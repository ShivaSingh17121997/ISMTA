/**
 * NSE intraday-equity (MIS) cost model — spec Phase 4's cost floor and Phase
 * 7/10's fee accounting, adapted for India.
 *
 * The NTB spec assumes a single symmetric `feeRate` (0.1% both sides — Binance
 * taker). That cannot express Indian charges, which are ASYMMETRIC:
 *
 *   - STT          0.025%  SELL side only
 *   - Stamp duty   0.003%  BUY side only
 *   - Brokerage    0.03% capped at ₹20 per order → cost % FALLS as notional rises
 *   - GST          18% on (brokerage + txn + SEBI), not on turnover
 *
 * So the round-trip cost is a function of notional, not a constant. On a ₹30,000
 * round trip it lands near 0.10%; on a ₹3,000 one the ₹20 brokerage floor alone
 * makes it ~1.4%, which eats any small take-profit alive.
 *
 * Rates default to Zerodha's published intraday schedule and are all overridable
 * from env — verify them against your own broker before trading.
 */
import { config } from '../config';
import { OrderSide, ProductType } from '../types';
import { logger } from '../utils/logger';

export interface ChargeBreakdown {
  brokerage: number;
  stt: number;
  exchangeTxn: number;
  gst: number;
  sebi: number;
  stampDuty: number;
  /** Flat depository charge on a CNC sell. Always 0 intraday. */
  dpCharge: number;
  total: number;
}

/**
 * What is being traded, for the charges that differ by product and instrument.
 * Omitted entirely, this behaves exactly as it did before: intraday equity.
 */
export interface CostContext {
  /** 'MIS' (default) uses the intraday schedule; 'CNC' the delivery one. */
  product?: ProductType;
  /**
   * An equity ETF pays 0.001% STT on the SELL leg only, against 0.1% on BOTH
   * legs for a delivery stock — a ~10x difference in round-trip cost, and the
   * concrete reason an index ETF is the natural vehicle for a hold-for-years
   * strategy.
   */
  instrument?: 'EQUITY' | 'ETF';
}

/** Statutory + broker charges for ONE leg. Never negative. */
export function charges(
  side: OrderSide,
  price: number,
  quantity: number,
  ctx: CostContext = {},
): ChargeBreakdown {
  const c = config.costs;
  const turnover = Math.abs(price * quantity);
  const zero: ChargeBreakdown = {
    brokerage: 0, stt: 0, exchangeTxn: 0, gst: 0, sebi: 0, stampDuty: 0, dpCharge: 0, total: 0,
  };
  if (!Number.isFinite(turnover) || turnover <= 0) return zero;

  const delivery = ctx.product === 'CNC';
  const etf = ctx.instrument === 'ETF';

  // A percentage or a flat cap per executed order, whichever is LOWER — and
  // delivery is its own schedule, not the intraday one. Zerodha charges nothing
  // on delivery; Groww charges 0.1% capped at ₹20. Getting this wrong moves
  // every breakeven the no-loss rule is enforced against.
  const brokerage = delivery
    ? Math.min((turnover * c.brokerageDeliveryPct) / 100, c.brokerageDeliveryCap)
    : Math.min((turnover * c.brokeragePct) / 100, c.brokerageCap);

  // STT: intraday is sell-only; delivery equity is BOTH legs; an ETF is
  // sell-only at a tenth of the delivery-equity rate.
  let sttPct = 0;
  if (delivery) {
    if (etf) sttPct = side === 'SELL' ? c.sttEtfSellPct : 0;
    else sttPct = c.sttDeliveryPct;
  } else if (side === 'SELL') {
    sttPct = c.sttPct;
  }
  const stt = (turnover * sttPct) / 100;

  const exchangeTxn = (turnover * c.exchangeTxnPct) / 100;
  const sebi = (turnover * c.sebiPct) / 100;
  const stampDuty =
    side === 'BUY'
      ? (turnover * (delivery ? c.stampDutyDeliveryPct : c.stampDutyPct)) / 100
      : 0;

  // The demat debit. Flat rupees per scrip per sell day, delivery only — no
  // percentage can represent it, which is why it is carried separately.
  const dpCharge = delivery && side === 'SELL' ? c.dpChargePerSell : 0;

  // GST applies to the SERVICE components only — not to turnover, STT or stamp
  // duty. The DP charge IS a service, so it attracts GST.
  const gst = ((brokerage + exchangeTxn + sebi + dpCharge) * c.gstPct) / 100;

  const total = brokerage + stt + exchangeTxn + gst + sebi + stampDuty + dpCharge;
  return { brokerage, stt, exchangeTxn, gst, sebi, stampDuty, dpCharge, total };
}

/** Total charges for a complete round trip at a given price and size. */
export function roundTripCharges(price: number, quantity: number, ctx: CostContext = {}): number {
  return charges('BUY', price, quantity, ctx).total + charges('SELL', price, quantity, ctx).total;
}

/** The DP charge including GST — the flat rupee term a CNC breakeven must carry. */
export function dpChargeInclGst(): number {
  return config.costs.dpChargePerSell * (1 + config.costs.gstPct / 100);
}

/**
 * What the broker charges when IT squares off an MIS position you left open past
 * 15:25 — ₹50 + 18% GST ≈ ₹59 at Zerodha.
 *
 * That is roughly 3x the ₹20 brokerage, and it is pure waste: you also surrender
 * the exit price, so the trailing stop you built never gets to fire. The session
 * watchdog exists to never pay this. The backtester charges it too, so a strategy
 * that habitually overstays is penalised in the numbers rather than in your
 * account.
 */
export function autoSquareOffCharge(): number {
  return config.costs.autoSquareOffFee * (1 + config.costs.gstPct / 100);
}

/**
 * Round-trip cost as a % of notional, INCLUDING slippage on both legs.
 * This is the number a stop distance must clear (spec Phase 4).
 */
export function roundTripCostPct(
  price: number,
  quantity: number,
  ctx: CostContext = {},
): number {
  const turnover = Math.abs(price * quantity);
  if (turnover <= 0) return 0;
  const feePct = (roundTripCharges(price, quantity, ctx) / turnover) * 100;
  const slipPct = 2 * (config.costs.slippageBps / 100); // both legs
  return feePct + slipPct;
}

/**
 * Spec Phase 4: a stop tighter than the round-trip cost stops out on fees and
 * slippage alone. Warn below 1.5x.
 *
 * Returns true when the stop clears the floor. Callers may still proceed — this
 * warns rather than blocks, because the right notional can bring the cost % down.
 */
export function checkStopAgainstCostFloor(
  symbol: string,
  stopPct: number,
  price: number,
  quantity: number,
): boolean {
  const cost = roundTripCostPct(price, quantity);
  const floor = 1.5 * cost;
  if (stopPct > 0 && stopPct < floor) {
    logger.warn(
      `${symbol}: stop ${stopPct.toFixed(2)}% is below the cost floor ${floor.toFixed(2)}% ` +
        `(round-trip cost ${cost.toFixed(2)}% at ₹${Math.round(price * quantity)} notional) — ` +
        `this trade stops out on fees alone`,
    );
    return false;
  }
  return true;
}

/** Apply slippage so it always works AGAINST the trader (spec Phase 7). */
export function applySlippage(price: number, side: OrderSide, action: 'open' | 'close'): number {
  const slip = config.costs.slippageBps / 10_000;
  const buying = (side === 'BUY' && action === 'open') || (side === 'SELL' && action === 'close');
  return buying ? price * (1 + slip) : price * (1 - slip);
}
