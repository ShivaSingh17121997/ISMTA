'use client';

import { dateTime, inr, num, pnlColor } from '../lib/format';
import type { ExitReason, Trade } from '../lib/types';
import { Badge } from './ui';

/**
 * How a trade ended, at a glance. This is the number that tells you whether the
 * trailing engine is earning its keep: `trailing` means a winner ran and the
 * ratchet released it, `stop_loss` means the entry was simply wrong.
 */
const EXIT_LABEL: Record<ExitReason, { text: string; tone: 'green' | 'red' | 'blue' | 'neutral' }> = {
  trailing: { text: 'trailed', tone: 'green' },
  take_profit: { text: 'target', tone: 'green' },
  stop_loss: { text: 'stopped', tone: 'red' },
  manual: { text: 'manual', tone: 'neutral' },
  square_off: { text: 'squared off', tone: 'blue' },
};

export function TradesTable({ trades, limit }: { trades: Trade[]; limit?: number }) {
  const rows = limit ? trades.slice(0, limit) : trades;
  if (!rows.length) {
    return <p className="py-6 text-center text-sm text-zinc-400">No trades yet</p>;
  }
  return (
    <div className="scroll-thin overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left text-xs uppercase text-zinc-400 dark:border-zinc-800">
            <th className="py-2 pr-4 font-medium">Symbol</th>
            <th className="py-2 pr-4 font-medium">Side</th>
            <th className="py-2 pr-4 font-medium">Qty</th>
            <th className="py-2 pr-4 font-medium">Entry</th>
            <th className="py-2 pr-4 font-medium">Exit</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 pr-4 font-medium">Closed by</th>
            <th className="py-2 pr-4 text-right font-medium">Net P&amp;L</th>
            <th className="py-2 pr-4 font-medium">Opened</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className="border-b border-zinc-100 dark:border-zinc-900">
              <td className="py-2 pr-4 font-medium">{t.symbol}</td>
              <td className="py-2 pr-4">
                <Badge tone={t.side === 'BUY' ? 'green' : 'red'}>{t.side}</Badge>
              </td>
              <td className="py-2 pr-4 tabular-nums">{t.quantity}</td>
              <td className="py-2 pr-4 tabular-nums">{num(t.entryPrice)}</td>
              <td className="py-2 pr-4 tabular-nums">{t.exitPrice ? num(t.exitPrice) : '—'}</td>
              <td className="py-2 pr-4">
                <Badge tone={t.status === 'OPEN' ? 'blue' : 'neutral'}>{t.status}</Badge>
              </td>
              <td className="py-2 pr-4 whitespace-nowrap">
                {t.exitReason ? (
                  <>
                    <Badge tone={EXIT_LABEL[t.exitReason]?.tone ?? 'neutral'}>
                      {EXIT_LABEL[t.exitReason]?.text ?? t.exitReason}
                    </Badge>
                    {/* A gapped stop filled worse than its level — the loss is
                        larger than the configured stop, and that must be visible. */}
                    {t.gapped && (
                      <span className="ml-1" title="Price gapped through the stop — filled worse than the stop level">
                        <Badge tone="amber">gapped</Badge>
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-zinc-400">—</span>
                )}
              </td>
              <td
                className={`py-2 pr-4 text-right tabular-nums ${pnlColor(t.pnl)}`}
                title={t.charges != null ? `after ₹${t.charges.toFixed(2)} in charges` : undefined}
              >
                {t.status === 'CLOSED' ? inr(t.pnl) : '—'}
              </td>
              <td className="py-2 pr-4 text-xs text-zinc-400">{dateTime(t.openedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
