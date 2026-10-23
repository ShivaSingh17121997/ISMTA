/**
 * OrderManager integration tests — the risk-gate bypass at the ORDER layer.
 *
 * riskGate.test.ts proves RiskManager.check() lets exits through when told
 * isReducing. This proves OrderManager actually TELLS it — which is the part
 * that was broken: the engine's own exits were fixed while the manual path from
 * routes/orders.ts still defaulted to intent:'entry' and got gated.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { config } from '../config';
import { orderManager } from '../services/OrderManager';
import { riskManager } from '../services/RiskManager';
import { marketData } from '../services/MarketDataService';
import { store } from '../store/memoryStore';
import { OrderRequest, Position } from '../types';

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

let seq = 0;
const newUser = () => `om${++seq}`;
const SYMBOL = 'RELIANCE';

function giveLongPosition(userId: string, quantity = 10): void {
  const price = marketData.getPrice(SYMBOL);
  const pos: Position = {
    symbol: SYMBOL,
    quantity,
    avgPrice: price,
    ltp: price,
    unrealisedPnl: 0,
    realisedPnl: 0,
  };
  store.positions.set(store.positionKey(userId, SYMBOL), pos);
}

/** Exactly what routes/orders.ts builds — note it sets no `intent`. */
function manualOrder(userId: string, side: 'BUY' | 'SELL', quantity = 10): OrderRequest {
  return {
    symbol: SYMBOL,
    side,
    quantity,
    orderType: 'MARKET',
    product: 'MIS',
    userId,
    tag: 'manual',
  };
}

async function main(): Promise<void> {
  // These tests are about the RISK gate. The pre-trade gate (session, instrument,
  // feed) is tested in orderGate.test.ts; here the session is switched off so
  // the suite passes at 02:00 on a Sunday.
  (config.session as { enabled: boolean }).enabled = false;

  await test(
    'a MANUAL close goes through with the daily loss limit breached (no `intent` set)',
    async () => {
      const u = newUser();
      giveLongPosition(u);
      store.addDailyPnl(u, -(config.risk.dailyLossLimit + 1000));

      // The operator opens the console to flatten. This is the request the route
      // builds verbatim — if this 422s, you cannot escape your own position.
      const res = await orderManager.place(manualOrder(u, 'SELL'));
      assert.equal(res.ok, true, `manual exit was rejected: ${res.reason}`);
      assert.equal(store.positions.get(store.positionKey(u, SYMBOL))!.quantity, 0, 'flat');
    },
  );

  await test('a manual ENTRY is still blocked with the limit breached', async () => {
    const u = newUser();
    store.addDailyPnl(u, -(config.risk.dailyLossLimit + 1000));
    const res = await orderManager.place(manualOrder(u, 'BUY'));
    assert.equal(res.ok, false, 'entries must still be gated');
    assert.match(res.reason ?? '', /Daily loss limit/);
  });

  await test('a manual close goes through with the kill switch engaged', async () => {
    const u = newUser();
    giveLongPosition(u);
    riskManager.setKilled(u, true);
    try {
      const res = await orderManager.place(manualOrder(u, 'SELL'));
      assert.equal(res.ok, true, `kill switch blocked an exit: ${res.reason}`);
    } finally {
      riskManager.setKilled(u, false);
    }
  });

  await test('isReducing is derived from the POSITION, not a caller-supplied intent', async () => {
    const u = newUser();
    giveLongPosition(u);
    store.addDailyPnl(u, -(config.risk.dailyLossLimit + 1000));
    // Caller lies: says 'entry' while actually reducing. The gate must still let
    // it through — reducing exposure is never something we want to block.
    const res = await orderManager.place({ ...manualOrder(u, 'SELL'), intent: 'entry' });
    assert.equal(res.ok, true, 'a mislabelled reduction must not be gated');
  });

  await test('an over-sized close is not trimmed by the value cap', async () => {
    const u = newUser();
    // 200 shares of RELIANCE ≈ ₹590k, far past the ₹100k cap. Trimming would
    // leave a residual position after what was meant to be a full exit.
    giveLongPosition(u, 200);
    const res = await orderManager.place(manualOrder(u, 'SELL', 200));
    assert.equal(res.ok, true);
    assert.equal(res.order!.filledQuantity, 200, 'the whole position must be exitable');
    assert.equal(store.positions.get(store.positionKey(u, SYMBOL))!.quantity, 0);
  });

  await test('flatten() closes out even with the limit breached and the switch engaged', async () => {
    const u = newUser();
    giveLongPosition(u, 25);
    store.addDailyPnl(u, -(config.risk.dailyLossLimit + 5000));
    riskManager.setKilled(u, true);
    try {
      await orderManager.flatten(u, SYMBOL);
      assert.equal(
        store.positions.get(store.positionKey(u, SYMBOL))!.quantity,
        0,
        'the "get me out" button must work precisely when everything else is blocked',
      );
    } finally {
      riskManager.setKilled(u, false);
    }
  });

  await test('a filled order persists its terminal status and charges', async () => {
    const u = newUser();
    const res = await orderManager.place(manualOrder(u, 'BUY'));
    assert.equal(res.ok, true);
    const stored = store.orders.get(res.order!.id)!;
    assert.equal(stored.status, 'FILLED', 'not left PENDING');
    assert.ok((stored.charges ?? 0) > 0, 'charges must be recorded for reconciliation');
  });

  // ── the cross-engine guard, through the real order path ───────────────────
  //
  // orderGate.test.ts proves the gate's logic. This proves OrderManager
  // actually REACHES it with a `strategyId` attached — the wiring gap that
  // would leave the guard permanently dormant in production while every unit
  // test still passed. A live probe on the running server was inconclusive
  // (the strategy never signalled in the window), so it is pinned here.

  function bookOn(userId: string, symbol: string, enabled: boolean): void {
    store.accumulatorBooks.set(`${userId}:${symbol}`, {
      id: `bk-${userId}`, userId, symbol, enabled, instrument: 'EQUITY',
      budget: 50_000, cash: 50_000, unsettled: [], openLots: [], closedLots: [],
      epochs: [], killSwitchEngaged: false, updatedAt: 0,
    } as never);
  }

  await test('a STRATEGY entry is refused on a symbol the accumulator owns', async () => {
    const u = newUser();
    bookOn(u, SYMBOL, true);
    const res = await orderManager.place({
      ...manualOrder(u, 'BUY'),
      strategyId: 'strat-1',
      tag: 'strategy',
      intent: 'entry',
    });
    assert.equal(res.ok, false, 'the guard did not fire through OrderManager');
    assert.match(res.reason ?? '', /held by the accumulator/);
    store.accumulatorBooks.delete(`${u}:${SYMBOL}`);
  });

  await test('a STRATEGY exit on that symbol still goes through', async () => {
    // The dangerous inverse: a strategy caught holding when a book is switched
    // on must always be able to close.
    const u = newUser();
    bookOn(u, SYMBOL, true);
    giveLongPosition(u);
    const res = await orderManager.place({
      ...manualOrder(u, 'SELL'),
      strategyId: 'strat-1',
      tag: 'target',
      intent: 'exit',
    });
    assert.equal(res.ok, true, `a strategy exit was trapped: ${res.reason}`);
    assert.equal(store.positions.get(store.positionKey(u, SYMBOL))!.quantity, 0, 'flat');
    store.accumulatorBooks.delete(`${u}:${SYMBOL}`);
  });

  await test('the accumulator is never blocked by its own book', async () => {
    const u = newUser();
    bookOn(u, SYMBOL, true);
    // The accumulator carries a tag and no strategyId — that is the separator.
    const res = await orderManager.place({
      ...manualOrder(u, 'BUY'),
      product: 'CNC',
      tag: 'accumulator:e0l1',
      intent: 'entry',
    });
    assert.equal(res.ok, true, `the accumulator was blocked: ${res.reason}`);
    store.accumulatorBooks.delete(`${u}:${SYMBOL}`);
  });

  if (failures.length) {
    console.error(`\n✗ orderManager: ${failures.length} failed, ${passed} passed\n`);
    console.error(failures.join('\n\n'));
    process.exit(1);
  }
  console.log(`✓ orderManager: ${passed} passed`);
}

void main();
