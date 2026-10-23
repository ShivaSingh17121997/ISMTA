/**
 * Broker-layer tests: TOTP, Groww payload mapping, and funds reservations.
 *
 * These cover the parts that can be verified WITHOUT credentials, which is
 * deliberate — the Groww adapter has never spoken to the live API, so the
 * mapping and the arithmetic are exactly where a silent mistake would hide.
 *
 * The assertions that matter most are the ones protecting money:
 *   - an unfilled order must never be reported as filled;
 *   - a fill price must never be invented;
 *   - reserved cash must not be spendable twice.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { base32Decode, secondsRemaining, totp } from '../utils/totp';
import { mapFunds, mapOrder } from '../brokers/GrowwBroker';
import { ZerodhaBroker } from '../brokers/ZerodhaBroker';
import { findKiteOrderByTag, isDefinitiveKiteRejection, kiteOrderTag } from '../brokers/kiteMapping';
import { sweepActionFor } from '../services/orderSweep';

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  try {
    const r = fn();
    if (r instanceof Promise) throw new Error('use testAsync for async cases');
    passed++;
  } catch (e) {
    failures.push(`  ✗ ${name}\n    ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
}
const pending: Promise<void>[] = [];
function testAsync(name: string, fn: () => Promise<void>): void {
  pending.push(
    fn().then(
      () => { passed++; },
      (e) => { failures.push(`  ✗ ${name}\n    ${e instanceof Error ? e.message.split('\n')[0] : e}`); },
    ),
  );
}

// ─── TOTP ──────────────────────────────────────────────────────────────────
// RFC 4648 / RFC 6238 published vectors. The secret "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
// is base32 for "12345678901234567890", the RFC 6238 SHA-1 test key.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('base32 decodes to the bytes the RFC specifies', () => {
  assert.equal(base32Decode(RFC_SECRET).toString('utf8'), '12345678901234567890');
});

test('base32 tolerates the spacing and padding authenticator apps add', () => {
  const spaced = 'gezd gnbv gy3t qojq gezd gnbv gy3t qojq';
  assert.deepEqual(base32Decode(spaced), base32Decode(RFC_SECRET));
  assert.deepEqual(base32Decode(`${RFC_SECRET}======`), base32Decode(RFC_SECRET));
});

test('a non-base32 secret is rejected rather than silently mangled', () => {
  // A typo'd secret must fail loudly at startup, not produce wrong codes that
  // look like a credentials problem at the broker.
  assert.throws(() => base32Decode('NOT-VALID-18!'), /non-base32/);
  assert.throws(() => base32Decode('   '), /empty/);
});

test('TOTP matches the RFC 6238 published vectors', () => {
  // Values from RFC 6238 Appendix B, SHA-1, 8 digits truncated to 6.
  assert.equal(totp(RFC_SECRET, 59_000, { digits: 8 }), '94287082');
  assert.equal(totp(RFC_SECRET, 1_111_111_109_000, { digits: 8 }), '07081804');
  assert.equal(totp(RFC_SECRET, 1_234_567_890_000, { digits: 8 }), '89005924');
  // Past 2^31 seconds — this is where a 32-bit counter silently breaks.
  assert.equal(totp(RFC_SECRET, 2_000_000_000_000, { digits: 8 }), '69279037');
});

test('the code is stable within a window and changes across one', () => {
  const a = totp(RFC_SECRET, 60_000);
  const b = totp(RFC_SECRET, 89_000);
  const c = totp(RFC_SECRET, 90_000);
  assert.equal(a, b, 'same 30s window must give the same code');
  assert.notEqual(a, c, 'the next window must give a different code');
  assert.match(a, /^\d{6}$/);
});

test('time remaining in the window is reported so a code is never used stale', () => {
  assert.equal(secondsRemaining(0), 30);
  assert.equal(secondsRemaining(29_000), 1);
  assert.equal(secondsRemaining(30_000), 30);
});

// ─── Groww order mapping ───────────────────────────────────────────────────

test('an acknowledged-but-unfilled order is PENDING, never FILLED', () => {
  // The whole point. Reporting this as filled is what corrupts breakeven.
  const r = mapOrder({ payload: { groww_order_id: 'GX1', order_status: 'NEW', filled_quantity: 0 } }, '');
  assert.equal(r.status, 'PENDING');
  assert.equal(r.filledPrice, undefined, 'no price may be invented for an unfilled order');
  assert.equal(r.brokerOrderId, 'GX1');
});

test('a filled order reports the BROKER average price, not a guess', () => {
  const r = mapOrder(
    { payload: { groww_order_id: 'GX2', order_status: 'EXECUTED', filled_quantity: 8, average_fill_price: 1632.45 } },
    '',
  );
  assert.equal(r.status, 'FILLED');
  assert.equal(r.filledPrice, 1632.45);
  assert.equal(r.filledQuantity, 8);
});

test('a partial fill reports the quantity that actually traded', () => {
  const r = mapOrder(
    { payload: { groww_order_id: 'GX3', order_status: 'EXECUTED', filled_quantity: 3, average_fill_price: 100 } },
    '',
  );
  assert.equal(r.status, 'FILLED');
  assert.equal(r.filledQuantity, 3, 'must be what traded, not what was asked for');
});

test('rejections and cancellations carry their reason', () => {
  const r = mapOrder({ payload: { order_status: 'REJECTED', remark: 'Insufficient funds' } }, 'GX4');
  assert.equal(r.status, 'REJECTED');
  assert.match(r.rejectionReason ?? '', /Insufficient funds/);
  const c = mapOrder({ payload: { order_status: 'CANCELLED' } }, 'GX5');
  assert.equal(c.status, 'REJECTED');
});

test('an order that closed with nothing filled is not a fill', () => {
  const r = mapOrder({ payload: { order_status: 'COMPLETE', filled_quantity: 0 } }, 'GX6');
  assert.equal(r.status, 'REJECTED');
  assert.match(r.rejectionReason ?? '', /nothing filled/);
});

test('mapping survives camelCase, flat payloads and string numbers', () => {
  // The adapter is unverified against the live API, so it must not depend on
  // one exact spelling of a field it has never actually seen.
  const camel = mapOrder({ data: { growwOrderId: 'GX7', orderStatus: 'EXECUTED', filledQuantity: '5', averagePrice: '99.5' } }, '');
  assert.equal(camel.status, 'FILLED');
  assert.equal(camel.filledQuantity, 5);
  assert.equal(camel.filledPrice, 99.5);
  const flat = mapOrder({ order_status: 'EXECUTED', filled_quantity: 2, average_price: 10 }, 'GX8');
  assert.equal(flat.status, 'FILLED');
  assert.equal(flat.brokerOrderId, 'GX8', 'falls back to the id we already know');
});

// ─── Groww funds mapping ───────────────────────────────────────────────────

test('funds are read from the documented field names', () => {
  const f = mapFunds({ payload: { clear_cash: 152_340.5, net_margin_used: 20_000, unsettled_credits: 5_000 } }, 111);
  assert.equal(f.cash, 152_340.5);
  assert.equal(f.usedMargin, 20_000);
  assert.equal(f.unsettled, 5_000);
  assert.equal(f.at, 111, 'the read time must be carried so staleness is visible');
});

test('funds fall back to the equity segment when no top-level cash is given', () => {
  const f = mapFunds({ payload: { equity_margin_details: { cnc_balance_available: 75_000 } } }, 1);
  assert.equal(f.cash, 75_000);
});

test('an unrecognised funds payload reads as zero rather than as a guess', () => {
  // Zero is visible and safe — it stops new buys. A fabricated balance would
  // place orders the account cannot pay for.
  const f = mapFunds({ payload: { something_else: 5 } }, 1);
  assert.equal(f.cash, 0);
  assert.ok(f.raw, 'the raw payload is kept so the field names can be fixed');
});

// ─── funds reservations ────────────────────────────────────────────────────
// FundsService talks to the live broker singleton, so the arithmetic is
// exercised through a local stand-in with the same shape.

class FakeFunds {
  private held = new Map<string, number>();
  constructor(private cash: number, private bufferPct = 0.5) {}
  reserved(): number {
    let s = 0;
    for (const v of this.held.values()) s += v;
    return s;
  }
  deployable(): number {
    return Math.max(0, (this.cash - this.reserved()) * (1 - this.bufferPct / 100));
  }
  reserve(id: string, amount: number): boolean {
    if (amount > this.deployable()) return false;
    this.held.set(id, amount);
    return true;
  }
  release(id: string): void {
    this.held.delete(id);
  }
}

test('the same rupees cannot be committed twice', () => {
  const f = new FakeFunds(100_000);
  assert.equal(f.reserve('a', 60_000), true);
  // 40,000 remains, less the charge buffer — a second 60,000 must be refused.
  assert.equal(f.reserve('b', 60_000), false, 'this is the double-spend the reservation prevents');
  assert.equal(f.reserve('c', 39_000), true);
});

test('releasing a reservation returns the money to the pool', () => {
  const f = new FakeFunds(100_000);
  f.reserve('a', 90_000);
  assert.equal(f.reserve('b', 50_000), false);
  f.release('a');
  assert.equal(f.reserve('b', 50_000), true, 'a resolved order must free its cash');
});

test('a charge buffer is withheld so an order can pay its own costs', () => {
  const f = new FakeFunds(100_000);
  assert.ok(f.deployable() < 100_000, 'brokerage, STT and stamp duty come out of the same cash');
  assert.ok(f.deployable() > 99_000, 'but the buffer must stay small enough to be usable');
});

// ─── lost replies, tags and ticks (real-money path) ────────────────────────
test('Kite refusals are told apart from "no answer"', () => {
  assert.equal(isDefinitiveKiteRejection({ error_type: 'InputException', message: 'bad price' }), true);
  assert.equal(isDefinitiveKiteRejection({ error_type: 'MarginException' }), true);
  assert.equal(isDefinitiveKiteRejection({ error_type: 'NetworkException' }), false);
  assert.equal(isDefinitiveKiteRejection(new Error('socket hang up')), false);
});

test('order tags are Kite-legal, deterministic and distinct', () => {
  const a = kiteOrderTag('acc:SYRMA:SELL:1726990000000:SYRMA-e0-l0-0');
  assert.match(a, /^[a-z0-9]{1,20}$/);
  assert.equal(a, kiteOrderTag('acc:SYRMA:SELL:1726990000000:SYRMA-e0-l0-0'));
  assert.notEqual(a, kiteOrderTag('acc:SYRMA:SELL:1726990060000:SYRMA-e0-l0-0'));
  assert.equal(findKiteOrderByTag([{ order_id: '1', tag: 'x' }, { order_id: '2', tag: a }], a), '2');
  assert.equal(findKiteOrderByTag([{ order_id: '1', tags: [a] }], a), '1');
  assert.equal(findKiteOrderByTag([{ order_id: '1', tag: 'x' }], a), null);
});

/** A fake Kite client: placeOrder behaviour and the order book are scripted per test. */
function fakeKite(opts: { place: () => Promise<unknown>; book?: unknown[]; history?: unknown[] }) {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    client: {
      placeOrder: async (_v: string, params: Record<string, unknown>) => {
        sent.push(params);
        return opts.place();
      },
      getOrders: async () => (opts.book ?? []).map((r) => ({ ...(r as object), tag: sent[0]?.tag })),
      getOrderHistory: async () => opts.history ?? [],
      cancelOrder: async () => ({}),
    },
  };
}
const REQ = { symbol: 'SYRMA', side: 'SELL' as const, quantity: 10, orderType: 'LIMIT' as const, product: 'CNC' as const, price: 1734.4449, clientOrderId: 'acc:t1' };

testAsync('a lost placeOrder reply is matched back by tag, not called a rejection', async () => {
  const k = fakeKite({
    place: async () => { throw new Error('ETIMEDOUT'); },
    book: [{ order_id: '991' }],
    history: [{ status: 'COMPLETE', filled_quantity: 10, average_price: 1734.45, transaction_type: 'SELL' }],
  });
  const r = await new ZerodhaBroker({ client: () => k.client }).placeOrder(REQ);
  assert.equal(r.status, 'FILLED');
  assert.equal(r.brokerOrderId, '991');
  assert.equal(r.filledQuantity, 10);
});

testAsync('a lost reply that cannot be confirmed is PENDING (halt), never REJECTED (retry)', async () => {
  const k = fakeKite({ place: async () => { throw new Error('socket hang up'); }, book: [] });
  const r = await new ZerodhaBroker({ client: () => k.client }).placeOrder(REQ);
  assert.equal(r.status, 'PENDING');
  assert.match(r.rejectionReason ?? '', /order state unknown/);
});

testAsync('a definite Kite refusal is still a plain rejection', async () => {
  const k = fakeKite({ place: async () => { throw { error_type: 'InputException', message: 'Invalid price' }; } });
  const r = await new ZerodhaBroker({ client: () => k.client }).placeOrder(REQ);
  assert.equal(r.status, 'REJECTED');
});

testAsync('limit prices go out on the NSE tick, sells rounded UP, with a tag', async () => {
  const k = fakeKite({
    place: async () => ({ order_id: '5' }),
    history: [{ status: 'COMPLETE', filled_quantity: 10, average_price: 1734.45, transaction_type: 'SELL' }],
  });
  await new ZerodhaBroker({ client: () => k.client }).placeOrder(REQ);
  const p = Number(k.sent[0].price);
  assert.ok(p >= REQ.price, `sell ${p} must not be below the asked ${REQ.price}`);
  assert.ok(Math.abs(Math.round(p / 0.05) * 0.05 - p) < 1e-9 || Math.abs(Math.round(p * 100) / 100 - p) < 1e-9, `off-tick ${p}`);
  assert.match(String(k.sent[0].tag), /^smt[a-z0-9]+$/);
});

test('the startup sweep closes dead paper orders and never guesses about live ones', () => {
  const now = Date.parse('2026-09-22T06:00:00Z');
  const old = { status: 'PENDING' as const, createdAt: now - 3_600_000, brokerOrderId: 'K1' };
  assert.equal(sweepActionFor(old, 'paper', true, now), 'close');
  assert.equal(sweepActionFor(old, 'live', true, now), 'resolve');
  assert.equal(sweepActionFor(old, 'live', false, now), 'alert');
  assert.equal(sweepActionFor({ ...old, brokerOrderId: undefined }, 'live', true, now), 'alert');
  assert.equal(sweepActionFor({ ...old, createdAt: now - 60_000 }, 'paper', true, now), 'keep', 'a young order may still be in flight');
  assert.equal(sweepActionFor({ ...old, status: 'FILLED' as const }, 'paper', true, now), 'keep');
});

// ─── report ────────────────────────────────────────────────────────────────
void Promise.all(pending).then(() => {
  if (failures.length) {
    console.error(`✗ broker: ${failures.length} failed, ${passed} passed`);
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log(`✓ broker: ${passed} passed`);
});
