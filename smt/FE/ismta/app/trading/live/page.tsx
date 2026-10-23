'use client';

import { useState } from 'react';
import { OrderTicket } from '../../components/OrderTicket';
import { NoLossHoldings } from '../../components/NoLossHoldings';
import { PositionsTable } from '../../components/PositionsTable';
import { PriceChart } from '../../components/PriceChart';
import { TriggersPanel, triggerPriceLines } from '../../components/TriggersPanel';
import { WatchlistPanel } from '../../components/WatchlistPanel';
import { Badge, Card, PageHeader } from '../../components/ui';
import { api, tradingApi } from '../../lib/api';
import { num } from '../../lib/format';
import { istYmd, sameDay } from '../../lib/ist';
import { istDateTime, istTime, useNow } from '../../lib/useNow';
import type { PlacedOrder } from '../../lib/types';
import { usePolling } from '../../lib/usePolling';
import { useLive } from '../../providers/LiveProvider';

/** Yahoo range/interval pairs behind the chart's range tabs. */
const RANGES = {
  '1D': ['1d', '1m'],
  '5D': ['5d', '5m'],
  '1M': ['1mo', '30m'],
  '6M': ['6mo', '1d'],
  '1Y': ['1y', '1d'],
} as const;
type RangeKey = keyof typeof RANGES;

export default function LiveTradingPage() {
  const { quotes } = useLive();
  const [rangeKey, setRangeKey] = useState<RangeKey>('1D');
  const [selected, setSelected] = useState('RELIANCE');
  const portfolio = usePolling(() => api.portfolio(), 3000);
  const orders = usePolling(() => api.orders(), 4000);
  const triggers = usePolling(() => tradingApi.triggers(), 4000);

  const position = portfolio.data?.positions.find((p) => p.symbol === selected) ?? null;
  const ltp = quotes[selected] ?? position?.ltp ?? 0;
  const allTriggers = triggers.data?.triggers ?? [];
  // Active trigger levels on the chart; the lines vanish when the trigger ends.
  const priceLines = triggerPriceLines(allTriggers, selected);

  const onPlaced = () => {
    portfolio.refresh();
    orders.refresh();
    triggers.refresh();
  };

  return (
    <div>
      <PageHeader title="Live Trading" subtitle="Watchlists, live chart, order ticket and standing triggers" />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <WatchlistPanel selected={selected} onSelect={setSelected} quotes={quotes} />

        <Card
          title={`${selected} — live`}
          className="lg:col-span-2"
          action={
            <div className="flex gap-1">
              {(Object.keys(RANGES) as RangeKey[]).map((k) => (
                <button
                  key={k}
                  onClick={() => setRangeKey(k)}
                  className={`rounded px-2 py-0.5 text-xs ${
                    rangeKey === k
                      ? 'bg-blue-600 text-white'
                      : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900'
                  }`}
                >
                  {k}
                </button>
              ))}
            </div>
          }
        >
          <PriceChart
            symbol={selected}
            livePrice={quotes[selected]}
            range={RANGES[rangeKey][0]}
            interval={RANGES[rangeKey][1]}
            priceLines={priceLines}
          />
          {priceLines.length > 0 && (
            <p className="mt-1 text-[11px] text-zinc-400">
              {priceLines.length} trigger level{priceLines.length === 1 ? '' : 's'} drawn:{' '}
              {priceLines.map((l) => `${l.title} @ ${num(l.price)}`).join(' · ')}
            </p>
          )}
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <OrderTicket symbol={selected} ltp={ltp} position={position} onPlaced={onPlaced} />

        <div className="space-y-4 lg:col-span-2">
          <Card title="Open Positions — strategy engine (MIS)">
            <PositionsTable positions={portfolio.data?.positions ?? []} />
          </Card>
          <NoLossHoldings />
          <Card title="Order History">
            <OrdersTable orders={orders.data?.orders ?? []} />
          </Card>
        </div>
      </div>

      <div className="mt-4">
        <TriggersPanel
          symbol={selected}
          ltp={ltp}
          position={position}
          triggers={allTriggers}
          loading={triggers.loading}
          onChanged={() => triggers.refresh()}
        />
      </div>
    </div>
  );
}

function OrdersTable({ orders }: { orders: PlacedOrder[] }) {
  // Time alone is ambiguous once the list spans days; anything not from today
  // (IST) carries its date. 0 = clock not read yet, so show dates until it is.
  const now = useNow(60_000);
  const today = now ? istYmd(now) : null;
  const when = (ts: number) =>
    today && sameDay(istYmd(ts), today) ? istTime(ts) : istDateTime(ts);
  if (!orders.length) return <p className="py-6 text-center text-sm text-zinc-400">No orders yet</p>;
  return (
    <div className="scroll-thin max-h-80 overflow-y-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left text-xs uppercase text-zinc-400 dark:border-zinc-800">
            <th className="py-2 pr-4 font-medium">Time</th>
            <th className="py-2 pr-4 font-medium">Symbol</th>
            <th className="py-2 pr-4 font-medium">Side</th>
            <th className="py-2 pr-4 font-medium">Qty</th>
            <th className="py-2 pr-4 font-medium">Fill</th>
            <th className="py-2 pr-4 font-medium">Slip</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 pr-4 font-medium">Source</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o, i) => (
            // A gate refusal is stored without an id; fall back so React can still key the row.
            <tr key={o.id || `${o.createdAt}-${i}`} className="border-b border-zinc-100 dark:border-zinc-900">
              <td className="whitespace-nowrap py-2 pr-4 text-xs tabular-nums text-zinc-400">{when(o.createdAt)}</td>
              <td className="py-2 pr-4 font-medium">
                {o.symbol}
                {o.product && <span className="ml-1 text-[10px] text-zinc-400">{o.product}</span>}
              </td>
              <td className="py-2 pr-4">
                <Badge tone={o.side === 'BUY' ? 'green' : 'red'}>{o.side}</Badge>
              </td>
              <td className="py-2 pr-4 tabular-nums" title={o.adjustment}>
                {o.quantity}
                {o.requestedQuantity != null && o.requestedQuantity !== o.quantity && (
                  <span className="text-[10px] text-amber-600"> of {o.requestedQuantity}</span>
                )}
              </td>
              <td className="py-2 pr-4 tabular-nums">{o.filledPrice ? num(o.filledPrice) : '—'}</td>
              <td className={`whitespace-nowrap py-2 pr-4 text-xs tabular-nums ${o.slippageBps != null && o.slippageBps > 0 ? 'text-rose-500' : 'text-zinc-400'}`}>
                {o.slippageBps != null ? `${o.slippageBps > 0 ? '+' : ''}${o.slippageBps.toFixed(1)} bps` : '—'}
              </td>
              <td className="py-2 pr-4">
                <Badge tone={o.status === 'FILLED' ? 'green' : o.status === 'REJECTED' ? 'red' : 'neutral'}>{o.status}</Badge>
                {o.rejectionReason && <span className="ml-1 text-[10px] text-rose-500">{o.rejectionReason}</span>}
              </td>
              <td className="py-2 pr-4 text-xs text-zinc-400">{o.tag ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
