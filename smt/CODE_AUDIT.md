# ISMTA — Logic & Correctness Audit

> Companion to `ANALYSIS_REPORT.md`. That document covers *strategic* gaps (cost
> modelling, sizing, averaging). This one covers **defects in the code as written**.
>
> Correction to `ANALYSIS_REPORT.md` §1: it states "the plumbing (strategy → risk →
> order → fill → P&L → backtest → UI) is clean and correct." **It is not.** The risk
> layer blocks stop-loss exits, the daily-loss limit never resets, and manual orders
> accept negative quantities. Those are money-losing bugs in the plumbing itself.

Severity: **C** = can lose real money / crash prod · **H** = wrong results ·
**M** = degradation · **L** = hygiene.

---

## The Deadlock (read this first)

Three independently-confirmed bugs compose into a permanent, unrecoverable freeze:

1. **`RiskManager.check()` cannot tell an entry from an exit** — `RiskManager.ts:32`
   takes only `(req, ltp)`. `OrderManager.onTick:180` routes stop-loss and
   take-profit exits through `place()` → the same `check()`.
2. **The daily-loss gate rejects every order once tripped** — `RiskManager.ts:37`.
3. **`resetDailyPnl()` has zero callers** — `memoryStore.ts:163`; verified by grep
   across `BE/src`. `dailyPnl` is keyed by `userId` with **no date component**, and
   `hydrate()` reloads it verbatim on boot.

**Sequence:** user hits the daily loss limit with an open long → price collapses →
SL fires → `check()` sees `dailyPnl <= -limit` → **the exit is rejected**. `onTick`
retries every tick forever, spamming `order:rejected` over the WebSocket, while the
position rides to zero. The loss limit designed to cap the loss at ₹5,000 is the
exact mechanism that lets it run unbounded. Because of (3) it never clears — not at
midnight, not on restart. The max-positions gate (`RiskManager.ts:43`) does the same
thing: at 5/5, every close is rejected and the account is frozen with 5 open
positions and no automated way out.

**Fix:** classify intent before gating.
```ts
// OrderManager.place()
const pos = store.positions.get(store.positionKey(userId, req.symbol));
const signed = req.side === 'BUY' ? req.quantity : -req.quantity;
const isReducing = !!pos && pos.quantity !== 0 && Math.sign(signed) !== Math.sign(pos.quantity);
const risk = riskManager.check(req, ltp, isReducing);
```
Skip gates 1, 2 **and 3** when reducing — the value cap at `RiskManager.ts:53`
silently *trims* an exit, leaving a residual position after a stop-loss if price has
run past the cap.

**And key the P&L bucket by IST trading day** so it self-expires with no scheduler
(a `Date.now()`-based `resetDailyPnl` on a UTC container would reset at 05:30 IST,
mid-session):
```ts
private istDay(ts = Date.now()) { return new Date(ts + 5.5 * 3600_000).toISOString().slice(0, 10); }
private pnlKey(userId: string) { return `${userId}:${this.istDay()}`; }
```

---

## C — Critical

### C1 · Risk gates block exits; daily limit never resets
See **The Deadlock** above. `RiskManager.ts:37,43,53` · `memoryStore.ts:163`.

### C2 · `POST /orders` accepts negative quantity → unlimited short position
`routes/orders.ts:13` — `if (!symbol || !side || !quantity)` rejects `0`/`NaN` but
**passes `-5`**. No integer check, no upper bound.

`{"symbol":"RELIANCE","side":"BUY","quantity":-5}` → `RiskManager.ts:52`:
`requestedValue = -5 * 2950 = -14750`, which is **not** `> maxPositionValue`, so the
value cap is bypassed entirely and `allowedQuantity: -5` is approved →
`OrderManager.ts:92`: `signedQty = +(-5) = -5` → **a BUY opens a short**. Pair
`quantity: -1e9` with the cap bypass for unlimited size.

```ts
const qty = Number(quantity);
if (!Number.isInteger(qty) || qty <= 0)
  return res.status(400).json({ error: 'quantity must be a positive integer' });
if (orderReq.orderType === 'LIMIT' && !(Number(price) > 0))
  return res.status(400).json({ error: 'LIMIT requires price > 0' });
```
Defence-in-depth: reject non-positive-integer quantity at the top of `check()` too.

### C3 · JWT secret falls back to a hardcoded default → full auth bypass
`config/index.ts:16` — `secret: process.env.JWT_SECRET ?? 'dev-secret-change-me'`,
with no production guard. The app boots happily with no `.env`. The secret is in a
public repo → anyone signs `{sub: <any userId>, role: 'admin'}` and, with
`BROKER=zerodha`, **places real orders on someone else's account**.

Fail fast: `if (config.env === 'production' && !process.env.JWT_SECRET) throw ...`

### C4 · No rate limiting + admin demo account seeded in production
`routes/auth.ts:28`, `app.ts:13-33` — no `express-rate-limit` dependency, no limiter
anywhere. `bootstrap/seed.ts:16-23` creates `demo@trader.in` / `demo123` with
`role: 'admin'`, called unconditionally at `server.ts:42` with no env check.
`demo123` falls to a wordlist in seconds. Gate `seedDemoData()` behind
`config.env !== 'production'` and throttle `/api/auth` (5/15min per IP+email).

### C5 · Express 4 does not catch async throws → process death
`package.json:29` pins `express@^4.19.2`; auto-catching of rejected handler promises
only landed in Express **5**. So `errorHandler` (`middleware/errorHandler.ts:9`) is
**unreachable for every async route**: `backtest.ts:13,69` · `orders.ts:11` ·
`auth.ts:10,28` · `market.ts:24`.

Concrete path: `KiteService.getHistorical:120` awaits `kc.getHistoricalData()` with
**no try/catch**. Token expires overnight (`.env.example:29` admits it's daily) →
user hits `POST /api/backtest` → rejection → **Node ≥15 terminates the process** with
open positions and no SL/TP monitor. No `unhandledRejection` handler exists in
`server.ts` (it registers SIGINT/SIGTERM only), so there isn't even a log line.

Fix: `import 'express-async-errors'` in `app.ts` (one line), add
`process.on('unhandledRejection', ...)`, and try/catch the Kite call so a data-source
outage degrades to sim instead of killing the box.

### C6 · TOCTOU: risk check and position write straddle an `await`
`OrderManager.ts:25` (check) → `:43` (`await broker.placeOrder`) → `:117` (write).
The check is synchronous but the position that would satisfy the *next* check is only
written after the await, and nothing serialises `place()`.

`MarketDataService.tickOnce:87-94` emits ~10 symbols in one synchronous loop, and
`server.ts:47` fires `void orderManager.onTick(...)` per tick — deliberately
un-awaited. Call A passes `open = 4 < 5`, suspends at the await; call B reads the
same `open = 4`, passes. Both resume → **6 positions with `maxPositions = 5`**. The
daily-loss gate is equally racy: N concurrent orders all read the pre-loss `dailyPnl`.

Fix with a per-user async mutex around check+place+applyFill:
```ts
private queues = new Map<string, Promise<unknown>>();
private runExclusive<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = this.queues.get(userId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  this.queues.set(userId, next.catch(() => {}));
  return next;
}
```

### C7 · `onTick` re-fires exits from a stale trade list → permanent phantom trade
`OrderManager.ts:168-191` — `trades` is snapshotted **before** the `await place()` at
`:180`. The first exit's `closeMatchingTrades` marks every opposite-side trade CLOSED
and zeroes `pos.quantity`; the loop continues over the stale array without
re-checking `t.status`.

Iteration 2 calls `place()` with `quantity: Math.abs(0) === 0`. Risk approves (`0 *
price` is not `> cap`; the `qty < 1` trim branch is never entered). `PaperBroker`
returns `FILLED, filledQuantity: 0`. In `applyFill`, `prevQty === 0` → `reducing` is
false → **`openTrade()` creates a permanent OPEN trade with quantity 0**, which makes
`StrategyEngine.ts:62`'s `holding` check true forever — silently disabling that
strategy on that symbol for the process lifetime.

```ts
for (const t of trades) {
  const live = store.trades.get(t.id);
  if (!live || live.status !== 'OPEN') continue;
  const cur = store.positions.get(key);
  if (!cur || cur.quantity === 0) break;
  const direction = Math.sign(cur.quantity);   // re-read; don't use the :162 capture
  ...
}
```

---

## H — High (wrong results)

### H1 · `VWAPStrategy` is permanently dead in live trading
`StrategyEngine.ts:90` rolls every new candle with `volume: 0`; `indicators.ts:150`
returns `null` when `vol === 0`. The buffer seeds from `generateHistory` (real
volumes), but after ~20 cycles the trailing 20-bar window is all zero-volume candles.
Executed: `vwap(candles.map(c => ({...c, volume: 0})), 20)` → `null`.
`VWAPStrategy.ts:25` then returns `'no volume data'` **forever** — VWAP silently stops
trading ~20 minutes after startup, with no error and no log.
Fix: accumulate tick volume into the rolled candle at `StrategyEngine.ts:83-91`; and
surface a `null` VWAP as a warning, not a HOLD indistinguishable from no-signal.

### H2 · Supertrend under-warmed 6× — trend is wrong on 60% of bars
`SupertrendStrategy.ts:15` returns `period + 5` (15 bars). Supertrend is a
path-dependent ratchet — `finalUpper/finalLower` carry forward indefinitely, so the
result depends on where the recursion started. Measured disagreement vs. a full
600-bar history:

| warm-up window | bars disagreeing (of 100) |
|---|---|
| 15 (**current `minCandles`**) | **60** |
| 20 | 44 |
| 30 | 23 |
| 40 (`MLEnsemble`'s) | 8 |
| 60 | 0 |

Convergence needs ~6× period. Worse, `indicators.ts:183-187` seeds
`trend = close > finalUpper ? 1 : -1` where `finalUpper = hl2 + 3*ATR` — essentially
always above close, so the seed is **always `-1`**, biasing every under-warmed window
bearish. This corrupts the early bars of every backtest (which starts at `i = minBars`)
and every `optimize()` result.
Fix: `return (params.period ?? 10) * 6;`, raise `MLEnsembleStrategy.ts:39` from 40 to
≥60, and seed `trend = 1` at `indicators.ts:186`.

### H3 · `ML_ENSEMBLE` is a Supertrend sign function wearing a logistic hat
`MLEnsembleStrategy.ts:65` feeds `supertrend: st.trend` as raw ±1 with weight `1.3`
(`:35`). `prob >= 0.6` needs `z >= ln(0.6/0.4) = 0.405`. **The supertrend term alone
contributes ±1.3 → `prob = 0.786`**, past the buy threshold regardless of all five
other features, which can only veto by summing below −0.9 (rare, given the clamps).
Measured: it emits a signal on **560 of ~560 bars**, repeating the same action for up
to **157 consecutive bars**. It also inherits H2 wholesale.
Fix: raise `buyThreshold` past the single-feature contribution (~0.85), or scale the
supertrend weight to its co-features' order — the weights are hand-set and
unvalidated (`:28`), so treat this as a heuristic, never as ML.

### H4 · Level-triggered strategies re-enter straight through their own stops
No strategy carries state; `evaluate()` is a pure level test. Non-HOLD emissions over
600 bars:

| strategy | emits | consecutive dupes | longest run |
|---|---|---|---|
| MA_CROSSOVER / VWAP / SUPERTREND | 23 / 77 / 18 | 0 | 0 (edge-triggered ✓) |
| MEAN_REVERSION | 38 | 15 | 4 |
| BREAKOUT | 90 | 33 | 5 |
| MOMENTUM | 149 | 100 | 14 |
| ML_ENSEMBLE | 560 | 542 | **157** |

`StrategyEngine.ts:62` masks the *order* duplication via `holding`, but not the
consequences: the instant SL/TP closes a position, the still-true level **re-enters
on the very next cycle, defeating the stop**; and `signalHistory` (cap 200) is
flooded by ML_ENSEMBLE, evicting useful history.
Fix: make them edge-triggered — fire only on a threshold *crossing*
(`prevProb < buyAt && prob >= buyAt`), plus a neutral band / cooldown.

### H5 · Opposite-signal exits never reverse — for the edge-triggered strategies the trade is lost entirely
`BacktestEngine.ts:67-80` is an `if / else-if`: an opposite signal while `open` is
non-null closes at `:76-79`, but the entry branch at `:67` was already skipped this
bar. Re-entry needs the signal to **repeat** — and MA_CROSSOVER/VWAP/SUPERTREND
measure `longestRun = 0` (H4), so by construction they never repeat. The reverse
position isn't delayed one bar, it's **never taken**. The asymmetric trade counts
confirm it: MA_CROSSOVER BUY=11/SELL=7, SUPERTREND BUY=9/SELL=3.
Fix: make the close and the re-entry sequential statements, not exclusive branches.

### H6 · Stop-loss fills at the stop price even when the bar gaps through it
`BacktestEngine.ts:52-61` — `const exit = hitSL ? open.stopLoss! : open.takeProfit!`.
A stop is a *market* order once touched. Long with SL 1000, next bar opens at 940
(gap down, low 935) → the engine books the exit at exactly **1000**, erasing a
60-point loss that really happened. Every gap-down is silently deleted, so max
drawdown and profit factor are systematically optimistic. This is the single largest
source of inflated results on real Kite minute bars.
```ts
const exit = hitSL
  ? (open.side === 'BUY' ? Math.min(open.stopLoss!, bar.open) : Math.max(open.stopLoss!, bar.open))
  : open.takeProfit!;   // TP as a limit order legitimately fills at the TP price
```

### H7 · Sharpe annualised with √252 on 1-minute bars — off by ~19×
`BacktestEngine.ts:159` — `(mean / sd) * Math.sqrt(252)`, but `rets` are **per-bar**
and the bars are 1-minute (`MarketDataService.ts:101` defaults `intervalMs = 60_000`;
`routes/backtest.ts:22,80` request `'minute'`). NSE trades 375 min/day, so the factor
is `√(252 × 375) ≈ 307`. **A strategy with a true Sharpe of 2.0 is reported as 0.10**
and discarded — and `/compare` ranks on this value. Also: the risk-free rate is never
subtracted, and `variance` (`:156`) divides by `n` rather than `n-1`.
Fix: infer the interval from `candles[1].timestamp - candles[0].timestamp` and use
`Math.sqrt((252 * 375 * 60_000) / intervalMs)`.

### H8 · Same-bar-close fill
`BacktestEngine.ts:66-75` — `window = candles.slice(0, i+1)` includes bar `i`'s close;
every strategy reads `closes[closes.length-1]`; the engine then fills at that
identical `bar.close`. Not future leakage (nothing reads `i+1`), but **unrealisable**:
the decision requires the bar to be closed, at which point that price is gone. A
mean-reversion strategy buying a 2% down-close fills *at* the dip every time; live,
the earliest fill is the next open, which often gaps further.
Fix: fill at `candles[i+1].open` and stop the loop at `candles.length - 1`.

### H9 · Zero commission, zero slippage anywhere in the backtester
`BacktestEngine.ts:120` — `pnl = (exitPrice - entryPrice) * qty * dir`. Gross. Real
NSE intraday round-trip: ~₹40 brokerage + 0.025% STT on the sell + ~0.003% txn + 18%
GST + stamp duty. `PaperBroker` models 2 bps of slippage and nothing else
(`PaperBroker.ts:14`). On a ₹30,000 round trip, real costs (~₹55-60) eat **~65% of a
₹90 gross win**. `/compare` (`routes/backtest.ts:85-97`) ranks strategies by
expectancy with cost = 0, so a 400-trade strategy and a 12-trade one are ranked by
trade count — an ordering that **inverts** once costs are applied.
Fix: `abstract charges(req, fillPrice): number` on `BaseBroker`; net it in
`applyFill` and `BacktestEngine.close()`; rates in `config/index.ts:36-41`; store
`charges` on the `Order` so the trade log reconciles.

### H10 · `optimize()`: no train/test split, ranked on in-sample return, over a random walk with built-in drift
`BacktestEngine.ts:109-111` fits every combo and ranks by `totalReturnPct` on the
**same** series, returning the top 20 as recommendations. And the data is
`generateHistory` — a `Math.random()` walk starting at `seed * 0.85` with
`drift = 0.0002` per candle (`MarketDataService.ts:105-111`). **The built-in upward
drift guarantees long-biased params win regardless of merit**, fitted to a series that
will never recur. Zero out-of-sample validity, presented as an optimisation result.
Fix: 70/30 split, report **test** metrics, rank on Sharpe/expectancy, and surface both
columns so the degradation is visible.

### H11 · `/optimize` is a one-request DoS on a live-order system
`routes/backtest.ts:40` — `router.post('/optimize', (req, res) => {` — not even
async. `grid` is taken from the body with only `typeof grid === 'object'` validation
(`:45`); the combo count is the **unbounded Cartesian product** (`:100-108`).
Compounding it, `run()` does `candles.slice(0, i+1)` *inside* the bar loop (`:47`) —
O(n²), measured clean 4×-per-doubling (500→20ms, 4000→1041ms).

`{"grid":{"a":[1..10],"b":[1..10],"c":[1..10],"d":[1..10]},"bars":5000}` → 10,000
combos × 5000 bars × O(n²) on the **single** Node thread. Health checks, order
placement, and the SL/TP tick monitor (`server.ts:45-48`) are frozen for minutes.
`/compare` (`:85-97`) has the same shape.
Fix: cap combos (reject > 200), validate each grid value is a numeric array, move to
`worker_threads`, and hoist the window out of the loop.

### H12 · Live mode trades on synthetic candles with a manufactured uptrend
`StrategyEngine.ts:30` → `MarketDataService.ts:101-126`. `ensureSymbol()`
**unconditionally** calls `generateHistory(sym, 120)` with **no check on
`config.dataSource`**. With `DATA_SOURCE=zerodha, BROKER=zerodha`, strategies are
seeded with 120 fabricated candles that by construction rise ~15% from a stale
hardcoded price — MA_CROSSOVER sees fast > slow on a guaranteed synthetic uptrend and
fires **real BUY orders on the real exchange within the first cycle**, before a single
genuine candle exists. The buffer only flushes after 300 cycles. Symbols absent from
`SEED_PRICES` get `seed = 1000` — a wholly invented series.
```ts
this.candles.set(sym, config.dataSource === 'sim' ? marketData.generateHistory(sym, 120) : []);
```
Backfill live buffers from `kiteService` historical data; tag synthetic candles so
`runCycle:57` refuses to evaluate until the window is real.

### H13 · Position flip corrupts `avgPrice` and leaves an untracked, stopless position
`OrderManager.ts:98-112` — the `reducing` branch books P&L on `closedQty` but **never
recomputes `avgPrice`**, and the `newQty === 0` reset at `:116` only handles exact
closes. Long 10 @ 2950, SELL 15 @ 3000 → realised +500 ✓, but `newQty = -5` with
`avgPrice` still **2950** (the *long's* price). The new short is instantly marked with
a fabricated −250 and every future realised calc on it is off by `(3000-2950)*qty`.
And `openTrade()` is only called in the `else` branch → **the new short has no Trade
row, no SL, no TP; `onTick` will never exit it**.
Fix: split into two legs (close `closedQty`, then `pos.avgPrice = price` and
`openTrade` the residual) — or reject flips at the risk layer and require flat-then-reverse.

### H14 · Full realised P&L stamped onto *every* matching trade
`OrderManager.ts:140-152` — `t.pnl = realised` assigns the **entire position's** P&L
to each matching trade, ignoring per-trade quantity. Strategy A holds BUY 10, B holds
BUY 15 on TCS; one SELL 25 exits both; `realised = +2,000` → **both get `pnl = 2000`**
→ `GET /portfolio/trades` reports 4,000, and A is credited 2,000 for 40% of the
position. `store.getDailyPnl` is correct (+2,000 once) — so the trade log and the P&L
ledger **disagree**, the worst failure mode for reconciliation. There is also **no
partial-exit support at all**: a SELL 5 against a BUY 10 closes the whole trade record
while the position correctly retains 5.
Fix: allocate pro-rata by quantity, FIFO, closing only up to `closedQty`; on a partial,
decrement `t.quantity` and leave it OPEN.

### H15 · Daily loss limit ignores unrealised P&L
`RiskManager.ts:36` · `OrderManager.ts:104` — `addDailyPnl` is only called in the
`reducing` branch, so the limit tracks **realised only**. Five positions at −20,000
unrealised each = −100,000 drawdown against a 5,000 limit, and `dailyPnl` is **0**:
risk reports `dailyLossUsedPct: 0`, no alert fires, the engine opens more. The "hard
stop" only engages *after* the loss is crystallised — i.e. after it can no longer be
prevented. (Fix depends on C1 so exits stay permitted.)

### H16 · Filled orders persist to Mongo as `PENDING` forever
`OrderManager.ts:41` is the **only** `orders.set` call in the codebase (verified by
grep). `PersistentMap.set` (`memoryStore.ts:58`) snapshots via `{...value}` **at call
time**, so Mongo receives `status: 'PENDING', filledQuantity: 0`. Lines 44-49 then
mutate the object *in place* — the RAM cache sees FILLED (same reference), Mongo never
does. After a restart, `hydrate()` reloads every historical order as PENDING while
positions/trades reload as filled: **the order book can never be reconciled against
the position book** — exactly what you'd reach for after a bad session.
Fix: `order.updatedAt = Date.now(); store.orders.set(order.id, order);` after the
mutation and inside the `catch` from H17.

### H17 · Broker throw → unhandled rejection → process exit
`OrderManager.ts:43` — `await broker.placeOrder(finalReq)` has no try/catch, and
`BaseBroker.placeOrder:26` only promises a `Promise<BrokerOrderResult>`; nothing
enforces that an adapter never rejects. `server.ts:47` `void orderManager.onTick(...)`
swallows it into an unhandled rejection → **Node ≥15 terminates the process** mid-
session, with open positions and no SL monitor. `server.ts:61`'s
`void strategyEngine.runCycle()` is the same shape — any `evaluate()` throw kills it.
Fix: try/catch → mark REJECTED, persist, emit; `.catch(logger.error)` on both `void`
calls; `process.on('unhandledRejection', ...)`.

### H18 · Synchronous listener throw inside `setInterval` crashes the process
`server.ts:46` calls `strategyEngine.onTick` **synchronously** inside
`marketData.emit('tick')`, inside `tickOnce()`, inside `setInterval`.
`EventEmitter.emit` does not isolate listeners and `tickOnce` has no try/catch.
`StrategyEngine.ts:39` does `buf[buf.length-1].close = ltp` — guarded by `if (!buf)`
but **not** against an empty array → `TypeError`. `WebSocketManager.broadcast:61`
calls `client.send()`, which throws if the socket closes between the `readyState`
check and the send: **a dead browser tab can take down the trading engine.**
Fix: wrap the `emit` in try/catch, `try { client.send(payload) } catch {}`, and guard
`if (!buf?.length) return;`.

### H19 · Frontend — expired JWT permanently bricks the app
`lib/api.ts:43-46` throws a generic `Error` for every non-OK status; 401 is not
special-cased. `clearToken()` (`:29-31`) is **exported but never called** — there is
no logout path. Token expires → `AuthProvider.tsx:31` `api.me()` → 401 → `catch` at
`:38` sets `error` → `AppShell.tsx:20` renders "Backend unavailable" forever. **Reload
does not help**: `getToken()` is still truthy at `:30`, so it retries `me()` and never
falls back to the login branch at `:35`. The user is stuck until they manually clear
localStorage.
Fix: `clearToken()` on 401 and throw a typed `UnauthorizedError`; catch it in
`AuthProvider` and fall through to the login branch.

### H20 · Frontend — stale poll response overwrites fresher data
`lib/usePolling.ts:19-33` — `setInterval(run, intervalMs)` fires unconditionally, with
no in-flight guard and no sequence guard (`alive` distinguishes mounted/unmounted, not
old/new). At 3000ms (`dashboard`, `risk`, `trading/live`), if the backend slows past
3s, requests overlap: response N+1 lands, then slow response N lands and `setData(d)`
at `:23` **overwrites it** — the dashboard displays P&L and positions *older than what
it already showed*. On a trading UI that's a correctness bug.
```ts
const seq = useRef(0); const my = ++seq.current;
... if (alive && my === seq.current) setData(d);
```
Plus an `inFlight` ref to skip overlapping ticks.

### H21 · Frontend — two parallel WebSockets / self-sustaining reconnect flap
- `useWebSocket.ts:56-60` — `onVisible` calls `connect()` whenever
  `readyState !== OPEN`, which is **true for `CONNECTING` (0)**. `connect()` at `:33`
  overwrites `ws` **without closing or detaching the old socket**, which keeps its
  handlers: if it later fails, its `onclose` schedules a *second* retry chain; if it
  succeeds, both sockets deliver `onmessage` → **duplicated ticks and events**.
- `useWebSocket.ts:45` — `ws.onerror = () => ws?.close()` closes whatever the outer
  `let ws` *currently* points at. After a reconnect reassigns `ws`, a late error from
  the **old** socket closes the **new, healthy one** → `onclose` → another reconnect.
  Self-sustaining flap.

Fix: tear down before reconnecting (`ws.onclose = ws.onerror = ws.onmessage = null;
ws.close();`) and capture `const socket = new WebSocket(...)`, referencing `socket` in
every handler.

---

## M — Medium

| # | Finding | Location |
|---|---|---|
| M1 | SL/TP side derived from **net position**, not trade direction — a manual sell that nets a long position negative makes `direction = -1`, so the long trade is evaluated with **short rules** and its "stop-loss" fires on a favourable move. Also `t.stopLoss &&` silently skips a legitimate `stopLoss: 0`; use `!= null`. Size the exit from `t.quantity`, not `Math.abs(pos.quantity)`. | `OrderManager.ts:162,172-175,183` |
| M2 | Non-marketable LIMIT orders fill instantly at the limit price — `fillPrice = LIMIT && price ? price : ltp` with `status: 'FILLED'` unconditional, limit never compared to `ltp`. A BUY LIMIT @ ₹1 with LTP 2950 fills at ₹1 → +97k unrealised, and the value cap saw `33 * 1 = 33`. Also no liquidity check: 10M shares fill at LTP with zero impact. | `PaperBroker.ts:40` |
| M3 | Unbounded `orders`/`trades`/`positions` + O(n log n) scan **per tick** — `tradesByUser` full-scans and **sorts every trade ever** on each call; `onTick` calls it per position per symbol per tick. `positions.delete`/`trades.delete` have zero callers, so closed trades accumulate forever and `hydrate()` reloads the lot. Tick handling falls behind the 1s interval, SL/TP evaluation lags the market, RSS climbs unbounded. Fix: a `${userId}:${symbol}` → trade-id index; evict CLOSED from RAM; drop the sort from the hot path. | `memoryStore.ts:133-151` · `OrderManager.ts:168` |
| M4 | Break-even trades counted as losses — `losses = filter(t => t.pnl <= 0)`, and `pnl` is rounded to 2dp so exact zeros are common. 5 winners + 5 scratches → `winRate` 50%, `grossLoss` 0 → `profitFactor` takes the sentinel branch → **"50% win rate, PF 99, avgLoss 0"**, internally contradictory. | `BacktestEngine.ts:143-144` |
| M5 | `profitFactor` returns a magic `99` — indistinguishable from a real PF of 99; `/compare` caps at 5, so a 2-trade fluke with no losers scores maximum. Return `null`/`Infinity`; a zero-loss backtest means insufficient sample. | `BacktestEngine.ts:190` |
| M6 | `POST /api/backtest` accepts arbitrary unvalidated `candles` — only "non-empty array" is checked; `{"candles":[{"close":"abc"}]}` yields `NaN` arithmetic and returns **200** with `sharpeRatio: null` (JSON serialises NaN as null). Sim/Kite paths cap at 5000 bars; a client-supplied array has **no cap**. Same gap on `params` and `grid`. Fix: zod. | `routes/backtest.ts:14,20,45` |
| M7 | `errorHandler` flattens everything to 500, echoes `err.message` verbatim (a Mongo/Kite error can carry connection strings), and doesn't check `res.headersSent` (mandatory — it throws if a handler already wrote). | `middleware/errorHandler.ts:11` |
| M8 | Fire-and-forget writes behind a 201 — routes return created **before** Mongo confirms. Upsert fails → one log line → restart → `hydrate()` brings back a world without that strategy/order. Make the store API async and await on the request path; keep fire-and-forget for the tick loop only. | `memoryStore.ts:55-65` |
| M9 | Single-process assumptions — `setInterval(() => void strategyEngine.runCycle())` runs **in every process**: two replicas or PM2 cluster mode → every strategy evaluates twice → **duplicate live orders**, no leader election. `dailyPnl` is a per-process Map, so with N replicas the real loss limit is **N× the configured one**. Gate behind `RUN_STRATEGY_ENGINE=true` or take a Mongo/Redis lease. | `server.ts:61` · `memoryStore.ts:91` |
| M10 | No capital/margin constraint in the backtester — `cash` is only a P&L accumulator; entry never checks `qty * entryPrice <= cash`. `startingCapital: 10000, quantity: 1000` on a ₹2900 stock trades ₹2.9M of notional against ₹10k, and `totalReturnPct` divides by the 10k → wildly inflated. | `BacktestEngine.ts:38,68-75` |
| M11 | O(n²) live + backtest indicator recomputation — every indicator is rebuilt from index 0 on every bar (EMA/Wilder/Supertrend are all O(1) per bar by construction). Live recomputes over a 300-bar buffer per strategy × symbol × cycle. | `BacktestEngine.ts:47` · `StrategyEngine.ts:59` |
| M12 | `MACrossoverStrategy.minCandles` ignores `fast` — returns `max(slow, 21) + 2`, and nothing validates `fast < slow`. With `fast=200, slow=50` the strategy is admitted at 52 bars, `emaSeries(closes, 200)` returns `[]`, and it returns `'EMA warming up'` **forever** — silently, permanently inert. `optimize()` grid-searches into this region and reports 0 trades as a legitimate result. Fix: `Math.max(params.fast ?? 9, params.slow ?? 21, 21) + 2` and reject `fast >= slow` at config time. | `MACrossoverStrategy.ts:15,22` |
| M13 | 7-day JWTs with no refresh and no revocation — a stolen token is valid for a week against a live-money API, invalidable only by rotating the global secret (logging everyone out). No `helmet` → no HSTS, no `X-Content-Type-Options`, no frame protection. | `config/index.ts:17` · `app.ts` |
| M14 | Frontend — `usePolling` ignores the fetcher's captured params: deps are `[intervalMs, tick]` only, so navigating `/strategies/a` → `/strategies/b` doesn't refetch or reset state; **strategy a's data renders under URL b** for up to 3s. Fix: a `deps` param. | `lib/usePolling.ts:38` |
| M15 | Frontend — polls a hidden tab forever, no backoff on error. `/dashboard` backgrounded keeps 3 loops alive; with the backend down that's ~1 request/sec of pure errors, indefinitely. (`useWebSocket` gets this right — mirror it.) | `lib/usePolling.ts:17-38` |
| M16 | Frontend — every WS tick re-renders each `useLive()` consumer's full subtree. `setQuotes` → new object → new `useMemo` value → all consumers. `PriceChart:16`/`EquityCurveChart:15` rebuild their whole dataset each render → full recharts reconcile. **No `React.memo` anywhere** in the codebase. Fix: split into high-frequency `LiveQuotesContext` + `LiveMetaContext`, memo the tables/charts, `useMemo` the chart data. | `LiveProvider.tsx:41,78` |
| M17 | Frontend — `history` is mutated outside React and its identity **never changes**; renders only happen because `quotes` happens to change on the same tick, and `setQuotes` bails when the price is unchanged (`:41`) → the appended point is invisible until an unrelated tick. **This means M16's `React.memo` fix will silently break the charts** unless history moves to immutable `useState` first. Do them together. | `LiveProvider.tsx:34,42-45,79` |
| M18 | Frontend — silent failures: `strategies/page.tsx:17-35` `toggle`/`remove` use `try/finally` with **no catch**, and the un-awaited `onClick` turns a rejection into an unhandled rejection — the button un-disables, the list refreshes unchanged, **the user sees nothing**. `Topbar.tsx:19` swallows every error with `.catch(() => {})`. Error/loading states are dropped on 4 of 7 pages (`dashboard`, `analytics`, `trading/live`, `risk`) — a failing API is indistinguishable from "no data yet"; `/risk` renders blank. | multiple |
| M19 | Frontend — duplicate portfolio polling on `/dashboard`: `Topbar.tsx:13-26` hand-rolls a 4s `api.portfolio()` loop duplicating `usePolling` verbatim, while `dashboard/page.tsx:14` polls the **same endpoint** on an independent 3s timer. Their `totalPnl` values visibly disagree between the Topbar and the Total P&L card. | `Topbar.tsx:13` |

---

## L — Low / hygiene

- **`positionKey` parsed with `split(':')[0]`** (`OrderManager.ts:167` vs
  `memoryStore.ts:143`) — safe today (UUIDs), silently truncates if userIds ever
  become emails or namespaced identities. `positionsByUser`'s `startsWith(userId+':')`
  has the mirrored prefix-collision hazard. Carry `userId` on `Position` instead.
- **Mongo write amplification** (`OrderManager.ts:165`) — one upsert per position per
  tick (~432k/day at 5 positions × 1s) purely to record a fluctuating `ltp`, which
  `routes/portfolio.ts:13-15` already recomputes from `broker.getLtp()` anyway.
  Mark-to-market is ephemeral; don't persist it.
- **Live evaluates a *forming* candle; backtest evaluates *completed* ones**
  (`StrategyEngine.ts:35-44` vs `BacktestEngine.ts:66`) — a live bar's `high−low` is
  truncated, understating ATR and tightening Supertrend bands. Breaks the "same code
  in both" guarantee asserted at `BaseStrategy.ts:9-13`.
- **Signal timestamps are wall-clock** (`BaseStrategy.ts:24,44`) — backtest signals are
  stamped with the time the *test ran*. Use the bar's timestamp.
- **`MomentumStrategy` hard-codes MACD 12/26/9** (`:24`) — `optimize()` cannot tune the
  filter that gates every entry, and `minCandles`'s `Math.max(35, ...)` silently
  encodes the resulting requirement.
- **Role claim decoded but never enforced** (`middleware/auth.ts:26`) — latent, but it
  invites a future route to assume protection that isn't there.
- **Frontend**: `type as never` (`strategies/page.tsx:116`); index keys on
  server-reordered lists (`strategies/[id]/page.tsx:61`, `risk/page.tsx:21`);
  `NaN%` CSS width when `maxPositions` is 0 (`risk/page.tsx:54`, `Meter`'s clamp
  doesn't filter NaN); backtest trade log injects the *current* `quantity` state
  rather than the one the test ran with (`backtest/page.tsx:41`) — change the input
  without re-running and the table shows numbers that don't reconcile.
- **Frontend duplication**: `PriceChart`/`EquityCurveChart` ~95% identical;
  `Tooltip contentStyle` copy-pasted 4×; `StrategyComparison.color()` is a byte-for-byte
  duplicate of `format.pnlColor()` in a file that already imports from `format`; symbol
  lists forked across 3 pages **and already drifted**; `OrdersTable` redeclares the
  `Order` shape inline and has already lost `filledQuantity`/`rejectionReason`/`orderType`.

---

## Verified correct — do not "fix"

Bounding the audit so these don't get churned:

- **Indicator math is textbook-correct.** RSI is genuine Wilder smoothing — matched
  Wilder's published 33-close reference to ≤0.07 across all 19 points (residual is the
  reference table's own rounding). EMA seeding (SMA seed at `period-1`, k=2/(p+1)),
  ATR indexing (the `tr[i-1] ↔ candle i` offset is right), Bollinger (population SD is
  the textbook BB definition), MACD, and the Supertrend recurrence itself are all
  correct. Donchian correctly **excludes** the current bar (`slice(-(period+1), -1)`).
- **No genuine look-ahead.** Nothing indexes `candles[i+1]`. H8 is a same-bar-fill
  realism problem, not leakage.
- **Short-side P&L signs are correct** (`OrderManager.ts:102,164`).
- **Max-drawdown peak-to-trough walk is sound and div-by-zero-safe**
  (`BacktestEngine.ts:163-169`).
- **IDOR is genuinely handled.** `routes/strategies.ts:47,54,67,76` each re-fetch by id
  and verify `cfg.userId !== req.userId`, returning **404 not 403** — correct, and it
  doesn't leak existence. Orders/portfolio are `userId`-scoped at the store layer with
  no by-id accessor exposed.
- **WS lifecycle basics are right**: socket created once (`[]` deps + `cbRef` latest-
  callback pattern), full cleanup on unmount, hidden-tab recovery via
  `visibilitychange` works, and the event/history buffers are bounded on both axes
  (40 events, 60 points/symbol, bounded symbol keyspace).
- **`StrategyEngine` buffers are correctly bounded** (300 candles, 200 signals).

---

## Suggested order

**Before the next run, live or paper:**
1. **C1** — the deadlock. Nothing else matters while stops can be rejected.
2. **C2** — negative quantity. One line of validation.
3. **C3 + C4** — JWT default, rate limit, don't seed an admin demo account in prod.
4. **C5** — `import 'express-async-errors'` + `unhandledRejection`. One line each,
   stops the process dying with open positions.

**Before trusting a single backtest number:**
5. **H9 + H6 + H8** — costs, gap fills, next-bar entry. Today every number is fiction.
6. **H7** — the Sharpe factor. You are discarding your best strategies.
7. **H10** — train/test split; stop optimising on in-sample return over a drifted
   random walk.

**Before trusting the strategies:**
8. **H1** — VWAP is dead. **H2 + H3** — Supertrend is a coin flip and ML_ENSEMBLE is
   its sign function. Three of seven strategies are currently unsound.
9. **H4 + H5** — edge-trigger the level strategies; make reversals actually reverse.

**Then:** C6/C7 (concurrency), H13/H14 (P&L attribution — and these are the
prerequisite for the multi-trade and averaging features in `ANALYSIS_REPORT.md` §4-5),
H12 (before `BROKER=zerodha` ever runs), M3/M9 (scale), then the frontend set.
