# Market data: real prices, real charts

`DATA_SOURCE=yahoo` is now the default. Every price on the platform — the
watchlist, the WebSocket ticks, the paper broker's fills, the accumulator's
marks, and every chart — comes from Yahoo's chart endpoint, polled. The
simulator (`DATA_SOURCE=sim`) still exists for offline development, and every
chart it feeds is labelled **SYNTHETIC** in red so it can never be mistaken for
a real one.

```
npm test               # 157 unit tests, incl. the feed parser and tracked-set logic
npm run verify:feed    # 9 runtime checks against the running server
```

## How prices flow now

```
Yahoo /v8/finance/chart ──poll──▶ YahooFeed ──ingestTick──▶ MarketDataService
                                                                 │
              ┌──────────────────────────────────────────────────┼──────────────┐
              ▼                          ▼                       ▼              ▼
     WebSocket 'tick'            StrategyEngine            PaperBroker     AccumulatorEngine
   (watchlist, charts)          (signals on close)       (fills at LTP)   (ladder decisions)
```

- **Tracked set**, recomputed every pass: watchlist seeds ∪ every accumulator
  book ∪ every enabled strategy's symbols. Switch a company on and it is polled
  from the next pass, no restart.
- **Cadence**: 15 s while the market is open, 5 min when closed (prices do not
  move on a closed market; polling a repeated close is how you get rate-limited
  before Monday's open).
- **Boot** awaits the first pass (bounded at 12 s) so the API never serves the
  seeded placeholders. A symbol Yahoo cannot price is marked **₹0** — "no data" —
  rather than left on a fake seed that would look exactly like a real print.
- **Indices** map to Yahoo's own codes: `NIFTY → ^NSEI`, `BANKNIFTY → ^NSEBANK`,
  `SENSEX → ^BSESN`. Stocks and ETFs are `<SYMBOL>.NS`.

## Charts

TradingView **Lightweight Charts v5** (the canvas engine behind TradingView's
own charts; Apache-2.0). Candlesticks with a volume pane, range tabs
(1D/5D/1M/6M/1Y), IST time axis, and horizontal price lines.

- `/api/market/candles/:symbol?range=&interval=` serves real OHLC. History is
  refreshed every minute; between refreshes the live tick is painted into the
  last bar, so the chart moves with the price.
- The accumulator page draws what the engine is watching for on the price
  itself: **blue dotted** unfilled ladder rungs (a buy fires on a cross), **amber
  dashed** each open lot's fee-inclusive breakeven (it can never be sold below
  this), **green** the resting sell target.
- The caption names the source on every chart. `source sim` is rendered with a
  red SYNTHETIC banner.

## Runtime checklist (`npm run verify:feed`) — last run 9/9

| # | Check | Evidence from the last run |
|---|---|---|
| F1 | Data source is yahoo, not the simulator | `source=yahoo running passes=4 market=open` |
| F2 | Every tracked symbol has a real price (none left on a seed) | `12/12 priced` |
| F3 | Platform quotes match Yahoo directly (≤ 1%) | RELIANCE, TCS, INFY all **0.000%** apart |
| F4 | Index symbols resolve through their Yahoo codes | `NIFTY ₹23659.9 via ^NSEI` |
| F5 | Prices are not random-walking | `0/12 symbols changed in 3s` — the simulator moves all of them every second |
| F6 | Intraday candles come from Yahoo and are well-formed | `224 × 1m bars, latest 0.0h ago`, ordered, OHLC-consistent |
| F7 | Daily candles cover months of real history | `128 daily bars spanning 183 days` |
| F8 | A symbol nothing seeded (SYRMA) is priced live | `₹1645 (0.000% from Yahoo)` |
| F9 | WebSocket ticks carry Yahoo prices | `tick BANKNIFTY ₹56818.25` |

## Browser check (headless Chrome, authenticated)

- **Live Trading**: an intraday NIFTY candlestick, 09:15–12:59 IST, caption
  `225 bars · 1m · source yahoo`. Watchlist at real prices — RELIANCE ₹1,292.90
  where the simulator used to show ₹2,950. Chart confirmed *updating*: 222 → 225
  bars and the last-bar time advancing across successive screenshots.
- **Accumulator**: a 3-month daily RELIANCE candlestick (67 bars, source yahoo)
  per book, with the rung/breakeven/target legend; correctly reports no rungs
  while no epoch is open.

Two things the browser found that the API could not:

1. A stray green **₹0.00** axis label on the live chart — the volume overlay's
   last-value marker, meaningless on an index. Fixed (`lastValueVisible: false`).
2. **TATAMOTORS at ₹0.** Not a feed bug: the symbol no longer exists. After the
   Oct 2025 demerger NSE lists **TMPV** (passenger vehicles, the original 1998
   listing) and **TMCV** (Tata Motors Ltd, commercial vehicles, listed
   2025-11-12); Yahoo resolves both and 404s the old code. The seeded watchlist
   carried the stale symbol; it now seeds TMPV and TMCV, and the first pass
   prices 12/12.

## Still true

- Yahoo is **unofficial** — no SLA, may rate-limit or change shape. It is the
  research and paper feed. For real execution, `DATA_SOURCE=zerodha` streams
  from Kite and takes precedence for candles when connected.
- Paper only. Nothing here places a real order.
