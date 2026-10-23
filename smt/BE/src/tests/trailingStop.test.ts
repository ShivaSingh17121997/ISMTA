/**
 * Unit tests for the NTB trailing-stop engine (spec Phase 8/9).
 *
 * The engine is pure, so these need no server, no Mongo and no clock. Per the
 * spec's implementation checklist this is the FIRST thing to get right —
 * everything else is plumbing around it.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { TrailingState } from '../types';
import {
  addSafetyOrder,
  adversePath,
  cappedStopFill,
  DcaConfig,
  finalStopPrice,
  nextDeviationPct,
  openTrailing,
  profitPct,
  TrailingConfig,
  TrailingPosition,
  updateTrailing,
} from '../strategies/trailingStop';

// ─── harness ───────────────────────────────────────────────────────────
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
/** Round to 2dp for comparison — these are prices, not exact binary fractions. */
const p2 = (n: number) => Math.round(n * 100) / 100;

const NO_DCA: DcaConfig = {
  enabled: false,
  maxSafetyOrders: 0,
  deviationPct: 0,
  stepScale: 1,
  volumeScale: 1,
  finalStopPct: 0,
};

const CFG: TrailingConfig = {
  activationPct: 0.8,
  trailPct: 1.5,
  stopLossPct: 1.0,
  takeProfitPct: 0,
  dca: NO_DCA,
};

function longAt(entry: number, stopPct = 1.0, dcaActive = false): TrailingPosition {
  return { side: 'BUY', entryPrice: entry, quantity: 10, trailing: openTrailing(entry, stopPct, dcaActive, 1000) };
}
function shortAt(entry: number, stopPct = 1.0, dcaActive = false): TrailingPosition {
  return { side: 'SELL', entryPrice: entry, quantity: 10, trailing: openTrailing(entry, stopPct, dcaActive, 1000) };
}

// ─── Phase 8: the spec's worked example, row by row ─────────────────────
// Entry 100, activation 0.8, trail 1.5, stop 1.0.

test("worked example: row 1 — price 100, flat, protection is the hard stop 99.00", () => {
  const pos = longAt(100);
  const d = updateTrailing(pos, 100, CFG);
  assert.equal(d.type, 'HOLD');
  assert.equal(pos.trailing.peak, 100);
  assert.equal(p2(profitPct(pos, 100)), 0);
  assert.equal(pos.trailing.armed, false);
  assert.equal(p2(d.protectionPrice), 99.0);
});

test("worked example: row 2 — price 100.5, +0.5% is below activation, still not armed", () => {
  const pos = longAt(100);
  updateTrailing(pos, 100, CFG);
  const d = updateTrailing(pos, 100.5, CFG);
  assert.equal(d.type, 'HOLD');
  assert.equal(pos.trailing.peak, 100.5);
  assert.equal(p2(profitPct(pos, 100.5)), 0.5);
  assert.equal(pos.trailing.armed, false, 'must not arm below activationPct');
  assert.equal(p2(d.protectionPrice), 99.0, 'protection is still the hard stop');
});

test("worked example: row 3 — price 101, +1.0% arms the trail, protection jumps to 99.49", () => {
  const pos = longAt(100);
  const d = updateTrailing(pos, 101, CFG);
  assert.equal(d.type, 'HOLD');
  assert.equal(pos.trailing.armed, true, 'must arm at pnl >= activationPct');
  assert.equal(p2(d.protectionPrice), 99.49);
  assert.ok(d.protectionPrice > 99.0, 'once armed the trail sits ABOVE the hard stop');
});

test("worked example: row 4 — price 110, riding the winner, protection ratchets to 108.35", () => {
  const pos = longAt(100);
  updateTrailing(pos, 101, CFG);
  const d = updateTrailing(pos, 110, CFG);
  assert.equal(d.type, 'HOLD');
  assert.equal(pos.trailing.peak, 110);
  assert.equal(p2(d.protectionPrice), 108.35);
});

test("worked example: row 5 — price 108.3 EXITS trailing at +8.3%, peak stays at 110", () => {
  const pos = longAt(100);
  updateTrailing(pos, 101, CFG);
  updateTrailing(pos, 110, CFG);
  const d = updateTrailing(pos, 108.3, CFG);
  assert.equal(d.type, 'EXIT');
  assert.equal(d.type === 'EXIT' && d.reason, 'trailing');
  assert.equal(pos.trailing.peak, 110, 'the peak ratchets and never retreats');
  assert.equal(p2(d.protectionPrice), 108.35);
  assert.equal(p2(profitPct(pos, 108.3)), 8.3, 'the spec books this as +8.3%');
});

// ─── Phase 8: invariants ───────────────────────────────────────────────

test('arming is a one-way latch — profit falling back below activation does not disarm', () => {
  const pos = longAt(100);
  updateTrailing(pos, 101, CFG);
  assert.equal(pos.trailing.armed, true);
  updateTrailing(pos, 100.1, CFG); // +0.1%, well under the 0.8% activation
  assert.equal(pos.trailing.armed, true, 'armed must never revert (except on a DCA add)');
});

test('stop-loss is evaluated BEFORE trailing — a fast adverse move is not masked', () => {
  const pos = longAt(100);
  updateTrailing(pos, 110, CFG); // arm, peak 110, trail level 108.35
  // 98 is below BOTH the trail (108.35) and the hard stop (99). Must report stop_loss.
  const d = updateTrailing(pos, 98, CFG);
  assert.equal(d.type, 'EXIT');
  assert.equal(d.type === 'EXIT' && d.reason, 'stop_loss', 'stop_loss must win over trailing');
  assert.equal(p2(d.protectionPrice), 99.0, 'and it fills at the stop level, not the trail');
});

test('unarmed position exits on the hard stop', () => {
  const pos = longAt(100);
  const d = updateTrailing(pos, 98.9, CFG); // below 99.00, never armed
  assert.equal(d.type, 'EXIT');
  assert.equal(d.type === 'EXIT' && d.reason, 'stop_loss');
});

test('trailing never fires while unarmed, even on a big retrace', () => {
  const pos = longAt(100);
  updateTrailing(pos, 100.5, CFG); // peak 100.5, not armed (+0.5% < 0.8%)
  const d = updateTrailing(pos, 99.5, CFG); // -1% off the peak, past trailPct, but above the 99 stop
  assert.equal(d.type, 'HOLD', 'an unarmed trail must not exit');
});

test('takeProfitPct = 0 disables the cap (the spec default)', () => {
  const pos = longAt(100);
  const d = updateTrailing(pos, 500, CFG); // +400%
  assert.equal(d.type, 'HOLD', 'with tp=0 the winner keeps running');
});

test('takeProfitPct > 0 caps the winner at the observed price', () => {
  const pos = longAt(100);
  const d = updateTrailing(pos, 103, { ...CFG, takeProfitPct: 2 });
  assert.equal(d.type, 'EXIT');
  assert.equal(d.type === 'EXIT' && d.reason, 'take_profit');
  assert.equal(d.protectionPrice, 103, 'take-profit fills at the observed price');
});

test('per-position stopPct overrides the config default (locked at entry)', () => {
  const pos = longAt(100, 2.5); // ATR-derived 2.5% stop
  const d = updateTrailing(pos, 98.0, CFG); // below the cfg 1% stop (99), above the locked 2.5% (97.5)
  assert.equal(d.type, 'HOLD', 'the config default must not override a locked stopPct');
  assert.equal(p2(d.protectionPrice), 97.5);
});

// ─── Phase 8: shorts mirror correctly ──────────────────────────────────

test('short: profit is positive as price FALLS', () => {
  const pos = shortAt(100);
  assert.equal(p2(profitPct(pos, 95)), 5);
  assert.equal(p2(profitPct(pos, 105)), -5);
});

test('short: trails off the trough and exits on a rally', () => {
  const pos = shortAt(100);
  const d1 = updateTrailing(pos, 90, CFG); // +10%, arms; trough 90; trail = 90*1.015 = 91.35
  assert.equal(d1.type, 'HOLD');
  assert.equal(pos.trailing.armed, true);
  assert.equal(p2(d1.protectionPrice), 91.35);
  const d2 = updateTrailing(pos, 91.4, CFG);
  assert.equal(d2.type, 'EXIT');
  assert.equal(d2.type === 'EXIT' && d2.reason, 'trailing');
  assert.equal(pos.trailing.trough, 90, 'the trough ratchets down and never retreats');
});

test('short: hard stop is ABOVE entry', () => {
  const pos = shortAt(100);
  const d = updateTrailing(pos, 101.5, CFG); // stop = 100*1.01 = 101
  assert.equal(d.type, 'EXIT');
  assert.equal(d.type === 'EXIT' && d.reason, 'stop_loss');
  assert.equal(p2(d.protectionPrice), 101.0);
});

// ─── Phase 8: the stop fill model ──────────────────────────────────────

test('cappedStopFill: no gap → fills at the stop level, not the observed extreme', () => {
  // The bar traded down to 94 but opened at 99.5, above the 99 stop.
  const r = cappedStopFill('BUY', 99, 94, 99.5);
  assert.equal(r.price, 99, 'a 1% stop must not become a 6% loss');
  assert.equal(r.gapped, false);
});

test('cappedStopFill: true gap → fills at the open and flags it', () => {
  const r = cappedStopFill('BUY', 99, 94, 94.5); // bar OPENED below the stop
  assert.equal(r.price, 94.5, 'a real gap fills at the open, which is worse');
  assert.equal(r.gapped, true);
});

test('cappedStopFill: short gaps upward', () => {
  assert.deepEqual(cappedStopFill('SELL', 101, 106, 100.5), { price: 101, gapped: false });
  assert.deepEqual(cappedStopFill('SELL', 101, 106, 105.5), { price: 105.5, gapped: true });
});

test('cappedStopFill: live poll (no candle context) assumes the resting stop filled', () => {
  const r = cappedStopFill('BUY', 99, 94, undefined);
  assert.equal(r.price, 99);
  assert.equal(r.gapped, false);
});

test('adversePath: long walks the LOW before the HIGH', () => {
  const bar = { open: 100, high: 105, low: 95, close: 102 };
  assert.deepEqual(adversePath('BUY', bar), [100, 95, 105, 102]);
});

test('adversePath: short walks the HIGH before the LOW', () => {
  const bar = { open: 100, high: 105, low: 95, close: 102 };
  assert.deepEqual(adversePath('SELL', bar), [100, 105, 95, 102]);
});

test('adversePath + engine: a bar touching BOTH stop and trail scores as a stop-out', () => {
  const pos = longAt(100);
  updateTrailing(pos, 110, CFG); // armed, peak 110, trail 108.35, stop 99
  // This bar touches the trail (108) AND the stop (98). Honest answer: stop_loss.
  const bar = { open: 109, high: 111, low: 98, close: 108 };
  const reasons: string[] = [];
  for (const price of adversePath('BUY', bar)) {
    const d = updateTrailing(pos, price, CFG);
    if (d.type === 'EXIT') {
      reasons.push(d.reason);
      break;
    }
  }
  assert.deepEqual(reasons, ['stop_loss'], 'walking low-first must book the loss, not the win');
});

// ─── Phase 9: DCA ──────────────────────────────────────────────────────

const DCA: DcaConfig = {
  enabled: true,
  maxSafetyOrders: 2,
  deviationPct: 1.0,
  stepScale: 2,
  volumeScale: 1.5,
  finalStopPct: 5,
};
const DCA_CFG: TrailingConfig = { ...CFG, dca: DCA };

test('DCA: replaces the classic stop — a losing position is NOT stopped out', () => {
  const pos = longAt(100, 1.0, true);
  const d = updateTrailing(pos, 99.5, DCA_CFG); // below the 99... no: -0.5%, above the 1% trigger
  assert.equal(d.type, 'HOLD', 'with DCA active the hard stop does not apply');
});

test('DCA: holds with NO protection while budget remains (the core trade-off)', () => {
  const pos = longAt(100, 1.0, true);
  const d = updateTrailing(pos, 97, DCA_CFG); // -3%: past the 1% stop AND past the 1% trigger
  assert.equal(d.type, 'ADD', 'it adds rather than stopping out');
});

test('DCA: first safety order triggers at deviationPct', () => {
  const pos = longAt(100, 1.0, true);
  assert.equal(updateTrailing(pos, 99.5, DCA_CFG).type, 'HOLD', '-0.5% is inside the 1% trigger');
  const d = updateTrailing(pos, 99.0, DCA_CFG); // exactly -1%
  assert.equal(d.type, 'ADD');
  assert.equal(d.type === 'ADD' && d.notional, 1500, 'k=1 notional = 1000 * 1.5^1');
});

test('DCA: trigger distance widens by stepScale after each add', () => {
  const st: TrailingState = openTrailing(100, 1, true, 1000);
  assert.equal(nextDeviationPct(st, DCA), 1.0);
  st.dcaOrdersUsed = 1;
  assert.equal(nextDeviationPct(st, DCA), 2.0, '1.0 * 2^1');
  st.dcaOrdersUsed = 2;
  assert.equal(nextDeviationPct(st, DCA), 4.0, '1.0 * 2^2');
});

test('DCA: addSafetyOrder recomputes the weighted average, re-references and DIS-ARMS', () => {
  const pos = longAt(100, 1.0, true);
  pos.quantity = 10;
  updateTrailing(pos, 110, DCA_CFG); // arm it first
  assert.equal(pos.trailing.armed, true);

  addSafetyOrder(pos, 90, 10); // add 10 @ 90 → avg (100*10 + 90*10)/20 = 95
  assert.equal(pos.entryPrice, 95, 'weighted average');
  assert.equal(pos.quantity, 20);
  assert.equal(pos.trailing.dcaOrdersUsed, 1);
  assert.equal(pos.trailing.peak, 95, 'peak re-references to the new average');
  assert.equal(pos.trailing.trough, 95, 'trough re-references to the new average');
  assert.equal(pos.trailing.armed, false, 'the ONLY place armed goes back to false');
});

test('DCA: once budget is spent, finalStopPct is the one real loss bound', () => {
  const pos = longAt(100, 1.0, true);
  pos.trailing.dcaOrdersUsed = 2; // budget spent (maxSafetyOrders = 2)
  assert.equal(p2(finalStopPrice(pos, DCA_CFG)), 95.0, '5% final stop');
  assert.equal(updateTrailing(pos, 96, DCA_CFG).type, 'HOLD', 'above the final stop → still holding');
  const d = updateTrailing(pos, 94.9, DCA_CFG);
  assert.equal(d.type, 'EXIT');
  assert.equal(d.type === 'EXIT' && d.reason, 'stop_loss');
  assert.equal(p2(d.protectionPrice), 95.0);
});

test('DCA: finalStopPct = 0 falls back to the locked stopPct', () => {
  const pos = longAt(100, 3.0, true);
  const cfg = { ...DCA_CFG, dca: { ...DCA, finalStopPct: 0 } };
  assert.equal(p2(finalStopPrice(pos, cfg)), 97.0, 'falls back to the position stopPct (3%)');
});

test('DCA: an averaged position still take-profits and trails normally (falls through)', () => {
  const pos = longAt(100, 1.0, true);
  const d = updateTrailing(pos, 103, { ...DCA_CFG, takeProfitPct: 2 });
  assert.equal(d.type, 'EXIT');
  assert.equal(d.type === 'EXIT' && d.reason, 'take_profit', 'DCA must not swallow the upside checks');
});

test('DCA: dcaActive is frozen at open — a runtime config flip cannot change an open position', () => {
  const pos = longAt(100, 1.0, false); // opened with DCA OFF
  const d = updateTrailing(pos, 98, DCA_CFG); // config now says DCA is on
  assert.equal(d.type, 'EXIT');
  assert.equal(d.type === 'EXIT' && d.reason, 'stop_loss', 'it rides out under the mode it opened with');
});

test('DCA: a BLOCKED add falls back to the final stop instead of riding down unprotected', () => {
  // THE bug this flag exists for: dcaOrdersUsed only advances on a FILL, so a
  // refused add never spends the budget and the final stop is never reached.
  // Adds are refused exactly when you are losing — i.e. exactly when it matters.
  const pos = longAt(100, 1.0, true);
  assert.equal(updateTrailing(pos, 97, DCA_CFG).type, 'ADD', 'first it tries to average');

  pos.trailing.dcaBlocked = true; // the add was refused (risk gate, or 0 shares)

  assert.equal(
    updateTrailing(pos, 97, DCA_CFG).type,
    'HOLD',
    'above the 5% final stop it still holds',
  );
  const d = updateTrailing(pos, 94.9, DCA_CFG); // past the 5% final stop
  assert.equal(d.type, 'EXIT', 'BLOCKED must not mean unprotected forever');
  assert.equal(d.type === 'EXIT' && d.reason, 'stop_loss');
  assert.equal(p2(d.protectionPrice), 95.0);
});

test('DCA: blocked with budget remaining still exits — the budget is never spent by refusals', () => {
  const pos = longAt(100, 1.0, true);
  pos.trailing.dcaBlocked = true;
  assert.equal(pos.trailing.dcaOrdersUsed, 0, 'budget untouched — no add ever filled');
  const d = updateTrailing(pos, 90, DCA_CFG);
  assert.equal(d.type, 'EXIT', 'must not return ADD or null forever');
});

// ─── cappedStopFill: the resting-stop assumption ───────────────────────

test('cappedStopFill: without a resting stop, a live poll fills at the OBSERVED price', () => {
  // No exchange stop + no candle context = we only learn the price on the next
  // poll. Booking the stop level here would flatter the result by 5 points.
  const r = cappedStopFill('BUY', 99, 94, undefined, false);
  assert.equal(r.price, 94, 'the honest fill is what we actually saw');
  assert.equal(r.gapped, true, 'and it is flagged');
});

test('cappedStopFill: without a resting stop, a benign poll still fills at the stop level', () => {
  // Observed price is better than the stop → no adverse surprise to report.
  const r = cappedStopFill('BUY', 99, 99, undefined, false);
  assert.equal(r.price, 99);
  assert.equal(r.gapped, false);
});

test('cappedStopFill: short without a resting stop fills at the observed price', () => {
  assert.deepEqual(cappedStopFill('SELL', 101, 106, undefined, false), { price: 106, gapped: true });
});

// ─── report ────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n✗ trailingStop: ${failures.length} failed, ${passed} passed\n`);
  console.error(failures.join('\n\n'));
  process.exit(1);
}
console.log(`✓ trailingStop: ${passed} passed`);
