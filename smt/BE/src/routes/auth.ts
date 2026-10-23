import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { signToken, authenticate, AuthedRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { store } from '../store/memoryStore';
import { User } from '../types';
import { TOTP_UNREADABLE_MESSAGE, checkTotp, storeTotp } from '../services/totpSecrets';
import { logger } from '../utils/logger';
import { config } from '../config';
import { cleanRegistration, registrationErrors } from '../services/authRules';

const router = Router();

/** Ten attempts a minute per IP. A password guess should cost seconds, not milliseconds. */
const loginLimiter = rateLimit({ windowMs: 60_000, max: 10, message: 'Too many login attempts. Wait a minute.' });

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Secret(bytes = 20): string {
  const buf = randomBytes(bytes);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Passwords that ship with the app (the seeded demo account). An account still
 * on one of these is public knowledge and may not switch to live trading.
 */
export const DEFAULT_PASSWORDS = ['demo123'];

export async function usesDefaultPassword(user: User): Promise<boolean> {
  for (const p of DEFAULT_PASSWORDS) if (await bcrypt.compare(p, user.passwordHash)) return true;
  return false;
}

/** Public: whether the sign-up page should offer to create an account. */
router.get('/config', (_req, res) => {
  res.json({ registrationOpen: config.allowRegistration });
});

router.post('/register', loginLimiter, async (req, res) => {
  if (!config.allowRegistration) {
    return res.status(403).json({ error: 'Registration is closed. Set ALLOW_REGISTRATION=true on the server to open it.' });
  }
  const body = req.body ?? {};
  const errors = registrationErrors(body, (e) => !!store.findUserByEmail(e));
  if (errors.length) {
    const taken = errors.some((m) => m.startsWith('An account with this email'));
    return res.status(taken ? 409 : 400).json({ error: errors.join(' '), errors });
  }
  const { email, password, name } = cleanRegistration(body);

  const user: User = {
    id: uuid(),
    email,
    name,
    passwordHash: await bcrypt.hash(password, 10),
    role: 'trader',
    createdAt: Date.now(),
  };
  // The hash takes ~100ms: a second sign-up with the same email may have landed meanwhile.
  if (store.findUserByEmail(email)) {
    return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
  }
  store.users.set(user.id, user);
  store.audit({ userId: user.id, kind: 'auth', detail: `registered ${email}` });
  const token = signToken(user.id, user.role);
  return res.status(201).json({ token, user: publicUser(user) });
});

/**
 * Login. When the account has a confirmed TOTP secret the request must also
 * carry `code`; a missing code is answered with `totpRequired` rather than a
 * bare 401 so the form can ask for it.
 */
router.post('/login', loginLimiter, async (req, res) => {
  const { email, password, code } = req.body ?? {};
  const user = email ? store.findUserByEmail(email) : undefined;
  if (!user || !(await bcrypt.compare(password ?? '', user.passwordHash))) {
    store.audit({ kind: 'auth', detail: `failed login for ${email ?? '(no email)'} from ${req.ip}` });
    return res.status(401).json({ error: 'invalid credentials' });
  }
  if (user.totpSecret) {
    if (!code) return res.status(401).json({ error: 'authenticator code required', totpRequired: true });
    const check = checkTotp(user, 'totpSecret', code);
    if (check === 'unreadable') return res.status(503).json({ error: TOTP_UNREADABLE_MESSAGE });
    if (check === 'wrong') {
      store.audit({ userId: user.id, kind: 'auth', detail: `wrong authenticator code from ${req.ip}` });
      return res.status(401).json({ error: 'wrong authenticator code', totpRequired: true });
    }
  }
  store.audit({ userId: user.id, kind: 'auth', detail: `login from ${req.ip}` });
  const token = signToken(user.id, user.role);
  return res.json({ token, user: publicUser(user) });
});

router.get('/me', authenticate, (req: AuthedRequest, res) => {
  const user = req.userId ? store.users.get(req.userId) : undefined;
  if (!user) return res.status(404).json({ error: 'user not found' });
  return res.json({ user: publicUser(user) });
});

/**
 * Two-factor enrolment. Step 1 returns a fresh secret and the otpauth URI for
 * an authenticator app; nothing is enforced yet. Step 2 confirms with a code
 * from the app, and only then does login start requiring it — so a mistyped
 * secret cannot lock the account.
 */
router.post('/totp/enrol', authenticate, (req: AuthedRequest, res) => {
  const user = store.users.get(req.userId!);
  if (!user) return res.status(404).json({ error: 'user not found' });
  const secret = base32Secret();
  user.totpPending = storeTotp(user.id, secret);
  store.users.set(user.id, user);
  const label = encodeURIComponent(`ISMTA:${user.email}`);
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=ISMTA&digits=6&period=30`;
  return res.json({ secret, uri, note: 'Add this to your authenticator app, then confirm with a code. Login will not require it until confirmed.' });
});

router.post('/totp/confirm', authenticate, (req: AuthedRequest, res) => {
  const user = store.users.get(req.userId!);
  if (!user) return res.status(404).json({ error: 'user not found' });
  if (!user.totpPending) return res.status(400).json({ error: 'no enrolment in progress — call /totp/enrol first' });
  const { code } = req.body ?? {};
  const check = checkTotp(user, 'totpPending', code);
  if (check === 'unreadable') return res.status(503).json({ error: TOTP_UNREADABLE_MESSAGE });
  if (check === 'wrong') {
    return res.status(400).json({ error: 'that code does not match the new secret; check the app and the clock' });
  }
  user.totpSecret = user.totpPending;
  user.totpPending = undefined;
  user.totpEnabledAt = Date.now();
  store.users.set(user.id, user);
  store.audit({ userId: user.id, kind: 'auth', detail: 'two-factor enabled' });
  logger.info(`TOTP enabled for ${user.email}`);
  return res.json({ user: publicUser(user) });
});

/** Disable. Requires the current password AND a current code. */
router.post('/totp/disable', authenticate, async (req: AuthedRequest, res) => {
  const user = store.users.get(req.userId!);
  if (!user) return res.status(404).json({ error: 'user not found' });
  const { password, code } = req.body ?? {};
  if (!(await bcrypt.compare(password ?? '', user.passwordHash))) return res.status(401).json({ error: 'wrong password' });
  if (!user.totpSecret) return res.json({ user: publicUser(user) });
  const check = checkTotp(user, 'totpSecret', code);
  if (check === 'unreadable') return res.status(503).json({ error: TOTP_UNREADABLE_MESSAGE });
  if (check === 'wrong') return res.status(401).json({ error: 'wrong authenticator code' });
  user.totpSecret = undefined;
  user.totpEnabledAt = undefined;
  store.users.set(user.id, user);
  store.audit({ userId: user.id, kind: 'auth', detail: 'two-factor disabled' });
  return res.json({ user: publicUser(user) });
});

/**
 * Change password. Needs the current password, and the authenticator code when
 * two-factor is on. 403 rather than 401 for a wrong answer: the session is
 * valid, and the frontend signs a browser out on any 401.
 */
router.post('/password', authenticate, loginLimiter, async (req: AuthedRequest, res) => {
  const user = store.users.get(req.userId!);
  if (!user) return res.status(404).json({ error: 'user not found' });
  const { current, next, code } = req.body ?? {};
  if (!(await bcrypt.compare(String(current ?? ''), user.passwordHash))) {
    return res.status(403).json({ error: 'Current password is wrong.' });
  }
  const check = user.totpSecret ? checkTotp(user, 'totpSecret', code) : 'ok';
  if (check === 'unreadable') return res.status(503).json({ error: TOTP_UNREADABLE_MESSAGE });
  if (check === 'wrong') {
    return res.status(403).json({ error: 'Enter the current code from your authenticator app.', totpRequired: true });
  }
  const pw = String(next ?? '');
  if (pw.length < 10) return res.status(400).json({ error: 'New password must be at least 10 characters.' });
  if (DEFAULT_PASSWORDS.includes(pw)) return res.status(400).json({ error: 'That is the published demo password.' });
  if (await bcrypt.compare(pw, user.passwordHash)) return res.status(400).json({ error: 'New password must differ from the current one.' });
  user.passwordHash = await bcrypt.hash(pw, 10);
  store.users.set(user.id, user);
  store.audit({ userId: user.id, kind: 'auth', detail: 'password changed' });
  return res.json({ user: publicUser(user) });
});

function publicUser(u: User) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, totpEnabled: !!u.totpSecret };
}

export default router;
