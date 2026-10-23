# ISMTA operations guide

How the safety layer works, what it refuses and why, and what has to be true
before `BROKER` is anything but `paper`. Written after the 10 Sep 2026 audit;
every control below closes a hole that was reproduced then.

## The order path

Every order, from every caller (the ticket, the strategy engine, the
accumulator, a standing trigger), goes through the **pre-trade gate**. Orders
that go through `OrderManager` — the ticket, the strategy engine, triggers —
then pass a second **risk gate**. The accumulator does **not**: it calls the
broker directly and enforces its own limits instead (see below).

1. **Pre-trade gate** (`BE/src/services/orderGate.ts`). Refuses when:
   - the process is **halted** (see below);
   - the symbol is an **index** or not in the NSE master, or is trade-for-trade
     (series BE/BZ) with an intraday product;
   - a **LIMIT** order has no price;
   - the exchange is not in **continuous trading** (09:15–15:30 IST on a
     trading day), or the closing auction blocks entry (F&O names, 15:15–15:20)
     or freezes market orders (15:25–15:30);
   - the symbol has **no quote**, or its last tick is older than
     `MAX_QUOTE_AGE_MS` (default 90 s) while the feed is live;
   - the live quote is more than `MAX_FILL_DEVIATION_PCT` (default 2 %) from
     the **price the decision was made at** (`referencePrice`);
   - the print is outside the day's **price band** around the previous close;
   - the **order rate** would exceed 10/s, 400/min or 5,000/day;
   - a **strategy** entry targets a symbol an enabled **accumulator book** owns
     (`symbol_reserved`) — see "One symbol, one engine" below.
   Exits are refused too: none of these conditions is one where an exit would
   fare better, and a live broker rejects them anyway. The one exception is
   `symbol_reserved`, which applies to entries only — a strategy already in a
   position must always be able to close it.
2. **Risk gate** (`BE/src/services/RiskManager.ts`). **`OrderManager` callers
   only** — the ticket, the strategy engine, triggers. Entries only; exits are
   never risk-gated. Kill switch, daily-loss limit, consecutive-loss breaker,
   cooldown, position count, position-value cap (which may **trim** the
   quantity; the trimmed order carries `requestedQuantity` and an
   `adjustment` sentence).

   **The accumulator does not pass this gate**, by design, and this section
   used to claim otherwise. Its controls do not fit: it cannot book a loss, so
   the daily-loss limit and the consecutive-loss breaker are inert, and
   `RISK_MAX_POSITIONS` (default 5) would block a user running nineteen books.
   It enforces its own instead — the per-lot fee-inclusive breakeven floor, the
   per-book budget and deployment ceiling, the reserve, the buy brake and a
   per-book kill switch — and it reserves cash through `FundsService`, which
   `OrderManager` does not.

A refused order is written to the audit trail with its reason and code. A
placed order records `submittedAt`, `ackAt`, `referencePrice`, `slippageBps`
and `clientOrderId`; the same client id for the same user is answered with the
original order, never placed twice.

Stops and targets on strategy trades are computed from the **fill**, using the
signal's percentage distances, never from the bar the signal saw.

## One symbol, one engine

Two independent engines trade one broker account:

| | Accumulator | Strategy engine |
|---|---|---|
| Product | **CNC** (delivery) | **MIS** (intraday) |
| Direction | long only | long or short |
| Exit rule | never below a lot's fee-inclusive cost | stop/target, flattened 15:10 |
| Order path | broker **directly** | `OrderManager` |
| Risk gate | its own controls | `RiskManager` |
| Cash | reserves via `FundsService` | does not reserve |

Point both at one symbol and they transact against each other through the same
account: the strategy's short competes for the cash the accumulator reserved
for its next rung, and on a live account whichever order arrives second is
rejected for margin. Worse, the accumulator's guarantee is arithmetic over lots
whose cost basis it believes it knows.

**The accumulator wins.** It is the system of record — it holds real delivery
positions with per-lot cost bases a competing order can corrupt — so a strategy
**entry** on a symbol with an *enabled* accumulator book is refused with
`symbol_reserved`. Exits are never refused: trapping an open position is worse
than the overlap. The manual ticket, triggers and the accumulator itself are
unaffected; only orders carrying a `strategyId` are strategy-originated.

This was not hypothetical. The demo seed created three strategies **enabled**
with `direction: 'both'`, so a fresh install opened intraday shorts in RELIANCE
and TCS within a minute of first boot — while accumulator books existed for the
same two names. Only the allocator's trend filter ("downtrend — refusing to
anchor") kept them apart, and the allocator can enable a book on its own.

The seed now creates every strategy **disabled**. Nothing trades until you
switch it on. The accumulator is not seeded and is unaffected — its books are
created when you switch a stock on, and they keep running as before.

To trade a symbol with a strategy, switch no-loss mode **off** for it first, or
remove it from the strategy's symbol list.

## Halts

`tradingHalt` (`BE/src/services/guards.ts`) is process-wide and blocks
everything, exits included. It is set by:

| key | set when | cleared when |
|---|---|---|
| `static-ip` | live broker, `BROKER_STATIC_IP` set, and the public IP differs | the IP matches again (checked at boot and every 10 min) |
| `feed` | no tick on any symbol for 3 × `MAX_QUOTE_AGE_MS` during the session | ticks resume |
| `reconcile-unreachable` | broker holdings unreadable three times in a row | a pass succeeds |
| `manual` | `POST /api/system/halt {engaged:true}` | `{engaged:false}` |

The per-user **kill switch** (`POST /api/risk/kill`) is different: it stops new
entries and leaves exits alone. Use it to stop trading; use the halt when the
system itself cannot be trusted.

## Reconciliation

With a live broker, `ReconcileService` compares the broker's holdings against
every book's open lots every `RECONCILE_EVERY_MIN` minutes (and at boot). A
mismatch halts the affected book (`haltedReason`), sends an alert and writes an
audit row. Nothing is corrected automatically: release the halt with
`POST /api/accumulator/:symbol/release-halt` once you know why.

## Alerts

Telegram, via `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Sent for: accumulator
fills, halts and rejections; trigger fires and failures; reconciliation
mismatches; a dead feed; the daily summary at 15:45 IST. Repeats within five
minutes are folded into one message. Unset, alerts are logged only.
`POST /api/system/test-alert` sends a test message.

## Audit trail

`auditlog` is append-only: order requests, gate and risk verdicts, fills,
rejections, accumulator decisions, trigger events, logins, halts, boots.
`GET /api/audit?kind=&symbol=&since=&limit=` and `GET /api/audit/export.csv`.
Writes to every collection are ordered per key, and the process waits up to
4 s for queued writes on shutdown.

## Standing triggers

`POST /api/triggers` creates a GTT (single leg), an OCO pair (target + stop) or
a trailing stop, watched by the feed loop. Nothing is sent to the broker until
a level is crossed, so no funds are blocked. A trigger created for a position
cancels itself when that position is flat (`autoCancelWhenFlat`, default on).
When one print satisfies both legs, the stop fires.

## Backtests

`POST /api/backtest` uses **real Yahoo history** (daily 5 y, hourly 2 y,
15-/5-minute 60 d, 1-minute 7 d) and labels every result with its `source`.
Every run is recorded in the trial ledger; the response carries the
**deflated Sharpe** against every earlier run of the same strategy on the same
symbol, and the minimum backtest length that many trials require. A Sharpe
that does not clear its benchmark is what that many tries produce by chance.
`DATA_SOURCE=sim` is the only way to get a synthetic series, and it says so.

## Going live: the checklist

Each user connects their own Zerodha account in **Settings → Zerodha (Kite
Connect)** and switches that account to live there. `BROKER` in `BE/.env`
stays `paper`: any other value routes every user's orders to one account, and
the live switch refuses it. The switch also lists, under "Before live
trading", everything below that it can check; it stays locked until that list
is empty.

1. `JWT_SECRET` and `BROKER_CREDENTIALS_KEY` set in `BE/.env`.
2. A Kite app (developers.kite.trade, Personal plan is enough) with redirect
   URL `http://127.0.0.1:4000/api/broker/zerodha/callback`; its API key and
   secret saved in Settings; **Connect Zerodha** pressed. Kite ends every
   session at 06:00 IST, so connect again each trading morning.
3. `BROKER_STATIC_IP` set to a **static** IP registered on the Kite app
   (mandatory since 1 Apr 2026; Kite allows one change a week). Restart the
   backend after setting it.
4. No paper positions left: press **Clear paper lots** under "Before live
   trading" (it closes simulated lots and simulated cash-sweep units on paper
   only, re-plans the allocator, and sends nothing to Zerodha), or wait for the
   paper lots to sell.
5. The account's password is not the published demo one, and two-factor is
   enrolled (Settings). The switch asks for both. The two-factor secret is
   encrypted with `BROKER_CREDENTIALS_KEY`: change that key and two-factor
   sign-in stops working (a clear error, not "wrong code"). To recover, stop
   the backend and run `npm run totp:reset -- <email>`, then enrol again.
6. Money in the Zerodha account, and DDPI (or eDIS) active in Zerodha Console,
   or CDSL refuses the bot's sells.
7. Telegram configured and `POST /api/system/test-alert` received on the phone.
8. **Test connection** in Settings shows the balance and holdings you expect.
9. Run the backend with `npm run build && npm run start:supervised`, never
   `npm run dev`. The dev runner restarts on every file save, which is exactly
   the crash-between-fill-and-save window the boot fill audit has to catch. The
   supervisor restarts the process after a crash (1s → 60s backoff); an
   uncaught exception flushes pending writes, alerts, and exits so it can. On a
   live account a fill that could not be saved to MongoDB halts its book.
10. Flip **Live trading** in Settings. Start with one hand-set amount on one
    stock and watch one buy and one sell in the Kite app before giving the bot
    more.

## Tests

`npm test` (in `BE`) runs every suite even after one fails, and points
`MONGO_URI` at `smt_trading_test`. It refuses to run against a database whose
name does not end in `_test`. Running a single suite directly with
`ts-node src/tests/<name>.test.ts` does NOT get that protection: set
`MONGO_URI=mongodb://127.0.0.1:27017/smt_trading_test` first, or the
persistence suite writes to the live `smt_trading`.

## Things to refresh on a schedule

- The NSE holiday list in `BE/src/services/session.ts` every January
  (or `NSE_HOLIDAYS=`).
- The cost constants in `BE/src/config/index.ts` when a broker or NSE circular
  changes them (last: NSE transaction charge 1 Mar 2026).
- The F&O symbol list in `BE/src/services/nse.ts` after each F&O review.
