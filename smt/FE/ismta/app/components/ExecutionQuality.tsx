'use client';

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { num } from '../lib/format';
import type { ExecutionReport } from '../lib/types';
import { istDateTime } from '../lib/useNow';
import { Badge, MiniStat } from './ui';
import { dayLabel, useChartPalette } from './NavChart';

/**
 * What happened between "decided" and "filled". Slippage is signed against the
 * trader (positive = worse than the reference price), latency is broker
 * acknowledgement time, and the rejection table includes the guard and risk
 * refusals that never became orders — leaving those out would flatter a bot
 * whose every attempt was turned away before it reached the broker.
 */
export function ExecutionQuality({ report }: { report: ExecutionReport }) {
  const p = useChartPalette();
  const { totals, slippage, latency, rejections, byTag, adjusted, byDay } = report;
  const fmt = (v: number | null, dp = 1, unit = '') => (v == null ? '—' : `${num(v, dp)}${unit}`);
  const anyDay = byDay.some((d) => d.filled || d.rejected || d.refused || d.cancelled);
  const chartData = byDay.map((d) => ({ ...d, turnedAway: d.rejected + d.refused }));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <MiniStat
          label="Fill rate"
          value={fmt(totals.fillRatePct, 1, '%')}
          sub={`${totals.filled} filled · ${totals.rejected + totals.refused} turned away`}
        />
        <MiniStat label="Slippage mean" value={fmt(slippage.meanBps, 1, ' bps')} sub={`${slippage.n} measured`} tone={slippage.meanBps == null ? undefined : -slippage.meanBps} />
        <MiniStat label="Slippage median" value={fmt(slippage.medianBps, 1, ' bps')} sub="vs reference price" />
        <MiniStat label="Slippage p90 / worst" value={`${fmt(slippage.p90Bps, 0)} / ${fmt(slippage.worstBps, 0)}`} sub="bps, against you" />
        <MiniStat label="Latency mean" value={fmt(latency.meanMs, 0, ' ms')} sub={`${latency.n} acknowledged`} />
        <MiniStat label="Latency p90" value={fmt(latency.p90Ms, 0, ' ms')} sub={latency.maxMs == null ? undefined : `max ${latency.maxMs} ms`} />
        <MiniStat label="Refused pre-broker" value={String(totals.refused)} sub="guards + risk gate" tone={totals.refused ? -1 : undefined} />
        <MiniStat label="Adjusted" value={String(totals.adjusted)} sub="quantity changed by a gate or repair" />
      </div>

      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Last 30 days</h4>
        {anyDay ? (
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }} barGap={2}>
              <CartesianGrid stroke={p.grid} vertical={false} />
              <XAxis
                dataKey="day"
                tick={{ fontSize: 10, fill: p.muted }}
                tickLine={false}
                axisLine={{ stroke: p.axis }}
                minTickGap={24}
                tickFormatter={(d: string) => dayLabel(d)}
              />
              <YAxis tick={{ fontSize: 10, fill: p.muted }} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip
                cursor={{ fill: p.grid, opacity: 0.4 }}
                contentStyle={{ background: p.surface, border: `1px solid ${p.axis}`, borderRadius: 8, fontSize: 12, color: p.ink }}
                labelFormatter={(d) => dayLabel(String(d), true)}
              />
              <Legend verticalAlign="top" align="right" iconType="rect" wrapperStyle={{ fontSize: 11, color: p.muted }} />
              <Bar dataKey="filled" name="Filled" stackId="a" fill={p.nav} maxBarSize={20} isAnimationActive={false} />
              <Bar dataKey="turnedAway" name="Rejected or refused" stackId="a" fill={p.bad} maxBarSize={20} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="py-4 text-center text-xs text-zinc-400">No orders in the last 30 days.</p>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Rejections by reason</h4>
          {rejections.length === 0 ? (
            <p className="py-3 text-xs text-zinc-400">Nothing rejected or refused — every order reached the broker and filled.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-[10px] uppercase text-zinc-400 dark:border-zinc-800">
                  <th className="py-1.5 pr-3 font-medium">Reason</th>
                  <th className="py-1.5 pr-3 text-right font-medium">n</th>
                  <th className="py-1.5 font-medium">Where</th>
                </tr>
              </thead>
              <tbody>
                {rejections.map((r) => (
                  <tr key={r.reason} className="border-b border-zinc-100 dark:border-zinc-900" title={r.example}>
                    <td className="py-1.5 pr-3">{r.reason}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{r.n}</td>
                    <td className="py-1.5 space-x-1 text-xs text-zinc-500">
                      {r.fromGuards > 0 && <Badge tone="amber">guard ×{r.fromGuards}</Badge>}
                      {r.fromRisk > 0 && <Badge tone="red">risk ×{r.fromRisk}</Badge>}
                      {r.fromOrders > 0 && <Badge tone="neutral">broker ×{r.fromOrders}</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Orders by origin</h4>
          {byTag.length === 0 ? (
            <p className="py-3 text-xs text-zinc-400">No orders yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-[10px] uppercase text-zinc-400 dark:border-zinc-800">
                  <th className="py-1.5 pr-3 font-medium">Origin</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Orders</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Filled</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Rejected</th>
                  <th className="py-1.5 text-right font-medium">Cancelled</th>
                </tr>
              </thead>
              <tbody>
                {byTag.map((t) => (
                  <tr key={t.tag} className="border-b border-zinc-100 dark:border-zinc-900">
                    <td className="py-1.5 pr-3">
                      <Badge tone={t.tag === 'manual' || t.tag === 'flatten' ? 'amber' : 'blue'}>{t.tag}</Badge>
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{t.n}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{t.filled}</td>
                    <td className={`py-1.5 pr-3 text-right tabular-nums ${t.rejected ? 'text-rose-500' : ''}`}>{t.rejected}</td>
                    <td className="py-1.5 text-right tabular-nums">{t.cancelled}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {adjusted.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Adjusted orders</h4>
          <ul className="space-y-1 text-xs">
            {adjusted.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline gap-x-2 text-zinc-600 dark:text-zinc-300">
                <span className="font-medium">{a.symbol}</span>
                <span className="text-zinc-400">{a.side}</span>
                <span className="tabular-nums">
                  {a.requested != null ? `${a.requested} → ${a.quantity}` : `qty ${a.quantity}`}
                </span>
                <span className="text-zinc-500">{a.adjustment}</span>
                <span className="text-zinc-400">{istDateTime(a.createdAt, false)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
