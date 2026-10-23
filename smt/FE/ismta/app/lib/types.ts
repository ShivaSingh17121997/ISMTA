// Shared types mirroring the backend API responses.

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface Position {
  symbol: string;
  quantity: number;
  avgPrice: number;
  ltp: number;
  unrealisedPnl: number;
  realisedPnl: number;
}

export interface PortfolioSummary {
  realisedPnl: number;
  unrealisedPnl: number;
  totalPnl: number;
  invested: number;
  openPositions: number;
}

/** Why a position closed. `trailing` is the NTB engine releasing a winner. */
export type ExitReason = 'trailing' | 'stop_loss' | 'take_profit' | 'manual' | 'square_off';

export interface Trade {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  /** weighted average entry — moves under DCA */
  entryPrice: number;
  exitPrice?: number;
  status: 'OPEN' | 'CLOSED';
  /** net of the full round trip: slippage + brokerage + STT + GST + stamp duty */
  pnl: number;
  /** total round-trip charges already deducted from pnl */
  charges?: number;
  exitReason?: ExitReason;
  /** the stop filled worse than its level because the bar gapped through it */
  gapped?: boolean;
  strategyId?: string;
  openedAt: number;
  closedAt?: number;
}

export interface Order {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  orderType: string;
  status: string;
  filledPrice?: number;
  filledQuantity: number;
  rejectionReason?: string;
  tag?: string;
  createdAt: number;
}

/** Mirrors StrategyType in BE/src/types/index.ts. NTB_* are the ported models. */
export type StrategyKind =
  | 'MA_CROSSOVER'
  | 'MOMENTUM'
  | 'MEAN_REVERSION'
  | 'BREAKOUT'
  | 'VWAP'
  | 'SUPERTREND'
  | 'ML_ENSEMBLE'
  | 'NTB_BREAKOUT'
  | 'NTB_PULLBACK'
  | 'NTB_MEANREV';

export interface Strategy {
  id: string;
  name: string;
  type: StrategyKind;
  /** 'trailing' = the NTB exit engine manages the position; defaults per type */
  exitMode?: 'static' | 'trailing';
  /** entry-side direction filter; never gates exits */
  direction?: 'long' | 'short' | 'both';
  symbols: string[];
  params: Record<string, number>;
  quantity: number;
  enabled: boolean;
  createdAt: number;
}

/** Response shape of GET /strategies/types — not the union above. */
export interface StrategyType {
  type: string;
  defaultParams: Record<string, number>;
}

export interface Signal {
  action: 'BUY' | 'SELL' | 'HOLD';
  symbol: string;
  confidence: number;
  reason: string;
  strategyId: string;
  acted: boolean;
  timestamp: number;
}

export interface RiskSnapshot {
  capital: number;
  dailyPnl: number;
  dailyLossLimit: number;
  dailyLossUsedPct: number;
  openPositions: number;
  maxPositions: number;
  marginUsed: number;
  marginAvailable: number;
}

export interface RiskAlert {
  level: 'warning' | 'critical';
  message: string;
}

export interface Quote {
  symbol: string;
  ltp: number;
  timestamp: number;
}

export interface BacktestResult {
  strategyType: string;
  symbol: string;
  params: Record<string, number>;
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
  expectancy: number;
  avgWin: number;
  avgLoss: number;
  equityCurve: { t: number; equity: number }[];
  tradeLog: {
    symbol: string;
    side: 'BUY' | 'SELL';
    entryPrice: number;
    exitPrice: number;
    /** net of the full round trip: slippage + brokerage + STT + GST + stamp duty */
    pnl: number;
    reason?: ExitReason;
    openedAt: number;
    closedAt: number;
  }[];
}

export interface StrategyComparisonRow {
  strategyType: string;
  winRate: number;
  profitFactor: number;
  sharpeRatio: number;
  expectancy: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  trades: number;
}

export interface StrategyComparison {
  symbol: string;
  runs: number;
  source: 'sim' | 'zerodha';
  results: StrategyComparisonRow[];
}

// ─── Accumulator ("no-loss") engine ───────────────────────
export interface AccumulatorLot {
  id: string;
  epoch: number;
  level: number;
  fillPrice: number;
  quantity: number;
  /** Every rupee that left the account for this lot, charges included. */
  quoteSpent: number;
  openedAt: number;
  breakeven?: number;
  /** Ratchet state: set once the lot has run past its arm price. */
  armed?: boolean;
  hwm?: number;
  /** Giveback from the high, percent, fixed when the lot armed. */
  trailPct?: number;
  /** The retracement exit for an armed lot. It replaces the fixed target. */
  trailStop?: number;
  target?: number;
  marketValue?: number;
  unrealised?: number;
  /** Where the shares were bought. Absent on older lots, which were all paper. */
  venue?: 'paper' | 'live';
}

export interface AccumulatorClosedLot extends AccumulatorLot {
  sellPrice: number;
  closedAt: number;
  proceeds: number;
  pnl: number;
  netBreakeven: number;
  /** Sold by the user from the Sell button, at market. The only closed lot that can show a loss. */
  forced?: boolean;
}

/** One open lot as the Sell button would sell it now, estimated with the real charges. */
export interface ForceSellLot {
  id: string;
  epoch: number;
  level: number;
  quantity: number;
  fillPrice: number;
  quoteSpent: number;
  openedAt: number;
  breakeven: number;
  /** Net rupees after every sell-side charge, the flat DP charge included. */
  estProceeds: number;
  /** estProceeds − quoteSpent. */
  estPnl: number;
}

export interface ForceSellPreview {
  symbol: string;
  mark: number;
  lots: ForceSellLot[];
  /** Why a sale cannot go out right now, or null. */
  blocker: string | null;
  killSwitchEngaged: boolean;
  venue: 'paper' | 'live';
}

export interface ForceSellResult {
  ok: boolean;
  refused?: string;
  sold: { lotId: string; quantity: number; price: number; proceeds: number; pnl: number }[];
  failed: { lotId: string; reason: string }[];
  killSwitchEngaged?: boolean;
  halted?: string;
}

/** One row of NSE's listed-company master (EQUITY_L.csv). */
export interface Instrument {
  symbol: string;
  name: string;
  /** EQ = normal rolling settlement; BE/BZ = trade-for-trade. */
  series: string;
  isin: string;
  listedOn: string;
  faceValue: number;
}

export interface AccumulatorBook {
  id: string;
  symbol: string;
  /** Company name from the NSE master, when known. */
  name?: string;
  /** No-loss mode on/off. Off = the scheduler leaves this book alone. */
  enabledChangedAt?: number;
  enabledChangedBy?: 'user' | 'allocator' | 'created';
  enabled: boolean;
  instrument: 'ETF' | 'EQUITY';
  budget: number;
  /** SETTLED, spendable. Unsettled proceeds sit apart until T+1. */
  cash: number;
  unsettled: { amount: number; settlesAt: number }[];
  openLots: AccumulatorLot[];
  closedLots: AccumulatorClosedLot[];
  epochs: { index: number; anchorPrice: number; levels: number[]; filledLevels: number[]; status: string }[];
  killSwitchEngaged: boolean;
  haltedReason?: string;
  previousClose?: number;
  /** Scalping mode: the tight/fast profile. A profile on the same engine, not a second engine. */
  scalp?: boolean;
  /** Regime autopilot. While on, the bot owns `scalp`. */
  autoProfile?: boolean;
  regime?: 'up' | 'down' | 'sideways';
  regimeNote?: string;
  profileSwitchedAt?: number;
  /** Set by the capital allocator: rungs for NEW epochs, entry pause, and its one-line reason. */
  tranches?: number;
  allocatorPaused?: boolean;
  allocatorNote?: string;
  /** Total budget the user fixed by hand; absent = the allocator decides. */
  manualBudget?: number;
  /** Why new rungs are blocked by a market event (surveillance, results, gap), if they are. */
  entryBlock?: string;
  updatedAt: number;
}

export interface AccumulatorReport {
  /** The profile in force and what it means — see the scalp overlay on the server. */
  scalpOn: boolean;
  profile: 'scalp' | 'swing';
  profileNote: string;
  autoProfile: boolean;
  regime: 'up' | 'down' | 'sideways' | null;
  regimeNote: string | null;
  targetPct: number;
  stepPct: number;
  minBuyGapHours: number;
  startDiscountPct: number;
  hiLookbackDays: number;
  tranches: number;
  trailEnabled: boolean;
  trailArmPct: number;
  trailRetracePct: number;
  /** True while lots ride past their target (confirmed uptrend) instead of selling at it. */
  ridingUptrend: boolean;
  uptrendTrailPct: number;
  /** Rupees of cost basis this book may hold in open lots at once. */
  deployCeiling: number;
  equity: number;
  cash: number;
  unsettledCash: number;
  bankedProfit: number;
  unrealisedPnl: number;
  unrealisedPct: number;
  deployed: number;
  deployable: number;
  reserve: number;
  openLots: number;
  closedTrades: number;
  oldestOpenLotDays: number;
  worstOpenLotPct: number;
  winRatePct: number;
  /** Always rendered beside the win rate. Never show one without the other. */
  winRateLabel: string;
}

export interface AccumulatorEvent {
  at: number;
  symbol: string;
  kind: string;
  detail: string;
}

export interface AccumulatorParams {
  reservePct: number;
  tranches: number;
  startDiscountPct: number;
  hiLookbackDays: number;
  stepPct: number;
  stepGrowth: number;
  minBuyGapMs: number;
  targetPct: number;
  slippageBufferPct: number;
  /** Ceiling on cost basis in open lots, percent of budget. 100 = none. */
  maxDeployPct: number;
  trail: { enabled: boolean; armPct: number; retracePct: number };
}

// ─── Market data ──────────────────────────────────────────
export interface Candle {
  symbol: string;
  /** epoch ms */
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** GET /api/market/feed — which price source is live and how healthy it is. */
export interface FeedStatus {
  dataSource: string;
  running?: boolean;
  passes?: number;
  lastPassAt?: number | null;
  tracked?: string[];
  priced?: number;
  unpriced?: string[];
  marketOpen?: boolean;
  nextPollMs?: number;
}

// ─── Capital allocator ───────────────────────────────────
export interface AllocationParams {
  totalCapital: number;
  reservePct: number;
  minTranche: number;
  minRungs: number;
  maxRungs: number;
  maxBooks: number;
  minScore: number;
  /** Most of capital one stock may hold when the bot sizes it, percent. */
  maxWeightPct?: number;
  /** Share of capital the index-ETF core aims for, percent (only once an ETF book exists). */
  corePct?: number;
}
export interface AllocatorStrength {
  symbol: string;
  eligible: boolean;
  reason?: string;
  bars: number;
  /** 0..1 — a ranking of what has been rising, not a forecast. */
  score: number;
  ret3mPct: number;
  ret1mPct: number;
  distFromHighPct: number;
  trendUp: boolean;
  ema50: number | null;
  ema200: number | null;
  lastClose: number;
}
export interface Allocation {
  symbol: string;
  selected: boolean;
  rank: number | null;
  score: number;
  /** deployed + unsettled + targetCash */
  targetBudget: number;
  /** Settled cash assigned to the book. 0 when not selected. */
  targetCash: number;
  tranches: number;
  weight: number;
  reason: string;
  /** True when the user fixed this budget by hand. */
  manual?: boolean;
  /** Funded from the index-ETF core share. */
  core?: boolean;
  /** A dropped stock given cash only to finish its ladder. */
  rescue?: boolean;
}
export interface AllocationPlan {
  totalCapital: number;
  /** Rupees in open lots and T+1 across all books. Never moved. */
  committed: number;
  allocatable: number;
  unallocated: number;
  /** New cash given to the stocks sized by hand. */
  manualCash?: number;
  /** New cash given to the index-ETF core. */
  coreCash?: number;
  minBudget: number;
  selected: string[];
  allocations: Allocation[];
}
export interface AllocatorRun {
  userId: string;
  at: number;
  tradingDay: string;
  params: AllocationParams;
  plan: AllocationPlan;
  strengths: Record<string, AllocatorStrength>;
}
export interface AllocatorState {
  run: AllocatorRun | null;
  params: AllocationParams;
  schedule: { due: boolean; why: string };
  events: { at: number; userId: string; kind: string; detail: string }[];
  /** Amounts the user fixed by hand, by symbol. */
  manualBudgets?: Record<string, number>;
  /** Rung counts the user fixed with those amounts, by symbol. */
  manualTranches?: Record<string, number>;
  /** Least new money a hand-set amount may add (one rung above the dust gate). */
  minManualCash?: number;
  /** The same, per stock, from its price: the smallest rung worth buying. */
  minManualCashBy?: Record<string, { newCash: number; why: string }>;
  note: string;
}

/** The scalp profile's knob values, as the server reports them. */
export interface ScalpProfile {
  targetPct: number;
  stepPct: number;
  stepGrowth: number;
  minBuyGapMs: number;
  startDiscountPct: number;
  hiLookbackDays: number;
  maxDeployPct: number;
  trail: { enabled: boolean; armPct: number; retracePct: number };
}

// ─── Recommendations ─────────────────────────────────────
export type Horizon = 'short' | 'medium' | 'long';
export type Verdict = 'strong' | 'good' | 'watch' | 'weak';

export interface SignalContribution {
  name: string;
  label: string;
  raw: number;
  /** 0..1 — this stock's rank on this signal among today's universe. */
  percentile: number;
  /** True when the stock was ranked against its SECTOR first, then globally. */
  sectorRelative: boolean;
  weight: number;
  contribution: number;
}

export interface TradePlan {
  horizon: Horizon;
  entry: number;
  entryKind: 'buy now' | 'wait for pullback' | 'wait for breakout';
  entryNote: string;
  stop: number;
  stopNote: string;
  target: number;
  targetNote: string;
  riskPerShare: number;
  stopDistancePct: number;
  rewardRisk: number;
  quantity: number;
  amount: number;
  pctOfCapital: number;
  riskAmount: number;
  rewardAmount: number;
  sizedBy: string;
  holdLabel: string;
  warnings: string[];
}

// ─── Turbulence: how rough the hold is likely to be ─────────────────────────
// Never a veto. The study behind it (WARNING_ENGINE.md) found that skipping
// extended names roughly halves returns, so this informs size and stop only.

export type TurbulenceSeverity = 'note' | 'caution' | 'serious';

export interface TurbulenceWarning {
  kind:
    | 'high-volatility'
    | 'run-up-extended'
    | 'dip-imminent'
    | 'thin-liquidity'
    | 'deep-drawdown-history';
  severity: TurbulenceSeverity;
  headline: string;
  detail: string;
  /** The base rate this rests on, always rendered beside the claim. */
  evidence: { condition: string; n: number; stat: string; baseline: string };
}

export interface PathForecast {
  bucket: string;
  bucketN: number;
  expectedDipAtr: number;
  expectedDipPct: number;
  expectedDipFrom: number;
  /** 0..1 */
  dipProbability: number;
  dipMedianDays: number;
  deepDipProbability: number;
  deepDipMedianDays: number;
  tailRisk: number;
  tailRiskMultiple: number;
  /** Mean 63-day excess return for this bucket. Positive in every bucket. */
  meanExcess63: number;
  runUpEscalated: boolean;
}

export interface Turbulence {
  symbol: string;
  forecast: PathForecast;
  warnings: TurbulenceWarning[];
  /**
   * The ATR multiple a stop must clear so the ordinary drawdown cannot reach
   * it. A floor, not a multiplier — the plan takes max(its own, this), so it
   * binds on short horizons and leaves wider ones alone.
   */
  requiredStopAtr: number;
  /** 0.5 or 1 — never 0. */
  stageNowFraction: number;
  summary: string;
}

export interface HoldingRisk {
  symbol: string;
  name: string;
  quantity: number;
  avgPrice: number;
  ltp: number;
  unrealisedPnlPct: number;
  turbulence: Turbulence | null;
  verdict: 'fine' | 'normal-dip' | 'beyond-normal' | 'deep' | 'unknown';
  note: string;
}

export interface HoldingRiskState {
  holdings: HoldingRisk[];
  baseline: { dipProbability: number; dipMedianDays: number; expectedDipAtr: number; n: number };
  note: string;
}

export interface RecMetrics {
  symbol: string;
  lastClose: number;
  mom12_1: number;
  mom6_1: number;
  mom3_1: number;
  momRiskAdj12_1: number;
  momRiskAdj6_1: number;
  momRiskAdj3_1: number;
  infoDiscreteness: number;
  ret1m: number;
  ret1w: number;
  fromHighPct: number;
  pctOf52wRange: number;
  high52w: number;
  low52w: number;
  atrPct: number | null;
  volAnnualPct: number;
  rsi14: number | null;
  adx14: number | null;
  medianTurnover: number;
  maxDrawdown1yPct: number;
  aboveSma200: boolean;
  ema20Above50: boolean;
}

export interface Headline {
  title: string;
  source: string;
  at: number;
  url: string;
  tone: number;
  matched: string[];
}

export interface Filing {
  category: string;
  detail: string;
  at: number;
  material: boolean;
}

export type BrokerAction = 'upgrade' | 'downgrade' | 'initiate' | 'target-raise' | 'target-cut' | 'reiterate';
export type BrokerStance = 'bullish' | 'neutral' | 'bearish';

/** A broker's call (Jefferies, CLSA, …) parsed from a headline. Display only — never ranked. */
export interface BrokerCall {
  broker: string;
  action: BrokerAction | null;
  rating: string | null;
  stance: BrokerStance | null;
  /** Rupees. Null when absent or implausibly far from the price. */
  target: number | null;
  /** Upside stated in the headline itself; negative for downside. */
  statedUpsidePct: number | null;
  /** Target vs the last close, percent. */
  upsidePct: number | null;
  /** Named in a list of picks rather than a call on this stock alone. */
  basket: boolean;
  title: string;
  source: string;
  at: number;
  url: string;
  /** How many outlets carried the same call. */
  echoes: number;
}

export interface BrokerSummary {
  calls: BrokerCall[];
  /** Latest single-stock call per broker. */
  bullish: number;
  neutral: number;
  bearish: number;
  note: string;
}

export interface NewsRead {
  symbol: string;
  headlines: Headline[];
  filings: Filing[];
  sentiment: number;
  scored: number;
  materialFilings: number;
  /** Absent on runs cached before broker calls existed. */
  brokers?: BrokerSummary;
  note: string;
  errors: string[];
}

export interface Recommendation {
  rank: number;
  symbol: string;
  name: string;
  score: number;
  verdict: Verdict;
  signals: SignalContribution[];
  plan: TradePlan;
  metrics: RecMetrics;
  news: NewsRead | null;
  /** How rough the hold is likely to be. Null when ATR is unusable. */
  turbulence: Turbulence | null;
  allocatedAmount: number;
  allocatedPct: number;
  duplicateOf: Horizon | null;
  /** Rank kept, capital withheld: recent coverage is strongly negative. */
  newsSuppressed: boolean;
  newsSuppressedReason?: string;
  /** NSE's own industry. Authoritative, and what the concentration cap counts. */
  sector: string;
  /** Curated categories — defence, semiconductors, green energy. Opinionated; may be empty. */
  themes: string[];
  /** Set when the sector cap trimmed this idea, with the arithmetic. */
  sectorCapped?: string;
}

export interface SectorExposure {
  sector: string;
  symbols: string[];
  amount: number;
  pct: number;
  capped: boolean;
}

export interface HorizonBucket {
  horizon: Horizon;
  label: string;
  holdLabel: string;
  budgetPct: number;
  budget: number;
  allocated: number;
  evidence: { grade: 'A' | 'B' | 'C'; note: string };
  recommendations: Recommendation[];
  note: string;
}

export interface RecommendationRun {
  at: number;
  tradingDay: string;
  capital: number;
  sizing: { capital: number; riskPerTradePct: number; maxPositionPct: number; maxTurnoverPct: number; minPositionValue: number };
  universeSize: number;
  measured: number;
  eligible: number;
  buckets: HorizonBucket[];
  vetoed: { symbol: string; name: string; reason: string }[];
  skipped: { symbol: string; reason: string }[];
  totalAllocated: number;
  totalRiskIfAllStopped: number;
  sectorExposure: SectorExposure[];
  maxSectorPct: number;
  sources: string;
  disclaimer: string;
}

export interface RecommendationState {
  run: RecommendationRun | null;
  settings: {
    sizing: { capital: number; riskPerTradePct: number; maxPositionPct: number; maxTurnoverPct: number; minPositionValue: number };
    universeSize: number;
  };
}

/** What the BROKER says the account holds. Read-only — funds move only in the broker's app. */
export interface FundsSnapshot {
  cash: number;
  usedMargin: number;
  unsettled: number;
  reserved: number;
  deployable: number;
  at: number;
  brokerName: string;
  /** True when this is the configured figure, not a real balance (paper, or the broker was unreachable). */
  simulated: boolean;
  error?: string;
}

// ── shell/auth/system ──
/** `/api/auth/*` returns `totpEnabled` on top of the base user. */
export interface AuthUser extends User {
  totpEnabled?: boolean;
}

export interface TotpEnrolment {
  secret: string;
  uri: string;
  note?: string;
}

export type SessionPhase = 'closed' | 'pre_open' | 'open' | 'post_close';

export interface ReconcileRow {
  symbol: string;
  expected: number;
  actual: number;
  difference: number;
}

export interface ReconcileResult {
  supported: boolean;
  at: number;
  reason: string;
  rows: ReconcileRow[];
  mismatched: ReconcileRow[];
  error?: string;
}

export type BufferSeedState = 'none' | 'seeding' | 'real' | 'synthetic' | 'failed';

/** GET /api/system — "is the system trustworthy right now", one screen's worth. */
export interface SystemReport {
  at: number;
  broker: string;
  dataSource: string;
  session: { phase: SessionPhase; tradingDay: boolean; describe: string };
  halted: boolean;
  halts: { key: string; reason: string }[];
  orderRate: {
    lastSecond: number;
    lastMinute: number;
    today: number;
    limits: { perSecond: number; perMinute: number; perDay: number };
  };
  guards: {
    maxQuoteAgeMs: number;
    maxFillDeviationPct: number;
    staticIp: string | null;
    staleSymbols: string[];
  };
  feed: {
    running: boolean;
    lastPassAt: number | null;
    priced: number;
    tracked: number;
    unpriced: string[];
    marketOpen: boolean;
  } | null;
  notifier: { configured: boolean; sent: number; failures: number; lastError: string | null };
  reconcile: { last: ReconcileResult | null; everyMin: number; enabled: boolean };
  strategyBuffers: { symbol: string; seed: BufferSeedState; bars: number }[];
  jwtSecretIsDefault: boolean;
  /** This user's own Zerodha connection, or null when they have not added keys. */
  brokerConnection?: { plan: BrokerPlan; tradingMode: BrokerTradingMode; status: BrokerConnectionStatus } | null;
  kiteFeed?: { active: boolean; streaming: boolean; subscribed: number; lastTickAt: number | null; error: string | null };
}

// ── broker connection (Settings → Zerodha) ──
/** `personal` = free Kite Connect plan (orders, no market data); `connect` = paid (adds live prices). */
export type BrokerPlan = 'personal' | 'connect';
export type BrokerTradingMode = 'paper' | 'live';
export type BrokerConnectionStatus = 'not_connected' | 'connected' | 'expired' | 'error';

/** GET /api/broker/zerodha — never carries a secret or a token. */
export interface BrokerConnectionView {
  broker: 'zerodha';
  configured: boolean;
  apiKeyMasked: string | null;
  plan: BrokerPlan;
  tradingMode: BrokerTradingMode;
  status: BrokerConnectionStatus;
  kiteUserId: string | null;
  kiteUserName: string | null;
  connectedAt: number | null;
  expiresAt: number | null;
  liveSince: number | null;
  lastError: string | null;
  redirectUrl: string;
  credentialsKey: { configured: boolean; matches: boolean };
  liveBlockers: string[];
  liveVenueBooks: string[];
  envBroker: string;
  staticIp: string | null;
  jwtSecretIsDefault: boolean;
  marketData: {
    feed: string;
    kiteActive: boolean;
    kiteStreaming: boolean;
    providedByYou: boolean;
    subscribed: number;
    lastTickAt: number | null;
    error: string | null;
  };
}

/** Shares per symbol as Kite reports them, with the parts that make up the total. */
export interface BrokerHeldRow {
  symbol: string;
  quantity: number;
  averagePrice: number;
  holdings: number;
  t1: number;
  todayCnc: number;
  usedToday: number;
}

export interface BrokerTestResult {
  at: number;
  profile: { userId: string; userName: string; broker: string; exchanges: string[]; products: string[] };
  funds: { cash: number; usedMargin: number };
  held: BrokerHeldRow[];
  marketData: { status: 'available' | 'not_on_plan' | 'unknown'; detail: string };
  planMismatch: string | null;
}

export interface StaticIpCheck {
  ok: boolean;
  ip: string | null;
  expected: string;
}

export interface EquitySnapshot {
  userId: string;
  day: string;
  at: number;
  equity: number;
  cash: number;
  deployed: number;
  realisedToDate: number;
  chargesToDate: number;
  flow: number;
  nifty?: number;
}

export interface AuditEntry {
  id: string;
  at: number;
  userId?: string;
  /** 'order' | 'risk' | 'fill' | 'reject' | 'guard' | 'engine' | 'auth' | 'reconcile' | 'system' */
  kind: string;
  symbol?: string;
  detail: string;
  data?: Record<string, unknown>;
}

/** Pushed over the WebSocket as `{ type: 'notice', data }`. */
export interface Notice {
  level: 'info' | 'warn' | 'critical';
  text: string;
}

// ── trading ──
// Shapes for the trade page (ticket, watchlists, triggers), the backtest page
// and the system status. Mirrors BE/src/types/index.ts and the route responses.

/** One row of GET /api/system strategyBuffers (the SystemStatus type lives in the shell block above). */
export interface StrategyBufferStatus {
  symbol: string;
  seed: 'none' | 'seeding' | 'real' | 'synthetic' | 'failed';
  bars: number;
}
/** The slice of GET /api/system the trading surfaces read (the shell block above types the full report). */
export interface TradingSystemStatus {
  at: number;
  session: { phase: 'closed' | 'pre_open' | 'open' | 'post_close'; tradingDay: boolean; describe: string };
  halted: boolean;
  strategyBuffers: StrategyBufferStatus[];
}

/** One leg's statutory + broker charges, as /api/orders/preview reports them. */
export interface ChargeBreakdown {
  brokerage: number;
  stt: number;
  exchangeTxn: number;
  gst: number;
  sebi: number;
  stampDuty: number;
  dpCharge: number;
  total: number;
}

export type ProductType = 'MIS' | 'CNC';
export type OrderKind = 'MARKET' | 'LIMIT';

/** GET /api/orders/preview */
export interface OrderPreview {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  product: ProductType;
  /** the price the charges were computed at (limit price, else LTP) */
  price: number;
  notional: number;
  tradable: boolean;
  tradableReason: string | null;
  charges: { entry: ChargeBreakdown; exit: ChargeBreakdown; roundTrip: number; roundTripPct: number };
  /** fee-inclusive breakeven for the round trip */
  breakeven: number;
  /** signed quantity already held (+long / −short) */
  existingPosition: number;
  /** previous close */
  reference: number | null;
  quoteAgeMs: number | null;
}

/** POST /api/orders body from the ticket. */
export interface TicketOrderRequest {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  orderType: OrderKind;
  product: ProductType;
  price?: number;
  /** the LTP the ticket displayed when the order was confirmed */
  referencePrice: number;
  /** idempotency key — one per click */
  clientOrderId: string;
}

/** The order as the server returns it: `Order` plus the execution-quality fields. */
export interface PlacedOrder extends Order {
  product?: ProductType;
  price?: number;
  referencePrice?: number;
  clientOrderId?: string;
  charges?: number;
  /** the quantity the caller asked for, when the risk gate trimmed it */
  requestedQuantity?: number;
  /** why `quantity` differs from `requestedQuantity` */
  adjustment?: string;
  /** fill vs reference, basis points, signed against the trader (positive = worse) */
  slippageBps?: number;
  submittedAt?: number;
  ackAt?: number;
  updatedAt?: number;
}

export interface PlaceOrderResponse {
  order: PlacedOrder;
  /** a sentence when the risk gate trimmed the quantity, else null */
  adjustment: string | null;
}

/** Signal fields the detail page shows when present (BE Signal has them; the base FE type does not). */
export interface SignalExtras {
  stopLoss?: number;
  takeProfit?: number;
  stopPct?: number;
  targetPct?: number;
  referencePrice?: number;
}

// Watchlists
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
export interface WatchlistQuote {
  ltp: number;
  /** previous close, or null when the feed has none */
  reference: number | null;
}
/** GET /api/watchlists row: the list plus a quote per symbol. */
export interface WatchlistView extends Watchlist {
  quotes: Record<string, WatchlistQuote>;
}

// Triggers (GTT / OCO / trailing)
export type TriggerStatus = 'ACTIVE' | 'TRIGGERED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
export type TriggerRole = 'single' | 'target' | 'stop';
export interface TriggerLeg {
  role: TriggerRole;
  side: 'BUY' | 'SELL';
  triggerPrice: number;
  fireWhen: 'above' | 'below';
  orderType: OrderKind;
  price?: number;
  quantity: number;
}
export interface Trigger {
  id: string;
  userId: string;
  symbol: string;
  product: ProductType;
  kind: 'single' | 'oco';
  legs: TriggerLeg[];
  trailPct?: number;
  extreme?: number;
  autoCancelWhenFlat?: boolean;
  status: TriggerStatus;
  note?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  triggeredAt?: number;
  firedLeg?: TriggerRole;
  resultOrderId?: string;
  failReason?: string;
}
/** POST /api/triggers body. */
export interface TriggerCreateRequest {
  symbol: string;
  product: ProductType;
  kind: 'single' | 'oco';
  legs: Omit<TriggerLeg, 'fireWhen'>[];
  trailPct?: number;
  expiresAt?: number;
  note?: string;
  autoCancelWhenFlat?: boolean;
}

// Backtest
export type BacktestSource = 'yahoo' | 'sim' | 'zerodha' | 'supplied';
export type BacktestInterval = '1m' | '5m' | '15m' | '1h' | '1d';
export interface DeflatedSharpe {
  probability: number;
  benchmarkSharpe: number;
  trials: number;
  note: string;
}
export interface BacktestHonesty {
  runId: string;
  /** runs of this strategy on this symbol (same source) so far, this one included */
  trials: number;
  deflatedSharpe: DeflatedSharpe;
  /** Bailey et al. MinBTL — periods needed for the Sharpe to beat the luck of `trials` tries */
  minBacktestLength: number;
  /** periods (closed trades) in this run */
  periods: number;
}
export interface BacktestResponse {
  result: BacktestResult & { from?: number; to?: number };
  source: BacktestSource;
  interval: string;
  /** e.g. "daily bars, last 5 years" or "SIMULATED random walk — …" */
  note: string;
  bars: number;
  honesty: BacktestHonesty;
}
/** One row of the trial ledger (GET /api/backtest/runs). */
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
  periodSharpe: number;
  skew: number;
  kurtosis: number;
}
export type OptimizeMetrics = Omit<BacktestResult, 'equityCurve' | 'tradeLog'>;
export interface OptimizeResult {
  params: Record<string, number>;
  train: OptimizeMetrics;
  test: OptimizeMetrics;
  /** train.expectancy − test.expectancy; large positive = the edge did not survive */
  decayPct: number;
}
export interface OptimizeResponse {
  results: OptimizeResult[];
  trainRatio: number;
  source: BacktestSource;
  interval: string;
  bars: number;
  trialsRecorded: number;
  note: string;
}
/** POST /api/backtest/compare — the full response (the older `StrategyComparison` type predates source/note). */
export interface StrategyComparisonResponse {
  symbol: string;
  runs: number;
  source: BacktestSource;
  interval: string;
  bars: number;
  note: string;
  results: (StrategyComparisonRow | { strategyType: string; error: string })[];
}

// ── analytics/journal ──
export type NavRange = '1y' | 'all';
export type NavPointSource = 'baseline' | 'reconstructed' | 'snapshot' | 'carried' | 'live';
export interface NavPoint {
  /** IST day, YYYY-MM-DD */
  day: string;
  equity: number;
  /** unit price, base 1000, flow-adjusted */
  nav: number;
  nifty: number | null;
  /** NIFTY 50 rebased to 1000 on the first day of the series */
  niftyNav: number | null;
  deployed: number;
  flow: number;
  source: NavPointSource;
}
export interface NavStats {
  spanDays: number;
  totalReturnPct: number;
  cagrPct: number;
  volPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  maxDrawdownDays: number;
  currentDrawdownPct: number;
  timeInMarketPct: number;
  niftyReturnPct: number | null;
  activeReturnPct: number | null;
}
export interface MonthRow {
  /** YYYY-MM */
  month: string;
  pnl: number;
  pct: number;
  niftyPct: number | null;
}
export interface DrawdownRow {
  start: string;
  trough: string;
  end: string | null;
  depthPct: number;
  days: number;
}
export interface CostSummary {
  charges: number;
  grossProfit: number;
  netProfit: number;
  costSharePct: number | null;
}
export interface TradeStatsSummary {
  n: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgWin: number;
  avgLoss: number;
  payoff: number | null;
  expectancy: number;
  profitFactor: number | null;
  medianHoldDays: number;
}
export interface NavReport {
  range: NavRange;
  points: NavPoint[];
  stats: NavStats;
  monthly: MonthRow[];
  drawdowns: DrawdownRow[];
  costs: CostSummary;
  tradeStats: TradeStatsSummary;
  meta: { snapshots: number; reconstructedDays: number; niftyDays: number; events: number; note: string };
  capital: number;
  live: { equity: number; cash: number; deployed: number; realisedToDate: number; chargesToDate: number };
  nifty: { at: number; days: number; ok: boolean } | null;
}
export interface ExecutionReport {
  totals: {
    orders: number;
    filled: number;
    rejected: number;
    cancelled: number;
    pending: number;
    adjusted: number;
    refused: number;
    fillRatePct: number | null;
  };
  byDay: { day: string; filled: number; rejected: number; cancelled: number; refused: number }[];
  byTag: { tag: string; n: number; filled: number; rejected: number; cancelled: number }[];
  slippage: { n: number; meanBps: number | null; medianBps: number | null; p90Bps: number | null; worstBps: number | null };
  latency: { n: number; meanMs: number | null; p90Ms: number | null; maxMs: number | null };
  rejections: { reason: string; n: number; fromOrders: number; fromGuards: number; fromRisk: number; example: string }[];
  adjusted: { id: string; symbol: string; side: string; requested: number | null; quantity: number; adjustment: string; createdAt: number }[];
}
export interface JournalNote {
  tradeId: string;
  userId: string;
  setup?: string;
  note?: string;
  ruleBreak?: boolean;
  updatedAt: number;
}
export interface JournalRow {
  id: string;
  source: 'trade' | 'lot';
  symbol: string;
  side: 'BUY' | 'SELL';
  status: 'OPEN' | 'CLOSED';
  entry: number;
  exit: number | null;
  quantity: number;
  pnl: number | null;
  charges: number;
  tags: string[];
  openedAt: number;
  closedAt: number | null;
  holdMs: number | null;
  maePct: number | null;
  mfePct: number | null;
  stopLoss: number | null;
  rMultiple: number | null;
  exitReason: string | null;
  invalid: boolean;
  invalidReason: string | null;
  note: JournalNote | null;
}
export interface TagSummary {
  tag: string;
  n: number;
  pnl: number;
  winRatePct: number;
  avgR: number | null;
  avgHoldDays: number;
}
export interface OverrideSummary {
  n: number;
  pnl: number;
  winRatePct: number;
}
export interface JournalReport {
  rows: JournalRow[];
  tags: string[];
  byTag: TagSummary[];
  overridesVsSystem: { manual: OverrideSummary; system: OverrideSummary };
  filter: { tag?: string; from?: string; to?: string };
  counts: { total: number; closed: number; open: number; invalid: number; lots: number; shown: number };
}

// ── future stars ──
/** How much weight the published evidence justifies for a pillar. */
export type FsGrade = 'A' | 'B' | 'C';
export type FsVerdict = 'accumulate' | 'stage-in' | 'watch' | 'too-early' | 'avoid';

export interface FsPillar {
  key: string;
  label: string;
  score: number;
  weight: number;
  contribution: number;
  grade: FsGrade;
  detail: string;
  /** true when the pillar is a hand-written judgement rather than measured data */
  curated: boolean;
}

export interface FsOrderWin {
  at: number;
  category: string;
  detail: string;
  valueInr: number | null;
  customer: string | null;
  url: string | null;
}

export interface FsOrderFlow {
  symbol: string;
  recent: FsOrderWin[];
  prior: FsOrderWin[];
  recentCount: number;
  priorCount: number;
  recentValueInr: number;
  priorValueInr: number;
  /** null unless most recent wins disclosed a value */
  bookToBill: number | null;
  valueCoverage: number;
  daysSinceLast: number | null;
  unpriced: number;
  error?: string;
}

export interface FsQuarter {
  end: string;
  label: string | null;
  consolidated: boolean;
  revenue: number;
  profit: number;
  pbt: number | null;
  filedAt: number;
}

export interface FsGrowth {
  symbol: string;
  quarters: FsQuarter[];
  revenueYoYPct: number | null;
  profitYoYPct: number | null;
  revenueYoYPriorPct: number | null;
  revenueAccelerationPct: number | null;
  ttmRevenue: number | null;
  ttmProfit: number | null;
  marginPct: number | null;
  marginYearAgoPct: number | null;
  positiveStreak: number;
  /** the quarter the latest figure was compared against */
  comparedWith: string | null;
  ageDays: number | null;
  error?: string;
}

export interface FsPolicyTag {
  scheme: string;
  why: string;
  since: number;
}

export interface FsPolicyRead {
  symbol: string;
  tags: FsPolicyTag[];
  critical: string[];
  raw: number;
}

export interface FsRiskFlag {
  kind: 'dilution' | 'pledge' | 'regulatory' | 'auditor' | 'governance' | 'valuation' | 'liquidity' | 'surveillance';
  detail: string;
  severity: number;
  at?: number;
}

export interface FsTranche {
  n: number;
  trigger: string;
  sharePct: number;
  amount: number;
  quantity: number;
  price: number;
  timing: string;
}

export interface FsEntryPlan {
  amount: number;
  pctOfCapital: number;
  tranches: FsTranche[];
  invalidation: string;
  invalidationPrice: number | null;
  riskAmount: number;
  nextCheck: string;
  holdLabel: string;
  warnings: string[];
}

export interface FutureStar {
  rank: number;
  symbol: string;
  name: string;
  sector: string;
  themes: string[];
  score: number;
  verdict: FsVerdict;
  /** false = it made the list but not the budget */
  funded: boolean;
  thesis: string;
  pillars: FsPillar[];
  orders: FsOrderFlow;
  growth: FsGrowth;
  policy: FsPolicyRead;
  risks: FsRiskFlag[];
  plan: FsEntryPlan;
  price: {
    last: number;
    high52w: number;
    low52w: number;
    /** 0..100 */
    pctOf52wRange: number;
    fromHighPct: number;
    aboveSma200: boolean;
    sma200: number | null;
    ret1yPct: number;
    atrPct: number | null;
    medianTurnover: number;
  };
}

export interface FutureStarsRun {
  at: number;
  tradingDay: string;
  capital: number;
  universeSize: number;
  measured: number;
  scored: number;
  stars: FutureStar[];
  rejected: { symbol: string; name: string; reason: string }[];
  skipped: { symbol: string; reason: string }[];
  totalIfAllStaged: number;
  categoryCapPct: number;
  /** how far short of a diversified list this is, stated rather than hidden */
  concentration: {
    fundedCount: number;
    recommendedMinimum: number;
    tooConcentrated: boolean;
    note: string;
  };
  sources: string;
  evidence: string;
  disclaimer: string;
}

export interface FutureStarsState {
  run: FutureStarsRun | null;
  settings: {
    plan: { capital: number; categoryCapPct: number; maxPositionPct: number; minPositionValue: number; maxTurnoverPct: number };
    weights: Record<string, number>;
    gates: Record<string, number>;
    schemes: string[];
    policyUniverseSize: number;
    universeSize: number;
  };
}

// ── turnarounds ──
export type TurnVerdict = 'buy-the-base' | 'watch-for-a-base' | 'too-early' | 'avoid';

export interface TurnPrice {
  last: number;
  high52w: number;
  low52w: number;
  pctOf52wRange: number;
  fromHighPct: number;
  aboveSma200: boolean;
  sma200: number;
  ema20: number;
  ema50: number;
  ema20Above50: boolean;
  low20: number;
  ret1m: number;
  mom3_1: number;
  mom6_1: number;
  mom12_1: number;
  maxDrawdown1yPct: number;
  rsi14: number | null;
  atrPct: number | null;
  volAnnualPct: number;
  medianTurnover: number;
}

export interface ShareholdingQuarter {
  date: string;
  promoterPct: number;
  publicPct: number | null;
  xbrl: string | null;
}

export interface Shareholding {
  symbol: string;
  quarters: ShareholdingQuarter[];
  latestPct: number | null;
  yearAgoPct: number | null;
  /** percentage points; negative = the promoter sold or was diluted */
  changePct: number | null;
  pledged: boolean | null;
  encumbrance: string[];
  error?: string;
}

export interface TurnEntry {
  trigger: string;
  triggerPrice: number | null;
  stop: number;
  stopDistancePct: number;
  amount: number;
  quantity: number;
  pctOfCapital: number;
  riskAmount: number;
  timeStop: string;
  nextCheck: string;
  holdLabel: string;
  warnings: string[];
}

export interface Turnaround {
  rank: number;
  symbol: string;
  name: string;
  sector: string;
  themes: string[];
  score: number;
  verdict: TurnVerdict;
  funded: boolean;
  thesis: string;
  pillars: FsPillar[];
  growth: FsGrowth;
  shareholding: Shareholding;
  risks: FsRiskFlag[];
  entry: TurnEntry;
  price: TurnPrice;
}

export interface TurnaroundRun {
  at: number;
  tradingDay: string;
  capital: number;
  universeSize: number;
  measured: number;
  scored: number;
  candidates: Turnaround[];
  rejected: { symbol: string; name: string; reason: string }[];
  skipped: { symbol: string; reason: string }[];
  totalIfAllTriggered: number;
  categoryCapPct: number;
  concentration: { fundedCount: number; recommendedMinimum: number; tooConcentrated: boolean; note: string };
  sources: string;
  evidence: string;
  disclaimer: string;
}

export interface TurnaroundState {
  run: TurnaroundRun | null;
  settings: {
    plan: { capital: number; categoryCapPct: number; riskPerIdeaPct: number; maxPositionPct: number; minPositionValue: number; maxTurnoverPct: number };
    weights: Record<string, number>;
    band: Record<string, number>;
    universeSize: number;
  };
}

// ── idle-cash sweep ──
export interface SweepEvent {
  at: number;
  userId: string;
  kind: 'PARK' | 'REDEEM' | 'SKIP' | 'REJECT' | 'HALT' | 'CONFIG';
  detail: string;
}

/** `/api/sweep`: the books' spare cash parked in a liquid ETF. */
export interface SweepReport {
  enabled: boolean;
  symbol: string;
  venue: 'paper' | 'live' | null;
  haltedReason: string | null;
  price: number;
  units: number;
  usableUnits: number;
  /** Bought today or yesterday: their sale would not fund a buy today (T1 rule). */
  lockedUnits: number;
  nextUnlockDate: string | null;
  parkedValue: number;
  cashOut: number;
  /** Income so far, realised and marked, after charges. */
  gain: number;
  realisedGain: number;
  chargesPaid: number;
  /** Σ book cash — settled money the books are waiting to spend. */
  idleCash: number;
  /** The part of it physically in the account. */
  cashOnHand: number;
  buffer: number;
  /** The ETF's trailing one-month return, annualised. */
  yieldPct: number | null;
  lastParkDay: string | null;
  params: { symbol: string; minBufferRs: number; minParkRs: number; parkFrom: string; parkUntil: string; topUpFrom: string };
  lots: { id: string; quantity: number; price: number; boughtOn: string; usableFrom: string; usable: boolean }[];
  events: SweepEvent[];
}

// ─── Tax (capital gains, FIFO) ───────────────────────────────────────────
export interface TaxMatch {
  symbol: string;
  quantity: number;
  boughtAt: number;
  soldAt: number;
  cost: number;
  proceeds: number;
  gain: number;
  longTerm: boolean;
  fy: string;
}
export interface TaxYear {
  fy: string;
  shortTermGains: number;
  shortTermLosses: number;
  longTermGains: number;
  longTermLosses: number;
  broughtForwardUsed: number;
  taxableShortTerm: number;
  netLongTerm: number;
  taxableLongTerm: number;
  estimatedTax: number;
  carryForward: { shortTerm: number; longTerm: number };
  enginePnl: number;
  sales: number;
}
export interface TaxHarvest {
  symbol: string;
  quantity: number;
  price: number;
  shortTerm: number;
  longTerm: number;
  taxBefore: number;
  taxAfter: number;
  cost: number;
  netBenefit: number;
}
export interface TaxReport {
  venue: 'paper' | 'live';
  taxable: boolean;
  currentFy: string;
  years: TaxYear[];
  matches: TaxMatch[];
  holdings: { symbol: string; boughtAt: number; quantity: number; cost: number; price: number }[];
  unmatched: { symbol: string; at: number; quantity: number }[];
  harvest: TaxHarvest[];
  sweepSlabIncomeByFy: Record<string, number>;
  notes: string[];
}
export interface SymbolFlagsResponse {
  symbol: string;
  asm?: string;
  gsm?: string;
  esm?: string;
  lastResultsDay: string | null;
  upcoming: { kind: 'results' | 'other'; date: string; detail: string }[];
  warnings: string[];
  error: string | null;
}

/** What an amount and rung count would do to a book, from the engine's own ladder maths. */
export interface RungPlan {
  budget: number;
  reservePct: number;
  rungs: number;
  bought: number;
  toBuy: number;
  perRung: number;
  minRungs: number;
  maxRungs: number;
  minPerRung: number;
  error: string | null;
}

// ── Market Weather (GET /api/market-weather) ──

export type WeatherLevel = 'calm' | 'unsettled' | 'stormy' | 'severe';
export type WeatherGrade = 'A' | 'B' | 'C';

export type WeatherSignalKind = 'warning' | 'turbulence' | 'calm';

export interface WeatherSignal {
  id: string;
  kind: WeatherSignalKind;
  label: string;
  detail: string;
  on: boolean | null;
  grade: WeatherGrade;
  direction: 'higher' | 'lower' | 'mixed';
  reason: string;
  oddsWhenOn: number | null;
  baseline: number | null;
  liftHalves: [number | null, number | null];
  episodes: number;
  meanFwdRet: number | null;
  oddsRecent: number | null;
  baselineRecent: number | null;
  recentFrom: string | null;
  dipOddsWhenOn: number | null;
  dipBaseline: number | null;
}

export interface WeatherForward {
  horizonDays: number;
  days: number;
  median: number | null;
  p10: number | null;
  p90: number | null;
  shareHigher: number | null;
}

export interface WeatherAnalogs {
  spec: { describe: string };
  episodes: string[];
  completeEpisodes: number;
  forward: WeatherForward[];
  furtherFallOdds: number | null;
  worstFurtherFallP10: number | null;
  baselineForward: WeatherForward[];
  baselineFallOdds: number | null;
  recentFrom: string;
  furtherFallOddsRecent: number | null;
  baselineFallOddsRecent: number | null;
  recentMatchDays: number;
}

export interface WeatherHeadline {
  title: string;
  source: string;
  at: number;
  url: string;
  labels: string[];
}

export interface WeatherLabelHistory {
  label: string;
  events: number;
  medianFirstDayPct: number | null;
  medianWorst60Pct: number | null;
  medianRecoveryDays: number | null;
  higherAfter60: number | null;
}

export interface WeatherEvent {
  label: string;
  title: string;
  headlines: WeatherHeadline[];
  history: WeatherLabelHistory | null;
  historyFrom: string | null;
  hit: string;
  held: string;
}

export interface WeatherSector {
  sector: string;
  members: number;
  inFall: { meanPp: number | null; beat: number; n: number };
  rebound: { meanPp: number | null; beat: number; n: number };
  downBeta: number | null;
  upBeta: number | null;
}

export interface WeatherRuleSegment {
  cagr: number;
  maxDD: number;
  avgExposure: number;
  matchedCagr: number;
  matchedMaxDD: number;
  edgePp: number;
}

export interface WeatherRule {
  id: string;
  label: string;
  all: WeatherRuleSegment;
  halves: [WeatherRuleSegment, WeatherRuleSegment];
}

export interface WeatherEventMove {
  date: string;
  label: string;
  name: string;
  firstDayPct: number;
  d20Pct: number | null;
  worst60Pct: number;
  recoveryDays: number | null;
}

export interface WeatherHolding {
  symbol: string;
  value: number;
  weight: number;
  sector: string;
  downBeta: number | null;
  ifIndexMinus10Pct: number | null;
  defensive: boolean;
}

export interface WeatherExposure {
  totalValue: number;
  downBeta: number | null;
  ifIndexMinus10Pct: number | null;
  defensiveShare: number;
  coverage: number;
  holdings: WeatherHolding[];
  bySector: { sector: string; weight: number }[];
  itDefensive: boolean;
}

export interface WeatherVerdict {
  action: 'invest' | 'invest-in-steps' | 'hold';
  steps: 'standard' | 'smaller' | 'front-loaded';
  title: string;
  oneLine: string;
  example: string;
  why: string[];
  never: string;
}

export interface WeatherStockCall {
  symbol: string;
  sector: string;
  held: boolean;
  score: number;
  downBeta: number | null;
  ifIndexMinus10Pct: number | null;
  trend12m: number | null;
  belowLongTrend: boolean | null;
  tags: { points: number; text: string }[];
}

export interface WeatherStockCalls {
  careful: WeatherStockCall[];
  resilient: WeatherStockCall[];
  scored: number;
  activeEvents: string[];
}

export interface MarketWeather {
  computedAt: number;
  verdict: WeatherVerdict;
  stocks: WeatherStockCalls | null;
  summary: { level: WeatherLevel; headline: string; drivers: string[]; odds: string[]; guidance: string[]; note: string };
  state: {
    date: string;
    close: number;
    fromAthPct: number;
    phase: string;
    vs200Pct: number | null;
    deathCross: boolean | null;
    ret3mPct: number | null;
    ret12mPct: number | null;
    breadthPct: number | null;
    at52wLowPct: number | null;
    breadthCoverage: number;
    indiaVix: number | null;
    indiaVix5dPct: number | null;
    spxVs200Pct: number | null;
    usVix: number | null;
    brent: number | null;
    brent3mPct: number | null;
    brentDaysAbove90: number;
    usdinr: number | null;
    usdinr3mPct: number | null;
    us10y: number | null;
    us10y6mChange: number | null;
  };
  signals: WeatherSignal[];
  analogs: WeatherAnalogs | null;
  valuation: { date: string; pe: number; pb: number; dy: number; pePctConsolidated: number | null; pbPctAll: number | null } | null;
  events: WeatherEvent[];
  headlines: WeatherHeadline[];
  escalation: {
    brent: number | null;
    brentDaysAbove90: number;
    brentDaysAbove100: number;
    flows: { date: string; fiiNet: number | null; diiNet: number | null }[];
    fiiNet5d: number | null;
    diiNet5d: number | null;
  };
  sectors: WeatherSector[];
  leaders: { heldUp: string[]; ledRebound: string[] };
  rules: WeatherRule[];
  supportedSignals: string[];
  eventHistory: WeatherEventMove[];
  calibration: {
    index: string;
    from: string;
    to: string;
    split: string;
    baseline: { all: { hitRate: number | null }; halves: [{ hitRate: number | null }, { hitRate: number | null }] };
    sectorFallsFrom: string | null;
  };
  health: { gauges: string[]; stocks: number; failedStocks: number; breadthCoverage: number; newsErrors: string[]; flowsError: string | null };
  exposure: WeatherExposure | null;
  status: { ready: boolean; refreshing: boolean; lastError: string | null; computedAt: number | null };
}

/** 202 while the first snapshot is being built. */
export interface MarketWeatherPending {
  status: { ready: boolean; refreshing: boolean; lastError: string | null };
}

// ── Global Markets (GET /api/global-markets) ──

export interface GlobalMetrics {
  asOf: string;
  last: number;
  ret1m: number | null;
  ret3m: number | null;
  ret6m: number | null;
  ret12m: number | null;
  cagr3y: number | null;
  cagr5y: number | null;
  mom12_1: number | null;
  mom6_1: number | null;
  vol1y: number | null;
  maxDD3y: number | null;
  fromHigh: number | null;
  uptrend: boolean | null;
}

export interface GlobalAccessInstrument {
  name: string;
  how: 'nse-etf' | 'india-fof' | 'lrs';
  symbol?: string;
  note?: string;
}

export interface GlobalAccess {
  summary: string;
  instruments: GlobalAccessInstrument[];
}

export interface GlobalMarketRow {
  code: string;
  name: string;
  region: string;
  indexName: string;
  currency: string;
  score: number | null;
  rank: number | null;
  inr: GlobalMetrics | null;
  local12m: number | null;
  corrWithIndia: number | null;
  access: GlobalAccess | null;
}

export interface GlobalStockRow {
  ticker: string;
  name: string;
  country: string;
  countryName: string;
  score: number | null;
  inr: GlobalMetrics | null;
}

export interface GlobalStrategy {
  id: string;
  label: string;
  cagr: number;
  maxDD: number;
  vol: number;
  halves: [number, number];
  edgeHalves: [number, number];
  curve: { month: string; value: number }[];
  holding: string[];
}

export interface GlobalEtfPremium {
  symbol: string;
  name: string;
  price: number | null;
  priceDate: string | null;
  nav: number | null;
  navDate: string | null;
  premium: number | null;
  overpriced: boolean;
}

export interface GlobalMarkets {
  computedAt: number;
  asOf: string;
  etfs: GlobalEtfPremium[];
  premiumWarn: number;
  facts: string[];
  markets: GlobalMarketRow[];
  strongest: string[];
  leaders: Record<string, GlobalStockRow[]>;
  globalLeaders: GlobalStockRow[];
  backtest: { from: string; to: string; split: string; months: number; strategies: GlobalStrategy[]; rankingWorked: boolean };
  health: { tickers: number; failed: string[] };
  status: { ready: boolean; refreshing: boolean; lastError: string | null };
}

export interface GlobalMarketsPending {
  status: { ready: boolean; refreshing: boolean; lastError: string | null };
}

// ── Foreign stocks (GET /api/foreign-stocks) ──

export interface ForeignQuality {
  asOfYear: number | null;
  roa: number | null;
  cfoa: number | null;
  accruals: number | null;
  leverage: number | null;
  roaVol: number | null;
  score: number | null;
  junk: boolean;
  weak: string[];
}

export interface ForeignRow {
  ticker: string;
  name: string;
  sector: string;
  country: string;
  kind: 'sp500' | 'adr';
  priceUsd: number;
  priceInr: number | null;
  ret12mUsd: number | null;
  ret12mInr: number | null;
  ret6mUsd: number | null;
  volPct: number;
  fromHighPct: number;
  typicalDipPct: number | null;
  score: number;
  verdict: 'strong' | 'good' | 'watch' | 'weak';
  vetoed: boolean;
  vetoReason: string | null;
  why: { label: string; percentile: number }[];
  quality: ForeignQuality | null;
  /** Rank in the momentum list (1–20 top picks, 21–40 second tier). */
  rank?: number;
  tier?: 1 | 2;
  /** Plan, reasons, analysts, news and filings: picks and bounce-backs only. */
  detail?: ForeignDetail;
}

export interface ForeignHeadline {
  title: string;
  source: string;
  at: number;
  url: string;
  tone: number;
  matched: string[];
}

export interface ForeignDetail {
  levels: { buyLow: number; buyHigh: number; review: number; reviewPct: number; reviewBasis: string; rangeLow: number; rangeHigh: number };
  reasons: { grade: 'A' | 'B' | 'C'; stance: 'good' | 'bad' | 'info'; text: string }[];
  analyst: { target: number | null; targetLow: number | null; targetHigh: number | null; buy: number; hold: number; sell: number; upside: number | null } | null;
  earningsDate: string | null;
  earningsSoon: boolean;
  news: { headlines: ForeignHeadline[]; sentiment: number; scored: number; veto: boolean; note: string; offTopic: number } | null;
  events: { date: string; item: string; text: string; level: 'red' | 'amber' | 'info' }[] | null;
  withheld: string | null;
  quarter: { latestEnd: string | null; revenueGrowth: number | null; margin: number | null; marginYearAgo: number | null } | null;
  /** Short / intermediate / long targets (top picks only). */
  targets?: ForeignHorizonTarget[];
  /** Why suggested, why it may keep rising, risks. */
  outlook?: { why: string[]; growth: { grade: 'A' | 'B' | 'C'; text: string }[]; risks: string[] };
}

export interface ForeignHorizonTarget {
  key: 'short' | 'medium' | 'long';
  label: string;
  days: number;
  base: number;
  low: number;
  high: number;
  basePct: number;
  lowPct: number;
  highPct: number;
  upRate: number;
  edge: boolean;
}

export interface ForeignHorizonStat {
  key: 'short' | 'medium' | 'long';
  days: number;
  label: string;
  n: number;
  upRate: number;
  picksMean: [number, number];
  allMean: [number, number];
  edge: boolean;
  oos: { n: number; insideMiddle: number; aboveBase: number };
}

export interface ForeignBounceRow extends ForeignRow {
  fallPct: number;
  bounceScore: number;
  flags: string[];
  clean: boolean;
  deep: boolean;
}

export interface ForeignBounceLine {
  id: 'equal' | 'fallen' | 'bouncePrice' | 'bounce' | 'bounceTop';
  label: string;
  cagr: number;
  maxDD: number;
  halves: [number, number];
  avgHoldings: number;
  emptyMonths: number;
}

export interface ForeignBounceBacktest {
  from: string;
  to: string;
  split: string;
  months: number;
  lines: ForeignBounceLine[];
  years: { year: string; equal: number; fallen: number; bounce: number; bouncePrice: number }[];
  passed: boolean;
  pricePassed: boolean;
  calibration: { observations: number; inside: number; above: number; below: number };
}

export interface ForeignBtLine {
  id: string;
  label: string;
  cagr: number;
  maxDD: number;
  halves: [number, number];
  edgeHalves: [number, number];
  avgHoldings: number;
}

export interface ForeignStocks {
  computedAt: number;
  asOf: string;
  usdInr: number | null;
  usdInr12m: number | null;
  picks: ForeignRow[];
  bySector: Record<string, ForeignRow[]>;
  adrs: ForeignRow[];
  avoid: ForeignRow[];
  counts: { universe: number; measured: number; eligible: number; junk: number; downtrend: number; noFundamentals: number };
  backtest: { from: string; to: string; split: string; months: number; lines: ForeignBtLine[]; worked: boolean; vetoWorked: boolean } | null;
  bounce?: { qualified: ForeignBounceRow[]; rejected: { ticker: string; name: string; fallPct: number; reason: string }[]; capPct: number; funded: boolean };
  bounceBacktest?: ForeignBounceBacktest | null;
  horizonStudy?: { from: string; to: string; split: string; stats: ForeignHorizonStat[]; stats2?: ForeignHorizonStat[] } | null;
  /** Ranks 21–40. */
  more?: ForeignRow[];
  startHere?: { ready: string[]; skipped: { ticker: string; why: string }[] };
  market?: { sectors: { ticker: string; name: string; ret1d: number | null; ret1w: number | null; ret1m: number | null }[]; headlines: ForeignHeadline[] };
  facts: string[];
  health: { failed: string[] };
  status: { ready: boolean; refreshing: boolean; lastError: string | null };
}

export interface ForeignStocksPending {
  status: { ready: boolean; refreshing: boolean; lastError: string | null };
}

// ── "add money now?" lights (BE services/addSignal/signal.ts) ──
export type AddLight = 'green' | 'yellow' | 'red' | 'grey';

export interface AddSignal {
  symbol: string;
  light: AddLight;
  label: string;
  /** nowAmount as a share of the plan, 0..100. */
  nowPct: number;
  /** Rupees to add now, whole shares when the price is known. */
  nowAmount: number;
  nowShares: number | null;
  planned: number;
  action: string;
  reasons: string[];
  notes: string[];
}

export interface AddSignalsResponse {
  computedAt: number;
  market: { action: 'invest' | 'invest-in-steps' | 'hold'; steps: string; title: string; reason?: string; computedAt: number | null } | null;
  capital: number;
  capPct: number;
  signals: Record<string, AddSignal>;
  counts: Record<AddLight, number>;
  staleNote?: string;
}
