/**
 * Services that had no tests: the boot-time stale-order sweep's decisions, the
 * funds reservation ledger, the allocator's switch-on rule, and the cleaning of
 * Yahoo daily bars the live engine now applies. No network, no database.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { sweepActionFor, STALE_PENDING_MS } from '../services/orderSweep';
import { FundsService } from '../services/FundsService';
import { enabledAfter } from '../services/allocator/allocate';
import { cleanDailyBars } from '../services/barCleaning';
import { config } from '../config';
import type { Candle } from '../types';

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

const NOW = Date.parse('2026-10-07T05:00:00Z');

async function main(): Promise<void> {
  // ── stale-order sweep ──────────────────────────────────────────────────
  await test('a young or finished order is left alone', () => {
    assert.equal(sweepActionFor({ status: 'PENDING', createdAt: NOW - 60_000 }, 'live', true, NOW), 'keep');
    assert.equal(sweepActionFor({ status: 'FILLED', createdAt: NOW - 86_400_000 }, 'live', true, NOW), 'keep');
  });

  await test('a stale paper order is closed: paper fills instantly, so it never executed', () => {
    assert.equal(sweepActionFor({ status: 'PENDING', createdAt: NOW - STALE_PENDING_MS - 1 }, 'paper', true, NOW), 'close');
  });

  await test('a stale live order is checked with the broker, or reported when it cannot be', () => {
    const old = NOW - STALE_PENDING_MS - 1;
    assert.equal(sweepActionFor({ status: 'PENDING', createdAt: old, brokerOrderId: 'K1' }, 'live', true, NOW), 'resolve');
    assert.equal(sweepActionFor({ status: 'PENDING', createdAt: old, brokerOrderId: 'K1' }, 'live', false, NOW), 'alert');
    assert.equal(sweepActionFor({ status: 'PENDING', createdAt: old }, 'live', true, NOW), 'alert', 'no broker id to look up');
  });

  // ── funds reservations (paper account) ─────────────────────────────────
  await test('a reservation is held against deployable cash and released after the order', async () => {
    const f = new FundsService();
    const U = 'svc-test-user';
    const before = await f.deployable(U, NOW);
    assert.ok(before > 0 && before <= config.risk.capital);
    assert.equal(await f.reserve('r1', 'ABC', 50_000, NOW, U), true);
    assert.equal(f.reserved(U, NOW), 50_000);
    assert.ok(Math.abs((await f.deployable(U, NOW)) - (before - 50_000 * (before / config.risk.capital))) < 1);
    f.release('r1');
    assert.equal(f.reserved(U, NOW), 0);
  });

  await test('a reservation larger than what is deployable is refused, not partially held', async () => {
    const f = new FundsService();
    const U = 'svc-test-user-2';
    assert.equal(await f.reserve('big', 'ABC', config.risk.capital * 2, NOW, U), false);
    assert.equal(f.reserved(U, NOW), 0);
  });

  await test('two reservations cannot together spend the same cash', async () => {
    const f = new FundsService();
    const U = 'svc-test-user-3';
    const all = await f.deployable(U, NOW);
    assert.equal(await f.reserve('a', 'A', all * 0.6, NOW, U), true);
    assert.equal(await f.reserve('b', 'B', all * 0.6, NOW, U), false, 'the second sees the first');
  });

  await test('a forgotten reservation expires instead of starving every later buy', async () => {
    const f = new FundsService();
    const U = 'svc-test-user-4';
    await f.reserve('stuck', 'ABC', 10_000, NOW, U);
    assert.equal(f.reserved(U, NOW + 6 * 60_000), 0);
  });

  // ── allocator switch-on rule ───────────────────────────────────────────
  await test('a stock the bot funds is switched on; one it passes over keeps the user\'s choice', () => {
    assert.equal(enabledAfter({ selected: true }, false), true);
    assert.equal(enabledAfter({ selected: false }, false), false);
    assert.equal(enabledAfter({ selected: false }, true), true);
  });

  await test('a hand-set amount or a rescue rung never switches a book on behind the user\'s back', () => {
    assert.equal(enabledAfter({ selected: true, manual: true }, false), false);
    assert.equal(enabledAfter({ selected: true, rescue: true }, false), false);
  });

  // ── daily bar cleaning (live engine) ───────────────────────────────────
  const bar = (i: number, close: number, high = close * 1.01): Candle =>
    ({ timestamp: NOW + i * 86_400_000, open: close, high, low: close * 0.99, close, volume: 1 }) as Candle;

  await test('a bad print at a tenth of the price is dropped before it reaches the start gate', () => {
    const bars = [bar(0, 130), bar(1, 13), bar(2, 13.1), bar(3, 131)];
    const clean = cleanDailyBars(bars);
    assert.deepEqual(clean.map((c) => c.close), [130, 131]);
  });

  await test('an impossible intraday high is clamped, so it cannot inflate the 45-day high', () => {
    const clean = cleanDailyBars([bar(0, 100), bar(1, 101, 400), bar(2, 102)]);
    assert.equal(clean[1].high, 101);
    assert.equal(clean[2].high, 102 * 1.01, 'normal highs are untouched');
  });

  await test('a real +30% day (F&O stocks have no circuit band) keeps its high', () => {
    const up = { ...bar(1, 130), open: 101, high: 132 };
    const clean = cleanDailyBars([bar(0, 100), up]);
    assert.equal(clean[1].high, 132, 'the high sits near the close: a real rally, not a print');
  });

  if (failures.length) {
    console.error(`✗ services: ${failures.length} failed, ${passed} passed`);
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log(`✓ services: ${passed} passed`);
}

void main();
