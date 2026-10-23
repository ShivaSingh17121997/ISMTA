/**
 * Live smoke test for the turbulence engine.
 *
 * Pulls real daily bars for a handful of deliberately different stocks — a calm
 * large cap, a volatile one, something that has run hard — and prints what the
 * warning panel would say, plus what the stop floor does at each horizon.
 *
 * It exists because the calibration tables are easy to get subtly wrong in a
 * way no unit test catches: every number stays in range, and the sentences are
 * still nonsense. It also caught the real bug this file now guards — a stop
 * floor expressed as a multiplier widened the long horizon, which already
 * clears the expected dip twice over, and shrank the position for nothing.
 *
 * Run: npx ts-node --transpile-only src/scripts/verifyTurbulence.ts [SYMBOLS...]
 */
import { measure } from '../services/recommender/metrics';
import { assessTurbulence } from '../services/recommender/turbulence';
import { HORIZONS, buildPlan } from '../services/recommender/plan';
import { fetchYahooChart } from '../services/yahoo';

const SYMBOLS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['HDFCBANK', 'RELIANCE', 'BEL', 'IDEA', 'TRENT', 'ADANIENT'];

async function main(): Promise<void> {
  let failures = 0;

  for (const symbol of SYMBOLS) {
    const chart = await fetchYahooChart(symbol, '10y', '1d', 20_000);
    const candles = (chart?.candles ?? []).filter((c) => c.close > 0);
    const m = measure(symbol, candles);
    if (!m) {
      console.log(`\n${symbol}: only ${candles.length} bars — skipped`);
      continue;
    }
    const t = assessTurbulence(m);
    if (!t) {
      console.log(`\n${symbol}: no usable ATR — skipped`);
      continue;
    }
    const f = t.forecast;

    console.log(`\n${'='.repeat(78)}`);
    console.log(`${symbol}  Rs ${m.lastClose.toFixed(2)}  ${candles.length} bars`);
    console.log(
      `  ATR ${(m.atrPct ?? 0).toFixed(2)}%  1m ${m.ret1m.toFixed(1)}%  ` +
        `RSI ${(m.rsi14 ?? 0).toFixed(0)}  ${(m.pctOf52wRange * 100).toFixed(0)}% of 52w range`,
    );
    console.log(`  -> ${t.summary}`);
    console.log(
      `  bucket "${f.bucket}" (n=${f.bucketN})  dip ${f.expectedDipPct.toFixed(1)}% ` +
        `(${f.expectedDipAtr}xATR -> Rs ${f.expectedDipFrom.toFixed(2)})  ` +
        `P5 ${(f.dipProbability * 100).toFixed(0)}% @${f.dipMedianDays}d  ` +
        `tail ${(f.tailRisk * 100).toFixed(1)}% (${f.tailRiskMultiple.toFixed(1)}x)  ` +
        `mean63 +${f.meanExcess63}%`,
    );
    console.log(
      `  stop floor ${t.requiredStopAtr.toFixed(2)}xATR  ` +
        `stage now ${(t.stageNowFraction * 100).toFixed(0)}%`,
    );

    for (const key of ['short', 'medium', 'long'] as const) {
      const spec = HORIZONS[key];
      const plain = buildPlan(m, spec);
      const withFloor = buildPlan(m, spec, undefined, t.requiredStopAtr);
      if (!plain || !withFloor) continue;
      // The invariant: the ordinary drawdown must never be what takes a
      // position out.
      const dipPrice = withFloor.entry * (1 - f.expectedDipPct / 100);
      const clears = withFloor.stop < dipPrice;
      const bound = withFloor.stop !== plain.stop;
      if (!clears) failures++;
      console.log(
        `  ${key.padEnd(6)} ${spec.atrStopMult}xATR  ` +
          `stop Rs ${plain.stop.toFixed(2)} -> ${withFloor.stop.toFixed(2)}  ` +
          `qty ${plain.quantity} -> ${withFloor.quantity}  ` +
          `${bound ? 'FLOOR BOUND' : 'unchanged  '}  ` +
          `${clears ? 'OK' : 'FAIL: stop sits inside the expected dip'}`,
      );
    }

    for (const w of t.warnings) console.log(`  [${w.severity.padEnd(8)}] ${w.headline}`);
  }

  console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURES`}`);
  if (failures) process.exit(1);
}

void main();
