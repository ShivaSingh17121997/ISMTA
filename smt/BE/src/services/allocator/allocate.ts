/**
 * Capital allocation across accumulator books — pure.
 *
 * The user's instruction: "let the bot decide which stock is performing well
 * and give it more money accordingly, and when to invest what amount."
 *
 * This module answers WHICH and HOW MUCH. WHEN stays with the ladder: the
 * start gate and the rungs already decide the day a buy fires, and nothing here
 * overrides them. The two compose cleanly — rank companies by strength so the
 * ladder only builds in names whose dips have a history of recovering, then let
 * the ladder buy those dips.
 *
 * Hard rules, all consequences of the no-loss invariant:
 *
 *   1. Only UNCOMMITTED cash moves. Open lots are never sold to rebalance —
 *      the engine cannot sell a lot below cost, and it will not sell one at a
 *      profit just because a spreadsheet wants the money elsewhere. A book that
 *      loses its allocation keeps every lot and sells each at its own target.
 *   2. Unsettled proceeds (T+1) stay with their book until they settle.
 *   3. Every funded book must clear the dust gate: tranche >= `minTranche`, or
 *      the flat DP charge eats the profit target. That is why ₹2 lakh funds a
 *      few books, not nineteen.
 *   4. Budgets round DOWN to ₹1,000; the remainder is reported, not invented.
 *
 * The user can also fix a stock's budget by hand (`manualBudget`). Those
 * amounts are honoured first and exactly, outside the ranking, the trend filter
 * and the per-stock cap: the user decided. The bot splits what is left among
 * the stocks still on automatic. If the pool has shrunk below what the manual
 * amounts need, they are scaled down together rather than overspending.
 */

import type { AccumulatorBook } from '../accumulator/types';

export interface Candidate {
  symbol: string;
  /** 0..1 from `strength()`. Higher = stronger. */
  score: number;
  trendUp: boolean;
  /** False when there is not enough history to score it. */
  eligible: boolean;
  /** Cost basis of open lots. Immovable. */
  deployed: number;
  /** Sale proceeds inside T+1. Immovable this pass. */
  unsettled: number;
  /** Settled cash the book holds now. Movable. */
  cash: number;
  openLots: number;
  /** Why it is not eligible, when it is not. */
  reason?: string;
  /** Total budget the user fixed for this stock (lots + T+1 + new cash). Absent = automatic. */
  manualBudget?: number;
  /** Rung count the user fixed with `manualBudget`. Absent = picked from the new cash. */
  manualTranches?: number;
  /** An index ETF: funded from the core share of capital, not the stock satellite. */
  core?: boolean;
  /** Rungs filled in the open ladder, and rupees spent on it (sold lots included). For rescue sizing. */
  epochFilled?: number;
  epochSpent?: number;
}

export interface AllocationParams {
  /** Rupees the allocator may spread across books, including what is already in lots. */
  totalCapital: number;
  reservePct: number;
  /** Smallest tranche the dust gate accepts, rupees. */
  minTranche: number;
  minRungs: number;
  maxRungs: number;
  maxBooks: number;
  /** Below this strength a company is not funded even if there is room. */
  minScore: number;
  /**
   * Most of `totalCapital` one stock may hold, percent: lots + T+1 + new cash.
   * Without it a lone qualifying stock took everything. What no book can take
   * stays unallocated. Absent = no cap.
   */
  maxWeightPct?: number;
  /**
   * Percent of capital the index-ETF core aims to hold (lots + T+1 + cash).
   * New cash tops the core up to it first; the stock satellite gets the rest.
   * A core ETF is exempt from the per-stock cap and from `maxBooks`. Absent or
   * 0 = no core: ETFs compete with stocks as before.
   */
  corePct?: number;
  /**
   * Most of capital, percent, all books may hold together in lots, T+1 and
   * assigned cash. What is above it stays unassigned (and can be swept).
   * Absent = no ceiling.
   */
  maxDeployPct?: number;
  /**
   * Rungs of new cash a dropped stock still holding lots may get, when its
   * trend is up, so its ladder is not stranded mid-way. 0 / absent = off.
   */
  rescueRungs?: number;
  /**
   * Count dropped stocks that still hold lots toward `maxBooks`, so rotation
   * cannot keep adding names while old ones sit stuck.
   */
  countHeldBooks?: boolean;
}

export const DEFAULT_ALLOCATION_PARAMS: AllocationParams = {
  totalCapital: 200_000,
  reservePct: 15,
  minTranche: 16_000,
  minRungs: 3,
  maxRungs: 12,
  maxBooks: 4,
  minScore: 0.35,
  maxWeightPct: 35,
  // Phase 3 backtest (ENGINE_FIX_PLAN.md): a 60% index-ETF core roughly halved
  // the worst drawdown and beat its exposure-matched benchmark in 3 of 4
  // universe/window runs. Applies only once an ETF book exists.
  corePct: 60,
  // The deployment ceiling, rescue rungs and counting held books each did worse
  // in every run, so they stay off. The settings remain for testing.
};

export interface Allocation {
  symbol: string;
  selected: boolean;
  rank: number | null;
  score: number;
  /** deployed + unsettled + targetCash */
  targetBudget: number;
  /** New settled cash the book should hold. 0 when not selected. */
  targetCash: number;
  tranches: number;
  weight: number;
  reason: string;
  /** True when the user fixed this budget; the bot did not rank it. */
  manual?: boolean;
  /** Funded from the index-ETF core. */
  core?: boolean;
  /** A dropped stock given cash only to finish its ladder. */
  rescue?: boolean;
}

/** One persisted allocator pass for a user — what it saw and what it decided. */
export interface AllocatorRun {
  userId: string;
  at: number;
  /** IST trading day the run belongs to. */
  tradingDay: string;
  params: AllocationParams;
  plan: AllocationPlan;
  /** Per-symbol scoring detail, keyed by symbol. */
  strengths: Record<string, unknown>;
}

export interface AllocationPlan {
  totalCapital: number;
  /** Rupees locked in lots and T+1 across all books. Cannot be moved. */
  committed: number;
  /** totalCapital − committed, floored at 0. */
  allocatable: number;
  /** Rupees left over after rounding down to ₹1,000. */
  unallocated: number;
  /** New cash given to the stocks whose budget the user fixed. Part of `allocatable`. */
  manualCash?: number;
  /** New cash given to the index-ETF core this pass. */
  coreCash?: number;
  /** New cash given to rescue rungs this pass. */
  rescueCash?: number;
  /** What the deployment ceiling held back, rupees (0 when off or not binding). */
  heldBackByCeiling?: number;
  minBudget: number;
  selected: string[];
  allocations: Allocation[];
}

const round1k = (n: number): number => Math.floor(n / 1000) * 1000;

/**
 * The pool `allocate` expects as `totalCapital`: EVERYTHING the books own,
 * including what is already in lots, because `allocate` subtracts the lots
 * itself (`committed`) to find what may move.
 *
 * Paper and live report different things, and that is the whole trap:
 *   - paper: the funds figure is RISK_CAPITAL, a whole-pool number that never
 *     moves when a lot is bought. It is the pool as it stands.
 *   - live: the figure is the broker's FREE cash, from which every delivery buy
 *     has already been debited. Passing it straight through subtracted the lots
 *     twice — a ₹2L account with ₹58k in lots read as ₹84k to allocate, not
 *     ₹1.42L, and the gap grew with every rung that filled.
 *
 * So live adds back the lots' cost basis — the same `deployed` measure
 * `allocate` subtracts, so the two cancel exactly — and whatever the idle-cash
 * sweep has parked, which the broker also shows as spent.
 *
 * Unsettled proceeds are left alone: `allocate` still holds them back for a
 * day, which is the conservative side whether or not the broker has already
 * credited them to free cash.
 */
export function allocatorPool(input: {
  /** Deployable cash from FundsService (after reservations and charge buffer). */
  funds: number;
  simulated: boolean;
  /** Σ cost basis of open lots, exactly as `Candidate.deployed` sums it. */
  deployed: number;
  /** Market value parked by the idle-cash sweep. */
  parked: number;
}): number {
  if (input.simulated) return Math.max(0, input.funds);
  return Math.max(0, input.funds) + Math.max(0, input.deployed) + Math.max(0, input.parked);
}

/**
 * The candidate fields a book supplies, the same for the live allocator and
 * the backtest: what is locked in it, whether it is an index-ETF core book
 * (any ETF book; the parking ETF of the cash sweep is not a book), and how far
 * its open ladder has got, for rescue sizing.
 */
export function bookCandidateFields(book: AccumulatorBook): Pick<
  Candidate,
  'symbol' | 'deployed' | 'unsettled' | 'cash' | 'openLots' | 'core' | 'epochFilled' | 'epochSpent' | 'manualBudget' | 'manualTranches'
> {
  const open = book.epochs[book.epochs.length - 1];
  const live = open && open.status === 'OPEN' ? open : undefined;
  const lotsOf = (e: number) => [...book.openLots, ...book.closedLots].filter((l) => l.epoch === e);
  return {
    symbol: book.symbol,
    deployed: book.openLots.reduce((s, l) => s + l.quoteSpent, 0),
    unsettled: book.unsettled.reduce((s, c) => s + c.amount, 0),
    cash: book.cash,
    openLots: book.openLots.length,
    ...(book.instrument === 'ETF' ? { core: true } : {}),
    ...(live ? { epochFilled: live.filledLevels.length, epochSpent: lotsOf(live.index).reduce((s, l) => s + l.quoteSpent, 0) } : {}),
    ...(book.manualBudget !== undefined ? { manualBudget: book.manualBudget } : {}),
    ...(book.manualBudget !== undefined && book.manualTranches !== undefined ? { manualTranches: book.manualTranches } : {}),
  };
}

/**
 * Rungs a budget affords above the dust gate, within the allocator's min/max:
 * the rung count the allocator gives a book of this size.
 */
export function rungsForBudget(budget: number, p: AllocationParams = DEFAULT_ALLOCATION_PARAMS): number {
  return Math.max(p.minRungs, Math.min(p.maxRungs, Math.floor((budget * (1 - p.reservePct / 100)) / p.minTranche)));
}

/**
 * Whether a book is switched on after an allocation. A book the bot funds is
 * switched on: that is what "let the bot decide" means. A book it passes over
 * keeps whatever the user set, and so does one whose amount the user fixed or
 * that only got a rescue rung: those on/off switches stay the user's.
 */
export function enabledAfter(a: Pick<Allocation, 'selected' | 'manual' | 'rescue'>, current: boolean): boolean {
  return a.selected && !a.manual && !a.rescue ? true : current;
}

/**
 * Rungs for a book given `newCash`, counting the rungs its open ladder has
 * already bought. Sizing from the new cash alone gave a book with 5 bought
 * rungs a count of 3: the ladder keeps its 5, so 0 were left to buy and the
 * cash sat stranded. With an open ladder: the rungs bought, plus as many more
 * as (budget × (1 − reserve) − spent on it) affords at the minimum rung size.
 * Without one, `fresh` decides, as before.
 */
export function rungsForBook(
  c: Pick<Candidate, 'deployed' | 'unsettled' | 'epochFilled' | 'epochSpent'>,
  newCash: number,
  p: AllocationParams,
  fresh: (cash: number) => number,
): number {
  if (c.epochFilled === undefined) return fresh(newCash);
  const budget = c.deployed + c.unsettled + newCash;
  const left = budget * (1 - p.reservePct / 100) - (c.epochSpent ?? c.deployed);
  const more = Math.max(0, Math.floor(left / p.minTranche));
  return Math.max(1, Math.min(p.maxRungs, c.epochFilled + more));
}

/** Smallest budget that still buys `minRungs` tranches above the dust gate. */
export function minViableBudget(p: AllocationParams): number {
  return Math.ceil((p.minTranche * p.minRungs) / (1 - p.reservePct / 100) / 1000) * 1000;
}

/**
 * Split `pool` across `items` in proportion to score, each clamped between its
 * floor (`floor`, or its ceiling if lower) and its `ceiling`.
 *
 * Water-filling: find the one rate λ at which Σ clamp(λ·score, lo, hi) equals
 * the pool, so the clamps are honoured TOGETHER. Pinning them one at a time
 * could hand a capped stock its full ceiling and leave another below its
 * floor, overspending the pool. When every ceiling together is less than the
 * pool, everyone gets their ceiling and the rest is left unspent. Callers
 * guarantee the floors fit (`n × floor ≤ pool`).
 */
export function waterFill(
  items: { symbol: string; score: number; ceiling: number }[],
  pool: number,
  floor: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!items.length) return out;
  const anyScore = items.some((i) => i.score > 0);
  const weight = (i: { score: number }): number => (anyScore ? Math.max(0, i.score) : 1);
  const lo = (i: { ceiling: number }): number => Math.max(0, Math.min(floor, i.ceiling));
  const hi = (i: { ceiling: number }): number => Math.max(0, i.ceiling);
  const at = (rate: number, i: (typeof items)[number]): number => Math.min(hi(i), Math.max(lo(i), rate * weight(i)));
  const spend = (rate: number): number => items.reduce((s, i) => s + at(rate, i), 0);

  if (spend(Number.MAX_VALUE) <= pool) {
    for (const i of items) out.set(i.symbol, hi(i));
    return out;
  }
  let low = 0;
  let high = 1;
  while (spend(high) < pool) high *= 2;
  for (let k = 0; k < 200; k++) {
    const mid = (low + high) / 2;
    if (spend(mid) > pool) high = mid;
    else low = mid;
  }
  for (const i of items) out.set(i.symbol, at(low, i));
  return out;
}

/** Smallest NEW cash a manual budget may add: one rung above the dust gate, after the reserve. */
export function minManualCash(p: AllocationParams): number {
  return Math.ceil(p.minTranche / (1 - p.reservePct / 100) / 1000) * 1000;
}

/** Rungs a given amount of new cash can afford above the dust gate, at least one. */
export function manualRungs(cash: number, p: AllocationParams): number {
  return Math.max(1, Math.min(p.maxRungs, Math.floor((cash * (1 - p.reservePct / 100)) / p.minTranche)));
}

/**
 * Why a manual budget cannot be accepted, or null. `others` is every OTHER
 * book's candidate (their lots, T+1 and manual amounts count against the pool).
 */
export function manualBudgetError(
  amount: number,
  book: Pick<Candidate, 'deployed' | 'unsettled'>,
  others: Pick<Candidate, 'deployed' | 'unsettled' | 'manualBudget'>[],
  p: AllocationParams,
  /**
   * The smallest worthwhile rung for THIS stock (allocator/rungFloor), which
   * depends on its price. Without one, the fixed `minTranche` floor applies.
   */
  floor?: { newCash: number; why: string },
): string | null {
  if (!Number.isFinite(amount) || amount < 0) return 'Enter an amount of ₹0 or more.';
  const held = book.deployed + book.unsettled;
  const newCash = Math.max(0, amount - held);
  const min = floor?.newCash ?? minManualCash(p);
  if (newCash > 0 && newCash < min) {
    return (
      `₹${Math.round(newCash).toLocaleString('en-IN')} of new money is too little for one rung: ` +
      `the minimum is ₹${min.toLocaleString('en-IN')} on top of the ₹${Math.round(held).toLocaleString('en-IN')} already in this stock ` +
      (floor
        ? `(${floor.why}, and ${p.reservePct}% is kept back). `
        : `, so that each buy clears the flat DP charge. `) +
      `Enter ₹0 to stop new buys.`
    );
  }
  const othersHeld = others.reduce((s, c) => s + c.deployed + c.unsettled, 0);
  const othersManual = others.reduce(
    (s, c) => s + (c.manualBudget === undefined ? 0 : Math.max(0, c.manualBudget - c.deployed - c.unsettled)),
    0,
  );
  const free = Math.max(0, p.totalCapital - held - othersHeld - othersManual);
  if (newCash > free) {
    return (
      `Only ₹${Math.floor(free).toLocaleString('en-IN')} of new money is free for this stock ` +
      `(₹${Math.round(p.totalCapital).toLocaleString('en-IN')} capital, less what is in open lots and T+1 ` +
      `and the amounts you set for other stocks). The most you can enter is ₹${Math.floor(free + held).toLocaleString('en-IN')}.`
    );
  }
  return null;
}

export function allocate(cands: Candidate[], p: AllocationParams = DEFAULT_ALLOCATION_PARAMS): AllocationPlan {
  const committed = cands.reduce((s, c) => s + c.deployed + c.unsettled, 0);
  const free = Math.max(0, p.totalCapital - committed);
  const minBudget = minViableBudget(p);

  // ── stocks the user sized by hand: honoured first, exactly ──
  const manual = cands.filter((c) => c.manualBudget !== undefined);
  const want = new Map(manual.map((c) => [c.symbol, Math.max(0, c.manualBudget! - c.deployed - c.unsettled)]));
  const wantTotal = [...want.values()].reduce((s, v) => s + v, 0);
  // The pool can shrink after the amounts were entered (a withdrawal, a lower
  // live balance). Scale them down together rather than spend money that is gone.
  const scale = wantTotal > free ? free / wantTotal : 1;
  const manualCashOf = new Map([...want].map(([sym, v]) => [sym, Math.floor(v * scale)]));
  const manualCash = [...manualCashOf.values()].reduce((s, v) => s + v, 0);

  // ── the rest: the bot ranks and splits it ──
  // The deployment ceiling caps lots + T+1 + assigned cash across every book.
  const ceilingRupees = p.maxDeployPct === undefined ? Infinity : (p.totalCapital * p.maxDeployPct) / 100;
  const allocatable = Math.max(0, Math.min(free, ceilingRupees - committed) - manualCash);
  const heldBackByCeiling = Math.max(0, free - manualCash - allocatable);
  // New cash a stock can still take before it holds maxWeightPct of capital.
  // A core index ETF is diversified by construction, so it is not capped.
  const capRupees = p.maxWeightPct === undefined ? Infinity : (p.totalCapital * p.maxWeightPct) / 100;
  // The core applies only once the user holds an index-ETF book. Without one,
  // reserving its share would just starve the stock books.
  const coreOn = (p.corePct ?? 0) > 0 && cands.some((c) => c.core && c.manualBudget === undefined);
  const isCore = (c: Candidate): boolean => coreOn && !!c.core;
  const headroom = (c: Candidate): number => (isCore(c) ? Infinity : Math.max(0, capRupees - c.deployed - c.unsettled));

  const qualifies = (c: Candidate): boolean => c.eligible && c.trendUp && c.score >= p.minScore;
  const byScore = (a: Candidate, b: Candidate): number => b.score - a.score || a.symbol.localeCompare(b.symbol);
  const autoCands = cands.filter((c) => c.manualBudget === undefined);

  // The core is topped up to its target share first; the satellite gets the rest.
  const coreHeld = autoCands.filter(isCore).reduce((s, c) => s + c.deployed + c.unsettled, 0);
  const coreTarget = coreOn ? (p.totalCapital * p.corePct!) / 100 : 0;
  const coreMoney = coreOn ? Math.min(allocatable, Math.max(0, coreTarget - coreHeld)) : 0;
  const satMoney = allocatable - coreMoney;

  const corePool = autoCands.filter((c) => isCore(c) && qualifies(c)).sort(byScore);
  const coreN = Math.min(corePool.length, Math.floor(coreMoney / minBudget));
  const coreChosen = corePool.slice(0, Math.max(0, coreN));

  // A stock already at its cap cannot fund one more rung, so it is not a candidate.
  const pool = autoCands
    .filter((c) => !isCore(c) && qualifies(c) && headroom(c) >= p.minTranche)
    .sort(byScore);
  // Dropped stocks still holding lots can take up slots, so rotation cannot
  // keep adding names while old ones sit stuck.
  const topSlots = new Set(pool.slice(0, p.maxBooks).map((c) => c.symbol));
  const heldElsewhere = p.countHeldBooks
    ? autoCands.filter((c) => !isCore(c) && c.openLots > 0 && !topSlots.has(c.symbol)).length
    : 0;
  const slots = Math.max(0, p.maxBooks - heldElsewhere);
  const n = Math.min(slots, pool.length, Math.floor(satMoney / minBudget));
  const satChosen = pool.slice(0, Math.max(0, n));
  const chosen = [...coreChosen, ...satChosen];

  const shares = new Map<string, number>([
    ...waterFill(coreChosen.map((c) => ({ symbol: c.symbol, score: c.score, ceiling: headroom(c) })), coreMoney, minBudget),
    ...waterFill(satChosen.map((c) => ({ symbol: c.symbol, score: c.score, ceiling: headroom(c) })), satMoney, minBudget),
  ]);
  const funded = [...shares.values()].reduce((s, v) => s + round1k(v), 0);

  // ── rescue: finish the ladder of a dropped stock whose trend is still up ──
  const rescueCashOf = new Map<string, { cash: number; tranches: number }>();
  if ((p.rescueRungs ?? 0) > 0) {
    let left = allocatable - funded;
    const chosenSet = new Set(chosen.map((c) => c.symbol));
    for (const c of autoCands.filter((x) => !chosenSet.has(x.symbol) && x.openLots > 0 && x.eligible && x.trendUp).sort(byScore)) {
      const r = p.rescueRungs!;
      const held = c.deployed + c.unsettled;
      // Enough that each of the r new rungs clears the dust gate: the ladder
      // splits (budget × (1 − reserve) − spent on this ladder) over its unfilled rungs.
      const budget = (p.minTranche * r + (c.epochSpent ?? held)) / (1 - p.reservePct / 100);
      const cash = Math.ceil(Math.max(0, budget - held) / 1000) * 1000;
      if (!(cash > 0) || cash > left) continue;
      left -= cash;
      rescueCashOf.set(c.symbol, { cash, tranches: Math.min(p.maxRungs, (c.epochFilled ?? c.openLots) + r) });
    }
  }
  const rescueCash = [...rescueCashOf.values()].reduce((s, v) => s + v.cash, 0);

  // A hand-set rung count wins; otherwise what the cash affords on top of the open ladder.
  const manualTranchesFor = (c: Candidate, cash: number): number =>
    c.manualTranches ?? rungsForBook(c, cash, p, (x) => (x > 0 ? manualRungs(x, p) : p.minRungs));

  let used = 0;
  const allocations: Allocation[] = cands.map((c) => {
    if (c.manualBudget !== undefined) {
      const cash = manualCashOf.get(c.symbol) ?? 0;
      const held = c.deployed + c.unsettled;
      const notes: string[] = [];
      if (scale < 1 && want.get(c.symbol)! > 0) {
        notes.push(`scaled down: your amounts need ₹${Math.round(wantTotal).toLocaleString('en-IN')} of new money, only ₹${Math.round(free).toLocaleString('en-IN')} is free`);
      }
      if (c.manualBudget! < held) notes.push(`₹${Math.round(held).toLocaleString('en-IN')} is already in lots/T+1, more than your amount, so no new buys`);
      if (cash > 0 && c.eligible && !c.trendUp) notes.push('the bot would not fund it: long-term trend is down');
      return {
        symbol: c.symbol,
        selected: cash > 0,
        rank: null,
        score: c.score,
        targetBudget: held + cash,
        targetCash: cash,
        tranches: manualTranchesFor(c, cash),
        weight: free > 0 ? cash / free : 0,
        manual: true,
        reason:
          `set by you: ₹${Math.round(c.manualBudget!).toLocaleString('en-IN')}` +
          (cash > 0 ? ` → ₹${Math.round(cash).toLocaleString('en-IN')} new cash` : ' — no new cash') +
          ` on ${manualTranchesFor(c, cash)} rung(s)${c.manualTranches !== undefined ? ' (rungs set by you)' : ''}` +
          (notes.length ? ` (${notes.join('; ')})` : '') +
          (c.openLots && cash === 0 ? ` — ${c.openLots} open lot(s) kept, selling at their own targets` : ''),
      };
    }
    const inCore = coreChosen.findIndex((x) => x.symbol === c.symbol);
    const inSat = satChosen.findIndex((x) => x.symbol === c.symbol);
    if (inCore >= 0 || inSat >= 0) {
      const share = round1k(shares.get(c.symbol) ?? 0);
      used += share;
      const tranches = rungsForBook(c, share, p, (cash) => rungsForBudget(cash, p));
      const rank = inCore >= 0 ? inCore + 1 : inSat + 1;
      return {
        symbol: c.symbol,
        selected: true,
        rank,
        score: c.score,
        targetBudget: c.deployed + c.unsettled + share,
        targetCash: share,
        tranches,
        weight: allocatable > 0 ? share / allocatable : 0,
        ...(inCore >= 0 ? { core: true } : {}),
        reason:
          (inCore >= 0 ? `index core #${rank}` : `rank #${rank}`) +
          `, strength ${c.score.toFixed(2)} → ₹${Math.round(share).toLocaleString('en-IN')} on ${tranches} rungs` +
          (inSat >= 0 && share >= round1k(headroom(c)) && Number.isFinite(capRupees)
            ? ` (capped at ${p.maxWeightPct}% of capital per stock)`
            : ''),
      };
    }
    const rescue = rescueCashOf.get(c.symbol);
    if (rescue) {
      used += rescue.cash;
      return {
        symbol: c.symbol,
        selected: true,
        rank: null,
        score: c.score,
        targetBudget: c.deployed + c.unsettled + rescue.cash,
        targetCash: rescue.cash,
        tranches: rescue.tranches,
        weight: allocatable > 0 ? rescue.cash / allocatable : 0,
        rescue: true,
        reason:
          `not in the top ranks, but ${c.openLots} open lot(s) and an up trend: ₹${rescue.cash.toLocaleString('en-IN')} ` +
          `to finish its ladder (${p.rescueRungs} more rung${p.rescueRungs === 1 ? '' : 's'})`,
      };
    }
    let reason: string;
    if (!c.eligible) reason = c.reason ?? 'not enough history to score';
    else if (!c.trendUp) reason = 'downtrend (EMA50 below EMA200) — refusing to anchor';
    else if (c.score < p.minScore) reason = `strength ${c.score.toFixed(2)} below ${p.minScore}`;
    else if (allocatable < minBudget) {
      reason = manualCash > 0
        ? 'no capital left for the bot — the rest is in open lots and the amounts you set'
        : 'no allocatable capital — everything is committed to open lots';
    }
    else if (isCore(c)) {
      reason = coreMoney < minBudget
        ? `index core is at its ${p.corePct}% target (₹${Math.round(coreHeld).toLocaleString('en-IN')} held)`
        : `index core: beyond the ETFs ₹${Math.round(coreMoney).toLocaleString('en-IN')} can fund`;
    }
    else if (headroom(c) < p.minTranche) reason = `already holds ${p.maxWeightPct}% of capital, the per-stock cap`;
    else if (coreOn && coreMoney > 0 && satMoney < minBudget) {
      reason =
        `₹${Math.round(coreMoney).toLocaleString('en-IN')} of the free cash is held for the index-ETF core ` +
        `(${p.corePct}% target); the ₹${Math.round(satMoney).toLocaleString('en-IN')} left for stocks is under the ` +
        `₹${minBudget.toLocaleString('en-IN')} a stock needs`;
    }
    else if (slots === 0 && heldElsewhere > 0) {
      reason = `all ${p.maxBooks} slots are taken by stocks still holding lots`;
    }
    else {
      const idx = pool.findIndex((x) => x.symbol === c.symbol);
      reason = `rank #${idx + 1}, beyond the ${Math.max(0, n)} books ₹${Math.round(satMoney).toLocaleString('en-IN')} can fund`;
    }
    return {
      symbol: c.symbol,
      selected: false,
      rank: null,
      score: c.score,
      targetBudget: c.deployed + c.unsettled,
      targetCash: 0,
      tranches: p.minRungs,
      weight: 0,
      reason: reason + (c.openLots ? ` — ${c.openLots} open lot(s) kept, selling at their own targets` : ''),
    };
  });

  return {
    totalCapital: p.totalCapital,
    committed,
    allocatable: free,
    unallocated: free - manualCash - used,
    manualCash,
    coreCash: coreChosen.reduce((s, c) => s + round1k(shares.get(c.symbol) ?? 0), 0),
    rescueCash,
    heldBackByCeiling,
    minBudget,
    selected: [
      ...manual.filter((c) => (manualCashOf.get(c.symbol) ?? 0) > 0).map((c) => c.symbol),
      ...chosen.map((c) => c.symbol),
      ...rescueCashOf.keys(),
    ],
    allocations,
  };
}
