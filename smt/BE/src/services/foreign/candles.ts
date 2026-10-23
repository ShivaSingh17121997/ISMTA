/**
 * Daily OHLCV bars for US-listed stocks, fetched RAW from Yahoo (no NSE symbol
 * mapping) and cached on disk under `.cache/foreign/bars/`, refreshed
 * incrementally. The recommender's `measure()` needs highs, lows and volume,
 * which is why this does not reuse the closes-only cache of Global Markets.
 *
 * Yahoo's `close` is split-adjusted but not dividend-adjusted: returns here are
 * price returns, a 1–2% a year understatement for dividend payers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { cleanDailyBars } from '../barCleaning';
import { parseYahooChart } from '../yahoo';
import { logger } from '../../utils/logger';
import type { Candle } from '../../types';

export const BARS_DIR = path.join(process.cwd(), '.cache', 'foreign', 'bars');
const TTL_MS = 12 * 3_600_000;
const START = Date.parse('2010-01-01T00:00:00Z');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

interface BarFile {
  fetchedAt: number;
  /** [timestamp, open, high, low, close, volume][] */
  bars: number[][];
}

const fileOf = (t: string): string => path.join(BARS_DIR, `${t.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

async function fetchBars(ticker: string, fromMs: number): Promise<Candle[] | null> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?period1=${Math.floor(fromMs / 1000)}&period2=${Math.floor(Date.now() / 1000)}&interval=1d`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const c = parseYahooChart(await res.json(), ticker);
    return c.candles.length ? cleanDailyBars(c.candles) : null;
  } catch (e) {
    logger.warn(`foreign bars ${ticker}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** Merge fresh bars into cached ones by timestamp, fresh winning. Pure. */
export function mergeBars(cached: Candle[], fresh: Candle[]): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of cached) m.set(c.timestamp, c);
  for (const c of fresh) m.set(c.timestamp, c);
  return [...m.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export async function loadBars(ticker: string, opts: { force?: boolean } = {}): Promise<Candle[] | null> {
  let cached: Candle[] = [];
  let fetchedAt = 0;
  try {
    const f = JSON.parse(fs.readFileSync(fileOf(ticker), 'utf8')) as BarFile;
    fetchedAt = f.fetchedAt;
    cached = f.bars.map(([timestamp, open, high, low, close, volume]) => ({ symbol: ticker, timestamp, open, high, low, close, volume }));
  } catch {
    cached = [];
  }
  if (cached.length && !opts.force && Date.now() - fetchedAt < TTL_MS) return cached;
  const from = cached.length ? cached[cached.length - 1].timestamp - 21 * 86_400_000 : START;
  const fresh = await fetchBars(ticker, from);
  if (!fresh) return cached.length ? cached : null;
  const merged = mergeBars(cached, fresh);
  try {
    fs.mkdirSync(BARS_DIR, { recursive: true });
    fs.writeFileSync(fileOf(ticker), JSON.stringify({ fetchedAt: Date.now(), bars: merged.map((c) => [c.timestamp, c.open, c.high, c.low, c.close, c.volume]) }));
  } catch (e) {
    logger.warn(`foreign bars cache ${ticker}: ${e instanceof Error ? e.message : e}`);
  }
  return merged;
}

export async function loadAllBars(
  tickers: string[],
  opts: { force?: boolean; concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ bars: Map<string, Candle[]>; failed: string[] }> {
  const queue = [...new Set(tickers)];
  const total = queue.length;
  const bars = new Map<string, Candle[]>();
  const failed: string[] = [];
  let done = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const t = queue.shift();
      if (!t) return;
      const b = await loadBars(t, opts);
      if (b && b.length) bars.set(t, b);
      else failed.push(t);
      opts.onProgress?.(++done, total);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 8 }, worker));
  return { bars, failed };
}
