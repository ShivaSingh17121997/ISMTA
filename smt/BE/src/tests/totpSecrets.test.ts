/**
 * Two-factor secrets at rest: sealed under the user's own context, legacy
 * plaintext still read and converted, and a lost key reported as a server
 * problem rather than as a wrong code.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';
import { config } from '../config';
import { totp } from '../utils/totp';
import {
  TotpUnreadableError,
  checkTotp,
  isSealed,
  revealTotp,
  sealPlaintextTotp,
  storeTotp,
  totpCodeMatches,
} from '../services/totpSecrets';
import type { User } from '../types';

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

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const KEY = randomBytes(32).toString('hex');
const creds = config.brokerCredentials as { key: string };
const savedKey = creds.key;
const user = (over: Partial<User> = {}): User =>
  ({ id: 'u1', email: 'a@b.in', name: 'A', role: 'trader', passwordHash: 'x', createdAt: 0, ...over }) as User;

try {
  creds.key = KEY;

  test('a new secret is stored sealed, and opens to the same secret', () => {
    const stored = storeTotp('u1', SECRET);
    assert.ok(isSealed(stored));
    assert.ok(!stored.includes(SECRET), 'no plaintext in the stored value');
    assert.equal(revealTotp('u1', stored), SECRET);
  });

  test('a sealed secret copied onto another account does not open', () => {
    assert.throws(() => revealTotp('u2', storeTotp('u1', SECRET)), TotpUnreadableError);
  });

  test('the current code matches a sealed secret; a wrong one does not', () => {
    const u = user({ totpSecret: storeTotp('u1', SECRET) });
    const now = Date.now();
    assert.ok(totpCodeMatches(u, 'totpSecret', totp(SECRET, now), now));
    assert.ok(totpCodeMatches(u, 'totpSecret', totp(SECRET, now - 30_000), now), 'one step of clock drift');
    const right = totp(SECRET, now);
    const wrong = right.slice(0, 5) + String((Number(right[5]) + 5) % 10);
    assert.ok(!totpCodeMatches(u, 'totpSecret', wrong, now) || [-30_000, 30_000].some((k) => totp(SECRET, now + k) === wrong));
    assert.ok(!totpCodeMatches(u, 'totpSecret', 'abc', now));
  });

  test('legacy plaintext still works, and boot conversion seals it without changing the codes', () => {
    const u = user({ totpSecret: SECRET, totpPending: 'KRSXG5CTMVRXEZLU' });
    const now = Date.now();
    assert.ok(totpCodeMatches(u, 'totpSecret', totp(SECRET, now), now));
    const changed = sealPlaintextTotp([u, user({ id: 'u3' })]);
    assert.equal(changed.length, 1, 'only the user with a secret');
    assert.ok(isSealed(u.totpSecret!) && isSealed(u.totpPending!));
    assert.ok(totpCodeMatches(u, 'totpSecret', totp(SECRET, now), now));
    assert.equal(sealPlaintextTotp([u]).length, 0, 'already sealed: nothing to do');
  });

  test('confirming moves the sealed pending value as-is (same context)', () => {
    const u = user({ totpPending: storeTotp('u1', SECRET) });
    u.totpSecret = u.totpPending;
    assert.equal(revealTotp('u1', u.totpSecret!), SECRET);
  });

  test('a changed key is reported as unreadable, never as a wrong code', () => {
    const u = user({ totpSecret: storeTotp('u1', SECRET) });
    creds.key = randomBytes(32).toString('hex');
    assert.equal(checkTotp(u, 'totpSecret', totp(SECRET)), 'unreadable');
    creds.key = KEY;
    assert.equal(checkTotp(u, 'totpSecret', totp(SECRET)), 'ok');
  });

  test('without a key: stored as before, and boot conversion waits for one', () => {
    creds.key = '';
    assert.equal(storeTotp('u1', SECRET), SECRET);
    const u = user({ totpSecret: SECRET });
    assert.equal(sealPlaintextTotp([u]).length, 0);
    assert.equal(checkTotp(u, 'totpSecret', totp(SECRET)), 'ok');
  });
} finally {
  creds.key = savedKey;
}

if (failures.length) {
  console.error(`✗ totpSecrets: ${failures.length} failed, ${passed} passed`);
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`✓ totpSecrets: ${passed} passed`);
