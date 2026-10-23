/**
 * Revenue and profit, from the company's own XBRL results filing.
 *
 * Yahoo's fundamentals API stopped answering without a crumb (verified
 * 2026-09-11: `/v10/finance/quoteSummary` and `/v7/finance/quote` both return
 * "Invalid Crumb" / "unable to access"), so the numbers come from the source
 * instead: every quarterly result filed with NSE carries a machine-readable
 * XBRL document, and the list endpoint hands out the links.
 *
 * XBRL quirks that matter, established by reading real filings:
 *
 *  - Facts are stamped with a context id, and NSE's contexts are COLUMNS of the
 *    results table rather than distinct periods: `OneD` is the quarter itself,
 *    `FourD` the year-to-date column. Both carry the SAME start and end date in
 *    the context definition, so the dates cannot be used to tell them apart.
 *    Syrma's Q3 FY25 filing reports ₹869.2 cr under OneD and ₹2,861.8 cr under
 *    FourD for the same stamped period — quarter and nine months. We read the
 *    quarter, and take the period from `DateOfStartOfReportingPeriod` /
 *    `DateOfEndOfReportingPeriod`, which are explicit facts.
 *  - A company files both standalone and consolidated results. Mixing them
 *    invents growth, so a series is built from one basis only, consolidated
 *    preferred.
 *  - Values are in rupees, already scaled; `decimals="-6"` is a precision hint,
 *    not a multiplier.
 *
 * The parser is pure and tested against a saved filing; only the fetchers touch
 * the network.
 */
import { logger } from '../../utils/logger';
import { Growth, Quarter } from './types';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** One row of the NSE results list. */
export interface RawResult {
  symbol?: string;
  companyName?: string;
  consolidated?: string;
  period?: string;
  relatingTo?: string;
  fromDate?: string;
  toDate?: string;
  filingDate?: string;
  broadCastDate?: string;
  audited?: string;
  xbrl?: string;
  seqNumber?: string;
}

/** Read one numeric XBRL fact for a context. */
function fact(xml: string, tag: string, context: string): number | null {
  const re = new RegExp(
    `<[a-zA-Z-]+:${tag}\\b[^>]*contextRef="${context}"[^>]*>\\s*(-?[\\d.]+)\\s*<`,
    'i',
  );
  const m = re.exec(xml);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Read one non-numeric fact (dates are stored as text). */
function textFact(xml: string, tag: string): string | null {
  const m = new RegExp(`<[a-zA-Z-]+:${tag}\\b[^>]*>\\s*([^<\\s][^<]*?)\\s*<`, 'i').exec(xml);
  return m ? m[1] : null;
}

/**
 * Parse one XBRL results document into the QUARTER it reports.
 *
 * `basisWanted` picks the context: NSE uses `OneD` for the standalone quarter
 * column and `FourD` for the consolidated one in single-basis filings. We try
 * the requested one first and fall back, because a company filing only
 * consolidated results still uses `OneD`.
 */
export function parseResultsXbrl(xml: string, filedAt: number, consolidated: boolean): Quarter | null {
  const end = textFact(xml, 'DateOfEndOfReportingPeriod');
  const start = textFact(xml, 'DateOfStartOfReportingPeriod');
  if (!end) return null;

  // Quarter length: a 3-month window is a quarter, anything longer is a
  // year-to-date or annual column and cannot be compared like-for-like.
  if (start) {
    const days = (Date.parse(end) - Date.parse(start)) / 86_400_000;
    if (!(days > 60 && days < 130)) return null;
  }

  for (const ctx of ['OneD', 'FourD']) {
    const revenue = fact(xml, 'RevenueFromOperations', ctx);
    if (revenue === null || !(revenue > 0)) continue;
    const profit =
      fact(xml, 'ProfitLossForPeriod', ctx) ??
      fact(xml, 'ProfitLossForPeriodFromContinuingOperations', ctx);
    if (profit === null) continue;
    return {
      end,
      label: textFact(xml, 'ReportingQuarter') ?? null,
      consolidated,
      revenue,
      profit,
      pbt: fact(xml, 'ProfitBeforeTax', ctx),
      filedAt,
    };
  }
  return null;
}

/** Quarters that are the same period, keeping the best-quality one. */
function dedupe(quarters: Quarter[]): Quarter[] {
  const byEnd = new Map<string, Quarter>();
  for (const q of quarters) {
    const prev = byEnd.get(q.end);
    // A later filing supersedes an earlier one for the same quarter (companies
    // refile corrections); consolidated beats standalone at equal recency.
    if (!prev || q.filedAt > prev.filedAt) byEnd.set(q.end, q);
  }
  return [...byEnd.values()].sort((a, b) => a.end.localeCompare(b.end));
}

const pct = (now: number, then: number): number | null =>
  then > 0 ? Math.round(((now - then) / then) * 1000) / 10 : null;

/**
 * The quarter roughly a year before `q`, matched BY DATE.
 *
 * Not by counting back four places in the array. Filings go missing — the
 * changeover to SEBI's integrated filing left a hole where the March 2025
 * quarter should be for several companies — and index arithmetic over a series
 * with a hole silently compares the wrong periods. Caught in testing: Syrma's
 * June 2026 quarter was being measured against December 2024 and reported as
 * "+82.8% year on year", an eighteen-month comparison wearing a twelve-month
 * label. A tolerance of ±45 days absorbs the fact that quarter ends are not
 * exactly 365 days apart; anything further away is not a comparison at all.
 */
function yearAgoOf(quarters: Quarter[], q: Quarter | undefined): Quarter | undefined {
  if (!q) return undefined;
  const target = Date.parse(q.end) - 365 * 86_400_000;
  let best: Quarter | undefined;
  let bestGap = Infinity;
  for (const c of quarters) {
    const gap = Math.abs(Date.parse(c.end) - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = c;
    }
  }
  return bestGap <= 45 * 86_400_000 ? best : undefined;
}

/**
 * Turn a quarterly series into growth. Pure.
 *
 * Year-on-year, never quarter-on-quarter: Indian results are seasonal (defence
 * and infrastructure book a disproportionate share in the March quarter), and a
 * sequential comparison would read that seasonality as a trend.
 */
export function computeGrowth(symbol: string, input: Quarter[]): Growth {
  const quarters = dedupe(input);
  const at = (i: number): Quarter | undefined => quarters[quarters.length - i];
  const latest = at(1);
  const prevQ = at(2);
  const yearAgo = yearAgoOf(quarters, latest);
  const prevYearAgo = yearAgoOf(quarters, prevQ);

  // Trailing twelve months only when the four quarters really do span a year:
  // summing four quarters with a hole in them understates revenue and would
  // flatter every ratio built on it.
  const last4 = quarters.slice(-4);
  const spansAYear =
    last4.length === 4 &&
    Math.abs(Date.parse(last4[3].end) - Date.parse(last4[0].end) - 273 * 86_400_000) <= 60 * 86_400_000;
  const ttmRevenue = spansAYear ? last4.reduce((s, q) => s + q.revenue, 0) : null;
  const ttmProfit = spansAYear ? last4.reduce((s, q) => s + q.profit, 0) : null;

  const revenueYoYPct = latest && yearAgo ? pct(latest.revenue, yearAgo.revenue) : null;
  const revenueYoYPriorPct = prevQ && prevYearAgo ? pct(prevQ.revenue, prevYearAgo.revenue) : null;

  // How many consecutive quarters, walking back, grew against their own year-ago
  // quarter. A single good quarter is noise; four in a row is a trend. A quarter
  // with no year-ago counterpart ends the count rather than being assumed good.
  let streak = 0;
  for (let i = 1; i <= quarters.length; i++) {
    const a = at(i);
    const b = yearAgoOf(quarters, a);
    if (a && b && a.revenue > b.revenue) streak++;
    else break;
  }

  const marginOf = (q: Quarter | undefined): number | null =>
    q && q.pbt !== null && q.revenue > 0 ? Math.round((q.pbt / q.revenue) * 1000) / 10 : null;

  return {
    symbol: symbol.toUpperCase(),
    quarters,
    revenueYoYPct,
    profitYoYPct: latest && yearAgo ? pct(latest.profit, yearAgo.profit) : null,
    revenueYoYPriorPct,
    revenueAccelerationPct:
      revenueYoYPct !== null && revenueYoYPriorPct !== null
        ? Math.round((revenueYoYPct - revenueYoYPriorPct) * 10) / 10
        : null,
    ttmRevenue,
    ttmProfit,
    marginPct: marginOf(latest),
    marginYearAgoPct: marginOf(yearAgo),
    positiveStreak: streak,
    comparedWith: yearAgo?.end ?? null,
    ageDays: latest ? Math.floor((Date.now() - Date.parse(latest.end)) / 86_400_000) : null,
  };
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.nseindia.com/' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * The results index for a symbol, from BOTH of NSE's filing regimes.
 *
 * SEBI replaced separate quarterly-result filings with a single "Integrated
 * Filing (Financial)" during 2025. The consequence, found by reading the data
 * rather than the circular: `corporates-financial-results` now stops dead at
 * the December 2024 quarter, and everything since lives under
 * `integrated-filing-results`. A tool reading only the old endpoint in
 * September 2026 would be scoring companies on numbers 21 months stale and
 * would never notice.
 *
 * So both are read and merged: the new one for current quarters, the old one
 * for the history that makes a year-on-year comparison possible.
 * Verified 2026-09-11; both answer with a User-Agent alone, no cookie.
 */
export async function fetchResultsIndex(symbol: string, timeoutMs = 20_000): Promise<RawResult[]> {
  const sym = encodeURIComponent(symbol.toUpperCase());
  const out: RawResult[] = [];
  const errors: string[] = [];

  // Current regime (2025 →). `qe_Date` is the quarter end; the field names are
  // snake_cased differently from the legacy payload, so normalise here.
  try {
    const body = await getJson(
      `https://www.nseindia.com/api/integrated-filing-results?index=equities&symbol=${sym}`,
      timeoutMs,
    );
    const rows = (body as { data?: unknown }).data ?? body;
    if (Array.isArray(rows)) {
      for (const r of rows as Record<string, string | null>[]) {
        if (!r.xbrl) continue;
        out.push({
          symbol: r.symbol ?? symbol,
          companyName: r.smName ?? r.cmName ?? undefined,
          consolidated: r.consolidated ?? undefined,
          period: 'Quarterly',
          toDate: r.qe_Date ?? undefined,
          broadCastDate: r.broadcast_Date ?? undefined,
          audited: r.audited ?? undefined,
          xbrl: r.xbrl,
          seqNumber: r.seq_Id ?? undefined,
        });
      }
    }
  } catch (e) {
    errors.push(`integrated: ${e instanceof Error ? e.message : e}`);
  }

  // Legacy regime (→ Dec 2024), for the year-ago comparisons.
  try {
    const body = await getJson(
      `https://www.nseindia.com/api/corporates-financial-results?index=equities&symbol=${sym}&period=Quarterly`,
      timeoutMs,
    );
    if (Array.isArray(body)) out.push(...(body as RawResult[]).filter((r) => !!r.xbrl));
  } catch (e) {
    errors.push(`legacy: ${e instanceof Error ? e.message : e}`);
  }

  if (!out.length && errors.length) throw new Error(`NSE results unavailable (${errors.join('; ')})`);
  return out;
}

/** "07-Mar-2025 20:58:46" → epoch ms, or 0. */
function filedAtOf(r: RawResult): number {
  const s = r.broadCastDate ?? r.filingDate ?? '';
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(s.trim());
  if (!m) return 0;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const mon = months.indexOf(m[2].toLowerCase());
  return mon < 0 ? 0 : Date.UTC(Number(m[3]), mon, Number(m[1])) - 5.5 * 3_600_000;
}

/**
 * Growth for one symbol, from up to `maxFilings` recent quarterly filings.
 *
 * Ten filings is the working minimum once both regimes are in play: the latest
 * quarter, its year-ago comparison, and the pair before them for acceleration —
 * plus the duplicates that come from a company filing standalone and
 * consolidated versions of the same quarter, and the occasional refiling.
 * Never throws — a failure comes back as an empty series carrying the reason.
 */
export async function fetchGrowth(symbol: string, maxFilings = 10): Promise<Growth> {
  const empty = (error: string): Growth => ({
    ...computeGrowth(symbol, []),
    error,
  });
  try {
    const index = await fetchResultsIndex(symbol);
    if (!index.length) return empty('no quarterly results filed with NSE');

    // One basis only. Prefer consolidated when the company files it.
    const isCons = (r: RawResult): boolean => (r.consolidated ?? '').toLowerCase().startsWith('con');
    const consolidated = index.some(isCons);
    const wanted = index
      .filter((r) => (consolidated ? isCons(r) : !isCons(r)))
      .filter((r) => !!r.xbrl)
      .sort((a, b) => filedAtOf(b) - filedAtOf(a))
      .slice(0, maxFilings);

    const quarters: Quarter[] = [];
    for (const r of wanted) {
      try {
        const res = await fetch(r.xbrl!, {
          headers: { 'User-Agent': UA, Referer: 'https://www.nseindia.com/' },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) continue;
        const q = parseResultsXbrl(await res.text(), filedAtOf(r), consolidated);
        if (q) quarters.push(q);
      } catch {
        /* one unreadable filing must not lose the series */
      }
    }
    if (!quarters.length) return empty('results filed, but no readable XBRL');
    return computeGrowth(symbol, quarters);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logger.warn(`growth ${symbol}: ${error}`);
    return empty(error);
  }
}
