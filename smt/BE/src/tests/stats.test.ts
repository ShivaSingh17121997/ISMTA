/**
 * Deflated Sharpe and friends. The worked numbers come from Bailey &
 * López de Prado's paper and the AMS "pseudo-mathematics" article.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { deflatedSharpe, expectedMaxSharpe, minBacktestLength, moments, normCdf, normInv, periodSharpe } from '../services/backtest/stats';

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
const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

test('normal CDF and its inverse agree', () => {
  for (const p of [0.01, 0.05, 0.5, 0.9, 0.975, 0.999]) near(normCdf(normInv(p)), p, 1e-6, `p=${p}`);
  near(normInv(0.975), 1.959964, 1e-4, 'z(0.975)');
  near(normCdf(0), 0.5, 1e-9, 'Φ(0)');
});

test('moments of a known series', () => {
  const m = moments([1, 2, 3, 4, 5]);
  near(m.mean, 3, 1e-12, 'mean');
  near(m.sd, Math.sqrt(2), 1e-12, 'sd');
  near(m.skew, 0, 1e-12, 'skew');
  near(m.kurtosis, 1.7, 1e-12, 'kurtosis');
  near(periodSharpe([1, 2, 3, 4, 5]), 3 / Math.sqrt(2), 1e-12, 'sharpe');
});

test('expected max Sharpe grows with the number of trials (AMS 2014, Fig. 1)', () => {
  // With unit variance across trials: E[max] ≈ 1.0 near N≈5, ≈ 2.0 near N≈45,
  // ≈ 3.0 near N≈1000 — the "five years of daily data tolerates ~45 trials" line.
  const e5 = expectedMaxSharpe(5, 1);
  const e45 = expectedMaxSharpe(45, 1);
  const e1000 = expectedMaxSharpe(1000, 1);
  assert.ok(e5 > 0.9 && e5 < 1.3, `E[max] at 5 trials = ${e5}`);
  assert.ok(e45 > 2.0 && e45 < 2.4, `E[max] at 45 trials = ${e45}`);
  assert.ok(e1000 > 2.9 && e1000 < 3.4, `E[max] at 1000 trials = ${e1000}`);
  assert.ok(e5 < e45 && e45 < e1000, 'monotone in the trial count');
  assert.equal(expectedMaxSharpe(1, 1), 0, 'one trial has no selection effect');
});

test('minimum backtest length: 45 trials of unit-variance Sharpe need ~4 periods per unit Sharpe²', () => {
  // MinBTL ≈ (E[max]/SR)² ; for SR=1 and N=45, E[max]≈2.0 → ≈4 (in units of the Sharpe's period; ×252² for annualised daily)
  const n = minBacktestLength(45, 1);
  assert.ok(n >= 3 && n <= 5, `MinBTL = ${n}`);
  assert.equal(minBacktestLength(1, 1), 0);
});

test('a single trial with a strong Sharpe over many periods is significant', () => {
  const r = deflatedSharpe({ sharpe: 0.3, periods: 200, skew: 0, kurtosis: 3, trials: 1, varianceOfTrialSharpes: 0 });
  assert.ok(r.probability > 0.99, `p=${r.probability}`);
  assert.equal(r.benchmarkSharpe, 0);
});

test('the same Sharpe after 100 trials with wide dispersion is not', () => {
  const r = deflatedSharpe({ sharpe: 0.3, periods: 200, skew: 0, kurtosis: 3, trials: 100, varianceOfTrialSharpes: 0.04 });
  assert.ok(r.benchmarkSharpe > 0.4, `benchmark=${r.benchmarkSharpe}`);
  assert.ok(r.probability < 0.5, `p=${r.probability}`);
  assert.match(r.note, /does not clear/);
});

test('fat tails and negative skew make the same Sharpe less believable', () => {
  const clean = deflatedSharpe({ sharpe: 0.2, periods: 60, skew: 0, kurtosis: 3, trials: 1, varianceOfTrialSharpes: 0 });
  const ugly = deflatedSharpe({ sharpe: 0.2, periods: 60, skew: -2, kurtosis: 12, trials: 1, varianceOfTrialSharpes: 0 });
  assert.ok(ugly.probability < clean.probability, `${ugly.probability} < ${clean.probability}`);
});

test('too few periods says so', () => {
  const r = deflatedSharpe({ sharpe: 2, periods: 2, skew: 0, kurtosis: 3, trials: 1, varianceOfTrialSharpes: 0 });
  assert.equal(r.probability, 0);
  assert.match(r.note, /too few/);
});

if (failures.length) {
  console.error(`\n✗ stats: ${failures.length} failed, ${passed} passed\n`);
  console.error(failures.join('\n\n'));
  process.exit(1);
}
console.log(`✓ stats: ${passed} passed`);
