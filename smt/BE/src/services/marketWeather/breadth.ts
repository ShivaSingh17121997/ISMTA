/**
 * Market breadth: what share of stocks are in their own uptrend. Pure.
 *
 * Breadth is the one input that showed a warning in BOTH halves of history
 * (MARKET_WEATHER.md): the index near its 52-week high while most stocks have
 * already rolled over. An index can make highs on a handful of heavyweights
 * while the median stock is falling; breadth sees that, the index cannot.
 *
 * SURVIVORSHIP. The universe is TODAY's NIFTY 500. Stocks that were in the
 * index in 2008 and later collapsed or delisted are missing, so historical
 * breadth reads somewhat stronger than it really was. That biases the measured
 * lift DOWN for "weak breadth" signals, not up. Coverage is reported per day so
 * early years with few listed names are visible rather than silently thin.
 */
import { rollingMin, type Series } from './series';

export interface BreadthRow {
  date: string;
  /** Share of covered stocks closing above their own 200-day average, 0..1. */
  above200: number | null;
  /** Share closing at a 252-day low. */
  at52wLow: number | null;
  /** Stocks with a 200-day history on this date. */
  coverage: number;
  /** (advancers − decliners) ÷ (advancers + decliners) for the day, −1..+1. */
  advNet: number | null;
  /** Cross-sectional standard deviation of 21-session returns (how scattered stocks are). */
  dispersion21: number | null;
  /** Equal-weight daily return of defensive (FMCG, healthcare) and cyclical (metals, realty, financials, capital goods) stocks. */
  defRet: number | null;
  cycRet: number | null;
}

/** Fewer names than this and the reading is noise, so it is reported as null. */
export const MIN_COVERAGE = 40;
/** A one-day move beyond this in one stock is a bad print, not information. */
const MAX_DAILY_MOVE = 0.4;

export const DEFENSIVE_INDUSTRIES = ['Fast Moving Consumer Goods', 'Healthcare'];
export const CYCLICAL_INDUSTRIES = ['Metals & Mining', 'Realty', 'Financial Services', 'Capital Goods'];

/**
 * Breadth on `axis` dates, from one pass over the stocks. A stock counts on a
 * date only if it traded that day; daily and 21-session returns only when the
 * previous bars are the previous axis days, so a suspension is never read as a
 * one-day move. `sectorOf` (by series key) enables the defensive / cyclical
 * returns; without it they are null.
 */
export function computeBreadth(
  axis: string[],
  stocks: Iterable<Series>,
  minCoverage = MIN_COVERAGE,
  sectorOf?: (seriesKey: string) => string | undefined,
): BreadthRow[] {
  const T = axis.length;
  const above = new Int32Array(T);
  const low = new Int32Array(T);
  const cov = new Int32Array(T);
  const adv = new Int32Array(T);
  const dec = new Int32Array(T);
  const r21n = new Int32Array(T);
  const r21s = new Float64Array(T);
  const r21q = new Float64Array(T);
  const defS = new Float64Array(T);
  const defN = new Int32Array(T);
  const cycS = new Float64Array(T);
  const cycN = new Int32Array(T);
  const pos = new Map(axis.map((d, i) => [d, i] as const));

  for (const s of stocks) {
    const c = s.close;
    if (c.length < 22) continue;
    const sec = sectorOf?.(s.key);
    const isDef = !!sec && DEFENSIVE_INDUSTRIES.includes(sec);
    const isCyc = !!sec && CYCLICAL_INDUSTRIES.includes(sec);
    const lows = c.length >= 252 ? rollingMin(c, 252) : null;
    let sum = 0;
    for (let i = 0; i < c.length; i++) {
      sum += c[i];
      if (i >= 200) sum -= c[i - 200];
      const at = pos.get(s.dates[i]);
      if (at === undefined) continue;
      // Daily move, only across consecutive axis days.
      if (i > 0 && at > 0 && s.dates[i - 1] === axis[at - 1]) {
        const r = c[i] / c[i - 1] - 1;
        if (Number.isFinite(r) && Math.abs(r) < MAX_DAILY_MOVE) {
          if (r > 0) adv[at]++;
          else if (r < 0) dec[at]++;
          if (isDef) { defS[at] += r; defN[at]++; }
          if (isCyc) { cycS[at] += r; cycN[at]++; }
        }
      }
      // 21-session return, only when the stock traded on each of those axis days.
      if (i >= 21 && at >= 21 && s.dates[i - 21] === axis[at - 21]) {
        const r = c[i] / c[i - 21] - 1;
        if (Number.isFinite(r) && Math.abs(r) < 2) { r21n[at]++; r21s[at] += r; r21q[at] += r * r; }
      }
      if (i < 199) continue;
      cov[at]++;
      if (c[i] > sum / 200) above[at]++;
      if (lows && i >= 251 && c[i] <= lows[i]) low[at]++;
    }
  }
  const MIN_GROUP = 5;
  return axis.map((date, i) => {
    const moved = adv[i] + dec[i];
    const n = r21n[i];
    const mean = n ? r21s[i] / n : 0;
    return {
      date,
      coverage: cov[i],
      above200: cov[i] >= minCoverage ? above[i] / cov[i] : null,
      at52wLow: cov[i] >= minCoverage ? low[i] / cov[i] : null,
      advNet: moved >= minCoverage ? (adv[i] - dec[i]) / moved : null,
      dispersion21: n >= minCoverage ? Math.sqrt(Math.max(0, r21q[i] / n - mean * mean)) : null,
      defRet: defN[i] >= MIN_GROUP ? defS[i] / defN[i] : null,
      cycRet: cycN[i] >= MIN_GROUP ? cycS[i] / cycN[i] : null,
    };
  });
}
