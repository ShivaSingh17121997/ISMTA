import { config } from '../config';
import { isKitePermissionError, kiteErrorMessage } from '../brokers/kiteMapping';
import { store } from '../store/memoryStore';
import { Candle } from '../types';
import { logger } from '../utils/logger';
import { marketData } from './MarketDataService';
import { trackedSymbols } from './YahooFeed';

/* eslint-disable @typescript-eslint/no-explicit-any */
// Loaded lazily so the app compiles/runs in sim mode even without the SDK installed.
// Typed loosely on purpose — the Kite SDK surface is wrapped behind this service.
let KiteConnect: any;
let KiteTicker: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sdk = require('kiteconnect');
  KiteConnect = sdk.KiteConnect;
  KiteTicker = sdk.KiteTicker;
} catch {
  /* SDK not installed — only an issue if a Zerodha feed or broker is used */
}

// Index tradingsymbols differ from our internal aliases.
const INDEX_ALIASES: Record<string, string> = {
  NIFTY: 'NIFTY 50',
  BANKNIFTY: 'NIFTY BANK',
};

const SYNC_EVERY_MS = 60_000;

/** Whose Kite session feeds the prices: the legacy .env token, or one user's paid-plan connection. */
export interface KiteFeedOwner {
  source: 'env' | 'user';
  userId: string | null;
  apiKey: string;
  accessToken: string;
}

export interface KiteFeedHooks {
  /** Kite rejected the session (06:00 IST, logged out elsewhere). */
  onExpired?: () => void;
  /** The key's plan has no market data (a free Personal key). */
  onDenied?: (reason: string) => void;
}

export interface KiteFeedStatus {
  active: boolean;
  source: 'env' | 'user' | null;
  ownerUserId: string | null;
  streaming: boolean;
  subscribed: number;
  lastTickAt: number | null;
  error: string | null;
}

/**
 * Kite market data: the KiteTicker WebSocket for live ticks and the REST client
 * for historical candles. Ticks go into the existing MarketDataService pipeline
 * via `ingestTick(…, 'kite')`, so strategies, the order manager and the
 * dashboard consume them with no other changes.
 *
 * Market data needs the PAID Kite Connect plan. It is started either from .env
 * (DATA_SOURCE=zerodha) or at runtime from a user's connected paid-plan key,
 * and can be stopped and restarted without a server restart. Yahoo keeps
 * polling underneath and skips only the symbols Kite is actively pricing, so a
 * dropped stream degrades to delayed prices rather than to no prices.
 *
 * This is the price feed only. Orders go through each user's own client in
 * BrokerConnectionService, never through this one.
 */
export class KiteService {
  private kc: any = null;
  private ticker: any = null;
  private owner: KiteFeedOwner | null = null;
  private hooks: KiteFeedHooks = {};
  private streaming = false;
  private lastTickAt: number | null = null;
  private error: string | null = null;
  /** Every NSE tradingsymbol → instrument token, from the day's instrument dump. */
  private instrumentTokens = new Map<string, number>();
  private symbolToToken = new Map<string, number>(); // internal symbol → instrument_token
  private tokenToSymbol = new Map<number, string>();
  private syncTimer: NodeJS.Timeout | null = null;

  get client(): any {
    return this.kc;
  }
  isConnected(): boolean {
    return !!this.kc;
  }
  get source(): 'env' | 'user' | null {
    return this.owner?.source ?? null;
  }
  get ownerUserId(): string | null {
    return this.owner?.userId ?? null;
  }

  /** Legacy path: DATA_SOURCE=zerodha with a token pasted into .env. */
  async startFromEnv(): Promise<boolean> {
    if (!config.zerodha.apiKey || !config.zerodha.accessToken) {
      logger.error('Zerodha creds missing — set ZERODHA_API_KEY + ZERODHA_ACCESS_TOKEN');
      logger.error('Generate a fresh daily token with: npm run kite:login');
      return false;
    }
    return this.start({
      source: 'env',
      userId: null,
      apiKey: config.zerodha.apiKey,
      accessToken: config.zerodha.accessToken,
    });
  }

  /** Start (or restart) the feed on one session. Resolves false when Kite refused it. */
  async start(owner: KiteFeedOwner, hooks: KiteFeedHooks = {}): Promise<boolean> {
    this.stop();
    if (!KiteConnect) {
      this.error = 'kiteconnect SDK not installed — run `npm install kiteconnect`';
      logger.error(this.error);
      return false;
    }
    const kc = new KiteConnect({ api_key: owner.apiKey });
    kc.setAccessToken(owner.accessToken);
    kc.setSessionExpiryHook(() => this.fail('Kite session expired', 'expired'));
    this.kc = kc;
    this.owner = owner;
    this.hooks = hooks;

    try {
      await this.loadInstruments();
    } catch (e) {
      this.fail(`Kite instrument list unavailable: ${kiteErrorMessage(e)}`, isKitePermissionError(e) ? 'denied' : 'other');
      return false;
    }
    this.startTicker();
    this.syncTimer = setInterval(() => this.syncSubscriptions(), SYNC_EVERY_MS);
    this.syncTimer.unref?.();
    logger.info(`Kite market data starting (${owner.source === 'env' ? '.env token' : `user ${owner.userId}`})`);
    return true;
  }

  stop(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    if (this.ticker) {
      const t = this.ticker;
      this.ticker = null;
      try {
        t.autoReconnect?.(false);
        t.disconnect?.();
      } catch {
        /* already closed */
      }
    }
    this.kc = null;
    this.owner = null;
    this.hooks = {};
    this.streaming = false;
    this.error = null;
    this.symbolToToken.clear();
    this.tokenToSymbol.clear();
  }

  private fail(reason: string, kind: 'expired' | 'denied' | 'other'): void {
    const hooks = this.hooks;
    logger.warn(`Kite market data stopped: ${reason}`);
    this.stop();
    this.error = reason;
    if (kind === 'expired') hooks.onExpired?.();
    if (kind === 'denied') hooks.onDenied?.(reason);
  }

  /** Load the NSE instrument dump. Symbols are resolved against it as they become tracked. */
  async loadInstruments(): Promise<void> {
    if (!this.kc) return;
    const instruments: any[] = await this.kc.getInstruments('NSE');
    this.instrumentTokens.clear();
    for (const inst of instruments ?? []) {
      if (inst?.tradingsymbol && inst.instrument_token) {
        this.instrumentTokens.set(String(inst.tradingsymbol), Number(inst.instrument_token));
      }
    }
    logger.info(`Kite instruments loaded: ${this.instrumentTokens.size} NSE`);
  }

  private wanted(): string[] {
    return trackedSymbols(marketData.symbols, [...store.accumulatorBooks.values()], store.enabledStrategies());
  }

  /**
   * Resolve newly tracked symbols and subscribe them, so a book switched on
   * mid-session streams within a minute instead of after a restart. Returns the
   * symbols Kite has no NSE instrument for (they stay on Yahoo).
   */
  syncSubscriptions(): string[] {
    const fresh: number[] = [];
    const missing: string[] = [];
    for (const sym of this.wanted()) {
      if (this.symbolToToken.has(sym)) continue;
      const token = this.instrumentTokens.get(INDEX_ALIASES[sym] ?? sym);
      if (!token) {
        missing.push(sym);
        continue;
      }
      this.symbolToToken.set(sym, token);
      this.tokenToSymbol.set(token, sym);
      fresh.push(token);
    }
    if (fresh.length && this.ticker && this.streaming) {
      this.ticker.subscribe(fresh);
      this.ticker.setMode(this.ticker.modeLTP, fresh);
    }
    return missing;
  }

  /** Connect the tick WebSocket and stream LTP into MarketDataService. */
  private startTicker(): void {
    if (!KiteTicker || !this.owner) return;
    const missing = this.syncSubscriptions();
    if (missing.length) logger.warn(`Kite: no NSE instrument for ${missing.join(', ')} — these stay on Yahoo`);

    const ticker = new KiteTicker({ api_key: this.owner.apiKey, access_token: this.owner.accessToken });
    this.ticker = ticker;
    ticker.autoReconnect?.(true, 50, 60);

    ticker.on('connect', () => {
      if (this.ticker !== ticker) return;
      this.streaming = true;
      this.error = null;
      const tokens = [...this.tokenToSymbol.keys()];
      if (tokens.length) {
        ticker.subscribe(tokens);
        ticker.setMode(ticker.modeLTP, tokens);
      }
      logger.info(`KiteTicker connected — subscribed to ${tokens.length} instruments`);
    });
    ticker.on('ticks', (ticks: any[]) => {
      if (this.ticker !== ticker) return;
      const now = Date.now();
      for (const t of ticks) {
        const sym = this.tokenToSymbol.get(t.instrument_token);
        if (sym && t.last_price) {
          marketData.ingestTick(sym, t.last_price, 'kite');
          this.lastTickAt = now;
        }
      }
    });
    ticker.on('error', (e: any) => {
      if (this.ticker !== ticker) return;
      const msg = kiteErrorMessage(e);
      // A key without the paid plan is refused at the WebSocket upgrade. Retrying
      // cannot fix that, so stop instead of reconnecting forever.
      if (isKitePermissionError(e) || /\b403\b/.test(msg)) {
        this.fail(`Kite refused the live price stream (${msg}). A free Personal-plan key has no market data.`, 'denied');
        return;
      }
      this.error = `KiteTicker: ${msg}`;
      logger.error(this.error);
    });
    ticker.on('close', () => {
      if (this.ticker !== ticker) return;
      this.streaming = false;
      logger.warn('KiteTicker disconnected');
    });
    ticker.on('noreconnect', () => {
      if (this.ticker !== ticker) return;
      this.streaming = false;
      this.error = this.error ?? 'KiteTicker gave up reconnecting';
    });
    ticker.on('reconnect', (n: number) => logger.info(`KiteTicker reconnecting (#${n})`));
    ticker.connect();
  }

  /** Fetch real historical candles for backtesting / charts. Empty on any failure — the caller falls back. */
  async getHistorical(symbol: string, interval = 'minute', days = 5): Promise<Candle[]> {
    const sym = symbol.toUpperCase();
    const token = this.symbolToToken.get(sym) ?? this.instrumentTokens.get(INDEX_ALIASES[sym] ?? sym);
    if (!this.kc || !token) return [];
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    try {
      const rows: any[] = await this.kc.getHistoricalData(token, interval, from, to);
      return rows.map((r) => ({
        symbol: sym,
        timestamp: new Date(r.date).getTime(),
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume ?? 0,
      }));
    } catch (e) {
      logger.warn(`Kite historical ${sym}: ${kiteErrorMessage(e)}`);
      return [];
    }
  }

  status(): KiteFeedStatus {
    return {
      active: !!this.kc,
      source: this.source,
      ownerUserId: this.ownerUserId,
      streaming: this.streaming,
      subscribed: this.tokenToSymbol.size,
      lastTickAt: this.lastTickAt,
      error: this.error,
    };
  }

  exchangeSymbol(symbol: string): string {
    return `NSE:${symbol.toUpperCase()}`;
  }
}

export const kiteService = new KiteService();
