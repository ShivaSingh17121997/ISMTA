'use client';

import { useEffect, useState } from 'react';
import { Badge, Card, MiniStat } from './ui';
import { api } from '../lib/api';
import { dateTime, inr, pct, pnlColor } from '../lib/format';
import type { AllocationParams, Allocation, AllocatorRun, RungPlan } from '../lib/types';
import { usePolling } from '../lib/usePolling';
import { useTradingLive } from '../lib/venue';

/**
 * Capital allocator.
 *
 * The user asked the bot to decide which companies get the paper capital and
 * how much. This panel shows exactly what it decided and the numbers it
 * decided from. The strength score is a ranking of what HAS been rising —
 * three-month and one-month return, distance from the 45-day high, and
 * whether EMA50 sits above EMA200 — and it is shown beside those inputs so it
 * never reads as a forecast. A run moves only settled, uncommitted cash: no
 * lot is ever sold or shifted to rebalance.
 *
 * Any company's amount can also be fixed by hand ("Your amount"). Those are
 * funded first and exactly; the bot splits only what is left.
 */
export function AllocatorPanel({
  names,
  onChanged,
}: {
  names: Map<string, string>;
  onChanged: () => void;
}) {
  const state = usePolling(() => api.allocator(), 15000);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function runNow() {
    setRunning(true);
    setError(null);
    try {
      await api.runAllocator();
      state.refresh();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  const run = state.data?.run ?? null;

  async function saveBudget(symbol: string, amount: number | null, rungs: number | null) {
    setError(null);
    setNotice(null);
    try {
      const r = await api.setManualBudget(symbol, amount, rungs);
      if (r.pending) setNotice(`${symbol}: ${r.pending}`);
      state.refresh();
      onChanged();
      return true;
    } catch (e) {
      setError(`${symbol}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  return (
    <Card
      title="Capital allocator — how the bot sizes each company"
      className="mb-6"
      action={
        <button
          onClick={runNow}
          disabled={running}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          title="Re-score every company from a year of daily bars and re-assign the free cash"
        >
          {running ? 'Scoring…' : 'Run allocator now'}
        </button>
      }
    >
      {error && (
        <div className="mb-4 rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 rounded-lg border border-blue-300 bg-blue-50 px-4 py-3 text-sm text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300">
          {notice}
        </div>
      )}

      {!run ? (
        <p className="text-sm text-zinc-500">
          {state.loading
            ? 'Loading…'
            : 'Not run yet. It runs once at start-up and once a day after the 15:35 IST close, or press the button.'}
        </p>
      ) : (
        <RunView
          run={run}
          names={names}
          params={state.data?.params}
          schedule={state.data?.schedule}
          note={state.data?.note}
          manualBudgets={state.data?.manualBudgets ?? {}}
          manualTranches={state.data?.manualTranches ?? {}}
          minManualCashBy={state.data?.minManualCashBy ?? {}}
          onSaveBudget={saveBudget}
        />
      )}
    </Card>
  );
}

function RunView({
  run,
  names,
  params,
  schedule,
  note,
  manualBudgets,
  manualTranches,
  minManualCashBy,
  onSaveBudget,
}: {
  run: AllocatorRun;
  names: Map<string, string>;
  params?: AllocationParams;
  schedule?: { due: boolean; why: string };
  note?: string;
  manualBudgets: Record<string, number>;
  manualTranches: Record<string, number>;
  minManualCashBy: Record<string, { newCash: number; why: string }>;
  onSaveBudget: (symbol: string, amount: number | null, rungs: number | null) => Promise<boolean>;
}) {
  const live = useTradingLive();
  const plan = run.plan;
  const rows = [...plan.allocations].sort(byRank);
  const manualCount = Object.keys(manualBudgets).length;

  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-6">
        <MiniStat
          label={live ? 'Zerodha capital' : 'Paper capital'}
          value={inr(plan.totalCapital, 0)}
          sub={live ? 'Free cash at Zerodha, plus open lots' : undefined}
        />
        <MiniStat label="In open lots / T+1" value={inr(plan.committed, 0)} sub="Never moved by a run" />
        <MiniStat label="Free to assign" value={inr(plan.allocatable, 0)} />
        <MiniStat
          label="Set by you"
          value={inr(plan.manualCash ?? 0, 0)}
          sub={`${manualCount} compan${manualCount === 1 ? 'y' : 'ies'} sized by hand`}
        />
        <MiniStat
          label="Assigned"
          value={inr(plan.allocatable - plan.unallocated, 0)}
          sub={`${plan.selected.length} of ${plan.allocations.length} companies funded`}
        />
        <MiniStat label="Left unassigned" value={inr(plan.unallocated, 0)} sub="Rounding to ₹1,000" />
      </div>

      {/* relative: the inputs' sr-only labels are absolute and would otherwise escape this scroll box and widen the page on phones */}
      <div className="relative overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="whitespace-nowrap px-2 py-2 text-left font-medium">#</th>
              <th className="whitespace-nowrap px-2 py-2 text-left font-medium">Company</th>
              <th className="whitespace-nowrap px-2 py-2 text-left font-medium">Strength</th>
              <th className="whitespace-nowrap px-2 py-2 text-right font-medium">3-month</th>
              <th className="whitespace-nowrap px-2 py-2 text-right font-medium">1-month</th>
              <th className="whitespace-nowrap px-2 py-2 text-right font-medium">vs 45-day high</th>
              {/* Long-term (EMA50 vs EMA200) — deliberately named, because the
                  stock table's ▲/▼ is the short-term EMA20/50 regime and the
                  two can disagree on the same day without either being wrong. */}
              <th
                className="whitespace-nowrap px-2 py-2 text-left font-medium"
                title="Long-term trend filter: EMA50 above EMA200 = Up. A Down stock is never funded. Differs from the short-term 20/50 regime shown in the stock table."
              >
                Long-term trend (50/200)
              </th>
              <th
                className="whitespace-nowrap px-2 py-2 text-left font-medium"
                title="Total for this company, including what is already in its open lots, and how many rungs to split it into. Empty = the bot decides."
              >
                Your amount · rungs
              </th>
              <th className="whitespace-nowrap px-2 py-2 text-right font-medium">Cash assigned</th>
              <th className="whitespace-nowrap px-2 py-2 text-right font-medium">Rungs</th>
              <th className="whitespace-nowrap px-2 py-2 text-left font-medium">Why</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const s = run.strengths[a.symbol];
              return (
                <tr
                  key={a.symbol}
                  className={`border-t border-zinc-100 dark:border-zinc-800 ${a.selected ? '' : 'text-zinc-500'}`}
                >
                  <td className="px-2 py-2 tabular-nums">
                    {a.manual ? (
                      <Badge tone="blue">You</Badge>
                    ) : a.core ? (
                      <Badge tone="green">Core {a.rank}</Badge>
                    ) : a.rescue ? (
                      <Badge tone="amber">Rescue</Badge>
                    ) : (
                      (a.rank ?? '—')
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <span className="font-mono text-xs font-semibold">{a.symbol}</span>
                    {names.get(a.symbol) && names.get(a.symbol) !== a.symbol && (
                      <span className="block text-xs text-zinc-500">{names.get(a.symbol)}</span>
                    )}
                  </td>
                  <td className="px-2 py-2">{s?.eligible ? <ScoreBar score={a.score} /> : '—'}</td>
                  <td className={`px-2 py-2 text-right tabular-nums ${s?.eligible ? pnlColor(s.ret3mPct) : ''}`}>
                    {s?.eligible ? pct(s.ret3mPct, 1) : '—'}
                  </td>
                  <td className={`px-2 py-2 text-right tabular-nums ${s?.eligible ? pnlColor(s.ret1mPct) : ''}`}>
                    {s?.eligible ? pct(s.ret1mPct, 1) : '—'}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{s?.eligible ? pct(s.distFromHighPct, 1) : '—'}</td>
                  <td className="px-2 py-2">
                    {s?.eligible ? (
                      <Badge tone={s.trendUp ? 'green' : 'red'}>{s.trendUp ? 'Up' : 'Down'}</Badge>
                    ) : (
                      <Badge tone="neutral">n/a</Badge>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <BudgetCell
                      key={`${a.symbol}:${manualBudgets[a.symbol] ?? 'auto'}:${manualTranches[a.symbol] ?? 'auto'}`}
                      symbol={a.symbol}
                      saved={manualBudgets[a.symbol]}
                      savedRungs={manualTranches[a.symbol]}
                      held={a.targetBudget - a.targetCash}
                      minNewCash={minManualCashBy[a.symbol]?.newCash}
                      onSave={onSaveBudget}
                    />
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{a.selected ? inr(a.targetCash, 0) : '—'}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{a.selected ? a.tranches : '—'}</td>
                  <td className="min-w-[16rem] max-w-sm px-2 py-2 text-xs">{a.reason}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-zinc-500">
        Last run {dateTime(run.at)} ({run.tradingDay}).{' '}
        {schedule && (schedule.due ? 'A pass is due now.' : `Next: ${schedule.why}.`)}{' '}
        {params &&
          `Each funded company gets at least ${inr(plan.minBudget, 0)} so every tranche clears the flat DP charge; ` +
            `at most ${params.maxBooks} companies; minimum strength ${params.minScore}.`}
      </p>
      {note && <p className="mt-2 text-xs text-zinc-500">{note}</p>}
      <p className="mt-2 text-xs text-zinc-500">
        <strong>Your amount</strong>{' '}is the total for that company, including what is already in its open lots. Leave
        it empty and the bot decides. Amounts you set are funded first and exactly; the bot then splits what is left
        among the rest. They are not limited by the bot&apos;s {params?.maxWeightPct ?? 35}% per-company cap or its
        trend filter, so the decision is yours. ₹0 stops new buys; open lots still sell at their own targets. With an
        amount set you can also choose the <strong>rungs</strong>{' '}it is split into (leave it empty and the bot picks):
        15% is kept back, the rest is shared equally by the rungs still to buy, at most 12 rungs, and a rung that already
        holds shares is never removed. Any amount works as long as each rung can buy enough shares for the profit target
        to clear 1.5× the round-trip cost (the flat DP charge, STT and stamp duty) — for most stocks that is one share, so
        the minimum follows the share price. The line under the boxes shows what each rung would get before you save.
      </p>
      {params?.corePct ? (
        <p className="mt-2 text-xs text-zinc-500">
          <strong>Index core:</strong>{' '}once you hold an index-ETF book (for example NIFTYBEES or JUNIORBEES), new cash
          first tops the ETFs up to {params.corePct}% of capital and the stocks share the rest. The ETFs are not held to
          the per-company cap. In the 10-year backtest this roughly halved the worst drawdown.
          {plan.coreCash ? ` This pass: ${inr(plan.coreCash, 0)} to the core.` : ' You hold no index-ETF book yet, so this is not in effect.'}
        </p>
      ) : null}
      <p className="mt-2 text-xs text-zinc-500">
        Strength = 0.5 × momentum (3-month return + half the 1-month, ±30% → 0..1) + 0.3 × closeness to the
        45-day high (20% off = 0) + 0.2 if EMA50 &gt; EMA200. A downtrend is never funded, whatever its score.
      </p>
    </>
  );
}

/**
 * The amount and rung fields for one company. Remounted (via its key) whenever
 * the saved values change, so the drafts always start from what the server
 * holds. A preview from the server shows, before saving, exactly what each
 * rung would get — computed by the engine's own ladder maths.
 */
function BudgetCell({
  symbol,
  saved,
  savedRungs,
  held,
  minNewCash,
  onSave,
}: {
  symbol: string;
  saved?: number;
  savedRungs?: number;
  held: number;
  minNewCash?: number;
  onSave: (symbol: string, amount: number | null, rungs: number | null) => Promise<boolean>;
}) {
  const initial = saved === undefined ? '' : String(saved);
  const initialRungs = savedRungs === undefined ? '' : String(savedRungs);
  const [draft, setDraft] = useState(initial);
  const [draftRungs, setDraftRungs] = useState(initialRungs);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ key: string; plan: RungPlan | null; error?: string } | null>(null);

  const parsed = draft.trim() === '' ? null : Number(draft);
  const invalid = parsed !== null && (!Number.isFinite(parsed) || parsed < 0);
  const rungs = parsed === null || draftRungs.trim() === '' ? null : Number(draftRungs);
  const rungsInvalid = rungs !== null && (!Number.isInteger(rungs) || rungs < 1);
  const dirty = (parsed ?? undefined) !== saved || (rungs ?? undefined) !== savedRungs;
  const previewKey = `${parsed}:${rungs}`;

  // Ask the server what this would do, a moment after typing stops. Every
  // setState happens in the timer or the promise, never in the effect body.
  useEffect(() => {
    let alive = true;
    const id = setTimeout(() => {
      if (parsed === null || invalid || rungsInvalid) {
        if (alive) setPreview(null);
        return;
      }
      api
        .previewRungs(symbol, parsed, rungs)
        .then((plan) => alive && setPreview({ key: previewKey, plan }))
        .catch((e) => alive && setPreview({ key: previewKey, plan: null, error: e instanceof Error ? e.message : String(e) }));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [symbol, parsed, rungs, invalid, rungsInvalid, previewKey]);

  const current = preview && preview.key === previewKey ? preview : null;
  const planError = current?.plan?.error ?? current?.error ?? null;
  const blocked = invalid || rungsInvalid || (rungs !== null && !!planError);

  async function commit(amount: number | null, r: number | null) {
    setSaving(true);
    const ok = await onSave(symbol, amount, amount === null ? null : r);
    setSaving(false);
    if (!ok) {
      setDraft(initial);
      setDraftRungs(initialRungs);
    }
  }

  const hint =
    (held > 0 ? `${inr(held, 0)} is already in open lots / T+1 and counts toward this amount. ` : '') +
    (minNewCash ? `New money must be ₹0 or at least ${inr(minNewCash, 0)}.` : '');

  const plan = current?.plan;
  const line =
    parsed === null
      ? null
      : planError
        ? planError
        : plan
          ? (rungs === null ? `Bot picks ${plan.rungs} rung${plan.rungs === 1 ? '' : 's'}: ` : '') +
            (plan.toBuy === 0
              ? `all ${plan.bought} rung(s) already bought; no new buys`
              : `${plan.toBuy} rung${plan.toBuy === 1 ? '' : 's'} to buy × ${inr(plan.perRung, 0)} each`) +
            (plan.bought > 0 && plan.toBuy > 0 ? ` (${plan.bought} already bought)` : '') +
            ` · ${plan.reservePct}% kept back · up to ${plan.maxRungs} rungs allowed`
          : 'Working it out…';

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <label className="sr-only" htmlFor={`budget-${symbol}`}>
          Your amount for {symbol}, in rupees
        </label>
        <input
          id={`budget-${symbol}`}
          type="number"
          inputMode="numeric"
          min={0}
          step={1000}
          value={draft}
          placeholder="Auto"
          disabled={saving}
          title={hint || undefined}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && dirty && !blocked) void commit(parsed, rungs);
            if (e.key === 'Escape') {
              setDraft(initial);
              setDraftRungs(initialRungs);
            }
          }}
          className={`w-28 rounded-md border bg-white px-2 py-1 text-right text-sm tabular-nums text-zinc-900 placeholder:text-zinc-400 dark:bg-zinc-900 dark:text-zinc-100 ${
            invalid
              ? 'border-rose-400'
              : saved !== undefined
                ? 'border-blue-400 dark:border-blue-700'
                : 'border-zinc-300 dark:border-zinc-700'
          }`}
        />
        <label className="sr-only" htmlFor={`rungs-${symbol}`}>
          Rungs for {symbol}
        </label>
        <input
          id={`rungs-${symbol}`}
          type="number"
          inputMode="numeric"
          min={1}
          max={12}
          step={1}
          value={parsed === null ? '' : draftRungs}
          placeholder={parsed === null ? '—' : 'Auto'}
          disabled={saving || parsed === null}
          title={parsed === null ? 'Set an amount first' : 'How many rungs to split the amount into. Empty = the bot picks.'}
          onChange={(e) => setDraftRungs(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && dirty && !blocked) void commit(parsed, rungs);
          }}
          className={`w-14 rounded-md border bg-white px-2 py-1 text-right text-sm tabular-nums text-zinc-900 placeholder:text-zinc-400 disabled:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:disabled:bg-zinc-800 ${
            rungsInvalid || (rungs !== null && planError)
              ? 'border-rose-400'
              : savedRungs !== undefined
                ? 'border-blue-400 dark:border-blue-700'
                : 'border-zinc-300 dark:border-zinc-700'
          }`}
        />
        {dirty && !blocked && (
          <button
            onClick={() => void commit(parsed, rungs)}
            disabled={saving}
            className="rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
        {!dirty && saved !== undefined && (
          <button
            onClick={() => void commit(null, null)}
            disabled={saving}
            title="Hand this company back to the bot (amount and rungs)"
            className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {saving ? '…' : 'Auto'}
          </button>
        )}
      </div>
      {line && (
        <span className={`max-w-[20rem] text-[11px] leading-snug ${planError ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-500'}`}>
          {line}
        </span>
      )}
    </div>
  );
}

/** Funded books first by rank; then everything else by score. */
function byRank(a: Allocation, b: Allocation): number {
  if (a.selected !== b.selected) return a.selected ? -1 : 1;
  if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
  return b.score - a.score || a.symbol.localeCompare(b.symbol);
}

function ScoreBar({ score }: { score: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-block h-1.5 w-16 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-700">
        <span className="block h-full rounded bg-blue-500" style={{ width: `${Math.round(score * 100)}%` }} />
      </span>
      <span className="tabular-nums">{score.toFixed(2)}</span>
    </span>
  );
}

