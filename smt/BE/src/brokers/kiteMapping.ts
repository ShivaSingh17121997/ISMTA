/**
 * Kite Connect wire formats → this application's broker contract.
 *
 * Pure, so every rule here that protects money is testable without a Zerodha
 * account. Field meanings follow kite.trade/docs/connect/v3 (orders, portfolio,
 * user) as read on 2026-09-14. Where the docs are silent, the choice is the one
 * that fails SAFE: a price is never invented and a balance is never overstated.
 */
import type { BrokerFunds, BrokerHolding, BrokerOrderResult } from './BaseBroker';

/**
 * Which Kite Connect product the key belongs to.
 *
 *   personal  free since March 2025 — orders, GTT, portfolio, margins. NO live
 *             quotes, WebSocket stream or historical candles.
 *   connect   ₹500/month per key — everything above plus the KiteTicker stream
 *             and historical data.
 */
export type KitePlan = 'personal' | 'connect';

const KITE_LOGIN = 'https://kite.zerodha.com/connect/login';
const IST_OFFSET_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;
const TERMINAL = new Set(['COMPLETE', 'REJECTED', 'CANCELLED']);

type Row = Record<string, unknown>;

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function obj(v: unknown): Row {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {};
}

function rows(v: unknown): Row[] {
  return Array.isArray(v) ? v.filter((r): r is Row => !!r && typeof r === 'object') : [];
}

/**
 * The Kite login page for one app. `redirect_params` is handed back verbatim on
 * the registered redirect URL, which is how the callback knows which user
 * started the login without trusting anything else in the query string.
 */
export function kiteLoginUrl(apiKey: string, state: string): string {
  const redirectParams = new URLSearchParams({ state }).toString();
  return `${KITE_LOGIN}?v=3&api_key=${encodeURIComponent(apiKey)}&redirect_params=${encodeURIComponent(redirectParams)}`;
}

/** Kite invalidates every access token at 06:00 IST (a regulatory requirement). The next such instant after `connectedAt`. */
export function kiteTokenExpiry(connectedAt: number): number {
  const d = new Date(connectedAt + IST_OFFSET_MS);
  let expiry = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 6) - IST_OFFSET_MS;
  if (expiry <= connectedAt) expiry += DAY_MS;
  return expiry;
}

/** The readable message inside whatever the SDK rejected with (an Error, or Kite's `{message, error_type}` body). */
export function kiteErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  const o = obj(e);
  if (o.message || o.error_type) return String(o.message ?? o.error_type);
  return String(e);
}

function errorType(e: unknown): string {
  return String(obj(e).error_type ?? '');
}

/**
 * Error types Kite returns when it has REFUSED an order — the order does not
 * exist. Anything else (a timeout, a dropped connection, a 5xx surfacing as
 * NetworkException/GeneralException/DataException) leaves the order's fate
 * unknown: Kite may have accepted it before the reply was lost.
 */
const DEFINITIVE_REFUSALS = new Set([
  'InputException', 'OrderException', 'TokenException', 'PermissionException',
  'MarginException', 'HoldingException', 'UserException',
]);

/** True when a placeOrder error proves the order was never created. */
export function isDefinitiveKiteRejection(e: unknown): boolean {
  return DEFINITIVE_REFUSALS.has(errorType(e));
}

/**
 * Kite's order `tag`: at most 20 alphanumerics. Derived from the caller's
 * idempotency key so the order can be found again when the reply to
 * placeOrder is lost. Deterministic (FNV-1a), so the same key gives the same tag.
 */
export function kiteOrderTag(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return `smt${h1.toString(36)}${h2.toString(36)}`.slice(0, 20);
}

/** The order id among Kite's order book rows carrying `tag`, or null. */
export function findKiteOrderByTag(orders: unknown, tag: string): string | null {
  const hit = rows(orders).find((r) => r.tag === tag || (Array.isArray(r.tags) && r.tags.includes(tag)));
  return hit?.order_id != null ? String(hit.order_id) : null;
}

/** The key's plan does not include what was asked for (quotes, stream, history on a free Personal key). */
export function isKitePermissionError(e: unknown): boolean {
  return (
    errorType(e) === 'PermissionException' ||
    /permission|not enabled|not subscribed|subscription|insufficient/i.test(kiteErrorMessage(e))
  );
}

/** The session is gone: expired at 06:00, logged out elsewhere, or revoked. */
export function isKiteTokenError(e: unknown): boolean {
  return errorType(e) === 'TokenException' || /incorrect `api_key` or `access_token`|token.*(expired|invalid)|session expired/i.test(kiteErrorMessage(e));
}

const DEPOSITORY = /\b(cdsl|tpin|e-?dis|ddpi|poa|authori[sz](e|ed|ation))\b/i;

/** A delivery SELL refused because the shares were not authorised for debit at the depository. */
export function isDepositoryAuthRejection(reason: string | undefined): boolean {
  return !!reason && DEPOSITORY.test(reason);
}

// Kite's wording for an app whose static IP is not set up (SEBI rule since 1 Apr 2026).
const APP_SETUP = /\b(no ips? configured|allowed ips?|ip (address )?(is )?not (allowed|whitelisted|registered)|unauthori[sz]ed ip|static ip)\b/i;

/**
 * An order refused because the Kite APP is not set up — today, its static IP.
 * Every order is refused the same way until the user fixes it in the Kite
 * developer console, so retrying each tick only hammers Kite.
 */
export function isAppSetupRejection(reason: string | undefined): boolean {
  return !!reason && APP_SETUP.test(reason);
}

export function describeKiteRejection(reason: string, side?: string): string {
  if (side !== 'BUY' && isDepositoryAuthRejection(reason)) {
    return (
      'Depository authorisation needed to sell: enable DDPI in Zerodha Console (one-time), or authorise ' +
      `these holdings with your CDSL TPIN for today. Kite said: ${reason}`
    );
  }
  return reason;
}

/**
 * The current state of an order from its /orders/:id history (last row wins).
 *
 * A CANCELLED order can still carry a partial fill, and those shares are real —
 * reporting it as a rejection would leave them in the demat account with no
 * lot recording them. So filled quantity decides FILLED, not the final state.
 */
export function mapKiteOrder(history: unknown, brokerOrderId: string): BrokerOrderResult {
  const list = rows(history);
  const o = list[list.length - 1];
  if (!o) throw new Error(`Zerodha returned no history for order ${brokerOrderId}`);

  const state = String(o.status ?? '').toUpperCase();
  const filledQuantity = num(o.filled_quantity);
  const averagePrice = num(o.average_price);
  const side = String(o.transaction_type ?? '').toUpperCase() || undefined;
  const message = String(o.status_message ?? o.status_message_raw ?? state);

  if (!TERMINAL.has(state)) return { brokerOrderId, status: 'PENDING', filledQuantity };

  if (state === 'REJECTED') {
    return { brokerOrderId, status: 'REJECTED', filledQuantity: 0, rejectionReason: describeKiteRejection(message, side) };
  }

  if (filledQuantity > 0) {
    // Shares traded but no price came back: report it as unresolved rather
    // than guess — every breakeven downstream is derived from this number.
    if (averagePrice <= 0) {
      return { brokerOrderId, status: 'PENDING', filledQuantity, rejectionReason: `${filledQuantity} filled but Kite reported no average price` };
    }
    return { brokerOrderId, status: 'FILLED', filledPrice: averagePrice, filledQuantity };
  }

  return {
    brokerOrderId,
    status: 'REJECTED',
    filledQuantity: 0,
    rejectionReason: state === 'CANCELLED' ? `cancelled with nothing filled (${message})` : 'completed with nothing filled',
  };
}

/**
 * Cash usable for a delivery (CNC) buy, from /user/margins/equity.
 *
 * NOT `net`: Kite documents net as intraday_payin + adhoc_margin + collateral,
 * and collateral — margin from pledged shares — funds intraday and F&O, never a
 * delivery purchase. `available.live_balance` is the current available balance;
 * when it is absent, raw cash less what is already debited.
 *
 * `unsettled` is 0. The endpoint has no field for unsettled sale proceeds —
 * `intraday_payin` is money DEPOSITED today, which the previous mapping
 * mislabelled — and a guessed figure here would be money that is not there.
 */
export function mapKiteFunds(margins: unknown, at: number): BrokerFunds {
  const m = obj(margins);
  const available = obj(m.available);
  const utilised = obj(m.utilised);
  const live = Number(available.live_balance);
  const debits = num(utilised.debits);
  const cash = Number.isFinite(live) ? live : num(available.cash) - debits;
  return { cash, usedMargin: debits, unsettled: 0, at, raw: m };
}

export interface KiteHeldRow extends BrokerHolding {
  /** holdings.quantity — settled shares */
  holdings: number;
  /** holdings.t1_quantity — bought yesterday, not yet settled */
  t1: number;
  /** Σ positions.net[CNC].quantity — bought (+) or sold (−) today */
  todayCnc: number;
  /** holdings.used_quantity — shown for checking only, never added */
  usedToday: number;
}

/**
 * What the account holds per symbol — the number reconciliation compares books to.
 *
 * Kite moves a delivery buy into /portfolio/holdings only the NEXT day; on the
 * day itself it exists only as a CNC row in /portfolio/positions. Reading
 * holdings alone reports every same-day buy as missing, so:
 *
 *   held = holdings.quantity + holdings.t1_quantity + Σ positions.net[CNC].quantity
 *
 * A holding sold today stays in `quantity` (flagged in `used_quantity`) and
 * shows as a negative CNC net position, so it is counted once. That last point
 * is inferred from the field definitions, not observed — the connection test
 * returns this breakdown so it can be checked against a real account.
 */
export function kiteHeldQuantities(holdings: unknown, positions: unknown): KiteHeldRow[] {
  const bySymbol = new Map<string, KiteHeldRow>();
  const rowFor = (symbol: string): KiteHeldRow => {
    let r = bySymbol.get(symbol);
    if (!r) {
      r = { symbol, quantity: 0, averagePrice: 0, holdings: 0, t1: 0, todayCnc: 0, usedToday: 0 };
      bySymbol.set(symbol, r);
    }
    return r;
  };

  for (const h of rows(holdings)) {
    const symbol = String(h.tradingsymbol ?? '').toUpperCase();
    if (!symbol) continue;
    const r = rowFor(symbol);
    r.holdings += num(h.quantity);
    r.t1 += num(h.t1_quantity);
    r.usedToday += num(h.used_quantity);
    if (num(h.average_price) > 0) r.averagePrice = num(h.average_price);
  }

  const net = Array.isArray(positions) ? positions : obj(positions).net;
  for (const p of rows(net)) {
    if (String(p.product ?? '').toUpperCase() !== 'CNC') continue;
    const symbol = String(p.tradingsymbol ?? '').toUpperCase();
    if (!symbol) continue;
    const r = rowFor(symbol);
    r.todayCnc += num(p.quantity);
    if (r.averagePrice <= 0 && num(p.average_price) > 0) r.averagePrice = num(p.average_price);
  }

  for (const r of bySymbol.values()) r.quantity = r.holdings + r.t1 + r.todayCnc;
  return [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}
