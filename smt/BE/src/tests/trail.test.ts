/**
 * Ratchet-exit tests.
 *
 * The ratchet is the one feature that touches the EXIT side, so it is the one
 * that could weaken the no-loss guarantee. These tests exist to prove it does
 * not. Three properties, in order of importance:
 *
 *   1. No closed lot ever books a loss, under any price path.
 *   2. An armed lot never sells below the fixed target it would have used
 *      without the ratchet — a gap through the target makes it HOLD, not sell
 *      cheap.
 *   3. The ratchet only ever fires above the target, so it is upside capture,
 *      never downside protection. It is not a stop-loss and must never behave
 *      like one.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { nextTradingDayStart } from '../services/session';
import {
  BreakevenViolationError,
  applyBuyFill,
  applyTrail,
  decide,
  lotArmPrice,
  lotBreakeven,
  lotTarget,
  lotTrailStop,
  recordDayHigh,
  sellLot,
} from '../services/accumulator/engine';
import {
  DEFAULT_ACCUMULATOR_PARAMS,
  type AccumulatorBook,
  type AccumulatorParams,
} from '../services/accumulator/types';

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

const P: AccumulatorParams = DEFAULT_ACCUMULATOR_PARAMS;
const OFF: AccumulatorParams = { ...P, trail: { ...P.trail, enabled: false } };
const BUDGET = 300_000;
const T0 = Date.parse('2026-01-05T04:00:00Z');
const HOUR = 3_600_000;

function book(over: Partial<AccumulatorBook> = {}): AccumulatorBook {
  return {
    id: 'b', userId: 'u', symbol: 'NIFTYBEES', instrument: 'ETF', budget: BUDGET, cash: BUDGET,
    unsettled: [], openLots: [], closedLots: [], epochs: [], lotSeq: 0, dayHighs: {}, orderedDays: [],
    enabled: true, killSwitchEngaged: false, createdAt: T0, updatedAt: T0, ...over,
  };
}

/** A book holding one lot bought at `price`. */
function withLot(price: number, params: AccumulatorParams = P): AccumulatorBook {
  let b = recordDayHigh(book(), price, T0);
  const qty = Math.floor((BUDGET * 0.85) / params.tranches / price);
  return applyBuyFill(b, { epoch: 0, level: 0, fillPrice: price, quantity: qty, at: T0 }, params);
}

/** Walk a price path through applyTrail + decide, executing every sell. */
function walk(
  b: AccumulatorBook,
  path: number[],
  params: AccumulatorParams = P,
): AccumulatorBook {
  let cur = b;
  let t = T0;
  for (const price of path) {
    t += HOUR;
    cur = applyTrail(cur, price, params);
    for (const d of decide(cur, price, t, params)) {
      if (d.action !== 'SELL') continue;
      try {
        cur = sellLot(cur, d.lotId!, d.limitPrice!, t, nextTradingDayStart(t), params);
      } catch (e) {
        if (!(e instanceof BreakevenViolationError)) throw e;
      }
    }
  }
  return cur;
}

// ─── the invariant ────────────────────────────────────────────────────────
test('no closed lot books a loss across 400 random price paths with the ratchet on', () => {
  let seed = 20260908;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let closed = 0;
  for (let run = 0; run < 400; run++) {
    let price = 100;
    const path: number[] = [];
    for (let i = 0; i < 260; i++) {
      price *= 1 + (rnd() - 0.5) * 0.14; // up to ±7% a step, both directions
      path.push(Math.max(1, price));
    }
    const after = walk(withLot(100), path);
    for (const l of after.closedLots) {
      closed++;
      assert.ok(l.pnl > 0, `run ${run}: closed lot booked ${l.pnl}`);
      assert.ok(l.sellPrice >= l.netBreakeven, `run ${run}: sold under breakeven`);
    }
  }
  assert.ok(closed > 100, `expected plenty of closes, saw ${closed}`);
});

test('an armed lot can never sell below the fixed target', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let run = 0; run < 200; run++) {
    const start = withLot(100);
    const target = lotTarget(start, start.openLots[0], P);
    let price = 100;
    const path: number[] = [];
    for (let i = 0; i < 200; i++) {
      price *= 1 + (rnd() - 0.45) * 0.2; // upward drift then violent moves
      path.push(Math.max(1, price));
    }
    for (const l of walk(start, path).closedLots) {
      assert.ok(
        l.sellPrice >= target - 1e-9,
        `run ${run}: sold at ${l.sellPrice}, under the fixed target ${target}`,
      );
    }
  }
});

test('sellLot still refuses a ratchet exit priced below breakeven', () => {
  const b = withLot(100);
  const lot = b.openLots[0];
  const floor = lotBreakeven(b, lot, P);
  assert.throws(
    () => sellLot(b, lot.id, floor - 0.5, T0 + HOUR, nextTradingDayStart(T0 + HOUR), P),
    BreakevenViolationError,
  );
});

// ─── arming ───────────────────────────────────────────────────────────────
test('a lot arms only above the arm price, which sits above the target', () => {
  const b = withLot(100);
  const lot = b.openLots[0];
  const target = lotTarget(b, lot, P);
  const arm = lotArmPrice(b, lot, P);
  assert.ok(arm > target, `arm ${arm} must sit above target ${target}`);

  assert.equal(applyTrail(b, target, P).openLots[0].armed, undefined, 'not armed at the target');
  const armed = applyTrail(b, arm, P).openLots[0];
  assert.equal(armed.armed, true);
  assert.equal(armed.hwm, arm);
});

test('the high-water mark ratchets up and never down', () => {
  let b = withLot(100);
  const arm = lotArmPrice(b, b.openLots[0], P);
  b = applyTrail(b, arm, P);
  b = applyTrail(b, arm * 1.2, P);
  assert.equal(b.openLots[0].hwm, arm * 1.2);
  b = applyTrail(b, arm * 0.9, P);
  assert.equal(b.openLots[0].hwm, arm * 1.2, 'a lower price must not lower the mark');
});

test('the trailing stop is floored at the fixed target', () => {
  const b = withLot(100);
  const lot = b.openLots[0];
  const target = lotTarget(b, lot, P);
  // A huge giveback would put the raw stop under breakeven; the floor holds.
  const wide: AccumulatorParams = { ...P, trail: { ...P.trail, retracePct: 90 } };
  const armed = applyTrail(b, lotArmPrice(b, lot, wide), wide).openLots[0];
  assert.equal(lotTrailStop(b, armed, wide), target);
});

// ─── behaviour ────────────────────────────────────────────────────────────
test('a lot that never reaches the arm price behaves exactly as before', () => {
  const start = withLot(100);
  const target = lotTarget(start, start.openLots[0], P);
  const path = [target * 0.99, target, target * 1.01];
  const on = walk(start, path, P);
  const off = walk(start, path, OFF);
  assert.equal(on.closedLots.length, 1);
  assert.equal(off.closedLots.length, 1);
  assert.equal(on.closedLots[0].sellPrice, off.closedLots[0].sellPrice);
});

test('a lot that GAPS past the arm price is ridden, not capped at the target', () => {
  // The ratchet can only engage when a single move carries price from under the
  // target to over the arm price — a gap, or a fast run between polls. On a slow
  // grind through the target the lot sells at the target, as it always did. That
  // is the price of never selling for less than the target, and it is the whole
  // reason this feature is narrow rather than free.
  const start = withLot(100);
  const lot = start.openLots[0];
  const be = lotBreakeven(start, lot, P);
  const peak = be * 1.6;
  const path = [be * 1.02, be * 1.3, peak, peak * 0.96];

  const on = walk(start, path, P);
  const off = walk(start, path, OFF);

  assert.equal(off.closedLots.length, 1);
  assert.equal(on.closedLots.length, 1);
  assert.ok(
    on.closedLots[0].pnl > off.closedLots[0].pnl * 5,
    `ratchet booked ${on.closedLots[0].pnl}, fixed target booked ${off.closedLots[0].pnl}`,
  );
});

test('a slow grind through the target still sells at the target — no regression, no gain', () => {
  const start = withLot(100);
  const be = lotBreakeven(start, start.openLots[0], P);
  // Small steps: the lot crosses the target long before it could arm.
  const path = [be * 1.01, be * 1.03, be * 1.05, be * 1.5];
  const on = walk(start, path, P);
  const off = walk(start, path, OFF);
  assert.equal(on.closedLots.length, 1);
  assert.equal(on.closedLots[0].sellPrice, off.closedLots[0].sellPrice);
});

test('a gap straight through the target leaves the lot open rather than selling cheap', () => {
  const start = withLot(100);
  const lot = start.openLots[0];
  const be = lotBreakeven(start, lot, P);
  const target = lotTarget(start, lot, P);
  // Arms at the high, then gaps below the target in one step.
  const after = walk(start, [be * 1.3, be * 1.005], P);
  assert.equal(after.closedLots.length, 0, 'must not sell below the target');
  assert.equal(after.openLots.length, 1);
  assert.equal(after.openLots[0].armed, true, 'stays armed, waiting');
  // And when price returns to the target, it sells at or above it.
  const back = walk(after, [target * 1.02], P);
  assert.equal(back.closedLots.length, 1);
  assert.ok(back.closedLots[0].sellPrice >= target - 1e-9);
});

test('the ratchet never fires as a stop-loss: no exit below breakeven is ever proposed', () => {
  let b = withLot(100);
  const lot = b.openLots[0];
  const floor = lotBreakeven(b, lot, P);
  b = applyTrail(b, floor * 1.5, P); // armed, high mark well up
  // Sweep the whole price range and check every SELL the engine proposes.
  for (let px = floor * 0.3; px < floor * 1.6; px += floor * 0.01) {
    for (const d of decide(b, px, T0 + HOUR, P)) {
      if (d.action !== 'SELL') continue;
      assert.ok(d.limitPrice! >= floor, `proposed a sell at ${d.limitPrice} below breakeven ${floor}`);
      assert.ok(d.limitPrice! >= lotTarget(b, lot, P) - 1e-9, 'proposed a sell below the fixed target');
    }
  }
});

test('the ratchet is off for a book whose params disable it', () => {
  const b = applyTrail(withLot(100), 1000, OFF);
  assert.equal(b.openLots[0].armed, undefined);
});

// ─── trend riding: arm AT the target while the regime is up ───────────────
/** The same one-lot book, with a confirmed regime set. */
function inRegime(regime: 'up' | 'down' | 'sideways', price = 100): AccumulatorBook {
  return { ...withLot(price), regime };
}
const RIDE = P.trail.uptrend.retracePct;

test('uptrend: a lot arms at its target instead of selling there', () => {
  const b = inRegime('up');
  const lot = b.openLots[0];
  const target = lotTarget(b, lot, P);
  assert.equal(lotArmPrice(b, lot, P), target);
  const after = walk(b, [target * 0.99, target * 1.001], P);
  assert.equal(after.closedLots.length, 0, 'must not sell at the target in an uptrend');
  assert.equal(after.openLots[0].armed, true);
  assert.equal(after.openLots[0].trailPct, RIDE);
});

test('uptrend: the worked example — peak +10% over cost sells one giveback below the peak', () => {
  const b = inRegime('up');
  const be = lotBreakeven(b, b.openLots[0], P);
  const peak = be * 1.1;
  const stop = peak * (1 - RIDE / 100); // ≈ +8.35% over breakeven
  const held = walk(b, [be * 1.03, be * 1.05, be * 1.08, peak, stop * 1.001], P);
  assert.equal(held.closedLots.length, 0, 'still riding above the stop');
  assert.ok(Math.abs(lotTrailStop(held, held.openLots[0], P) - stop) < 0.05);
  const sold = walk(held, [stop * 0.999], P);
  assert.equal(sold.closedLots.length, 1);
  const s = sold.closedLots[0].sellPrice;
  // Fills at the market (stop × 0.999 here), never better than it — the stop's honest fill.
  assert.ok(s >= stop * 0.998 && s <= stop, `sold at ${s}, stop ${stop}`);
});

test('uptrend: a pullback right after crossing sells at the target, never below it', () => {
  const b = inRegime('up');
  const target = lotTarget(b, b.openLots[0], P);
  // Crosses by a hair, so the giveback sits under the target: the floor wins.
  const after = walk(b, [target * 1.002, target * 0.999, target], P);
  assert.equal(after.closedLots.length, 1);
  assert.ok(after.closedLots[0].sellPrice >= target - 1e-9);
});

test('sideways or down: lots still sell at the target exactly as before', () => {
  for (const regime of ['sideways', 'down'] as const) {
    const b = inRegime(regime);
    const target = lotTarget(b, b.openLots[0], P);
    const path = [target * 0.99, target, target * 1.01];
    const on = walk(b, path, P);
    const off = walk(b, path, OFF);
    assert.equal(on.closedLots.length, 1, regime);
    assert.equal(on.closedLots[0].sellPrice, off.closedLots[0].sellPrice, regime);
  }
});

test('a lot armed in an uptrend keeps its giveback after the trend turns down', () => {
  let b = inRegime('up');
  const be = lotBreakeven(b, b.openLots[0], P);
  b = walk(b, [be * 1.05, be * 1.12], P);
  b = { ...b, regime: 'down' };
  assert.equal(b.openLots[0].trailPct, RIDE);
  const stop = lotTrailStop(b, b.openLots[0], P);
  assert.ok(Math.abs(stop - be * 1.12 * (1 - RIDE / 100)) < 0.05, `stop ${stop}`);
  const sold = walk(b, [stop * 0.998], P);
  assert.equal(sold.closedLots.length, 1, 'the downturn pullback takes the profit');
});

test('uptrend riding switched off: behaves as the plain ratchet', () => {
  const noRide: AccumulatorParams = { ...P, trail: { ...P.trail, uptrend: { ...P.trail.uptrend, enabled: false } } };
  const b = inRegime('up');
  assert.ok(lotArmPrice(b, b.openLots[0], noRide) > lotTarget(b, b.openLots[0], noRide));
});

test('uptrend: no closed lot books a loss or sells under target across 400 random paths', () => {
  let seed = 424242;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let closed = 0;
  for (let run = 0; run < 400; run++) {
    const start = inRegime(run % 3 === 0 ? 'down' : 'up');
    const target = lotTarget(start, start.openLots[0], P);
    let price = 100;
    const path: number[] = [];
    for (let i = 0; i < 260; i++) {
      price *= 1 + (rnd() - 0.48) * 0.08;
      path.push(Math.max(1, price));
    }
    for (const l of walk(start, path).closedLots) {
      closed++;
      assert.ok(l.pnl > 0, `run ${run}: loss ${l.pnl}`);
      assert.ok(l.sellPrice >= target - 1e-9, `run ${run}: sold ${l.sellPrice} under target ${target}`);
    }
  }
  assert.ok(closed > 100, `expected plenty of closes, saw ${closed}`);
});

if (failures.length) {
  console.error(`✗ trail: ${failures.length} failed, ${passed} passed`);
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`✓ trail: ${passed} passed`);
