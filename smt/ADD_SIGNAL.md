# Add-money lights (2026-10-15)

One light per stock on the stock table (`/accumulator`, dashboard) and on every
recommendation card: **should I add new money to this stock now, and how much?**

| Light | Label | Meaning |
|---|---|---|
| 🟢 | Add now | Buy the planned amount today |
| 🟡 | Add smaller | Buy today, but about half: a very bumpy or thinly traded stock |
| 🔴 | Wait | Pause NEW money. Never means sell |
| ⚪ | No read | Under ~1 year of prices |

Amounts are whole shares. Click a light for the reasons and notes.

## The rules

**Red:** only for measured or structural reasons. These are the market **HOLD**
sign (breadth divergence, the only market sign that passed both halves of
history), NSE **surveillance**, the **news veto**, the engine's own **entry
block**, **halted / kill switch**, and the stock already at the **35% per-stock
cap**.

**Yellow:** about size, never timing. It covers ATR ≥ 5% of price and median
turnover under ₹2 crore/day. The light buys `SMALLER_FRACTION` (0.5) of the
plan, raised to the DP floor or one share.

**Green:** everything else.

**Notes:** these never change the light or the amount. They cover the expected
dip, the market page's "invest in steps", and an upcoming results date.

## Why there is no "wait for a dip" (verification, 2026-10-15)

The first version had a staging yellow: part now, the rest at a dip price or
after N sessions. It was replayed point-in-time on 90 large caps
(2017-11 → 2025-10, every 5th session, ~13,000 stock signals and ~4,500 market
signals). Script: session scratchpad `verify/backtest.ts`.

| Trigger | Return vs buying all now (63d / 252d) | Both halves | Worst 5% | P(loss > 20%) |
|---|---|---|---|---|
| Stock: dip likely soon | −0.48% / −0.68% | negative | +1.0 / +0.6 pt | 6.3→5.9% / 13.2→13.0% |
| Market: NIFTY ≥10% off its high | −1.37% / −1.96% | negative | +1.0 / +0.7 pt | 1.7→1.8% / 4.3→4.2% |

Staging gave up 1.5–5 points of the best outcomes for almost no protection.
The user chose "follow the data", so the dip and the market's steps became
notes. The fallback in the old rule did matter: "skip if no dip comes" was 5–13×
worse (−2.5% to −25.6%).

**The yellow premise was re-checked on the same sample** (`verify/tail.ts`).
Over 63 days, yellow-light stocks trailed NIFTY by more than 20 points 12.8% of
the time, against 3.6% for green (first half 13.5 vs 5.2, second half 9.0 vs
2.2). Their mean excess return was +5.9% against +1.8%. That is a fatter tail
AND a higher mean: "buy smaller", not "skip".

**Caveat:** the universe is today's large caps. That survivor bias flatters
buying now, so the true cost of waiting is probably smaller than measured,
though still not positive.

## Other verification

- **Unit tests:** `BE/src/tests/addSignal.test.ts` has 21 tests, including a
  20,000-case seeded property test. It checks:
  - red if and only if a red cause is present
  - whole shares, never over the plan
  - yellow if and only if a size cause is present
  - results dates and market steps never change the decision
  - banned phrases
- **Mutation checks:** six deliberate bugs were all caught. These were red on
  run-up, no fallback floor, one share too many, wait-for-dip yellow restored,
  market steps turning red, and yellow not sizing down.
- **Property-test catches:** the test found a real overspend of ₹1.22 at
  ₹7.09/share from a flat ₹1 rounding slack. It is fixed: share maths now runs
  on the unrounded plan.
- **Independent audit:** 116 checks against raw Mongo and raw Yahoo bars:
  cap room for 22 books, red causes, and add-at levels. ATR% was computed three
  ways (engine, light, hand-written Wilder) and agreed to two decimals.
- **Live run:** a read-only copy of real data (`verify/serve.ts`), rendered on
  FE :3002 at desktop and 390px widths, with no page errors and no horizontal
  scroll. On 2026-10-15: 21 green, KAYNES red (news veto), no yellow. The
  bumpiest was OLAELEC at ATR 4.92%, just under the line.
- **Full suite:** all 48 BE suites pass, and the BE build passes. FE tsc,
  eslint and tests pass.

## Amounts

- **Books:** room under the per-stock cap (capital × 35% − lot cost − T+1),
  counted the way the allocator counts it. Minimum buy is the ₹16k tranche.
  Index ETFs are uncapped, so they get a percent only.
- **Recommendations:** the card's own allocation at the card's own entry price,
  so share counts match the card. Minimum buy is ₹5k (DP drag ~0.4%).

## Files

- `BE/src/services/addSignal/signal.ts`: the pure rules
- `BE/src/services/AddSignalService.ts`: gathers inputs, 10-minute cache
- `BE/src/routes/addSignals.ts`: `GET /api/add-signals/books|recommendations[?refresh=1]`
- `RecommenderEngine.turbulenceFor()` / `newsVeto()`: share the 10-year candle and news caches
- `FE/ismta/app/components/AddSignal.tsx`: pill, summary strip, `useAddSignals`

The lights are read-only: the engine never reads a light, and nothing here
places an order.

## Open point

The **Market Weather** page still says "invest in steps" during corrections.
This test is an approximation of that verdict: it used a single trigger (NIFTY
≥10% off its high) and a 25%-now schedule, not the page's exact plan. Even so,
it measured a cost of 1–2%. The page has not been changed. That is a separate
decision for the user.
