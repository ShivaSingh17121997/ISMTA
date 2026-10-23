/**
 * Who owns the company, and whether they are selling.
 *
 * Two of the best-evidenced warning signs in equities are in here, and both are
 * India-specific in their strongest form:
 *
 *  PROMOTER DILUTION. Pontiff & Woodgate (JF 2008) find share issuance predicts
 *  returns more significantly than size, book-to-market or momentum. The
 *  refinement that matters is Larrain & Urzúa's: essentially ALL of the
 *  predictive power comes from issues that materially dilute the CONTROLLER —
 *  −1.72% a month after those, against −0.78% and insignificant when the
 *  controlling stake rises. Roughly one issue in eight qualifies. Indian
 *  quarterly shareholding filings make this directly computable, which is
 *  unusual: in most markets you have to hand-collect it.
 *
 *  PLEDGED PROMOTER SHARES. Chauhan, Mishra & Spahr (Financial Management 2021),
 *  1,452 Indian firms: pledging raises volatility and lowers firm value and
 *  long-run performance. Dou, Masulis & Zein (RFS 2019) establish the causal
 *  mechanism — margin-call cascades, where a falling price forces the promoter
 *  to sell, which lowers the price. That is precisely the mechanism that turns
 *  a large fall into a permanent one, so it belongs in any screen that looks at
 *  stocks which have already fallen.
 *
 * Note the asymmetry deliberately built in below: a RISING promoter stake is
 * treated as mild reassurance, a FALLING one as a real warning. The evidence is
 * much stronger on the downside.
 *
 * Sources verified 2026-09-11:
 *   /api/corporate-share-holdings-master?index=equities&symbol=X
 *     → one row per quarter (21 available), `pr_and_prgrp` = promoter %, plus
 *       an `xbrl` link per row.
 *   The row's XBRL carries explicit encumbrance booleans:
 *     WhetherAnySharesHeldByPromotersAreEncumberedUnderPledged
 *     ...UnderNonDisposalUndertaking / ...OtherThanByWayOfPledgeOrNDU
 */
import { logger } from '../../utils/logger';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface ShareholdingQuarter {
  /** YYYY-MM-DD of the quarter end */
  date: string;
  promoterPct: number;
  publicPct: number | null;
  xbrl: string | null;
}

export interface Shareholding {
  symbol: string;
  quarters: ShareholdingQuarter[];
  latestPct: number | null;
  /** promoter % a year ago, matched by date */
  yearAgoPct: number | null;
  /** latest − year ago, percentage points. Negative = the promoter sold or was diluted. */
  changePct: number | null;
  /** true when the latest filing says promoter shares are pledged or otherwise encumbered */
  pledged: boolean | null;
  /** what kind of encumbrance the filing reported */
  encumbrance: string[];
  error?: string;
}

interface RawRow {
  date?: string;
  pr_and_prgrp?: string;
  public_val?: string;
  xbrl?: string;
}

const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

/** "30-JUN-2026" → "2026-06-30". */
export function parseShpDate(s: string | undefined): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec((s ?? '').trim());
  if (!m) return null;
  const mon = MONTHS[m[2].toUpperCase()];
  return mon ? `${m[3]}-${mon}-${m[1].padStart(2, '0')}` : null;
}

/** Turn the raw rows into a clean, sorted series. Pure. */
export function parseShareholding(symbol: string, rows: RawRow[]): ShareholdingQuarter[] {
  const out: ShareholdingQuarter[] = [];
  for (const r of rows) {
    const date = parseShpDate(r.date);
    const promoterPct = Number(r.pr_and_prgrp);
    if (!date || !Number.isFinite(promoterPct)) continue;
    // A company can refile a quarter; keep the first occurrence, which the API
    // returns newest-first.
    if (out.some((x) => x.date === date)) continue;
    out.push({
      date,
      promoterPct,
      publicPct: Number.isFinite(Number(r.public_val)) ? Number(r.public_val) : null,
      xbrl: r.xbrl ?? null,
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Summarise the series. Pure.
 *
 * The year-ago comparison is matched BY DATE for the same reason the results
 * series is: shareholding filings go missing, and companies file interim
 * patterns after a placement (Syrma has a 12-AUG-2025 row between its June and
 * September quarters), so counting back four rows compares the wrong periods.
 */
export function summariseShareholding(
  symbol: string,
  quarters: ShareholdingQuarter[],
  encumbrance: string[],
  pledged: boolean | null,
): Shareholding {
  const latest = quarters[0];
  let yearAgo: ShareholdingQuarter | undefined;
  if (latest) {
    const target = Date.parse(latest.date) - 365 * 86_400_000;
    let bestGap = Infinity;
    for (const q of quarters) {
      const gap = Math.abs(Date.parse(q.date) - target);
      if (gap < bestGap) {
        bestGap = gap;
        yearAgo = q;
      }
    }
    if (bestGap > 60 * 86_400_000) yearAgo = undefined;
  }
  const latestPct = latest?.promoterPct ?? null;
  const yearAgoPct = yearAgo?.promoterPct ?? null;
  return {
    symbol: symbol.toUpperCase(),
    quarters,
    latestPct,
    yearAgoPct,
    changePct:
      latestPct !== null && yearAgoPct !== null ? Math.round((latestPct - yearAgoPct) * 100) / 100 : null,
    pledged,
    encumbrance,
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

/** Read the encumbrance booleans out of a shareholding-pattern XBRL. Pure. */
export function parseEncumbrance(xml: string): { pledged: boolean; kinds: string[] } {
  const kinds: string[] = [];
  const check = (tag: string, label: string): void => {
    const m = new RegExp(`<[a-zA-Z-]+:${tag}\\b[^>]*>\\s*(true|false)\\s*<`, 'i').exec(xml);
    if (m && m[1].toLowerCase() === 'true') kinds.push(label);
  };
  check('WhetherAnySharesHeldByPromotersAreEncumberedUnderPledged', 'pledged');
  check('WhetherAnySharesHeldByPromotersAreEncumberedUnderNonDisposalUndertaking', 'non-disposal undertaking');
  check('WhetherAnySharesHeldByPromotersAreEncumberedOtherThanByWayOfPledgeOrNDU', 'other encumbrance');
  return { pledged: kinds.length > 0, kinds };
}

/**
 * Ownership for one symbol. Never throws: a failure returns an empty read with
 * the reason, and the caller treats "unknown" as unknown rather than as clean.
 */
export async function fetchShareholding(symbol: string, timeoutMs = 20_000): Promise<Shareholding> {
  const sym = symbol.toUpperCase();
  try {
    const body = await getJson(
      `https://www.nseindia.com/api/corporate-share-holdings-master?index=equities&symbol=${encodeURIComponent(sym)}`,
      timeoutMs,
    );
    const rows = Array.isArray(body) ? (body as RawRow[]) : [];
    const quarters = parseShareholding(sym, rows);
    if (!quarters.length) return { ...summariseShareholding(sym, [], [], null), error: 'no shareholding filings' };

    // Encumbrance comes from the latest filing's own XBRL. Best-effort: an
    // unreadable file leaves `pledged` null, which is "unknown", not "clean".
    let pledged: boolean | null = null;
    let kinds: string[] = [];
    const url = quarters[0].xbrl;
    if (url) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': UA, Referer: 'https://www.nseindia.com/' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          const parsed = parseEncumbrance(await res.text());
          pledged = parsed.pledged;
          kinds = parsed.kinds;
        }
      } catch {
        /* leave unknown */
      }
    }
    return summariseShareholding(sym, quarters, kinds, pledged);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logger.warn(`shareholding ${sym}: ${error}`);
    return { ...summariseShareholding(sym, [], [], null), error };
  }
}
