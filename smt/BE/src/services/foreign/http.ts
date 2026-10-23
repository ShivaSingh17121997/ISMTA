/**
 * Disk-cached JSON/text fetches for the foreign-stock enrichments (Nasdaq,
 * SEC submissions, Google News). Every fetch is spaced by a per-host gap, so
 * a refresh of ~40 names never bursts a free endpoint, and a failure falls
 * back to the last cached copy (stale is better than blank for a research
 * page). A failure with no cache returns null; callers render "–".
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../utils/logger';

export const CACHE_DIR = path.join(process.cwd(), '.cache', 'foreign');
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36';
export const SEC_UA = 'SMT personal research tool (self-hosted)';

const lastHit = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait so that requests to one host are at least `gapMs` apart. */
async function pace(host: string, gapMs: number): Promise<void> {
  const next = (lastHit.get(host) ?? 0) + gapMs;
  lastHit.set(host, Math.max(Date.now(), next));
  const wait = next - Date.now();
  if (wait > 0) await sleep(wait);
}

export const safeName = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, '_');

export async function cachedFetch(
  url: string,
  file: string,
  opts: { ttlMs: number; headers?: Record<string, string>; gapMs?: number; force?: boolean; timeoutMs?: number },
): Promise<string | null> {
  const full = path.join(CACHE_DIR, file);
  try {
    if (!opts.force && Date.now() - fs.statSync(full).mtimeMs < opts.ttlMs) return fs.readFileSync(full, 'utf8');
  } catch {
    /* not cached */
  }
  try {
    await pace(new URL(url).host, opts.gapMs ?? 500);
    const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, ...opts.headers }, signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
    return body;
  } catch (e) {
    logger.warn(`foreign fetch ${url.slice(0, 90)}: ${e instanceof Error ? e.message : e}`);
    try {
      return fs.readFileSync(full, 'utf8');
    } catch {
      return null;
    }
  }
}

export async function cachedJson<T>(url: string, file: string, opts: Parameters<typeof cachedFetch>[2]): Promise<T | null> {
  const body = await cachedFetch(url, file, { ...opts, headers: { Accept: 'application/json', ...opts.headers } });
  if (body == null) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}
