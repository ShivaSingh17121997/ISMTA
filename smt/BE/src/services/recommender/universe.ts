/**
 * The universe of stocks the recommender considers.
 *
 * NOT all 2,571 listed companies. Three reasons, in order of importance:
 *
 *   1. Ranking is only meaningful against a comparable peer group. Scoring a
 *      ₹500-crore microcap against Reliance on the same percentile scale
 *      produces a number, but not a comparison.
 *   2. Most of the list fails the liquidity floor anyway, so scoring it is
 *      work whose only output is a veto.
 *   3. Yahoo is an unofficial feed with no SLA. Two thousand daily-bar
 *      requests would be abusive and would be rate-limited long before it
 *      finished.
 *
 * So the default is the large- and mid-cap names that carry most of the NSE's
 * traded value, plus whatever the user already holds a book on. The list is a
 * starting point, not a claim about index membership — it is not rebalanced,
 * and index composition changes. `?symbols=` overrides it entirely.
 */

import { store } from '../../store/memoryStore';

/**
 * Liquid NSE names, broadly the large-cap complex plus well-traded mid-caps.
 * Hand-maintained: nothing in this codebase subscribes to index membership.
 */
export const DEFAULT_UNIVERSE: string[] = [
  // Banks and financials
  'HDFCBANK', 'ICICIBANK', 'SBIN', 'AXISBANK', 'KOTAKBANK', 'INDUSINDBK',
  'BAJFINANCE', 'BAJAJFINSV', 'SHRIRAMFIN', 'HDFCLIFE', 'SBILIFE', 'ICICIGI',
  'PFC', 'RECLTD', 'CHOLAFIN', 'MUTHOOTFIN',
  // Technology
  'TCS', 'INFY', 'HCLTECH', 'WIPRO', 'TECHM', 'LTIM', 'PERSISTENT', 'COFORGE',
  // Energy, utilities and materials
  'RELIANCE', 'ONGC', 'NTPC', 'POWERGRID', 'COALINDIA', 'BPCL', 'IOC', 'GAIL',
  'TATAPOWER', 'ADANIPOWER', 'OIL', 'NHPC',
  // Industrials and infrastructure
  'LT', 'SIEMENS', 'ABB', 'BEL', 'HAL', 'CUMMINSIND', 'THERMAX', 'BHEL',
  'ADANIPORTS', 'ADANIENT',
  // Metals and cement
  'TATASTEEL', 'JSWSTEEL', 'HINDALCO', 'VEDL', 'JINDALSTEL', 'ULTRACEMCO',
  'GRASIM', 'SHREECEM', 'AMBUJACEM',
  // Consumer
  'HINDUNILVR', 'ITC', 'NESTLEIND', 'BRITANNIA', 'TATACONSUM', 'DABUR',
  'GODREJCP', 'MARICO', 'TITAN', 'ASIANPAINT', 'PIDILITIND', 'TRENT',
  // Autos
  'MARUTI', 'M&M', 'BAJAJ-AUTO', 'HEROMOTOCO', 'EICHERMOT', 'TVSMOTOR',
  'ASHOKLEY', 'BOSCHLTD',
  // Pharma and healthcare
  'SUNPHARMA', 'DRREDDY', 'CIPLA', 'DIVISLAB', 'APOLLOHOSP', 'LUPIN',
  'AUROPHARMA', 'TORNTPHARM',
  // Telecom and media
  'BHARTIARTL', 'IDEA',
  // Chemicals and other
  'UPL', 'SRF', 'PIIND', 'DEEPAKNTR', 'COROMANDEL',
];

/**
 * The symbols to score: the default list plus every book the user already has,
 * so a stock they are trading is never missing from its own recommendation.
 */
export function resolveUniverse(userId: string, override?: string[]): string[] {
  if (override?.length) return dedupe(override.map((s) => s.trim().toUpperCase()).filter(Boolean));
  const owned = store.accumulatorBooksByUser(userId).map((b) => b.symbol);
  return dedupe([...DEFAULT_UNIVERSE, ...owned]);
}

const dedupe = (xs: string[]): string[] => [...new Set(xs)];
