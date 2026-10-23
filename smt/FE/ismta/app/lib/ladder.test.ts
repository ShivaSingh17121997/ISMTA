/**
 * Ladder-view tests.
 *
 * Run: npm test  (node's type stripping — no test framework is installed, and
 * adding one to pull in a single suite would be a bigger change than the code
 * it covers). Assertions come from `node:assert`.
 *
 * It lives in the frontend, beside the module it tests, rather than in the
 * backend suite: importing across the two projects broke `tsc`'s `rootDir`, so
 * the backend build failed even though the test itself passed.
 *
 * WHAT THESE PROTECT
 *
 *  - The dead zone. `unrealised` counts buy-side charges only; `breakeven` also
 *    carries the sell side, including the FLAT DP charge. Between them a lot is
 *    up on paper and still a loss to sell. Measured against the engine's own
 *    cost model (`BE/src/services/accumulator/math.ts`, qty × price grid) that
 *    band is 0.11% of the lot at ₹2,00,000 and 1.70% at ₹1,000 — so it is
 *    widest exactly where positions are smallest. Colouring on `unrealised`
 *    would paint those lots GREEN on a screen whose whole promise is that it
 *    never sells at a loss.
 *  - Epoch isolation. A book that has run several ladders holds closed lots at
 *    the same rung NUMBERS from earlier epochs; matching on level alone would
 *    show an old sale against a live rung.
 *  - Sold rungs stay sold while the engine counts them filled (`filledLevels`); a
 *    rung whose lot closed is not bought again in that ladder. Rendering it as
 *    "waiting" would promise a buy that cannot happen.
 */
import assert from 'node:assert/strict';
import { buildLadder, lotState, paperEven, type LotState } from './ladder.ts';
import type { AccumulatorBook, AccumulatorClosedLot, AccumulatorLot } from './types.ts';

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push(`  x ${name}\n    ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
}

/**
 * A held lot with REAL numbers: 30 shares at ₹500, and the spend and breakeven
 * the engine's cost model actually produces for it. Hardcoded rather than
 * imported so this suite does not reach into the backend — the backend has its
 * own tests for the cost model; this one only needs a pair where breakeven
 * sits above paper-even, which is the property under test.
 */
const SPENT = 15_003.03;
const BREAKEVEN = 500.2447;

function heldLot(over: Partial<AccumulatorLot> = {}): AccumulatorLot {
  return {
    id: 'lot-1',
    epoch: 0,
    level: 0,
    fillPrice: 500,
    quantity: 30,
    quoteSpent: SPENT,
    openedAt: 0,
    breakeven: BREAKEVEN,
    ...over,
  };
}

function closedLot(over: Partial<AccumulatorClosedLot> = {}): AccumulatorClosedLot {
  return {
    ...heldLot(),
    sellPrice: 520,
    closedAt: 1,
    proceeds: 15_500,
    pnl: 496.97,
    netBreakeven: BREAKEVEN,
    ...over,
  };
}

function book(over: Partial<AccumulatorBook> = {}): AccumulatorBook {
  return {
    id: 'b',
    symbol: 'TEST',
    enabled: true,
    instrument: 'EQUITY',
    budget: 100_000,
    cash: 0,
    unsettled: [],
    openLots: [],
    closedLots: [],
    epochs: [
      { index: 0, anchorPrice: 500, levels: [500, 470, 437.7], filledLevels: [0], status: 'OPEN' },
    ],
    killSwitchEngaged: false,
    updatedAt: 0,
    ...over,
  };
}

// ── the colour rule ─────────────────────────────────────────────────────────

test('breakeven sits above paper-even, so the dead zone is real', () => {
  const lot = heldLot();
  assert.ok(
    lot.breakeven! > paperEven(lot),
    'breakeven must exceed paper-even, or the sell-side charges are missing',
  );
});

test('a mark inside the dead zone is AMBER, and the naive rule would say green', () => {
  const lot = heldLot();
  const paper = paperEven(lot);
  const mid = (paper + lot.breakeven!) / 2;
  assert.ok(mid > paper && mid < lot.breakeven!, 'fixture must straddle the band');
  assert.equal(lotState(mid, lot), 'deadzone');
  // The trap, stated as an assertion: `unrealised` is POSITIVE right here.
  assert.ok(lot.quantity * mid - lot.quoteSpent > 0, 'unrealised is positive in the dead zone');
});

test('at or above breakeven is GREEN, boundary included', () => {
  const lot = heldLot();
  assert.equal(lotState(lot.breakeven!, lot), 'clears');
  assert.equal(lotState(lot.breakeven! + 1, lot), 'clears');
});

test('below paper-even is RED; paper-even itself is not yet a loss on spend', () => {
  const lot = heldLot();
  const paper = paperEven(lot);
  assert.equal(lotState(paper - 0.01, lot), 'down');
  assert.equal(lotState(paper, lot), 'deadzone');
});

test('the three states are exhaustive and ordered by mark', () => {
  const lot = heldLot();
  const paper = paperEven(lot);
  const seen: LotState[] = [
    lotState(paper * 0.9, lot),
    lotState((paper + lot.breakeven!) / 2, lot),
    lotState(lot.breakeven! * 1.1, lot),
  ];
  assert.deepEqual(seen, ['down', 'deadzone', 'clears']);
});

test('a lot with no served breakeven invents no floor', () => {
  const lot = heldLot({ breakeven: undefined, quantity: 10, quoteSpent: 5000 });
  assert.equal(lotState(499, lot), 'down');
  assert.equal(lotState(500, lot), 'clears', 'falls back to paper-even, nothing invented');
});

test('a zero-quantity lot does not divide by zero', () => {
  const lot = heldLot({ quantity: 0, quoteSpent: 0, breakeven: undefined });
  assert.equal(paperEven(lot), 0);
  assert.equal(lotState(10, lot), 'clears');
});

// ── ladder assembly ─────────────────────────────────────────────────────────

test('every rung of the open epoch gets exactly one row', () => {
  const v = buildLadder(book(), []);
  assert.ok(v);
  assert.equal(v.rows.length, 3);
  assert.deepEqual(v.rows.map((r) => r.level), [0, 1, 2]);
});

test('no open epoch is a normal state, not an error', () => {
  const b = book({
    epochs: [{ index: 0, anchorPrice: 500, levels: [500], filledLevels: [0], status: 'CLOSED' }],
  });
  assert.equal(buildLadder(b, []), null);
});

test('a held lot marks its rung held; the rest wait', () => {
  const v = buildLadder(book(), [heldLot()]);
  assert.ok(v);
  assert.equal(v.rows[0].kind, 'held');
  assert.equal(v.rows[1].kind, 'waiting');
  assert.equal(v.held, 1);
  assert.equal(v.waiting, 2);
});

test('a SOLD rung stays sold — never shown as waiting again', () => {
  const v = buildLadder(book({ closedLots: [closedLot()] }), []);
  assert.ok(v);
  assert.equal(v.rows[0].kind, 'sold');
  assert.equal(v.sold, 1);
  assert.equal(v.waiting, 2, 'the sold rung must NOT be counted as waiting');
});

test('a sold rung the engine re-armed is waiting again, because it will buy on the next dip', () => {
  const b = book({
    closedLots: [closedLot({ level: 1 })],
    epochs: [{ index: 0, anchorPrice: 500, levels: [500, 470, 437.7], filledLevels: [0], status: 'OPEN' }],
  });
  const v = buildLadder(b, [heldLot()]);
  assert.ok(v);
  assert.equal(v.rows[1].kind, 'waiting', 'rung 1 is no longer in filledLevels');
  assert.equal(v.next?.level, 1);
});

test('lots match on epoch AND level, never level alone', () => {
  // A closed lot at rung 0 of an EARLIER ladder must not attach to rung 0 of
  // the live one.
  const b = book({
    epochs: [
      { index: 0, anchorPrice: 600, levels: [600], filledLevels: [0], status: 'CLOSED' },
      { index: 1, anchorPrice: 500, levels: [500, 470], filledLevels: [], status: 'OPEN' },
    ],
    closedLots: [closedLot({ epoch: 0, level: 0 })],
  });
  const v = buildLadder(b, []);
  assert.ok(v);
  assert.equal(v.epochIndex, 1);
  assert.equal(v.rows[0].kind, 'waiting', 'rung 0 of the LIVE ladder is still unbought');
  assert.equal(v.sold, 0);
});

test('the next rung is the shallowest unfilled one', () => {
  const v = buildLadder(book(), [heldLot({ level: 0 })]);
  assert.ok(v);
  assert.equal(v.next?.level, 1);
  assert.equal(v.next?.kind, 'waiting');
});

test('a fully filled ladder has no next rung', () => {
  const b = book({
    epochs: [{ index: 0, anchorPrice: 500, levels: [500], filledLevels: [0], status: 'OPEN' }],
  });
  const v = buildLadder(b, [heldLot({ level: 0 })]);
  assert.ok(v);
  assert.equal(v.next, null);
  assert.equal(v.waiting, 0);
});

test('held + sold + waiting always accounts for every rung', () => {
  const b = book({
    epochs: [
      { index: 0, anchorPrice: 500, levels: [500, 470, 437, 410], filledLevels: [0, 1], status: 'OPEN' },
    ],
    closedLots: [closedLot({ level: 1 })],
  });
  const v = buildLadder(b, [heldLot({ level: 0 })]);
  assert.ok(v);
  assert.equal(v.rows.length, 4);
  assert.equal(v.held + v.sold + v.waiting, v.rows.length);
});

test('rung prices carry through in ladder order, descending from the anchor', () => {
  const v = buildLadder(book(), []);
  assert.ok(v);
  const prices = v.rows.map((r) => r.price);
  assert.deepEqual(prices, [500, 470, 437.7]);
  for (let i = 1; i < prices.length; i++) {
    assert.ok(prices[i] < prices[i - 1], 'a ladder must descend');
  }
  assert.equal(v.anchorPrice, 500, 'rung 0 is the anchor');
});

if (failures.length) {
  console.error(`x ladder: ${failures.length} failed, ${passed} passed`);
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`ok ladder: ${passed} passed`);
