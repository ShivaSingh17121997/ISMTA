/**
 * Turning a ranked stock into an actionable plan: where to buy, where the idea
 * is wrong, where to take profit, and how much money to put behind it. Pure.
 *
 * THE SIZING RULE, because it is the part people get backwards.
 *
 * Position size is derived from the STOP, not chosen first. You decide what
 * fraction of capital you are willing to lose if the idea fails — the risk
 * budget — and then buy however many shares put exactly that much at risk:
 *
 *     quantity = riskBudget / (entry − stop)
 *
 * A volatile stock needs a wider stop, so the same rupee risk buys fewer
 * shares. That is the point: every position risks the same amount regardless of
 * how jumpy the stock is, so one name cannot dominate the outcome. Sizing by
 * "how much do I like it" instead makes the loudest conviction the biggest
 * loss.
 *
 * Three caps sit on top, and each exists because the formula alone produces
 * something silly at the edges:
 *
 *   1. Position cap. A very tight stop implies a huge position. Capped as a
 *      percent of capital.
 *   2. Liquidity cap. A position that is large against a stock's daily
 *      turnover cannot be exited at the price on the screen. Capped as a
 *      fraction of median daily traded value.
 *   3. Whole shares. NSE cash has no fractional units, and the remainder is
 *      reported rather than quietly rounded away.
 *
 * NOTHING HERE PREDICTS ANYTHING. The stop is where the thesis is wrong, not a
 * forecast of the low. The target is a level worth taking profit at, not a
 * forecast of the high.
 */

import { roundToTick } from '../nse';
import type { Metrics } from './metrics';

export type Horizon = 'short' | 'medium' | 'long';

export interface HorizonSpec {
  horizon: Horizon;
  label: string;
  /** Intended holding period in trading days, low to high. */
  holdDays: [number, number];
  /** Stop distance as a multiple of ATR(14). Longer horizons need more room. */
  atrStopMult: number;
  /** First target as a multiple of the risk taken (reward:risk). */
  rewardRisk: number;
  /**
   * How far below the last close an entry may be placed, percent. A limit
   * further away than this is a wish, not a plan — it will simply never fill.
   */
  maxPullbackPct: number;
  /**
   * Ceiling on stop distance, percent of entry.
   *
   * The stop is normally the WIDER of an ATR stop and the last swing low, which
   * is right for a long hold. But a swing low can sit 11% away, and an 11% stop
   * on a three-day idea is not risk control — it is a position that will be
   * held through a move nobody intended to sit through. Past this cap the ATR
   * stop is used instead and the structure is ignored.
   */
  maxStopPct: number;
}

/**
 * The three horizons.
 *
 * Stops widen and targets stretch as the horizon lengthens, because the noise
 * you must tolerate scales with the time you intend to hold. A 1.5x ATR stop on
 * a twelve-month idea is not risk control, it is a guarantee of being shaken
 * out by an ordinary week.
 */
export const HORIZONS: Record<Horizon, HorizonSpec> = {
  short: {
    horizon: 'short',
    label: 'Short term',
    holdDays: [3, 20],
    atrStopMult: 1.5,
    rewardRisk: 2,
    maxPullbackPct: 4,
    maxStopPct: 6,
  },
  medium: {
    horizon: 'medium',
    label: 'Medium term',
    holdDays: [21, 126],
    atrStopMult: 2.5,
    rewardRisk: 2.5,
    maxPullbackPct: 7,
    maxStopPct: 12,
  },
  long: {
    horizon: 'long',
    label: 'Long term',
    holdDays: [126, 504],
    atrStopMult: 4,
    rewardRisk: 3,
    maxPullbackPct: 10,
    maxStopPct: 25,
  },
};

export interface SizingParams {
  /** Total capital the recommendations are sized against. */
  capital: number;
  /** Fraction of capital risked if a stop is hit, percent. */
  riskPerTradePct: number;
  /** Hard ceiling on one position, percent of capital. */
  maxPositionPct: number;
  /** A position may not exceed this share of median daily turnover, percent. */
  maxTurnoverPct: number;
  /** Positions below this are not worth the flat charges. */
  minPositionValue: number;
}

export const DEFAULT_SIZING: SizingParams = {
  capital: 200_000,
  riskPerTradePct: 1,
  maxPositionPct: 15,
  maxTurnoverPct: 1,
  minPositionValue: 16_000,
};

export type EntryKind = 'buy now' | 'wait for pullback' | 'wait for breakout';

export interface TradePlan {
  horizon: Horizon;
  entry: number;
  entryKind: EntryKind;
  entryNote: string;
  stop: number;
  stopNote: string;
  target: number;
  targetNote: string;
  /** Rupees at risk per share: entry − stop. */
  riskPerShare: number;
  /** Percent of the entry price that the stop is away. */
  stopDistancePct: number;
  rewardRisk: number;
  quantity: number;
  /** quantity × entry. */
  amount: number;
  pctOfCapital: number;
  /** Rupees lost if the stop is hit — should be close to the risk budget. */
  riskAmount: number;
  /** Rupees gained if the target is hit. */
  rewardAmount: number;
  /** Which cap, if any, decided the size. */
  sizedBy: 'risk budget' | 'position cap' | 'liquidity cap' | 'too small to trade';
  holdLabel: string;
  warnings: string[];
}

const holdLabel = (spec: HorizonSpec): string => {
  const [lo, hi] = spec.holdDays;
  const toText = (d: number) => (d < 21 ? `${d}d` : d < 252 ? `${Math.round(d / 21)}mo` : `${(d / 252).toFixed(0)}y`);
  return `${toText(lo)}–${toText(hi)}`;
};

/**
 * Build a plan for one stock at one horizon.
 *
 * Returns null only when the numbers are unusable — no ATR, or a stop that is
 * not below the entry. A plan that cannot state its own risk is worse than no
 * plan.
 */
export function buildPlan(
  m: Metrics,
  spec: HorizonSpec,
  sizing: SizingParams = DEFAULT_SIZING,
  /**
   * A floor on the ATR stop distance, from `turbulence.ts` — the multiple that
   * the drawdown this stock ORDINARILY suffers would otherwise reach.
   *
   * The measured 21-day dip runs 1.18–1.92 ATR depending on how volatile the
   * stock is, so a short-horizon 1.5× stop on a calm name sits inside ordinary
   * noise and gets taken out by the very move the model predicts. It binds
   * almost only there: medium stops at 2.5× and long at 4× already clear it,
   * and taking the MAX rather than scaling means those are left alone instead
   * of being widened into a needlessly smaller position.
   *
   * 0 leaves the stop exactly as it was, so existing callers are unaffected.
   */
  requiredStopAtr = 0,
): TradePlan | null {
  const atr = m.atr14;
  if (!atr || atr <= 0 || m.lastClose <= 0) return null;
  const warnings: string[] = [];
  const floor = Number.isFinite(requiredStopAtr) ? Math.max(0, Math.min(3, requiredStopAtr)) : 0;
  const atrStopMult = Math.max(spec.atrStopMult, floor);
  const widened = atrStopMult > spec.atrStopMult;

  // ── entry ────────────────────────────────────────────────────────────────
  // Prefer buying into a pullback rather than chasing, but only when the
  // pullback level is close enough to actually be reached. A limit 9% below
  // the market on a short-term idea is not an entry, it is a daydream.
  const pullbackTo = spec.horizon === 'short' ? m.ema20 : m.ema50;
  const pullbackPct = ((m.lastClose - pullbackTo) / m.lastClose) * 100;

  let entry: number;
  let entryKind: EntryKind;
  let entryNote: string;

  if (pullbackTo < m.lastClose && pullbackPct <= spec.maxPullbackPct && pullbackPct > 0.5) {
    entry = roundToTick(pullbackTo, 'up');
    entryKind = 'wait for pullback';
    entryNote =
      `Rest a limit at ₹${entry.toFixed(2)}, the ${spec.horizon === 'short' ? '20' : '50'}-day EMA, ` +
      `${pullbackPct.toFixed(1)}% below the last close. Buying the pullback rather than the print.`;
  } else {
    entry = roundToTick(m.lastClose, 'up');
    entryKind = 'buy now';
    entryNote =
      pullbackTo >= m.lastClose
        ? `Price is already at or below its moving average — no pullback to wait for. Enter near ₹${entry.toFixed(2)}.`
        : `The nearest pullback level is ${pullbackPct.toFixed(1)}% away, too far to wait for on this horizon. Enter near ₹${entry.toFixed(2)}.`;
  }

  // ── stop ─────────────────────────────────────────────────────────────────
  // Two candidates, and the LOWER wins. A stop tucked just under a swing low is
  // where the idea is genuinely wrong; an ATR stop is where ordinary noise
  // ends. Taking the further of the two avoids being stopped out by a normal
  // day, at the cost of a smaller position — which is the correct trade.
  const atrStop = entry - atrStopMult * atr;
  const structureStop = m.supportRecent !== null ? Math.min(m.supportRecent, m.low20) * 0.995 : m.low20 * 0.995;
  const wider = Math.min(atrStop, structureStop);
  // …but never wider than the horizon tolerates. A swing low eleven percent
  // away is a fine stop for a two-year hold and a nonsense one for a
  // three-day trade, so past the cap the ATR stop is used instead.
  const floorByCap = entry * (1 - spec.maxStopPct / 100);
  const capped = wider < floorByCap;
  const stopRaw = capped ? Math.max(floorByCap, atrStop) : wider;
  const stop = roundToTick(stopRaw, 'down');
  if (stop <= 0 || stop >= entry) return null;

  const stopNote = capped
    ? `Capped at ${spec.maxStopPct}% below entry. The nearest swing low sits ` +
      `${(((entry - structureStop) / entry) * 100).toFixed(1)}% away, too far to risk on a ` +
      `${holdLabel(spec)} idea, so the ATR stop is used instead.`
    : atrStop <= structureStop
      ? `${atrStopMult.toFixed(2).replace(/\.?0+$/, '')}× ATR below entry. ATR is ₹${atr.toFixed(2)} ` +
        `(${(m.atrPct ?? 0).toFixed(1)}% of price), so this is roughly a normal ` +
        `${atrStopMult.toFixed(1)}-day move.` +
        (widened
          ? ` Widened from ${spec.atrStopMult}× because this stock's ordinary drawdown would ` +
            `otherwise reach the stop — see the path forecast.`
          : '')
      : `Just under the recent swing low of ₹${(m.supportRecent ?? m.low20).toFixed(2)}. Below that the setup is broken, not merely noisy.`;
  if (capped) {
    warnings.push(`Structure sits below the ${spec.maxStopPct}% stop cap — the level that would truly invalidate this is further away`);
  }

  const riskPerShare = entry - stop;
  const stopDistancePct = (riskPerShare / entry) * 100;

  // ── target ───────────────────────────────────────────────────────────────
  // Reward:risk first, then sanity-checked against the 52-week high: a target
  // that sails past a level the stock has not seen in a year is arithmetic, not
  // analysis, so it is flagged rather than silently trusted.
  const target = roundToTick(entry + spec.rewardRisk * riskPerShare, 'up');
  let targetNote =
    `${spec.rewardRisk}× the risk taken. Risking ₹${riskPerShare.toFixed(2)} a share to make ` +
    `₹${(target - entry).toFixed(2)}.`;
  if (target > m.high52w) {
    targetNote += ` This is above the 52-week high of ₹${m.high52w.toFixed(2)} — it needs a new high to get there.`;
    warnings.push('Target sits above the 52-week high');
  } else if (m.resistanceRecent !== null && m.resistanceRecent < target) {
    targetNote += ` Expect resistance near ₹${m.resistanceRecent.toFixed(2)} on the way.`;
  }

  // ── size ─────────────────────────────────────────────────────────────────
  const riskBudget = (sizing.capital * sizing.riskPerTradePct) / 100;
  const byRisk = Math.floor(riskBudget / riskPerShare);
  const byPosition = Math.floor((sizing.capital * sizing.maxPositionPct) / 100 / entry);
  const byLiquidity = m.medianTurnover > 0
    ? Math.floor((m.medianTurnover * sizing.maxTurnoverPct) / 100 / entry)
    : byRisk;

  const quantity = Math.max(0, Math.min(byRisk, byPosition, byLiquidity));
  const amount = quantity * entry;

  let sizedBy: TradePlan['sizedBy'] = 'risk budget';
  if (quantity === byLiquidity && byLiquidity < byRisk && byLiquidity < byPosition) sizedBy = 'liquidity cap';
  else if (quantity === byPosition && byPosition < byRisk) sizedBy = 'position cap';
  if (amount < sizing.minPositionValue) sizedBy = 'too small to trade';

  if (sizedBy === 'liquidity cap') {
    warnings.push(`Thinly traded: capped at ${sizing.maxTurnoverPct}% of its ₹${Math.round(m.medianTurnover).toLocaleString('en-IN')} median daily turnover`);
  }
  if (sizedBy === 'too small to trade') {
    warnings.push(`A ₹${Math.round(amount).toLocaleString('en-IN')} position is below the ₹${sizing.minPositionValue.toLocaleString('en-IN')} floor where flat charges stop mattering`);
  }
  if (stopDistancePct > 25) {
    warnings.push(`The stop is ${stopDistancePct.toFixed(0)}% away — this is a volatile name and the position is correspondingly small`);
  }
  if ((m.atrPct ?? 0) > 6) warnings.push(`Daily range averages ${(m.atrPct ?? 0).toFixed(1)}% — expect a bumpy hold`);

  return {
    horizon: spec.horizon,
    entry,
    entryKind,
    entryNote,
    stop,
    stopNote,
    target,
    targetNote,
    riskPerShare,
    stopDistancePct,
    rewardRisk: spec.rewardRisk,
    quantity,
    amount,
    pctOfCapital: sizing.capital > 0 ? (amount / sizing.capital) * 100 : 0,
    riskAmount: quantity * riskPerShare,
    rewardAmount: quantity * (target - entry),
    sizedBy,
    holdLabel: holdLabel(spec),
    warnings,
  };
}
