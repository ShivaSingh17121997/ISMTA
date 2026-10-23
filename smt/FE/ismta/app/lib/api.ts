'use client';

import type {
  AddSignalsResponse,
  ForeignStocks,
  ForeignStocksPending,
  GlobalMarkets,
  GlobalMarketsPending,
  MarketWeather,
  MarketWeatherPending,
  BacktestResult,
  StrategyComparison,
  Order,
  PortfolioSummary,
  Position,
  RiskAlert,
  RiskSnapshot,
  Signal,
  Strategy,
  StrategyType,
  Trade,
  User,
  AccumulatorBook,
  AccumulatorEvent,
  AccumulatorLot,
  AccumulatorParams,
  AccumulatorReport,
  ForceSellPreview,
  ForceSellResult,
  Instrument,
  Candle,
  FeedStatus,
  FundsSnapshot,
  SweepReport,
  RecommendationState,
  HoldingRiskState,
  RecommendationRun,
  ScalpProfile,
  AllocatorRun,
  AllocatorState,
  RungPlan,
  SymbolFlagsResponse,
  TaxReport,
} from './types';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const TOKEN_KEY = 'ismta_token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // The validating routes answer with `{ errors: [...] }`, not `{ error }` —
    // a refusal whose reason is dropped is worse than no validation at all,
    // because the user is left with a switch that silently will not move.
    const errors: unknown = body.errors;
    const detail = Array.isArray(errors) && errors.length ? errors.join(' ') : body.error;
    // A 401 on anything but the credential-checking routes means the token is
    // dead (expired, or the server restarted with a new secret): drop it and
    // go to the login page, unless that is where we already are.
    if (res.status === 401 && !isCredentialRoute(path) && typeof window !== 'undefined') {
      clearToken();
      // `/me` is the auth provider's own probe; it decides what happens next.
      if (path !== '/api/auth/me' && !window.location.pathname.startsWith('/login')) {
        const next = window.location.pathname + window.location.search;
        window.location.replace(`/login?next=${encodeURIComponent(next)}`);
      }
    }
    throw new ApiError(detail ?? `Request failed (${res.status})`, res.status, body);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // ── auth ──
  login: (email: string, password: string) =>
    request<{ token: string; user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  me: () => request<{ user: User }>('/api/auth/me'),

  // ── portfolio ──
  portfolio: () =>
    request<{ positions: Position[]; summary: PortfolioSummary }>('/api/portfolio'),
  trades: () => request<{ trades: Trade[] }>('/api/portfolio/trades'),

  // ── strategies ──
  strategyTypes: () => request<{ types: StrategyType[] }>('/api/strategies/types'),
  strategies: () => request<{ strategies: Strategy[] }>('/api/strategies'),
  strategy: (id: string) =>
    request<{ strategy: Strategy; signals: Signal[] }>(`/api/strategies/${id}`),
  createStrategy: (body: Partial<Strategy>) =>
    request<{ strategy: Strategy }>('/api/strategies', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  toggleStrategy: (id: string) =>
    request<{ strategy: Strategy }>(`/api/strategies/${id}/toggle`, { method: 'POST' }),
  deleteStrategy: (id: string) =>
    request<{ ok: boolean }>(`/api/strategies/${id}`, { method: 'DELETE' }),

  // ── orders ──
  orders: () => request<{ orders: Order[] }>('/api/orders'),
  placeOrder: (body: {
    symbol: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    orderType?: string;
    price?: number;
  }) => request<{ order: Order }>('/api/orders', { method: 'POST', body: JSON.stringify(body) }),

  // ── risk ──
  risk: () => request<{ risk: RiskSnapshot; alerts: RiskAlert[] }>('/api/risk'),
  marketWeather: () => request<MarketWeather | MarketWeatherPending>('/api/market-weather'),
  globalMarkets: () => request<GlobalMarkets | GlobalMarketsPending>('/api/global-markets'),
  foreignStocks: () => request<ForeignStocks | ForeignStocksPending>('/api/foreign-stocks'),
  refreshForeignStocks: () => request<{ computedAt: number }>('/api/foreign-stocks/refresh', { method: 'POST', body: '{}' }),
  refreshGlobalMarkets: () => request<{ computedAt: number }>('/api/global-markets/refresh', { method: 'POST', body: '{}' }),
  refreshMarketWeather: () =>
    request<{ computedAt: number; headline: string }>('/api/market-weather/refresh', { method: 'POST', body: '{}' }),
  /**
   * Path forecast for positions already held. Deliberately NOT polled: it
   * reads up to ten years of daily bars for any symbol the recommender has not
   * already cached, so it is fetched on demand.
   */
  holdingRisk: () => request<HoldingRiskState>('/api/risk/holdings'),

  accumulator: () =>
    request<{
      books: { book: AccumulatorBook; mark: number; report: AccumulatorReport; lots?: AccumulatorLot[] }[];
      params: AccumulatorParams;
      scalpProfile: ScalpProfile;
      events: AccumulatorEvent[];
    }>('/api/accumulator'),
  accumulatorBook: (symbol: string) =>
    request<{
      book: AccumulatorBook;
      mark: number;
      lots: AccumulatorLot[];
      report: AccumulatorReport;
      params: AccumulatorParams;
      /** Rupees the next unfilled rung would spend. Estimate — see the route. */
      nextTranche: number;
      events: AccumulatorEvent[];
    }>(`/api/accumulator/${encodeURIComponent(symbol)}`),
  instruments: (q: string, limit = 25) =>
    request<{ total: number; results: Instrument[] }>(
      `/api/market/instruments?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  /** Refused by the server while the book holds open lots. */
  deleteAccumulator: (symbol: string) =>
    request<{ removed: string }>(`/api/accumulator/${encodeURIComponent(symbol)}`, {
      method: 'DELETE',
    }),
  toggleAccumulator: (symbol: string) =>
    request<{ book: AccumulatorBook; enabled: boolean }>(
      `/api/accumulator/${encodeURIComponent(symbol)}/toggle`,
      { method: 'POST' },
    ),
  /**
   * Scalping mode on/off — a profile on the same engine, not a second engine.
   * Rejected with 422 when the target cannot clear 1.5x the round-trip cost at
   * this book's tranche size.
   */
  toggleScalp: (symbol: string, enabled?: boolean) =>
    request<{ book: AccumulatorBook; scalp: boolean; profile: string; profileNote: string; note: string }>(
      `/api/accumulator/${encodeURIComponent(symbol)}/scalp`,
      { method: 'POST', body: JSON.stringify(enabled === undefined ? {} : { enabled }) },
    ),
  /**
   * Regime autopilot on/off. While on, the bot owns the scalp flag: sideways
   * switches to scalp, a confirmed trend switches to swing.
   */
  toggleAutopilot: (symbol: string, enabled?: boolean) =>
    request<{
      book: AccumulatorBook;
      autoProfile: boolean;
      regime: string | null;
      regimeNote: string | null;
      profile: string;
      note: string;
    }>(`/api/accumulator/${encodeURIComponent(symbol)}/autopilot`, {
      method: 'POST',
      body: JSON.stringify(enabled === undefined ? {} : { enabled }),
    }),
  createAccumulator: (body: {
    symbol: string;
    instrument: 'ETF' | 'EQUITY';
    budget: number;
    enabled?: boolean;
  }) =>
    request<{ book: AccumulatorBook; report: AccumulatorReport }>('/api/accumulator', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  accumulatorKillSwitch: (symbol: string, engaged: boolean) =>
    request<{ killSwitchEngaged: boolean; note: string }>(
      `/api/accumulator/${encodeURIComponent(symbol)}/kill-switch`,
      { method: 'POST', body: JSON.stringify({ engaged }) },
    ),
  /** What the Sell button would book for each open lot right now. Places nothing. */
  forceSellPreview: (symbol: string) =>
    request<ForceSellPreview>(`/api/accumulator/${encodeURIComponent(symbol)}/force-sell/preview`),
  /** Sell these lots NOW at market, even below cost. 409 with the reason when it cannot go out. */
  forceSell: (symbol: string, lotIds: string[], stopBuying: boolean) =>
    request<ForceSellResult>(`/api/accumulator/${encodeURIComponent(symbol)}/force-sell`, {
      method: 'POST',
      body: JSON.stringify({ confirm: true, lotIds, stopBuying }),
    }),
  /**
   * Run one engine pass now. `events` carries the engine's own account of what
   * it decided — show it, or a no-op looks like a dead button.
   */
  stepAccumulator: (symbol: string) =>
    request<{
      book: AccumulatorBook;
      mark: number;
      report: AccumulatorReport;
      events: AccumulatorEvent[];
    }>(`/api/accumulator/${encodeURIComponent(symbol)}/step`, { method: 'POST' }),

  // ── capital allocator ──
  allocator: () => request<AllocatorState>('/api/accumulator/allocator'),
  /** Re-score every book and re-assign uncommitted cash now. 409 while a pass is already running. */
  /** Fix a stock's total budget by hand, or pass null to hand it back to the allocator. */
  setManualBudget: (symbol: string, amount: number | null, rungs: number | null = null) =>
    request<{ book: AccumulatorBook; run: AllocatorRun | null; pending?: string }>(
      `/api/accumulator/${encodeURIComponent(symbol)}/budget`,
      { method: 'POST', body: JSON.stringify({ amount, rungs }) },
    ),

  /** What an amount and rung count would do, without saving. `rungs` null = what the bot would pick. */
  previewRungs: (symbol: string, amount: number, rungs: number | null) =>
    request<RungPlan>(
      `/api/accumulator/${encodeURIComponent(symbol)}/budget/preview?amount=${amount}${rungs === null ? '' : `&rungs=${rungs}`}`,
    ),

  runAllocator: () =>
    request<{ run: AllocatorRun; events: AllocatorState['events'] }>('/api/accumulator/allocator/run', {
      method: 'POST',
    }),

  // ── add-money lights ──
  /** Green / yellow / red per stock. Cached 10 min on the server; refresh=true recomputes. */
  addSignals: (kind: 'books' | 'recommendations', refresh = false) =>
    request<AddSignalsResponse>(`/api/add-signals/${kind}${refresh ? '?refresh=1' : ''}`),

  // ── recommendations ──
  /** The last ranking run, or null. Never triggers a fetch. */
  recommendations: () => request<RecommendationState>('/api/recommendations'),

  funds: () => request<{ funds: FundsSnapshot }>('/api/funds'),
  refreshFunds: () => request<{ funds: FundsSnapshot }>('/api/funds/refresh', { method: 'POST' }),
  // ── idle-cash sweep ──
  sweep: () => request<SweepReport>('/api/sweep'),

  /** Capital-gains report (FIFO) for paper or live trades. */
  tax: (venue: 'paper' | 'live') => request<TaxReport>(`/api/tax?venue=${venue}`),

  /** NSE surveillance stage and upcoming board meetings for one symbol. */
  symbolFlags: (symbol: string) => request<SymbolFlagsResponse>(`/api/market/flags/${encodeURIComponent(symbol)}`),
  setSweep: (enabled: boolean) =>
    request<SweepReport>('/api/sweep/enable', { method: 'POST', body: JSON.stringify({ enabled }) }),
  runSweep: () => request<{ result: { action: string; reason: string }; sweep: SweepReport }>('/api/sweep/run', { method: 'POST' }),
  releaseSweepHalt: () => request<SweepReport>('/api/sweep/release-halt', { method: 'POST' }),
  /** Rank the universe now. Takes tens of seconds: it pulls two years of bars per symbol. */
  runRecommendations: (body: { capital?: number; riskPerTradePct?: number; maxPositionPct?: number; symbols?: string[] }) =>
    request<{ run: RecommendationRun }>('/api/recommendations/run', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ── market ──
  /**
   * Feed health, and critically whether the exchange is open right now. The
   * engine refuses to place orders outside the session, so without this the
   * interface cannot explain why a perfectly working button changes nothing.
   */
  feed: () => request<FeedStatus>('/api/market/feed'),
  candles: (symbol: string, range = '1d', interval = '1m') =>
    request<{ symbol: string; source: string; range: string; interval: string; candles: Candle[] }>(
      `/api/market/candles/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`,
    ),

  // ── backtest ──
  backtest: (body: {
    strategyType: string;
    symbol: string;
    bars?: number;
    params?: Record<string, number>;
    startingCapital?: number;
    quantity?: number;
  }) => request<{ result: BacktestResult }>('/api/backtest', {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  compareStrategies: (body: { symbol: string; bars?: number; runs?: number; quantity?: number }) =>
    request<StrategyComparison>('/api/backtest/compare', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

export { API_URL };

// ── shell/auth/system ──
/**
 * A failed request, with the status and the parsed body kept: the login form
 * needs `totpRequired` and 429 apart from a plain "wrong password".
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get totpRequired(): boolean {
    return this.body.totpRequired === true;
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Authenticated download: fetch with the bearer header and return the blob. */
export async function download(path: string): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new ApiError(`Download failed (${res.status})`, res.status);
  return res.blob();
}

export const shellApi = {
  /** Public: is sign-up open on this server. */
  authConfig: () => request<{ registrationOpen: boolean }>('/api/auth/config'),

  /** Create an account; answers with a token, already signed in. */
  register: (email: string, password: string, name?: string) =>
    request<{ token: string; user: AuthUser }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(name ? { email, password, name } : { email, password }),
    }),

  /** Login with an optional authenticator code; a 401 carrying `totpRequired` means "ask for the code". */
  login: (email: string, password: string, code?: string) =>
    request<{ token: string; user: AuthUser }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(code ? { email, password, code } : { email, password }),
    }),
  me: () => request<{ user: AuthUser }>('/api/auth/me'),
  totpEnrol: () => request<TotpEnrolment>('/api/auth/totp/enrol', { method: 'POST' }),
  totpConfirm: (code: string) =>
    request<{ user: AuthUser }>('/api/auth/totp/confirm', { method: 'POST', body: JSON.stringify({ code }) }),
  changePassword: (current: string, next: string, code?: string) =>
    request<{ user: AuthUser }>('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify(code ? { current, next, code } : { current, next }),
    }),
  totpDisable: (password: string, code: string) =>
    request<{ user: AuthUser }>('/api/auth/totp/disable', {
      method: 'POST',
      body: JSON.stringify({ password, code }),
    }),

  system: () => request<SystemReport>('/api/system'),
  checkIp: () => request<StaticIpCheck>('/api/system/check-ip', { method: 'POST' }),
  setHalt: (engaged: boolean, reason?: string) =>
    request<{ halted: boolean; halts: { key: string; reason: string }[] }>('/api/system/halt', {
      method: 'POST',
      body: JSON.stringify({ engaged, reason }),
    }),
  testAlert: () =>
    request<{ sent: boolean; notifier: SystemReport['notifier'] }>('/api/system/test-alert', { method: 'POST' }),
  reconcile: () => request<ReconcileResult>('/api/system/reconcile', { method: 'POST' }),
  snapshot: () => request<{ snapshots: EquitySnapshot[] }>('/api/system/snapshot', { method: 'POST' }),

  audit: (q: { kind?: string; symbol?: string; since?: number; limit?: number }) => {
    const p = new URLSearchParams();
    if (q.kind) p.set('kind', q.kind);
    if (q.symbol) p.set('symbol', q.symbol);
    if (q.since) p.set('since', String(q.since));
    if (q.limit) p.set('limit', String(q.limit));
    const qs = p.toString();
    return request<{ entries: AuditEntry[] }>(`/api/audit${qs ? `?${qs}` : ''}`);
  },
  auditCsv: (q: { since?: number; limit?: number }) => {
    const p = new URLSearchParams();
    if (q.since) p.set('since', String(q.since));
    if (q.limit) p.set('limit', String(q.limit));
    const qs = p.toString();
    return download(`/api/audit/export.csv${qs ? `?${qs}` : ''}`);
  },
};

import type {
  AuditEntry,
  AuthUser,
  EquitySnapshot,
  ReconcileResult,
  StaticIpCheck,
  SystemReport,
  TotpEnrolment,
} from './types';

/** Routes whose 401 means "wrong credentials", not "your session is over". */
function isCredentialRoute(path: string): boolean {
  return path.startsWith('/api/auth/') && path !== '/api/auth/me';
}

// ── trading ──
// The trade page (ticket, watchlists, triggers), the backtest page and the
// system status. A sibling of `api` because that object is closed above; the
// same `request` helper, so a 422 `{error}` or `{errors[]}` surfaces verbatim.
import type {
  BacktestInterval,
  BacktestResponse,
  BacktestRun,
  OptimizeResponse,
  OrderPreview,
  PlaceOrderResponse,
  ProductType,
  StrategyComparisonResponse,
  TicketOrderRequest,
  TradingSystemStatus,
  Trigger,
  TriggerCreateRequest,
  Watchlist,
  WatchlistView,
} from './types';

export const tradingApi = {
  system: () => request<TradingSystemStatus>('/api/system'),

  // orders
  orderPreview: (q: { symbol: string; side: 'BUY' | 'SELL'; quantity: number; product: ProductType; price?: number }) =>
    request<OrderPreview>(
      `/api/orders/preview?symbol=${encodeURIComponent(q.symbol)}&side=${q.side}&quantity=${q.quantity}&product=${q.product}` +
        (q.price ? `&price=${q.price}` : ''),
    ),
  /** 201 → {order, adjustment}; a 422 throws with the server's reason verbatim. */
  placeTicketOrder: (body: TicketOrderRequest) =>
    request<PlaceOrderResponse>('/api/orders', { method: 'POST', body: JSON.stringify(body) }),

  // triggers
  triggers: () => request<{ triggers: Trigger[] }>('/api/triggers'),
  createTrigger: (body: TriggerCreateRequest) =>
    request<{ trigger: Trigger }>('/api/triggers', { method: 'POST', body: JSON.stringify(body) }),
  cancelTrigger: (id: string) =>
    request<{ trigger: Trigger }>(`/api/triggers/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),

  // watchlists
  watchlists: () => request<{ watchlists: WatchlistView[] }>('/api/watchlists'),
  createWatchlist: (body: { name: string; symbols?: string[] }) =>
    request<{ watchlist: Watchlist }>('/api/watchlists', { method: 'POST', body: JSON.stringify(body) }),
  patchWatchlist: (id: string, body: { name?: string; symbols?: string[]; notes?: Record<string, string> }) =>
    request<{ watchlist: Watchlist }>(`/api/watchlists/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  addWatchlistSymbol: (id: string, symbol: string) =>
    request<{ watchlist: Watchlist }>(`/api/watchlists/${encodeURIComponent(id)}/symbols`, {
      method: 'POST',
      body: JSON.stringify({ symbol }),
    }),
  removeWatchlistSymbol: (id: string, symbol: string) =>
    request<{ watchlist: Watchlist }>(
      `/api/watchlists/${encodeURIComponent(id)}/symbols/${encodeURIComponent(symbol)}`,
      { method: 'DELETE' },
    ),
  deleteWatchlist: (id: string) =>
    request<{ ok: boolean }>(`/api/watchlists/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // backtest
  runBacktest: (body: {
    strategyType: string;
    symbol: string;
    interval?: BacktestInterval;
    bars?: number;
    params?: Record<string, number>;
    startingCapital?: number;
    quantity?: number;
    exitMode?: 'static' | 'trailing';
  }) => request<BacktestResponse>('/api/backtest', { method: 'POST', body: JSON.stringify(body) }),
  backtestRuns: () => request<{ runs: BacktestRun[] }>('/api/backtest/runs'),
  optimize: (body: {
    strategyType: string;
    symbol: string;
    grid: Record<string, number[]>;
    trainRatio?: number;
    interval?: BacktestInterval;
    bars?: number;
    startingCapital?: number;
    quantity?: number;
    exitMode?: 'static' | 'trailing';
  }) => request<OptimizeResponse>('/api/backtest/optimize', { method: 'POST', body: JSON.stringify(body) }),
  compareAll: (body: { symbol: string; interval?: BacktestInterval; bars?: number; runs?: number; quantity?: number }) =>
    request<StrategyComparisonResponse>('/api/backtest/compare', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

// ── analytics/journal ──
/** Performance analytics and the trade journal. Types are referenced inline so this block only ever appends. */
export const analyticsApi = {
  /** The NAV curve against NIFTY 50, stats, monthly table, drawdowns, costs and trade stats. */
  analyticsNav: (range: import('./types').NavRange = 'all') =>
    request<import('./types').NavReport>(`/api/analytics/nav?range=${range}`),
  /** Fills, rejections, slippage, latency and adjusted orders. */
  analyticsExecution: () => request<import('./types').ExecutionReport>('/api/analytics/execution'),
  /** Every trade and closed lot, with by-tag and override-vs-system summaries. Dates are IST days. */
  journal: (filter: { tag?: string; from?: string; to?: string } = {}) => {
    const qs = new URLSearchParams();
    if (filter.tag) qs.set('tag', filter.tag);
    if (filter.from) qs.set('from', filter.from);
    if (filter.to) qs.set('to', filter.to);
    const q = qs.toString();
    return request<import('./types').JournalReport>(`/api/journal${q ? `?${q}` : ''}`);
  },
  /** Upsert the note on a trade (or `lot:<lotId>`). Omitted fields are kept. */
  patchJournal: (id: string, body: { setup?: string; note?: string; ruleBreak?: boolean }) =>
    request<{ note: import('./types').JournalNote }>(`/api/journal/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
};

// ── future stars ──
/**
 * Companies that could become materially larger, ranked on order wins, growth,
 * policy exposure and price confirmation — with a staged entry plan for each.
 * A run reads quarterly filings and order announcements, so it takes minutes
 * and is never triggered by a page load.
 */
export const futureStarsApi = {
  /** The last run, or null. Cheap. */
  futureStars: () => request<import('./types').FutureStarsState>('/api/future-stars'),
  /** Rank now. Minutes, not seconds. */
  runFutureStars: (body: { symbols?: string[]; capital?: number; categoryCapPct?: number; maxPositionPct?: number } = {}) =>
    request<{ run: import('./types').FutureStarsRun }>('/api/future-stars/run', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Everything behind one symbol, whether or not it qualified. */
  futureStar: (symbol: string) =>
    request<{
      symbol: string;
      star: import('./types').FutureStar | null;
      rejected: { symbol: string; name: string; reason: string } | null;
      skipped: { symbol: string; reason: string } | null;
      evidence: string;
    }>(`/api/future-stars/${encodeURIComponent(symbol)}`),
};

// ── turnarounds ──
/**
 * Stocks well below their highs where the business has not broken. A run reads
 * quarterly filings and shareholding patterns, so it takes minutes.
 */
export const turnaroundApi = {
  turnarounds: () => request<import('./types').TurnaroundState>('/api/turnarounds'),
  runTurnarounds: (body: { symbols?: string[]; capital?: number; categoryCapPct?: number; riskPerIdeaPct?: number } = {}) =>
    request<{ run: import('./types').TurnaroundRun }>('/api/turnarounds/run', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

// ── broker connection ──
/**
 * The user's own Zerodha (Kite Connect) app. The secret is sent once, on save,
 * and never comes back. A 409 carries `errors[]` naming what blocks the change.
 */
type BrokerView = { connection: import('./types').BrokerConnectionView };
export const brokerApi = {
  /** Before going live: close every paper lot and the paper sweep units, on paper only. */
  clearPaper: () =>
    request<{
      books: { symbol: string; lots: number; value: number; pnl: number }[];
      sweep: { units: number; proceeds: number } | null;
      blockers: string[];
    }>('/api/accumulator/clear-paper', { method: 'POST', body: JSON.stringify({ confirm: true }) }),

  zerodha: () => request<BrokerView>('/api/broker/zerodha'),
  saveCredentials: (body: { apiKey: string; apiSecret: string; plan: import('./types').BrokerPlan }) =>
    request<BrokerView>('/api/broker/zerodha/credentials', { method: 'PUT', body: JSON.stringify(body) }),
  setPlan: (plan: import('./types').BrokerPlan) =>
    request<BrokerView>('/api/broker/zerodha/plan', { method: 'PATCH', body: JSON.stringify({ plan }) }),
  /** Kite's login page for this user; open it in the same tab. */
  loginUrl: () => request<{ url: string }>('/api/broker/zerodha/login', { method: 'POST' }),
  /** Read-only: profile, funds, holdings and whether the key has market data. Places no order. */
  test: () =>
    request<BrokerView & { result: import('./types').BrokerTestResult; publicIp: string | null }>(
      '/api/broker/zerodha/test',
      { method: 'POST' },
    ),
  /** Live needs the password (and the authenticator code when two-factor is on). */
  setMode: (body: { mode: import('./types').BrokerTradingMode; password?: string; code?: string }) =>
    request<BrokerView & { pausedBooks: string[] }>('/api/broker/zerodha/mode', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  disconnect: () => request<BrokerView>('/api/broker/zerodha/disconnect', { method: 'POST' }),
  remove: () => request<BrokerView>('/api/broker/zerodha', { method: 'DELETE' }),
};
