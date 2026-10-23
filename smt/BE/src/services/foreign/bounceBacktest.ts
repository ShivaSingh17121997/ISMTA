/**
 * Point-in-time monthly backtest of the "Bouncing back" list, and the
 * calibration of the plan's 6-month range. Pure.
 *
 * Same discipline as foreign/backtest.ts: at each month end, use only prices up
 * to that day and SEC annual figures at least 120 days old; a stock is in the
 * universe only from the day it joined the S&P 500; hold for the next month;
 * 0.1% per switch; split in two halves.
 *
 * THE GATE TO SHIP (plan check B3): the full rule, with the business gates,
 * must beat BOTH holding everything equally AND the "fallen 20–75%" basket, in
 * BOTH halves. The second comparator matters most: companies that fell and
 * were then dropped from the index are missing from this data (free sources
 * have no prices for them), which flatters every fallen-stock line. Both
 * fallen-stock lines carry that bias, so beating the plain fallen basket is the
 * fairer test of whether the GATES add anything.
 *
 * What differs from live: the quarterly loss gate, the SEC-event gate and the
 * news veto cannot be replayed (no point-in-time history), so the backtest uses
 * annual profit and the quality veto only.
 */
import type { Candle } from '../../types';
import type { FiscalYear, QualityScore } from './fundamentals';
import { qualityAt, scoreQuality } from './fundamentals';
import { bounceFeatures, bounceScore, bounceVerdict, businessClean, FUNDED, priceGate, MIN_FALL, MAX_FALL } from './bounce';
import { monthEnds, SWITCH_COST } from './backtest';

export interface BounceLine {
  id: 'equal' | 'fallen' | 'bouncePrice' | 'bounce' | 'bounceTop';
  label: string;
  cagr: number;
  maxDD: number;
  halves: [number, number];
  avgHoldings: number;
  /** Months with nothing to hold (sat in cash, 0%). */
  emptyMonths: number;
}

export interface BounceBacktest {
  from: string;
  to: string;
  split: string;
  months: number;
  lines: BounceLine[];
  years: { year: string; equal: number; fallen: number; bounce: number; bouncePrice: number }[];
  /** Plan check B3: the business-gated line beat equal weight AND the fallen basket in both halves. */
  passed: boolean;
  /** The same test for the price-only line (what the page lists). */
  pricePassed: boolean;
  /** Plan check T3: share of 6-month outcomes inside the ±1σ range. */
  calibration: { observations: number; inside: number; above: number; below: number };
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

const cagrOf = (r: number[]) => (r.length ? Math.pow(r.reduce((a, x) => a * (1 + x), 1), 12 / r.length) - 1 : 0);
const ddOf = (r: number[]) => {
  let p = 1;
  let pk = 1;
  let m = 0;
  for (const x of r) {
    p *= 1 + x;
    pk = Math.max(pk, p);
    m = Math.min(m, p / pk - 1);
  }
  return m;
};

/** Annualised volatility of daily log returns over the last 63 sessions, as `measure()` does. */
function vol63(bars: Candle[], upTo: number): number {
  const r: number[] = [];
  for (let k = upTo - 62; k <= upTo; k++) r.push(Math.log(bars[k].close / bars[k - 1].close));
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt((r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1)) * 252);
}

export function runBounceBacktest(input: {
  bars: Map<string, Candle[]>;
  sectors: Map<string, string>;
  ciks: Map<string, number | null>;
  added: Map<string, string | null>;
  fundamentals: Map<number, FiscalYear[]>;
  from?: string;
}): BounceBacktest {
  const datesOf = new Map<string, string[]>();
  for (const [t, b] of input.bars) datesOf.set(t, b.map((c) => istDate(c.timestamp)));
  const last = [...datesOf.values()].reduce((a, d) => (d.length && d[d.length - 1] > a ? d[d.length - 1] : a), '0000');
  const months = monthEnds(input.from ?? '2012-01-01', last);
  if (months[months.length - 1] < last) months.push(last);

  const ids: BounceLine['id'][] = ['equal', 'fallen', 'bouncePrice', 'bounce', 'bounceTop'];
  const rets = new Map(ids.map((id) => [id, [] as number[]] as const));
  const counts = new Map(ids.map((id) => [id, [] as number[]] as const));
  const prevHeld = new Map(ids.map((id) => [id, new Set<string>()] as const));
  const cal = { observations: 0, inside: 0, above: 0, below: 0 };

  for (let k = 0; k < months.length - 1; k++) {
    const date = months[k];
    const next = months[k + 1];
    type Row = { t: string; f: NonNullable<ReturnType<typeof bounceFeatures>>; fwd: number };
    const rows: Row[] = [];
    for (const [t, b] of input.bars) {
      const a = input.added.get(t);
      if (!a || a > date) continue;
      const d = datesOf.get(t)!;
      const i = lastAtOrBefore(d, date);
      if (i < 260 || Date.parse(date) - Date.parse(d[i]) > 7 * 86_400_000) continue;
      const j = lastAtOrBefore(d, next);
      if (j <= i) continue;
      const f = bounceFeatures(b, i);
      if (!f) continue;
      rows.push({ t, f, fwd: b[j].close / b[i].close - 1 });
      // Calibration: is the close ~126 sessions later inside price × e^(±σ√½)?
      if (k % 3 === 0 && i + 126 < b.length) {
        const s = vol63(b, i) * Math.sqrt(0.5);
        const p = b[i].close;
        const later = b[i + 126].close;
        cal.observations++;
        if (later > p * Math.exp(s)) cal.above++;
        else if (later < p * Math.exp(-s)) cal.below++;
        else cal.inside++;
      }
    }
    // Quality is ranked across everyone measured that month, as live does.
    const reads = rows.map((r) => {
      const cik = input.ciks.get(r.t);
      return qualityAt(cik ? input.fundamentals.get(cik) : undefined, date, input.sectors.get(r.t) === 'Financials');
    });
    const qs = scoreQuality(reads);
    const qBy = new Map<string, QualityScore>(rows.map((r, n) => [r.t, qs[n]] as const));

    const fallen = rows.filter((r) => r.f.fall >= MIN_FALL && r.f.fall <= MAX_FALL);
    const bouncePrice = fallen.filter((r) => priceGate(r.f) == null);
    const bounce = bouncePrice.filter((r) => businessClean(bounceVerdict(r.f, { quality: qBy.get(r.t) ?? null })));
    const bounceTop = [...bounce]
      .sort((x, y) => bounceScore({ quality: qBy.get(y.t) ?? null }) - bounceScore({ quality: qBy.get(x.t) ?? null }) || x.t.localeCompare(y.t))
      .slice(0, FUNDED);
    const sets: Record<BounceLine['id'], Row[]> = { equal: rows, fallen, bouncePrice, bounce, bounceTop };
    for (const id of ids) {
      const held = sets[id];
      counts.get(id)!.push(held.length);
      if (!held.length) {
        rets.get(id)!.push(0);
        prevHeld.set(id, new Set());
        continue;
      }
      const now = new Set(held.map((r) => r.t));
      const prev = prevHeld.get(id)!;
      // Same convention as foreign/backtest.ts: 0.1% on the share of names that are new this month.
      const moved = [...now].filter((t) => !prev.has(t)).length / now.size;
      rets.get(id)!.push((1 + held.reduce((a, r) => a + r.fwd, 0) / held.length) * (1 - SWITCH_COST * moved) - 1);
      prevHeld.set(id, now);
    }
  }

  const split = months.findIndex((m) => m >= '2019-05-31');
  const labels: Record<BounceLine['id'], string> = {
    equal: 'Every stock, equally',
    fallen: 'Any stock 20–75% below its high',
    bouncePrice: 'Fallen and turned up (price rules only)',
    bounce: 'Bouncing back: price rules + profitable + not weak finances',
    bounceTop: `Bouncing back, top ${FUNDED} by finances`,
  };
  const lines: BounceLine[] = ids.map((id) => {
    const r = rets.get(id)!;
    const n = counts.get(id)!;
    return {
      id,
      label: labels[id],
      cagr: cagrOf(r),
      maxDD: ddOf(r),
      halves: [cagrOf(r.slice(0, split)), cagrOf(r.slice(split))],
      avgHoldings: n.reduce((a, b) => a + b, 0) / (n.length || 1),
      emptyMonths: n.filter((x) => x === 0).length,
    };
  });
  const by = (id: BounceLine['id']) => lines.find((l) => l.id === id)!;
  const years: BounceBacktest['years'] = [];
  const yearOf = months.slice(1).map((m) => m.slice(0, 4));
  for (const y of [...new Set(yearOf)]) {
    const idx = yearOf.map((v, n) => (v === y ? n : -1)).filter((n) => n >= 0);
    const g = (id: BounceLine['id']) => idx.reduce((a, n) => a * (1 + rets.get(id)![n]), 1) - 1;
    years.push({ year: y, equal: g('equal'), fallen: g('fallen'), bounce: g('bounce'), bouncePrice: g('bouncePrice') });
  }
  const b = by('bounce');
  const beats = (l: BounceLine) => [0, 1].every((h) => l.halves[h] > by('equal').halves[h] && l.halves[h] > by('fallen').halves[h]);
  return {
    from: months[0],
    to: months[months.length - 1],
    split: months[split],
    months: months.length - 1,
    lines,
    years,
    passed: beats(b),
    pricePassed: beats(by('bouncePrice')),
    calibration: cal,
  };
}
