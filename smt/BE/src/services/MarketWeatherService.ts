/**
 * Market Weather, live: loads history, reads today's state, labels the news,
 * tracks the escalators, and alerts on a change. Read-only — it never places,
 * cancels or resizes an order. (The optional allocator hook in Phase 5 is a
 * separate, default-off setting that only ever slows NEW buying.)
 *
 * One snapshot is shared by all users; only the book exposure is per user.
 * Refresh: on boot (after a delay, so it never competes with the trading
 * engines' startup), then every 30 minutes. Daily history is disk-cached for
 * 6h, so most refreshes only re-read the cache, the news and the flows.
 */
import fs from 'node:fs';
import path from 'node:path';
import { broker } from '../brokers';
import { store } from '../store/memoryStore';
import { logger } from '../utils/logger';
import { notifier } from './Notifier';
import { marketEvents, nseDate } from './marketEvents';
import { DEFAULT_UNIVERSE } from './recommender/universe';
import { classify } from './recommender/sectors';
import { instrumentKind } from './instruments';
import calibrationJson from './marketWeather/calibration.json';
import type { Calibration, RuleCalibration } from './marketWeather/calibrate';
import { CACHE_DIR, loadSeries } from './marketWeather/data';
import {
  activeEvents,
  fetchMacroHeadlines,
  HISTORY_ALIAS,
  parseFiiDii,
  SECTOR_REPORTS,
  type ActiveEvent,
  type EventLabel,
  type EventMove,
  type FlowDay,
  type LabelHistory,
  type LabelledHeadline,
} from './marketWeather/events';
import { bookExposure, downBetaOf, type BookExposure, type Holding } from './marketWeather/exposure';
import { loadMarketHistory, prepareIndex, type MarketHistory, type PreparedIndex } from './marketWeather/history';
import { analogSpecFor, findAnalogs, readSignals, type Analogs, type SignalRead } from './marketWeather/odds';
import { stateAt, type MarketState } from './marketWeather/regime';
import type { SectorCalibration } from './marketWeather/sectors';
import { sectorLeaders, summarize, supportedSignals, type SectorLeaders, type Summary } from './marketWeather/summary';
import { fetchValuation, readValuation, type ValuationRead } from './marketWeather/valuation';
import { scoreStocks, type StockCalls } from './marketWeather/stockCalls';
import { verdictOf, type Verdict } from './marketWeather/verdict';

const cal = calibrationJson as unknown as Calibration;
const REFRESH_MS = 30 * 60_000;
const BOOT_DELAY_MS = 20_000;
const NEWS_TTL_MS = 30 * 60_000;
const FLOWS_FILE = path.join(CACHE_DIR, 'fiidii.json');
const ALERT_FILE = path.join(CACHE_DIR, 'alert-state.json');
const ALERT_QUIET_MS = 24 * 3_600_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

export interface WeatherEvent extends ActiveEvent {
  title: string;
  history: LabelHistory | null;
  /** Set when the history is borrowed from a related label. */
  historyFrom: EventLabel | null;
  hit: string;
  held: string;
}

export interface WeatherSnapshot {
  computedAt: number;
  verdict: Verdict;
  summary: Summary;
  state: MarketState;
  signals: SignalRead[];
  analogs: Analogs | null;
  valuation: ValuationRead | null;
  events: WeatherEvent[];
  headlines: LabelledHeadline[];
  escalation: {
    brent: number | null;
    brentDaysAbove90: number;
    brentDaysAbove100: number;
    flows: FlowDay[];
    fiiNet5d: number | null;
    diiNet5d: number | null;
  };
  sectors: Omit<SectorCalibration, 'episodes'>[];
  leaders: SectorLeaders;
  rules: RuleCalibration[];
  supportedSignals: string[];
  eventHistory: EventMove[];
  calibration: {
    index: string;
    from: string;
    to: string;
    split: string;
    baseline: Calibration['baseline'];
    priorReturn12m: Calibration['priorReturn'][number] | null;
    drawdowns: Calibration['drawdowns'];
    sectorFallsFrom: string | null;
  };
  health: {
    gauges: string[];
    stocks: number;
    failedStocks: number;
    breadthCoverage: number;
    newsErrors: string[];
    flowsError: string | null;
    historyLoadedAt: number;
  };
}

interface AlertState {
  level?: string;
  events?: string[];
  brentBand?: number;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}
function writeJson(file: string, v: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(v));
  } catch (e) {
    logger.warn(`market-weather write ${path.basename(file)}: ${e instanceof Error ? e.message : e}`);
  }
}

class MarketWeatherService {
  private history: MarketHistory | null = null;
  private nifty: PreparedIndex | null = null;
  private sensex: PreparedIndex | null = null;
  private snapshot: WeatherSnapshot | null = null;
  private news: { at: number; headlines: LabelledHeadline[]; errors: string[] } | null = null;
  private flowsError: string | null = null;
  private inflight: Promise<WeatherSnapshot | null> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;

  start(): void {
    const boot = setTimeout(() => void this.refresh(), BOOT_DELAY_MS);
    boot.unref?.();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get(): WeatherSnapshot | null {
    return this.snapshot;
  }

  status(): { ready: boolean; refreshing: boolean; lastError: string | null; computedAt: number | null } {
    return { ready: !!this.snapshot, refreshing: !!this.inflight, lastError: this.lastError, computedAt: this.snapshot?.computedAt ?? null };
  }

  /** One refresh at a time; concurrent callers share it. */
  refresh(opts: { force?: boolean } = {}): Promise<WeatherSnapshot | null> {
    if (!this.inflight) {
      this.inflight = this.doRefresh(opts)
        .catch((e) => {
          this.lastError = e instanceof Error ? e.message : String(e);
          logger.warn(`market-weather refresh failed: ${this.lastError}`);
          return this.snapshot;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  private async doRefresh(opts: { force?: boolean }): Promise<WeatherSnapshot | null> {
    const t0 = Date.now();
    this.history = await loadMarketHistory({ force: opts.force });
    this.nifty = prepareIndex(this.history, 'nifty');
    this.sensex = prepareIndex(this.history, 'sensex');
    if (!this.nifty) throw new Error('NIFTY 50 history unavailable');

    const [valuation, news, flows] = await Promise.all([fetchValuation(), this.loadNews(), this.updateFlows()]);
    const p = this.nifty.prepared;
    const state = stateAt(p, p.axis.length - 1);
    const signals = readSignals(cal, state);
    // Analogs on the Sensex: same definitions, twice the history.
    let analogs: Analogs | null = null;
    if (this.sensex) {
      const sp = this.sensex.prepared;
      analogs = findAnalogs(sp, analogSpecFor(stateAt(sp, sp.axis.length - 1)));
    }
    const supported = supportedSignals(cal);
    const leaders = sectorLeaders(cal);
    const summary = summarize(state, signals, analogs, 'NIFTY 50', supported, leaders, cal.levelAtHighs);

    const events: WeatherEvent[] = activeEvents(news.headlines).map((e) => ({
      ...e,
      headlines: e.headlines.slice(0, 4),
      title: SECTOR_REPORTS[e.label].title,
      history: cal.events?.find((h) => h.label === (HISTORY_ALIAS[e.label] ?? e.label)) ?? null,
      historyFrom: HISTORY_ALIAS[e.label] ?? null,
      hit: SECTOR_REPORTS[e.label].hit,
      held: SECTOR_REPORTS[e.label].held,
    }));
    const last5 = flows.slice(-5);
    const sum = (k: 'fiiNet' | 'diiNet'): number | null =>
      last5.length && last5.every((f) => f[k] != null) ? Math.round(last5.reduce((s, f) => s + f[k]!, 0)) : null;

    const snap: WeatherSnapshot = {
      computedAt: Date.now(),
      verdict: verdictOf(state, signals, supported, analogs, summary.level),
      summary,
      state,
      signals,
      analogs,
      valuation: readValuation(valuation, state.date) ?? null,
      events,
      headlines: news.headlines.slice(0, 30),
      escalation: {
        brent: state.brent,
        brentDaysAbove90: state.brentDaysAbove90,
        brentDaysAbove100: state.brentDaysAbove100,
        flows: flows.slice(-20),
        fiiNet5d: sum('fiiNet'),
        diiNet5d: sum('diiNet'),
      },
      sectors: (cal.sectors ?? []).map(({ episodes: _e, ...s }) => s),
      leaders,
      rules: cal.rules,
      supportedSignals: supported,
      eventHistory: cal.eventMoves ?? [],
      calibration: {
        index: cal.index,
        from: cal.from,
        to: cal.to,
        split: cal.split,
        baseline: cal.baseline,
        priorReturn12m: cal.priorReturn.find((x) => x.lookbackDays === 252) ?? null,
        drawdowns: cal.drawdowns,
        sectorFallsFrom: cal.sectorFallsFrom ?? null,
      },
      health: {
        gauges: Object.keys(this.history.gauges),
        stocks: this.history.stocks.size,
        failedStocks: this.history.failedStocks.length,
        breadthCoverage: state.breadthCoverage,
        newsErrors: news.errors,
        flowsError: this.flowsError,
        historyLoadedAt: this.history.loadedAt,
      },
    };
    this.snapshot = snap;
    this.lastError = null;
    logger.info(`market-weather: ${summary.headline} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    await this.alerts(snap);
    return snap;
  }

  private async loadNews(): Promise<{ headlines: LabelledHeadline[]; errors: string[] }> {
    if (this.news && Date.now() - this.news.at < NEWS_TTL_MS) return this.news;
    const r = await fetchMacroHeadlines(3);
    this.news = { at: Date.now(), ...r };
    return this.news;
  }

  /** NSE serves only the latest day; each refresh appends it, so history grows forward. */
  private async updateFlows(): Promise<FlowDay[]> {
    const saved = readJson<FlowDay[]>(FLOWS_FILE, []);
    try {
      const res = await fetch('https://www.nseindia.com/api/fiidiiTradeReact', {
        headers: { 'User-Agent': UA, Referer: 'https://www.nseindia.com/' },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const day = parseFiiDii(await res.json(), nseDate);
      if (!day) throw new Error('unreadable payload');
      const merged = [...saved.filter((f) => f.date !== day.date), day].sort((a, b) => a.date.localeCompare(b.date));
      writeJson(FLOWS_FILE, merged.slice(-750));
      this.flowsError = null;
      return merged;
    } catch (e) {
      this.flowsError = e instanceof Error ? e.message : String(e);
      return saved;
    }
  }

  /**
   * Alerts on a CHANGE only, remembered across restarts so a reboot does not
   * re-announce the same weather. Three triggers: the level moved, a new event
   * label became active, Brent crossed 30 or 60 sessions above $90.
   */
  private async alerts(snap: WeatherSnapshot): Promise<void> {
    const st = readJson<AlertState>(ALERT_FILE, {});
    const next: AlertState = { ...st };
    const lvl = snap.summary.level;
    if (st.level && st.level !== lvl) {
      await notifier.alert(lvl === 'severe' || lvl === 'stormy' ? 'warn' : 'info', `weather:level:${lvl}`, `Market Weather: ${snap.summary.headline}. ${snap.summary.note}`, ALERT_QUIET_MS);
    }
    next.level = lvl;
    const labels = snap.events.map((e) => e.label);
    const fresh = labels.filter((l) => !(st.events ?? []).includes(l));
    if (st.events && fresh.length) {
      for (const l of fresh) {
        const e = snap.events.find((x) => x.label === l)!;
        const h = e.history;
        const hist = h
          ? ` Past ${h.events} event(s) of this type: median first day ${h.medianFirstDayPct}%, worst within 60 days ${h.medianWorst60Pct}%.`
          : '';
        await notifier.alert('info', `weather:event:${l}`, `News: ${e.title} — "${e.headlines[0]?.title}".${hist}`, ALERT_QUIET_MS);
      }
    }
    next.events = labels;
    const band = snap.escalation.brentDaysAbove90 >= 60 ? 60 : snap.escalation.brentDaysAbove90 >= 30 ? 30 : 0;
    if (band > (st.brentBand ?? 0)) {
      await notifier.alert('warn', `weather:brent:${band}`, `Oil: Brent above $90 for ${snap.escalation.brentDaysAbove90} sessions. Past war shocks became real falls when oil stayed this high.`, ALERT_QUIET_MS);
    }
    next.brentBand = band;
    writeJson(ALERT_FILE, next);
  }

  /** Holdings: store positions plus accumulator open lots, the larger quantity per symbol. */
  holdingsFor(userId: string): Holding[] {
    const qty = new Map<string, { q: number; price: number }>();
    for (const p of store.positionsByUser(userId)) {
      if (p.quantity <= 0) continue;
      qty.set(p.symbol, { q: p.quantity, price: p.ltp || p.avgPrice });
    }
    for (const b of store.accumulatorBooksByUser(userId)) {
      const q = b.openLots.reduce((s, l) => s + l.quantity, 0);
      if (q <= 0) continue;
      const cur = qty.get(b.symbol);
      const price = cur?.price || b.lastPrice || b.openLots[b.openLots.length - 1].fillPrice;
      if (!cur || q > cur.q) qty.set(b.symbol, { q, price });
    }
    return [...qty].map(([symbol, v]) => ({ symbol, quantity: v.q, price: broker.getLtp(symbol) || v.price }));
  }

  /**
   * Stock-by-stock risk tags for the liquid universe plus everything this user
   * holds, scored against today's conditions and active news types.
   */
  async stocksFor(userId: string): Promise<StockCalls | null> {
    if (!this.history) return null;
    const held = new Set(this.holdingsFor(userId).map((h) => h.symbol));
    const symbols = [...new Set([...DEFAULT_UNIVERSE, ...held])];
    const inputs = [];
    for (const sym of symbols) {
      let s = this.history.stocks.get(sym);
      if (!s) s = (await loadSeries(`stk_${sym}`, `${sym}.NS`)) ?? undefined;
      inputs.push({ symbol: sym, sector: this.sectorOf(sym), series: s, surveillance: marketEvents.surveillance(sym), held: held.has(sym) });
    }
    return scoreStocks(this.history.gauges.nifty!, inputs, cal, this.snapshot?.events.map((e) => e.label) ?? []);
  }

  private sectorOf(sym: string): string {
    const c = classify(sym, this.history!.sectors).sector;
    if (c !== 'Unclassified') return c;
    return instrumentKind(sym) === 'ETF' ? (/GOLD/i.test(sym) ? 'Gold ETF' : 'Index / other ETF') : c;
  }

  async exposureFor(userId: string): Promise<BookExposure | null> {
    if (!this.history || !this.nifty) return null;
    const holdings = this.holdingsFor(userId);
    const index = this.history.gauges.nifty!;
    const betas = new Map<string, number | null>();
    for (const h of holdings) {
      let s = this.history.stocks.get(h.symbol);
      if (!s) s = (await loadSeries(`stk_${h.symbol}`, `${h.symbol}.NS`)) ?? undefined;
      betas.set(h.symbol, downBetaOf(index, s));
    }
    const shocks: EventLabel[] = this.snapshot?.events.map((e) => e.label) ?? [];
    return bookExposure(holdings, (s) => betas.get(s) ?? null, (s) => this.sectorOf(s), shocks);
  }
}

export const marketWeather = new MarketWeatherService();
