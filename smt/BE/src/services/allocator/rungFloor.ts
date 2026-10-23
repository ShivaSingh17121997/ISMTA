/**
 * The smallest rung worth buying, for one stock at its current price.
 *
 * The allocator's own pass keeps its fixed `minTranche` (₹16,000): with a
 * large pool it prefers few, large rungs. But a fixed floor refuses a small
 * account outright — ₹2,000 for a ₹1,700 stock is a perfectly good rung. What
 * actually makes a rung too small is cost: the DP charge is flat rupees per
 * sell, so on a tiny order it eats the profit target. So for amounts the user
 * sets by hand the floor is derived, per stock, from the same rule that guards
 * opening a book (validateBook): the target must clear 1.5× the round-trip
 * cost. The answer is the fewest whole shares that pass, never less than one.
 *
 * Every sell is still at or above the fee-inclusive breakeven whatever the
 * rung size; this floor only keeps a rung from being one where the broker
 * takes most of the profit.
 */
import { roundTripCostPct } from '../costs';

/** validateBook's margin: the target must clear the round trip this many times. */
export const COST_MARGIN = 1.5;

export interface RungFloor {
  /** Shares the smallest worthwhile rung buys. */
  shares: number;
  /** Rupees that rung costs. */
  perRung: number;
  /** New money a budget must add to fund it, after the reserve, rounded up to ₹100. */
  newCash: number;
  /** One line for the screen: why this is the minimum. */
  why: string;
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

export function rungFloor(
  price: number,
  targetPct: number,
  instrument: 'EQUITY' | 'ETF',
  reservePct: number,
  /** Never ask for more than this per rung; the allocator's own preference. */
  cap: number,
): RungFloor {
  if (!(price > 0)) {
    // No price yet (a new book before its first quote): fall back to the cap.
    return { shares: 0, perRung: cap, newCash: roundUp(cap / (1 - reservePct / 100)), why: 'no price for this stock yet' };
  }
  const ctx = { product: 'CNC' as const, instrument };
  const passes = (q: number) => targetPct >= COST_MARGIN * roundTripCostPct(price, q, ctx);
  // Cost % only falls as the order grows, so the first passing count is the answer.
  let shares = 1;
  while (!passes(shares) && (shares + 1) * price <= cap) shares++;
  const perRung = shares * price;
  const why =
    shares === 1
      ? `one share costs about ${inr(price)}`
      : `${shares} shares at about ${inr(price)}, so the ${targetPct}% target clears ${COST_MARGIN}× the round-trip cost (DP charge, STT, stamp)`;
  return { shares, perRung, newCash: roundUp(perRung / (1 - reservePct / 100)), why };
}

function roundUp(n: number): number {
  return Math.ceil(n / 100) * 100;
}
