/**
 * Point-in-time monthly backtest of the foreign-stock recommender. Pure.
 *
 * At each month end: measure every stock from bars up to that day only, rank
 * the junk screen from SEC figures available by that day only (120-day lag),
 * score with the medium-horizon scorer, hold the top N equally for the next
 * month. Switching costs 0.1% of the money moved (US brokerage is near zero;
 * spread and slippage remain; the one-off 1.5–2.5% rupee→dollar conversion is
 * outside the comparison because every alternative here pays it too).
 *
 * Compared with: every stock equally weighted (the fair test), the S&P 500
 * index, and the junk basket itself (does the veto remove losers?). The window
 * is split in two; a result must hold in both halves.
 *
 * SURVIVORSHIP: the universe is TODAY's S&P 500. Stocks that fell out of the
 * index are missing, which flatters every line here — the equal-weight line
 * most. The comparison between lines is what matters, not their level.
 */
import type { Candle } from '../../types';
import type { FiscalYear } from './fundamentals';
import { qualityAt, scoreQuality, type QualityScore } from './fundamentals';
import { measureAt, pickTop, scoreForeign } from './score';
import type { Metrics } from '../recommender/metrics';

export const SWITCH_COST = 0.001;

export interface BtLine {
  id: string;
  label: string;
  cagr: number;
  maxDD: number;
  halves: [number, number];
  /** Minus the equal-weight universe, per half, percentage points. */
  edgeHalves: [number, number];
  avgHoldings: number;
}

export interface ForeignBacktest {
  from: string;
  to: string;
  split: string;
  months: number;
  lines: BtLine[];
  /** True when the momentum list (what the page recommends) beat equal weight in both halves. */
  worked: boolean;
  /** True when the junk basket trailed the rest in both halves. */
  vetoWorked: boolean;
}

const istDate = (ts: number): string => new Date(ts + 19_800_000).toISOString().slice(0, 10);

/** Index of the last bar on or before `date`. */
function idxAt(bars: Candle[], dates: string[], date: string): number {
  let lo = 0;
  let hi = dates.length - 1;
  if (!dates.length || dates[0] > date) return -1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (dates[m] <= date) lo = m;
    else hi = m - 1;
  }
  void bars;
  return lo;
}

export function monthEnds(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  for (;;) {
    const d = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    if (d > to) break;
    out.push(d);
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export function runForeignBacktest(input: {
  bars: Map<string, Candle[]>;
  sectors: Map<string, string>;
  ciks: Map<string, number | null>;
  fundamentals: Map<number, FiscalYear[]>;
  /**
   * Ticker → date it joined the index. A stock is in the month-t universe only
   * if it joined on or before t: companies join AFTER big runs, so using today's
   * list for the past would hold them through runs made before they qualified.
   * Tickers absent from the map are excluded (ADRs: today's hand-picked giants).
   */
  added?: Map<string, string | null>;
  index?: Candle[];
  from?: string;
  topN?: number;
}): ForeignBacktest {
  const topN = input.topN ?? 20;
  const datesOf = new Map<string, string[]>();
  for (const [t, b] of input.bars) datesOf.set(t, b.map((c) => istDate(c.timestamp)));
  const last = [...datesOf.values()].reduce((a, d) => (d.length && d[d.length - 1] > a ? d[d.length - 1] : a), '0000');
  const months = monthEnds(input.from ?? '2012-01-01', last);
  if (months[months.length - 1] < last) months.push(last);
  const priceAt = (t: string, date: string): number | null => {
    const b = input.bars.get(t)!;
    const k = idxAt(b, datesOf.get(t)!, date);
    // Stale by more than a week = not trading then (not yet listed, or suspended).
    if (k < 0 || Date.parse(date) - Date.parse(datesOf.get(t)![k]) > 7 * 86_400_000) return null;
    return b[k].close;
  };

  type Pick = { recommended: string[]; momentumOnly: string[]; uncapped: string[]; junk: string[]; clean: string[]; all: string[] };
  const picks: Pick[] = [];
  for (let k = 0; k < months.length - 1; k++) {
    const date = months[k];
    const metrics: Metrics[] = [];
    for (const [t, b] of input.bars) {
      if (input.added) {
        const a = input.added.get(t);
        if (!a || a > date) continue;
      }
      const i = idxAt(b, datesOf.get(t)!, date);
      if (i < 0 || priceAt(t, date) == null) continue;
      const m = measureAt(t, b, i);
      if (m) metrics.push(m);
    }
    const syms = metrics.map((m) => m.symbol);
    const reads = syms.map((s) => {
      const cik = input.ciks.get(s);
      return qualityAt(cik ? input.fundamentals.get(cik) : undefined, date, input.sectors.get(s) === 'Financials');
    });
    const scored = scoreQuality(reads);
    const quality = new Map<string, QualityScore>(syms.map((s, i) => [s, scored[i]] as const));
    const withVeto = scoreForeign(metrics, input.sectors, quality, { vetoJunk: true });
    const without = scoreForeign(metrics, input.sectors, quality, { vetoJunk: false });
    picks.push({
      recommended: pickTop(withVeto, topN, input.sectors).map((s) => s.symbol),
      momentumOnly: pickTop(without, topN, input.sectors).map((s) => s.symbol),
      uncapped: without.filter((s) => !s.vetoed).slice(0, topN).map((s) => s.symbol),
      junk: syms.filter((s) => quality.get(s)?.junk),
      clean: syms.filter((s) => quality.get(s)?.score != null && !quality.get(s)!.junk),
      all: syms,
    });
  }

  const mid = Math.floor((months.length - 1) / 2);
  const run = (choose: (p: Pick) => string[]): { values: number[]; avg: number } => {
    const values = [1];
    let prev = new Set<string>();
    let held = 0;
    for (let k = 0; k < months.length - 1; k++) {
      const sel = choose(picks[k]);
      let r = 0;
      let n = 0;
      for (const t of sel) {
        const a = priceAt(t, months[k]);
        const b = priceAt(t, months[k + 1]);
        if (a == null || b == null) continue;
        r += b / a - 1;
        n++;
      }
      const ret = n ? r / n : 0;
      const moved = sel.length ? sel.filter((s) => !prev.has(s)).length / sel.length : 0;
      values.push(values[values.length - 1] * (1 + ret) * (1 - SWITCH_COST * moved));
      prev = new Set(sel);
      held += n;
    }
    return { values, avg: held / Math.max(1, months.length - 1) };
  };
  const stats = (v: number[]): { cagr: number; maxDD: number; halves: [number, number] } => {
    const c = (a: number, b: number) => (b > a ? (v[b] / v[a]) ** (12 / (b - a)) - 1 : 0);
    let peak = v[0];
    let dd = 0;
    for (const x of v) {
      peak = Math.max(peak, x);
      dd = Math.min(dd, x / peak - 1);
    }
    return { cagr: c(0, v.length - 1), maxDD: dd, halves: [c(0, mid), c(mid, v.length - 1)] };
  };
  const lines: BtLine[] = [];
  const add = (id: string, label: string, r: { values: number[]; avg: number }): void => {
    lines.push({ id, label, ...stats(r.values), edgeHalves: [0, 0], avgHoldings: Math.round(r.avg) });
  };
  add('equal', 'Every stock, equal weight', run((p) => p.all));
  add('momentum', `Top ${topN} by momentum, max 4 per sector (what this page recommends)`, run((p) => p.momentumOnly));
  add('uncapped', `Top ${topN} by momentum, no sector cap`, run((p) => p.uncapped));
  add('momentumVeto', `Top ${topN} by momentum, max 4 per sector, weak finances excluded`, run((p) => p.recommended));
  add('clean', 'All stocks except junk', run((p) => p.clean));
  add('junk', 'Junk basket only (weakest 20% on quality)', run((p) => p.junk));
  if (input.index?.length) {
    const ix = input.index;
    const ixDates = ix.map((c) => istDate(c.timestamp));
    const at = (d: string): number => ix[idxAt(ix, ixDates, d)].close;
    const v = [1];
    for (let k = 0; k < months.length - 1; k++) v.push(v[v.length - 1] * (at(months[k + 1]) / at(months[k])));
    lines.push({ id: 'index', label: 'S&P 500 index', ...stats(v), edgeHalves: [0, 0], avgHoldings: 500 });
  }
  const base = lines[0];
  for (const l of lines) l.edgeHalves = [Math.round((l.halves[0] - base.halves[0]) * 10000) / 100, Math.round((l.halves[1] - base.halves[1]) * 10000) / 100];
  const rec = lines.find((l) => l.id === 'momentum')!;
  const junk = lines.find((l) => l.id === 'junk')!;
  const clean = lines.find((l) => l.id === 'clean')!;
  return {
    from: months[0],
    to: months[months.length - 1],
    split: months[mid],
    months: months.length - 1,
    lines,
    worked: rec.edgeHalves[0] > 0 && rec.edgeHalves[1] > 0,
    vetoWorked: junk.halves[0] < clean.halves[0] && junk.halves[1] < clean.halves[1],
  };
}
