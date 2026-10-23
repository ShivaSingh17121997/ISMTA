/**
 * Daily equity snapshots — the raw material of the NAV curve.
 *
 * One row per user per IST trading day, written after the close (and on
 * demand). Equity is the sum of what the account actually holds:
 *   paper : RISK_CAPITAL + every book's banked and unrealised P&L + the
 *           strategy engine's realised-to-date and open marks
 *   live  : broker cash + unsettled + every open lot at the mark + strategy marks
 *
 * The benchmark close (NIFTY 50) is stored beside it so the curve can be drawn
 * without a second fetch per day, and a day it could not be fetched is left
 * null rather than interpolated.
 */
import { config } from '../config';
import { store } from '../store/memoryStore';
import { EquitySnapshot } from '../types';
import { logger } from '../utils/logger';
import { reportFor } from './AccumulatorEngine';
import { broker } from '../brokers';
import { fundsService } from './FundsService';
import { cashSweep } from './CashSweepService';
import { istParts, isTradingDay } from './session';
import { inLiveWindow, venueOfRecord, venueViewFor } from './venueView';
import { fetchYahooLtp } from './yahoo';

export function snapshotKey(userId: string, day: string): string {
  return `${userId}:${day}`;
}

/** Everything the snapshot needs, computed from the store at `now`. Pure apart from LTPs. */
export function computeEquity(userId: string, funds: { cash: number; unsettled: number }, simulated: boolean) {
  const books = store.accumulatorBooksByUser(userId);
  // A live account's realised figures count only what it traded: sold lots
  // bought live, and trades opened after the switch (services/venueView).
  const view = venueViewFor(userId);
  const liveOnly = !simulated && view.venue === 'live';
  const lotCounts = (l: { venue?: 'paper' | 'live' }) => !liveOnly || venueOfRecord(l) === 'live';
  let bookPnl = 0;
  let bookMarketValue = 0;
  let deployed = 0;
  let realised = 0;
  let cleared = 0;
  let charges = 0;
  for (const b of books) {
    const mark = broker.getLtp(b.symbol) || b.lastPrice || b.previousClose || 0;
    const r = reportFor(b, mark);
    bookPnl += r.bankedProfit + r.unrealisedPnl + r.clearedPnl;
    cleared += r.clearedPnl;
    deployed += r.deployed;
    bookMarketValue += r.deployed + r.unrealisedPnl;
    realised += liveOnly ? b.closedLots.filter(lotCounts).reduce((s, l) => s + l.pnl, 0) : r.bankedProfit;
    for (const l of b.closedLots) {
      if (!lotCounts(l)) continue;
      // charges = what left the account beyond the shares' price, both legs
      charges += Math.max(0, l.quoteSpent - l.fillPrice * l.quantity) + Math.max(0, l.sellPrice * l.quantity - l.proceeds);
    }
  }
  let stratRealised = 0;
  let stratCharges = 0;
  for (const t of store.tradesByUser(userId)) {
    if (t.invalid) continue;
    if (liveOnly && !inLiveWindow(t.openedAt, view)) continue;
    if (t.status === 'CLOSED') {
      stratRealised += t.pnl;
      stratCharges += t.charges ?? 0;
    }
  }
  let stratUnrealised = 0;
  for (const p of store.positionsByUser(userId)) {
    const ltp = broker.getLtp(p.symbol) || p.ltp;
    stratUnrealised += (ltp - p.avgPrice) * p.quantity;
    deployed += Math.abs(p.quantity) * p.avgPrice;
  }
  // The idle-cash sweep: paper cash never moved, so only its income counts;
  // a live account's cash fell by what was parked, so the units count whole.
  const sweepGain = cashSweep.gain(userId);
  const sweepValue = cashSweep.marketValue(userId);
  const equity = simulated
    ? config.risk.capital + bookPnl + stratRealised + stratUnrealised + sweepGain
    : funds.cash + funds.unsettled + bookMarketValue + stratUnrealised + sweepValue;
  return {
    equity: Math.round(equity * 100) / 100,
    cash: Math.round((simulated ? config.risk.capital - deployed + realised + cleared + stratRealised : funds.cash) * 100) / 100,
    deployed: Math.round(deployed * 100) / 100,
    realisedToDate: Math.round((realised + stratRealised) * 100) / 100,
    chargesToDate: Math.round((charges + stratCharges) * 100) / 100,
  };
}

export class SnapshotService {
  private timer: NodeJS.Timeout | null = null;
  private lastDay = '';

  /** Write today's snapshot for every user. Idempotent per day (overwrites). */
  async takeAll(now: number = Date.now(), reason = 'scheduled'): Promise<EquitySnapshot[]> {
    const day = istParts(now).date;
    const nifty = await fetchYahooLtp('NIFTY').catch(() => null);
    const out: EquitySnapshot[] = [];
    for (const user of store.users.values()) {
      // Each user's own account: their Zerodha balance when trading live, paper capital otherwise.
      const funds = await fundsService.snapshot(user.id).catch(() => null);
      const eq = computeEquity(
        user.id,
        { cash: funds?.cash ?? config.risk.capital, unsettled: funds?.unsettled ?? 0 },
        funds?.simulated ?? true,
      );
      const snap: EquitySnapshot = {
        userId: user.id,
        day,
        at: now,
        ...eq,
        flow: 0,
        venue: (funds?.simulated ?? true) ? 'paper' : 'live',
        nifty: nifty ?? undefined,
      };
      store.equitySnapshots.set(snapshotKey(user.id, day), snap);
      out.push(snap);
    }
    this.lastDay = day;
    logger.info(`Equity snapshot ${day} (${reason}): ${out.map((s) => `₹${s.equity.toLocaleString('en-IN')}`).join(', ')}${nifty ? ` · NIFTY ${nifty}` : ''}`);
    return out;
  }

  /**
   * Once a minute: after 15:35 IST on a trading day, if today's row is missing,
   * write it. Boot-safe — a restart at 18:00 still records the day.
   */
  start(): void {
    if (this.timer) return;
    const tick = async () => {
      const now = Date.now();
      if (!isTradingDay(now)) return;
      const { date, minutes } = istParts(now);
      if (minutes < 15 * 60 + 35 || this.lastDay === date) return;
      const anyUser = [...store.users.values()][0];
      if (anyUser && store.equitySnapshots.has(snapshotKey(anyUser.id, date))) {
        this.lastDay = date;
        return;
      }
      await this.takeAll(now).catch((e) => logger.error(`snapshot failed: ${e?.message ?? e}`));
    };
    this.timer = setInterval(() => void tick(), 60_000);
    this.timer.unref?.();
    void tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const snapshotService = new SnapshotService();
