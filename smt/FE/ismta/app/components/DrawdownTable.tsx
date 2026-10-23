'use client';

import { pct } from '../lib/format';
import type { DrawdownRow } from '../lib/types';
import { Badge } from './ui';
import { dayLabel } from './NavChart';

/**
 * The five deepest peak-to-trough episodes in the unit price. An episode
 * without an end is still under water: its duration is measured to today and
 * grows every day the peak is not regained.
 */
export function DrawdownTable({ rows }: { rows: DrawdownRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-zinc-400">
        No drawdown yet — NAV has never closed below an earlier peak.
      </p>
    );
  }
  return (
    <div className="scroll-thin overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left text-xs uppercase text-zinc-400 dark:border-zinc-800">
            <th className="py-2 pr-3 font-medium">Peak</th>
            <th className="py-2 pr-3 font-medium">Trough</th>
            <th className="py-2 pr-3 font-medium">Recovered</th>
            <th className="py-2 pr-3 text-right font-medium">Depth</th>
            <th className="py-2 text-right font-medium">Days</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.start}-${r.trough}`} className="border-b border-zinc-100 dark:border-zinc-900">
              <td className="py-1.5 pr-3 tabular-nums whitespace-nowrap">{dayLabel(r.start, true)}</td>
              <td className="py-1.5 pr-3 tabular-nums whitespace-nowrap">{dayLabel(r.trough, true)}</td>
              <td className="py-1.5 pr-3 whitespace-nowrap">
                {r.end ? (
                  <span className="tabular-nums">{dayLabel(r.end, true)}</span>
                ) : (
                  <Badge tone="amber">still under water</Badge>
                )}
              </td>
              <td className="py-1.5 pr-3 text-right font-semibold tabular-nums text-rose-500">{pct(r.depthPct)}</td>
              <td className="py-1.5 text-right tabular-nums" title={r.end ? 'peak to recovery' : 'peak to today, and counting'}>
                {r.days}
                {r.end ? '' : '+'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[10px] text-zinc-400">
        Depth is the unit-price fall from the peak to the trough. Days run from the peak to the day the peak was regained.
      </p>
    </div>
  );
}
