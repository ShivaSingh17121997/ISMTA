/**
 * Strength score — how "well-performing" a company is, on a 0..1 scale. Pure.
 *
 * Three transparent components, from daily closes:
 *
 *   momentum   0.5  3-month return plus half the 1-month return, scaled so
 *                   ±30% maps to the extremes. Rewards what has been rising.
 *   proximity  0.3  how close the last close sits to the 45-day high. A name
 *                   20% off its high scores 0 here — that is a broken trend,
 *                   not a dip. (The ladder's own start gate still requires a
 *                   6% discount before it anchors; proximity chooses the
 *                   company, the gate chooses the day.)
 *   trend      0.2  EMA50 above EMA200 with price above EMA200. Also a hard
 *                   filter: a downtrend is never funded, whatever the score —
 *                   the brief's rule that a confirmed downtrend refuses new
 *                   epochs, applied across companies.
 *
 * This is a ranking heuristic, not a forecast. It says which names have been
 * strong; it does not know which will stay strong. It is here because the user
 * asked the bot to favour performing stocks, and because laddering into a
 * downtrend is the one way this strategy turns bounded drawdown into a
 * permanent lock-up.
 */
import { ema } from '../../strategies/indicators';

export interface Strength {
  symbol: string;
  eligible: boolean;
  reason?: string;
  bars: number;
  score: number;
  ret3mPct: number;
  ret1mPct: number;
  /** last close vs the trailing high, percent, ≤ 0 unless at a new high. */
  distFromHighPct: number;
  trendUp: boolean;
  ema50: number | null;
  ema200: number | null;
  lastClose: number;
}

export interface StrengthOptions {
  /** Daily bars required. EMA200 needs 200; a fresh listing cannot be scored. */
  minBars: number;
  highLookback: number;
}

export const DEFAULT_STRENGTH_OPTIONS: StrengthOptions = { minBars: 200, highLookback: 45 };

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const pctChange = (closes: number[], back: number): number => {
  const a = closes[closes.length - 1 - back];
  const b = closes[closes.length - 1];
  return a > 0 ? (b / a - 1) * 100 : 0;
};

export function strength(
  symbol: string,
  closes: number[],
  highs: number[],
  opts: StrengthOptions = DEFAULT_STRENGTH_OPTIONS,
): Strength {
  const bars = closes.length;
  const lastClose = closes[bars - 1] ?? 0;
  const base: Strength = {
    symbol, eligible: false, bars, score: 0, ret3mPct: 0, ret1mPct: 0,
    distFromHighPct: 0, trendUp: false, ema50: null, ema200: null, lastClose,
  };
  if (bars < opts.minBars || !(lastClose > 0)) {
    return { ...base, reason: `insufficient history (${bars} daily bars, need ${opts.minBars})` };
  }

  const ret3mPct = pctChange(closes, 63);
  const ret1mPct = pctChange(closes, 21);
  const hi = Math.max(...highs.slice(-opts.highLookback));
  const distFromHighPct = hi > 0 ? (lastClose / hi - 1) * 100 : 0;
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const trendUp = ema50 !== null && ema200 !== null && ema50 > ema200 && lastClose > ema200;

  const momentum01 = (clamp((ret3mPct + 0.5 * ret1mPct) / 30, -1, 1) + 1) / 2;
  const proximity = clamp(1 + distFromHighPct / 20, 0, 1);
  const score = 0.5 * momentum01 + 0.3 * proximity + 0.2 * (trendUp ? 1 : 0);

  return {
    ...base,
    eligible: true,
    score: Math.round(score * 1000) / 1000,
    ret3mPct, ret1mPct, distFromHighPct, trendUp, ema50, ema200,
  };
}
