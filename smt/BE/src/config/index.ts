import dotenv from 'dotenv';

dotenv.config();

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  const v = (value ?? '').toLowerCase() as T;
  return allowed.includes(v) ? v : fallback;
}

/** Strategy evaluation cadence (ms) — one "candle" for the live engine. */
const cycleIntervalMs = Math.max(2000, num(process.env.SIM_TICK_INTERVAL_MS, 1000) * 5);

/**
 * The account the risk limits are measured against. Read here rather than
 * inline, because the other risk defaults are now derived from it.
 */
const riskCapital = num(process.env.RISK_CAPITAL, 1_000_000);

/**
 * Risk limits as a FRACTION of capital, used only when the absolute env var is
 * not set.
 *
 * The defaults used to be absolute rupee figures — ₹1,00,000 a position,
 * ₹5,000 a day — and they were chosen for the ₹10,00,000 default capital, where
 * they mean 10% and 0.5%. Nothing tied them to `RISK_CAPITAL`, so setting a
 * smaller account silently kept limits sized for the larger one: at
 * ₹2,00,000 the same numbers permit HALF the account in a single position, a
 * daily loss of 2.5%, and 250% of capital across five positions.
 *
 * These ratios reproduce the old defaults exactly at ₹10,00,000, so an account
 * that never set `RISK_CAPITAL` sees no change at all. Anything set explicitly
 * still wins — this only fixes what happens when it is not.
 */
const RISK_FRACTIONS = {
  /** One position, as a share of capital. */
  maxPositionValue: 0.1,
  /** One day's loss, as a share of capital. */
  dailyLossLimit: 0.005,
} as const;

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: num(process.env.PORT, 4000),
  /**
   * Interface the API listens on. Loopback by default: this server can place
   * real orders, so it is not offered to the local network unless HOST says so
   * (e.g. HOST=0.0.0.0 to reach it from a phone on the same Wi-Fi).
   */
  host: process.env.HOST ?? '127.0.0.1',
  /** Self-service sign-up. Off unless ALLOW_REGISTRATION=true — anyone who can register can trade. */
  allowRegistration: process.env.ALLOW_REGISTRATION === 'true',
  /**
   * Allowed browser origins. Comma-separated, so several frontends can share one
   * API. In development any localhost port is additionally allowed — Next.js
   * hops ports when one is taken (3000 → 3001 → 3002), and pinning a single one
   * guarantees a CORS failure the first time something else grabs it.
   */
  corsOrigins: (process.env.CORS_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  jwt: {
    secret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
    /** True when no JWT_SECRET was supplied. The server refuses to trade live on the default. */
    secretIsDefault: !process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  },

  /**
   * Pre-trade guards. Every order, from every caller, passes these before the
   * risk gate. They exist because the paper broker used to fill a market order
   * on a closed exchange, buy an index in the cash segment, and act on a signal
   * computed 24% away from the live price.
   */
  guards: {
    /** Reject an order when the symbol's last tick is older than this while the market is open. */
    maxQuoteAgeMs: num(process.env.MAX_QUOTE_AGE_MS, 90_000),
    /** Reject an order when the live quote is this far (%) from the price the decision was made at. */
    maxFillDeviationPct: num(process.env.MAX_FILL_DEVIATION_PCT, 2),
    /** SEBI/NSE: above 10 orders/second/exchange the algo must be registered. Kite adds 400/min and 5,000/day. */
    ordersPerSecond: num(process.env.MAX_ORDERS_PER_SECOND, 10),
    ordersPerMinute: num(process.env.MAX_ORDERS_PER_MINUTE, 400),
    ordersPerDay: num(process.env.MAX_ORDERS_PER_DAY, 5000),
    /**
     * The static IP whitelisted at the broker (mandatory since 1 Apr 2026).
     * When set and the broker is live, the public IP is checked at boot and on
     * a timer; a mismatch halts every order until it matches again.
     */
    staticIp: process.env.BROKER_STATIC_IP ?? '',
    /** Minutes between reconciliation passes against the broker's holdings (live brokers only). */
    reconcileEveryMin: num(process.env.RECONCILE_EVERY_MIN, 5),
  },

  /** Telegram push alerts. Both unset = alerts are logged only. */
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    chatId: process.env.TELEGRAM_CHAT_ID ?? '',
  },

  /**
   * Bar length for the live strategy engine. Yahoo prints every 15 s at best,
   * so a 5-second bar of Yahoo data is three identical bars per print; one
   * minute is the smallest bar that exists in the source.
   */
  strategyBarMs: num(
    process.env.STRATEGY_BAR_MS,
    (process.env.DATA_SOURCE ?? 'yahoo').toLowerCase() === 'yahoo' ? 60_000 : cycleIntervalMs,
  ),

  /**
   * 'yahoo' (default) polls real NSE prices; 'zerodha' streams from Kite;
   * 'sim' random-walks a seeded watchlist and is for offline development ONLY —
   * every chart and every fill under it is synthetic.
   */
  dataSource: (process.env.DATA_SOURCE ?? 'yahoo').toLowerCase(),
  broker: (process.env.BROKER ?? 'paper').toLowerCase(),

  /**
   * Groww trading API. Only TOTP auth is usable unattended — Groww's other two
   * modes need a human to click something before 06:00 every day. The TOTP
   * secret is the second factor itself: keep it in .env, never in git.
   */
  groww: {
    apiKey: process.env.GROWW_API_KEY ?? '',
    totpSecret: process.env.GROWW_TOTP_SECRET ?? '',
  },

  zerodha: {
    apiKey: process.env.ZERODHA_API_KEY ?? '',
    apiSecret: process.env.ZERODHA_API_SECRET ?? '',
    accessToken: process.env.ZERODHA_ACCESS_TOKEN ?? '',
    /**
     * Market protection (%) on MARKET orders. Kite rejects 0 since 2026; -1
     * lets the broker pick its band (0.5–2% by price). A market order without
     * it can fill anywhere the book is thin.
     */
    marketProtection: num(process.env.ZERODHA_MARKET_PROTECTION, -1),
  },

  /**
   * Per-user broker credentials entered in Settings. The key encrypts every
   * stored api_secret and access token; it lives only here, never in MongoDB.
   */
  brokerCredentials: {
    key: process.env.BROKER_CREDENTIALS_KEY ?? '',
  },

  /**
   * This API as the browser reaches it. Kite redirects to
   * `<publicApiUrl>/api/broker/zerodha/callback` after login, and that exact URL
   * must be the Redirect URL registered on developers.kite.trade.
   */
  publicApiUrl: (process.env.PUBLIC_API_URL ?? `http://127.0.0.1:${num(process.env.PORT, 4000)}`).replace(/\/+$/, ''),
  /** Where the Kite callback sends the browser afterwards. */
  frontendUrl: (process.env.FRONTEND_URL ?? (process.env.CORS_ORIGIN ?? 'http://localhost:3000').split(',')[0].trim()).replace(/\/+$/, ''),

  sim: {
    tickIntervalMs: num(process.env.SIM_TICK_INTERVAL_MS, 1000),
    volatility: num(process.env.SIM_VOLATILITY, 0.0015),
  },

  /** Yahoo feed cadence. Open-market polls hit one request per tracked symbol. */
  yahoo: {
    pollMs: num(process.env.YAHOO_POLL_MS, 15_000),
    /** Prices do not move on a closed market; a slow heartbeat keeps the close fresh. */
    closedPollMs: num(process.env.YAHOO_CLOSED_POLL_MS, 300_000),
    /** How long boot waits for the first pass before serving anyway. */
    firstPassTimeoutMs: num(process.env.YAHOO_FIRST_PASS_TIMEOUT_MS, 12_000),
  },

  mongoUri: process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/smt_trading',

  risk: {
    dailyLossLimit: num(
      process.env.RISK_DAILY_LOSS_LIMIT,
      riskCapital * RISK_FRACTIONS.dailyLossLimit,
    ),
    maxPositions: num(process.env.RISK_MAX_POSITIONS, 5),
    maxPositionValue: num(
      process.env.RISK_MAX_POSITION_VALUE,
      riskCapital * RISK_FRACTIONS.maxPositionValue,
    ),
    capital: riskCapital,
  },

  cycleIntervalMs,

  /**
   * NSE intraday-equity cost model (spec Phase 4/7/10, adapted for India).
   * Defaults follow Zerodha's published intraday schedule — VERIFY against your
   * own broker. Percentages are of turnover; `brokerageCap` is rupees per order.
   */
  costs: {
    brokeragePct: num(process.env.COST_BROKERAGE_PCT, 0.03),
    brokerageCap: num(process.env.COST_BROKERAGE_CAP, 20),
    /** SELL side only, intraday */
    sttPct: num(process.env.COST_STT_PCT, 0.025),
    /** NSE equity, verified July 2026 (zerodha.com/charges) — was 0.00297% before the revision */
    exchangeTxnPct: num(process.env.COST_EXCHANGE_TXN_PCT, 0.00307),
    gstPct: num(process.env.COST_GST_PCT, 18),
    sebiPct: num(process.env.COST_SEBI_PCT, 0.0001),
    /** BUY side only, intraday */
    stampDutyPct: num(process.env.COST_STAMP_DUTY_PCT, 0.003),
    slippageBps: num(process.env.COST_SLIPPAGE_BPS, 2),
    /**
     * Broker penalty per order when IT squares off your MIS position because you
     * didn't. ₹50 + 18% GST at Zerodha — roughly 3x the ₹20 brokerage, and pure
     * waste: you also surrender the exit price. The session watchdog exists to
     * never pay this.
     */
    autoSquareOffFee: num(process.env.COST_AUTO_SQUARE_OFF_FEE, 50),

    /**
     * DELIVERY (CNC) rates. Intraday and delivery are not the same schedule, and
     * the differences are large enough to change which trades are viable:
     *
     *   STT        0.1% BOTH legs on delivery equity, against 0.025% sell-only
     *              intraday. An equity ETF pays 0.001% on the SELL leg only,
     *              which is why an index ETF is ~10x cheaper to round-trip than
     *              a delivery stock.
     *   Stamp duty 0.015% buy-side, against 0.003% intraday.
     *   DP charge  a FLAT rupee amount per scrip per SELL DAY, levied by the
     *              depository for the demat debit. It does not exist intraday
     *              because nothing leaves the demat account.
     *
     * The DP charge is the one that breaks percentage-only cost models. At
     * ₹13.5 + GST it is 0.32% of a ₹5,000 sale and 1.59% of a ₹1,000 one —
     * larger than a 1% take-profit. Any strategy holding CNC positions must
     * carry it as rupees, not as a rate.
     *
     * VERIFY against your own contract note before trading delivery.
     */
    /**
     * DELIVERY brokerage, which is a different schedule from intraday and
     * differs sharply between brokers:
     *
     *   Zerodha  ₹0 on equity delivery
     *   Groww    ₹20 or 0.1% per order, whichever is LOWER
     *
     * This is not a rounding detail for this system. The accumulator's no-loss
     * rule is a FEE-INCLUSIVE breakeven, so understating brokerage lowers every
     * breakeven and the engine will sell at what it computes as a profit and is
     * not. Defaults follow the ACTIVE broker so that switching BROKER= also
     * switches the cost model; an explicit env var still overrides.
     */
    brokerageDeliveryPct: num(
      process.env.COST_BROKERAGE_DELIVERY_PCT,
      (process.env.BROKER ?? 'paper').toLowerCase() === 'groww' ? 0.1 : 0,
    ),
    brokerageDeliveryCap: num(process.env.COST_BROKERAGE_DELIVERY_CAP, 20),
    sttDeliveryPct: num(process.env.COST_STT_DELIVERY_PCT, 0.1),
    sttEtfSellPct: num(process.env.COST_STT_ETF_SELL_PCT, 0.001),
    stampDutyDeliveryPct: num(process.env.COST_STAMP_DUTY_DELIVERY_PCT, 0.015),
    dpChargePerSell: num(process.env.COST_DP_CHARGE_PER_SELL, 13.5),
  },

  /**
   * NSE session policy (IST). The NTB spec has no session concept at all — it
   * was written for 24/7 crypto. See services/session.ts.
   */
  session: {
    /** enforce trading hours / holidays / flatten. Turn off only for 24/7 markets. */
    enabled: bool(process.env.SESSION_ENABLED, true),
    /** no entries before this — the opening minutes are the widest spreads of the day */
    entryOpensAt: process.env.SESSION_ENTRY_OPENS_AT ?? '09:20',
    /** no NEW positions after this — nothing worth opening 10 minutes before a forced exit */
    entryClosesAt: process.env.SESSION_ENTRY_CLOSES_AT ?? '15:00',
    /**
     * Force-flatten MIS from here. Default 15:10 sits ahead of BOTH the CAS
     * entry block (15:15) and the broker square-off (15:25), so we always exit
     * on our own terms at a price we chose.
     */
    flattenAt: process.env.SESSION_FLATTEN_AT ?? '15:10',
    /** when the BROKER does it for you, at ₹50+GST and a price you don't pick */
    squareOffAt: process.env.SESSION_SQUARE_OFF_AT ?? '15:25',
  },

  /** NTB strategy port — spec Phase 11. */
  ntb: {
    // ── Phase 8: the exit engine ──
    /** profit % before the trailing stop arms */
    activationPct: num(process.env.ACTIVATION_PCT, 0.8),
    /** retrace % from peak/trough that exits, once armed */
    trailPct: num(process.env.TRAIL_PCT, 1.5),
    /** hard stop %; keep above the round-trip cost band */
    stopLossPct: num(process.env.STOP_LOSS_PCT, 1.0),
    /**
     * Hard take-profit cap. KEEP AT 0. A small TP caps winners below where the
     * trailing exit would have released them, which inverts reward:risk — you
     * keep the full-size losers and truncate the winners meant to pay for them.
     * The trailing stop IS the take-profit; that is the entire thesis.
     */
    takeProfitPct: num(process.env.TAKE_PROFIT_PCT, 0),

    // ── Phase 4: stop distance ──
    stopMode: oneOf(process.env.STOP_MODE, ['fixed', 'atr'] as const, 'fixed'),
    atrPeriod: num(process.env.ATR_PERIOD, 14),
    atrStopMult: num(process.env.ATR_STOP_MULT, 1.5),

    // ── Phase 3: direction filter (entries only; never gates an exit) ──
    direction: oneOf(process.env.DIRECTION, ['long', 'short', 'both'] as const, 'both'),

    // ── Phase 5: sizing ──
    /** fixed notional per trade (₹) when risk-based sizing is off */
    quoteOrderSize: num(process.env.QUOTE_ORDER_SIZE, 50_000),
    /** > 0 enables risk-based sizing coupled to the per-position stop */
    riskPerTradePct: num(process.env.RISK_PER_TRADE_PCT, 0),
    /** hard notional cap (₹); 0 = off. Defaults to the existing risk cap. */
    maxPositionQuote: num(process.env.MAX_POSITION_QUOTE, 100_000),

    // ── Phase 6: risk gate ──
    /** halt entries after losing this % of capital in a UTC day; 0 = off */
    maxDailyLossPct: num(process.env.MAX_DAILY_LOSS_PCT, 5),
    /** halt entries after N losers in a row; 0 = off */
    maxConsecutiveLosses: num(process.env.MAX_CONSECUTIVE_LOSSES, 3),
    /** block entries for N candles after a loss; 0 = off */
    lossCooldownCandles: num(process.env.LOSS_COOLDOWN_CANDLES, 0),
    /** derived: candles → ms, against the live engine cadence */
    get lossCooldownMs(): number {
      return num(process.env.LOSS_COOLDOWN_CANDLES, 0) * cycleIntervalMs;
    },

    /**
     * Does a REAL resting stop order exist on the exchange?
     *
     * cappedStopFill assumes, in live mode, that a stop filled at its level. That
     * is only honest with a real exchange stop. If stops are managed in a poll
     * loop, you fill at whatever the next poll shows — exactly the bug the model
     * is meant to remove. NSE gaps every morning, so this matters far more here
     * than in the 24/7 crypto market NTB was built for.
     */
    useExchangeStop: bool(process.env.USE_EXCHANGE_STOP, false),

    // ── Phase 9: DCA / averaging-down (HIGH RISK — off by default) ──
    dca: {
      enabled: bool(process.env.DCA_ENABLED, false),
      maxSafetyOrders: num(process.env.DCA_MAX_SAFETY_ORDERS, 2),
      deviationPct: num(process.env.DCA_DEVIATION_PCT, 1.0),
      stepScale: num(process.env.DCA_STEP_SCALE, 2),
      volumeScale: num(process.env.DCA_VOLUME_SCALE, 1.5),
      finalStopPct: num(process.env.DCA_FINAL_STOP_PCT, 5),
    },
  },
} as const;

export type AppConfig = typeof config;
