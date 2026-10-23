/**
 * Per-user broker connection: credential sealing, Kite response mapping, and
 * the rules that decide when live trading may be switched on.
 *
 * All pure — nothing here needs a Zerodha account, a network or a database.
 * The assertions that matter most protect money:
 *   - a sealed secret cannot be opened under another user's context;
 *   - a cancelled order's partial fill is booked, not discarded;
 *   - pledged collateral is never counted as cash for a delivery buy;
 *   - a same-day buy is not reported missing by reconciliation;
 *   - a paper book with simulated lots can never be switched to live.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';
import { keyFingerprint, open, parseCredentialsKey, seal } from '../utils/secretBox';
import {
  describeKiteRejection,
  isAppSetupRejection,
  isKitePermissionError,
  isKiteTokenError,
  kiteHeldQuantities,
  kiteLoginUrl,
  kiteTokenExpiry,
  mapKiteFunds,
  mapKiteOrder,
} from '../brokers/kiteMapping';
import {
  classifyHolding,
  effectiveStatus,
  liveSwitchBlockers,
  maskApiKey,
  paperSwitchBlockers,
  validateKiteCredentials,
} from '../services/brokerRules';
import type { BrokerConnection } from '../types';

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

const IST = 5.5 * 3_600_000;
/** Epoch ms of an IST wall-clock time. */
const ist = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - IST;

// ─── secret box ────────────────────────────────────────────────────────────
const KEY = randomBytes(32);

test('a sealed secret opens with the same key and context', () => {
  const sealed = seal(KEY, 'kite-secret-123', 'u1:apiSecret');
  assert.notEqual(sealed.includes('kite-secret-123'), true, 'plaintext must not appear in the sealed value');
  assert.equal(open(KEY, sealed, 'u1:apiSecret'), 'kite-secret-123');
});

test("one user's sealed secret does not open under another user's context", () => {
  const sealed = seal(KEY, 'kite-secret-123', 'u1:apiSecret');
  assert.throws(() => open(KEY, sealed, 'u2:apiSecret'));
  assert.throws(() => open(KEY, sealed, 'u1:accessToken'), 'a secret must not open as a token either');
});

test('a modified byte or a different key fails to open', () => {
  const sealed = seal(KEY, 'abc', 'ctx');
  const parts = sealed.split(':');
  const body = Buffer.from(parts[3], 'base64');
  body[0] ^= 0xff;
  parts[3] = body.toString('base64');
  assert.throws(() => open(KEY, parts.join(':'), 'ctx'), 'tampering must be detected');
  assert.throws(() => open(randomBytes(32), sealed, 'ctx'), 'a rotated key must not open old values');
});

test('the same plaintext seals differently every time (random IV)', () => {
  assert.notEqual(seal(KEY, 'same', 'ctx'), seal(KEY, 'same', 'ctx'));
});

test('credential keys: 64 hex or 32-byte base64, nothing weaker', () => {
  assert.equal(parseCredentialsKey('a'.repeat(64))?.length, 32);
  assert.equal(parseCredentialsKey(KEY.toString('base64'))?.length, 32);
  assert.equal(parseCredentialsKey('short'), null);
  assert.equal(parseCredentialsKey('a'.repeat(63)), null);
  assert.equal(keyFingerprint(KEY), keyFingerprint(Buffer.from(KEY)), 'fingerprint is stable');
  assert.notEqual(keyFingerprint(KEY), keyFingerprint(randomBytes(32)));
});

// ─── login + expiry ────────────────────────────────────────────────────────
test('the login URL carries the api key and the state inside redirect_params', () => {
  const url = new URL(kiteLoginUrl('abc123key', 'st4te'));
  assert.equal(url.origin + url.pathname, 'https://kite.zerodha.com/connect/login');
  assert.equal(url.searchParams.get('v'), '3');
  assert.equal(url.searchParams.get('api_key'), 'abc123key');
  assert.equal(url.searchParams.get('redirect_params'), 'state=st4te', 'Kite hands this back on the redirect');
});

test('a session expires at the next 06:00 IST', () => {
  assert.equal(kiteTokenExpiry(ist(2026, 9, 14, 10)), ist(2026, 9, 15, 6), 'a morning login lasts until tomorrow 06:00');
  assert.equal(kiteTokenExpiry(ist(2026, 9, 14, 5, 30)), ist(2026, 9, 14, 6), 'a 05:30 login dies at 06:00 the same day');
  assert.equal(kiteTokenExpiry(ist(2026, 9, 14, 6)), ist(2026, 9, 15, 6), 'exactly 06:00 rolls to the next day');
  assert.equal(kiteTokenExpiry(ist(2026, 9, 14, 23, 59)), ist(2026, 9, 15, 6));
});

// ─── orders ────────────────────────────────────────────────────────────────
test('a working order is PENDING and carries no price', () => {
  const r = mapKiteOrder([{ status: 'OPEN', filled_quantity: 0 }], 'K1');
  assert.equal(r.status, 'PENDING');
  assert.equal(r.filledPrice, undefined);
});

test("a completed order reports Kite's average price and quantity", () => {
  const r = mapKiteOrder(
    [{ status: 'OPEN' }, { status: 'COMPLETE', filled_quantity: 7, average_price: 1432.55, transaction_type: 'BUY' }],
    'K2',
  );
  assert.deepEqual([r.status, r.filledQuantity, r.filledPrice], ['FILLED', 7, 1432.55], 'the LAST history row decides');
});

test("a CANCELLED order's partial fill is booked as a fill — those shares are real", () => {
  const r = mapKiteOrder([{ status: 'CANCELLED', filled_quantity: 3, average_price: 100.5 }], 'K3');
  assert.equal(r.status, 'FILLED');
  assert.equal(r.filledQuantity, 3);
  assert.equal(r.filledPrice, 100.5);
});

test('shares filled with no average price are unresolved, never priced by guess', () => {
  const r = mapKiteOrder([{ status: 'COMPLETE', filled_quantity: 5, average_price: 0 }], 'K4');
  assert.equal(r.status, 'PENDING');
  assert.equal(r.filledPrice, undefined);
});

test('cancelled or completed with nothing filled is not a fill', () => {
  assert.equal(mapKiteOrder([{ status: 'CANCELLED', filled_quantity: 0 }], 'K5').status, 'REJECTED');
  assert.equal(mapKiteOrder([{ status: 'COMPLETE', filled_quantity: 0 }], 'K6').status, 'REJECTED');
  assert.throws(() => mapKiteOrder([], 'K7'), /no history/);
});

test('a depository refusal on a SELL says what to do about it', () => {
  const r = mapKiteOrder(
    [{ status: 'REJECTED', transaction_type: 'SELL', status_message: 'Shares need to be authorised at CDSL to sell' }],
    'K8',
  );
  assert.equal(r.status, 'REJECTED');
  assert.match(r.rejectionReason ?? '', /DDPI/);
  assert.match(r.rejectionReason ?? '', /TPIN/);
  assert.equal(describeKiteRejection('Insufficient funds', 'BUY'), 'Insufficient funds', 'ordinary reasons pass through');
});

test('permission and session errors are told apart', () => {
  assert.equal(isKitePermissionError({ error_type: 'PermissionException', message: 'Insufficient permission' }), true);
  assert.equal(isKiteTokenError({ error_type: 'TokenException', message: 'Token is invalid or has expired.' }), true);
  assert.equal(isKiteTokenError({ error_type: 'PermissionException', message: 'x' }), false);
});

// ─── funds ─────────────────────────────────────────────────────────────────
test('cash for a delivery buy is live_balance, not net (net includes pledged collateral)', () => {
  const f = mapKiteFunds(
    { net: 250_000, available: { live_balance: 90_000, cash: 100_000, collateral: 160_000, intraday_payin: 5_000 }, utilised: { debits: 10_000 } },
    42,
  );
  assert.equal(f.cash, 90_000);
  assert.equal(f.usedMargin, 10_000);
  assert.equal(f.unsettled, 0, 'money deposited today is not unsettled sale proceeds');
  assert.equal(f.at, 42);
});

test('without live_balance, cash is raw cash less debits', () => {
  assert.equal(mapKiteFunds({ net: 999, available: { cash: 50_000 }, utilised: { debits: 12_000 } }, 1).cash, 38_000);
  assert.equal(mapKiteFunds({}, 1).cash, 0, 'an unreadable payload is zero, never a guess');
});

// ─── holdings ──────────────────────────────────────────────────────────────
test("today's delivery buy counts even though Kite lists it only under positions", () => {
  const held = kiteHeldQuantities([], { net: [{ tradingsymbol: 'INFY', product: 'CNC', quantity: 4, average_price: 1500 }], day: [] });
  assert.equal(held.find((h) => h.symbol === 'INFY')?.quantity, 4);
});

test('settled + T1 + today, per symbol; intraday rows are not holdings', () => {
  const held = kiteHeldQuantities(
    [{ tradingsymbol: 'tcs', quantity: 10, t1_quantity: 2, average_price: 3000 }],
    { net: [
      { tradingsymbol: 'TCS', product: 'CNC', quantity: 1 },
      { tradingsymbol: 'TCS', product: 'MIS', quantity: 50 },
    ] },
  );
  const tcs = held.find((h) => h.symbol === 'TCS')!;
  assert.equal(tcs.quantity, 13);
  assert.deepEqual([tcs.holdings, tcs.t1, tcs.todayCnc], [10, 2, 1], 'the breakdown is kept for checking');
});

test('a holding sold today nets out once, not twice', () => {
  const held = kiteHeldQuantities(
    [{ tradingsymbol: 'SBIN', quantity: 5, used_quantity: 5 }],
    { net: [{ tradingsymbol: 'SBIN', product: 'CNC', quantity: -5 }] },
  );
  assert.equal(held[0].quantity, 0);
});

// ─── rules ─────────────────────────────────────────────────────────────────
test('credentials are validated and the key is masked', () => {
  assert.equal(validateKiteCredentials('abcd1234efgh', 'secret0987654321').ok, true);
  assert.equal(validateKiteCredentials(' abcd1234efgh ', 'secret0987654321').ok, true, 'copied whitespace is trimmed');
  assert.equal(validateKiteCredentials('', 'x').ok, false);
  assert.equal(validateKiteCredentials('same12345', 'same12345').ok, false);
  assert.equal(validateKiteCredentials('bad key!', 'secret0987654321').ok, false);
  assert.equal(maskApiKey('abcd1234efgh'), '••••••••efgh');
});

const conn = (over: Partial<BrokerConnection> = {}): BrokerConnection => ({
  id: 'u1:zerodha', userId: 'u1', broker: 'zerodha', apiKey: 'abcd1234efgh', apiSecretSealed: 'v1:x:y:z',
  keyId: 'k', plan: 'personal', tradingMode: 'paper', status: 'connected',
  connectedAt: ist(2026, 9, 14, 9), expiresAt: ist(2026, 9, 15, 6), createdAt: 0, updatedAt: 0, ...over,
});

test('a session past 06:00 reads as expired whatever was stored', () => {
  assert.equal(effectiveStatus(conn(), ist(2026, 9, 14, 12)), 'connected');
  assert.equal(effectiveStatus(conn(), ist(2026, 9, 15, 6, 1)), 'expired');
  assert.equal(effectiveStatus(undefined, 0), 'not_connected');
});

const ready = {
  conn: conn(), now: ist(2026, 9, 14, 12), credentialsKeyOk: true, jwtSecretIsDefault: false,
  envBroker: 'paper', openLotBooks: [] as string[], openTrades: 0, simulatedData: false, staticIpSet: true,
};

test('live is allowed only when connected, on a real JWT secret, with nothing simulated open', () => {
  assert.deepEqual(liveSwitchBlockers(ready), []);
  assert.match(liveSwitchBlockers({ ...ready, conn: undefined })[0], /Save your Kite API key/);
  assert.match(liveSwitchBlockers({ ...ready, now: ist(2026, 9, 15, 7) }).join(' '), /Connect Zerodha/);
  assert.match(liveSwitchBlockers({ ...ready, jwtSecretIsDefault: true }).join(' '), /JWT_SECRET/);
  assert.match(liveSwitchBlockers({ ...ready, envBroker: 'zerodha' }).join(' '), /BROKER=zerodha/);
  assert.match(liveSwitchBlockers({ ...ready, credentialsKeyOk: false }).join(' '), /BROKER_CREDENTIALS_KEY/);
  assert.match(liveSwitchBlockers({ ...ready, simulatedData: true }).join(' '), /SIMULATED/);
  assert.match(liveSwitchBlockers({ ...ready, staticIpSet: false }).join(' '), /BROKER_STATIC_IP/);
});

test('a paper book holding simulated lots blocks live — the engine would sell shares Kite does not hold', () => {
  const b = liveSwitchBlockers({ ...ready, openLotBooks: ['RELIANCE', 'TCS'] });
  assert.equal(b.length, 1);
  assert.match(b[0], /RELIANCE, TCS/);
  assert.match(liveSwitchBlockers({ ...ready, openTrades: 2 }).join(' '), /2 open paper trade/);
});

test('static-IP rejections are recognised; ordinary rejections are not', () => {
  assert.equal(isAppSetupRejection('No IPs configured for this app. Add allowed IPs on the Kite developer console.'), true);
  assert.equal(isAppSetupRejection('Request from an IP address not allowed for this app'), true);
  assert.equal(isAppSetupRejection('Insufficient funds. Required margin is 1610.00'), false);
  assert.equal(isAppSetupRejection('Shares need to be authorised at CDSL to sell'), false);
  assert.equal(isAppSetupRejection(undefined), false);
});

test('switching back to paper is refused only while live intraday trades are open', () => {
  assert.deepEqual(paperSwitchBlockers({ openTrades: 0 }), []);
  assert.match(paperSwitchBlockers({ openTrades: 1 })[0], /Flatten/);
});

test('reconciliation halts only on a shortfall, not on shares held outside the bot', () => {
  assert.equal(classifyHolding(10, 10), 'ok');
  assert.equal(classifyHolding(10, 7), 'shortfall');
  assert.equal(classifyHolding(10, 25), 'surplus');
  assert.equal(classifyHolding(0, 40), 'untracked');
});

// ─── report ────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`✗ brokerConnection: ${failures.length} failed, ${passed} passed`);
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`✓ brokerConnection: ${passed} passed`);
