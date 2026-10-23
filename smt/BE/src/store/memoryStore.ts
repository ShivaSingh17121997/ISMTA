import { Model } from 'mongoose';
import { v4 as uuid } from 'uuid';
import {
  AuditEntry,
  BacktestRun,
  BrokerConnection,
  EquitySnapshot,
  JournalNote,
  Order,
  Position,
  StrategyConfig,
  Trade,
  Trigger,
  User,
  UserRiskState,
  Watchlist,
} from '../types';
import type { AccumulatorBook } from '../services/accumulator/types';
import type { AllocatorRun } from '../services/allocator/allocate';
import type { RecommendationRun } from '../services/RecommenderEngine';
import type { FutureStarsRun } from '../services/futurestars/types';
import type { TurnaroundRun } from '../services/turnaround/types';
import type { Instrument } from '../services/instruments';
import type { SweepState } from '../services/sweep/plan';
import { logger } from '../utils/logger';
import { isMongoConnected } from './db';
import {
  AccumulatorBookModel,
  AllocatorRunModel,
  AuditLogModel,
  BacktestRunModel,
  BrokerConnectionModel,
  CashSweepModel,
  DailyPnlModel,
  EquitySnapshotModel,
  InstrumentModel,
  JournalModel,
  OrderModel,
  PositionModel,
  RecommendationRunModel,
  FutureStarsRunModel,
  TurnaroundRunModel,
  RiskStateModel,
  StrategyModel,
  TradeModel,
  TriggerModel,
  UserModel,
  WatchlistModel,
} from './models';

/**
 * Write-through map: an in-memory cache that mirrors one MongoDB collection.
 *
 * Reads hit RAM and stay synchronous — the live trading loop (ticks, fills,
 * risk checks) depends on that. Writes update RAM immediately and are persisted
 * to MongoDB in the background. On boot, `hydrate()` reloads the cache from
 * MongoDB so data survives restarts and shows up in MongoDB Compass. If MongoDB
 * is down, it silently degrades to cache-only.
 *
 * WRITES ARE ORDERED PER KEY. They used to be fire-and-forget upserts, and two
 * writes to the same document in quick succession (PENDING, then FILLED) could
 * land in either order. The evidence was a stored order that was PENDING with
 * zero filled quantity yet carried the fill price and charges only the later
 * write knew — after a restart the order book said an exit never happened
 * while the trade book said it did. Each key now has its own promise chain, so
 * the last write in program order is the last write in the database.
 *
 * The document is REPLACED, not `$set`, so a snapshot is a true snapshot: a
 * field the object no longer has is gone from the database too.
 */
interface PersistentMapOptions {
  /**
   * Restore a missing top-level `id` on hydrate. `'key'` copies the Mongo
   * `_id` (collections keyed by the object's own id); a function mints one.
   * Exists because documents written through replaceOne while mongoose's `id`
   * virtual was enabled lost the field; healed rows are re-persisted.
   */
  healId?: 'key' | ((key: string) => string);
}

class PersistentMap<T extends object> {
  private cache = new Map<string, T>();
  private chains = new Map<string, Promise<void>>();

  constructor(
    private readonly model: Model<Record<string, unknown>>,
    private readonly options: PersistentMapOptions = {},
  ) {}

  /** Load this collection from MongoDB into the cache. Returns the row count. */
  async hydrate(): Promise<number> {
    if (!isMongoConnected()) return 0;
    const docs = await this.model.find().lean();
    const healed: string[] = [];
    for (const doc of docs) {
      const { _id, ...rest } = doc as Record<string, unknown> & { _id: string };
      const key = String(_id);
      if (this.options.healId && (rest.id === undefined || rest.id === null)) {
        rest.id = this.options.healId === 'key' ? key : this.options.healId(key);
        healed.push(key);
      }
      this.cache.set(key, rest as unknown as T);
    }
    if (healed.length) {
      logger.warn(`${this.model.modelName}: restored a missing id on ${healed.length} document(s); re-persisting`);
      for (const key of healed) this.set(key, this.cache.get(key)!);
    }
    return docs.length;
  }

  get(key: string): T | undefined {
    return this.cache.get(key);
  }
  has(key: string): boolean {
    return this.cache.has(key);
  }
  get size(): number {
    return this.cache.size;
  }
  values(): IterableIterator<T> {
    return this.cache.values();
  }
  entries(): IterableIterator<[string, T]> {
    return this.cache.entries();
  }
  keys(): IterableIterator<string> {
    return this.cache.keys();
  }

  set(key: string, value: T): this {
    this.cache.set(key, value);
    if (isMongoConnected()) {
      const doc: Record<string, unknown> = { ...(value as Record<string, unknown>) };
      delete doc._id; // _id is immutable; it comes from the filter on upsert
      this.enqueue(key, () => this.model.replaceOne({ _id: key }, doc, { upsert: true }).then(() => undefined));
    }
    return this;
  }

  delete(key: string): boolean {
    const existed = this.cache.delete(key);
    if (isMongoConnected()) {
      this.enqueue(key, () => this.model.deleteOne({ _id: key }).then(() => undefined));
    }
    return existed;
  }

  /** Keys whose most recent write failed, with the reason. Cleared by the next write that lands. */
  private failed = new Map<string, string>();

  /** Serialise writes to one key. A failure is logged and does not block the next write. */
  private enqueue(key: string, op: () => Promise<void>): void {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next: Promise<void> = prev
      .then(op)
      .then(() => {
        this.failed.delete(key);
      })
      .catch((e) => {
        const msg = e?.message ?? String(e);
        this.failed.set(key, msg);
        logger.error(`persist ${this.model.modelName}/${key} failed: ${msg}`);
      })
      .then(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    this.chains.set(key, next);
  }

  /** Resolves once every queued write has reached the database. For shutdown and tests. */
  async flush(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  /**
   * Waits for the writes queued so far for ONE key, then says whether they
   * landed: null when the latest write reached MongoDB, otherwise why not
   * (the write failed, or the database is not connected so nothing was written).
   */
  async flushKey(key: string): Promise<string | null> {
    await this.chains.get(key);
    if (!isMongoConnected()) return 'the database is not connected';
    return this.failed.get(key) ?? null;
  }
}

/**
 * Domain data store. Backed by MongoDB via write-through caches above, but the
 * public surface stays the same Map-like API the routes/services already use,
 * so swapping persistence in needed no changes outside this file.
 */
class MemoryStore {
  users = new PersistentMap<User>(UserModel, { healId: 'key' });
  strategies = new PersistentMap<StrategyConfig>(StrategyModel, { healId: 'key' });
  orders = new PersistentMap<Order>(OrderModel, { healId: 'key' });
  trades = new PersistentMap<Trade>(TradeModel, { healId: 'key' });
  /** positions keyed by `${userId}:${symbol}` */
  positions = new PersistentMap<Position>(PositionModel);
  /**
   * Risk-gate state per user (kill switch, loss streak, cooldown).
   * Persisted because a circuit breaker a restart silently releases is worse
   * than no breaker: three losses halt entries, ops deploys, and trading resumes
   * straight back into the conditions that produced them.
   */
  riskState = new PersistentMap<UserRiskState>(RiskStateModel);
  /**
   * Accumulator books, keyed by `${userId}:${symbol}`.
   *
   * Persisted for the same reason the risk state is: a book a restart forgets
   * would re-buy rungs it already holds, and the engine can never sell those
   * duplicates at a loss to unwind the mistake.
   */
  accumulatorBooks = new PersistentMap<AccumulatorBook>(AccumulatorBookModel, { healId: () => uuid() });
  /** NSE listed-company master, keyed by symbol. Reference data, refreshed daily. */
  instruments = new PersistentMap<Instrument>(InstrumentModel);
  /**
   * Capital-allocator passes, keyed by userId:tradingDay. Persisted so a
   * restart knows today already ran and does not re-shuffle budgets.
   */
  allocatorRuns = new PersistentMap<AllocatorRun>(AllocatorRunModel);
  /** Recommendation runs, keyed by userId:tradingDay. */
  recommendationRuns = new PersistentMap<RecommendationRun>(RecommendationRunModel);
  /** Future-stars runs, keyed by userId:tradingDay. */
  futureStarsRuns = new PersistentMap<FutureStarsRun>(FutureStarsRunModel);
  /** Turnaround runs, keyed by userId:tradingDay. */
  turnaroundRuns = new PersistentMap<TurnaroundRun>(TurnaroundRunModel);
  /** Every backtest, keyed by run id. The trial ledger behind deflated Sharpe. */
  backtestRuns = new PersistentMap<BacktestRun>(BacktestRunModel, { healId: 'key' });
  /** Watchlists, keyed by id. */
  watchlists = new PersistentMap<Watchlist>(WatchlistModel, { healId: 'key' });
  /** Standing triggers (GTT / OCO / trailing), keyed by id. */
  triggers = new PersistentMap<Trigger>(TriggerModel, { healId: 'key' });
  /** Daily equity snapshots, keyed by userId:tradingDay. */
  equitySnapshots = new PersistentMap<EquitySnapshot>(EquitySnapshotModel);
  /** Journal notes keyed by trade id. */
  journal = new PersistentMap<JournalNote>(JournalModel);
  /** Each user's own broker app (plan, trading mode, session, sealed secrets), keyed `<userId>:zerodha`. */
  brokerConnections = new PersistentMap<BrokerConnection>(BrokerConnectionModel);
  /** Idle-cash sweep state, keyed by userId. */
  cashSweeps = new PersistentMap<SweepState>(CashSweepModel);
  /** realised P&L booked per user for the current trading day */
  private dailyPnl = new Map<string, number>();

  /** Last N audit entries, for a process running without MongoDB. */
  private auditRing: AuditEntry[] = [];
  private auditChain: Promise<void> = Promise.resolve();
  private auditSeq = 0;

  /** Reload every collection from MongoDB into the in-memory caches. */
  async hydrate(): Promise<void> {
    if (!isMongoConnected()) return;
    const [u, s, o, t, p, r, a, i, al, rr, fsr, tur, br, w, tr, es, j, bc, cs] = await Promise.all([
      this.users.hydrate(),
      this.strategies.hydrate(),
      this.orders.hydrate(),
      this.trades.hydrate(),
      this.positions.hydrate(),
      this.riskState.hydrate(),
      this.accumulatorBooks.hydrate(),
      this.instruments.hydrate(),
      this.allocatorRuns.hydrate(),
      this.recommendationRuns.hydrate(),
      this.futureStarsRuns.hydrate(),
      this.turnaroundRuns.hydrate(),
      this.backtestRuns.hydrate(),
      this.watchlists.hydrate(),
      this.triggers.hydrate(),
      this.equitySnapshots.hydrate(),
      this.journal.hydrate(),
      this.brokerConnections.hydrate(),
      this.cashSweeps.hydrate(),
    ]);
    const pnlDocs = await DailyPnlModel.find().lean();
    for (const d of pnlDocs as Array<{ _id: string; pnl?: number }>) {
      this.dailyPnl.set(String(d._id), Number(d.pnl) || 0);
    }
    logger.info(
      `Hydrated from MongoDB — users:${u} strategies:${s} orders:${o} trades:${t} ` +
        `positions:${p} pnl:${pnlDocs.length} risk:${r} accumulator:${a} instruments:${i} ` +
        `allocator:${al} recs:${rr} futureStars:${fsr} turnarounds:${tur} backtests:${br} watchlists:${w} triggers:${tr} snapshots:${es} journal:${j} brokers:${bc} sweeps:${cs}`,
    );
  }

  /** Wait for every pending write. Called on shutdown so a fill is never lost to a restart. */
  async flush(): Promise<void> {
    await Promise.all([
      this.users.flush(),
      this.strategies.flush(),
      this.orders.flush(),
      this.trades.flush(),
      this.positions.flush(),
      this.riskState.flush(),
      this.accumulatorBooks.flush(),
      this.instruments.flush(),
      this.allocatorRuns.flush(),
      this.recommendationRuns.flush(),
      this.futureStarsRuns.flush(),
      this.turnaroundRuns.flush(),
      this.backtestRuns.flush(),
      this.watchlists.flush(),
      this.triggers.flush(),
      this.equitySnapshots.flush(),
      this.journal.flush(),
      this.brokerConnections.flush(),
      this.cashSweeps.flush(),
      this.auditChain,
    ]);
  }

  // ── audit trail ──

  /**
   * Append one audit entry. Never blocks the caller; writes are serialised so
   * the database order is the program order. Returns the entry for logging.
   */
  audit(entry: Omit<AuditEntry, 'id' | 'at'> & { at?: number }): AuditEntry {
    this.auditSeq += 1;
    const at = entry.at ?? Date.now();
    const full: AuditEntry = { ...entry, at, id: `${at}-${this.auditSeq}` };
    this.auditRing.push(full);
    if (this.auditRing.length > 5_000) this.auditRing = this.auditRing.slice(-5_000);
    if (isMongoConnected()) {
      const doc = { ...full, _id: full.id } as Record<string, unknown>;
      delete doc.id;
      this.auditChain = this.auditChain
        .then(() => AuditLogModel.create(doc).then(() => undefined))
        .catch((e) => {
          logger.error(`audit append failed: ${e?.message ?? e}`);
        });
    }
    return full;
  }

  /** Recent audit entries, newest first. Reads Mongo when connected, else the ring. */
  async auditEntries(filter: { userId?: string; kind?: string; symbol?: string; since?: number; limit?: number } = {}): Promise<AuditEntry[]> {
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 2_000);
    if (isMongoConnected()) {
      const q: Record<string, unknown> = {};
      if (filter.userId) q.userId = filter.userId;
      if (filter.kind) q.kind = filter.kind;
      if (filter.symbol) q.symbol = filter.symbol.toUpperCase();
      if (filter.since) q.at = { $gte: filter.since };
      const docs = await AuditLogModel.find(q).sort({ at: -1 }).limit(limit).lean();
      return docs.map((d) => {
        const { _id, ...rest } = d as Record<string, unknown> & { _id: string };
        return { ...(rest as Omit<AuditEntry, 'id'>), id: String(_id) };
      });
    }
    return this.auditRing
      .filter((e) => (!filter.userId || e.userId === filter.userId))
      .filter((e) => (!filter.kind || e.kind === filter.kind))
      .filter((e) => (!filter.symbol || e.symbol === filter.symbol.toUpperCase()))
      .filter((e) => (!filter.since || e.at >= filter.since))
      .slice(-limit)
      .reverse();
  }

  // ── users ──
  /** Case- and space-insensitive: "Me@Mail.com " finds "me@mail.com". */
  findUserByEmail(email: string): User | undefined {
    const e = String(email ?? '').trim().toLowerCase();
    return [...this.users.values()].find((u) => u.email.trim().toLowerCase() === e);
  }

  // ── strategies ──
  strategiesByUser(userId: string): StrategyConfig[] {
    return [...this.strategies.values()].filter((s) => s.userId === userId);
  }
  enabledStrategies(): StrategyConfig[] {
    return [...this.strategies.values()].filter((s) => s.enabled);
  }

  // ── accumulator ──
  accumulatorKey(userId: string, symbol: string): string {
    return `${userId}:${symbol}`;
  }
  accumulatorBook(userId: string, symbol: string): AccumulatorBook | undefined {
    return this.accumulatorBooks.get(this.accumulatorKey(userId, symbol));
  }
  accumulatorBooksByUser(userId: string): AccumulatorBook[] {
    return [...this.accumulatorBooks.values()].filter((b) => b.userId === userId);
  }
  saveAccumulatorBook(b: AccumulatorBook): void {
    this.accumulatorBooks.set(this.accumulatorKey(b.userId, b.symbol), b);
  }
  /** Wait until this book's queued writes are in MongoDB. */
  flushAccumulatorBook(userId: string, symbol: string): Promise<string | null> {
    return this.accumulatorBooks.flushKey(this.accumulatorKey(userId, symbol));
  }

  // ── orders ──
  ordersByUser(userId: string): Order[] {
    return [...this.orders.values()]
      .filter((o) => o.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  /** Idempotency: the order a client already placed under this id, if any. */
  orderByClientId(userId: string, clientOrderId: string): Order | undefined {
    return [...this.orders.values()].find(
      (o) => o.userId === userId && o.clientOrderId === clientOrderId,
    );
  }

  // ── trades ──
  tradesByUser(userId: string): Trade[] {
    return [...this.trades.values()]
      .filter((t) => t.userId === userId)
      .sort((a, b) => b.openedAt - a.openedAt);
  }
  openTradesByUser(userId: string): Trade[] {
    return this.tradesByUser(userId).filter((t) => t.status === 'OPEN');
  }

  // ── positions ──
  positionKey(userId: string, symbol: string): string {
    return `${userId}:${symbol}`;
  }
  positionsByUser(userId: string): Position[] {
    return [...this.positions.entries()]
      .filter(([k]) => k.startsWith(`${userId}:`))
      .map(([, v]) => v)
      .filter((p) => p.quantity !== 0);
  }

  // ── watchlists / triggers / snapshots ──
  watchlistsByUser(userId: string): Watchlist[] {
    return [...this.watchlists.values()]
      .filter((w) => w.userId === userId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }
  triggersByUser(userId: string): Trigger[] {
    return [...this.triggers.values()]
      .filter((t) => t.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  activeTriggers(): Trigger[] {
    return [...this.triggers.values()].filter((t) => t.status === 'ACTIVE');
  }
  snapshotsByUser(userId: string): EquitySnapshot[] {
    return [...this.equitySnapshots.values()]
      .filter((s) => s.userId === userId)
      .sort((a, b) => a.day.localeCompare(b.day));
  }
  backtestRunsByUser(userId: string): BacktestRun[] {
    return [...this.backtestRuns.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.at - a.at);
  }

  // ── daily P&L ──
  //
  // Keyed by `${userId}:${utcDay}` (spec Phase 6), NOT by userId alone. Three
  // things fall out of that, all of which were previously broken:
  //   1. The bucket SELF-EXPIRES at the day boundary — no scheduler needed.
  //      (`resetDailyPnl()` had zero callers, so the limit never reset at all:
  //      once breached, the account was blocked permanently, even across restarts.)
  //   2. It is restart-safe: hydrate() reloads yesterday's bucket under
  //      yesterday's key, where today's gate will never read it.
  //   3. It is driven by TRADE TIMESTAMPS, not the wall clock, so the risk
  //      manager behaves identically in backtest, paper and live.
  //
  // UTC (not IST) is safe for NSE: 00:00 UTC is 05:30 IST, which falls before the
  // 09:15 open — so a session is never split across a day boundary.

  /** UTC trading day index for a timestamp. */
  utcDay(time: number = Date.now()): number {
    return Math.floor(time / 86_400_000);
  }

  private pnlKey(userId: string, time: number): string {
    return `${userId}:${this.utcDay(time)}`;
  }

  addDailyPnl(userId: string, pnl: number, time: number = Date.now()): number {
    const key = this.pnlKey(userId, time);
    const next = (this.dailyPnl.get(key) ?? 0) + pnl;
    this.dailyPnl.set(key, next);
    this.persistPnl(key, next);
    return next;
  }

  getDailyPnl(userId: string, time: number = Date.now()): number {
    return this.dailyPnl.get(this.pnlKey(userId, time)) ?? 0;
  }

  /** Zero one user's bucket for the day of `time` (a paper↔live switch). */
  clearDailyPnl(userId: string, time: number = Date.now()): void {
    const key = this.pnlKey(userId, time);
    if (!this.dailyPnl.has(key)) return;
    this.dailyPnl.set(key, 0);
    this.persistPnl(key, 0);
  }

  /** Manual override (admin / tests). Day rollover no longer needs this. */
  resetDailyPnl(): void {
    this.dailyPnl.clear();
    if (isMongoConnected()) {
      void DailyPnlModel.deleteMany({}).catch((e) =>
        logger.error(`reset dailyPnl failed: ${e?.message ?? e}`),
      );
    }
  }

  private persistPnl(key: string, pnl: number): void {
    if (!isMongoConnected()) return;
    void DailyPnlModel.updateOne({ _id: key }, { $set: { pnl } }, { upsert: true }).catch((e) =>
      logger.error(`persist dailyPnl failed: ${e?.message ?? e}`),
    );
  }
}

export const store = new MemoryStore();
