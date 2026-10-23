/**
 * Each user's own Zerodha (Kite Connect) app, entered in Settings.
 *
 * WHAT A USER CONTROLS
 *
 *   keys          api_key + api_secret from developers.kite.trade. The secret is
 *                 sealed with BROKER_CREDENTIALS_KEY and never leaves the server.
 *   plan          personal (free: orders, portfolio, funds — no market data) or
 *                 connect (paid: adds the live price stream). A toggle, because
 *                 Kite sells the same app on either plan and the user upgrades
 *                 in Kite's console, not here.
 *   connection    Kite has no refresh token for individual apps and logs every
 *                 app out at 06:00 IST, so a human logs in once a day. "Connect"
 *                 sends the browser to Kite; Kite sends it back to /callback with
 *                 a request_token that is exchanged here for the day's token.
 *   trading mode  paper or live. Connecting never places an order by itself —
 *                 live is a separate, password-confirmed switch.
 *
 * WHY LIVE IS GUARDED
 *
 * A paper book's lots are simulated. If the same book suddenly traded live, the
 * engine would try to SELL shares the demat account never held — or, worse,
 * shares the user holds for their own reasons. So live cannot be switched on
 * while any book holds simulated lots, and each book remembers which venue its
 * lots came from (AccumulatorEngine refuses to trade a book on the other one).
 *
 * MARKET DATA
 *
 * Prices are the same for everyone, so one stream is enough: the earliest
 * connected paid-plan key feeds KiteService for the whole server, and Yahoo
 * covers everything else. A key Kite refuses market data to is not retried for
 * 15 minutes, so a free key switched to "paid" by mistake does not loop.
 */
import { randomBytes } from 'crypto';
import { config } from '../config';
import { marketData } from './MarketDataService';
import {
  isKitePermissionError,
  isKiteTokenError,
  kiteErrorMessage,
  kiteHeldQuantities,
  KiteHeldRow,
  kiteLoginUrl,
  kiteTokenExpiry,
  mapKiteFunds,
} from '../brokers/kiteMapping';
import { store } from '../store/memoryStore';
import type { BrokerConnection, BrokerConnectionStatus, BrokerPlan, BrokerTradingMode } from '../types';
import { logger } from '../utils/logger';
import { configuredKeyFingerprint, credentialsKey, keyFingerprint, open, seal } from '../utils/secretBox';
import { effectiveStatus, liveSwitchBlockers, maskApiKey, paperSwitchBlockers, validateKiteCredentials } from './brokerRules';
import { kiteService } from './KiteService';
import { notifier } from './Notifier';

/* eslint-disable @typescript-eslint/no-explicit-any */
let KiteConnect: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  KiteConnect = require('kiteconnect').KiteConnect;
} catch {
  /* only needed once someone connects */
}

const LOGIN_TTL_MS = 10 * 60_000;
const TICK_MS = 60_000;
const FEED_RETRY_MS = 15 * 60_000;

export const PLANS: readonly BrokerPlan[] = ['personal', 'connect'];
export const isPlan = (v: unknown): v is BrokerPlan => PLANS.includes(v as BrokerPlan);

const idFor = (userId: string) => `${userId}:zerodha`;

export class BrokerConnectionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly errors?: string[],
  ) {
    super(message);
  }
}

/** Everything Settings shows. Never carries a secret or a token. */
export interface BrokerConnectionView {
  broker: 'zerodha';
  configured: boolean;
  apiKeyMasked: string | null;
  plan: BrokerPlan;
  tradingMode: BrokerTradingMode;
  status: BrokerConnectionStatus;
  kiteUserId: string | null;
  kiteUserName: string | null;
  connectedAt: number | null;
  expiresAt: number | null;
  liveSince: number | null;
  lastError: string | null;
  /** Paste this into the app's Redirect URL on developers.kite.trade. */
  redirectUrl: string;
  credentialsKey: { configured: boolean; matches: boolean };
  liveBlockers: string[];
  /** Books whose lots were bought live; they pause while trading is on paper. */
  liveVenueBooks: string[];
  envBroker: string;
  staticIp: string | null;
  jwtSecretIsDefault: boolean;
  marketData: {
    feed: string;
    kiteActive: boolean;
    kiteStreaming: boolean;
    providedByYou: boolean;
    subscribed: number;
    lastTickAt: number | null;
    error: string | null;
  };
}

export interface BrokerTestResult {
  at: number;
  profile: { userId: string; userName: string; broker: string; exchanges: string[]; products: string[] };
  funds: { cash: number; usedMargin: number };
  held: KiteHeldRow[];
  marketData: { status: 'available' | 'not_on_plan' | 'unknown'; detail: string };
  planMismatch: string | null;
}

class BrokerConnectionService {
  /** userId → authenticated KiteConnect client for today's session. */
  private clients = new Map<string, any>();
  /** login state → who started it. Single use, 10 minutes. */
  private logins = new Map<string, { userId: string; expiresAt: number }>();
  /** userId → when Kite last refused this key market data. */
  private feedRefusals = new Map<string, { at: number; reason: string }>();
  private timer: NodeJS.Timeout | null = null;

  get(userId: string): BrokerConnection | undefined {
    return store.brokerConnections.get(idFor(userId));
  }

  private require(userId: string): BrokerConnection {
    const conn = this.get(userId);
    if (!conn) throw new BrokerConnectionError('Save your Kite API key and secret first.', 404);
    return conn;
  }

  private save(conn: BrokerConnection): void {
    conn.updatedAt = Date.now();
    store.brokerConnections.set(conn.id, conn);
  }

  private keyMatches(conn: BrokerConnection): boolean {
    return conn.keyId === configuredKeyFingerprint();
  }

  private secretOf(conn: BrokerConnection): string {
    return open(credentialsKey(), conn.apiSecretSealed, `${conn.userId}:apiSecret`);
  }

  private tokenOf(conn: BrokerConnection): string | null {
    return conn.accessTokenSealed ? open(credentialsKey(), conn.accessTokenSealed, `${conn.userId}:accessToken`) : null;
  }

  // ── read by the order path ─────────────────────────────────────────────

  isLive(userId: string): boolean {
    return this.get(userId)?.tradingMode === 'live';
  }

  liveUserIds(): string[] {
    return [...store.brokerConnections.values()].filter((c) => c.tradingMode === 'live').map((c) => c.userId);
  }

  /** Today's client, or null when there is no usable session. */
  clientFor(userId: string): any | null {
    const conn = this.get(userId);
    if (!conn || effectiveStatus(conn, Date.now()) !== 'connected') return null;
    return this.clients.get(userId) ?? null;
  }

  unavailableReason(userId: string): string {
    const conn = this.get(userId);
    if (!conn) return 'No Zerodha connection — add your Kite keys in Settings';
    switch (effectiveStatus(conn, Date.now())) {
      case 'expired':
        return 'Zerodha session ended (Kite logs every app out at 06:00 IST) — reconnect in Settings';
      case 'error':
        return `Zerodha connection error: ${conn.lastError ?? 'unknown'} — reconnect in Settings`;
      case 'connected':
        return 'Zerodha session is not loaded on this server — reconnect in Settings';
      default:
        return 'Zerodha is not connected — connect in Settings';
    }
  }

  // ── keys and plan ──────────────────────────────────────────────────────

  saveCredentials(userId: string, input: { apiKey?: unknown; apiSecret?: unknown; plan?: unknown }): BrokerConnection {
    const check = validateKiteCredentials(input.apiKey, input.apiSecret);
    if (!check.ok) throw new BrokerConnectionError(check.errors.join(' '), 400, check.errors);
    const existing = this.get(userId);
    if (existing?.tradingMode === 'live') {
      throw new BrokerConnectionError('Switch trading back to paper before replacing the keys of a live connection.', 409);
    }
    const key = credentialsKey();
    const now = Date.now();
    const plan = isPlan(input.plan) ? input.plan : existing?.plan ?? 'personal';
    this.dropSession(userId);
    const conn: BrokerConnection = {
      id: idFor(userId),
      userId,
      broker: 'zerodha',
      apiKey: check.apiKey,
      apiSecretSealed: seal(key, check.apiSecret, `${userId}:apiSecret`),
      keyId: keyFingerprint(key),
      plan,
      tradingMode: 'paper',
      status: 'not_connected',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    store.brokerConnections.set(conn.id, conn);
    this.feedRefusals.delete(userId);
    store.audit({ userId, kind: 'broker', detail: `Zerodha keys saved (${maskApiKey(conn.apiKey)}, ${plan} plan)` });
    this.refreshFeed();
    return conn;
  }

  setPlan(userId: string, plan: BrokerPlan): BrokerConnection {
    const conn = this.require(userId);
    if (conn.plan === plan) return conn;
    conn.plan = plan;
    this.save(conn);
    this.feedRefusals.delete(userId);
    store.audit({ userId, kind: 'broker', detail: `Kite plan set to ${plan === 'connect' ? 'paid (Kite Connect)' : 'free (Personal)'}` });
    this.refreshFeed();
    return conn;
  }

  // ── daily login ────────────────────────────────────────────────────────

  loginUrl(userId: string): string {
    const conn = this.require(userId);
    if (!this.keyMatches(conn)) {
      throw new BrokerConnectionError('The stored keys cannot be opened with the current BROKER_CREDENTIALS_KEY. Enter them again.', 409);
    }
    const now = Date.now();
    for (const [s, l] of this.logins) if (l.expiresAt < now) this.logins.delete(s);
    const state = randomBytes(24).toString('base64url');
    this.logins.set(state, { userId, expiresAt: now + LOGIN_TTL_MS });
    return kiteLoginUrl(conn.apiKey, state);
  }

  /**
   * Kite's redirect. Unauthenticated by necessity (it is the browser coming
   * back from kite.zerodha.com), so the single-use `state` is the ONLY thing
   * that identifies the user — nothing else in the query string is trusted.
   */
  async completeLogin(q: { state?: string; requestToken?: string; status?: string }): Promise<{ userId: string }> {
    const entry = q.state ? this.logins.get(q.state) : undefined;
    if (q.state) this.logins.delete(q.state);
    if (!entry || entry.expiresAt < Date.now()) {
      throw new BrokerConnectionError('This Zerodha login link has expired or was already used. Start again from Settings.');
    }
    const { userId } = entry;
    const conn = this.require(userId);
    if (q.status && q.status !== 'success') {
      throw new BrokerConnectionError(`Kite reported the login as "${q.status}".`);
    }
    if (!q.requestToken) throw new BrokerConnectionError('Kite did not send a request token back.');
    if (!KiteConnect) throw new BrokerConnectionError('kiteconnect SDK is not installed on the server.', 500);

    let session: any;
    try {
      const kc = new KiteConnect({ api_key: conn.apiKey });
      session = await kc.generateSession(q.requestToken, this.secretOf(conn));
    } catch (e) {
      const msg = kiteErrorMessage(e);
      conn.status = 'error';
      conn.lastError = `Login failed: ${msg}`;
      this.save(conn);
      store.audit({ userId, kind: 'broker', detail: `Zerodha login failed: ${msg}` });
      throw new BrokerConnectionError(`Kite refused the login: ${msg}. Check the API secret, and that the app's redirect URL matches.`, 502);
    }

    const token = String(session?.access_token ?? '');
    if (!token) throw new BrokerConnectionError('Kite returned no access token.', 502);
    const kiteUserId = String(session.user_id ?? '');

    // Books trading live belong to ONE demat account. Logging this app into a
    // different Zerodha client while live would point those books at shares
    // they never bought.
    if (conn.tradingMode === 'live' && conn.kiteUserId && kiteUserId && conn.kiteUserId !== kiteUserId) {
      throw new BrokerConnectionError(
        `This connection trades live for Zerodha client ${conn.kiteUserId}, but the login was ${kiteUserId}. Switch trading to paper first.`,
        409,
      );
    }

    const now = Date.now();
    conn.accessTokenSealed = seal(credentialsKey(), token, `${userId}:accessToken`);
    conn.status = 'connected';
    conn.connectedAt = now;
    conn.expiresAt = kiteTokenExpiry(now);
    conn.kiteUserId = kiteUserId || undefined;
    conn.kiteUserName = session.user_name ? String(session.user_name) : undefined;
    conn.lastError = undefined;
    this.save(conn);
    this.installClient(conn, token);
    this.feedRefusals.delete(userId);
    store.audit({ userId, kind: 'broker', detail: `Zerodha connected as ${conn.kiteUserId ?? 'unknown client'} until ${new Date(conn.expiresAt).toISOString()}` });
    logger.info(`Zerodha connected for user ${userId} (${conn.kiteUserId})`);
    this.refreshFeed();
    return { userId };
  }

  private installClient(conn: BrokerConnection, token: string): void {
    if (!KiteConnect) return;
    const kc = new KiteConnect({ api_key: conn.apiKey });
    kc.setAccessToken(token);
    kc.setSessionExpiryHook(() => this.markExpired(conn.userId, 'Kite rejected the session (logged out elsewhere, or past 06:00 IST)'));
    this.clients.set(conn.userId, kc);
  }

  private dropSession(userId: string): void {
    this.clients.delete(userId);
  }

  private markExpired(userId: string, reason: string): void {
    const conn = this.get(userId);
    if (!conn) return;
    const wasConnected = conn.status === 'connected';
    this.dropSession(userId);
    conn.accessTokenSealed = undefined;
    conn.status = 'expired';
    conn.lastError = reason;
    this.save(conn);
    if (wasConnected) {
      store.audit({ userId, kind: 'broker', detail: `Zerodha session ended: ${reason}` });
      if (conn.tradingMode === 'live') {
        void notifier.alert(
          'critical',
          `broker-expired:${userId}`,
          `Zerodha session ended for ${conn.kiteUserId ?? userId}: ${reason}. Live orders are refused until you reconnect in Settings.`,
        );
      }
    }
    this.refreshFeed();
  }

  // ── paper / live ───────────────────────────────────────────────────────

  liveBlockers(userId: string, now = Date.now()): string[] {
    const conn = this.get(userId);
    const openLotBooks = store
      .accumulatorBooksByUser(userId)
      .filter((b) => b.openLots.length > 0 && (b.venue ?? 'paper') === 'paper')
      .map((b) => b.symbol);
    const out = liveSwitchBlockers({
      conn,
      now,
      credentialsKeyOk: !!conn && this.keyMatches(conn),
      jwtSecretIsDefault: config.jwt.secretIsDefault,
      envBroker: config.broker,
      openLotBooks,
      openTrades: store.openTradesByUser(userId).length,
      totpEnabled: !!store.users.get(userId)?.totpSecret,
      paperSweepUnits: (() => {
        const sw = store.cashSweeps.get(userId);
        return sw && (sw.venue ?? 'paper') === 'paper' ? sw.lots.reduce((n, l) => n + l.quantity, 0) : 0;
      })(),
      simulatedData: marketData.isSimulated(),
      staticIpSet: config.guards.staticIp.trim().length > 0,
    });
    if (conn && effectiveStatus(conn, now) === 'connected' && !this.clients.has(userId)) {
      out.push('Reconnect Zerodha — this server has no session loaded for you.');
    }
    return out;
  }

  private liveVenueBooks(userId: string): string[] {
    return store
      .accumulatorBooksByUser(userId)
      .filter((b) => b.openLots.length > 0 && b.venue === 'live')
      .map((b) => b.symbol);
  }

  setTradingMode(userId: string, mode: BrokerTradingMode): { conn: BrokerConnection; pausedBooks: string[] } {
    const conn = this.require(userId);
    if (conn.tradingMode === mode) return { conn, pausedBooks: [] };
    const now = Date.now();

    if (mode === 'live') {
      const blockers = this.liveBlockers(userId, now);
      if (blockers.length) throw new BrokerConnectionError(blockers.join(' '), 409, blockers);
      conn.tradingMode = 'live';
      conn.liveSince = now;
      this.save(conn);
      store.audit({ userId, kind: 'broker', detail: `LIVE trading ON — orders now go to Zerodha client ${conn.kiteUserId}` });
      void notifier.alert('warn', `broker-live:${userId}`, `Live trading switched ON for Zerodha client ${conn.kiteUserId}.`, 0);
      return { conn, pausedBooks: [] };
    }

    const blockers = paperSwitchBlockers({ openTrades: store.openTradesByUser(userId).length });
    if (blockers.length) throw new BrokerConnectionError(blockers.join(' '), 409, blockers);
    conn.tradingMode = 'paper';
    conn.liveSince = undefined;
    this.save(conn);
    const pausedBooks = this.liveVenueBooks(userId);
    store.audit({
      userId,
      kind: 'broker',
      detail: `Live trading OFF — orders are simulated${pausedBooks.length ? `; paused books holding real lots: ${pausedBooks.join(', ')}` : ''}`,
    });
    return { conn, pausedBooks };
  }

  // ── disconnect / remove ────────────────────────────────────────────────

  async disconnect(userId: string): Promise<BrokerConnection> {
    const conn = this.require(userId);
    const kc = this.clients.get(userId);
    if (kc) {
      try {
        await kc.invalidateAccessToken();
      } catch (e) {
        logger.debug(`Kite logout for ${userId}: ${kiteErrorMessage(e)}`);
      }
    }
    this.dropSession(userId);
    conn.accessTokenSealed = undefined;
    conn.status = 'not_connected';
    conn.lastError = undefined;
    this.save(conn);
    store.audit({ userId, kind: 'broker', detail: 'Zerodha disconnected' });
    this.refreshFeed();
    return conn;
  }

  async remove(userId: string): Promise<void> {
    const conn = this.require(userId);
    if (conn.tradingMode === 'live') {
      throw new BrokerConnectionError('Switch trading back to paper before removing a live connection.', 409);
    }
    if (conn.status === 'connected') await this.disconnect(userId);
    store.brokerConnections.delete(conn.id);
    this.feedRefusals.delete(userId);
    store.audit({ userId, kind: 'broker', detail: 'Zerodha keys removed' });
    this.refreshFeed();
  }

  // ── connection test (reads only, never orders) ─────────────────────────

  async test(userId: string): Promise<BrokerTestResult> {
    const conn = this.require(userId);
    const kc = this.clientFor(userId);
    if (!kc) throw new BrokerConnectionError(this.unavailableReason(userId), 409);
    const at = Date.now();

    let profile: any;
    let margins: unknown;
    let holdings: unknown;
    let positions: unknown;
    try {
      [profile, margins, holdings, positions] = await Promise.all([
        kc.getProfile(),
        kc.getMargins('equity'),
        kc.getHoldings(),
        kc.getPositions(),
      ]);
    } catch (e) {
      if (isKiteTokenError(e)) this.markExpired(userId, 'Kite rejected the session during the connection test');
      throw new BrokerConnectionError(`Kite: ${kiteErrorMessage(e)}`, 502);
    }

    let marketData: BrokerTestResult['marketData'];
    try {
      await kc.getLTP(['NSE:INFY']);
      marketData = { status: 'available', detail: 'Kite returned a live quote.' };
    } catch (e) {
      marketData = isKitePermissionError(e)
        ? { status: 'not_on_plan', detail: `Kite refused a quote: ${kiteErrorMessage(e)}` }
        : { status: 'unknown', detail: kiteErrorMessage(e) };
    }

    let planMismatch: string | null = null;
    if (conn.plan === 'connect' && marketData.status === 'not_on_plan') {
      planMismatch = 'This key has no market data, so it is on the free Personal plan. Set the plan to Free, or subscribe to Kite Connect in the developer console.';
    } else if (conn.plan === 'personal' && marketData.status === 'available') {
      planMismatch = 'This key has market data. Set the plan to Paid to stream live prices from Kite instead of Yahoo.';
    }

    const funds = mapKiteFunds(margins, at);
    return {
      at,
      profile: {
        userId: String(profile?.user_id ?? ''),
        userName: String(profile?.user_name ?? ''),
        broker: String(profile?.broker ?? ''),
        exchanges: Array.isArray(profile?.exchanges) ? profile.exchanges.map(String) : [],
        products: Array.isArray(profile?.products) ? profile.products.map(String) : [],
      },
      funds: { cash: funds.cash, usedMargin: funds.usedMargin },
      held: kiteHeldQuantities(holdings, positions),
      marketData,
      planMismatch,
    };
  }

  // ── views ──────────────────────────────────────────────────────────────

  redirectUrl(): string {
    return `${config.publicApiUrl}/api/broker/zerodha/callback`;
  }

  view(userId: string, now = Date.now()): BrokerConnectionView {
    const conn = this.get(userId);
    const feed = kiteService.status();
    const providedByYou = feed.source === 'user' && feed.ownerUserId === userId;
    return {
      broker: 'zerodha',
      configured: !!conn,
      apiKeyMasked: conn ? maskApiKey(conn.apiKey) : null,
      plan: conn?.plan ?? 'personal',
      tradingMode: conn?.tradingMode ?? 'paper',
      status: effectiveStatus(conn, now),
      kiteUserId: conn?.kiteUserId ?? null,
      kiteUserName: conn?.kiteUserName ?? null,
      connectedAt: conn?.connectedAt ?? null,
      expiresAt: conn?.expiresAt ?? null,
      liveSince: conn?.liveSince ?? null,
      lastError: conn?.lastError ?? null,
      redirectUrl: this.redirectUrl(),
      credentialsKey: { configured: configuredKeyFingerprint() !== null, matches: !conn || this.keyMatches(conn) },
      liveBlockers: conn ? this.liveBlockers(userId, now) : [],
      liveVenueBooks: this.liveVenueBooks(userId),
      envBroker: config.broker,
      staticIp: config.guards.staticIp || null,
      jwtSecretIsDefault: config.jwt.secretIsDefault,
      marketData: {
        feed: config.dataSource,
        kiteActive: feed.active,
        kiteStreaming: feed.streaming,
        providedByYou,
        subscribed: feed.subscribed,
        lastTickAt: feed.lastTickAt,
        error: this.feedRefusals.get(userId)?.reason ?? (providedByYou ? feed.error : null),
      },
    };
  }

  /** The three facts the top bar and sidebar need. */
  summary(userId: string): { plan: BrokerPlan; tradingMode: BrokerTradingMode; status: BrokerConnectionStatus } | null {
    const conn = this.get(userId);
    return conn ? { plan: conn.plan, tradingMode: conn.tradingMode, status: effectiveStatus(conn, Date.now()) } : null;
  }

  // ── market data ────────────────────────────────────────────────────────

  /** Point the Kite price stream at a connected paid-plan key, or stop it when there is none. */
  refreshFeed(): void {
    // DATA_SOURCE=zerodha is the .env feed and owns KiteService; sim is offline development.
    if (config.dataSource !== 'yahoo') return;
    const now = Date.now();
    const candidates = [...store.brokerConnections.values()].filter((c) => {
      if (c.plan !== 'connect' || effectiveStatus(c, now) !== 'connected') return false;
      if (!this.clients.has(c.userId) || !this.keyMatches(c)) return false;
      const refused = this.feedRefusals.get(c.userId);
      return !refused || now - refused.at >= FEED_RETRY_MS;
    });

    const current = kiteService.ownerUserId;
    if (kiteService.source === 'user' && current && candidates.some((c) => c.userId === current)) return;

    if (!candidates.length) {
      if (kiteService.source === 'user') {
        kiteService.stop();
        logger.info('Kite price stream stopped — no connected paid-plan key; prices stay on Yahoo');
      }
      return;
    }

    const pick = candidates.sort((a, b) => (a.connectedAt ?? 0) - (b.connectedAt ?? 0))[0];
    let token: string | null;
    try {
      token = this.tokenOf(pick);
    } catch {
      token = null;
    }
    if (!token) return;
    void kiteService.start(
      { source: 'user', userId: pick.userId, apiKey: pick.apiKey, accessToken: token },
      {
        onExpired: () => this.markExpired(pick.userId, 'Kite rejected the price-stream session'),
        onDenied: (reason) => {
          this.feedRefusals.set(pick.userId, { at: Date.now(), reason });
          store.audit({ userId: pick.userId, kind: 'broker', detail: `Kite market data refused: ${reason}` });
          this.refreshFeed();
        },
      },
    );
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  /** After store.hydrate(): reload today's sessions, then check expiry every minute. */
  start(): void {
    const now = Date.now();
    for (const conn of store.brokerConnections.values()) {
      if (conn.status !== 'connected') continue;
      if (effectiveStatus(conn, now) === 'expired') {
        this.markExpired(conn.userId, 'Kite sessions end at 06:00 IST');
        continue;
      }
      try {
        const token = this.tokenOf(conn);
        if (token) this.installClient(conn, token);
      } catch {
        conn.status = 'error';
        conn.lastError = 'The stored session cannot be opened with the current BROKER_CREDENTIALS_KEY. Enter the keys again.';
        this.save(conn);
      }
    }
    const loaded = this.clients.size;
    if (store.brokerConnections.size) {
      logger.info(`Broker connections: ${store.brokerConnections.size} saved, ${loaded} session(s) loaded, ${this.liveUserIds().length} live`);
    }
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  private tick(): void {
    const now = Date.now();
    for (const conn of store.brokerConnections.values()) {
      if (conn.status === 'connected' && effectiveStatus(conn, now) === 'expired') {
        this.markExpired(conn.userId, 'Kite sessions end at 06:00 IST');
      }
    }
    for (const [s, l] of this.logins) if (l.expiresAt < now) this.logins.delete(s);
    this.refreshFeed();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (kiteService.source === 'user') kiteService.stop();
  }
}

export const brokerConnections = new BrokerConnectionService();
