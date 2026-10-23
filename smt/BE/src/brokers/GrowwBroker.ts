/**
 * Groww trading API adapter.
 *
 * WHAT MONEY DOES AND DOES NOT DO HERE
 *
 * There is no deposit endpoint, and there never will be — a third party may not
 * move money into a broking account. Cash is added by the account holder in the
 * Groww app, by UPI or netbanking. This adapter only ever READS the balance.
 *
 * That is also why nothing needs syncing. The API authenticates as the account
 * holder against the same Groww account the phone uses; there is one ledger and
 * two windows onto it. Money added on the phone appears in `getFunds()` on the
 * next poll, because it is not a copy of the balance, it IS the balance.
 *
 * AUTHENTICATION
 *
 * Of Groww's three modes, only API key + TOTP survives unattended operation —
 * the other two expire or need a click every morning before the market opens.
 * See `utils/totp.ts`. The session token is cached until shortly before its
 * stated expiry and re-minted on demand, so a token dying mid-session costs one
 * extra request rather than a day of silence.
 *
 * FILLS ARE READ, NOT ASSUMED
 *
 * `placeOrder` returns when the order is ACKNOWLEDGED, which is not when it is
 * filled. This adapter then polls the order until it reaches a terminal state
 * and reports the broker's own average price and filled quantity. That matters
 * more here than anywhere else in the codebase: the accumulator's no-loss rule
 * is defined against a fee-inclusive breakeven computed from the fill price, so
 * an assumed price does not produce a small error — it produces a guarantee
 * that is arithmetically enforced against a number the trade never happened at.
 *
 * UNVERIFIED AGAINST THE LIVE API. Written from the published documentation;
 * no Groww credentials existed when it was built, so every request shape below
 * is unconfirmed. Field mapping is deliberately tolerant — several plausible
 * spellings are accepted for each number — and `verifyCredentials()` exists to
 * be run once, by hand, before this is ever pointed at real money.
 */

import { config } from '../config';
import { logger } from '../utils/logger';
import { roundToTick } from '../services/nse';
import { totp } from '../utils/totp';
import { OrderRequest } from '../types';
import { BaseBroker, BrokerFunds, BrokerHolding, BrokerOrderResult } from './BaseBroker';

const BASE = 'https://api.groww.in';
/** Re-mint this long before the token's stated expiry. */
const TOKEN_SAFETY_MS = 5 * 60_000;
/** How long to keep asking whether an order finished, and how often. */
const FILL_POLL_MS = 700;
const FILL_TIMEOUT_MS = 20_000;

/** Groww order states that mean "nothing more will happen to this order". */
const TERMINAL = new Set(['EXECUTED', 'COMPLETE', 'COMPLETED', 'FILLED', 'REJECTED', 'CANCELLED', 'CANCELED', 'FAILED']);
const REJECTED = new Set(['REJECTED', 'CANCELLED', 'CANCELED', 'FAILED']);

/** Pull the first present, numeric field from a set of candidate names. */
function pickNum(obj: Record<string, unknown> | undefined, ...keys: string[]): number {
  if (!obj) return 0;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    // Several Indian broker APIs return numbers as strings, sometimes padded.
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return 0;
}

function pickStr(obj: Record<string, unknown> | undefined, ...keys: string[]): string {
  if (!obj) return '';
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number') return String(v);
  }
  return '';
}

/** Follow a dotted path if present, so nested payload shapes still resolve. */
function at(obj: unknown, path: string): Record<string, unknown> | undefined {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur && typeof cur === 'object' ? (cur as Record<string, unknown>) : undefined;
}

/**
 * Map Groww's funds payload, wherever the numbers happen to live.
 *
 * Exported and pure so the mapping can be tested against captured payloads
 * without credentials — which is the only part of this adapter that can be
 * verified offline.
 */
export function mapFunds(payload: unknown, now: number): BrokerFunds {
  const root =
    at(payload, 'payload') ?? at(payload, 'data') ?? (payload as Record<string, unknown> | undefined);
  const equity = at(root, 'equity_margin_details') ?? at(root, 'equityMarginDetails') ?? root;

  const cash = pickNum(
    root,
    'clear_cash', 'clearCash', 'available_cash', 'availableCash', 'net_available_margin',
  ) || pickNum(equity, 'cnc_balance_available', 'cncBalanceAvailable', 'available_margin');

  return {
    cash,
    usedMargin: pickNum(root, 'net_margin_used', 'netMarginUsed', 'margin_used', 'marginUsed'),
    unsettled: pickNum(root, 'unsettled_credits', 'unsettledCredits', 'payin_amount', 'adhoc_margin'),
    at: now,
    raw: payload,
  };
}

/** Map one Groww order payload onto the adapter's result shape. Pure. */
export function mapOrder(payload: unknown, fallbackId: string): BrokerOrderResult {
  const o = at(payload, 'payload') ?? at(payload, 'data') ?? (payload as Record<string, unknown> | undefined);
  const state = pickStr(o, 'order_status', 'orderStatus', 'status').toUpperCase();
  const filledQuantity = pickNum(
    o, 'filled_quantity', 'filledQuantity', 'quantity_filled', 'quantityFilled', 'traded_quantity', 'tradedQuantity',
  );
  const avg = pickNum(
    o, 'average_fill_price', 'averageFillPrice', 'average_price', 'averagePrice',
    'avg_price', 'avgPrice', 'trade_price', 'tradePrice',
  );

  if (REJECTED.has(state)) {
    return {
      brokerOrderId: pickStr(o, 'groww_order_id', 'growwOrderId', 'order_id') || fallbackId,
      status: 'REJECTED',
      filledQuantity,
      rejectionReason: pickStr(o, 'remark', 'rejection_reason', 'remarks', 'message') || state || 'rejected',
    };
  }

  const done = TERMINAL.has(state);
  return {
    brokerOrderId: pickStr(o, 'groww_order_id', 'growwOrderId', 'order_id') || fallbackId,
    // Anything not terminal is still working. Reporting it as FILLED is the
    // exact mistake this adapter exists to avoid.
    status: done && filledQuantity > 0 ? 'FILLED' : done ? 'REJECTED' : 'PENDING',
    filledPrice: avg > 0 ? avg : undefined,
    filledQuantity,
    rejectionReason: done && filledQuantity === 0 ? 'closed with nothing filled' : undefined,
  };
}

export class GrowwBroker extends BaseBroker {
  readonly name = 'groww';

  private token: string | null = null;
  private tokenExpiresAt = 0;
  private minting: Promise<string> | null = null;
  private ltpCache = new Map<string, { price: number; at: number }>();

  isConnected(): boolean {
    return Boolean(config.groww.apiKey && config.groww.totpSecret);
  }

  // ── auth ──────────────────────────────────────────────────────────────────

  /**
   * A valid session token, minting one if needed.
   *
   * Concurrent callers share a single in-flight mint: Groww caps token
   * generation at 150 per 24 hours, which a few racing engine ticks could burn
   * through in a morning.
   */
  private async accessToken(now = Date.now()): Promise<string> {
    if (this.token && now < this.tokenExpiresAt - TOKEN_SAFETY_MS) return this.token;
    if (this.minting) return this.minting;

    this.minting = (async () => {
      const res = await fetch(`${BASE}/v1/token/api/access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          key_type: 'totp',
          totp: totp(config.groww.totpSecret),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Groww auth failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as Record<string, unknown>;
      const holder = at(body, 'payload') ?? at(body, 'data') ?? body;
      const token = pickStr(holder, 'token', 'access_token', 'accessToken');
      if (!token) throw new Error('Groww auth returned no token');

      // Groww's tokens expire at 06:00 daily. Trust an explicit expiry when one
      // is given; otherwise assume the next 06:00 IST rather than forever.
      const explicit = pickNum(holder, 'expires_at', 'expiresAt', 'expiry');
      this.tokenExpiresAt = explicit > 0 ? (explicit < 1e12 ? explicit * 1000 : explicit) : nextSixAmIst(Date.now());
      this.token = token;
      logger.info(`Groww access token minted, valid until ${new Date(this.tokenExpiresAt).toISOString()}`);
      return token;
    })();

    try {
      return await this.minting;
    } finally {
      this.minting = null;
    }
  }

  private async call<T>(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
    const token = await this.accessToken();
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-API-VERSION': '1.0',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) {
      // The token died early. Drop it so the next call mints a fresh one
      // rather than looping on a credential that will never work again.
      this.token = null;
      this.tokenExpiresAt = 0;
      throw new Error(`Groww rejected the session token (HTTP ${res.status})`);
    }
    if (!res.ok) throw new Error(`Groww ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  // ── market data ───────────────────────────────────────────────────────────

  /**
   * Last traded price.
   *
   * The interface is synchronous — it was written around a streaming feed that
   * always has a price in hand — so this serves the most recent cached quote
   * and refreshes in the background. A caller that has never seen this symbol
   * gets 0, which every caller already treats as "no market data".
   */
  getLtp(symbol: string): number {
    const hit = this.ltpCache.get(symbol.toUpperCase());
    void this.refreshLtp(symbol);
    return hit?.price ?? 0;
  }

  private async refreshLtp(symbol: string): Promise<void> {
    const key = symbol.toUpperCase();
    const hit = this.ltpCache.get(key);
    if (hit && Date.now() - hit.at < 1_000) return;
    try {
      const body = await this.call<Record<string, unknown>>(
        `/v1/live-data/ltp?segment=CASH&exchange_symbols=${encodeURIComponent(`NSE_${key}`)}`,
      );
      const holder = at(body, 'payload') ?? at(body, 'data') ?? body;
      const price = pickNum(holder, `NSE_${key}`, key, 'ltp', 'last_price');
      if (price > 0) this.ltpCache.set(key, { price, at: Date.now() });
    } catch (e) {
      logger.debug(`Groww LTP ${key}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ── orders ────────────────────────────────────────────────────────────────

  async placeOrder(req: OrderRequest): Promise<BrokerOrderResult> {
    if (!this.isConnected()) {
      return {
        brokerOrderId: '',
        status: 'REJECTED',
        filledQuantity: 0,
        rejectionReason: 'Groww not configured — set GROWW_API_KEY and GROWW_TOTP_SECRET',
      };
    }

    try {
      const body = await this.call<Record<string, unknown>>('/v1/order/create', {
        method: 'POST',
        body: JSON.stringify({
          trading_symbol: req.symbol.toUpperCase(),
          quantity: req.quantity,
          exchange: 'NSE',
          segment: 'CASH',
          product: req.product ?? 'CNC',
          order_type: req.orderType === 'LIMIT' ? 'LIMIT' : 'MARKET',
          transaction_type: req.side,
          validity: 'DAY',
          ...(req.orderType === 'LIMIT' && req.price ? { price: roundToTick(req.price) } : {}),
        }),
      });

      const ack = mapOrder(body, '');
      if (!ack.brokerOrderId) {
        return { brokerOrderId: '', status: 'REJECTED', filledQuantity: 0, rejectionReason: 'Groww returned no order id' };
      }
      logger.info(`Groww order placed: ${req.side} ${req.quantity} ${req.symbol} (id ${ack.brokerOrderId})`);
      if (ack.status === 'REJECTED') return ack;

      // Acknowledged is not filled. Ask until the broker says it is finished.
      return await this.awaitFill(ack.brokerOrderId, req);
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'Groww placeOrder failed';
      logger.error(`Groww order rejected: ${reason}`);
      return { brokerOrderId: '', status: 'REJECTED', filledQuantity: 0, rejectionReason: reason };
    }
  }

  /**
   * Poll until the order reaches a terminal state.
   *
   * A timeout returns PENDING rather than guessing. An order still working at
   * the end of this window is a real situation — a limit order resting away
   * from the market — and the honest report is that nothing is known yet, not
   * an invented fill.
   */
  private async awaitFill(orderId: string, req: OrderRequest): Promise<BrokerOrderResult> {
    const deadline = Date.now() + FILL_TIMEOUT_MS;
    let last: BrokerOrderResult = { brokerOrderId: orderId, status: 'PENDING', filledQuantity: 0 };

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, FILL_POLL_MS));
      try {
        last = await this.getOrder(orderId);
      } catch (e) {
        logger.debug(`Groww order poll ${orderId}: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      if (last.status === 'FILLED' || last.status === 'REJECTED') {
        if (last.status === 'FILLED' && last.filledQuantity < req.quantity) {
          logger.warn(
            `Groww PARTIAL fill on ${orderId}: ${last.filledQuantity} of ${req.quantity} ${req.symbol}`,
          );
        }
        return last;
      }
    }

    logger.warn(`Groww order ${orderId} still working after ${FILL_TIMEOUT_MS / 1000}s — reporting PENDING`);
    return last;
  }

  async getOrder(brokerOrderId: string): Promise<BrokerOrderResult> {
    const body = await this.call<Record<string, unknown>>(
      `/v1/order/detail/${encodeURIComponent(brokerOrderId)}?segment=CASH`,
    );
    return mapOrder(body, brokerOrderId);
  }

  async cancelOrder(brokerOrderId: string): Promise<boolean> {
    try {
      await this.call('/v1/order/cancel', {
        method: 'POST',
        body: JSON.stringify({ groww_order_id: brokerOrderId, segment: 'CASH' }),
      });
      return true;
    } catch (e) {
      logger.warn(`Groww cancel ${brokerOrderId}: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  // ── funds and holdings ────────────────────────────────────────────────────

  async getFunds(): Promise<BrokerFunds> {
    // Say what is actually wrong. Without this the failure surfaces from deep
    // inside the TOTP decoder as "secret is empty", which reads like a bug
    // rather than as "you have not configured this broker yet".
    if (!this.isConnected()) {
      throw new Error('Groww not configured — set GROWW_API_KEY and GROWW_TOTP_SECRET');
    }
    const body = await this.call<unknown>('/v1/margins/detail/user?segment=CASH');
    return mapFunds(body, Date.now());
  }

  async getHoldings(): Promise<BrokerHolding[] | null> {
    try {
      const body = await this.call<Record<string, unknown>>('/v1/holdings/user');
      const holder = at(body, 'payload') ?? at(body, 'data') ?? body;
      const rows = (holder?.holdings ?? holder?.data ?? []) as unknown[];
      if (!Array.isArray(rows)) return null;
      return rows
        .map((r) => {
          const o = r as Record<string, unknown>;
          return {
            symbol: pickStr(o, 'trading_symbol', 'tradingSymbol', 'symbol').toUpperCase(),
            quantity: pickNum(o, 'quantity', 'net_quantity', 'total_quantity'),
            averagePrice: pickNum(o, 'average_price', 'averagePrice', 'avg_price'),
          };
        })
        .filter((h) => h.symbol && h.quantity > 0);
    } catch (e) {
      logger.warn(`Groww holdings: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /**
   * One-shot credential check. Run `npm run groww:verify` BEFORE trading:
   * it proves the key and TOTP secret work, that the funds endpoint parses,
   * and that the balance seen here matches the Groww app — without placing an
   * order. This adapter has never spoken to the live API, so this check is the
   * difference between "should work" and "does work".
   */
  async verifyCredentials(): Promise<BrokerFunds> {
    if (!this.isConnected()) throw new Error('GROWW_API_KEY / GROWW_TOTP_SECRET are not set');
    await this.accessToken();
    return this.getFunds();
  }
}

/** Next 06:00 IST as an epoch, the hour Groww expires tokens. */
function nextSixAmIst(now: number): number {
  const IST = 5.5 * 3_600_000;
  const ist = now + IST;
  const day = Math.floor(ist / 86_400_000);
  const sixAm = day * 86_400_000 + 6 * 3_600_000;
  const next = ist < sixAm ? sixAm : sixAm + 86_400_000;
  return next - IST;
}
