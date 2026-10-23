'use client';

import { useState } from 'react';
import { NoLossHoldings } from '../components/NoLossHoldings';
import { Card, PageHeader, StatCard } from '../components/ui';
import { api } from '../lib/api';
import { inr, pct } from '../lib/format';
import type { HoldingRisk, HoldingRiskState } from '../lib/types';
import { usePolling } from '../lib/usePolling';

export default function RiskPage() {
  const risk = usePolling(() => api.risk(), 3000);
  const r = risk.data?.risk;
  const alerts = risk.data?.alerts ?? [];

  return (
    <div>
      <PageHeader title="Risk Management" subtitle="Margin, daily loss limits & exposure monitoring" />

      {alerts.length > 0 && (
        <div className="mb-6 space-y-2">
          {alerts.map((a, i) => (
            <div
              key={i}
              className={`rounded-lg border px-4 py-3 text-sm ${
                a.level === 'critical'
                  ? 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300'
                  : 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'
              }`}
            >
              <span className="font-semibold uppercase">{a.level}</span> · {a.message}
            </div>
          ))}
        </div>
      )}

      {r && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="Capital" value={inr(r.capital)} />
            <StatCard label="Daily P&L" value={inr(r.dailyPnl)} colored={r.dailyPnl} />
            <StatCard label="Margin Used" value={inr(r.marginUsed)} sub="strategy engine (MIS)" />
            <StatCard label="Margin Available" value={inr(r.marginAvailable)} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card title="Daily Loss Limit">
              <Meter
                label={`${inr(Math.max(0, -r.dailyPnl), 0)} lost today of a ${inr(r.dailyLossLimit, 0)} daily loss limit`}
                pct={r.dailyLossUsedPct}
                danger
              />
            </Card>
            <Card title="Position Utilisation — strategy engine (MIS)">
              <Meter
                label={`${r.openPositions} of ${r.maxPositions} positions`}
                pct={(r.openPositions / r.maxPositions) * 100}
              />
            </Card>
          </div>

          {/* The limits above are the strategy engine's. The accumulator's
              delivery lots sit outside them and are listed separately, so
              "0 positions" is never read as "nothing held". */}
          <NoLossHoldings className="mt-4" />

          <div className="mt-4">
            <HoldingsTurbulence />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Is the red number on the screen ordinary for this stock?
 *
 * Usually it is, and that is the whole point. Roughly two thirds of stocks fall
 * 5% at some point within three months, and the study behind this found no
 * condition under which such a fall predicted a worse outcome. Selling into one
 * is a decision made on discomfort rather than information, and this panel
 * exists to take the discomfort away.
 *
 * Loaded on demand, never polled: it reads up to a decade of daily bars per
 * uncached symbol.
 */
function HoldingsTurbulence() {
  const [data, setData] = useState<HoldingRiskState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.holdingRisk());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card title="Is this drawdown normal?">
      {!data && (
        <div className="text-sm text-zinc-500">
          <p className="mb-3">
            Compares each open position&apos;s drawdown with what is ordinary for that stock, so a
            fall inside the usual range is not mistaken for a broken thesis. Reads up to ten years
            of daily bars, so it is fetched on request rather than polled.
          </p>
          <button
            onClick={load}
            disabled={loading}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            {loading ? 'Measuring…' : 'Check my positions'}
          </button>
          {error && <p className="mt-2 text-rose-600 dark:text-rose-400">{error}</p>}
        </div>
      )}

      {data && data.holdings.length === 0 && (
        <p className="text-sm text-zinc-500">No open positions to assess.</p>
      )}

      {data && data.holdings.length > 0 && (
        <>
          <ul className="space-y-2">
            {data.holdings.map((h) => (
              <HoldingRow key={h.symbol} h={h} />
            ))}
          </ul>
          <p className="mt-3 border-t border-zinc-200 pt-2 text-[11px] leading-snug text-zinc-500 dark:border-zinc-800">
            {data.note}
          </p>
          <button
            onClick={load}
            disabled={loading}
            className="mt-2 text-[11px] text-zinc-500 underline hover:text-zinc-700 disabled:opacity-50 dark:hover:text-zinc-300"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </>
      )}
    </Card>
  );
}

const verdictStyle: Record<HoldingRisk['verdict'], { label: string; cls: string }> = {
  fine: { label: 'In profit', cls: 'text-emerald-600 dark:text-emerald-400' },
  // The important one. Phrased as reassurance because that is what it is.
  'normal-dip': { label: 'Normal dip', cls: 'text-zinc-500' },
  'beyond-normal': { label: 'Past normal', cls: 'text-amber-600 dark:text-amber-400' },
  deep: { label: 'Deep', cls: 'text-rose-600 dark:text-rose-400' },
  unknown: { label: 'Unknown', cls: 'text-zinc-400' },
};

function HoldingRow({ h }: { h: HoldingRisk }) {
  const v = verdictStyle[h.verdict];
  return (
    <li className="rounded-md border border-zinc-200 p-2.5 dark:border-zinc-800">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">{h.symbol}</span>
        <span className="flex items-baseline gap-2 text-sm">
          <span className={`text-[11px] font-medium ${v.cls}`}>{v.label}</span>
          <span
            className={`font-mono tabular-nums ${
              h.unrealisedPnlPct >= 0
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-rose-600 dark:text-rose-400'
            }`}
          >
            {pct(h.unrealisedPnlPct, 1)}
          </span>
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-snug text-zinc-500">{h.note}</p>
      {h.turbulence && (
        <p className="mt-1 text-[10px] text-zinc-400">
          {h.quantity} @ {inr(h.avgPrice)} · now {inr(h.ltp)} · {h.turbulence.summary}
        </p>
      )}
    </li>
  );
}

function Meter({ label, pct, danger }: { label: string; pct: number; danger?: boolean }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const color = danger
    ? clamped >= 100
      ? 'bg-rose-600'
      : clamped >= 70
        ? 'bg-amber-500'
        : 'bg-emerald-500'
    : clamped >= 100
      ? 'bg-amber-500'
      : 'bg-blue-600';
  return (
    <div>
      <div className="mb-2 flex justify-between text-sm text-zinc-500">
        <span>{label}</span>
        <span className="tabular-nums">{clamped.toFixed(0)}%</span>
      </div>
      <div className="h-3 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}
