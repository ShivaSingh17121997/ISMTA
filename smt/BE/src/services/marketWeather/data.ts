/**
 * Market Weather data layer: daily history for the market gauges and for the
 * NIFTY 500 constituents (breadth, sector baskets, downside beta).
 *
 * Source is Yahoo's chart endpoint via `fetchYahooDailyHistory` — never
 * `range=max`, which returns MONTHLY bars. Bars go through `cleanDailyBars`, the
 * same cleaning the live engine uses.
 *
 * DISK CACHE. Breadth needs ~500 stock histories; refetching 25 years of each
 * on every boot would be ~100 MB and minutes of requests. Each series is kept
 * as JSON under `.cache/market-weather/` and refreshed incrementally: only the
 * last few weeks are fetched and merged once the cached copy is older than the
 * TTL. A failed refresh keeps the cached copy and says so — it never invents a
 * bar, and a series that has never loaded is simply absent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetchYahooDailyHistory } from '../yahoo';
import { cleanDailyBars } from '../barCleaning';
import { logger } from '../../utils/logger';
import { fromCandles, splice, type Series } from './series';

export const CACHE_DIR = path.join(process.cwd(), '.cache', 'market-weather');
/** Daily closes change once a day; six hours keeps a running server current without hammering Yahoo. */
const TTL_MS = 6 * 3_600_000;
/** How far back an incremental refresh refetches, to pick up revisions and gaps. */
const REFRESH_OVERLAP_DAYS = 21;
const HISTORY_START = Date.parse('1997-01-01T00:00:00Z');

/**
 * The gauges. `lag` = the market closes after NSE, so the engine must read its
 * PREVIOUS close on an Indian date (see series.ts).
 */
export const GAUGES = {
  nifty: { yahoo: '^NSEI', label: 'NIFTY 50', lag: false },
  sensex: { yahoo: '^BSESN', label: 'Sensex', lag: false },
  indiaVix: { yahoo: '^INDIAVIX', label: 'India VIX', lag: false },
  spx: { yahoo: '^GSPC', label: 'S&P 500', lag: true },
  usVix: { yahoo: '^VIX', label: 'US VIX', lag: true },
  brent: { yahoo: 'BZ=F', label: 'Brent crude', lag: true },
  usdinr: { yahoo: 'INR=X', label: 'USD/INR', lag: true },
  us10y: { yahoo: '^TNX', label: 'US 10-year yield', lag: true },
  us3m: { yahoo: '^IRX', label: 'US 3-month yield', lag: true },
  gold: { yahoo: 'GC=F', label: 'Gold', lag: true },
} as const;
export type GaugeKey = keyof typeof GAUGES;
/** Brent futures on Yahoo start in Aug 2007; WTI fills the years before. */
const WTI = 'CL=F';
const BRENT_START = '2007-08-01';

interface CacheFile {
  key: string;
  fetchedAt: number;
  dates: string[];
  close: number[];
}

function cachePath(key: string): string {
  return path.join(CACHE_DIR, `${key.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

function readCache(key: string): CacheFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(key), 'utf8')) as CacheFile;
    return Array.isArray(raw.dates) && raw.dates.length === raw.close.length ? raw : null;
  } catch {
    return null;
  }
}

function writeCache(c: CacheFile): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath(c.key), JSON.stringify(c));
  } catch (e) {
    logger.warn(`market-weather cache write ${c.key}: ${e instanceof Error ? e.message : e}`);
  }
}

/** Merge a fresh tail into a cached series: fresh values win on overlapping dates. Pure. */
export function mergeSeries(key: string, cached: Series | null, fresh: Series): Series {
  if (!cached) return fresh;
  const m = new Map<string, number>();
  cached.dates.forEach((d, i) => m.set(d, cached.close[i]));
  fresh.dates.forEach((d, i) => m.set(d, fresh.close[i]));
  const dates = [...m.keys()].sort();
  return { key, dates, close: dates.map((d) => m.get(d)!) };
}

async function fetchRange(yahoo: string, key: string, fromMs: number): Promise<Series | null> {
  const chart = await fetchYahooDailyHistory(yahoo, fromMs, Date.now(), 30_000);
  if (!chart || !chart.candles.length) return null;
  return fromCandles(key, cleanDailyBars(chart.candles));
}

/**
 * One series, from cache when fresh, else refreshed. `force` skips the TTL.
 * Returns null only when nothing has ever loaded.
 */
export async function loadSeries(key: string, yahoo: string, opts: { force?: boolean; now?: number } = {}): Promise<Series | null> {
  const now = opts.now ?? Date.now();
  const cached = readCache(key);
  const cachedSeries: Series | null = cached ? { key, dates: cached.dates, close: cached.close } : null;
  if (cached && !opts.force && now - cached.fetchedAt < TTL_MS) return cachedSeries;

  const last = cached?.dates[cached.dates.length - 1];
  const from = last ? Date.parse(`${last}T00:00:00Z`) - REFRESH_OVERLAP_DAYS * 86_400_000 : HISTORY_START;
  const fresh = await fetchRange(yahoo, key, from);
  if (!fresh) {
    if (cachedSeries) logger.warn(`market-weather: ${key} refresh failed, using cache to ${last}`);
    return cachedSeries;
  }
  const merged = mergeSeries(key, cachedSeries, fresh);
  writeCache({ key, fetchedAt: now, dates: merged.dates, close: merged.close });
  return merged;
}

export type GaugeSeries = Partial<Record<GaugeKey, Series>>;

/** All gauges. Brent is spliced onto WTI before Aug 2007 so the oil series reaches back to 1997. */
export async function loadGauges(opts: { force?: boolean } = {}): Promise<GaugeSeries> {
  const out: GaugeSeries = {};
  for (const [key, g] of Object.entries(GAUGES) as [GaugeKey, (typeof GAUGES)[GaugeKey]][]) {
    const s = await loadSeries(key, g.yahoo, opts);
    if (s) out[key] = s;
  }
  const wti = await loadSeries('wti', WTI, opts);
  if (out.brent && wti) out.brent = splice('brent', wti, out.brent, BRENT_START);
  return out;
}

/**
 * Stock closes for breadth and baskets, several at a time. Symbols that fail
 * are reported, not retried in a loop — breadth states its coverage instead.
 */
export async function loadStocks(
  symbols: string[],
  opts: { force?: boolean; concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ series: Map<string, Series>; failed: string[] }> {
  const series = new Map<string, Series>();
  const failed: string[] = [];
  const queue = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const total = queue.length;
  let done = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const sym = queue.shift();
      if (!sym) return;
      const s = await loadSeries(`stk_${sym}`, `${sym}.NS`, opts);
      if (s && s.dates.length) series.set(sym, s);
      else failed.push(sym);
      opts.onProgress?.(++done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 6) }, worker));
  return { series, failed };
}
