import { config } from '../config';
import { marketData } from '../services/MarketDataService';
import { OrderRequest } from '../types';
import { logger } from '../utils/logger';
import { BaseBroker, BrokerFunds, BrokerOrderResult } from './BaseBroker';
import { roundToTick } from '../services/nse';
import {
  describeKiteRejection,
  findKiteOrderByTag,
  isDefinitiveKiteRejection,
  kiteErrorMessage,
  kiteOrderTag,
  kiteHeldQuantities,
  KiteHeldRow,
  mapKiteFunds,
  mapKiteOrder,
} from './kiteMapping';

/* eslint-disable @typescript-eslint/no-explicit-any */
type KiteClient = any;

const FILL_POLL_MS = 700;
const FILL_TIMEOUT_MS = 20_000;
/** How long to wait for Kite to confirm a cancel before giving up on it. */
const CANCEL_SETTLE_MS = 6_000;
/** How long to look for an order in Kite's book after placeOrder failed without a verdict. */
const LOOKUP_ATTEMPTS = 4;
const LOOKUP_GAP_MS = 1_500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ZerodhaBrokerOptions {
  /** The authenticated Kite client to use right now, or null when there is no session. */
  client: () => KiteClient | null;
  /** Why there is no client — becomes the rejection reason the engine logs. */
  unavailableReason?: () => string;
  /** Whose account this is, for logs. */
  label?: string;
}

/**
 * Live Zerodha adapter — places REAL orders on the exchange via Kite Connect.
 *
 * One instance per account. The client comes from a provider rather than a
 * singleton: a user's connection supplies their own session, the legacy .env
 * setup supplies its token, and an expired session supplies nothing, which
 * rejects every order with a reason instead of sending it anywhere else.
 *
 * FILLS ARE READ FROM KITE, NOT ASSUMED. `placeOrder` returning an order id
 * means the order was ACCEPTED, not executed — it can still be rejected at the
 * exchange, fill partially, or rest unfilled. The accumulator's no-loss rule is
 * enforced against a fee-inclusive breakeven derived from the fill price, so a
 * fabricated price would enforce the guarantee against a number the trade never
 * happened at. The order is polled to a terminal state and Kite's own average
 * price and filled quantity are reported.
 *
 * AN ORDER IS NEVER LEFT WORKING UNWATCHED. One still open after the poll window
 * is cancelled and re-read: anything that traded before the cancel is reported
 * as a (partial) fill, the rest is gone. Returning "pending" and walking away
 * would let it fill an hour later into a book that never recorded it — and let
 * the engine place the same order again on the next tick.
 */
export class ZerodhaBroker extends BaseBroker {
  readonly name = 'zerodha';

  constructor(private readonly opts: ZerodhaBrokerOptions) {
    super();
  }

  private get kc(): KiteClient | null {
    return this.opts.client();
  }

  private unavailable(): string {
    return this.opts.unavailableReason?.() ?? 'Zerodha not connected';
  }

  private tag(): string {
    return this.opts.label ? ` [${this.opts.label}]` : '';
  }

  isConnected(): boolean {
    return !!this.kc;
  }

  getLtp(symbol: string): number {
    return marketData.getPrice(symbol);
  }

  async placeOrder(req: OrderRequest): Promise<BrokerOrderResult> {
    const kc = this.kc;
    if (!kc) {
      const reason = this.unavailable();
      logger.warn(`Zerodha${this.tag()} order refused: ${reason}`);
      return { brokerOrderId: '', status: 'REJECTED', filledQuantity: 0, rejectionReason: reason };
    }

    // Found again by this tag if the reply to placeOrder is lost.
    const tag = kiteOrderTag(req.clientOrderId ?? `${req.symbol}:${req.side}:${req.quantity}:${req.price}:${Date.now()}`);
    // A price off NSE's tick ladder is rejected outright. Round in the
    // direction that can only help this account: sells up, buys down.
    const price =
      req.orderType === 'LIMIT' && req.price
        ? roundToTick(req.price, req.side === 'SELL' ? 'up' : 'down')
        : undefined;

    let orderId: string;
    try {
      const resp = await kc.placeOrder('regular', {
        exchange: 'NSE',
        tradingsymbol: req.symbol.toUpperCase(),
        transaction_type: req.side, // 'BUY' | 'SELL'
        quantity: req.quantity,
        product: req.product ?? 'MIS',
        order_type: req.orderType === 'LIMIT' ? 'LIMIT' : 'MARKET',
        ...(price ? { price } : {}),
        tag,
        // Kite rejects a market order with zero protection since 1 Apr 2026; -1
        // lets the broker choose its band so a thin book cannot fill it anywhere.
        ...(req.orderType === 'MARKET' ? { market_protection: config.zerodha.marketProtection } : {}),
      });
      orderId = String(resp.order_id);
    } catch (e) {
      const reason = describeKiteRejection(kiteErrorMessage(e), req.side);
      if (isDefinitiveKiteRejection(e)) {
        logger.error(`Zerodha${this.tag()} order rejected: ${reason}`);
        return { brokerOrderId: '', status: 'REJECTED', filledQuantity: 0, rejectionReason: reason };
      }
      // No verdict (timeout, dropped connection, 5xx). Kite may have taken the
      // order; calling it rejected would let the next tick send it again.
      logger.error(`Zerodha${this.tag()} placeOrder gave no verdict (${reason}) — looking for tag ${tag}`);
      const found = await this.findByTag(tag);
      if (!found) {
        return {
          brokerOrderId: '',
          status: 'PENDING',
          filledQuantity: 0,
          rejectionReason:
            `order state unknown: placeOrder failed with "${reason}" and no order tagged ${tag} ` +
            `could be confirmed in Kite. Check the Kite order book before clearing this halt.`,
        };
      }
      orderId = found;
    }

    logger.info(`Zerodha${this.tag()} order placed: ${req.side} ${req.quantity} ${req.symbol} (id ${orderId})`);
    return this.awaitFill(orderId, req);
  }

  /** The id of the order carrying `tag` in today's order book, or null when it cannot be confirmed. */
  private async findByTag(tag: string): Promise<string | null> {
    for (let i = 0; i < LOOKUP_ATTEMPTS; i++) {
      await sleep(LOOKUP_GAP_MS);
      const kc = this.kc;
      if (!kc) return null;
      try {
        const id = findKiteOrderByTag(await kc.getOrders(), tag);
        if (id) return id;
      } catch (e) {
        logger.debug(`Zerodha order-book lookup: ${kiteErrorMessage(e)}`);
      }
    }
    return null;
  }

  async cancelOrder(brokerOrderId: string): Promise<boolean> {
    const kc = this.kc;
    if (!kc) return false;
    try {
      await kc.cancelOrder('regular', brokerOrderId);
      return true;
    } catch (e) {
      logger.error(`Zerodha${this.tag()} cancelOrder ${brokerOrderId} failed: ${kiteErrorMessage(e)}`);
      return false;
    }
  }

  private async poll(orderId: string): Promise<BrokerOrderResult | null> {
    try {
      return await this.getOrder(orderId);
    } catch (e) {
      logger.debug(`Zerodha order poll ${orderId}: ${kiteErrorMessage(e)}`);
      return null;
    }
  }

  /** Poll Kite until the order settles; cancel it if it does not. Report what actually happened. */
  private async awaitFill(orderId: string, req: OrderRequest): Promise<BrokerOrderResult> {
    let last: BrokerOrderResult = { brokerOrderId: orderId, status: 'PENDING', filledQuantity: 0 };
    const deadline = Date.now() + FILL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(FILL_POLL_MS);
      const r = await this.poll(orderId);
      if (!r) continue;
      last = r;
      if (r.status !== 'PENDING') return this.settled(r, req);
    }

    logger.warn(`Zerodha${this.tag()} order ${orderId} still working after ${FILL_TIMEOUT_MS / 1000}s — cancelling`);
    const cancelSent = await this.cancelOrder(orderId);
    const settleBy = Date.now() + CANCEL_SETTLE_MS;
    while (Date.now() < settleBy) {
      await sleep(FILL_POLL_MS);
      const r = await this.poll(orderId);
      if (!r) continue;
      last = r;
      if (r.status !== 'PENDING') return this.settled(r, req);
    }

    const reason = cancelSent
      ? `still working after ${FILL_TIMEOUT_MS / 1000}s; the cancel was sent but Kite has not confirmed it`
      : `still working after ${FILL_TIMEOUT_MS / 1000}s and the cancel failed`;
    logger.error(`Zerodha${this.tag()} order ${orderId} ${reason} — it may still fill`);
    return { ...last, status: 'PENDING', rejectionReason: reason };
  }

  private settled(r: BrokerOrderResult, req: OrderRequest): BrokerOrderResult {
    if (r.status === 'FILLED' && r.filledQuantity < req.quantity) {
      logger.warn(`Zerodha${this.tag()} PARTIAL fill on ${r.brokerOrderId}: ${r.filledQuantity} of ${req.quantity} ${req.symbol}`);
    }
    return r;
  }

  async getOrder(brokerOrderId: string): Promise<BrokerOrderResult> {
    const kc = this.kc;
    if (!kc) throw new Error(this.unavailable());
    // getOrderHistory returns every state transition; the last is current.
    return mapKiteOrder(await kc.getOrderHistory(brokerOrderId), brokerOrderId);
  }

  /** Cash usable for a delivery buy — see mapKiteFunds for why this is not Kite's `net`. */
  async getFunds(): Promise<BrokerFunds> {
    const kc = this.kc;
    if (!kc) throw new Error(this.unavailable());
    return mapKiteFunds(await kc.getMargins('equity'), Date.now());
  }

  /**
   * Shares held per symbol, INCLUDING today's delivery buys (which Kite lists
   * under positions until tomorrow). Throws when Kite cannot be read, so
   * reconciliation counts a failure instead of treating it as "not supported".
   */
  async getHoldings(): Promise<KiteHeldRow[]> {
    const kc = this.kc;
    if (!kc) throw new Error(this.unavailable());
    const [holdings, positions] = await Promise.all([kc.getHoldings(), kc.getPositions()]);
    return kiteHeldQuantities(holdings, positions);
  }
}
