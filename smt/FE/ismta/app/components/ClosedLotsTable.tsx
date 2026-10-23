'use client';

import { useMemo, useState } from 'react';
import { Card } from './ui';
import { dateTime, inr, pct } from '../lib/format';
import { istYmd, sameDay, sameMonth } from '../lib/ist';
import type { AccumulatorClosedLot } from '../lib/types';
import { useNow } from '../lib/useNow';

/**
 * Trade history for one stock: every lot this book has sold.
 *
 * Ported from the NTB bot's trades table — same filter/CSV/"show all" shape.
 * The columns differ because a trade here IS a lot: it carries the rung it was
 * bought on, the fee-inclusive floor it had to clear, and how long the capital
 * was locked up before it cleared.
 *
 * The hold column is the one to read. Profit per trade is guaranteed; time is
 * what the guarantee costs, and it is the only column that can be bad.
 */

const PAGE = 50;
type Filter = 'all' | 'today' | 'month';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All time' },
  { value: 'today', label: 'Today' },
  { value: 'month', label: 'This month' },
];

const csvCell = (v: string | number): string => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCsv(symbol: string, lots: AccumulatorClosedLot[]): string {
  const head = [
    'symbol', 'lotId', 'epoch', 'rung', 'quantity', 'buyPrice', 'costBasis',
    'netBreakeven', 'sellPrice', 'proceeds', 'profit', 'profitPct', 'holdDays', 'boughtAt', 'soldAt',
  ];
  const rows = lots.map((l) =>
    [
      symbol, l.id, l.epoch, l.level, l.quantity, l.fillPrice, l.quoteSpent,
      l.netBreakeven, l.sellPrice, l.proceeds, l.pnl,
      ((l.pnl / l.quoteSpent) * 100).toFixed(4),
      ((l.closedAt - l.openedAt) / 86_400_000).toFixed(2),
      new Date(l.openedAt).toISOString(), new Date(l.closedAt).toISOString(),
    ].map(csvCell).join(','),
  );
  return [head.join(','), ...rows].join('\n');
}

export function ClosedLotsTable({ symbol, lots }: { symbol: string; lots: AccumulatorClosedLot[] }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [showAll, setShowAll] = useState(false);
  // Hourly is plenty: these buckets only change at an IST midnight.
  const nowMs = useNow(3_600_000);

  const filtered = useMemo(() => {
    const now = istYmd(nowMs);
    const inRange = (ts: number) => {
      // Before the clock lands, no date window can be evaluated — show
      // everything rather than an empty table that looks like "no trades".
      if (nowMs === 0 || filter === 'all') return true;
      const p = istYmd(ts);
      return filter === 'today' ? sameDay(p, now) : sameMonth(p, now);
    };
    // Newest first: the most recent sale is the one being looked for.
    return lots.filter((l) => inRange(l.closedAt)).sort((a, b) => b.closedAt - a.closedAt);
  }, [lots, filter, nowMs]);

  const visible = showAll ? filtered : filtered.slice(0, PAGE);
  const total = filtered.reduce((s, l) => s + l.pnl, 0);

  function exportCsv() {
    const blob = new Blob([toCsv(symbol, filtered)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${symbol}-closed-lots-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card
      title="Trade history"
      action={
        <div className="flex items-center gap-2">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as Filter)}
            aria-label="Filter trades by period"
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
          >
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          <span className="text-xs text-zinc-500">
            {visible.length}
            {filtered.length > visible.length ? ` of ${filtered.length}` : ''}
          </span>
          <button
            onClick={exportCsv}
            disabled={!filtered.length}
            title="Download the filtered trades as CSV"
            className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            CSV
          </button>
        </div>
      }
    >
      <div className="max-h-96 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white text-[10px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-950">
            <tr className="border-b border-zinc-200 dark:border-zinc-800">
              <th className="whitespace-nowrap px-2 py-2 text-left font-medium">Sold</th>
              <th className="whitespace-nowrap px-2 py-2 text-left font-medium">Rung</th>
              <th className="whitespace-nowrap px-2 py-2 text-right font-medium">Qty</th>
              <th className="whitespace-nowrap px-2 py-2 text-right font-medium">Bought</th>
              <th
                className="whitespace-nowrap px-2 py-2 text-right font-medium"
                title="The fee-inclusive floor this sale had to clear"
              >
                Breakeven
              </th>
              <th className="whitespace-nowrap px-2 py-2 text-right font-medium">Sold at</th>
              <th className="whitespace-nowrap px-2 py-2 text-right font-medium">Profit</th>
              <th className="whitespace-nowrap px-2 py-2 text-right font-medium">%</th>
              <th
                className="whitespace-nowrap px-2 py-2 text-right font-medium"
                title="How long the capital was locked up. The only column here that can be bad."
              >
                Held
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={9} className="px-2 py-8 text-center text-sm text-zinc-500">
                  {lots.length === 0
                    ? 'No lots sold yet. A lot is only sold above its fee-inclusive cost, so this table fills up slowly and never shows a loss.'
                    : 'No trades in this period.'}
                </td>
              </tr>
            )}
            {visible.map((l) => {
              const days = (l.closedAt - l.openedAt) / 86_400_000;
              return (
                <tr
                  key={l.id}
                  className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/60 dark:hover:bg-zinc-900/40"
                >
                  <td className="whitespace-nowrap px-2 py-2 text-xs text-zinc-500">{dateTime(l.closedAt)}</td>
                  <td className="whitespace-nowrap px-2 py-2 font-mono text-xs">
                    e{l.epoch}·r{l.level}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{l.quantity}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{inr(l.fillPrice)}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-amber-600 dark:text-amber-400">
                    {inr(l.netBreakeven)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{inr(l.sellPrice)}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                    {inr(l.pnl)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                    {pct((l.pnl / l.quoteSpent) * 100, 2)}
                  </td>
                  <td
                    className={`whitespace-nowrap px-2 py-2 text-right tabular-nums ${
                      days > 180 ? 'text-rose-600 dark:text-rose-400' : days > 60 ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-500'
                    }`}
                  >
                    {days < 1 ? `${Math.round(days * 24)}h` : `${days.toFixed(0)}d`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!showAll && filtered.length > PAGE && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-2 w-full border-t border-zinc-200 py-2 text-center text-xs text-blue-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-blue-400 dark:hover:bg-zinc-900"
        >
          Show all {filtered.length} trades
        </button>
      )}

      {filtered.length > 0 && (
        <p className="mt-3 border-t border-zinc-200 pt-2 text-xs text-zinc-500 dark:border-zinc-800">
          {filtered.length} lot{filtered.length === 1 ? '' : 's'} sold for{' '}
          <span className="font-semibold text-emerald-600 dark:text-emerald-400">{inr(total)}</span>. Every
          row is a profit because the engine cannot sell below cost — that is an accounting identity, not
          a track record.
        </p>
      )}
    </Card>
  );
}
