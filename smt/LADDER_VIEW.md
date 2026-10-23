# Ladder view — design analysis and verification checklist

**Date:** 2026-09-16 · **Scope:** `/accumulator/<SYMBOL>` · **Status:** built, 16 unit tests + 36 browser checks passing.

Shows every rung of the open ladder: what has been bought, what it is worth, and what the engine is still waiting to buy — green when in profit, red when at a loss.

---

## 1. What the codebase actually does (checked, not assumed)

Before designing anything, the engine's own model:

| Fact | Where | Consequence for the UI |
|---|---|---|
| An **epoch** is one ladder generation. `levels[]` are the rung prices, index 0 = the anchor. | `accumulator/types.ts:79` | Rows are per-rung of the **open** epoch only. |
| `filledLevels` is **append-only** — a rung is never un-filled, even after its lot sells. | `engine.ts:607` | A sold rung must be its own state. Rendering it as "waiting" would promise a buy that **cannot happen** in this ladder. |
| An epoch closes when its **last open lot** sells; a new one anchors later. | `engine.ts:670` | Closed lots from older epochs must not attach to live rungs. Matching is on **epoch AND level**. |
| Rung gaps **compound** and grow by `stepGrowth` each step. | `math.ts:113` | Rung spacing widens with depth — the list shows each rung's own distance from the mark rather than implying even steps. |
| Next tranche = `(budget × (1 − reserve) − spent this epoch) ÷ unfilled rungs`, where "spent" includes lots already **sold**. | `engine.ts:341` | Not `budget ÷ rungs`. Served from the API rather than recomputed client-side. |

## 2. The decision that shaped the feature

The request was "green if in profit, red if in loss." That needs a definition of profit, and **this engine has two that disagree**:

- **paper-even** — `quantity × mark − quoteSpent`, the lot's `unrealised`. Counts charges paid on the **buy**. Served by `routes/accumulator.ts:173`.
- **breakeven** — `netBreakeven(...)`, the price at which a **sale** actually clears cost, so it also carries brokerage, STT, exchange, GST, SEBI, stamp duty and the **flat DP charge**.

Between them is a dead zone where `unrealised` reads positive and selling still books a loss. Measured against the engine's own cost model:

| Lot size | Dead-zone width | Loss if you sold inside it |
|---|---|---|
| ₹1,000 | **1.70%** | ₹16.99 |
| ₹10,000 | 0.26% | ₹26.34 |
| ₹15,000 | 0.21% | ₹31.54 |
| ₹2,00,000 | 0.11% | ₹223.89 |

It is widest exactly where positions are smallest, because the DP charge is a flat rupee amount. This is the trap `math.ts` warns about in its own comment: *"a percentage-only breakeven books 'profits' that are losses on the contract note."*

**So colouring on `unrealised` would paint a lot GREEN that the engine will refuse to sell** — on a screen whose entire promise is that it never sells at a loss. Hence three states, not two:

| State | Condition | Meaning |
|---|---|---|
| 🟢 **green** — "in profit" | `mark ≥ breakeven` | A sale clears cost. The engine may sell here. |
| 🟡 **amber** — "below breakeven" | `paper-even ≤ mark < breakeven` | Up on what you spent, still a loss to sell. The engine holds. |
| 🔴 **red** — "at a loss" | `mark < paper-even` | Down on the spend too. |

Amber is not hedging. It is the one band where the two definitions disagree, and hiding it is how someone concludes the engine is stuck. The live page proves the case: a lot showing **+₹2.00 unrealised** renders amber with *"breakeven ₹500.60 — needs 0.1% more"*.

## 3. What each row shows

- **Held** — `r2 · 20 @ ₹500.00 · below breakeven · +₹2.00 (+0.0%)`, then spend, breakeven (with "needs X% more" when short), and the resting sell target — or the trail stop once the lot has armed.
- **Sold** — `r1 · 25 @ ₹485.00 · sold at ₹505.00 · +₹475.00`. Realised P&L is positive by construction.
- **Waiting** — `r4 · ₹343.10 · 31.4% below the mark · waiting`. The shallowest unfilled rung is highlighted as **next** and carries `buys ~₹12,500 when price crosses`.
- **Header** — ladder index, anchor price, `held · sold · waiting` counts, and the next buy. Replaced by a kill-switch notice when one is engaged.

State is carried by a **dot, a word and the colour** — never colour alone — so it survives greyscale, colour blindness and forced-colors.

## 4. Verification checklist

### Unit — `cd FE/ismta && npm test` (16 assertions, all pass)

Run with Node's type stripping; no test framework was installed and adding one for a single suite would be a bigger change than the code it covers.

- [x] `breakeven > paper-even` — the dead zone is real, not theoretical
- [x] A mark inside the dead zone returns `deadzone`, **and** `unrealised` is asserted positive there — the trap is pinned, not just described
- [x] `mark ≥ breakeven` → `clears`, boundary inclusive
- [x] `mark < paper-even` → `down`; paper-even itself is not yet a loss on spend
- [x] The three states are exhaustive and ordered by mark
- [x] A lot with no served breakeven invents no floor
- [x] Zero-quantity lot does not divide by zero
- [x] Every rung of the open epoch gets exactly one row
- [x] No open epoch returns `null` — a normal state, not an error
- [x] A held lot marks its rung; the rest wait
- [x] **A sold rung stays sold** and is not counted as waiting
- [x] **Lots match on epoch AND level** — an old sale never attaches to a live rung
- [x] Next rung is the shallowest unfilled one
- [x] A fully filled ladder has no next rung
- [x] `held + sold + waiting` always accounts for every rung
- [x] Rung prices carry through in descending order; rung 0 is the anchor

### Browser — Playwright against the running app (36 checks, all pass)

Two passes × two themes. The **fixture** pass intercepts `/api/accumulator/<SYMBOL>` to put all five row states on screen at once — the unit tests prove the logic, this proves the states actually *render distinctly*, which no assertion can.

- [x] Ladder card renders (live and fixture, light and dark)
- [x] Rungs listed; all 5 fixture rungs shown
- [x] Rung 0 labelled as the anchor
- [x] Colour legend explains sell-side charges
- [x] **Green, amber and red all render distinctly** in both themes
- [x] Sold row renders; waiting row renders
- [x] No horizontal overflow
- [x] No unformatted float
- [x] Zero console errors or warnings

### Cross-check against the chart

The live page's list and the existing price chart are independent renderings of the same data, so they are a check on each other. They agree exactly:

```
list:  anchored ₹321.60 · next buy ₹302.30 · r2 ₹281.45 · r3 ₹259.11
       r0 breakeven ₹322.87 · sells at ₹335.80
chart: Rung 1 ₹302.30 · Rung 2 ₹281.45 · Rung 3 ₹259.11
       BE r0 ₹322.87 · Sell r0 ₹335.80
```

### Build

- [x] `BE tsc --noEmit` clean · `BE npm test` — 27 suites pass
- [x] `FE tsc --noEmit` clean · `FE next build` — 16 routes

## 5. Problems found and fixed during the work

1. **The test broke the backend build.** The first version put the suite in `BE/src/tests/` importing the frontend module. It passed — and `tsc --noEmit` and `npm run build` both failed with `TS6059: not under rootDir`. Moved to the frontend beside the module it tests. *Caught by running the build, not the test.*
2. **Name collision** — the imported `LadderRow` type and the local row component shared a name. Component renamed to `RungRow`.
3. **Node ESM needs the real extension** for type stripping, so the test imports `./ladder.ts`. Enabled `allowImportingTsExtensions` (safe: `noEmit` is already on, and it only permits the explicit form).
4. **Dark-mode contrast** — the sold row's price sat at `zinc-500` on a dark row background, roughly 3.5:1. Too thin for a number; one step lighter in dark only.

## 6. Files

| File | Change |
|---|---|
| `FE/ismta/app/lib/ladder.ts` | **New** — pure: `lotState`, `paperEven`, `buildLadder`. No JSX, so it is testable |
| `FE/ismta/app/lib/ladder.test.ts` | **New** — 16 assertions |
| `FE/ismta/app/components/LadderList.tsx` | **New** — rendering only |
| `FE/ismta/app/accumulator/[symbol]/page.tsx` | "The ladder — every rung" card, under the chart |
| `BE/src/routes/accumulator.ts` | Serves `nextTranche` on the book detail |
| `FE/ismta/app/lib/api.ts` | Types `nextTranche` |
| `FE/ismta/package.json` | `npm test` |
| `FE/ismta/tsconfig.json` | `allowImportingTsExtensions` |

## 7. Deliberately not done

- **No rung price on filled rows.** The **fill** price is authoritative — `types.ts:45` says so outright ("the requested price is never authoritative") — and showing both invites the reader to wonder which one is real.
- **No "sell now" button per rung.** Exits are the engine's decision and are never blocked or forced from the API; a per-row button implying otherwise would misrepresent the guarantee.
- **No progress bar of ladder depth.** The rungs already carry their own distance from the mark, and spacing compounds — a linear bar would draw uneven gaps as even ones.
