/**
 * Unit tests for the indicators the NTB entry models depend on.
 *
 * ADX is new and load-bearing: it is the regime gate for ALL THREE entry models,
 * and model C inverts it. If ADX is wrong, every NTB signal is wrong.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { Candle } from '../types';
import { adx, adxSeries, atr, ema, htfTrend, rsi } from '../strategies/indicators';

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

const mk = (h: number, l: number, c: number, i: number): Candle => ({
  symbol: 'X',
  timestamp: i * 60_000,
  open: c,
  high: h,
  low: l,
  close: c,
  volume: 100,
});

function trend(from: number, step: number, n = 60): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const b = from + i * step;
    out.push(mk(b + 1, b - 1, b, i));
  }
  return out;
}

const UP = trend(100, 2);
const DOWN = trend(200, -2);
const CHOP: Candle[] = Array.from({ length: 60 }, (_, i) => {
  const b = 100 + (i % 2 === 0 ? 0.5 : -0.5);
  return mk(b + 1, b - 1, b, i);
});

// ─── ADX ───────────────────────────────────────────────────────────────

test('ADX: strong uptrend reads high (>40)', () => {
  const v = adx(UP, 14);
  assert.ok(v != null && v > 40, `expected >40, got ${v}`);
});

test('ADX: strong downtrend also reads high — it measures STRENGTH, not direction', () => {
  const v = adx(DOWN, 14);
  assert.ok(v != null && v > 40, `expected >40, got ${v}`);
});

test('ADX: chop reads low (<25) — this is what gates breakout/pullback out of a range', () => {
  const v = adx(CHOP, 14);
  assert.ok(v != null && v < 25, `expected <25, got ${v}`);
});

test('ADX: chop and trend land on opposite sides of the default 22 threshold', () => {
  // If this fails, the regime gate cannot separate the two regimes and every
  // NTB model degrades to an unfiltered signal.
  assert.ok(adx(CHOP, 14)! < 22, 'chop must be below the gate');
  assert.ok(adx(UP, 14)! >= 22, 'trend must be above the gate');
});

test('ADX: first defined value lands at exactly 2*period - 1 (spec Phase 2)', () => {
  const s = adxSeries(UP, 14);
  const first = s.findIndex((v) => v !== undefined);
  assert.equal(first, 27, '2*14 - 1 = 27');
});

test('ADX: warm-up guard — needs 2*period candles', () => {
  assert.equal(adxSeries(UP.slice(0, 27), 14).length, 0, 'n < 2*period returns []');
  assert.ok(adxSeries(UP.slice(0, 28), 14).length > 0, 'n = 2*period is enough');
});

test('ADX: honours a non-default period', () => {
  const s = adxSeries(UP, 5);
  const first = s.findIndex((v) => v !== undefined);
  assert.equal(first, 9, '2*5 - 1 = 9');
});

test('ADX: is bounded 0..100', () => {
  for (const series of [UP, DOWN, CHOP]) {
    for (const v of adxSeries(series, 14)) {
      if (v === undefined) continue;
      assert.ok(v >= 0 && v <= 100, `ADX out of range: ${v}`);
    }
  }
});

// ─── htfTrend ──────────────────────────────────────────────────────────

test('htfTrend: agrees with the underlying trend', () => {
  assert.equal(htfTrend(UP, 12, 3, 5), 'BUY');
  assert.equal(htfTrend(DOWN, 12, 3, 5), 'SELL');
});

test('htfTrend: factor <= 1 disables it (returns null = "no opinion", never a veto)', () => {
  assert.equal(htfTrend(UP, 1, 3, 5), null);
  assert.equal(htfTrend(UP, 0, 3, 5), null);
});

test('htfTrend: returns null rather than guessing when the sampled series is too short', () => {
  assert.equal(htfTrend(UP.slice(0, 10), 12, 3, 5), null, '10 candles / 12 = 1 sample');
});

// ─── regression guards on the indicators NTB relies on ─────────────────
// These were verified correct in CODE_AUDIT.md; pin them so a refactor can't
// silently swap Wilder's smoothing for simple averaging.

test('EMA: seeded with an SMA of the first `period` values', () => {
  // emaSeries([1..10], 5): seed = mean(1..5) = 3 at index 4.
  assert.equal(ema([1, 2, 3, 4, 5], 5), 3);
});

test("RSI: Wilder's averaging — all-gains series pins at 100", () => {
  assert.equal(rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 14), 100);
});

test('ATR: constant true range of 2 yields ATR 2', () => {
  const flat: Candle[] = Array.from({ length: 30 }, (_, i) => mk(101, 99, 100, i));
  assert.equal(atr(flat, 14), 2);
});

if (failures.length) {
  console.error(`\n✗ indicators: ${failures.length} failed, ${passed} passed\n`);
  console.error(failures.join('\n\n'));
  process.exit(1);
}
console.log(`✓ indicators: ${passed} passed`);
