/**
 * Accumulator engine — pure decisions and pure book transitions.
 *
 * No clock, no broker, no database. `decide()` is a function of (book, price,
 * now); `applyBuyFill` and `sellLot` take a book and return a new one. The
 * stateful service in `../AccumulatorEngine.ts` supplies the price, the time and
 * the execution; everything that decides anything lives here, so the live path
 * and a backtest run identical code.
 *
 * `sellLot` is the chokepoint for the invariant. It is the only function the
 * BOT uses to remove a lot from `openLots`, and it throws rather than book a
 * fill at or below cost basis. `forceSellLot` is the user's override (the Sell
 * button) and is never called by any automatic path.
 */

import { isFnoEligible, roundToTick, withinPriceBand } from '../nse';
import { istParts } from '../session';
import { applyScalpOverlay, scalpActive } from './scalp';
import {
  MONEY_EPSILON,
  grossCost,
  ladderLevels,
  netBreakeven,
  netProceeds,
  nextLevelToBuy,
  sellTarget,
  sharesFor,
  startGatePasses,
  trancheSize,
  volStepPct,
} from './math';
import type {
  AccumulatorBook,
  AccumulatorDecision,
  AccumulatorInstrument,
  AccumulatorParams,
  ClosedLot,
  Epoch,
  Lot,
} from './types';

export class BreakevenViolationError extends Error {
  constructor(
    readonly lotId: string,
    readonly sellPrice: number,
    readonly floor: number,
    readonly proceeds: number,
    readonly quoteSpent: number,
  ) {
    super(
      `Refusing to sell lot ${lotId} at ₹${sellPrice.toFixed(2)}: net breakeven is ` +
        `₹${floor.toFixed(2)}. Proceeds ₹${proceeds.toFixed(2)} against a cost basis of ` +
        `₹${quoteSpent.toFixed(2)} (short ₹${(quoteSpent - proceeds).toFixed(2)}). ` +
        `The accumulator never sells below full fee-inclusive cost.`,
    );
    this.name = 'BreakevenViolationError';
  }
}

export class AccumulatorHaltedError extends Error {
  constructor(reason: string) {
    super(`Accumulator halted: ${reason}`);
    this.name = 'AccumulatorHaltedError';
  }
}

const shapeOf = (book: AccumulatorBook): { instrument: AccumulatorInstrument } => ({
  instrument: book.instrument,
});

/**
 * The params actually in force for one book: the global swing defaults, with
 * the scalp profile overlaid when scalping mode is on, then the allocator's
 * per-book rung count on top.
 *
 * ORDER MATTERS. Scalp first, allocator second: the rung count is a capital
 * decision (how many tranches this budget can afford above the dust gate) and
 * must win over a profile's opinion about ladder shape.
 *
 * This is the ONLY place a profile is applied. Every caller that decides
 * anything — `decide`, `applyBuyFill`, the routes that render a lot's target —
 * goes through here, so a profile can never be half-applied.
 */
export function paramsFor(book: AccumulatorBook, params: AccumulatorParams): AccumulatorParams {
  const scalp = scalpActive(book);
  let p = scalp ? applyScalpOverlay(params) : params;
  // The stock's own volatility sets the gap of a NEW ladder (swing only). An
  // open ladder keeps its stored prices, so this never re-shapes one.
  if (!scalp && params.volStep?.enabled && book.volPct && book.volPct > 0) {
    p = { ...p, stepPct: volStepPct(book.volPct, params.volStep) };
  }
  return book.tranches ? { ...p, tranches: book.tranches } : p;
}

export function openEpoch(book: AccumulatorBook): Epoch | undefined {
  const last = book.epochs[book.epochs.length - 1];
  return last && last.status === 'OPEN' ? last : undefined;
}

/** Sale proceeds still inside T+1 and therefore not spendable. */
export function unsettledCash(book: AccumulatorBook): number {
  return book.unsettled.reduce((sum, c) => sum + c.amount, 0);
}

/** Settled + unsettled. The right number for equity, the wrong one for buying. */
export function totalCash(book: AccumulatorBook): number {
  return book.cash + unsettledCash(book);
}

/** Cost basis of everything still open. */
export function deployedCapital(book: AccumulatorBook): number {
  return book.openLots.reduce((sum, l) => sum + l.quoteSpent, 0);
}

/** Mark-to-market of open lots at a price. */
export function openMarketValue(book: AccumulatorBook, price: number): number {
  return book.openLots.reduce((sum, l) => sum + l.quantity * price, 0);
}

/** Cash + open lots at the mark. The only number that describes the account. */
export function equity(book: AccumulatorBook, price: number): number {
  return totalCash(book) + openMarketValue(book, price);
}

/**
 * Move matured proceeds into spendable cash (T+1).
 *
 * The single place money can leave the settlement queue, so there is exactly one
 * place T+1 can be violated.
 */
export function releaseSettled(book: AccumulatorBook, now: number): AccumulatorBook {
  if (book.unsettled.length === 0) return book;
  const matured = book.unsettled.filter((c) => c.settlesAt <= now);
  if (matured.length === 0) return book;
  return {
    ...book,
    cash: book.cash + matured.reduce((s, c) => s + c.amount, 0),
    unsettled: book.unsettled.filter((c) => c.settlesAt > now),
    updatedAt: now,
  };
}

/** Net breakeven for one lot. */
export function lotBreakeven(
  book: AccumulatorBook,
  lot: Lot,
  params: AccumulatorParams,
): number {
  return netBreakeven(lot.quoteSpent, lot.quantity, shapeOf(book), params.slippageBufferPct);
}

/** The resting sell target for one lot. */
export function lotTarget(book: AccumulatorBook, lot: Lot, params: AccumulatorParams): number {
  return sellTarget(lotBreakeven(book, lot, params), params.targetPct);
}

/**
 * True when the book should ride its winners: trend riding is on and the
 * book's last CONFIRMED regime read is up. An unconfirmed or missing read is
 * not an uptrend, so a book with no trend history behaves exactly as before.
 */
export function ridingUptrend(book: AccumulatorBook, params: AccumulatorParams): boolean {
  return params.trail.enabled && params.trail.uptrend?.enabled === true && book.regime === 'up';
}

/** The price at which a lot stops resting at its target and starts trailing. */
export function lotArmPrice(book: AccumulatorBook, lot: Lot, params: AccumulatorParams): number {
  const be = lotBreakeven(book, lot, params);
  const target = sellTarget(be, params.targetPct);
  // In an uptrend the lot arms AT its target: crossing it starts the ride
  // rather than ending the trade.
  if (ridingUptrend(book, params)) return target;
  // Arming below the target would be incoherent: the lot would have sold first.
  return Math.max(sellTarget(be, Math.max(params.trail.armPct, params.targetPct)), target);
}

/** The giveback, percent, a lot arming now would lock in. */
function armingTrailPct(book: AccumulatorBook, params: AccumulatorParams): number {
  return ridingUptrend(book, params) ? params.trail.uptrend.retracePct : params.trail.retracePct;
}

/** The giveback, percent, an armed lot trails by. */
export function lotTrailPct(lot: Lot, params: AccumulatorParams): number {
  return lot.trailPct ?? params.trail.retracePct;
}

/**
 * The exit price for an armed lot: its high-water mark less the giveback,
 * FLOORED AT THE FIXED TARGET.
 *
 * That floor is what makes the ratchet safe. An armed lot can only ever sell
 * at or above the price it would have sold at without the ratchet, so the
 * feature is a strict improvement or a no-op. It never reaches down toward
 * breakeven, and `sellLot` still refuses anything that does.
 */
export function lotTrailStop(book: AccumulatorBook, lot: Lot, params: AccumulatorParams): number {
  const target = lotTarget(book, lot, params);
  if (!lot.armed || !(lot.hwm! > 0)) return target;
  const retraced = lot.hwm! * (1 - Math.max(0, lotTrailPct(lot, params)) / 100);
  return Math.max(roundToTick(retraced, 'up'), target);
}

/**
 * Advance every open lot's ratchet state against a price. Pure.
 *
 * Separate from `decide` so the state transition is explicit and ordered: a lot
 * arms or raises its high-water mark BEFORE the exit is evaluated, exactly once
 * per tick. Returns the same book when nothing changed.
 */
export function applyTrail(
  book: AccumulatorBook,
  price: number,
  params: AccumulatorParams,
): AccumulatorBook {
  const p = paramsFor(book, params);
  if (!p.trail.enabled || !(price > 0) || book.openLots.length === 0) return book;

  let changed = false;
  const openLots = book.openLots.map((lot) => {
    if (!lot.armed) {
      if (price < lotArmPrice(book, lot, p)) return lot;
      changed = true;
      return { ...lot, armed: true, hwm: price, trailPct: armingTrailPct(book, p) };
    }
    if (price > (lot.hwm ?? 0)) {
      changed = true;
      return { ...lot, hwm: price };
    }
    return lot;
  });

  return changed ? { ...book, openLots } : book;
}

/** Rolling high over the last `days` distinct trading days recorded on the book. */
export function rollingHigh(book: AccumulatorBook, days: number): number {
  const from = Math.max(0, book.orderedDays.length - days);
  let hi = 0;
  for (let i = from; i < book.orderedDays.length; i++) {
    hi = Math.max(hi, book.dayHighs[book.orderedDays[i]] ?? 0);
  }
  return hi;
}

/** Record a bar's high against its IST trading day, for the start gate. */
export function recordDayHigh(book: AccumulatorBook, high: number, at: number): AccumulatorBook {
  const day = istParts(at).date;
  if (book.dayHighs[day] !== undefined) {
    if (high <= book.dayHighs[day]) return book;
    return { ...book, dayHighs: { ...book.dayHighs, [day]: high } };
  }
  // A new day: append it and drop whatever falls outside the kept window.
  const orderedDays = [...book.orderedDays, day].slice(-DAY_HIGH_HISTORY_DAYS);
  const dayHighs: Record<string, number> = {};
  for (const d of orderedDays) dayHighs[d] = d === day ? high : book.dayHighs[d];
  return { ...book, dayHighs, orderedDays };
}

/** Days of start-gate history a book keeps. Enough for the lookback with margin, not unbounded. */
export const DAY_HIGH_HISTORY_DAYS = 120;

/**
 * Merge externally sourced daily highs (Yahoo daily bars) into the book's
 * start-gate history.
 *
 * `recordDayHigh` only learns highs the engine has watched, so a new book's
 * "45-day high" is a one-day high for its first seven weeks — and the start
 * gate, which exists to stop the ladder anchoring at a top, has nothing to
 * measure "top" against. Seeding from real history makes the gate honest on
 * day one.
 *
 * Pure. Keeps the max per day, re-sorts the day index chronologically (ISO
 * dates sort lexically), and trims to the last `DAY_HIGH_HISTORY_DAYS`. Returns
 * the same object when there is nothing to merge.
 */
export function mergeDayHighs(
  book: AccumulatorBook,
  entries: { day: string; high: number }[],
  opts: { authoritative?: boolean } = {},
): AccumulatorBook {
  const valid = entries.filter((e) => e.high > 0 && /^\d{4}-\d{2}-\d{2}$/.test(e.day));
  if (valid.length === 0) return book;

  // Authoritative: the source's high REPLACES a recorded one for every
  // completed day it covers. Taking the max instead would let one bad print
  // (a pre-bonus price, a synthetic seed) sit in the rolling high for months.
  // The source's latest day may still be trading, so it only ever raises.
  const latest = valid.reduce((m, e) => (e.day > m ? e.day : m), '');
  const dayHighs: Record<string, number> = { ...book.dayHighs };
  for (const e of valid) {
    dayHighs[e.day] =
      opts.authoritative && e.day !== latest ? e.high : Math.max(dayHighs[e.day] ?? 0, e.high);
  }

  const orderedDays = Object.keys(dayHighs).sort().slice(-DAY_HIGH_HISTORY_DAYS);
  const kept: Record<string, number> = {};
  for (const d of orderedDays) kept[d] = dayHighs[d];

  return { ...book, dayHighs: kept, orderedDays };
}

/**
 * Step and growth a stored ladder was built with, read back from its prices.
 * Every rung is scaled by the same factor in a corporate action, so the ratios
 * survive a split or bonus. Falls back to the profile in force only where the
 * ladder is too short to say.
 */
function ladderGeometry(levels: number[], p: AccumulatorParams): { stepPct: number; stepGrowth: number } {
  const gap = (i: number): number => 1 - levels[i + 1] / levels[i];
  if (levels.length < 2 || !(gap(0) > 0)) return { stepPct: p.stepPct, stepGrowth: p.stepGrowth };
  const stepPct = gap(0) * 100;
  if (levels.length < 3) return { stepPct, stepGrowth: p.stepGrowth };
  const growth = gap(1) / gap(0);
  return { stepPct, stepGrowth: Number.isFinite(growth) && growth >= 1 ? growth : 1 };
}

/**
 * Bring the open ladder's rung count in line with the count in force.
 *
 * The allocator re-sizes books daily, so a book's `tranches` can change while a
 * ladder is open. Without this, a ladder anchored at the allocator's minimum of
 * 3 rungs keeps 3 after the book is moved to 4, and the 4th rung never exists
 * until every lot has sold.
 *
 * What it may and may not do:
 *   - EXTEND with deeper rungs, using the ladder's OWN gaps read back from its
 *     prices — not the profile in force now. Flipping scalp on still never
 *     re-shapes a ladder underneath its lots.
 *   - SHORTEN only by dropping unfilled rungs at the bottom. A rung that has
 *     been bought is never removed.
 *   - Existing rung prices are copied, never recomputed. Rungs are entry prices
 *     only, so no lot's cost basis, floor or target moves.
 *
 * Pure and idempotent. Returns the same book when there is nothing to do.
 */
export function syncLadder(book: AccumulatorBook, params: AccumulatorParams): AccumulatorBook {
  const epoch = openEpoch(book);
  if (!epoch) return book;
  const p = paramsFor(book, params);
  const have = epoch.levels.length;
  const deepestFilled = epoch.filledLevels.reduce((m, k) => Math.max(m, k), -1);
  const want = Math.max(p.tranches, deepestFilled + 1);
  if (want === have) return book;

  let levels: number[];
  if (want < have) {
    levels = epoch.levels.slice(0, want);
  } else {
    const { stepPct, stepGrowth } = ladderGeometry(epoch.levels, p);
    levels = [...epoch.levels];
    let price = levels[have - 1];
    for (let i = have - 1; i < want - 1; i++) {
      const gap = (stepPct / 100) * Math.pow(stepGrowth, i);
      if (!(gap > 0 && gap < 1)) break; // a rung at or below zero is not a rung
      price *= 1 - gap;
      levels.push(price);
    }
    if (levels.length === have) return book;
  }

  return { ...book, epochs: book.epochs.map((e) => (e.index === epoch.index ? { ...e, levels } : e)) };
}

/**
 * Rupees for the next rung: what the ladder has left, split evenly over the
 * rungs it has left.
 *
 *   rung 0        budget × (1 − reserve) ÷ rungs
 *   later rungs   (budget × (1 − reserve) − spent in this ladder) ÷ unfilled rungs
 *
 * With a steady budget that is the same amount every rung (plus the few rupees
 * whole-share rounding left behind). When the allocator changes the budget or
 * the rung count mid-ladder, the change is spread over the rungs still to come.
 * Re-cutting every rung from the new budget instead made the first lot — bought
 * at the highest price — the smallest one, and left cash that no rung would use.
 *
 * "Spent" includes lots already sold, so profit taken on one rung does not
 * inflate the deeper ones. Never negative. The settled-cash check and the
 * deployment ceiling still apply on top, in `buildBuy`.
 */
export function nextTrancheSize(book: AccumulatorBook, params: AccumulatorParams): number {
  const epoch = openEpoch(book);
  if (!epoch) return trancheSize(book.budget, params);
  const unfilled = epoch.levels.length - epoch.filledLevels.length;
  if (unfilled <= 0) return 0;
  const pool = book.budget * (1 - params.reservePct / 100);
  // With re-armed rungs a sold deeper lot's money is back in play for its own
  // rung, so it no longer counts as spent. The anchor never re-arms, so its
  // sale still counts: taking profit on rung 0 must not inflate deeper rungs.
  const lots = params.rearmSoldRungs
    ? [...book.openLots, ...book.closedLots.filter((l) => l.level === 0)]
    : [...book.openLots, ...book.closedLots];
  const spent = lots.filter((l) => l.epoch === epoch.index).reduce((s, l) => s + l.quoteSpent, 0);
  return Math.max(0, pool - spent) / unfilled;
}

/**
 * What to do at this price. Exits first and ALWAYS — the kill switch and every
 * risk gate reach only the entry half. Blocking a profitable exit protects
 * nothing and destroys capital.
 */
export function decide(
  book: AccumulatorBook,
  price: number,
  now: number,
  params: AccumulatorParams,
): AccumulatorDecision[] {
  const out: AccumulatorDecision[] = [];

  if (book.haltedReason) {
    return [{ action: 'HOLD', symbol: book.symbol, reason: `Halted: ${book.haltedReason}` }];
  }

  // The profile in force for this book — swing, or its scalp rewrite. Resolved
  // once, used for every decision below, so a tick can never mix the two.
  const p = paramsFor(book, params);

  // ── Exits. Never gated. ──
  //
  // The floor comes from `slippageBufferPct`, which no profile overlays, so
  // flipping scalp on or off moves a lot's TARGET and never its floor.
  for (const lot of book.openLots) {
    const floor = lotBreakeven(book, lot, p);
    const target = sellTarget(floor, p.targetPct);

    // An ARMED lot has already run past its target and is now riding its
    // high-water mark. It exits on the retracement, never at the target, and
    // its stop is floored at that same target.
    if (p.trail.enabled && lot.armed) {
      const stop = lotTrailStop(book, lot, p);
      if (price <= stop) {
        // Fill no better than the market. A retracement that runs through the
        // stop — an overnight gap, say — fills where the market actually is,
        // not at the stop, which is the honest model of a stop order.
        // Snapped UP to NSE's tick: an off-tick price is rejected by the
        // exchange, and rounding up can only raise the sale, never cross the floor.
        const exit = roundToTick(Math.min(price, stop), 'up');
        // But never below the fixed target. If the gap carried price under it,
        // HOLD: the lot reverts to resting at its target and sells there when
        // price returns. This bounds the ratchet's downside to "the lot stays
        // open longer", and never to "the lot sells for less than it would
        // have without the ratchet".
        if (exit >= target) {
          out.push({
            action: 'SELL',
            symbol: book.symbol,
            lotId: lot.id,
            limitPrice: exit,
            quantity: lot.quantity,
            netBreakeven: floor,
            reason:
              `Ratchet exit at ₹${exit.toFixed(2)}: ${lotTrailPct(lot, p)}% back from the high of ` +
              `₹${(lot.hwm ?? 0).toFixed(2)} (fixed target was ₹${target.toFixed(2)}, ` +
              `breakeven ₹${floor.toFixed(2)})`,
          });
        }
      }
      continue;
    }

    if (price >= target) {
      out.push({
        action: 'SELL',
        symbol: book.symbol,
        lotId: lot.id,
        limitPrice: target,
        quantity: lot.quantity,
        netBreakeven: floor,
        reason:
          `₹${price.toFixed(2)} cleared target ₹${target.toFixed(2)} ` +
          `(breakeven ₹${floor.toFixed(2)})`,
      });
    }
  }

  // ── Entries. Gated. ──
  if (book.killSwitchEngaged) {
    out.push({
      action: 'HOLD',
      symbol: book.symbol,
      reason: 'Kill switch engaged: new risk halted. Exits above remain permitted.',
    });
    return out;
  }

  if (book.entryBlock) {
    out.push({
      action: 'HOLD',
      symbol: book.symbol,
      reason: `${book.entryBlock}. Exits above remain permitted.`,
    });
    return out;
  }

  if (book.allocatorPaused) {
    out.push({
      action: 'HOLD',
      symbol: book.symbol,
      reason: `Allocator assigned capital elsewhere: no new rungs. Exits above remain permitted.` +
        (book.allocatorNote ? ` (${book.allocatorNote})` : ''),
    });
    return out;
  }

  if (book.lastBuyAt !== undefined && now - book.lastBuyAt < p.minBuyGapMs) {
    const waitMin = Math.ceil((p.minBuyGapMs - (now - book.lastBuyAt)) / 60_000);
    out.push({
      action: 'HOLD',
      symbol: book.symbol,
      reason: `Crash-cascade brake: ${waitMin} min until the next ladder buy is permitted`,
    });
    return out;
  }

  // Resize a ladder whose rung count has changed since it opened, so a decision
  // never lags the book by a tick. The service persists the same resize.
  const ladder = syncLadder(book, params);
  const epoch = openEpoch(ladder);
  const tranche = nextTrancheSize(ladder, p);
  const high = rollingHigh(book, p.hiLookbackDays);

  if (!epoch) {
    if (!startGatePasses(price, high, p.startDiscountPct)) {
      out.push({
        action: 'HOLD',
        symbol: book.symbol,
        reason:
          `Start gate: ₹${price.toFixed(2)} is not ${p.startDiscountPct}% below the ` +
          `${p.hiLookbackDays}-day high of ₹${high.toFixed(2)} — refusing to anchor near a high`,
      });
      return out;
    }
    const buy = buildBuy(book, price, book.epochs.length, 0, tranche, p, 'Start gate passed: anchoring epoch');
    out.push(buy ?? {
      action: 'HOLD',
      symbol: book.symbol,
      reason: 'Start gate passed but the tranche buys no whole share, or settled cash is short',
    });
    return out;
  }

  const level = nextLevelToBuy(epoch, price);
  if (level === null) {
    out.push({ action: 'HOLD', symbol: book.symbol, reason: 'No unfilled ladder rung crossed' });
    return out;
  }

  const buy = buildBuy(
    book, price, epoch.index, level, tranche, p,
    `Price crossed ladder rung ${level} (₹${epoch.levels[level].toFixed(2)})`,
  );
  out.push(buy ?? {
    action: 'HOLD',
    symbol: book.symbol,
    reason:
      deployedCapital(book) + tranche > deployCeiling(book, p) + MONEY_EPSILON
        ? `Deployment cap: ₹${deployedCapital(book).toFixed(0)} of the ₹${deployCeiling(book, p).toFixed(0)} ` +
          `ceiling (${p.maxDeployPct}% of budget) is already in lots — holding the rest back`
        : `Rung ${level} reached but the book cannot fund a whole-share tranche from SETTLED cash`,
  });
  return out;
}

/** Rupees of cost basis this book may hold in open lots at once. */
export function deployCeiling(book: AccumulatorBook, params: AccumulatorParams): number {
  return (book.budget * Math.min(100, Math.max(0, params.maxDeployPct))) / 100;
}

function buildBuy(
  book: AccumulatorBook,
  price: number,
  epochIndex: number,
  level: number,
  tranche: number,
  params: AccumulatorParams,
  reason: string,
): AccumulatorDecision | null {
  // Marketable limit. The executor's actual fill forms the cost basis; this
  // only bounds how much worse than the print we are willing to pay.
  const limitPrice = roundToTick(price, 'up');
  const quantity = sharesFor(tranche, limitPrice);
  if (quantity < 1) return null;
  // A rung below the day's lower circuit is unreachable today. Not an error —
  // the exchange would simply refuse the order, so the ladder waits.
  if (book.previousClose !== undefined &&
      !withinPriceBand(limitPrice, book.previousClose, isFnoEligible(book.symbol))) {
    return null;
  }
  // Settled cash only — unsettled proceeds cannot fund a buy (T+1).
  const cost = grossCost(quantity, limitPrice, shapeOf(book));
  if (cost > book.cash) return null;

  // Deployment ceiling. This engine has no stop-loss by construction, so a cap
  // on how much of the budget can sit in open lots at once is the only brake on
  // a ladder that keeps filling into a fall. The scalp profile lowers it,
  // because a 2% dip gate and a 2h brake fill rungs far faster than the swing
  // profile's 6% and 24h.
  if (deployedCapital(book) + cost > deployCeiling(book, params) + MONEY_EPSILON) return null;

  return { action: 'BUY', symbol: book.symbol, epoch: epochIndex, level, limitPrice, quantity, reason };
}

export interface BuyFill {
  epoch: number;
  level: number;
  /** The broker's ACTUAL fill price. Never the requested one. */
  fillPrice: number;
  quantity: number;
  at: number;
  /** The order that produced this fill, recorded on the lot. */
  orderId?: string;
}

/** Apply a buy fill, opening a new epoch when level 0 anchors one. */
export function applyBuyFill(
  book: AccumulatorBook,
  fill: BuyFill,
  params: AccumulatorParams,
): AccumulatorBook {
  if (book.haltedReason) throw new AccumulatorHaltedError(book.haltedReason);

  const quoteSpent = grossCost(fill.quantity, fill.fillPrice, shapeOf(book));
  if (quoteSpent > book.cash + MONEY_EPSILON) {
    throw new Error(
      `Buy needs ₹${quoteSpent.toFixed(2)} of SETTLED cash but the book holds ₹${book.cash.toFixed(2)}`,
    );
  }

  // The profile in force builds the ladder. An epoch keeps the GAPS it was built
  // with for its whole life: flipping scalp on later re-targets the open lots
  // but never re-shapes a ladder underneath them. Only the rung COUNT follows
  // the book (`syncLadder`), and a fill on a grown rung stores the grown ladder.
  book = syncLadder(book, params);
  const epochs = [...book.epochs];
  let current = openEpoch(book);
  const p = paramsFor(book, params);

  if (!current) {
    if (fill.level !== 0) {
      throw new Error(`Cannot fill rung ${fill.level} with no open epoch; rung 0 anchors it`);
    }
    current = {
      index: epochs.length,
      anchorPrice: fill.fillPrice,
      openedAt: fill.at,
      levels: ladderLevels(fill.fillPrice, p.tranches, p.stepPct, p.stepGrowth),
      filledLevels: [],
      status: 'OPEN',
    };
    epochs.push(current);
  }

  const idx = epochs.length - 1;
  const epoch = epochs[idx];
  if (fill.epoch !== epoch.index) {
    throw new Error(
      `Buy fill names epoch ${fill.epoch} but the open epoch is ${epoch.index} — ` +
        `refusing to book a fill against an epoch it does not belong to`,
    );
  }
  if (epoch.filledLevels.includes(fill.level)) {
    throw new Error(`Rung ${fill.level} of epoch ${epoch.index} is already filled`);
  }
  epochs[idx] = { ...epoch, filledLevels: [...epoch.filledLevels, fill.level] };

  const lot: Lot = {
    id: `${book.symbol}-e${epoch.index}-l${fill.level}-${book.lotSeq}`,
    epoch: epoch.index,
    level: fill.level,
    fillPrice: fill.fillPrice,
    quantity: fill.quantity,
    quoteSpent,
    openedAt: fill.at,
    ...(fill.orderId ? { orderId: fill.orderId } : {}),
    venue: book.venue ?? 'paper',
  };

  return {
    ...book,
    cash: book.cash - quoteSpent,
    openLots: [...book.openLots, lot],
    epochs,
    lastBuyAt: fill.at,
    lotSeq: book.lotSeq + 1,
    updatedAt: fill.at,
  };
}

/**
 * ═══════════════════════ THE INVARIANT ═══════════════════════
 * The only way a lot leaves `openLots`. Throws rather than book a fill at or
 * below cost basis — the lot simply stays open.
 *
 * Two deliberately redundant checks: the price must clear the solved breakeven,
 * AND the rupee proceeds recomputed at the actual sell notional must cover
 * `quoteSpent`. The second catches any drift between the breakeven solver and
 * the cost model itself.
 * ═════════════════════════════════════════════════════════════
 */
export function sellLot(
  book: AccumulatorBook,
  lotId: string,
  sellPrice: number,
  at: number,
  settlesAt: number,
  params: AccumulatorParams,
  orderId?: string,
): AccumulatorBook {
  const lot = book.openLots.find((l) => l.id === lotId);
  if (!lot) throw new Error(`No open lot with id ${lotId}`);

  const floor = lotBreakeven(book, lot, params);
  const proceeds = netProceeds(lot.quantity, sellPrice, shapeOf(book));

  if (sellPrice < floor - MONEY_EPSILON || proceeds < lot.quoteSpent - MONEY_EPSILON) {
    throw new BreakevenViolationError(lotId, sellPrice, floor, proceeds, lot.quoteSpent);
  }

  const closed: ClosedLot = {
    ...lot,
    sellPrice,
    closedAt: at,
    proceeds,
    pnl: proceeds - lot.quoteSpent,
    netBreakeven: floor,
    ...(orderId ? { sellOrderId: orderId } : {}),
  };

  const openLots = book.openLots.filter((l) => l.id !== lotId);
  // Re-arm: a deeper rung whose lot sold can buy again on the next dip to it.
  const rearm = paramsFor(book, params).rearmSoldRungs === true && lot.level > 0;
  const epochs = book.epochs.map((e) => {
    if (e.index !== lot.epoch || e.status !== 'OPEN') return e;
    if (!openLots.some((l) => l.epoch === e.index)) return { ...e, status: 'CLOSED' as const, closedAt: at };
    return rearm ? { ...e, filledLevels: e.filledLevels.filter((k) => k !== lot.level) } : e;
  });

  return {
    ...book,
    // Proceeds go into the T+1 queue, never straight into spendable cash.
    unsettled: [...book.unsettled, { amount: proceeds, fromLotId: lotId, soldAt: at, settlesAt }],
    openLots,
    closedLots: [...book.closedLots, closed],
    epochs,
    updatedAt: at,
  };
}

/**
 * The user's override: book a lot sold BY HAND at market, whatever its cost.
 *
 * The bot never calls this. It exists for the Sell button, and the closed lot
 * says so (`forced: true`) so a loss on it can never be mistaken for the
 * engine's. Everything else matches `sellLot`: proceeds go into the T+1 queue,
 * and the epoch closes with its last open lot.
 *
 * One difference on purpose: the rung is NEVER re-armed. A forced sale is
 * usually below cost, so price sits at or under the lot's rung; re-arming it
 * would buy the same rung straight back on the next tick.
 */
export function forceSellLot(
  book: AccumulatorBook,
  lotId: string,
  sellPrice: number,
  at: number,
  settlesAt: number,
  params: AccumulatorParams,
  orderId?: string,
): AccumulatorBook {
  if (book.haltedReason) throw new AccumulatorHaltedError(book.haltedReason);
  const lot = book.openLots.find((l) => l.id === lotId);
  if (!lot) throw new Error(`No open lot with id ${lotId}`);
  if (!(sellPrice > 0)) throw new Error(`Forced sale of ${lotId} needs a positive price, got ${sellPrice}`);

  const proceeds = netProceeds(lot.quantity, sellPrice, shapeOf(book));
  const closed: ClosedLot = {
    ...lot,
    sellPrice,
    closedAt: at,
    proceeds,
    pnl: proceeds - lot.quoteSpent,
    netBreakeven: lotBreakeven(book, lot, params),
    forced: true,
    ...(orderId ? { sellOrderId: orderId } : {}),
  };

  const openLots = book.openLots.filter((l) => l.id !== lotId);
  const epochs = book.epochs.map((e) =>
    e.index === lot.epoch && e.status === 'OPEN' && !openLots.some((l) => l.epoch === e.index)
      ? { ...e, status: 'CLOSED' as const, closedAt: at }
      : e,
  );

  return {
    ...book,
    unsettled: [...book.unsettled, { amount: proceeds, fromLotId: lotId, soldAt: at, settlesAt }],
    openLots,
    closedLots: [...book.closedLots, closed],
    epochs,
    updatedAt: at,
  };
}

/**
 * What a forced sale of one lot would book at this price: net proceeds after
 * every sell-side charge (the flat DP charge included) and the result against
 * the lot's full cost. Pure; places nothing.
 */
export function forceSellEstimate(
  book: AccumulatorBook,
  lot: Lot,
  price: number,
): { proceeds: number; pnl: number } {
  const proceeds = price > 0 ? netProceeds(lot.quantity, price, shapeOf(book)) : 0;
  return { proceeds, pnl: proceeds - lot.quoteSpent };
}
