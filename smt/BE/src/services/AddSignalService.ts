/**
 * Gathers what `addSignal` needs for every stock on two screens — the
 * accumulator's stock table and the recommendations page — and caches it.
 *
 * Everything here is a READ of state other services already keep: the market
 * verdict (MarketWeatherService), NSE surveillance and the results calendar
 * (marketEvents), ten years of bars and the news (the recommender's caches),
 * and the book itself. Nothing here places an order or changes a book; the
 * light is advice for the person adding money, and the engine never reads it.
 *
 * Its own route rather than a field on GET /api/accumulator, because that
 * route is polled every few seconds and a first read here can cost a ten-year
 * Yahoo fetch per stock.
 */
import { allocatorEngine } from './AllocatorEngine';
import { broker } from '../brokers';
import { getInstrument } from './instruments';
import { logger } from '../utils/logger';
import { marketEvents, upcoming } from './marketEvents';
import { marketWeather } from './MarketWeatherService';
import { recommenderEngine } from './RecommenderEngine';
import { surveillanceLabel } from './accumulator/events';
import { istParts } from './session';
import { store } from '../store/memoryStore';
import { LIGHT_ORDER, addSignal, type AddSignal, type MarketRead } from './addSignal/signal';
import type { AccumulatorBook } from './accumulator/types';
import type { Turbulence } from './recommender/turbulence';

const TTL_MS = 10 * 60_000;
const CONCURRENCY = 3;
/**
 * Smallest part worth buying on its own for a one-off purchase from the
 * ranking. The ladder's own minimum (`minTranche`, ₹16k) protects engine
 * rungs; a direct buy only has to stay clear of the flat DP charge, which is
 * ~0.4% of a ₹5k sale (₹1k pays 1.7%, ₹10k 0.26% — LADDER_VIEW.md).
 */
const REC_MIN_PART = 5_000;
/** How far ahead an announced results date is worth mentioning. */
const RESULTS_LOOKAHEAD_DAYS = 30;

export interface AddSignalsResponse {
  computedAt: number;
  /** The market-level read every stock shares, or null while it is still loading. */
  market: (MarketRead & { computedAt: number | null }) | null;
  /** Rupee basis: the capital the allocator plans against, and the per-stock cap. */
  capital: number;
  capPct: number;
  signals: Record<string, AddSignal>;
  /** Plain counts, for a one-line summary above the table. */
  counts: Record<AddSignal['light'], number>;
  /** Set on the recommendations kind when the ranking is days old. */
  staleNote?: string;
}

type Kind = 'books' | 'recommendations';

export class AddSignalService {
  private cache = new Map<string, { at: number; value: AddSignalsResponse }>();
  private inflight = new Map<string, Promise<AddSignalsResponse>>();

  async get(userId: string, kind: Kind, force = false, now = Date.now()): Promise<AddSignalsResponse> {
    const key = `${userId}:${kind}`;
    const hit = this.cache.get(key);
    if (!force && hit && now - hit.at < TTL_MS) return hit.value;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = (kind === 'books' ? this.forBooks(userId, now) : this.forRecommendations(userId, now))
      .then((value) => {
        this.cache.set(key, { at: now, value });
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** The market verdict, reduced to what a stock light needs. */
  market(): AddSignalsResponse['market'] {
    const snap = marketWeather.get();
    if (!snap) return null;
    const v = snap.verdict;
    return { action: v.action, steps: v.steps, title: v.title, reason: v.why[0], computedAt: snap.computedAt };
  }

  private basis(): { capital: number; capPct: number; minTranche: number; corePct: number } {
    const p = allocatorEngine.params();
    return { capital: p.totalCapital, capPct: p.maxWeightPct ?? 100, minTranche: p.minTranche, corePct: p.corePct ?? 0 };
  }

  /**
   * Room left under the per-stock cap, counted exactly as the allocator counts
   * it (lot cost + unsettled T+1). An index ETF is uncapped by design, so it
   * gets no rupee figure and the light speaks in percent only.
   */
  private room(book: AccumulatorBook | undefined, b: ReturnType<AddSignalService['basis']>) {
    if (book?.instrument === 'ETF') return { planned: 0, full: null };
    const held = book
      ? book.openLots.reduce((s, l) => s + l.quoteSpent, 0) + book.unsettled.reduce((s, c) => s + c.amount, 0)
      : 0;
    const cap = (b.capital * b.capPct) / 100;
    const planned = Math.max(0, cap - held);
    const full = held > 0 && planned < b.minTranche ? { heldPct: (held / b.capital) * 100, capPct: b.capPct } : null;
    return { planned: full ? 0 : planned, full };
  }

  private async resultsOn(symbol: string, now: number): Promise<string | null> {
    const events = await marketEvents.calendar(symbol, now);
    return upcoming(events, istParts(now).date, RESULTS_LOOKAHEAD_DAYS).find((e) => e.results)?.date ?? null;
  }

  private static price(symbol: string, fallback: number): number {
    const ltp = broker.getLtp(symbol);
    return ltp > 0 ? ltp : fallback;
  }

  private static bookFacts(book: AccumulatorBook | undefined) {
    if (!book) return { stopped: null, entryBlock: null };
    return {
      stopped: book.haltedReason ? ('halted' as const) : book.killSwitchEngaged ? ('kill' as const) : null,
      entryBlock: book.entryBlock ?? null,
    };
  }

  private static finish(signals: AddSignal[], market: AddSignalsResponse['market'], b: { capital: number; capPct: number }, now: number): AddSignalsResponse {
    const counts = { green: 0, yellow: 0, red: 0, grey: 0 };
    for (const s of signals) counts[s.light]++;
    signals.sort((x, y) => LIGHT_ORDER[x.light] - LIGHT_ORDER[y.light] || x.symbol.localeCompare(y.symbol));
    return {
      computedAt: now,
      market,
      capital: b.capital,
      capPct: b.capPct,
      signals: Object.fromEntries(signals.map((s) => [s.symbol, s])),
      counts,
    };
  }

  /** One light per accumulator book the user owns. */
  private async forBooks(userId: string, now: number): Promise<AddSignalsResponse> {
    const books = store.accumulatorBooksByUser(userId);
    const market = this.market();
    const b = this.basis();
    const out: AddSignal[] = [];
    const queue = [...books];
    const worker = async (): Promise<void> => {
      for (let book = queue.shift(); book; book = queue.shift()) {
        const sym = book.symbol.toUpperCase();
        try {
          const price = AddSignalService.price(sym, book.lastPrice ?? book.previousClose ?? 0);
          const [turbulence, newsVeto, resultsOn] = await Promise.all([
            recommenderEngine.turbulenceFor(sym, price > 0 ? price : undefined, now),
            // An index ETF has no company news to veto on.
            book.instrument === 'ETF' ? Promise.resolve(null) : recommenderEngine.newsVeto(sym, getInstrument(sym)?.name ?? sym, now),
            book.instrument === 'ETF' ? Promise.resolve(null) : this.resultsOn(sym, now),
          ]);
          const signal = addSignal({
              symbol: sym,
              price: price > 0 ? price : turbulence?.forecast.expectedDipFrom ?? 0,
              ...this.room(book, b),
              turbulence,
              market,
              surveillance: surveillanceLabel(marketEvents.surveillance(sym)),
              newsVeto,
              ...AddSignalService.bookFacts(book),
              resultsOn,
              minAmount: b.minTranche,
            });
          // Green on a switched-off book is advice the bot will not act on.
          if (!book.enabled && signal.light !== 'red') {
            signal.notes.unshift('No-loss mode is off for this stock, so the bot will not buy it for you. Switch it on, or buy it yourself.');
          }
          out.push(signal);
        } catch (e) {
          logger.warn(`add signal ${sym}: ${e instanceof Error ? e.message : e}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    return AddSignalService.finish(out, market, b, now);
  }

  /**
   * One light per recommended stock in the latest ranking. Uses the run's own
   * turbulence and news veto, so the light and the card can never disagree,
   * and adds what the run cannot know: today's market verdict, surveillance,
   * and whether the user already holds enough of the stock in a book.
   */
  private async forRecommendations(userId: string, now: number): Promise<AddSignalsResponse> {
    const run = recommenderEngine.lastRun(userId);
    const market = this.market();
    const b = this.basis();
    if (!run) return AddSignalService.finish([], market, b, now);

    // A stock can appear at two horizons; the funded row is the one that counts.
    const recs = new Map<string, (typeof run.buckets)[number]['recommendations'][number]>();
    for (const bucket of run.buckets) {
      for (const r of bucket.recommendations) {
        const seen = recs.get(r.symbol);
        if (!seen || (seen.duplicateOf !== null && r.duplicateOf === null)) recs.set(r.symbol, r);
      }
    }

    const out: AddSignal[] = [];
    const queue = [...recs.values()];
    const worker = async (): Promise<void> => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        try {
          const book = store.accumulatorBook(userId, r.symbol);
          // The card's own entry, so the light's share count matches the card
          // it sits on (DIVISLAB: ₹17,891 is 2 shares at the ₹8,945 pullback
          // entry, but 1 at the ₹8,996 last price).
          const price = r.plan.entry > 0 ? r.plan.entry : AddSignalService.price(r.symbol, r.metrics.lastClose);
          const room = this.room(book, b);
          // The ranking's own size, unless a book already holds part of it.
          const planned = room.full ? 0 : book ? Math.min(r.allocatedAmount, room.planned) : r.allocatedAmount;
          out.push(
            addSignal({
              symbol: r.symbol,
              price,
              planned,
              full: room.full,
              turbulence: r.turbulence as Turbulence | null,
              market,
              surveillance: surveillanceLabel(marketEvents.surveillance(r.symbol)),
              newsVeto: r.newsSuppressed ? (r.newsSuppressedReason ?? 'Recent news is strongly negative.') : null,
              ...AddSignalService.bookFacts(book),
              resultsOn: await this.resultsOn(r.symbol, now),
              minAmount: REC_MIN_PART,
            }),
          );
        } catch (e) {
          logger.warn(`add signal ${r.symbol}: ${e instanceof Error ? e.message : e}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    const res = AddSignalService.finish(out, market, b, now);
    const ageDays = Math.floor((now - run.at) / 86_400_000);
    if (ageDays >= 3) res.staleNote = `The ranking is ${ageDays} days old — re-run it for fresh sizes.`;
    return res;
  }
}

export const addSignals = new AddSignalService();
