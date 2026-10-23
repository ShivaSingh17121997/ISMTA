/**
 * Idle-cash sweep — the stateful half. The decisions live in sweep/plan.ts.
 *
 * Parks the books' spare settled cash in a liquid ETF (LIQUIDCASE by default)
 * once a day after the last possible rung, and sells units back when a rung
 * needs the cash. See sweep/plan.ts for why each rule is what it is.
 *
 * WIRING
 *
 *   - AccumulatorEngine calls `ensureCash` before reserving funds for a BUY.
 *     With nothing parked it returns immediately, so a user who never switches
 *     the sweep on runs exactly the code path they ran before.
 *   - AllocatorEngine adds `marketValue` back into capital on a live account:
 *     the broker's cash falls by whatever is parked, and without that the
 *     allocator would read parking as losing money and shrink every budget.
 *   - SnapshotService counts the units (live) or their gain (paper) in equity.
 *   - ReconcileService expects the units on a live account and halts the sweep,
 *     not the books, if they are missing.
 *
 * Every order goes through the same pre-trade gate, rate limiter, order ledger
 * and funds reservation as a book's order, on the user's own broker.
 */
import { randomUUID } from 'node:crypto';
import { brokerFor, venueOf } from '../brokers/registry';
import { store } from '../store/memoryStore';
import type { Order, OrderRequest } from '../types';
import { logger } from '../utils/logger';
import { charges } from './costs';
import { fundsService } from './FundsService';
import { orderRateLimiter } from './guards';
import { marketData } from './MarketDataService';
import { notifier } from './Notifier';
import { roundToTick } from './nse';
import { preTradeGate } from './orderGate';
import { hhmm, istParts, isMarketOpen, nextTradingDayStart } from './session';
import { config } from '../config';
import { fetchYahooChart, fetchYahooQuote } from './yahoo';
import { paramsFor } from './accumulator/engine';
import { trancheSize } from './accumulator/math';
import { DEFAULT_ACCUMULATOR_PARAMS, type AccumulatorBook } from './accumulator/types';

/** Unassigned money older than this is not trusted: the allocator runs every trading day. */
const UNASSIGNED_MAX_AGE_MS = 4 * 86_400_000;

/**
 * What the allocator's latest pass for this user left unassigned. Read from
 * the stored run, not by importing the allocator (it imports this service).
 * Zero when there is no recent run, so a stale plan never parks money a book
 * has since been given.
 */
export function unassignedCash(userId: string, now = Date.now()): number {
  let latest: { at: number; plan: { unallocated: number } } | undefined;
  for (const r of store.allocatorRuns.values()) {
    if (r.userId === userId && (!latest || r.at > latest.at)) latest = r;
  }
  if (!latest || now - latest.at > UNASSIGNED_MAX_AGE_MS) return 0;
  return Math.max(0, latest.plan.unallocated);
}
import {
  DEFAULT_SWEEP_PARAMS,
  applyParkFill,
  applyRedeemFill,
  bufferNeed,
  cashOnHand,
  decideScheduled,
  marketValue,
  newSweepState,
  planRedeem,
  rungsPerSession,
  totalGain,
  unitsHeld,
  usableUnits,
  type SweepParams,
  type SweepState,
} from './sweep/plan';

export interface SweepEvent {
  at: number;
  userId: string;
  kind: 'PARK' | 'REDEEM' | 'SKIP' | 'REJECT' | 'HALT' | 'CONFIG';
  detail: string;
}

/** A quote older than this is re-read before trading on it. */
const QUOTE_MAX_AGE_MS = 90_000;
/** Marketable-limit offset: LIQUIDCASE moves ~0.02%/day, so 0.1% always crosses. */
const LIMIT_OFFSET = 0.001;
const YIELD_TTL_MS = 6 * 3_600_000;
/** Minutes a book may enter in, from the session config (09:20–15:00 by default). */
const ENTRY_WINDOW_MIN = hhmm(config.session.entryClosesAt) - hhmm(config.session.entryOpensAt);

export class CashSweepService {
  readonly params: SweepParams = DEFAULT_SWEEP_PARAMS;
  private timer: NodeJS.Timeout | null = null;
  private locks = new Map<string, Promise<unknown>>();
  private events: SweepEvent[] = [];
  private yieldCache: { at: number; pct: number | null } | null = null;

  /** The user's sweep, or a fresh (off, empty) one that is not yet persisted. */
  state(userId: string, now = Date.now()): SweepState {
    return store.cashSweeps.get(userId) ?? newSweepState(userId, now, this.params.symbol);
  }

  private save(s: SweepState): void {
    store.cashSweeps.set(s.userId, s);
  }

  start(checkMs = 60_000): void {
    if (this.timer) return;
    this.repairClearedPaperTotals();
    // Ask the feed to keep the parking ETF priced, so its quote is fresh when needed.
    marketData.registerSymbol(this.params.symbol);
    this.timer = setInterval(() => void this.tick(), checkMs);
    this.timer.unref?.();
    logger.info(`CashSweepService started (${this.params.symbol}; parks ${this.params.parkFrom}–${this.params.parkUntil} IST)`);
  }

  /**
   * Sweeps cleared before `clearPaper` reset the running totals still carry the
   * paper income in `realisedGain`. Matches only that exact state: no venue, no
   * units, nothing owed, and every recorded sale a paper one.
   */
  repairClearedPaperTotals(): number {
    let fixed = 0;
    for (const s of [...store.cashSweeps.values()]) {
      if (!isClearedPaperLedger(s)) continue;
      this.save({ ...s, realisedGain: 0, chargesPaid: 0 });
      logger.info(`cash sweep ${s.userId}: paper income (₹${s.realisedGain.toFixed(2)}) removed from the totals after an earlier clear`);
      fixed++;
    }
    return fixed;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  recentEvents(userId: string, limit = 30): SweepEvent[] {
    return this.events.filter((e) => e.userId === userId).slice(-limit).reverse();
  }

  private log(userId: string, kind: SweepEvent['kind'], detail: string, now = Date.now()): void {
    // A quiet hold every minute would bury the events that matter.
    const mine = this.events.filter((e) => e.userId === userId);
    const last = mine[mine.length - 1];
    if (kind === 'SKIP' && last?.kind === 'SKIP' && last.detail === detail) return;
    this.events.push({ at: now, userId, kind, detail });
    if (this.events.length > 1_000) this.events = this.events.slice(-1_000);
    if (kind !== 'SKIP') store.audit({ userId, kind: 'sweep', symbol: this.params.symbol, detail: `${kind}: ${detail}`, at: now });
    const line = `sweep ${userId.slice(0, 8)}: ${kind} ${detail}`;
    if (kind === 'HALT' || kind === 'REJECT') logger.warn(line);
    else if (kind !== 'SKIP') logger.info(line);
  }

  /**
   * Before going live: unwind PAPER units at the current price (paper charges,
   * no order), then zero the ledger so nothing simulated is counted as cash
   * parked from a real account. Live units are never touched. Returns null when
   * there was nothing paper to clear.
   */
  async clearPaper(userId: string, now = Date.now()): Promise<{ units: number; proceeds: number } | null> {
    return this.withLock(userId, async () => {
      let s = store.cashSweeps.get(userId);
      if (!s || (s.venue ?? 'paper') !== 'paper') return null;
      const units = unitsHeld(s);
      if (units === 0 && s.cashOut === 0) return null;
      let proceeds = 0;
      if (units > 0) {
        const price = marketData.getPrice(s.symbol) || s.lots[s.lots.length - 1]?.price || 0;
        if (!(price > 0)) throw new Error(`no ${s.symbol} price to unwind the paper units at`);
        const fee = charges('SELL', price, units, { product: 'CNC', instrument: 'ETF' }).total;
        s = applyRedeemFill(s, { quantity: units, price, charges: fee, at: now });
        proceeds = units * price - fee;
      }
      // What is left in cashOut is paper income; a live ledger must start at zero.
      // So do the running totals: paper income is not live income. The rows stay
      // in `realised`, tagged paper, which the tax view's venue filter leaves out.
      const next: SweepState = { ...s, cashOut: 0, realisedGain: 0, chargesPaid: 0, updatedAt: now };
      delete next.venue;
      this.save(next);
      this.log(userId, 'REDEEM', `paper units cleared before going live: ${units} unit(s), ₹${proceeds.toFixed(0)} back; no order placed`, now);
      return { units, proceeds };
    });
  }

  /** Serialise everything that trades for one user — a top-up and a rung must not both sell. */
  private withLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(userId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.locks.set(userId, next);
    void next.finally(() => {
      if (this.locks.get(userId) === next) this.locks.delete(userId);
    }).catch(() => undefined);
    return next;
  }

  /**
   * The books' settled cash (plus unassigned cash, see `unassignedCash`) and
   * the buffer to keep in the account.
   * `override` is a book mid-step whose cash in memory is newer than the store's.
   */
  ledger(userId: string, override?: AccumulatorBook): { idle: number; buffer: number } {
    const books = store.accumulatorBooksByUser(userId).map((b) =>
      override && b.symbol === override.symbol ? override : b,
    );
    // Book cash, plus what the allocator left unassigned on its latest pass:
    // that money is in the account too, and otherwise earns nothing.
    const idle = books.reduce((s, b) => s + Math.max(0, b.cash), 0) + (this.params.includeUnassigned ? unassignedCash(userId) : 0);
    const buffer = bufferNeed(
      books.map((b) => ({
        cash: b.cash,
        tranche: trancheSize(b.budget, paramsFor(b, DEFAULT_ACCUMULATOR_PARAMS)),
        rungs: rungsPerSession(paramsFor(b, DEFAULT_ACCUMULATOR_PARAMS).minBuyGapMs, ENTRY_WINDOW_MIN),
        active: b.enabled && !b.killSwitchEngaged && !b.haltedReason && !b.allocatorPaused,
      })),
      this.params,
    );
    return { idle, buffer };
  }

  /** A fresh price for the parking ETF, from the feed or straight from Yahoo. */
  async price(now = Date.now()): Promise<number> {
    const sym = this.params.symbol;
    if (marketData.getPrice(sym) > 0 && marketData.quoteAge(sym, now) < QUOTE_MAX_AGE_MS) return marketData.getPrice(sym);
    const q = await fetchYahooQuote(sym).catch(() => null);
    if (q) {
      if (q.previousClose) marketData.setReference(sym, q.previousClose);
      marketData.ingestExternal(sym, q.ltp, q.quoteTime ?? undefined);
    }
    return marketData.getPrice(sym);
  }

  /** Trailing one-month return of the ETF, annualised — what parking is earning right now. */
  async currentYieldPct(now = Date.now()): Promise<number | null> {
    if (this.yieldCache && now - this.yieldCache.at < YIELD_TTL_MS) return this.yieldCache.pct;
    let pct: number | null = null;
    try {
      const chart = await fetchYahooChart(this.params.symbol, '3mo', '1d', 15_000);
      const bars = (chart?.candles ?? []).filter((c) => c.close > 0);
      if (bars.length >= 20) {
        const a = bars[bars.length - 22] ?? bars[0];
        const b = bars[bars.length - 1];
        const days = (b.timestamp - a.timestamp) / 86_400_000;
        if (days > 0) pct = (Math.pow(b.close / a.close, 365 / days) - 1) * 100;
      }
    } catch {
      pct = null;
    }
    this.yieldCache = { at: now, pct };
    return pct;
  }

  setEnabled(userId: string, enabled: boolean, now = Date.now()): SweepState {
    const s = { ...this.state(userId, now), enabled, updatedAt: now };
    this.save(s);
    this.log(userId, 'CONFIG', enabled
      ? `switched ON — spare cash above the buffer is parked in ${s.symbol} after ${this.params.parkFrom} IST`
      : `switched OFF — parked units are sold back as the T1 rule allows`, now);
    return s;
  }

  releaseHalt(userId: string, now = Date.now()): SweepState {
    const s = { ...this.state(userId, now), haltedReason: undefined, updatedAt: now };
    this.save(s);
    this.log(userId, 'CONFIG', 'halt cleared by the user', now);
    return s;
  }

  halt(userId: string, reason: string, now = Date.now()): void {
    const s = this.state(userId, now);
    if (s.haltedReason) return;
    this.save({ ...s, haltedReason: reason, updatedAt: now });
    this.log(userId, 'HALT', reason, now);
    void notifier.alert('critical', `sweep-halt:${userId}`, `Cash sweep halted: ${reason}`);
  }

  /** Market value of the parked units — the capital the broker's cash figure no longer shows. */
  marketValue(userId: string): number {
    const s = store.cashSweeps.get(userId);
    if (!s || unitsHeld(s) === 0) return 0;
    const px = marketData.getPrice(s.symbol) || s.lots[s.lots.length - 1]?.price || 0;
    return marketValue(s, px);
  }

  /** Income so far, realised and marked. Zero when nothing was ever parked. */
  gain(userId: string): number {
    const s = store.cashSweeps.get(userId);
    if (!s) return 0;
    const px = marketData.getPrice(s.symbol) || s.lots[s.lots.length - 1]?.price || 0;
    return totalGain(s, px);
  }

  /**
   * Make sure `amount` rupees of a book's cash is in the account, not parked.
   * Sells usable units when it is not. Returns ok:false only when the cash is
   * parked AND locked by the T1 rule (or the sweep cannot trade) — the caller
   * then skips the rung exactly as it would for any other shortage of cash.
   */
  async ensureCash(
    userId: string,
    amount: number,
    override?: AccumulatorBook,
    now = Date.now(),
  ): Promise<{ ok: boolean; reason?: string; redeemed?: number }> {
    const s0 = store.cashSweeps.get(userId);
    if (!s0 || unitsHeld(s0) === 0 || !(amount > 0)) return { ok: true };
    return this.withLock(userId, async () => {
      const s = this.state(userId, now);
      const { idle, buffer } = this.ledger(userId, override);
      const available = cashOnHand(idle, s) - fundsService.reserved(userId, now);
      if (available >= amount) return { ok: true };

      const shortfall = amount - available;
      if (s.haltedReason) return { ok: false, reason: `₹${Math.round(shortfall)} of it is parked and the sweep is halted: ${s.haltedReason}` };
      // Raise the rung AND refill the buffer, so the next rung does not pay a second sale.
      const want = Math.max(shortfall, buffer - (available - amount));
      const price = await this.price(now);
      const plan = planRedeem({ need: want, state: s, price, now, params: this.params });
      if (plan.quantity === 0 || plan.amount < shortfall - 0.01) {
        const next = s.lots.find((l) => now < l.usableFrom);
        return {
          ok: false,
          reason:
            `₹${Math.round(shortfall).toLocaleString('en-IN')} of the cash is parked in ${s.symbol} and ` +
            `still T1-locked` + (next ? ` (usable from ${istParts(next.usableFrom).date})` : ''),
        };
      }
      const sold = await this.trade(userId, 'SELL', plan.quantity, price, now, `to fund a ₹${Math.round(amount).toLocaleString('en-IN')} rung`);
      if (!sold.ok) return { ok: false, reason: `could not sell ${s.symbol}: ${sold.reason}` };
      const after = cashOnHand(this.ledger(userId, override).idle, this.state(userId, now)) - fundsService.reserved(userId, now);
      if (after < amount) return { ok: false, reason: `sold ${sold.quantity} units but only ₹${Math.round(after)} is in the account` };
      // A live balance cached before the sale would still read the old figure.
      await fundsService.read(userId, true, now).catch(() => undefined);
      return { ok: true, redeemed: sold.quantity };
    });
  }

  /** One scheduled pass over every user who has a sweep. */
  async tick(now = Date.now()): Promise<void> {
    if (!isMarketOpen(now)) return;
    for (const s of [...store.cashSweeps.values()]) {
      if (!s.enabled && unitsHeld(s) === 0) continue;
      try {
        await this.runFor(s.userId, now);
      } catch (e) {
        this.log(s.userId, 'REJECT', e instanceof Error ? e.message : String(e), now);
      }
    }
  }

  /** Decide and act for one user. Safe to call by hand; the scheduler calls it every minute. */
  async runFor(userId: string, now = Date.now()): Promise<{ action: string; reason: string }> {
    return this.withLock(userId, async () => {
      if (!isMarketOpen(now)) return { action: 'none', reason: 'market closed' };
      const s = this.state(userId, now);
      const { idle, buffer } = this.ledger(userId);
      const price = await this.price(now);
      const { date, minutes } = istParts(now);
      const act = decideScheduled({ state: s, idle, buffer, price, now, minutes, today: date, params: this.params });
      if (act.kind === 'none') {
        this.log(userId, 'SKIP', act.reason, now);
        return { action: 'none', reason: act.reason };
      }
      if (act.kind === 'park') {
        const r = await this.trade(userId, 'BUY', act.quantity, price, now, act.reason);
        if (r.ok) this.save({ ...this.state(userId, now), lastParkDay: date });
        return { action: r.ok ? 'park' : 'none', reason: r.ok ? act.reason : r.reason ?? 'refused' };
      }
      const r = await this.trade(userId, 'SELL', act.quantity, price, now, act.reason);
      return { action: r.ok ? 'redeem' : 'none', reason: r.ok ? act.reason : r.reason ?? 'refused' };
    });
  }

  /**
   * Place one sweep order and book what actually filled. Units are fungible, so
   * a partial fill is booked as it happened — unlike a book's lot, nothing
   * depends on a unit belonging to a particular purchase except T1 and FIFO,
   * which the lot records carry.
   */
  private async trade(
    userId: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    price: number,
    now: number,
    why: string,
  ): Promise<{ ok: boolean; quantity: number; reason?: string }> {
    const s = this.state(userId, now);
    const sym = s.symbol;
    const fail = (kind: SweepEvent['kind'], reason: string) => {
      this.log(userId, kind, `${side} ${quantity} ${sym} not placed: ${reason}`, now);
      return { ok: false, quantity: 0, reason };
    };
    if (!(quantity > 0)) return fail('SKIP', 'nothing to trade');
    if (s.haltedReason) return fail('SKIP', `halted: ${s.haltedReason}`);

    const brk = brokerFor(userId);
    const venue = venueOf(brk);
    if (unitsHeld(s) > 0 && s.venue && s.venue !== venue) {
      return fail('SKIP', s.venue === 'live'
        ? 'the parked units are in your live account — paused while trading is on paper'
        : 'the parked units are simulated (paper) — they are not in your demat account');
    }
    if (venue === 'live' && marketData.isSimulated()) return fail('SKIP', 'market data is simulated — no live orders');
    if (!brk.isConnected()) return fail('SKIP', `${brk.name} is not connected`);
    if (side === 'SELL' && quantity > usableUnits(s, now)) return fail('SKIP', 'units are still T1-locked');

    const limit = roundToTick(side === 'BUY' ? price * (1 + LIMIT_OFFSET) : price * (1 - LIMIT_OFFSET));
    const clientOrderId = `sweep:${userId}:${side}:${now}`;
    const req: OrderRequest = {
      symbol: sym,
      side,
      quantity,
      orderType: 'LIMIT',
      product: 'CNC',
      price: limit,
      userId,
      tag: side === 'BUY' ? 'sweep:park' : 'sweep:redeem',
      intent: side === 'BUY' ? 'entry' : 'exit',
      clientOrderId,
      referencePrice: price,
    };

    const reservationId = clientOrderId;
    if (side === 'BUY') {
      const held = await fundsService.reserve(reservationId, sym, quantity * limit, now, userId);
      if (!held) return fail('SKIP', 'not enough deployable cash at the broker');
    }

    let filledAtBroker = false;
    let record: Order | null = null;
    try {
      const gate = preTradeGate(req, now);
      if (!gate.ok) return fail('REJECT', gate.reason ?? gate.code ?? 'refused by the pre-trade gate');
      orderRateLimiter.record(now);
      record = { ...req, id: randomUUID(), status: 'PENDING', filledQuantity: 0, submittedAt: Date.now(), createdAt: now, updatedAt: now };
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

      if (order.status === 'PENDING') {
        this.halt(userId, `${side} ${sym} is still working at ${brk.name} (order ${order.brokerOrderId || 'unknown'}). Check it in Kite, then clear this halt.`, now);
        return { ok: false, quantity: 0, reason: 'order still working at the broker' };
      }
      if (!(order.filledQuantity > 0) || !order.filledPrice) {
        return fail('REJECT', order.rejectionReason ?? order.status);
      }

      const qty = order.filledQuantity;
      const px = order.filledPrice;
      const fee = charges(side, px, qty, { product: 'CNC', instrument: 'ETF' }).total;
      record = { ...record, charges: fee };
      store.orders.set(record.id, record);
      const cur = this.state(userId, now);
      const next =
        side === 'BUY'
          ? applyParkFill({ ...cur, venue }, {
              id: record.id,
              quantity: qty,
              price: px,
              charges: fee,
              at: now,
              boughtOn: istParts(now).date,
              // Bought today: not sellable as delivery today, and a sale tomorrow
              // (T1) yields proceeds that cannot be spent that day.
              usableFrom: nextTradingDayStart(nextTradingDayStart(now)),
            })
          : applyRedeemFill(cur, { quantity: qty, price: px, charges: fee, at: now });
      this.save(next);
      this.log(
        userId,
        side === 'BUY' ? 'PARK' : 'REDEEM',
        `${side === 'BUY' ? 'bought' : 'sold'} ${qty} ${sym} @ ₹${px.toFixed(2)} (₹${Math.round(qty * px).toLocaleString('en-IN')}, charges ₹${fee.toFixed(2)})` +
          (qty < quantity ? ` — PARTIAL, ${qty} of ${quantity}` : '') + ` — ${why}`,
        now,
      );
      return { ok: true, quantity: qty };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (filledAtBroker) {
        this.halt(userId, `${side} ${sym} FILLED at ${brk.name} but could not be booked: ${msg}. Reconcile, then clear this halt.`, now);
        return { ok: false, quantity: 0, reason: msg };
      }
      if (record && record.status === 'PENDING') {
        store.orders.set(record.id, { ...record, status: 'REJECTED', rejectionReason: msg, updatedAt: Date.now() });
      }
      return fail('REJECT', msg);
    } finally {
      fundsService.release(reservationId);
    }
  }

  /** Everything the panel needs. */
  async report(userId: string, now = Date.now()) {
    const s = this.state(userId, now);
    const { idle, buffer } = this.ledger(userId);
    const price = marketData.getPrice(s.symbol) > 0 ? marketData.getPrice(s.symbol) : await this.price(now);
    const held = unitsHeld(s);
    const usable = usableUnits(s, now);
    const nextUnlock = s.lots.filter((l) => now < l.usableFrom).sort((a, b) => a.usableFrom - b.usableFrom)[0];
    return {
      enabled: s.enabled,
      symbol: s.symbol,
      venue: s.venue ?? null,
      haltedReason: s.haltedReason ?? null,
      price,
      units: held,
      usableUnits: usable,
      lockedUnits: held - usable,
      nextUnlockDate: nextUnlock ? istParts(nextUnlock.usableFrom).date : null,
      parkedValue: marketValue(s, price),
      cashOut: s.cashOut,
      gain: totalGain(s, price),
      realisedGain: s.realisedGain,
      chargesPaid: s.chargesPaid,
      idleCash: idle,
      cashOnHand: cashOnHand(idle, s),
      buffer,
      yieldPct: await this.currentYieldPct(now),
      lastParkDay: s.lastParkDay ?? null,
      params: this.params,
      lots: s.lots.map((l) => ({
        id: l.id,
        quantity: l.quantity,
        price: l.price,
        boughtOn: l.boughtOn,
        usableFrom: istParts(l.usableFrom).date,
        usable: now >= l.usableFrom,
      })),
      events: this.recentEvents(userId),
    };
  }
}

export const cashSweep = new CashSweepService();

/** A sweep emptied by `clearPaper` whose running totals still hold the paper income. */
export function isClearedPaperLedger(s: SweepState): boolean {
  return (
    s.venue === undefined &&
    s.lots.length === 0 &&
    s.cashOut === 0 &&
    s.realised.length > 0 &&
    s.realised.every((r) => (r.venue ?? 'paper') === 'paper') &&
    (s.realisedGain !== 0 || s.chargesPaid !== 0)
  );
}
