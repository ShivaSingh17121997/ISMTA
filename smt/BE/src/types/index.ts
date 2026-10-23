// ─── Market data ──────────────────────────────────────────
export interface Candle {
  symbol: string;
  timestamp: number; // epoch ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Tick {
  symbol: string;
  ltp: number; // last traded price
  timestamp: number;
}

// ─── Orders & trades ──────────────────────────────────────
export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT';
export type ProductType = 'MIS' | 'CNC' | 'NRML'; // intraday / delivery / normal
export type OrderStatus = 'PENDING' | 'FILLED' | 'REJECTED' | 'CANCELLED';

/**
 * What an order is trying to do. Drives both the risk gate (only `entry` and
 * `dca_add` are gated — see RiskManager) and the fill handling.
 */
export type OrderIntent = 'entry' | 'exit' | 'dca_add';

export interface OrderRequest {
  symbol: string;
  side: OrderSide;
  quantity: number;
  orderType: OrderType;
  product: ProductType;
  price?: number; // required for LIMIT
  strategyId?: string;
  userId?: string;
  tag?: string;
  /** informational; the risk gate derives "is this reducing?" from the position */
  intent?: OrderIntent;
  /** why this order closes a trade. Set only by the exit path — never inferred from `tag`. */
  exitReason?: ExitReason;
  /** the trade this order acts on (exits and DCA adds) */
  tradeId?: string;
  /**
   * Optional SL/TP carried from a strategy signal; attached to the opened trade.
   * When the % distances are present the levels are recomputed from the FILL.
   */
  stopLossTakeProfit?: { sl?: number; tp?: number; stopPct?: number; targetPct?: number };
  /** stop distance % to lock onto the opened trade (spec Phase 4) */
  stopPct?: number;
  /**
   * Fill price the PAPER broker must honour, so the engine's stop-fill model
   * (cappedStopFill) survives execution. IGNORED by live brokers — there the
   * exchange decides the fill and reports it back.
   */
  simulatedFillPrice?: number;
  /**
   * Idempotency key. A second request with the same id for the same user is
   * answered with the FIRST order rather than placed again — a retried click,
   * a re-run cycle, a reconnect can otherwise double a position.
   */
  clientOrderId?: string;
  /**
   * The price the decision was made at (a signal's bar close, the ticket's
   * displayed LTP). Compared against the live quote BEFORE placing: a fill far
   * from the price you decided on is not the trade you decided on.
   */
  referencePrice?: number;
  /** After-market order: accepted while the exchange is closed, released at the next open. */
  amo?: boolean;
}

export interface Order extends OrderRequest {
  id: string;
  brokerOrderId?: string;
  status: OrderStatus;
  filledPrice?: number;
  filledQuantity: number;
  rejectionReason?: string;
  /** statutory + broker charges for this leg, so the trade log reconciles */
  charges?: number;
  /** the quantity the caller asked for, when the risk gate trimmed it */
  requestedQuantity?: number;
  /** why `quantity` differs from `requestedQuantity`, in words the ticket can show */
  adjustment?: string;
  /** fill vs reference, basis points, signed against the trader (positive = worse) */
  slippageBps?: number;
  /** execution-quality timestamps: when we sent it, when the broker answered */
  submittedAt?: number;
  ackAt?: number;
  createdAt: number;
  updatedAt: number;
}

/** Why a position was closed. `manual` = operator/opposite-signal, not a protection level. */
export type ExitReason = 'trailing' | 'stop_loss' | 'take_profit' | 'manual' | 'square_off';

/**
 * Live state of the NTB trailing-stop engine for one position (spec Phase 0/8).
 * Persisted on the Trade so it survives a restart, and mutated in place by the
 * engine. `stopPct` is locked at entry and must never move for an open trade.
 */
export interface TrailingState {
  /** highest price seen since entry (ratchets up, never retreats) */
  peak: number;
  /** lowest price seen since entry (ratchets down, never retreats) */
  trough: number;
  /** has the trailing stop activated? one-way latch, except on a DCA add */
  armed: boolean;
  /** stop distance % locked in AT ENTRY — may be ATR-derived; config changes must not move it */
  stopPct: number;
  /** safety orders FILLED so far */
  dcaOrdersUsed: number;
  /** DCA mode captured at open; a runtime toggle must not change an open position */
  dcaActive: boolean;
  /**
   * Set when a safety order was REFUSED (risk gate, or sized to 0 shares).
   *
   * Critical: without this, a refused add leaves the position permanently
   * unprotected. `dcaOrdersUsed` only increments on a FILL, so a refused add
   * never spends the budget, and the budget-spent branch — the only path to
   * `finalStopPct` — is never reached. Adds are refused exactly when you are
   * losing, which is exactly when the final stop matters. Sticky by design: once
   * we could not average, the position must fall back to a real stop.
   */
  dcaBlocked?: boolean;
  /** notional of the first leg, used to scale safety-order sizes */
  baseNotional: number;
}

// A round-trip (entry + exit) position that produces realised P&L.
export interface Trade {
  id: string;
  userId: string;
  strategyId?: string;
  symbol: string;
  side: OrderSide; // direction of the entry
  quantity: number;
  /** weighted average entry — CHANGES under DCA (spec Phase 0) */
  entryPrice: number;
  exitPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  status: 'OPEN' | 'CLOSED';
  pnl: number;
  /** total round-trip charges (entry + exit) already deducted from `pnl` */
  charges?: number;
  exitReason?: ExitReason;
  /** true when the stop filled worse than its level because the bar gapped through it */
  gapped?: boolean;
  /** present only for trades managed by the trailing engine (exitMode: 'trailing') */
  trailing?: TrailingState;
  entryOrderId: string;
  exitOrderId?: string;
  openedAt: number;
  closedAt?: number;
  /**
   * Set when the trade is known to be an artefact (a signal computed on
   * synthetic bars, a bad tick) rather than a real outcome. Kept, never
   * deleted, so the record of what happened survives; excluded from every
   * performance figure.
   */
  invalid?: boolean;
  invalidReason?: string;
  /** journal: where the trade came from — 'strategy', 'manual', 'autopilot', 'override' … */
  tags?: string[];
  /** worst and best excursion from entry while open, in % of entry (MAE negative, MFE positive) */
  maePct?: number;
  mfePct?: number;
}

// ─── Watchlists / triggers / snapshots / journal / audit ──
export interface Watchlist {
  id: string;
  userId: string;
  name: string;
  symbols: string[];
  /** free-text note per symbol */
  notes: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export type TriggerStatus = 'ACTIVE' | 'TRIGGERED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';

export interface TriggerLeg {
  /** 'target' or 'stop' for OCO; 'single' for a one-leg trigger */
  role: 'single' | 'target' | 'stop';
  side: OrderSide;
  /** fires when LTP crosses this level in the leg's direction */
  triggerPrice: number;
  /** which side of the trigger price fires the leg; fixed at creation from where the price was */
  fireWhen: 'above' | 'below';
  orderType: OrderType;
  /** limit price when orderType is LIMIT; market otherwise */
  price?: number;
  quantity: number;
}

/**
 * A standing trigger the feed loop watches: single-leg GTT, OCO pair, or a
 * trailing stop that ratchets `triggerPrice` behind the price. Nothing is sent
 * to the broker until it fires, so no funds are blocked.
 */
export interface Trigger {
  id: string;
  userId: string;
  symbol: string;
  product: ProductType;
  kind: 'single' | 'oco';
  legs: TriggerLeg[];
  /** trailing stop: the stop leg follows the price at this distance (%) once armed */
  trailPct?: number;
  /** highest (long) / lowest (short) price seen since creation, for the trail */
  extreme?: number;
  /** cancel when the position it protects is flat — a stop that outlives its position is a naked order */
  autoCancelWhenFlat?: boolean;
  status: TriggerStatus;
  note?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  triggeredAt?: number;
  firedLeg?: TriggerLeg['role'];
  resultOrderId?: string;
  failReason?: string;
}

export interface EquitySnapshot {
  userId: string;
  /** IST trading day, YYYY-MM-DD */
  day: string;
  at: number;
  /** books equity + strategy positions marked + free cash */
  equity: number;
  cash: number;
  deployed: number;
  /** realised since inception (books + trades), net of charges */
  realisedToDate: number;
  chargesToDate: number;
  /** external cash flow booked this day (deposits +, withdrawals −); 0 for paper */
  flow: number;
  /** NIFTY 50 close for the day, when known */
  nifty?: number;
  /**
   * Paper capital or the real broker balance. A live curve must never be
   * chained onto paper equity. Absent on rows written before this field.
   */
  venue?: 'paper' | 'live';
}

export interface JournalNote {
  tradeId: string;
  userId: string;
  setup?: string;
  note?: string;
  ruleBreak?: boolean;
  updatedAt: number;
}

export interface BacktestRun {
  id: string;
  userId: string;
  at: number;
  strategyType: string;
  symbol: string;
  params: Record<string, number>;
  source: string;
  interval: string;
  bars: number;
  from: number;
  to: number;
  startingCapital: number;
  totalReturnPct: number;
  trades: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  /** per-period (not annualised) Sharpe, skew and kurtosis of the trade P&L series — what deflated Sharpe needs */
  periodSharpe: number;
  skew: number;
  kurtosis: number;
}

export interface AuditEntry {
  id: string;
  at: number;
  userId?: string;
  /** 'order', 'risk', 'fill', 'reject', 'guard', 'engine', 'auth', 'reconcile', 'system' */
  kind: string;
  symbol?: string;
  detail: string;
  data?: Record<string, unknown>;
}

export interface Position {
  symbol: string;
  quantity: number; // signed: +long / -short
  avgPrice: number;
  ltp: number;
  unrealisedPnl: number;
  realisedPnl: number;
}

// ─── Strategy ─────────────────────────────────────────────
export type SignalAction = 'BUY' | 'SELL' | 'HOLD';

export interface Signal {
  action: SignalAction;
  symbol: string;
  confidence: number; // 0..1
  reason: string;
  stopLoss?: number;
  takeProfit?: number;
  /**
   * The distances behind stopLoss/takeProfit, in %. Carried so the trade can be
   * protected relative to the FILL rather than the bar close the signal saw —
   * a stop computed from a price the fill never happened at is not a stop.
   */
  stopPct?: number;
  targetPct?: number;
  /** the close the signal was computed on */
  referencePrice?: number;
  timestamp: number;
}

export type StrategyType =
  | 'MA_CROSSOVER'
  | 'MOMENTUM'
  | 'MEAN_REVERSION'
  | 'BREAKOUT'
  | 'VWAP'
  | 'SUPERTREND'
  | 'ML_ENSEMBLE'
  // NTB ports — trend-filtered breakout, trend pullback, RSI mean-reversion.
  | 'NTB_BREAKOUT'
  | 'NTB_PULLBACK'
  | 'NTB_MEANREV';

/**
 * `static`  — SL/TP are fixed prices set at entry (ISMTA's original behaviour).
 * `trailing` — the NTB Phase-8 engine manages the position (ratcheting trail).
 */
export type ExitMode = 'static' | 'trailing';

/** Entry-side direction filter (spec Phase 3). Never gates exits. */
export type DirectionFilter = 'long' | 'short' | 'both';

export interface StrategyConfig {
  id: string;
  userId: string;
  name: string;
  type: StrategyType;
  symbols: string[];
  params: Record<string, number>;
  quantity: number;
  enabled: boolean;
  /** defaults to 'static' for the original 7 types, 'trailing' for NTB_* */
  exitMode?: ExitMode;
  /** defaults to 'both'; runtime-mutable, entries only */
  direction?: DirectionFilter;
  createdAt: number;
}

// ─── Backtest ─────────────────────────────────────────────
export interface BacktestResult {
  strategyType: string;
  symbol: string;
  params: Record<string, number>;
  from: number;
  to: number;
  startingCapital: number;
  endingCapital: number;
  totalReturnPct: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  expectancy: number; // avg P&L per trade (INR)
  avgWin: number;
  avgLoss: number;
  equityCurve: { t: number; equity: number }[];
  tradeLog: {
    symbol: string;
    side: OrderSide;
    entryPrice: number;
    exitPrice: number;
    /** net of the full round trip: slippage + brokerage + STT + GST + stamp duty */
    pnl: number;
    reason?: ExitReason;
    openedAt: number;
    closedAt: number;
  }[];
}

// ─── Risk ─────────────────────────────────────────────────
/** Per-user risk-gate state. Persisted so a restart cannot release a breaker. */
export interface UserRiskState {
  /** UTC day index the streak/cooldown belong to; a newer day resets them */
  day: number;
  consecutiveLosses: number;
  cooldownUntil: number;
  killed: boolean;
}

// ─── User ─────────────────────────────────────────────────
export interface User {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  role: 'admin' | 'trader';
  createdAt: number;
  /** TOTP second factor. `totpPending` holds a secret enrolled but not yet confirmed. */
  totpSecret?: string;
  totpPending?: string;
  totpEnabledAt?: number;
}

/**
 * Which Kite Connect product a user's key is on. `personal` is free (orders,
 * portfolio, margins — no market data); `connect` is the paid plan that adds
 * the live price stream and historical candles.
 */
export type BrokerPlan = 'personal' | 'connect';
/** Where this user's orders go. `live` sends real orders to their own Zerodha account. */
export type BrokerTradingMode = 'paper' | 'live';
export type BrokerConnectionStatus = 'not_connected' | 'connected' | 'expired' | 'error';

/**
 * One user's own Kite Connect app. Keyed `<userId>:zerodha`.
 *
 * The api_secret and the day's access token are sealed (AES-256-GCM, see
 * utils/secretBox) and never leave the server. The api_key is stored plainly:
 * it appears in every Kite login URL and is not a credential on its own.
 */
export interface BrokerConnection {
  id: string;
  userId: string;
  broker: 'zerodha';
  apiKey: string;
  apiSecretSealed: string;
  accessTokenSealed?: string;
  /** Fingerprint of the BROKER_CREDENTIALS_KEY that sealed the values. */
  keyId: string;
  plan: BrokerPlan;
  tradingMode: BrokerTradingMode;
  status: BrokerConnectionStatus;
  kiteUserId?: string;
  kiteUserName?: string;
  connectedAt?: number;
  /** 06:00 IST after `connectedAt` — Kite invalidates every token then. */
  expiresAt?: number;
  lastError?: string;
  liveSince?: number;
  createdAt: number;
  updatedAt: number;
}
