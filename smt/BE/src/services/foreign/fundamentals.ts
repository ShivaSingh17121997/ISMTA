/**
 * Company finances from the SEC, and a point-in-time "junk" screen.
 *
 * SOURCE. SEC XBRL "frames" (data.sec.gov/api/xbrl/frames/…): one request
 * returns one figure for every filer for one fiscal year, so 5 concepts × ~17
 * years is ~85 requests instead of a 4 MB file per company. Free, no key, a
 * descriptive User-Agent required, 10 requests a second at most.
 *
 * POINT IN TIME. A fiscal year's numbers are treated as known only 120 days
 * after the year ends (10-K deadlines are 60–90 days; 120 is the safe side).
 * Frames carry the LATEST reported value for a period, so a later restatement
 * can leak into history — a mild look-ahead, stated in the checklist.
 *
 * THE SCREEN IS A VETO, NOT A BOOSTER. The evidence is stronger for avoiding
 * weak companies than for paying up for strong ones (Asness, Frazzini &
 * Pedersen "Quality minus Junk" 2019; Sloan 1996 on accruals; Ball et al. 2016
 * on cash profitability), and the same rule is used for Indian stocks here.
 * Five measures, each ranked across the universe on the same date:
 *   return on assets (higher better), operating cash flow ÷ assets (higher),
 *   accruals = (profit − operating cash) ÷ assets (LOWER: profit not backed by
 *   cash), liabilities ÷ assets (lower; skipped for financials, where leverage
 *   is the business), and the variability of ROA over 5 years (lower).
 * The bottom 20% on the average rank is "weak finances" and is not recommended.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../utils/logger';

const DIR = path.join(process.cwd(), '.cache', 'foreign', 'sec');
const UA = 'SMT personal research tool (self-hosted)';
export const AVAILABLE_AFTER_DAYS = 120;
export const JUNK_SHARE = 0.2;
const FIRST_YEAR = 2008;

type Concept = 'ni' | 'cfo' | 'assets' | 'liab' | 'equity';
const CONCEPTS: Record<Concept, { tag: string; instant: boolean }> = {
  ni: { tag: 'NetIncomeLoss', instant: false },
  cfo: { tag: 'NetCashProvidedByUsedInOperatingActivities', instant: false },
  assets: { tag: 'Assets', instant: true },
  liab: { tag: 'Liabilities', instant: true },
  equity: { tag: 'StockholdersEquity', instant: true },
};

export interface FiscalYear {
  year: number;
  /** Fiscal year end (from the profit figure when present). */
  end: string;
  /** First date this year's numbers are treated as known. */
  availableFrom: string;
  ni: number | null;
  cfo: number | null;
  assets: number | null;
  liab: number | null;
}

interface FrameRow {
  cik: number;
  end: string;
  val: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function frame(concept: Concept, year: number, force: boolean): Promise<FrameRow[]> {
  const { tag, instant } = CONCEPTS[concept];
  const period = instant ? `CY${year}Q4I` : `CY${year}`;
  const file = path.join(DIR, `${tag}_${period}.json`);
  const current = new Date().getUTCFullYear();
  // Old years do not change much; recent ones are refetched weekly.
  const ttl = year < current - 2 ? Infinity : 7 * 86_400_000;
  try {
    if (!force && Date.now() - fs.statSync(file).mtimeMs < ttl) return JSON.parse(fs.readFileSync(file, 'utf8')) as FrameRow[];
  } catch {
    /* not cached */
  }
  try {
    const res = await fetch(`https://data.sec.gov/api/xbrl/frames/us-gaap/${tag}/USD/${period}.json`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { data?: { cik: number; end: string; val: number }[] };
    const rows = (j.data ?? []).map((d) => ({ cik: d.cik, end: d.end, val: d.val }));
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(rows));
    await sleep(150);
    return rows;
  } catch (e) {
    logger.warn(`SEC frame ${tag} ${period}: ${e instanceof Error ? e.message : e}`);
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as FrameRow[];
    } catch {
      return [];
    }
  }
}

const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Every company's fiscal years, keyed by CIK. */
export async function loadFundamentals(opts: { force?: boolean } = {}): Promise<Map<number, FiscalYear[]>> {
  const lastYear = new Date().getUTCFullYear() - 1;
  const byCik = new Map<number, Map<number, FiscalYear>>();
  for (let y = FIRST_YEAR; y <= lastYear; y++) {
    for (const c of Object.keys(CONCEPTS) as Concept[]) {
      const rows = await frame(c, y, opts.force ?? false);
      for (const r of rows) {
        let m = byCik.get(r.cik);
        if (!m) byCik.set(r.cik, (m = new Map()));
        let fy = m.get(y);
        if (!fy) m.set(y, (fy = { year: y, end: `${y}-12-31`, availableFrom: addDays(`${y}-12-31`, AVAILABLE_AFTER_DAYS), ni: null, cfo: null, assets: null, liab: null }));
        if (c === 'ni') {
          fy.end = r.end;
          fy.availableFrom = addDays(r.end, AVAILABLE_AFTER_DAYS);
        }
        if (c === 'equity') {
          // Liabilities are not tagged by every filer; assets − equity stands in.
          if (fy.liab == null && fy.assets != null) fy.liab = fy.assets - r.val;
          (fy as FiscalYear & { equity?: number }).equity = r.val;
        } else fy[c] = r.val;
        if (c === 'assets' && fy.liab == null && (fy as FiscalYear & { equity?: number }).equity != null) {
          fy.liab = r.val - (fy as FiscalYear & { equity?: number }).equity!;
        }
      }
    }
  }
  const out = new Map<number, FiscalYear[]>();
  for (const [cik, m] of byCik) out.set(cik, [...m.values()].sort((a, b) => a.year - b.year));
  return out;
}

export interface QualityRead {
  asOfYear: number | null;
  roa: number | null;
  cfoa: number | null;
  accruals: number | null;
  leverage: number | null;
  roaVol: number | null;
}

/** The measures for one company as known on `date`. Pure. */
export function qualityAt(years: FiscalYear[] | undefined, date: string, financial: boolean): QualityRead {
  const known = (years ?? []).filter((y) => y.availableFrom <= date && y.assets && y.assets > 0);
  const last = known[known.length - 1];
  if (!last) return { asOfYear: null, roa: null, cfoa: null, accruals: null, leverage: null, roaVol: null };
  const roaOf = (y: FiscalYear): number | null => (y.ni != null ? y.ni / y.assets! : null);
  const recent = known.slice(-5).map(roaOf).filter((x): x is number => x != null);
  const mean = recent.reduce((a, b) => a + b, 0) / (recent.length || 1);
  return {
    asOfYear: last.year,
    roa: roaOf(last),
    cfoa: last.cfo != null ? last.cfo / last.assets! : null,
    accruals: last.ni != null && last.cfo != null ? (last.ni - last.cfo) / last.assets! : null,
    leverage: financial || last.liab == null ? null : last.liab / last.assets!,
    roaVol: recent.length >= 3 ? Math.sqrt(recent.reduce((a, b) => a + (b - mean) ** 2, 0) / recent.length) : null,
  };
}

export interface QualityScore extends QualityRead {
  /** Mean percentile across available measures, 0..1 (higher = stronger finances). Null with fewer than 3 measures. */
  score: number | null;
  junk: boolean;
  /** Plain-words reasons for a weak score. */
  weak: string[];
}

function pct(values: (number | null)[], higherBetter: boolean): (number | null)[] {
  const idx = values.map((v, i) => ({ v, i })).filter((o): o is { v: number; i: number } => o.v != null && Number.isFinite(o.v));
  idx.sort((a, b) => a.v - b.v);
  const out: (number | null)[] = values.map(() => null);
  idx.forEach((o, k) => {
    const r = idx.length > 1 ? k / (idx.length - 1) : 0.5;
    out[o.i] = higherBetter ? r : 1 - r;
  });
  return out;
}

/** Rank the universe on the five measures and flag the bottom JUNK_SHARE. Pure. */
export function scoreQuality(reads: QualityRead[]): QualityScore[] {
  const cols: [keyof QualityRead, boolean, string][] = [
    ['roa', true, 'low profit for its size'],
    ['cfoa', true, 'little cash from operations'],
    ['accruals', false, 'profit not backed by cash'],
    ['leverage', false, 'heavy debt'],
    ['roaVol', false, 'unstable profits'],
  ];
  const ranks = cols.map(([k, hb]) => pct(reads.map((r) => r[k] as number | null), hb));
  const scores = reads.map((_, i) => {
    const v = ranks.map((r) => r[i]).filter((x): x is number => x != null);
    return v.length >= 3 ? v.reduce((a, b) => a + b, 0) / v.length : null;
  });
  const valid = scores.filter((s): s is number => s != null).sort((a, b) => a - b);
  const cut = valid.length ? valid[Math.floor(valid.length * JUNK_SHARE)] : -1;
  return reads.map((r, i) => ({
    ...r,
    score: scores[i],
    junk: scores[i] != null && scores[i]! < cut,
    weak: cols.filter((_, k) => ranks[k][i] != null && ranks[k][i]! < 0.2).map(([, , why]) => why),
  }));
}
