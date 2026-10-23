/**
 * Calibration: what history says each market state was worth. Pure.
 *
 * Nothing on the Market Weather screen is a typed-in number. Every probability,
 * lift and backtest figure is produced here from the price history and written
 * to calibration.json by `npm run calibrate:weather`; `--check` recomputes and
 * fails if the shipped file has drifted.
 *
 * THE QUESTION ASKED OF EVERY STATE: on days when it held, how often did the
 * index fall 10% or more (lowest close in the next 63 trading days at least 10%
 * below today's), against the same rate on all days. That ratio is the lift.
 * It is asked separately of two halves of history, because a sign that works
 * in one half and not the other is most likely a fluke — and most of them are.
 *
 * OVERLAP. Daily windows overlap, so 1,000 "days" can be three events. Every
 * cell therefore also counts EPISODES: runs of on-days separated by more than a
 * month. The screen shows episodes, not days.
 *
 * ACTING ON IT. The rule backtests compare each exposure rule with a plain mix
 * holding the SAME AVERAGE exposure with no timing, the rest earning cash.
 * Holding less stock always falls less; only beating that mix is evidence of
 * timing skill.
 */
import type { EventMove, LabelHistory } from './events';
import { forwardReturn, forwardWorst } from './series';
import type { SectorCalibration } from './sectors';
import { SIGNALS, type Prepared, type SignalId } from './regime';

export const HORIZON_DAYS = 63;
export const FALL_THRESHOLD = -0.1;
/** Turbulence is judged on the next month: a 5%+ dip within 21 sessions. */
export const TURB_DAYS = 21;
export const TURB_THRESHOLD = -0.05;
/** A sign whose data starts after this date gets its halves split at the midpoint of its own history. */
const LATE_START = '2005-01-01';
/** On-days closer together than this belong to one episode. */
export const EPISODE_GAP_DAYS = 21;
export const DEFAULT_SPLIT = '2012-01-01';
/** Idle cash in the rule backtests, per year. */
export const CASH_YIELD = 0.06;
/** Cost per unit of exposure changed: STT, brokerage, slippage. */
export const SWITCH_COST = 0.002;
const WARMUP = 260;

export interface RateCell {
  days: number;
  episodes: number;
  /** Share of days followed by a 10%+ fall within the horizon. */
  hitRate: number | null;
  meanFwdRet: number | null;
  /** hitRate ÷ the baseline hitRate of the same period. */
  lift: number | null;
}

export interface SignalCalibration {
  id: SignalId;
  /** Against a 10%+ fall within 63 sessions; baseline = days on which the sign can be read. */
  all: RateCell;
  halves: [RateCell, RateCell];
  /** Against a 5%+ dip within 21 sessions (the turbulence test). */
  turbulence?: { all: RateCell; halves: [RateCell, RateCell] };
  /** Where this sign's two halves are split (its own midpoint when its data starts late). */
  split?: string;
  /** Baseline mean 63-session return over the same days, for calm signs. */
  baseFwdRet?: [number | null, number | null];
}

export interface BucketCalibration {
  label: string;
  lo: number;
  hi: number;
  cell: RateCell;
}

export interface Drawdown {
  peak: string;
  trough: string;
  depthPct: number;
  fallDays: number;
  recovered: string | null;
}

export interface RuleSegment {
  cagr: number;
  maxDD: number;
  avgExposure: number;
  matchedCagr: number;
  matchedMaxDD: number;
  /** cagr − matchedCagr, in percentage points per year. */
  edgePp: number;
}

export interface RuleCalibration {
  id: RuleId;
  label: string;
  all: RuleSegment;
  halves: [RuleSegment, RuleSegment];
}

export interface Calibration {
  version: 1;
  index: string;
  from: string;
  to: string;
  split: string;
  horizonDays: number;
  fallThreshold: number;
  breadthFrom: string | null;
  baseline: { all: RateCell; halves: [RateCell, RateCell] };
  priorReturn: { lookbackDays: number; buckets: BucketCalibration[] }[];
  signals: SignalCalibration[];
  drawdowns: Drawdown[];
  rules: RuleCalibration[];
  /** Phase 3: sector baskets in past falls (attached by the calibration script). */
  sectors?: SectorCalibration[];
  sectorFallsFrom?: string;
  /** Phase 4: measured moves of the catalogued shock events, and per-label history. */
  eventMoves?: EventMove[];
  events?: LabelHistory[];
  /**
   * How each level read near highs (within 5%) on NIFTY, and how often a 10%+ fall
   * within 3 months followed. In-sample: the grades behind the level use the
   * full history. Attached by the calibration script.
   */
  levelAtHighs?: Record<string, { days: number; hitRate: number | null }>;
}

interface Range {
  from: number;
  to: number; // exclusive
}

function rangeOf(p: Prepared, fromDate: string, toDate: string): Range {
  let from = p.axis.findIndex((d) => d >= fromDate);
  if (from < 0) from = p.axis.length;
  let to = p.axis.findIndex((d) => d >= toDate);
  if (to < 0) to = p.axis.length;
  return { from: Math.max(from, WARMUP), to };
}

/** Count episodes in an ascending list of day indexes. */
export function countEpisodes(idx: number[], gap = EPISODE_GAP_DAYS): number {
  let n = 0;
  let last = -Infinity;
  for (const i of idx) {
    if (i - last > gap) n++;
    last = i;
  }
  return n;
}

/**
 * The rate cell for days in `r` where `on(i)` is true. Days without a full
 * forward window are skipped. Without `baselineHit`, the lift is measured
 * against the days on which `on` is readable (not null), so a sign whose data
 * starts in 2008 is not compared with a 1998 baseline.
 */
export function rateCell(
  p: Prepared,
  r: Range,
  on: (i: number) => boolean | null,
  baselineHit?: number | null,
  horizon = HORIZON_DAYS,
  threshold = FALL_THRESHOLD,
): RateCell & { baseHit: number | null; baseRet: number | null } {
  const idx: number[] = [];
  let hits = 0;
  let ret = 0;
  let bn = 0;
  let bh = 0;
  let br = 0;
  for (let i = r.from; i < r.to; i++) {
    const worst = forwardWorst(p.close, i, horizon);
    if (worst == null) continue;
    const v = on(i);
    if (v == null) continue;
    const fr = forwardReturn(p.close, i, horizon)!;
    bn++;
    if (worst <= threshold) bh++;
    br += fr;
    if (v !== true) continue;
    idx.push(i);
    if (worst <= threshold) hits++;
    ret += fr;
  }
  const n = idx.length;
  const hitRate = n ? hits / n : null;
  const base = baselineHit !== undefined ? baselineHit : bn ? bh / bn : null;
  return {
    days: n,
    episodes: countEpisodes(idx),
    hitRate: round(hitRate),
    meanFwdRet: round(n ? ret / n : null),
    lift: hitRate != null && base ? round(hitRate / base, 2) : null,
    baseHit: round(bn ? bh / bn : null),
    baseRet: round(bn ? br / bn : null),
  };
}

/** Strip the helper fields before storing a cell. */
const cellOf = ({ baseHit: _b, baseRet: _r, ...c }: RateCell & { baseHit: number | null; baseRet: number | null }): RateCell => c;

function round(x: number | null, dp = 4): number | null {
  if (x == null || !Number.isFinite(x)) return null;
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/** Drawdowns of at least `min` (e.g. 0.10), peak to trough, with the recovery date. */
export function drawdowns(dates: string[], close: number[], min = 0.1): Drawdown[] {
  const out: Drawdown[] = [];
  let peak = 0;
  let trough = 0;
  let deep = false;
  for (let i = 1; i < close.length; i++) {
    if (close[i] >= close[peak]) {
      if (deep) out.push(dd(dates, close, peak, trough, dates[i]));
      deep = false;
      peak = i;
      trough = i;
    } else {
      if (close[i] < close[trough]) trough = i;
      if (close[trough] / close[peak] - 1 <= -min) deep = true;
    }
  }
  if (deep) out.push(dd(dates, close, peak, trough, null));
  return out;
}

function dd(dates: string[], close: number[], p: number, t: number, recovered: string | null): Drawdown {
  return {
    peak: dates[p],
    trough: dates[t],
    depthPct: Math.round((close[t] / close[p] - 1) * 1000) / 10,
    fallDays: t - p,
    recovered,
  };
}

// ── Exposure rules ─────────────────────────────────────────────────────────

export type RuleId = 'buyHold' | 'trend200Out' | 'trend200Half' | 'spxHalf' | 'breadthHalf' | 'newLowsHalf' | 'curveHalf' | 'composite';

type ExposureFn = (p: Prepared, i: number, prev: number) => number;

/** Each rule builds a fresh closure, so stateful rules (a hold timer) reset per run. */
export const RULES: { id: RuleId; label: string; make: () => ExposureFn }[] = [
  { id: 'buyHold', label: 'Buy and hold', make: () => () => 1 },
  {
    id: 'trend200Out',
    label: 'All out below the 200-day (2% band)',
    make: () => (p, i, prev) => {
      const s = p.sma200[i];
      if (s == null) return 1;
      if (p.close[i] < s * 0.98) return 0;
      if (p.close[i] > s * 1.02) return 1;
      return prev;
    },
  },
  {
    id: 'trend200Half',
    label: 'Hold 50% below the 200-day (2% band)',
    make: () => (p, i, prev) => {
      const s = p.sma200[i];
      if (s == null) return 1;
      if (p.close[i] < s * 0.98) return 0.5;
      if (p.close[i] > s * 1.02) return 1;
      return prev;
    },
  },
  {
    id: 'spxHalf',
    label: 'Hold 50% while the S&P 500 is below its 200-day',
    make: () => (p, i) => {
      const a = p.spx[i];
      const b = p.spxSma200[i];
      return a != null && b != null && a < b ? 0.5 : 1;
    },
  },
  {
    id: 'breadthHalf',
    label: 'Hold 50% for 63 days after a breadth divergence',
    make: () => {
      let timer = 0;
      const sig = SIGNALS.find((s) => s.id === 'breadthDivergence')!;
      return (p, i) => {
        if (sig.test(p, i) === true) timer = HORIZON_DAYS;
        if (timer > 0) {
          timer--;
          return 0.5;
        }
        return 1;
      };
    },
  },
  {
    id: 'newLowsHalf',
    label: 'Hold 50% for 63 days after 10%+ of stocks hit 52-week lows',
    make: () => {
      let timer = 0;
      const sig = SIGNALS.find((s) => s.id === 'newLowsSpread')!;
      return (p, i) => {
        if (sig.test(p, i) === true) timer = HORIZON_DAYS;
        if (timer > 0) {
          timer--;
          return 0.5;
        }
        return 1;
      };
    },
  },
  {
    id: 'curveHalf',
    label: 'Hold 50% for 63 days after the US curve re-steepens',
    make: () => {
      let timer = 0;
      const sig = SIGNALS.find((s) => s.id === 'curveResteepen')!;
      return (p, i) => {
        if (sig.test(p, i) === true) timer = HORIZON_DAYS;
        if (timer > 0) {
          timer--;
          return 0.5;
        }
        return 1;
      };
    },
  },
  {
    id: 'composite',
    label: 'Hold 50% when 2+ of: below 200-day, S&P below 200-day, VIX > 25, breadth < 35%',
    make: () => (p, i) => {
      const ids: SignalId[] = ['below200', 'spxBelow200', 'indiaVixHigh', 'washedOut'];
      const k = ids.filter((id) => SIGNALS.find((s) => s.id === id)!.test(p, i) === true).length;
      return k >= 2 ? 0.5 : 1;
    },
  },
];

/**
 * Exposure decided at close i applies to the return from i to i+1 — the rule
 * acts on the next session, never the one it just observed.
 */
export function simulate(p: Prepared, r: Range, fn: ExposureFn): { cagr: number; maxDD: number; avgExposure: number } {
  const cashDaily = CASH_YIELD / 252;
  let v = 1;
  let peak = 1;
  let maxDD = 0;
  let e = 1;
  let sumE = 0;
  let n = 0;
  for (let i = r.from; i < Math.min(r.to, p.close.length - 1); i++) {
    const ne = fn(p, i, e);
    if (ne !== e) {
      v *= 1 - SWITCH_COST * Math.abs(ne - e);
      e = ne;
    }
    v *= 1 + e * (p.close[i + 1] / p.close[i] - 1) + (1 - e) * cashDaily;
    sumE += e;
    n++;
    peak = Math.max(peak, v);
    maxDD = Math.min(maxDD, v / peak - 1);
  }
  const years = n / 250;
  return { cagr: years > 0 ? v ** (1 / years) - 1 : 0, maxDD, avgExposure: n ? sumE / n : 1 };
}

function segment(p: Prepared, r: Range, make: () => ExposureFn): RuleSegment {
  const s = simulate(p, r, make());
  const avg = s.avgExposure;
  const m = simulate(p, r, () => avg);
  return {
    cagr: round(s.cagr)!,
    maxDD: round(s.maxDD)!,
    avgExposure: round(avg)!,
    matchedCagr: round(m.cagr)!,
    matchedMaxDD: round(m.maxDD)!,
    edgePp: round((s.cagr - m.cagr) * 100, 2)!,
  };
}

// ── The whole calibration ──────────────────────────────────────────────────

const PRIOR_BUCKETS: [string, number, number][] = [
  ['Fell more than 10%', -Infinity, -0.1],
  ['Fell 0–10%', -0.1, 0],
  ['Rose 0–10%', 0, 0.1],
  ['Rose 10–20%', 0.1, 0.2],
  ['Rose 20–30%', 0.2, 0.3],
  ['Rose 30–50%', 0.3, 0.5],
  ['Rose more than 50%', 0.5, Infinity],
];

export function calibrate(p: Prepared, opts: { from?: string; split?: string } = {}): Calibration {
  const from = opts.from ?? p.axis[0];
  const split = opts.split ?? DEFAULT_SPLIT;
  const all = rangeOf(p, from, '9999');
  const h1 = rangeOf(p, from, split);
  const h2 = rangeOf(p, split, '9999');
  const always = (): boolean => true;

  const base = cellOf(rateCell(p, all, always, null));
  const b1 = cellOf(rateCell(p, h1, always, null));
  const b2 = cellOf(rateCell(p, h2, always, null));
  const withLift = (c: RateCell): RateCell => ({ ...c, lift: 1 });

  const signals: SignalCalibration[] = SIGNALS.map((s) => {
    const on = (i: number): boolean | null => s.test(p, i);
    // Split at the fixed date, or at the midpoint of the sign's own history if it starts late.
    let first = -1;
    let count = 0;
    for (let i = all.from; i < all.to; i++) if (on(i) != null) { if (first < 0) first = i; count++; }
    let sp = split;
    if (first >= 0 && p.axis[first] > LATE_START) {
      let k = 0;
      for (let i = first; i < all.to; i++) if (on(i) != null && ++k >= count / 2) { sp = p.axis[i]; break; }
    }
    const s1 = rangeOf(p, from, sp);
    const s2 = rangeOf(p, sp, '9999');
    const c1 = rateCell(p, s1, on);
    const c2 = rateCell(p, s2, on);
    return {
      id: s.id,
      split: sp,
      all: cellOf(rateCell(p, all, on)),
      halves: [cellOf(c1), cellOf(c2)],
      baseFwdRet: [c1.baseRet, c2.baseRet],
      turbulence: {
        all: cellOf(rateCell(p, all, on, undefined, TURB_DAYS, TURB_THRESHOLD)),
        halves: [cellOf(rateCell(p, s1, on, undefined, TURB_DAYS, TURB_THRESHOLD)), cellOf(rateCell(p, s2, on, undefined, TURB_DAYS, TURB_THRESHOLD))],
      },
    };
  });

  const priorReturn = [63, 126, 252].map((lookbackDays) => ({
    lookbackDays,
    buckets: PRIOR_BUCKETS.map(([label, lo, hi]) => ({
      label,
      lo,
      hi,
      cell: cellOf(rateCell(
        p,
        all,
        (i) => {
          if (i < lookbackDays) return null;
          const r = p.close[i] / p.close[i - lookbackDays] - 1;
          return r >= lo && r < hi;
        },
        base.hitRate,
      )),
    })),
  }));

  const rules: RuleCalibration[] = RULES.map((r) => ({
    id: r.id,
    label: r.label,
    all: segment(p, all, r.make),
    halves: [segment(p, h1, r.make), segment(p, h2, r.make)],
  }));

  const firstBreadth = p.breadth.findIndex((b) => b != null);
  const sliceFrom = Math.max(0, p.axis.findIndex((d) => d >= from));
  return {
    version: 1,
    index: p.indexKey,
    from: p.axis[all.from],
    to: p.axis[p.axis.length - 1],
    split,
    horizonDays: HORIZON_DAYS,
    fallThreshold: FALL_THRESHOLD,
    breadthFrom: firstBreadth >= 0 ? p.axis[firstBreadth] : null,
    baseline: { all: withLift(base), halves: [withLift(b1), withLift(b2)] },
    priorReturn,
    signals,
    drawdowns: drawdowns(p.axis.slice(sliceFrom), p.close.slice(sliceFrom)),
    rules,
  };
}

/**
 * Differences between two calibrations larger than `tol` on any rate, as
 * readable lines. Empty means they agree. Used by `--check`.
 */
export function diffCalibrations(a: Calibration, b: Calibration, tol = 0.01): string[] {
  const out: string[] = [];
  const cmp = (label: string, x: number | null, y: number | null, t = tol): void => {
    if (x == null && y == null) return;
    if (x == null || y == null || Math.abs(x - y) > t) out.push(`${label}: shipped ${x} vs recomputed ${y}`);
  };
  cmp('baseline', a.baseline.all.hitRate, b.baseline.all.hitRate);
  for (const s of a.signals) {
    const t = b.signals.find((x) => x.id === s.id);
    if (!t) {
      out.push(`signal ${s.id} missing from recomputed`);
      continue;
    }
    cmp(`${s.id} all`, s.all.hitRate, t.all.hitRate);
    s.halves.forEach((h, k) => cmp(`${s.id} half ${k + 1}`, h.hitRate, t.halves[k].hitRate));
    if (s.turbulence && t.turbulence) cmp(`${s.id} turbulence`, s.turbulence.all.hitRate, t.turbulence.all.hitRate);
  }
  for (const r of a.rules) {
    const t = b.rules.find((x) => x.id === r.id);
    if (t) cmp(`rule ${r.id} edge`, r.all.edgePp, t.all.edgePp, 0.5);
  }
  return out;
}
