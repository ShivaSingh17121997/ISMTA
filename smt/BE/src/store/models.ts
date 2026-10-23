import mongoose, { Schema } from 'mongoose';

/**
 * Each collection stores the app's own domain objects verbatim, using the
 * entity's `id` (or composite key, for positions) as the Mongo `_id`. Schemas
 * are intentionally flexible (`strict: false`) so the persisted documents match
 * the TypeScript interfaces in `../types` exactly — and read cleanly in Compass.
 */
function collection(name: string): mongoose.Model<Record<string, unknown>> {
  const schema = new Schema<Record<string, unknown>>(
    { _id: String },
    {
      strict: false,
      versionKey: false,
      collection: name,
      minimize: false,
      // Mongoose adds an `id` VIRTUAL to every schema by default. Our domain
      // objects carry a real `id` field, and when a document is cast for
      // replaceOne the virtual wins and the field is silently dropped — every
      // trade and order written on 10–11 Sep 2026 came back from Mongo with no
      // id, and the exit engine could no longer find them. Off, permanently.
      id: false,
    },
  );
  return mongoose.model<Record<string, unknown>>(name, schema);
}

export const UserModel = collection('users');
export const StrategyModel = collection('strategies');
export const OrderModel = collection('orders');
export const TradeModel = collection('trades');
export const PositionModel = collection('positions');
export const DailyPnlModel = collection('dailypnl');
/** kill switch + loss-streak + cooldown, per user — must survive a restart */
export const RiskStateModel = collection('riskstate');
/** Process-wide switches that must outlive a restart (the manual trading halt). */
export const SystemStateModel = collection('systemstate');

/**
 * Accumulator books — one per user+symbol. Kept OUT of `trades` on purpose: a
 * Trade nets DCA adds into a weighted-average entry, and averaging away the
 * per-lot cost basis is exactly what would break the no-loss invariant.
 */
export const AccumulatorBookModel = collection('accumulatorbooks');
/** NSE listed-company master, cached so a boot without NSE still has a list. */
export const InstrumentModel = collection('instruments');
/** Capital-allocator passes: what the bot saw and what it decided, per user per trading day. */
export const AllocatorRunModel = collection('allocatorruns');
/** Recommendation runs, per user per trading day. A run costs a minute of Yahoo calls; losing it on restart is not acceptable. */
export const RecommendationRunModel = collection('recommendationruns');
/** Future-stars runs, per user per trading day. Built from quarterly filings, so a run is expensive and worth keeping. */
export const FutureStarsRunModel = collection('futurestarsruns');
/** Turnaround runs, per user per trading day. */
export const TurnaroundRunModel = collection('turnaroundruns');
/** Every backtest ever run, so the trial count behind a Sharpe ratio is known (deflated Sharpe needs N). */
export const BacktestRunModel = collection('backtestruns');
/** User watchlists. */
export const WatchlistModel = collection('watchlists');
/** Standing triggers (GTT / OCO / trailing) watched by the feed loop. */
export const TriggerModel = collection('triggers');
/** One row per user per trading day: equity, cash, deployed, benchmark close. The NAV curve is built from these. */
export const EquitySnapshotModel = collection('equitysnapshots');
/** Journal annotations on trades (tags, MAE/MFE) live on the trade itself; this holds user notes keyed by trade id. */
export const JournalModel = collection('journal');
/**
 * Append-only audit trail: order requests, risk verdicts, fills, rejections,
 * engine decisions, guard trips. Never updated, never deleted by the app.
 */
export const AuditLogModel = collection('auditlog');
/** Each user's own broker app: plan, trading mode, session state, sealed secrets. Keyed `<userId>:zerodha`. */
export const BrokerConnectionModel = collection('brokerconnections');
/** Idle-cash sweep per user: parked units (lots for T1 and FIFO), cash taken, income realised. */
export const CashSweepModel = collection('cashsweeps');
