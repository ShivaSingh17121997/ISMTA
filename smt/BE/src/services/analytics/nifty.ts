/**
 * NIFTY 50 daily closes, keyed by IST day, cached in memory for six hours.
 *
 * One Yahoo call serves every NAV request for the rest of the session. A
 * failed fetch keeps whatever the cache already held and retries after five
 * minutes rather than hammering the source; it never invents a close.
 */
import { fetchYahooCandles } from '../yahoo';
import { istParts } from '../session';

const TTL_MS = 6 * 3_600_000;
const FAIL_TTL_MS = 5 * 60_000;

interface Cache {
  at: number;
  closes: Map<string, number>;
  ok: boolean;
}

let cache: Cache | null = null;
let inflight: Promise<Map<string, number>> | null = null;

export async function niftyDailyCloses(now = Date.now()): Promise<Map<string, number>> {
  if (cache && now - cache.at < (cache.ok ? TTL_MS : FAIL_TTL_MS)) return cache.closes;
  if (inflight) return inflight;
  inflight = (async () => {
    const candles = await fetchYahooCandles('NIFTY', '2y', '1d').catch(() => []);
    const closes = new Map<string, number>();
    for (const c of candles) if (c.close > 0) closes.set(istParts(c.timestamp).date, c.close);
    cache = closes.size > 0 ? { at: Date.now(), closes, ok: true } : { at: Date.now(), closes: cache?.closes ?? new Map(), ok: false };
    return cache.closes;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

export function niftyCacheInfo(): { at: number; days: number; ok: boolean } | null {
  return cache ? { at: cache.at, days: cache.closes.size, ok: cache.ok } : null;
}
