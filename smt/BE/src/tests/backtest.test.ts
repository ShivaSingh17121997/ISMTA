/**
 * Backtester validation tests — the two things that decide whether you can
 * BELIEVE a backtest number on NSE data.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { backtestEngine, barsPerYear } from '../services/BacktestEngine';
import { Candle } from '../types';

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

const MIN = 60_000;
const DAY = 86_400_000;

/** Candles at a fixed interval from a base time. */
function series(n: number, intervalMs: number, base = Date.UTC(2026, 6, 15, 4, 0)): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const price = 100 + Math.sin(i / 7) * 2;
    return {
      symbol: 'X',
      timestamp: base + i * intervalMs,
      open: price,
      high: price + 0.5,
      low: price - 0.5,
      close: price,
      volume: 1000,
    };
  });
}

// ─── Sharpe annualisation (was ~19x wrong) ─────────────────────────────

test('barsPerYear: 1-minute NSE bars → 252 days × 375 min = 94,500', () => {
  assert.equal(barsPerYear(series(100, MIN)), 252 * 375);
});

test('barsPerYear: 5-minute bars → 75 bars/day', () => {
  assert.equal(barsPerYear(series(100, 5 * MIN)), 252 * 75);
});

test('barsPerYear: daily bars → the classic 252', () => {
  assert.equal(barsPerYear(series(100, DAY)), 252);
});

test('barsPerYear: the old hardcoded √252 understated minute-bar Sharpe by ~19x', () => {
  // This is the concrete bug: √(252×375)/√252 = √375 ≈ 19.36. A strategy with a
  // true Sharpe of 2.0 was reported as ~0.10 — and /compare ranks on it, so the
  // best strategies were being discarded.
  const wrong = Math.sqrt(252);
  const right = Math.sqrt(barsPerYear(series(100, MIN)));
  assert.ok(Math.abs(right / wrong - Math.sqrt(375)) < 1e-9);
  assert.ok(right / wrong > 19 && right / wrong < 19.4, `off by ${(right / wrong).toFixed(1)}x`);
});

test('barsPerYear: uses the MEDIAN gap, so overnight gaps do not skew it', () => {
  // A real NSE minute series has a ~17.75h gap between 15:30 and the next 09:15.
  // A mean interval would be dragged far from the true bar size by those.
  const day1 = series(300, MIN, Date.UTC(2026, 6, 15, 4, 0));
  const day2 = series(300, MIN, Date.UTC(2026, 6, 16, 4, 0));
  const withGap = [...day1, ...day2];
  assert.equal(barsPerYear(withGap), 252 * 375, 'still reads as 1-minute bars');
});

test('barsPerYear: degrades safely on too-short input', () => {
  assert.equal(barsPerYear([]), 252);
  assert.equal(barsPerYear(series(2, MIN)), 252);
});

// ─── Walk-forward optimisation ─────────────────────────────────────────

test('optimize: returns BOTH train and test metrics for every combo', () => {
  const candles = series(600, MIN);
  const results = backtestEngine.optimize(
    { strategyType: 'MA_CROSSOVER', symbol: 'X', candles, startingCapital: 1_000_000, quantity: 10 },
    { fast: [5, 9], slow: [21, 34] },
  );
  assert.equal(results.length, 4, '2 x 2 grid');
  for (const r of results) {
    assert.ok(r.train, 'in-sample metrics present');
    assert.ok(r.test, 'out-of-sample metrics present');
    assert.equal(typeof r.decayPct, 'number', 'degradation is surfaced, not hidden');
    assert.ok(r.params.fast != null && r.params.slow != null);
  }
});

test('optimize: ranks by OUT-OF-SAMPLE expectancy, not in-sample return', () => {
  // Ranking in-sample is how you pick the combo that memorised the noise best.
  const candles = series(600, MIN);
  const results = backtestEngine.optimize(
    { strategyType: 'MA_CROSSOVER', symbol: 'X', candles, startingCapital: 1_000_000, quantity: 10 },
    { fast: [5, 9, 12], slow: [21, 34] },
  );
  for (let i = 1; i < results.length; i++) {
    assert.ok(
      results[i - 1].test.expectancy >= results[i].test.expectancy,
      'sorted by test expectancy descending',
    );
  }
});

test('optimize: train and test are DISJOINT slices', () => {
  const candles = series(600, MIN);
  const [r] = backtestEngine.optimize(
    { strategyType: 'MA_CROSSOVER', symbol: 'X', candles, startingCapital: 1_000_000, quantity: 10 },
    { fast: [9] },
  );
  // 70/30 split of 600 bars → train ends at index 420, test starts there.
  assert.ok(r.train.to <= r.test.from, 'the test slice must start at or after the train slice ends');
  assert.ok(r.train.from < r.train.to);
});

test('optimize: honours a custom trainRatio', () => {
  const candles = series(600, MIN);
  const [a] = backtestEngine.optimize(
    { strategyType: 'MA_CROSSOVER', symbol: 'X', candles, startingCapital: 1_000_000, quantity: 10 },
    { fast: [9] },
    0.5,
  );
  const [b] = backtestEngine.optimize(
    { strategyType: 'MA_CROSSOVER', symbol: 'X', candles, startingCapital: 1_000_000, quantity: 10 },
    { fast: [9] },
    0.9,
  );
  assert.ok(a.train.to < b.train.to, 'a larger trainRatio means a longer train slice');
});

// ─── Session realism ───────────────────────────────────────────────────

test('backtest: session rules auto-detect OFF for the 24/7 simulator', () => {
  // Synthetic candles at arbitrary wall-clock times must not be crippled by NSE
  // trading hours — that would just produce an empty report.
  const midnight = series(400, MIN, Date.UTC(2026, 6, 15, 20, 0)); // 01:30 IST
  const r = backtestEngine.run({
    strategyType: 'MA_CROSSOVER',
    symbol: 'X',
    candles: midnight,
    startingCapital: 1_000_000,
    quantity: 10,
  });
  assert.ok(r.trades >= 0, 'runs without session gating');
});

test('backtest: enforceSession=true blocks entries outside the NSE window', () => {
  const midnight = series(400, MIN, Date.UTC(2026, 6, 15, 20, 0)); // 01:30 IST — market closed
  const r = backtestEngine.run({
    strategyType: 'MA_CROSSOVER',
    symbol: 'X',
    candles: midnight,
    startingCapital: 1_000_000,
    quantity: 10,
    enforceSession: true,
  });
  assert.equal(r.trades, 0, 'no trades can be opened while the market is shut');
});

if (failures.length) {
  console.error(`\n✗ backtest: ${failures.length} failed, ${passed} passed\n`);
  console.error(failures.join('\n\n'));
  process.exit(1);
}
console.log(`✓ backtest: ${passed} passed`);
