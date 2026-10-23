/**
 * Authenticated encryption for broker credentials at rest.
 *
 * A Kite api_secret plus one day's access token is enough to trade someone's
 * account, so neither is ever written to MongoDB in the clear. AES-256-GCM: a
 * tampered value fails to open instead of decrypting to junk.
 *
 * Every value is sealed with a CONTEXT (`<userId>:apiSecret`, …) as additional
 * authenticated data. Copying one user's sealed secret into another user's
 * document therefore does not decrypt — write access to the database alone
 * cannot move credentials between accounts.
 *
 * The key lives only in BE/.env as BROKER_CREDENTIALS_KEY. Lose it and the
 * stored credentials are unrecoverable by design: re-enter them in Settings.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { config } from '../config';

const FORMAT = 'v1';
const IV_BYTES = 12;

export class CredentialsKeyError extends Error {}

export const GENERATE_KEY_HINT =
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`;

/** 64 hex characters, or base64 of exactly 32 bytes. Anything else is refused rather than stretched. */
export function parseCredentialsKey(raw: string): Buffer | null {
  const s = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
  if (/^[A-Za-z0-9+/]{43}=$/.test(s)) {
    const b = Buffer.from(s, 'base64');
    if (b.length === 32) return b;
  }
  return null;
}

/** Short, non-reversible id of a key, stored beside sealed values so a changed key is detected, not mistaken for tampering. */
export function keyFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

export function seal(key: Buffer, plaintext: string, context: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [FORMAT, iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':');
}

/** Throws on a wrong key, a wrong context or any modified byte. */
export function open(key: Buffer, sealed: string, context: string): string {
  const [format, iv, tag, body] = sealed.split(':');
  if (format !== FORMAT || !iv || !tag || body === undefined) throw new Error('not a sealed credential');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}

/** The configured key, or an error that says exactly how to set one. */
export function credentialsKey(): Buffer {
  const raw = config.brokerCredentials.key;
  if (!raw) {
    throw new CredentialsKeyError(
      `BROKER_CREDENTIALS_KEY is not set in BE/.env. Generate one with ${GENERATE_KEY_HINT}, add it, and restart the backend.`,
    );
  }
  const key = parseCredentialsKey(raw);
  if (!key) throw new CredentialsKeyError('BROKER_CREDENTIALS_KEY must be 64 hex characters (32 bytes).');
  return key;
}

/** Fingerprint of the configured key, or null when none is usable. */
export function configuredKeyFingerprint(): string | null {
  try {
    return keyFingerprint(credentialsKey());
  } catch {
    return null;
  }
}
