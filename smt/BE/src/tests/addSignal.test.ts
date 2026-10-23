/**
 * Add-money light tests.
 *
 * The arithmetic matters, but most of these guard what the light must NEVER
 * do, because each was measured and lost money:
 *
 *   - near its high, after a hot month, or in a downtrend is never red
 *     (WARNING_ENGINE.md: those names beat the index by more, not less);
 *   - an upcoming results date never changes the light or the amount;
 *   - an expected dip or the market's "invest in steps" never shrinks the
 *     amount: staging cost 0.5–2% vs buying at once in a 10-year
 *     point-in-time test, for almost no protection (ADD_SIGNAL.md);
 *   - red pauses NEW money and never tells anyone to sell.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { assessTurbulence } from '../services/recommender/turbulence';
import type { Metrics } from '../services/recommender/metrics';
import {
  SMALLER_FRACTION,
  VERY_VOLATILE_ATR_PCT,
  addSignal,
  type AddSignal,
  type AddSignalInput,
  type MarketRead,
} from '../services/addSignal/signal';

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

const INVEST: MarketRead = { action: 'invest', steps: 'standard', title: 'INVEST AS PLANNED' };
const STEPS: MarketRead = { action: 'invest-in-steps', steps: 'standard', title: 'INVEST IN STEPS' };
const HOLD: MarketRead = { action: 'hold', steps: 'standard', title: 'HOLD — PAUSE NEW MONEY', reason: 'Breadth divergence is on.' };

function input(over: Partial<AddSignalInput> = {}, m: Partial<Metrics> = {}): AddSignalInput {
  const met = metrics(m);
  return {
    symbol: 'TEST',
    price: met.lastClose,
    planned: 100_000,
    turbulence: assessTurbulence(met),
    market: INVEST,
    minAmount: 16_000,
    ...over,
  };
}

function allText(s: AddSignal): string {
  return [s.label, s.action, ...s.reasons, ...s.notes].join(' ');
}

// ── the colours ────────────────────────────────────────────────────────────

test('ordinary stock, calm market → green, the whole plan now', () => {
  const s = addSignal(input());
  assert.equal(s.light, 'green');
  assert.equal(s.label, 'Add now');
  assert.equal(s.nowPct, 100);
  assert.equal(s.nowAmount, 100_000);
  assert.equal(s.nowShares, 100);
});

test('very volatile stock → yellow "Add smaller", half now, nothing to wait for', () => {
  const s = addSignal(input({}, { atrPct: 6 }));
  assert.equal(s.light, 'yellow');
  assert.equal(s.label, 'Add smaller');
  assert.equal(s.nowAmount, 100_000 * SMALLER_FRACTION);
  assert.match(s.reasons[0], /Very bumpy/);
  assert.ok(!/dip|after \d+ trading days|falls to/i.test(s.action), 'yellow is about size, never timing');
});

test('thinly traded stock → yellow', () => {
  const s = addSignal(input({}, { medianTurnover: 1e7 }));
  assert.equal(s.light, 'yellow');
  assert.match(s.reasons.join(' '), /thinly traded/);
});

test('the volatility line sits exactly at the study threshold', () => {
  assert.equal(addSignal(input({}, { atrPct: VERY_VOLATILE_ATR_PCT - 0.01 })).light, 'green');
  assert.equal(addSignal(input({}, { atrPct: VERY_VOLATILE_ATR_PCT })).light, 'yellow');
});

test('market HOLD → red for every stock, nothing to add', () => {
  const s = addSignal(input({ market: HOLD }));
  assert.equal(s.light, 'red');
  assert.equal(s.nowAmount, 0);
  assert.match(s.reasons[0], /HOLD/);
});

test('each structural block turns it red on its own', () => {
  const cases: Partial<AddSignalInput>[] = [
    { surveillance: 'ASM Stage 1' },
    { newsVeto: 'Recent coverage is strongly negative.' },
    { entryBlock: 'Results on 2026-10-14: waiting 2 session(s)' },
    { stopped: 'kill' },
    { stopped: 'halted' },
    { full: { heldPct: 36, capPct: 35 }, planned: 0 },
  ];
  for (const c of cases) {
    const s = addSignal(input(c));
    assert.equal(s.light, 'red', JSON.stringify(c));
    assert.equal(s.reasons.length, 1, JSON.stringify(c));
  }
});

test('no price history → grey, never a green by default', () => {
  const s = addSignal(input({ turbulence: null }));
  assert.equal(s.light, 'grey');
  assert.equal(s.nowAmount, 0);
});

// ── what the 10-year test ruled out ────────────────────────────────────────

test('an expected dip never shrinks the amount (staging cost ~0.5% in the test)', () => {
  // ATR 2.5% + a hot month: the turbulence module stages this one (0.5); the light must not.
  const met = { atrPct: 2.5, ret1m: 30 };
  assert.equal(assessTurbulence(metrics(met))!.stageNowFraction, 0.5, 'fixture must be a staged stock');
  const s = addSignal(input({}, met));
  assert.equal(s.light, 'green');
  assert.equal(s.nowAmount, 100_000);
  assert.ok(s.notes.some((n) => /Expect a ~\d+% dip/.test(n) && /cost ~0.5%/.test(n)), 'but the dip is stated, with its cost');
});

test('market "invest in steps" never shrinks the amount (cost 1–2% in the test)', () => {
  for (const steps of ['standard', 'smaller', 'front-loaded'] as const) {
    const s = addSignal(input({ market: { ...STEPS, steps } }));
    assert.equal(s.light, 'green', steps);
    assert.equal(s.nowAmount, 100_000, steps);
    assert.ok(s.notes.some((n) => /cost 1–2%/.test(n)), steps);
  }
});

test('near the 52-week high after a hot month is NOT red', () => {
  const s = addSignal(input({}, { ret1m: 45, fromHighPct: -1, pctOf52wRange: 0.99, rsi14: 85 }));
  assert.notEqual(s.light, 'red');
  assert.ok(s.nowAmount > 0);
});

test('a downtrend far below the high is NOT red', () => {
  const s = addSignal(input({}, { aboveSma200: false, ema20Above50: false, fromHighPct: -40, mom12_1: -30, ret1m: -15 }));
  assert.notEqual(s.light, 'red');
});

test('an upcoming results date never changes the colour or the amount', () => {
  for (const atrPct of [1.5, 2.5, 4, 6]) {
    const a = addSignal(input({}, { atrPct }));
    const b = addSignal(input({ resultsOn: '2026-11-10' }, { atrPct }));
    assert.equal(b.light, a.light);
    assert.equal(b.nowAmount, a.nowAmount);
    assert.ok(b.notes.some((n) => n.includes('2026-11-10')), 'but it is mentioned');
  }
});

test('the most extreme stock the turbulence module can see is still never red', () => {
  const s = addSignal(input({}, { atrPct: 15, ret1m: 90, maxDrawdown1yPct: 80 }));
  assert.equal(s.light, 'yellow');
  assert.ok(s.nowAmount > 0);
});

// ── the arithmetic ─────────────────────────────────────────────────────────

test('whole shares — the ₹8,945 stock case found on screen', () => {
  // DIVISLAB 2026-10-15: plan ₹17,891 at ₹8,945 is 2 shares; "add ₹5,000" was unbuyable.
  const s = addSignal(input({ planned: 17_891, minAmount: 5_000, price: 8_945 }, { lastClose: 8_945 }));
  assert.equal(s.nowShares, 2);
  assert.equal(s.nowAmount, 17_890);
  const y = addSignal(input({ planned: 17_891, minAmount: 5_000, price: 8_945 }, { lastClose: 8_945, atrPct: 6 }));
  assert.equal(y.nowShares, 1, 'half of 2 shares');
});

test('rupee rounding never costs a share (7 × ₹1,590.20)', () => {
  const s = addSignal(input({ planned: 11_131.4, minAmount: 5_000, price: 1_590.2 }, { lastClose: 1_590.2 }));
  assert.equal(s.nowShares, 7);
});

test('the smaller amount is never below the DP floor, nor above the plan', () => {
  const s = addSignal(input({ planned: 20_000, minAmount: 16_000 }, { atrPct: 6 }));
  assert.equal(s.nowAmount, 16_000, 'half (₹10k) is raised to the ₹16k floor');
  const t = addSignal(input({ planned: 12_000, minAmount: 16_000 }, { atrPct: 6 }));
  assert.equal(t.nowAmount, 12_000, 'but never above the plan');
});

test('a plan under one share says so instead of "add ₹0"', () => {
  const s = addSignal(input({ planned: 4_000, price: 8_945 }, { lastClose: 8_945 }));
  assert.equal(s.label, 'Under 1 share');
  assert.equal(s.nowAmount, 0);
  assert.match(s.action, /does not buy one share/);
});

test('with no rupee plan the light still speaks in percent', () => {
  const s = addSignal(input({ planned: 0 }, { atrPct: 6 }));
  assert.equal(s.light, 'yellow');
  assert.equal(s.nowPct, 50);
  assert.match(s.action, /about 50%/);
});

// ── the words ──────────────────────────────────────────────────────────────

test('no generated sentence tells anyone to sell or predicts a fall', () => {
  const banned = /\bsell\b|\bselling\b|will (fall|drop|crash)|going to (fall|drop)|\bcrash\b|exit now/i;
  const variants: Partial<AddSignalInput>[] = [
    {}, { market: HOLD }, { market: STEPS }, { surveillance: 'GSM 2' }, { stopped: 'kill' },
    { newsVeto: 'Recent coverage is strongly negative.' }, { full: { heldPct: 40, capPct: 35 }, planned: 0 },
    { resultsOn: '2026-11-01' }, { turbulence: null }, { planned: 0 },
  ];
  for (const v of variants) {
    for (const atrPct of [1.5, 4, 8]) {
      const s = addSignal(input(v, { atrPct, ret1m: 30, medianTurnover: 3e7, maxDrawdown1yPct: 60 }));
      assert.ok(!banned.test(allText(s)), `banned phrase in: ${allText(s)}`);
    }
  }
});

test('red keeps what you own', () => {
  const s = addSignal(input({ market: HOLD }));
  assert.match(s.action, /Keep the shares/);
});

// ── property test: random stocks, invariants that must always hold ─────────

/** Small seeded PRNG (mulberry32), so a failure reproduces exactly. */
function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('20,000 random stocks: every invariant holds', () => {
  const r = rng(20261015);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const markets: (MarketRead | null)[] = [
    null, INVEST, STEPS, HOLD,
    { ...STEPS, steps: 'smaller' }, { ...STEPS, steps: 'front-loaded' },
  ];
  const bad: string[] = [];
  for (let n = 0; n < 20_000 && bad.length < 5; n++) {
    const price = Math.round((5 + r() ** 3 * 15_000) * 100) / 100;
    const m = {
      lastClose: price,
      atrPct: 0.5 + r() * 14,
      ret1m: -40 + r() * 130,
      medianTurnover: 10 ** (6 + r() * 4),
      maxDrawdown1yPct: r() * 80,
    };
    const red = {
      surveillance: r() < 0.05 ? 'ASM Stage 1' : null,
      newsVeto: r() < 0.05 ? 'Recent news is strongly negative.' : null,
      entryBlock: r() < 0.05 ? 'gap-down' : null,
      stopped: r() < 0.05 ? pick(['halted', 'kill'] as const) : null,
      full: r() < 0.05 ? { heldPct: 36, capPct: 35 } : null,
    };
    const market = pick(markets);
    const minAmount = pick([0, 5_000, 16_000]);
    const planned = r() < 0.1 ? 0 : Math.round(r() * 300_000 * 100) / 100;
    const turbulence = r() < 0.03 ? null : assessTurbulence(metrics(m));
    const inp = input({ price, planned, minAmount, market, resultsOn: r() < 0.3 ? '2026-11-05' : null, turbulence, ...red }, m);
    const s = addSignal(inp);
    const fail = (why: string) =>
      bad.push(`#${n} ${why} — ${JSON.stringify({ price, planned, minAmount, light: s.light, label: s.label, now: s.nowAmount, ns: s.nowShares })}`);

    const hasRed = !!(red.surveillance || red.newsVeto || red.entryBlock || red.stopped || red.full || market?.action === 'hold');
    // I1 red if and only if a red cause is present
    if ((s.light === 'red') !== hasRed) fail('red without a red cause, or a red cause ignored');
    if (!hasRed && !turbulence && s.light !== 'grey') fail('no history but not grey');
    // I2 red and grey add nothing
    if ((s.light === 'red' || s.light === 'grey') && s.nowAmount) fail('red/grey with an amount');
    // I3 never more than the plan
    // (the true cost — shares × price — not the rupee-rounded display figure)
    const cost = s.nowShares !== null ? s.nowShares * price : s.nowAmount;
    if (cost > planned + 1e-6) fail('amount exceeds the plan');
    // I4 whole shares, rupees match shares
    if (s.nowShares !== null && Math.abs(s.nowAmount - Math.round(s.nowShares * price)) > 1) fail('rupees ≠ shares × price');
    if (s.nowAmount > 0 && (s.nowShares ?? 1) < 1) fail('rupees but no share');
    if (!hasRed && turbulence) {
      const veryVolatile = turbulence.forecast.expectedDipPct / turbulence.forecast.expectedDipAtr >= VERY_VOLATILE_ATR_PCT;
      const thin = turbulence.warnings.some((w) => w.kind === 'thin-liquidity' && w.severity === 'serious');
      // I5 yellow exactly for the two size reasons — never for a dip or the market's steps
      if ((s.light === 'yellow') !== (veryVolatile || thin)) fail('yellow/green does not match the size causes');
      if (planned > 0 && price > 0 && s.label !== 'Under 1 share') {
        // I6 green buys the whole plan in whole shares
        if (s.light === 'green' && s.nowShares !== Math.floor(planned / price + 1e-9)) fail('green does not buy the whole plan');
        // I7 yellow buys the smaller size, raised only to the DP / one-share floor
        if (s.light === 'yellow') {
          const want = Math.min(planned, Math.max(planned * SMALLER_FRACTION, minAmount, price));
          if (s.nowShares !== Math.floor(want / price + 1e-9)) fail('yellow amount is not the smaller size');
        }
      }
    }
    // I8 results never change the decision
    if (inp.resultsOn) {
      const t = addSignal({ ...inp, resultsOn: null });
      if (t.light !== s.light || t.nowAmount !== s.nowAmount) fail('results date changed the decision');
    }
    // I9 the market's steps never change the decision (the 10-year test)
    if (market?.action === 'invest-in-steps') {
      const t = addSignal({ ...inp, market: INVEST });
      if (t.light !== s.light || t.nowAmount !== s.nowAmount) fail('market steps changed the decision');
    }
    // I10 every non-green says why; nowPct in range
    if (s.light !== 'green' && s.reasons.length === 0) fail('no reason given');
    if (s.nowPct < 0 || s.nowPct > 100) fail('nowPct out of range');
  }
  assert.equal(bad.length, 0, bad.join('\n    '));
});

if (failures.length) {
  console.error(`✗ addSignal: ${failures.length} failed, ${passed} passed`);
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`✓ addSignal: ${passed} passed`);
