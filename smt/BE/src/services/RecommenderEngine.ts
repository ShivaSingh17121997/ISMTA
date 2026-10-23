/**
 * The recommender: fetch, measure, rank, plan, allocate.
 *
 * The pure modules under `recommender/` do the thinking. This is the wiring —
 * what to fetch, in what order, how often, and how to divide capital between
 * horizons once each horizon has its own ranked list.
 *
 * WHY NEWS IS FETCHED LAST AND FOR ALMOST NOTHING
 *
 * Headlines are pulled only for the stocks that actually made a shortlist,
 * roughly fifteen names rather than the hundred scored. Two reasons: the feeds
 * are free and unofficial and hammering them for ninety stocks nobody will act
 * on is abusive, and news does not enter the ranking at all. It is context
 * attached to a decision already made on price and trend, because a lexicon
 * counting words in headlines is not strong enough to move a ranking and
 * pretending otherwise would be the dishonest part of this feature.
 *
 * WHAT THIS IS NOT. It is not advice, it does not forecast, and a score is a
 * rank against today's universe rather than a probability. Every number it
 * produces is derived from price history that is freely available; the edge, if
 * any, is in the discipline of consistent sizing, not in the ranking.
 */

import { config } from '../config';
import { logger } from '../utils/logger';
import { store } from '../store/memoryStore';
import { istParts } from './session';
import { fetchYahooChart } from './yahoo';
import { getInstrument } from './instruments';
import { MIN_BARS, measure, type Metrics } from './recommender/metrics';
import {
  DEFAULT_ELIGIBILITY,
  EVIDENCE,
  scoreHorizon,
  type EligibilityParams,
  type HorizonScore,
} from './recommender/score';
import {
  DEFAULT_SIZING,
  HORIZONS,
  buildPlan,
  type Horizon,
  type SizingParams,
  type TradePlan,
} from './recommender/plan';
import { assessTurbulence, type Turbulence } from './recommender/turbulence';
import { describeSources, fetchNews, type NewsRead } from './recommender/news';
import { withUpside } from './recommender/brokerCalls';
import { resolveUniverse } from './recommender/universe';
import { UNCLASSIFIED, classify, loadSectors } from './recommender/sectors';
import type { Candle } from '../types';

/** Daily bars do not change during a session; a long TTL is correct, not lazy. */
const CANDLE_TTL_MS = 6 * 3_600_000;
const NEWS_TTL_MS = 60 * 60_000;
const FETCH_CONCURRENCY = 4;
/** Coverage this negative withholds capital. */
const NEWS_VETO_TONE = -0.4;
/** …but only when this many headlines carried a scored word. One is noise. */
const NEWS_VETO_MIN = 3;

/** How many names to shortlist per horizon. */
const PER_HORIZON = 5;

/**
 * Most capital allowed in any one NSE sector, across all three horizons.
 *
 * This exists because momentum ranking is systematically bad at diversifying.
 * A percentile screen picks whatever has been going up, and what has been going
 * up is usually one theme at a time — defence through 2024, PSU banks before
 * that, IT before that. Rank the market on momentum in a hot tape and the top
 * fifteen names can be eleven from one sector, which is not fifteen ideas: it
 * is one idea bought eleven times, and it unwinds together.
 *
 * Twenty-five percent is deliberately loose. It permits real concentration in a
 * genuine trend — the point of momentum is to lean into it — while refusing the
 * case where a whole book is one bet wearing different tickers.
 */
export const MAX_SECTOR_PCT = 25;

/** Share of capital each horizon may claim. Long first: it is the most evidenced. */
export const HORIZON_BUDGET: Record<Horizon, number> = { long: 45, medium: 35, short: 20 };

export interface Recommendation {
  rank: number;
  symbol: string;
  name: string;
  score: number;
  verdict: HorizonScore['verdict'];
  signals: HorizonScore['signals'];
  plan: TradePlan;
  metrics: Metrics;
  news: NewsRead | null;
  /**
   * How rough the hold is likely to be — expected drawdown, how soon, and how
   * fat the left tail is. Never a veto: the study behind it found that skipping
   * extended names roughly halves returns, so this informs the size and the
   * stop and changes nothing else. Null when ATR is unusable.
   */
  turbulence: Turbulence | null;
  /**
   * Zero when this stock is already funded by a longer horizon. The idea is
   * still shown — it is real information that a name ranks well at two
   * horizons — but the money is not committed twice.
   */
  allocatedAmount: number;
  allocatedPct: number;
  duplicateOf: Horizon | null;
  /**
   * Set when recent coverage is strongly negative. The idea keeps its rank —
   * the price data has not changed — but the money is withheld.
   *
   * Sentiment is far too weak to rank on: Tetlock measured a one-standard-
   * deviation move in media pessimism at about eight basis points on next-day
   * returns, fully reversed within a week, against a round-trip cost several
   * times that. It is strong enough for exactly one job, which is not buying
   * into a fraud allegation or a guidance cut on the day it breaks.
   */
  newsSuppressed: boolean;
  newsSuppressedReason?: string;
  /** NSE's own industry. Authoritative, and what the concentration cap counts. */
  sector: string;
  /** Curated categories — defence, semiconductors, green energy. Opinionated; may be empty. */
  themes: string[];
  /** Set when the sector cap trimmed this idea, with the arithmetic. */
  sectorCapped?: string;
}

/** What the book is actually exposed to once every horizon has allocated. */
export interface SectorExposure {
  sector: string;
  symbols: string[];
  amount: number;
  pct: number;
  /** True when the cap bound here, i.e. ideas were trimmed to fit. */
  capped: boolean;
}

export interface HorizonBucket {
  horizon: Horizon;
  label: string;
  holdLabel: string;
  budgetPct: number;
  budget: number;
  allocated: number;
  /** How much to trust this horizon, and why. */
  evidence: { grade: 'A' | 'B' | 'C'; note: string };
  recommendations: Recommendation[];
  note: string;
}

export interface RecommendationRun {
  at: number;
  tradingDay: string;
  capital: number;
  sizing: SizingParams;
  universeSize: number;
  measured: number;
  eligible: number;
  buckets: HorizonBucket[];
  /** Everything the scorer refused, with the reason. */
  vetoed: { symbol: string; name: string; reason: string }[];
  /** Symbols with too little history or no data at all. */
  skipped: { symbol: string; reason: string }[];
  totalAllocated: number;
  totalRiskIfAllStopped: number;
  /** Sector exposure after the cap, largest first. */
  sectorExposure: SectorExposure[];
  maxSectorPct: number;
  sources: string;
  disclaimer: string;
}

/**
 * Enforce the sector cap over every funded idea, across all horizons.
 *
 * Runs last, after horizon budgets and the news veto, because it is a portfolio
 * constraint rather than a ranking one — it can only be evaluated once the whole
 * book is known.
 *
 * Trimming is by rank, worst first: an over-weight sector keeps its best ideas
 * whole and loses its weakest. The alternative — scaling every position in the
 * sector down pro-rata — would shrink the highest-conviction idea to fund the
 * lowest, which is exactly backwards. Mutating in place is deliberate; the caller
 * owns these objects and needs the `sectorCapped` note on them.
 */
export function applySectorCap(
  picks: Recommendation[],
  capital: number,
  maxPct = MAX_SECTOR_PCT,
): SectorExposure[] {
  const limit = (capital * maxPct) / 100;
  const bySector = new Map<string, Recommendation[]>();
  for (const p of picks) {
    if (p.allocatedAmount <= 0) continue;
    const list = bySector.get(p.sector) ?? [];
    list.push(p);
    bySector.set(p.sector, list);
  }

  const exposure: SectorExposure[] = [];
  for (const [sector, list] of bySector) {
    // "Unclassified" is a bag of unrelated names, not a sector. Capping it
    // would be a limit on ignorance rather than on correlated risk.
    const exempt = sector === UNCLASSIFIED;
    // Best first, so the trim falls on the tail.
    const ranked = [...list].sort((a, b) => b.score - a.score);
    let used = 0;
    let capped = false;
    for (const p of ranked) {
      if (exempt) {
        used += p.allocatedAmount;
        continue;
      }
      const room = limit - used;
      if (room <= 0) {
        p.sectorCapped =
          `No capital: ${sector} already holds the full ${maxPct}% limit ` +
          `(₹${Math.round(limit).toLocaleString('en-IN')}) in higher-ranked names.`;
        p.allocatedAmount = 0;
        p.allocatedPct = 0;
        capped = true;
      } else if (p.allocatedAmount > room) {
        p.sectorCapped =
          `Trimmed from ₹${Math.round(p.allocatedAmount).toLocaleString('en-IN')} to ` +
          `₹${Math.round(room).toLocaleString('en-IN')} — the rest of the ${maxPct}% ${sector} limit.`;
        p.allocatedAmount = room;
        p.allocatedPct = capital > 0 ? (room / capital) * 100 : 0;
        used += room;
        capped = true;
      } else {
        used += p.allocatedAmount;
      }
    }
    exposure.push({
      sector,
      symbols: ranked.filter((p) => p.allocatedAmount > 0).map((p) => p.symbol),
      amount: used,
      pct: capital > 0 ? (used / capital) * 100 : 0,
      capped,
    });
  }
  return exposure.sort((a, b) => b.amount - a.amount);
}

const DISCLAIMER =
  'FOR PERSONAL USE ONLY — NOT INVESTMENT ADVICE, AND NOT FOR DISTRIBUTION. ' +
  'The operator is not a SEBI-registered Investment Adviser or Research Analyst. A tool that ' +
  'produces recommendations for its own owner sits outside both regimes; the moment its output ' +
  'is shown to anyone else, sold, or published with performance claims, it does not. ' +
  'Scores are RANKS against the universe scored today, not forecasts or probabilities. Entry, ' +
  'stop and target are levels derived from price history and volatility — the stop marks where ' +
  'the idea is wrong, not a prediction of the low. Momentum is the best-evidenced equity signal ' +
  'there is and comparable Indian strategies have still drawn down more than 70% with multi-year ' +
  'recoveries. Position sizes assume every stop is honoured; a gap through a stop loses more ' +
  'than the figure shown. Costs of roughly 0.35% a round trip are not deducted from any figure here.';

interface CachedCandles {
  at: number;
  candles: Candle[];
  error?: string;
}

export class RecommenderEngine {
  private candles = new Map<string, CachedCandles>();
  private news = new Map<string, { at: number; read: NewsRead }>();
  private inFlight = new Set<string>();
  private last = new Map<string, RecommendationRun>();

  /**
   * The most recent run for this user. Served from the store, which is
   * hydrated from MongoDB, so a restart does not throw away a run that cost a
   * minute of Yahoo calls — and so the validation harness has history to score.
   */
  lastRun(userId: string): RecommendationRun | undefined {
    const cached = this.last.get(userId);
    if (cached) return cached;
    let best: RecommendationRun | undefined;
    for (const [key, run] of store.recommendationRuns.entries()) {
      if (!key.startsWith(`${userId}:`)) continue;
      if (!best || run.at > best.at) best = run;
    }
    if (best) this.last.set(userId, best);
    return best;
  }

  /** Every persisted run for a user, oldest first. */
  history(userId: string): RecommendationRun[] {
    return [...store.recommendationRuns.entries()]
      .filter(([key]) => key.startsWith(`${userId}:`))
      .map(([, run]) => run)
      .sort((a, b) => a.at - b.at);
  }

  /**
   * Ten years of daily bars, cached.
   *
   * Two years was enough for the 252-day lookback plus the skip month, and no
   * more. The turbulence study needs a decade: its base rates were calibrated
   * on 2016–2026 and a stock measured against a two-year window would be
   * compared with observations it never lived through. Verified available —
   * `range=10y&interval=1d` returns ~2,475 bars for a liquid NSE name, already
   * adjusted for splits and bonuses.
   */
  private async candlesFor(symbol: string, now: number): Promise<CachedCandles> {
    const hit = this.candles.get(symbol);
    if (hit && !hit.error && now - hit.at < CANDLE_TTL_MS) return hit;
    let out: CachedCandles;
    try {
      const chart = await fetchYahooChart(symbol, '10y', '1d', 20_000);
      const bars = (chart?.candles ?? []).filter((c) => c.close > 0);
      out = { at: now, candles: bars };
      if (!bars.length) out.error = 'no daily bars';
    } catch (e) {
      out = { at: now, candles: [], error: e instanceof Error ? e.message : String(e) };
    }
    this.candles.set(symbol, out);
    return out;
  }

  private async newsFor(symbol: string, name: string, now: number): Promise<NewsRead | null> {
    const hit = this.news.get(symbol);
    if (hit && now - hit.at < NEWS_TTL_MS) return hit.read;
    try {
      const read = await fetchNews(symbol, name, 7);
      this.news.set(symbol, { at: now, read });
      return read;
    } catch (e) {
      logger.warn(`news ${symbol}: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /** Run `worker` over `items`, `n` at a time. */
  private static async pool<T>(items: T[], n: number, worker: (item: T) => Promise<void>): Promise<void> {
    const queue = [...items];
    const run = async (): Promise<void> => {
      for (let it = queue.shift(); it !== undefined; it = queue.shift()) await worker(it);
    };
    await Promise.all(Array.from({ length: Math.min(n, queue.length) }, run));
  }

  /**
   * Produce a full run for a user.
   *
   * Sequential by design: measure everything, score each horizon over the same
   * measured set, then plan and allocate. Scoring must see the whole universe
   * at once — that is what makes a percentile mean anything.
   */
  async run(
    userId: string,
    opts: {
      symbols?: string[];
      capital?: number;
      sizing?: Partial<SizingParams>;
      eligibility?: Partial<EligibilityParams>;
      withNews?: boolean;
      now?: number;
    } = {},
  ): Promise<RecommendationRun> {
    if (this.inFlight.has(userId)) throw new Error('A recommendation run is already in progress');
    this.inFlight.add(userId);
    const now = opts.now ?? Date.now();

    try {
      const universe = resolveUniverse(userId, opts.symbols);
      const capital = opts.capital ?? config.risk.capital;
      const sizing: SizingParams = { ...DEFAULT_SIZING, ...opts.sizing, capital };
      const eligibility: EligibilityParams = { ...DEFAULT_ELIGIBILITY, ...opts.eligibility };

      // ── measure ──
      const metrics: Metrics[] = [];
      const skipped: { symbol: string; reason: string }[] = [];
      await RecommenderEngine.pool(universe, FETCH_CONCURRENCY, async (symbol) => {
        const c = await this.candlesFor(symbol, now);
        if (c.error) {
          skipped.push({ symbol, reason: c.error });
          return;
        }
        const m = measure(symbol, c.candles);
        if (!m) {
          skipped.push({ symbol, reason: `only ${c.candles.length} daily bars, needs ${MIN_BARS}` });
          return;
        }
        metrics.push(m);
      });

      // ── classify ──
      // One fetch per day for the whole run. An empty map is survivable: every
      // stock reads as Unclassified and the cap simply does not bind.
      const sectors = await loadSectors(now);

      // ── score, plan, allocate ──
      const nameOf = (s: string) => getInstrument(s)?.name ?? s;
      const buckets: HorizonBucket[] = [];
      const takenBy = new Map<string, Horizon>();
      const order: Horizon[] = ['long', 'medium', 'short'];
      let eligibleCount = 0;
      const vetoed: RecommendationRun['vetoed'] = [];

      for (const horizon of order) {
        const spec = HORIZONS[horizon];
        // Sectors go in so momentum is ranked within sector before it is ranked
        // globally — otherwise a hot sector fills every slot with one bet.
        const scores = scoreHorizon(metrics, horizon, eligibility, sectors);
        const live = scores.filter((s) => !s.vetoed);
        eligibleCount = live.length;

        if (horizon === 'long') {
          for (const s of scores.filter((x) => x.vetoed)) {
            vetoed.push({ symbol: s.symbol, name: nameOf(s.symbol), reason: s.vetoReason ?? 'not eligible' });
          }
        }

        const budgetPct = HORIZON_BUDGET[horizon];
        const budget = (capital * budgetPct) / 100;

        // Plan the top names, keeping only those that can state a usable plan.
        //
        // A stock already funded by a longer horizon is still SHOWN — that it
        // ranks well at two horizons is real information — but it must not
        // consume one of the five slots, or a horizon whose best names are all
        // already held funds nothing and its entire budget sits idle. So the
        // count that stops this loop is of FRESH names, not of rows.
        const picks: Recommendation[] = [];
        let freshCount = 0;
        for (const s of live) {
          if (freshCount >= PER_HORIZON) break;
          const m = metrics.find((x) => x.symbol === s.symbol);
          if (!m) continue;
          // Turbulence first, because it widens the stop — and the stop is what
          // the position size falls out of. Assessed at the last close here;
          // re-assessed against the actual entry once the plan names one.
          const firstPass = assessTurbulence(m);
          const plan = buildPlan(m, spec, sizing, firstPass?.requiredStopAtr ?? 0);
          if (!plan || plan.quantity < 1) continue;
          // The dip is worth quoting off the price actually being paid, which
          // for a pullback entry is not the last close.
          const turbulence = assessTurbulence(m, plan.entry);
          const cls = classify(s.symbol, sectors);
          const duplicateOf = takenBy.get(s.symbol) ?? null;
          if (!duplicateOf) freshCount++;
          picks.push({
            rank: picks.length + 1,
            symbol: s.symbol,
            name: nameOf(s.symbol),
            score: s.score,
            verdict: s.verdict,
            signals: s.signals,
            plan,
            metrics: m,
            news: null,
            turbulence,
            allocatedAmount: 0,
            allocatedPct: 0,
            duplicateOf,
            newsSuppressed: false,
            sector: cls.sector,
            themes: cls.themes,
          });
        }

        // Scale to the horizon budget. Positions already funded by a longer
        // horizon claim nothing here, so the same stock is never bought twice.
        const fresh = picks.filter((p) => p.duplicateOf === null);
        const wanted = fresh.reduce((s, p) => s + p.plan.amount, 0);
        const scale = wanted > budget && wanted > 0 ? budget / wanted : 1;
        for (const p of fresh) {
          p.allocatedAmount = p.plan.amount * scale;
          p.allocatedPct = capital > 0 ? (p.allocatedAmount / capital) * 100 : 0;
          takenBy.set(p.symbol, horizon);
        }

        const allocated = fresh.reduce((s, p) => s + p.allocatedAmount, 0);
        buckets.push({
          horizon,
          label: spec.label,
          holdLabel: picks[0]?.plan.holdLabel ?? '',
          budgetPct,
          budget,
          allocated,
          recommendations: picks,
          evidence: EVIDENCE[horizon],
          note:
            scale < 1
              ? `Sized to the ${budgetPct}% horizon budget: the risk-based sizes wanted ` +
                `₹${Math.round(wanted).toLocaleString('en-IN')}, so each was scaled to ` +
                `${(scale * 100).toFixed(0)}%.`
              : `Risk-based sizing came in under the ${budgetPct}% horizon budget; nothing was scaled down.`,
        });
      }

      // ── news, only for what was shortlisted ──
      if (opts.withNews !== false) {
        const wanted = [...new Set(buckets.flatMap((b) => b.recommendations.map((r) => r.symbol)))];
        const reads = new Map<string, NewsRead | null>();
        await RecommenderEngine.pool(wanted, 3, async (symbol) => {
          reads.set(symbol, await this.newsFor(symbol, nameOf(symbol), now));
        });
        for (const b of buckets) {
          for (const r of b.recommendations) {
            const read = reads.get(r.symbol) ?? null;
            // Upside is priced per run against this run's close; the cached read
            // is shared across runs, so it is copied rather than written to.
            r.news = read && {
              ...read,
              brokers: { ...read.brokers, calls: withUpside(read.brokers.calls, r.metrics.lastClose) },
            };
            // Withhold the money, keep the rank. Requires several scored
            // headlines agreeing — one bad word in one headline is noise.
            if (r.news && r.news.sentiment <= NEWS_VETO_TONE && r.news.scored >= NEWS_VETO_MIN) {
              r.newsSuppressed = true;
              r.newsSuppressedReason =
                `Recent coverage is strongly negative (${r.news.scored} scored headlines, tone ` +
                `${r.news.sentiment.toFixed(2)}). The ranking is unchanged — the price data has not ` +
                `moved — but no capital is committed until you have read why.`;
              r.allocatedAmount = 0;
              r.allocatedPct = 0;
            }
          }
        }
      }

      // ── sector cap ──
      // Last, because it is the only constraint that spans horizons: it cannot
      // be judged until every bucket has committed and the news veto has freed
      // whatever it was going to free.
      const funded = buckets.flatMap((b) => b.recommendations).filter((r) => r.duplicateOf === null);
      const sectorExposure = applySectorCap(funded, capital);
      for (const b of buckets) {
        b.allocated = b.recommendations
          .filter((r) => r.duplicateOf === null && !r.newsSuppressed)
          .reduce((s, r) => s + r.allocatedAmount, 0);
      }

      const totalAllocated = buckets.reduce((s, b) => s + b.allocated, 0);
      const totalRisk = buckets.reduce(
        (s, b) => s + b.recommendations.filter((r) => r.duplicateOf === null)
          .reduce((t, r) => t + r.plan.riskAmount * (r.plan.amount > 0 ? r.allocatedAmount / r.plan.amount : 0), 0),
        0,
      );

      const run: RecommendationRun = {
        at: now,
        tradingDay: istParts(now).date,
        capital,
        sizing,
        universeSize: universe.length,
        measured: metrics.length,
        eligible: eligibleCount,
        buckets,
        vetoed: vetoed.sort((a, b) => a.symbol.localeCompare(b.symbol)),
        skipped,
        totalAllocated,
        totalRiskIfAllStopped: totalRisk,
        sectorExposure,
        maxSectorPct: MAX_SECTOR_PCT,
        sources: describeSources(),
        disclaimer: DISCLAIMER,
      };

      this.last.set(userId, run);
      store.recommendationRuns.set(`${userId}:${run.tradingDay}`, run);
      logger.info(
        `Recommendations for ${userId}: ${metrics.length}/${universe.length} measured, ` +
          `${eligibleCount} eligible, ₹${Math.round(totalAllocated).toLocaleString('en-IN')} allocated`,
      );
      return run;
    } finally {
      this.inFlight.delete(userId);
    }
  }

  /**
   * The same path forecast, applied to positions ALREADY HELD.
   *
   * Arguably the more useful half. On the recommendations page turbulence tells
   * you how to size; here it answers the question that actually costs people
   * money, which is "I am down 4% — is the idea broken?" Usually it is not: a
   * 5% dip inside three months is what roughly two thirds of all stocks do, and
   * the study found no condition under which that dip predicts a worse outcome.
   *
   * Reuses the candle cache, so a run made this morning costs nothing. Symbols
   * never scored still cost one fetch each, which is why this is its own route
   * rather than part of the cheap risk snapshot.
   */
  async assessHoldings(userId: string, now: number = Date.now()): Promise<HoldingRisk[]> {
    const positions = store.positionsByUser(userId).filter((p) => p.quantity > 0);
    const out: HoldingRisk[] = [];

    await RecommenderEngine.pool(positions, FETCH_CONCURRENCY, async (pos) => {
      const base = {
        symbol: pos.symbol,
        name: getInstrument(pos.symbol)?.name ?? pos.symbol,
        quantity: pos.quantity,
        avgPrice: pos.avgPrice,
        ltp: pos.ltp,
        unrealisedPnlPct: pos.avgPrice > 0 ? (pos.ltp / pos.avgPrice - 1) * 100 : 0,
      };
      const c = await this.candlesFor(pos.symbol, now);
      if (c.error) {
        out.push({ ...base, turbulence: null, verdict: 'unknown', note: `no price history: ${c.error}` });
        return;
      }
      const m = measure(pos.symbol, c.candles);
      if (!m) {
        out.push({
          ...base,
          turbulence: null,
          verdict: 'unknown',
          note: `only ${c.candles.length} daily bars, needs ${MIN_BARS} to measure`,
        });
        return;
      }
      // Quoted against what was actually PAID, because that is the number the
      // holder is looking at, not the last close.
      const turbulence = assessTurbulence(m, pos.avgPrice);
      out.push({ ...base, turbulence, ...judgeDrawdown(base.unrealisedPnlPct, turbulence) });
    });

    return out.sort((a, b) => a.unrealisedPnlPct - b.unrealisedPnlPct);
  }

  /**
   * The path forecast for any one symbol, quoted off `entry` (default: last
   * close). Shares the ten-year candle cache, so a stock the ranking already
   * scored costs nothing. Null when there is too little history to measure.
   */
  async turbulenceFor(symbol: string, entry?: number, now: number = Date.now()): Promise<Turbulence | null> {
    const c = await this.candlesFor(symbol, now);
    if (c.error) return null;
    const m = measure(symbol, c.candles);
    return m ? assessTurbulence(m, entry ?? m.lastClose) : null;
  }

  /**
   * The ranking's news veto for one symbol: the reason when recent coverage is
   * strongly negative, else null. Same thresholds as `run`, same hourly cache.
   */
  async newsVeto(symbol: string, name: string, now: number = Date.now()): Promise<string | null> {
    const read = await this.newsFor(symbol, name, now);
    if (!read || !(read.sentiment <= NEWS_VETO_TONE && read.scored >= NEWS_VETO_MIN)) return null;
    return (
      `Recent news is strongly negative (${read.scored} scored headlines, tone ${read.sentiment.toFixed(2)}). ` +
      'Read why before adding money.'
    );
  }
}

/**
 * Is a position's current drawdown ordinary, or is it past what this stock
 * normally does?
 *
 * Deliberately NOT a sell signal. Section 4.4 of the study scanned sixteen
 * bearish-looking conditions and every one of them still had a positive mean
 * forward excess return, so there is nothing here that earns the word "exit".
 * The stop already answers that question, and it answers it on structure.
 * What this adds is context: being down 4% in a stock whose ordinary dip is 6%
 * is not information, and treating it as information is how a plan gets
 * abandoned at the worst moment.
 */
export function judgeDrawdown(
  unrealisedPnlPct: number,
  t: Turbulence | null,
): { verdict: HoldingRisk['verdict']; note: string } {
  if (!t) return { verdict: 'unknown', note: 'not enough history to say what is normal for this stock' };
  const dip = t.forecast.expectedDipPct;
  if (unrealisedPnlPct >= 0) {
    return {
      verdict: 'fine',
      note:
        `Up ${unrealisedPnlPct.toFixed(1)}%. For reference, a ${dip.toFixed(1)}% drawdown is ` +
        `ordinary for a stock this volatile — expect to give some of this back without it ` +
        `meaning anything.`,
    };
  }
  const down = -unrealisedPnlPct;
  if (down <= dip) {
    return {
      verdict: 'normal-dip',
      note:
        `Down ${down.toFixed(1)}%, which is INSIDE the ${dip.toFixed(1)}% drawdown that is ` +
        `ordinary for this stock. ${(t.forecast.dipProbability * 100).toFixed(0)}% of the time ` +
        `a name like this falls 5% within three months. This is noise, not a broken thesis — ` +
        `the stop is what decides that.`,
    };
  }
  if (down <= dip * 2) {
    return {
      verdict: 'beyond-normal',
      note:
        `Down ${down.toFixed(1)}%, past the ${dip.toFixed(1)}% that is ordinary here but well ` +
        `short of unusual. Check the stop rather than the P&L: nothing measured in the study ` +
        `says a fall of this size predicts a worse outcome from here.`,
    };
  }
  return {
    verdict: 'deep',
    note:
      `Down ${down.toFixed(1)}%, more than twice this stock's ordinary ${dip.toFixed(1)}% ` +
      `drawdown. That is a size worth re-reading the original reason for — though note that ` +
      `even "30% below the 52-week high and under the 200-day average" showed a positive mean ` +
      `forward return, so this is a prompt to look, not a signal to sell.`,
  };
}

export interface HoldingRisk {
  symbol: string;
  name: string;
  quantity: number;
  avgPrice: number;
  ltp: number;
  unrealisedPnlPct: number;
  turbulence: Turbulence | null;
  /** How the current drawdown compares with what is ordinary for this stock. */
  verdict: 'fine' | 'normal-dip' | 'beyond-normal' | 'deep' | 'unknown';
  note: string;
}

export const recommenderEngine = new RecommenderEngine();
