/**
 * Daily history for foreign indices, currencies and stocks, from Yahoo.
 *
 * These tickers are fetched RAW (no `yahooSymbol` mapping): that helper turns
 * any bare symbol into an NSE one ("AAPL" → "AAPL.NS"), which is right for the
 * rest of the app and wrong here. Same disk-cache scheme as Market Weather:
 * `.cache/global/`, refreshed incrementally once older than the TTL, and the
 * cached copy kept when a refresh fails. Closes are Yahoo's price closes, so
 * returns exclude dividends (a 1–3% a year understatement for most markets).
 */
import fs from 'node:fs';
import path from 'node:path';
import { cleanDailyBars } from '../barCleaning';
import { parseYahooChart } from '../yahoo';
import { logger } from '../../utils/logger';
import { mergeSeries } from '../marketWeather/data';
import { fromCandles, type Series } from '../marketWeather/series';

export const GLOBAL_CACHE_DIR = path.join(process.cwd(), '.cache', 'global');
const TTL_MS = 12 * 3_600_000;
const OVERLAP_DAYS = 21;
const START = Date.parse('2003-01-01T00:00:00Z');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const file = (ticker: string): string => path.join(GLOBAL_CACHE_DIR, `${ticker.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

interface CacheFile {
  fetchedAt: number;
  dates: string[];
  close: number[];
}

async function fetchRaw(ticker: string, fromMs: number): Promise<Series | null> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?period1=${Math.floor(fromMs / 1000)}&period2=${Math.floor(Date.now() / 1000)}&interval=1d`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const chart = parseYahooChart(await res.json(), ticker);
    if (!chart.candles.length) return null;
    return fromCandles(ticker, cleanDailyBars(chart.candles));
  } catch (e) {
    logger.warn(`global ${ticker}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** One ticker, from cache when fresh, else refreshed. Null only if it has never loaded. */
export async function loadRaw(ticker: string, opts: { force?: boolean; now?: number } = {}): Promise<Series | null> {
  const now = opts.now ?? Date.now();
  let cached: CacheFile | null = null;
  try {
    cached = JSON.parse(fs.readFileSync(file(ticker), 'utf8')) as CacheFile;
  } catch {
    cached = null;
  }
  const cs: Series | null = cached ? { key: ticker, dates: cached.dates, close: cached.close } : null;
  if (cached && !opts.force && now - cached.fetchedAt < TTL_MS) return cs;
  const last = cached?.dates[cached.dates.length - 1];
  const from = last ? Date.parse(`${last}T00:00:00Z`) - OVERLAP_DAYS * 86_400_000 : START;
  const fresh = await fetchRaw(ticker, from);
  if (!fresh) return cs;
  const merged = mergeSeries(ticker, cs, fresh);
  try {
    fs.mkdirSync(GLOBAL_CACHE_DIR, { recursive: true });
    fs.writeFileSync(file(ticker), JSON.stringify({ fetchedAt: now, dates: merged.dates, close: merged.close }));
  } catch (e) {
    logger.warn(`global cache write ${ticker}: ${e instanceof Error ? e.message : e}`);
  }
  return merged;
}

/** Many tickers, a few at a time. Missing ones are reported, never invented. */
export async function loadMany(tickers: string[], opts: { force?: boolean; concurrency?: number } = {}): Promise<{ series: Map<string, Series>; failed: string[] }> {
  const queue = [...new Set(tickers)];
  const series = new Map<string, Series>();
  const failed: string[] = [];
  const worker = async (): Promise<void> => {
    for (;;) {
      const t = queue.shift();
      if (!t) return;
      const s = await loadRaw(t, opts);
      if (s && s.dates.length) series.set(t, s);
      else failed.push(t);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 6 }, worker));
  return { series, failed };
}
