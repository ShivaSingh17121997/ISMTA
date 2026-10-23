/** Technical-indicator helpers used by the strategies and backtester. */
import { Candle } from '../types';

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/** Full EMA series (same length as input); returns [] if not enough data. */
export function emaSeries(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  // seed with SMA of first `period` values
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function ema(values: number[], period: number): number | null {
  const s = emaSeries(values, period);
  return s.length ? s[s.length - 1] : null;
}

/** Rate of change (%) over `period` bars. */
export function roc(values: number[], period: number): number | null {
  if (values.length <= period) return null;
  const prev = values[values.length - 1 - period];
  const last = values[values.length - 1];
  if (!prev) return null;
  return ((last - prev) / prev) * 100;
}

export interface MACDResult {
  macd: number;
  signal: number;
  histogram: number;
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MACDResult | null {
  if (values.length < slow + signalPeriod) return null;
  const fastEma = emaSeries(values, fast);
  const slowEma = emaSeries(values, slow);
  const macdLine: number[] = [];
  for (let i = slow - 1; i < values.length; i++) {
    if (fastEma[i] != null && slowEma[i] != null) macdLine.push(fastEma[i] - slowEma[i]);
  }
  const signalLine = emaSeries(macdLine, signalPeriod);
  const macdVal = macdLine[macdLine.length - 1];
  const signalVal = signalLine[signalLine.length - 1];
  if (signalVal == null) return null;
  return { macd: macdVal, signal: signalVal, histogram: macdVal - signalVal };
}

export interface Bollinger {
  middle: number;
  upper: number;
  lower: number;
}

export function bollinger(values: number[], period = 20, mult = 2): Bollinger | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { middle: mean, upper: mean + mult * sd, lower: mean - mult * sd };
}

/** Relative Strength Index (Wilder's smoothing). */
export function rsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ─── Candle-based indicators (need OHLC, not just closes) ──────────────

/** Average True Range series (Wilder smoothing), indexed by candle position. */
export function atrSeries(candles: Candle[], period = 14): number[] {
  if (candles.length < period + 1) return [];
  const tr: number[] = []; // tr[i-1] corresponds to candle i (i>=1)
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const out: number[] = [];
  let prev = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i - 1]) / period;
    out[i] = prev;
  }
  return out;
}

export function atr(candles: Candle[], period = 14): number | null {
  const s = atrSeries(candles, period);
  const v = s[s.length - 1];
  return v == null ? null : v;
}

/**
 * Average Directional Index (Wilder). Trend STRENGTH, direction-agnostic.
 *
 * This is the regime gate for all three NTB entry models: breakout/pullback
 * stand aside when ADX is low (chop), mean-reversion stands aside when it is
 * high (a trend you must not fade).
 *
 * Indexed by candle position; the first defined value lands at `2*period - 1`,
 * because ADX is a Wilder average of DX, which is itself Wilder-smoothed.
 */
export function adxSeries(candles: Candle[], period = 14): number[] {
  const n = candles.length;
  const out: number[] = [];
  if (n < 2 * period) return out;

  // Directional movement + true range, aligned so index i belongs to candle i.
  const tr: number[] = [0];
  const plusDM: number[] = [0];
  const minusDM: number[] = [0];
  for (let i = 1; i < n; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const ph = candles[i - 1].high;
    const pl = candles[i - 1].low;
    const pc = candles[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    const up = h - ph;
    const down = pl - l;
    // Only the LARGER move counts, and only if it is positive.
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }

  // Seed the Wilder averages at index `period` (mean of the first `period` values).
  let trW = 0;
  let plusW = 0;
  let minusW = 0;
  for (let i = 1; i <= period; i++) {
    trW += tr[i];
    plusW += plusDM[i];
    minusW += minusDM[i];
  }
  trW /= period;
  plusW /= period;
  minusW /= period;

  const dx: number[] = [];
  const computeDx = (i: number) => {
    // DI is a ratio of like-smoothed terms, so mean- vs sum-smoothing is equivalent here.
    const plusDI = trW > 0 ? (100 * plusW) / trW : 0;
    const minusDI = trW > 0 ? (100 * minusW) / trW : 0;
    const sum = plusDI + minusDI;
    dx[i] = sum > 0 ? (100 * Math.abs(plusDI - minusDI)) / sum : 0;
  };
  computeDx(period);
  for (let i = period + 1; i < n; i++) {
    trW = (trW * (period - 1) + tr[i]) / period;
    plusW = (plusW * (period - 1) + plusDM[i]) / period;
    minusW = (minusW * (period - 1) + minusDM[i]) / period;
    computeDx(i);
  }

  // ADX seeds as the mean of the first `period` DX values → index 2*period - 1.
  let sum = 0;
  for (let i = period; i <= 2 * period - 1; i++) sum += dx[i];
  let adxVal = sum / period;
  out[2 * period - 1] = adxVal;
  for (let i = 2 * period; i < n; i++) {
    adxVal = (adxVal * (period - 1) + dx[i]) / period;
    out[i] = adxVal;
  }
  return out;
}

export function adx(candles: Candle[], period = 14): number | null {
  const s = adxSeries(candles, period);
  const v = s[s.length - 1];
  return v == null ? null : v;
}

/**
 * Higher-timeframe trend confirmation (NTB spec Phase 2).
 *
 * Samples every `factor`-th close BACKWARDS from the newest candle, then asks
 * whether that coarser series' fast/slow EMAs agree with the entry. On 5m data,
 * factor=12 confirms against the 1h trend.
 *
 * Note the sampling anchors to the most recent candle, NOT to wall-clock hour
 * boundaries. That is the spec's own documented simplification; it means the
 * sampled series shifts by one bar each candle. Kept for parity with NTB.
 *
 * Returns null when disabled (factor <= 1) or when there is not enough data —
 * callers treat null as "no opinion", never as a veto.
 */
export function htfTrend(
  candles: Candle[],
  factor: number,
  fast: number,
  slow: number,
): 'BUY' | 'SELL' | null {
  if (factor <= 1) return null;
  const sampled: number[] = [];
  for (let i = candles.length - 1; i >= 0; i -= factor) sampled.push(candles[i].close);
  if (sampled.length < slow) return null;
  sampled.reverse(); // back to oldest → newest
  const f = emaSeries(sampled, fast);
  const s = emaSeries(sampled, slow);
  const fv = f[f.length - 1];
  const sv = s[s.length - 1];
  if (fv == null || sv == null) return null;
  return fv > sv ? 'BUY' : 'SELL';
}

/** Donchian channel over the `period` bars BEFORE the latest bar (for breakouts). */
export function donchian(
  candles: Candle[],
  period = 20,
): { upper: number; lower: number; middle: number } | null {
  if (candles.length < period + 1) return null;
  const prior = candles.slice(-(period + 1), -1);
  const upper = Math.max(...prior.map((c) => c.high));
  const lower = Math.min(...prior.map((c) => c.low));
  return { upper, lower, middle: (upper + lower) / 2 };
}

/** Volume-weighted average price over the last `period` candles. */
export function vwap(candles: Candle[], period = 20): number | null {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  let pv = 0;
  let vol = 0;
  for (const c of slice) {
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * c.volume;
    vol += c.volume;
  }
  return vol > 0 ? pv / vol : null;
}

/** Supertrend — returns current and previous trend (+1 up / -1 down) for flip detection. */
export function supertrend(
  candles: Candle[],
  period = 10,
  mult = 3,
): { trend: number; prevTrend: number; value: number } | null {
  const n = candles.length;
  if (n < period + 2) return null;
  const a = atrSeries(candles, period);

  let prevFinalUpper = 0;
  let prevFinalLower = 0;
  let prevTrend = 1;
  let started = false;
  let lastTrend = 1;
  let secondLastTrend = 1;
  let lastValue = 0;

  for (let i = period; i < n; i++) {
    const atrVal = a[i];
    if (atrVal == null) continue;
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const basicUpper = hl2 + mult * atrVal;
    const basicLower = hl2 - mult * atrVal;
    const close = candles[i].close;
    const prevClose = candles[i - 1].close;

    let finalUpper: number;
    let finalLower: number;
    let trend: number;
    if (!started) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      trend = close > finalUpper ? 1 : -1;
      started = true;
    } else {
      finalUpper =
        basicUpper < prevFinalUpper || prevClose > prevFinalUpper ? basicUpper : prevFinalUpper;
      finalLower =
        basicLower > prevFinalLower || prevClose < prevFinalLower ? basicLower : prevFinalLower;
      trend = prevTrend === 1 ? (close < finalLower ? -1 : 1) : close > finalUpper ? 1 : -1;
    }

    secondLastTrend = lastTrend;
    lastTrend = trend;
    lastValue = trend === 1 ? finalLower : finalUpper;
    prevFinalUpper = finalUpper;
    prevFinalLower = finalLower;
    prevTrend = trend;
  }

  return { trend: lastTrend, prevTrend: secondLastTrend, value: lastValue };
}
