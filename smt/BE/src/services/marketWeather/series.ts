/**
 * Daily series helpers for Market Weather. Pure.
 *
 * Everything in this feature is a daily close on an IST trading date. Inputs
 * come from different markets that close at different times, so alignment is
 * the one thing here that can quietly cheat:
 *
 *   NSE closes 15:30 IST. The S&P 500, US VIX, the US 10-year, Brent and gold
 *   all print their "close" for the same calendar date AFTER that — US markets
 *   close at about 01:30 IST the next morning. Reading the same-date value of a
 *   US series on an Indian date therefore uses information that did not exist
 *   at the Indian close. `asOf(..., lag: true)` reads the last value STRICTLY
 *   BEFORE the date, which is what was knowable at 15:30 IST.
 */
import type { Candle } from '../../types';
import { istParts } from '../session';

export interface Series {
  key: string;
  /** IST trading dates, ascending, unique. */
  dates: string[];
  close: number[];
}

/** Candles → Series on IST dates; the last bar on a date wins. */
export function fromCandles(key: string, candles: Candle[]): Series {
  const byDate = new Map<string, number>();
  for (const c of candles) byDate.set(istParts(c.timestamp).date, c.close);
  const dates = [...byDate.keys()].sort();
  return { key, dates, close: dates.map((d) => byDate.get(d)!) };
}

/** Splice `older` in front of `newer`, using `older` only before `newer` starts (or before `cut`). */
export function splice(key: string, older: Series, newer: Series, cut?: string): Series {
  const start = cut ?? newer.dates[0] ?? '9999';
  const dates: string[] = [];
  const close: number[] = [];
  older.dates.forEach((d, i) => {
    if (d < start) {
      dates.push(d);
      close.push(older.close[i]);
    }
  });
  newer.dates.forEach((d, i) => {
    if (d >= start) {
      dates.push(d);
      close.push(newer.close[i]);
    }
  });
  return { key, dates, close };
}

/**
 * Align `s` onto `axis`: for each axis date, the last value of `s` on or before
 * it (`lag: false`, same-session markets) or strictly before it (`lag: true`,
 * markets that close after NSE). Null before `s` starts or when its last value
 * is older than `staleDays` calendar days.
 */
export function alignTo(axis: string[], s: Series | undefined, lag: boolean, staleDays = 10): (number | null)[] {
  if (!s || !s.dates.length) return axis.map(() => null);
  const out: (number | null)[] = [];
  let j = -1;
  for (const d of axis) {
    while (j + 1 < s.dates.length && (lag ? s.dates[j + 1] < d : s.dates[j + 1] <= d)) j++;
    if (j < 0 || daysBetween(s.dates[j], d) > staleDays) out.push(null);
    else out.push(s.close[j]);
  }
  return out;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/** Simple moving average; null until `n` values are available (nulls break the window). */
export function sma(xs: (number | null)[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(xs.length).fill(null);
  let sum = 0;
  let run = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    if (x == null) {
      sum = 0;
      run = 0;
      continue;
    }
    sum += x;
    run++;
    if (run > n) {
      sum -= xs[i - n] as number;
      run = n;
    }
    if (run === n) out[i] = sum / n;
  }
  return out;
}

/** Highest value over the trailing `n` bars including today (monotonic deque, O(n)). */
export function rollingMax(xs: number[], n: number): number[] {
  const out: number[] = [];
  const dq: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    while (dq.length && xs[dq[dq.length - 1]] <= xs[i]) dq.pop();
    dq.push(i);
    if (dq[0] <= i - n) dq.shift();
    out.push(xs[dq[0]]);
  }
  return out;
}

/** Lowest value over the trailing `n` bars including today. */
export function rollingMin(xs: number[], n: number): number[] {
  return rollingMax(xs.map((x) => -x), n).map((x) => -x);
}

/** Running maximum from the start (all-time high to date). */
export function runningMax(xs: number[]): number[] {
  let m = -Infinity;
  return xs.map((x) => (m = Math.max(m, x)));
}

/** Change over `k` bars as a fraction; null when either end is missing. */
export function change(xs: (number | null)[], i: number, k: number): number | null {
  if (i - k < 0) return null;
  const a = xs[i - k];
  const b = xs[i];
  return a != null && b != null && a > 0 ? b / a - 1 : null;
}

/** Lowest close over the next `h` bars, relative to today's close. Null if the window is incomplete. */
export function forwardWorst(close: number[], i: number, h: number): number | null {
  if (i + h >= close.length) return null;
  let m = close[i];
  for (let j = i + 1; j <= i + h; j++) if (close[j] < m) m = close[j];
  return m / close[i] - 1;
}

export function forwardReturn(close: number[], i: number, h: number): number | null {
  return i + h < close.length ? close[i + h] / close[i] - 1 : null;
}

/** Value at quantile q (0..1) of the finite numbers in xs; null when empty. */
export function quantile(xs: number[], q: number): number | null {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.floor(q * v.length)))];
}

/** Fraction of `xs` strictly below `v`. */
export function percentileOf(xs: number[], v: number): number | null {
  const f = xs.filter(Number.isFinite);
  return f.length ? f.filter((x) => x < v).length / f.length : null;
}

/**
 * Expanding percentile: each value's rank among all EARLIER values (0..1), so a
 * "top 20%" threshold on day t uses only what was known on day t. Null until
 * `minHistory` values have been seen, and for null inputs.
 */
export function expandingPct(xs: (number | null)[], minHistory = 250): (number | null)[] {
  const sorted: number[] = [];
  const out: (number | null)[] = [];
  for (const v of xs) {
    if (v == null || !Number.isFinite(v)) {
      out.push(null);
      continue;
    }
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (sorted[m] < v) lo = m + 1;
      else hi = m;
    }
    out.push(sorted.length >= minHistory ? lo / sorted.length : null);
    sorted.splice(lo, 0, v);
  }
  return out;
}
