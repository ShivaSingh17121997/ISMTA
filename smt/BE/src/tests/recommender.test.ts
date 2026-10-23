/**
 * Recommender tests: measurement, cross-sectional scoring, and the trade plan.
 *
 * The assertions that matter most are the ones protecting against plausible
 * nonsense rather than crashes:
 *
 *   - momentum must SKIP the last month, or it silently measures two opposing
 *     effects at once and reports their average as a signal;
 *   - a score must be a RANK, so it cannot be gamed by a market that is simply
 *     up, and a vetoed stock must not distort the ranks of the rest;
 *   - position size must fall out of the stop, so every idea risks the same
 *     rupees no matter how volatile the stock.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { MIN_BARS, measure } from '../services/recommender/metrics';
import {
  DEFAULT_ELIGIBILITY,
  WEIGHTS,
  scoreHorizon,
  sectorRelativeValues,
  vetoReason,
} from '../services/recommender/score';
import {
  DEFAULT_SIZING,
  HORIZONS,
  buildPlan,
  type SizingParams,
} from '../services/recommender/plan';
import { UNCLASSIFIED, classify, parseConstituents } from '../services/recommender/sectors';
import { applySectorCap, type Recommendation } from '../services/RecommenderEngine';
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
const T0 = Date.parse('2024-01-01T00:00:00Z');

/** A candle series from a close path, with a fixed daily range and volume. */
function series(closes: number[], opts: { rangePct?: number; volume?: number; symbol?: string } = {}): Candle[] {
  const { rangePct = 2, volume = 500_000, symbol = 'TEST' } = opts;
  return closes.map((c, i) => ({
    symbol,
    timestamp: T0 + i * DAY,
    open: c,
    high: c * (1 + rangePct / 200),
    low: c * (1 - rangePct / 200),
    close: c,
    volume,
  }));
}

/** `n` closes compounding at `drift` per bar. */
const drift = (n: number, d: number, start = 100): number[] => {
  const out: number[] = [];
  let p = start;
  for (let i = 0; i < n; i++) { p *= 1 + d; out.push(p); }
  return out;
};

const N = MIN_BARS + 40;

// ─── metrics ───────────────────────────────────────────────────────────────
test('a series shorter than the minimum history is not measured at all', () => {
  assert.equal(measure('X', series(drift(100, 0.001))), null);
  assert.ok(measure('X', series(drift(N, 0.001))) !== null);
});

test('momentum SKIPS the last month, so a late crash does not erase a year of strength', () => {
  // Eleven months up, then a sharp fall over the final month.
  const closes = drift(N - 21, 0.0025);
  const top = closes[closes.length - 1];
  for (let i = 0; i < 21; i++) closes.push(top * (1 - 0.012 * (i + 1)));
  const m = measure('X', series(closes))!;

  assert.ok(m.mom12_1 > 0, `12-1 momentum should stay positive, got ${m.mom12_1}`);
  assert.ok(m.ret1m < 0, `the skipped month should be negative, got ${m.ret1m}`);
  // If the skip were missing, the two would have the same sign.
  assert.ok(m.mom12_1 > 0 && m.ret1m < 0, 'the skip is what keeps these independent');
});

test('position in the 52-week range reads 1 at the high and 0 at the low', () => {
  const up = measure('X', series(drift(N, 0.002)))!;
  assert.ok(up.pctOf52wRange > 0.95, `rising series should sit at its high, got ${up.pctOf52wRange}`);
  assert.ok(up.fromHighPct > -3, 'and close under the 52-week high');

  const down = measure('X', series(drift(N, -0.002)))!;
  assert.ok(down.pctOf52wRange < 0.05, `falling series should sit at its low, got ${down.pctOf52wRange}`);
});

test('a flat series has near-zero volatility and a rising one is above its 200-day', () => {
  const flat = measure('X', series(new Array(N).fill(100)))!;
  assert.ok(flat.volAnnualPct < 1, `flat series volatility ${flat.volAnnualPct}`);
  assert.equal(flat.maxDrawdown1yPct, 0);

  const up = measure('X', series(drift(N, 0.002)))!;
  assert.equal(up.aboveSma200, true);
  assert.equal(up.ema20Above50, true);
  assert.ok(up.trendSpreadPct > 0);
});

test('drawdown measures the worst peak-to-trough, not the start-to-end move', () => {
  // Up 50%, down 30% from there, then back up — ends higher than it began.
  const closes = [...drift(200, 0.002), ...drift(60, -0.006, 149), ...drift(60, 0.004, 104)];
  const m = measure('X', series(closes.slice(-N).length >= MIN_BARS ? closes : [...drift(N - closes.length, 0.001, 80), ...closes]))!;
  assert.ok(m.maxDrawdown1yPct > 15, `should see a real drawdown, got ${m.maxDrawdown1yPct}`);
});

test('liquidity is the MEDIAN daily turnover, so one spike day cannot fake it', () => {
  const candles = series(new Array(N).fill(100), { volume: 1_000 });
  candles[candles.length - 1].volume = 100_000_000; // one enormous day
  const m = measure('X', candles)!;
  assert.ok(m.medianTurnover < 200_000, `median should ignore the spike, got ${m.medianTurnover}`);
  assert.ok(m.volumeRatio > 10, 'but the spike should show up as unusual volume');
});

test('swing levels are found either side of the last close', () => {
  const closes = drift(N, 0.001);
  const m = measure('X', series(closes))!;
  assert.ok(m.low20 <= m.lastClose && m.high20 >= m.lastClose * 0.98);
  if (m.supportRecent !== null) assert.ok(m.supportRecent < m.lastClose, 'support sits below price');
});

// ─── scoring ───────────────────────────────────────────────────────────────
const metricsFor = (symbol: string, closes: number[], o = {}) => measure(symbol, series(closes, { ...o, symbol }))!;

test('every horizon’s weights sum to one', () => {
  for (const [h, w] of Object.entries(WEIGHTS)) {
    const total = Object.values(w).reduce((s, x) => s + x, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `${h} weights sum to ${total}`);
  }
});

test('the strongest stock outranks the weakest at every horizon', () => {
  const universe = [
    metricsFor('STRONG', drift(N, 0.003)),
    metricsFor('MILD', drift(N, 0.0012)),
    metricsFor('FLAT', drift(N, 0.0004)),
  ];
  for (const h of ['long', 'medium', 'short'] as const) {
    const ranked = scoreHorizon(universe, h).filter((r) => !r.vetoed);
    assert.equal(ranked[0].symbol, 'STRONG', `${h}: ${ranked.map((r) => r.symbol).join(',')}`);
    assert.ok(ranked[0].score > ranked[ranked.length - 1].score);
  }
});

test('a score is a RANK: the same stock scores the same whether the market is up or flat', () => {
  // Identical relative ordering, wildly different absolute returns.
  const calm = [metricsFor('A', drift(N, 0.0010)), metricsFor('B', drift(N, 0.0005)), metricsFor('C', drift(N, 0.0002))];
  const boom = [metricsFor('A', drift(N, 0.0040)), metricsFor('B', drift(N, 0.0020)), metricsFor('C', drift(N, 0.0008))];
  const rankOf = (rs: ReturnType<typeof scoreHorizon>) => rs.filter((r) => !r.vetoed).map((r) => r.symbol).join(',');
  assert.equal(rankOf(scoreHorizon(calm, 'long')), rankOf(scoreHorizon(boom, 'long')));
});

test('results come back sorted, best first', () => {
  const universe = [
    metricsFor('C', drift(N, 0.0005)),
    metricsFor('A', drift(N, 0.003)),
    metricsFor('B', drift(N, 0.0015)),
  ];
  const ranked = scoreHorizon(universe, 'long').filter((r) => !r.vetoed);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].score >= ranked[i].score, 'descending by score');
  }
});

test('every score decomposes into the contributions that produced it', () => {
  const universe = [metricsFor('A', drift(N, 0.003)), metricsFor('B', drift(N, 0.001))];
  const top = scoreHorizon(universe, 'long')[0];
  const sum = top.signals.reduce((s, x) => s + x.contribution, 0) * 100;
  assert.ok(Math.abs(sum - top.score) < 1e-9, 'contributions must add up to the score');
  assert.ok(top.signals.every((s) => s.percentile >= 0 && s.percentile <= 1), 'percentiles are 0..1');
  assert.ok(top.signals[0].contribution >= top.signals[top.signals.length - 1].contribution, 'sorted by influence');
});

// ─── vetoes ────────────────────────────────────────────────────────────────
test('a stock below its 200-day average is vetoed at every horizon', () => {
  const down = metricsFor('DOWN', drift(N, -0.002));
  assert.match(vetoReason(down) ?? '', /200-day/);
  for (const h of ['long', 'medium', 'short'] as const) {
    const r = scoreHorizon([down, metricsFor('UP', drift(N, 0.002))], h).find((x) => x.symbol === 'DOWN')!;
    assert.equal(r.vetoed, true);
    assert.equal(r.score, 0);
    assert.ok(r.vetoReason);
  }
});

test('a thinly traded stock is vetoed with its actual turnover in the reason', () => {
  const thin = metricsFor('THIN', drift(N, 0.002), { volume: 100 });
  const reason = vetoReason(thin) ?? '';
  assert.match(reason, /turnover/);
  assert.match(reason, /crore/);
});

test('a penny stock is vetoed on price', () => {
  const penny = measure('PENNY', series(drift(N, 0.002, 5), { symbol: 'PENNY' }))!;
  assert.match(vetoReason(penny) ?? '', /below the ₹20 floor/);
});

test('a vetoed stock does not distort the ranks of the rest', () => {
  const good = [metricsFor('A', drift(N, 0.003)), metricsFor('B', drift(N, 0.001))];
  const withJunk = [...good, metricsFor('JUNK', drift(N, -0.004))];
  const a1 = scoreHorizon(good, 'long').find((r) => r.symbol === 'A')!.score;
  const a2 = scoreHorizon(withJunk, 'long').find((r) => r.symbol === 'A')!.score;
  assert.ok(Math.abs(a1 - a2) < 1e-9, `A scored ${a1} then ${a2} — the veto leaked into the ranks`);
});

test('a single-stock universe scores neutral rather than perfect', () => {
  const only = scoreHorizon([metricsFor('A', drift(N, 0.003))], 'long')[0];
  assert.ok(Math.abs(only.score - 50) < 1e-6, `nothing to compare against, got ${only.score}`);
});

// ─── the trade plan ────────────────────────────────────────────────────────
const planFor = (closes: number[], h: 'short' | 'medium' | 'long' = 'medium', sizing?: Partial<SizingParams>) =>
  buildPlan(metricsFor('P', closes, { volume: 2_000_000 }), HORIZONS[h], { ...DEFAULT_SIZING, ...sizing })!;

test('a plan always states a stop below entry and a target above it', () => {
  for (const h of ['short', 'medium', 'long'] as const) {
    const p = planFor(drift(N, 0.002), h);
    assert.ok(p.stop < p.entry, `${h}: stop ${p.stop} must be below entry ${p.entry}`);
    assert.ok(p.target > p.entry, `${h}: target ${p.target} must be above entry`);
    assert.ok(p.riskPerShare > 0);
  }
});

test('position size falls out of the stop: rupees at risk match the budget', () => {
  const sizing = { ...DEFAULT_SIZING, capital: 500_000, riskPerTradePct: 1, maxPositionPct: 100, maxTurnoverPct: 100 };
  const p = buildPlan(metricsFor('P', drift(N, 0.002), { volume: 5_000_000 }), HORIZONS.medium, sizing)!;
  const budget = (sizing.capital * sizing.riskPerTradePct) / 100;
  assert.ok(p.riskAmount <= budget + 1e-6, `risking ${p.riskAmount} against a ${budget} budget`);
  // Whole shares only, so it lands just under rather than exactly on.
  assert.ok(p.riskAmount > budget - p.riskPerShare, 'and uses almost all of it');
});

test('a wider stop buys FEWER shares for the same rupee risk', () => {
  const sizing = { ...DEFAULT_SIZING, maxPositionPct: 100, maxTurnoverPct: 100 };
  const calm = buildPlan(metricsFor('C', drift(N, 0.002), { rangePct: 1, volume: 5_000_000 }), HORIZONS.medium, sizing)!;
  const wild = buildPlan(metricsFor('W', drift(N, 0.002), { rangePct: 8, volume: 5_000_000 }), HORIZONS.medium, sizing)!;
  assert.ok(wild.stopDistancePct > calm.stopDistancePct, 'the volatile name needs a wider stop');
  assert.ok(wild.quantity < calm.quantity, `volatile ${wild.quantity} should be smaller than calm ${calm.quantity}`);
  // The whole point: both risk about the same money.
  assert.ok(Math.abs(wild.riskAmount - calm.riskAmount) / Math.max(calm.riskAmount, 1) < 0.1);
});

test('the stop never exceeds the horizon cap, however far the swing low sits', () => {
  for (const h of ['short', 'medium', 'long'] as const) {
    // A volatile series pushes both the ATR stop and the swing-low stop out.
    const p = buildPlan(
      metricsFor('V', drift(N, 0.002), { rangePct: 12, volume: 5_000_000 }),
      HORIZONS[h],
      DEFAULT_SIZING,
    )!;
    assert.ok(
      p.stopDistancePct <= HORIZONS[h].maxStopPct + 0.5,
      `${h}: stop ${p.stopDistancePct.toFixed(1)}% exceeds the ${HORIZONS[h].maxStopPct}% cap`,
    );
  }
});

test('a capped stop says so and warns that true invalidation is further away', () => {
  const p = buildPlan(
    metricsFor('V', drift(N, 0.002), { rangePct: 14, volume: 5_000_000 }),
    HORIZONS.short,
    DEFAULT_SIZING,
  )!;
  assert.match(p.stopNote, /Capped at 6% below entry/);
  assert.ok(p.warnings.some((w) => /stop cap/.test(w)), p.warnings.join('|'));
});

test('a longer horizon uses a wider stop than a shorter one', () => {
  const closes = drift(N, 0.002);
  const s = planFor(closes, 'short');
  const l = planFor(closes, 'long');
  assert.ok(l.stopDistancePct > s.stopDistancePct, `long ${l.stopDistancePct}% vs short ${s.stopDistancePct}%`);
});

test('the position cap binds when a tight stop would imply an enormous position', () => {
  const sizing = { ...DEFAULT_SIZING, capital: 1_000_000, riskPerTradePct: 5, maxPositionPct: 10, maxTurnoverPct: 100 };
  const p = buildPlan(metricsFor('P', drift(N, 0.002), { rangePct: 0.5, volume: 50_000_000 }), HORIZONS.long, sizing)!;
  assert.equal(p.sizedBy, 'position cap');
  assert.ok(p.pctOfCapital <= 10 + 1e-9, `${p.pctOfCapital}% exceeds the 10% cap`);
});

test('the liquidity cap binds on a thinly traded stock and says so', () => {
  const sizing = { ...DEFAULT_SIZING, capital: 10_000_000, maxPositionPct: 100, maxTurnoverPct: 1, minPositionValue: 0 };
  const p = buildPlan(metricsFor('P', drift(N, 0.002), { volume: 3_000 }), HORIZONS.medium, sizing)!;
  assert.equal(p.sizedBy, 'liquidity cap');
  assert.ok(p.warnings.some((w) => /Thinly traded/.test(w)), p.warnings.join('|'));
});

test('a position too small for the flat charges is flagged, not silently recommended', () => {
  const sizing = { ...DEFAULT_SIZING, capital: 20_000, riskPerTradePct: 0.5, minPositionValue: 16_000 };
  const p = buildPlan(metricsFor('P', drift(N, 0.002), { volume: 5_000_000 }), HORIZONS.medium, sizing)!;
  assert.equal(p.sizedBy, 'too small to trade');
  assert.ok(p.warnings.some((w) => /below the ₹16,000 floor/.test(w)), p.warnings.join('|'));
});

test('reward:risk is honoured and the rupee figures agree with it', () => {
  const p = planFor(drift(N, 0.002), 'medium');
  const rr = (p.target - p.entry) / p.riskPerShare;
  assert.ok(Math.abs(rr - HORIZONS.medium.rewardRisk) < 0.05, `reward:risk came out ${rr}`);
  if (p.quantity > 0) {
    assert.ok(Math.abs(p.rewardAmount / p.riskAmount - rr) < 0.05, 'rupee reward:risk must match per-share');
  }
});

test('every plan explains its entry, its stop and its target in words', () => {
  const p = planFor(drift(N, 0.002), 'medium');
  assert.ok(p.entryNote.length > 20 && p.stopNote.length > 20 && p.targetNote.length > 20);
  assert.ok(['buy now', 'wait for pullback', 'wait for breakout'].includes(p.entryKind));
  assert.match(p.holdLabel, /\d/);
});

test('a target beyond the 52-week high is flagged rather than quietly promised', () => {
  // A strong uptrend sits at its high, so any target is a new high.
  const p = planFor(drift(N, 0.004), 'long');
  if (p.target > metricsFor('P', drift(N, 0.004)).high52w) {
    assert.ok(p.warnings.some((w) => /52-week high/.test(w)), p.warnings.join('|'));
  }
});

// ── sector classification and the concentration cap ──

// Real shape of the NIFTY 500 file: quoted company names contain commas, so the
// trailing columns are the only stable ones.
const CSV = [
  'Company Name,Industry,Symbol,Series,ISIN Code',
  '"Hindustan Aeronautics Ltd.",Capital Goods,HAL,EQ,INE066F01020',
  '"Syrma SGS Technology Ltd.",Capital Goods,SYRMA,EQ,INE0DYJ01015',
  '"Tata Power Company Ltd.",Power,TATAPOWER,EQ,INE245A01021',
  '"Bajaj Auto Ltd., formerly Bajaj Holdings",Automobile and Auto Components,BAJAJ-AUTO,EQ,INE917I01010',
].join('\n');

test('the constituent parser survives commas inside quoted company names', () => {
  const m = parseConstituents(CSV);
  assert.equal(m.size, 4);
  assert.equal(m.get('HAL'), 'Capital Goods');
  // The row with a comma inside the quoted name must still resolve.
  assert.equal(m.get('BAJAJ-AUTO'), 'Automobile and Auto Components');
});

test('a malformed or empty file yields nothing rather than a guess', () => {
  assert.equal(parseConstituents('').size, 0);
  assert.equal(parseConstituents('Nothing,Useful\n1,2').size, 0);
});

test('themes separate what the NSE sector cannot', () => {
  const s = parseConstituents(CSV);
  // Both are "Capital Goods" to the exchange. That is the whole reason themes exist.
  assert.equal(classify('HAL', s).sector, classify('SYRMA', s).sector);
  assert.deepEqual(classify('HAL', s).themes, ['Defence']);
  assert.ok(classify('SYRMA', s).themes.includes('Semiconductors & Electronics'));
});

test('a stock can carry several themes, and one outside the file still gets a sector', () => {
  const s = parseConstituents(CSV);
  const tp = classify('TATAPOWER', s);
  assert.ok(tp.themes.includes('Power') && tp.themes.includes('Renewable & green energy'));
  // Not in the CSV, but in the fallback.
  assert.equal(classify('LTIM', s).sector, 'Information Technology');
  // Not in either: honestly unclassified, never invented.
  assert.equal(classify('NOSUCHCO', s).sector, UNCLASSIFIED);
  assert.deepEqual(classify('NOSUCHCO', s).themes, []);
});

/** A minimal funded pick — only the fields the cap reads. */
function pick(symbol: string, sector: string, score: number, amount: number): Recommendation {
  return {
    symbol, sector, score, themes: [], rank: 1, name: symbol,
    allocatedAmount: amount, allocatedPct: (amount / 100_000) * 100,
    duplicateOf: null, newsSuppressed: false,
  } as unknown as Recommendation;
}

test('the sector cap trims the weakest idea and leaves the strongest whole', () => {
  const picks = [
    pick('A', 'Defence', 90, 20_000),
    pick('B', 'Defence', 80, 20_000),
    pick('C', 'Defence', 70, 20_000),
  ];
  applySectorCap(picks, 100_000, 25); // limit ₹25,000
  assert.equal(picks[0].allocatedAmount, 20_000, 'best idea untouched');
  assert.equal(picks[1].allocatedAmount, 5_000, 'second trimmed to the remaining room');
  assert.equal(picks[2].allocatedAmount, 0, 'third gets nothing');
  assert.match(picks[1].sectorCapped ?? '', /Trimmed/);
  assert.match(picks[2].sectorCapped ?? '', /No capital/);
});

test('the cap never binds when a book is already diversified', () => {
  const picks = [pick('A', 'Defence', 90, 20_000), pick('B', 'FMCG', 80, 20_000)];
  const exp = applySectorCap(picks, 100_000, 25);
  assert.ok(picks.every((p) => p.allocatedAmount === 20_000 && !p.sectorCapped));
  assert.ok(exp.every((e) => !e.capped));
  assert.equal(exp[0].amount, 20_000);
});

test('Unclassified is exempt — it is a bag of unrelated names, not a sector', () => {
  const picks = [
    pick('A', UNCLASSIFIED, 90, 20_000),
    pick('B', UNCLASSIFIED, 80, 20_000),
    pick('C', UNCLASSIFIED, 70, 20_000),
  ];
  applySectorCap(picks, 100_000, 25);
  assert.ok(picks.every((p) => p.allocatedAmount === 20_000), 'no trimming without real sector information');
});

test('exposure reports the sectors largest first and totals what was actually funded', () => {
  const picks = [
    pick('A', 'Defence', 90, 30_000),
    pick('B', 'FMCG', 80, 10_000),
    pick('C', 'Defence', 70, 30_000),
  ];
  const exp = applySectorCap(picks, 200_000, 25); // limit ₹50,000
  assert.equal(exp[0].sector, 'Defence');
  assert.equal(exp[0].amount, 50_000);
  assert.equal(exp[0].pct, 25);
  assert.ok(exp[0].capped);
  assert.deepEqual(exp[0].symbols, ['A', 'C']);
  assert.equal(exp[1].amount, 10_000);
});

// ── sector-relative momentum ──

test('a value is standardised against its own sector, not the whole market', () => {
  // Two sectors on very different scales. Within each, the middle name should
  // land near zero — which raw values could never tell you.
  const values = [10, 20, 30, 40, 110, 120, 130, 140];
  const secs = ['A', 'A', 'A', 'A', 'B', 'B', 'B', 'B'];
  const z = sectorRelativeValues(values, secs);
  // The nth name of A and the nth of B must standardise identically: the
  // sectors differ only by a level shift.
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(z[i] - z[i + 4]) < 1e-9, `${z[i]} vs ${z[i + 4]}`);
  assert.ok(z[0] < 0 && z[3] > 0, 'the weakest in a sector must be negative, the strongest positive');
});

test('a sector too small to characterise falls back to the whole universe', () => {
  // 'B' has one member, so its own mean is itself and its z would be 0 —
  // silently making a bad stock look average. It must be measured globally.
  const values = [10, 20, 30, 40, 1000];
  const secs = ['A', 'A', 'A', 'A', 'B'];
  const z = sectorRelativeValues(values, secs, 4);
  assert.ok(z[4] > 1, `the lone outlier must stay an outlier, got ${z[4]}`);
});

test('a sector whose members are identical yields no spread rather than a divide-by-zero', () => {
  const z = sectorRelativeValues([5, 5, 5, 5], ['A', 'A', 'A', 'A']);
  assert.ok(z.every((x) => x === 0), z.join(','));
});

test('the strong name in a weak sector beats the weak name in a strong sector', () => {
  // This is the whole point. PHARMA1..4 all soar; CEMENT1..4 all crawl. Under
  // plain cross-sectional ranking the pharma names sweep the board and the
  // list becomes one sector bet. Sector-relative ranking must promote the best
  // cement name above the WORST pharma name.
  const universe = [
    metricsFor('PH1', drift(N, 0.0040)), metricsFor('PH2', drift(N, 0.0038)),
    metricsFor('PH3', drift(N, 0.0036)), metricsFor('PH4', drift(N, 0.0034)),
    metricsFor('CE1', drift(N, 0.0012)), metricsFor('CE2', drift(N, 0.0006)),
    metricsFor('CE3', drift(N, 0.0004)), metricsFor('CE4', drift(N, 0.0002)),
  ];
  const sectors = new Map([
    ['PH1', 'Pharma'], ['PH2', 'Pharma'], ['PH3', 'Pharma'], ['PH4', 'Pharma'],
    ['CE1', 'Cement'], ['CE2', 'Cement'], ['CE3', 'Cement'], ['CE4', 'Cement'],
  ]);
  const rank = (ss: ReturnType<typeof scoreHorizon>) =>
    ss.filter((x) => !x.vetoed).sort((a, b) => b.score - a.score).map((x) => x.symbol);

  const plain = rank(scoreHorizon(universe, 'long', DEFAULT_ELIGIBILITY));
  const relative = rank(scoreHorizon(universe, 'long', DEFAULT_ELIGIBILITY, sectors));

  // Without sectors, the four pharma names take the top four places.
  assert.deepEqual(plain.slice(0, 4), ['PH1', 'PH2', 'PH3', 'PH4'], plain.join(','));
  // With sectors, the best cement name climbs above the worst pharma name.
  assert.ok(relative.indexOf('CE1') < relative.indexOf('PH4'),
    `expected CE1 above PH4, got ${relative.join(',')}`);
});

test('passing no sector map leaves scoring exactly as it was', () => {
  const universe = [
    metricsFor('A', drift(N, 0.003)), metricsFor('B', drift(N, 0.002)),
    metricsFor('C', drift(N, 0.001)), metricsFor('D', drift(N, 0.0005)),
  ];
  const without = scoreHorizon(universe, 'medium', DEFAULT_ELIGIBILITY);
  // Every symbol in one bucket is the same as no bucketing at all.
  const oneBucket = new Map(universe.map((m) => [m.symbol, 'ALL'] as const));
  const withOne = scoreHorizon(universe, 'medium', DEFAULT_ELIGIBILITY, oneBucket);
  for (let i = 0; i < without.length; i++) {
    assert.ok(Math.abs(without[i].score - withOne[i].score) < 1e-9,
      `${without[i].symbol}: ${without[i].score} vs ${withOne[i].score}`);
  }
});

test('a signal reports whether its percentile was sector-relative', () => {
  const universe = [
    metricsFor('A', drift(N, 0.003)), metricsFor('B', drift(N, 0.002)),
    metricsFor('C', drift(N, 0.001)), metricsFor('D', drift(N, 0.0005)),
  ];
  const secs = new Map(universe.map((m) => [m.symbol, 'Pharma'] as const));
  const s = scoreHorizon(universe, 'long', DEFAULT_ELIGIBILITY, secs)[0];
  const mom = s.signals.find((x) => x.name === 'momRiskAdj12_1');
  const range = s.signals.find((x) => x.name === 'pctOf52wRange');
  assert.equal(mom?.sectorRelative, true, 'momentum is ranked within sector');
  assert.equal(range?.sectorRelative, false, '52-week range is not — it is a position, not a return');
  // Without a map, nothing claims to be sector-relative.
  const plain = scoreHorizon(universe, 'long')[0];
  assert.ok(plain.signals.every((x) => !x.sectorRelative));
});

// ── the 2026-09-09 weight revision ──

test('the signals with no evidence behind them carry no weight', () => {
  for (const [h, w] of Object.entries(WEIGHTS)) {
    assert.equal(w.adx14, undefined, `${h} still weights ADX`);
    assert.equal(w.momRiskAdj3_1, undefined, `${h} still weights 3-month momentum`);
  }
  // Volume ratio is kept, but only as a token so its sign can be tested later.
  assert.ok((WEIGHTS.short.volumeRatio ?? 0) <= 0.05, 'volume ratio must stay de-weighted');
});

test('long and medium use both momentum windows but tilt to opposite ones', () => {
  // Weighting the two windows equally at BOTH horizons made long and medium
  // near-identical scorers: they picked the same five stocks, medium deduped to
  // nothing, and its entire budget went unspent. Three horizons must ask three
  // questions, so the tilt is the thing to protect.
  for (const h of ['long', 'medium'] as const) {
    const w = WEIGHTS[h];
    assert.ok(w.momRiskAdj6_1 > 0 && w.momRiskAdj12_1 > 0, `${h} must use both windows`);
  }
  assert.ok(WEIGHTS.long.momRiskAdj12_1 > WEIGHTS.long.momRiskAdj6_1,
    'the long horizon must lean on the 12-month window');
  assert.ok(WEIGHTS.medium.momRiskAdj6_1 > WEIGHTS.medium.momRiskAdj12_1,
    'the medium horizon must lean on the 6-month window');
});

test('no two horizons score the same way', () => {
  // A direct guard on the failure above: identical weight vectors mean one
  // bucket is decorative and its budget is dead capital.
  const key = (h: 'long' | 'medium' | 'short') =>
    Object.entries(WEIGHTS[h]).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}:${v}`).join(',');
  const keys = (['long', 'medium', 'short'] as const).map(key);
  assert.equal(new Set(keys).size, 3, `two horizons share a weight vector — ${keys.join(' || ')}`);
});

if (failures.length) {
  console.error(`✗ recommender: ${failures.length} failed, ${passed} passed`);
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`✓ recommender: ${passed} passed`);
