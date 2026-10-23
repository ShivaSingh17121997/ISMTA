/**
 * findUnbookedFills — every filled engine order must be on its book.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { findUnbookedFills } from '../services/accumulator/fillAudit';
import type { AccumulatorBook, ClosedLot, Lot } from '../services/accumulator/types';
import type { Order } from '../types';

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

const U = 'u1';
const T = 1_790_000_000_000;

function book(over: Partial<AccumulatorBook> = {}): AccumulatorBook {
  return { userId: U, symbol: 'ABC', createdAt: T - 1_000, openLots: [], closedLots: [], ...over } as AccumulatorBook;
}
function lot(over: Partial<Lot> = {}): Lot {
  return { id: 'ABC-e0-l0-0', epoch: 0, level: 0, fillPrice: 100, quantity: 10, quoteSpent: 1_001, openedAt: T, ...over };
}
function closed(over: Partial<ClosedLot> = {}): ClosedLot {
  return { ...lot(), sellPrice: 105, closedAt: T + 5_000, proceeds: 1_048, pnl: 47, netBreakeven: 100.2, ...over };
}
function order(over: Partial<Order> = {}): Order {
  return {
    id: 'o1', userId: U, symbol: 'ABC', side: 'BUY', quantity: 10, orderType: 'LIMIT', product: 'CNC',
    tag: 'accumulator:e0l0', status: 'FILLED', filledQuantity: 10, filledPrice: 100,
    createdAt: T, updatedAt: T, ...over,
  } as Order;
}

test('a BUY whose lot carries its order id is booked', () => {
  assert.deepEqual(findUnbookedFills([order()], [book({ openLots: [lot({ orderId: 'o1' })] })]), []);
});

test('a BUY still counts as booked after its lot has closed', () => {
  assert.deepEqual(findUnbookedFills([order()], [book({ closedLots: [closed({ orderId: 'o1' })] })]), []);
});

test('an older lot without the link matches on epoch, rung and the step time', () => {
  assert.deepEqual(findUnbookedFills([order()], [book({ openLots: [lot()] })]), []);
});

test('a BUY whose lot was cleared before going live is still booked', () => {
  const cleared = { ...lot(), clearedAt: T + 10_000, markPrice: 95, value: 950, pnl: -51 };
  assert.deepEqual(findUnbookedFills([order()], [book({ clearedLots: [cleared] })]), [], 'legacy match on epoch, rung and time');
  assert.deepEqual(findUnbookedFills([order()], [book({ clearedLots: [{ ...cleared, orderId: 'o1' }] })]), [], 'linked by order id');
});

test('a BUY with no lot is unbooked', () => {
  const r = findUnbookedFills([order()], [book()]);
  assert.equal(r.length, 1);
  assert.equal(r[0].bookMissing, false);
  assert.match(r[0].reason, /no lot records it/);
});

test('a lot on the same rung opened at another time does not hide a lost BUY', () => {
  const r = findUnbookedFills([order()], [book({ openLots: [lot({ openedAt: T - 60_000 })] })]);
  assert.equal(r.length, 1);
});

test('a lot linked to a different order does not hide a lost BUY', () => {
  const r = findUnbookedFills([order()], [book({ openLots: [lot({ orderId: 'other' })] })]);
  assert.equal(r.length, 1);
});

test('a SELL whose closed lot carries its order id is booked', () => {
  const sell = order({ id: 's1', side: 'SELL', tag: 'accumulator:ABC-e0-l0-0' });
  assert.deepEqual(findUnbookedFills([sell], [book({ closedLots: [closed({ sellOrderId: 's1' })] })]), []);
});

test('an older SELL matches on its lot id being closed', () => {
  const sell = order({ id: 's1', side: 'SELL', tag: 'accumulator:ABC-e0-l0-0' });
  assert.deepEqual(findUnbookedFills([sell], [book({ closedLots: [closed()] })]), []);
});

test('a SELL whose lot is still open is unbooked', () => {
  const sell = order({ id: 's1', side: 'SELL', tag: 'accumulator:ABC-e0-l0-0' });
  const r = findUnbookedFills([sell], [book({ openLots: [lot()] })]);
  assert.equal(r.length, 1);
  assert.match(r[0].reason, /still open/);
});

test('orders that did not trade are ignored', () => {
  const r = findUnbookedFills(
    [order({ status: 'REJECTED', filledQuantity: 0 }), order({ id: 'o2', status: 'CANCELLED', filledQuantity: 0 })],
    [book()],
  );
  assert.deepEqual(r, []);
});

test('a partial BUY that traded is still checked', () => {
  const r = findUnbookedFills([order({ status: 'CANCELLED', filledQuantity: 4 })], [book()]);
  assert.equal(r.length, 1);
});

test('orders that are not the engine\'s are ignored', () => {
  const r = findUnbookedFills(
    [order({ tag: undefined }), order({ id: 'o2', tag: 'sweep:LIQUIDCASE' }), order({ id: 'o3', tag: 'ticket' })],
    [book()],
  );
  assert.deepEqual(r, []);
});

test('an order for a removed book is reported but marked so it never halts anything', () => {
  const r = findUnbookedFills([order()], []);
  assert.equal(r.length, 1);
  assert.equal(r[0].bookMissing, true);
});

test('orders from before a re-added book was created are not its history', () => {
  assert.deepEqual(findUnbookedFills([order({ createdAt: T - 86_400_000 })], [book()]), []);
});

test('books are matched per user and symbol, case-insensitively', () => {
  const other = book({ userId: 'u2', openLots: [lot({ orderId: 'o1' })] });
  assert.equal(findUnbookedFills([order({ symbol: 'abc' })], [other, book()]).length, 1);
  assert.equal(findUnbookedFills([order({ symbol: 'abc' })], [book({ openLots: [lot({ orderId: 'o1' })] })]).length, 0);
});

if (failures.length) {
  console.error(`✗ fillAudit: ${failures.length} failed, ${passed} passed`);
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`✓ fillAudit: ${passed} passed`);
