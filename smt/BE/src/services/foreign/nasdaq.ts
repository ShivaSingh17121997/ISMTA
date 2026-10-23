/**
 * Analyst and earnings data from Nasdaq's public JSON API (no key; a browser
 * User-Agent is required). Verified by fetching on 2026-10-14:
 *
 *   /api/analyst/{T}/targetprice      consensus target low/mean/high, buy/hold/sell
 *                                     counts, and 12 monthly consensus snapshots
 *   /api/company/{T}/earnings-surprise last 4 quarters: EPS vs consensus
 *   /api/analyst/{T}/earnings-forecast estimates, with up/down revisions in 4 weeks
 *   /api/calendar/earnings?date=D      everyone reporting on day D
 *
 * EVERYTHING HERE IS DISPLAY OR A RISK RULE, NEVER A RANKING INPUT. Consensus
 * targets are optimistic on average, and their track record CANNOT be measured
 * from this source: `historicalConsensus[].y` is the stock's PRICE that month,
 * not the target (Apple's 10/01/2025 value, 255.45, was its price that day).
 * Scoring it as a target produced "median promised upside 0.0%" on 2026-10-14,
 * which is how the mistake showed itself. So targets are shown as the analysts'
 * view only. The one rule that uses this data is the earnings-date warning,
 * which is about risk.
 *
 * NOT USED: /api/company/{T}/insider-trades. Its "open market buys" count gave
 * Nvidia 23 and MetLife 86 in a year (2026-10-14); Nvidia insiders essentially
 * never buy in the market, so the count includes plan or grant acquisitions.
 * Every pick showed "insiders bought", which carries no information.
 *
 * Share classes: Nasdaq has no record for BRK.B in any spelling tried, so a
 * failure just leaves the card blank.
 */
import { cachedJson, safeName } from './http';

const BASE = 'https://api.nasdaq.com/api';
const TTL = 24 * 3_600_000;
const GAP_MS = 500;

export interface AnalystView {
  target: number | null;
  targetLow: number | null;
  targetHigh: number | null;
  buy: number;
  hold: number;
  sell: number;
}

export interface EarningsView {
  /** Newest first. Surprise as a fraction (0.06 = beat by 6%). */
  surprises: { quarter: string; reported: string; surprise: number | null }[];
  /** Revisions over the last 4 weeks for the next quarter and the next fiscal year. */
  revisionsUp: number | null;
  revisionsDown: number | null;
  estimates: number | null;
}

export interface NasdaqRead {
  analyst: AnalystView | null;
  earnings: EarningsView | null;
}

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,%\s]/g, '').replace(/^\((.*)\)$/, '-$1'));
  return Number.isFinite(n) ? n : null;
};

/** BRK-B → BRK.B: Nasdaq writes share classes with a dot. */
export const nasdaqSymbol = (ticker: string): string => ticker.replace('-', '.');

type Body = { data?: Record<string, unknown> | null };

/** Parse /analyst/{T}/targetprice. Pure. */
export function parseTarget(body: Body | null): AnalystView | null {
  const c = (body?.data as { consensusOverview?: Record<string, unknown> } | undefined)?.consensusOverview;
  if (!c) return null;
  return {
    target: num(c.priceTarget),
    targetLow: num(c.lowPriceTarget),
    targetHigh: num(c.highPriceTarget),
    buy: num(c.buy) ?? 0,
    hold: num(c.hold) ?? 0,
    sell: num(c.sell) ?? 0,
  };
}

/** Parse earnings-surprise + earnings-forecast. Pure. */
export function parseEarnings(surprise: Body | null, forecast: Body | null): EarningsView | null {
  const rows = ((surprise?.data as { earningsSurpriseTable?: { rows?: Record<string, unknown>[] } } | undefined)?.earningsSurpriseTable?.rows ?? []).map((r) => {
    const pct = num(r.percentageSurprise);
    return { quarter: String(r.fiscalQtrEnd ?? ''), reported: String(r.dateReported ?? ''), surprise: pct == null ? null : pct / 100 };
  });
  const f = forecast?.data as { quarterlyForecast?: { rows?: Record<string, unknown>[] }; yearlyForecast?: { rows?: Record<string, unknown>[] } } | undefined;
  const q = f?.quarterlyForecast?.rows?.[0];
  const y = f?.yearlyForecast?.rows?.[0];
  if (!rows.length && !q && !y) return null;
  const add = (a: unknown, b: unknown): number | null => (num(a) == null && num(b) == null ? null : (num(a) ?? 0) + (num(b) ?? 0));
  return { surprises: rows, revisionsUp: add(q?.up, y?.up), revisionsDown: add(q?.down, y?.down), estimates: num(q?.noOfEstimates) };
}

export async function loadNasdaq(ticker: string, opts: { force?: boolean } = {}): Promise<NasdaqRead> {
  const t = nasdaqSymbol(ticker);
  const o = { ttlMs: TTL, gapMs: GAP_MS, force: opts.force };
  const f = (kind: string) => `nasdaq/${safeName(ticker)}_${kind}.json`;
  const target = await cachedJson<Body>(`${BASE}/analyst/${t}/targetprice`, f('target'), o);
  const surprise = await cachedJson<Body>(`${BASE}/company/${t}/earnings-surprise`, f('surprise'), o);
  const forecast = await cachedJson<Body>(`${BASE}/analyst/${t}/earnings-forecast`, f('forecast'), o);
  return { analyst: parseTarget(target), earnings: parseEarnings(surprise, forecast) };
}

/**
 * Who reports in the next `days` calendar days: ticker (our dash form) → date.
 * One request per day, cached a day.
 */
export async function loadEarningsCalendar(days = 10, from = new Date()): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let k = 0; k <= days; k++) {
    const date = new Date(from.getTime() + k * 86_400_000).toISOString().slice(0, 10);
    const body = await cachedJson<{ data?: { rows?: { symbol?: string }[] | null } }>(`${BASE}/calendar/earnings?date=${date}`, `nasdaq/calendar_${date}.json`, {
      ttlMs: 12 * 3_600_000,
      gapMs: GAP_MS,
    });
    for (const r of body?.data?.rows ?? []) if (r.symbol && !out.has(r.symbol.replace('.', '-'))) out.set(r.symbol.replace('.', '-'), date);
  }
  return out;
}

