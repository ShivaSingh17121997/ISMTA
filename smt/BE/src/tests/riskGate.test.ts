/**
 * Risk gate tests — spec Phase 6.
 *
 * The first block is a REGRESSION TEST for the bug that made this port unsafe:
 * the risk manager used to gate exits as well as entries, so once the daily-loss
 * limit tripped it rejected the engine's own stop-loss and the position rode to
 * zero. If those tests ever fail, the trailing stop is decorative.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { riskManager } from '../services/RiskManager';
import { store } from '../store/memoryStore';
import { OrderRequest, Position, Trade } from '../types';
import { config } from '../config';

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

let seq = 0;
/** Fresh user per test — the gate holds per-user streak/cooldown state. */
const newUser = () => `u${++seq}`;

function req(userId: string, over: Partial<OrderRequest> = {}): OrderRequest {
  return {
    symbol: 'RELIANCE',
    side: 'BUY',
    quantity: 10,
    orderType: 'MARKET',
    product: 'MIS',
    userId,
    ...over,
  };
}

function fillPositions(userId: string, n: number): void {
  for (let i = 0; i < n; i++) {
    const pos: Position = {
      symbol: `SYM${i}`,
      quantity: 10,
      avgPrice: 100,
      ltp: 100,
      unrealisedPnl: 0,
      realisedPnl: 0,
    };
    store.positions.set(store.positionKey(userId, `SYM${i}`), pos);
  }
}

function closedTrade(userId: string, pnl: number, closedAt = Date.now()): Trade {
  return {
    id: `t${++seq}`,
    userId,
    symbol: 'RELIANCE',
    side: 'BUY',
    quantity: 10,
    entryPrice: 100,
    exitPrice: 100,
    status: 'CLOSED',
    pnl,
    entryOrderId: 'o1',
    openedAt: closedAt - 1000,
    closedAt,
  };
}

// ─── C1 REGRESSION: exits are never gated ──────────────────────────────

test('C1: a stop-loss EXIT is approved even with the daily loss limit breached', () => {
  const u = newUser();
  store.addDailyPnl(u, -(config.risk.dailyLossLimit + 1000));

  const entry = riskManager.check(req(u), 100, false);
  assert.equal(entry.approved, false, 'the entry must be blocked');

  const exit = riskManager.check(req(u, { side: 'SELL' }), 100, true);
  assert.equal(exit.approved, true, 'THE EXIT MUST GET THROUGH — otherwise the loss is unbounded');
  assert.equal(exit.allowedQuantity, 10, 'and at full size, not trimmed');
});

test('C1: an EXIT is approved at max concurrent positions', () => {
  const u = newUser();
  fillPositions(u, config.risk.maxPositions);

  assert.equal(riskManager.check(req(u), 100, false).approved, false, 'entry blocked at the cap');
  assert.equal(
    riskManager.check(req(u, { side: 'SELL' }), 100, true).approved,
    true,
    'an exit must never be blocked by the position cap, or the account freezes',
  );
});

test('C1: an EXIT is not trimmed by the position value cap', () => {
  const u = newUser();
  // A 100-share exit at ₹9,000 = ₹900k, far past the ₹100k cap. Trimming it
  // would leave a residual position after a stop-loss.
  const d = riskManager.check(req(u, { side: 'SELL', quantity: 100 }), 9000, true);
  assert.equal(d.approved, true);
  assert.equal(d.allowedQuantity, 100, 'the full position must be exitable');
});

test('C1: an EXIT is approved with the kill switch engaged', () => {
  const u = newUser();
  riskManager.setKilled(u, true);
  assert.equal(riskManager.check(req(u), 100, false).approved, false);
  assert.equal(riskManager.check(req(u, { side: 'SELL' }), 100, true).approved, true);
  riskManager.setKilled(u, false);
});

test('C1: adding to an EXISTING position is not blocked by the max-positions cap', () => {
  // A DCA safety order does not increase the position COUNT. Gating it here made
  // DCA undeployable at the cap — and dead on arrival with maxPositions=1.
  const u = newUser();
  fillPositions(u, config.risk.maxPositions);
  const add = riskManager.check(req(u, { symbol: 'SYM0', side: 'BUY' }), 100, false);
  assert.equal(add.approved, true, 'averaging into a position you already hold must pass');

  const fresh = riskManager.check(req(u, { symbol: 'BRANDNEW' }), 100, false);
  assert.equal(fresh.approved, false, 'but a genuinely new position is still capped');
});

// ─── C2: structural validation applies to everything ───────────────────

test('C2: a negative quantity is rejected (it used to bypass the value cap)', () => {
  const u = newUser();
  // -5 * 2950 = -14750, which is NOT "> maxPositionValue", so the cap waved it
  // through — and a BUY with a negative quantity opens a SHORT.
  const d = riskManager.check(req(u, { quantity: -5 }), 2950, false);
  assert.equal(d.approved, false);
  assert.match(d.reason, /positive integer/);
});

test('C2: a zero quantity is rejected', () => {
  assert.equal(riskManager.check(req(newUser(), { quantity: 0 }), 100, false).approved, false);
});

test('C2: a fractional quantity is rejected (NSE trades whole shares)', () => {
  assert.equal(riskManager.check(req(newUser(), { quantity: 1.5 }), 100, false).approved, false);
});

test('C2: validation applies to exits too — a 0-qty exit cannot create a phantom trade', () => {
  const d = riskManager.check(req(newUser(), { side: 'SELL', quantity: 0 }), 100, true);
  assert.equal(d.approved, false, 'the isReducing bypass must not skip structural checks');
});

// ─── Phase 6 gates ─────────────────────────────────────────────────────

test('gate: daily loss limit blocks entries', () => {
  const u = newUser();
  assert.equal(riskManager.check(req(u), 100, false).approved, true, 'clean slate opens fine');
  store.addDailyPnl(u, -config.risk.dailyLossLimit);
  assert.equal(riskManager.check(req(u), 100, false).approved, false);
});

test('gate: consecutive-loss circuit breaker halts entries', () => {
  const u = newUser();
  for (let i = 0; i < config.ntb.maxConsecutiveLosses; i++) {
    riskManager.recordTrade(closedTrade(u, -100));
  }
  const d = riskManager.check(req(u), 100, false);
  assert.equal(d.approved, false);
  assert.match(d.reason, /consecutive losses/);
});

test('gate: a WIN clears the loss streak', () => {
  const u = newUser();
  for (let i = 0; i < config.ntb.maxConsecutiveLosses; i++) {
    riskManager.recordTrade(closedTrade(u, -100));
  }
  assert.equal(riskManager.check(req(u), 100, false).approved, false);
  riskManager.recordTrade(closedTrade(u, +50));
  assert.equal(riskManager.check(req(u), 100, false).approved, true, 'a win must reopen entries');
});

test('gate: post-loss cooldown blocks entries, and a win clears it', () => {
  const u = newUser();
  process.env.LOSS_COOLDOWN_CANDLES = '5'; // config reads this live
  try {
    const t = closedTrade(u, -100);
    riskManager.recordTrade(t);
    const blocked = riskManager.check(req(u), 100, false, t.closedAt! + 1000);
    assert.equal(blocked.approved, false);
    assert.match(blocked.reason, /cooldown/);

    // Past the cooldown window it opens again.
    const later = riskManager.check(req(u), 100, false, t.closedAt! + config.ntb.lossCooldownMs + 1);
    assert.equal(later.approved, true);

    // And a win clears it immediately.
    const u2 = newUser();
    const l = closedTrade(u2, -100);
    riskManager.recordTrade(l);
    assert.equal(riskManager.check(req(u2), 100, false, l.closedAt! + 1000).approved, false);
    riskManager.recordTrade(closedTrade(u2, +50, l.closedAt! + 500));
    assert.equal(
      riskManager.check(req(u2), 100, false, l.closedAt! + 1000).approved,
      true,
      'the cooldown exists to stop tilt after a loss, not to punish a recovery',
    );
  } finally {
    delete process.env.LOSS_COOLDOWN_CANDLES;
  }
});

test('gate: kill switch blocks entries', () => {
  const u = newUser();
  riskManager.setKilled(u, true);
  const d = riskManager.check(req(u), 100, false);
  assert.equal(d.approved, false);
  assert.match(d.reason, /kill-switch/);
  riskManager.setKilled(u, false);
  assert.equal(riskManager.check(req(u), 100, false).approved, true);
});

test('gate: the value cap TRIMS an entry rather than rejecting it', () => {
  const u = newUser();
  const d = riskManager.check(req(u, { quantity: 1000 }), 2950, false);
  assert.equal(d.approved, true);
  assert.equal(d.allowedQuantity, Math.floor(config.risk.maxPositionValue / 2950));
});

// ─── Phase 6: UTC-day rolling from trade timestamps ────────────────────

const DAY = 86_400_000;

test('day roll: the daily P&L bucket is day-keyed, so it self-expires', () => {
  const u = newUser();
  const mon = 1_700_000_000_000;
  store.addDailyPnl(u, -6000, mon);
  assert.equal(store.getDailyPnl(u, mon), -6000);
  assert.equal(store.getDailyPnl(u, mon + DAY), 0, "yesterday's loss must not block today");
});

test('day roll: a breached limit no longer blocks entries the next day', () => {
  const u = newUser();
  const mon = 1_700_000_000_000;
  store.addDailyPnl(u, -(config.risk.dailyLossLimit + 1), mon);
  assert.equal(riskManager.check(req(u), 100, false, mon).approved, false, 'blocked on the day');
  assert.equal(
    riskManager.check(req(u), 100, false, mon + DAY).approved,
    true,
    'the limit must reset at the UTC day boundary — it previously never reset at all',
  );
});

test('day roll: the loss streak resets across the day boundary', () => {
  const u = newUser();
  const mon = 1_700_000_000_000;
  for (let i = 0; i < config.ntb.maxConsecutiveLosses; i++) {
    riskManager.recordTrade(closedTrade(u, -100, mon));
  }
  assert.equal(riskManager.check(req(u), 100, false, mon).approved, false);
  assert.equal(riskManager.check(req(u), 100, false, mon + DAY).approved, true);
});

test('day roll: is driven by TRADE TIMESTAMPS, not the wall clock', () => {
  // This is what makes the gate behave identically in backtest, paper and live.
  const u = newUser();
  const historical = 1_600_000_000_000; // years in the past
  store.addDailyPnl(u, -(config.risk.dailyLossLimit + 1), historical);
  assert.equal(
    riskManager.check(req(u), 100, false, historical).approved,
    false,
    'a replayed historical loss must gate at its own timestamp',
  );
  assert.equal(riskManager.check(req(u), 100, false).approved, true, 'and not leak into now');
});

test('day roll: UTC boundary falls before the NSE open (05:30 IST), never splitting a session', () => {
  // 00:00 UTC == 05:30 IST, and NSE trades 09:15–15:30 IST. So a whole session
  // always lands inside one UTC day — which is why the spec's UTC rolling is
  // safe here and no IST-specific handling is needed.
  const open = Date.UTC(2024, 5, 3, 3, 45); // 09:15 IST
  const close = Date.UTC(2024, 5, 3, 10, 0); // 15:30 IST
  assert.equal(store.utcDay(open), store.utcDay(close), 'one session, one UTC day');
});

// ── limits must follow the account ──────────────────────────────────────────
//
// The defaults used to be absolute rupees (₹1,00,000 a position, ₹5,000 a day)
// chosen for the ₹10,00,000 default capital. Nothing tied them to
// RISK_CAPITAL, so setting a smaller account kept limits sized for the larger
// one: at ₹2,00,000 the same numbers allowed HALF the account in one position
// and 250% of capital across five. They are now fractions of capital.
//
// Skipped when the env var is set, because an explicit figure is a deliberate
// choice and must still win.

test('maxPositionValue is 10% of capital when not set explicitly', () => {
  if (process.env.RISK_MAX_POSITION_VALUE) return;
  const ratio = config.risk.maxPositionValue / config.risk.capital;
  assert.ok(
    Math.abs(ratio - 0.1) < 1e-9,
    `maxPositionValue is ${(ratio * 100).toFixed(1)}% of capital, expected 10% — ` +
      'an absolute default has crept back in',
  );
});

test('dailyLossLimit is 0.5% of capital when not set explicitly', () => {
  if (process.env.RISK_DAILY_LOSS_LIMIT) return;
  const ratio = config.risk.dailyLossLimit / config.risk.capital;
  assert.ok(
    Math.abs(ratio - 0.005) < 1e-9,
    `dailyLossLimit is ${(ratio * 100).toFixed(2)}% of capital, expected 0.5%`,
  );
});

test('the default limits cannot commit more than the account', () => {
  // The number that made this worth fixing: 5 x ₹1,00,000 against ₹2,00,000
  // was 250% of capital. On defaults it must never exceed 100%.
  if (process.env.RISK_MAX_POSITION_VALUE || process.env.RISK_MAX_POSITIONS) return;
  const notional = config.risk.maxPositions * config.risk.maxPositionValue;
  assert.ok(
    notional <= config.risk.capital,
    `default limits allow ₹${Math.round(notional)} of notional against ` +
      `₹${config.risk.capital} of capital`,
  );
});

if (failures.length) {
  console.error(`\n✗ riskGate: ${failures.length} failed, ${passed} passed\n`);
  console.error(failures.join('\n\n'));
  process.exit(1);
}
console.log(`✓ riskGate: ${passed} passed`);
