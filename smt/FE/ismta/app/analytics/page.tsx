'use client';

import { useState } from 'react';
import { DrawdownTable } from '../components/DrawdownTable';
import { ExecutionQuality } from '../components/ExecutionQuality';
import { JournalTable, type JournalPatch } from '../components/JournalTable';
import { MonthlyTable } from '../components/MonthlyTable';
import { NavChart } from '../components/NavChart';
import { StrategyComparison } from '../components/StrategyComparison';
import { Card, MiniStat, PageHeader, StatCard } from '../components/ui';
import { analyticsApi } from '../lib/api';
import { inr, num, pct } from '../lib/format';
import type { NavRange } from '../lib/types';
import { usePolling } from '../lib/usePolling';

/**
 * Performance analytics. The account as a unit price (NAV, base 1000) against
 * NIFTY 50 on one axis, the statistics that unit price supports, what the
 * round trip cost, how orders actually executed, and the journal.
 *
 * The one range control sits in the header and scopes the curve, the tiles,
 * the monthly table, the drawdowns, the costs and the trade statistics — every
 * number on the page agrees about which days it covers. Execution quality is
 * always the last 30 days; the journal is everything.
 */
export default function AnalyticsPage() {
  const [range, setRange] = useState<NavRange>('all');
  const [tag, setTag] = useState('');

  const nav = usePolling(() => analyticsApi.analyticsNav(range), 60_000);
  const exec = usePolling(() => analyticsApi.analyticsExecution(), 30_000);
  const journal = usePolling(() => analyticsApi.journal(tag ? { tag } : {}), 15_000);

  const changeRange = (r: NavRange) => {
    setRange(r);
    nav.refresh();
  };
  const changeTag = (t: string) => {
    setTag(t);
    journal.refresh();
  };
  const saveNote = async (id: string, patch: JournalPatch) => {
    await analyticsApi.patchJournal(id, patch);
    journal.refresh();
  };

  const r = nav.data;
  const s = r?.stats;
  const shortSpan = (s?.spanDays ?? 0) < 90;

  return (
    <div>
      <PageHeader
        title="Analytics"
        subtitle="NAV against NIFTY 50, costs, execution quality and the trade journal"
        action={
          <div className="flex items-center gap-1 rounded-lg border border-zinc-200 p-0.5 text-xs dark:border-zinc-800">
            {(['1y', 'all'] as NavRange[]).map((x) => (
              <button
                key={x}
                type="button"
                onClick={() => changeRange(x)}
                className={`rounded-md px-2.5 py-1 font-medium transition ${
                  range === x
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                    : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                }`}
              >
                {x === '1y' ? '1 year' : 'All time'}
              </button>
            ))}
          </div>
        }
      />

      {nav.error && (
        <p className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          Could not load the NAV curve: {nav.error}
        </p>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label={shortSpan ? 'Return' : 'CAGR'}
          value={s ? pct(shortSpan ? s.totalReturnPct : s.cagrPct) : '—'}
          colored={s ? (shortSpan ? s.totalReturnPct : s.cagrPct) : undefined}
          sub={
            s
              ? shortSpan
                ? `over ${s.spanDays} day${s.spanDays === 1 ? '' : 's'} · annualised ${pct(s.cagrPct)} means little yet`
                : `${pct(s.totalReturnPct)} total over ${s.spanDays} days`
              : undefined
          }
        />
        <StatCard
          label="Max drawdown"
          value={s ? pct(s.maxDrawdownPct) : '—'}
          colored={s ? s.maxDrawdownPct : undefined}
          sub={s ? (s.maxDrawdownPct < 0 ? `${s.maxDrawdownDays} day${s.maxDrawdownDays === 1 ? '' : 's'} peak to recovery` : 'never below a prior peak') : undefined}
        />
        <StatCard
          label="Current drawdown"
          value={s ? pct(s.currentDrawdownPct) : '—'}
          colored={s ? s.currentDrawdownPct : undefined}
          sub={s ? (s.currentDrawdownPct < 0 ? 'below the high-water mark' : 'at the high-water mark') : undefined}
        />
        <StatCard
          label="Exposure"
          value={s ? `${num(s.timeInMarketPct, 0)}%` : '—'}
          sub={r ? `days with capital deployed · ${inr(r.live.deployed, 0)} now` : undefined}
        />
        <StatCard
          label="Cost share"
          value={r ? (r.costs.costSharePct == null ? '—' : `${num(r.costs.costSharePct, 1)}%`) : '—'}
          sub={
            r
              ? r.costs.costSharePct == null
                ? `${inr(r.costs.charges, 0)} in charges, no gross profit to share`
                : `${inr(r.costs.charges, 0)} of ${inr(r.costs.grossProfit, 0)} gross went to charges`
              : undefined
          }
        />
        <StatCard
          label="Active return vs NIFTY"
          value={s ? (s.activeReturnPct == null ? '—' : pct(s.activeReturnPct)) : '—'}
          colored={s?.activeReturnPct ?? undefined}
          sub={s ? (s.niftyReturnPct == null ? 'NIFTY 50 closes unavailable' : `NIFTY ${pct(s.niftyReturnPct)} over the same days`) : undefined}
        />
      </div>

      <Card title="NAV vs NIFTY 50 — both rebased to 1000" className="mb-6">
        {!r ? (
          <p className="py-12 text-center text-sm text-zinc-400">{nav.loading ? 'Loading…' : 'No data'}</p>
        ) : r.points.length < 2 ? (
          <p className="py-12 text-center text-sm text-zinc-400">{r.meta.note}</p>
        ) : (
          <>
            <NavChart points={r.points} />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-zinc-500">
              <span>{r.meta.note}</span>
              {s && (
                <span className="tabular-nums">
                  vol {num(s.volPct, 1)}% · Sharpe {num(s.sharpe, 2)} · {r.points.length} days
                </span>
              )}
            </div>
          </>
        )}
      </Card>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card title="Monthly returns">
          {r ? <MonthlyTable rows={r.monthly} /> : <p className="py-8 text-center text-sm text-zinc-400">Loading…</p>}
        </Card>
        <Card title="Deepest drawdowns">
          {r ? <DrawdownTable rows={r.drawdowns} /> : <p className="py-8 text-center text-sm text-zinc-400">Loading…</p>}
        </Card>
      </div>

      <Card title="Trade statistics — closed lots and valid trades" className="mb-6">
        {!r ? (
          <p className="py-6 text-center text-sm text-zinc-400">Loading…</p>
        ) : r.tradeStats.n === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-400">
            No closed trades or sold lots in this range yet — the curve starts at your capital.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
              <MiniStat label="Closed" value={String(r.tradeStats.n)} sub={`${r.tradeStats.wins} won · ${r.tradeStats.losses} lost`} />
              <MiniStat label="Win rate" value={`${num(r.tradeStats.winRatePct, 0)}%`} />
              <MiniStat label="Avg win" value={r.tradeStats.wins ? inr(r.tradeStats.avgWin, 0) : '—'} tone={r.tradeStats.wins ? 1 : undefined} />
              <MiniStat label="Avg loss" value={r.tradeStats.losses ? inr(r.tradeStats.avgLoss, 0) : '—'} tone={r.tradeStats.losses ? -1 : undefined} />
              <MiniStat label="Payoff" value={r.tradeStats.payoff == null ? '—' : num(r.tradeStats.payoff, 2)} sub="avg win ÷ avg loss" />
              <MiniStat label="Expectancy" value={inr(r.tradeStats.expectancy, 0)} sub="per closed outcome" tone={r.tradeStats.expectancy} />
              <MiniStat label="Profit factor" value={r.tradeStats.profitFactor == null ? '—' : num(r.tradeStats.profitFactor, 2)} sub="gross wins ÷ gross losses" />
              <MiniStat label="Median hold" value={holdDays(r.tradeStats.medianHoldDays)} />
            </div>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-500">
              <span>
                Gross <b className="tabular-nums text-zinc-700 dark:text-zinc-200">{inr(r.costs.grossProfit, 0)}</b>
              </span>
              <span>
                Charges <b className="tabular-nums text-zinc-700 dark:text-zinc-200">{inr(r.costs.charges, 0)}</b>
              </span>
              <span>
                Net <b className={`tabular-nums ${r.costs.netProfit >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{inr(r.costs.netProfit, 0)}</b>
              </span>
              <span className="text-zinc-400">Lot charges = cost beyond the shares on both legs; trade charges as booked.</span>
            </div>
          </>
        )}
      </Card>

      <Card title="Execution quality — last 30 days" className="mb-6">
        {exec.error ? (
          <p className="py-6 text-center text-sm text-rose-500">Could not load execution data: {exec.error}</p>
        ) : !exec.data ? (
          <p className="py-6 text-center text-sm text-zinc-400">Loading…</p>
        ) : exec.data.totals.orders === 0 && exec.data.totals.refused === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-400">No orders yet — fills, slippage and rejections appear after the first order.</p>
        ) : (
          <ExecutionQuality report={exec.data} />
        )}
      </Card>

      <Card title="Trade journal" className="mb-6">
        {journal.error ? (
          <p className="py-6 text-center text-sm text-rose-500">Could not load the journal: {journal.error}</p>
        ) : !journal.data ? (
          <p className="py-6 text-center text-sm text-zinc-400">Loading…</p>
        ) : (
          <JournalTable report={journal.data} tag={tag} onTagChange={changeTag} onSave={saveNote} />
        )}
      </Card>

      <div className="mb-6">
        <StrategyComparison />
      </div>
    </div>
  );
}

function holdDays(days: number): string {
  if (days >= 1) return `${num(days, 1)} d`;
  const hours = days * 24;
  if (hours >= 1) return `${num(hours, 1)} h`;
  return `${num(hours * 60, 0)} min`;
}
