/**
 * One-off data repairs from the 10 Sep 2026 audit. Every write is by `_id`.
 *
 *   npx ts-node --transpile-only src/scripts/repair2026_09.ts
 *
 *  1. RELIANCE and TCS books were seeded as `instrument: 'ETF'` with no
 *     `enabled` flag. Both are stocks; the ETF cost model would understate
 *     every breakeven by ~0.2% if either were ever funded.
 *  2. Trade f7c912ab (ICICIBANK SELL, 9 Sep) was a signal computed on
 *     synthetic candles, filled at the real price and "stopped" at a level
 *     derived from the fake one, booking +₹4,820 that never happened. It is
 *     flagged invalid, not deleted, so the record survives and every
 *     performance figure excludes it.
 *  3. Order 420fe020 (the TCS exit) was persisted as PENDING by an out-of-order
 *     write although its trade closed at 2,210.40. Set to what happened.
 */
import mongoose from 'mongoose';
import { config } from '../config';

const USER = '92ac98d0-fcfd-4fda-9641-fc3ceb115cfe';

async function main(): Promise<void> {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
  const db = mongoose.connection.db!;

  for (const sym of ['RELIANCE', 'TCS']) {
    const id = `${USER}:${sym}`;
    const before = await db.collection('accumulatorbooks').findOne({ _id: id as never });
    if (!before) {
      console.log(`${sym}: no book, nothing to do`);
      continue;
    }
    if (before.openLots?.length || before.closedLots?.length) {
      console.log(`${sym}: has lots — refusing to retype it; do this by hand`);
      continue;
    }
    const r = await db.collection('accumulatorbooks').updateOne(
      { _id: id as never },
      { $set: { instrument: 'EQUITY', enabled: false, enabledChangedAt: Date.now(), enabledChangedBy: 'user', updatedAt: Date.now() } },
    );
    console.log(`${sym}: instrument ETF → EQUITY, enabled → false (matched ${r.matchedCount})`);
  }

  const tradeId = 'f7c912ab-743e-426b-9d23-e3871fe03ac4';
  const t = await db.collection('trades').findOne({ _id: tradeId as never });
  if (t) {
    const r = await db.collection('trades').updateOne(
      { _id: tradeId as never },
      {
        $set: {
          invalid: true,
          invalidReason:
            'signal computed on synthetic seed candles (ref ≈₹1,049.77) and filled at the real ₹1,388.20; the +₹4,820 "stop-loss" exit at ₹1,065.50 never happened at the exchange',
        },
      },
    );
    console.log(`trade ${tradeId}: flagged invalid (matched ${r.matchedCount}, pnl was ${t.pnl})`);
  } else {
    console.log(`trade ${tradeId}: not found`);
  }

  const orderId = '420fe020-72fe-4f2d-833f-6c200d685de9';
  const o = await db.collection('orders').findOne({ _id: orderId as never });
  if (o && o.status === 'PENDING') {
    const r = await db.collection('orders').updateOne(
      { _id: orderId as never },
      { $set: { status: 'FILLED', filledQuantity: o.quantity, updatedAt: (o.createdAt ?? Date.now()) + 5, adjustment: 'repaired 2026-09-10: persisted PENDING by an out-of-order write; the trade it closed shows the fill' } },
    );
    console.log(`order ${orderId}: PENDING → FILLED ${o.quantity} @ ${o.filledPrice} (matched ${r.matchedCount})`);
  } else {
    console.log(`order ${orderId}: ${o ? `already ${o.status}` : 'not found'}`);
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
