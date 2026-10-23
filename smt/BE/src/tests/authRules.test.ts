/**
 * Sign-up rules (services/authRules.ts).
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { cleanRegistration, normaliseEmail, registrationErrors } from '../services/authRules';

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

const none = () => false;

test('a good sign-up has no errors', () => {
  assert.deepEqual(registrationErrors({ email: 'asha@example.com', password: 'trade20261', name: 'Asha' }, none), []);
});

test('emails are trimmed and lower-cased, so one person cannot register twice', () => {
  assert.equal(normaliseEmail('  Asha@Example.COM '), 'asha@example.com');
  const taken = (e: string) => e === 'asha@example.com';
  assert.match(registrationErrors({ email: ' ASHA@example.com', password: 'trade20261' }, taken).join(' '), /already exists/);
});

test('a bad email is refused', () => {
  for (const email of ['', 'asha', 'asha@', '@example.com', 'a b@example.com', 'asha@example']) {
    assert.ok(registrationErrors({ email, password: 'trade20261' }, none).length > 0, `accepted ${JSON.stringify(email)}`);
  }
});

test('the password needs 10+ characters, a letter and a number, and must not be the email', () => {
  const err = (password: string) => registrationErrors({ email: 'asha@example.com', password }, none).join(' ');
  assert.match(err('ab12'), /at least 10/);
  assert.match(err('abcdefghij'), /letter and one number/);
  assert.match(err('1234567890'), /letter and one number/);
  assert.match(registrationErrors({ email: 'asha123456@example.com', password: 'asha123456' }, none).join(' '), /cannot be your email/);
  assert.equal(err('trade20261'), '');
});

test('a missing or non-string password is refused, not crashed on', () => {
  assert.ok(registrationErrors({ email: 'asha@example.com' }, none).length > 0);
  assert.ok(registrationErrors({ email: 'asha@example.com', password: 1234567890 }, none).length > 0);
});

test('a long name is refused; no name defaults to the email\'s first part', () => {
  assert.match(registrationErrors({ email: 'asha@example.com', password: 'trade20261', name: 'x'.repeat(61) }, none).join(' '), /under 60/);
  assert.equal(cleanRegistration({ email: 'Asha@Example.com', password: 'trade20261' }).name, 'asha');
  assert.equal(cleanRegistration({ email: 'asha@example.com', password: 'trade20261', name: '  Asha K ' }).name, 'Asha K');
});

if (failures.length) {
  console.error(`✗ authRules: ${failures.length} failed, ${passed} passed`);
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`✓ authRules: ${passed} passed`);
