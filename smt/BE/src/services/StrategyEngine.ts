import { EventEmitter } from 'events';
import { config } from '../config';
import { marketData } from './MarketDataService';
import { orderManager } from './OrderManager';
import { store } from '../store/memoryStore';
import { getStrategy } from '../strategies';
import { atr } from '../strategies/indicators';
import { Candle, Signal, StrategyConfig } from '../types';
import { logger } from '../utils/logger';
import { checkStopAgainstCostFloor } from './costs';
import { canEnter } from './session';
import { effectiveStopPct, sizePosition } from './sizing';
import { fetchYahooCandles } from './yahoo';

interface SignalRecord extends Signal {
  strategyId: string;
  acted: boolean;
  blockedBy?: string;
}

export type SeedState = 'none' | 'seeding' | 'real' | 'synthetic' | 'failed';

/**
 * Drives live strategy execution (spec Phase 1).
 *
 * The candle buffer's LAST element is always the FORMING bar — it accumulates
 * ticks and is not yet closed. Strategies are evaluated on `closedCandles()`,
 * which excludes it.
 *
 * Two rules from the spec matter enormously and are easy to get wrong:
 *   1. Entries are evaluated ONLY on a closed candle's close. Never intra-bar.
 *      This prevents acting on a signal that un-prints before the bar closes,
 *      and it is what makes the live engine see the same data distribution the
 *      backtester does.
 *   2. Exits are NOT evaluated here. They run per-tick in OrderManager.onTick,
 *      so a stop can fire between bars.
 *
 * HISTORY IS REAL OR ABSENT. The buffer used to be seeded with a random walk
 * so indicators were "warm" the moment a strategy was enabled — which meant
 * that for the first 120 bars after every restart, every signal, stop and
 * target was computed on invented prices. One such signal decided at ₹1,050,
 * filled at ₹1,388, and was "stopped out" ten seconds later for a +₹4,820
 * phantom profit. Now a symbol is seeded from the feed's own history (Yahoo
 * one-minute bars), and until that arrives the strategy simply does not
 * evaluate. Only the offline simulator (DATA_SOURCE=sim) still synthesises.
 */
export class StrategyEngine extends EventEmitter {
  private candles = new Map<string, Candle[]>();
  private seedState = new Map<string, SeedState>();
  private signalHistory: SignalRecord[] = [];
  private readonly maxBuffer = 300;
  private readonly maxHistory = 200;
  private cycle = 0;

  /**
   * Make sure a symbol has a buffer and, if the feed is real, start seeding it
   * from real bars. Returns immediately; the seed lands in the background and
   * the symbol is skipped until it has.
   */
  ensureSymbol(symbol: string): void {
    const sym = symbol.toUpperCase();
    if (this.candles.has(sym)) return;
    this.candles.set(sym, []);
    if (config.dataSource === 'sim') {
      this.candles.set(sym, marketData.generateHistory(sym, 120, config.strategyBarMs));
      this.seedState.set(sym, 'synthetic');
      return;
    }
    this.seedState.set(sym, 'seeding');
    void this.seed(sym);
  }

  /** Real one-minute bars from the feed's history. Five days is ~1,875 bars; we keep the last 300. */
  private async seed(sym: string): Promise<void> {
    try {
      const bars = await fetchYahooCandles(sym, '5d', '1m');
      const recent = bars.filter((b) => b.close > 0).slice(-this.maxBuffer);
      if (recent.length < 30) {
        this.seedState.set(sym, 'failed');
        logger.warn(`Strategy history for ${sym}: only ${recent.length} real bars — not evaluating until the buffer fills from live ticks`);
        return;
      }
      // Only adopt the history if nothing has overwritten the buffer meanwhile
      // (a roll may have pushed a forming bar). Prepend the real bars to it.
      const current = this.candles.get(sym) ?? [];
      this.candles.set(sym, [...recent, ...current].slice(-this.maxBuffer));
      this.seedState.set(sym, 'real');
      logger.info(`Strategy history for ${sym}: seeded ${recent.length} real 1-minute bars (${new Date(recent[0].timestamp).toISOString().slice(0, 16)} → ${new Date(recent[recent.length - 1].timestamp).toISOString().slice(0, 16)})`);
      store.audit({ kind: 'engine', symbol: sym, detail: `strategy candle buffer seeded with ${recent.length} real bars` });
    } catch (e) {
      this.seedState.set(sym, 'failed');
      logger.warn(`Strategy history for ${sym} failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  seedStateOf(symbol: string): SeedState {
    return this.seedState.get(symbol.toUpperCase()) ?? 'none';
  }

  /** Append the latest tick price to the FORMING candle. */
  onTick(symbol: string, ltp: number): void {
    const sym = symbol.toUpperCase();
    const buf = this.candles.get(sym);
    // Guard the empty case too: this runs synchronously inside an EventEmitter
    // fan-out inside setInterval, so a TypeError here kills the process.
    if (!buf?.length) return;
    const last = buf[buf.length - 1];
    last.close = ltp;
    last.high = Math.max(last.high, ltp);
    last.low = Math.min(last.low, ltp);
  }

  /** History EXCLUDING the forming bar — the only thing an entry may look at. */
  private closedCandles(sym: string): Candle[] {
    const buf = this.candles.get(sym);
    if (!buf || buf.length < 2) return [];
    return buf.slice(0, -1);
  }

  /** Run one evaluation cycle over all enabled strategies. */
  async runCycle(): Promise<void> {
    this.cycle++;
    const now = Date.now();
    const enabled = store.enabledStrategies();

    // Ensure every buffer exists BEFORE rolling, so the forming bar is always
    // the last element for every tracked symbol.
    for (const cfg of enabled) for (const s of cfg.symbols) this.ensureSymbol(s);

    // Close the forming candle and open the next one.
    this.rollCandles();

    for (const cfg of enabled) {
      const strat = getStrategy(cfg.type);
      if (!strat) continue;
      for (const symbol of cfg.symbols) {
        const sym = symbol.toUpperCase();
        // A buffer that is still seeding, or whose seed failed, is not history.
        const seed = this.seedStateOf(sym);
        if (seed === 'seeding' || seed === 'failed' || seed === 'none') continue;
        const closed = this.closedCandles(sym);
        if (closed.length < strat.minCandles(cfg.params)) continue;

        const signal = strat.evaluate({ symbol: sym, candles: closed, params: cfg.params });
        if (signal.action === 'HOLD') continue;

        const rec: SignalRecord = { ...signal, strategyId: cfg.id, acted: false };

        // One position per symbol per strategy. DCA adds are driven by the
        // trailing engine on tick, not by a re-entry here.
        const holding = store
          .openTradesByUser(cfg.userId)
          .some((t) => t.symbol === sym && t.strategyId === cfg.id);

        if (!holding) {
          const blocked = this.entryBlockedBy(cfg, signal, now);
          if (blocked) {
            rec.blockedBy = blocked;
            logger.debug(`[${cfg.name}] ${signal.action} ${sym} blocked: ${blocked}`);
          } else {
            const res = await this.enter(cfg, signal, closed);
            rec.acted = res.ok;
            if (!res.ok) rec.blockedBy = res.reason;
            if (res.ok) logger.info(`[${cfg.name}] ${signal.action} ${sym} — ${signal.reason}`);
          }
        }

        this.pushSignal(rec);
        this.emit('signal', rec);
      }
    }
  }

  /**
   * Reasons an entry cannot be taken. ENTRIES ONLY — an open position always
   * exits normally regardless of any of this. A filter that can block an exit is
   * a capital-destroying bug, which is why all of it lives here and never in
   * OrderManager's exit path.
   */
  private entryBlockedBy(cfg: StrategyConfig, signal: Signal, now: number): string | null {
    // NSE session (see services/session.ts). The spec has no session concept —
    // it was written for 24/7 crypto — but on NSE the clock decides more than
    // the signal does near the open and the close.
    if (config.session.enabled) {
      const gate = canEnter(now);
      if (!gate.ok) return gate.reason ?? 'session closed';
    }

    // Spec Phase 3 — direction filter. Runtime-mutable.
    const direction = cfg.direction ?? config.ntb.direction;
    if (direction !== 'both') {
      const wanted = signal.action === 'BUY' ? 'long' : 'short';
      if (wanted !== direction) return `direction filter (${direction} only)`;
    }
    return null;
  }

  private exitModeFor(cfg: StrategyConfig): 'static' | 'trailing' {
    return cfg.exitMode ?? (cfg.type.startsWith('NTB_') ? 'trailing' : 'static');
  }

  /** Phases 4 + 5: lock the stop distance, then size the position off it. */
  private async enter(cfg: StrategyConfig, signal: Signal, closed: Candle[]) {
    const refPrice = closed[closed.length - 1].close;
    const trailing = this.exitModeFor(cfg) === 'trailing';
    // The gate compares this against the live quote before anything is sent.
    const withRef: Signal = { ...signal, referencePrice: signal.referencePrice ?? refPrice };

    if (!trailing) {
      // Original behaviour, untouched: fixed quantity and static SL/TP.
      return orderManager.placeFromSignal(withRef, cfg.userId, cfg.quantity, cfg.id);
    }

    // Phase 4 — stop distance, locked in at entry and carried for the trade's life.
    const stopPct = effectiveStopPct(atr(closed, config.ntb.atrPeriod), refPrice);

    // Phase 5 — size from THIS stop, not the config default. This coupling is the
    // whole point: a wider stop buys a smaller position, so the rupee risk per
    // trade stays constant across volatility regimes.
    const sized = sizePosition({
      price: refPrice,
      stopPct,
      fixedQuote: config.ntb.quoteOrderSize,
      riskPerTradePct: config.ntb.riskPerTradePct,
      referenceBalance: config.risk.capital,
      maxPositionQuote: config.ntb.maxPositionQuote,
    });

    if (sized.quantity < 1) {
      return { ok: false as const, reason: sized.reason ?? 'sized to 0 shares' };
    }

    // Phase 4 — a stop tighter than the round trip stops out on fees alone.
    checkStopAgainstCostFloor(signal.symbol, stopPct, refPrice, sized.quantity);

    logger.debug(
      `[${cfg.name}] sizing ${signal.symbol}: ${sized.quantity} sh @ ₹${refPrice.toFixed(2)} ` +
        `(₹${sized.notional.toFixed(0)}, ${sized.basis}-based, stop ${stopPct.toFixed(2)}%)`,
    );

    return orderManager.placeFromSignal(withRef, cfg.userId, sized.quantity, cfg.id, stopPct);
  }

  /** Close the forming candle on every tracked symbol and open the next. */
  private rollCandles(): void {
    for (const [sym, buf] of this.candles.entries()) {
      const px = marketData.getPrice(sym);
      if (!px) continue;
      buf.push({
        symbol: sym,
        timestamp: Date.now(),
        open: px,
        high: px,
        low: px,
        close: px,
        volume: 0,
      });
      if (buf.length > this.maxBuffer) buf.shift();
    }
  }

  getSignalHistory(strategyId?: string): SignalRecord[] {
    const all = [...this.signalHistory].reverse();
    return strategyId ? all.filter((s) => s.strategyId === strategyId) : all;
  }

  getCandles(symbol: string): Candle[] {
    return this.candles.get(symbol.toUpperCase()) ?? [];
  }

  /** Per-symbol buffer health, for the strategies page. */
  bufferStatus(): { symbol: string; seed: SeedState; bars: number }[] {
    return [...this.candles.entries()].map(([symbol, buf]) => ({
      symbol,
      seed: this.seedStateOf(symbol),
      bars: Math.max(0, buf.length - 1),
    }));
  }

  private pushSignal(rec: SignalRecord): void {
    this.signalHistory.push(rec);
    if (this.signalHistory.length > this.maxHistory) this.signalHistory.shift();
  }
}

export const strategyEngine = new StrategyEngine();
