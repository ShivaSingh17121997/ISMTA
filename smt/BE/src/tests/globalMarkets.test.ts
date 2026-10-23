/**
 * Global Markets tests: rupee conversion, metrics, ranking and the backtest.
 *
 * The guards that matter:
 *   - returns are in RUPEES, using the right direction of each FX quote;
 *   - the backtest ranks at month t from data up to t only, and earns month t+1;
 *   - fixed mixes rebalance to their weights; '*foreign' spreads equally;
 *   - "the ranking worked" needs both top-N strategies ahead in both halves.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { metricsOf, momentumScores, monthlyCorrelation, pctRanks, toInr } from '../services/global/rank';
import { monthEnds, runBacktest } from '../services/global/backtest';
import { COUNTRIES } from '../services/global/universe';
import { ACCESS_ROUTES, INDIA_ETFS, parseAmfiNav } from '../services/global/access';
import type { Series } from '../services/marketWeather/series';

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

function days(start: string, n: number): string[] {
  const out: string[] = [];
  let t = Date.parse(`${start}T00:00:00Z`);
  while (out.length < n) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}
const ser = (key: string, dates: string[], f: (i: number) => number): Series => ({ key, dates, close: dates.map((_, i) => f(i)) });

test('toInr: USD-per-local quotes multiply, local-per-USD quotes divide', () => {
  const d = days('2024-01-01', 3);
  const inr = ser('INR=X', d, () => 80);
  const local = ser('IDX', d, () => 100);
  const eur = toInr(local, ser('EURUSD=X', d, () => 1.1), { ticker: 'EURUSD=X', invert: false }, inr);
  assert.ok(Math.abs(eur.close[0] - 100 * 1.1 * 80) < 1e-9);
  const jpy = toInr(local, ser('JPY=X', d, () => 150), { ticker: 'JPY=X', invert: true }, inr);
  assert.ok(Math.abs(jpy.close[0] - (100 / 150) * 80) < 1e-9);
  const usd = toInr(local, null, null, inr);
  assert.equal(usd.close[0], 8000);
  assert.equal(toInr(local, null, null, inr, true).close[0], 100, 'India is already in rupees');
});

test('a market flat in local currency still gains in rupees when its currency rises', () => {
  const d = days('2023-01-02', 600);
  const local = ser('IDX', d, () => 100);
  const fx = ser('EURUSD=X', d, (i) => 1 + i * 0.0005);
  const m = metricsOf(toInr(local, fx, { ticker: 'EURUSD=X', invert: false }, ser('INR=X', d, () => 80)))!;
  assert.ok(m.ret12m! > 0.1, `12m in rupees ${m.ret12m}`);
  assert.equal(metricsOf(local)!.ret12m, 0);
});

test('metrics: skip-month momentum, uptrend, drawdown', () => {
  const d = days('2020-01-01', 900);
  const s = ser('X', d, (i) => 100 * Math.exp(i * 0.001));
  const m = metricsOf(s)!;
  assert.ok(m.mom12_1! > 0.2 && m.mom12_1! < m.ret12m!, 'skipping the last month gives a smaller number on a steady rise');
  assert.equal(m.uptrend, true);
  assert.equal(m.maxDD3y, 0);
  assert.equal(metricsOf(ser('Y', d.slice(0, 100), () => 1)), null, 'needs a year of history');
});

test('percentile ranks share ties and ignore nulls', () => {
  assert.deepEqual(pctRanks([3, null, 1, 3]), [0.75, null, 0, 0.75]);
  const ms = [metricsOf(ser('a', days('2020-01-01', 400), (i) => 100 + i))!, null];
  assert.deepEqual(momentumScores(ms).map((x) => x != null), [true, false]);
});

test('correlation of a series with itself is 1, and needs 2 years of months', () => {
  const d = days('2018-01-01', 1600);
  const a = ser('a', d, (i) => 100 + Math.sin(i / 20) * 10 + i * 0.05);
  assert.equal(monthlyCorrelation(a, a), 1);
  assert.equal(monthlyCorrelation(ser('b', d.slice(0, 300), (i) => i + 1), ser('c', d.slice(0, 300), (i) => i + 1)), null);
});

test('monthEnds lists the last day of each month', () => {
  assert.deepEqual(monthEnds('2024-01-15', '2024-04-10'), ['2024-01-31', '2024-02-29', '2024-03-31']);
});

test('backtest: the ranking at month t earns month t+1, never month t', () => {
  // A market that jumps 50% in one month and is flat otherwise. A rule with look-ahead
  // would hold it during the jump; a rule without it only sees the jump afterwards.
  const d = days('2004-01-01', 4000);
  const jumpAt = d.findIndex((x) => x >= '2012-06-15');
  const markets = new Map<string, Series>();
  markets.set('JUMP', ser('JUMP', d, (i) => (i >= jumpAt ? 150 : 100)));
  for (const k of ['A', 'B', 'C', 'D']) markets.set(k, ser(k, d, (i) => 100 * Math.exp(i * 0.0002 * (k.charCodeAt(0) - 64))));
  const bt = runBacktest(markets, { candidates: ['JUMP', 'A', 'B', 'C', 'D'], benchmarks: {}, topN: [1], trendGate: false });
  const top1 = bt.strategies.find((s) => s.id === 'top1')!;
  const ew = bt.strategies.find((s) => s.id === 'equalWeight')!;
  const jumpMonth = top1.curve.findIndex((p) => p.month >= '2012-06-30');
  const top1Gain = top1.curve[jumpMonth].value / top1.curve[jumpMonth - 1].value - 1;
  assert.ok(top1Gain < 0.05, `top-1 captured ${top1Gain} of a jump it could not have seen coming`);
  assert.ok(ew.curve[jumpMonth].value / ew.curve[jumpMonth - 1].value - 1 > 0.08, 'equal weight holds it and gets a fifth of the jump');
});

test('backtest: mixes rebalance to weights; "*foreign" spreads equally', () => {
  const d = days('2004-01-01', 3000);
  const markets = new Map<string, Series>([
    ['IN', ser('IN', d, () => 100)],
    ['X', ser('X', d, (i) => 100 * Math.exp(i * 0.0004))],
    ['Y', ser('Y', d, () => 100)],
  ]);
  const bt = runBacktest(markets, {
    candidates: ['X', 'Y'],
    benchmarks: { india: 'IN' },
    topN: [],
    mixes: [{ id: 'm', label: 'mix', weights: { IN: 0.5, '*foreign': 0.5 } }],
  });
  const m = bt.strategies.find((s) => s.id === 'm')!;
  const x = bt.strategies.find((s) => s.id === 'equalWeight')!;
  // half in a flat market, half in an equal-weight basket of X and flat Y ≈ a quarter of X's growth
  assert.ok(m.cagr > 0 && m.cagr < x.cagr, `${m.cagr} vs ${x.cagr}`);
  assert.equal(bt.rankingWorked, false, 'no top-N strategies → nothing "worked"');
});

test('every covered country has a usable access entry or is India', () => {
  for (const c of COUNTRIES) {
    if (c.code === 'IN') continue;
    const a = ACCESS_ROUTES[c.code];
    assert.ok(a, `no access route for ${c.code}`);
    assert.ok(a.summary.length > 10);
  }
});

test('AMFI NAV file parses by scheme code; every India ETF has a code', () => {
  const txt = [
    'Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date',
    ' ',
    'Open Ended Schemes(Other Scheme - Other  ETFs)',
    '114984;INF247L01AP3;-;Motilal Oswal Nasdaq 100 ETF;;;290.6437;08-Oct-2026',
    '149438;INF247L01AU3;-;Motilal Oswal Nasdaq Q50 ETF;;;122.3834;08-Oct-2026',
    '999;x;-;Broken;;;N.A.;08-Oct-2026',
  ].join('\r\n');
  const m = parseAmfiNav(txt);
  assert.equal(m.get('114984')?.nav, 290.6437);
  assert.equal(m.get('149438')?.date, '08-Oct-2026');
  assert.equal(m.has('999'), false, 'a non-numeric NAV is dropped, never zero');
  assert.ok(INDIA_ETFS.length >= 6);
  for (const e of INDIA_ETFS) assert.match(e.amfiCode, /^\d+$/);
});

if (failures.length) {
  console.error(`globalMarkets: ${passed} passed, ${failures.length} failed\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`✓ globalMarkets: ${passed} passed`);
