import bcrypt from 'bcryptjs';
import { usesDefaultPassword } from './auth';
import { Response, Router } from 'express';
import { config } from '../config';
import { authenticate, AuthedRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { BrokerConnectionError, brokerConnections, isPlan } from '../services/BrokerConnectionService';
import { publicIp } from '../services/guards';
import { allocatorEngine } from '../services/AllocatorEngine';
import { cashSweep } from '../services/CashSweepService';
import { riskManager } from '../services/RiskManager';
import { store } from '../store/memoryStore';
import { logger } from '../utils/logger';
import { TOTP_UNREADABLE_MESSAGE, checkTotp } from '../services/totpSecrets';
import { CredentialsKeyError } from '../utils/secretBox';

/**
 * A user's own Zerodha connection: keys, plan, daily login, paper/live.
 *
 *   GET    /zerodha              status (never a secret or a token)
 *   PUT    /zerodha/credentials  { apiKey, apiSecret, plan? }
 *   PATCH  /zerodha/plan         { plan: 'personal' | 'connect' }
 *   POST   /zerodha/login        → { url } to open in the browser
 *   GET    /zerodha/callback     Kite's redirect (unauthenticated; the state identifies the user)
 *   POST   /zerodha/test         read-only check: profile, funds, holdings, market data
 *   PATCH  /zerodha/mode         { mode: 'paper' | 'live', password?, code? }
 *   POST   /zerodha/disconnect
 *   DELETE /zerodha
 */
const router = Router();

const limiter = rateLimit({ windowMs: 60_000, max: 30, message: 'Too many broker requests. Wait a minute.' });
/** Going live asks for the password, so it gets the login limiter's budget. */
const modeLimiter = rateLimit({ windowMs: 60_000, max: 10, message: 'Too many attempts. Wait a minute.' });

function fail(res: Response, e: unknown): void {
  if (e instanceof BrokerConnectionError) {
    res.status(e.status).json({ error: e.message, ...(e.errors ? { errors: e.errors } : {}) });
    return;
  }
  if (e instanceof CredentialsKeyError) {
    res.status(503).json({ error: e.message });
    return;
  }
  logger.error(`broker route: ${e instanceof Error ? e.message : String(e)}`);
  res.status(500).json({ error: 'Broker request failed' });
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** http(s)://localhost or 127.0.0.1, any port — the development frontends CORS already accepts. */
const LOCALHOST = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const RETURN_TTL_MS = 15 * 60_000;

/** The browser origin, if it is one this API serves. Never a free-form redirect target. */
function allowedOrigin(origin: unknown): string | null {
  if (typeof origin !== 'string') return null;
  if (config.corsOrigins.includes(origin)) return origin;
  if (config.env !== 'production' && LOCALHOST.test(origin)) return origin;
  return null;
}

/**
 * login state → the frontend that started it. Kite's redirect must land the
 * browser back on the SAME app: the session token lives in that origin's
 * storage, and a Next dev server that hopped from :3000 to :3002 would
 * otherwise be sent to whatever now answers on FRONTEND_URL.
 */
const returnTo = new Map<string, { origin: string; at: number }>();

router.get('/zerodha/callback', limiter, async (req, res) => {
  const state = str(req.query.state);
  const back = state ? returnTo.get(state) : undefined;
  if (state) returnTo.delete(state);
  const target = new URL('/settings', back?.origin ?? config.frontendUrl);
  try {
    await brokerConnections.completeLogin({
      state,
      requestToken: str(req.query.request_token),
      status: str(req.query.status),
    });
    target.searchParams.set('broker', 'connected');
  } catch (e) {
    if (!(e instanceof BrokerConnectionError)) logger.error(`Zerodha callback: ${e instanceof Error ? e.message : String(e)}`);
    target.searchParams.set('broker', 'error');
    target.searchParams.set('reason', e instanceof BrokerConnectionError || e instanceof CredentialsKeyError ? e.message : 'Zerodha login failed');
  }
  res.redirect(302, target.toString());
});

router.use(authenticate);
router.use(limiter);

router.get('/zerodha', (req: AuthedRequest, res) => {
  res.json({ connection: brokerConnections.view(req.userId!) });
});

router.put('/zerodha/credentials', (req: AuthedRequest, res) => {
  try {
    const { apiKey, apiSecret, plan } = req.body ?? {};
    brokerConnections.saveCredentials(req.userId!, { apiKey, apiSecret, plan });
    res.json({ connection: brokerConnections.view(req.userId!) });
  } catch (e) {
    fail(res, e);
  }
});

router.patch('/zerodha/plan', (req: AuthedRequest, res) => {
  const { plan } = req.body ?? {};
  if (!isPlan(plan)) return res.status(400).json({ error: "plan must be 'personal' or 'connect'" });
  try {
    brokerConnections.setPlan(req.userId!, plan);
    return res.json({ connection: brokerConnections.view(req.userId!) });
  } catch (e) {
    return fail(res, e);
  }
});

router.post('/zerodha/login', (req: AuthedRequest, res) => {
  try {
    const url = brokerConnections.loginUrl(req.userId!);
    const state = new URLSearchParams(new URL(url).searchParams.get('redirect_params') ?? '').get('state');
    const origin = allowedOrigin(req.headers.origin);
    const now = Date.now();
    for (const [s, r] of returnTo) if (now - r.at > RETURN_TTL_MS) returnTo.delete(s);
    if (state && origin) returnTo.set(state, { origin, at: now });
    res.json({ url });
  } catch (e) {
    fail(res, e);
  }
});

router.post('/zerodha/test', async (req: AuthedRequest, res) => {
  try {
    const [result, ip] = await Promise.all([brokerConnections.test(req.userId!), publicIp().catch(() => null)]);
    res.json({ result, publicIp: ip, connection: brokerConnections.view(req.userId!) });
  } catch (e) {
    fail(res, e);
  }
});

/**
 * A venue switch starts the new venue's books from zero: nothing measured on
 * one may steer the other.
 *   1. Today's loss count, streak and cooldown (a paper losing streak must not
 *      halt a real account).
 *   2. Going live, the sweep ledger's paper income. The switch already refuses
 *      while paper units are held; this zeroes a paper ledger that emptied on
 *      its own, which would otherwise count as cash parked from the account.
 *   3. Budgets, re-planned against the new venue's cash now rather than at the
 *      next scheduled pass. Runs after 2, which changes what the pool counts.
 */
async function startVenue(userId: string, mode: 'paper' | 'live'): Promise<void> {
  riskManager.resetForVenueSwitch(userId);
  if (mode === 'live') {
    await cashSweep.clearPaper(userId).catch((e) => logger.warn(`Sweep paper ledger on going live: ${e instanceof Error ? e.message : e}`));
  }
  await allocatorEngine
    .runFor(userId, `switched to ${mode}`)
    .catch((e) => logger.warn(`Allocator re-plan after switching to ${mode}: ${e instanceof Error ? e.message : e}`));
}

router.patch('/zerodha/mode', modeLimiter, async (req: AuthedRequest, res) => {
  const { mode, password, code } = req.body ?? {};
  if (mode !== 'paper' && mode !== 'live') return res.status(400).json({ error: "mode must be 'paper' or 'live'" });
  const user = store.users.get(req.userId!);
  if (!user) return res.status(404).json({ error: 'user not found' });

  // Real money: the person at the keyboard proves it is the account owner, not
  // just someone holding a still-valid token. 403, not 401: the session is
  // valid, and the frontend signs a browser out on any 401.
  if (mode === 'live') {
    if (!(await bcrypt.compare(String(password ?? ''), user.passwordHash))) {
      store.audit({ userId: user.id, kind: 'broker', detail: `live switch refused: wrong password from ${req.ip}` });
      return res.status(403).json({ error: 'Wrong password.', totpRequired: !!user.totpSecret });
    }
    // Two-factor is mandatory for real money, not merely honoured when on.
    if (!user.totpSecret) {
      return res.status(403).json({ error: 'Turn on two-factor authentication in Settings before switching to live.' });
    }
    const check = checkTotp(user, 'totpSecret', code);
    if (check === 'unreadable') return res.status(503).json({ error: TOTP_UNREADABLE_MESSAGE });
    if (check === 'wrong') {
      return res.status(403).json({ error: 'Enter the current code from your authenticator app.', totpRequired: true });
    }
    if (await usesDefaultPassword(user)) {
      return res.status(403).json({ error: 'This account still uses the published demo password. Change it in Settings first.' });
    }
  }

  try {
    const { pausedBooks } = brokerConnections.setTradingMode(req.userId!, mode);
    void startVenue(req.userId!, mode);
    return res.json({ connection: brokerConnections.view(req.userId!), pausedBooks });
  } catch (e) {
    return fail(res, e);
  }
});

router.post('/zerodha/disconnect', async (req: AuthedRequest, res) => {
  try {
    await brokerConnections.disconnect(req.userId!);
    res.json({ connection: brokerConnections.view(req.userId!) });
  } catch (e) {
    fail(res, e);
  }
});

router.delete('/zerodha', async (req: AuthedRequest, res) => {
  try {
    await brokerConnections.remove(req.userId!);
    res.json({ connection: brokerConnections.view(req.userId!) });
  } catch (e) {
    fail(res, e);
  }
});

export default router;
