/**
 * Standing triggers: OCO ordering, trailing ratchet, expiry, flat-cancel.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { evaluateTrigger, fireWhenFor } from '../services/TriggerService';
import { Trigger } from '../types';

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

const T0 = 1_700_000_000_000;
function oco(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 't1',
    userId: 'u',
    symbol: 'RELIANCE',
    product: 'CNC',
    kind: 'oco',
    legs: [
      { role: 'target', side: 'SELL', triggerPrice: 1100, fireWhen: 'above', orderType: 'MARKET', quantity: 10 },
      { role: 'stop', side: 'SELL', triggerPrice: 950, fireWhen: 'below', orderType: 'MARKET', quantity: 10 },
    ],
    status: 'ACTIVE',
    createdAt: T0,
    updatedAt: T0,
    expiresAt: T0 + 86_400_000,
    ...overrides,
  };
}

test('fireWhen: a sell target fires above, a sell stop below; buy legs the reverse', () => {
  assert.equal(fireWhenFor('SELL', 'target', 1100, 1000), 'above');
  assert.equal(fireWhenFor('SELL', 'stop', 950, 1000), 'below');
  assert.equal(fireWhenFor('BUY', 'target', 900, 1000), 'below');
  assert.equal(fireWhenFor('BUY', 'stop', 1050, 1000), 'above');
  assert.equal(fireWhenFor('BUY', 'single', 1050, 1000), 'above', 'a single leg fires on the side the level sits');
  assert.equal(fireWhenFor('BUY', 'single', 950, 1000), 'below');
});

test('nothing fires between the levels', () => {
  const d = evaluateTrigger(oco(), 1000, T0 + 1, false);
  assert.equal(d.fire, undefined);
  assert.equal(d.end, undefined);
});

test('the target fires above, the stop below', () => {
  assert.equal(evaluateTrigger(oco(), 1100, T0 + 1, false).fire?.role, 'target');
  assert.equal(evaluateTrigger(oco(), 949.9, T0 + 1, false).fire?.role, 'stop');
});

test('when a print satisfies both legs the stop wins', () => {
  // Degenerate but possible with a wide gap and a mis-set target below the stop.
  const t = oco({
    legs: [
      { role: 'target', side: 'SELL', triggerPrice: 900, fireWhen: 'above', orderType: 'MARKET', quantity: 10 },
      { role: 'stop', side: 'SELL', triggerPrice: 950, fireWhen: 'below', orderType: 'MARKET', quantity: 10 },
    ],
  });
  assert.equal(evaluateTrigger(t, 920, T0 + 1, false).fire?.role, 'stop');
});

test('expiry ends the trigger without firing', () => {
  const d = evaluateTrigger(oco(), 1200, T0 + 86_400_000, false);
  assert.equal(d.fire, undefined);
  assert.equal(d.end, 'expired');
  assert.equal(d.next.status, 'EXPIRED');
});

test('a flat position cancels a protective trigger', () => {
  const d = evaluateTrigger(oco({ autoCancelWhenFlat: true }), 1200, T0 + 1, true);
  assert.equal(d.fire, undefined, 'a stop must not fire on a position that no longer exists');
  assert.equal(d.next.status, 'CANCELLED');
  const keep = evaluateTrigger(oco({ autoCancelWhenFlat: false }), 1200, T0 + 1, true);
  assert.equal(keep.fire?.role, 'target', 'an entry trigger is not tied to a position');
});

test('a trailing stop ratchets up behind the high and never loosens', () => {
  let t = oco({ trailPct: 5, extreme: 1000 });
  // price runs to 1080: stop moves to 1080 × 0.95 = 1026
  let d = evaluateTrigger(t, 1080, T0 + 1, false);
  t = d.next;
  assert.equal(t.legs.find((l) => l.role === 'stop')!.triggerPrice, 1026);
  assert.equal(t.extreme, 1080);
  // price falls to 1040: stop stays at 1026 (never loosens), nothing fires
  d = evaluateTrigger(t, 1040, T0 + 2, false);
  t = d.next;
  assert.equal(t.legs.find((l) => l.role === 'stop')!.triggerPrice, 1026);
  assert.equal(d.fire, undefined);
  // price falls through 1026: the stop fires
  d = evaluateTrigger(t, 1025, T0 + 3, false);
  assert.equal(d.fire?.role, 'stop');
});

test('a trailing stop never sits below the original stop', () => {
  const t = oco({ trailPct: 20, extreme: 1000 }); // 1000 × 0.8 = 800 < 950
  const d = evaluateTrigger(t, 1000, T0 + 1, false);
  assert.equal(d.next.legs.find((l) => l.role === 'stop')!.triggerPrice, 950);
});

if (failures.length) {
  console.error(`\n✗ triggers: ${failures.length} failed, ${passed} passed\n`);
  console.error(failures.join('\n\n'));
  process.exit(1);
}
console.log(`✓ triggers: ${passed} passed`);
