/**
 * Turbulence tests.
 *
 * Most of these guard against the module drifting back into the feature that
 * was measured and rejected. The study behind it (WARNING_ENGINE.md) found that
 * "it is high, do not buy" halves returns, so the assertions here are less
 * about arithmetic than about keeping a rule out of the codebase:
 *
 *   - no warning may ever be a veto, and severity has a ceiling below one;
 *   - a position may be staged but never reduced to nothing;
 *   - volatility, not the run-up, must drive the bucket, because controlling
 *     for ATR% showed the run-up was mostly a proxy for it;
 *   - the expected dip must be quoted in ATR, since fall DEPTH measured a
 *     −0.14 correlation across five-year halves and has no predictive content;
 *   - every warning must carry its baseline, or a scary-sounding base rate gets
 *     read as a prediction.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import {
  BASELINE,
  BUCKETS,
  HIGH_ATR_PCT,
  HOT_RUNUP_PCT,
  assessTurbulence,
  bucketFor,
  worstSeverity,
  type Severity,
} from '../services/recommender/turbulence';
import { judgeDrawdown } from '../services/RecommenderEngine';
import { DEFAULT_SIZING, HORIZONS, buildPlan } from '../services/recommender/plan';
import type { Metrics } from '../services/recommender/metrics';

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

/** A plausible Metrics object; every test overrides only what it cares about. */
function metrics(over: Partial<Metrics> = {}): Metrics {
  const lastClose = over.lastClose ?? 1000;
  const atrPct = over.atrPct ?? 2.5;
  return {
    symbol: 'TEST',
    bars: 300,
    lastClose,
    asOf: Date.now(),
    mom12_1: 10, mom6_1: 8, mom3_1: 5,
    ret1m: 3, ret1w: 1,
    momRiskAdj12_1: 0.4, momRiskAdj6_1: 0.3, momRiskAdj3_1: 0.2,
    infoDiscreteness: -0.1,
    ema20: lastClose, ema50: lastClose * 0.97, sma200: lastClose * 0.9,
    aboveSma200: true, ema20Above50: true, trendSpreadPct: 7, adx14: 25,
    high52w: lastClose * 1.1, low52w: lastClose * 0.7,
    pctOf52wRange: 0.75, fromHighPct: -9,
    atr14: (atrPct / 100) * lastClose,
    atrPct,
    volAnnualPct: 30,
    rsi14: 55,
    medianTurnover: 50_00_00_000,
    volumeRatio: 1,
    supportRecent: lastClose * 0.95, resistanceRecent: lastClose * 1.05,
    low20: lastClose * 0.94, high20: lastClose * 1.04,
    maxDrawdown1yPct: 20,
    ...over,
  };
}

// ── the rules that must never be broken ─────────────────────────────────────

test('no warning is ever a veto — severity has no level above "serious"', () => {
  // Deliberately the worst case the module can see.
  const t = assessTurbulence(metrics({ atrPct: 12, ret1m: 60, medianTurnover: 1e7, maxDrawdown1yPct: 70 }));
  assert.ok(t, 'the worst case must still produce a forecast');
  const allowed: Severity[] = ['note', 'caution', 'serious'];
  for (const w of t.warnings) {
    assert.ok(allowed.includes(w.severity), `unexpected severity "${w.severity}" on ${w.kind}`);
  }
});

test('a position is never staged down to nothing', () => {
  const t = assessTurbulence(metrics({ atrPct: 12, ret1m: 80 }));
  assert.ok(t);
  assert.ok(t.stageNowFraction > 0, 'stageNowFraction must never be 0 — skipping halves returns');
  assert.ok(t.stageNowFraction <= 1);
});

test('no warning text tells the user not to buy', () => {
  // The exact phrasing the study rejected. If this ever fires, the feature has
  // regressed into the version that loses money.
  const banned = /\b(do not (buy|invest)|don'?t (buy|invest)|avoid buying|stay out|sell now|will (fall|drop|come down))\b/i;
  for (const atrPct of [1, 2.5, 4, 6, 12]) {
    for (const ret1m of [-10, 5, 25, 60]) {
      const t = assessTurbulence(metrics({ atrPct, ret1m }));
      assert.ok(t);
      for (const w of t.warnings) {
        const text = `${w.headline} ${w.detail}`;
        assert.ok(!banned.test(text), `banned directive in ${w.kind}: "${text.slice(0, 90)}"`);
      }
    }
  }
});

test('every bucket reports a POSITIVE mean excess return', () => {
  // The measured fact that forbids a veto. If a bucket ever went negative the
  // design would need revisiting — so assert it rather than trust the comment.
  for (const b of BUCKETS) {
    assert.ok(b.meanExcess63 > 0, `${b.label} has non-positive mean excess return`);
  }
  assert.ok(BASELINE.meanExcess63 > 0);
});

// ── volatility is the driver ────────────────────────────────────────────────

test('bucketing is on volatility, not on the run-up', () => {
  const calm = assessTurbulence(metrics({ atrPct: 1.5, ret1m: 60 }));
  const wild = assessTurbulence(metrics({ atrPct: 8, ret1m: 0 }));
  assert.ok(calm && wild);
  // A calm stock after a huge month is still safer than a wild one that has
  // done nothing — that is the whole point of the grid in the header.
  assert.ok(
    wild.forecast.tailRisk > calm.forecast.tailRisk,
    `volatility must dominate: wild ${wild.forecast.tailRisk} vs calm-but-hot ${calm.forecast.tailRisk}`,
  );
});

test('buckets are monotonic in tail risk', () => {
  // Sorted highest-ATR first, so tail risk must fall as we walk down.
  for (let i = 1; i < BUCKETS.length; i++) {
    assert.ok(
      BUCKETS[i].tailRisk < BUCKETS[i - 1].tailRisk,
      `${BUCKETS[i].label} is not below ${BUCKETS[i - 1].label} in tail risk`,
    );
    assert.ok(BUCKETS[i].minAtrPct < BUCKETS[i - 1].minAtrPct, 'buckets must be ordered by ATR%');
  }
});

test('bucketFor picks the right band and never returns undefined', () => {
  assert.equal(bucketFor(0).label, 'calm');
  assert.equal(bucketFor(1.9).label, 'calm');
  assert.equal(bucketFor(2).label, 'ordinary');
  assert.equal(bucketFor(3).label, 'volatile');
  assert.equal(bucketFor(HIGH_ATR_PCT).label, 'very volatile');
  assert.equal(bucketFor(99).label, 'very volatile');
});

// ── the dip is quoted in ATR, because depth does not persist ────────────────

test('the expected dip scales with ATR, not with a remembered fall depth', () => {
  // Same bucket, same dipAtr — but a stock priced at twice the volatility must
  // report twice the rupee dip. If this ever keyed off maxDrawdown1yPct the
  // module would be forecasting from a statistic measured at -0.14 correlation.
  const a = assessTurbulence(metrics({ atrPct: 3.5, maxDrawdown1yPct: 10 }));
  const b = assessTurbulence(metrics({ atrPct: 3.5, maxDrawdown1yPct: 65 }));
  assert.ok(a && b);
  assert.equal(
    a.forecast.expectedDipPct.toFixed(4),
    b.forecast.expectedDipPct.toFixed(4),
    'past drawdown must NOT change the forecast — it has no predictive content',
  );
});

test('expected dip is bucket dipAtr x atrPct, and lands below the entry', () => {
  const m = metrics({ atrPct: 4 });
  const t = assessTurbulence(m, 500);
  assert.ok(t);
  const b = bucketFor(4);
  assert.equal(t.forecast.expectedDipAtr, b.dipAtr);
  assert.ok(Math.abs(t.forecast.expectedDipPct - b.dipAtr * 4) < 1e-9);
  assert.ok(t.forecast.expectedDipFrom < 500, 'the dip level must sit below the entry');
  assert.ok(t.forecast.expectedDipFrom > 0);
});

test('the dip is quoted off the ENTRY, not the last close', () => {
  const m = metrics({ lastClose: 1000, atrPct: 3 });
  const atClose = assessTurbulence(m);
  const atLimit = assessTurbulence(m, 900);
  assert.ok(atClose && atLimit);
  assert.ok(
    atLimit.forecast.expectedDipFrom < atClose.forecast.expectedDipFrom,
    'a lower entry must produce a lower dip level',
  );
});

// ── the run-up escalation ───────────────────────────────────────────────────

test('a hot month raises tail risk and pulls the dip forward', () => {
  const cool = assessTurbulence(metrics({ atrPct: 4, ret1m: 5 }));
  const hot = assessTurbulence(metrics({ atrPct: 4, ret1m: HOT_RUNUP_PCT + 5 }));
  assert.ok(cool && hot);
  assert.ok(hot.forecast.tailRisk > cool.forecast.tailRisk, 'a hot month must raise tail risk');
  assert.ok(hot.forecast.dipMedianDays < cool.forecast.dipMedianDays, 'the dip must arrive sooner');
  assert.ok(hot.forecast.runUpEscalated && !cool.forecast.runUpEscalated);
});

test('a hot month does NOT inflate the dip depth', () => {
  // Measured: dip in ATR barely moved across run-up buckets (1.75 -> 1.45).
  // Inflating it would be inventing a number the study does not support.
  const cool = assessTurbulence(metrics({ atrPct: 4, ret1m: 5 }));
  const hot = assessTurbulence(metrics({ atrPct: 4, ret1m: 45 }));
  assert.ok(cool && hot);
  assert.equal(hot.forecast.expectedDipAtr, cool.forecast.expectedDipAtr);
});

test('the run-up warning explicitly says it is not a reason to skip', () => {
  const t = assessTurbulence(metrics({ atrPct: 4, ret1m: 35 }));
  assert.ok(t);
  const w = t.warnings.find((x) => x.kind === 'run-up-extended');
  assert.ok(w, 'a 35% month must raise the run-up warning');
  assert.ok(/stage|not reverse|beat the index/i.test(w.detail), 'must carry the counter-message');
});

// ── presentation contracts the UI depends on ────────────────────────────────

test('every warning carries its own baseline', () => {
  const t = assessTurbulence(metrics({ atrPct: 6, ret1m: 30, medianTurnover: 1e7, maxDrawdown1yPct: 50 }));
  assert.ok(t);
  assert.ok(t.warnings.length >= 4, `expected several warnings, got ${t.warnings.length}`);
  for (const w of t.warnings) {
    assert.ok(w.evidence.condition.length > 0, `${w.kind} has no condition`);
    assert.ok(w.evidence.stat.length > 0, `${w.kind} has no stat`);
    assert.ok(w.evidence.baseline.length > 0, `${w.kind} has no baseline`);
    assert.ok(w.headline.length > 0 && w.detail.length > 0);
  }
});

test('warnings are ordered loudest first', () => {
  const t = assessTurbulence(metrics({ atrPct: 8, ret1m: 40, medianTurnover: 1e7 }));
  assert.ok(t);
  const r = (s: Severity) => (s === 'serious' ? 2 : s === 'caution' ? 1 : 0);
  for (let i = 1; i < t.warnings.length; i++) {
    assert.ok(
      r(t.warnings[i].severity) <= r(t.warnings[i - 1].severity),
      'warnings must be sorted by descending severity',
    );
  }
  assert.equal(worstSeverity(t), t.warnings[0].severity);
});

test('the dip warning states that it may not come at all', () => {
  const t = assessTurbulence(metrics({ atrPct: 2.5 }));
  assert.ok(t);
  const w = t.warnings.find((x) => x.kind === 'dip-imminent');
  assert.ok(w);
  assert.ok(
    /never comes|distribution, not a date/i.test(w.detail),
    'the dip warning must not read as a prediction',
  );
});

// ── the actionable outputs ──────────────────────────────────────────────────

test('the required stop always clears the drawdown the study expects', () => {
  for (const atrPct of [1, 2.5, 4, 8]) {
    const t = assessTurbulence(metrics({ atrPct }));
    assert.ok(t);
    assert.ok(
      t.requiredStopAtr > t.forecast.expectedDipAtr,
      `a ${t.requiredStopAtr}x ATR stop sits inside the expected ${t.forecast.expectedDipAtr}x dip`,
    );
    // Naturally bounded by the widest bucket dip (1.92 ATR) plus the margin.
    assert.ok(t.requiredStopAtr <= 2.3, `requiredStopAtr ${t.requiredStopAtr} is implausibly wide`);
  }
});

test('the stop floor binds on short horizons and leaves longer ones alone', () => {
  // The bug this guards: scaling every horizon by one multiplier widened the
  // long stop, which already clears the dip twice over, and shrank the position
  // for nothing. Taking the max must be a no-op wherever the spec is wider.
  const m = metrics({ atrPct: 1.7 }); // calm: requires ~2.2 ATR
  const t = assessTurbulence(m);
  assert.ok(t);

  const short = buildPlan(m, HORIZONS.short, DEFAULT_SIZING);
  const shortWide = buildPlan(m, HORIZONS.short, DEFAULT_SIZING, t.requiredStopAtr);
  assert.ok(short && shortWide);
  assert.ok(shortWide.stop < short.stop, 'a 1.5x short stop must be widened past a 1.92x dip');

  for (const spec of [HORIZONS.medium, HORIZONS.long]) {
    const plain = buildPlan(m, spec, DEFAULT_SIZING);
    const withFloor = buildPlan(m, spec, DEFAULT_SIZING, t.requiredStopAtr);
    assert.ok(plain && withFloor);
    assert.equal(
      withFloor.stop,
      plain.stop,
      `${spec.horizon} already stops at ${spec.atrStopMult}x ATR — it must not be widened`,
    );
    assert.equal(withFloor.quantity, plain.quantity, `${spec.horizon} position must not shrink`);
  }
});

test('a widened stop never produces a bigger position', () => {
  const m = metrics({ atrPct: 1.7 });
  const t = assessTurbulence(m);
  assert.ok(t);
  const plain = buildPlan(m, HORIZONS.short, DEFAULT_SIZING);
  const wide = buildPlan(m, HORIZONS.short, DEFAULT_SIZING, t.requiredStopAtr);
  assert.ok(plain && wide);
  assert.ok(wide.quantity <= plain.quantity, 'a wider stop must risk the same rupees on fewer shares');
  assert.ok(wide.stopDistancePct > plain.stopDistancePct);
});

test('staging triggers only when the dip is both likely and soon', () => {
  const calm = assessTurbulence(metrics({ atrPct: 1.5, ret1m: 0 }));   // 56% at 17d
  const wild = assessTurbulence(metrics({ atrPct: 8, ret1m: 40 }));    // 72%+ at ~2d
  assert.ok(calm && wild);
  assert.equal(calm.stageNowFraction, 1, 'a calm, slow-dipping name needs no staging');
  assert.equal(wild.stageNowFraction, 0.5, 'a volatile hot name should be staged');
});

test('tailRiskMultiple is stated against the sample baseline', () => {
  const t = assessTurbulence(metrics({ atrPct: 6 }));
  assert.ok(t);
  assert.ok(
    Math.abs(t.forecast.tailRiskMultiple - t.forecast.tailRisk / BASELINE.tailRisk) < 1e-9,
    'the multiple must be measured against BASELINE, not a hand-picked number',
  );
  assert.ok(t.forecast.tailRiskMultiple > 1, 'a very volatile name must exceed the baseline');
});

// ── degenerate input ────────────────────────────────────────────────────────

test('unusable ATR yields null rather than a unitless forecast', () => {
  assert.equal(assessTurbulence(metrics({ atrPct: null, atr14: null })), null);
  assert.equal(assessTurbulence(metrics({ atrPct: 0, atr14: 0 })), null);
  assert.equal(assessTurbulence(metrics({ atrPct: 3 }), 0), null);
  assert.equal(assessTurbulence(metrics({ atrPct: 3 }), -5), null);
});

test('probabilities stay inside 0..1', () => {
  for (const atrPct of [0.5, 2, 4, 20]) {
    for (const ret1m of [-50, 0, 200]) {
      const t = assessTurbulence(metrics({ atrPct, ret1m }));
      assert.ok(t);
      const f = t.forecast;
      for (const [k, v] of Object.entries({
        dipProbability: f.dipProbability,
        deepDipProbability: f.deepDipProbability,
        tailRisk: f.tailRisk,
      })) {
        assert.ok(v >= 0 && v <= 1, `${k}=${v} out of range at atrPct=${atrPct} ret1m=${ret1m}`);
      }
      assert.ok(f.dipMedianDays >= 1, 'a median of zero sessions would be nonsense');
    }
  }
});

test('worstSeverity is null when there is nothing to assess', () => {
  assert.equal(worstSeverity(null), null);
});

// ── held positions ──────────────────────────────────────────────────────────

test('a drawdown inside the ordinary range reads as noise, not a broken thesis', () => {
  const t = assessTurbulence(metrics({ atrPct: 4 })); // ordinary dip ~6.3%
  assert.ok(t);
  const j = judgeDrawdown(-4, t);
  assert.equal(j.verdict, 'normal-dip');
  assert.ok(/noise/i.test(j.note));
});

test('the drawdown verdict escalates with depth, and never says sell', () => {
  const t = assessTurbulence(metrics({ atrPct: 4 }));
  assert.ok(t);
  const dip = t.forecast.expectedDipPct;
  assert.equal(judgeDrawdown(3, t).verdict, 'fine');
  assert.equal(judgeDrawdown(-(dip * 0.5), t).verdict, 'normal-dip');
  assert.equal(judgeDrawdown(-(dip * 1.5), t).verdict, 'beyond-normal');
  assert.equal(judgeDrawdown(-(dip * 3), t).verdict, 'deep');
  // Not even the deepest verdict may issue a directive.
  const banned = /\b(sell (now|it)|cut (it|the position)|exit now|get out)\b/i;
  for (const p of [5, -1, -dip, -dip * 2, -dip * 5]) {
    assert.ok(!banned.test(judgeDrawdown(p, t).note), `directive at ${p}%`);
  }
});

test('the boundary between normal and beyond-normal is the expected dip itself', () => {
  const t = assessTurbulence(metrics({ atrPct: 2.5 }));
  assert.ok(t);
  const dip = t.forecast.expectedDipPct;
  assert.equal(judgeDrawdown(-(dip - 0.01), t).verdict, 'normal-dip');
  assert.equal(judgeDrawdown(-(dip + 0.01), t).verdict, 'beyond-normal');
});

test('no turbulence means "unknown", never a clean bill of health', () => {
  const j = judgeDrawdown(-30, null);
  assert.equal(j.verdict, 'unknown');
  assert.ok(!/fine|normal/i.test(j.verdict));
});

if (failures.length) {
  console.error(`✗ turbulence: ${failures.length} failed, ${passed} passed`);
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`✓ turbulence: ${passed} passed`);
