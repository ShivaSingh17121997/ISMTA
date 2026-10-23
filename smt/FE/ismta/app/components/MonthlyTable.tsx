'use client';

import type { CSSProperties } from 'react';
import { inr, pct, pnlColor } from '../lib/format';
import type { MonthRow } from '../lib/types';

/**
 * Month rows: rupee P&L (net of any deposits), the unit-price return, NIFTY's
 * return over the same days, and the difference. Cells carry a green/red wash
 * whose intensity scales with the biggest month on screen, so the shape of a
 * year reads from across the room and no single month shouts.
 */

const UP = '16,185,129'; // emerald-500
const DOWN = '244,63,94'; // rose-500
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return y && m ? `${MONTHS[m - 1]} ${y}` : month;
}

function tint(value: number | null, maxAbs: number): CSSProperties {
  if (value == null || value === 0 || maxAbs <= 0) return {};
  const ratio = Math.min(1, Math.abs(value) / maxAbs);
  const rgb = value > 0 ? UP : DOWN;
  return { background: `rgba(${rgb},${0.06 + 0.24 * ratio})` };
}

export function MonthlyTable({ rows }: { rows: MonthRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-zinc-400">
        No months yet — a row appears once the curve has at least one day.
      </p>
    );
  }
  const maxPct = Math.max(
    1e-9,
    ...rows.map((r) => Math.abs(r.pct)),
    ...rows.map((r) => (r.niftyPct == null ? 0 : Math.abs(r.niftyPct))),
  );
  const maxPnl = Math.max(1e-9, ...rows.map((r) => Math.abs(r.pnl)));
  const active = (r: MonthRow) => (r.niftyPct == null ? null : r.pct - r.niftyPct);
  const maxActive = Math.max(1e-9, ...rows.map((r) => Math.abs(active(r) ?? 0)));
  const total = rows.reduce((s, r) => s + r.pnl, 0);

  return (
    <div className="scroll-thin overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left text-xs uppercase text-zinc-400 dark:border-zinc-800">
            <th className="py-2 pr-3 font-medium">Month</th>
            <th className="py-2 pr-3 text-right font-medium">P&amp;L</th>
            <th className="py-2 pr-3 text-right font-medium">Return</th>
            <th className="py-2 pr-3 text-right font-medium">NIFTY 50</th>
            <th className="py-2 text-right font-medium">Active</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const a = active(r);
            return (
              <tr key={r.month} className="border-b border-zinc-100 dark:border-zinc-900">
                <td className="py-1.5 pr-3 font-medium whitespace-nowrap">{monthLabel(r.month)}</td>
                <td className={`py-1.5 pr-3 text-right tabular-nums ${pnlColor(r.pnl)}`} style={tint(r.pnl, maxPnl)}>
                  {inr(r.pnl, 0)}
                </td>
                <td className={`py-1.5 pr-3 text-right tabular-nums ${pnlColor(r.pct)}`} style={tint(r.pct, maxPct)}>
                  {pct(r.pct)}
                </td>
                <td
                  className={`py-1.5 pr-3 text-right tabular-nums ${r.niftyPct == null ? 'text-zinc-400' : pnlColor(r.niftyPct)}`}
                  style={tint(r.niftyPct, maxPct)}
                  title={r.niftyPct == null ? 'NIFTY 50 close not available for this month' : undefined}
                >
                  {r.niftyPct == null ? '—' : pct(r.niftyPct)}
                </td>
                <td
                  className={`py-1.5 text-right tabular-nums ${a == null ? 'text-zinc-400' : pnlColor(a)}`}
                  style={tint(a, maxActive)}
                  title="Your return minus NIFTY's over the same days"
                >
                  {a == null ? '—' : pct(a)}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="text-xs">
            <td className="pt-2 text-zinc-500">Total</td>
            <td className={`pt-2 pr-3 text-right font-semibold tabular-nums ${pnlColor(total)}`}>{inr(total, 0)}</td>
            <td colSpan={3} className="pt-2 text-right text-zinc-400">
              net of deposits and withdrawals
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
