/**
 * The one pre-trade gate every order passes, from every caller: the manual
 * ticket, the strategy engine, the accumulator, a standing trigger.
 *
 * It answers "can this order be sent to the exchange right now?", not "is this
 * a good trade?" — that is the risk manager's job, and the risk manager only
 * gates entries. This gate applies to exits too, because none of these
 * conditions is one where an exit would fare better than an entry: the
 * exchange is closed, the instrument does not exist, the feed is dead, the
 * process is halted.
 *
 * Every check here was a real hole. The paper broker filled a MARKET order at
 * 17:14 IST on a closed exchange; it sold one unit of the NIFTY index in the
 * cash segment; it accepted a LIMIT order with no price and filled it at the
 * last print; and a strategy that decided at ₹1,050 was filled at ₹1,388.
 *
 * Pure apart from reading the market-data cache and the instrument master.
 * Takes an explicit clock so the tests can put the market wherever they like.
 */
import { config } from '../config';
import { store } from '../store/memoryStore';
import { OrderRequest } from '../types';
import { orderRateLimiter, tradingHalt } from './guards';
import { getInstrument } from './instruments';
import { marketData } from './MarketDataService';
import { isFnoEligible, withinPriceBand } from './nse';
import { canPlaceMarketOrder, orderEntryBlocked, phaseAt } from './session';

export interface GateVerdict {
  ok: boolean;
  /** machine-readable, for the audit trail and the ticket's copy */
  code?:
    | 'halted'
    | 'not_tradable'
    | 'limit_needs_price'
    | 'market_closed'
    | 'entry_blocked'
    | 'market_frozen'
    | 'no_quote'
    | 'stale_quote'
    | 'reference_deviation'
    | 'price_band'
    | 'rate_limit'
    | 'symbol_reserved';
  reason?: string;
}

/** Index and derivative underlyings that cannot be bought in the cash segment. */
const INDICES = new Set([
  'NIFTY', 'NIFTY50', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX', 'BANKEX',
  'INDIAVIX', 'NIFTYIT', 'NIFTYAUTO', 'NIFTYPHARMA', 'NIFTYFMCG', 'NIFTYMETAL',
]);

/** Series NSE settles on a normal rolling basis (EQ) or trade-for-trade (BE/BZ). Everything else is not for this app. */
const TRADABLE_SERIES = new Set(['EQ', 'BE', 'BZ']);

/**
 * Is this something the cash segment will let us trade?
 *
 * With the NSE master loaded the answer is authoritative. Without it (a boot
 * with NSE unreachable and an empty cache) the best we can do is refuse the
 * things that are certainly not stocks.
 */
export function tradability(symbol: string, product: OrderRequest['product']): GateVerdict {
  const sym = symbol.toUpperCase();
  if (INDICES.has(sym)) {
    return { ok: false, code: 'not_tradable', reason: `${sym} is an index; it cannot be bought or sold in the cash segment` };
  }
  if (store.instruments.size === 0) return { ok: true };
  const row = getInstrument(sym);
  if (!row) return { ok: false, code: 'not_tradable', reason: `${sym} is not in the NSE listed-company master` };
  if (!TRADABLE_SERIES.has(row.series)) {
    return { ok: false, code: 'not_tradable', reason: `${sym} is series ${row.series}; only EQ, BE and BZ series trade as equity` };
  }
  if ((row.series === 'BE' || row.series === 'BZ') && product === 'MIS') {
    return { ok: false, code: 'not_tradable', reason: `${sym} is trade-for-trade (series ${row.series}): delivery only, no intraday` };
  }
  return { ok: true };
}

export function preTradeGate(req: OrderRequest, now: number = Date.now()): GateVerdict {
  const sym = req.symbol.toUpperCase();

  // 0. The process has declared itself untrustworthy.
  if (tradingHalt.active) {
    return { ok: false, code: 'halted', reason: `trading halted — ${tradingHalt.describe()}` };
  }

  // 1. Is it a stock?
  const tradable = tradability(sym, req.product);
  if (!tradable.ok) return tradable;

  // 2. A LIMIT order is a price. Without one it is a MARKET order wearing a label.
  if (req.orderType === 'LIMIT' && !(req.price != null && req.price > 0)) {
    return { ok: false, code: 'limit_needs_price', reason: 'a LIMIT order needs a limit price' };
  }

  // 3. The session. After-market orders are queued by the broker for the
  //    pre-open; this app does not queue them yet, so say so rather than fill.
  if (config.session.enabled) {
    const phase = phaseAt(now);
    if (phase !== 'open') {
      return {
        ok: false,
        code: 'market_closed',
        reason: req.amo
          ? `market ${phase}: after-market orders are not supported yet — place it from 09:15`
          : `market ${phase}: the exchange is not in continuous trading (09:15–15:30 IST on a trading day)`,
      };
    }
    if (req.intent !== 'exit') {
      const entry = orderEntryBlocked(now, sym);
      if (!entry.ok) return { ok: false, code: 'entry_blocked', reason: entry.reason };
    }
    if (req.orderType === 'MARKET') {
      const mkt = canPlaceMarketOrder(now, sym);
      if (!mkt.ok) return { ok: false, code: 'market_frozen', reason: mkt.reason };
    }
  }

  // 3.5 One symbol, one engine. THE ACCUMULATOR WINS.
  //
  // This app runs two independent trading engines over one broker account, and
  // until this check existed neither knew the other was there. The accumulator
  // buys CNC and never sells at a loss; the strategy engine trades MIS and may
  // go short. Point both at one symbol and they are transacting against each
  // other through the same account — the strategy's short competes for the cash
  // the accumulator reserved for its next rung, and on a live account whichever
  // order arrives second is rejected for margin.
  //
  // It was not hypothetical. Books existed for RELIANCE and TCS while the
  // seeded MA Crossover strategy was short both. Nothing separated them except
  // the allocator's trend filter refusing to anchor in a downtrend — and the
  // allocator can enable a book on its own, so one EMA crossover was all it
  // would have taken.
  //
  // The accumulator is the system of record here and keeps running: it holds
  // real delivery positions with per-lot cost bases that a competing order can
  // corrupt, so the strategy is the one that yields.
  //
  // THREE THINGS THIS DELIBERATELY DOES NOT DO:
  //   - it never blocks an EXIT. A strategy already short when a book is
  //     switched on must always be able to close; trapping a position is far
  //     worse than the overlap it was meant to prevent.
  //   - it never blocks the accumulator, the manual ticket or a trigger. Only
  //     orders carrying a `strategyId` are strategy-originated.
  //   - it does not disable the strategy. It refuses the entries that clash and
  //     says why, leaving every other symbol it trades working.
  if (req.strategyId && req.intent !== 'exit' && req.userId) {
    const book = store.accumulatorBook(req.userId, sym);
    if (book?.enabled) {
      return {
        ok: false,
        code: 'symbol_reserved',
        reason:
          `${sym} is held by the accumulator (no-loss mode is on for it), which owns its ` +
          `positions and cash. Strategy entries on it are refused so the two engines cannot ` +
          `trade against each other; exits are still allowed. Switch no-loss mode off for ` +
          `${sym}, or remove it from this strategy.`,
      };
    }
  }

  // 4. A price, and a recent one. A seeded placeholder is ₹0 and a dead feed
  //    leaves the last print standing forever; both fill at a price nobody saw.
  const ltp = marketData.getPrice(sym);
  if (!(ltp > 0)) return { ok: false, code: 'no_quote', reason: `no market data for ${sym}` };
  // Staleness is judged only once a feed is live (something has ticked) and
  // only on the real clock: tick ages are wall-clock, so a simulation driving
  // the engine with its own timestamps (the accumulator simulator, the tests)
  // has nothing to be stale relative to. A process with seeded prices and no
  // feed at all has nothing either.
  const onRealClock = Math.abs(now - Date.now()) < 5 * 60_000;
  if (config.dataSource !== 'sim' && config.guards.maxQuoteAgeMs > 0 && marketData.hasTicked() && onRealClock) {
    const age = marketData.quoteAge(sym, now);
    if (!Number.isFinite(age)) {
      return { ok: false, code: 'stale_quote', reason: `${sym} has not ticked since boot — the feed has not priced it yet` };
    }
    if (age > config.guards.maxQuoteAgeMs) {
      return {
        ok: false,
        code: 'stale_quote',
        reason: `${sym} last ticked ${Math.round(age / 1000)}s ago (limit ${Math.round(config.guards.maxQuoteAgeMs / 1000)}s) — refusing to trade a stale price`,
      };
    }
  }

  // 5. The decision price and the live price must be the same trade.
  if (req.referencePrice != null && req.referencePrice > 0 && config.guards.maxFillDeviationPct > 0) {
    const devPct = (Math.abs(ltp - req.referencePrice) / req.referencePrice) * 100;
    if (devPct > config.guards.maxFillDeviationPct) {
      return {
        ok: false,
        code: 'reference_deviation',
        reason: `live price ₹${ltp.toFixed(2)} is ${devPct.toFixed(1)}% from the decision price ₹${req.referencePrice.toFixed(2)} (limit ${config.guards.maxFillDeviationPct}%)`,
      };
    }
  }

  // 6. Inside the day's price band. A print outside it is a bad tick or a
  //    circuit-locked stock; either way the exchange will not fill there.
  const ref = marketData.getReference(sym);
  if (ref > 0 && !withinPriceBand(ltp, ref, isFnoEligible(sym))) {
    return {
      ok: false,
      code: 'price_band',
      reason: `₹${ltp.toFixed(2)} is outside the daily price band around the previous close ₹${ref.toFixed(2)} — bad tick or circuit`,
    };
  }

  // 7. Order-rate limits (SEBI 10/s; broker per-minute and per-day).
  const rate = orderRateLimiter.check(now);
  if (!rate.ok) return { ok: false, code: 'rate_limit', reason: rate.reason };

  return { ok: true };
}
