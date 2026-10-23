# Implementation Checklist

Status of the original 7-phase plan. **MVP foundation = done & verified.** The
remaining items are deliberately deferred (real money, external accounts, ML, infra)
and each has a marked extension point in the code.

Legend: ✅ done & verified · 🟡 partial / scaffolded · ⬜ not started (future)

---

## Phase 1 — Backend Core & Infrastructure
- ✅ Express server with TypeScript, JSON middleware, CORS, `/health`
- ✅ JWT auth (register / login / me), bcrypt password hashing
- ✅ Data store: in-memory store mirroring planned collections (users, strategies,
  orders, trades, positions, daily P&L)
- ✅ Broker abstraction layer (Adapter pattern) + factory selecting broker via env
- ✅ Real-time market data service (simulated feed + OHLC history generator)
- 🟡 MongoDB collections — store interface is Mongo-shaped; **swap `store/memoryStore.ts`
  for Mongoose models** (`MONGO_URI` already plumbed through config)
- ⬜ Redis cache + Bull job queues (config placeholder only)

## Phase 2 — Trading Strategy Engine
- ✅ MA Crossover (9/21 EMA)
- ✅ Momentum (ROC + MACD confirmation)
- ✅ Mean Reversion (Bollinger Bands + RSI)
- ✅ Breakout (Donchian channel)
- ✅ VWAP crossover
- ✅ Supertrend (ATR trend follower)
- ✅ ML Ensemble (weighted feature/logistic scorer) — **heuristic placeholder**,
  not a trained model; see note below
- ✅ Indicator library: SMA, EMA, ROC, MACD, Bollinger, RSI, ATR, Donchian, VWAP, Supertrend
- ✅ Automated SL/TP, confidence scoring, signal-history tracking
- 🟡 ML Random Forest — `ML_ENSEMBLE` provides the strategy slot + feature
  engineering with the right `evaluate()` contract; swap the fixed weights for a
  trained Random Forest / gradient-boosting model loaded from disk, retrained monthly

**7 strategies live**, all registered in `strategies/index.ts` and selectable in the
UI (create form + backtest). Type keys: `MA_CROSSOVER`, `MOMENTUM`, `MEAN_REVERSION`,
`BREAKOUT`, `VWAP`, `SUPERTREND`, `ML_ENSEMBLE`.

## Phase 3 — Risk Management & Order Management
- ✅ Risk enforcer: daily-loss limit, max concurrent positions, per-position value cap
- ✅ Position sizing helper (fractional Kelly)
- ✅ Order lifecycle: request → risk check → broker → fill → position/trade/P&L update
- ✅ Automated SL/TP exits on every tick
- 🟡 Margin safety — basic margin-used/available; refine with broker margin API

## Phase 4 — Backtesting Engine
- ✅ Candle-based backtester, no look-ahead (strategy sees only past bars)
- ✅ Metrics: total return, win rate, profit factor, Sharpe, max drawdown, equity curve
- ✅ Grid-search parameter optimisation (`/api/backtest/optimize`)
- 🟡 Historical data — currently synthetic OHLC; **point `MarketDataService` at a real
  source** (Zerodha historical API / CSV import)
- ⬜ Walk-forward train/test split harness (engine supports it; add the orchestration)

## Phase 5 — Frontend Dashboard & Pages
- ✅ `/dashboard` — live P&L, positions, NIFTY chart, live activity feed
- ✅ `/strategies` — list, create, enable/disable, delete
- ✅ `/strategies/[id]` — params, signal history, execution stats
- ✅ `/backtest` — run with params, equity curve, metrics, trade log
- ✅ `/trading/live` — watchlist, live chart, manual order ticket, order history
- ✅ `/risk` — margin, daily-loss meter, position utilisation, alerts
- ✅ `/analytics` — net P&L, win rate, P&L-by-symbol chart, closed trades, and a
  **Strategy Comparison** tool (ranks all 7 strategies by expectancy / Sharpe /
  profit factor / win rate / return; `/api/backtest/compare`)
- ✅ Recharts equity/price/bar charts; real-time via WebSocket provider
- ⬜ `/settings` page (notifications/preferences) — sidebar slot free to add

## Phase 6 — Notifications & Monitoring
- ✅ Winston structured logging across services
- ✅ Real-time event broadcast (WebSocket) consumed by the live feed
- ⬜ Email (SendGrid) / SMS (Twilio) / Telegram channels
- ⬜ System-health dashboard

## Phase 7 — Deployment & Testing
- ✅ Both apps produce clean production builds (`tsc` / `next build`)
- ⬜ Dockerfiles + docker-compose (Mongo + Redis + BE + FE)
- ⬜ Unit/integration tests (Jest) — `npm test` is a stub
- ⬜ AWS/Heroku (BE) + Vercel (FE) deploy

---

## Zerodha (Kite Connect) integration — DONE
- ✅ `KiteService` — REST client + KiteTicker WebSocket, instrument-token mapping,
  real ticks piped into the existing pipeline via `marketData.ingestTick()`
- ✅ **Hybrid mode** (`DATA_SOURCE=zerodha` + `BROKER=paper`): real prices, paper fills
- ✅ Real historical candles feed backtests + charts in zerodha mode
- ✅ Full-live order placement (`ZerodhaBroker`, `BROKER=zerodha`) via `kc.placeOrder`
- ✅ Daily access-token helper (`npm run kite:login`)
- ✅ Graceful fallback to simulation when creds/SDK are missing
- 🟡 Fill reconciliation — live orders are optimistically marked filled at LTP;
  wire Kite **order postbacks / order-update WebSocket** for true average fill price

## Going live — remaining extension points
1. **Persistence:** implement Mongoose models behind the `store` access methods.
2. **Fill reconciliation:** consume Kite order postbacks for true average fill prices.
3. **Trained ML model:** replace the fixed weights in `ML_ENSEMBLE` with a Random
   Forest / gradient-boosting model trained offline, retrained monthly.
4. **SEBI audit:** add an `audit_logs` collection + write hook in `OrderManager`.

## Safety note
By **default** this runs in pure simulation (`DATA_SOURCE=sim`, `BROKER=paper`) — no
real orders, no funds at risk. **Hybrid** mode adds real prices but still simulates
fills (safe). Setting `BROKER=zerodha` places **real orders with real money** — only do
this after completing Phase 7 testing, broker certification, and SEBI/exchange
algo-approval requirements.
