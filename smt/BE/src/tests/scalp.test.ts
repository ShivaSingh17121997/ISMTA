/**
 * Scalping-mode tests.
 *
 * Scalp mode is a profile on the accumulator, so the assertions that matter are
 * the ones proving it is ONLY a profile: the no-loss floor does not move when
 * the toggle flips, a scalp still cannot sell a lot below cost, and every knob
 * the overlay is not supposed to touch is untouched.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { nextTradingDayStart } from '../services/session';
import {
  BreakevenViolationError,
  applyBuyFill,
  decide,
  deployCeiling,
  lotBreakeven,
  lotTarget,
  paramsFor,
  recordDayHigh,
  sellLot,
} from '../services/accumulator/engine';
import {
  DEFAULT_SCALP_PROFILE as SP,
  applyScalpOverlay,
  describeProfile,
  scalpActive,
  validateScalp,
} from '../services/accumulator/scalp';
import {
  DEFAULT_ACCUMULATOR_PARAMS,
  type AccumulatorBook,
  type AccumulatorParams,
} from '../services/accumulator/types';

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

const P: AccumulatorParams = DEFAULT_ACCUMULATOR_PARAMS;
const BUDGET = 300_000;
const T0 = Date.parse('2026-01-05T04:00:00Z'); // Monday 09:30 IST
const HOUR = 3_600_000;

function book(over: Partial<AccumulatorBook> = {}): AccumulatorBook {
  return {
    id: 'b1',
    userId: 'u1',
    symbol: 'NIFTYBEES',
    instrument: 'ETF',
    budget: BUDGET,
    cash: BUDGET,
    unsettled: [],
    openLots: [],
    closedLots: [],
    epochs: [],
    lotSeq: 0,
    dayHighs: {},
    orderedDays: [],
    enabled: true,
    killSwitchEngaged: false,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

/** A book holding one lot bought at `price`, with the day's high recorded. */
function withLot(price: number, over: Partial<AccumulatorBook> = {}): AccumulatorBook {
  let b = recordDayHigh(book(over), price, T0);
  const qty = Math.floor((BUDGET * 0.85) / P.tranches / price);
  b = applyBuyFill(b, { epoch: 0, level: 0, fillPrice: price, quantity: qty, at: T0 }, P);
  return b;
}

// ─── the overlay itself ───────────────────────────────────────────────────
test('scalp overlay rewrites exactly the knobs it claims to', () => {
  const s = applyScalpOverlay(P);
  assert.equal(s.targetPct, SP.targetPct);
  assert.equal(s.stepPct, SP.stepPct);
  assert.equal(s.stepGrowth, SP.stepGrowth);
  assert.equal(s.minBuyGapMs, SP.minBuyGapMs);
  assert.equal(s.startDiscountPct, SP.startDiscountPct);
  assert.equal(s.hiLookbackDays, SP.hiLookbackDays);
  assert.equal(s.maxDeployPct, SP.maxDeployPct);
});

test('the overlay never touches the reserve or the slippage buffer', () => {
  // These two feed the breakeven floor and the capital rule. A UI toggle that
  // moved either would move a lot's floor under it.
  const s = applyScalpOverlay(P);
  assert.equal(s.reservePct, P.reservePct);
  assert.equal(s.slippageBufferPct, P.slippageBufferPct);
  assert.equal(s.tranches, P.tranches);
});

test('scalp is tighter than swing on every dimension that defines a scalp', () => {
  const s = applyScalpOverlay(P);
  assert.ok(s.targetPct < P.targetPct, 'smaller target');
  assert.ok(s.stepPct < P.stepPct, 'tighter rungs');
  assert.ok(s.minBuyGapMs < P.minBuyGapMs, 'faster cadence');
  assert.ok(s.startDiscountPct < P.startDiscountPct, 'shallower dip gate');
  assert.ok(s.hiLookbackDays < P.hiLookbackDays, 'shorter lookback');
  assert.ok(s.maxDeployPct < P.maxDeployPct, 'and a drawdown cap swing does not have');
});

test('scalpActive reads the book flag, and an unset flag is swing', () => {
  assert.equal(scalpActive(book()), false);
  assert.equal(scalpActive(book({ scalp: false })), false);
  assert.equal(scalpActive(book({ scalp: true })), true);
});

test('paramsFor applies scalp first, then lets the allocator rung count win', () => {
  const p = paramsFor(book({ scalp: true, tranches: 3 }), P);
  assert.equal(p.targetPct, SP.targetPct, 'scalp target applied');
  assert.equal(p.tranches, 3, "the allocator's rung count is not overwritten by the profile");
  assert.equal(paramsFor(book({ scalp: true }), P).tranches, P.tranches);
});

test('paramsFor returns the untouched params for a swing book', () => {
  assert.equal(paramsFor(book(), P), P, 'same object — the tick path allocates nothing');
});

// ─── the invariant, under the profile ─────────────────────────────────────
test('flipping scalp does not move a lot’s breakeven floor', () => {
  const swing = withLot(100);
  const scalp = { ...swing, scalp: true };
  const lot = swing.openLots[0];
  assert.equal(
    lotBreakeven(scalp, lot, paramsFor(scalp, P)),
    lotBreakeven(swing, lot, paramsFor(swing, P)),
    'the floor is a fact about cost, not about the profile',
  );
});

test('scalp lowers the sell target but never below the floor', () => {
  const swing = withLot(100);
  const scalp = { ...swing, scalp: true };
  const lot = swing.openLots[0];
  const floor = lotBreakeven(swing, lot, P);
  const swingTarget = lotTarget(swing, lot, paramsFor(swing, P));
  const scalpTarget = lotTarget(scalp, lot, paramsFor(scalp, P));
  assert.ok(scalpTarget < swingTarget, `scalp ${scalpTarget} should undercut swing ${swingTarget}`);
  assert.ok(scalpTarget >= floor, `scalp target ${scalpTarget} must clear the floor ${floor}`);
});

test('a scalp sale below cost is still refused — the invariant is under the profile', () => {
  const b = { ...withLot(100), scalp: true };
  const lot = b.openLots[0];
  const floor = lotBreakeven(b, lot, paramsFor(b, P));
  assert.throws(
    () => sellLot(b, lot.id, floor - 0.5, T0 + HOUR, nextTradingDayStart(T0 + HOUR), paramsFor(b, P)),
    BreakevenViolationError,
  );
});

test('a scalp sale at its own target books a profit', () => {
  const b = { ...withLot(100), scalp: true };
  const lot = b.openLots[0];
  const p = paramsFor(b, P);
  const next = sellLot(b, lot.id, lotTarget(b, lot, p), T0 + HOUR, nextTradingDayStart(T0 + HOUR), p);
  assert.equal(next.closedLots.length, 1);
  assert.ok(next.closedLots[0].pnl > 0, `pnl ${next.closedLots[0].pnl} must be positive`);
});

test('scalp exits are never gated by the deployment cap', () => {
  // Cap exceeded on purpose: the sell must still be decided.
  const b = { ...withLot(100), scalp: true };
  const lot = b.openLots[0];
  const target = lotTarget(b, lot, paramsFor(b, P));
  const decisions = decide(b, target + 1, T0 + 3 * HOUR, P);
  assert.ok(decisions.some((d) => d.action === 'SELL' && d.lotId === lot.id), 'exit decided');
});

// ─── entry cadence ────────────────────────────────────────────────────────
test('scalp anchors on a shallower dip than swing refuses at', () => {
  // 2.5% under the recorded high: past scalp's 2% gate, short of swing's 3%.
  const hi = 100;
  const price = 97.5;
  const swing = recordDayHigh(book(), hi, T0);
  const scalp = { ...swing, scalp: true };
  const swingDecision = decide(swing, price, T0, P)[0];
  const scalpDecision = decide(scalp, price, T0, P)[0];
  assert.equal(swingDecision.action, 'HOLD');
  assert.match(swingDecision.reason, /Start gate/);
  assert.equal(scalpDecision.action, 'BUY', `scalp should anchor: ${scalpDecision.reason}`);
});

test('the scalp buy brake is hours, not a day', () => {
  const b = { ...withLot(100), scalp: true };
  // 3h after the fill: past scalp's 2h brake, far short of swing's 24h.
  const swingDecision = decide({ ...b, scalp: false }, 90, T0 + 3 * HOUR, P)[0];
  assert.match(swingDecision.reason, /Crash-cascade brake/);
  const scalpDecisions = decide(b, 90, T0 + 3 * HOUR, P);
  assert.ok(
    !scalpDecisions.some((d) => /Crash-cascade brake/.test(d.reason)),
    'the 2h brake has expired for a scalp',
  );
});

test('scalp ladders are even; swing ladders widen', () => {
  const b = recordDayHigh(book({ scalp: true }), 100, T0);
  const filled = applyBuyFill(b, { epoch: 0, level: 0, fillPrice: 100, quantity: 10, at: T0 }, P);
  const lv = filled.epochs[0].levels;
  const gaps = lv.slice(1).map((p, i) => 1 - p / lv[i]);
  for (const g of gaps) assert.ok(Math.abs(g - SP.stepPct / 100) < 1e-9, `even ${SP.stepPct}% rungs`);

  const swingFilled = applyBuyFill(
    recordDayHigh(book(), 100, T0),
    { epoch: 0, level: 0, fillPrice: 100, quantity: 10, at: T0 },
    P,
  );
  const sl = swingFilled.epochs[0].levels;
  assert.ok(1 - sl[2] / sl[1] > 1 - sl[1] / sl[0], 'swing gaps compound');
});

// ─── the deployment cap ───────────────────────────────────────────────────
test('the deployment ceiling is a percentage of budget', () => {
  assert.equal(deployCeiling(book(), P), BUDGET, 'swing: no ceiling beyond the reserve');
  assert.equal(
    deployCeiling(book({ scalp: true }), applyScalpOverlay(P)),
    (BUDGET * SP.maxDeployPct) / 100,
  );
});

test('a scalp stops laddering at its deployment ceiling instead of filling every rung', () => {
  // Deep in the ladder with the cap already reached: the rung is crossed and
  // there is settled cash, and it still refuses.
  const b = book({
    scalp: true,
    cash: BUDGET,
    openLots: [
      { id: 'l0', epoch: 0, level: 0, fillPrice: 100, quantity: 1, quoteSpent: (BUDGET * SP.maxDeployPct) / 100, openedAt: T0 },
    ],
    epochs: [{ index: 0, anchorPrice: 100, openedAt: T0, levels: [100, 98, 96.04], filledLevels: [0], status: 'OPEN' }],
    lastBuyAt: T0 - 5 * HOUR,
  });
  const d = decide(b, 97, T0, P);
  assert.ok(!d.some((x) => x.action === 'BUY'), 'no buy at the ceiling');
  assert.match(d[d.length - 1].reason, /Deployment cap/);
});

test('the same book under swing has no ceiling and buys the rung', () => {
  const b = book({
    cash: BUDGET,
    openLots: [
      { id: 'l0', epoch: 0, level: 0, fillPrice: 100, quantity: 1, quoteSpent: (BUDGET * SP.maxDeployPct) / 100, openedAt: T0 },
    ],
    epochs: [{ index: 0, anchorPrice: 100, openedAt: T0, levels: [100, 94, 87.1], filledLevels: [0], status: 'OPEN' }],
    lastBuyAt: T0 - 30 * HOUR,
  });
  assert.ok(decide(b, 93, T0, P).some((x) => x.action === 'BUY'));
});

// ─── the economic guard ───────────────────────────────────────────────────
test('scalp is refused on a tranche the flat DP charge would eat', () => {
  // ₹6,000 budget over 12 rungs is a ₹425 tranche: the round trip alone is
  // several percent, far above the 1.5% target.
  const errors = validateScalp(book({ budget: 6_000 }), P, 100);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /below 1.5x the round-trip cost/);
});

test('scalp is accepted on a tranche that clears 1.5x the round trip', () => {
  assert.deepEqual(validateScalp(book({ budget: BUDGET }), P, 100), []);
});

test('scalp is refused on a book the allocator sized at zero', () => {
  const errors = validateScalp(book({ budget: 0 }), P, 100);
  assert.match(errors[0], /no budget to scalp with/);
});

test('scalp is refused when a tranche does not buy one share', () => {
  const errors = validateScalp(book({ budget: 6_000 }), P, 5_000);
  assert.match(errors[0], /does not buy one share/);
});

test('the profile description says which profile is in force', () => {
  assert.match(describeProfile(true), /scalp/);
  assert.match(describeProfile(false), /swing/);
});

if (failures.length) {
  console.error(`✗ scalp: ${failures.length} failed, ${passed} passed`);
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`✓ scalp: ${passed} passed`);
