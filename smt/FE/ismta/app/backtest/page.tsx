'use client';

import { useState } from 'react';
import { EquityCurveChart } from '../components/EquityCurveChart';
import { INDEX_INSTRUMENTS, InstrumentSearch } from '../components/InstrumentSearch';
import { Badge, Card, PageHeader, StatCard } from '../components/ui';
import { TradesTable } from '../components/TradesTable';
import { api, tradingApi } from '../lib/api';
import { dateTime, inr, num, pct } from '../lib/format';
import type {
  BacktestInterval,
  BacktestResponse,
  BacktestSource,
  OptimizeResponse,
  StrategyKind,
  Trade,
} from '../lib/types';
import { usePolling } from '../lib/usePolling';

const STRATS: StrategyKind[] = [
  'MA_CROSSOVER',
  'MOMENTUM',
  'MEAN_REVERSION',
  'BREAKOUT',
  'VWAP',
  'SUPERTREND',
  'ML_ENSEMBLE',
  // NTB port — these use the trailing exit engine and risk-coupled sizing, so
  // the `quantity` input below is ignored for them.
  'NTB_BREAKOUT',
  'NTB_PULLBACK',
  'NTB_MEANREV',
];

/** Each interval implies the longest range Yahoo serves for it (BE routes/backtest.ts HISTORY). */
const INTERVALS: { value: BacktestInterval; label: string; range: string }[] = [
  { value: '1m', label: '1 minute', range: 'last 7 days' },
  { value: '5m', label: '5 minutes', range: 'last 60 days' },
  { value: '15m', label: '15 minutes', range: 'last 60 days' },
  { value: '1h', label: '1 hour', range: 'last 2 years' },
  { value: '1d', label: 'Daily', range: 'last 5 years' },
];

const SOURCE_NAME: Record<BacktestSource, string> = {
  yahoo: 'Yahoo',
  zerodha: 'Kite',
  sim: 'SIMULATED',
  supplied: 'supplied candles',
};

/** The data-source label every result carries. Red when the bars are invented. */
function SourceLabel({ source, note, bars, interval }: { source: BacktestSource; note: string; bars: number; interval: string }) {
  if (source === 'sim') {
    return (
      <span className="inline-flex items-center gap-2 rounded-md border border-rose-400 bg-rose-50 px-3 py-1 text-sm font-semibold text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
        SIMULATED random walk — {note}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300">
      {SOURCE_NAME[source]} · {note} · {bars} × {interval} bars
    </span>
  );
}

export default function BacktestPage() {
  const [strategyType, setStrategyType] = useState('MA_CROSSOVER');
  const [symbol, setSymbol] = useState('RELIANCE');
  const [barInterval, setBarInterval] = useState<BacktestInterval>('1d');
  const [bars, setBars] = useState(500);
  /** '' = use the broker's deployable */
  const [capitalText, setCapitalText] = useState('');
  const [quantity, setQuantity] = useState(10);
  const [exitMode, setExitMode] = useState<'default' | 'static' | 'trailing'>('default');
  const [resp, setResp] = useState<BacktestResponse | null>(null);
  /** the quantity the displayed result was actually produced with */
  const [ranQuantity, setRanQuantity] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // optimize
  const [gridEdits, setGridEdits] = useState<Record<string, Record<string, string>>>({});
  const [trainRatio, setTrainRatio] = useState(0.7);
  const [opt, setOpt] = useState<OptimizeResponse | null>(null);
  const [optLoading, setOptLoading] = useState(false);
  const [optErr, setOptErr] = useState<string | null>(null);

  const funds = usePolling(() => api.funds(), 30_000);
  const types = usePolling(() => api.strategyTypes(), 60_000);
  const runs = usePolling(() => tradingApi.backtestRuns(), 15_000);

  const deployable = funds.data?.funds.deployable ?? null;
  const capital = capitalText.trim() ? Number(capitalText) : (deployable ?? undefined);
  const selfSizing = strategyType.startsWith('NTB_');
  const intervalSpec = INTERVALS.find((i) => i.value === barInterval)!;

  const common = {
    strategyType,
    symbol,
    interval: barInterval,
    bars,
    startingCapital: capital,
    quantity: selfSizing ? undefined : quantity,
    exitMode: exitMode === 'default' ? undefined : exitMode,
  };

  const run = async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await tradingApi.runBacktest(common);
      setResp(r);
      setRanQuantity(quantity);
      runs.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Backtest failed');
    } finally {
      setLoading(false);
    }
  };

  // Grid editor: the strategy's default params, one row each, overridable per
  // strategy without an effect — the rows are derived, not synced.
  const defaults = types.data?.types.find((t) => t.type === strategyType)?.defaultParams ?? {};
  const gridRows = Object.keys(defaults).map((k) => [k, gridEdits[strategyType]?.[k] ?? String(defaults[k])] as const);
  const setGridValue = (k: string, v: string) =>
    setGridEdits((g) => ({ ...g, [strategyType]: { ...(g[strategyType] ?? {}), [k]: v } }));
  const parsedGrid: Record<string, number[]> = Object.fromEntries(
    gridRows
      .map(([k, v]) => [k, v.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))] as const)
      .filter(([, vals]) => vals.length > 0),
  );
  const combos = Object.values(parsedGrid).reduce((n, vals) => n * vals.length, 1);

  const optimize = async () => {
    setOptLoading(true);
    setOptErr(null);
    try {
      const r = await tradingApi.optimize({ ...common, grid: parsedGrid, trainRatio });
      setOpt(r);
      runs.refresh();
    } catch (e) {
      setOptErr(e instanceof Error ? e.message : 'Optimize failed');
    } finally {
      setOptLoading(false);
    }
  };

  const result = resp?.result ?? null;
  // Adapt backtest tradeLog → Trade rows for the shared table.
  const tradeRows: Trade[] = (result?.tradeLog ?? []).map((t, i) => ({
    id: String(i),
    symbol: t.symbol,
    side: t.side,
    // The quantity the run actually used, not the current input value.
    quantity: ranQuantity ?? quantity,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    status: 'CLOSED',
    pnl: t.pnl,
    exitReason: t.reason,
    openedAt: t.openedAt,
    closedAt: t.closedAt,
  }));

  return (
    <div>
      <PageHeader title="Backtest" subtitle="Run a strategy over real history, and be told how much of the result is luck" />

      <Card className="mb-6">
        <div className="grid grid-cols-2 items-end gap-4 lg:grid-cols-4 xl:grid-cols-8">
          <Field label="Strategy">
            <select value={strategyType} onChange={(e) => setStrategyType(e.target.value)} className={inputCls}>
              {STRATS.map((s) => (
                <option key={s} value={s}>
                  {s.replace('_', ' ')}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`Symbol · ${symbol}`}>
            <InstrumentSearch
              onSelect={(i) => setSymbol(i.symbol)}
              extras={INDEX_INSTRUMENTS}
              placeholder={symbol}
              clearOnSelect
            />
          </Field>
          <Field label={`Interval (${intervalSpec.range})`}>
            <select value={barInterval} onChange={(e) => setBarInterval(e.target.value as BacktestInterval)} className={inputCls}>
              {INTERVALS.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label} · {i.range}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Bars (from the end)">
            <input type="number" min={50} max={5000} value={bars} onChange={(e) => setBars(Number(e.target.value))} className={inputCls} />
          </Field>
          <Field label={deployable != null ? `Capital (deployable ${inr(deployable, 0)})` : 'Capital'}>
            <input
              type="number"
              min={1000}
              step={1000}
              value={capitalText}
              placeholder={deployable != null ? String(deployable) : '…'}
              onChange={(e) => setCapitalText(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label={selfSizing ? 'Quantity (auto-sized)' : 'Quantity'}>
            <input
              type="number"
              min={1}
              value={quantity}
              disabled={selfSizing}
              title={selfSizing ? 'NTB strategies size each position from its own stop distance, so this is ignored' : undefined}
              onChange={(e) => setQuantity(Number(e.target.value))}
              className={`${inputCls} disabled:cursor-not-allowed disabled:opacity-50`}
            />
          </Field>
          <Field label="Exit mode">
            <select value={exitMode} onChange={(e) => setExitMode(e.target.value as typeof exitMode)} className={inputCls}>
              <option value="default">{selfSizing ? 'default (trailing)' : 'default (static)'}</option>
              <option value="static">static SL/TP</option>
              <option value="trailing">trailing (NTB engine)</option>
            </select>
          </Field>
          <button
            onClick={run}
            disabled={loading || !symbol}
            className="rounded-md bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Running…' : 'Run backtest'}
          </button>
        </div>
        {err && <p className="mt-3 text-xs text-rose-500">{err}</p>}
      </Card>

      {resp && result && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <SourceLabel source={resp.source} note={resp.note} bars={resp.bars} interval={resp.interval} />
            <span className="text-xs text-zinc-500">
              {result.strategyType.replace('_', ' ')} on {result.symbol}
              {result.from && result.to ? ` · ${dateTime(result.from)} → ${dateTime(result.to)}` : ''}
            </span>
          </div>

          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-6">
            <StatCard label="Total Return" value={pct(result.totalReturnPct)} colored={result.totalReturnPct} />
            <StatCard label="Win Rate" value={`${result.winRate}%`} />
            <StatCard label="Profit Factor" value={String(result.profitFactor)} />
            <StatCard label="Sharpe" value={String(result.sharpeRatio)} colored={result.sharpeRatio} />
            <StatCard label="Max Drawdown" value={`${result.maxDrawdownPct}%`} colored={-result.maxDrawdownPct} />
            <StatCard label="Trades" value={`${result.trades}`} sub={`${result.wins}W / ${result.losses}L`} />
          </div>

          <HonestyCard honesty={resp.honesty} />

          <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card title="Equity curve" className="lg:col-span-2">
              {result.equityCurve.length > 1 ? (
                <EquityCurveChart data={result.equityCurve} />
              ) : (
                <p className="py-10 text-center text-sm text-zinc-400">No equity data</p>
              )}
              <p className="mt-3 text-xs text-zinc-400">
                Capital {inr(result.startingCapital)} → {inr(result.endingCapital)} · expectancy {inr(result.expectancy)} per trade
              </p>
            </Card>
            <Card title="Parameters">
              <dl className="space-y-1 text-sm">
                {Object.entries(result.params).map(([k, v]) => (
                  <div key={k} className="flex justify-between">
                    <dt className="text-zinc-500">{k}</dt>
                    <dd className="tabular-nums">{v}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          </div>

          <Card title={`Trade log (${tradeRows.length})`} className="mb-6">
            <TradesTable trades={tradeRows} />
          </Card>
        </>
      )}

      {/* ── optimize ── */}
      <Card
        title="Optimize (walk-forward grid search)"
        className="mb-6"
        action={<span className="text-xs text-zinc-500">{combos} combination{combos === 1 ? '' : 's'} · cap 200</span>}
      >
        <p className="mb-3 text-xs text-zinc-500">
          Comma-separated values per parameter, prefilled with {strategyType.replace('_', ' ')}&apos;s defaults. The
          first {Math.round(trainRatio * 100)}% of the bars fit the parameters, the rest test them; results are ranked by
          OUT-OF-SAMPLE expectancy. Every combination is added to the trial ledger.
        </p>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
          {gridRows.length === 0 && <p className="col-span-full text-xs text-zinc-400">Loading parameter defaults…</p>}
          {gridRows.map(([k, v]) => (
            <Field key={k} label={k}>
              <input
                value={v}
                onChange={(e) => setGridValue(k, e.target.value)}
                className={`${inputCls} ${parsedGrid[k] ? '' : 'border-rose-400'}`}
                aria-label={`grid ${k}`}
              />
            </Field>
          ))}
          <Field label="Train ratio">
            <input
              type="number"
              min={0.1}
              max={0.9}
              step={0.05}
              value={trainRatio}
              onChange={(e) => setTrainRatio(Number(e.target.value))}
              className={inputCls}
            />
          </Field>
          <div className="flex items-end">
            <button
              onClick={optimize}
              disabled={optLoading || combos < 1 || combos > 200 || gridRows.length === 0}
              className="w-full rounded-md bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {optLoading ? 'Optimizing…' : `Run ${combos} combos`}
            </button>
          </div>
        </div>
        {optErr && <p className="mt-3 text-xs text-rose-500">{optErr}</p>}

        {opt && (
          <div className="mt-4">
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <SourceLabel source={opt.source} note={opt.note.split('Data: ')[1]?.split('. Every')[0] ?? opt.note} bars={opt.bars} interval={opt.interval} />
              <span className="text-xs text-zinc-500">{opt.trialsRecorded} combinations recorded in the trial ledger</span>
            </div>
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-zinc-200 text-left uppercase text-zinc-400 dark:border-zinc-800">
                    <th className="py-2 pr-3 font-medium">#</th>
                    <th className="py-2 pr-3 font-medium">Params</th>
                    <th className="py-2 pr-3 text-right font-medium">Train exp.</th>
                    <th className="py-2 pr-3 text-right font-medium">Test exp.</th>
                    <th className="py-2 pr-3 text-right font-medium">Train ret.</th>
                    <th className="py-2 pr-3 text-right font-medium">Test ret.</th>
                    <th className="py-2 pr-3 text-right font-medium">Train Sharpe</th>
                    <th className="py-2 pr-3 text-right font-medium">Test Sharpe</th>
                    <th className="py-2 pr-3 text-right font-medium">Train DD</th>
                    <th className="py-2 pr-3 text-right font-medium">Test DD</th>
                    <th className="py-2 pr-3 text-right font-medium">Trades (tr/te)</th>
                    <th className="py-2 pr-3 text-right font-medium">Decay</th>
                  </tr>
                </thead>
                <tbody>
                  {opt.results.map((r, i) => (
                    <tr key={i} className="border-b border-zinc-100 dark:border-zinc-900">
                      <td className="py-1.5 pr-3 text-zinc-400">{i + 1}</td>
                      <td className="py-1.5 pr-3 font-mono">{Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(' ')}</td>
                      <td className={`py-1.5 pr-3 text-right tabular-nums ${color(r.train.expectancy)}`}>{num(r.train.expectancy)}</td>
                      <td className={`py-1.5 pr-3 text-right tabular-nums font-medium ${color(r.test.expectancy)}`}>{num(r.test.expectancy)}</td>
                      <td className={`py-1.5 pr-3 text-right tabular-nums ${color(r.train.totalReturnPct)}`}>{pct(r.train.totalReturnPct)}</td>
                      <td className={`py-1.5 pr-3 text-right tabular-nums ${color(r.test.totalReturnPct)}`}>{pct(r.test.totalReturnPct)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{r.train.sharpeRatio}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{r.test.sharpeRatio}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-rose-500">{r.train.maxDrawdownPct}%</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-rose-500">{r.test.maxDrawdownPct}%</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">
                        {r.train.trades}/{r.test.trades}
                      </td>
                      <td className={`py-1.5 pr-3 text-right tabular-nums font-semibold ${decayColor(r.decayPct)}`} title="train expectancy − test expectancy; large positive = fitted noise">
                        {pct(r.decayPct)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-zinc-500">{opt.note}</p>
          </div>
        )}
      </Card>

      {/* ── trial ledger ── */}
      <Card title={`Trial ledger (${runs.data?.runs.length ?? 0} runs)`} action={<span className="text-xs text-zinc-500">every backtest and every optimize combination, newest first</span>}>
        {!runs.data || runs.data.runs.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-400">No runs recorded yet.</p>
        ) : (
          <div className="scroll-thin max-h-96 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white dark:bg-zinc-950">
                <tr className="border-b border-zinc-200 text-left uppercase text-zinc-400 dark:border-zinc-800">
                  <th className="py-2 pr-3 font-medium">Time</th>
                  <th className="py-2 pr-3 font-medium">Strategy</th>
                  <th className="py-2 pr-3 font-medium">Symbol</th>
                  <th className="py-2 pr-3 font-medium">Params</th>
                  <th className="py-2 pr-3 font-medium">Source</th>
                  <th className="py-2 pr-3 font-medium">Interval</th>
                  <th className="py-2 pr-3 text-right font-medium">Trades</th>
                  <th className="py-2 pr-3 text-right font-medium">Return</th>
                  <th className="py-2 pr-3 text-right font-medium">Sharpe</th>
                </tr>
              </thead>
              <tbody>
                {runs.data.runs.map((r) => (
                  <tr key={r.id} className="border-b border-zinc-100 dark:border-zinc-900">
                    <td className="py-1.5 pr-3 whitespace-nowrap tabular-nums text-zinc-500">{dateTime(r.at)}</td>
                    <td className="py-1.5 pr-3">{r.strategyType.replace('_', ' ')}</td>
                    <td className="py-1.5 pr-3 font-medium">{r.symbol}</td>
                    <td className="py-1.5 pr-3 font-mono text-[11px]">{Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(' ')}</td>
                    <td className="py-1.5 pr-3">
                      <Badge tone={r.source === 'sim' ? 'red' : 'neutral'}>{r.source}</Badge>
                    </td>
                    <td className="py-1.5 pr-3">{r.interval}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{r.trades}</td>
                    <td className={`py-1.5 pr-3 text-right tabular-nums ${color(r.totalReturnPct)}`}>{pct(r.totalReturnPct)}</td>
                    <td className={`py-1.5 pr-3 text-right tabular-nums ${color(r.sharpeRatio)}`}>{r.sharpeRatio}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/** How much of the Sharpe is luck: trials so far, deflated Sharpe, and whether the test was long enough. */
function HonestyCard({ honesty }: { honesty: BacktestResponse['honesty'] }) {
  const ds = honesty.deflatedSharpe;
  const clears = ds.probability >= 0.95;
  const longEnough = honesty.minBacktestLength === 0 || honesty.periods >= honesty.minBacktestLength;
  return (
    <Card
      title="Honesty"
      className={`mb-6 ${clears ? 'border-emerald-300 dark:border-emerald-900' : 'border-amber-300 dark:border-amber-900'}`}
      action={<Badge tone={clears ? 'green' : 'amber'}>{clears ? 'clears the benchmark' : 'not distinguishable from luck'}</Badge>}
    >
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500">Trials so far</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{honesty.trials}</div>
          <div className="text-xs text-zinc-400">this strategy + symbol + source</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500">Deflated Sharpe</div>
          <div className={`mt-1 text-2xl font-semibold tabular-nums ${clears ? 'text-emerald-500' : 'text-amber-500'}`}>
            {(ds.probability * 100).toFixed(1)}%
          </div>
          <div className="text-xs text-zinc-400">probability the Sharpe beats the luck of {ds.trials} tries (≥ 95% is the bar)</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500">Benchmark Sharpe</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{ds.benchmarkSharpe}</div>
          <div className="text-xs text-zinc-400">expected best of {ds.trials} random tries (per period)</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500">Min backtest length</div>
          <div className={`mt-1 text-2xl font-semibold tabular-nums ${longEnough ? '' : 'text-rose-500'}`}>
            {honesty.periods} / {honesty.minBacktestLength || '—'}
          </div>
          <div className="text-xs text-zinc-400">periods in this run / needed at {honesty.trials} trials{longEnough ? '' : ' — too short'}</div>
        </div>
      </div>
      <p className={`mt-3 text-xs ${clears ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}`}>{ds.note}</p>
    </Card>
  );
}

const inputCls = 'w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block truncate text-xs text-zinc-500" title={label}>
        {label}
      </label>
      {children}
    </div>
  );
}

function color(n: number): string {
  if (n > 0) return 'text-emerald-500';
  if (n < 0) return 'text-rose-500';
  return 'text-zinc-400';
}

/** Decay = train − test expectancy. Positive means the edge shrank out of sample; big positive is overfit. */
function decayColor(n: number): string {
  if (n > 50) return 'text-rose-500';
  if (n > 0) return 'text-amber-500';
  return 'text-emerald-500';
}
