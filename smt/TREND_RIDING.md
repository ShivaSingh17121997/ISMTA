# Trend riding: do targets update, and should lots ride an up-move?

2026-09-18. Question asked: *"Are we re-updating the target? Is there logic for riding an upward trend, since the market is up today? Can we implement it?"*

**Short answer.**
1. **The target does not follow price.** Each lot sells at `breakeven × 1.04`, and that number is fixed when the lot is bought. It changes only when the profile flips between swing (+4%) and scalp (+1.5%).
2. **Trend-riding code exists (the "ratchet") but almost never switches on.** It only arms if price *jumps* past +8% between two polls. In a normal rise, price crosses +4% first and the lot sells there.
3. **I measured a proper ride-the-trend exit, and a buy-sooner-in-uptrends entry, on 5 years of data. Neither is a reliable improvement.** The best variant gains about +0.5 points a year on one universe and loses on the other two. **Recommendation: don't make it the default.** Details and options are in §5.

---

## 1. Checklist: what the code does today (verified in source)

| # | Check | Result | Where |
|---|---|---|---|
| 1 | Is a lot's target recalculated as price moves? | **No.** `target = sellTarget(breakeven, targetPct)`, where breakeven comes from the lot's own cost. It is the same number for the lot's whole life. | [engine.ts:145](BE/src/services/accumulator/engine.ts#L145), [math.ts:99](BE/src/services/accumulator/math.ts#L99) |
| 2 | Can the target change at all? | **Yes, only by a profile flip.** Swing = +4%, scalp = +1.5%. With Auto on, an *up* regime selects swing, so uptrends already get the wider target. | [types.ts:272](BE/src/services/accumulator/types.ts#L272), [scalp.ts:67](BE/src/services/accumulator/scalp.ts#L67), `trend.ts` `profileForRegime` |
| 3 | Is there trend-riding logic? | **Yes: the ratchet.** `trail: { enabled: true, armPct: 8, retracePct: 3 }`. Once armed, a lot follows its high and exits 3% below it, with the exit never below the +4% target. | [types.ts:275](BE/src/services/accumulator/types.ts#L275), [engine.ts:168-205](BE/src/services/accumulator/engine.ts#L168-L205) |
| 4 | Does the ratchet fire in a normal up-move? | **No.** It arms at +8% (`lotArmPrice`), but the lot sells at +4% first ([engine.ts:415](BE/src/services/accumulator/engine.ts#L415)). The only way to arm is going from below +4% to above +8% between two 60-second polls, which in practice means an overnight gap. | [engine.ts:150-157](BE/src/services/accumulator/engine.ts#L150-L157), [AccumulatorEngine.ts:182](BE/src/services/AccumulatorEngine.ts#L182) |
| 5 | After a lot sells in an uptrend, does the book buy back in? | **Not until price dips 3% below the 45-day high** (start gate). In a steady climb, the book sits in cash. | [engine.ts:467-477](BE/src/services/accumulator/engine.ts#L467-L477) |
| 6 | Is riding safe for the no-loss rule? | **Yes, by construction.** `sellLot` refuses anything below breakeven, and the ratchet's stop is floored at the target. If price gaps under the target, the lot HOLDs. | [engine.ts:397](BE/src/services/accumulator/engine.ts#L397), [engine.ts:641](BE/src/services/accumulator/engine.ts#L641), `tests/trail.test.ts` |
| 7 | Paper fills on a sell above target | Paper books the sale **at the target** even when the market is higher (PaperBroker fills a LIMIT at its limit). A live exchange would fill at the better market price. **So paper under-reports these exits.** | [PaperBroker.ts:56](BE/src/brokers/PaperBroker.ts#L56) |
| 8 | Other engines | The **strategy engine** (intraday MIS) has a real trailing stop (arms at +0.8%, trails 1.5%, no take-profit cap), but all its strategies are disabled. **The /recommendations targets** are fixed reward:risk levels, advisory only, recalculated each run. Neither trades your accumulator books. | [config/index.ts:284-295](BE/src/config/index.ts#L284-L295), [plan.ts:261](BE/src/services/recommender/plan.ts#L261) |

## 2. Today, live (paper, 2026-09-18)

| Book | Regime | Open lot | Breakeven | Target (+4%) | Price now | Note |
|---|---|---|---|---|---|---|
| **SYRMA** | up (EMA20 +5.5% over EMA50) | none | — | — | ₹1,728.9 | **Sold yesterday** at ₹1,634.4 (10 sh, +₹637). Today's high was ₹1,762.6. |
| ETERNAL | up | ₹321.60 ×58 | ₹322.87 | ₹335.80 | ₹326.85 | −2.7% short of target |
| OIL | up | ₹485.60 ×34 | ₹487.39 | ₹506.90 | ₹475.70 | under breakeven |
| SEAMECLTD | up | ₹1,721.50 ×12 | ₹1,727.53 | ₹1,796.70 | ₹1,726.30 | at breakeven |

SYRMA is the case behind your question. A ride rule (3% trail from the high) would still hold it: high ₹1,762.6 minus 3% is ₹1,709.7, and the price is ₹1,728.9. It would show about **₹945 more on paper** than the ₹637 booked. That is one day of one stock, and the 5-year test below shows it doesn't average out that way. SYRMA's ₹73,000 is now idle until price reaches the start gate (≈ ₹1,709.7, 3% under the 45-day high).

## 3. What was measured

This was a scratch simulation, no project files changed. Entries, costs, breakeven and the no-loss check (`sellLot`) are the **real engine**; only the rule being tested was swapped.
- 5 years of Yahoo daily bars, 3 rungs, ₹2L per universe, limit fills.
- Pessimistic intrabar model: a bar's high comes before its close, and a gap through a stop fills at the open.
- Three universes: **your 8 enabled books**, **12 large caps**, **12 mid-cap/PSU names**.
- Each run on the full 5 years and on each half separately.

### 3a. Exit side: ride instead of selling at +4%

CAGR over the full 5 years (CAGR/maxDD in brackets):

| Rule | Your books | Large caps | Mid/PSU |
|---|---|---|---|
| **Shipped** (fixed +4%, gap-only ratchet) | **7.41%** (0.38) | **2.54%** (0.25) | **6.83%** (0.50) |
| Arm at +4%, trail 3%, floor = target | 7.89% (0.39) | 2.44% (0.23) | 6.35% (0.50) |
| Arm at +4%, trail 5%, floor = target | 6.95% (0.34) | 2.28% (0.21) | 6.09% (0.47) |
| Arm at +4%, trail 8%, floor = target | 6.04% (0.29) | 2.45% (0.22) | 6.20% (0.48) |
| Trail 5%, floor lowered to +2% | 5.44% (0.23) | 1.49% (0.13) | 5.03% (0.37) |
| Trail 3%, only when regime = up | 7.80% (0.39) | 2.44% (0.24) | 6.47% (0.52) |

### 3b. Entry side: buy back sooner when the regime is up

| Rule | Your books | Large caps | Mid/PSU |
|---|---|---|---|
| **Shipped** (3% dip gate always) | **7.41%** | **2.54%** | **6.83%** |
| Up regime: 1.5% gate | 7.29% | 2.85% | 6.86% |
| Up regime: no gate | 7.33% | 2.81% | 6.88% |
| Up regime: no gate + trail 3% | 7.35% | 2.43% | 6.24% |

On large caps, the worst open lot went from −49% to −53% and the longest hold stayed above 1,000 days.

## 4. What the numbers say

- **No trend-riding variant wins in all three universes.** The best exit rule (trail 3%) gains +0.48 points on your books, and loses 0.10 on large caps and 0.48 on mid/PSU. The half-by-half runs flip sign too. These are single runs, and differences under ~0.5 points are noise.
- **Wider trails are clearly worse**, and lowering the floor below the target is the worst rule tested. Lots give back more than they gain, and trades drop by 10–25%.
- **Why riding doesn't pay here:** the engine's return comes from turnover. Sell at +4%, re-anchor on a dip, repeat. A lot that rides keeps its capital busy but earns nothing on the pullback it waits through. When it gaps below the target it gets stuck ("gapStuck": 3–22 lots per run), and under the no-loss rule a stuck lot can only wait.
- **Buying sooner in uptrends is also flat.** This agrees with the earlier finding that the dip gate is roughly neutral, and it costs a deeper worst lot.
- The earlier measurement still holds: the biggest lever is **idle cash** (25–40% of capital at work), not how each winning lot exits.

## 5. Can we implement it? Yes. Should it be the default? No.

It is cheap to build. The pieces (`armed`, `hwm`, `lotTrailStop`, and the no-loss floor) already exist. Options:

- [ ] **A. Leave trading behaviour as is.** Recommended on this evidence.
- [ ] **B. Add a per-book "Ride" switch, off by default.** Arm at the target instead of at +8%, trail 3%, floor = target. About 30 lines in `engine.ts` plus a book field, a route, and a switch in `StockModeTable`. It stays safe under no-loss, but it's measured as neutral to slightly negative, so it's your call per stock.
- [ ] **C. Fix paper fills (checklist item 7). Worth doing regardless.** A marketable sell should fill at `max(limit, LTP)` in `PaperBroker`, so paper P&L stops understating gap-up exits. This changes no trading decision, only paper accounting.
- [ ] **D. Show the target and ratchet state on the ladder rows**, e.g. "sells at ₹335.80 · ratchet arms at ₹348.70". Then "why did it sell at +4% when it kept going" is answered on screen.

If B is built, the minimum test set:
- [ ] Extend `trail.test.ts`'s 400 random paths so no closed lot is below breakeven in ride mode.
- [ ] An armed lot never sells below its target.
- [ ] A gap through the target means HOLD, then sell at the target.
- [ ] Switch off means byte-identical decisions to today.
- [ ] Run `npm run sim` with the ride variant added, so the number stays reproducible in the repo.
- [ ] `tsc --noEmit` + full `npm test`.

**Caveats:** daily bars only; today's surviving names (survivorship bias); one 5-year window.
