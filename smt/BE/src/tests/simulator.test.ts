/**
 * The portfolio backtest (services/backtest/accumulatorSim) on synthetic bars.
 * No network. Checks the measurement itself: window, drawdown, CAGR, ETF
 * pricing, the regime read, the allocator and the sweep, and that money is
 * conserved through all of them.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import {
  cagrPct,
  adjustForSplits,
  dropBadPrints,
  capitalAtWork,
  exposureMatched,
  fixedRateSeries,
  maxDrawdownPct,
  seriesStats,
  simulatePortfolio,
  type SimOptions,
  type SimRun,
} from '../services/backtest/accumulatorSim';
import { DEFAULT_ACCUMULATOR_PARAMS } from '../services/accumulator/types';
import type { Candle } from '../types';

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push(`  ✗ ${name}\n    ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
}

const DAY = 86_400_000;
const START = Date.parse('2020-01-01T04:00:00Z'); // 09:30 IST

/** Weekday daily bars from a price path; high/low a fixed band around the close. */
function bars(path: number[], band = 0.01): Candle[] {
  const out: Candle[] = [];
  let t = START;
  for (let i = 0; i < path.length; i++) {
    while ([0, 6].includes(new Date(t).getUTCDay())) t += DAY;
    const c = path[i];
    const o = i ? path[i - 1] : c;
    out.push({ timestamp: t, open: o, high: Math.max(o, c) * (1 + band), low: Math.min(o, c) * (1 - band), close: c, volume: 1 } as Candle);
    t += DAY;
  }
  return out;
}

/** Deterministic wave around a trend: dips that recover, so the ladder trades. */
function wave(n: number, start: number, driftPerBar: number, amp = 0.08, period = 40): number[] {
  return Array.from({ length: n }, (_, i) => start * (1 + driftPerBar) ** i * (1 + amp * Math.sin((2 * Math.PI * i) / period)));
}

const base: SimOptions = {
  years: 2,
  capital: 200_000,
  params: DEFAULT_ACCUMULATOR_PARAMS,
  regime: 'off',
  sizing: 'equal',
};

/** Equity rebuilt from the run's own ledgers. Must equal the curve's last point. */
function ledgerEquity(run: SimRun, capital: number): number {
  const unrealised = run.openLots.reduce((a, l) => a + l.cost * (l.pctVsCost / 100), 0);
  return capital + run.realisedPnl + unrealised + run.sweepGain;
}

// ─── helpers ──────────────────────────────────────────────────────────────
test('CAGR uses the real number of years', () => {
  assert.equal(Math.round(cagrPct(100, 121, 2) * 100) / 100, 10);
  assert.equal(cagrPct(100, 100, 0), 0);
});

test('max drawdown is peak to trough of the series given', () => {
  assert.equal(maxDrawdownPct([100, 120, 90, 130, 117]), 25);
});

test('halves split the window, so a sign flip is visible', () => {
  const days = ['2020-01-01', '2021-01-01', '2022-01-01'];
  const s = seriesStats([100, 120, 108], days);
  assert.ok(s.halves[0] > 19 && s.halves[0] < 21);
  assert.ok(s.halves[1] < 0);
});

test('exposure-matched at w=0 is the cash series and at w=1 is the basket', () => {
  const days = ['2020-01-01', '2020-07-01', '2021-01-01'];
  const basket = [100, 80, 130];
  const cash = fixedRateSeries(100, days, 6);
  exposureMatched(basket, days, 0, 6).forEach((v, i) => assert.ok(Math.abs(v - cash[i]) < 1e-9));
  exposureMatched(basket, days, 1, 6).forEach((v, i) => assert.ok(Math.abs(v - basket[i]) < 1e-9));
});

// ─── the run ──────────────────────────────────────────────────────────────
const threeYears = 3 * 252;
const dataA = new Map([
  ['AAA', bars(wave(threeYears, 100, 0.0004))],
  ['BBB', bars(wave(threeYears, 50, 0.0002, 0.1, 55))],
]);

test('the window is exactly the years asked for, ending on the last bar', () => {
  const run = simulatePortfolio(dataA, base);
  assert.ok(Math.abs(run.years - 2) < 0.02, `window ${run.years}y`);
  assert.equal(run.curve[run.curve.length - 1].day, run.to);
});

test('the ladder actually trades on a recovering wave', () => {
  const run = simulatePortfolio(dataA, base);
  assert.ok(run.roundTrips > 5, `only ${run.roundTrips} trips`);
  assert.ok(capitalAtWork(run) > 0 && capitalAtWork(run) < 1);
});

test('portfolio drawdown comes from the summed curve, never above the worst single book', () => {
  // Two books that move opposite ways: the portfolio's drawdown must be no
  // worse than either alone (the old script averaged per-book drawdowns).
  const up = wave(threeYears, 100, 0.0003, 0.08, 40);
  const down = up.map((v, i) => 100 * (1 + 0.08 * Math.sin((2 * Math.PI * i) / 40 + Math.PI)) * (1 + 0.0003) ** i);
  const data = new Map([['UPX', bars(up)], ['DNX', bars(down)]]);
  const both = simulatePortfolio(data, base);
  const one = simulatePortfolio(new Map([['UPX', bars(up)]]), { ...base, capital: 100_000 });
  const two = simulatePortfolio(new Map([['DNX', bars(down)]]), { ...base, capital: 100_000 });
  const dd = (r: SimRun) => maxDrawdownPct(r.curve.map((p) => p.equity));
  assert.ok(dd(both) <= Math.max(dd(one), dd(two)) + 1e-9);
});

test('an ETF is priced as an ETF: lower charges on the same trades than a stock', () => {
  const data = new Map([['FUNDX', bars(wave(threeYears, 200, 0.0003))]]);
  const asStock = simulatePortfolio(data, base);
  const asEtf = simulatePortfolio(data, { ...base, etfs: new Set(['FUNDX']) });
  assert.ok(asEtf.roundTrips > 0);
  assert.ok(asEtf.bookCharges < asStock.bookCharges, `${asEtf.bookCharges} vs ${asStock.bookCharges}`);
});

test('reading the regime lets lots ride an uptrend past their target', () => {
  // A steady climb with shallow pullbacks: EMA20 well above EMA50.
  const data = new Map([['RISE', bars(wave(threeYears, 100, 0.0015, 0.04, 30), 0.02)]]);
  const off = simulatePortfolio(data, base);
  const on = simulatePortfolio(data, { ...base, regime: 'regime' });
  assert.equal(off.armedExits, 0, 'without a regime read nothing arms on intraday moves');
  assert.ok(on.armedExits > 0, 'with it, lots arm at target and ride');
});

test('money is conserved: equity equals capital plus realised, unrealised and sweep gains', () => {
  for (const opts of [
    base,
    { ...base, regime: 'auto' as const },
    { ...base, sizing: 'allocator' as const },
    { ...base, sizing: 'allocator' as const, sweepYieldPct: 6 },
    { ...base, sweepYieldPct: 6, sweepUnassigned: true },
  ]) {
    const run = simulatePortfolio(dataA, opts);
    const last = run.curve[run.curve.length - 1].equity;
    assert.ok(Math.abs(last - ledgerEquity(run, opts.capital)) < 1, `${opts.sizing}/${opts.regime}/${opts.sweepYieldPct}: ${last} vs ${ledgerEquity(run, opts.capital)}`);
  }
});

test('the allocator funds nothing in a downtrend, and the money just sits', () => {
  const fall = Array.from({ length: threeYears }, (_, i) => 100 * 0.999 ** i);
  const run = simulatePortfolio(new Map([['FALL', bars(fall)]]), { ...base, sizing: 'allocator' });
  assert.equal(run.roundTrips, 0);
  assert.equal(run.openLots.length, 0);
  assert.ok(Math.abs(run.curve[run.curve.length - 1].equity - base.capital) < 1e-6);
});

test('the sweep earns on idle cash, net of its charges', () => {
  const fall = Array.from({ length: threeYears }, (_, i) => 100 * 0.999 ** i);
  const data = new Map([['FALL', bars(fall)]]);
  const opts = { ...base, sizing: 'allocator' as const, sweepYieldPct: 6, sweepUnassigned: true };
  const run = simulatePortfolio(data, opts);
  const end = run.curve[run.curve.length - 1].equity;
  // 2 years at 6% on ~₹1.9L parked is ~₹23k; charges are small.
  assert.ok(end > base.capital * 1.10 && end < base.capital * 1.13, `end ${end}`);
  assert.ok(run.sweepCharges > 0);
});

test('the live sweep parks only book cash, so unassigned money does not earn', () => {
  const fall = Array.from({ length: threeYears }, (_, i) => 100 * 0.999 ** i);
  const run = simulatePortfolio(new Map([['FALL', bars(fall)]]), { ...base, sizing: 'allocator', sweepYieldPct: 6 });
  assert.ok(Math.abs(run.curve[run.curve.length - 1].equity - base.capital) < 1e-6);
});

test('an unadjusted 1:10 split is back-adjusted, so it is not read as a 90% crash', () => {
  const path = Array.from({ length: 100 }, (_, i) => (i < 50 ? 200 : 20) * (1 + 0.001 * i));
  const raw = bars(path, 0.005).map((c, i) => (i === 50 ? { ...c, open: c.close } : c));
  const split = { type: 'SPLIT' as const, exDate: raw[50].timestamp, ratio: { from: 1, to: 10 } };
  const { bars: adj, adjustments } = adjustForSplits(raw, [split]);
  assert.equal(adjustments[0].applied, true);
  assert.ok(maxDrawdownPct(adj.map((c) => c.close)) < 5, `drawdown ${maxDrawdownPct(adj.map((c) => c.close))}`);
  assert.equal(adj[60].close, raw[60].close, 'bars from the ex-date on are untouched');
});

test('a split Yahoo already adjusted is left alone', () => {
  const path = Array.from({ length: 100 }, (_, i) => 20 * (1 + 0.001 * i));
  const raw = bars(path, 0.005);
  const split = { type: 'SPLIT' as const, exDate: raw[50].timestamp, ratio: { from: 1, to: 10 } };
  const { bars: adj, adjustments } = adjustForSplits(raw, [split]);
  assert.equal(adjustments[0].applied, false);
  assert.deepEqual(adj, raw);
});

test('a 1:1 bonus halves the prices before it', () => {
  const path = Array.from({ length: 60 }, (_, i) => (i < 30 ? 1000 : 500));
  const raw = bars(path, 0.005).map((c, i) => (i === 30 ? { ...c, open: 500 } : c));
  const bonus = { type: 'BONUS' as const, exDate: raw[30].timestamp, ratio: { from: 1, to: 1 } };
  const { bars: adj } = adjustForSplits(raw, [bonus]);
  assert.equal(adj[10].close, 500);
});

test('a two-day bad print at a tenth of the price is dropped', () => {
  const path = Array.from({ length: 30 }, (_, i) => (i === 10 || i === 11 ? 13 : 130));
  const { bars: clean, dropped } = dropBadPrints(bars(path));
  assert.equal(dropped.length, 2);
  assert.equal(clean.length, 28);
  assert.ok(clean.every((c) => c.close === 130));
});

test('a real crash that does not snap back is kept', () => {
  const path = Array.from({ length: 30 }, (_, i) => (i < 10 ? 100 : 30 + i * 0.1));
  const { bars: clean, dropped } = dropBadPrints(bars(path));
  assert.equal(dropped.length, 0);
  assert.equal(clean.length, 30);
});

test('ordinary daily moves are never dropped', () => {
  const { dropped } = dropBadPrints(bars(wave(500, 100, 0.0005, 0.15, 20)));
  assert.equal(dropped.length, 0);
});

test('monthly bars are refused, never read as days', () => {
  const monthly = bars(wave(120, 100, 0.01)).map((c, i) => ({ ...c, timestamp: START + i * 30 * DAY }));
  assert.throws(() => simulatePortfolio(new Map([['MON', monthly]]), base), /daily bars are required/);
});

if (failures.length) {
  console.error(`✗ simulator: ${failures.length} failed, ${passed} passed`);
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`✓ simulator: ${passed} passed`);
