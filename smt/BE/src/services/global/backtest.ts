/**
 * Does following the country-momentum ranking pay, for an Indian investor? Pure.
 *
 * Monthly, from 2004: at each month end, rank the foreign markets on the same
 * two risk-adjusted momentum measures the live page uses (computed only from
 * month-end values up to that month), hold the top N equally for the next
 * month, all in rupees. Switching costs 0.3% of the money moved (brokerage, FX
 * spread and the bid-ask of an ETF). Compared with:
 *   - holding every foreign market equally, rebalanced monthly (the fair test:
 *     same markets, no ranking),
 *   - the Sensex and the S&P 500 in rupees,
 *   - the BOTTOM N, as a sanity check that the ranking means something.
 * The window is split in two; a strategy must beat the equal-weight basket in
 * both halves before the page says the ranking has worked.
 *
 * Index prices exclude dividends, which lowers every line similarly. The
 * markets are today's list, so countries that were dropped from investors'
 * radar are not represented (mild survivorship).
 */
import { alignTo, type Series } from '../marketWeather/series';

export const SWITCH_COST = 0.003;
const CASH_YIELD_MONTHLY = 0.06 / 12;

export interface CurvePoint {
  month: string;
  value: number;
}

export interface StrategyResult {
  id: string;
  label: string;
  cagr: number;
  maxDD: number;
  vol: number;
  halves: [number, number];
  /** CAGR minus the equal-weight basket's CAGR, per half, in percentage points. */
  edgeHalves: [number, number];
  curve: CurvePoint[];
  /** Markets held in the latest month (top-N strategies only). */
  holding: string[];
}

export interface BacktestResult {
  from: string;
  to: string;
  split: string;
  months: number;
  strategies: StrategyResult[];
  /** True when both "top N" strategies beat the basket in both halves. */
  rankingWorked: boolean;
}

/** Last calendar day of each month from `from` to the last month in data. */
export function monthEnds(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  for (;;) {
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    if (last > to) break;
    out.push(last);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

function stats(values: number[], months: string[], mid: number): { cagr: number; maxDD: number; vol: number; halves: [number, number] } {
  const c = (a: number, b: number): number => {
    const yrs = (b - a) / 12;
    return yrs > 0 ? (values[b] / values[a]) ** (1 / yrs) - 1 : 0;
  };
  let peak = values[0];
  let mdd = 0;
  const rets: number[] = [];
  for (let k = 0; k < values.length; k++) {
    peak = Math.max(peak, values[k]);
    mdd = Math.min(mdd, values[k] / peak - 1);
    if (k) rets.push(values[k] / values[k - 1] - 1);
  }
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / rets.length) * Math.sqrt(12);
  void months;
  return { cagr: c(0, values.length - 1), maxDD: mdd, vol, halves: [c(0, mid), c(mid, values.length - 1)] };
}

export function runBacktest(
  inrByCode: Map<string, Series>,
  opts: {
    candidates: string[];
    benchmarks: Record<string, string>;
    from?: string;
    topN?: number[];
    trendGate?: boolean;
    /** Fixed-weight mixes; the key '*foreign' means all candidates equally. */
    mixes?: { id: string; label: string; weights: Record<string, number> }[];
  } = { candidates: [], benchmarks: {} },
): BacktestResult {
  const from = opts.from ?? '2004-01-01';
  const lastDate = [...inrByCode.values()].reduce((a, s) => (s.dates[s.dates.length - 1] > a ? s.dates[s.dates.length - 1] : a), '0000');
  const months = monthEnds(from, lastDate);
  // The current month is incomplete: the last point is the last data date, not month end.
  if (months[months.length - 1] < lastDate) months.push(lastDate);
  const V = new Map<string, (number | null)[]>();
  for (const [code, s] of inrByCode) V.set(code, alignTo(months, s, false, 10));
  const T = months.length;
  const mid = Math.floor(T / 2);
  const cands = opts.candidates.filter((c) => V.has(c));

  // Momentum score at month t from values up to t only.
  const scoreAt = (t: number): Map<string, number> => {
    const raw: { code: string; a: number; b: number }[] = [];
    for (const code of cands) {
      const v = V.get(code)!;
      if (t < 13 || v[t] == null || v[t - 1] == null || v[t - 12] == null || v[t - 6] == null) continue;
      const rets: number[] = [];
      for (let k = t - 11; k <= t; k++) if (v[k] != null && v[k - 1] != null) rets.push(v[k]! / v[k - 1]! - 1);
      if (rets.length < 10) continue;
      const mu = rets.reduce((x, y) => x + y, 0) / rets.length;
      const vol = Math.sqrt(rets.reduce((x, y) => x + (y - mu) ** 2, 0) / rets.length) * Math.sqrt(12) || 1;
      raw.push({ code, a: (v[t - 1]! / v[t - 12]! - 1) / vol, b: (v[t - 1]! / v[t - 6]! - 1) / vol });
    }
    const rank = (key: 'a' | 'b'): Map<string, number> => {
      const sorted = [...raw].sort((x, y) => x[key] - y[key]);
      return new Map(sorted.map((r, k) => [r.code, sorted.length > 1 ? k / (sorted.length - 1) : 0.5] as const));
    };
    const ra = rank('a');
    const rb = rank('b');
    return new Map(raw.map((r) => [r.code, (ra.get(r.code)! + rb.get(r.code)!) / 2] as const));
  };
  const trendUp = (code: string, t: number): boolean => {
    const v = V.get(code)!;
    if (t < 10 || v[t] == null) return false;
    let s = 0;
    let n = 0;
    for (let k = t - 9; k <= t; k++) if (v[k] != null) { s += v[k]!; n++; }
    return n >= 8 && v[t]! > s / n;
  };

  const ret = (code: string, t: number): number | null => {
    const v = V.get(code)!;
    return v[t] != null && v[t + 1] != null ? v[t + 1]! / v[t]! - 1 : null;
  };

  const start = 13;
  const run = (pick: (t: number) => string[], cashIfShort = 0): { values: number[]; holding: string[] } => {
    const values = [1];
    let prev: string[] = [];
    let holding: string[] = [];
    for (let t = start; t < T - 1; t++) {
      const sel = pick(t);
      const n = Math.max(sel.length, cashIfShort);
      const w = n ? 1 / n : 0;
      // Turnover: share of money moved between this month's and last month's holdings.
      const moved = prev.length || sel.length ? sel.filter((s) => !prev.includes(s)).length / Math.max(1, n) : 0;
      let r = 0;
      let used = 0;
      for (const s of sel) {
        const x = ret(s, t);
        if (x == null) continue;
        r += w * x;
        used += w;
      }
      r += (1 - used) * CASH_YIELD_MONTHLY;
      values.push(values[values.length - 1] * (1 + r) * (1 - SWITCH_COST * moved));
      prev = sel;
      holding = sel;
    }
    return { values, holding };
  };

  const strategies: StrategyResult[] = [];
  const add = (id: string, label: string, r: { values: number[]; holding: string[] }): void => {
    const st = stats(r.values, months, mid - start);
    strategies.push({
      id,
      label,
      ...st,
      edgeHalves: [0, 0],
      curve: r.values.map((v, k) => ({ month: months[start + k], value: Math.round(v * 10000) / 10000 })),
      holding: r.holding,
    });
  };
  const ew = run((t) => cands.filter((c) => ret(c, t) != null));
  add('equalWeight', `All ${cands.length} foreign markets, equal weight`, ew);
  for (const n of opts.topN ?? [3, 5]) {
    add(`top${n}`, `Top ${n} by momentum`, run((t) => [...scoreAt(t)].sort((a, b) => b[1] - a[1]).slice(0, n).map(([c]) => c)));
    if (opts.trendGate !== false) {
      add(
        `top${n}trend`,
        `Top ${n} by momentum, only if in an uptrend (else cash)`,
        run((t) => [...scoreAt(t)].sort((a, b) => b[1] - a[1]).slice(0, n).map(([c]) => c).filter((c) => trendUp(c, t)), n),
      );
    }
  }
  add('bottom5', 'Bottom 5 by momentum (sanity check)', run((t) => [...scoreAt(t)].sort((a, b) => a[1] - b[1]).slice(0, 5).map(([c]) => c)));
  // Fixed mixes, rebalanced monthly back to their weights: the diversification question.
  const mix = (weights: Record<string, number>): { values: number[]; holding: string[] } => {
    const values = [1];
    for (let t = start; t < T - 1; t++) {
      let r = 0;
      let used = 0;
      for (const [code, w] of Object.entries(weights)) {
        if (code === '*foreign') {
          const live = cands.filter((c) => ret(c, t) != null);
          for (const c of live) r += (w / live.length) * ret(c, t)!;
          used += live.length ? w : 0;
          continue;
        }
        const x = V.has(code) ? ret(code, t) : null;
        if (x == null) continue;
        r += w * x;
        used += w;
      }
      r += (1 - used) * CASH_YIELD_MONTHLY;
      values.push(values[values.length - 1] * (1 + r));
    }
    return { values, holding: Object.keys(weights) };
  };
  for (const m of opts.mixes ?? []) add(m.id, m.label, mix(m.weights));
  for (const [id, code] of Object.entries(opts.benchmarks)) {
    if (V.has(code)) add(id, id === 'india' ? 'India (Sensex), in rupees' : id === 'us' ? 'S&P 500, in rupees' : code, run((t) => (ret(code, t) == null ? [] : [code])));
  }
  const base = strategies[0];
  for (const s of strategies) s.edgeHalves = [Math.round((s.halves[0] - base.halves[0]) * 10000) / 100, Math.round((s.halves[1] - base.halves[1]) * 10000) / 100];
  const tops = strategies.filter((s) => /^top\d+$/.test(s.id));
  return {
    from: months[start],
    to: months[T - 1],
    split: months[mid],
    months: T - start,
    strategies,
    rankingWorked: tops.length > 0 && tops.every((s) => s.edgeHalves[0] > 0 && s.edgeHalves[1] > 0),
  };
}
