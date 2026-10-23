import { config } from '../config';
import { getStrategy } from '../strategies';
import { atr } from '../strategies/indicators';
import {
  adversePath,
  cappedStopFill,
  openTrailing,
  TrailingConfig,
  TrailingPosition,
  updateTrailing,
} from '../strategies/trailingStop';
import { BacktestResult, Candle, ExitMode, ExitReason, OrderSide } from '../types';
import { applySlippage, autoSquareOffCharge, charges, checkStopAgainstCostFloor } from './costs';
import { roundToTick } from './nse';
import { canEnter, isMarketOpen, mustFlatten, pastSquareOff } from './session';
import { effectiveStopPct, sizePosition } from './sizing';
import { resolveTrailingConfig } from './trailingConfig';

export interface BacktestParams {
  strategyType: string;
  symbol: string;
  params?: Record<string, number>;
  candles: Candle[];
  startingCapital?: number;
  quantity?: number;
  /** defaults to 'trailing' for NTB_* types, 'static' otherwise */
  exitMode?: ExitMode;
  /**
   * Apply NSE session rules (entry window, 15:10 flatten, square-off penalty).
   * Auto-detected from the candle timestamps when omitted — real NSE bars get
   * session realism; the 24/7 random-walk simulator does not, since applying
   * trading hours to synthetic timestamps would simply produce zero trades.
   */
  enforceSession?: boolean;
}

/** The metrics that matter for ranking, without the heavy arrays. */
export type OptimizeMetrics = Omit<BacktestResult, 'equityCurve' | 'tradeLog'>;

export interface OptimizeResult {
  params: Record<string, number>;
  /** fitted on the first slice */
  train: OptimizeMetrics;
  /** measured on the held-out slice — this is what the ranking uses */
  test: OptimizeMetrics;
  /** train.expectancy − test.expectancy; large positive = the edge did not survive */
  decayPct: number;
}

function strip(r: BacktestResult): OptimizeMetrics {
  const { equityCurve: _e, tradeLog: _t, ...rest } = r;
  return rest;
}

interface OpenPos extends TrailingPosition {
  side: OrderSide;
  entryPrice: number;
  quantity: number;
  stopLoss?: number;
  takeProfit?: number;
  openedAt: number;
  entryCharges: number;
}

/**
 * Candle-based backtester.
 *
 * Runs the SAME exit engine as live (strategies/trailingStop.ts) over each bar's
 * price path, ADVERSE EXTREME FIRST — walking `low` before `high` on a long, so a
 * bar that touched both the stop and the trailing level is scored as a stop-out,
 * not a win. That single ordering is what keeps results honest instead of
 * optimistic.
 *
 * Known fidelity limits, stated rather than hidden:
 *  - Entries fill at the same close that generated the signal (+ slippage). This
 *    is the NTB spec's own model, kept for parity; it is not future leakage, but
 *    it is not perfectly realisable either — the earliest true fill is the next
 *    bar's open. See CODE_AUDIT.md H8.
 *  - Sharpe is still annualised with sqrt(252) on non-daily bars (H7), and
 *    optimize() still ranks in-sample (H10). Neither is fixed here.
 */
export class BacktestEngine {
  /** one cost-floor warning per run, not per trade */
  private warnedCostFloor = false;

  run(input: BacktestParams): BacktestResult {
    const strat = getStrategy(input.strategyType);
    if (!strat) throw new Error(`Unknown strategy: ${input.strategyType}`);
    this.warnedCostFloor = false;

    const params = { ...strat.defaultParams, ...(input.params ?? {}) };
    const candles = input.candles;
    const startingCapital = input.startingCapital ?? 1_000_000;
    const minBars = strat.minCandles(params);
    const exitMode: ExitMode =
      input.exitMode ?? (input.strategyType.startsWith('NTB_') ? 'trailing' : 'static');

    // The SAME resolver the live path uses, so a param optimize() recommends is
    // a param live trading will actually read.
    //
    // DCA is forced OFF: this engine does not model a multi-leg averaged
    // position. Previously it read the live DCA toggle and threw, which meant
    // enabling DCA for trading made the unrelated /compare and /optimize
    // dashboards 500 — "turn off your live config to read a chart".
    const trailCfg: TrailingConfig = resolveTrailingConfig(params, false);

    // Session realism: on for real NSE bars, off for the 24/7 simulator.
    const enforceSession = input.enforceSession ?? looksLikeNseSession(candles);

    let cash = startingCapital;
    let open: OpenPos | null = null;
    const tradeLog: BacktestResult['tradeLog'] = [];
    const equityCurve: { t: number; equity: number }[] = [];

    const mark = (price: number) =>
      open ? (price - open.entryPrice) * open.quantity * (open.side === 'BUY' ? 1 : -1) : 0;

    for (let i = minBars; i < candles.length; i++) {
      const bar = candles[i];

      if (open) {
        // 1. Manage the position by walking the bar's path, adverse extreme first.
        for (const price of adversePath(open.side, bar)) {
          const exit = this.evaluateExit(open, price, bar, exitMode, trailCfg);
          if (!exit) continue;
          cash += this.close(open, exit.price, bar.timestamp, exit.reason, tradeLog);
          open = null;
          break; // position closed mid-bar; stop walking
        }

        // 2. NSE: an MIS position cannot be carried overnight. Flatten on our
        //    terms at `flattenAt`; past `squareOffAt` the broker does it for us
        //    and charges ₹50+GST — model that, so a strategy that habitually
        //    overstays is penalised in the numbers rather than in the account.
        if (open && enforceSession && mustFlatten(bar.timestamp)) {
          const penalised = pastSquareOff(bar.timestamp);
          cash += this.close(
            open,
            bar.close,
            bar.timestamp,
            'square_off',
            tradeLog,
            penalised ? autoSquareOffCharge() : 0,
          );
          open = null;
        }

        // 3. Static mode only: an opposite signal still closes at market.
        if (open && exitMode === 'static') {
          const signal = strat.evaluate({ symbol: input.symbol, candles: candles.slice(0, i + 1), params });
          if (signal.action !== 'HOLD' && signal.action !== open.side) {
            cash += this.close(open, bar.close, bar.timestamp, 'manual', tradeLog);
            open = null;
          }
        }
      } else {
        // 4. Flat: evaluate an entry, on the CLOSE only. Never intra-bar.
        const window = candles.slice(0, i + 1);
        const signal = strat.evaluate({ symbol: input.symbol, candles: window, params });
        if (signal.action === 'BUY' || signal.action === 'SELL') {
          // The clock decides more than the signal near the open and the close.
          const gate = enforceSession ? canEnter(bar.timestamp) : { ok: true };
          if (gate.ok) {
            open = this.openPosition(signal.action, bar, window, input, params, exitMode, signal);
          }
        }
      }

      equityCurve.push({ t: bar.timestamp, equity: cash + mark(bar.close) });
    }

    // Close any residual position at the last price.
    if (open) {
      const last = candles[candles.length - 1];
      cash += this.close(open, last.close, last.timestamp, 'square_off', tradeLog);
      open = null;
      equityCurve.push({ t: last.timestamp, equity: cash });
    }

    return this.metrics(input, params, candles, startingCapital, cash, tradeLog, equityCurve);
  }

  private openPosition(
    side: OrderSide,
    bar: Candle,
    window: Candle[],
    input: BacktestParams,
    params: Record<string, number>,
    exitMode: ExitMode,
    signal: { stopLoss?: number; takeProfit?: number },
  ): OpenPos | null {
    // Spec Phase 7: slippage always worsens the fill.
    const fill = applySlippage(bar.close, side, 'open');

    if (exitMode !== 'trailing') {
      const quantity = input.quantity ?? 1;
      return {
        side,
        entryPrice: fill,
        quantity,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        openedAt: bar.timestamp,
        // Per-SIDE charges. Halving a round trip would defeat the whole point of
        // the asymmetric model (STT sell-only, stamp duty buy-only).
        entryCharges: charges(side, fill, quantity).total,
        trailing: openTrailing(fill, 0, false, 0), // unused in static mode
      };
    }

    // Phases 4 + 5, mirroring the live path exactly.
    const stopPct = effectiveStopPct(atr(window, config.ntb.atrPeriod), fill);
    const sized = sizePosition({
      price: fill,
      stopPct,
      fixedQuote: config.ntb.quoteOrderSize,
      riskPerTradePct: config.ntb.riskPerTradePct,
      referenceBalance: input.startingCapital ?? config.risk.capital,
      maxPositionQuote: config.ntb.maxPositionQuote,
    });
    if (sized.quantity < 1) return null;

    // Phase 4 cost floor. Warned once per run, not per trade — a backtest is
    // exactly where you'd discover the stop is inside the round-trip cost, but
    // it is also where a per-trade warning would emit thousands of lines.
    if (!this.warnedCostFloor) {
      this.warnedCostFloor = true;
      checkStopAgainstCostFloor(input.symbol, stopPct, fill, sized.quantity);
    }

    return {
      side,
      entryPrice: fill,
      quantity: sized.quantity,
      openedAt: bar.timestamp,
      entryCharges: charges(side, fill, sized.quantity).total,
      // DCA is never active in a backtest — see resolveTrailingConfig(params, false).
      trailing: openTrailing(fill, stopPct, false, sized.notional),
    };
  }

  /** One step of the price path. Returns a fill when the position should close. */
  private evaluateExit(
    pos: OpenPos,
    price: number,
    bar: Candle,
    exitMode: ExitMode,
    cfg: TrailingConfig,
  ): { price: number; reason: ExitReason } | null {
    if (exitMode === 'trailing') {
      const d = updateTrailing(pos, price, cfg);
      if (d.type === 'HOLD') return null;
      if (d.type === 'ADD') {
        // Unreachable: resolveTrailingConfig(params, false) forces DCA off here,
        // because this engine cannot model a multi-leg averaged position and
        // would rather refuse than mis-report one.
        throw new Error('DCA is not modelled by the backtester (see NTB_PORT.md §4)');
      }
      // Only stop-losses are capped to their level; trailing and take-profit
      // fill at the observed price. Candle context is always available here, so
      // gap handling is exact and the resting-stop assumption never applies.
      if (d.reason === 'stop_loss') {
        const f = cappedStopFill(pos.side, d.protectionPrice, price, bar.open);
        return { price: f.price, reason: 'stop_loss' };
      }
      return { price, reason: d.reason };
    }

    // Static SL/TP.
    const dir = pos.side === 'BUY' ? 1 : -1;
    const hitSL = pos.stopLoss != null && (dir > 0 ? price <= pos.stopLoss : price >= pos.stopLoss);
    const hitTP =
      pos.takeProfit != null && (dir > 0 ? price >= pos.takeProfit : price <= pos.takeProfit);
    if (hitSL) {
      const f = cappedStopFill(pos.side, pos.stopLoss!, price, bar.open);
      return { price: f.price, reason: 'stop_loss' };
    }
    if (hitTP) return { price: pos.takeProfit!, reason: 'take_profit' };
    return null;
  }

  /**
   * Grid-search with a walk-forward TRAIN/TEST split.
   *
   * Previously this fit every combo and ranked it on the SAME series, then
   * returned the top 20 as recommendations — the textbook overfitting trap. Over
   * the simulator (a random walk with a hardcoded upward drift) the "best"
   * parameters were noise-fitted to one `Math.random()` series that will never
   * recur, and the drift guaranteed long-biased params won regardless of merit.
   *
   * Now: fit on the first `trainRatio` of the data, and RANK ON THE HELD-OUT
   * TEST SLICE. Both metrics are returned so the degradation is visible — a
   * combo that looks brilliant in-sample and collapses out-of-sample is the
   * signature of a curve fit, and you can now see it rather than deploy it.
   *
   * The spec's own bake-off is exactly this discipline; without it there is no
   * way to tell whether an NSE entry has an edge or a memory.
   */
  optimize(
    base: BacktestParams,
    grid: Record<string, number[]>,
    trainRatio = 0.7,
  ): OptimizeResult[] {
    const keys = Object.keys(grid);
    const combos: Record<string, number>[] = [{}];
    for (const key of keys) {
      const next: Record<string, number>[] = [];
      for (const combo of combos) {
        for (const v of grid[key]) next.push({ ...combo, [key]: v });
      }
      combos.splice(0, combos.length, ...next);
    }

    const split = Math.floor(base.candles.length * Math.min(Math.max(trainRatio, 0.1), 0.9));
    const train = base.candles.slice(0, split);
    const test = base.candles.slice(split);

    const results = combos.map((combo) => {
      const params = { ...base.params, ...combo };
      const inSample = this.run({ ...base, params, candles: train });
      const outOfSample = this.run({ ...base, params, candles: test });
      return {
        params: combo,
        train: strip(inSample),
        test: strip(outOfSample),
        /** how much of the in-sample edge survived. < 0 = it was a curve fit. */
        decayPct: round(inSample.expectancy - outOfSample.expectancy),
      };
    });

    // Rank on OUT-OF-SAMPLE expectancy — the only number with any claim to
    // predictive value. Ranking on in-sample return is how you pick the combo
    // that memorised the noise best.
    return results.sort((a, b) => b.test.expectancy - a.test.expectancy);
  }

  private close(
    pos: OpenPos,
    exitPrice: number,
    closedAt: number,
    reason: ExitReason,
    log: BacktestResult['tradeLog'],
    penalty = 0,
  ): number {
    // Slippage on the exit leg too (spec Phase 7/10).
    const fill = roundToTick(applySlippage(exitPrice, pos.side, 'close'));
    const gross = (fill - pos.entryPrice) * pos.quantity * (pos.side === 'BUY' ? 1 : -1);
    // Full round trip in pnl. NTB's own accounting omits the entry fee here,
    // which biases win rate and profit factor optimistically on EVERY trade —
    // the spec flags it as a porting note and asks the port to fix it.
    const exitSide: OrderSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
    const exitCharges = charges(exitSide, fill, pos.quantity).total;
    const pnl = gross - pos.entryCharges - exitCharges - penalty;

    log.push({
      symbol: '',
      side: pos.side,
      entryPrice: round(pos.entryPrice),
      exitPrice: round(fill),
      pnl: round(pnl),
      reason,
      openedAt: pos.openedAt,
      closedAt,
    });
    return pnl;
  }

  private metrics(
    input: BacktestParams,
    params: Record<string, number>,
    candles: Candle[],
    startingCapital: number,
    endingCapital: number,
    tradeLog: BacktestResult['tradeLog'],
    equityCurve: { t: number; equity: number }[],
  ): BacktestResult {
    for (const t of tradeLog) t.symbol = input.symbol;
    const wins = tradeLog.filter((t) => t.pnl > 0);
    const losses = tradeLog.filter((t) => t.pnl <= 0);
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

    // Per-bar returns for Sharpe.
    const rets: number[] = [];
    for (let i = 1; i < equityCurve.length; i++) {
      const prev = equityCurve[i - 1].equity;
      if (prev > 0) rets.push((equityCurve[i].equity - prev) / prev);
    }
    const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
    // Sample variance (n-1): these are a sample of returns, not the population.
    const variance =
      rets.length > 1 ? rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1) : 0;
    const sd = Math.sqrt(variance);
    // Annualise by the ACTUAL bar interval, not a hardcoded √252.
    //
    // These are per-BAR returns and the bars are typically 1-minute, so √252
    // annualised them as if each bar were a trading day — understating Sharpe by
    // √375 ≈ 19x. A strategy with a true Sharpe of 2.0 reported as 0.10 and got
    // discarded; /compare ranks on this number.
    const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(barsPerYear(candles)) : 0;

    // Max drawdown on the equity curve.
    let peak = startingCapital;
    let maxDd = 0;
    for (const point of equityCurve) {
      peak = Math.max(peak, point.equity);
      const dd = (peak - point.equity) / peak;
      maxDd = Math.max(maxDd, dd);
    }

    // Expectancy = average P&L per trade (the single best "is it worth trading" metric).
    const avgWin = wins.length ? grossProfit / wins.length : 0;
    const avgLoss = losses.length ? grossLoss / losses.length : 0;
    const netPnl = tradeLog.reduce((s, t) => s + t.pnl, 0);
    const expectancy = tradeLog.length ? netPnl / tradeLog.length : 0;

    return {
      strategyType: input.strategyType,
      symbol: input.symbol,
      params,
      from: candles[0]?.timestamp ?? 0,
      to: candles[candles.length - 1]?.timestamp ?? 0,
      startingCapital,
      endingCapital: round(endingCapital),
      totalReturnPct: round(((endingCapital - startingCapital) / startingCapital) * 100),
      trades: tradeLog.length,
      wins: wins.length,
      losses: losses.length,
      winRate: tradeLog.length ? round((wins.length / tradeLog.length) * 100) : 0,
      profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : grossProfit > 0 ? 99 : 0,
      maxDrawdownPct: round(maxDd * 100),
      sharpeRatio: round(sharpe),
      expectancy: round(expectancy),
      avgWin: round(avgWin),
      avgLoss: round(avgLoss),
      equityCurve,
      tradeLog,
    };
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** NSE continuous session: 09:15–15:30 IST = 375 minutes, ~252 trading days. */
const NSE_MINUTES_PER_DAY = 375;
const TRADING_DAYS_PER_YEAR = 252;

/**
 * How many bars of this series make up a year — the correct Sharpe annualisation
 * factor, inferred from the data instead of assumed.
 *
 * Uses the MEDIAN gap, not the mean: real NSE series have overnight gaps of ~17.75
 * hours between the 15:30 close and the next 09:15 open, and a handful of those
 * would drag a mean interval far away from the true bar size.
 */
export function barsPerYear(candles: Candle[]): number {
  if (candles.length < 3) return TRADING_DAYS_PER_YEAR;
  const gaps: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const g = candles[i].timestamp - candles[i - 1].timestamp;
    if (g > 0) gaps.push(g);
  }
  if (!gaps.length) return TRADING_DAYS_PER_YEAR;
  gaps.sort((a, b) => a - b);
  const intervalMs = gaps[Math.floor(gaps.length / 2)];

  const DAY_MS = 86_400_000;
  // Daily or coarser bars: the classic 252.
  if (intervalMs >= DAY_MS) return TRADING_DAYS_PER_YEAR * (DAY_MS / intervalMs);
  // Intraday: only the 375 traded minutes of each day count.
  const barsPerDay = (NSE_MINUTES_PER_DAY * 60_000) / intervalMs;
  return TRADING_DAYS_PER_YEAR * barsPerDay;
}

/**
 * Do these candles look like a real NSE session?
 *
 * True when most bars fall inside 09:15–15:30 IST on trading days. The
 * random-walk simulator stamps candles at `Date.now() - i*interval`, so a run at
 * 01:00 IST produces bars outside every session — applying trading hours to
 * those would just yield zero trades and a confusing empty report.
 */
function looksLikeNseSession(candles: Candle[]): boolean {
  if (candles.length < 20) return false;
  const step = Math.max(1, Math.floor(candles.length / 50)); // sample ~50 bars
  let inSession = 0;
  let checked = 0;
  for (let i = 0; i < candles.length; i += step) {
    checked++;
    if (isMarketOpen(candles[i].timestamp)) inSession++;
  }
  return checked > 0 && inSession / checked > 0.8;
}

export const backtestEngine = new BacktestEngine();
