/**
 * The Sell button: a lot sold BY HAND at market, even below cost.
 * Checklist: FORCE_SELL_CHECKLIST.md at the repo root (ids A1…D2 below).
 *
 *   - the pure booking (`forceSellLot`) and the unchanged bot path (`sellLot`);
 *   - the real service (`accumulatorEngine.forceSell`) against the real paper
 *     broker at a fixed in-session time, through the shared order loop;
 *   - what reads closed lots afterwards: the report, the tax ledger, the fill audit;
 *   - the two routes, over HTTP, against the real app in this process.
 *
 * No network, no Mongo. Run: npm test
 */
import './_httpTestEnv';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app';
import { signToken } from '../middleware/auth';
import { brokerFor } from '../brokers/registry';
import { accumulatorEngine, createBook, reportFor } from '../services/AccumulatorEngine';
import { orderRateLimiter } from '../services/guards';
import { marketData } from '../services/MarketDataService';
import { isMarketOpen, nextTradingDayStart } from '../services/session';
import { findUnbookedFills } from '../services/accumulator/fillAudit';
import { matchFifo, transactionsFromBooks } from '../services/tax/ledger';
import {
  BreakevenViolationError,
  applyBuyFill,
  forceSellEstimate,
  forceSellLot,
  recordDayHigh,
  sellLot,
} from '../services/accumulator/engine';
import { DEFAULT_ACCUMULATOR_PARAMS as P, type AccumulatorBook } from '../services/accumulator/types';
import { store } from '../store/memoryStore';
import type { BrokerOrderResult } from '../brokers/BaseBroker';
import type { OrderRequest } from '../types';

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures.push(`  ✗ ${name}\n    ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
}

// Monday 5 Jan 2026, 10:30 IST — inside the session. Sunday is closed.
const OPEN = Date.parse('2026-01-05T05:00:00Z');
const CLOSED = Date.parse('2026-01-04T05:00:00Z');
const NEXT_DAY = Date.parse('2026-01-06T05:00:00Z');
const HOUR = 3_600_000;
const USER = 'fsell-user';
store.users.set(USER, { id: USER, email: 'fsell@test.in', passwordHash: 'x', name: USER, role: 'trader', createdAt: OPEN - 30 * 86_400_000 });

let seq = 0;
/** A book with a 45-day high of 100, ready to anchor a ladder under 97. */
function seed(): AccumulatorBook {
  const symbol = `FSELL${seq++}`;
  let b = createBook({ userId: USER, symbol, instrument: 'ETF', budget: 300_000 });
  b = { ...b, createdAt: OPEN - 7 * 86_400_000 };
  b = recordDayHigh(b, 100, OPEN - 86_400_000);
  store.saveAccumulatorBook(b);
  return b;
}
const price = (symbol: string, p: number) => marketData.ingestExternal(symbol, p);

/** A seeded book holding one lot, bought by the real engine at 95. */
async function bookWithLot(): Promise<AccumulatorBook> {
  // The 10-orders-a-second limiter runs on the wall clock; this suite places
  // dozens of orders in well under a second.
  (orderRateLimiter as unknown as { stamps: number[] }).stamps = [];
  const b0 = seed();
  price(b0.symbol, 95);
  const b = await accumulatorEngine.step(b0, 95, OPEN);
  assert.equal(b.openLots.length, 1, 'fixture: the engine should have bought rung 0');
  return b;
}

/** A pure book with lots at the given rungs, for the booking tests. */
function pureBook(levels: number[]): AccumulatorBook {
  let b: AccumulatorBook = { ...createBook({ userId: 'pure', symbol: 'PURE', instrument: 'EQUITY', budget: 500_000 }) };
  levels.forEach((level, i) => {
    b = applyBuyFill(b, { epoch: 0, level, fillPrice: 100 - level * 6, quantity: 100, at: OPEN + i }, P);
  });
  return b;
}

async function main(): Promise<void> {
  // ── A. pure booking ──────────────────────────────────────────────────
  await test('A1 forceSellLot books the named lot at the given price, at a loss, flagged forced', () => {
    const b = pureBook([0]);
    const lot = b.openLots[0];
    const after = forceSellLot(b, lot.id, 90, OPEN + HOUR, NEXT_DAY, P, 'ord-1');
    assert.equal(after.openLots.length, 0);
    const c = after.closedLots[0];
    assert.equal(c.id, lot.id);
    assert.equal(c.sellPrice, 90);
    assert.equal(c.forced, true);
    assert.equal(c.sellOrderId, 'ord-1');
    assert.ok(c.pnl < 0, `expected a loss, got ${c.pnl}`);
    assert.ok(Math.abs(c.pnl - (c.proceeds - lot.quoteSpent)) < 1e-9);
    assert.ok(Math.abs(c.proceeds - forceSellEstimate(b, lot, 90).proceeds) < 1e-9, 'estimate and booking must agree');
  });

  await test('A2 proceeds go to the T+1 queue, not into cash', () => {
    const b = pureBook([0]);
    const after = forceSellLot(b, b.openLots[0].id, 90, OPEN + HOUR, NEXT_DAY, P);
    assert.equal(after.cash, b.cash);
    assert.equal(after.unsettled.length, 1);
    assert.equal(after.unsettled[0].settlesAt, NEXT_DAY);
    assert.equal(after.unsettled[0].amount, after.closedLots[0].proceeds);
  });

  await test('A3 a forced sale never re-arms its rung (a bot sale at profit does)', () => {
    assert.equal(P.rearmSoldRungs, true, 'fixture: re-arm is on by default');
    const b = pureBook([0, 1]);
    const deep = b.openLots.find((l) => l.level === 1)!;
    const forced = forceSellLot(b, deep.id, 80, OPEN + HOUR, NEXT_DAY, P);
    assert.ok(forced.epochs[0].filledLevels.includes(1), 'forced: rung 1 must stay filled');
    // Contrast: the bot's own profitable sale of the same lot re-arms it.
    const bot = sellLot(b, deep.id, 120, OPEN + HOUR, NEXT_DAY, P);
    assert.ok(!bot.epochs[0].filledLevels.includes(1), 'bot sale: rung 1 re-arms');
  });

  await test('A4 force-selling the last open lot closes the epoch; an earlier one does not', () => {
    const b = pureBook([0, 1]);
    const one = forceSellLot(b, b.openLots[0].id, 90, OPEN + HOUR, NEXT_DAY, P);
    assert.equal(one.epochs[0].status, 'OPEN');
    const two = forceSellLot(one, one.openLots[0].id, 90, OPEN + HOUR, NEXT_DAY, P);
    assert.equal(two.epochs[0].status, 'CLOSED');
  });

  await test('A5 refuses an unknown lot, a non-positive price and a halted book', () => {
    const b = pureBook([0]);
    assert.throws(() => forceSellLot(b, 'nope', 90, OPEN, NEXT_DAY, P), /No open lot/);
    assert.throws(() => forceSellLot(b, b.openLots[0].id, 0, OPEN, NEXT_DAY, P), /positive price/);
    assert.throws(() => forceSellLot({ ...b, haltedReason: 'x' }, b.openLots[0].id, 90, OPEN, NEXT_DAY, P), /halted/);
  });

  await test('A6 the bot path is unchanged: sellLot still refuses the same loss', () => {
    const b = pureBook([0]);
    assert.throws(() => sellLot(b, b.openLots[0].id, 90, OPEN, NEXT_DAY, P), BreakevenViolationError);
  });

  // ── B. the service, through the real order loop and paper broker ─────
  await test('B3/B4/B8 a forced sale goes out as a MARKET CNC exit, is booked and logged', async () => {
    const b = await bookWithLot();
    const lot = b.openLots[0];
    price(b.symbol, 90);
    const r = await accumulatorEngine.forceSell(USER, b.symbol, [lot.id], { stopBuying: true }, OPEN + HOUR);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.sold.length, 1);
    assert.ok(r.sold[0].pnl < 0, 'sold at 90 against a 95 buy: a loss');

    const stored = store.accumulatorBook(USER, b.symbol)!;
    assert.equal(stored.openLots.length, 0, 'the saved book no longer holds the lot');
    const c = stored.closedLots.find((l) => l.id === lot.id)!;
    assert.equal(c.forced, true);

    const order = store.orders.get(c.sellOrderId!)!;
    assert.ok(order, 'the order row exists and is linked from the closed lot');
    assert.equal(order.side, 'SELL');
    assert.equal(order.orderType, 'MARKET');
    assert.equal(order.product, 'CNC');
    assert.equal(order.intent, 'exit');
    assert.equal(order.tag, `accumulator:${lot.id}`);
    assert.equal(order.status, 'FILLED');
    assert.equal(order.price, undefined, 'a MARKET order carries no limit price');

    const ev = accumulatorEngine.recentEvents(50).find((e) => e.symbol === b.symbol && e.kind === 'FILL' && /FORCED SALE/.test(e.detail));
    assert.ok(ev, 'a FILL event names the forced sale');
  });

  await test('B6 "stop new buys" engages the kill switch first, and the next step buys nothing', async () => {
    const b = await bookWithLot();
    price(b.symbol, 90);
    const r = await accumulatorEngine.forceSell(USER, b.symbol, [b.openLots[0].id], { stopBuying: true }, OPEN + HOUR);
    assert.equal(r.killSwitchEngaged, true);
    // Deep under the high, a new ladder would anchor at once without the switch.
    price(b.symbol, 85);
    const next = await accumulatorEngine.step(store.accumulatorBook(USER, b.symbol)!, 85, NEXT_DAY);
    assert.equal(next.openLots.length, 0, 'no buy after a forced sale with stop-buying on');
    assert.equal(next.killSwitchEngaged, true, 'the step kept the switch');
  });

  await test('B6b without "stop new buys" the kill switch is left alone', async () => {
    const b = await bookWithLot();
    price(b.symbol, 90);
    const r = await accumulatorEngine.forceSell(USER, b.symbol, [b.openLots[0].id], { stopBuying: false }, OPEN + HOUR);
    assert.equal(r.ok, true);
    assert.equal(store.accumulatorBook(USER, b.symbol)!.killSwitchEngaged, false);
  });

  await test('B1 refusals send no order and say why', async () => {
    const b = await bookWithLot();
    const lotId = b.openLots[0].id;
    price(b.symbol, 90);
    const before = store.orders.size;
    const cases: [string, () => Promise<{ refused?: string }>, RegExp][] = [
      ['no lots', () => accumulatorEngine.forceSell(USER, b.symbol, [], { stopBuying: true }, OPEN + HOUR), /at least one/],
      ['unknown lot', () => accumulatorEngine.forceSell(USER, b.symbol, ['ghost'], { stopBuying: true }, OPEN + HOUR), /Not open/],
      ['market closed', () => accumulatorEngine.forceSell(USER, b.symbol, [lotId], { stopBuying: true }, CLOSED), /closed/],
      ['unknown book', () => accumulatorEngine.forceSell(USER, 'NOSUCH', [lotId], { stopBuying: true }, OPEN + HOUR), /No such/],
    ];
    for (const [name, run, re] of cases) {
      const r = await run();
      assert.match(r.refused ?? '', re, name);
    }
    store.saveAccumulatorBook({ ...store.accumulatorBook(USER, b.symbol)!, haltedReason: 'reconcile mismatch' });
    assert.match((await accumulatorEngine.forceSell(USER, b.symbol, [lotId], { stopBuying: true }, OPEN + HOUR)).refused ?? '', /halted/);
    store.saveAccumulatorBook({ ...store.accumulatorBook(USER, b.symbol)!, haltedReason: undefined, venue: 'live' });
    assert.match((await accumulatorEngine.forceSell(USER, b.symbol, [lotId], { stopBuying: true }, OPEN + HOUR)).refused ?? '', /Zerodha/);
    assert.equal(store.orders.size, before, 'no order was recorded by any refusal');
    const after = store.accumulatorBook(USER, b.symbol)!;
    assert.equal(after.openLots.length, 1, 'the lot is still held');
    assert.equal(after.killSwitchEngaged, false, 'a refused sale does not engage the kill switch');
  });

  await test('B2 waits for an in-flight step, then sells exactly once', async () => {
    const b = await bookWithLot();
    price(b.symbol, 90);
    const key = `${USER}:${b.symbol}`;
    const stepping = (accumulatorEngine as unknown as { stepping: Set<string> }).stepping;
    stepping.add(key);
    const pending = accumulatorEngine.forceSell(USER, b.symbol, [b.openLots[0].id], { stopBuying: true }, OPEN + HOUR);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(store.accumulatorBook(USER, b.symbol)!.openLots.length, 1, 'nothing sold while the step held the lock');
    stepping.delete(key);
    const r = await pending;
    assert.equal(r.ok, true);
    assert.equal(store.accumulatorBook(USER, b.symbol)!.closedLots.filter((l) => l.forced).length, 1);
    assert.equal(stepping.has(key), false, 'the lock is released afterwards');
  });

  await test('B5 a partial fill halts the book and leaves the lot open', async () => {
    const b = await bookWithLot();
    price(b.symbol, 90);
    const brk = brokerFor(USER);
    const original = brk.placeOrder.bind(brk);
    brk.placeOrder = async (req: OrderRequest): Promise<BrokerOrderResult> => ({
      brokerOrderId: 'partial-1', status: 'FILLED', filledPrice: 90, filledQuantity: req.quantity - 1,
    });
    try {
      const r = await accumulatorEngine.forceSell(USER, b.symbol, [b.openLots[0].id], { stopBuying: true }, OPEN + HOUR);
      assert.equal(r.ok, false);
      assert.equal(r.failed.length, 1);
      assert.match(r.halted ?? '', /Partial SELL/);
      const after = store.accumulatorBook(USER, b.symbol)!;
      assert.equal(after.openLots.length, 1);
      assert.match(after.haltedReason ?? '', /Partial SELL/);
    } finally {
      brk.placeOrder = original;
    }
  });

  await test('B7 works on a book whose no-loss mode is off', async () => {
    const b = await bookWithLot();
    store.saveAccumulatorBook({ ...store.accumulatorBook(USER, b.symbol)!, enabled: false });
    price(b.symbol, 90);
    const r = await accumulatorEngine.forceSell(USER, b.symbol, [b.openLots[0].id], { stopBuying: true }, OPEN + HOUR);
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  await test('B9 selling one of two lots leaves the other open and its ladder intact', async () => {
    (orderRateLimiter as unknown as { stamps: number[] }).stamps = [];
    const b0 = seed();
    price(b0.symbol, 95);
    let b = await accumulatorEngine.step(b0, 95, OPEN);
    price(b0.symbol, 88);
    b = await accumulatorEngine.step(b, 88, NEXT_DAY);
    assert.equal(b.openLots.length, 2, 'fixture: two rungs bought');
    const deep = b.openLots.find((l) => l.level === 1)!;
    price(b0.symbol, 87);
    const r = await accumulatorEngine.forceSell(USER, b0.symbol, [deep.id], { stopBuying: false }, NEXT_DAY + HOUR);
    assert.equal(r.ok, true, JSON.stringify(r));
    const after = store.accumulatorBook(USER, b0.symbol)!;
    assert.deepEqual(after.openLots.map((l) => l.level), [0]);
    assert.equal(after.epochs[0].status, 'OPEN');
    assert.ok(after.epochs[0].filledLevels.includes(1), 'rung 1 not re-armed: it will not buy straight back');
  });

  // ── C. what reads closed lots ─────────────────────────────────────────
  await test('C1/C2/C3 the report, tax ledger and fill audit all take a forced loss honestly', async () => {
    const b = await bookWithLot();
    price(b.symbol, 90);
    await accumulatorEngine.forceSell(USER, b.symbol, [b.openLots[0].id], { stopBuying: true }, OPEN + HOUR);
    const book = store.accumulatorBook(USER, b.symbol)!;
    const c = book.closedLots[0];

    const rep = reportFor(book, 90);
    assert.ok(Math.abs(rep.bankedProfit - c.pnl) < 1e-9, 'banked profit includes the loss');
    assert.equal(rep.winRatePct, 0, 'a forced loss is not a win');

    const { buys, sells } = transactionsFromBooks([book]);
    const { matches, unmatched } = matchFifo(buys, sells);
    assert.equal(unmatched.length, 0);
    assert.equal(matches.length, 1);
    assert.ok(matches[0].gain < 0, 'the tax ledger books a capital loss');

    const unbooked = findUnbookedFills(store.orders.values(), store.accumulatorBooks.values()).filter((u) => u.symbol === b.symbol);
    assert.equal(unbooked.length, 0, 'the fill audit matches the forced sell to its closed lot');
  });

  // ── D. the routes, over HTTP ─────────────────────────────────────────
  const server = createApp().listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(base + path, {
      ...init,
      headers: { Authorization: `Bearer ${signToken(USER, 'trader')}`, 'Content-Type': 'application/json' },
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  try {
    const b = await bookWithLot();
    price(b.symbol, 90);
    const lotId = b.openLots[0].id;

    await test('D1 the preview lists each lot with real-cost estimates and places nothing', async () => {
      const before = store.orders.size;
      const { status, body } = await call(`/api/accumulator/${b.symbol}/force-sell/preview`);
      assert.equal(status, 200);
      assert.equal(body.lots.length, 1);
      const l = body.lots[0];
      assert.equal(l.id, lotId);
      assert.ok(l.estPnl < 0 && l.estProceeds > 0);
      const lot = store.accumulatorBook(USER, b.symbol)!.openLots[0];
      assert.ok(Math.abs(l.estProceeds - forceSellEstimate(b, lot, body.mark).proceeds) < 1e-6);
      assert.ok('blocker' in body);
      assert.equal(store.orders.size, before);
    });

    await test('D2 the sell route validates its body and says why it refuses', async () => {
      assert.equal((await call(`/api/accumulator/${b.symbol}/force-sell`, { method: 'POST', body: JSON.stringify({ lotIds: [lotId] }) })).status, 400);
      assert.equal((await call(`/api/accumulator/${b.symbol}/force-sell`, { method: 'POST', body: JSON.stringify({ confirm: true, lotIds: [] }) })).status, 400);
      assert.equal((await call(`/api/accumulator/${b.symbol}/force-sell`, { method: 'POST', body: JSON.stringify({ confirm: true, lotIds: [lotId], stopBuying: 'yes' }) })).status, 400);
      assert.equal((await call('/api/accumulator/NOSUCH/force-sell', { method: 'POST', body: JSON.stringify({ confirm: true, lotIds: [lotId] }) })).status, 404);
      // The real clock decides: closed now → 409 with the preview's own reason; open → it sells.
      const preview = (await call(`/api/accumulator/${b.symbol}/force-sell/preview`)).body;
      const r = await call(`/api/accumulator/${b.symbol}/force-sell`, { method: 'POST', body: JSON.stringify({ confirm: true, lotIds: [lotId] }) });
      if (!isMarketOpen(Date.now())) {
        assert.equal(r.status, 409);
        assert.equal(r.body.error, preview.blocker);
        assert.equal(store.accumulatorBook(USER, b.symbol)!.openLots.length, 1);
      } else {
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.sold.length, 1);
      }
    });
  } finally {
    server.close();
  }

  console.log(`${failures.length ? '✗' : '✓'} forceSell: ${passed} passed${failures.length ? `, ${failures.length} failed` : ''}`);
  if (failures.length) {
    console.log(failures.join('\n'));
    process.exit(1);
  }
  process.exit(0);
}

void main();
