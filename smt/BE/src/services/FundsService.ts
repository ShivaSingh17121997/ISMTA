/**
 * How much money there actually is, and how much of it may be committed.
 *
 * THE BROKER IS THE ONLY SOURCE OF TRUTH FOR CASH.
 *
 * Nothing here keeps a cash ledger. Money arrives by UPI from a phone, leaves
 * as brokerage and taxes, and moves when a trade is placed by hand outside this
 * system — none of which this process can observe. A local balance would begin
 * drifting from the real one within a day and would then be confidently wrong,
 * which is worse than being obviously absent. So the balance is READ, cached
 * briefly, and never written.
 *
 * That is also why money added in a broker's mobile app "appears" here with no
 * synchronisation step. There is one account and one ledger; the app and this
 * service are two windows onto it. The next poll simply sees a larger number.
 *
 * ONE ACCOUNT PER BROKER, NOT ONE FOR THE SERVER
 *
 * A user trading live on their own Zerodha account has their own balance and
 * their own reservations. Paper users each get RISK_CAPITAL. The .env broker
 * (BROKER=zerodha/groww) is one account shared by everyone, so it is one pool.
 *
 * WHY RESERVATIONS EXIST
 *
 * A balance is only true until you spend against it. Three books deciding in
 * the same tick would each read the same ₹1,00,000 and each commit ₹40,000,
 * and the broker would reject the third — or, worse, accept all three on
 * margin the account cannot cover. So capital committed by an order that has
 * been sent but not yet resolved is held aside until it fills or fails.
 *
 * WHAT DEPLOYABLE MEANS
 *
 *   deployable = cash − reservations − charge buffer
 *
 * A LIVE BROKER THAT CANNOT BE READ HAS NO MONEY
 *
 * Paper falls back to RISK_CAPITAL. A live account does not: a failed read (an
 * expired session, Kite down) reads as ₹0, which stops new buys and nothing
 * else — exits are never gated on funds. Falling back to the configured figure
 * would have the allocator plan real orders against money nobody has checked.
 */

import { broker as serverBroker } from '../brokers';
import { BaseBroker, BrokerFunds } from '../brokers/BaseBroker';
import { brokerFor } from '../brokers/registry';
import { config } from '../config';
import { logger } from '../utils/logger';

/** How long a funds reading may be reused before it must be re-read. */
const TTL_MS = 30_000;
/**
 * A reservation older than this is assumed lost — a crash between placing an
 * order and recording its outcome would otherwise strand capital forever.
 * Deliberately longer than any order-resolution window.
 */
const RESERVATION_TTL_MS = 5 * 60_000;
/**
 * Fraction of a commitment held back for charges. Brokerage, STT, stamp duty,
 * GST and the DP charge are all debited from the same cash, and an account
 * with exactly enough for the shares has not got enough for the trade.
 */
const CHARGE_BUFFER_PCT = 0.5;

interface Reservation {
  id: string;
  account: string;
  symbol: string;
  amount: number;
  at: number;
}

interface Account {
  cached: BrokerFunds | null;
  inFlight: Promise<BrokerFunds> | null;
  lastError?: string;
  simulated: boolean;
}

export interface FundsSnapshot {
  /** What the broker last said. */
  cash: number;
  usedMargin: number;
  unsettled: number;
  /** Sum of capital held for orders in flight. */
  reserved: number;
  /** cash − reserved − charge buffer. What the allocator may plan against. */
  deployable: number;
  /** When the underlying figure was read from the broker. */
  at: number;
  brokerName: string;
  /**
   * True when this is `RISK_CAPITAL` rather than a real balance (paper mode).
   * The screen must say so: a number that looks live is how a person comes to
   * trust a figure that was never a balance.
   */
  simulated: boolean;
  /** Set when the last read failed, so the reason is visible rather than lost. */
  error?: string;
}

export class FundsService {
  private accounts = new Map<string, Account>();
  private reservations = new Map<string, Reservation>();

  /** Which ledger a user's orders draw on. */
  private resolve(userId?: string): { key: string; broker: BaseBroker } {
    const b = brokerFor(userId);
    if (b.name === 'paper') return { key: `paper:${userId ?? '-'}`, broker: b };
    if (b === serverBroker) return { key: `server:${b.name}`, broker: b };
    return { key: `user:${userId}`, broker: b };
  }

  private account(key: string): Account {
    let a = this.accounts.get(key);
    if (!a) {
      a = { cached: null, inFlight: null, simulated: true };
      this.accounts.set(key, a);
    }
    return a;
  }

  /**
   * The broker's funds for this user's account, cached for `TTL_MS`.
   *
   * Concurrent callers share one request: an engine tick can ask several times
   * and none of that should become several round trips.
   */
  async read(userId?: string, force = false, now = Date.now()): Promise<BrokerFunds> {
    const { key, broker } = this.resolve(userId);
    const acc = this.account(key);
    if (!force && acc.cached && now - acc.cached.at < TTL_MS) return acc.cached;
    if (acc.inFlight) return acc.inFlight;

    acc.inFlight = (async () => {
      try {
        const funds = await broker.getFunds();
        acc.cached = funds;
        acc.lastError = undefined;
        acc.simulated = broker.name === 'paper';
        return funds;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        acc.lastError = msg;
        logger.warn(`Funds read failed (${broker.name}, ${key}): ${msg}`);
        if (broker.name === 'paper') {
          acc.simulated = true;
          return acc.cached ?? { cash: config.risk.capital, usedMargin: 0, unsettled: 0, at: now };
        }
        // Fail closed, and cache the zero so a dead broker is not re-asked on every tick.
        acc.simulated = false;
        acc.cached = { cash: 0, usedMargin: 0, unsettled: 0, at: now };
        return acc.cached;
      } finally {
        acc.inFlight = null;
      }
    })();
    return acc.inFlight;
  }

  /** Drop reservations old enough that their order can no longer be pending. */
  private expire(now: number): void {
    for (const [id, r] of this.reservations) {
      if (now - r.at > RESERVATION_TTL_MS) {
        logger.warn(`Funds reservation ${id} (${r.symbol}, ₹${Math.round(r.amount)}) expired — releasing`);
        this.reservations.delete(id);
      }
    }
  }

  reserved(userId?: string, now = Date.now()): number {
    this.expire(now);
    const { key } = this.resolve(userId);
    let sum = 0;
    for (const r of this.reservations.values()) if (r.account === key) sum += r.amount;
    return sum;
  }

  /**
   * Hold capital for an order about to be sent. Returns false when the money
   * is not there, which is a normal outcome and not an error — the caller
   * should simply not place the order.
   */
  async reserve(id: string, symbol: string, amount: number, now = Date.now(), userId?: string): Promise<boolean> {
    if (amount <= 0) return true;
    const available = await this.deployable(userId, now);
    if (amount > available) {
      logger.warn(`Funds: refusing ₹${Math.round(amount)} for ${symbol} — only ₹${Math.round(available)} deployable`);
      return false;
    }
    this.reservations.set(id, { id, account: this.resolve(userId).key, symbol, amount, at: now });
    return true;
  }

  /** Release a reservation once the order has filled, failed, or been cancelled. */
  release(id: string): void {
    this.reservations.delete(id);
  }

  /** Cash the allocator may plan against, after reservations and charges. */
  async deployable(userId?: string, now = Date.now()): Promise<number> {
    const funds = await this.read(userId, false, now);
    const gross = funds.cash - this.reserved(userId, now);
    return Math.max(0, gross * (1 - CHARGE_BUFFER_PCT / 100));
  }

  /** Everything the funds panel needs, in one object. */
  async snapshot(userId?: string, now = Date.now()): Promise<FundsSnapshot> {
    const funds = await this.read(userId, false, now);
    const { key, broker } = this.resolve(userId);
    const acc = this.account(key);
    const reserved = this.reserved(userId, now);
    return {
      cash: funds.cash,
      usedMargin: funds.usedMargin,
      unsettled: funds.unsettled,
      reserved,
      deployable: Math.max(0, (funds.cash - reserved) * (1 - CHARGE_BUFFER_PCT / 100)),
      at: funds.at,
      brokerName: broker.name,
      simulated: acc.simulated,
      error: acc.lastError,
    };
  }
}

export const fundsService = new FundsService();
