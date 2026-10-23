/**
 * Short-, intermediate- and long-term targets for the top picks, built from
 * what past top picks actually did. Pure.
 *
 * THE METHOD. At every month end since 2012, the live list is rebuilt point in
 * time (same scorer, same sector cap, only stocks already in the S&P 500, SEC
 * figures 120 days old). For each pick, the return over the next 21, 126 and
 * 252 trading days is recorded in units of that stock's own volatility:
 *     z = ln(P[t+h] / P[t]) / (σ · √(h/252))
 * The 25th, 50th and 75th percentiles of z, multiplied back by a stock's
 * volatility today, give its base case (median) and its middle range (half of
 * past outcomes landed inside).
 *
 * VOLATILITY BUCKETS. Returns do NOT grow in proportion to volatility: over a
 * year the median z of past picks was 0.64 for the calmest third, 0.54 for the
 * middle and 0.41 for the wildest (2026-10-14). One scale for all would promise
 * a 120%-volatility stock +87% a year. So the percentiles are fitted per
 * volatility third, and the DRIFT part (the median) uses a volatility capped at
 * the bucket's 90th percentile; the spread around it uses the stock's own
 * volatility, because a wild stock's range really is wide.
 *
 * THE CHECKS (FOREIGN_RECS_CHECKLIST.md, H1–H3):
 *   H1 per horizon, did the picks beat the average stock in BOTH halves? A
 *      horizon that did not is labelled "no measured edge", and its target is
 *      shown as a range around the market-like drift, not as a reason to buy.
 *   H2 out of sample: percentiles fitted on the first half, tested on the
 *      second. About 50% of outcomes should land inside the middle range and
 *      about 50% above the base case.
 *   H3 overlap: monthly samples of 6- and 12-month returns overlap, so the
 *      counts overstate the independent evidence; the page says so.
 */
import type { Candle } from '../../types';
import type { FiscalYear, QualityScore } from './fundamentals';
import { qualityAt, scoreQuality } from './fundamentals';
import { measureAt, pickNextTier, pickTop, scoreForeign } from './score';
import { monthEnds } from './backtest';
import type { Metrics } from '../recommender/metrics';

export type HorizonKey = 'short' | 'medium' | 'long';
export const HORIZONS: { key: HorizonKey; days: number; label: string }[] = [
  { key: 'short', days: 21, label: 'Short term (1 month)' },
  { key: 'medium', days: 126, label: 'Intermediate (6 months)' },
  { key: 'long', days: 252, label: 'Long term (1 year)' },
];

export interface HorizonStat {
  key: HorizonKey;
  days: number;
  label: string;
  /** Samples (pick-months) with a complete forward window. */
  n: number;
  /** The fitted model (all months), per volatility bucket. */
  model: BandModel;
  /** Share of past picks that were up at the end of the horizon. */
  upRate: number;
  /** Mean simple return of picks and of all eligible stocks, per half. */
  picksMean: [number, number];
  allMean: [number, number];
  /** H1: picks beat the average stock in both halves. */
  edge: boolean;
  /** H2: out-of-sample, fit on half 1, test on half 2. */
  oos: { n: number; insideMiddle: number; aboveBase: number };
}

export interface Bucket {
  /** Upper volatility bound of the bucket (annual fraction); Infinity for the last (null once stored as JSON). */
  maxSigma: number | null;
  /** Volatility used for the drift (median) part: the bucket's 90th percentile. */
  driftCap: number;
  zP25: number;
  zP50: number;
  zP75: number;
  n: number;
}
export interface BandModel {
  days: number;
  buckets: Bucket[];
}

/** Low / base / high RETURNS for a stock of volatility `sigma` (annual fraction). Pure. */
export function bandFor(model: BandModel, sigma: number): { low: number; base: number; high: number } {
  // The last bucket is open-ended: Infinity in memory, null after a JSON round trip.
  const b = model.buckets.find((x) => x.maxSigma == null || sigma <= x.maxSigma) ?? model.buckets[model.buckets.length - 1];
  const t = Math.sqrt(model.days / 252);
  const drift = b.zP50 * Math.min(sigma, b.driftCap) * t;
  return {
    low: Math.exp(drift + (b.zP25 - b.zP50) * sigma * t) - 1,
    base: Math.exp(drift) - 1,
    high: Math.exp(drift + (b.zP75 - b.zP50) * sigma * t) - 1,
  };
}

type Fit = { z: number; sigma: number };
/** Fit per-volatility-third percentiles. Pure. */
export function fitBands(obs: Fit[], days: number): BandModel {
  const sig = obs.map((o) => o.sigma).sort((a, b) => a - b);
  const cuts = [quantile(sig, 1 / 3), quantile(sig, 2 / 3), Infinity];
  let lower = -Infinity;
  const buckets = cuts.map((maxSigma) => {
    const g = obs.filter((o) => o.sigma > lower && o.sigma <= maxSigma);
    lower = maxSigma;
    const z = g.map((o) => o.z).sort((a, b) => a - b);
    const sg = g.map((o) => o.sigma).sort((a, b) => a - b);
    return { maxSigma, driftCap: quantile(sg, 0.9), zP25: quantile(z, 0.25), zP50: quantile(z, 0.5), zP75: quantile(z, 0.75), n: g.length };
  });
  return { days, buckets };
}

export interface HorizonStudy {
  from: string;
  to: string;
  split: string;
  /** The top 20 (ranks 1–20). */
  stats: HorizonStat[];
  /** The second tier (ranks 21–40), measured separately: weaker scores need their own evidence. */
  stats2: HorizonStat[];
}

const istDate = (ts: number): string => new Date(ts + 19_800_000).toISOString().slice(0, 10);

function lastAtOrBefore(dates: string[], date: string): number {
  if (!dates.length || dates[0] > date) return -1;
  let lo = 0;
  let hi = dates.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (dates[m] <= date) lo = m;
    else hi = m - 1;
  }
  return lo;
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function runHorizonStudy(input: {
  bars: Map<string, Candle[]>;
  sectors: Map<string, string>;
  ciks: Map<string, number | null>;
  added: Map<string, string | null>;
  fundamentals: Map<number, FiscalYear[]>;
  from?: string;
  topN?: number;
}): HorizonStudy {
  const topN = input.topN ?? 20;
  const datesOf = new Map<string, string[]>();
  for (const [t, b] of input.bars) datesOf.set(t, b.map((c) => istDate(c.timestamp)));
  const last = [...datesOf.values()].reduce((a, d) => (d.length && d[d.length - 1] > a ? d[d.length - 1] : a), '0000');
  const months = monthEnds(input.from ?? '2012-01-01', last);
  const splitIdx = months.findIndex((m) => m >= '2019-05-31');

  type Obs = { z: number; r: number; half: 0 | 1; sigma: number };
  const picksObs = HORIZONS.map(() => [] as Obs[]);
  const tier2Obs = HORIZONS.map(() => [] as Obs[]);
  const allObs = HORIZONS.map(() => [] as Obs[]);

  for (let k = 0; k < months.length; k++) {
    const date = months[k];
    const half: 0 | 1 = k < splitIdx ? 0 : 1;
    const metrics: Metrics[] = [];
    const idx = new Map<string, number>();
    for (const [t, b] of input.bars) {
      const a = input.added.get(t);
      if (!a || a > date) continue;
      const d = datesOf.get(t)!;
      const i = lastAtOrBefore(d, date);
      if (i < 0 || Date.parse(date) - Date.parse(d[i]) > 7 * 86_400_000) continue;
      const m = measureAt(t, b, i);
      if (!m) continue;
      metrics.push(m);
      idx.set(t, i);
    }
    if (!metrics.length) continue;
    const syms = metrics.map((m) => m.symbol);
    const qs = scoreQuality(
      syms.map((s) => {
        const cik = input.ciks.get(s);
        return qualityAt(cik ? input.fundamentals.get(cik) : undefined, date, input.sectors.get(s) === 'Financials');
      }),
    );
    const quality = new Map<string, QualityScore>(syms.map((s, n) => [s, qs[n]] as const));
    // Exactly the live list: ranked without the junk veto, sector-capped.
    const scored = scoreForeign(metrics, input.sectors, quality, { vetoJunk: false });
    const picked = new Set(pickTop(scored, topN, input.sectors).map((s) => s.symbol));
    const picked2 = new Set(pickNextTier(scored, picked, topN, input.sectors).map((s) => s.symbol));
    const eligible = scored.filter((s) => !s.vetoed).map((s) => s.symbol);
    const mBy = new Map(metrics.map((m) => [m.symbol, m] as const));
    for (const t of eligible) {
      const b = input.bars.get(t)!;
      const i = idx.get(t)!;
      const sigma = mBy.get(t)!.volAnnualPct / 100;
      if (!(sigma > 0)) continue;
      HORIZONS.forEach((h, n) => {
        if (i + h.days >= b.length) return;
        const r = b[i + h.days].close / b[i].close - 1;
        const o: Obs = { z: Math.log(1 + r) / (sigma * Math.sqrt(h.days / 252)), r, half, sigma };
        allObs[n].push(o);
        if (picked.has(t)) picksObs[n].push(o);
        else if (picked2.has(t)) tier2Obs[n].push(o);
      });
    }
  }

  const statsOf = (obs: Obs[][]): HorizonStat[] => HORIZONS.map((h, n) => {
    const p = obs[n];
    const byHalf = (xs: Obs[], hf: 0 | 1) => mean(xs.filter((o) => o.half === hf).map((o) => o.r));
    const picksMean: [number, number] = [byHalf(p, 0), byHalf(p, 1)];
    const allMean: [number, number] = [byHalf(allObs[n], 0), byHalf(allObs[n], 1)];
    // H2: fit on the first half only, then test the exact target formula on the second.
    const train = fitBands(p.filter((o) => o.half === 0), h.days);
    const test = p.filter((o) => o.half === 1);
    let inside = 0;
    let above = 0;
    for (const o of test) {
      const b = bandFor(train, o.sigma);
      if (o.r >= b.low && o.r <= b.high) inside++;
      if (o.r > b.base) above++;
    }
    return {
      key: h.key,
      days: h.days,
      label: h.label,
      n: p.length,
      model: fitBands(p, h.days),
      upRate: p.length ? p.filter((o) => o.r > 0).length / p.length : 0,
      picksMean,
      allMean,
      edge: picksMean[0] > allMean[0] && picksMean[1] > allMean[1],
      oos: { n: test.length, insideMiddle: test.length ? inside / test.length : 0, aboveBase: test.length ? above / test.length : 0 },
    };
  });
  return { from: months[0], to: months[months.length - 1], split: months[splitIdx], stats: statsOf(picksObs), stats2: statsOf(tier2Obs) };
}

export interface HorizonTarget {
  key: HorizonKey;
  label: string;
  days: number;
  base: number;
  low: number;
  high: number;
  basePct: number;
  lowPct: number;
  highPct: number;
  upRate: number;
  edge: boolean;
}

/** One stock's targets from its price and volatility (annual %, as `measure()` gives). Tier 2 uses its own fit. Pure. */
export function targetsFor(price: number, volAnnualPct: number, study: HorizonStudy | null, tier: 1 | 2 = 1): HorizonTarget[] {
  if (!study) return [];
  const stats = tier === 2 ? study.stats2 ?? [] : study.stats;
  const sigma = volAnnualPct / 100;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return stats.map((s) => {
    const b = bandFor(s.model, sigma);
    return {
      key: s.key,
      label: s.label,
      days: s.days,
      base: r2(price * (1 + b.base)),
      low: r2(price * (1 + b.low)),
      high: r2(price * (1 + b.high)),
      basePct: b.base,
      lowPct: b.low,
      highPct: b.high,
      upRate: s.upRate,
      edge: s.edge,
    };
  });
}
