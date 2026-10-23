/**
 * NIFTY 50 valuation: trailing PE, PB and dividend yield since 1999.
 *
 * Valuation predicts 3–10 year returns and says nothing about timing — markets
 * stay expensive or cheap for years. It is shown as long-run context and never
 * enters a warning.
 *
 * SOURCE (verified 2026-10-09): niftyindices.com's PE/PB endpoint. The older
 * `Backpage.aspx/...` path is dead; `BackPage/...` works with a browser
 * User-Agent and no cookie, and returns the whole history in one call.
 *
 * THE 2021 BREAK. On 31 Mar 2021 NSE switched index PE from standalone to
 * consolidated earnings and the PE dropped 40.4 → 33.2 overnight with no price
 * move. A PE percentile across that date compares two different numbers, so PE
 * is ranked only within the consolidated era; PB did not break and is ranked
 * over the full history.
 */
import { logger } from '../../utils/logger';
import { percentileOf } from './series';

const URL = 'https://www.niftyindices.com/BackPage/getpepbHistoricaldataDBtoString';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
export const PE_BREAK = '2021-03-31';

export interface ValuationSeries {
  dates: string[];
  pe: number[];
  pb: number[];
  dy: number[];
}

export interface ValuationRead {
  date: string;
  pe: number;
  pb: number;
  dy: number;
  /** PE rank within the consolidated-earnings era (since 31 Mar 2021), 0..1. */
  pePctConsolidated: number | null;
  /** PB rank over the whole history, 0..1. */
  pbPctAll: number | null;
}

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

/** "08 Oct 2026" → "2026-10-08"; null when unparseable. */
export function parseNiDate(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2})[ -]([A-Za-z]{3})[ -](\d{4})$/.exec(s.trim());
  if (!m || !MONTHS[m[2]]) return null;
  return `${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, '0')}`;
}

/**
 * Parse the endpoint's body. It answers `{ d: "<json string>" }` (ASP.NET page
 * method) or the bare array; both are accepted. Rows with a non-positive PE or
 * PB are dropped, never zero-filled. Pure.
 */
export function parseValuation(body: unknown): ValuationSeries {
  let rows: unknown = body;
  if (rows && typeof rows === 'object' && 'd' in rows) {
    const d = (rows as { d: unknown }).d;
    rows = typeof d === 'string' ? JSON.parse(d) : d;
  }
  if (!Array.isArray(rows)) return { dates: [], pe: [], pb: [], dy: [] };
  const byDate = new Map<string, { pe: number; pb: number; dy: number }>();
  for (const r of rows as Record<string, unknown>[]) {
    const date = parseNiDate(r.DATE ?? r.Date);
    const pe = Number(r.pe ?? r.PE);
    const pb = Number(r.pb ?? r.PB);
    const dy = Number(r.divYield ?? r.DivYield ?? 0);
    if (!date || !(pe > 0) || !(pb > 0)) continue;
    byDate.set(date, { pe, pb, dy: Number.isFinite(dy) ? dy : 0 });
  }
  const dates = [...byDate.keys()].sort();
  return {
    dates,
    pe: dates.map((d) => byDate.get(d)!.pe),
    pb: dates.map((d) => byDate.get(d)!.pb),
    dy: dates.map((d) => byDate.get(d)!.dy),
  };
}

/** The reading on or before `date`, ranked as described above. Pure. */
export function readValuation(v: ValuationSeries, date: string): ValuationRead | null {
  let i = -1;
  for (let k = 0; k < v.dates.length && v.dates[k] <= date; k++) i = k;
  if (i < 0) return null;
  const peEra: number[] = [];
  const pbAll: number[] = [];
  for (let k = 0; k <= i; k++) {
    pbAll.push(v.pb[k]);
    if (v.dates[k] >= PE_BREAK) peEra.push(v.pe[k]);
  }
  return {
    date: v.dates[i],
    pe: v.pe[i],
    pb: v.pb[i],
    dy: v.dy[i],
    pePctConsolidated: v.dates[i] >= PE_BREAK ? percentileOf(peEra, v.pe[i]) : null,
    pbPctAll: percentileOf(pbAll, v.pb[i]),
  };
}

let cache: { at: number; v: ValuationSeries } | null = null;

/** Full history, cached for 12h. Empty series on failure. */
export async function fetchValuation(now = Date.now()): Promise<ValuationSeries> {
  if (cache && now - cache.at < 12 * 3_600_000) return cache.v;
  const end = new Date(now);
  const fmt = (d: Date): string =>
    `${String(d.getUTCDate()).padStart(2, '0')}-${Object.keys(MONTHS)[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
  const cinfo = `{'name':'NIFTY 50','startDate':'01-Jan-1999','endDate':'${fmt(end)}','indexName':'NIFTY 50'}`;
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': UA },
      body: JSON.stringify({ cinfo }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const v = parseValuation(await res.json());
    if (!v.dates.length) throw new Error('parsed to nothing');
    cache = { at: now, v };
    return v;
  } catch (e) {
    logger.warn(`NIFTY valuation: ${e instanceof Error ? e.message : e}`);
    return cache?.v ?? { dates: [], pe: [], pb: [], dy: [] };
  }
}
