/**
 * The rules around a user's own broker connection, kept pure so each refusal
 * can be tested without a Zerodha account or a database.
 *
 * Every rule here exists because the alternative moves real money wrongly:
 * switching a paper book to a live broker makes the engine try to sell shares
 * the demat account never held; a live key on the development JWT secret lets
 * anyone with the source sign in and trade.
 */
import type { BrokerConnection, BrokerConnectionStatus } from '../types';

export const KITE_CREDENTIAL = /^[A-Za-z0-9]{6,64}$/;

/** "••••••••••••ab12" — enough to recognise a key, not enough to use it. */
export function maskApiKey(apiKey: string): string {
  if (!apiKey) return '';
  return `${'•'.repeat(Math.max(4, apiKey.length - 4))}${apiKey.slice(-4)}`;
}

export type CredentialCheck =
  | { ok: true; apiKey: string; apiSecret: string }
  | { ok: false; errors: string[] };

export function validateKiteCredentials(apiKey: unknown, apiSecret: unknown): CredentialCheck {
  const errors: string[] = [];
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const secret = typeof apiSecret === 'string' ? apiSecret.trim() : '';
  if (!KITE_CREDENTIAL.test(key)) errors.push('API key must be the letters and digits shown on developers.kite.trade.');
  if (!KITE_CREDENTIAL.test(secret)) errors.push('API secret must be the letters and digits shown on developers.kite.trade.');
  if (key && key === secret) errors.push('API key and API secret are different values — check you copied both.');
  return errors.length ? { ok: false, errors } : { ok: true, apiKey: key, apiSecret: secret };
}

/** The stored status with the clock applied: a session past 06:00 IST is expired whatever was last written. */
export function effectiveStatus(conn: BrokerConnection | undefined, now: number): BrokerConnectionStatus {
  if (!conn) return 'not_connected';
  if (conn.status === 'connected' && (!conn.expiresAt || now >= conn.expiresAt)) return 'expired';
  return conn.status;
}

export interface LiveSwitchContext {
  conn: BrokerConnection | undefined;
  now: number;
  /** The stored secrets open with the configured BROKER_CREDENTIALS_KEY. */
  credentialsKeyOk: boolean;
  jwtSecretIsDefault: boolean;
  /** BROKER from .env. Anything but paper already routes every user to one account. */
  envBroker: string;
  /** Books holding simulated lots. */
  openLotBooks: string[];
  /** Open strategy trades (intraday). */
  openTrades: number;
  /** Simulated units parked by the cash sweep while on paper. */
  paperSweepUnits?: number;
  /** Two-factor sign-in is enrolled on the app account (the switch requires it). */
  totpEnabled?: boolean;
  /** Prices come from the simulator, not a real feed. */
  simulatedData: boolean;
  /** BROKER_STATIC_IP is configured. */
  staticIpSet: boolean;
}

/** Why live trading cannot be switched on right now. Empty = allowed. */
export function liveSwitchBlockers(ctx: LiveSwitchContext): string[] {
  const out: string[] = [];
  if (!ctx.conn) {
    out.push('Save your Kite API key and secret first.');
    return out;
  }
  if (!ctx.credentialsKeyOk) {
    out.push('The stored keys cannot be opened with the current BROKER_CREDENTIALS_KEY. Enter them again.');
  }
  if (effectiveStatus(ctx.conn, ctx.now) !== 'connected') {
    out.push('Connect Zerodha first. Kite sessions end at 06:00 IST every day.');
  }
  if (ctx.jwtSecretIsDefault) {
    out.push('JWT_SECRET is the development default. Set it in BE/.env and restart the backend — otherwise anyone with the source could sign in as you and trade.');
  }
  if (ctx.envBroker !== 'paper') {
    out.push(`BROKER=${ctx.envBroker} in BE/.env already sends every user's orders to one account. Set BROKER=paper to use per-user connections.`);
  }
  if (ctx.openLotBooks.length) {
    out.push(
      `These paper books hold simulated lots that are not in your demat account: ${ctx.openLotBooks.join(', ')}. ` +
        'Clear them (Clear paper lots, below) or wait for them to sell first — live, the engine would try to sell shares Kite does not hold.',
    );
  }
  if (ctx.totpEnabled === false) {
    out.push('Turn on two-factor sign-in (Settings → Two-factor authentication). The live switch asks for its 6-digit code.');
  }
  if ((ctx.paperSweepUnits ?? 0) > 0) {
    out.push(
      `The cash sweep holds ${ctx.paperSweepUnits} simulated LIQUIDCASE unit(s) from paper trading. Live, they would be ` +
        'counted as cash parked from your real account and could block real buys. Clear them first.',
    );
  }
  if (ctx.openTrades > 0) {
    out.push(`${ctx.openTrades} open paper trade(s). Close them first.`);
  }
  if (ctx.simulatedData) {
    out.push('Market data is SIMULATED (DATA_SOURCE=sim, or the Zerodha feed failed to start). Real orders need real prices.');
  }
  if (!ctx.staticIpSet) {
    out.push('Set BROKER_STATIC_IP in BE/.env to the IP registered on your Kite developer app — Kite rejects orders from any other address (SEBI rule since 1 Apr 2026).');
  }
  return out;
}

/** Why live trading cannot be switched OFF right now. Empty = allowed. */
export function paperSwitchBlockers(ctx: { openTrades: number }): string[] {
  return ctx.openTrades > 0
    ? [`${ctx.openTrades} open live trade(s). Flatten them first — switching now would leave real intraday positions with nothing managing their exits.`]
    : [];
}

export type HoldingVerdict = 'ok' | 'shortfall' | 'surplus' | 'untracked';

/**
 * Broker quantity against book quantity.
 *
 * Only a SHORTFALL is dangerous: the book is enforcing breakevens on shares
 * that are not there. A surplus is shares held outside the bot (bought by hand,
 * or before the bot existed) — the bot's lots are still fully backed, so
 * halting would stop a healthy book for the user's own long-term holdings.
 */
export function classifyHolding(expected: number, actual: number): HoldingVerdict {
  if (expected === actual) return 'ok';
  if (expected === 0) return 'untracked';
  return actual < expected ? 'shortfall' : 'surplus';
}
