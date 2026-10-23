# Strategy engine vs accumulator — why both run, and where they collide

**Date:** 2026-09-16 · **Question:** why is MA Crossover running when the accumulator is working properly? · **Status:** **FIXED** — see §7.

The accumulator keeps running exactly as before (19 books, 7 enabled, still stepping). The strategy engine now yields to it.

---

## 1. Why it is running at all

Nobody switched it on. [`BE/src/bootstrap/seed.ts`](BE/src/bootstrap/seed.ts) creates three demo strategies **already enabled**, with `direction: 'both'` so they may go short:

```ts
name: 'NIFTY MA Crossover',
symbols: ['RELIANCE', 'TCS'],
quantity: 10,
direction: 'both',
enabled: true,     // ← the seed, not you
```

Two survive and are live right now (verified against the running API):

```
NIFTY MA Crossover  MA_CROSSOVER  enabled=True  dir=both  qty=10  RELIANCE,TCS
Bank Momentum       MOMENTUM      enabled=True  dir=both  qty=15  HDFCBANK,ICICIBANK

positions: TCS qty=-10 @ 2242.30 · RELIANCE qty=-10 @ 1247.70
```

The `-10` are intraday shorts. They are legitimate: the strategy engine places **MIS** ([`OrderManager.ts:251`](BE/src/services/OrderManager.ts#L251)) and is flattened at **15:10**, ahead of the broker's 15:25 square-off. The accumulator places **CNC** ([`AccumulatorEngine.ts:105`](BE/src/services/AccumulatorEngine.ts#L105)) and is long-only. Different product, different rules — so the no-loss guarantee is not touched by the short.

## 2. The two engines are genuinely independent — including where they should not be

| | Accumulator | Strategy engine |
|---|---|---|
| Order path | `brk.placeOrder()` **direct** ([`:657`](BE/src/services/AccumulatorEngine.ts#L657)) | `orderManager.placeFromSignal()` |
| Pre-trade gate (`orderGate`) | ✅ | ✅ |
| **Risk gate (`RiskManager`)** | ❌ **never called** | ✅ `OrderManager:88` |
| **Funds reservation (`FundsService`)** | ✅ | ❌ **never called** |
| Capital basis | per-book `budget` | `config.risk.capital` |
| Cross-engine awareness | **none — verified by grep** | **none** |

Each engine skips exactly the control the other relies on.

The accumulator skipping `RiskManager` is **defensible**: the daily-loss limit and consecutive-loss breaker are meaningless for an engine that cannot book a loss, and `maxPositions: 5` would block a book that runs 19. It has its own controls (breakeven floor, deploy ceiling, reserve, per-book kill switch).

The strategy engine skipping `FundsService` is the one with no such justification — it means it can commit money the accumulator has already claimed.

## 3. The collision, quantified

**Symbol overlap is already present.** The accumulator has books for RELIANCE and TCS — the same two symbols MA Crossover is shorting:

```
ACCUMULATOR books (19): ETERNAL, BAJAJHFL, OIL, COALINDIA, OLAELEC, NTPC,
  COROMANDEL, KAYNES, SEAMECLTD, ABFRL, ARE&M, SCI, NHPC, RCF, IREDA, NBCC,
  RELIANCE, TCS, SYRMA
STRATEGY symbols (4): RELIANCE, TCS, HDFCBANK, ICICIBANK
OVERLAP: RELIANCE, TCS
```

**It is not active today** — both books are `enabled=false`, budget ₹0, no lots. So there is no live conflict, and nothing needs fixing this minute.

**But the only thing holding it back is a market condition.** The allocator's own note on both books:

```
RELIANCE: enabled=False  "downtrend (EMA50 below EMA200) — refusing to anchor"
TCS:      enabled=False  "downtrend (EMA50 below EMA200) — refusing to anchor"
```

That is a trend filter, not a conflict check. The allocator **can flip a book on by itself** — [`AllocatorEngine.ts:311`](BE/src/services/AllocatorEngine.ts#L311):

```ts
const enabled = a.selected ? true : book.enabled;
```

So when RELIANCE's EMA50 crosses back above its EMA200, the allocator may select it, set `enabled = true`, and the accumulator will start **buying RELIANCE in CNC while MA Crossover shorts it in MIS** — with no component anywhere aware that both are happening.

**Capital is double-counted.** Against an account of ₹2,00,000:

| Claim | Amount | Reserved at broker? |
|---|---|---|
| Accumulator budgets (19 books) | ₹1,97,886 | ✅ via `FundsService` |
| Strategy engine headroom (5 × ₹1,00,000) | ₹5,00,000 | ❌ no funds check |
| **Combined worst case** | **₹6,97,886** | against ₹2,00,000 |

In paper mode this is invisible — `PaperBroker` fills anything. On a live account the broker rejects for margin, and *which* engine gets rejected is a race.

## 4. Verification checklist

Every item checked against the running system or the source, not assumed.

### The facts

- [x] Strategies are enabled by the seed, not by the user — `seed.ts`, `enabled: true`
- [x] Two are live now — confirmed via `GET /api/strategies`
- [x] The `-10` positions match MA Crossover's symbols and `quantity: 10` — confirmed via `GET /api/portfolio`
- [x] Strategy orders are **MIS**, accumulator orders are **CNC** — so the short is legal and does not touch the no-loss rule
- [x] MIS is auto-flattened at 15:10, ahead of the 15:25 broker square-off — `session.ts:197`

### The gaps

- [x] **Symbol overlap exists**: RELIANCE, TCS are in both systems
- [x] Those two books are currently disabled with ₹0 budget — **no live conflict today**
- [x] They are held back by a **trend filter**, not a conflict check — allocator note quoted verbatim
- [x] The allocator **can enable a book without the user** — `AllocatorEngine.ts:311`
- [x] **No cross-engine guard exists** — `grep` for `strategyEngine|strategies` across `AccumulatorEngine.ts`, `accumulator/*`, `orderGate.ts` returns nothing
- [x] `orderGate` has **no opposing-position check** — `grep` for `position|holding|opposite|short` returns nothing
- [x] Accumulator **never calls `RiskManager`** — `grep` across `AccumulatorEngine.ts`, `accumulator/`, `AllocatorEngine.ts` returns nothing
- [x] `OrderManager` **never calls `FundsService`** — `grep` for `funds|deployable|reserve` returns nothing
- [x] Capital arithmetic confirmed live: budgets ₹1,97,886 · deployable ₹1,99,000 · strategy headroom ₹5,00,000

### Documentation defect found

- [x] **`OPERATIONS.md` is wrong.** It opens with:

  > *"Every order, from every caller (the ticket, the strategy engine, the accumulator, a standing trigger), goes through the same two gates in this order: 1. Pre-trade gate … 2. Risk gate (`RiskManager`)"*

  The accumulator goes through gate 1 only. Gate 2 is never called on its path. The skip is probably correct by design — but the safety document says it happens, and it does not. Anyone reading that file to answer *"what stops the accumulator over-trading?"* gets a wrong answer.

## 5. What was fixed

The rule applied throughout: **the accumulator is the system of record and keeps running; the strategy engine yields.**

| # | Fix | File |
|---|---|---|
| 1 | **Cross-engine guard.** A strategy *entry* on a symbol with an enabled accumulator book is refused with `symbol_reserved`. Exits are never refused. The accumulator, the manual ticket and triggers are unaffected — only orders carrying a `strategyId` are strategy-originated. | `services/orderGate.ts` |
| 2 | **Seed no longer auto-trades.** All three demo strategies are created `enabled: false`; the boot log says so. The accumulator is not seeded and is untouched. | `bootstrap/seed.ts` |
| 3 | **The two live strategies switched off** via the API. Their open shorts are untouched and still flatten at 15:10 — `enforceSessionFlatten` iterates positions directly on its own 30 s timer, explicitly "so it survives a stalled strategy cycle". | live state |
| 4 | **`OrderManager` now checks funds** on a BUY-to-open, reserving through `FundsService` and releasing in a `finally`. Sells are not gated (shorting consumes margin, not cash, and there is no margin model here); reducing orders are not gated. | `services/OrderManager.ts` |
| 5 | **`OPERATIONS.md` corrected** — it claimed the accumulator passes the risk gate. It does not, by design; the section now says which controls it uses instead, and a new "One symbol, one engine" section documents the guard. | `OPERATIONS.md` |

### Verification

- [x] `BE tsc --noEmit` clean · **28 suites pass** (`orderGate` 14→23, `orderManager` 7→10)
- [x] `FE tsc --noEmit` clean · 16 ladder tests pass
- [x] **The guard fires through the real order path**, not just the pure function:
      `Order refused [symbol_reserved] BUY 10 RELIANCE: RELIANCE is held by the accumulator…`
- [x] A strategy **exit** on a reserved symbol still fills and goes flat — the trapped-position case
- [x] A strategy **DCA add** is refused; `manageTrailing` already treats that as expected and falls back to the final stop
- [x] The **15:10 session flatten** is never refused (it places with `intent: 'exit'`)
- [x] The **accumulator** is never blocked by its own book — it carries a `tag`, never a `strategyId`
- [x] Another user's book does not reserve the symbol
- [x] Live after the change: accumulator **19 books, 7 enabled, ₹1,96,854 equity, still stepping**; strategies **0 enabled**

One check was **inconclusive and is reported as such**: a live probe created a strategy on ETERNAL (which has an enabled book), enabled it for 20 s and deleted it. No position was opened — but the strategy never signalled in that window, so the gate was not exercised. That gap is closed by the `orderManager` integration tests instead, which drive the real `place()` path.

### 6. Risk limits now follow the account

The sizing problem turned out to be a real defect rather than a config choice. `RISK_MAX_POSITION_VALUE` and `RISK_DAILY_LOSS_LIMIT` were **absolute rupee defaults chosen for the ₹10,00,000 default capital**, where they mean 10% and 0.5%. Nothing tied them to `RISK_CAPITAL`, so setting a smaller account silently kept limits sized for the larger one:

| At capital | maxPositionValue | dailyLossLimit | 5-position notional |
|---|---|---|---|
| ₹10,00,000 (the default they were written for) | 10% | 0.5% | 50% of capital |
| **₹2,00,000 (yours)** | **50%** | **2.5%** | **250% of capital** |

Both are now fractions of capital — `0.10` and `0.005` — reproducing the old numbers exactly at ₹10,00,000, so an account that never set `RISK_CAPITAL` sees no change. An explicit env var still wins.

Live after the change: `maxPositionValue` ₹1,00,000 → **₹20,000**, `dailyLossLimit` ₹5,000 → **₹1,000**, five-position notional 250% → **50% of capital**.

`.env.example` listed both as absolute figures, so anyone copying it got the defect straight back. They are now commented out with the derivation explained.

`server.ts` also logs the limits as a share of capital at boot and warns when they exceed it — not an error, because MIS carries intraday leverage and exceeding capital can be deliberate; it is worth saying only because the accumulator trades the same account in CNC with none.

Three tests pin it (`riskGate` 20→23), each skipped when the corresponding env var is set so an explicit override stays legal.

### Not done

Nothing outstanding from this analysis.

## 6. Direct answer

MA Crossover was running because the demo seed switched it on, and nothing since had switched it off. It was not interfering with the accumulator *yet* — different product, and both overlapping books happened to be disabled — but the two engines shared an account and knew nothing about each other, and the only thing keeping them off the same stock was RELIANCE and TCS being in a downtrend.

That is now closed from both ends: the strategies are off and no longer start themselves, and if one is ever switched back on it cannot take an entry on a stock the accumulator owns. **The accumulator is unchanged and still running** — 19 books, 7 enabled, stepping normally.
