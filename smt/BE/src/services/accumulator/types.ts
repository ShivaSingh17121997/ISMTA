/**
 * Accumulator ("no-loss") engine — types.
 *
 * WHY THIS IS NOT A BaseStrategy
 * ------------------------------
 * `BaseStrategy.evaluate(candles) → Signal` is stateless and returns one signal
 * with an SL/TP, and `StrategyEngine` enforces one open position per symbol per
 * strategy. The Accumulator breaks all three assumptions on purpose:
 *
 *   - it is stateful: it owns a ladder of epochs and up to `tranches` lots;
 *   - it holds MANY concurrent lots on one symbol, and never nets them — each
 *     lot lives and dies on its own cost basis, which is the whole invariant;
 *   - it has no stop-loss at all. A lot that can be stopped out is a lot that
 *     books a loss.
 *
 * `Trade.entryPrice` is documented as a weighted average that moves under DCA,
 * so representing lots as DCA adds would average away exactly the per-lot cost
 * basis the engine depends on. Hence its own book, its own collection, and its
 * own engine service beside StrategyEngine.
 *
 * THE INVARIANT
 * -------------
 * A lot is only ever sold ABOVE its full, fee-inclusive cost basis. Every
 * closed trade is therefore a profit by construction, not by prediction. That
 * is an accounting identity, not an edge: it trades realised losses for
 * unrealised drawdown and capital lock-up measured in years, and if the
 * instrument never recovers, open lots are a total loss while the win rate
 * still reads 100%.
 *
 * It holds ONLY because the instrument is cash/delivery (CNC), non-expiring and
 * long-only. Remove any one and the guarantee is false.
 */

import type { EventVetoParams } from './events';

export type AccumulatorInstrument = 'EQUITY' | 'ETF';

/**
 * One accumulated lot. Never netted with another.
 */
export interface Lot {
  id: string;
  /** Epoch (ladder generation) this lot belongs to. */
  epoch: number;
  /** Ladder rung; 0 is the anchor. */
  level: number;
  /** Actual executed price. The requested price is never authoritative. */
  fillPrice: number;
  /** Whole shares — India has no fractional units. */
  quantity: number;
  /**
   * Every rupee that left the account for this lot: turnover + all buy-side
   * charges. This is the number a sale must beat.
   */
  quoteSpent: number;
  openedAt: number;
  /**
   * Ratchet state. A lot arms once price runs well past its fixed target, and
   * from then on exits on a retracement from its high-water mark instead of at
   * the target. Both fields are absent until the lot arms.
   *
   * This can only ever raise the price a lot sells at — the trailing stop is
   * floored at the fixed target — so it cannot weaken the invariant.
   */
  armed?: boolean;
  /** Highest price seen since arming. */
  hwm?: number;
  /**
   * Giveback from `hwm`, percent, fixed at the moment the lot armed. Absent on
   * lots armed before this field existed; they use `trail.retracePct`. Fixed
   * per lot so a later regime flip never moves an armed lot's stop.
   */
  trailPct?: number;
  /**
   * The order (store `orders` id) whose fill opened this lot. Lets a restart
   * prove every filled engine order was booked. Absent on older lots.
   */
  orderId?: string;
  /**
   * Where the shares were bought. A book keeps its paper history after it goes
   * live, so the tax report filters lots by this, not by the book. Absent on
   * lots bought before this field existed, which were all paper.
   */
  venue?: 'paper' | 'live';
}

/**
 * A paper lot closed by "Clear paper lots" before going live. Not a trade: it
 * is kept out of `closedLots` (stats, tax) and marked at `markPrice`.
 */
export interface ClearedLot extends Lot {
  clearedAt: number;
  markPrice: number;
  /** quantity × markPrice, credited to the book's cash. */
  value: number;
  /** value − quoteSpent: the paper result at the moment of clearing. */
  pnl: number;
}

export interface ClosedLot extends Lot {
  /** The order whose fill closed this lot. Absent on older lots. */
  sellOrderId?: string;
  sellPrice: number;
  closedAt: number;
  /** Net rupees received after all sell-side charges, DP charge included. */
  proceeds: number;
  /**
   * proceeds − quoteSpent. Never negative for a sale the bot made; it can be
   * negative only when `forced` — the user sold the lot at market by hand.
   */
  pnl: number;
  /** The floor this sale had to clear (for a forced sale: the floor it was allowed to ignore). */
  netBreakeven: number;
  /**
   * Sold by the user from the Sell button, at market, regardless of cost.
   * The one way a closed lot can carry a loss. Absent on every bot sale.
   */
  forced?: boolean;
}

export interface Epoch {
  index: number;
  /** Level-0 fill price; all rungs are computed from it. */
  anchorPrice: number;
  openedAt: number;
  /** Rung prices, index 0 = anchor. Strictly descending. */
  levels: number[];
  filledLevels: number[];
  status: 'OPEN' | 'CLOSED';
  closedAt?: number;
}

/** Sale proceeds inside the T+1 settlement window — owned, but not spendable. */
export interface PendingCredit {
  amount: number;
  fromLotId: string;
  soldAt: number;
  /** Earliest timestamp at which this money may fund a buy. */
  settlesAt: number;
}

/**
 * The per-instrument book. Books never share capital.
 */
export interface AccumulatorBook {
  id: string;
  userId: string;
  symbol: string;
  instrument: AccumulatorInstrument;
  /** Rupees allocated to this symbol. */
  budget: number;
  /** SETTLED, spendable rupees. */
  cash: number;
  unsettled: PendingCredit[];
  openLots: Lot[];
  closedLots: ClosedLot[];
  /** Paper lots cleared before going live; see `accumulator/paperClear.ts`. */
  clearedLots?: ClearedLot[];
  epochs: Epoch[];
  /** Timestamp of the most recent buy, for the crash-cascade brake. */
  lastBuyAt?: number;
  lotSeq: number;
  /** Highest price seen per IST trading day, for the start gate's rolling high. */
  dayHighs: Record<string, number>;
  orderedDays: string[];
  /** Previous session's close, for the daily circuit band (services/nse). Rolls once per day. */
  previousClose?: number;
  /** Most recent price the engine stepped on, and when. The mark when no feed price exists. */
  lastPrice?: number;
  lastPriceAt?: number;
  /**
   * Ex-date of the newest corporate action already absorbed. Anything at or
   * before this has been applied; re-reading the same history is a no-op.
   * Applying a split twice is as destructive as never applying it.
   */
  lastCorporateActionAt?: number;
  /** Audit trail of every action applied to this book. */
  corporateActions?: import('./corporateActions').CorporateAction[];
  /**
   * Per-book rung count, set by the capital allocator from the budget it gave
   * this book (fewer rupees, fewer rungs, so each tranche still clears the dust
   * gate). Falls back to the global params when unset. Applies to NEW epochs;
   * an open ladder keeps the rungs it was built with.
   */
  tranches?: number;
  /**
   * Set by the allocator when capital was assigned elsewhere: no new rungs.
   * Exits are untouched — open lots still sell at their own targets. Distinct
   * from the kill switch (the user's manual halt) and from `enabled`.
   */
  allocatorPaused?: boolean;
  /** The allocator's one-line reason for this book's sizing, for the UI. */
  allocatorNote?: string;
  /**
   * Total budget the user fixed by hand (lots + T+1 + new cash), rupees. The
   * allocator honours it exactly instead of ranking the stock. Absent = the
   * allocator decides.
   */
  manualBudget?: number;
  /**
   * Rung count the user chose with `manualBudget`. Absent = the allocator picks
   * it from the new cash. Only meaningful while `manualBudget` is set.
   */
  manualTranches?: number;
  /**
   * Scalping mode: the tight/fast profile from `./scalp`. A PROFILE on this
   * engine, not a second engine — the no-loss floor is untouched, only the
   * target size and entry cadence change. Nested inside no-loss mode: it does
   * nothing while `enabled` is false, and turning no-loss off parks it rather
   * than clearing it.
   */
  scalp?: boolean;
  /**
   * Regime autopilot. On, the engine reads the trend from daily closes and
   * owns the `scalp` flag: sideways switches to scalp, a confirmed trend
   * switches to swing.
   *
   * ONE CONTROLLER PER KNOB. While this is on, the scalp switch belongs to the
   * bot and the UI shows it read-only. A human and an autopilot fighting over
   * the same control is how a book ends up flipping profiles twice a day.
   */
  autoProfile?: boolean;
  /** Last confirmed regime, for display and for the flip rate limit. */
  regime?: 'up' | 'down' | 'sideways';
  regimeNote?: string;
  /**
   * Daily volatility, percent: standard deviation of the last 60 daily log
   * returns. Refreshed with the regime read. Sets the rung gap of a NEW ladder
   * when `volStep` is on; an open ladder keeps the gaps it was built with.
   */
  volPct?: number;
  /**
   * Why new rungs are blocked by a market event right now (surveillance,
   * results, a gap-down), or absent. Recomputed by the engine every step;
   * exits are never affected. See `accumulator/events.ts`.
   */
  entryBlock?: string;
  /** The last HOLD reason the engine logged (digits as #), so an unchanged one is not logged again, even across restarts. */
  lastHoldGist?: string;
  /** Latest IST day the stock opened `eventVeto.gapPct` or more under the previous close. */
  gapDownDay?: string;
  /** When the profile last changed. Rate-limits the autopilot. */
  profileSwitchedAt?: number;
  /**
   * "No-loss mode" on/off. Off = the scheduler ignores this book entirely;
   * lots stay exactly as they are. Distinct from the kill switch, which keeps
   * evaluating and only blocks NEW entries.
   */
  enabled: boolean;
  /**
   * Audit stamp for `enabled`: when it last changed and which code path did
   * it. Exists because a book once switched itself on with no trace left to
   * say how. A mode flag that can change without an author is a mode flag
   * nobody can trust.
   */
  enabledChangedAt?: number;
  enabledChangedBy?: 'user' | 'allocator' | 'created';
  killSwitchEngaged: boolean;
  haltedReason?: string;
  /**
   * Where this book's open lots were bought: simulated fills, or a real Zerodha
   * account. Set when a book with no open lots fills its first buy. A book with
   * lots is never traded on the OTHER venue — a paper lot is not in the demat
   * account, and selling a live lot in simulation would close shares still held.
   * Absent = paper (every book before live trading existed).
   */
  venue?: 'paper' | 'live';
  createdAt: number;
  updatedAt: number;
}

export interface AccumulatorParams {
  /** Fraction of budget never deployed, percent. */
  reservePct: number;
  /** Ladder rungs including the anchor. */
  tranches: number;
  /** Price must be this far below the rolling high to open an epoch. */
  startDiscountPct: number;
  /** Rolling-high lookback, in trading days. */
  hiLookbackDays: number;
  /** Gap from rung 0 to rung 1, percent. */
  stepPct: number;
  /** Each later gap multiplies by this. */
  stepGrowth: number;
  /** Minimum gap between two ladder buys, ms. */
  minBuyGapMs: number;
  /** Resting sell target above net breakeven, percent. */
  targetPct: number;
  /** Extra haircut so the floor sits above exact breakeven, percent. */
  slippageBufferPct: number;
  /**
   * Ceiling on cost basis held in open lots, as a percent of budget. 100 = no
   * ceiling beyond the reserve. The scalp profile lowers it, because a shallow
   * dip gate plus a short buy brake fills rungs fast, and a drawdown limiter is
   * the only brake this engine has — it has no stop-loss by construction.
   */
  maxDeployPct: number;
  /**
   * Ratchet exit. Off, every lot sells at breakeven + `targetPct`, which caps
   * the upside of a lot that keeps running — measured as the single largest
   * leak in this strategy, since a stock that doubles still only ever pays
   * `targetPct` per lot.
   *
   * On, a lot that reaches `armPct` above breakeven stops resting at the fixed
   * target and instead follows its high-water mark down by `retracePct`. The
   * stop is floored at the fixed target price, so an armed lot can never sell
   * for LESS than it would have without the ratchet. It is a strict
   * improvement or a no-op, never a regression, and it never approaches the
   * breakeven floor.
   */
  trail: {
    enabled: boolean;
    /** Gain over breakeven, percent, at which a lot starts trailing. Must exceed targetPct. */
    armPct: number;
    /** Giveback from the high-water mark, percent. */
    retracePct: number;
    /**
     * Trend riding. While the book's confirmed regime is UP, a lot arms the
     * moment it reaches its fixed target (instead of at `armPct`) and trails
     * `retracePct` below its high. The stop keeps the same floor, the fixed
     * target, so a ridden lot never sells for less than it would have without
     * this. Outside an up regime, lots sell at the target as before.
     */
    uptrend: {
      enabled: boolean;
      retracePct: number;
    };
  };
  /**
   * When a lot on a deeper rung sells, that rung can buy again if price comes
   * back down to it, funded by what the sale returned. Without it every rung
   * fires once per ladder, and a second leg down buys nothing until the whole
   * ladder has sold. The anchor rung is never re-armed. Absent = off.
   */
  rearmSoldRungs?: boolean;
  /**
   * Rung gap from the stock's own volatility instead of a flat `stepPct`:
   * gap = k × daily volatility × √20 (about one month's typical move),
   * clamped to [minPct, maxPct]. Swing profile only; scalp keeps its gap.
   */
  volStep?: { enabled: boolean; k: number; minPct: number; maxPct: number };
  /** Which market events block new rungs. See `accumulator/events.ts`. Absent = none. */
  eventVeto?: EventVetoParams;
}

export const DEFAULT_ACCUMULATOR_PARAMS: AccumulatorParams = {
  reservePct: 15,
  tranches: 12,
  /**
   * 3%, not 6%.
   *
   * Measured over Nov 2021 to Sep 2026 on twelve NIFTY large caps with the real
   * engine (`npm run sim`): a 6% gate returned 2.1% a year with 21% of capital
   * at work; a 3% gate returned 2.8% with 25% at work, at the SAME maximum
   * drawdown, the same worst open lot and effectively the same lock-up. The
   * deeper gate was leaving capital idle without buying safety.
   *
   * It is not lowered further. Removing the gate entirely scored better again
   * (2.9%) but pushed the worst open lot from −46% to −50% and the longest hold
   * past a thousand days. Under a rule that forbids ever selling at a loss,
   * lock-up IS the risk, so the gate stays — it is what stops the ladder
   * anchoring at a top.
   *
   * One window of evidence on one universe. Treat as a better default, not a
   * settled constant.
   */
  startDiscountPct: 3,
  hiLookbackDays: 45,
  stepPct: 6,
  stepGrowth: 1.15,
  minBuyGapMs: 24 * 60 * 60 * 1000,
  targetPct: 4,
  slippageBufferPct: 0.05,
  maxDeployPct: 100,
  /**
   * Uptrend giveback 0.75%, chosen 2026-09-22 from a sweep of 0.5–1.5% against
   * the old exit (real engine, 32 stocks in 3 groups, 5y daily + 2y hourly).
   * Tighter was better in every run: a tight trail keeps turnover high and
   * rarely leaves an armed lot open overnight, where a gap under the target
   * strands it. 0.5% scored best, but it sits inside the minute-to-minute
   * noise that bar data cannot show, so 0.75% keeps most of the gain with a
   * margin. Books +1.0 to +1.8pp/yr, mid/PSU about +1.1, large caps flat.
   */
  trail: { enabled: true, armPct: 8, retracePct: 3, uptrend: { enabled: true, retracePct: 0.75 } },
  /**
   * On, from the Phase 4 backtest (ENGINE_FIX_PLAN.md): against the
   * exposure-matched benchmark it added +0.8 to +5.0 points a year in all four
   * 10-year runs and was flat (within ±0.3) over 5 years, at 2–4 points more
   * drawdown in most runs. Volatility-spaced rungs (`volStep`) were mixed and
   * not monotonic in k, so they stay off.
   */
  rearmSoldRungs: true,
  /**
   * Phase 5 backtest (ENGINE_FIX_PLAN.md), 5 universes:
   *   - Gap-down block: worse in every universe at 3/4/5% and 1/2/3 sessions
   *     (−0.2 to −2.5 points a year). Sharp drops are where the ladder earns.
   *   - Results block (733–901 real NSE results days): +0.9, 0.0, +2.4, +0.7,
   *     −0.8 at 1 session; similar mix at 2 and 3. Not consistent: off.
   *   - Surveillance: no history to test against; kept on as a red-flag rule.
   *     It rarely touches large caps.
   */
  eventVeto: { surveillance: true, resultsSessions: 0, gapPct: 0, gapSessions: 0 },
};

export type AccumulatorAction = 'BUY' | 'SELL' | 'HOLD';

export interface AccumulatorDecision {
  action: AccumulatorAction;
  symbol: string;
  reason: string;
  /** BUY only. */
  epoch?: number;
  level?: number;
  /** BUY/SELL. */
  limitPrice?: number;
  quantity?: number;
  /** SELL only. */
  lotId?: string;
  /** SELL only: the user's forced sale — a MARKET order booked by `forceSellLot`, not `sellLot`. */
  forced?: boolean;
  netBreakeven?: number;
}
