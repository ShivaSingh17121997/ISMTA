/**
 * Loads everything Market Weather reads and prepares it on an index axis.
 * Shared by the calibration script and the live service so both see exactly
 * the same inputs.
 */
import { loadSectors } from '../recommender/sectors';
import { logger } from '../../utils/logger';
import { computeBreadth, type BreadthRow } from './breadth';
import { loadGauges, loadStocks, type GaugeSeries } from './data';
import { prepare, type Prepared } from './regime';
import type { Series } from './series';

export interface MarketHistory {
  gauges: GaugeSeries;
  stocks: Map<string, Series>;
  /** NSE industry per NIFTY 500 symbol. */
  sectors: Map<string, string>;
  failedStocks: string[];
  loadedAt: number;
}

export async function loadMarketHistory(
  opts: { force?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<MarketHistory> {
  const gauges = await loadGauges({ force: opts.force });
  const sectors = await loadSectors();
  const { series, failed } = await loadStocks([...sectors.keys()], { force: opts.force, onProgress: opts.onProgress });
  if (failed.length) logger.info(`market-weather: ${failed.length} of ${sectors.size} NIFTY 500 histories unavailable`);
  return { gauges, stocks: series, sectors, failedStocks: failed, loadedAt: Date.now() };
}

export interface PreparedIndex {
  prepared: Prepared;
  breadth: BreadthRow[];
}

/** Breadth and every gauge aligned onto one index's trading days. */
export function prepareIndex(h: MarketHistory, key: 'nifty' | 'sensex'): PreparedIndex | null {
  const index = h.gauges[key];
  if (!index || index.dates.length < 300) return null;
  const breadth = computeBreadth(index.dates, h.stocks.values(), undefined, (k) => h.sectors.get(k.replace(/^stk_/, '')));
  return { prepared: prepare(index, h.gauges, breadth), breadth };
}
