import { EventEmitter } from 'events';
import { config } from '../config';
import { Candle, Tick } from '../types';
import { logger } from '../utils/logger';

/** A handful of liquid NSE symbols with rough seed prices (INR). */
const SEED_PRICES: Record<string, number> = {
  RELIANCE: 2950,
  TCS: 3850,
  INFY: 1520,
  HDFCBANK: 1650,
  ICICIBANK: 1180,
  SBIN: 825,
  // Tata Motors demerged in Oct 2025: passenger vehicles kept the original
  // listing as TMPV; the commercial-vehicle business relisted as TMCV on
  // 12 Nov 2025. TATAMOTORS is no longer an NSE symbol and Yahoo 404s it.
  TMPV: 400,
  TMCV: 330,
  WIPRO: 470,
  NIFTY: 23500,
  BANKNIFTY: 51000,
};

/**
 * Simulated market-data feed. In paper mode it generates a random-walk
 * tick for every tracked symbol on a fixed interval. A real deployment
 * would replace `start()` with a Zerodha KiteTicker WebSocket subscription
 * and emit the same `tick` events — every downstream consumer is unchanged.
 */
export class MarketDataService extends EventEmitter {
  private prices = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    for (const [sym, px] of Object.entries(SEED_PRICES)) this.prices.set(sym, px);
  }

  private liveMode = false;
  /**
   * Symbols whose price comes from an external feed (Yahoo, for accumulator
   * books on companies the simulator does not seed). The simulator must NOT
   * random-walk these, or a real ₹520 print becomes ₹519.73 a second later for
   * no reason and every decision downstream is made on noise.
   */
  private external = new Set<string>();
  /** When each symbol last received a real tick. A price with no recent tick is a stale price. */
  private lastTickAt = new Map<string, number>();
  /** Previous session close per symbol — the reference the exchange measures price bands from. */
  private reference = new Map<string, number>();
  /** `<source>:<symbol>` → when that feed last priced the symbol. */
  private sourceTickAt = new Map<string, number>();

  get symbols(): string[] {
    return [...this.prices.keys()];
  }

  /** Milliseconds since the last tick, or Infinity if the symbol never ticked. */
  quoteAge(symbol: string, now: number = Date.now()): number {
    const at = this.lastTickAt.get(symbol.toUpperCase());
    return at ? Math.max(0, now - at) : Number.POSITIVE_INFINITY;
  }

  /** Has ANY tick arrived? False in a unit test with seeded prices; true once a feed is live. */
  hasTicked(): boolean {
    return this.lastTickAt.size > 0;
  }

  setReference(symbol: string, previousClose: number): void {
    if (Number.isFinite(previousClose) && previousClose > 0) {
      this.reference.set(symbol.toUpperCase(), previousClose);
    }
  }

  /** Previous close, or 0 when unknown. */
  getReference(symbol: string): number {
    return this.reference.get(symbol.toUpperCase()) ?? 0;
  }

  /** True while prices come from the random-walk simulator (DATA_SOURCE=sim, or a failed Zerodha feed). */
  isSimulated(): boolean {
    return !this.liveMode;
  }

  /** Switch off the simulated generator; ticks now arrive via ingestTick(). */
  setLiveMode(enabled: boolean): void {
    this.liveMode = enabled;
    if (enabled) this.stop();
  }

  /** Register a tradable symbol (e.g. discovered from the Kite instrument list). */
  registerSymbol(symbol: string, seedPrice = 0): void {
    const sym = symbol.toUpperCase();
    if (!this.prices.has(sym)) this.prices.set(sym, seedPrice);
  }

  /**
   * Feed a real tick into the same pipeline the sim feed uses. `source` names
   * the feed ('kite', 'yahoo') so two feeds can tell which one is pricing a
   * symbol right now.
   */
  ingestTick(symbol: string, ltp: number, source?: string, printedAt?: number): void {
    const sym = symbol.toUpperCase();
    if (!Number.isFinite(ltp) || ltp <= 0) return;
    const now = Date.now();
    this.prices.set(sym, ltp);
    // A polled source reports when the exchange printed the price. Age is
    // measured from that, so a delayed or frozen feed reads as stale instead
    // of as fresh the moment we happened to poll it.
    this.lastTickAt.set(sym, printedAt && printedAt > 0 ? Math.min(now, printedAt) : now);
    if (source) this.sourceTickAt.set(`${source}:${sym}`, now);
    this.emit('tick', { symbol: sym, ltp, timestamp: now } as Tick);
  }

  /** Milliseconds since `source` last priced this symbol, or Infinity if it never has. */
  sourceAge(symbol: string, source: string, now: number = Date.now()): number {
    const at = this.sourceTickAt.get(`${source}:${symbol.toUpperCase()}`);
    return at ? Math.max(0, now - at) : Number.POSITIVE_INFINITY;
  }

  /** Feed a real price for a symbol the simulator must leave alone from now on. */
  ingestExternal(symbol: string, ltp: number, printedAt?: number): void {
    this.external.add(symbol.toUpperCase());
    this.ingestTick(symbol, ltp, 'yahoo', printedAt);
  }

  isExternal(symbol: string): boolean {
    return this.external.has(symbol.toUpperCase());
  }

  /**
   * Mark a symbol as having NO price. Used by the Yahoo feed when a fetch fails
   * on the first pass, so a seeded placeholder never masquerades as a real
   * print — ₹0 reads as "no data" and the paper broker refuses to fill on it.
   */
  markUnpriced(symbol: string): void {
    this.prices.set(symbol.toUpperCase(), 0);
  }

  getPrice(symbol: string): number {
    return this.prices.get(symbol.toUpperCase()) ?? 0;
  }

  getAllPrices(): Tick[] {
    const now = Date.now();
    return [...this.prices.entries()].map(([symbol, ltp]) => ({ symbol, ltp, timestamp: now }));
  }

  start(): void {
    if (this.liveMode) {
      logger.info('MarketDataService in LIVE mode — awaiting real ticks (no simulator)');
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => this.tickOnce(), config.sim.tickIntervalMs);
    logger.info(`MarketDataService started (simulated, ${config.sim.tickIntervalMs}ms)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tickOnce(): void {
    const now = Date.now();
    for (const [symbol, prev] of this.prices.entries()) {
      if (this.external.has(symbol)) continue; // real price; do not synthesise
      // Gaussian-ish shock via the central limit trick.
      const shock = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
      const next = Math.max(1, prev * (1 + shock * config.sim.volatility));
      const ltp = Math.round(next * 100) / 100;
      this.prices.set(symbol, ltp);
      this.lastTickAt.set(symbol, now);
      this.emit('tick', { symbol, ltp, timestamp: now } as Tick);
    }
  }

  /**
   * Deterministic-ish synthetic OHLC history for backtesting / charts.
   * Generates `count` candles ending now, spaced `intervalMs` apart.
   */
  generateHistory(symbol: string, count: number, intervalMs = 60_000): Candle[] {
    const sym = symbol.toUpperCase();
    const seed = SEED_PRICES[sym] ?? 1000;
    const candles: Candle[] = [];
    let price = seed * 0.85; // start below seed so there is a trend to find
    const start = Date.now() - count * intervalMs;
    for (let i = 0; i < count; i++) {
      const drift = 0.0002; // slight upward bias
      const shock = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
      const open = price;
      const close = Math.max(1, open * (1 + drift + shock * config.sim.volatility * 6));
      const high = Math.max(open, close) * (1 + Math.random() * 0.002);
      const low = Math.min(open, close) * (1 - Math.random() * 0.002);
      candles.push({
        symbol: sym,
        timestamp: start + i * intervalMs,
        open: round(open),
        high: round(high),
        low: round(low),
        close: round(close),
        volume: Math.floor(10000 + Math.random() * 90000),
      });
      price = close;
    }
    return candles;
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export const marketData = new MarketDataService();
