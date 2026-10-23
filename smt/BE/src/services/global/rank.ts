/**
 * Ranking markets and stocks for an Indian investor. Pure.
 *
 * THE SCORE. Country-index momentum is one of the best-documented effects in
 * finance (Asness, Moskowitz & Pedersen 2013 "Value and Momentum Everywhere";
 * Richards 1997): markets that did well over the past 6–12 months, leaving out
 * the most recent month, have tended to keep doing better than the rest for a
 * while. The score here is the average of two cross-sectional percentile ranks:
 *
 *   - 12-month return skipping the last month, divided by volatility
 *   - 6-month return skipping the last month, divided by volatility
 *
 * the same construction as NSE's own momentum indices. Everything is measured
 * in RUPEES. A market is called "in an uptrend" when its rupee value is above
 * its own 200-day average.
 *
 * WHAT THE SCORE IS NOT. It is not a forecast for any one market. The backtest
 * (backtest.ts) is what says whether following it has paid, and the page shows
 * that next to the ranking.
 */
import { alignTo, type Series } from '../marketWeather/series';
import type { FxSpec } from './universe';

/** Convert a local-currency series into rupees on its own dates. */
export function toInr(local: Series, usdPerLocal: Series | null, fx: FxSpec | null, inrPerUsd: Series, isInr = false): Series {
  if (isInr) return local;
  const usd = alignTo(local.dates, inrPerUsd, false, 7);
  const fxv = fx && usdPerLocal ? alignTo(local.dates, usdPerLocal, false, 7) : null;
  const dates: string[] = [];
  const close: number[] = [];
  local.dates.forEach((d, i) => {
    const inr = usd[i];
    let rate: number | null = 1;
    if (fx) {
      const q = fxv?.[i];
      rate = q == null || !(q > 0) ? null : fx.invert ? 1 / q : q;
    }
    if (inr == null || rate == null) return;
    dates.push(d);
    close.push(local.close[i] * rate * inr);
  });
  return { key: `${local.key}:INR`, dates, close };
}

export interface Metrics {
  asOf: string;
  last: number;
  ret1m: number | null;
  ret3m: number | null;
  ret6m: number | null;
  ret12m: number | null;
  cagr3y: number | null;
  cagr5y: number | null;
  /** 12-month and 6-month return, both leaving out the last month. */
  mom12_1: number | null;
  mom6_1: number | null;
  /** Annualised volatility of daily returns over the past year. */
  vol1y: number | null;
  /** Worst peak-to-trough fall over the past 3 years. */
  maxDD3y: number | null;
  /** Distance from the 52-week high. */
  fromHigh: number | null;
  /** Above its own 200-day average (in the currency measured). */
  uptrend: boolean | null;
}

/** Index of the last date on or before `daysAgo` calendar days back. */
function backIdx(dates: string[], i: number, days: number): number | null {
  const target = Date.parse(dates[i]) - days * 86_400_000;
  let lo = 0;
  let hi = i;
  if (Date.parse(dates[0]) > target) return null;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (Date.parse(dates[m]) <= target) lo = m;
    else hi = m - 1;
  }
  return lo;
}

export function metricsOf(s: Series, at = s.dates.length - 1): Metrics | null {
  if (at < 260) return null;
  const c = s.close;
  const d = s.dates;
  const ret = (days: number): number | null => {
    const k = backIdx(d, at, days);
    return k == null ? null : c[at] / c[k] - 1;
  };
  const cagr = (years: number): number | null => {
    const k = backIdx(d, at, Math.round(years * 365.25));
    return k == null ? null : (c[at] / c[k]) ** (1 / years) - 1;
  };
  const skip = backIdx(d, at, 30);
  const m12 = backIdx(d, at, 365);
  const m6 = backIdx(d, at, 182);
  const y1 = backIdx(d, at, 365) ?? 0;
  let s1 = 0;
  let s2 = 0;
  let n = 0;
  for (let k = y1 + 1; k <= at; k++) {
    const r = Math.log(c[k] / c[k - 1]);
    s1 += r;
    s2 += r * r;
    n++;
  }
  // Annualise on the number of bars per year actually observed (markets differ in holidays).
  const perYear = n > 0 ? n / ((Date.parse(d[at]) - Date.parse(d[y1])) / (365.25 * 86_400_000)) : 252;
  const vol = n > 20 ? Math.sqrt(Math.max(0, s2 / n - (s1 / n) ** 2) * perYear) : null;
  const k3 = backIdx(d, at, 3 * 365) ?? 0;
  let peak = c[k3];
  let mdd = 0;
  for (let k = k3; k <= at; k++) {
    peak = Math.max(peak, c[k]);
    mdd = Math.min(mdd, c[k] / peak - 1);
  }
  let hi = 0;
  for (let k = y1; k <= at; k++) hi = Math.max(hi, c[k]);
  let sum = 0;
  for (let k = at - 199; k <= at; k++) sum += c[k];
  return {
    asOf: d[at],
    last: c[at],
    ret1m: ret(30),
    ret3m: ret(91),
    ret6m: ret(182),
    ret12m: ret(365),
    cagr3y: cagr(3),
    cagr5y: cagr(5),
    mom12_1: skip != null && m12 != null ? c[skip] / c[m12] - 1 : null,
    mom6_1: skip != null && m6 != null ? c[skip] / c[m6] - 1 : null,
    vol1y: vol,
    maxDD3y: mdd,
    fromHigh: hi > 0 ? c[at] / hi - 1 : null,
    uptrend: at >= 199 ? c[at] > sum / 200 : null,
  };
}

/** Percentile ranks (0..1) of each value among the non-null values; ties share the mean rank. */
export function pctRanks(xs: (number | null)[]): (number | null)[] {
  const v = xs.map((x, i) => ({ x, i })).filter((o): o is { x: number; i: number } => o.x != null && Number.isFinite(o.x));
  const out: (number | null)[] = xs.map(() => null);
  if (v.length < 2) {
    v.forEach((o) => (out[o.i] = 0.5));
    return out;
  }
  v.sort((a, b) => a.x - b.x);
  for (let k = 0; k < v.length; ) {
    let j = k;
    while (j + 1 < v.length && v[j + 1].x === v[k].x) j++;
    const r = (k + j) / 2 / (v.length - 1);
    for (let m = k; m <= j; m++) out[v[m].i] = r;
    k = j + 1;
  }
  return out;
}

/** Momentum score per item: mean of the two risk-adjusted momentum ranks. Null if either input is missing. */
export function momentumScores(ms: (Metrics | null)[]): (number | null)[] {
  const ra = (m: Metrics | null, k: 'mom12_1' | 'mom6_1'): number | null =>
    m && m[k] != null && m.vol1y ? m[k]! / m.vol1y : null;
  const r12 = pctRanks(ms.map((m) => ra(m, 'mom12_1')));
  const r6 = pctRanks(ms.map((m) => ra(m, 'mom6_1')));
  return ms.map((_, i) => (r12[i] == null || r6[i] == null ? null : (r12[i]! + r6[i]!) / 2));
}

/** Correlation of monthly (every ~21 sessions) rupee returns over the last `years`. */
export function monthlyCorrelation(a: Series, b: Series, years = 5): number | null {
  const end = Date.parse(a.dates[a.dates.length - 1]);
  const pts: string[] = [];
  for (let t = end - years * 365.25 * 86_400_000; t <= end; t += 30.44 * 86_400_000) pts.push(new Date(t).toISOString().slice(0, 10));
  const av = alignTo(pts, a, false, 10);
  const bv = alignTo(pts, b, false, 10);
  const ra: number[] = [];
  const rb: number[] = [];
  for (let k = 1; k < pts.length; k++) {
    if (av[k] == null || av[k - 1] == null || bv[k] == null || bv[k - 1] == null) continue;
    ra.push(av[k]! / av[k - 1]! - 1);
    rb.push(bv[k]! / bv[k - 1]! - 1);
  }
  if (ra.length < 24) return null;
  const ma = ra.reduce((x, y) => x + y, 0) / ra.length;
  const mb = rb.reduce((x, y) => x + y, 0) / rb.length;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let k = 0; k < ra.length; k++) {
    sab += (ra[k] - ma) * (rb[k] - mb);
    saa += (ra[k] - ma) ** 2;
    sbb += (rb[k] - mb) ** 2;
  }
  return saa && sbb ? Math.round((sab / Math.sqrt(saa * sbb)) * 100) / 100 : null;
}
