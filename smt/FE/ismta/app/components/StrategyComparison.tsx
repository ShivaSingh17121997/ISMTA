'use client';

import { useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { tradingApi } from '../lib/api';
import { num, pct } from '../lib/format';
import type { BacktestInterval, StrategyComparisonResponse, StrategyComparisonRow } from '../lib/types';
import { Badge, Card } from './ui';

const SYMBOLS = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'NIFTY', 'BANKNIFTY'];

/** Each interval implies the longest range Yahoo serves for it. */
const INTERVALS: { value: BacktestInterval; label: string }[] = [
  { value: '1m', label: '1m · 7d' },
  { value: '5m', label: '5m · 60d' },
  { value: '15m', label: '15m · 60d' },
  { value: '1h', label: '1h · 2y' },
  { value: '1d', label: '1d · 5y' },
];

type MetricKey = 'expectancy' | 'sharpeRatio' | 'profitFactor' | 'winRate' | 'totalReturnPct';
const METRICS: { key: MetricKey; label: string; help: string }[] = [
  { key: 'expectancy', label: 'Expectancy', help: 'Avg P&L per trade — the bottom line' },
  { key: 'sharpeRatio', label: 'Sharpe', help: 'Return per unit of risk' },
  { key: 'profitFactor', label: 'Profit Factor', help: 'Gross profit ÷ gross loss (>1 = profitable)' },
  { key: 'winRate', label: 'Win Rate', help: '% of trades that were profitable' },
  { key: 'totalReturnPct', label: 'Return %', help: 'Total return over the test window' },
];

const prettyName = (t: string) => t.replace(/_/g, ' ');

const isRow = (r: StrategyComparisonResponse['results'][number]): r is StrategyComparisonRow =>
  !('error' in r) && typeof r.expectancy === 'number';

export function StrategyComparison() {
  const [symbol, setSymbol] = useState('RELIANCE');
  const [interval, setInterval_] = useState<BacktestInterval>('1d');
  const [metric, setMetric] = useState<MetricKey>('expectancy');
  const [data, setData] = useState<StrategyComparisonResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setErr(null);
    try {
      setData(await tradingApi.compareAll({ symbol, interval, bars: 1000, runs: 5, quantity: 10 }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Comparison failed');
    } finally {
      setLoading(false);
    }
  };

  // Sort table by the selected metric; rows that errored are listed apart.
  const rows: StrategyComparisonRow[] = data ? data.results.filter(isRow).sort((a, b) => b[metric] - a[metric]) : [];
  const errored = data ? data.results.filter((r): r is { strategyType: string; error: string } => 'error' in r) : [];
  const chartData = rows.map((r) => ({ name: prettyName(r.strategyType), value: r[metric] }));
  const best = rows[0];
  const simulated = data?.source === 'sim';

  return (
    <Card
      title="Strategy Comparison"
      action={
        <div className="flex items-center gap-2">
          <select
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            className="rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-700"
            aria-label="Symbol"
          >
            {SYMBOLS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            value={interval}
            onChange={(e) => setInterval_(e.target.value as BacktestInterval)}
            className="rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-700"
            aria-label="Interval"
            title="Bar interval; the range is the longest Yahoo serves for it"
          >
            {INTERVALS.map((i) => (
              <option key={i.value} value={i.value}>
                {i.label}
              </option>
            ))}
          </select>
          <button
            onClick={run}
            disabled={loading}
            className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Running…' : 'Compare all'}
          </button>
        </div>
      }
    >
      {!data && !err && (
        <p className="py-10 text-center text-sm text-zinc-400">
          Pick a symbol and interval, then run a side-by-side backtest of all strategies on the same bars.
        </p>
      )}
      {err && <p className="py-4 text-center text-sm text-rose-500">{err}</p>}

      {data && (
        <>
          <div className="mb-3">
            {simulated ? (
              <span className="inline-flex rounded-md border border-rose-400 bg-rose-50 px-3 py-1 text-sm font-semibold text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
                SIMULATED random walk — {data.note} · avg of {data.runs} runs
              </span>
            ) : (
              <span className="inline-flex rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300">
                source {data.source} · {data.note} · {data.bars} × {data.interval} bars
              </span>
            )}
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="text-xs text-zinc-500">Rank by:</span>
            {METRICS.map((m) => (
              <button
                key={m.key}
                onClick={() => setMetric(m.key)}
                title={m.help}
                className={`rounded-full px-2.5 py-1 text-xs ${
                  metric === m.key
                    ? 'bg-blue-600 text-white'
                    : 'border border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {best && (
            <div className="mb-4 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm dark:border-emerald-900 dark:bg-emerald-950/30">
              🏆 Best by <strong>{METRICS.find((m) => m.key === metric)?.label}</strong>:{' '}
              <strong>{prettyName(best.strategyType)}</strong> on {data.symbol}
            </div>
          )}

          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chartData} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" opacity={0.3} />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#71717a' }} interval={0} angle={-15} textAnchor="end" height={50} />
              <YAxis tick={{ fontSize: 11, fill: '#71717a' }} width={60} tickFormatter={(v) => num(v, 0)} />
              <Tooltip
                contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 12 }}
                formatter={(v) => [num(Number(v)), METRICS.find((m) => m.key === metric)?.label ?? '']}
              />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {chartData.map((d, i) => (
                  <Cell key={d.name} fill={i === 0 ? '#10b981' : d.value >= 0 ? '#3b82f6' : '#f43f5e'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>

          <div className="scroll-thin mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-xs uppercase text-zinc-400 dark:border-zinc-800">
                  <th className="py-2 pr-4 font-medium">#</th>
                  <th className="py-2 pr-4 font-medium">Strategy</th>
                  <th className="py-2 pr-4 text-right font-medium">Expectancy</th>
                  <th className="py-2 pr-4 text-right font-medium">Sharpe</th>
                  <th className="py-2 pr-4 text-right font-medium">Profit Factor</th>
                  <th className="py-2 pr-4 text-right font-medium">Win %</th>
                  <th className="py-2 pr-4 text-right font-medium">Return</th>
                  <th className="py-2 pr-4 text-right font-medium">Max DD</th>
                  <th className="py-2 pr-4 text-right font-medium">Trades</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.strategyType} className="border-b border-zinc-100 dark:border-zinc-900">
                    <td className="py-2 pr-4 text-zinc-400">{i + 1}</td>
                    <td className="py-2 pr-4 font-medium">
                      {prettyName(r.strategyType)} {i === 0 && <Badge tone="green">top</Badge>}
                    </td>
                    <td className={`py-2 pr-4 text-right tabular-nums ${color(r.expectancy)}`}>{num(r.expectancy)}</td>
                    <td className={`py-2 pr-4 text-right tabular-nums ${color(r.sharpeRatio)}`}>{r.sharpeRatio}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{r.profitFactor}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{r.winRate}%</td>
                    <td className={`py-2 pr-4 text-right tabular-nums ${color(r.totalReturnPct)}`}>{pct(r.totalReturnPct)}</td>
                    <td className="py-2 pr-4 text-right tabular-nums text-rose-500">{r.maxDrawdownPct}%</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{r.trades}</td>
                  </tr>
                ))}
                {errored.map((r) => (
                  <tr key={r.strategyType} className="border-b border-zinc-100 dark:border-zinc-900">
                    <td className="py-2 pr-4 text-zinc-400">—</td>
                    <td className="py-2 pr-4 font-medium">
                      {prettyName(r.strategyType)} <Badge tone="red">error</Badge>
                    </td>
                    <td colSpan={7} className="py-2 pr-4 text-xs text-rose-500">
                      {r.error}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-zinc-400">
            Expectancy = average P&amp;L per trade — the most reliable ranking. Win rate alone is misleading.{' '}
            {simulated
              ? 'These bars are a random walk: no strategy can have an edge on them, so a "winner" here is noise.'
              : 'One shared series of real bars: every strategy saw exactly the same history.'}
          </p>
        </>
      )}
    </Card>
  );
}

function color(n: number): string {
  if (n > 0) return 'text-emerald-500';
  if (n < 0) return 'text-rose-500';
  return 'text-zinc-400';
}
