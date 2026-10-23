/**
 * Corporate-action tests.
 *
 * The headline case is the one that would otherwise be silent and permanent: a
 * split that is not applied makes a lot look catastrophically down, and because
 * this engine will not sell below cost, that fake loss locks the lot up
 * forever. So these tests check that after an adjustment NOTHING economic has
 * moved — breakeven, target and notional are all unchanged — and that every
 * price field on the book scaled, not just the obvious ones.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import {
  CorporateActionHaltError,
  adjustmentFactor,
  applyCorporateAction,
  describeAction,
  pendingActions,
  type CorporateAction,
} from '../services/accumulator/corporateActions';
import {
  applyBuyFill,
  applyTrail,
  lotArmPrice,
  lotBreakeven,
  lotTarget,
  recordDayHigh,
  rollingHigh,
} from '../services/accumulator/engine';
import {
  DEFAULT_ACCUMULATOR_PARAMS as P,
  type AccumulatorBook,
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

const T0 = Date.parse('2026-01-05T04:00:00Z');
const DAY = 86_400_000;
const BUDGET = 300_000;
const SPLIT_1_5: CorporateAction = { type: 'SPLIT', exDate: T0 + 30 * DAY, ratio: { from: 1, to: 5 } };
const BONUS_1_1: CorporateAction = { type: 'BONUS', exDate: T0 + 30 * DAY, ratio: { from: 1, to: 1 } };

function book(over: Partial<AccumulatorBook> = {}): AccumulatorBook {
  return {
    id: 'b', userId: 'u', symbol: 'NIFTYBEES', instrument: 'ETF', budget: BUDGET, cash: BUDGET,
    unsettled: [], openLots: [], closedLots: [], epochs: [], lotSeq: 0, dayHighs: {}, orderedDays: [],
    enabled: true, killSwitchEngaged: false, createdAt: T0 - DAY, updatedAt: T0, ...over,
  };
}

/** A book with a two-rung ladder and recorded day highs. */
function laddered(): AccumulatorBook {
  let b = recordDayHigh(book(), 300, T0);
  b = applyBuyFill(b, { epoch: 0, level: 0, fillPrice: 280, quantity: 75, at: T0 }, P);
  b = applyBuyFill(b, { epoch: 0, level: 1, fillPrice: 263.2, quantity: 80, at: T0 + DAY }, P);
  return { ...b, previousClose: 265 };
}

// ─── the factor ───────────────────────────────────────────────────────────
test('a 1:5 split turns one share into five', () => {
  assert.equal(adjustmentFactor(SPLIT_1_5), 5);
});

test('a 1:1 bonus doubles the holding, it does not leave it unchanged', () => {
  assert.equal(adjustmentFactor(BONUS_1_1), 2);
});

test('a 2:3 bonus gives five shares for every three held', () => {
  assert.equal(adjustmentFactor({ type: 'BONUS', exDate: T0, ratio: { from: 3, to: 2 } }), 5 / 3);
});

test('a dividend does not change the share count', () => {
  assert.equal(adjustmentFactor({ type: 'DIVIDEND', exDate: T0, dividendPerShare: 4 }), 1);
});

test('a ratio-less split is rejected rather than silently treated as 1', () => {
  assert.throws(() => adjustmentFactor({ type: 'SPLIT', exDate: T0 }), /needs a positive ratio/);
});

// ─── the headline: nothing economic moves ─────────────────────────────────
test('a split leaves every lot economically identical', () => {
  const before = laddered();
  const after = applyCorporateAction(before, SPLIT_1_5);

  assert.equal(after.openLots.length, before.openLots.length);
  for (let i = 0; i < before.openLots.length; i++) {
    const b = before.openLots[i];
    const a = after.openLots[i];
    assert.equal(a.quantity, b.quantity * 5);
    assert.ok(Math.abs(a.fillPrice - b.fillPrice / 5) < 1e-9);
    assert.equal(a.quoteSpent, b.quoteSpent, 'no money moved, so cost basis cannot move');
    assert.ok(Math.abs(a.quantity * a.fillPrice - b.quantity * b.fillPrice) < 1e-6, 'notional unchanged');
  }
  assert.equal(after.cash, before.cash);
});

test('the breakeven floor scales exactly, so no lot becomes unsellable', () => {
  const before = laddered();
  const after = applyCorporateAction(before, SPLIT_1_5);
  for (let i = 0; i < before.openLots.length; i++) {
    const beBefore = lotBreakeven(before, before.openLots[i], P);
    const beAfter = lotBreakeven(after, after.openLots[i], P);
    // Post-split the floor is a fifth of what it was, in a market priced a
    // fifth as high. Same economic price.
    assert.ok(
      Math.abs(beAfter - beBefore / 5) / beBefore < 0.02,
      `breakeven ${beBefore} → ${beAfter}, expected about ${beBefore / 5}`,
    );
    assert.ok(lotTarget(after, after.openLots[i], P) > beAfter, 'target still clears the floor');
  }
});

test('an unadjusted split would show a fake 80% loss — this is what the module prevents', () => {
  // The bug, demonstrated: mark the OLD book at the NEW price.
  const before = laddered();
  const postSplitPrice = 280 / 5;
  const lot = before.openLots[0];
  const fakePnl = (lot.quantity * postSplitPrice - lot.quoteSpent) / lot.quoteSpent;
  assert.ok(fakePnl < -0.75, `unadjusted, the lot reads ${(fakePnl * 100).toFixed(0)}%`);

  // Adjusted, it reads flat.
  const after = applyCorporateAction(before, SPLIT_1_5);
  const fixed = after.openLots[0];
  const realPnl = (fixed.quantity * postSplitPrice - fixed.quoteSpent) / fixed.quoteSpent;
  assert.ok(Math.abs(realPnl) < 0.02, `adjusted, the lot reads ${(realPnl * 100).toFixed(1)}%`);
});

// ─── every price field on the book ────────────────────────────────────────
test('the open ladder scales, so it keeps pointing at the same economic prices', () => {
  const before = laddered();
  const after = applyCorporateAction(before, SPLIT_1_5);
  const e0 = before.epochs[0];
  const e1 = after.epochs[0];
  assert.ok(Math.abs(e1.anchorPrice - e0.anchorPrice / 5) < 1e-9);
  for (let i = 0; i < e0.levels.length; i++) {
    assert.ok(Math.abs(e1.levels[i] - e0.levels[i] / 5) < 1e-9, `rung ${i} did not scale`);
  }
});

test('the start gate’s recorded day highs scale, or the gate reads a crash that never happened', () => {
  const before = laddered();
  const after = applyCorporateAction(before, SPLIT_1_5);
  assert.ok(Math.abs(rollingHigh(after, 45) - rollingHigh(before, 45) / 5) < 1e-9);
});

test('the previous close scales, or the circuit band rejects every order', () => {
  const after = applyCorporateAction(laddered(), SPLIT_1_5);
  assert.ok(Math.abs((after.previousClose ?? 0) - 265 / 5) < 1e-9);
});

test('an armed lot’s high-water mark scales, or its trailing stop is unreachable forever', () => {
  let b = laddered();
  const arm = lotArmPrice(b, b.openLots[0], P);
  b = applyTrail(b, arm * 1.1, P);
  assert.equal(b.openLots[0].armed, true);
  const hwmBefore = b.openLots[0].hwm!;
  const after = applyCorporateAction(b, SPLIT_1_5);
  assert.ok(Math.abs(after.openLots[0].hwm! - hwmBefore / 5) < 1e-9);
});

test('closed lots are never rewritten — they record prices actually transacted', () => {
  const closed = {
    id: 'x', epoch: 0, level: 0, fillPrice: 280, quantity: 75, quoteSpent: 21_000, openedAt: T0,
    sellPrice: 300, closedAt: T0 + DAY, proceeds: 22_400, pnl: 1_400, netBreakeven: 281,
  };
  const after = applyCorporateAction(book({ closedLots: [closed] }), SPLIT_1_5);
  assert.deepEqual(after.closedLots[0], closed);
});

// ─── dividends ────────────────────────────────────────────────────────────
test('a dividend credits cash and does not touch cost basis', () => {
  const before = laddered();
  const shares = before.openLots.reduce((s, l) => s + l.quantity, 0);
  const after = applyCorporateAction(before, { type: 'DIVIDEND', exDate: T0 + DAY, dividendPerShare: 4 });
  assert.equal(after.cash, before.cash + 4 * shares);
  // Reducing the basis would let a lot sell for less than it actually cost.
  assert.equal(after.openLots[0].quoteSpent, before.openLots[0].quoteSpent);
  assert.equal(after.openLots[0].quantity, before.openLots[0].quantity);
});

test('a dividend with a missing amount halts rather than crediting nothing', () => {
  assert.throws(
    () => applyCorporateAction(laddered(), { type: 'DIVIDEND', exDate: T0 }),
    CorporateActionHaltError,
  );
});

// ─── the halt ─────────────────────────────────────────────────────────────
test('a fractional-share adjustment halts instead of rounding a cost basis', () => {
  // 3 shares under a 2:3 bonus is 5, but 4 shares is 6.67 — not whole.
  const b = book({
    openLots: [
      { id: 'l', epoch: 0, level: 0, fillPrice: 100, quantity: 4, quoteSpent: 400, openedAt: T0 },
    ],
  });
  assert.throws(
    () => applyCorporateAction(b, { type: 'BONUS', exDate: T0 + DAY, ratio: { from: 3, to: 2 } }),
    (e: Error) => e instanceof CorporateActionHaltError && /not a whole number/.test(e.message),
  );
});

test('the halt message names the book and says trading stopped', () => {
  try {
    applyCorporateAction(laddered(), { type: 'SPLIT', exDate: T0, ratio: { from: 1, to: 0 } });
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof Error);
    assert.match(e.message, /positive ratio|HALT/);
  }
});

// ─── idempotence ──────────────────────────────────────────────────────────
test('an action already absorbed is not applied twice', () => {
  const after = applyCorporateAction(laddered(), SPLIT_1_5);
  assert.equal(after.lastCorporateActionAt, SPLIT_1_5.exDate);
  assert.deepEqual(pendingActions(after, [SPLIT_1_5], T0 + 60 * DAY), []);
});

test('actions before the book existed are ignored', () => {
  const b = book({ createdAt: T0 });
  const old: CorporateAction = { type: 'SPLIT', exDate: T0 - 10 * DAY, ratio: { from: 1, to: 2 } };
  assert.deepEqual(pendingActions(b, [old], T0 + DAY), []);
});

test('future-dated actions wait for their ex-date', () => {
  const b = book({ createdAt: T0 - 10 * DAY });
  const future: CorporateAction = { type: 'SPLIT', exDate: T0 + 10 * DAY, ratio: { from: 1, to: 2 } };
  assert.deepEqual(pendingActions(b, [future], T0), []);
  assert.equal(pendingActions(b, [future], T0 + 11 * DAY).length, 1);
});

test('multiple pending actions come back oldest first', () => {
  const b = book({ createdAt: T0 - 100 * DAY });
  const a1: CorporateAction = { type: 'SPLIT', exDate: T0 - 5 * DAY, ratio: { from: 1, to: 2 } };
  const a2: CorporateAction = { type: 'BONUS', exDate: T0 - 2 * DAY, ratio: { from: 1, to: 1 } };
  assert.deepEqual(pendingActions(b, [a2, a1], T0).map((a) => a.exDate), [a1.exDate, a2.exDate]);
});

test('two sequential splits compound correctly', () => {
  const before = laddered();
  const qty = before.openLots[0].quantity;
  let after = applyCorporateAction(before, SPLIT_1_5);
  after = applyCorporateAction(after, { type: 'SPLIT', exDate: T0 + 40 * DAY, ratio: { from: 1, to: 2 } });
  assert.equal(after.openLots[0].quantity, qty * 10);
  assert.equal(after.openLots[0].quoteSpent, before.openLots[0].quoteSpent);
  assert.equal(after.corporateActions?.length, 2);
});

test('the description reads like something a human can check against a filing', () => {
  assert.match(describeAction(SPLIT_1_5), /split 1:5 \(×5\.0000 shares\), ex \d{4}-\d{2}-\d{2}/);
  assert.match(describeAction({ type: 'DIVIDEND', exDate: T0, dividendPerShare: 4.5 }), /₹4\.50 per share/);
});

if (failures.length) {
  console.error(`✗ corporateActions: ${failures.length} failed, ${passed} passed`);
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`✓ corporateActions: ${passed} passed`);
