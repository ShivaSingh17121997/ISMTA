/**
 * AccumulatorEngine INTEGRATION tests — the stateful service, not the pure core.
 *
 * Every other suite in this project tests pure functions. That left the layer
 * that actually does things completely uncovered: placing the order, applying
 * the broker's fill, moving proceeds through the T+1 queue, persisting the
 * book. A pure engine that is perfect and a service that never calls it looks
 * exactly like a working system until the day it is asked to trade.
 *
 * This drives the real `accumulatorEngine.step()` against the real paper
 * broker, offline. No network: `step` takes the price it is given.
 *
 * The assertion that matters is the same one as everywhere else — a closed lot
 * cannot book a loss — but here it has to survive a round trip through order
 * placement and settlement, not just a function call.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { accumulatorEngine, closeFields, createBook, reportFor } from '../services/AccumulatorEngine';
import { brokerFor } from '../brokers/registry';
import { orderRateLimiter } from '../services/guards';
import { marketData } from '../services/MarketDataService';
import { store } from '../store/memoryStore';
import { isMarketOpen, nextTradingDayStart } from '../services/session';
import { lotBreakeven, lotTarget, recordDayHigh } from '../services/accumulator/engine';
import { DEFAULT_ACCUMULATOR_PARAMS as P, type AccumulatorBook } from '../services/accumulator/types';

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

// Monday 5 Jan 2026, 10:30 IST — inside the session, past the entry gate.
const OPEN = Date.parse('2026-01-05T05:00:00Z');
const CLOSED = Date.parse('2026-01-04T05:00:00Z'); // Sunday
// Tuesday 10:30 IST — exactly 24h on, so the buy brake has expired.
const NEXT_DAY = Date.parse('2026-01-06T05:00:00Z');
const HOUR = 3_600_000;
const USER = 'itest-user';

let seq = 0;
/** A funded book with a 45-day high recorded, priced and ready to trade. */
function seed(high = 100, budget = 300_000): AccumulatorBook {
  const symbol = `ITEST${seq++}`;
  let b = createBook({ userId: USER, symbol, instrument: 'ETF', budget });
  // Created before the fixture session, as a real book is created before it trades.
  b = { ...b, createdAt: OPEN - 7 * 86_400_000 };
  b = recordDayHigh(b, high, OPEN - 86_400_000);
  store.saveAccumulatorBook(b);
  return b;
}

const price = (symbol: string, p: number) => marketData.ingestExternal(symbol, p);

async function main(): Promise<void> {
  // Sanity: the timestamps this suite depends on must mean what it thinks.
  await test('the fixture timestamps are inside and outside the session', () => {
    assert.equal(isMarketOpen(OPEN), true, 'OPEN must be a live session');
    assert.equal(isMarketOpen(CLOSED), false, 'CLOSED must not be');
  });

  // ── the full lifecycle ──────────────────────────────────────────────────
  await test('a full buy → sell → settle cycle runs through the real service', async () => {
    const book = seed(100);
    const sym = book.symbol;

    // 1. Price 5% under the high clears the 3% start gate.
    price(sym, 95);
    let b = await accumulatorEngine.step(book, 95, OPEN);

    assert.equal(b.openLots.length, 1, 'a rung should have filled');
    assert.equal(b.epochs.length, 1, 'an epoch should have opened');
    assert.ok(b.cash < book.cash, 'cash must have left the book');
    const lot = b.openLots[0];
    assert.ok(lot.quantity > 0 && lot.quoteSpent > 0);
    assert.ok(
      Math.abs(b.cash + lot.quoteSpent - book.cash) < 0.01,
      'cash out must equal the lot cost exactly',
    );

    // 2. The book was PERSISTED, not just returned.
    const stored = store.accumulatorBook(USER, sym);
    assert.equal(stored?.openLots.length, 1, 'the fill must be saved to the store');

    // 3. Above the target, it sells.
    const target = lotTarget(b, lot, P);
    price(sym, target + 1);
    b = await accumulatorEngine.step(b, target + 1, OPEN + 2 * HOUR);

    assert.equal(b.openLots.length, 0, 'the lot should have sold');
    assert.equal(b.closedLots.length, 1);
    const closed = b.closedLots[0];
    assert.ok(closed.pnl > 0, `closed lot booked ${closed.pnl}, must be positive`);
    assert.ok(closed.sellPrice >= closed.netBreakeven, 'sold at or above breakeven');

    // 4. Proceeds are UNSETTLED, not spendable.
    assert.equal(b.unsettled.length, 1, 'proceeds must enter the T+1 queue');
    assert.ok(
      Math.abs(b.unsettled[0].amount - closed.proceeds) < 0.01,
      'the queued amount is the net proceeds',
    );
    const cashBeforeSettle = b.cash;

    // 5. After T+1 they settle into spendable cash.
    const settlesAt = b.unsettled[0].settlesAt;
    assert.ok(settlesAt > OPEN, 'settlement is in the future');
    price(sym, target + 1);
    b = await accumulatorEngine.step(b, target + 1, settlesAt + HOUR);
    assert.equal(b.unsettled.length, 0, 'the queue should have drained');
    assert.ok(b.cash > cashBeforeSettle, 'settled cash must have arrived');
  });

  // ── the invariant, through the service ──────────────────────────────────
  await test('no closed lot books a loss across a randomised walk through the service', async () => {
    const book = seed(100);
    const sym = book.symbol;
    let b = book;
    let t = OPEN;
    let s = 424242;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

    let p = 100;
    for (let i = 0; i < 300; i++) {
      p = Math.max(1, p * (1 + (rnd() - 0.5) * 0.12));
      // Advance a full day each step so the buy brake never blocks everything.
      t += 26 * HOUR;
      if (!isMarketOpen(t)) continue;
      price(sym, p);
      b = await accumulatorEngine.step(b, p, t);
    }

    assert.ok(b.closedLots.length > 0, 'the walk should have closed at least one lot');
    for (const l of b.closedLots) {
      assert.ok(l.pnl > 0, `closed lot ${l.id} booked ${l.pnl}`);
      assert.ok(l.sellPrice >= l.netBreakeven - 1e-6, `sold under breakeven`);
    }
    const r = reportFor(b, p);
    assert.equal(r.winRatePct, 100, 'by construction');
  });

  // ── the gates ───────────────────────────────────────────────────────────
  await test('a closed market places no orders at all', async () => {
    const book = seed(100);
    price(book.symbol, 80); // deep below the gate — would certainly buy if open
    const b = await accumulatorEngine.step(book, 80, CLOSED);
    assert.equal(b.openLots.length, 0);
    assert.equal(b.epochs.length, 0);
    assert.equal(b.cash, book.cash);
  });

  await test('the kill switch blocks the buy but never the sell', async () => {
    const book = seed(100);
    const sym = book.symbol;
    price(sym, 95);
    let b = await accumulatorEngine.step(book, 95, OPEN);
    assert.equal(b.openLots.length, 1, 'one lot before the switch');

    // Engage it, then offer a deep dip. NEXT_DAY is exactly 24h on, so the buy
    // brake has expired and the kill switch is the only thing that can block
    // the rung — and both timestamps are inside a live session, or `step`
    // would short-circuit on the closed market and prove nothing.
    assert.equal(isMarketOpen(NEXT_DAY), true);
    assert.equal(isMarketOpen(NEXT_DAY + HOUR), true);

    b = { ...b, killSwitchEngaged: true };
    store.saveAccumulatorBook(b);
    price(sym, 70);
    b = await accumulatorEngine.step(b, 70, NEXT_DAY);
    assert.equal(b.openLots.length, 1, 'the kill switch must block new rungs');

    // And now offer a price above the target: the exit still fires.
    const target = lotTarget(b, b.openLots[0], P);
    price(sym, target + 1);
    b = await accumulatorEngine.step(b, target + 1, NEXT_DAY + HOUR);
    assert.equal(b.openLots.length, 0, 'an exit is never blocked by the kill switch');
    assert.ok(b.closedLots[0].pnl > 0);
  });

  await test('a halted book does nothing at all', async () => {
    const book = { ...seed(100), haltedReason: 'corporate action could not be applied' };
    store.saveAccumulatorBook(book);
    price(book.symbol, 80);
    const b = await accumulatorEngine.step(book, 80, OPEN);
    assert.equal(b.openLots.length, 0);
  });

  await test('the start gate refuses to anchor near a high', async () => {
    const book = seed(100);
    price(book.symbol, 99); // only 1% down, gate wants 3%
    const b = await accumulatorEngine.step(book, 99, OPEN);
    assert.equal(b.openLots.length, 0, 'no anchor within the gate');
  });

  await test('the buy brake spaces ladder rungs by a day', async () => {
    const book = seed(100);
    const sym = book.symbol;
    price(sym, 95);
    let b = await accumulatorEngine.step(book, 95, OPEN);
    assert.equal(b.openLots.length, 1);
    // A far deeper price one hour later must NOT fill a second rung.
    price(sym, 80);
    b = await accumulatorEngine.step(b, 80, OPEN + HOUR);
    assert.equal(b.openLots.length, 1, 'the 24h brake should hold');
  });

  await test('a book with no price gets no order rather than a guessed one', async () => {
    const book = seed(100);
    // Deliberately never priced: the broker has no LTP for this symbol.
    const b = await accumulatorEngine.step(book, 95, OPEN);
    assert.equal(b.openLots.length, 0, 'a rejected order must not create a lot');
  });

  // ── a documented gap, pinned so it cannot change silently ───────────────
  await test('KNOWN GAP: step() ignores the no-loss toggle (the scheduler honours it)', async () => {
    const book = { ...seed(100), enabled: false };
    store.saveAccumulatorBook(book);
    price(book.symbol, 95);
    const b = await accumulatorEngine.step(book, 95, OPEN);
    // runAll() skips disabled books; step() does not check the flag, so
    // pressing Evaluate on a switched-off book still trades. Pinned here so
    // the behaviour is visible and cannot drift unnoticed.
    assert.equal(b.openLots.length, 1, 'documenting current behaviour, not endorsing it');
  });

  // ── the event log ───────────────────────────────────────────────────────
  await test('every fill is logged with a reason', async () => {
    const book = seed(100);
    price(book.symbol, 95);
    await accumulatorEngine.step(book, 95, OPEN);
    const events = accumulatorEngine.recentEvents(200).filter((e) => e.symbol === book.symbol);
    assert.ok(events.some((e) => e.kind === 'FILL'), 'a FILL event should exist');
    assert.ok(events.every((e) => e.detail.length > 0), 'no event is blank');
  });

  // ── real-money safety: one step per book, and nothing lost around a fill ──
  await test('two evaluations of the same book at once place ONE order, not two', async () => {
    const book = seed(100);
    price(book.symbol, 95);
    const [a, b] = await Promise.all([
      accumulatorEngine.step(book, 95, OPEN),
      accumulatorEngine.step(book, 95, OPEN),
    ]);
    const after = store.accumulatorBook(USER, book.symbol)!;
    assert.equal(after.openLots.length, 1, `expected one lot, saw ${after.openLots.length}`);
    const orders = [...store.orders.values()].filter((o) => o.symbol === book.symbol);
    assert.equal(orders.length, 1, `expected one order, saw ${orders.length}`);
    assert.ok(a && b);
  });

  await test('a kill switch set while an order is out is not undone by the step', async () => {
    const book = seed(100);
    price(book.symbol, 95);
    const running = accumulatorEngine.step(book, 95, OPEN);
    accumulatorEngine.setKillSwitch(USER, book.symbol, true);
    await running;
    assert.equal(store.accumulatorBook(USER, book.symbol)!.killSwitchEngaged, true);
  });

  await test('every engine order is recorded, with its fill and a unique client id', async () => {
    const book = seed(100);
    price(book.symbol, 95);
    await accumulatorEngine.step(book, 95, OPEN);
    const orders = [...store.orders.values()].filter((o) => o.symbol === book.symbol);
    assert.equal(orders.length, 1);
    const o = orders[0];
    assert.equal(o.status, 'FILLED');
    assert.ok(o.filledPrice! > 0 && o.filledQuantity > 0);
    assert.match(o.tag ?? '', /^accumulator:/);
    assert.match(o.clientOrderId ?? '', /^acc:/);
  });

  await test('a fill the book cannot record HALTS the book instead of being retried', async () => {
    const book = seed(100);
    price(book.symbol, 95);
    const bought = await accumulatorEngine.step(book, 95, OPEN);
    assert.equal(bought.openLots.length, 1);
    const be = lotBreakeven(bought, bought.openLots[0], P);
    const up = lotTarget(bought, bought.openLots[0], P) * 1.01;

    // The broker reports a sale BELOW breakeven — the book must refuse to
    // record it, and since shares really moved, stop rather than re-send.
    const brk = brokerFor(USER);
    const original = brk.placeOrder.bind(brk);
    brk.placeOrder = async (req) => ({ brokerOrderId: 'X1', status: 'FILLED', filledPrice: be * 0.9, filledQuantity: req.quantity });
    try {
      price(book.symbol, up);
      await accumulatorEngine.step(bought, up, NEXT_DAY);
    } finally {
      brk.placeOrder = original;
    }
    const after = store.accumulatorBook(USER, book.symbol)!;
    assert.match(after.haltedReason ?? '', /FILLED .* could not be booked/);
    assert.equal(after.openLots.length, 1, 'the lot is not silently dropped');
  });

  await test('a buy refused because the Kite app has no static IP HALTS once instead of retrying every tick', async () => {
    (orderRateLimiter as unknown as { stamps: number[] }).stamps = [];
    const book = seed(100);
    price(book.symbol, 95);
    const brk = brokerFor(USER);
    const original = brk.placeOrder.bind(brk);
    let sent = 0;
    brk.placeOrder = async () => {
      sent++;
      return {
        brokerOrderId: 'X2',
        status: 'REJECTED',
        filledQuantity: 0,
        rejectionReason: 'No IPs configured for this app. Add allowed IPs on the Kite developer console.',
      };
    };
    try {
      await accumulatorEngine.step(book, 95, OPEN);
      const halted = store.accumulatorBook(USER, book.symbol)!;
      assert.match(halted.haltedReason ?? '', /static IP .* developers\.kite\.trade/);
      // The next tick must not send again.
      await accumulatorEngine.step(halted, 95, OPEN + 60_000);
    } finally {
      brk.placeOrder = original;
    }
    assert.equal(sent, 1, 'one order, then the halt; not one a minute');
  });

  // ── crash between a fill and its save ──────────────────────────────────
  // This suite sends orders far faster than any real tick, and the SEBI 10/s
  // limiter runs on the wall clock. Clear it so the tests below are not refused.
  const resetRate = () => {
    (orderRateLimiter as unknown as { stamps: number[] }).stamps = [];
  };
  await test('every lot names the order that opened it, and every closed lot the order that closed it', async () => {
    resetRate();
    const book = seed(100);
    price(book.symbol, 95);
    const bought = await accumulatorEngine.step(book, 95, OPEN);
    const buy = [...store.orders.values()].find((o) => o.symbol === book.symbol && o.side === 'BUY')!;
    assert.equal(bought.openLots[0].orderId, buy.id);

    const up = lotTarget(bought, bought.openLots[0], P) * 1.01;
    price(book.symbol, up);
    const sold = await accumulatorEngine.step(bought, up, NEXT_DAY);
    const sell = [...store.orders.values()].find((o) => o.symbol === book.symbol && o.side === 'SELL')!;
    assert.equal(sold.closedLots.length, 1);
    assert.equal(sold.closedLots[0].orderId, buy.id, 'the buy link survives the close');
    assert.equal(sold.closedLots[0].sellOrderId, sell.id);
    assert.equal(accumulatorEngine.haltUnbookedFills(NEXT_DAY, { symbol: book.symbol }).length, 0, 'a clean history audits clean');
  });

  await test('a fill is saved and flushed right after it is booked, not at the end of the step', async () => {
    resetRate();
    const book = seed(100);
    price(book.symbol, 95);
    const original = store.flushAccumulatorBook.bind(store);
    const seen: { lots: number; orderId?: string }[] = [];
    // What the store holds at the moment the engine waits for the write.
    store.flushAccumulatorBook = (userId, symbol) => {
      const b = store.accumulatorBook(userId, symbol);
      seen.push({ lots: b?.openLots.length ?? 0, orderId: b?.openLots[0]?.orderId });
      return original(userId, symbol);
    };
    try {
      const after = await accumulatorEngine.step(book, 95, OPEN);
      assert.equal(seen.length, 1, 'one flush per fill');
      assert.equal(seen[0].lots, 1, 'the lot is in the store when the flush is awaited');
      assert.equal(seen[0].orderId, after.openLots[0].orderId);
    } finally {
      store.flushAccumulatorBook = original;
    }
  });

  await test('a restart that lost a BUY fill halts the book instead of buying the rung again', async () => {
    resetRate();
    const book = seed(100);
    price(book.symbol, 95);
    await accumulatorEngine.step(book, 95, OPEN);
    // Simulate the crash: the order row says FILLED, the book never saw it.
    store.saveAccumulatorBook(book);

    const found = accumulatorEngine.haltUnbookedFills(OPEN + 60_000, { symbol: book.symbol });
    assert.equal(found.length, 1);
    assert.equal(found[0].side, 'BUY');
    const after = store.accumulatorBook(USER, book.symbol)!;
    assert.match(after.haltedReason ?? '', /Unbooked fill: BUY/);

    const ordersBefore = [...store.orders.values()].filter((o) => o.symbol === book.symbol).length;
    await accumulatorEngine.step(after, 95, OPEN + 2 * 60_000);
    const ordersAfter = [...store.orders.values()].filter((o) => o.symbol === book.symbol).length;
    assert.equal(ordersAfter, ordersBefore, 'the halted book sends nothing');
  });

  await test('a restart that lost a SELL fill halts the book instead of selling the lot again', async () => {
    resetRate();
    const book = seed(100);
    price(book.symbol, 95);
    const bought = await accumulatorEngine.step(book, 95, OPEN);
    const up = lotTarget(bought, bought.openLots[0], P) * 1.01;
    price(book.symbol, up);
    await accumulatorEngine.step(bought, up, NEXT_DAY);
    store.saveAccumulatorBook(bought); // the sale never reached the book

    const found = accumulatorEngine.haltUnbookedFills(NEXT_DAY + 60_000, { symbol: book.symbol });
    assert.equal(found.length, 1);
    assert.match(found[0].reason, /still open/);
    assert.match(store.accumulatorBook(USER, book.symbol)!.haltedReason ?? '', /Unbooked fill: SELL/);
  });

  await test('previous close rolls once per day, so the circuit band is not checked against itself', () => {
    const mon = Date.parse('2026-01-05T05:00:00Z');
    let f = closeFields({}, 100, mon);
    assert.equal(f.previousClose, undefined, 'no prior session seen yet');
    f = closeFields(f, 104, mon + HOUR);
    assert.equal(f.previousClose, undefined, 'intraday ticks never become the previous close');
    assert.equal(f.lastPrice, 104);
    f = closeFields(f, 98, NEXT_DAY);
    assert.equal(f.previousClose, 104, "a new day takes yesterday's last price");
    f = closeFields(f, 97, NEXT_DAY + HOUR);
    assert.equal(f.previousClose, 104, 'and holds it all day');
    assert.equal(closeFields(f, 97, NEXT_DAY + HOUR, 103.5).previousClose, 103.5, "the exchange's own close wins");
  });

  if (failures.length) {
    console.error(`✗ accumulatorService: ${failures.length} failed, ${passed} passed`);
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log(`✓ accumulatorService: ${passed} passed`);
}

void main();
