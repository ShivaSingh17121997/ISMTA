'use client';

import { inr, num, pnlColor } from '../lib/format';
import type { Position } from '../lib/types';

export function PositionsTable({ positions }: { positions: Position[] }) {
  if (!positions.length) {
    return <p className="py-6 text-center text-sm text-zinc-400">No open positions</p>;
  }
  return (
    <div className="scroll-thin overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left text-xs uppercase text-zinc-400 dark:border-zinc-800">
            <th className="py-2 pr-4 font-medium">Symbol</th>
            <th className="py-2 pr-4 font-medium">Qty</th>
            <th className="py-2 pr-4 font-medium">Avg</th>
            <th className="py-2 pr-4 font-medium">LTP</th>
            <th className="py-2 pr-4 text-right font-medium">Unrealised P&L</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p.symbol} className="border-b border-zinc-100 dark:border-zinc-900">
              <td className="py-2 pr-4 font-medium">{p.symbol}</td>
              <td className="py-2 pr-4 tabular-nums">{p.quantity}</td>
              <td className="py-2 pr-4 tabular-nums">{num(p.avgPrice)}</td>
              <td className="py-2 pr-4 tabular-nums">{num(p.ltp)}</td>
              <td className={`py-2 pr-4 text-right tabular-nums ${pnlColor(p.unrealisedPnl)}`}>
                {inr(p.unrealisedPnl)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
