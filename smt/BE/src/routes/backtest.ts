import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { config } from '../config';
import { authenticate, AuthedRequest } from '../middleware/auth';
import { backtestEngine } from '../services/BacktestEngine';
import { deflatedSharpe, minBacktestLength, moments, periodSharpe, variance } from '../services/backtest/stats';
import { fundsService } from '../services/FundsService';
import { kiteService } from '../services/KiteService';
import { marketData } from '../services/MarketDataService';
import { fetchYahooCandles } from '../services/yahoo';
import { getStrategy, listStrategyTypes } from '../strategies';
import { store } from '../store/memoryStore';
import { BacktestResult, BacktestRun, Candle, ExitMode } from '../types';

const router = Router();
router.use(authenticate);

const EXIT_MODES: ExitMode[] = ['static', 'trailing'];

/**
 * Real history from Yahoo. `interval` picks the bar; the range is the longest
 * Yahoo serves for it (1-minute bars only exist for the last 7 days, 5-minute
 * for 60, daily for years). `bars` trims from the end.
 */
const HISTORY: Record<string, { range: string; label: string }> = {
  '1m': { range: '7d', label: '1-minute bars, last 7 days' },
  '5m': { range: '60d', label: '5-minute bars, last 60 days' },
  '15m': { range: '60d', label: '15-minute bars, last 60 days' },
  '1h': { range: '2y', label: 'hourly bars, last 2 years' },
  '1d': { range: '5y', label: 'daily bars, last 5 years' },
};

interface HistoryResult {
  candles: Candle[];
  source: 'yahoo' | 'zerodha' | 'sim' | 'supplied';
  interval: string;
  note: string;
}

async function loadHistory(symbol: string, interval: string, bars: number, days: number, supplied?: Candle[]): Promise<HistoryResult> {
  if (supplied?.length) return { candles: supplied, source: 'supplied', interval, note: 'candles supplied by the caller' };
  if (config.dataSource === 'zerodha' && kiteService.isConnected()) {
    const c = await kiteService.getHistorical(symbol, 'minute', Math.min(days || 30, 60));
    if (c.length) return { candles: c.slice(-bars), source: 'zerodha', interval: '1m', note: `Kite minute bars, last ${Math.min(days || 30, 60)} days` };
  }
  if (config.dataSource === 'sim') {
    return { candles: marketData.generateHistory(symbol, bars), source: 'sim', interval: '1m', note: 'SIMULATED random walk — DATA_SOURCE=sim; not a market' };
  }
  const spec = HISTORY[interval] ?? HISTORY['1d'];
  const c = await fetchYahooCandles(symbol, spec.range, interval in HISTORY ? interval : '1d');
  if (!c.length) throw new Error(`no ${interval} history for ${symbol} from Yahoo`);
  return { candles: c.slice(-bars), source: 'yahoo', interval: interval in HISTORY ? interval : '1d', note: spec.label };
}

/**
 * Which exit engine to backtest with.
 *
 * Precedence: explicit body param → the saved strategy's exitMode → the type
 * default. Without the middle step, backtesting an existing strategy you had
 * opted into the trailing engine would silently run it STATIC (the default keys
 * off the type string, and 'MA_CROSSOVER'.startsWith('NTB_') is false) — you'd
 * get a green report for an exit path that never runs live.
 */
function resolveExitMode(body: Record<string, unknown>): ExitMode | undefined {
  const explicit = body.exitMode;
  if (typeof explicit === 'string' && EXIT_MODES.includes(explicit as ExitMode)) {
    return explicit as ExitMode;
  }
  const id = body.strategyId;
  if (typeof id === 'string') return store.strategies.get(id)?.exitMode;
  return undefined;
}

/** Per-period Sharpe, skew and kurtosis of the trade P&L series — what deflated Sharpe needs. */
function honesty(r: BacktestResult) {
  const pnls = r.tradeLog.map((t) => t.pnl);
  const m = moments(pnls);
  return { periodSharpe: periodSharpe(pnls), skew: m.skew, kurtosis: m.kurtosis, periods: pnls.length };
}

/**
 * Record the run in the trial ledger and return the deflated Sharpe against
 * every earlier run of the same strategy on the same symbol. The count is what
 * makes the number honest: the fifth configuration you try on RELIANCE is
 * judged against the luck of five tries, not one.
 */
function ledger(userId: string, r: BacktestResult, h: HistoryResult, startingCapital: number) {
  const stats = honesty(r);
  const run: BacktestRun = {
    id: uuid(),
    userId,
    at: Date.now(),
    strategyType: r.strategyType,
    symbol: r.symbol,
    params: r.params,
    source: h.source,
    interval: h.interval,
    bars: h.candles.length,
    from: r.from,
    to: r.to,
    startingCapital,
    totalReturnPct: r.totalReturnPct,
    trades: r.trades,
    winRate: r.winRate,
    profitFactor: r.profitFactor,
    maxDrawdownPct: r.maxDrawdownPct,
    sharpeRatio: r.sharpeRatio,
    periodSharpe: stats.periodSharpe,
    skew: stats.skew,
    kurtosis: stats.kurtosis,
  };
  store.backtestRuns.set(run.id, run);
  const family = store.backtestRunsByUser(userId).filter((x) => x.strategyType === run.strategyType && x.symbol === run.symbol && x.source === run.source);
  const trialSharpes = family.map((x) => x.periodSharpe);
  const dsr = deflatedSharpe({
    sharpe: stats.periodSharpe,
    periods: stats.periods,
    skew: stats.skew,
    kurtosis: stats.kurtosis,
    trials: family.length,
    varianceOfTrialSharpes: variance(trialSharpes),
  });
  return {
    runId: run.id,
    trials: family.length,
    deflatedSharpe: dsr,
    minBacktestLength: minBacktestLength(family.length, Math.max(stats.periodSharpe, 0.01)),
    periods: stats.periods,
  };
}

// Run a backtest over real history (Yahoo by default), Kite candles, supplied candles, or the simulator.
router.post('/', async (req: AuthedRequest, res) => {
  const { strategyType, symbol, params, candles, bars, days, startingCapital, quantity, exitMode, interval } =
    req.body ?? {};
  if (!strategyType || !getStrategy(strategyType)) {
    return res.status(400).json({ error: 'valid strategyType required' });
  }
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  if (exitMode != null && !EXIT_MODES.includes(exitMode)) {
    return res.status(400).json({ error: `exitMode must be one of ${EXIT_MODES.join('|')}` });
  }

  let history: HistoryResult;
  try {
    history = await loadHistory(
      String(symbol).toUpperCase(),
      typeof interval === 'string' ? interval : '1d',
      Math.min(Number(bars) || 5000, 5000),
      Number(days) || 0,
      Array.isArray(candles) && candles.length ? candles : undefined,
    );
  } catch (e) {
    return res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }

  const capital = Number(startingCapital) || (await fundsService.deployable(req.userId).catch(() => config.risk.capital));
  const result = backtestEngine.run({
    strategyType,
    symbol: String(symbol).toUpperCase(),
    params,
    candles: history.candles,
    startingCapital: capital,
    quantity: Number(quantity) || undefined,
    exitMode: resolveExitMode(req.body ?? {}),
  });
  const trial = ledger(req.userId!, result, history, capital);
  return res.json({
    result,
    source: history.source,
    interval: history.interval,
    note: history.note,
    bars: history.candles.length,
    honesty: trial,
  });
});

/** The trial ledger: every run, newest first, so the trial count is visible. */
router.get('/runs', (req: AuthedRequest, res) => {
  const runs = store.backtestRunsByUser(req.userId!).slice(0, 200);
  res.json({ runs });
});

/**
 * Grid-search with a walk-forward train/test split.
 *
 * Results are ranked by OUT-OF-SAMPLE expectancy and carry both slices, so a
 * combo that shines in-sample and collapses out-of-sample is visible rather than
 * deployed. `trainRatio` defaults to 0.7. Every combination counts as a trial
 * in the ledger — that is the whole point of the ledger.
 */
router.post('/optimize', async (req: AuthedRequest, res) => {
  const { strategyType, symbol, grid, bars, startingCapital, quantity, trainRatio, interval } = req.body ?? {};
  if (!strategyType || !getStrategy(strategyType)) {
    return res.status(400).json({ error: 'valid strategyType required' });
  }
  if (!symbol || !grid || typeof grid !== 'object' || Array.isArray(grid)) {
    return res.status(400).json({ error: 'symbol and grid object required' });
  }

  // Validate the grid before building a Cartesian product out of it: this loop
  // is synchronous and blocks the event loop — including the SL/TP tick monitor
  // that manages live positions.
  let combos = 1;
  for (const [k, v] of Object.entries(grid)) {
    if (!Array.isArray(v) || !v.length || !v.every((n) => Number.isFinite(Number(n)))) {
      return res.status(400).json({ error: `grid.${k} must be a non-empty array of numbers` });
    }
    combos *= v.length;
  }
  if (combos > 200) {
    return res
      .status(400)
      .json({ error: `grid expands to ${combos} combinations; cap is 200 (this blocks the event loop)` });
  }

  let history: HistoryResult;
  try {
    history = await loadHistory(String(symbol).toUpperCase(), typeof interval === 'string' ? interval : '1d', Math.min(Number(bars) || 5000, 5000), 0);
  } catch (e) {
    return res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
  const capital = Number(startingCapital) || (await fundsService.deployable(req.userId).catch(() => config.risk.capital));
  const ratio = Number(trainRatio) > 0 ? Number(trainRatio) : 0.7;
  const results = backtestEngine
    .optimize(
      {
        strategyType,
        symbol: String(symbol).toUpperCase(),
        candles: history.candles,
        startingCapital: capital,
        quantity: Number(quantity) || undefined,
        exitMode: resolveExitMode(req.body ?? {}),
      },
      grid,
      ratio,
    )
    .slice(0, 20);

  // Every combination is a trial. Record them as such (metrics from the TEST slice).
  for (const r of results) {
    const run: BacktestRun = {
      id: uuid(),
      userId: req.userId!,
      at: Date.now(),
      strategyType,
      symbol: String(symbol).toUpperCase(),
      params: r.params,
      source: history.source,
      interval: history.interval,
      bars: history.candles.length,
      from: r.test.from,
      to: r.test.to,
      startingCapital: capital,
      totalReturnPct: r.test.totalReturnPct,
      trades: r.test.trades,
      winRate: r.test.winRate,
      profitFactor: r.test.profitFactor,
      maxDrawdownPct: r.test.maxDrawdownPct,
      sharpeRatio: r.test.sharpeRatio,
      periodSharpe: 0,
      skew: 0,
      kurtosis: 3,
    };
    store.backtestRuns.set(run.id, run);
  }

  return res.json({
    results,
    trainRatio: ratio,
    source: history.source,
    interval: history.interval,
    bars: history.candles.length,
    trialsRecorded: results.length,
    note:
      'Ranked by OUT-OF-SAMPLE (test) expectancy. Compare train vs test: a large ' +
      'positive decayPct means the parameters fitted noise and will not repeat. ' +
      `Data: ${history.note}. Every combination has been added to the trial ledger.`,
  });
});

// Compare ALL strategies on one symbol, ranked by metrics.
// Real history is one shared series (runs forced to 1); the simulator averages `runs` fresh series.
router.post('/compare', async (req: AuthedRequest, res) => {
  const { symbol, bars, days, runs, startingCapital, quantity, interval } = req.body ?? {};
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  const sym = String(symbol).toUpperCase();
  const cap = Number(startingCapital) || (await fundsService.deployable(req.userId).catch(() => config.risk.capital));
  const qty = Number(quantity) || undefined;
  const barCount = Math.min(Number(bars) || 5000, 5000);

  let history: HistoryResult;
  try {
    history = await loadHistory(sym, typeof interval === 'string' ? interval : '1d', barCount, Number(days) || 0);
  } catch (e) {
    return res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
  const passes = history.source === 'sim' ? Math.min(Math.max(Number(runs) || 4, 1), 10) : 1;

  const types = listStrategyTypes().map((t) => t.type);
  const rows = types.map((type) => {
    const acc = { winRate: 0, profitFactor: 0, sharpeRatio: 0, expectancy: 0, totalReturnPct: 0, maxDrawdownPct: 0, trades: 0 };
    // Isolate each row: one strategy throwing must not abort the whole table.
    try {
      for (let i = 0; i < passes; i++) {
        const candles = history.source === 'sim' ? marketData.generateHistory(sym, barCount) : history.candles;
        const r = backtestEngine.run({ strategyType: type, symbol: sym, candles, startingCapital: cap, quantity: qty });
        acc.winRate += r.winRate;
        acc.profitFactor += Math.min(r.profitFactor, 5); // cap so a fluke doesn't dominate
        acc.sharpeRatio += r.sharpeRatio;
        acc.expectancy += r.expectancy;
        acc.totalReturnPct += r.totalReturnPct;
        acc.maxDrawdownPct += r.maxDrawdownPct;
        acc.trades += r.trades;
      }
    } catch (e) {
      return { strategyType: type, error: e instanceof Error ? e.message : String(e) };
    }
    const avg = (n: number) => Math.round((n / passes) * 100) / 100;
    return {
      strategyType: type,
      winRate: avg(acc.winRate),
      profitFactor: avg(acc.profitFactor),
      sharpeRatio: avg(acc.sharpeRatio),
      expectancy: avg(acc.expectancy),
      totalReturnPct: avg(acc.totalReturnPct),
      maxDrawdownPct: avg(acc.maxDrawdownPct),
      trades: avg(acc.trades),
    };
  });

  // Rows that errored sort last rather than being dropped, so a broken strategy
  // is visible in the table instead of silently absent.
  const score = (r: (typeof rows)[number]) =>
    'expectancy' in r && typeof r.expectancy === 'number' ? r.expectancy : -Infinity;
  rows.sort((a, b) => score(b) - score(a));
  return res.json({
    symbol: sym,
    runs: passes,
    source: history.source,
    interval: history.interval,
    bars: history.candles.length,
    note: history.note,
    results: rows,
  });
});

export default router;
