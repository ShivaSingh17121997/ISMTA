/**
 * Two-factor secrets at rest.
 *
 * Whoever reads a TOTP secret can produce every future code, so it gets the
 * same treatment as a Kite api_secret: sealed with BROKER_CREDENTIALS_KEY
 * (AES-256-GCM) under the context `<userId>:totp`, which also stops a sealed
 * secret being copied onto another account.
 *
 * Values written before this existed are plaintext; they are still read, and
 * `sealPlaintextTotp` converts them at boot. Without a configured key the app
 * still works on paper, so the secret is then stored as before (plaintext) and
 * sealed the first boot a key is present.
 */
import type { User } from '../types';
import { totp } from '../utils/totp';
import { credentialsKey, open, seal } from '../utils/secretBox';
import { logger } from '../utils/logger';

const SEALED = /^v1:/;

export class TotpUnreadableError extends Error {}

const context = (userId: string) => `${userId}:totp`;

function keyOrNull(): Buffer | null {
  try {
    return credentialsKey();
  } catch {
    return null;
  }
}

export function isSealed(stored: string): boolean {
  return SEALED.test(stored);
}

/** The value to store for a fresh secret. */
export function storeTotp(userId: string, secret: string): string {
  const key = keyOrNull();
  return key ? seal(key, secret, context(userId)) : secret;
}

/** The base32 secret, from a sealed or a legacy plaintext value. */
export function revealTotp(userId: string, stored: string): string {
  if (!isSealed(stored)) return stored;
  const key = keyOrNull();
  if (!key) throw new TotpUnreadableError('BROKER_CREDENTIALS_KEY is not set, so the two-factor secret cannot be read.');
  try {
    return open(key, stored, context(userId));
  } catch {
    throw new TotpUnreadableError('The two-factor secret was sealed with a different BROKER_CREDENTIALS_KEY.');
  }
}

/** Current code or one step either side, for clock drift. */
export function codeMatchesSecret(secret: string, code: unknown, now = Date.now()): boolean {
  const c = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  return [0, -30_000, 30_000].some((skew) => totp(secret, now + skew) === c);
}

/** Checks `code` against the user's stored secret (`totpSecret` or `totpPending`). Throws TotpUnreadableError. */
export function totpCodeMatches(user: User, field: 'totpSecret' | 'totpPending', code: unknown, now = Date.now()): boolean {
  const stored = user[field];
  if (!stored) return false;
  return codeMatchesSecret(revealTotp(user.id, stored), code, now);
}

/** What a user should be told when their secret cannot be opened. */
export const TOTP_UNREADABLE_MESSAGE =
  'Your two-factor secret cannot be read on this server (the encryption key changed). ' +
  'Restore the old BROKER_CREDENTIALS_KEY, or have the admin run: npm run totp:reset -- <email>';

/** For routes: 'unreadable' is a server problem (answer 503 with TOTP_UNREADABLE_MESSAGE), not a wrong code. */
export function checkTotp(user: User, field: 'totpSecret' | 'totpPending', code: unknown): 'ok' | 'wrong' | 'unreadable' {
  try {
    return totpCodeMatches(user, field, code) ? 'ok' : 'wrong';
  } catch (e) {
    if (e instanceof TotpUnreadableError) {
      logger.error(`TOTP for ${user.email}: ${e.message}`);
      return 'unreadable';
    }
    throw e;
  }
}

/** Seals plaintext secrets in place. Returns the users changed; a no-op without a key. */
export function sealPlaintextTotp(users: Iterable<User>): User[] {
  const key = keyOrNull();
  if (!key) return [];
  const changed: User[] = [];
  for (const u of users) {
    let touched = false;
    for (const f of ['totpSecret', 'totpPending'] as const) {
      const v = u[f];
      if (v && !isSealed(v)) {
        u[f] = seal(key, v, context(u.id));
        touched = true;
      }
    }
    if (touched) changed.push(u);
  }
  return changed;
}
