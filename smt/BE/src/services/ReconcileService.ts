/**
 * Broker reconciliation on a schedule.
 *
 * The no-loss guarantee is arithmetic over lots with recorded fill prices. If
 * the shares are not really there — sold by hand in the broker's app, a
 * partial fill booked whole, a restart that lost a write — the guarantee is
 * being enforced against a fiction. The FIA's automated-trading controls call
 * drop-copy reconciliation the early warning for unintended trading; this is
 * that, at retail scale.
 *
 * Per ACCOUNT: each user trading live on their own Zerodha account is compared
 * with their own books; the .env broker is one account shared by every user.
 * Only books whose lots were bought live count — paper lots are not in any
 * demat account. Paper-only servers skip this entirely.
 *
 * Only a SHORTFALL halts a book (see classifyHolding): the book is enforcing
 * breakevens on shares that are not there. Shares held outside the bot are
 * reported, never halted on. And a shortfall must be seen on two consecutive
 * passes, because a sell that filled a moment ago can reach Kite's holdings
 * before the book closes the lot. Nothing is "corrected" automatically: the
 * human decides.
 */
import { BaseBroker, broker as serverBroker } from '../brokers';
import { anyLiveBroker, brokerFor } from '../brokers/registry';
import { config } from '../config';
import { store } from '../store/memoryStore';
import type { AccumulatorBook } from './accumulator/types';
import { brokerConnections } from './BrokerConnectionService';
import { cashSweep } from './CashSweepService';
import { accumulatorEngine } from './AccumulatorEngine';
import { classifyHolding, HoldingVerdict } from './brokerRules';
import { tradingHalt } from './guards';
import { notifier } from './Notifier';
import { logger } from '../utils/logger';

export interface ReconcileRow {
  symbol: string;
  expected: number;
  actual: number;
  difference: number;
  verdict?: HoldingVerdict;
}

export interface ReconcileResult {
  supported: boolean;
  at: number;
  reason: string;
  rows: ReconcileRow[];
  mismatched: ReconcileRow[];
  error?: string;
}

const STRIKES_TO_HALT = 2;
const FAILURES_TO_ALERT = 3;

interface Account {
  broker: BaseBroker;
  userIds: string[];
  shared: boolean;
}

export class ReconcileService {
  private timer: NodeJS.Timeout | null = null;
  private last: ReconcileResult | null = null;
  private failures = new Map<string, number>();
  private strikes = new Map<string, number>();

  /** Users grouped by the account their orders actually reach. Paper users are left out. */
  private accounts(onlyUserId?: string): Map<string, Account> {
    const ids = new Set<string>([...store.accumulatorBooks.values()].map((b) => b.userId));
    for (const u of brokerConnections.liveUserIds()) ids.add(u);
    const out = new Map<string, Account>();
    for (const userId of ids) {
      if (onlyUserId && userId !== onlyUserId) continue;
      const b = brokerFor(userId);
      if (b.name === 'paper') continue;
      const shared = b === serverBroker;
      const key = shared ? `server:${b.name}` : `user:${userId}`;
      const acct = out.get(key) ?? { broker: b, userIds: [], shared };
      acct.userIds.push(userId);
      out.set(key, acct);
    }
    return out;
  }

  /**
   * One pass. With `onlyUserId` it is a read-only report for that user: it
   * neither halts books nor counts strikes, because a shared account cannot be
   * judged from one user's books.
   */
  async run(reason = 'scheduled', onlyUserId?: string): Promise<ReconcileResult> {
    const at = Date.now();
    const reportOnly = !!onlyUserId;
    const accounts = this.accounts(onlyUserId);
    if (!accounts.size) {
      const r: ReconcileResult = { supported: false, at, reason, rows: [], mismatched: [] };
      if (!reportOnly) this.last = r;
      return r;
    }

    const rows: ReconcileRow[] = [];
    const mismatched: ReconcileRow[] = [];
    const errors: string[] = [];
    const halted: string[] = [];

    for (const [key, acct] of accounts) {
      // No session: every order to this account is already refused, so there is
      // nothing trading blind. Not a failure; the connection screen says why.
      if (!acct.broker.isConnected()) {
        errors.push(`${key}: not connected`);
        continue;
      }
      let held;
      try {
        held = await acct.broker.getHoldings();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${key}: ${msg}`);
        if (!reportOnly) this.onFailure(key, acct, msg);
        continue;
      }
      if (!held) continue;
      if (!reportOnly) {
        this.failures.delete(key);
        if (acct.shared) tradingHalt.clear('reconcile-unreachable');
      }

      const actualBy = new Map(held.map((h) => [h.symbol.toUpperCase(), h.quantity]));
      const expectedBy = new Map<string, number>();
      const booksBy = new Map<string, AccumulatorBook[]>();
      for (const userId of acct.userIds) {
        for (const b of store.accumulatorBooksByUser(userId)) {
          if (b.venue !== 'live') continue;
          const sym = b.symbol.toUpperCase();
          expectedBy.set(sym, (expectedBy.get(sym) ?? 0) + b.openLots.reduce((s, l) => s + l.quantity, 0));
          booksBy.set(sym, [...(booksBy.get(sym) ?? []), b]);
        }
      }
      // Units the idle-cash sweep parked on this live account.
      const sweepUsersBy = new Map<string, string[]>();
      for (const userId of acct.userIds) {
        const sw = store.cashSweeps.get(userId);
        if (!sw || sw.venue !== 'live') continue;
        const units = sw.lots.reduce((n, l) => n + l.quantity, 0);
        if (units === 0) continue;
        const sym = sw.symbol.toUpperCase();
        expectedBy.set(sym, (expectedBy.get(sym) ?? 0) + units);
        sweepUsersBy.set(sym, [...(sweepUsersBy.get(sym) ?? []), userId]);
      }

      for (const sym of new Set([...expectedBy.keys(), ...actualBy.keys()])) {
        const expected = expectedBy.get(sym) ?? 0;
        const actual = actualBy.get(sym) ?? 0;
        const verdict = classifyHolding(expected, actual);
        if (verdict === 'ok' && expected === 0) continue;
        const row: ReconcileRow = { symbol: sym, expected, actual, difference: actual - expected, verdict };
        rows.push(row);
        const strikeKey = `${key}:${sym}`;
        if ((verdict === 'surplus' || verdict === 'untracked') && booksBy.has(sym)) {
          // Extra shares are usually the user's own, and halting on them would
          // stop a healthy book. But a buy the engine filled and never booked
          // looks exactly like this, so check the order ledger: halt only when
          // it shows an engine fill missing from the book. 'untracked' too: a
          // book's FIRST fill going unbooked leaves it expecting zero shares.
          const unbooked = reportOnly
            ? []
            : accumulatorEngine.haltUnbookedFills(at, { symbol: sym, userIds: acct.userIds }).filter((u) => !u.bookMissing);
          if (unbooked.length) {
            mismatched.push(row);
            halted.push(sym);
            store.audit({ userId: unbooked[0].userId, kind: 'reconcile', symbol: sym, detail: `halted: broker ${actual} vs books ${expected}; ${unbooked.map((u) => u.reason).join('; ')}` });
          }
        }
        if (verdict !== 'shortfall') {
          this.strikes.delete(strikeKey);
          continue;
        }
        mismatched.push(row);
        if (reportOnly) continue;
        const strikes = (this.strikes.get(strikeKey) ?? 0) + 1;
        this.strikes.set(strikeKey, strikes);
        // Missing parked units stop the sweep; the books' lots are not in question.
        if (strikes >= STRIKES_TO_HALT) {
          for (const userId of sweepUsersBy.get(sym) ?? []) {
            cashSweep.halt(userId, `reconciliation: broker holds ${actual} ${sym}, the sweep and books expect ${expected}`, at);
          }
        }
        for (const b of booksBy.get(sym) ?? []) {
          if (strikes < STRIKES_TO_HALT) {
            store.audit({ userId: b.userId, kind: 'reconcile', symbol: sym, detail: `broker holds ${actual}, books expect ${expected} — halts if still short on the next pass` });
            continue;
          }
          if (b.haltedReason) continue;
          b.haltedReason = `reconciliation: broker holds ${actual}, book expects ${expected}`;
          b.updatedAt = at;
          store.saveAccumulatorBook(b);
          halted.push(sym);
          store.audit({ userId: b.userId, kind: 'reconcile', symbol: sym, detail: `halted: broker ${actual} vs books ${expected} (${actual - expected})` });
        }
      }
    }

    if (halted.length) {
      void notifier.alert('critical', 'reconcile', `Reconciliation mismatch on ${[...new Set(halted)].join(', ')} — affected books halted`);
      logger.warn(`Reconciliation halted books: ${halted.join(', ')}`);
    }
    const result: ReconcileResult = {
      supported: true,
      at,
      reason,
      rows: rows.sort((a, b) => a.symbol.localeCompare(b.symbol)),
      mismatched,
      error: errors.length ? errors.join('; ') : undefined,
    };
    if (!reportOnly) this.last = result;
    return result;
  }

  private onFailure(key: string, acct: Account, msg: string): void {
    const n = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, n);
    if (n < FAILURES_TO_ALERT) return;
    if (acct.shared) {
      // One account for everyone: we cannot see it, so nobody trades blind.
      tradingHalt.set('reconcile-unreachable', `broker holdings unreadable ${n} times: ${msg}`);
      void notifier.alert('critical', 'reconcile-unreachable', `Cannot read broker holdings (${msg}); trading halted`);
    } else {
      void notifier.alert('critical', `reconcile-unreachable:${key}`, `Cannot read Zerodha holdings for ${acct.userIds.join(', ')} ${n} times (${msg}) — their books are not being checked`);
    }
  }

  status(): { last: ReconcileResult | null; everyMin: number; enabled: boolean } {
    return { last: this.last, everyMin: config.guards.reconcileEveryMin, enabled: anyLiveBroker() };
  }

  /** Runs on a timer whenever any account is live; a user can switch to live without a restart. */
  start(): void {
    if (this.timer || config.guards.reconcileEveryMin <= 0) return;
    this.timer = setInterval(() => {
      if (anyLiveBroker()) void this.run();
    }, config.guards.reconcileEveryMin * 60_000);
    this.timer.unref?.();
    if (anyLiveBroker()) void this.run('boot');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const reconcileService = new ReconcileService();
