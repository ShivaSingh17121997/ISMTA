/**
 * Per-symbol technical measurements. Pure, and deliberately opinion-free.
 *
 * This module MEASURES and does not judge. It turns a candle series into a
 * fixed set of numbers — returns over several windows, trend state, volatility,
 * where price sits in its range, how heavily it is trading. Nothing here knows
 * what "good" is.
 *
 * The judging happens in `score.ts`, and it happens CROSS-SECTIONALLY: a stock
 * is ranked against the other stocks measured on the same day, not against a
 * constant someone picked. That split matters. A 12% three-month return is
 * excellent in a flat market and mediocre in a roaring one, and any scorer that
 * compares it to a fixed threshold is really just measuring the market.
 *
 * Windows are in TRADING days, because that is what a daily candle series
 * counts. The usual convention: 21 ≈ a month, 63 ≈ a quarter, 126 ≈ a half
 * year, 252 ≈ a year.
 */

import {
  adx,
  atr,
  ema,
  rsi,
  sma,
} from '../../strategies/indicators';
import type { Candle } from '../../types';

/** Trading days per calendar period, the convention used throughout. */
export const MONTH = 21;
export const QUARTER = 63;
export const HALF_YEAR = 126;
export const YEAR = 252;

/** Enough history for a 252-day lookback plus the 21-day skip momentum needs. */
export const MIN_BARS = YEAR + MONTH + 5;

export interface Metrics {
  symbol: string;
  bars: number;
  lastClose: number;
  asOf: number;

  /**
   * Momentum, percent, over several windows — all SKIPPING the most recent
   * month.
   *
   * The skip is not a detail. Jegadeesh and Titman's momentum is measured from
   * t−12 months to t−1 precisely because the most recent month runs the other
   * way: short-horizon reversal contaminates it. A "12-month momentum" that
   * includes last month is measuring two effects that partly cancel.
   */
  mom12_1: number;
  mom6_1: number;
  mom3_1: number;
  /** The skipped month itself, kept separately: it is a REVERSAL signal, not momentum. */
  ret1m: number;
  /** Last five sessions, for the short horizon. */
  ret1w: number;

  /**
   * Momentum divided by annualised volatility.
   *
   * This is the form the India-specific work favours: Raju's *Shades of
   * Momentum* tested academic, volatility-adjusted, idiosyncratic and
   * information-discreteness variants across 2008–2024 and found the
   * volatility-adjusted one delivered the best risk-adjusted returns. Raw
   * momentum rewards a stock for being violent; dividing by volatility asks
   * how much of the move was signal rather than noise.
   */
  momRiskAdj12_1: number;
  momRiskAdj6_1: number;
  momRiskAdj3_1: number;

  /**
   * Information discreteness, −1..+1. LOWER IS BETTER.
   *
   *   ID = sign(return) × (share of down days − share of up days)
   *
   * A stock that climbed smoothly on many small up days has continuous
   * information and negative ID. One that jumped on a few big days has
   * discrete information and positive ID. Da, Gurun & Warachka found momentum
   * falls monotonically from strongly positive for continuous information to
   * NEGATIVE for discrete — so the same 40% gain means opposite things
   * depending on how it arrived.
   */
  infoDiscreteness: number;

  /** Trend state. */
  ema20: number;
  ema50: number;
  sma200: number;
  aboveSma200: boolean;
  ema20Above50: boolean;
  /** (ema50 − sma200) / sma200, percent. How firmly the trend is established. */
  trendSpreadPct: number;
  /** Wilder's ADX: trend STRENGTH regardless of direction. Above ~25 is a real trend. */
  adx14: number | null;

  /** Where price sits in its own range. */
  high52w: number;
  low52w: number;
  /** 0 = at the 52-week low, 1 = at the high. George & Hwang's ranking variable. */
  pctOf52wRange: number;
  /** Distance below the 52-week high, percent, ≤ 0. */
  fromHighPct: number;

  /** Volatility. */
  atr14: number | null;
  /** ATR as a percent of price — the unit position sizing is denominated in. */
  atrPct: number | null;
  /** Annualised standard deviation of daily log returns over a quarter, percent. */
  volAnnualPct: number;

  /** Overbought/oversold. */
  rsi14: number | null;

  /** Liquidity: median daily turnover in rupees over the last quarter. */
  medianTurnover: number;
  /** Latest volume against its 50-day average. Above 1 means unusual interest. */
  volumeRatio: number;

  /** Nearest swing levels, for entry and stop placement. */
  supportRecent: number | null;
  resistanceRecent: number | null;
  /** The lowest low of the last 20 sessions — a conventional stop reference. */
  low20: number;
  high20: number;

  /** Worst peak-to-trough over the last year, percent. What owning it has cost. */
  maxDrawdown1yPct: number;
}

const pctChange = (closes: number[], back: number): number => {
  const from = closes[closes.length - 1 - back];
  const to = closes[closes.length - 1];
  return from > 0 ? (to / from - 1) * 100 : 0;
};

/** Return from `from` bars ago to `skip` bars ago — momentum with the recent month excluded. */
const skipMomentum = (closes: number[], from: number, skip: number): number => {
  const a = closes[closes.length - 1 - from];
  const b = closes[closes.length - 1 - skip];
  return a > 0 && b > 0 ? (b / a - 1) * 100 : 0;
};

/**
 * A swing low: a bar whose low is the lowest within `k` bars either side.
 * Returns the most recent one strictly below `price`, or null.
 */
function lastSwingLow(candles: Candle[], k = 3, below = Infinity): number | null {
  for (let i = candles.length - 1 - k; i >= k; i--) {
    const lo = candles[i].low;
    if (lo >= below) continue;
    let isSwing = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j !== i && candles[j].low < lo) { isSwing = false; break; }
    }
    if (isSwing) return lo;
  }
  return null;
}

/** A swing high, mirror of the above, strictly above `price`. */
function lastSwingHigh(candles: Candle[], k = 3, above = -Infinity): number | null {
  for (let i = candles.length - 1 - k; i >= k; i--) {
    const hi = candles[i].high;
    if (hi <= above) continue;
    let isSwing = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j !== i && candles[j].high > hi) { isSwing = false; break; }
    }
    if (isSwing) return hi;
  }
  return null;
}

/** Annualised stdev of daily log returns, percent. */
function annualisedVol(closes: number[], window: number): number {
  const n = Math.min(window, closes.length - 1);
  if (n < 5) return 0;
  const rets: number[] = [];
  for (let i = closes.length - n; i < closes.length; i++) {
    const a = closes[i - 1];
    const b = closes[i];
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < 5) return 0;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

/** Worst peak-to-trough over a window, as a positive percent. */
function maxDrawdownPct(closes: number[], window: number): number {
  const slice = closes.slice(-window);
  let peak = -Infinity;
  let dd = 0;
  for (const v of slice) {
    peak = Math.max(peak, v);
    if (peak > 0) dd = Math.max(dd, (peak - v) / peak);
  }
  return dd * 100;
}

/**
 * Information discreteness over a window: sign(return) × (%down − %up) days.
 * Negative means the move arrived smoothly, which is the favourable case.
 */
function infoDiscreteness(closes: number[], window: number): number {
  const n = Math.min(window, closes.length - 1);
  if (n < 20) return 0;
  const slice = closes.slice(-(n + 1));
  let up = 0;
  let down = 0;
  for (let i = 1; i < slice.length; i++) {
    if (slice[i] > slice[i - 1]) up++;
    else if (slice[i] < slice[i - 1]) down++;
  }
  const total = up + down;
  if (!total) return 0;
  const ret = slice[slice.length - 1] - slice[0];
  const sign = ret > 0 ? 1 : ret < 0 ? -1 : 0;
  return sign * ((down - up) / total);
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Measure one symbol. Returns null when there is not enough history — a stock
 * that listed four months ago cannot be ranked on a year of momentum, and
 * guessing is worse than omitting it.
 */
export function measure(symbol: string, candles: Candle[]): Metrics | null {
  const bars = candles.filter((c) => c.close > 0 && c.high > 0 && c.low > 0);
  if (bars.length < MIN_BARS) return null;

  const closes = bars.map((c) => c.close);
  const last = bars[bars.length - 1];
  const lastClose = last.close;

  const yearBars = bars.slice(-YEAR);
  const high52w = Math.max(...yearBars.map((c) => c.high));
  const low52w = Math.min(...yearBars.map((c) => c.low));
  const range = high52w - low52w;

  const ema20 = ema(closes, 20) ?? lastClose;
  const ema50 = ema(closes, 50) ?? lastClose;
  const sma200 = sma(closes, 200) ?? lastClose;
  const a14 = atr(bars, 14);

  const last20 = bars.slice(-20);
  const quarterBars = bars.slice(-QUARTER);
  const turnovers = quarterBars.map((c) => c.close * c.volume);
  const vol50 = bars.slice(-50).reduce((s, c) => s + c.volume, 0) / Math.min(50, bars.length);

  const mom12_1 = skipMomentum(closes, YEAR, MONTH);
  const mom6_1 = skipMomentum(closes, HALF_YEAR, MONTH);
  const mom3_1 = skipMomentum(closes, QUARTER, MONTH);
  // Volatility over a full year, so the denominator is not itself noisy.
  const vol1y = annualisedVol(closes, YEAR);
  // Guarded: a near-zero denominator would turn a rounding error into a
  // top-ranked stock.
  const riskAdj = (m: number) => (vol1y > 1 ? m / vol1y : 0);

  return {
    symbol,
    bars: bars.length,
    lastClose,
    asOf: last.timestamp,

    mom12_1,
    mom6_1,
    mom3_1,
    ret1m: pctChange(closes, MONTH),
    ret1w: pctChange(closes, 5),
    momRiskAdj12_1: riskAdj(mom12_1),
    momRiskAdj6_1: riskAdj(mom6_1),
    momRiskAdj3_1: riskAdj(mom3_1),
    infoDiscreteness: infoDiscreteness(closes, HALF_YEAR),

    ema20,
    ema50,
    sma200,
    aboveSma200: lastClose > sma200,
    ema20Above50: ema20 > ema50,
    trendSpreadPct: sma200 > 0 ? ((ema50 - sma200) / sma200) * 100 : 0,
    adx14: adx(bars, 14),

    high52w,
    low52w,
    pctOf52wRange: range > 0 ? (lastClose - low52w) / range : 0.5,
    fromHighPct: high52w > 0 ? (lastClose / high52w - 1) * 100 : 0,

    atr14: a14,
    atrPct: a14 !== null && lastClose > 0 ? (a14 / lastClose) * 100 : null,
    volAnnualPct: annualisedVol(closes, QUARTER),

    rsi14: rsi(closes, 14),

    medianTurnover: median(turnovers),
    volumeRatio: vol50 > 0 ? last.volume / vol50 : 1,

    supportRecent: lastSwingLow(bars, 3, lastClose),
    resistanceRecent: lastSwingHigh(bars, 3, lastClose),
    low20: Math.min(...last20.map((c) => c.low)),
    high20: Math.max(...last20.map((c) => c.high)),

    maxDrawdown1yPct: maxDrawdownPct(closes, YEAR),
  };
}
