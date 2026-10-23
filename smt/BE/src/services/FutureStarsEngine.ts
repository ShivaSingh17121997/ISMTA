/**
 * The future-stars engine.
 *
 * Ranks companies on what they have WON and BUILT rather than on what their
 * shares have already done, and hands back a staged entry plan for each.
 *
 * Cadence is the reason this is a separate engine rather than a fourth horizon
 * inside the recommender. The recommender re-ranks on price and can run daily;
 * the inputs here — quarterly results, order filings, an industrial-policy map
 * — change a few times a year. Running it daily would be theatre and would
 * hammer two NSE endpoints for answers that had not changed, so every input is
 * cached for hours to a day and a run is something the user asks for.
 *
 * The universe is deliberately narrow: names this tool has a policy or
 * strategic-production view about, plus the liquid default list, plus whatever
 * the user already owns. There is no scan of two thousand small caps here. A
 * screen over everything would mostly surface the lottery tickets the evidence
 * says to avoid.
 */
import { config } from '../config';
import { store } from '../store/memoryStore';
import { logger } from '../utils/logger';
import { getInstrument } from './instruments';
import { istParts } from './session';
import { fetchYahooChart } from './yahoo';
import { MIN_BARS, measure } from './recommender/metrics';
import { classify, loadSectors, themesFor } from './recommender/sectors';
import { DEFAULT_UNIVERSE } from './recommender/universe';
import { fetchGrowth } from './futurestars/fundamentals';
import { fetchOrderFlow } from './futurestars/orders';
import { POLICY_UNIVERSE, policyFor } from './futurestars/policy';
import { GATES, PriceContext, scoreFutureStar, writeThesis } from './futurestars/score';
import { DEFAULT_PLAN_PARAMS, PlanParams, buildEntryPlan, fundingPlan } from './futurestars/plan';
import { FutureStar, FutureStarsRun, Growth, OrderFlow, RiskFlag } from './futurestars/types';

const CANDLE_TTL_MS = 6 * 3_600_000;
/** Results change quarterly. A day of caching costs nothing and saves NSE. */
const GROWTH_TTL_MS = 24 * 3_600_000;
/** Order filings are the fast-moving input here, and even they are not hourly. */
const ORDERS_TTL_MS = 6 * 3_600_000;
const FETCH_CONCURRENCY = 3;

const EVIDENCE =
  'Weights follow the evidence, which does not flatter this category. PROFITABILITY carries the most: ' +
  'quality-minus-junk is the strongest documented factor in Indian equities, 1.69% a month with a 0.92% ' +
  'four-factor alpha over 1995–2021 (Jacob, Pradeep & Varma, IIMA 2022), while value was marginally negative ' +
  'and the size premium zero. GROWTH is scored as ACCELERATION, never as a level: firms stringing together ' +
  'five years of above-median earnings growth occur at 3.0% against the 3.1% chance predicts (Chan, Karceski ' +
  '& Lakonishok, JF 2003), and the highest forecast-growth decile earns about 3% a year against 15% for the ' +
  'lowest (Bordalo et al., JF 2019). ORDER WINS were demoted after the literature was read rather than ' +
  'recalled: Rajgopal, Shevlin & Venkatachalam (2003) found the market OVERWEIGHTS backlog — the profitable ' +
  'hedge is long the lowest-backlog decile, worth 5.8% a year — and Hou, Xue & Zhang (RFS 2020) cannot ' +
  'replicate it at all (t = 0.71). Only the CHANGE in the order book has a positive sign, a stretched ' +
  'book-to-bill predicts weaker future earnings (Banker et al., RQFA 2024), and a COUNT of announcements is ' +
  'a disclosure habit rather than a signal, because SEBI only compels disclosure of orders outside the ' +
  'normal course of business. POLICY support is opinion and nearly unweighted: the unconditional ' +
  'government-exposure spread is −0.6% a year (Belo, Gala & Li, JFE 2013), there is no Indian study of PLI, ' +
  'defence indigenisation or public capex and returns, and firms receiving fiscal inflows have been shown to ' +
  'CUT investment (Cohen, Coval & Malloy, JPE 2011).';

const DISCLAIMER =
  'NOT FOR DISTRIBUTION. This is a watchlist with a staged plan, not a forecast, and the base rates are ' +
  'brutal: only 24% of Indian stocks have beaten the market over their lifetime, the median one lost a third ' +
  'of its value, and the top 5% of firms produced 92% of all wealth created — the highest concentration of ' +
  '43 markets studied. Of the top 500 Indian companies in 2008, about 4% became durable compounders. A ' +
  'fundamental screen does not protect you: of stocks that suffered catastrophic unrecovered declines, 54% ' +
  'were profitable at their peak and most traded on reasonable multiples. Scores are absolute bars, not a ' +
  'league table — an empty list means nothing qualified, which is the normal result. Order values are read ' +
  'from filing text and are a floor, because Indian filings put the amount in the attached PDF. Policy tags ' +
  'are opinion. Nothing here deducts the ~0.35% round-trip cost of trading it, and half a small-cap position ' +
  'has taken 38 to 51 days to sell in SEBI’s own stress tests.';

const SOURCES =
  'NSE corporate announcements (order and contract wins), NSE integrated filings and legacy quarterly ' +
  'results (XBRL revenue and profit), Yahoo daily bars (price context), and a hand-written policy map.';

interface Cached<T> {
  at: number;
  value: T;
}

export class FutureStarsEngine {
  private candles = new Map<string, Cached<import('../types').Candle[]>>();
  private growth = new Map<string, Cached<Growth>>();
  private orders = new Map<string, Cached<{ flow: OrderFlow; regulatory: RiskFlag[] }>>();
  private last = new Map<string, FutureStarsRun>();
  private inFlight = new Set<string>();

  lastRun(userId: string): FutureStarsRun | undefined {
    const cached = this.last.get(userId);
    if (cached) return cached;
    let best: FutureStarsRun | undefined;
    for (const [key, run] of store.futureStarsRuns.entries()) {
      if (!key.startsWith(`${userId}:`)) continue;
      if (!best || run.at > best.at) best = run;
    }
    if (best) this.last.set(userId, best);
    return best;
  }

  /** The names worth asking about: policy view, or liquid default, or already owned. */
  universe(userId: string, override?: string[]): string[] {
    if (override?.length) return [...new Set(override.map((s) => s.trim().toUpperCase()).filter(Boolean))];
    const owned = store.accumulatorBooksByUser(userId).map((b) => b.symbol.toUpperCase());
    return [...new Set([...POLICY_UNIVERSE, ...DEFAULT_UNIVERSE, ...owned])].sort();
  }

  private async candlesFor(symbol: string, now: number): Promise<import('../types').Candle[]> {
    const hit = this.candles.get(symbol);
    if (hit && now - hit.at < CANDLE_TTL_MS) return hit.value;
    const chart = await fetchYahooChart(symbol, '2y', '1d', 15_000);
    const value = (chart?.candles ?? []).filter((c) => c.close > 0);
    this.candles.set(symbol, { at: now, value });
    return value;
  }

  private async growthFor(symbol: string, now: number): Promise<Growth> {
    const hit = this.growth.get(symbol);
    if (hit && now - hit.at < GROWTH_TTL_MS) return hit.value;
    const value = await fetchGrowth(symbol);
    this.growth.set(symbol, { at: now, value });
    return value;
  }

  private async ordersFor(symbol: string, now: number, ttmRevenue: number | null) {
    const hit = this.orders.get(symbol);
    if (hit && now - hit.at < ORDERS_TTL_MS) return hit.value;
    const value = await fetchOrderFlow(symbol, now, ttmRevenue);
    this.orders.set(symbol, { at: now, value });
    return value;
  }

  private static async pool<T>(items: T[], n: number, worker: (item: T) => Promise<void>): Promise<void> {
    const queue = [...items];
    const run = async (): Promise<void> => {
      for (let it = queue.shift(); it !== undefined; it = queue.shift()) await worker(it);
    };
    await Promise.all(Array.from({ length: Math.min(n, queue.length) }, run));
  }

  /**
   * Risk flags that come from price and size rather than filings. The
   * filing-derived ones (regulatory action) arrive with the order flow.
   */
  private priceRisks(p: PriceContext): RiskFlag[] {
    const flags: RiskFlag[] = [];
    if (p.pctOf52wRange > 95) {
      flags.push({
        kind: 'valuation',
        detail: `within ${(100 - p.pctOf52wRange).toFixed(0)}% of the 52-week high — the story is fully in the price`,
        severity: 0.25,
      });
    }
    if (p.medianTurnover < 5 * GATES.minTurnover) {
      flags.push({
        kind: 'liquidity',
        detail: `median turnover only ₹${(p.medianTurnover / 1e7).toFixed(1)} crore a day`,
        severity: 0.2,
      });
    }
    if (p.ret1yPct > 150) {
      flags.push({
        kind: 'valuation',
        detail: `up ${p.ret1yPct.toFixed(0)}% in a year; much of the future may already be paid for`,
        severity: 0.3,
      });
    }
    return flags;
  }

  async run(
    userId: string,
    opts: { symbols?: string[]; capital?: number; params?: Partial<PlanParams>; now?: number; /** False for a one-symbol lookup: answer it without replacing the saved run. */ persist?: boolean } = {},
  ): Promise<FutureStarsRun> {
    if (this.inFlight.has(userId)) throw new Error('A future-stars run is already in progress');
    this.inFlight.add(userId);
    const now = opts.now ?? Date.now();

    try {
      const universe = this.universe(userId, opts.symbols);
      const capital = opts.capital ?? config.risk.capital;
      const params: PlanParams = { ...DEFAULT_PLAN_PARAMS, ...opts.params, capital };
      const sectors = await loadSectors(now).catch(() => new Map<string, string>());

      const skipped: { symbol: string; reason: string }[] = [];
      const rejected: { symbol: string; name: string; reason: string }[] = [];
      /** Everything that cleared the gates, before the budget is divided. */
      const qualified: {
        symbol: string;
        name: string;
        score: number;
        verdict: ReturnType<typeof scoreFutureStar>['verdict'];
        pillars: ReturnType<typeof scoreFutureStar>['pillars'];
        orders: OrderFlow;
        growth: Growth;
        policy: ReturnType<typeof policyFor>;
        risks: RiskFlag[];
        price: PriceContext;
      }[] = [];
      let measured = 0;
      let scoredCount = 0;

      await FutureStarsEngine.pool(universe, FETCH_CONCURRENCY, async (symbol) => {
        try {
          const candles = await this.candlesFor(symbol, now);
          if (candles.length < MIN_BARS) {
            skipped.push({ symbol, reason: `only ${candles.length} daily bars; needs ${MIN_BARS}` });
            return;
          }
          const m = measure(symbol, candles);
          if (!m) {
            skipped.push({ symbol, reason: 'metrics could not be computed' });
            return;
          }
          measured++;

          const price: PriceContext = {
            last: m.lastClose,
            high52w: m.high52w,
            low52w: m.low52w,
            // `measure` returns this as a 0..1 fraction (0 = at the low). This
            // module works in percent everywhere, so convert once, here, at the
            // boundary. Missing it read a stock sitting at 93% of its range as
            // sitting at 1% and inverted every judgement built on it.
            pctOf52wRange: m.pctOf52wRange * 100,
            fromHighPct: m.fromHighPct,
            aboveSma200: m.aboveSma200,
            sma200: m.sma200,
            ret1yPct: m.mom12_1,
            atrPct: m.atrPct,
            medianTurnover: m.medianTurnover,
          };

          // Cheap gates before the expensive NSE calls: there is no point
          // reading two years of filings for something we cannot trade.
          if (price.medianTurnover < GATES.minTurnover || price.last < GATES.minPrice) {
            rejected.push({
              symbol,
              name: getInstrument(symbol)?.name ?? symbol,
              reason:
                price.last < GATES.minPrice
                  ? `share price ₹${price.last.toFixed(2)} is below the ₹${GATES.minPrice} floor`
                  : `median turnover ₹${(price.medianTurnover / 1e5).toFixed(1)} lakh a day is too thin to trade`,
            });
            return;
          }

          const policy = policyFor(symbol);
          const growth = await this.growthFor(symbol, now);
          const { flow, regulatory } = await this.ordersFor(symbol, now, growth.ttmRevenue);

          const risks = [...regulatory, ...this.priceRisks(price)];
          const scored = scoreFutureStar({ orders: flow, growth, policy, price, risks });
          scoredCount++;

          const name = getInstrument(symbol)?.name ?? symbol;
          if (scored.rejected) {
            rejected.push({ symbol, name, reason: scored.rejected });
            return;
          }

          qualified.push({
            symbol,
            name,
            score: scored.score,
            verdict: scored.verdict,
            pillars: scored.pillars,
            orders: flow,
            growth,
            policy,
            risks,
            price,
          });
        } catch (e) {
          skipped.push({ symbol, reason: e instanceof Error ? e.message : String(e) });
        }
      });

      // Rank first, then divide the budget, then build plans. Sizing each idea
      // in isolation and trimming afterwards produced watchlist entries holding
      // a "buy now" plan for ₹0.
      qualified.sort((a, b) => b.score - a.score);
      const funding = fundingPlan(qualified, params);

      const stars: FutureStar[] = qualified.map((qf, i) => {
        const budget = funding.budgets.get(qf.symbol) ?? null;
        const plan = buildEntryPlan({
          score: qf.score,
          verdict: qf.verdict,
          price: qf.price,
          growth: qf.growth,
          orders: qf.orders,
          params,
          now,
          budget,
          unfundedReason:
            budget === null
              ? `Ranked #${i + 1}, outside the top ${funding.funded} the ${params.categoryCapPct}% category budget can fund properly.`
              : undefined,
        });
        const partial: Omit<FutureStar, 'thesis' | 'rank'> = {
          symbol: qf.symbol,
          name: qf.name,
          sector: classify(qf.symbol, sectors).sector,
          themes: themesFor(qf.symbol),
          score: qf.score,
          verdict: qf.verdict,
          funded: plan.amount > 0,
          pillars: qf.pillars,
          orders: qf.orders,
          growth: qf.growth,
          policy: qf.policy,
          risks: qf.risks,
          plan,
          price: qf.price,
        };
        return { ...partial, rank: i + 1, thesis: writeThesis(partial) };
      });

      // The diversification gap, computed rather than asserted.
      const RECOMMENDED_MIN = 20;
      const fundedCount = stars.filter((s) => s.funded).length;
      const capRupees = (capital * params.categoryCapPct) / 100;
      const neededCapital = Math.round((RECOMMENDED_MIN * params.minPositionValue * 100) / params.categoryCapPct);
      const tooConcentrated = fundedCount > 0 && fundedCount < RECOMMENDED_MIN;
      const concentration = {
        fundedCount,
        recommendedMinimum: RECOMMENDED_MIN,
        tooConcentrated,
        note: tooConcentrated
          ? `This list funds ${fundedCount} name${fundedCount === 1 ? '' : 's'}, and the evidence says a category like ` +
            `this needs about ${RECOMMENDED_MIN} to work. No screen reliably excludes the companies that go to zero — ` +
            `54% of stocks that fell catastrophically and never recovered were profitable at their peak — so the only ` +
            `defence that has been shown to work is owning enough of them: the chance of beating Treasury bills rises ` +
            `from 47.8% on one stock to 86.7% across 25. At ₹${params.minPositionValue.toLocaleString('en-IN')} a ` +
            `position and a ${params.categoryCapPct}% category budget, ${RECOMMENDED_MIN} names needs about ` +
            `₹${neededCapital.toLocaleString('en-IN')} of capital, against the ` +
            `₹${Math.round(capRupees).toLocaleString('en-IN')} available here. Until then this is a concentrated bet ` +
            `wearing a diversified label, and a small-cap quality index fund does the same job without the ` +
            `single-name risk — NSE's own data has a quality filter lifting the small-cap 15-year return from 8.9% to ` +
            `16.4% a year.`
          : fundedCount === 0
            ? 'Nothing is funded, so there is no concentration to worry about.'
            : `${fundedCount} funded names is inside the range the evidence supports for a list like this.`,
      };

      const run: FutureStarsRun = {
        at: now,
        tradingDay: istParts(now).date,
        capital,
        universeSize: universe.length,
        measured,
        scored: scoredCount,
        stars,
        rejected: rejected.sort((a, b) => a.symbol.localeCompare(b.symbol)),
        skipped: skipped.sort((a, b) => a.symbol.localeCompare(b.symbol)),
        totalIfAllStaged: stars.reduce((s, x) => s + x.plan.amount, 0),
        categoryCapPct: params.categoryCapPct,
        concentration,
        sources: `${SOURCES} ${funding.note}`,
        evidence: EVIDENCE,
        disclaimer: DISCLAIMER,
      };

      if (opts.persist !== false) {
        this.last.set(userId, run);
        store.futureStarsRuns.set(`${userId}:${run.tradingDay}`, run);
      }
      logger.info(
        `Future stars for ${userId}: ${measured} measured, ${scoredCount} scored, ${stars.length} qualified, ` +
          `₹${Math.round(run.totalIfAllStaged).toLocaleString('en-IN')} staged`,
      );
      return run;
    } finally {
      this.inFlight.delete(userId);
    }
  }
}

export const futureStarsEngine = new FutureStarsEngine();
