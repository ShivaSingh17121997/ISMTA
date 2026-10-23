/**
 * Capital allocator — the stateful half of services/allocator.
 *
 * The user's brief for this piece, verbatim: "let bot decide at what time it
 * need to invest what amount" and "let bot decide which stock is performing
 * good should get more money". This service is the scheduler and the wiring;
 * the decisions live in two pure, tested modules:
 *
 *   allocator/strength.ts   how strong each company has been (0..1)
 *   allocator/allocate.ts   who gets funded, how much, on how many rungs
 *
 * WHEN a rupee is actually spent stays the ladder's call. The allocator hands
 * each book a budget and a rung count; the start gate and the rungs in
 * accumulator/engine.ts pick the day. That split is deliberate: the ladder is
 * what makes "never sell below cost" hold, and nothing here reaches into it.
 *
 * What it never does: sell a lot, move a lot, or touch unsettled proceeds.
 * Only settled, uncommitted cash is re-assigned. A book that loses its
 * allocation is marked `allocatorPaused` (no NEW rungs); its exits are
 * evaluated exactly as before.
 *
 * Cadence: once per trading day after the close (15:35 IST), when the day's
 * bar is final, plus once at boot for a user who has never been allocated. It
 * applies its plan only while the accumulator scheduler is idle, so the two
 * never write the same book at once.
 */

import { config } from '../config';
import { isMongoConnected } from '../store/db';
import { store } from '../store/memoryStore';
import { logger } from '../utils/logger';
import { accumulatorEngine } from './AccumulatorEngine';
import { fundsService } from './FundsService';
import { cashSweep } from './CashSweepService';
import { hhmm, istParts, isTradingDay } from './session';
import { fetchYahooChart } from './yahoo';
import { cleanDailyBars } from './barCleaning';
import {
  DEFAULT_ALLOCATION_PARAMS,
  allocate,
  allocatorPool,
  bookCandidateFields,
  enabledAfter,
  manualBudgetError,
  manualRungs,
  rungsForBook,
  type Allocation,
  type AllocationParams,
  type AllocatorRun,
  type Candidate,
} from './allocator/allocate';
import { strength, type Strength } from './allocator/strength';
import { DEFAULT_ACCUMULATOR_PARAMS, type AccumulatorBook } from './accumulator/types';
import { planRungs, type RungPlan } from './accumulator/rungPlan';
import { paramsFor } from './accumulator/engine';
import { rungFloor, type RungFloor } from './allocator/rungFloor';
import { marketData } from './MarketDataService';

/** EMA200 needs 200 daily bars; one year of NSE sessions is ~248. */
const HISTORY_RANGE = '1y';
const HISTORY_INTERVAL = '1d';
/** A manual re-run inside this window re-uses the bars already fetched. */
const HISTORY_TTL_MS = 6 * 3_600_000;
const FETCH_CONCURRENCY = 3;
/** The daily pass waits for the close so the last bar is final. */
const RUN_AFTER_IST = '15:35';

/** An amount the allocator cannot honour; the message is for the user. */
export class ManualBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManualBudgetError';
  }
}

export interface AllocatorEvent {
  at: number;
  userId: string;
  kind: 'RUN' | 'SKIP' | 'ERROR';
  detail: string;
}

interface History {
  at: number;
  closes: number[];
  highs: number[];
  error?: string;
}

export class AllocatorEngine {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = new Set<string>();
  private history = new Map<string, History>();
  private events: AllocatorEvent[] = [];

  /**
   * The pure allocator's defaults with the configured capital as the pool.
   *
   * Synchronous, so it stays usable from a route that just wants to show the
   * settings. It reports the CONFIGURED figure — use `liveParams()` for a
   * decision, which asks the broker what is really there.
   */
  params(): AllocationParams {
    return { ...DEFAULT_ALLOCATION_PARAMS, totalCapital: config.risk.capital };
  }

  /**
   * The same defaults, but sized against the broker's actual deployable cash.
   *
   * This is what makes money added in a broker's mobile app reach the strategy:
   * nothing is imported or synced, the pool is simply re-read from the broker
   * before each allocation. Add ₹50,000 by UPI and the next run plans against
   * ₹50,000 more. Withdraw, and the pool shrinks — which correctly stops NEW
   * entries and never forces a sale, because selling to raise cash would mean
   * selling below breakeven and the no-loss invariant forbids exactly that.
   *
   * In paper mode this resolves to RISK_CAPITAL, so behaviour is unchanged.
   *
   * On a live account the broker reports FREE cash, which already excludes
   * every open lot and anything the idle-cash sweep has parked; both are added
   * back so the pool means the same thing it means in paper. See `allocatorPool`.
   */
  async liveParams(userId?: string): Promise<AllocationParams> {
    const funds = await fundsService.snapshot(userId);
    const books = userId ? store.accumulatorBooksByUser(userId) : [];
    const totalCapital = allocatorPool({
      funds: funds.deployable,
      simulated: funds.simulated,
      // The same sum `candidate()` puts in `deployed`, so `allocate` cancels it exactly.
      deployed: books.reduce((s, b) => s + b.openLots.reduce((t, l) => t + l.quoteSpent, 0), 0),
      parked: userId ? cashSweep.marketValue(userId) : 0,
    });
    return { ...DEFAULT_ALLOCATION_PARAMS, totalCapital };
  }

  start(checkMs = 5 * 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), checkMs);
    this.timer.unref?.();
    void this.tick();
    logger.info(
      `AllocatorEngine started (daily after ${RUN_AFTER_IST} IST; ` +
        `capital ₹${config.risk.capital.toLocaleString('en-IN')})`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Every user who owns at least one book. */
  private userIds(): string[] {
    return [...new Set([...store.accumulatorBooks.values()].map((b) => b.userId))];
  }

  lastRun(userId: string): AllocatorRun | undefined {
    let best: AllocatorRun | undefined;
    for (const r of store.allocatorRuns.values()) {
      if (r.userId === userId && (!best || r.at > best.at)) best = r;
    }
    return best;
  }

  /** Is a scheduled pass owed to this user right now, and why or why not. */
  due(userId: string, now = Date.now()): { due: boolean; why: string } {
    const last = this.lastRun(userId);
    if (!last) {
      // "No record" has two meanings: never allocated, or the history could
      // not be read. Only the first is a reason to reallocate. Treating the
      // second as the first re-shuffles every budget on a boot that happened
      // to race the store — silently, and once per restart.
      if (!isMongoConnected()) {
        return { due: false, why: 'store not readable — refusing to reallocate against an unknown history' };
      }
      return { due: true, why: 'never allocated' };
    }
    const p = istParts(now);
    if (!isTradingDay(now)) return { due: false, why: `not a trading day; last run ${last.tradingDay}` };
    if (p.minutes < hhmm(RUN_AFTER_IST)) {
      return { due: false, why: `next pass after ${RUN_AFTER_IST} IST today; last run ${last.tradingDay}` };
    }
    if (last.tradingDay === p.date) return { due: false, why: `already ran today (${p.date})` };
    return { due: true, why: `daily pass for ${p.date}; last run ${last.tradingDay}` };
  }

  private async tick(now = Date.now()): Promise<void> {
    for (const userId of this.userIds()) {
      const d = this.due(userId, now);
      if (!d.due) continue;
      try {
        await this.runFor(userId, d.why, now, false);
      } catch (e) {
        this.log(userId, 'ERROR', e instanceof Error ? e.message : String(e));
      }
    }
  }

  /**
   * Fix (or, with null, release) the budget of one stock by hand, then re-run
   * the allocation so it applies now rather than after tomorrow's close.
   * Throws a user-facing message when the amount cannot be honoured. The
   * re-run can be refused (a pass already in flight, the engine busy); the
   * amount is saved either way and lands on the next pass.
   */
  /**
   * What an amount and rung count would do to one book: rupees per rung, rungs
   * bought and to buy, and the most rungs the amount allows. `rungs` null =
   * what the allocator would pick on its own.
   */
  previewRungs(userId: string, symbol: string, amount: number, rungs: number | null): RungPlan {
    const book = store.accumulatorBook(userId, symbol);
    if (!book) throw new Error(`No book for ${symbol}`);
    const p = this.params();
    const held = book.openLots.reduce((s, l) => s + l.quoteSpent, 0) + book.unsettled.reduce((s, c) => s + c.amount, 0);
    const newCash = Math.max(0, amount - held);
    const r = rungs ?? rungsForBook(bookCandidateFields(book), newCash, p, (x) => (x > 0 ? manualRungs(x, p) : p.minRungs));
    // A rung you size by hand needs only to be worth buying at this stock's price.
    const floor = this.rungFloorFor(book);
    return planRungs(book, amount, r, DEFAULT_ACCUMULATOR_PARAMS, { minPerRung: floor.perRung, maxRungs: p.maxRungs });
  }

  /** The smallest worthwhile rung for one book at its current price (allocator/rungFloor). */
  rungFloorFor(book: AccumulatorBook): RungFloor {
    const price = marketData.getPrice(book.symbol) || book.lastPrice || book.previousClose || 0;
    const ap = paramsFor(book, DEFAULT_ACCUMULATOR_PARAMS);
    return rungFloor(price, ap.targetPct, book.instrument, ap.reservePct, this.params().minTranche);
  }

  /**
   * The preview the panel shows: the amount checks Save runs (minimum new
   * money, at most what is free) first, then the rung plan. So a preview can
   * never say "fine" for something Save would refuse.
   */
  async previewBudget(userId: string, symbol: string, amount: number, rungs: number | null): Promise<RungPlan> {
    const plan = this.previewRungs(userId, symbol, amount, rungs);
    const book = store.accumulatorBook(userId, symbol)!;
    const held = (b: AccumulatorBook) => ({
      deployed: b.openLots.reduce((s, l) => s + l.quoteSpent, 0),
      unsettled: b.unsettled.reduce((s, c) => s + c.amount, 0),
      manualBudget: b.manualBudget,
    });
    const others = store.accumulatorBooksByUser(userId).filter((b) => b.symbol !== book.symbol).map(held);
    const amountError = manualBudgetError(amount, held(book), others, await this.liveParams(userId), this.rungFloorFor(book));
    return amountError ? { ...plan, error: amountError } : plan;
  }

  async setManualBudget(
    userId: string,
    symbol: string,
    amount: number | null,
    rungs: number | null = null,
  ): Promise<{ book: AccumulatorBook; run: AllocatorRun | null; pending?: string; plan?: RungPlan }> {
    const book = store.accumulatorBook(userId, symbol);
    if (!book) throw new Error(`No book for ${symbol}`);
    if (amount === null && rungs !== null) throw new ManualBudgetError('Set an amount before choosing the number of rungs.');
    if (amount !== null) {
      const held = (b: AccumulatorBook) => ({
        deployed: b.openLots.reduce((s, l) => s + l.quoteSpent, 0),
        unsettled: b.unsettled.reduce((s, c) => s + c.amount, 0),
        manualBudget: b.manualBudget,
      });
      const others = store.accumulatorBooksByUser(userId).filter((b) => b.symbol !== book.symbol).map(held);
      const err = manualBudgetError(amount, held(book), others, await this.liveParams(userId), this.rungFloorFor(book));
      if (err) throw new ManualBudgetError(err);
    }
    // Rungs are checked with the engine's own ladder maths on the would-be book.
    const plan = amount !== null ? this.previewRungs(userId, symbol, Math.floor(amount), rungs) : undefined;
    if (plan?.error && rungs !== null) throw new ManualBudgetError(plan.error);
    const next: AccumulatorBook = { ...book, updatedAt: Date.now() };
    if (amount === null) {
      delete next.manualBudget;
      delete next.manualTranches;
    } else {
      next.manualBudget = Math.floor(amount);
      if (rungs === null) delete next.manualTranches;
      else next.manualTranches = rungs;
    }
    store.saveAccumulatorBook(next);
    this.log(
      userId, 'RUN',
      amount === null
        ? `${symbol}: budget back to automatic`
        : `${symbol}: budget fixed by you at ₹${Math.floor(amount).toLocaleString('en-IN')}` +
          (rungs !== null ? ` on ${rungs} rungs` : ''),
    );
    try {
      const run = await this.runFor(userId, `budget for ${symbol} ${amount === null ? 'set to automatic' : 'set by you'}`);
      return { book: store.accumulatorBook(userId, symbol)!, run, ...(plan ? { plan } : {}) };
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return { book: next, run: null, pending: `Saved. It applies on the next allocator pass (${why}).`, ...(plan ? { plan } : {}) };
    }
  }

  recentEvents(userId?: string, limit = 50): AllocatorEvent[] {
    const all = userId ? this.events.filter((e) => e.userId === userId) : this.events;
    return all.slice(-limit).reverse();
  }

  private log(userId: string, kind: AllocatorEvent['kind'], detail: string): void {
    this.events.push({ at: Date.now(), userId, kind, detail });
    if (this.events.length > 500) this.events = this.events.slice(-500);
    if (kind === 'ERROR') logger.error(`allocator: ${detail}`);
    else logger.info(`allocator: ${detail}`);
  }

  private async fetchHistory(symbol: string, now: number): Promise<History> {
    const hit = this.history.get(symbol);
    if (hit && !hit.error && now - hit.at < HISTORY_TTL_MS) return hit;
    let h: History;
    try {
      const chart = await fetchYahooChart(symbol, HISTORY_RANGE, HISTORY_INTERVAL, 15_000);
      const bars = cleanDailyBars((chart?.candles ?? []).filter((c) => c.close > 0 && c.high > 0 && c.low > 0));
      h = { at: now, closes: bars.map((c) => c.close), highs: bars.map((c) => c.high) };
      if (!bars.length) h.error = 'Yahoo returned no daily bars';
    } catch (e) {
      h = { at: now, closes: [], highs: [], error: e instanceof Error ? e.message : String(e) };
    }
    this.history.set(symbol, h);
    return h;
  }

  /** A year of daily bars per symbol, a few at a time — Yahoo is unofficial and rate-limits. */
  private async histories(symbols: string[], now: number): Promise<Map<string, History>> {
    const out = new Map<string, History>();
    const queue = [...symbols];
    const worker = async (): Promise<void> => {
      for (let s = queue.shift(); s !== undefined; s = queue.shift()) {
        out.set(s, await this.fetchHistory(s, now));
      }
    };
    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, worker));
    return out;
  }

  private candidate(book: AccumulatorBook, h: History): { cand: Candidate; strength: Strength | null } {
    // The same fields the backtest uses, so the two allocate identically.
    const base = bookCandidateFields(book);
    const skip = (reason: string): { cand: Candidate; strength: null } => ({
      cand: { ...base, score: 0, trendUp: false, eligible: false, reason },
      strength: null,
    });
    // The user's manual halts win over the bot's opinion, every time.
    if (book.killSwitchEngaged) return skip('kill switch engaged — you halted new risk on this book');
    if (book.haltedReason) return skip(`halted: ${book.haltedReason}`);
    if (h.error) return skip(`no price history: ${h.error}`);
    const s = strength(book.symbol, h.closes, h.highs);
    return {
      cand: {
        ...base,
        score: s.score,
        trendUp: s.trendUp,
        eligible: s.eligible,
        ...(s.reason ? { reason: s.reason } : {}),
      },
      strength: s,
    };
  }

  /** Never write a book while a scheduler step may be mid-flight on it. */
  private async whenAccumulatorIdle(maxWaitMs = 30_000): Promise<boolean> {
    const until = Date.now() + maxWaitMs;
    while (accumulatorEngine.busy && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 250));
    }
    return !accumulatorEngine.busy;
  }

  /**
   * One full pass for a user: score every book, allocate, apply, persist.
   * Safe to call by hand at any time; the daily schedule calls it once.
   */
  async runFor(
    userId: string,
    why = 'manual',
    now = Date.now(),
    /** False for the daily scheduler, which must never apply a redundant pass. */
    manual = true,
  ): Promise<AllocatorRun> {
    if (this.inFlight.has(userId)) throw new Error('An allocator pass is already running for this user');
    this.inFlight.add(userId);
    try {
      const books = store.accumulatorBooksByUser(userId);
      const params = await this.liveParams(userId);
      const hist = await this.histories(books.map((b) => b.symbol), now);

      const strengths: Record<string, Strength> = {};
      const cands: Candidate[] = [];
      for (const b of books) {
        const h = hist.get(b.symbol) ?? { at: now, closes: [], highs: [], error: 'not fetched' };
        const { cand, strength: s } = this.candidate(b, h);
        cands.push(cand);
        if (s) strengths[b.symbol] = s;
      }

      const plan = allocate(cands, params);

      // Fetching a year of bars for every book takes seconds. Re-check before
      // writing: a scheduled pass that became redundant while it was fetching
      // must not land, or a restart during that window silently re-shuffles
      // budgets that were already settled for the day.
      const tradingDay = istParts(now).date;
      if (!manual && this.lastRun(userId)?.tradingDay === tradingDay) {
        throw new Error(`a pass for ${tradingDay} landed while this one was fetching; not applying it twice`);
      }

      if (!(await this.whenAccumulatorIdle())) {
        throw new Error('accumulator scheduler stayed busy for 30s; allocation not applied');
      }
      for (const a of plan.allocations) this.apply(userId, a, now);

      const run: AllocatorRun = { userId, at: now, tradingDay, params, plan, strengths };
      store.allocatorRuns.set(`${userId}:${tradingDay}`, run);

      const placed = plan.allocatable - plan.unallocated;
      this.log(
        userId, 'RUN',
        `${why}: funded ${plan.selected.length ? plan.selected.join(', ') : 'nothing'} — ` +
          `₹${Math.round(placed).toLocaleString('en-IN')} of ₹${Math.round(plan.allocatable).toLocaleString('en-IN')} free cash placed, ` +
          `₹${Math.round(plan.committed).toLocaleString('en-IN')} already in lots/T+1, ${books.length} books scored`,
      );
      return run;
    } finally {
      this.inFlight.delete(userId);
    }
  }

  /**
   * Write one allocation onto its book. Re-reads the store first so it applies
   * to the freshest copy. Lots, epochs and the unsettled queue are untouched by
   * construction — an allocation only ever carries budget, cash and rungs.
   */
  private apply(userId: string, a: Allocation, now: number): void {
    const book = store.accumulatorBook(userId, a.symbol);
    if (!book) return;
    const enabled = enabledAfter(a, book.enabled);
    const flipped = enabled !== book.enabled;
    const next: AccumulatorBook = {
      ...book,
      budget: a.targetBudget,
      cash: a.targetCash,
      tranches: a.tranches,
      allocatorPaused: !a.selected,
      allocatorNote: a.reason,
      enabled,
      // Stamp the author only when the flag actually moved, so a nightly pass
      // does not erase the record of who last set it.
      ...(flipped ? { enabledChangedAt: now, enabledChangedBy: 'allocator' as const } : {}),
      updatedAt: now,
    };
    store.saveAccumulatorBook(next);
  }
}

export const allocatorEngine = new AllocatorEngine();
