/**
 * Accumulator engine service — the stateful half.
 *
 * Sits beside StrategyEngine rather than inside it. StrategyEngine enforces one
 * open position per symbol per strategy and nets DCA adds into a weighted
 * average entry; the accumulator needs up to `tranches` concurrent lots on one
 * symbol, each with its own untouched cost basis. Those are incompatible, so it
 * owns its own book (store.accumulatorBooks) and drives its own orders.
 *
 * It reuses everything else this codebase already has: the broker adapter, the
 * NSE session gate, the cost model, the tick/price-band helpers and the store.
 *
 * DELIVERY ONLY. Every order it places is CNC. The no-loss invariant depends on
 * being able to hold a position indefinitely, so an intraday product — which the
 * broker squares off for you at 15:20 — would break the guarantee on day one.
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { isAppSetupRejection, isDepositoryAuthRejection } from '../brokers/kiteMapping';
import { brokerFor, venueOf } from '../brokers/registry';
import type { Order, OrderRequest } from '../types';
import { orderRateLimiter } from './guards';
import { notifier } from './Notifier';
import { preTradeGate } from './orderGate';
import { marketData } from './MarketDataService';
import { fetchYahooQuote } from './yahooLtp';
import { store } from '../store/memoryStore';
import { fundsService } from './FundsService';
import { cashSweep } from './CashSweepService';
import { logger } from '../utils/logger';
import { canEnter, isMarketOpen, istParts, nextTradingDayStart } from './session';
import { fetchYahooChart, fetchYahooCorporateActions } from './yahoo';
import {
  BreakevenViolationError,
  applyBuyFill,
  applyTrail,
  ridingUptrend,
  decide,
  deployCeiling,
  equity,
  mergeDayHighs,
  paramsFor,
  recordDayHigh,
  releaseSettled,
  rollingHigh,
  forceSellLot,
  sellLot,
  syncLadder,
} from './accumulator/engine';
import { describeProfile, scalpActive, validateScalp } from './accumulator/scalp';
import { autoProfileDecision, classifyRegime } from './accumulator/trend';
import { applyCorporateAction, describeAction, pendingActions } from './accumulator/corporateActions';
import { dailyVolPct, dpImpactPct, trancheSize } from './accumulator/math';
import { findUnbookedFills, type UnbookedFill } from './accumulator/fillAudit';
import { entryBlock, inOpeningWindow, isGapDown } from './accumulator/events';
import { marketEvents } from './marketEvents';
import { cleanDailyBars } from './barCleaning';
import { clearPaperLots } from './accumulator/paperClear';
import { roundTripCostPct } from './costs';
import {
  DEFAULT_ACCUMULATOR_PARAMS,
  type AccumulatorBook,
  type AccumulatorDecision,
  type AccumulatorInstrument,
  type AccumulatorParams,
} from './accumulator/types';

export interface AccumulatorEvent {
  at: number;
  symbol: string;
  kind: 'DECISION' | 'FILL' | 'REFUSED' | 'REJECT' | 'SETTLED' | 'SKIP' | 'HALT' | 'LADDER';
  detail: string;
}

/** What the Sell button did, lot by lot. */
export interface ForceSellResult {
  /** True when every chosen lot sold. */
  ok: boolean;
  /** Set when nothing was sent at all, and why. */
  refused?: string;
  sold: { lotId: string; quantity: number; price: number; proceeds: number; pnl: number }[];
  failed: { lotId: string; reason: string }[];
  killSwitchEngaged?: boolean;
  /** Set when a sale left the book halted (a partial fill, an unknown order state). */
  halted?: string;
}

export interface CreateBookInput {
  userId: string;
  symbol: string;
  instrument: AccumulatorInstrument;
  budget: number;
  /** Start in no-loss mode immediately. Default true. */
  enabled?: boolean;
}

/** Reasons a book may not be opened at all. Refusals, not warnings. */
export function validateBook(
  input: CreateBookInput,
  params: AccumulatorParams = DEFAULT_ACCUMULATOR_PARAMS,
  referencePrice = 0,
): string[] {
  const errors: string[] = [];
  const tranche = trancheSize(input.budget, params);

  if (!(input.budget > 0)) errors.push('Budget must be positive.');

  // Dust gate. The DP charge is flat rupees per sell, so it does not shrink
  // with the order — it just eats a larger share of a smaller one.
  const dp = dpImpactPct(tranche);
  if (dp > 0.1) {
    const minBudget = Math.ceil(
      ((16_000 * params.tranches) / (1 - params.reservePct / 100)) / 1000,
    ) * 1000;
    errors.push(
      `Tranche of ₹${tranche.toFixed(0)} is too small: the flat DP charge is ${dp.toFixed(2)}% ` +
        `of it. Raise the budget to about ₹${minBudget.toLocaleString('en-IN')} at ` +
        `${params.tranches} tranches, or cut the tranche count.`,
    );
  }

  // The target must clear the round trip with margin, or the strategy pays the
  // broker to break even.
  if (referencePrice > 0) {
    const qty = Math.max(1, Math.floor(tranche / referencePrice));
    const cost = roundTripCostPct(referencePrice, qty, {
      product: 'CNC',
      instrument: input.instrument,
    });
    if (params.targetPct < 1.5 * cost) {
      errors.push(
        `Target ${params.targetPct}% is below 1.5× the round-trip cost of ${cost.toFixed(2)}% ` +
          `at this tranche size.`,
      );
    }
  }

  // An index ETF recovers; a single stock may not. Yes Bank, DHFL and Suzlon
  // all left holders waiting on a recovery that has not come, and a delisted
  // stock leaves no market to recover in — while the win rate still reads 100%.
  if (input.instrument === 'EQUITY') {
    logger.warn(
      `Accumulator opened on ${input.symbol}, an individual stock. The strategy assumes the ` +
        `instrument eventually recovers; for a single stock that is not guaranteed, and open ` +
        `lots can never be sold at a loss to escape.`,
    );
  }

  return errors;
}

export function createBook(input: CreateBookInput): AccumulatorBook {
  const now = Date.now();
  return {
    id: `${input.userId}:${input.symbol}`,
    userId: input.userId,
    symbol: input.symbol,
    instrument: input.instrument,
    budget: input.budget,
    cash: input.budget,
    unsettled: [],
    openLots: [],
    closedLots: [],
    epochs: [],
    lotSeq: 0,
    dayHighs: {},
    orderedDays: [],
    enabled: input.enabled ?? true,
    enabledChangedAt: now,
    enabledChangedBy: 'created',
    killSwitchEngaged: false,
    createdAt: now,
    updatedAt: now,
  };
}

/** Regime reads are recomputed from daily bars at most this often. */
const CLOSES_TTL_MS = 6 * 3_600_000;

/**
 * Drives every enabled accumulator book on a tick.
 *
 * Exits are evaluated first and are never gated. The session gate, the kill
 * switch and the risk checks reach only the entry half — a filter that can block
 * an exit is a capital-destroying bug, which is why they all sit on that side.
 */
/**
 * The book's price memory after a tick. `lastPrice` follows every tick;
 * `previousClose` is the PRIOR session's close and changes only when a new IST
 * day starts — the circuit band is measured from it, so letting it follow the
 * tick would make the band check compare a price with itself. The exchange's
 * own previous close (from the quote) wins when the feed supplies one.
 */
export function closeFields(
  b: Pick<AccumulatorBook, 'previousClose' | 'lastPrice' | 'lastPriceAt'>,
  price: number,
  now: number,
  reference = 0,
): Pick<AccumulatorBook, 'previousClose' | 'lastPrice' | 'lastPriceAt'> {
  const newDay = b.lastPriceAt !== undefined && istParts(b.lastPriceAt).date !== istParts(now).date;
  const previousClose =
    reference > 0 ? reference : newDay && b.lastPrice ? b.lastPrice : b.previousClose;
  return { ...(previousClose ? { previousClose } : {}), lastPrice: price, lastPriceAt: now };
}

/** A Kite tick younger than this outranks any other price source. */
const KITE_FRESH_MS = 60_000;
/** How often one book is re-checked for splits and bonuses. */
const CORPORATE_CHECK_MS = 30 * 60_000;

export class AccumulatorEngine extends EventEmitter {
  private events: AccumulatorEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private cycling = false;
  /**
   * Books with a step in progress, keyed `userId:symbol`. The scheduler and the
   * Evaluate route both call `step`, and a live fill can take 20s+; without
   * this a second step would decide on the same unfilled rung or unsold lot
   * and send the order twice.
   */
  private stepping = new Set<string>();
  /** When each book was last checked for corporate actions, keyed `userId:symbol`. */
  private corporateCheckedAt = new Map<string, number>();
  /** Daily closes per symbol for the regime read. A regime cannot change intraday. */
  private closesCache = new Map<string, { at: number; closes: number[]; error?: string }>();

  /** True while a scheduler pass is stepping books. The allocator waits for this to clear so the two never save the same book at once. */
  get busy(): boolean {
    return this.cycling || this.stepping.size > 0;
  }

  /**
   * Start the scheduler: every `intervalMs`, price and advance every ENABLED
   * book. This is what makes "automatically" true — without it a book only
   * moves when someone clicks Evaluate.
   */
  start(intervalMs = 60_000): void {
    if (this.timer) return;
    // Seed start-gate history BEFORE the first pass, so a step never saves a
    // stale copy of a book over a freshly seeded one. Best-effort: Yahoo down
    // just means the book learns its highs the slow way.
    // Corporate actions BEFORE the day highs: a split rescales every recorded
    // high, so seeding first would store pre-split prices and halve them again.
    void this.applyCorporateActionsAll(Date.now(), true)
      .then(() => this.backfillDayHighs())
      .finally(() => {
      this.timer = setInterval(() => void this.runAll(), intervalMs);
      this.timer.unref?.();
      void this.runAll();
      logger.info(`AccumulatorEngine scheduler started (${intervalMs / 1000}s)`);
    });
  }

  /**
   * Give one book its start-gate history from real daily bars, and save it.
   *
   * Called on creation, and at boot for any book that has recorded fewer days
   * than the lookback. Without this a new book's "45-day high" is a one-day
   * high for seven weeks and the gate cannot tell a dip from a top.
   */
  async seedDayHighs(book: AccumulatorBook, authoritative = false): Promise<AccumulatorBook> {
    const lookback = paramsFor(book, DEFAULT_ACCUMULATOR_PARAMS).hiLookbackDays;
    let entries: { day: string; high: number }[] = [];
    try {
      const chart = await fetchYahooChart(book.symbol, '6mo', '1d', 15_000);
      // Cleaned: one bad high would sit in the 45-day high and freeze the start gate.
      entries = cleanDailyBars(chart?.candles ?? []).map((c) => ({ day: istParts(c.timestamp).date, high: c.high }));
    } catch (e) {
      this.log(book, 'SKIP', `Could not seed history from Yahoo: ${e instanceof Error ? e.message : e}`);
    }
    // Re-read: the caller's copy may be older than what a step just saved.
    const fresh = store.accumulatorBook(book.userId, book.symbol) ?? book;
    const next = mergeDayHighs(fresh, entries, { authoritative });
    store.saveAccumulatorBook(next);
    const before = rollingHigh(fresh, lookback);
    if (next !== fresh && Math.abs(rollingHigh(next, lookback) - before) > 0.005) {
      this.log(
        next, 'DECISION',
        `Start-gate history seeded: ${next.orderedDays.length} days of highs, ` +
          `${lookback}-day high now ₹${rollingHigh(next, lookback).toFixed(2)}`,
      );
    }
    return next;
  }

  /**
   * Turn the regime autopilot on or off for a book.
   *
   * On, the bot owns the scalp flag: it reads the trend from daily closes and
   * switches sideways→scalp, trend→swing. Turning it on runs a pass at once so
   * the book lands on the right profile immediately rather than at the next tick.
   */
  async setAutoProfile(userId: string, symbol: string, on: boolean): Promise<AccumulatorBook | undefined> {
    const b = store.accumulatorBook(userId, symbol);
    if (!b) return undefined;
    const next = { ...b, autoProfile: on, updatedAt: Date.now() };
    store.saveAccumulatorBook(next);
    this.log(
      next, 'DECISION',
      on
        ? 'Regime autopilot ON — the bot now picks scalp or swing from the trend'
        : 'Regime autopilot OFF — the profile is yours to set',
    );
    logger.info(`Accumulator autopilot ${on ? 'ON' : 'OFF'} for ${symbol}`);
    return on ? ((await this.autoProfileFor(next)) ?? next) : next;
  }

  /**
   * Read the regime for one book and apply the profile it calls for.
   *
   * The economic validation still runs: if the regime says scalp but this
   * book's tranche is too small for a 1.5% target to clear 1.5x the round
   * trip, the switch is refused and logged. The autopilot cannot talk the
   * engine into an uneconomic trade.
   */
  async autoProfileFor(book: AccumulatorBook, now = Date.now()): Promise<AccumulatorBook | undefined> {
    if (!book.autoProfile) return undefined;

    const h = await this.fetchDailyCloses(book.symbol, now);
    if (h.error) {
      this.log(book, 'SKIP', `Autopilot: no history to read the trend from (${h.error})`);
      return undefined;
    }

    const read = classifyRegime(h.closes);
    const fresh = store.accumulatorBook(book.userId, book.symbol) ?? book;
    const decision = autoProfileDecision(fresh, read, now);

    // Record what it saw even when it changes nothing — an autopilot whose
    // reasoning is invisible is indistinguishable from one that is broken.
    const volPct = dailyVolPct(h.closes);
    let next: AccumulatorBook = {
      ...fresh,
      ...(read.regime ? { regime: read.regime } : {}),
      ...(volPct ? { volPct } : {}),
      regimeNote: read.reason,
      updatedAt: now,
    };

    if (decision.scalp === null) {
      store.saveAccumulatorBook(next);
      return next;
    }

    const mark = marketData.getPrice(book.symbol) || book.lastPrice || book.previousClose || 0;
    const errors = validateScalp(next, paramsFor({ ...next, scalp: true }, DEFAULT_ACCUMULATOR_PARAMS), mark);
    if (decision.scalp && errors.length) {
      // Say so on the book, not only in the log. Otherwise the UI shows
      // "sideways → swing" and looks like the autopilot ignored its own rule.
      next = { ...next, regimeNote: `${read.reason} → wanted scalp, refused: ${errors[0]}` };
      this.log(next, 'REFUSED', `Autopilot wanted scalp but it is uneconomic here: ${errors[0]}`);
      store.saveAccumulatorBook(next);
      return next;
    }

    next = { ...next, scalp: decision.scalp, profileSwitchedAt: now };
    store.saveAccumulatorBook(next);
    this.log(next, 'DECISION', `Autopilot: ${decision.reason}. Now ${describeProfile(decision.scalp)}`);
    logger.info(`Autopilot switched ${book.symbol} to ${decision.scalp ? 'scalp' : 'swing'} (${read.regime})`);
    return next;
  }

  /**
   * Absorb any corporate action this book has not yet seen.
   *
   * Runs BEFORE any book is stepped and before the day's highs are recorded,
   * because everything downstream — the start gate, the ladder, every lot's
   * mark — is priced in post-split rupees the moment the market reopens. A
   * book that trades for even one tick on a pre-split basis is booking against
   * a cost basis five times too high.
   *
   * A halt is a deliberate outcome, not a failure to handle: if the adjustment
   * is not exact, the book stops rather than continue on a corrupt basis.
   */
  async applyCorporateActionsFor(book: AccumulatorBook, now = Date.now()): Promise<AccumulatorBook> {
    const actions = await fetchYahooCorporateActions(book.symbol);
    const pending = pendingActions(book, actions, now);
    if (pending.length === 0) return book;

    let b = store.accumulatorBook(book.userId, book.symbol) ?? book;
    for (const action of pending) {
      try {
        const before = b.openLots.reduce((s, l) => s + l.quantity, 0);
        b = applyCorporateAction(b, action);
        const after = b.openLots.reduce((s, l) => s + l.quantity, 0);
        this.log(
          b, 'DECISION',
          `Corporate action absorbed — ${describeAction(action)}` +
            (before !== after ? `: ${before} shares became ${after}, cost basis unchanged` : ''),
        );
        logger.warn(`Corporate action on ${book.symbol}: ${describeAction(action)}`);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        b = { ...b, haltedReason: reason, updatedAt: now };
        this.log(b, 'HALT', reason);
        logger.error(reason);
        break;
      }
    }

    store.saveAccumulatorBook({ ...b, updatedAt: now });
    return b;
  }

  /**
   * Check every book for corporate actions, a few at a time.
   *
   * Cheap in the common case: Yahoo returns an empty events block for most
   * symbols most of the time, and each book records the newest ex-date it has
   * absorbed, so re-reading the same history changes nothing.
   */
  private async applyCorporateActionsAll(now = Date.now(), force = false): Promise<void> {
    // Every 30 minutes per book, not every pass: this ran a two-year Yahoo
    // events fetch for every book every minute (~27,000 calls a day), and a
    // throttled Yahoo then slowed the price reads that exits depend on. Only
    // books that can trade or hold shares need it; the rest are checked when
    // they are switched on (boot pass, `force`).
    const books = [...store.accumulatorBooks.values()].filter((b) => {
      if (b.haltedReason) return false;
      if (!force && !b.enabled && b.openLots.length === 0) return false;
      const key = `${b.userId}:${b.symbol}`;
      if (!force && now - (this.corporateCheckedAt.get(key) ?? 0) < CORPORATE_CHECK_MS) return false;
      this.corporateCheckedAt.set(key, now);
      return true;
    });
    const queue = [...books];
    const worker = async (): Promise<void> => {
      for (let b = queue.shift(); b !== undefined; b = queue.shift()) {
        try {
          await this.applyCorporateActionsFor(b, now);
        } catch (e) {
          logger.warn(`corporate actions ${b.symbol}: ${e instanceof Error ? e.message : e}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
  }

  /**
   * Run the autopilot over every book that has it enabled, and keep the trend
   * read current on every other enabled book too. Trend riding arms lots from
   * `book.regime`, so a book without the autopilot still needs the read.
   */
  private async autoProfileAll(now = Date.now()): Promise<void> {
    const books = [...store.accumulatorBooks.values()].filter(
      (b) => (b.autoProfile || b.enabled) && !b.haltedReason,
    );
    for (const b of books) {
      try {
        if (b.autoProfile) await this.autoProfileFor(b, now);
        else await this.refreshRegime(b, now);
      } catch (e) {
        this.log(b, 'SKIP', `Autopilot: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  /**
   * Record the confirmed regime on a book WITHOUT touching its profile. Saves
   * only on a change, since this runs every pass. A failed or unconfirmed read
   * changes nothing: a book keeps its last confirmed regime, and one that never
   * had one does not ride.
   */
  private async refreshRegime(book: AccumulatorBook, now: number): Promise<void> {
    const h = await this.fetchDailyCloses(book.symbol, now);
    if (h.error) return;
    const read = classifyRegime(h.closes);
    const fresh = store.accumulatorBook(book.userId, book.symbol) ?? book;
    const regime = read.regime ?? fresh.regime;
    const volPct = dailyVolPct(h.closes) ?? fresh.volPct;
    if (regime === fresh.regime && read.reason === fresh.regimeNote && volPct === fresh.volPct) return;
    if (regime !== fresh.regime) {
      this.log(fresh, 'DECISION',
        regime === 'up'
          ? `Trend turned up — lots now ride past their target and trail ${DEFAULT_ACCUMULATOR_PARAMS.trail.uptrend.retracePct}% below their high`
          : `Trend is ${regime} — lots sell at their target`);
    }
    store.saveAccumulatorBook({
      ...fresh,
      ...(regime ? { regime } : {}),
      ...(volPct ? { volPct } : {}),
      regimeNote: read.reason,
      updatedAt: now,
    });
  }

  /** Daily closes for a symbol, cached — the regime cannot change intraday. */
  private async fetchDailyCloses(
    symbol: string,
    now: number,
  ): Promise<{ closes: number[]; error?: string }> {
    const hit = this.closesCache.get(symbol);
    if (hit && !hit.error && now - hit.at < CLOSES_TTL_MS) return hit;
    let out: { at: number; closes: number[]; error?: string };
    try {
      const chart = await fetchYahooChart(symbol, '1y', '1d', 15_000);
      const closes = cleanDailyBars((chart?.candles ?? []).filter((c) => c.close > 0)).map((c) => c.close);
      out = { at: now, closes };
      if (!closes.length) out.error = 'Yahoo returned no daily closes';
    } catch (e) {
      out = { at: now, closes: [], error: e instanceof Error ? e.message : String(e) };
    }
    this.closesCache.set(symbol, out);
    return out;
  }

  /** Seed every book whose recorded history is shorter than its lookback, a few at a time. */
  private async backfillDayHighs(): Promise<void> {
    // Every book, not only short-history ones: Yahoo's daily highs replace
    // recorded ones, which is what clears a bad print out of the start gate.
    const need = [...store.accumulatorBooks.values()].filter((b) => !b.haltedReason);
    if (need.length === 0) return;
    logger.info(`Refreshing start-gate history for ${need.length} book(s)`);
    const queue = [...need];
    const worker = async (): Promise<void> => {
      for (let b = queue.shift(); b !== undefined; b = queue.shift()) await this.seedDayHighs(b, true);
    };
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Resolve a price for a book's symbol.
   *
   * Symbols the configured feed already carries (the simulator's seed list, or
   * a live Kite subscription) use that. Anything else — a company like SYRMA
   * that nothing seeded — is priced from Yahoo and marked EXTERNAL so the
   * simulator never touches it. Once external, always external.
   */
  private async priceFor(symbol: string): Promise<number> {
    // A fresh Kite tick is the exchange's own print; never replace it with a
    // Yahoo poll, even for a symbol first priced from Yahoo.
    if (marketData.sourceAge(symbol, 'kite') < KITE_FRESH_MS && marketData.getPrice(symbol) > 0) {
      return marketData.getPrice(symbol);
    }
    if (!marketData.isExternal(symbol) && marketData.getPrice(symbol) > 0) {
      return marketData.getPrice(symbol);
    }
    const quote = await fetchYahooQuote(symbol);
    if (quote) {
      if (quote.previousClose) marketData.setReference(symbol, quote.previousClose);
      marketData.ingestExternal(symbol, quote.ltp, quote.quoteTime ?? undefined);
    }
    return marketData.getPrice(symbol);
  }

  /** One scheduler pass over every enabled book, across all users. */
  async runAll(now = Date.now()): Promise<void> {
    if (this.cycling) return; // a slow Yahoo call must not stack passes
    this.cycling = true;
    try {
      // Two passes before anything trades, in this order:
      //
      //   1. Corporate actions. A book must never step on a pre-split cost
      //      basis; one tick of that books against a basis five times too high.
      //   2. The autopilot. It owns the scalp flag, so resolving the regime
      //      first means a tick never trades on a profile it is about to change.
      //
      // Both are cheap in the common case — Yahoo returns no events for most
      // symbols, and the regime read is cached against daily bars.
      await this.applyCorporateActionsAll(now);
      await this.autoProfileAll(now);

      for (const book of store.accumulatorBooks.values()) {
        if (!book.enabled || book.haltedReason) continue;
        const price = await this.priceFor(book.symbol);
        if (!(price > 0)) continue;
        await this.step(book, price, now);
      }
    } catch (e) {
      logger.error(`accumulator cycle: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.cycling = false;
    }
  }

  /**
   * Clear every PAPER lot of a user's books (see `accumulator/paperClear.ts`).
   * Waits for the scheduler to be idle first: a step in flight holds its own
   * copy of a book and would write the lots back when it saves.
   */
  async clearPaperLots(userId: string, now = Date.now()): Promise<{ symbol: string; lots: number; value: number; pnl: number }[]> {
    const until = Date.now() + 30_000;
    while (this.busy && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
    if (this.busy) throw new Error('The engine stayed busy for 30s; try again in a minute.');
    const out: { symbol: string; lots: number; value: number; pnl: number }[] = [];
    for (const b of store.accumulatorBooksByUser(userId)) {
      if ((b.openLots.length === 0 && b.unsettled.length === 0) || (b.venue ?? 'paper') !== 'paper') continue;
      const mark = marketData.getPrice(b.symbol) || b.lastPrice || b.previousClose || 0;
      const { book, cleared } = clearPaperLots(b, mark, now);
      store.saveAccumulatorBook(book);
      const value = cleared.reduce((s, l) => s + l.value, 0);
      const pnl = cleared.reduce((s, l) => s + l.pnl, 0);
      this.log(book, 'DECISION',
        `Paper lots cleared before going live: ${cleared.length} lot(s) marked at ₹${mark.toFixed(2)}, ` +
          `₹${value.toFixed(0)} back to cash (paper result ₹${pnl.toFixed(0)}). No order was placed.`);
      out.push({ symbol: b.symbol, lots: cleared.length, value, pnl });
    }
    return out;
  }

  /**
   * Why a forced sale of this book cannot go out right now, or null when it
   * can. Shared by the preview and the sale, so the dialog and the engine never
   * disagree about whether the button works.
   */
  forceSellBlocker(book: AccumulatorBook, now = Date.now()): string | null {
    if (book.haltedReason) {
      return `This stock is halted (${book.haltedReason}). Reconcile with the broker and release the halt first: ` +
        'selling against a book that may not match your demat account could sell shares that are not there.';
    }
    if (book.openLots.length === 0) return 'There are no open lots to sell.';
    if (!isMarketOpen(now)) return 'The exchange is closed. A forced sale goes out at market, so it can only be placed 09:15–15:30 IST on a trading day.';
    const brk = brokerFor(book.userId);
    const venue = venueOf(brk);
    if ((book.venue ?? 'paper') !== venue) {
      return book.venue === 'live'
        ? 'These lots are real shares on your Zerodha account, but trading is on paper right now. Switch to live to sell them.'
        : 'These are paper lots; they are not in your demat account, so they cannot be sold on your live account.';
    }
    if (venue === 'live' && marketData.isSimulated()) return 'Market data is simulated; no live order is placed until a real feed is running.';
    if (!brk.isConnected()) return `${brk.name} is not connected.`;
    return null;
  }

  /**
   * The user's Sell button: sell the chosen lots NOW, at market, whatever they
   * cost. The one path that can book a loss, and only a human can start it.
   *
   * Runs through the same order loop as the engine (`executeDecisions`) under
   * the same per-book lock as a step, so the scheduler cannot sell the same lot
   * in the same minute. With `stopBuying` the kill switch goes on BEFORE the
   * first order: selling every lot closes the ladder, and without it the next
   * tick could open a new one straight away.
   */
  async forceSell(
    userId: string,
    symbol: string,
    lotIds: string[],
    opts: { stopBuying: boolean },
    now = Date.now(),
  ): Promise<ForceSellResult> {
    const sym = symbol.toUpperCase();
    const key = `${userId}:${sym}`;
    const refuse = (reason: string): ForceSellResult => ({ ok: false, refused: reason, sold: [], failed: [] });

    const ids = [...new Set(lotIds)];
    if (ids.length === 0) return refuse('Choose at least one lot to sell.');

    // A live step can take 20s+ at the broker. Wait for it rather than refuse.
    const until = Date.now() + 30_000;
    while (this.stepping.has(key) && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
    if (this.stepping.has(key)) return refuse('The engine is still working on this stock; try again in a minute.');

    this.stepping.add(key);
    try {
      let b = store.accumulatorBook(userId, sym);
      if (!b) return refuse('No such accumulator book.');
      const missing = ids.filter((id) => !b!.openLots.some((l) => l.id === id));
      if (missing.length) return refuse(`Not open any more: ${missing.join(', ')}. Refresh and try again.`);
      const blocker = this.forceSellBlocker(b, now);
      if (blocker) return refuse(blocker);

      if (opts.stopBuying && !b.killSwitchEngaged) {
        b = { ...b, killSwitchEngaged: true, updatedAt: now };
        store.saveAccumulatorBook(b);
        this.log(b, 'DECISION', 'Kill switch engaged by the Sell button: no new rungs will be bought');
      }

      const lots = ids.map((id) => b!.openLots.find((l) => l.id === id)!);
      this.log(b, 'DECISION',
        `Forced sale requested by the user: ${lots.length} lot(s), ${lots.reduce((s, l) => s + l.quantity, 0)} shares, at market`);
      const decisions: AccumulatorDecision[] = lots.map((l) => ({
        action: 'SELL',
        symbol: sym,
        lotId: l.id,
        quantity: l.quantity,
        forced: true,
        reason: 'Forced sale by the user (Sell button), at market',
      }));

      const brk = brokerFor(userId);
      const firstEvent = this.events.length;
      const start = b;
      b = await this.executeDecisions(b, start, decisions, brk, venueOf(brk), now);
      b = this.saveStepped(b, start);

      // Why a lot did not sell: the newest REJECT/HALT/REFUSED this run logged.
      const problems = this.events
        .slice(firstEvent)
        .filter((e) => e.symbol === sym && (e.kind === 'REJECT' || e.kind === 'HALT' || e.kind === 'REFUSED'));
      const why = problems.length ? problems[problems.length - 1].detail : 'not sold — see the engine log';
      const sold: ForceSellResult['sold'] = [];
      const failed: ForceSellResult['failed'] = [];
      for (const id of ids) {
        const c = b.closedLots.find((l) => l.id === id && l.forced);
        if (c) sold.push({ lotId: id, quantity: c.quantity, price: c.sellPrice, proceeds: c.proceeds, pnl: c.pnl });
        else failed.push({ lotId: id, reason: why });
      }
      return { ok: failed.length === 0, sold, failed, killSwitchEngaged: b.killSwitchEngaged, halted: b.haltedReason };
    } finally {
      this.stepping.delete(key);
    }
  }

  /** Turn no-loss mode on or off for a book. Off leaves every lot untouched. */
  setEnabled(userId: string, symbol: string, enabled: boolean): AccumulatorBook | undefined {
    const b = store.accumulatorBook(userId, symbol);
    if (!b) return undefined;
    const now = Date.now();
    const next: AccumulatorBook = {
      ...b,
      enabled,
      enabledChangedAt: now,
      enabledChangedBy: 'user',
      updatedAt: now,
    };
    store.saveAccumulatorBook(next);
    this.log(next, 'DECISION', `No-loss mode switched ${enabled ? 'ON' : 'OFF'} by the user`);
    logger.info(`Accumulator no-loss mode ${enabled ? 'ON' : 'OFF'} for ${symbol}`);
    // A book coming back on may carry months-old highs; refresh them from
    // Yahoo before the start gate reads them.
    if (enabled) void this.seedDayHighs(next, true);
    return next;
  }

  /**
   * Switch the scalp profile on or off for a book.
   *
   * Nested inside no-loss mode, exactly as in the NTB bot this is ported from:
   * the flag is saved whatever `enabled` says, but it only does anything while
   * no-loss mode is on. Turning no-loss off parks the profile rather than
   * clearing it, so switching back on resumes the same one.
   *
   * Refuses when the target cannot clear 1.5x the round-trip cost at this
   * book's tranche size — a scalp that small pays the exchange more than it
   * keeps, and the flat DP charge means "small" is a rupee amount, not a
   * percentage. Returns the errors instead of throwing.
   */
  setScalp(
    userId: string,
    symbol: string,
    on: boolean,
    markPrice = 0,
  ): { book?: AccumulatorBook; errors: string[] } {
    const b = store.accumulatorBook(userId, symbol);
    if (!b) return { errors: [] };

    if (on) {
      const errors = validateScalp(
        b,
        paramsFor({ ...b, scalp: true }, DEFAULT_ACCUMULATOR_PARAMS),
        markPrice,
      );
      if (errors.length) {
        this.log(b, 'REFUSED', `Scalping mode refused: ${errors[0]}`);
        return { errors };
      }
    }

    const next = { ...b, scalp: on, updatedAt: Date.now() };
    store.saveAccumulatorBook(next);
    this.log(next, 'DECISION', `Profile switched to ${describeProfile(on)}`);
    logger.info(`Accumulator scalping mode ${on ? 'ON' : 'OFF'} for ${symbol}`);
    return { book: next, errors: [] };
  }

  recentEvents(limit = 200): AccumulatorEvent[] {
    return this.events.slice(-limit).reverse();
  }

  private log(book: AccumulatorBook, kind: AccumulatorEvent['kind'], detail: string): void {
    const e: AccumulatorEvent = { at: Date.now(), symbol: book.symbol, kind, detail };
    this.events.push(e);
    if (this.events.length > 2_000) this.events = this.events.slice(-2_000);
    this.emit('event', e);
    // Everything except the once-a-minute "market closed" heartbeat goes to the
    // durable audit trail, so a rung that fired can be explained after a restart.
    if (kind !== 'SKIP' || !/Market closed/.test(detail)) {
      store.audit({ userId: book.userId, kind: 'engine', symbol: book.symbol, detail: `[${kind}] ${detail}` });
    }
    if (kind === 'FILL' || kind === 'HALT' || kind === 'REJECT') {
      void notifier.alert(kind === 'FILL' ? 'info' : 'critical', `acc:${kind}:${book.symbol}`, `${book.symbol} ${kind}: ${detail}`, kind === 'FILL' ? 0 : 5 * 60_000);
    }
  }

  /**
   * Advance one book against one price. Returns the updated book.
   *
   * One step per book at a time: a second caller while one is running is
   * skipped, not queued, because it would decide on the same state.
   */
  async step(book: AccumulatorBook, price: number, now = Date.now()): Promise<AccumulatorBook> {
    const key = `${book.userId}:${book.symbol}`;
    if (this.stepping.has(key)) {
      this.log(book, 'SKIP', 'Another evaluation of this book is still running — skipped so no order is sent twice');
      return store.accumulatorBook(book.userId, book.symbol) ?? book;
    }
    this.stepping.add(key);
    try {
      return await this.stepLocked(store.accumulatorBook(book.userId, book.symbol) ?? book, price, now);
    } finally {
      this.stepping.delete(key);
    }
  }

  /**
   * Halt every book holding a filled engine order it never booked. Runs at boot
   * (after the stale-order sweep has resolved what it can) and from
   * reconciliation when the broker holds more than the books expect. Returns
   * what it found, books already halted and removed books included.
   */
  haltUnbookedFills(now = Date.now(), only?: { userIds?: string[]; symbol?: string }): UnbookedFill[] {
    const found = findUnbookedFills(store.orders.values(), store.accumulatorBooks.values()).filter(
      (u) =>
        (!only?.symbol || u.symbol.toUpperCase() === only.symbol.toUpperCase()) &&
        (!only?.userIds || only.userIds.includes(u.userId)),
    );
    for (const u of found) {
      if (u.bookMissing) {
        logger.warn(`Fill audit: order ${u.orderId} (${u.side} ${u.filledQuantity} ${u.symbol}) belongs to a removed book`);
        continue;
      }
      const book = store.accumulatorBook(u.userId, u.symbol);
      if (!book || book.haltedReason) continue;
      const halt =
        `Unbooked fill: ${u.reason} (order ${u.brokerOrderId ?? u.orderId}, ` +
        `${new Date(u.createdAt).toISOString()}). Most likely a restart between the fill and the save. ` +
        `Check the broker, correct the book, then clear this halt.`;
      const next = { ...book, haltedReason: halt, updatedAt: now };
      store.saveAccumulatorBook(next);
      this.log(next, 'HALT', halt);
    }
    return found;
  }

  /**
   * Save a stepped book WITHOUT undoing what others wrote while it was out at
   * the broker. The kill switch, no-loss toggle, autopilot, regime and a halt
   * from reconciliation belong to other writers; the step owns lots and cash.
   */
  private saveStepped(b: AccumulatorBook, start: AccumulatorBook): AccumulatorBook {
    const fresh = store.accumulatorBook(b.userId, b.symbol);
    const merged: AccumulatorBook = fresh
      ? {
          ...b,
          enabled: fresh.enabled,
          killSwitchEngaged: fresh.killSwitchEngaged,
          // Set by the user from the allocator panel while this step was out.
          manualBudget: fresh.manualBudget,
          manualTranches: fresh.manualTranches,
          autoProfile: fresh.autoProfile,
          scalp: fresh.scalp,
          profileSwitchedAt: fresh.profileSwitchedAt,
          regime: fresh.regime,
          regimeNote: fresh.regimeNote,
          volPct: fresh.volPct,
          // A halt this step raised wins; otherwise whatever is stored now does
          // (a reconcile halt set mid-step, or a halt a human just cleared).
          haltedReason: b.haltedReason !== start.haltedReason ? b.haltedReason : fresh.haltedReason,
        }
      : b;
    store.saveAccumulatorBook(merged);
    return merged;
  }

  private async stepLocked(book: AccumulatorBook, price: number, now: number): Promise<AccumulatorBook> {
    const start = book;
    let b = book;

    // T+1: the only place money leaves the settlement queue.
    const beforeCash = b.cash;
    b = releaseSettled(b, now);
    if (b.cash !== beforeCash) {
      this.log(b, 'SETTLED', `₹${(b.cash - beforeCash).toFixed(2)} of sale proceeds settled (T+1)`);
    }

    b = recordDayHigh(b, price, now);
    // Advance the ratchet before deciding, so a lot arms or raises its
    // high-water mark exactly once per tick and the exit below sees it.
    b = applyTrail(b, price, DEFAULT_ACCUMULATOR_PARAMS);

    // Match the open ladder to the rung count the allocator has set since it
    // opened. `decide` resizes on the fly as well; this makes it stick and shows.
    const resized = syncLadder(b, DEFAULT_ACCUMULATOR_PARAMS);
    if (resized !== b) {
      const before = b.epochs[b.epochs.length - 1].levels;
      const after = resized.epochs[resized.epochs.length - 1].levels;
      const added = after.slice(before.length).map((l) => `₹${l.toFixed(2)}`);
      this.log(resized, 'LADDER',
        `Ladder resized ${before.length} → ${after.length} rungs to match the book's rung count` +
          (added.length ? ` (new: ${added.join(', ')})` : ''));
      b = resized;
    }

    if (!isMarketOpen(now)) {
      this.log(b, 'SKIP', `Market closed (${istParts(now).date}) — no orders`);
      return this.saveStepped(b, start);
    }

    // Orders go to THIS user's broker: paper, or their own Zerodha account once
    // they have switched it to live in Settings.
    const brk = brokerFor(b.userId);
    const venue = venueOf(brk);
    // A book's lots live on exactly one venue. Trading paper lots on a real
    // account would sell shares the demat account never held; selling real lots
    // in simulation would close positions that are still held.
    if (b.openLots.length > 0 && (b.venue ?? 'paper') !== venue) {
      this.log(
        b,
        'SKIP',
        b.venue === 'live'
          ? 'Holds shares bought on your live Zerodha account — paused while trading is on paper'
          : 'Holds simulated (paper) lots, which are not in your demat account — not traded live. Switch back to paper to let them finish, or remove the book.',
      );
      return this.saveStepped(b, start);
    }
    // Real orders are never priced off the random-walk simulator.
    if (venue === 'live' && marketData.isSimulated()) {
      this.log(b, 'SKIP', 'Market data is SIMULATED — no live orders until a real feed is running');
      return this.saveStepped(b, start);
    }
    if (!brk.isConnected()) {
      this.log(b, 'SKIP', `${brk.name} is not connected — no orders`);
      return this.saveStepped(b, start);
    }

    // Market events that block NEW rungs (surveillance, results, a gap-down).
    // Exits are unaffected: `decide` checks the block only for entries.
    const veto = DEFAULT_ACCUMULATOR_PARAMS.eventVeto;
    if (veto) {
      const today = istParts(now).date;
      // The day's first price, against yesterday's close: a gap-down on news.
      // Only when that first price is from the opening minutes, so it is the open.
      const firstToday =
        (b.lastPriceAt === undefined || istParts(b.lastPriceAt).date !== today) && inOpeningWindow(now);
      const prevClose = marketData.getReference(b.symbol) || b.lastPrice;
      if (firstToday && isGapDown(prevClose, price, veto.gapPct)) {
        b = { ...b, gapDownDay: today };
        this.log(b, 'DECISION', `Opened at ₹${price.toFixed(2)}, ${veto.gapPct}%+ under yesterday's ₹${prevClose!.toFixed(2)}`);
      }
      const block = entryBlock({
        now,
        params: veto,
        surveillance: marketEvents.surveillance(b.symbol),
        lastResultsDay: marketEvents.lastResultsDay(b.symbol, now),
        gapDownDay: b.gapDownDay,
      });
      if ((block ?? undefined) !== b.entryBlock) {
        this.log(b, 'DECISION', block ? `New rungs blocked: ${block}` : 'Entry block lifted');
      }
      b = { ...b, entryBlock: block ?? undefined };
    }

    b = await this.executeDecisions(b, start, decide(b, price, now, DEFAULT_ACCUMULATOR_PARAMS), brk, venue, now);

    b = { ...b, ...closeFields(b, price, now, marketData.getReference(b.symbol)), updatedAt: now };
    return this.saveStepped(b, start);
  }

  /**
   * Send each decision to the broker and book what actually traded. The ONE
   * order path: the scheduler's step and the user's forced sale both run
   * through it, so every live-money safety (order row before send, save after
   * each fill, partial-fill and unknown-state halts) applies to both.
   */
  private async executeDecisions(
    b: AccumulatorBook,
    start: AccumulatorBook,
    decisions: AccumulatorDecision[],
    brk: ReturnType<typeof brokerFor>,
    venue: ReturnType<typeof venueOf>,
    now: number,
  ): Promise<AccumulatorBook> {
    for (const d of decisions) {
      // A halt raised elsewhere while an earlier order was out stops the rest.
      if (store.accumulatorBook(b.userId, b.symbol)?.haltedReason) break;
      if (d.action === 'HOLD') {
        // The same HOLD every minute filled the audit log (87% of 34,804 rows
        // in 26 days). Log it when the reason changes; the countdown digits in
        // a brake message do not count as a change.
        // Kept on the book, not in memory: a dev server restarts dozens of
        // times a day, and each restart re-logged every book's reason.
        const gist = d.reason.replace(/\d+/g, '#');
        if (b.lastHoldGist !== gist) {
          b = { ...b, lastHoldGist: gist };
          this.log(b, 'DECISION', d.reason);
        }
        continue;
      }
      if (b.lastHoldGist !== undefined) b = { ...b, lastHoldGist: undefined };

      // The session gate applies to ENTRIES only. An exit at a profit is never
      // held back — see canEnter's contract in services/session.ts.
      if (d.action === 'BUY') {
        const gate = canEnter(now);
        if (!gate.ok) {
          this.log(b, 'SKIP', `Entry blocked: ${gate.reason}`);
          continue;
        }
      }

      // Hold the cash before sending the order. Without this, several books
      // deciding in the same tick each read the same balance and each commit
      // against it — the broker then rejects the last one, or accepts them all
      // on money the account has not got. EXITS are never gated on funds:
      // selling returns cash, and blocking an exit would break the invariant
      // that an exit is never held back.
      const reservationId = `${b.symbol}:${d.action}:${now}:${d.lotId ?? `e${d.epoch}l${d.level}`}`;
      if (d.action === 'BUY') {
        const cost = d.quantity! * (d.limitPrice ?? 0);
        // Spare cash may be parked in the liquid ETF. Bring back what this rung
        // needs first; with nothing parked this returns at once.
        const cashIn = await cashSweep.ensureCash(b.userId, cost, b, now);
        if (!cashIn.ok) {
          this.log(b, 'SKIP', `BUY ${b.symbol}: ${cashIn.reason}`);
          continue;
        }
        if (cashIn.redeemed) this.log(b, 'DECISION', `Sold ${cashIn.redeemed} parked ${cashSweep.params.symbol} units to fund this rung`);
        const held = await fundsService.reserve(reservationId, b.symbol, cost, now, b.userId);
        if (!held) {
          this.log(b, 'SKIP', `BUY ${b.symbol}: not enough deployable cash for ₹${Math.round(cost)}`);
          continue;
        }
      }

      // Set once the broker reports shares actually traded. From then on a
      // failure to book the fill is a halt, never a retry: the shares moved.
      let filledAtBroker = false;
      let record: Order | null = null;
      try {
        const req: OrderRequest = {
          symbol: b.symbol,
          side: d.action,
          quantity: d.quantity!,
          // A forced sale is the user saying "sell now": MARKET, so it fills.
          // Every engine order is a LIMIT at its rung or target.
          ...(d.forced ? { orderType: 'MARKET' as const } : { orderType: 'LIMIT' as const, price: d.limitPrice }),
          product: 'CNC',
          userId: b.userId,
          tag: `accumulator:${d.action === 'BUY' ? `e${d.epoch}l${d.level}` : d.lotId}`,
          intent: d.action === 'BUY' ? 'entry' : 'exit',
          // Unique per attempt: the live adapter derives its Kite tag from it,
          // which is how a lost reply is matched back to the order.
          clientOrderId: `acc:${reservationId}`,
        };
        // The same gate every order passes: session, instrument, feed health,
        // order rate, process halt. The engine has its own session check, but
        // a stale feed or a halted process must stop a rung too.
        const gate = preTradeGate(req, now);
        if (!gate.ok) {
          // The enclosing `finally` releases the funds reservation.
          this.log(b, 'REJECT', `${d.action} ${b.symbol} refused before sending: ${gate.reason}`);
          continue;
        }
        orderRateLimiter.record(now);
        // Recorded BEFORE sending, so the order exists in the ledger even if
        // the process dies while the broker is working it.
        record = {
          ...req,
          id: randomUUID(),
          status: 'PENDING',
          filledQuantity: 0,
          submittedAt: Date.now(),
          createdAt: now,
          updatedAt: now,
        };
        store.orders.set(record.id, record);
        const order = await brk.placeOrder(req);
        record = {
          ...record,
          brokerOrderId: order.brokerOrderId || undefined,
          status: order.status,
          filledQuantity: order.filledQuantity,
          ...(order.filledPrice ? { filledPrice: order.filledPrice } : {}),
          ...(order.rejectionReason ? { rejectionReason: order.rejectionReason } : {}),
          ackAt: Date.now(),
          updatedAt: Date.now(),
        };
        store.orders.set(record.id, record);
        if (order.filledQuantity > 0) filledAtBroker = true;

        // Still working at the broker after the adapter tried to cancel it: it
        // may yet fill, into a book that has not recorded it, and the next tick
        // would send the same order again. Stop this book for a human.
        if (order.status === 'PENDING') {
          const halt =
            `${d.action} ${b.symbol} is still working at ${brk.name} (order ${order.brokerOrderId || 'unknown'}): ` +
            `${order.rejectionReason ?? 'no confirmation'}. Check the order in Kite, reconcile, then clear this halt.`;
          b = { ...b, haltedReason: halt, updatedAt: now };
          this.log(b, 'HALT', halt);
          void notifier.alert('critical', `acc-pending:${b.userId}:${b.symbol}`, halt);
          break;
        }

        if (order.status !== 'FILLED' || !order.filledPrice) {
          // A delivery sell refused at the depository is refused again every tick
          // until the shares are authorised. Halt rather than hammer Kite.
          if (d.action === 'SELL' && isDepositoryAuthRejection(order.rejectionReason)) {
            const halt = `SELL ${b.symbol} refused: ${order.rejectionReason}`;
            b = { ...b, haltedReason: halt, updatedAt: now };
            this.log(b, 'HALT', halt);
            void notifier.alert('critical', `acc-cdsl:${b.userId}`, halt);
            break;
          }
          // The Kite app itself is not set up (its static IP): refused the same
          // way every tick until fixed in the developer console. Halt once.
          if (isAppSetupRejection(order.rejectionReason)) {
            const halt =
              `${d.action} ${b.symbol} refused by Zerodha: ${order.rejectionReason} ` +
              'Add the server static IP (BROKER_STATIC_IP) to your app at developers.kite.trade, then release this halt.';
            b = { ...b, haltedReason: halt, updatedAt: now };
            this.log(b, 'HALT', halt);
            void notifier.alert('critical', `acc-appsetup:${b.userId}`, halt);
            break;
          }
          this.log(b, 'REJECT', `${d.action} ${b.symbol}: ${order.rejectionReason ?? order.status}`);
          continue;
        }

        // A partial fill is a real outcome once orders are resolved against the
        // broker rather than assumed. Book what actually traded — recording the
        // requested size would put quantity in the book that is not in the
        // demat account, and every breakeven derived from it would be wrong.
        if (order.filledQuantity > 0 && order.filledQuantity < d.quantity!) {
          this.log(
            b, 'FILL',
            `PARTIAL ${d.action} ${b.symbol}: filled ${order.filledQuantity} of ${d.quantity}`,
          );
        }

        if (d.action === 'BUY') {
          // The lot is on the venue that filled it; a book with no open lots
          // takes the venue of its next buy.
          b = applyBuyFill({ ...b, venue }, {
            epoch: d.epoch!,
            level: d.level!,
            fillPrice: order.filledPrice,
            quantity: order.filledQuantity,
            at: now,
            orderId: record.id,
          }, DEFAULT_ACCUMULATOR_PARAMS);
          this.log(b, 'FILL', `BOUGHT ${order.filledQuantity} @ ₹${order.filledPrice.toFixed(2)} — ${d.reason}`);
        } else if (order.filledQuantity < d.quantity!) {
          // `sellLot` closes a lot WHOLE — it has no notion of half a lot. So a
          // partial sell cannot be booked: doing so would record the position
          // as gone while shares remain in the demat account, and every later
          // breakeven, P&L and no-loss decision would be computed against
          // holdings that do not exist. Halt the book and let a human split it.
          const halt =
            `Partial SELL on ${b.symbol}: ${order.filledQuantity} of ${d.quantity} filled ` +
            `(order ${order.brokerOrderId}). The remaining shares are still held. Reconcile ` +
            `against the broker and clear this halt manually.`;
          b = { ...b, haltedReason: halt, updatedAt: now };
          this.log(b, 'HALT', halt);
        } else {
          const settlesAt = nextTradingDayStart(now);
          // The user's forced sale is booked WITHOUT the breakeven check; the
          // bot's own sale always goes through `sellLot`, which refuses a loss.
          const book = d.forced ? forceSellLot : sellLot;
          b = book(b, d.lotId!, order.filledPrice, now, settlesAt, DEFAULT_ACCUMULATOR_PARAMS, record.id);
          const closed = b.closedLots[b.closedLots.length - 1];
          this.log(
            b, 'FILL',
            `${d.forced ? 'FORCED SALE (Sell button) — ' : ''}SOLD ${order.filledQuantity} @ ₹${order.filledPrice.toFixed(2)}, ` +
              `P&L ₹${closed.pnl.toFixed(2)}, settles ${istParts(settlesAt).date}`,
          );
        }
        // The shares have moved, so the book must be in MongoDB before the next
        // order goes out. Saved only at the end of the step, a restart in
        // between would lose the lot while the order row says FILLED, and the
        // next tick would buy the same rung again.
        b = this.saveStepped(b, start);
        const [bookSave, orderSave] = await Promise.all([
          store.flushAccumulatorBook(b.userId, b.symbol),
          store.orders.flushKey(record.id),
        ]);
        // Live, a fill that is not in the database is the crash window the
        // save exists to close: stop this book rather than send another order.
        // (Paper runs without a database in tests, so it is exempt.)
        const saveError = bookSave ?? orderSave;
        if (saveError && venue === 'live') {
          const halt =
            `${d.action} ${b.symbol} filled at ${brk.name} but could not be saved to the database (${saveError}). ` +
            'Check MongoDB, then reconcile and clear this halt.';
          b = { ...b, haltedReason: halt, updatedAt: now };
          this.log(b, 'HALT', halt);
          void notifier.alert('critical', `acc-unsaved:${b.userId}:${b.symbol}`, halt);
          break;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (filledAtBroker) {
          // The broker traded but the book could not record it. Continuing
          // would re-send the order next tick against shares already moved.
          const halt =
            `${d.action} ${b.symbol} FILLED at ${brk.name}${record?.brokerOrderId ? ` (order ${record.brokerOrderId})` : ''} ` +
            `but could not be booked: ${msg}. Reconcile against the broker, then clear this halt.`;
          b = { ...b, haltedReason: halt, updatedAt: now };
          this.log(b, 'HALT', halt);
          void notifier.alert('critical', `acc-unbooked:${b.userId}:${b.symbol}`, halt);
          break;
        }
        if (e instanceof BreakevenViolationError) {
          // The invariant refused the order before anything traded. The lot
          // stays open — a correct outcome, not an error to swallow.
          this.log(b, 'REFUSED', msg);
          continue;
        }
        if (record && record.status === 'PENDING') {
          store.orders.set(record.id, { ...record, status: 'REJECTED', rejectionReason: msg, updatedAt: Date.now() });
        }
        this.log(b, 'REJECT', msg);
      } finally {
        // Filled, rejected or thrown — the order is no longer in flight, so the
        // cash it was holding goes back to the pool. `finally` because a
        // reservation leaked on an error path would starve every later buy.
        fundsService.release(reservationId);
      }
    }
    return b;
  }

  /** Advance every book a user owns. */
  async runCycle(userId: string, prices: Record<string, number>): Promise<void> {
    for (const book of store.accumulatorBooksByUser(userId)) {
      const price = prices[book.symbol];
      if (!(price > 0)) continue;
      await this.step(book, price);
    }
  }

  /** Halts NEW RISK only. Exits are enforced elsewhere and are never blocked. */
  setKillSwitch(userId: string, symbol: string, engaged: boolean): AccumulatorBook | undefined {
    const b = store.accumulatorBook(userId, symbol);
    if (!b) return undefined;
    const next = { ...b, killSwitchEngaged: engaged, updatedAt: Date.now() };
    store.saveAccumulatorBook(next);
    logger.warn(`Accumulator kill switch ${engaged ? 'ENGAGED' : 'released'} for ${symbol}`);
    return next;
  }
}

export const accumulatorEngine = new AccumulatorEngine();

/** The §13 report: the flattering number never travels without the honest ones. */
export function reportFor(book: AccumulatorBook, markPrice: number) {
  const openCost = book.openLots.reduce((s, l) => s + l.quoteSpent, 0);
  const openValue = book.openLots.reduce((s, l) => s + l.quantity * markPrice, 0);
  const banked = book.closedLots.reduce((s, l) => s + l.pnl, 0);
  // Paper lots cleared before going live: not trades, but part of the paper result.
  const clearedPnl = (book.clearedLots ?? []).reduce((s, l) => s + l.pnl, 0);
  const now = Date.now();
  const oldest = book.openLots.reduce((m, l) => Math.max(m, now - l.openedAt), 0);
  const worst = book.openLots.reduce(
    (w, l) => Math.min(w, ((l.quantity * markPrice - l.quoteSpent) / l.quoteSpent) * 100),
    0,
  );
  const params = paramsFor(book, DEFAULT_ACCUMULATOR_PARAMS);
  const deployable = book.budget * (1 - params.reservePct / 100);
  const scalpOn = scalpActive(book);

  return {
    /** The profile actually in force, and what it means, for the UI. */
    scalpOn,
    profile: scalpOn ? ('scalp' as const) : ('swing' as const),
    profileNote: describeProfile(scalpOn),
    targetPct: params.targetPct,
    stepPct: params.stepPct,
    minBuyGapHours: params.minBuyGapMs / 3_600_000,
    startDiscountPct: params.startDiscountPct,
    hiLookbackDays: params.hiLookbackDays,
    tranches: params.tranches,
    /** Ratchet settings in force, so the UI can explain an armed lot's exit. */
    trailEnabled: params.trail.enabled,
    trailArmPct: params.trail.armPct,
    trailRetracePct: params.trail.retracePct,
    /** True while this book's lots ride past the target instead of selling at it. */
    ridingUptrend: ridingUptrend(book, params),
    uptrendTrailPct: params.trail.uptrend.retracePct,
    deployCeiling: deployCeiling(book, params),
    equity: equity(book, markPrice),
    cash: book.cash,
    unsettledCash: book.unsettled.reduce((s, c) => s + c.amount, 0),
    bankedProfit: banked,
    clearedPnl,
    openCostBasis: openCost,
    openMarketValue: openValue,
    unrealisedPnl: openValue - openCost,
    unrealisedPct: openCost > 0 ? ((openValue - openCost) / openCost) * 100 : 0,
    deployed: openCost,
    deployable,
    reserve: book.budget - deployable,
    openLots: book.openLots.length,
    closedTrades: book.closedLots.length,
    oldestOpenLotDays: oldest / 86_400_000,
    worstOpenLotPct: worst,
    winRatePct:
      book.closedLots.length === 0
        ? 0
        : (book.closedLots.filter((l) => l.pnl > 0).length / book.closedLots.length) * 100,
    /**
     * Shown with every win rate, always. It is ~100% by construction, so on its
     * own it says nothing about performance — and SEBI prohibits presenting it
     * as an assured return.
     */
    winRateLabel: 'structural — ~100% by design, carries no information on its own',
  };
}
