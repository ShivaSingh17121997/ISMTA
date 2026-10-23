/**
 * Accumulator maths: net breakeven, sell targets, ladder geometry, quantization.
 *
 * PURE. Prices in, numbers out — no clock, no broker, no I/O. That is what lets
 * the same code run in the live engine and in a backtest.
 *
 * The breakeven is solved against `services/costs.ts` directly rather than
 * against a private copy of the fee schedule. There is one cost model in this
 * codebase and this uses it, so a rate correction lands here automatically.
 */

import { charges, dpChargeInclGst } from '../costs';
import { roundToTick } from '../nse';
import type { AccumulatorInstrument, AccumulatorParams, Epoch } from './types';

/** Absolute rupee tolerance for float comparison only — not a profit allowance. */
export const MONEY_EPSILON = 1e-6;

export interface CostShape {
  instrument: AccumulatorInstrument;
}

/** Net rupees received from selling `quantity` at `price`, delivery charges deducted. */
export function netProceeds(quantity: number, price: number, shape: CostShape): number {
  const turnover = quantity * price;
  return turnover - charges('SELL', price, quantity, { product: 'CNC', instrument: shape.instrument }).total;
}

/** Total rupees leaving the account to buy `quantity` at `price`. */
export function grossCost(quantity: number, price: number, shape: CostShape): number {
  const turnover = quantity * price;
  return turnover + charges('BUY', price, quantity, { product: 'CNC', instrument: shape.instrument }).total;
}

/**
 * The price at or above which a lot may be sold: the floor below which the
 * engine refuses to trade.
 *
 * Solved by fixed-point iteration rather than a closed form, because the charge
 * schedule is not linear in price — brokerage is `min(0.03%, ₹20)`, so the fee
 * rate itself moves with the notional, and the DP charge is a flat rupee amount
 * that no percentage can express. Omitting that flat term is the classic error:
 * on a ₹1,000 lot it is 1.59%, larger than a 1% take-profit, so a
 * percentage-only breakeven books "profits" that are losses on the contract note.
 *
 * Converges in a handful of passes; the guard afterwards makes a float artefact
 * incapable of returning a floor that does not actually clear cost.
 */
export function netBreakeven(
  quoteSpent: number,
  quantity: number,
  shape: CostShape,
  slippageBufferPct = 0,
): number {
  if (!(quantity > 0) || !(quoteSpent > 0)) {
    throw new Error(`netBreakeven needs positive quantity and quoteSpent, got ${quantity}/${quoteSpent}`);
  }

  let price = quoteSpent / quantity;
  for (let i = 0; i < 24; i++) {
    const fees = charges('SELL', price, quantity, {
      product: 'CNC',
      instrument: shape.instrument,
    }).total;
    const next = (quoteSpent + fees) / quantity;
    if (Math.abs(next - price) <= 1e-9) {
      price = next;
      break;
    }
    price = next;
  }

  // Belt and braces: nudge up by exactly the shortfall until proceeds clear
  // cost. No fixed minimum step — that would overshoot and stop the floor being
  // the true breakeven.
  for (let guard = 0; guard < 64; guard++) {
    const shortfall = quoteSpent - netProceeds(quantity, price, shape);
    if (shortfall <= 0) break;
    price += shortfall / quantity;
  }

  return price * (1 + slippageBufferPct / 100);
}

/** Whole shares affordable at a price. Always rounds DOWN; the remainder stays as cash. */
export function sharesFor(rupees: number, price: number): number {
  if (!(price > 0) || !(rupees > 0)) return 0;
  return Math.floor(rupees / price);
}

/**
 * The resting sell target for a lot: breakeven plus the profit target, rounded
 * UP to the NSE tick for that price band, and hard-clamped so it can never sit
 * below breakeven whatever a caller asks for.
 *
 * UP, always. Rounding a target down undercuts breakeven, and undercutting
 * breakeven is the one thing this engine exists not to do.
 */
export function sellTarget(breakeven: number, targetPct: number): number {
  const raw = breakeven * (1 + Math.max(targetPct, 0) / 100);
  return Math.max(roundToTick(raw, 'up'), roundToTick(breakeven, 'up'));
}

/**
 * Ladder rung prices. Gaps COMPOUND on the running price, not on the anchor:
 *
 *   levels[k] = anchor × Π (1 − stepPct/100 × stepGrowth^i) for i in [0, k)
 *
 * At the defaults (6%, ×1.15, 12 rungs) the last rung sits near 20% of the
 * anchor — roughly −80%. Adding the gaps instead of compounding them would sum
 * past 100% and is simply wrong.
 */
export function ladderLevels(
  anchorPrice: number,
  tranches: number,
  stepPct: number,
  stepGrowth: number,
): number[] {
  if (!(anchorPrice > 0)) throw new Error(`anchorPrice must be positive, got ${anchorPrice}`);
  if (!Number.isInteger(tranches) || tranches < 1) {
    throw new Error(`tranches must be a positive integer, got ${tranches}`);
  }
  if (!(stepPct > 0 && stepPct < 100)) throw new Error(`stepPct must be in (0,100), got ${stepPct}`);
  if (!(stepGrowth >= 1)) throw new Error(`stepGrowth must be >= 1, got ${stepGrowth}`);

  const levels = [anchorPrice];
  let price = anchorPrice;
  for (let i = 0; i < tranches - 1; i++) {
    const gap = (stepPct / 100) * Math.pow(stepGrowth, i);
    if (gap >= 1) {
      throw new Error(
        `Ladder gap ${(gap * 100).toFixed(2)}% at rung ${i + 1} reaches zero — ` +
          `reduce stepPct/stepGrowth/tranches`,
      );
    }
    price *= 1 - gap;
    levels.push(price);
  }
  return levels;
}

/**
 * The start gate: price must be at least `startDiscountPct` below the rolling
 * high. This is what stops the engine anchoring a ladder at a high, which is the
 * single most expensive thing it can do — an anchor at the top is what turns
 * "hold until above breakeven" into a multi-year lock-up.
 */
export function startGatePasses(price: number, rollingHigh: number, discountPct: number): boolean {
  if (!(price > 0) || !(rollingHigh > 0)) return false;
  return price <= rollingHigh * (1 - discountPct / 100);
}

/**
 * The next rung to buy, or null.
 *
 * When price gaps through several unfilled rungs at once we take the SHALLOWEST
 * one and fill it at the current, lower price: no tranche is lost to the gap,
 * the fill is never worse than the rung it is booked against, and the buy brake
 * paces the rest of the cascade.
 */
export function nextLevelToBuy(epoch: Epoch, price: number): number | null {
  const filled = new Set(epoch.filledLevels);
  for (let k = 0; k < epoch.levels.length; k++) {
    if (filled.has(k)) continue;
    if (price <= epoch.levels[k]) return k;
    return null; // price is above this unfilled rung; nothing deeper is crossed
  }
  return null;
}

/**
 * Daily volatility, percent: standard deviation of the last `n` daily log
 * returns. Undefined with fewer than 20 returns.
 */
export function dailyVolPct(closes: number[], n = 60): number | undefined {
  const tail = closes.filter((c) => c > 0).slice(-(n + 1));
  if (tail.length < 21) return undefined;
  const rets = tail.slice(1).map((c, i) => Math.log(c / tail[i]));
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * 100;
}

/** Rung gap, percent, for a stock with this daily volatility. */
export function volStepPct(volPct: number, cfg: { k: number; minPct: number; maxPct: number }): number {
  return Math.min(cfg.maxPct, Math.max(cfg.minPct, cfg.k * volPct * Math.sqrt(20)));
}

/** Rupees per tranche once the untouchable reserve is set aside. */
export function trancheSize(budget: number, params: AccumulatorParams): number {
  return (budget * (1 - params.reservePct / 100)) / params.tranches;
}

/** The DP charge as a percentage of a tranche — the dust-gate metric. */
export function dpImpactPct(tranche: number): number {
  if (!(tranche > 0)) return Infinity;
  return (dpChargeInclGst() / tranche) * 100;
}
