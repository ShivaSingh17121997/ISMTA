'use client';

import type { ReactNode } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useChartPalette, type ChartPalette } from '../lib/chartPalette';
import { dayLabel, inr, num } from '../lib/format';
import type { NavPoint } from '../lib/types';

/**
 * NAV against NIFTY 50, both rebased to 1000 on the first day of the series, so
 * the two lines share ONE axis. Two measures of different scale on two axes
 * would let the reader see a correlation that is an artefact of the scales;
 * indexing both to a common base is the honest form.
 *
 * Colours follow the app theme (class-based dark mode via ThemeProvider), not
 * the OS setting alone. The pair — slot-1 blue for the account, slot-2 orange
 * for the benchmark — passes the colour-vision separation checks on both the
 * white and the zinc-950 card surface.
 */

/**
 * The palette now lives in `lib/chartPalette` so non-charting pages can read a
 * colour without importing Recharts. Re-exported here because every existing
 * caller imports it from this file.
 */
export { useChartPalette, type ChartPalette };
/** Also moved to `lib/format`, for the same reason. Re-exported for callers. */
export { dayLabel };

const SOURCE_LABEL: Record<NavPoint['source'], string> = {
  baseline: 'baseline — your capital',
  reconstructed: 'reconstructed from realised P&L',
  snapshot: 'end-of-day snapshot',
  carried: 'carried forward (no snapshot that day)',
  live: 'live',
};

export function NavChart({ points, height = 300 }: { points: NavPoint[]; height?: number }) {
  const p = useChartPalette();
  const hasNifty = points.some((x) => x.niftyNav != null);
  const spansYears = points.length > 1 && points[0].day.slice(0, 4) !== points[points.length - 1].day.slice(0, 4);

  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={points} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={p.grid} strokeWidth={1} vertical={false} />
          <XAxis
            dataKey="day"
            tick={{ fontSize: 11, fill: p.muted }}
            tickLine={false}
            axisLine={{ stroke: p.axis }}
            minTickGap={36}
            tickFormatter={(d: string) => dayLabel(d, spansYears)}
          />
          <YAxis
            tick={{ fontSize: 11, fill: p.muted }}
            tickLine={false}
            axisLine={false}
            domain={['auto', 'auto']}
            width={56}
            tickFormatter={(v: number) => num(v, 0)}
          />
          <Tooltip
            cursor={{ stroke: p.axis, strokeWidth: 1 }}
            content={({ active, payload }) => {
              const row = payload?.[0]?.payload as NavPoint | undefined;
              if (!active || !row) return null;
              return (
                <div
                  className="rounded-lg border px-3 py-2 text-xs shadow-lg"
                  style={{ background: p.surface, borderColor: p.axis, color: p.ink }}
                >
                  <div className="mb-1 font-semibold">{dayLabel(row.day, true)}</div>
                  <TipRow swatch={p.nav} label="NAV" value={num(row.nav, 2)} />
                  <TipRow label="Equity" value={inr(row.equity, 0)} muted={p.muted} />
                  <TipRow label="Deployed" value={inr(row.deployed, 0)} muted={p.muted} />
                  {row.niftyNav != null && <TipRow swatch={p.nifty} label="NIFTY 50" value={num(row.niftyNav, 2)} />}
                  {row.nifty != null && <TipRow label="NIFTY close" value={num(row.nifty, 2)} muted={p.muted} />}
                  <div className="mt-1 text-[10px]" style={{ color: p.muted }}>
                    {SOURCE_LABEL[row.source]}
                  </div>
                </div>
              );
            }}
          />
          <Legend
            verticalAlign="top"
            align="right"
            iconType="plainline"
            wrapperStyle={{ fontSize: 11, color: p.muted, paddingBottom: 8 }}
          />
          <Line
            type="linear"
            dataKey="nav"
            name="NAV"
            stroke={p.nav}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, stroke: p.surface, strokeWidth: 2, fill: p.nav }}
            isAnimationActive={false}
          />
          {hasNifty && (
            <Line
              type="linear"
              dataKey="niftyNav"
              name="NIFTY 50"
              stroke={p.nifty}
              strokeWidth={2}
              dot={false}
              connectNulls
              activeDot={{ r: 4, stroke: p.surface, strokeWidth: 2, fill: p.nifty }}
              isAnimationActive={false}
            />
          )}
        </LineChart>
      </ResponsiveContainer>

      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
          Show as table ({points.length} day{points.length === 1 ? '' : 's'})
        </summary>
        <div className="scroll-thin mt-2 max-h-64 overflow-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-[10px] uppercase text-zinc-400 dark:border-zinc-800">
                <th className="py-1 pr-3 font-medium">Day</th>
                <th className="py-1 pr-3 text-right font-medium">Equity</th>
                <th className="py-1 pr-3 text-right font-medium">NAV</th>
                <th className="py-1 pr-3 text-right font-medium">NIFTY 50</th>
                <th className="py-1 pr-3 text-right font-medium">Deployed</th>
                <th className="py-1 pr-3 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {points.map((r) => (
                <tr key={r.day} className="border-b border-zinc-100 dark:border-zinc-900">
                  <td className="py-1 pr-3 tabular-nums">{r.day}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{inr(r.equity, 0)}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{num(r.nav, 2)}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{r.niftyNav == null ? '—' : num(r.niftyNav, 2)}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{inr(r.deployed, 0)}</td>
                  <td className="py-1 pr-3 text-zinc-500">{SOURCE_LABEL[r.source]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function TipRow({ swatch, label, value, muted }: { swatch?: string; label: string; value: ReactNode; muted?: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="inline-flex items-center gap-1.5" style={{ color: muted }}>
        {swatch && <span className="inline-block h-0.5 w-3 rounded" style={{ background: swatch }} />}
        {label}
      </span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}
