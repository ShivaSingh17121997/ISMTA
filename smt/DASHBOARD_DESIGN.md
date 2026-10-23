# Dashboard redesign — design rationale and verification checklist

**Date:** 2026-09-16 · **Scope:** `/dashboard` · **Status:** built, verified in a real browser in both themes at three widths.

---

## 1. What was wrong with the old dashboard

Not a styling problem. Three structural ones:

| # | Problem | Consequence |
|---|---|---|
| 1 | **No hierarchy.** Four identically-sized stat cards — equity, banked, unrealised, deployed. | The reader has to decide what matters before they can read anything. The layout did no triage. |
| 2 | **Levels with no trend.** Every figure was a point in time. | "₹1,96,778" is unreadable without knowing where it came from. No chart anywhere on the page. |
| 3 | **No attention layer.** A process halt, a stalled price feed, a breached loss limit and a lot 20% underwater were all discoverable — on `/system` and `/risk`. | The screen whose job is *"should I do something?"* refused to answer it. |

Smaller ones: `—` rendered while loading (reads as zero, or as broken, beside a P&L number); the strategy-engine section sat under a bare `<h2>` that looked like a paragraph, implying its numbers belonged to the totals above; the funds panel spent full width on four small figures.

## 2. Design principles applied

1. **One hero.** Equity, at 4xl, with the curve and a signed change. Everything else is deliberately smaller. The 2:1 grid split makes the hierarchy literal.
2. **Banked profit ranks second**, not fourth — it is the accumulator's actual promise (every closed lot sold above its fee-inclusive cost), so it gets its own tile beside the hero.
3. **Triage before numbers.** The attention strip sits above the hero and is **silent when nothing is wrong** — a strip that always shows something trains the eye to skip it.
4. **Composition, not enumeration.** Deployed / settled / unsettled are parts of one pool, so they are one stacked bar, not three numbers the reader must divide in their head.
5. **Colour is never the message.** Direction carries a ▲/▼ glyph and a signed number; severity carries an icon *and* a word.
6. **Skeletons, never em-dashes.** A pulsing block cannot be mistaken for a value.
7. **Reading order is the decision order:** what am I worth → does anything need me → where is the money → the working table → history → the other engine.

## 3. Chart and colour decisions

Colour was chosen last and **validated by script**, not by eye (`dataviz/scripts/validate_palette.js`).

**Equity sparkline** — one series, so no legend (the heading names it); 2px stroke; fading area fill; crosshair + tooltip snapped to the nearest real observation rather than an interpolation; 2px surface ring on the hover marker; end-cap dot. Hand-rolled SVG measured in real pixels via `ResizeObserver` — a scaled `viewBox` with `preserveAspectRatio="none"` stretches the stroke to different weights horizontally and vertically, which is how sparklines end up subtly wrong.

**Capital bar** — three categorical slots in fixed order, 2px surface gap between segments, every value direct-labelled in the legend so nothing is hover-only.

| Slot | Light | Dark | Why |
|---|---|---|---|
| 1 Deployed | `#2a78d6` | `#3987e5` | existing app slot-1 |
| 2 Settled cash | `#eb6834` | `#d95926` | existing app slot-2 |
| 3 Unsettled | `#8b5cf6` | `#8b5cf6` | **chosen by validator** |

Slot 3 was picked against two rejected candidates:

- `#7a8794` (gray) — **FAILED the chroma floor** (0.025): reads as "no data" rather than as a category.
- `#0d9488` (teal) — passed, but worst-case CVD separation was ΔE 10.7 under protanopia.
- `#8b5cf6` (violet) — **ΔE 24.7 protan / 25.9 tritan**, the widest of the three. Selected.

Dark mode is **selected, not flipped**: each set was re-validated against its own surface. A lighter violet (`#a78bfa`) failed the dark lightness band, so the same hue was kept — it passed on both surfaces independently.

Status colours (emerald/rose) stay reserved for P&L and severity, and are never reused as a series colour.

## 4. Verification checklist

Automated in `scratchpad/shoot.js` — Playwright driving real Chrome against the running app, logged in as the seeded demo trader, **6 configurations** (light/dark × 1600px/1280px/390px) × 9 assertions = **54 checks**.

### Automated — all pass

- [x] Hero "Total equity" renders in every configuration
- [x] Banked-profit tile renders
- [x] Engine-capital card renders
- [x] **No unformatted float anywhere on screen** (regex `\d+\.\d{4,}`)
- [x] "Banked profit" appears **exactly once** — no duplicate figure to cross-check
- [x] **No horizontal overflow** at any width (`scrollWidth <= innerWidth`)
- [x] **Every control has an accessible name** (button / link / `role="switch"`)
- [x] Sparkline carries `role="img"` + `aria-label`
- [x] Attention region present
- [x] **Zero console errors or warnings** (401s on the pre-login probe excluded)
- [x] `tsc --noEmit` clean, both projects
- [x] `next build` succeeds, 16 routes

### Manual — checked against the screenshots

- [x] Hierarchy reads at a glance: one number dominates
- [x] Light and dark both legible; bar segments distinguishable in both
- [x] Mobile stacks cleanly, nothing clipped or overlapping
- [x] Direction is not colour-alone (▲/▼ glyph + signed number present)
- [x] Severity is not colour-alone (icon + word "Critical"/"Warning"/"Note")
- [x] Attention strip is silent when nothing is wrong ("Nothing needs attention" — one quiet line)
- [x] Win rate never shown without its explanatory label
- [x] Two P&L systems visually separated by a drawn rule, not an implied one
- [x] No dead whitespace in the capital card
- [x] Loading shows skeletons, not `—`

### Bugs found by looking at the render

The validator checks colour, not layout. Three defects survived typecheck, build and every automated assertion, and were caught only by opening the screenshot:

1. **`OLDEST LOT 7.081434606481482d`** — the engine returns `oldestOpenLotDays` as a raw fraction (`oldest / 86_400_000`) and every display site rounds it. The new KPI tile did not. *Fixed, and the automated suite now has a float regex so it cannot come back.*
2. **Dead whitespace** in the Engine-capital card — it stretched to match the Funds card and the content sat at the top. *Fixed with information rather than padding: a total + "% working" header and a ladder-ceiling footer.*
3. **Duplicated figures** — the stock table's own strip repeated "Banked profit" and "Unrealised" from the KPI row directly above it. *Fixed with a `summary="modes"` prop; `/accumulator`, which has nothing above the table, keeps the full strip by default.*

A fourth was caught on the second pass: with no reserve configured, the ceiling equals the pool, so *"the ladder may hold up to ₹1,97,886"* restated the number directly above it. The copy is now adaptive.

## 5. Files

| File | Change |
|---|---|
| `app/dashboard/page.tsx` | Rewritten — layout, triage derivation, KPI row |
| `app/components/dashboard/Sparkline.tsx` | **New** — hero equity curve |
| `app/components/dashboard/EquityHero.tsx` | **New** — hero + banked tile |
| `app/components/dashboard/AttentionStrip.tsx` | **New** — triage layer |
| `app/components/dashboard/CapitalBar.tsx` | **New** — stacked allocation |
| `app/components/dashboard/primitives.tsx` | **New** — `Skeleton`, `KpiTile`, `KpiRow`, `SectionHeading` |
| `app/lib/chartPalette.ts` | **New** — palette extracted from `NavChart` so a page can read a colour without pulling Recharts into its bundle; `cat1/cat2/cat3` added |
| `app/lib/format.ts` | `dayLabel` moved here, same reason |
| `app/components/NavChart.tsx` | Re-exports both, so every existing import still resolves |
| `app/components/StockModeTable.tsx` | `summary?: 'full' \| 'modes'`, default `'full'` |
| `app/components/FundsPanel.tsx` | 4-col → 2-col grid; it now lives in a half-width cell |

## 6. Deliberately not done

- **No animated number transitions.** Standard on consumer fintech dashboards and wrong here: a figure that rolls while you read it invites a misread, and these numbers drive orders.
- **No sparkline y-axis.** It is a glance view; `/analytics` has the full charted version with axes and the NIFTY benchmark.
- **Funds panel not merged into the capital bar.** They answer different questions — what the *engine* has committed vs what the *broker* actually holds — and they must never be added together. Side by side, separately titled.
- **No new colour system.** The app already had a validated palette; this extends it by one validated slot rather than replacing it.
