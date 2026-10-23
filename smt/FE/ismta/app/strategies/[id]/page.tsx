'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Badge, Card, PageHeader, StatCard } from '../../components/ui';
import { api } from '../../lib/api';
import { num, time } from '../../lib/format';
import type { Signal, SignalExtras } from '../../lib/types';
import { usePolling } from '../../lib/usePolling';

export default function StrategyDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const detail = usePolling(() => api.strategy(id), 3000);

  const strat = detail.data?.strategy;
  // The engine records stopPct/targetPct/referencePrice on a signal when it
  // computed them; the base Signal type predates those fields.
  const signals: (Signal & SignalExtras)[] = detail.data?.signals ?? [];
  const acted = signals.filter((s) => s.acted).length;

  return (
    <div>
      <PageHeader
        title={strat?.name ?? 'Strategy'}
        subtitle={strat ? `${strat.type.replace('_', ' ')} · ${strat.symbols.join(', ')}` : undefined}
        action={
          <Link href="/strategies" className="text-sm text-blue-600 hover:underline">
            ← Back
          </Link>
        }
      />

      {detail.error && <p className="text-sm text-rose-500">{detail.error}</p>}

      {strat && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="Status" value={strat.enabled ? 'LIVE' : 'OFF'} />
            <StatCard label="Quantity" value={String(strat.quantity)} sub={strat.exitMode ? `exit ${strat.exitMode}` : undefined} />
            <StatCard label="Signals" value={String(signals.length)} />
            <StatCard label="Executed" value={String(acted)} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card title="Parameters">
              <dl className="space-y-2 text-sm">
                {Object.entries(strat.params).map(([k, v]) => (
                  <div key={k} className="flex justify-between">
                    <dt className="text-zinc-500">{k}</dt>
                    <dd className="tabular-nums">{v}</dd>
                  </div>
                ))}
              </dl>
            </Card>

            <Card title="Signal history" className="lg:col-span-2">
              {signals.length === 0 ? (
                <p className="py-6 text-center text-sm text-zinc-400">No signals recorded yet</p>
              ) : (
                <ul className="scroll-thin max-h-96 space-y-2 overflow-y-auto">
                  {signals.map((sig, i) => (
                    <li
                      key={i}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-100 px-3 py-2 text-sm dark:border-zinc-900"
                    >
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <Badge tone={sig.action === 'BUY' ? 'green' : sig.action === 'SELL' ? 'red' : 'neutral'}>
                          {sig.action}
                        </Badge>
                        <span className="font-medium">{sig.symbol}</span>
                        <span className="text-zinc-500">{sig.reason}</span>
                        {(sig.referencePrice != null || sig.stopPct != null || sig.targetPct != null) && (
                          <span className="text-xs tabular-nums text-zinc-400">
                            {sig.referencePrice != null && <>ref {num(sig.referencePrice)}</>}
                            {sig.stopPct != null && (
                              <>
                                {' '}· stop <span className="text-rose-500">−{sig.stopPct}%</span>
                                {sig.stopLoss != null && ` (${num(sig.stopLoss)})`}
                              </>
                            )}
                            {sig.targetPct != null && sig.targetPct > 0 && (
                              <>
                                {' '}· target <span className="text-emerald-500">+{sig.targetPct}%</span>
                                {sig.takeProfit != null && ` (${num(sig.takeProfit)})`}
                              </>
                            )}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-zinc-400">
                        <span>conf {(sig.confidence * 100).toFixed(0)}%</span>
                        {sig.acted && <Badge tone="blue">executed</Badge>}
                        <span>{time(sig.timestamp)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
