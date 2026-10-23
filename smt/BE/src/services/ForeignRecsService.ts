/**
 * Foreign stocks: recommendations among US-listed companies (the S&P 500 plus
 * large foreign ADRs) for an Indian investor buying through LRS.
 *
 * Read-only, own use. One snapshot for all users, rebuilt on boot (after a
 * delay) and every 12 hours. The point-in-time backtest is heavy, so its result
 * is kept on disk and recomputed weekly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger';
import { loadAllBars, loadBars } from './foreign/candles';
import { loadFundamentals, qualityAt, scoreQuality, type QualityScore } from './foreign/fundamentals';
import { runForeignBacktest, type ForeignBacktest } from './foreign/backtest';
import { measureAt, MAX_PER_SECTOR, pickNextTier, pickTop, scoreForeign, type ForeignScore } from './foreign/score';
import { loadForeignUniverse, type ForeignStock } from './foreign/universe';
import { loadRaw } from './global/data';
import { INVESTING_ABROAD_FACTS } from './global/access';
import type { Candle } from '../types';
import type { Metrics } from './recommender/metrics';
import type { Headline } from './recommender/news';
import { loadQuarterly, type QuarterRead } from './foreign/quarterly';
import { loadEarningsCalendar, loadNasdaq, type AnalystView, type NasdaqRead } from './foreign/nasdaq';
import { loadSecEvents, type SecEvent } from './foreign/secEvents';
import { loadMarketHeadlines, loadUsNews } from './foreign/usNews';
import { analystUpside, daysTo, EARNINGS_WAIT_DAYS, levelsFor, outlookFor, readyNow, whyLines, type Levels, type Outlook, type WhyLine } from './foreign/plan';
import { runHorizonStudy, targetsFor, type HorizonStudy, type HorizonTarget } from './foreign/horizons';
import { bounceFeatures, bounceScore, bounceVerdict, businessClean, DEEP_FALL, SECTION_CAP_PCT, type BounceFeatures } from './foreign/bounce';
import { runBounceBacktest, type BounceBacktest } from './foreign/bounceBacktest';

const REFRESH_MS = 12 * 3_600_000;
const BOOT_DELAY_MS = 90_000;
const BT_FILE = path.join(process.cwd(), '.cache', 'foreign', 'backtest.json');
const BT_TTL_MS = 7 * 86_400_000;
const BOUNCE_BT_FILE = path.join(process.cwd(), '.cache', 'foreign', 'bounce-backtest.json');
const HORIZON_FILE = path.join(process.cwd(), '.cache', 'foreign', 'horizon-study.json');
/** Sector ETFs for the market panel (SPDR Select Sector funds), and the S&P 500 itself. */
const SECTOR_ETFS: [string, string][] = [
  ['SPY', 'S&P 500'], ['XLK', 'Information Technology'], ['XLF', 'Financials'], ['XLV', 'Health Care'], ['XLE', 'Energy'],
  ['XLI', 'Industrials'], ['XLY', 'Consumer Discretionary'], ['XLP', 'Consumer Staples'], ['XLC', 'Communication Services'],
  ['XLU', 'Utilities'], ['XLB', 'Materials'], ['XLRE', 'Real Estate'],
];
export const TOP_PICKS = 20;
/** Typical dip within a month, in ATRs: the median found across 189k observations (WARNING_ENGINE.md). */
const DIP_ATR = 1.75;

export interface ForeignRow {
  ticker: string;
  name: string;
  sector: string;
  country: string;
  kind: ForeignStock['kind'];
  priceUsd: number;
  priceInr: number | null;
  ret12mUsd: number | null;
  ret12mInr: number | null;
  ret6mUsd: number | null;
  volPct: number;
  fromHighPct: number;
  typicalDipPct: number | null;
  score: number;
  verdict: ForeignScore['verdict'];
  vetoed: boolean;
  vetoReason: string | null;
  /** The three signals that contributed most, in plain words with their percentile. */
  why: { label: string; percentile: number }[];
  quality: QualityScore | null;
  /** Rank in the momentum list (1–20 top picks, 21–40 second tier); absent elsewhere. */
  rank?: number;
  tier?: 1 | 2;
  /** Plan, reasons, analysts, news and filings: on picks and bounce-backs only. */
  detail?: RowDetail;
}

export interface RowDetail {
  levels: Levels;
  reasons: WhyLine[];
  analyst: (AnalystView & { upside: number | null }) | null;
  earningsDate: string | null;
  /** Earnings within 7 days: wait until after results. */
  earningsSoon: boolean;
  news: { headlines: Headline[]; sentiment: number; scored: number; veto: boolean; note: string; offTopic: number } | null;
  /** 8-K events in 90 days, newest first (null for ADRs, which do not file 8-Ks). */
  events: SecEvent[] | null;
  /** Why new money is held back on this name right now (news veto or red filing), or null. Never changes the rank. */
  withheld: string | null;
  quarter: QuarterRead | null;
  /** Short / intermediate / long targets from what past top picks did (top picks only; empty for bounce-backs). */
  targets: HorizonTarget[];
  /** Why suggested, why it may keep rising, risks (momentum picks only). */
  outlook?: Outlook;
}

export interface BounceRow extends ForeignRow {
  fallPct: number;
  bounceScore: number;
  flags: string[];
  /** Passes the business checks too (profitable, finances not weak). */
  clean: boolean;
  deep: boolean;
}

export interface MarketPanel {
  sectors: { ticker: string; name: string; ret1d: number | null; ret1w: number | null; ret1m: number | null }[];
  headlines: Headline[];
}

export interface ForeignSnapshot {
  computedAt: number;
  asOf: string;
  usdInr: number | null;
  usdInr12m: number | null;
  picks: ForeignRow[];
  /** Best two per sector among the recommended, for spreading money across sectors. */
  bySector: Record<string, ForeignRow[]>;
  adrs: ForeignRow[];
  /** The largest, best-known names that are currently NOT recommended, with why. */
  avoid: ForeignRow[];
  counts: { universe: number; measured: number; eligible: number; junk: number; downtrend: number; noFundamentals: number };
  backtest: ForeignBacktest | null;
  /** Fallen 20–75% and turned up. A watch-list unless its backtest passed check B3. */
  bounce: { qualified: BounceRow[]; rejected: { ticker: string; name: string; fallPct: number; reason: string }[]; capPct: number; funded: boolean };
  bounceBacktest: BounceBacktest | null;
  /** How past top picks did over 1, 6 and 12 months; the source of every horizon target. */
  horizonStudy: HorizonStudy | null;
  /** Top picks with nothing to wait for, in rank order, and the higher-ranked ones skipped. */
  startHere: { ready: string[]; skipped: { ticker: string; why: string }[] };
  /** Ranks 21–40: the second tier, shown in "Start here" after the top 20. */
  more: ForeignRow[];
  market: MarketPanel;
  facts: string[];
  health: { failed: string[] };
}

const back = (b: Candle[], days: number): number | null => {
  const t = b[b.length - 1].timestamp - days * 86_400_000;
  for (let k = b.length - 1; k >= 0; k--) if (b[k].timestamp <= t) return b[k].close;
  return null;
};

class ForeignRecsService {
  private snap: ForeignSnapshot | null = null;
  private inflight: Promise<ForeignSnapshot | null> | null = null;
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
  get(): ForeignSnapshot | null {
    return this.snap;
  }
  status(): { ready: boolean; refreshing: boolean; lastError: string | null } {
    return { ready: !!this.snap, refreshing: !!this.inflight, lastError: this.lastError };
  }

  refresh(opts: { force?: boolean; rebuildBacktest?: boolean } = {}): Promise<ForeignSnapshot | null> {
    if (!this.inflight) {
      this.inflight = this.build(opts)
        .then((s) => {
          this.snap = s;
          this.lastError = null;
          return s;
        })
        .catch((e) => {
          this.lastError = e instanceof Error ? e.message : String(e);
          logger.warn(`foreign recs refresh failed: ${this.lastError}`);
          return this.snap;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  private async build(opts: { force?: boolean; rebuildBacktest?: boolean }): Promise<ForeignSnapshot> {
    const universe = await loadForeignUniverse();
    const { bars, failed } = await loadAllBars(universe.map((u) => u.ticker), { force: opts.force });
    const fundamentals = await loadFundamentals({ force: opts.force });
    const inr = await loadRaw('INR=X', { force: opts.force });
    const usdInr = inr ? inr.close[inr.close.length - 1] : null;
    const inr12 = inr && inr.close.length > 260 ? inr.close[inr.close.length - 1] / inr.close[inr.close.length - 253] - 1 : null;
    const byTicker = new Map(universe.map((u) => [u.ticker, u] as const));
    const sectors = new Map(universe.map((u) => [u.ticker, u.sector] as const));

    const metrics: Metrics[] = [];
    for (const u of universe) {
      const b = bars.get(u.ticker);
      if (!b) continue;
      const m = measureAt(u.ticker, b);
      if (m) metrics.push(m);
    }
    const today = new Date().toISOString().slice(0, 10);
    const syms = metrics.map((m) => m.symbol);
    const qs = scoreQuality(
      syms.map((s) => {
        const u = byTicker.get(s)!;
        return qualityAt(u.cik ? fundamentals.get(u.cik) : undefined, today, u.sector === 'Financials');
      }),
    );
    const quality = new Map(syms.map((s, i) => [s, qs[i]] as const));
    // Ranked WITHOUT the junk veto (it failed the backtest); weak finances ride along as a flag.
    const scored = scoreForeign(metrics, sectors, quality, { vetoJunk: false });
    const mBy = new Map(metrics.map((m) => [m.symbol, m] as const));

    const rowOf = (s: ForeignScore): ForeignRow => {
      const u = byTicker.get(s.symbol)!;
      const m = mBy.get(s.symbol)!;
      const b = bars.get(s.symbol)!;
      const p = b[b.length - 1].close;
      const r12 = back(b, 365);
      const r6 = back(b, 182);
      const ret12mUsd = r12 ? p / r12 - 1 : null;
      return {
        ticker: s.symbol,
        name: u.name,
        sector: u.sector,
        country: u.country,
        kind: u.kind,
        priceUsd: p,
        priceInr: usdInr ? p * usdInr : null,
        ret12mUsd,
        ret12mInr: ret12mUsd != null && inr12 != null ? (1 + ret12mUsd) * (1 + inr12) - 1 : null,
        ret6mUsd: r6 ? p / r6 - 1 : null,
        volPct: m.volAnnualPct,
        fromHighPct: m.fromHighPct,
        typicalDipPct: m.atrPct != null ? Math.round(m.atrPct * DIP_ATR * 10) / 10 : null,
        score: Math.round(s.score * 10) / 10,
        verdict: s.verdict,
        vetoed: s.vetoed,
        vetoReason: s.vetoReason ?? null,
        why: s.signals.slice(0, 3).map((x) => ({ label: x.label, percentile: Math.round(x.percentile * 100) })),
        quality: s.quality,
      };
    };
    const eligible = scored.filter((s) => !s.vetoed);
    const picks = pickTop(scored, TOP_PICKS, sectors, MAX_PER_SECTOR).map(rowOf);
    const bySector: Record<string, ForeignRow[]> = {};
    for (const s of eligible) {
      const sec = byTicker.get(s.symbol)!.sector;
      if ((bySector[sec] ??= []).length < 2) bySector[sec].push(rowOf(s));
    }
    const adrs = scored.filter((s) => byTicker.get(s.symbol)?.kind === 'adr').map(rowOf);
    // Best-known names: the 40 most traded. Those vetoed are the "not now" list.
    const big = [...metrics].sort((a, b) => b.medianTurnover - a.medianTurnover).slice(0, 40).map((m) => m.symbol);
    const avoid = scored.filter((s) => s.vetoed && big.includes(s.symbol)).map(rowOf);

    // ---- v2: plans, reasons, analysts, filings, news (FOREIGN_RECS_PLAN_V2.md) ----
    const quarterly = await loadQuarterly({ force: opts.force });
    const horizonStudy = await this.horizonStudyCached(bars, universe, fundamentals, opts.rebuildBacktest === true);
    const calendar = await loadEarningsCalendar(EARNINGS_WAIT_DAYS + 3).catch(() => new Map<string, string>());
    const enrich = async (row: ForeignRow, kind: 'momentum' | 'bounce', signals: { label: string; percentile: number }[], fall?: number, tier: 1 | 2 = 1): Promise<RowDetail> => {
      const u = byTicker.get(row.ticker)!;
      const m = mBy.get(row.ticker)!;
      const q = u.cik ? quarterly.get(u.cik) ?? null : null;
      const nasdaq: NasdaqRead | null = await loadNasdaq(row.ticker).catch(() => null);
      const sec = u.cik ? await loadSecEvents(u.cik).catch(() => null) : null;
      const news = await loadUsNews(u.name, row.ticker).catch(() => null);
      const earningsDate = calendar.get(row.ticker) ?? null;
      const dTo = daysTo(earningsDate ?? undefined, today);
      const red = sec?.red[0];
      return {
        levels: levelsFor(m, kind),
        reasons: whyLines({ kind, m, signals, fall, ret12m: row.ret12mUsd, q, quality: row.quality, nasdaq }),
        analyst: nasdaq?.analyst ? { ...nasdaq.analyst, upside: analystUpside(nasdaq, row.priceUsd) } : null,
        earningsDate,
        earningsSoon: dTo != null && dTo >= 0 && dTo <= EARNINGS_WAIT_DAYS,
        news: news ? { headlines: news.headlines, sentiment: news.sentiment, scored: news.scored, veto: news.veto, note: news.note, offTopic: news.offTopic } : null,
        events: sec ? sec.events.slice(0, 8) : null,
        withheld: red ? `SEC filing on ${red.date}: ${red.text}` : news?.veto ? 'mostly negative headlines this week (news veto)' : null,
        quarter: q,
        targets: kind === 'momentum' ? targetsFor(row.priceUsd, m.volAnnualPct, horizonStudy, tier) : [],
      };
    };
    const scoreBy = new Map(scored.map((x) => [x.symbol, x] as const));
    const sigsOf = (t: string) => (scoreBy.get(t)?.signals ?? []).slice(0, 3).map((x) => ({ label: x.label, percentile: Math.round(x.percentile * 100) }));
    const more = pickNextTier(scored, new Set(picks.map((p) => p.ticker)), TOP_PICKS, sectors, MAX_PER_SECTOR).map(rowOf);
    for (const [list, tier, offset] of [[picks, 1, 0], [more, 2, TOP_PICKS]] as const) {
      for (let k = 0; k < list.length; k++) {
        const p = list[k];
        p.rank = offset + k + 1;
        p.tier = tier;
        p.detail = await enrich(p, 'momentum', sigsOf(p.ticker), undefined, tier);
      }
    }
    // The case for each pick, written once every name is enriched (sector crowding needs the shown list).
    const startHere = readyNow([...picks, ...more]);
    const shownReady = new Set(startHere.ready);
    for (const list of [picks, more]) {
      for (const p of list) {
        const pool = shownReady.has(p.ticker) ? [...picks, ...more].filter((x) => shownReady.has(x.ticker)) : list;
        const hist = horizonStudy ? (p.tier === 2 ? horizonStudy.stats2 : horizonStudy.stats)?.find((x) => x.key === 'long') ?? null : null;
        p.detail!.outlook = outlookFor({
          rank: p.rank!,
          tier: p.tier!,
          universe: metrics.length,
          sector: p.sector,
          ret12m: p.ret12mUsd,
          volPct: p.volPct,
          signals: sigsOf(p.ticker),
          q: p.detail!.quarter,
          quality: p.quality,
          nasdaq: await loadNasdaq(p.ticker).catch(() => null),
          analystUpside: p.detail!.analyst?.upside ?? null,
          earningsSoon: p.detail!.earningsSoon,
          history: hist,
          sectorPeers: pool.filter((x) => x.sector === p.sector).length,
        });
      }
    }

    // Bouncing back: every measured stock 20–75% below its high, minus the momentum names (a name is shown once).
    const pickSet = new Set([...picks, ...more].map((p) => p.ticker));
    const bounceQualified: BounceRow[] = [];
    const bounceRejected: ForeignSnapshot['bounce']['rejected'] = [];
    const feats = new Map<string, BounceFeatures>();
    for (const m of metrics) {
      if (pickSet.has(m.symbol)) continue;
      const f = bounceFeatures(bars.get(m.symbol)!);
      if (f) feats.set(m.symbol, f);
    }
    for (const [t, f] of feats) {
      const u = byTicker.get(t)!;
      const ctx = { quality: quality.get(t) ?? null, quarter: u.cik ? quarterly.get(u.cik) ?? null : null };
      let v = bounceVerdict(f, ctx);
      if (v.status === 'not-fallen') continue;
      if (v.status === 'rejected') {
        bounceRejected.push({ ticker: t, name: u.name, fallPct: f.fall, reason: v.reason! });
        continue;
      }
      // The momentum list's dollar eligibility applies here too.
      const mt = mBy.get(t)!;
      if (mt.lastClose < 5 || mt.medianTurnover < 20_000_000) continue;
      const row = rowOf(scoreBy.get(t)!);
      row.detail = await enrich(row, 'bounce', [], f.fall);
      const redEvent = row.detail.events?.find((e) => e.level === 'red');
      v = bounceVerdict(f, { ...ctx, redEvent: redEvent ? `${redEvent.text} (${redEvent.date})` : null, newsVeto: row.detail.news?.veto ?? false });
      if (v.status === 'rejected') {
        bounceRejected.push({ ticker: t, name: u.name, fallPct: f.fall, reason: v.reason! });
        continue;
      }
      bounceQualified.push({ ...row, fallPct: f.fall, bounceScore: bounceScore(ctx), flags: v.flags, clean: businessClean(v), deep: f.fall >= DEEP_FALL });
    }
    // Clean businesses first, then by finances and business direction. Never by depth.
    bounceQualified.sort((a, b) => Number(b.clean) - Number(a.clean) || b.bounceScore - a.bounceScore || a.ticker.localeCompare(b.ticker));
    const bounceBacktest = await this.bounceBacktestCached(bars, universe, fundamentals, opts.rebuildBacktest === true);
    const market = await this.marketPanel(opts.force);

    const backtest = await this.backtestCached(bars, universe, fundamentals, opts.rebuildBacktest === true);
    const asOf = metrics.reduce((a, m) => (m.asOf > a ? m.asOf : a), 0);
    logger.info(`foreign recs: ${picks.length} picks from ${metrics.length} stocks; top ${picks.slice(0, 5).map((p) => p.ticker).join(', ')}`);
    return {
      computedAt: Date.now(),
      asOf: asOf ? new Date(asOf).toISOString().slice(0, 10) : today,
      usdInr,
      usdInr12m: inr12,
      picks,
      bySector,
      adrs,
      avoid,
      counts: {
        universe: universe.length,
        measured: metrics.length,
        eligible: eligible.length,
        junk: scored.filter((s) => s.quality?.junk).length,
        downtrend: metrics.filter((m) => !m.aboveSma200).length,
        noFundamentals: syms.filter((s) => quality.get(s)?.score == null).length,
      },
      backtest,
      bounce: {
        qualified: bounceQualified.slice(0, 15),
        rejected: bounceRejected.sort((a, b) => a.fallPct - b.fallPct).slice(0, 40),
        capPct: SECTION_CAP_PCT,
        funded: bounceBacktest?.passed ?? false,
      },
      bounceBacktest,
      horizonStudy,
      startHere,
      more,
      market,
      facts: INVESTING_ABROAD_FACTS,
      health: { failed },
    };
  }

  private async marketPanel(force?: boolean): Promise<MarketPanel> {
    const sectors: MarketPanel['sectors'] = [];
    for (const [t, name] of SECTOR_ETFS) {
      const b = await loadBars(t, { force });
      const r = (n: number) => (b && b.length > n ? b[b.length - 1].close / b[b.length - 1 - n].close - 1 : null);
      sectors.push({ ticker: t, name, ret1d: r(1), ret1w: r(5), ret1m: r(21) });
    }
    const headlines = await loadMarketHeadlines().catch(() => []);
    return { sectors, headlines };
  }

  private async horizonStudyCached(
    bars: Map<string, Candle[]>,
    universe: ForeignStock[],
    fundamentals: Map<number, import('./foreign/fundamentals').FiscalYear[]>,
    rebuild: boolean,
  ): Promise<HorizonStudy | null> {
    try {
      if (!rebuild && Date.now() - fs.statSync(HORIZON_FILE).mtimeMs < BT_TTL_MS) return JSON.parse(fs.readFileSync(HORIZON_FILE, 'utf8')) as HorizonStudy;
    } catch {
      /* not cached */
    }
    try {
      const s = runHorizonStudy({
        bars,
        sectors: new Map(universe.map((u) => [u.ticker, u.sector] as const)),
        ciks: new Map(universe.map((u) => [u.ticker, u.cik] as const)),
        added: new Map(universe.filter((u) => u.kind === 'sp500').map((u) => [u.ticker, u.added] as const)),
        fundamentals,
      });
      fs.mkdirSync(path.dirname(HORIZON_FILE), { recursive: true });
      // JSON has no Infinity: the last bucket's open upper bound is stored as null; bandFor treats null as open.
      fs.writeFileSync(HORIZON_FILE, JSON.stringify(s));
      return s;
    } catch (e) {
      logger.warn(`foreign horizon study: ${e instanceof Error ? e.message : e}`);
      try {
        return JSON.parse(fs.readFileSync(HORIZON_FILE, 'utf8')) as HorizonStudy;
      } catch {
        return null;
      }
    }
  }

  private async bounceBacktestCached(
    bars: Map<string, Candle[]>,
    universe: ForeignStock[],
    fundamentals: Map<number, import('./foreign/fundamentals').FiscalYear[]>,
    rebuild: boolean,
  ): Promise<BounceBacktest | null> {
    try {
      if (!rebuild && Date.now() - fs.statSync(BOUNCE_BT_FILE).mtimeMs < BT_TTL_MS) return JSON.parse(fs.readFileSync(BOUNCE_BT_FILE, 'utf8')) as BounceBacktest;
    } catch {
      /* not cached */
    }
    try {
      const bt = runBounceBacktest({
        bars,
        sectors: new Map(universe.map((u) => [u.ticker, u.sector] as const)),
        ciks: new Map(universe.map((u) => [u.ticker, u.cik] as const)),
        added: new Map(universe.filter((u) => u.kind === 'sp500').map((u) => [u.ticker, u.added] as const)),
        fundamentals,
      });
      fs.mkdirSync(path.dirname(BOUNCE_BT_FILE), { recursive: true });
      fs.writeFileSync(BOUNCE_BT_FILE, JSON.stringify(bt));
      return bt;
    } catch (e) {
      logger.warn(`foreign bounce backtest: ${e instanceof Error ? e.message : e}`);
      try {
        return JSON.parse(fs.readFileSync(BOUNCE_BT_FILE, 'utf8')) as BounceBacktest;
      } catch {
        return null;
      }
    }
  }

  private async backtestCached(
    bars: Map<string, Candle[]>,
    universe: ForeignStock[],
    fundamentals: Map<number, import('./foreign/fundamentals').FiscalYear[]>,
    rebuild: boolean,
  ): Promise<ForeignBacktest | null> {
    try {
      if (!rebuild && Date.now() - fs.statSync(BT_FILE).mtimeMs < BT_TTL_MS) return JSON.parse(fs.readFileSync(BT_FILE, 'utf8')) as ForeignBacktest;
    } catch {
      /* not cached */
    }
    try {
      const index = (await loadBars('^GSPC')) ?? undefined;
      const bt = runForeignBacktest({
        bars,
        sectors: new Map(universe.map((u) => [u.ticker, u.sector] as const)),
        ciks: new Map(universe.map((u) => [u.ticker, u.cik] as const)),
        added: new Map(universe.filter((u) => u.kind === 'sp500').map((u) => [u.ticker, u.added] as const)),
        fundamentals,
        index,
      });
      fs.mkdirSync(path.dirname(BT_FILE), { recursive: true });
      fs.writeFileSync(BT_FILE, JSON.stringify(bt));
      return bt;
    } catch (e) {
      logger.warn(`foreign backtest: ${e instanceof Error ? e.message : e}`);
      try {
        return JSON.parse(fs.readFileSync(BT_FILE, 'utf8')) as ForeignBacktest;
      } catch {
        return null;
      }
    }
  }
}

export const foreignRecs = new ForeignRecsService();
