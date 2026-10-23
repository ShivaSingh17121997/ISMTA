/**
 * Persistence round-trip against a real MongoDB, when one is reachable.
 *
 * Two regressions this guards:
 *  1. Writes to one key land in program order (PENDING then FILLED can never
 *     be stored reversed).
 *  2. A top-level `id` field survives the round trip. Mongoose's default `id`
 *     virtual silently dropped it under replaceOne, and every trade and order
 *     written on 10–11 Sep 2026 came back without one — invisible to the exit
 *     engine after a restart.
 *
 * Skips (passes) when MongoDB is not running, so `npm test` works offline.
 * Uses the backtest-run ledger with a throwaway key and removes it after.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectMongo } from '../store/db';
import { BacktestRunModel, SystemStateModel } from '../store/models';
import { TradingHalt } from '../services/guards';
import { store } from '../store/memoryStore';
import { BacktestRun } from '../types';

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures.push(`  ✗ ${name}\n    ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
}

function run(id: string, sharpe: number): BacktestRun {
  return {
    id,
    userId: 'persistence-test',
    at: Date.now(),
    strategyType: 'MA_CROSSOVER',
    symbol: 'ZZTEST',
    params: {},
    source: 'test',
    interval: '1d',
    bars: 0,
    from: 0,
    to: 0,
    startingCapital: 1,
    totalReturnPct: 0,
    trades: 0,
    winRate: 0,
    profitFactor: 0,
    maxDrawdownPct: 0,
    sharpeRatio: sharpe,
    periodSharpe: sharpe,
    skew: 0,
    kurtosis: 3,
  };
}

async function main(): Promise<void> {
  const ok = await connectMongo();
  if (!ok) {
    console.log('✓ persistence: skipped (MongoDB not reachable)');
    return;
  }
  const key = `persistence-test-${Date.now()}`;
  try {
    await test('a top-level id survives the round trip', async () => {
      store.backtestRuns.set(key, run(key, 1));
      await store.backtestRuns.flush();
      const doc = (await BacktestRunModel.findById(key).lean()) as Record<string, unknown> | null;
      assert.ok(doc, 'document written');
      assert.equal(doc!.id, key, 'the `id` field must be stored, not eaten by the id virtual');
    });

    await test('twenty rapid writes to one key land in program order', async () => {
      for (let i = 1; i <= 20; i++) store.backtestRuns.set(key, run(key, i));
      await store.backtestRuns.flush();
      const doc = (await BacktestRunModel.findById(key).lean()) as Record<string, unknown> | null;
      assert.equal(doc!.sharpeRatio, 20, 'the last write in program order is the last write in the database');
    });

    await test('a field removed from the object is removed from the document', async () => {
      const r = run(key, 5) as BacktestRun & { extra?: string };
      r.extra = 'gone soon';
      store.backtestRuns.set(key, r);
      await store.backtestRuns.flush();
      delete r.extra;
      store.backtestRuns.set(key, r);
      await store.backtestRuns.flush();
      const doc = (await BacktestRunModel.findById(key).lean()) as Record<string, unknown> | null;
      assert.equal(doc!.extra, undefined, 'a snapshot is a snapshot');
    });

    await test('a manual trading halt survives a restart; clearing it survives too', async () => {
      const prefix = `zztest-halt-${Date.now()}:`;
      const before = new TradingHalt(prefix);
      before.set('manual', 'test halt');
      before.set('feed', 'automatic, must not persist');
      await new Promise((r) => setTimeout(r, 300));
      const after = new TradingHalt(prefix);
      await after.restore();
      assert.deepEqual(after.list().map((h) => h.key), ['manual'], 'only the manual halt comes back');
      after.clear('manual');
      await new Promise((r) => setTimeout(r, 300));
      const again = new TradingHalt(prefix);
      await again.restore();
      assert.equal(again.active, false, 'a cleared halt stays cleared');
      await SystemStateModel.deleteMany({ _id: { $regex: `^${prefix}` } });
    });
  } finally {
    store.backtestRuns.delete(key);
    await store.backtestRuns.flush();
    await mongoose.disconnect();
  }

  if (failures.length) {
    console.error(`\n✗ persistence: ${failures.length} failed, ${passed} passed\n`);
    console.error(failures.join('\n\n'));
    process.exit(1);
  }
  console.log(`✓ persistence: ${passed} passed`);
}

void main();
