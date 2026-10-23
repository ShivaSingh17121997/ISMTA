/**
 * Yahoo market-data feed — `DATA_SOURCE=yahoo`.
 *
 * Polls a real last-traded price for every tracked symbol and pushes it into
 * `marketData.ingestTick`, so every downstream consumer — the WebSocket
 * broadcast, the strategy engine, the paper broker's fills, the accumulator —
 * sees real prices through exactly the pipeline the simulator used to fill.
 * The simulator is switched off entirely in this mode.
 *
 * Tracked set, recomputed every pass: the watchlist seeds, every accumulator
 * book, every enabled strategy's symbols. Switch a company on and it is polled
 * from the next pass with no restart.
 *
 * Cadence follows the session: `yahoo.pollMs` while the market is open, a
 * slow heartbeat when it is closed — prices do not move, and hammering Yahoo
 * for a repeated close is how you get rate-limited before Monday's open.
 *
 * On the FIRST pass, a symbol Yahoo cannot price is marked UNPRICED (₹0) rather
 * than left on its seeded placeholder. A fake ₹2,950 for RELIANCE would look
 * exactly like a real one on every screen; a ₹0 says "no data" and the paper
 * broker refuses to fill against it.
 */
import { config } from '../config';
import { store } from '../store/memoryStore';
import { logger } from '../utils/logger';
import { marketData } from './MarketDataService';
import { isMarketOpen } from './session';
import { fetchYahooQuote } from './yahoo';

/** Pure: the union of everything that needs a price, upper-cased and sorted. */
export function trackedSymbols(
  base: readonly string[],
  books: ReadonlyArray<{ symbol: string }>,
  strategies: ReadonlyArray<{ symbols: string[] }>,
): string[] {
  const set = new Set<string>();
  const add = (s: string): void => {
    const u = s.trim().toUpperCase();
    if (u) set.add(u);
  };
  base.forEach(add);
  books.forEach((b) => add(b.symbol));
  strategies.forEach((s) => s.symbols.forEach(add));
  return [...set].sort();
}

export interface FeedStatus {
  source: 'yahoo';
  running: boolean;
  passes: number;
  lastPassAt: number | null;
  lastPassMs: number | null;
  tracked: string[];
  priced: number;
  unpriced: string[];
  failures: Record<string, number>;
  marketOpen: boolean;
  nextPollMs: number;
}

const CONCURRENCY = 4;
/** A symbol Kite has ticked within this window is Kite's; Yahoo leaves it alone. */
const KITE_FRESH_MS = 60_000;

class YahooFeed {
  private timer: NodeJS.Timeout | null = null;
  private passing = false;
  private running = false;
  private passes = 0;
  private lastPassAt: number | null = null;
  private lastPassMs: number | null = null;
  private failures: Record<string, number> = {};
  private unpriced = new Set<string>();

  symbols(): string[] {
    return trackedSymbols(
      marketData.symbols,
      [...store.accumulatorBooks.values()],
      store.enabledStrategies(),
    );
  }

  /** One full pass over the tracked set, `CONCURRENCY` symbols at a time. */
  async pass(): Promise<void> {
    if (this.passing) return; // a slow Yahoo must not stack passes
    this.passing = true;
    const started = Date.now();
    const symbols = this.symbols();
    const firstPass = this.passes === 0;
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < symbols.length) {
        const sym = symbols[cursor++];
        // A live Kite stream is already pricing this symbol. Polling Yahoo as
        // well would interleave a delayed print with a live one. Once Kite goes
        // quiet for KITE_FRESH_MS, Yahoo takes the symbol back automatically.
        // The first pass still runs, for the previous close.
        if (!firstPass && marketData.sourceAge(sym, 'kite') < KITE_FRESH_MS) continue;
        const quote = await fetchYahooQuote(sym);
        const ltp = quote?.ltp ?? null;
        if (quote && ltp !== null) {
          if (quote.previousClose) marketData.setReference(sym, quote.previousClose);
          if (firstPass || marketData.sourceAge(sym, 'kite') >= KITE_FRESH_MS) marketData.ingestTick(sym, ltp, 'yahoo', quote.quoteTime ?? undefined);
          this.unpriced.delete(sym);
          delete this.failures[sym];
        } else {
          this.failures[sym] = (this.failures[sym] ?? 0) + 1;
          if (firstPass || marketData.getPrice(sym) === 0) {
            marketData.markUnpriced(sym);
            this.unpriced.add(sym);
          }
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, symbols.length) }, worker));
    } finally {
      this.passes++;
      this.lastPassAt = Date.now();
      this.lastPassMs = this.lastPassAt - started;
      this.passing = false;
    }
    if (firstPass) {
      logger.info(
        `Yahoo feed: first pass priced ${symbols.length - this.unpriced.size}/${symbols.length} ` +
          `symbols in ${this.lastPassMs}ms` +
          (this.unpriced.size ? ` — unpriced: ${[...this.unpriced].join(', ')}` : ''),
      );
    }
  }

  private nextPollMs(): number {
    return isMarketOpen(Date.now()) ? config.yahoo.pollMs : config.yahoo.closedPollMs;
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.pass().finally(() => this.schedule());
    }, this.nextPollMs());
    this.timer.unref?.();
  }

  /**
   * Start polling. Awaits the first pass (bounded) so the API never serves the
   * seeded placeholder prices — by the time `listen` runs, prices are real or
   * explicitly ₹0.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const bounded = Promise.race([
      this.pass(),
      new Promise<void>((r) => setTimeout(r, config.yahoo.firstPassTimeoutMs)),
    ]);
    await bounded;
    logger.info(
      `Yahoo market data enabled — ${this.symbols().length} symbols, ` +
        `${config.yahoo.pollMs / 1000}s open / ${config.yahoo.closedPollMs / 1000}s closed`,
    );
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  getStatus(): FeedStatus {
    const tracked = this.symbols();
    return {
      source: 'yahoo',
      running: this.running,
      passes: this.passes,
      lastPassAt: this.lastPassAt,
      lastPassMs: this.lastPassMs,
      tracked,
      priced: tracked.filter((s) => marketData.getPrice(s) > 0).length,
      unpriced: [...this.unpriced].sort(),
      failures: { ...this.failures },
      marketOpen: isMarketOpen(Date.now()),
      nextPollMs: this.nextPollMs(),
    };
  }
}

export const yahooFeed = new YahooFeed();
