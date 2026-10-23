'use client';

import { useState } from 'react';
import { Badge, Card } from './ui';
import { turnaroundApi } from '../lib/api';
import { inr, num } from '../lib/format';
import { usePolling } from '../lib/usePolling';
import type { FsGrade, FsPillar, Turnaround, TurnVerdict } from '../lib/types';

/**
 * Turnarounds — stocks well below their highs where the business has not broken.
 *
 * The interface has one job the other two lists do not: to keep making the
 * difference between a de-rating and a downgrade visible. Every card therefore
 * leads with the fall AND the margin side by side, because a company 45% down
 * with widening margins and one 45% down with collapsing margins look identical
 * on a chart and are opposite trades.
 *
 * The second job is to make an UNFIRED TRIGGER feel like success rather than a
 * missed opportunity. Nothing in this category is bought at market; the entry
 * is a level, and if it is never reached, nothing is ever bought. That is the
 * plan working, and the copy says so.
 */

const VERDICT: Record<TurnVerdict, { label: string; tone: 'green' | 'blue' | 'amber' | 'neutral' | 'red' }> = {
  'buy-the-base': { label: 'buy the base', tone: 'green' },
  'watch-for-a-base': { label: 'watch for a base', tone: 'amber' },
  'too-early': { label: 'too early', tone: 'neutral' },
  avoid: { label: 'avoid', tone: 'red' },
};

const GRADE_HINT: Record<FsGrade, string> = {
  A: 'Directly supported by published evidence.',
  B: 'Measured from filings or price, but the evidence is mixed.',
  C: 'A judgement written into this tool. Opinion, not data.',
};

function crore(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '—';
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(n >= 1e9 ? 0 : 1)} cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(1)} lakh`;
  return inr(n, 0);
}

function PillarRow({ p }: { p: FsPillar }) {
  return (
    <div className="border-t border-zinc-100 py-2 dark:border-zinc-900">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-200">{p.label}</span>
        <span title={GRADE_HINT[p.grade]}>
          <Badge tone={p.grade === 'A' ? 'green' : p.grade === 'B' ? 'blue' : 'amber'}>evidence {p.grade}</Badge>
        </span>
        {p.curated && <Badge tone="amber">curated opinion</Badge>}
        <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-zinc-500">
          {p.score.toFixed(2)} × {p.weight} = {p.contribution.toFixed(3)}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div
          className={`h-full rounded-full ${p.curated ? 'bg-amber-400' : p.grade === 'A' ? 'bg-emerald-500' : 'bg-blue-500'}`}
          style={{ width: `${Math.round(p.score * 100)}%` }}
        />
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{p.detail}</p>
    </div>
  );
}

function Fact({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: number }) {
  const colour =
    tone === undefined || tone === 0
      ? 'text-zinc-900 dark:text-zinc-100'
      : tone > 0
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-rose-600 dark:text-rose-400';
  return (
    <div className="rounded-lg border border-zinc-200 px-2 py-1.5 dark:border-zinc-800">
      <div className="text-[9px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`font-mono text-sm font-semibold tabular-nums ${colour}`}>{value}</div>
      {sub && <div className="truncate text-[10px] text-zinc-400">{sub}</div>}
    </div>
  );
}

function TurnCard({ c }: { c: Turnaround }) {
  const [open, setOpen] = useState(false);
  const v = VERDICT[c.verdict];
  const g = c.growth;
  const s = c.shareholding;
  const fall = Math.abs(c.price.fromHighPct);
  const marginDelta = g.marginPct !== null && g.marginYearAgoPct !== null ? g.marginPct - g.marginYearAgoPct : null;

  return (
    <div
      className={`rounded-xl border p-4 ${
        c.funded
          ? 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950'
          : 'border-dashed border-zinc-300 bg-zinc-50/60 dark:border-zinc-700 dark:bg-zinc-900/40'
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-xs text-zinc-400">#{c.rank}</span>
        <span className="text-base font-semibold">{c.symbol}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-zinc-500">{c.name}</span>
        <Badge tone={v.tone}>{v.label}</Badge>
        {!c.funded && <Badge tone="neutral">watchlist only</Badge>}
        <span className="font-mono text-sm font-semibold tabular-nums">{c.score.toFixed(0)}</span>
      </div>

      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500">
        <span>{c.sector}</span>
        <span className="tabular-nums">₹{num(c.price.last)}</span>
        <span className="font-medium text-rose-600 dark:text-rose-400">{fall.toFixed(0)}% below its high</span>
        <span className={c.price.mom3_1 >= 0 ? 'text-emerald-600 dark:text-emerald-400' : ''}>
          3-month {c.price.mom3_1 >= 0 ? '+' : ''}
          {c.price.mom3_1.toFixed(0)}%
        </span>
        <span>{c.price.aboveSma200 ? 'above 200-day' : 'below 200-day'}</span>
      </div>

      <p className="mt-2 text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-300">{c.thesis}</p>

      {/* The fall and the business, side by side — the whole question. */}
      <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Fact
          label="How far it has fallen"
          value={`−${fall.toFixed(0)}%`}
          sub={`from ₹${num(c.price.high52w, 0)}`}
          tone={-1}
        />
        <Fact
          label="Margin, year on year"
          value={g.marginPct === null ? '—' : `${g.marginPct}%`}
          sub={g.marginYearAgoPct !== null ? `was ${g.marginYearAgoPct}%` : 'no comparison filed'}
          tone={marginDelta ?? 0}
        />
        <Fact
          label="Revenue, year on year"
          value={g.revenueYoYPct === null ? '—' : `${g.revenueYoYPct > 0 ? '+' : ''}${g.revenueYoYPct}%`}
          sub={g.comparedWith ? `vs quarter to ${g.comparedWith}` : 'no comparable quarter'}
          tone={g.revenueYoYPct ?? 0}
        />
        <Fact
          label="Promoter stake"
          value={s.latestPct === null ? '—' : `${s.latestPct}%`}
          sub={
            s.changePct === null
              ? 'no history'
              : `${s.changePct > 0 ? '+' : ''}${s.changePct} pts in a year${s.pledged ? ', pledged' : ''}`
          }
          tone={s.pledged ? -1 : (s.changePct ?? 0)}
        />
      </div>

      {/* The plan: a level, not a date. */}
      <div className="mt-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <div className="mb-2 flex flex-wrap items-baseline gap-2">
          <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">When to buy</span>
          <span className="ml-auto text-[11px] text-zinc-500">hold {c.entry.holdLabel}</span>
        </div>
        <p className="text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-300">{c.entry.trigger}</p>
        {c.funded && c.entry.amount > 0 && (
          <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Fact label="Buy" value={inr(c.entry.amount, 0)} sub={`${c.entry.quantity} shares, ${c.entry.pctOfCapital}% of capital`} />
            <Fact label="Stop" value={`₹${num(c.entry.stop)}`} sub={`${c.entry.stopDistancePct}% below today`} />
            <Fact label="Risked if stopped" value={inr(c.entry.riskAmount, 0)} sub="the base failing is the whole loss" />
            <Fact label="Next test" value={c.entry.nextCheck.split(',')[0]} sub={c.entry.nextCheck.split(',').slice(1).join(',').trim()} />
          </div>
        )}
        <p className="mt-2 border-t border-zinc-100 pt-2 text-[11px] text-rose-600 dark:border-zinc-900 dark:text-rose-400">
          <span className="font-semibold">Sell if:</span> it closes below ₹{num(c.entry.stop)}, the base has failed.{' '}
          {c.entry.timeStop}
        </p>
        {c.entry.warnings.length > 0 && (
          <ul className="mt-2 space-y-0.5">
            {c.entry.warnings.map((w, i) => (
              <li key={i} className="text-[11px] text-amber-700 dark:text-amber-400">
                {w}
              </li>
            ))}
          </ul>
        )}
      </div>

      {c.risks.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {c.risks.map((r, i) => (
            <span key={i} title={r.detail}>
              <Badge tone="red">{r.kind}</Badge>
            </span>
          ))}
        </div>
      )}

      <button
        onClick={() => setOpen((x) => !x)}
        className="mt-3 text-[11px] text-blue-600 hover:underline dark:text-blue-400"
      >
        {open ? 'Hide the workings' : 'Show the workings — every pillar, the results and the shareholding history'}
      </button>

      {open && (
        <div className="mt-2">
          <div className="rounded-lg border border-zinc-200 px-3 py-1 dark:border-zinc-800">
            {c.pillars.map((p) => (
              <PillarRow key={p.key} p={p} />
            ))}
          </div>

          {g.quarters.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                Quarterly results, as filed
              </div>
              <div className="scroll-thin overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-left text-zinc-400">
                      <th className="px-2 py-1 font-medium">Quarter</th>
                      {g.quarters.map((x) => (
                        <th key={x.end} className="px-2 py-1 font-mono font-medium tabular-nums">
                          {x.end.slice(2, 7)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t border-zinc-100 dark:border-zinc-900">
                      <td className="px-2 py-1 text-zinc-500">Revenue</td>
                      {g.quarters.map((x) => (
                        <td key={x.end} className="px-2 py-1 tabular-nums">{crore(x.revenue)}</td>
                      ))}
                    </tr>
                    <tr className="border-t border-zinc-100 dark:border-zinc-900">
                      <td className="px-2 py-1 text-zinc-500">Pre-tax margin</td>
                      {g.quarters.map((x) => (
                        <td key={x.end} className="px-2 py-1 tabular-nums">
                          {x.pbt !== null && x.revenue > 0 ? `${((x.pbt / x.revenue) * 100).toFixed(1)}%` : '—'}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {s.quarters.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                Promoter holding, as filed
                {s.pledged === true && (
                  <span className="ml-2 font-normal normal-case text-rose-600 dark:text-rose-400">
                    encumbered: {s.encumbrance.join(', ')}
                  </span>
                )}
              </div>
              <div className="scroll-thin overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-left text-zinc-400">
                      <th className="px-2 py-1 font-medium">Quarter</th>
                      {s.quarters.slice(0, 8).map((x) => (
                        <th key={x.date} className="px-2 py-1 font-mono font-medium tabular-nums">
                          {x.date.slice(2, 7)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t border-zinc-100 dark:border-zinc-900">
                      <td className="px-2 py-1 text-zinc-500">Promoter %</td>
                      {s.quarters.slice(0, 8).map((x) => (
                        <td key={x.date} className="px-2 py-1 tabular-nums">{x.promoterPct}</td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function Turnarounds() {
  const state = usePolling(() => turnaroundApi.turnarounds(), 60_000);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRejected, setShowRejected] = useState(false);

  const run = state.data?.run ?? null;
  const settings = state.data?.settings;

  async function runNow() {
    setRunning(true);
    setError(null);
    try {
      await turnaroundApi.runTurnarounds({});
      state.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card
      title="Turnarounds — down a long way, but the business is intact"
      className="mb-6"
      action={
        <button
          onClick={runNow}
          disabled={running}
          className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {running ? 'Reading filings…' : run ? 'Re-run' : 'Run'}
        </button>
      }
    >
      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-[12px] leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
        <span className="font-semibold">The hardest category, and the one most likely to lose money.</span> It looks
        for stocks well below their highs whose revenue, margins and owners say the business has not broken — a
        de-rating rather than a downgrade. Depth is used as a filter, never as a score: a stock 60% down earns no
        more credit than one 30% down, because &ldquo;cheaper is better&rdquo; is exactly how people catch falling
        knives. Nothing is bought at market. Each idea names a price that would confirm the fall has stopped, and
        if that price never arrives, nothing is ever bought.
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      )}

      {!run ? (
        <div className="py-8 text-center">
          <p className="text-sm text-zinc-500">
            Nothing ranked yet. A run reads quarterly results and shareholding patterns for{' '}
            {settings?.universeSize ?? 'about 170'} companies, so it takes a few minutes.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-500">
            <span>
              {run.candidates.length} qualified of {run.scored} scored
            </span>
            <span>·</span>
            <span>{run.candidates.filter((c) => c.funded).length} funded</span>
            <span>·</span>
            <span>
              {inr(run.totalIfAllTriggered, 0)} if every trigger fires, inside a {run.categoryCapPct}% cap
            </span>
            <span>·</span>
            <span>ranked {new Date(run.at).toLocaleString('en-IN', { hour12: false })}</span>
          </div>

          {run.concentration.tooConcentrated && (
            <div className="mb-4 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 dark:border-rose-900 dark:bg-rose-950/30">
              <div className="mb-1 text-xs font-semibold text-rose-800 dark:text-rose-300">
                Too concentrated for a category with this failure rate — {run.concentration.fundedCount} funded,
                about {run.concentration.recommendedMinimum} needed
              </div>
              <p className="text-[11px] leading-relaxed text-rose-700 dark:text-rose-300">
                {run.concentration.note}
              </p>
            </div>
          )}

          {run.candidates.length === 0 ? (
            <div className="rounded-lg border border-zinc-200 py-8 text-center dark:border-zinc-800">
              <p className="text-sm font-medium">Nothing qualified today.</p>
              <p className="mx-auto mt-1 max-w-lg text-[12px] text-zinc-500">
                Either nothing has fallen far enough, or everything that has is still falling. Both are good reasons
                to own none of it.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {run.candidates.map((c) => (
                <TurnCard key={c.symbol} c={c} />
              ))}
            </div>
          )}

          {run.rejected.length > 0 && (
            <div className="mt-4">
              <button
                onClick={() => setShowRejected((x) => !x)}
                className="text-[11px] text-blue-600 hover:underline dark:text-blue-400"
              >
                {showRejected ? 'Hide' : 'Show'} the {run.rejected.length} that did not qualify, and why
              </button>
              {showRejected && (
                <div className="scroll-thin mt-2 max-h-72 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                  <table className="w-full text-[11px]">
                    <tbody>
                      {run.rejected.map((r) => (
                        <tr key={r.symbol} className="border-b border-zinc-100 last:border-0 dark:border-zinc-900">
                          <td className="whitespace-nowrap px-2 py-1 font-mono font-medium">{r.symbol}</td>
                          <td className="px-2 py-1 text-zinc-500">{r.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          <details className="mt-4 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
              Why this category is built to argue with itself
            </summary>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-300">{run.evidence}</p>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">{run.sources}</p>
            <p className="mt-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">{run.disclaimer}</p>
          </details>
        </>
      )}
    </Card>
  );
}
