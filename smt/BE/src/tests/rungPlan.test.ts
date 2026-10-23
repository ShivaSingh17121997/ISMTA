/**
 * Hand-set rung count: the preview (accumulator/rungPlan.ts), the allocator
 * keeping it, and — the point — that the preview's rupees per rung are what
 * the engine actually spends when the rung buys.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { planRungs } from '../services/accumulator/rungPlan';
import { applyBuyFill, decide, openEpoch, recordDayHigh, sellLot, lotTarget } from '../services/accumulator/engine';
import { DEFAULT_ACCUMULATOR_PARAMS as P, type AccumulatorBook } from '../services/accumulator/types';
import { allocate, bookCandidateFields, DEFAULT_ALLOCATION_PARAMS as AP, type Candidate } from '../services/allocator/allocate';

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

const T0 = Date.parse('2026-01-05T05:00:00Z');
const DAY = 86_400_000;
const LIMITS = { minPerRung: AP.minTranche, maxRungs: AP.maxRungs };

function book(over: Partial<AccumulatorBook> = {}): AccumulatorBook {
  const b = {
    id: 'b', userId: 'u', symbol: 'ABC', instrument: 'EQUITY', budget: 60_000, cash: 60_000,
    unsettled: [], openLots: [], closedLots: [], epochs: [], lotSeq: 0, dayHighs: {}, orderedDays: [],
    enabled: true, killSwitchEngaged: false, createdAt: 0, updatedAt: 0, ...over,
  } as AccumulatorBook;
  return recordDayHigh(b, 100, T0 - DAY);
}

/** A book whose ladder has bought rungs 0 and 1 on `rungs` rungs. */
function twoBought(rungs: number, budget = 120_000): AccumulatorBook {
  let b = book({ budget, cash: budget, tranches: rungs });
  const d0 = decide(b, 95, T0, P).find((d) => d.action === 'BUY')!;
  b = applyBuyFill(b, { epoch: 0, level: 0, fillPrice: d0.limitPrice!, quantity: d0.quantity!, at: T0 }, P);
  const r1 = openEpoch(b)!.levels[1];
  const d1 = decide(b, r1, T0 + 2 * DAY, P).find((d) => d.action === 'BUY')!;
  return applyBuyFill(b, { epoch: 0, level: 1, fillPrice: r1, quantity: d1.quantity!, at: T0 + 2 * DAY }, P);
}

// ─── the preview ─────────────────────────────────────────────────────────
test('a fresh ₹60,000 on 3 rungs is ₹17,000 a rung after the 15% reserve', () => {
  const plan = planRungs(book(), 60_000, 3, P, LIMITS);
  assert.equal(plan.error, null);
  assert.equal(plan.toBuy, 3);
  assert.equal(plan.bought, 0);
  assert.ok(Math.abs(plan.perRung - 17_000) < 1e-6);
  assert.equal(plan.maxRungs, 3, '4 rungs would be ₹12,750 each');
});

test('too many rungs for the amount is refused, with the most allowed', () => {
  const plan = planRungs(book(), 60_000, 4, P, LIMITS);
  assert.match(plan.error ?? '', /₹12,750 per rung.*at most 3/);
});

test('more than the 12-rung maximum is refused; a fraction or zero is refused', () => {
  assert.match(planRungs(book(), 1_000_000, 13, P, LIMITS).error ?? '', /At most 12/);
  assert.match(planRungs(book(), 60_000, 2.5, P, LIMITS).error ?? '', /whole number/);
  assert.match(planRungs(book(), 60_000, 0, P, LIMITS).error ?? '', /whole number/);
});

test('fewer rungs than the ladder has already bought is refused', () => {
  const b = twoBought(4);
  const plan = planRungs(b, 120_000, 1, P, LIMITS);
  assert.equal(plan.bought, 2);
  assert.equal(plan.minRungs, 2);
  assert.match(plan.error ?? '', /Choose 2 or more/);
});

test('on an open ladder, what is left is split over the rungs still to buy', () => {
  const b = twoBought(4);
  const spent = b.openLots.reduce((s, l) => s + l.quoteSpent, 0);
  const plan = planRungs(b, 120_000, 5, P, LIMITS);
  assert.equal(plan.toBuy, 3);
  assert.ok(Math.abs(plan.perRung - (120_000 * 0.85 - spent) / 3) < 1e-6);
});

test('choosing exactly the rungs already bought is allowed: nothing more to buy', () => {
  const plan = planRungs(twoBought(4), 120_000, 2, P, LIMITS);
  assert.equal(plan.error, null);
  assert.equal(plan.toBuy, 0);
});

test('a sold, re-armed rung counts as one still to buy', () => {
  let b = twoBought(4);
  const lot1 = b.openLots.find((l) => l.level === 1)!;
  b = sellLot(b, lot1.id, lotTarget(b, lot1, P), T0 + 3 * DAY, T0 + 4 * DAY, P);
  const plan = planRungs(b, 120_000, 4, P, LIMITS);
  assert.equal(plan.bought, 1);
  assert.equal(plan.toBuy, 3);
});

// ─── the engine spends exactly what the preview says ─────────────────────
test('the first rung the engine buys is the preview\'s rupees per rung, to within one share', () => {
  for (const [amount, rungs] of [[60_000, 3], [100_000, 5], [200_000, 10], [30_000, 1]] as const) {
    const plan = planRungs(book(), amount, rungs, P, LIMITS);
    assert.equal(plan.error, null, `${amount}/${rungs}: ${plan.error}`);
    const b = book({ budget: amount, cash: amount, tranches: rungs });
    const buy = decide(b, 95, T0, P).find((d) => d.action === 'BUY')!;
    const spend = buy.quantity! * buy.limitPrice!;
    assert.ok(spend <= plan.perRung && spend > plan.perRung - buy.limitPrice!, `${amount}/${rungs}: spent ${spend}, preview ${plan.perRung}`);
  }
});

test('on an open ladder, the next rung the engine buys matches the preview too', () => {
  const b0 = twoBought(4);
  const plan = planRungs(b0, 150_000, 5, P, LIMITS);
  // Apply what the allocator would: the new budget and rung count.
  const b = { ...b0, budget: 150_000, cash: b0.cash + 30_000, tranches: 5 };
  const r2 = openEpoch(b)!.levels[2];
  const buy = decide(b, r2, T0 + 5 * DAY, P).find((d) => d.action === 'BUY')!;
  assert.equal(buy.level, 2);
  const spend = buy.quantity! * buy.limitPrice!;
  assert.ok(spend <= plan.perRung && spend > plan.perRung - buy.limitPrice!, `spent ${spend}, preview ${plan.perRung}`);
});

// ─── the allocator keeps the hand-set count ──────────────────────────────
const cand = (over: Partial<Candidate>): Candidate => ({
  symbol: 'ABC', score: 0.5, trendUp: true, eligible: true, deployed: 0, unsettled: 0, cash: 0, openLots: 0, ...over,
});

test('a hand-set rung count goes onto the allocation, run after run', () => {
  for (let run = 0; run < 3; run++) {
    const plan = allocate([cand({ manualBudget: 60_000, manualTranches: 2 })], AP);
    assert.equal(plan.allocations[0].tranches, 2);
    assert.match(plan.allocations[0].reason, /2 rung\(s\) \(rungs set by you\)/);
  }
});

test('without a hand-set count the allocator picks one from the new cash, as before', () => {
  const plan = allocate([cand({ manualBudget: 60_000 })], AP);
  assert.equal(plan.allocations[0].tranches, 3);
});

test('a rung count is only carried while an amount is set', () => {
  const b = book({ manualTranches: 4 });
  assert.equal(bookCandidateFields(b).manualTranches, undefined);
  assert.equal(bookCandidateFields({ ...b, manualBudget: 60_000 }).manualTranches, 4);
});

if (failures.length) {
  console.error(`✗ rungPlan: ${failures.length} failed, ${passed} passed`);
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`✓ rungPlan: ${passed} passed`);
