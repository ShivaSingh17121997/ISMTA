/**
 * The turnaround engine — stocks well below their highs where the business
 * underneath has not broken.
 *
 * The universe is the opposite end of the same telescope as the future-stars
 * list. That one gates on price confirmation and therefore throws away every
 * company whose shares have fallen; this one starts there. On the run of
 * 11 September 2026 the future-stars list rejected BEL, RVNL, KAYNES, NTPC,
 * IREDA and TARIL purely for sitting below their 200-day averages — six
 * companies with real order books and real revenue, discarded for the one
 * reason that makes them candidates here.
 *
 * The two lists are deliberately mutually exclusive at the price gate, so the
 * same company can never be recommended twice for opposite reasons.
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
import { fetchShareholding, Shareholding } from './futurestars/shareholding';
import { POLICY_UNIVERSE } from './futurestars/policy';
import { Growth, RiskFlag } from './futurestars/types';
import { BAND, TurnPrice, scoreTurnaround } from './turnaround/score';
import { DEFAULT_TURN_PARAMS, TurnPlanParams, buildTurnEntry, turnFundingPlan } from './turnaround/plan';
import { Turnaround, TurnaroundRun } from './turnaround/types';

const CANDLE_TTL_MS = 6 * 3_600_000;
const GROWTH_TTL_MS = 24 * 3_600_000;
const SHP_TTL_MS = 24 * 3_600_000;
const ORDERS_TTL_MS = 12 * 3_600_000;
const FETCH_CONCURRENCY = 3;

const EVIDENCE =
  'This category argues with the strongest anomaly in equities, and the design says so. Twelve-month momentum ' +
  'says losers keep losing for the next three to twelve months, and momentum is the largest documented factor ' +
  'in Indian equities — so nothing here is bought while it is still falling: entry is on a trigger that ' +
  'confirms the base held, and an unfired trigger is the plan working. Reversal, where it exists, is a three- ' +
  'to five-year formation and hold (De Bondt & Thaler), not a reaction to last month. What separates a ' +
  'recoverable fall from a permanent one is financial strength and profitability rather than cheapness, which ' +
  'is why the heaviest pillar asks whether the business still works and loss-making companies are excluded ' +
  'outright — distressed stocks underperform badly (Campbell, Hilscher & Szilagyi, JF 2008). Promoter ' +
  'pledging and a falling promoter stake are excluded together because that pair is the documented mechanism ' +
  '(margin-call cascades) by which a large fall becomes a permanent one.';

const DISCLAIMER =
  'NOT FOR DISTRIBUTION. Most large falls are never recovered: about 40% of Russell 3000 members since 1980 ' +
  'suffered a decline of 70% or more that they never made back, and in India only 24% of stocks have beaten ' +
  'the market over their lifetime while the median one lost a third of its value. Depth is used here as a ' +
  'FILTER and never as a score — a stock 60% down earns no more credit than one 30% down, because "cheaper is ' +
  'better" is the falling-knife error written as arithmetic. Anything more than ' +
  `${BAND.maxFallPct}% below its high is refused outright rather than guessed at. Every idea carries a real ` +
  'stop and a time stop, and both are meant to be obeyed.';

const SOURCES =
  'Yahoo daily bars (the fall and whether it has stopped), NSE integrated and legacy filings (XBRL revenue, ' +
  'profit and margin), NSE quarterly shareholding patterns (promoter stake and encumbrance), and NSE ' +
  'corporate announcements (regulatory action).';

interface Cached<T> {
  at: number;
  value: T;
}

export class TurnaroundEngine {
  private candles = new Map<string, Cached<import('../types').Candle[]>>();
  private growth = new Map<string, Cached<Growth>>();
  private shp = new Map<string, Cached<Shareholding>>();
  private risks = new Map<string, Cached<RiskFlag[]>>();
  private last = new Map<string, TurnaroundRun>();
  private inFlight = new Set<string>();

  lastRun(userId: string): TurnaroundRun | undefined {
    const cached = this.last.get(userId);
    if (cached) return cached;
    let best: TurnaroundRun | undefined;
    for (const [key, run] of store.turnaroundRuns.entries()) {
      if (!key.startsWith(`${userId}:`)) continue;
      if (!best || run.at > best.at) best = run;
    }
    if (best) this.last.set(userId, best);
    return best;
  }

  universe(userId: string, override?: string[]): string[] {
    if (override?.length) return [...new Set(override.map((s) => s.trim().toUpperCase()).filter(Boolean))];
    const owned = store.accumulatorBooksByUser(userId).map((b) => b.symbol.toUpperCase());
    return [...new Set([...DEFAULT_UNIVERSE, ...POLICY_UNIVERSE, ...owned])].sort();
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

  private async shareholdingFor(symbol: string, now: number): Promise<Shareholding> {
    const hit = this.shp.get(symbol);
    if (hit && now - hit.at < SHP_TTL_MS) return hit.value;
    const value = await fetchShareholding(symbol);
    this.shp.set(symbol, { at: now, value });
    return value;
  }

  /** Regulatory action from the filings — the same read the other engine does. */
  private async risksFor(symbol: string, now: number): Promise<RiskFlag[]> {
    const hit = this.risks.get(symbol);
    if (hit && now - hit.at < ORDERS_TTL_MS) return hit.value;
    const { regulatory } = await fetchOrderFlow(symbol, now, null);
    this.risks.set(symbol, { at: now, value: regulatory });
    return regulatory;
  }

  private static async pool<T>(items: T[], n: number, worker: (item: T) => Promise<void>): Promise<void> {
    const queue = [...items];
    const run = async (): Promise<void> => {
      for (let it = queue.shift(); it !== undefined; it = queue.shift()) await worker(it);
    };
    await Promise.all(Array.from({ length: Math.min(n, queue.length) }, run));
  }

  /** One paragraph: what fell, what did not, and what would confirm it. */
  private writeThesis(t: Omit<Turnaround, 'thesis' | 'rank'>): string {
    const { price: p, growth: g, shareholding: s } = t;
    const parts: string[] = [];
    parts.push(
      `${t.name} is ${Math.abs(p.fromHighPct).toFixed(0)}% below its 52-week high and ` +
        `${p.mom12_1 >= 0 ? 'up' : 'down'} ${Math.abs(p.mom12_1).toFixed(0)}% over the year.`,
    );
    if (g.marginPct !== null && g.revenueYoYPct !== null) {
      parts.push(
        `The business behind it is ${g.marginPct > 0 ? 'still profitable' : 'loss-making'}: a ${g.marginPct}% pre-tax margin` +
          (g.marginYearAgoPct !== null ? ` against ${g.marginYearAgoPct}% a year earlier` : '') +
          `, on revenue ${g.revenueYoYPct >= 0 ? 'up' : 'down'} ${Math.abs(g.revenueYoYPct)}%.`,
      );
    }
    if (s.latestPct !== null) {
      parts.push(
        `Promoters hold ${s.latestPct}%` +
          (s.changePct !== null && Math.abs(s.changePct) > 0.05
            ? `, ${s.changePct > 0 ? 'up' : 'down'} ${Math.abs(s.changePct)} points over the year`
            : ', unchanged over the year') +
          (s.pledged === true ? ', and some of it is pledged' : s.pledged === false ? ', none of it pledged' : '') +
          '.',
      );
    }
    parts.push(
      p.ema20Above50
        ? 'The 20-day average has crossed back above the 50-day, which is the first sign the fall has stopped.'
        : 'The 20-day average is still below the 50-day, so the fall has not yet demonstrably stopped.',
    );
    if (t.risks.length) parts.push(`Against that: ${t.risks.map((r) => r.kind).join(', ')}.`);
    return parts.join(' ');
  }

  async run(
    userId: string,
    opts: { symbols?: string[]; capital?: number; params?: Partial<TurnPlanParams>; now?: number; /** False for a one-symbol lookup: answer it without replacing the saved run. */ persist?: boolean } = {},
  ): Promise<TurnaroundRun> {
    if (this.inFlight.has(userId)) throw new Error('A turnaround run is already in progress');
    this.inFlight.add(userId);
    const now = opts.now ?? Date.now();

    try {
      const universe = this.universe(userId, opts.symbols);
      const capital = opts.capital ?? config.risk.capital;
      const params: TurnPlanParams = { ...DEFAULT_TURN_PARAMS, ...opts.params, capital };
      const sectors = await loadSectors(now).catch(() => new Map<string, string>());

      const skipped: { symbol: string; reason: string }[] = [];
      const rejected: { symbol: string; name: string; reason: string }[] = [];
      const qualified: {
        symbol: string;
        name: string;
        score: number;
        verdict: ReturnType<typeof scoreTurnaround>['verdict'];
        pillars: ReturnType<typeof scoreTurnaround>['pillars'];
        growth: Growth;
        shareholding: Shareholding;
        risks: RiskFlag[];
        price: TurnPrice;
      }[] = [];
      let measured = 0;
      let scoredCount = 0;

      await TurnaroundEngine.pool(universe, FETCH_CONCURRENCY, async (symbol) => {
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

          const price: TurnPrice = {
            last: m.lastClose,
            high52w: m.high52w,
            low52w: m.low52w,
            pctOf52wRange: m.pctOf52wRange * 100,
            fromHighPct: m.fromHighPct,
            aboveSma200: m.aboveSma200,
            sma200: m.sma200,
            ema20: m.ema20,
            ema50: m.ema50,
            ema20Above50: m.ema20Above50,
            low20: m.low20,
            ret1m: m.ret1m,
            mom3_1: m.mom3_1,
            mom6_1: m.mom6_1,
            mom12_1: m.mom12_1,
            maxDrawdown1yPct: m.maxDrawdown1yPct,
            rsi14: m.rsi14,
            atrPct: m.atrPct,
            volAnnualPct: m.volAnnualPct,
            medianTurnover: m.medianTurnover,
          };

          const name = getInstrument(symbol)?.name ?? symbol;
          const fall = Math.abs(price.fromHighPct);

          // The cheap gates first — no point reading a year of filings for
          // something that is not down, or is down too far to judge.
          if (price.medianTurnover < BAND.minTurnover || price.last < BAND.minPrice) {
            rejected.push({
              symbol,
              name,
              reason:
                price.last < BAND.minPrice
                  ? `share price ₹${price.last.toFixed(2)} is below the ₹${BAND.minPrice} floor`
                  : `median turnover ₹${(price.medianTurnover / 1e5).toFixed(1)} lakh a day is too thin`,
            });
            return;
          }
          if (fall < BAND.minFallPct) {
            rejected.push({ symbol, name, reason: `only ${fall.toFixed(0)}% below its high — not down enough` });
            return;
          }
          if (fall > BAND.maxFallPct) {
            rejected.push({
              symbol,
              name,
              reason: `${fall.toFixed(0)}% below its high — past the point where recovery is the exception`,
            });
            return;
          }

          const [growth, shareholding, regulatory] = await Promise.all([
            this.growthFor(symbol, now),
            this.shareholdingFor(symbol, now),
            this.risksFor(symbol, now),
          ]);

          const risks: RiskFlag[] = [...regulatory];
          if (shareholding.pledged === true) {
            risks.push({
              kind: 'pledge',
              detail: `promoter shares are encumbered (${shareholding.encumbrance.join(', ')})`,
              severity: 0.45,
            });
          }
          if ((shareholding.changePct ?? 0) < -1.5) {
            risks.push({
              kind: 'dilution',
              detail: `promoter stake fell ${Math.abs(shareholding.changePct!)} points over the year`,
              severity: 0.4,
            });
          }

          const scored = scoreTurnaround({ growth, price, shareholding, risks });
          scoredCount++;
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
            growth,
            shareholding,
            risks,
            price,
          });
        } catch (e) {
          skipped.push({ symbol, reason: e instanceof Error ? e.message : String(e) });
        }
      });

      qualified.sort((a, b) => b.score - a.score);
      const funding = turnFundingPlan(qualified, params);

      const candidates: Turnaround[] = qualified.map((qf, i) => {
        const budget = funding.budgets.get(qf.symbol) ?? null;
        const entry = buildTurnEntry({
          score: qf.score,
          verdict: qf.verdict,
          price: qf.price,
          growth: qf.growth,
          params,
          now,
          budget,
          unfundedReason:
            budget === null
              ? `Ranked #${i + 1}, outside the top ${funding.funded} the ${params.categoryCapPct}% category budget can fund.`
              : undefined,
        });
        const partial: Omit<Turnaround, 'thesis' | 'rank'> = {
          symbol: qf.symbol,
          name: qf.name,
          sector: classify(qf.symbol, sectors).sector,
          themes: themesFor(qf.symbol),
          score: qf.score,
          verdict: qf.verdict,
          funded: entry.amount > 0,
          pillars: qf.pillars,
          growth: qf.growth,
          shareholding: qf.shareholding,
          risks: qf.risks,
          entry,
          price: qf.price,
        };
        return { ...partial, rank: i + 1, thesis: this.writeThesis(partial) };
      });

      const RECOMMENDED_MIN = 15;
      const fundedCount = candidates.filter((c) => c.funded).length;
      const tooConcentrated = fundedCount > 0 && fundedCount < RECOMMENDED_MIN;
      const run: TurnaroundRun = {
        at: now,
        tradingDay: istParts(now).date,
        capital,
        universeSize: universe.length,
        measured,
        scored: scoredCount,
        candidates,
        rejected: rejected.sort((a, b) => a.symbol.localeCompare(b.symbol)),
        skipped: skipped.sort((a, b) => a.symbol.localeCompare(b.symbol)),
        totalIfAllTriggered: candidates.reduce((s, c) => s + c.entry.amount, 0),
        categoryCapPct: params.categoryCapPct,
        concentration: {
          fundedCount,
          recommendedMinimum: RECOMMENDED_MIN,
          tooConcentrated,
          note: tooConcentrated
            ? `${fundedCount} funded name${fundedCount === 1 ? '' : 's'} against the ${RECOMMENDED_MIN} a category with this ` +
              `failure rate really needs. Most large falls are never recovered, and no screen reliably tells you which ` +
              `in advance — the defence that works is owning enough of them, and a ₹${Math.round(capital).toLocaleString('en-IN')} ` +
              `account cannot. Treat every one of these as a single bet that can go to zero.`
            : fundedCount === 0
              ? 'Nothing is funded, so there is no concentration to worry about.'
              : `${fundedCount} funded names is inside the range this category needs.`,
        },
        sources: `${SOURCES} ${funding.note}`,
        evidence: EVIDENCE,
        disclaimer: DISCLAIMER,
      };

      if (opts.persist !== false) {
        this.last.set(userId, run);
        store.turnaroundRuns.set(`${userId}:${run.tradingDay}`, run);
      }
      logger.info(
        `Turnarounds for ${userId}: ${measured} measured, ${scoredCount} scored, ${candidates.length} qualified, ` +
          `₹${Math.round(run.totalIfAllTriggered).toLocaleString('en-IN')} if every trigger fires`,
      );
      return run;
    } finally {
      this.inFlight.delete(userId);
    }
  }
}

export const turnaroundEngine = new TurnaroundEngine();
