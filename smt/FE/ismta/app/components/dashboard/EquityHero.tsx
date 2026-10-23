'use client';

import Link from 'next/link';
import { inr, pct } from '../../lib/format';
import { Sparkline, type SparkPoint } from './Sparkline';
import { LoadingLabel, Skeleton } from './primitives';

/**
 * The one number the page exists to show, and the shape of how it got there.
 *
 * The old dashboard opened with four identical stat cards. Equity, banked
 * profit, unrealised and deployed all rendered at the same size, so the reader
 * had to decide which mattered before they could read anything — and none of
 * them had a trend, so ₹2,10,000 of equity was unreadable without knowing
 * where it came from. A level with no history is not an answer.
 *
 * So: ONE hero number, one signed change beside it, and the curve underneath.
 * Everything else on the page is deliberately smaller than this.
 *
 * WHY THE CHANGE IS STATED IN WORDS AS WELL AS COLOUR. Green and red are the
 * whole convention in trading UI, and they are also the single most common
 * accessibility failure in it. The arrow glyph and the signed number carry the
 * direction on their own; the colour is reinforcement, never the message.
 */
export function EquityHero({
  equity,
  change,
  changePct,
  basis,
  points,
  periodLabel,
  loading,
  budget,
  bookCount,
}: {
  equity: number;
  /** Rupee change over the window, on the SAME basis as `equity`. Null = not shown. */
  change: number | null;
  changePct: number | null;
  /** One line saying what `equity` covers. */
  basis: string;
  /** Oldest → newest. Fewer than two and the curve is omitted, not faked. */
  points: SparkPoint[];
  periodLabel: string;
  loading?: boolean;
  budget: number;
  /** Books with a budget above zero. */
  bookCount: number;
}) {
  // The change is passed in rather than derived from points[0]: the caller
  // owns the basis, and diffing a number against a curve from a different
  // source is exactly the bug this used to have.
  const first = points.length ? points[0].value : null;
  const up = (change ?? 0) >= 0;

  return (
    <div className="relative overflow-hidden rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Total equity
          </h2>

          {loading ? (
            <>
              <Skeleton className="mt-2 h-10 w-52" />
              <LoadingLabel what="equity" />
            </>
          ) : (
            <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-mono text-4xl font-semibold tracking-tight tabular-nums text-zinc-900 dark:text-zinc-50">
                {inr(equity, 0)}
              </span>

              {change !== null && changePct !== null && (
                <span
                  className={`flex items-baseline gap-1 font-mono text-sm tabular-nums ${
                    up ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                  }`}
                >
                  {/* Direction as a glyph, so it survives greyscale. */}
                  <span aria-hidden="true">{up ? '▲' : '▼'}</span>
                  <span>
                    {inr(Math.abs(change), 0)} ({pct(changePct, 1)})
                  </span>
                  <span className="font-sans text-zinc-400">{periodLabel}</span>
                </span>
              )}
            </div>
          )}

          {!loading && (
            <>
              <p className="mt-1 text-xs text-zinc-500">{basis}</p>
              <p className="mt-0.5 text-xs text-zinc-500">
                {inr(budget, 0)} engine budget across {bookCount} funded{' '}
                {bookCount === 1 ? 'stock' : 'stocks'}
              </p>
            </>
          )}
        </div>

        <Link
          href="/analytics"
          className="shrink-0 rounded-md border border-zinc-300 px-2.5 py-1 text-xs text-zinc-600 transition-colors hover:bg-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          Full analytics
        </Link>
      </div>

      <div className="mt-4">
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <Sparkline
            points={points}
            height={96}
            format={(v) => inr(v, 0)}
            ariaLabel={`Equity over ${periodLabel}, from ${
              first !== null ? inr(first, 0) : 'unknown'
            } to ${inr(equity, 0)}`}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Banked profit, given its own tile beside the hero.
 *
 * This is the accumulator's actual promise — every closed lot sold above its
 * fee-inclusive cost — so it is the second thing the page should say, not the
 * fourth. The win rate sits with it because the engine's headline "100%" is
 * meaningless without the label explaining what it counts, and the two must
 * never be shown apart.
 */
export function BankedTile({
  banked,
  closedTrades,
  winRatePct,
  winRateLabel,
  loading,
}: {
  banked: number;
  closedTrades: number;
  winRatePct: number | null;
  winRateLabel: string | null;
  loading?: boolean;
}) {
  return (
    <div className="flex flex-col rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <h2 className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
        Banked profit
      </h2>

      {loading ? (
        <>
          <Skeleton className="mt-2 h-9 w-32" />
          <LoadingLabel what="banked profit" />
        </>
      ) : (
        <>
          <div
            className={`mt-1 font-mono text-3xl font-semibold tabular-nums ${
              banked > 0
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-zinc-900 dark:text-zinc-50'
            }`}
          >
            {inr(banked, 0)}
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {closedTrades > 0
              ? `${closedTrades} lot${closedTrades === 1 ? '' : 's'} sold, every one above cost`
              : 'Nothing sold yet — profit is banked only when a lot closes'}
          </p>
        </>
      )}

      {!loading && winRatePct !== null && winRateLabel && (
        <div className="mt-auto border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] text-zinc-500">Win rate</span>
            <span className="font-mono text-sm tabular-nums text-zinc-900 dark:text-zinc-100">
              {winRatePct.toFixed(0)}%
            </span>
          </div>
          {/* The label is not optional garnish. A bare "100%" invites exactly
              the wrong conclusion about what the engine guarantees. */}
          <p className="mt-0.5 text-[10px] leading-snug text-zinc-400">{winRateLabel}</p>
        </div>
      )}
    </div>
  );
}
