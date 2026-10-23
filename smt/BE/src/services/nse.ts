/**
 * NSE market microstructure — tick sizes and price bands.
 *
 * Pure and config-free so it can be used from the strategy engine, the broker
 * adapters and the backtester alike.
 *
 * Sources (verified July 2026):
 *  - Tick size ladder, effective 2025-04-15 (NSE circular; stocks and stock futures)
 *  - Price bands: 20% for most scrips, dynamic 10% operating range for F&O-eligible
 */

/**
 * Minimum price increment for a stock at `price`.
 *
 * This is a LADDER, not a flat ₹0.05 — NSE revised it on 2025-04-15. It matters
 * more than it looks: a stop computed as `entry * (1 - stopPct/100)` almost never
 * lands on the grid, and NSE REJECTS an order whose price is not a valid tick.
 * At ₹5,000+ the tick is ₹0.50, so the grid also quantises how tight a stop can
 * actually be.
 *
 * Boundaries follow the circular: the band a price falls into is `lower <= p < upper`.
 */
export function tickSize(price: number): number {
  const p = Math.abs(price);
  if (p < 250) return 0.01;
  if (p < 1_000) return 0.05;
  if (p < 5_000) return 0.1;
  if (p < 10_000) return 0.5;
  if (p < 20_000) return 1;
  return 5;
}

export type TickRounding = 'nearest' | 'up' | 'down';

/**
 * Snap a price onto the NSE tick grid.
 *
 * @param mode `nearest` for fills and generic prices; `down`/`up` when the
 *   direction must be conservative (e.g. a long's stop rounds DOWN so rounding
 *   can never tighten a stop into an earlier exit than intended).
 */
export function roundToTick(price: number, mode: TickRounding = 'nearest'): number {
  if (!Number.isFinite(price) || price <= 0) return price;
  const tick = tickSize(price);
  const units = price / tick;
  const snapped =
    mode === 'up' ? Math.ceil(units) : mode === 'down' ? Math.floor(units) : Math.round(units);
  // Ticks are 2dp at their finest (₹0.01), so this kills float dust like 99.49000000000001.
  return Math.round(snapped * tick * 100) / 100;
}

/**
 * Round a protection level so rounding never works against the trader:
 * a long's stop moves DOWN (wider), a short's stop moves UP (wider).
 * Rounding a stop the other way would fire it earlier than the configured
 * distance — a silent tightening of every stop in the system.
 */
export function roundStopToTick(price: number, side: 'BUY' | 'SELL'): number {
  return roundToTick(price, side === 'BUY' ? 'down' : 'up');
}

/**
 * Daily price band (%) either side of the reference price.
 *
 * F&O-eligible scrips have no fixed daily circuit; they run a dynamic 10%
 * operating range instead. Everything else is 20%. Some scrips sit at 2%/5%
 * surveillance bands — those are per-scrip exchange data we do not have here, so
 * this is a floor, not a guarantee.
 */
export function priceBandPct(fnoEligible: boolean): number {
  return fnoEligible ? 10 : 20;
}

/** Is `price` inside the band around `reference` (usually the previous close)? */
export function withinPriceBand(price: number, reference: number, fnoEligible: boolean): boolean {
  if (!(reference > 0)) return true; // no reference → cannot judge; don't block
  const band = priceBandPct(fnoEligible) / 100;
  return price >= reference * (1 - band) && price <= reference * (1 + band);
}

/**
 * F&O-eligible NSE symbols we care about.
 *
 * Matters for two things: the tighter 10% band, and the Closing Auction Session
 * (which applies ONLY to securities with active derivative contracts).
 *
 * This is a static subset covering the seeded universe. The real list changes
 * with each F&O review — override via NSE_FNO_SYMBOLS, and prefer the exchange's
 * instrument dump once KiteService can supply it.
 */
const FNO_DEFAULT = [
  'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN',
  'TATAMOTORS', 'WIPRO', 'AXISBANK', 'KOTAKBANK', 'ITC', 'LT',
  'BHARTIARTL', 'HINDUNILVR', 'MARUTI', 'ASIANPAINT', 'BAJFINANCE',
  'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY',
];

const fnoSet = new Set(
  (process.env.NSE_FNO_SYMBOLS
    ? process.env.NSE_FNO_SYMBOLS.split(',')
    : FNO_DEFAULT
  ).map((s) => s.trim().toUpperCase()).filter(Boolean),
);

export function isFnoEligible(symbol: string): boolean {
  return fnoSet.has(symbol.toUpperCase());
}
