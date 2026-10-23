/**
 * Position sizing — spec Phase 5.
 *
 * The whole point is the COUPLING: the `stopPct` fed in here is the same
 * per-trade value the position locks at entry (Phase 4), including an
 * ATR-derived one. A wider stop therefore automatically buys a smaller position,
 * so the RUPEE RISK PER TRADE STAYS CONSTANT regardless of volatility. Halving
 * the stop doubles the size.
 *
 * Break that coupling — e.g. by passing the config default while the position
 * uses an ATR stop — and risk-based sizing silently stops working. The spec calls
 * this out explicitly; it is the easiest thing to get wrong in a port.
 *
 * NSE ADAPTATION: NTB computes `qty = quoteAmount / fill`, which yields
 * fractional coins. Equities are integers, so we floor — and flooring can round
 * a small notional to ZERO shares, which we surface as a rejection reason rather
 * than silently placing a 0-quantity order.
 */
import { config } from '../config';

export interface SizingInput {
  price: number;
  /** the position's locked stop distance %, NOT the config default */
  stopPct: number;
  /** fallback notional when risk-based sizing is off */
  fixedQuote: number;
  /** > 0 enables risk-based sizing */
  riskPerTradePct: number;
  /** capital the risk % is measured against */
  referenceBalance: number;
  /** hard cap on notional; 0 = off */
  maxPositionQuote: number;
}

export interface SizingResult {
  quantity: number;
  notional: number;
  /** how the size was arrived at — surfaced in logs and the signal record */
  basis: 'risk' | 'fixed';
  reason?: string;
}

export function sizePosition(input: SizingInput): SizingResult {
  const { price, stopPct, fixedQuote, riskPerTradePct, referenceBalance, maxPositionQuote } = input;

  if (!(price > 0)) {
    return { quantity: 0, notional: 0, basis: 'fixed', reason: 'no valid price' };
  }

  let notional = fixedQuote;
  let basis: 'risk' | 'fixed' = 'fixed';

  // All three guards are required. A zero stop would make the division
  // meaningless, so we fall back to fixed sizing rather than divide by it.
  if (riskPerTradePct > 0 && stopPct > 0 && referenceBalance > 0) {
    const riskAmount = (referenceBalance * riskPerTradePct) / 100;
    notional = riskAmount / (stopPct / 100);
    basis = 'risk';
  }

  if (maxPositionQuote > 0) notional = Math.min(notional, maxPositionQuote);

  // NSE: whole shares only.
  const quantity = Math.max(0, Math.floor(notional / price));
  if (quantity < 1) {
    return {
      quantity: 0,
      notional: 0,
      basis,
      reason: `notional ₹${notional.toFixed(0)} buys 0 shares at ₹${price.toFixed(2)}`,
    };
  }

  return { quantity, notional: quantity * price, basis };
}

/**
 * Spec Phase 4: the stop distance locked in at entry.
 *
 * ATR mode widens the stop in volatile regimes and tightens it in calm ones,
 * which reduces whipsaw stop-outs. The result is stored ON THE POSITION and used
 * for that trade's entire life — changing config mid-trade must not move an open
 * position's stop.
 */
export function effectiveStopPct(atrValue: number | null, refPrice: number): number {
  if (config.ntb.stopMode === 'atr' && refPrice > 0 && atrValue != null && atrValue > 0) {
    return ((atrValue * config.ntb.atrStopMult) / refPrice) * 100;
  }
  return config.ntb.stopLossPct;
}
