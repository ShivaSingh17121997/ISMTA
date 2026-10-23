'use client';

import Link from 'next/link';
import { api } from '../lib/api';
import { inr, num, pct, pnlColor } from '../lib/format';
import { usePolling } from '../lib/usePolling';
import { Card } from './ui';

/**
 * The accumulator's open lots, for pages that otherwise only see the strategy
 * engine.
 *
 * The risk page and the trade page read the strategy engine's store (MIS,
 * intraday), so with every rupee sitting in no-loss delivery lots they said
 * "₹0 margin used" and "no open positions" — true of that engine, and wrong as
 * a description of the account. This lists those holdings beside them, under
 * their own heading, and says plainly that the engine's limits do not cover
 * them. It never adds them into the engine's numbers.
 */
export function NoLossHoldings({ className = '' }: { className?: string }) {
  const acc = usePolling(() => api.accumulator(), 10_000);

  const rows = (acc.data?.books ?? [])
    .map((b) => {
      const lots = b.lots ?? b.book.openLots ?? [];
      const qty = lots.reduce((s, l) => s + l.quantity, 0);
      return {
        symbol: b.book.symbol,
        qty,
        // Average fill, not breakeven — the same "avg" a broker holding shows.
        avg: qty > 0 ? lots.reduce((s, l) => s + l.fillPrice * l.quantity, 0) / qty : 0,
        // Priced at the same mark the book reports unrealised P&L against.
        value: qty * b.mark,
        unrealised: b.report.unrealisedPnl,
        unrealisedPct: b.report.unrealisedPct,
      };
    })
    .filter((r) => r.qty > 0)
    .sort((a, b) => b.value - a.value);
  const total = rows.reduce((s, r) => s + r.value, 0);
  const totalPnl = rows.reduce((s, r) => s + r.unrealised, 0);

  return (
    <Card
      title="No-loss holdings (accumulator, CNC delivery)"
      className={className}
      action={
        <Link href="/accumulator" className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300">
          Accumulator
        </Link>
      }
    >
      <p className="mb-3 text-xs text-zinc-500">
        Delivery lots held by the no-loss accumulator. They are not strategy-engine positions: the
        strategy engine&apos;s MIS margin, position-count and daily-loss limits do not apply to them,
        and each lot is only ever sold above its fee-inclusive cost.
      </p>
      {acc.loading && !acc.data ? (
        <p className="py-4 text-center text-sm text-zinc-400">Loading…</p>
      ) : !rows.length ? (
        <p className="py-4 text-center text-sm text-zinc-400">No open no-loss lots</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs uppercase text-zinc-400 dark:border-zinc-800">
                <th className="py-2 pr-4 font-medium">Symbol</th>
                <th className="py-2 pr-4 text-right font-medium">Qty</th>
                <th className="py-2 pr-4 text-right font-medium">Avg</th>
                <th className="py-2 pr-4 text-right font-medium">Value</th>
                <th className="py-2 text-right font-medium">Unrealised</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.symbol} className="border-b border-zinc-100 dark:border-zinc-900">
                  <td className="py-2 pr-4 font-medium">
                    <Link href={`/accumulator/${encodeURIComponent(r.symbol)}`} className="hover:underline">
                      {r.symbol}
                    </Link>
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{num(r.qty, 0)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{inr(r.avg)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{inr(r.value, 0)}</td>
                  <td className={`whitespace-nowrap py-2 text-right tabular-nums ${pnlColor(r.unrealised)}`}>
                    {inr(r.unrealised, 0)} <span className="text-[10px]">({pct(r.unrealisedPct, 1)})</span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="text-xs text-zinc-500">
                <td className="pt-2 pr-4" colSpan={3}>
                  {rows.length} holding{rows.length === 1 ? '' : 's'}
                </td>
                <td className="pt-2 pr-4 text-right tabular-nums">{inr(total, 0)}</td>
                <td className={`pt-2 text-right tabular-nums ${pnlColor(totalPnl)}`}>{inr(totalPnl, 0)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  );
}
