# ISMTA — Codebase Analysis & Professional Trading-Bot Gap Report

> Scope: audit the current implementation against `CHECKLIST.md`, list what is
> genuinely implemented, identify the features a professional trading bot needs
> to **maximise edge (and win rate)**, and give concrete designs for the two
> features you asked for specifically: **multiple simultaneous trades** and a
> **proper averaging strategy**.
>
> Verdict up front: this is a **well-architected MVP skeleton**, not a
> profit-ready bot. The plumbing (strategy → risk → order → fill → P&L →
> backtest → UI) is clean and correct. What's missing is everything that
> separates a *demo* from a *live edge*: realistic cost modelling, dynamic
> position sizing, portfolio-level risk, execution quality, and a real ML model.

---

## 1. What is actually implemented (verified in code)

| Area | Status | Evidence |
|---|---|---|
| Express + TS API, JWT auth, CORS, `/health` | ✅ Real | `BE/src/app.ts`, `routes/auth.ts` |
| Broker adapter (Paper / Zerodha) + factory | ✅ Real | `BE/src/brokers/` |
| Simulated market feed + OHLC history | ✅ Real | `BE/src/services/MarketDataService.ts` |
| Zerodha Kite (ticks, REST, hybrid mode) | ✅ Real | `BE/src/services/KiteService.ts` |
| 7 strategies + indicator library | ✅ Real | `BE/src/strategies/` |
| Live strategy engine (rolling candles, per-cycle eval) | ✅ Real | [StrategyEngine.ts](BE/src/services/StrategyEngine.ts) |
| Order lifecycle + auto SL/TP exit on tick | ✅ Real | [OrderManager.ts](BE/src/services/OrderManager.ts) |
| Risk checks (daily loss, max positions, value cap) | ✅ Real | [RiskManager.ts](BE/src/services/RiskManager.ts) |
| Backtester (no look-ahead) + grid optimise | ✅ Real | [BacktestEngine.ts](BE/src/services/BacktestEngine.ts) |
| MongoDB write-through persistence | ✅ Real | [memoryStore.ts](BE/src/store/memoryStore.ts) |
| Next.js dashboard (7 pages, recharts, WS) | ✅ Real | `FE/ismta/app/` |

**The `CHECKLIST.md` is broadly honest.** Two corrections worth noting:

- The checklist calls MongoDB "🟡 partial", but `memoryStore.ts` already
  implements a full write-through cache with Mongoose models and `hydrate()`.
  This is closer to **✅ done** than 🟡.
- "ML Ensemble" is correctly flagged as a **heuristic, not a trained model** —
  it's a hand-weighted logistic score over 6 indicators
  ([MLEnsembleStrategy.ts](BE/src/strategies/MLEnsembleStrategy.ts)). Do not
  treat it as ML.

---

## 2. The honest truth about "maximise win rate"

Before the feature list, one thing must be said because it changes the whole
design: **win rate is the wrong optimisation target on its own.**

A strategy that takes +₹500 profits and −₹5,000 losses can win 90% of trades and
still bankrupt the account. The bot already computes the right north-star metric —
**expectancy** (avg P&L per trade) — in [BacktestEngine.ts:175](BE/src/services/BacktestEngine.ts#L175).

The correct objective is: **maximise expectancy = (WinRate × AvgWin) − (LossRate × AvgLoss)**,
subject to a drawdown ceiling. Everything below improves *that*. Where a feature
specifically lifts raw win rate, it's marked 🎯.

**Danger:** the "averaging" strategy you asked for (§5) is the classic way to
*inflate* win rate while *destroying* expectancy if done as a martingale. It's
covered carefully.

---

## 3. Gap analysis — what a professional bot needs

### 3.1 Execution realism (biggest hole — inflates results today)

| Missing | Why it matters | Where to add |
|---|---|---|
| **Slippage model** | Paper broker fills at exact LTP. Real market fills are worse. Backtest win rates are **overstated**. | `PaperBroker.placeOrder`, `BacktestEngine.close` |
| **Brokerage + STT + GST + stamp duty + exchange fees** | Indian intraday round-trip costs ~₹40–60 + 0.025% STT. On small TP targets this flips winners to losers. | Add a `costs.ts`; subtract in `applyFill` and backtest `close()` |
| **Partial fills / liquidity** | Orders assumed 100% filled instantly. | `BaseBroker` fill simulation |
| **Order postback reconciliation** | Live Zerodha orders optimistically marked filled at LTP (checklist 🟡). True avg fill price unknown. | Wire Kite order-update WebSocket |

> Adding a cost + slippage model is the **single highest-value change** — right
> now every backtest number is optimistic.

### 3.2 Position sizing & risk (currently naive)

| Missing | Current state | Fix |
|---|---|---|
| **Dynamic sizing** | Strategy uses a **fixed `cfg.quantity`**; the fractional-Kelly helper in [RiskManager.kellyQuantity](BE/src/services/RiskManager.ts#L63) exists but is **never called**. | Size each entry from Kelly / volatility / % risk-per-trade |
| **Volatility-based stops** 🎯 | SL/TP are **fixed percentages** ([BaseStrategy.makeSignal](BE/src/strategies/BaseStrategy.ts#L28)). ATR indicator exists but is unused for stops. | ATR-multiple stops adapt to each symbol's noise → fewer premature stop-outs → higher win rate |
| **Trailing stops** 🎯 | None. Winners give back profit at fixed TP. | Trail SL as price moves favourably |
| **Portfolio correlation / sector caps** | `maxPositions=5` counts positions but ignores that 5 correlated banks = 1 bet. | Cap exposure per sector / correlation cluster |
| **Risk-per-trade %** | Value cap is absolute (₹100k), not "risk 1% of capital per trade". | Size so (entry−stop)×qty = 1% of capital |
| **Max daily trades / cool-down** | None — a broken strategy can over-trade. | Add trade-count + loss-streak circuit breaker |

### 3.3 Signal quality (raises win rate directly) 🎯

- **Regime / trend filter**: only take mean-reversion in ranges, momentum in
  trends. A single higher-timeframe filter (e.g. price vs 200-EMA) typically
  lifts win rate meaningfully.
- **Multi-timeframe confirmation**: confirm the 5-min signal against the 15-min
  trend before entering.
- **Time-of-day filter**: skip the first/last minutes and lunch chop on NSE;
  block entries near 15:15 for MIS square-off.
- **Volume / liquidity filter**: ignore signals on thin volume.
- **Signal confluence / ensemble voting**: require ≥2 strategies to agree before
  firing (the engine already produces per-strategy signals — add a voter).
- **News / event blackout**: no earnings/RBI-day guard today.

### 3.4 Real ML (checklist's own extension point)

Replace the fixed weights in `MLEnsembleStrategy` with a model trained offline on
`features → forward return`, retrained monthly, loaded from disk. Add
**walk-forward validation** (checklist ⬜) so you don't overfit — the current
`optimize()` sorts purely by in-sample return ([BacktestEngine.ts:111](BE/src/services/BacktestEngine.ts#L111)), the textbook overfitting trap.

### 3.5 Ops, monitoring, compliance

- Alerts (Telegram/email/SMS) — checklist ⬜. A live bot must page you on
  errors, disconnects, and daily-loss breach.
- Auto-reconnect + heartbeat on the Kite WebSocket; a dropped feed = blind bot.
- SEBI `audit_logs` collection (checklist item) before any real-money run.
- Automated tests — `npm test` is a stub; a money-handling engine needs unit
  tests on P&L, fills, and risk math.
- Kill switch / global "flatten all & halt" endpoint.

---

## 4. Feature: multiple trades at the same time

### 4.1 What works and what doesn't today

**Already concurrent:** the engine loops every enabled strategy over every symbol
each cycle ([StrategyEngine.runCycle](BE/src/services/StrategyEngine.ts#L47)), so
you *can* hold positions in many symbols and run many strategies at once, bounded
by `maxPositions` (default 5).

**The real limitation — one net position per symbol.** Positions are keyed
`${userId}:${symbol}` ([memoryStore.ts:143](BE/src/store/memoryStore.ts#L143)).
So if Strategy A and Strategy B both trade RELIANCE, they **collapse into one net
position** and stomp on each other's SL/TP. And the engine explicitly blocks a
strategy from re-entering a symbol it already holds
([StrategyEngine.ts:62-69](BE/src/services/StrategyEngine.ts#L62)) — so no two
concurrent trades on the same symbol, even intentionally.

There's also a latent bug: `closeMatchingTrades` closes **every** open trade on
that symbol/side and assigns each the full realised P&L
([OrderManager.ts:140](BE/src/services/OrderManager.ts#L140)) — fine with one
trade per symbol, wrong the moment you allow several.

### 4.2 How to implement true multi-trade concurrency

1. **Re-key positions by `(userId, symbol, strategyId)`** instead of
   `(userId, symbol)`. Each strategy then owns an independent position, SL/TP,
   and P&L on the same symbol.
   - Update `positionKey`, `positionsByUser`, and every `store.positions` access
     in `OrderManager.applyFill` / `onTick`.
2. **Fix `closeMatchingTrades`** to match a single trade by `entryOrderId` /
   FIFO and split realised P&L per matched quantity — not blanket-close.
3. **Track a broker-level net position separately** for real Zerodha orders
   (the exchange nets by symbol regardless of your internal split), while
   keeping per-strategy attribution internally.
4. **Concurrency guard on the run loop**: `runCycle` is `async` and fired on a
   timer; ensure two cycles can't overlap (a running flag) so risk checks and
   fills don't race.
5. **Portfolio risk across concurrent trades**: add total-exposure and
   correlation caps (§3.2) so "5 concurrent trades" can't become 5× the same bet.

> This is a moderate change (~1 file for keying + 1 for the close bug) and it's
> the prerequisite for the averaging strategy below.

---

## 5. Feature: the "averaging" strategy (done properly)

"Averaging" means adding to a position at a better price so your **average entry**
improves. The engine plumbing already computes a **weighted-average price on
adds** ([OrderManager.applyFill:107-111](BE/src/services/OrderManager.ts#L109)) —
but nothing ever uses it, because the strategy engine blocks re-entry
([StrategyEngine.ts:69](BE/src/services/StrategyEngine.ts#L69)).

There are three flavours — pick deliberately, they are **not** equal:

| Type | Behaviour | Effect on win rate | Verdict |
|---|---|---|---|
| **DCA / scale-in (planned)** | Split intended size into N legs at pre-set distances; total risk fixed in advance | Slightly ↑ | ✅ Professional |
| **Pyramiding (add to winners)** | Add only as the trade moves *in* your favour, trailing the stop up | ↑ expectancy | ✅ Professional |
| **Martingale (double-down on losers)** | Add bigger size as it moves *against* you | ↑↑ win rate, catastrophic tail | ❌ **Blows up accounts** |

Averaging-down *feels* like it "maximises win rate" (more trades close green) but
it does so by taking rare, giant losses — the opposite of an edge. **Recommend
DCA scale-in with a hard total-risk cap, and/or pyramiding into winners.**

### 5.1 Proper design (safe averaging)

Add an averaging layer that is **budget-bounded before the first entry**:

1. **New strategy params** on any strategy (or a wrapper):
   ```
   averaging: {
     enabled: true,
     maxLegs: 3,              // total entries incl. the first
     legTriggerPct: 1.0,      // add each time price moves 1% against (DCA) or for (pyramid)
     mode: 'DCA' | 'PYRAMID',
     legSizeMode: 'EQUAL' | 'DECREASING', // never 'MARTINGALE'
     totalRiskPct: 1.5        // cap: sum of all legs risks ≤ 1.5% of capital
   }
   ```
2. **Pre-compute the full ladder at first entry.** Size each leg so that if the
   *final* stop is hit with the *full* averaged position, the loss ≤
   `totalRiskPct` of capital. This is what makes it safe vs martingale — you can
   never add "just one more".
3. **Track legs on the Trade/Position**: add `legs: {price, qty}[]` and
   `plannedLegs`. Re-enable adds by relaxing the re-entry block in
   `StrategyEngine` *only* when `averaging.enabled` and legs remain and the
   trigger distance is met.
4. **Recompute SL/TP off the new average** after each add (the avg-price math is
   already in `applyFill`; just recompute `t.stopLoss` / `t.takeProfit` from the
   blended average and remaining risk budget).
5. **Exit rule**: one shared stop for the whole averaged position, sized so the
   worst case stays within budget. TP measured from the average entry.
6. **Backtest it**: `BacktestEngine` currently supports **one open position at a
   time** ([BacktestEngine.ts:39](BE/src/services/BacktestEngine.ts#L39), `open:
   OpenPos | null`). Extend `OpenPos` to hold multiple legs and a blended average
   so averaging can be validated historically *before* going live.

### 5.2 Where the code changes land

- `types/index.ts` — add `legs` to `Trade`, `averaging` params to `StrategyConfig`.
- `StrategyEngine.ts` — replace the binary `holding` block with "can this
  strategy add another leg?" logic.
- `OrderManager.applyFill` — already averages; add leg recording + SL/TP recompute.
- `BacktestEngine.run` — support a multi-leg open position.
- `RiskManager` — enforce the pre-committed total-risk ladder cap.

---

## 6. Prioritised roadmap

**Do first (correctness — today's numbers are optimistic):**
1. Cost + slippage model in broker *and* backtester (§3.1).
2. Walk-forward validation; stop optimising on in-sample return (§3.4).
3. Fix `closeMatchingTrades` P&L bug (§4.1).

**Then (edge / win rate) 🎯:**
4. ATR-based + trailing stops (§3.2).
5. Regime + multi-timeframe + time-of-day filters (§3.3).
6. Dynamic position sizing (wire up Kelly / % risk) (§3.2).

**Then (the two requested features):**
7. Multi-trade concurrency — re-key positions by strategy (§4).
8. Safe DCA/pyramid averaging with a pre-committed risk ladder (§5).

**Before real money:**
9. Portfolio correlation/sector caps, circuit breakers, kill switch (§3.2).
10. Alerts, WS auto-reconnect, audit log, unit tests (§3.5).

---

## 7. One-paragraph summary

The codebase is a clean, honestly-documented MVP: the full trade pipeline works
end-to-end in simulation and hybrid Zerodha mode, with 7 strategies, risk checks,
a no-look-ahead backtester, and a live dashboard. To become a *professional*
bot it needs, in order: **realistic costs/slippage** (without which win rates are
fiction), **dynamic sizing and ATR/trailing stops**, **signal-quality filters**
(regime, multi-timeframe, time-of-day) that genuinely raise win rate, and a
**real trained ML model with walk-forward validation**. The two features you
asked for are both feasible: **multiple simultaneous trades** needs positions
re-keyed by `(user, symbol, strategy)` plus a P&L-attribution fix, and a proper
**averaging strategy** should be a **budget-capped DCA/pyramid ladder — never a
martingale** — built on the weighted-average logic the order manager already has.
