/**
 * Latest-quarter revenue and profit for every SEC filer, and the same quarter
 * a year earlier, for the "why it can go up" card.
 *
 * SOURCE. SEC XBRL frames for calendar quarters (CY2026Q2 …): one request per
 * concept-quarter returns every filer. Checked 2026-10-14: Q1–Q3 frames are
 * full (≈2,300 filers for revenue, ≈5,000 for profit) but Q4 frames are thin
 * (≈480), because a 10-K reports the year, not a three-month Q4. So the card
 * compares the latest quarter a company HAS with the quarter ending about a
 * year before it, matched BY DATE (±45 days), never by counting back rows:
 * a missing quarter would otherwise compare the wrong periods, the trap that
 * bit Future Stars twice.
 *
 * Revenue has no single tag. The ASC 606 tag is used first, then the older
 * catch-all `Revenues`, then the tax-inclusive tag refiners use (Valero had no
 * figure without it). A company is compared only with itself on the same tag.
 */
import { cachedJson, SEC_UA } from './http';

const REVENUE_TAGS = ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'RevenueFromContractWithCustomerIncludingAssessedTax'] as const;
const PROFIT_TAG = 'NetIncomeLoss';
export const YEAR_AGO_TOLERANCE_DAYS = 45;
const QUARTERS_BACK = 9;

export interface QuarterFact {
  start: string;
  end: string;
  val: number;
}

export interface QuarterRead {
  /** End date of the latest quarter with revenue. */
  latestEnd: string | null;
  revenue: number | null;
  revenueYearAgo: number | null;
  /** Latest quarter vs the same quarter a year earlier, fraction. */
  revenueGrowth: number | null;
  /** Net margin now and a year earlier, fractions. */
  margin: number | null;
  marginYearAgo: number | null;
  /** Net profit in the latest quarter (any quarter with profit, revenue or not). */
  latestProfit: number | null;
}

const days = (a: string, b: string): number => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
const isQuarter = (f: QuarterFact): boolean => {
  const d = days(f.start, f.end);
  return d >= 80 && d <= 100;
};

/** The fact whose end is about a year before `end` (±45 days). Pure. */
export function yearAgoOf(facts: QuarterFact[], end: string): QuarterFact | null {
  const target = Date.parse(end) - 365 * 86_400_000;
  let best: QuarterFact | null = null;
  for (const f of facts) {
    const gap = Math.abs(Date.parse(f.end) - target) / 86_400_000;
    if (gap <= YEAR_AGO_TOLERANCE_DAYS && (!best || gap < Math.abs(Date.parse(best.end) - target) / 86_400_000)) best = f;
  }
  return best;
}

/** Read one company's quarters. `revenue` is per tag, in preference order. Pure. */
export function readQuarters(revenue: QuarterFact[][], profit: QuarterFact[]): QuarterRead {
  const prof = profit.filter(isQuarter).sort((a, b) => a.end.localeCompare(b.end));
  const latestProfit = prof.length ? prof[prof.length - 1].val : null;
  for (const raw of revenue) {
    const rev = raw.filter(isQuarter).sort((a, b) => a.end.localeCompare(b.end));
    if (!rev.length) continue;
    const now = rev[rev.length - 1];
    const ago = yearAgoOf(rev, now.end);
    const pNow = prof.find((p) => p.end === now.end) ?? null;
    const pAgo = ago ? prof.find((p) => p.end === ago.end) ?? null : null;
    return {
      latestEnd: now.end,
      revenue: now.val,
      revenueYearAgo: ago?.val ?? null,
      revenueGrowth: ago && ago.val > 0 ? now.val / ago.val - 1 : null,
      margin: pNow && now.val > 0 ? pNow.val / now.val : null,
      marginYearAgo: pAgo && ago && ago.val > 0 ? pAgo.val / ago.val : null,
      latestProfit,
    };
  }
  return { latestEnd: null, revenue: null, revenueYearAgo: null, revenueGrowth: null, margin: null, marginYearAgo: null, latestProfit };
}

/** The last `n` calendar quarters as SEC frame periods, newest first. Pure. */
export function recentQuarters(today: string, n = QUARTERS_BACK): string[] {
  let y = Number(today.slice(0, 4));
  let q = Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1;
  const out: string[] = [];
  while (out.length < n) {
    out.push(`CY${y}Q${q}`);
    if (--q === 0) {
      q = 4;
      y--;
    }
  }
  return out;
}

type FrameBody = { data?: { cik: number; start: string; end: string; val: number }[] };

/** Every filer's recent completed quarters, keyed by CIK. */
export async function loadQuarterly(opts: { force?: boolean } = {}): Promise<Map<number, QuarterRead>> {
  // The current quarter has not ended, so it has no frame yet (SEC answers 404); start one back.
  const periods = recentQuarters(new Date().toISOString().slice(0, 10), QUARTERS_BACK + 1).slice(1);
  const rev = new Map<number, QuarterFact[][]>();
  const prof = new Map<number, QuarterFact[]>();
  const pull = async (tag: string, p: string) =>
    cachedJson<FrameBody>(`https://data.sec.gov/api/xbrl/frames/us-gaap/${tag}/USD/${p}.json`, `sec/q_${tag}_${p}.json`, {
      ttlMs: 3 * 86_400_000,
      headers: { 'User-Agent': SEC_UA },
      gapMs: 150,
      force: opts.force,
      timeoutMs: 60_000,
    });
  for (const p of periods) {
    for (let t = 0; t < REVENUE_TAGS.length; t++) {
      for (const d of (await pull(REVENUE_TAGS[t], p))?.data ?? []) {
        let arr = rev.get(d.cik);
        if (!arr) rev.set(d.cik, (arr = REVENUE_TAGS.map(() => [])));
        arr[t].push({ start: d.start, end: d.end, val: d.val });
      }
    }
    for (const d of (await pull(PROFIT_TAG, p))?.data ?? []) {
      let arr = prof.get(d.cik);
      if (!arr) prof.set(d.cik, (arr = []));
      arr.push({ start: d.start, end: d.end, val: d.val });
    }
  }
  const out = new Map<number, QuarterRead>();
  for (const cik of new Set([...rev.keys(), ...prof.keys()])) out.set(cik, readQuarters(rev.get(cik) ?? [], prof.get(cik) ?? []));
  return out;
}
