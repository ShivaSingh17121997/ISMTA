# ISMTA — Indian Stock Market Trading Automation

An automated, multi-strategy algorithmic trading platform for the Indian market.
This repository contains a **runnable MVP foundation** that implements the full
architecture end-to-end in **paper-trading / simulated-data mode** — it runs with
**zero broker credentials** and is structured so each real integration (Zerodha,
MongoDB, ML, etc.) drops into a clearly-marked extension point.

```
smt/
├── BE/            Backend  — Node + Express + TypeScript trading engine
└── FE/ismta/      Frontend — Next.js 16 + React 19 + Tailwind v4 dashboard
```

---

## Quick start

Two terminals.

### 1. Backend
```bash
cd BE
cp .env.example .env          # optional — sensible defaults already apply
npm install
npm run dev                   # http://localhost:4000  (WS at /ws)
```
On boot it seeds a demo account and two live strategies, then starts a simulated
market feed. You should see `BUY …` / `Closed …` log lines within seconds.

> **Demo login:** `demo@trader.in` / `demo123` (the frontend auto-logs-in with this).

> ⚠️ If port 4000 is busy, set `PORT=4555` in `.env` **and** update
> `FE/ismta/.env.local` (`NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL`) to match.

### 2. Frontend
```bash
cd FE/ismta
npm install
npm run dev                   # http://localhost:3000
```
Open http://localhost:3000 — it redirects to the live dashboard.

---

## What works today (verified)

- ✅ Backend boots, seeds demo data, runs a simulated NSE feed (10 symbols).
- ✅ Three strategies (MA Crossover, Momentum, Mean Reversion) auto-evaluate and
  place paper orders on a cycle.
- ✅ Risk layer enforces daily-loss limit, max positions and per-position value cap
  **before** every order.
- ✅ Order manager fills via the paper broker, tracks positions/trades/P&L, and
  **auto-exits on stop-loss / take-profit** each tick.
- ✅ Backtester walks candles bar-by-bar and reports return, win rate, profit
  factor, Sharpe and max drawdown (+ grid-search optimisation).
- ✅ REST API + WebSocket broadcast of ticks / signals / trades / orders.
- ✅ Dashboard, Strategies (+ detail), Backtest, Live Trading, Risk and Analytics
  pages — all live, with recharts visualisations. `npm run build` passes for both.

---

## Architecture

### Backend (`BE/src`)
| Layer | Files |
|---|---|
| **Brokers (Adapter)** | `brokers/BaseBroker.ts`, `PaperBroker.ts`, `ZerodhaBroker.ts` (skeleton), `index.ts` (factory) |
| **Market data** | `services/MarketDataService.ts` (simulated feed + OHLC history) |
| **Strategies** | `strategies/BaseStrategy.ts`, `MACrossoverStrategy.ts`, `MomentumStrategy.ts`, `MeanReversionStrategy.ts`, `indicators.ts` |
| **Engines** | `services/StrategyEngine.ts`, `OrderManager.ts`, `RiskManager.ts`, `BacktestEngine.ts`, `WebSocketManager.ts` |
| **API** | `routes/{auth,strategies,orders,portfolio,risk,market,backtest}.ts`, `app.ts`, `server.ts` |
| **Store** | `store/memoryStore.ts` (mirrors the planned Mongo collections) |

### Frontend (`FE/ismta/app`)
| Area | Files |
|---|---|
| **Services** | `lib/api.ts`, `lib/useWebSocket.ts`, `lib/usePolling.ts`, `lib/format.ts`, `lib/types.ts` |
| **Providers** | `providers/AuthProvider.tsx`, `providers/LiveProvider.tsx` |
| **Shell** | `components/AppShell.tsx`, `Sidebar.tsx`, `Topbar.tsx`, `ui.tsx` |
| **Widgets** | `PositionsTable`, `TradesTable`, `LiveFeed`, `EquityCurveChart`, `PriceChart` |
| **Pages** | `dashboard`, `strategies`, `strategies/[id]`, `backtest`, `trading/live`, `risk`, `analytics` |

---

## API reference (all under `/api`, JWT via `Authorization: Bearer`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/register`, `/auth/login` | auth |
| GET | `/auth/me` | current user |
| GET/POST | `/strategies` | list / create |
| GET | `/strategies/types` | available types + defaults |
| GET/PATCH/DELETE | `/strategies/:id` | read / update / delete |
| POST | `/strategies/:id/toggle` | enable / disable |
| GET/POST | `/orders` | history / place manual order |
| GET | `/portfolio`, `/portfolio/trades` | positions & summary, trade log |
| GET | `/risk` | risk snapshot + alerts |
| GET | `/market/quotes`, `/market/candles/:symbol` | quotes, OHLC |
| POST | `/backtest`, `/backtest/optimize` | run / grid-search |

WebSocket `ws://localhost:4000/ws` emits `{ type, data }` for
`tick | signal | trade | order | snapshot`.

---

## Zerodha (Kite Connect) — real data, optional live orders

The platform runs in **pure simulation by default** (no credentials). Two env vars
select where data and orders come from:

| `DATA_SOURCE` | `BROKER` | Mode | Money at risk |
|---|---|---|---|
| `sim` | `paper` | Pure simulation (default) | none |
| `zerodha` | `paper` | **Hybrid** — real Kite prices + simulated fills | **none** |
| `zerodha` | `zerodha` | Fully live — real orders on the exchange | **real** |

In **hybrid** mode the strategies, charts, P&L and backtests use **real NSE prices**
streamed from Kite; only the order fills are simulated. Requires a paid Kite Connect
subscription and a daily access token (live data flows only during market hours).

**Daily token flow** (Zerodha tokens expire each day):
```bash
cd BE
# set ZERODHA_API_KEY / ZERODHA_API_SECRET in .env first
npm run kite:login                 # prints the login URL
# log in → copy `request_token` from the redirect URL
npm run kite:login -- <request_token>   # prints today's ACCESS TOKEN
# paste it into .env as ZERODHA_ACCESS_TOKEN, set DATA_SOURCE=zerodha, then npm run dev
```

If Kite init fails (missing/expired token, SDK absent), the server logs a clear error
and **falls back to simulated data** so development never blocks.

**Key files:** `services/KiteService.ts` (ticker + REST + instrument map),
`brokers/ZerodhaBroker.ts` (live orders), `scripts/kiteLogin.ts` (token helper).

## See also

- [`CHECKLIST.md`](CHECKLIST.md) — full plan status: done vs. remaining, mapped to
  the 7 original phases, with the exact extension points for going to production.
