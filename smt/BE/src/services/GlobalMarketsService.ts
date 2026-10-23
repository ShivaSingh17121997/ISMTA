/**
 * Global Markets: which countries' stock markets are strongest for an Indian
 * investor right now (in rupees), the leading companies inside them, how to
 * reach them from India, and whether following such a ranking has paid.
 *
 * Read-only and for the owner's own use. One snapshot shared by all users,
 * refreshed on boot (after a delay) and every 6 hours; daily history is
 * disk-cached for 12 hours, so most refreshes do no network work.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger';
import { runBacktest, type BacktestResult } from './global/backtest';
import { GLOBAL_CACHE_DIR, loadMany } from './global/data';
import { metricsOf, momentumScores, monthlyCorrelation, toInr, type Metrics } from './global/rank';
import { ACCESS_ROUTES, INDIA_ETFS, INVESTING_ABROAD_FACTS, parseAmfiNav, PREMIUM_WARN, type AccessRoute } from './global/access';
import { COUNTRIES, INR_PER_USD, type Country } from './global/universe';
import type { Series } from './marketWeather/series';

const REFRESH_MS = 6 * 3_600_000;
const AMFI_URL = 'https://portal.amfiindia.com/spages/NAVAll.txt';
const AMFI_FILE = path.join(GLOBAL_CACHE_DIR, 'navall.txt');
const AMFI_TTL_MS = 6 * 3_600_000;
const BOOT_DELAY_MS = 45_000;
export const TOP_MARKETS = 5;
export const LEADERS_PER_MARKET = 3;

export interface MarketRow {
  code: string;
  name: string;
  region: Country['region'];
  indexName: string;
  currency: string;
  score: number | null;
  rank: number | null;
  inr: Metrics | null;
  /** 12-month return in the local currency, to show what the currency did. */
  local12m: number | null;
  /** Correlation of monthly rupee returns with India over 5 years: lower = better diversifier. */
  corrWithIndia: number | null;
  access: AccessRoute | null;
}

export interface StockRow {
  ticker: string;
  name: string;
  country: string;
  countryName: string;
  score: number | null;
  inr: Metrics | null;
}

export interface EtfPremium {
  symbol: string;
  name: string;
  price: number | null;
  priceDate: string | null;
  nav: number | null;
  navDate: string | null;
  /** price ÷ NAV − 1: how much more than the holdings are worth you would pay. */
  premium: number | null;
  overpriced: boolean;
}

export interface GlobalSnapshot {
  computedAt: number;
  asOf: string;
  /** India-listed international ETFs: NSE price against AMFI's NAV. */
  etfs: EtfPremium[];
  premiumWarn: number;
  facts: string[];
  markets: MarketRow[];
  /** Top foreign markets by score, in an uptrend. */
  strongest: string[];
  leaders: Record<string, StockRow[]>;
  /** Strongest stocks across all covered markets, ranked together. */
  globalLeaders: StockRow[];
  backtest: BacktestResult;
  health: { tickers: number; failed: string[] };
}

class GlobalMarketsService {
  private snap: GlobalSnapshot | null = null;
  private inflight: Promise<GlobalSnapshot | null> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;

  start(): void {
    const t = setTimeout(() => void this.refresh(), BOOT_DELAY_MS);
    t.unref?.();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get(): GlobalSnapshot | null {
    return this.snap;
  }

  status(): { ready: boolean; refreshing: boolean; lastError: string | null } {
    return { ready: !!this.snap, refreshing: !!this.inflight, lastError: this.lastError };
  }

  refresh(opts: { force?: boolean } = {}): Promise<GlobalSnapshot | null> {
    if (!this.inflight) {
      this.inflight = this.build(opts)
        .then((s) => {
          this.snap = s;
          this.lastError = null;
          return s;
        })
        .catch((e) => {
          this.lastError = e instanceof Error ? e.message : String(e);
          logger.warn(`global markets refresh failed: ${this.lastError}`);
          return this.snap;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  private async build(opts: { force?: boolean }): Promise<GlobalSnapshot> {
    const tickers = [INR_PER_USD, ...COUNTRIES.flatMap((c) => [c.index, ...(c.fx ? [c.fx.ticker] : []), ...c.leaders.map((l) => l.ticker)])];
    const { series, failed } = await loadMany(tickers, { force: opts.force });
    const inrUsd = series.get(INR_PER_USD);
    if (!inrUsd) throw new Error('USD/INR history unavailable');
    const inrOf = (c: Country, s: Series): Series => toInr(s, c.fx ? series.get(c.fx.ticker) ?? null : null, c.fx, inrUsd, c.code === 'IN');

    const indexInr = new Map<string, Series>();
    for (const c of COUNTRIES) {
      const s = series.get(c.index);
      if (s) indexInr.set(c.code, inrOf(c, s));
    }
    const india = indexInr.get('IN');
    const covered = COUNTRIES.filter((c) => indexInr.has(c.code));
    const metrics = covered.map((c) => metricsOf(indexInr.get(c.code)!));
    const scores = momentumScores(metrics);
    const markets: MarketRow[] = covered.map((c, i) => ({
      code: c.code,
      name: c.name,
      region: c.region,
      indexName: c.indexName,
      currency: c.currency,
      score: scores[i],
      rank: null,
      inr: metrics[i],
      local12m: metricsOf(series.get(c.index)!)?.ret12m ?? null,
      corrWithIndia: india && c.code !== 'IN' ? monthlyCorrelation(indexInr.get(c.code)!, india) : null,
      access: ACCESS_ROUTES[c.code] ?? null,
    }));
    markets.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    markets.forEach((m, k) => (m.rank = m.score == null ? null : k + 1));
    const strongest = markets
      .filter((m) => m.code !== 'IN' && m.code !== 'US-TECH' && m.inr?.uptrend)
      .slice(0, TOP_MARKETS)
      .map((m) => m.code);

    // Leaders: each market's biggest companies, ranked inside that market, in rupees.
    const leaders: Record<string, StockRow[]> = {};
    const pooled: { row: StockRow; m: Metrics | null }[] = [];
    for (const c of covered) {
      if (!c.leaders.length) continue;
      const rows = c.leaders
        .map((l) => {
          const s = series.get(l.ticker);
          const inr = s ? metricsOf(inrOf(c, s)) : null;
          return { ticker: l.ticker, name: l.name, country: c.code, countryName: c.name, score: null as number | null, inr };
        })
        .filter((r) => r.inr);
      const sc = momentumScores(rows.map((r) => r.inr));
      rows.forEach((r, k) => (r.score = sc[k]));
      rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
      leaders[c.code] = rows;
      for (const r of rows) pooled.push({ row: { ...r }, m: r.inr });
    }
    const gsc = momentumScores(pooled.map((p) => p.m));
    pooled.forEach((p, k) => (p.row.score = gsc[k]));
    const globalLeaders = pooled
      .map((p) => p.row)
      .filter((r) => r.inr?.uptrend)
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
      .slice(0, 15);

    const candidates = covered.map((c) => c.code).filter((c) => c !== 'IN' && c !== 'US-TECH');
    const backtest = runBacktest(indexInr, {
      candidates,
      benchmarks: { india: 'IN', us: 'US' },
      mixes: [
        { id: 'in80us20', label: '80% India + 20% S&P 500', weights: { IN: 0.8, US: 0.2 } },
        { id: 'in70us30', label: '70% India + 30% S&P 500', weights: { IN: 0.7, US: 0.3 } },
        { id: 'in70fx30', label: '70% India + 30% all foreign markets', weights: { IN: 0.7, '*foreign': 0.3 } },
        { id: 'in50us50', label: '50% India + 50% S&P 500', weights: { IN: 0.5, US: 0.5 } },
      ],
    });
    const asOf = markets.reduce((a, m) => (m.inr && m.inr.asOf > a ? m.inr.asOf : a), '0000');
    const etfs = await this.etfPremiums(opts.force);
    logger.info(`global markets: strongest ${strongest.join(', ')} (${series.size} tickers, ${failed.length} failed)`);
    return {
      computedAt: Date.now(),
      asOf,
      etfs,
      premiumWarn: PREMIUM_WARN,
      facts: INVESTING_ABROAD_FACTS,
      markets,
      strongest,
      leaders,
      globalLeaders,
      backtest,
      health: { tickers: series.size, failed },
    };
  }

  /** AMFI's daily NAV file (about 1.5 MB), cached for 6 hours; the cached copy is kept if a refresh fails. */
  private async amfiNavs(force = false): Promise<Map<string, { nav: number; date: string }>> {
    let text: string | null = null;
    try {
      const st = fs.statSync(AMFI_FILE);
      if (!force && Date.now() - st.mtimeMs < AMFI_TTL_MS) text = fs.readFileSync(AMFI_FILE, 'utf8');
    } catch {
      text = null;
    }
    if (!text) {
      try {
        const res = await fetch(AMFI_URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = await res.text();
        fs.mkdirSync(GLOBAL_CACHE_DIR, { recursive: true });
        fs.writeFileSync(AMFI_FILE, text);
      } catch (e) {
        logger.warn(`AMFI NAV file: ${e instanceof Error ? e.message : e}`);
        try {
          text = fs.readFileSync(AMFI_FILE, 'utf8');
        } catch {
          text = '';
        }
      }
    }
    return parseAmfiNav(text);
  }

  /** Each India-listed international ETF's NSE price against its NAV. */
  private async etfPremiums(force = false): Promise<EtfPremium[]> {
    const navs = await this.amfiNavs(force);
    const { series } = await loadMany(INDIA_ETFS.map((e) => `${e.symbol}.NS`), { force });
    return INDIA_ETFS.map((e) => {
      const s = series.get(`${e.symbol}.NS`);
      const price = s ? s.close[s.close.length - 1] : null;
      const nav = navs.get(e.amfiCode);
      const premium = price != null && nav ? price / nav.nav - 1 : null;
      return {
        symbol: e.symbol,
        name: e.name,
        price,
        priceDate: s ? s.dates[s.dates.length - 1] : null,
        nav: nav?.nav ?? null,
        navDate: nav?.date ?? null,
        premium,
        overpriced: premium != null && premium > PREMIUM_WARN,
      };
    }).sort((a, b) => (a.premium ?? 9) - (b.premium ?? 9));
  }
}

export const globalMarkets = new GlobalMarketsService();
