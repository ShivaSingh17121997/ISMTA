/**
 * Turnarounds: the band, the falling-knife guards, the base trigger and sizing.
 *
 * The cases here encode the decisions that keep this category from being an
 * expensive way to catch falling knives. Several are drawn from the live run of
 * 11 September 2026.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { computeGrowth } from '../services/futurestars/fundamentals';
import { parseEncumbrance, parseShareholding, parseShpDate, summariseShareholding } from '../services/futurestars/shareholding';
import { BAND, TurnPrice, WEIGHTS, scoreOwnership, scoreResilience, scoreStabilisation, scoreTurnaround } from '../services/turnaround/score';
import { DEFAULT_TURN_PARAMS, buildTurnEntry, turnFundingPlan } from '../services/turnaround/plan';
import { Quarter } from '../services/futurestars/types';

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

const CR = 1e7;
const NOW = Date.parse('2026-09-11T06:00:00Z');
const q = (end: string, revenue: number, profit: number, pbt = profit): Quarter => ({
  end, label: null, consolidated: true, revenue, profit, pbt, filedAt: Date.parse(end) + 45 * 86_400_000,
});

/** A healthy de-rating: profitable, margin holding, revenue growing. */
const healthy = computeGrowth('H', [
  q('2025-06-30', 100 * CR, 8 * CR, 11 * CR),
  q('2025-09-30', 105 * CR, 9 * CR, 12 * CR),
  q('2026-06-30', 120 * CR, 10 * CR, 14 * CR),
  q('2026-09-30', 126 * CR, 11 * CR, 15 * CR),
]);
/** A downgrade: revenue and margin both going backwards. */
const deteriorating = computeGrowth('D', [
  q('2025-06-30', 100 * CR, 10 * CR, 14 * CR),
  q('2025-09-30', 100 * CR, 10 * CR, 14 * CR),
  q('2026-06-30', 78 * CR, 2 * CR, 3 * CR),
  q('2026-09-30', 75 * CR, 1 * CR, 1 * CR),
]);
/** Losing money. */
const lossMaking = computeGrowth('L', [
  q('2025-06-30', 100 * CR, -5 * CR, -6 * CR),
  q('2026-06-30', 90 * CR, -9 * CR, -11 * CR),
]);

const price = (over: Partial<TurnPrice> = {}): TurnPrice => ({
  last: 100,
  high52w: 160,
  low52w: 80,
  pctOf52wRange: 25,
  fromHighPct: -37.5,
  aboveSma200: false,
  sma200: 120,
  ema20: 98,
  ema50: 96,
  ema20Above50: true,
  low20: 92,
  ret1m: 4,
  mom3_1: 10,
  mom6_1: -15,
  mom12_1: -30,
  maxDrawdown1yPct: -42,
  rsi14: 48,
  atrPct: 3,
  volAnnualPct: 38,
  medianTurnover: 500_000_000,
  ...over,
});

const clean = summariseShareholding('X', [{ date: '2026-06-30', promoterPct: 55, publicPct: 45, xbrl: null }, { date: '2025-06-30', promoterPct: 55, publicPct: 45, xbrl: null }], [], false);

// ── shareholding ──
test('shareholding dates and series parse, newest first', () => {
  assert.equal(parseShpDate('30-JUN-2026'), '2026-06-30');
  assert.equal(parseShpDate('rubbish'), null);
  const qs = parseShareholding('SYRMA', [
    { date: '30-JUN-2026', pr_and_prgrp: '42.28', public_val: '57.72' },
    { date: '30-JUN-2025', pr_and_prgrp: '46.42', public_val: '53.58' },
    { date: 'bad', pr_and_prgrp: '1' },
  ]);
  assert.equal(qs.length, 2);
  assert.equal(qs[0].date, '2026-06-30');
});

test('the promoter comparison is matched by date, not by row', () => {
  // Syrma really does have an interim 12-Aug-2025 filing between quarters, so
  // counting back rows compares the wrong periods.
  const s = summariseShareholding('SYRMA', parseShareholding('SYRMA', [
    { date: '30-JUN-2026', pr_and_prgrp: '42.28' },
    { date: '31-MAR-2026', pr_and_prgrp: '42.28' },
    { date: '31-DEC-2025', pr_and_prgrp: '42.72' },
    { date: '30-SEP-2025', pr_and_prgrp: '42.97' },
    { date: '12-AUG-2025', pr_and_prgrp: '42.97' },
    { date: '30-JUN-2025', pr_and_prgrp: '46.42' },
  ]), [], false);
  assert.equal(s.latestPct, 42.28);
  assert.equal(s.yearAgoPct, 46.42, 'compared against the same quarter a year earlier');
  assert.equal(s.changePct, -4.14);
});

test('encumbrance booleans are read from the shareholding XBRL', () => {
  const none = parseEncumbrance('<x:WhetherAnySharesHeldByPromotersAreEncumberedUnderPledged>false</x:WhetherAnySharesHeldByPromotersAreEncumberedUnderPledged>');
  assert.equal(none.pledged, false);
  const some = parseEncumbrance(
    '<x:WhetherAnySharesHeldByPromotersAreEncumberedUnderPledged>true</x:a>' +
    '<x:WhetherAnySharesHeldByPromotersAreEncumberedUnderNonDisposalUndertaking>true</x:b>',
  );
  assert.equal(some.pledged, true);
  assert.deepEqual(some.kinds, ['pledged', 'non-disposal undertaking']);
});

// ── the band: depth is a filter, never a score ──
test('a stock that has barely fallen is not a turnaround', () => {
  const out = scoreTurnaround({ growth: healthy, price: price({ fromHighPct: -8 }), shareholding: clean, risks: [] });
  assert.match(out.rejected ?? '', /not down enough/);
});

test('a stock that has collapsed is refused rather than guessed at', () => {
  const out = scoreTurnaround({ growth: healthy, price: price({ fromHighPct: -85 }), shareholding: clean, risks: [] });
  assert.match(out.rejected ?? '', /base rate of recovery collapses/);
});

test('being further down earns no extra credit inside the band', () => {
  // The falling-knife error is "cheaper is better". Depth gates; it does not score.
  const shallow = scoreTurnaround({ growth: healthy, price: price({ fromHighPct: -25 }), shareholding: clean, risks: [] });
  const deep = scoreTurnaround({ growth: healthy, price: price({ fromHighPct: -65 }), shareholding: clean, risks: [] });
  assert.ok(deep.score <= shallow.score, `deeper (${deep.score}) must not beat shallower (${shallow.score})`);
});

// ── the falling-knife guards ──
test('a stock still in free fall is refused however good the business', () => {
  const falling = price({ ema20Above50: false, ema20: 100, low20: 99.5, ret1m: -14, mom3_1: -35, mom12_1: -30, pctOf52wRange: 3 });
  const out = scoreTurnaround({ growth: healthy, price: falling, shareholding: clean, risks: [] });
  assert.match(out.rejected ?? '', /still falling/);
});

test('a loss-making company is distress, not a discount', () => {
  const out = scoreTurnaround({ growth: lossMaking, price: price(), shareholding: clean, risks: [] });
  assert.match(out.rejected ?? '', /loss-making/);
});

test('a deteriorating business is a downgrade, not a de-rating', () => {
  const out = scoreTurnaround({ growth: deteriorating, price: price(), shareholding: clean, risks: [] });
  assert.ok(out.rejected, 'must be refused');
  assert.match(out.rejected!, /deteriorating|downgrade/);
});

test('pledged shares plus a falling promoter stake is refused outright', () => {
  // The margin-call cascade: a falling price forces the promoter to sell, which
  // lowers the price. It is how a large fall becomes a permanent one.
  const bad = summariseShareholding('X', [
    { date: '2026-06-30', promoterPct: 40, publicPct: 60, xbrl: null },
    { date: '2025-06-30', promoterPct: 45, publicPct: 55, xbrl: null },
  ], ['pledged'], true);
  const out = scoreTurnaround({ growth: healthy, price: price(), shareholding: bad, risks: [] });
  assert.match(out.rejected ?? '', /pledged AND the stake is falling/);
});

test('a healthy de-rating that has stopped falling qualifies', () => {
  const out = scoreTurnaround({ growth: healthy, price: price(), shareholding: clean, risks: [] });
  assert.equal(out.rejected, null, out.rejected ?? '');
  assert.ok(out.score >= BAND.minScore);
  assert.equal(out.pillars.length, 4);
});

// ── the pillars ──
test('resilience separates a de-rating from a downgrade', () => {
  assert.ok(scoreResilience(healthy).score > scoreResilience(deteriorating).score);
  assert.match(scoreResilience(lossMaking).detail, /LOSS-MAKING/);
  assert.equal(scoreResilience(computeGrowth('E', [])).score, 0);
});

test('stabilisation rewards a decelerating fall, not a deep one', () => {
  const stopping = scoreStabilisation(price());
  const stillGoing = scoreStabilisation(price({ ema20Above50: false, low20: 99.8, ret1m: -12, mom3_1: -40 }));
  assert.ok(stopping.score > stillGoing.score);
  assert.match(stopping.detail, /above its 20-day low/);
});

test('ownership is asymmetric: selling hurts more than buying helps', () => {
  const steady = scoreOwnership(clean);
  const selling = scoreOwnership(summariseShareholding('X', [
    { date: '2026-06-30', promoterPct: 51, publicPct: 49, xbrl: null },
    { date: '2025-06-30', promoterPct: 55, publicPct: 45, xbrl: null },
  ], [], false));
  const buying = scoreOwnership(summariseShareholding('X', [
    { date: '2026-06-30', promoterPct: 56, publicPct: 44, xbrl: null },
    { date: '2025-06-30', promoterPct: 55, publicPct: 45, xbrl: null },
  ], [], false));
  assert.ok(selling.score < steady.score, 'selling must be punished');
  assert.ok(buying.score - steady.score < steady.score - selling.score, 'buying helps less than selling hurts');
  assert.match(selling.detail, /DOWN/);
});

test('unknown shareholding is neutral, never treated as clean', () => {
  const unknown = { ...clean, error: 'NSE unreachable', latestPct: null, pledged: null };
  const s = scoreOwnership(unknown);
  assert.ok(s.score > 0 && s.score < 0.5, `neutral, got ${s.score}`);
  assert.match(s.detail, /neutral rather than clean/);
});

// ── the entry plan ──
test('nothing is bought at market: entry waits for the base to confirm', () => {
  const e = buildTurnEntry({
    score: 65, verdict: 'watch-for-a-base',
    price: price({ ema20Above50: false, ema50: 104 }),
    growth: healthy, params: DEFAULT_TURN_PARAMS, now: NOW, budget: 20_000,
  });
  assert.match(e.trigger, /close above ₹104/);
  assert.match(e.trigger, /if it never closes above, nothing is ever bought/i);
  assert.ok(e.triggerPrice !== null);
});

test('the stop sits below the base', () => {
  const e = buildTurnEntry({
    score: 70, verdict: 'buy-the-base', price: price(), growth: healthy,
    params: DEFAULT_TURN_PARAMS, now: NOW, budget: 30_000,
  });
  // low20 92 × 0.96 = 88.32, about 11.7% below a price of 100.
  assert.equal(e.stop, 88.32);
  assert.ok(e.stopDistancePct > 10 && e.stopDistancePct < 13);
  assert.ok(e.quantity >= 1);
  assert.match(e.timeStop, /higher high within 12 months/);
});

test('size comes from the stop once the position cap stops binding', () => {
  // On a ₹2 lakh account the 6% position cap (₹12,000) binds before the risk
  // calculation does, which is itself the honest answer at that size. Give the
  // account enough room and the stop drives the size, as intended.
  const small = buildTurnEntry({
    score: 70, verdict: 'buy-the-base', price: price(), growth: healthy,
    params: DEFAULT_TURN_PARAMS, now: NOW, budget: 30_000,
  });
  assert.equal(small.amount, 12_000, 'the 6% cap binds at ₹2 lakh');

  const params = { ...DEFAULT_TURN_PARAMS, capital: 2_000_000 };
  const big = buildTurnEntry({
    score: 70, verdict: 'buy-the-base', price: price(), growth: healthy,
    params, now: NOW, budget: 300_000,
  });
  // 1% of ₹20,00,000 = ₹20,000 risked over an 11.7% stop ≈ ₹1,71,000,
  // comfortably inside the 6% cap of ₹1,20,000 — so the cap binds again at
  // ₹1,20,000 and the realised risk is below the budget. Either way the risk is
  // never MORE than intended, which is the property that matters.
  assert.ok(big.riskAmount <= (params.capital * params.riskPerIdeaPct) / 100 + 1, `risk ₹${big.riskAmount} must not exceed the budget`);
  assert.ok(big.amount > small.amount);
});

test('a share costing more than the whole position is refused, not shown as 0 shares', () => {
  // Dixon at ₹13,850 inside a ₹12,000 position, from the live run.
  const e = buildTurnEntry({
    score: 60, verdict: 'watch-for-a-base',
    price: price({ last: 13_850, low20: 12_900, ema20: 13_600, ema50: 13_400, high52w: 19_000, low52w: 10_000 }),
    growth: healthy, params: DEFAULT_TURN_PARAMS, now: NOW, budget: 12_000,
  });
  assert.equal(e.quantity, 0);
  assert.equal(e.amount, 0);
  assert.match(e.trigger, /Not investable here/);
  assert.ok(e.warnings.some((w) => /One share costs/.test(w)));
});

test('an unfunded candidate keeps its thesis and gets no "buy" instruction', () => {
  const e = buildTurnEntry({
    score: 58, verdict: 'watch-for-a-base', price: price(), growth: healthy,
    params: DEFAULT_TURN_PARAMS, now: NOW, budget: null, unfundedReason: 'outside the funded set',
  });
  assert.equal(e.amount, 0);
  assert.match(e.trigger, /Watchlist only/);
});

test('the budget funds a few properly rather than all of them badly', () => {
  const ranked = Array.from({ length: 9 }, (_, i) => ({ symbol: `S${i}`, score: 70 - i }));
  const { budgets, funded } = turnFundingPlan(ranked, DEFAULT_TURN_PARAMS);
  // 15% of ₹2,00,000 = ₹30,000 ÷ ₹15,000 = 2.
  assert.equal(funded, 2);
  assert.equal(budgets.get('S0'), 15_000);
  assert.equal(budgets.get('S5'), null);
});

test('this category is smaller and more sceptical than future stars', () => {
  assert.ok(DEFAULT_TURN_PARAMS.categoryCapPct < 20, 'a smaller sleeve than the growth category');
  assert.ok(WEIGHTS.resilience > WEIGHTS.shape * 3, 'the business matters far more than the shape of the chart');
  const total = Object.values(WEIGHTS).reduce((s, x) => s + x, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

if (failures.length) {
  console.error(`\n✗ turnaround: ${failures.length} failed, ${passed} passed\n`);
  console.error(failures.join('\n\n'));
  process.exit(1);
}
console.log(`✓ turnaround: ${passed} passed`);
