/**
 * Stops are set from the FILL, not from the bar the signal saw.
 *
 * The 9 Sep 2026 phantom: a signal decided at ≈₹1,050 (a synthetic bar),
 * filled at the real ₹1,388, and carried a stop at ₹1,065 — 23% below its
 * entry — which "fired" ten seconds later for +₹4,820 that never happened.
 * Two guards close that: the pre-trade gate refuses a fill far from the
 * decision price, and when a signal carries % distances the trade's stop and
 * target are recomputed from the actual fill.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { config } from '../config';
import { marketData } from '../services/MarketDataService';
import { orderManager } from '../services/OrderManager';
import { store } from '../store/memoryStore';
import { Signal } from '../types';

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

const SYMBOL = 'INFY';
let seq = 0;
const newUser = () => `fp${++seq}`;

function signal(overrides: Partial<Signal>): Signal {
  return {
    action: 'SELL',
    symbol: SYMBOL,
    confidence: 0.8,
    reason: 'test',
    timestamp: Date.now(),
    ...overrides,
  };
}

async function main(): Promise<void> {
  (config.session as { enabled: boolean }).enabled = false;
  const ltp = marketData.getPrice(SYMBOL);
  assert.ok(ltp > 0, 'INFY needs a seeded price');

  await test('a signal whose reference is far from the live price is refused before sending', async () => {
    const u = newUser();
    const fake = ltp * 0.76; // the phantom's ratio
    const res = await orderManager.placeFromSignal(
      signal({ referencePrice: fake, stopLoss: fake * 1.015, takeProfit: fake * 0.96, stopPct: 1.5, targetPct: 4 }),
      u,
      10,
      'strat-a',
    );
    assert.equal(res.ok, false, 'must not fill 24% away from the decision price');
    assert.match(res.reason ?? '', /from the decision price/);
    assert.equal(store.openTradesByUser(u).length, 0);
  });

  await test('stop and target are recomputed from the fill when the signal gives % distances', async () => {
    const u = newUser();
    // Absolute levels deliberately WRONG (computed from a stale bar); the % distances are right.
    const stale = ltp * 0.9;
    const res = await orderManager.placeFromSignal(
      signal({
        referencePrice: ltp,
        stopLoss: stale * 1.015,
        takeProfit: stale * 0.96,
        stopPct: 1.5,
        targetPct: 4,
      }),
      u,
      10,
      'strat-b',
    );
    assert.equal(res.ok, true, res.reason);
    const t = store.openTradesByUser(u)[0];
    assert.ok(t, 'a trade opened');
    const fill = t.entryPrice;
    // SELL: stop above entry by 1.5%, target below by 4%.
    assert.ok(t.stopLoss! > fill, `stop ${t.stopLoss} must be above the SHORT entry ${fill}`);
    assert.ok(Math.abs(t.stopLoss! / fill - 1.015) < 0.002, `stop ${t.stopLoss} ≈ fill × 1.015 (${fill * 1.015})`);
    assert.ok(Math.abs(t.takeProfit! / fill - 0.96) < 0.002, `target ${t.takeProfit} ≈ fill × 0.96`);
    assert.ok(t.tags?.includes('strategy'), 'auto-tagged from the order');
    await orderManager.flatten(u, SYMBOL);
  });

  await test('without % distances the absolute levels are used (legacy signals)', async () => {
    const u = newUser();
    const res = await orderManager.placeFromSignal(
      signal({ action: 'BUY', referencePrice: ltp, stopLoss: ltp * 0.98, takeProfit: ltp * 1.05 }),
      u,
      10,
      'strat-c',
    );
    assert.equal(res.ok, true, res.reason);
    const t = store.openTradesByUser(u)[0];
    assert.ok(Math.abs(t.stopLoss! - ltp * 0.98) < 0.01 * ltp);
    await orderManager.flatten(u, SYMBOL);
  });

  await test('the same signal placed twice is one order (idempotent client id)', async () => {
    const u = newUser();
    const s = signal({ action: 'BUY', referencePrice: ltp, stopPct: 1, targetPct: 2, timestamp: 1234567 });
    const a = await orderManager.placeFromSignal(s, u, 5, 'strat-d');
    const b = await orderManager.placeFromSignal(s, u, 5, 'strat-d');
    assert.equal(a.ok, true, a.reason);
    assert.equal(b.order?.id, a.order?.id, 'second call returns the first order');
    assert.equal(store.positions.get(store.positionKey(u, SYMBOL))?.quantity, 5, 'position not doubled');
    await orderManager.flatten(u, SYMBOL);
  });

  await test('a trimmed quantity comes back with the reason', async () => {
    const u = newUser();
    const res = await orderManager.place({
      symbol: SYMBOL,
      side: 'BUY',
      quantity: 1_000_000,
      orderType: 'MARKET',
      product: 'MIS',
      userId: u,
      tag: 'manual',
    });
    assert.equal(res.ok, true, res.reason);
    assert.ok(res.order!.filledQuantity < 1_000_000);
    assert.equal(res.order!.requestedQuantity, 1_000_000);
    assert.match(res.order!.adjustment ?? '', /reduced from 1000000/);
    assert.match(res.reason ?? '', /reduced/);
    await orderManager.flatten(u, SYMBOL);
  });

  if (failures.length) {
    console.error(`\n✗ fillProtection: ${failures.length} failed, ${passed} passed\n`);
    console.error(failures.join('\n\n'));
    process.exit(1);
  }
  console.log(`✓ fillProtection: ${passed} passed`);
}

void main();
