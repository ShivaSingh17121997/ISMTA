'use client';

import { useState } from 'react';
import { Badge, Card } from './ui';
import { futureStarsApi } from '../lib/api';
import { inr, num } from '../lib/format';
import { usePolling } from '../lib/usePolling';
import type { FsGrade, FsPillar, FutureStar, FsVerdict } from '../lib/types';

/**
 * Future stars — companies that could become materially larger, judged on what
 * they have WON rather than on what their shares have already done.
 *
 * Three things this section has to do that the momentum list above it does not:
 *
 *  1. Say where every number came from. The order book is a mandatory exchange
 *     filing, the growth is the company's own XBRL, and the policy tag is an
 *     opinion typed into this codebase. Those are not the same kind of fact and
 *     the interface never lets them look the same — the grade badge and the
 *     "curated" mark are on every pillar.
 *  2. Answer "when do I invest", not just "what". That is the staged plan, and
 *     each tranche is attached to a condition rather than a date.
 *  3. Make an empty list feel like a result. Most days nothing clears the bar,
 *     and a category that always finds four ideas is one that is not really
 *     testing anything.
 */

const VERDICT: Record<FsVerdict, { label: string; tone: 'green' | 'blue' | 'amber' | 'neutral' | 'red' }> = {
  accumulate: { label: 'accumulate', tone: 'green' },
  'stage-in': { label: 'stage in', tone: 'blue' },
  watch: { label: 'watch', tone: 'amber' },
  'too-early': { label: 'too early', tone: 'neutral' },
  avoid: { label: 'avoid', tone: 'red' },
};

const GRADE_HINT: Record<FsGrade, string> = {
  A: 'Directly supported by published evidence.',
  B: 'Measured from filings, but the evidence that it predicts returns is mixed.',
  C: 'A judgement written into this tool. Opinion, not data.',
};

/** ₹ in the units an Indian investor actually reads. */
function crore(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '—';
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(n >= 1e9 ? 0 : 1)} cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(1)} lakh`;
  return inr(n, 0);
}

function GradeBadge({ grade }: { grade: FsGrade }) {
  const tone = grade === 'A' ? 'green' : grade === 'B' ? 'blue' : 'amber';
  return (
    <span title={GRADE_HINT[grade]}>
      <Badge tone={tone}>evidence {grade}</Badge>
    </span>
  );
}

function PillarRow({ p }: { p: FsPillar }) {
  const width = `${Math.round(p.score * 100)}%`;
  return (
    <div className="border-t border-zinc-100 py-2 dark:border-zinc-900">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-200">{p.label}</span>
        <GradeBadge grade={p.grade} />
        {p.curated && (
          <span title="Written by hand into this tool rather than measured from data.">
            <Badge tone="amber">curated opinion</Badge>
          </span>
        )}
        <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-zinc-500">
          {p.score.toFixed(2)} × {p.weight} = {p.contribution.toFixed(3)}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div
          className={`h-full rounded-full ${p.curated ? 'bg-amber-400' : p.grade === 'A' ? 'bg-emerald-500' : 'bg-blue-500'}`}
          style={{ width }}
        />
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{p.detail}</p>
    </div>
  );
}

function StarCard({ star }: { star: FutureStar }) {
  const [open, setOpen] = useState(false);
  const v = VERDICT[star.verdict];
  const g = star.growth;
  const o = star.orders;

  return (
    <div
      className={`rounded-xl border p-4 ${
        star.funded
          ? 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950'
          : 'border-dashed border-zinc-300 bg-zinc-50/60 dark:border-zinc-700 dark:bg-zinc-900/40'
      }`}
    >
      {/* headline */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-xs text-zinc-400">#{star.rank}</span>
        <span className="text-base font-semibold">{star.symbol}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-zinc-500">{star.name}</span>
        <Badge tone={v.tone}>{v.label}</Badge>
        {!star.funded && (
          <span title="It made the list but not the budget: a thesis with no position.">
            <Badge tone="neutral">watchlist only</Badge>
          </span>
        )}
        <span className="font-mono text-sm font-semibold tabular-nums">{star.score.toFixed(0)}</span>
      </div>

      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500">
        <span>{star.sector}</span>
        {star.themes.map((t) => (
          <span key={t} className="text-violet-600 dark:text-violet-400">
            {t}
          </span>
        ))}
        <span className="tabular-nums">₹{num(star.price.last)}</span>
        <span className={star.price.aboveSma200 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'}>
          {star.price.aboveSma200 ? 'above' : 'below'} 200-day
        </span>
        <span className="tabular-nums">{star.price.pctOf52wRange.toFixed(0)}% of 52-week range</span>
      </div>

      <p className="mt-2 text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-300">{star.thesis}</p>

      {/* the four facts people actually compare */}
      <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Fact
          label="Order wins, 6 months"
          value={o.error ? '—' : `${o.recentCount}`}
          sub={o.error ? 'filings unavailable' : `against ${o.priorCount} in the six before`}
          tone={o.recentCount > o.priorCount ? 1 : o.recentCount < o.priorCount ? -1 : 0}
        />
        <Fact
          label="Revenue, year on year"
          value={g.revenueYoYPct === null ? '—' : `${g.revenueYoYPct > 0 ? '+' : ''}${g.revenueYoYPct}%`}
          sub={g.comparedWith ? `vs quarter to ${g.comparedWith}` : 'no comparable quarter filed'}
          tone={g.revenueYoYPct ?? 0}
        />
        <Fact
          label="Profit, year on year"
          value={g.profitYoYPct === null ? '—' : `${g.profitYoYPct > 0 ? '+' : ''}${g.profitYoYPct}%`}
          sub={
            g.marginPct !== null && g.marginYearAgoPct !== null
              ? `margin ${g.marginYearAgoPct}% → ${g.marginPct}%`
              : 'margin unknown'
          }
          tone={g.profitYoYPct ?? 0}
        />
        <Fact
          label={star.funded ? 'Position if fully staged' : 'No position'}
          value={star.funded ? inr(star.plan.amount, 0) : '—'}
          sub={star.funded ? `${star.plan.pctOfCapital}% of capital` : 'outside the funded set'}
        />
      </div>

      {/* the plan: the answer to "when" */}
      <div className="mt-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <div className="mb-2 flex flex-wrap items-baseline gap-2">
          <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">When to invest</span>
          <span className="text-[11px] text-zinc-500">
            {star.plan.tranches.length === 1
              ? 'one purchase'
              : `${star.plan.tranches.length} tranches, each on a condition rather than a date`}
          </span>
          <span className="ml-auto text-[11px] text-zinc-500">hold {star.plan.holdLabel}</span>
        </div>
        <ol className="space-y-1.5">
          {star.plan.tranches.map((t) => (
            <li key={t.n} className="flex gap-2 text-[12px]">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 font-mono text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                {t.n}
              </span>
              <span className="flex-1 text-zinc-600 dark:text-zinc-300">
                {t.trigger}
                {star.funded && t.amount > 0 && (
                  <span className="ml-1 whitespace-nowrap font-mono text-[11px] text-zinc-500">
                    — {inr(t.amount, 0)} ({t.quantity} sh, {t.sharePct}%)
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-2 border-t border-zinc-100 pt-2 text-[11px] text-rose-600 dark:border-zinc-900 dark:text-rose-400">
          <span className="font-semibold">Sell if:</span> {star.plan.invalidation}
        </p>
        <p className="mt-1 text-[11px] text-zinc-500">
          Next real test: {star.plan.nextCheck}.
          {star.funded && star.plan.riskAmount > 0
            ? ` Losing it from here to the invalidation level costs about ${inr(star.plan.riskAmount, 0)}.`
            : ''}
        </p>
        {star.plan.warnings.length > 0 && (
          <ul className="mt-2 space-y-0.5">
            {star.plan.warnings.map((w, i) => (
              <li key={i} className="text-[11px] text-amber-700 dark:text-amber-400">
                {w}
              </li>
            ))}
          </ul>
        )}
      </div>

      {star.risks.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {star.risks.map((r, i) => (
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
        {open ? 'Hide the workings' : 'Show the workings — every pillar, the order wins and the results history'}
      </button>

      {open && (
        <div className="mt-2">
          <div className="rounded-lg border border-zinc-200 px-3 py-1 dark:border-zinc-800">
            {star.pillars.map((p) => (
              <PillarRow key={p.key} p={p} />
            ))}
          </div>

          {/* order wins, the primary evidence */}
          {o.recent.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                Order wins filed with the exchange
                {o.valueCoverage < 0.6 && o.recentCount > 0 && (
                  <span className="ml-2 font-normal normal-case text-amber-600 dark:text-amber-400">
                    {o.unpriced} of {o.recentCount} disclosed no value in the filing text, so the totals are a floor
                  </span>
                )}
              </div>
              <div className="scroll-thin max-h-56 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                <table className="w-full text-[11px]">
                  <tbody>
                    {o.recent.map((w, i) => (
                      <tr key={i} className="border-b border-zinc-100 last:border-0 dark:border-zinc-900">
                        <td className="whitespace-nowrap px-2 py-1 text-zinc-500">
                          {new Date(w.at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
                        </td>
                        <td className="px-2 py-1 tabular-nums">{w.valueInr ? crore(w.valueInr) : '—'}</td>
                        <td className="px-2 py-1 text-zinc-600 dark:text-zinc-300">{w.customer ?? ''}</td>
                        <td className="px-2 py-1 text-zinc-500">
                          {w.url ? (
                            <a href={w.url} target="_blank" rel="noreferrer" className="hover:underline">
                              {w.detail.slice(0, 90)}
                            </a>
                          ) : (
                            w.detail.slice(0, 90)
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* the results the growth was computed from */}
          {g.quarters.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                Quarterly results, as filed
                {g.ageDays !== null && g.ageDays > 150 && (
                  <span className="ml-2 font-normal normal-case text-amber-600 dark:text-amber-400">
                    latest is {g.ageDays} days old
                  </span>
                )}
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
                        <td key={x.end} className="px-2 py-1 tabular-nums">
                          {crore(x.revenue)}
                        </td>
                      ))}
                    </tr>
                    <tr className="border-t border-zinc-100 dark:border-zinc-900">
                      <td className="px-2 py-1 text-zinc-500">Profit</td>
                      {g.quarters.map((x) => (
                        <td key={x.end} className="px-2 py-1 tabular-nums">
                          {crore(x.profit)}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* policy, clearly marked as opinion */}
          {(star.policy.tags.length > 0 || star.policy.critical.length > 0) && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/60 p-2 dark:border-amber-900 dark:bg-amber-950/20">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                Policy and strategic production — curated opinion
              </div>
              {star.policy.critical.length > 0 && (
                <p className="text-[11px] text-zinc-600 dark:text-zinc-300">
                  Makes: {star.policy.critical.join(', ')}
                </p>
              )}
              <ul className="mt-1 space-y-0.5">
                {star.policy.tags.map((t) => (
                  <li key={t.scheme} className="text-[11px] text-zinc-600 dark:text-zinc-300">
                    <span className="font-medium">{t.scheme}</span>{' '}
                    <span className="text-zinc-400">({t.since})</span> — {t.why}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
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

export function FutureStars() {
  const state = usePolling(() => futureStarsApi.futureStars(), 60_000);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRejected, setShowRejected] = useState(false);

  const run = state.data?.run ?? null;
  const settings = state.data?.settings;

  async function runNow() {
    setRunning(true);
    setError(null);
    try {
      await futureStarsApi.runFutureStars({});
      state.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card
      title="Future stars — companies that could be much larger in a few years"
      className="mb-6"
      action={
        <button
          onClick={runNow}
          disabled={running}
          className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {running ? 'Reading filings…' : run ? 'Re-run' : 'Run'}
        </button>
      }
    >
      <div className="mb-4 rounded-lg border border-violet-200 bg-violet-50/70 px-3 py-2 text-[12px] leading-relaxed text-violet-900 dark:border-violet-900 dark:bg-violet-950/30 dark:text-violet-200">
        <span className="font-semibold">A different question from the list above.</span> The three horizons rank
        what price has already done. This ranks what a company has <em>won</em>: order and contract wins filed with
        the exchange, revenue and profit from its own quarterly filings, the government schemes and strategic
        production it sits in, and whether the market has started to agree. Each idea comes with a staged plan —
        when to buy the first part, what has to be true before the rest, and what would mean the reason for owning
        it has gone.
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      )}

      {!run ? (
        <div className="py-8 text-center">
          <p className="text-sm text-zinc-500">
            Nothing ranked yet. A run reads quarterly results and order filings for{' '}
            {settings?.universeSize ?? 'about 170'} companies, so it takes a few minutes.
          </p>
          <p className="mx-auto mt-2 max-w-xl text-[11px] text-zinc-400">
            It is deliberately not run automatically: these inputs change a few times a year, not daily.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-500">
            <span>
              {run.stars.length} qualified of {run.scored} scored
            </span>
            <span>·</span>
            <span>{run.stars.filter((s) => s.funded).length} funded</span>
            <span>·</span>
            <span>
              {inr(run.totalIfAllStaged, 0)} committed if every trigger fires, inside a {run.categoryCapPct}% cap
            </span>
            <span>·</span>
            <span>ranked {new Date(run.at).toLocaleString('en-IN', { hour12: false })}</span>
          </div>

          {/* The guardrail the evidence says matters most, and the one this
              account cannot satisfy. Shown before the ideas, not after. */}
          {run.concentration.tooConcentrated && (
            <div className="mb-4 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 dark:border-rose-900 dark:bg-rose-950/30">
              <div className="mb-1 text-xs font-semibold text-rose-800 dark:text-rose-300">
                This list is too concentrated to work as intended —{' '}
                {run.concentration.fundedCount} funded, about {run.concentration.recommendedMinimum} needed
              </div>
              <p className="text-[11px] leading-relaxed text-rose-700 dark:text-rose-300">
                {run.concentration.note}
              </p>
            </div>
          )}

          {run.stars.length === 0 ? (
            <div className="rounded-lg border border-zinc-200 py-8 text-center dark:border-zinc-800">
              <p className="text-sm font-medium">Nothing qualified today.</p>
              <p className="mx-auto mt-1 max-w-lg text-[12px] text-zinc-500">
                That is the normal result, not a failure. Every bar in this list is absolute rather than a ranking,
                so when no company clears them the list is empty instead of promoting the least bad one.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {run.stars.map((s) => (
                <StarCard key={s.symbol} star={s} />
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
              How this is scored, and what the evidence actually says
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
