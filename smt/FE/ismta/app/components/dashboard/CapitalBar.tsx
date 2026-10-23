'use client';

import { useChartPalette } from '../../lib/chartPalette';
import { inr } from '../../lib/format';
import { Skeleton } from './primitives';

/**
 * Where the capital actually is, as one bar.
 *
 * Replaces four loose currency figures. Deployed / settled / unsettled are
 * parts of ONE pool, and four separate numbers make the reader do the division
 * in their head to answer the only question they had: how much of my money is
 * working, and how much is idle? A stacked bar answers it without arithmetic.
 *
 * Form: part-to-whole over a small, fixed set of categories — a single stacked
 * bar, not a pie (angles are harder to compare than lengths) and not a donut
 * with a number in the hole (that is a stat tile wearing a costume).
 *
 * Colour: the three categorical slots in FIXED ORDER from the app palette,
 * validated against both card surfaces. Identity never rests on colour alone —
 * every segment is in the legend with its own value, and the legend is always
 * present because there is more than one series.
 *
 * Spacers: a 2px surface gap between segments, so two adjacent fills read as
 * two quantities rather than one blended block.
 */

export interface CapitalSlice {
  key: string;
  label: string;
  value: number;
  hint: string;
}

export function CapitalBar({
  deployed,
  settled,
  unsettled,
  ceiling,
  loading,
}: {
  deployed: number;
  settled: number;
  unsettled: number;
  /**
   * Total cost basis the ladder may hold open at once, summed over books.
   * Shown because "26% deployed" invites the obvious next question — is the
   * rest idle by choice? — and the ceiling is the answer.
   */
  ceiling?: number;
  loading?: boolean;
}) {
  const p = useChartPalette();

  const slices: (CapitalSlice & { color: string })[] = [
    {
      key: 'deployed',
      label: 'Deployed',
      value: deployed,
      hint: 'cost basis of open lots',
      color: p.cat1,
    },
    {
      key: 'settled',
      label: 'Settled cash',
      value: settled,
      hint: 'ready to buy a dip',
      color: p.cat2,
    },
    {
      key: 'unsettled',
      label: 'Unsettled',
      value: unsettled,
      hint: 'T+1 — can buy, cannot withdraw',
      color: p.cat3,
    },
  ];

  const total = slices.reduce((s, x) => s + Math.max(0, x.value), 0);

  if (loading) {
    return (
      <div>
        <Skeleton className="h-3 w-full rounded-full" />
        <div className="mt-3 grid grid-cols-3 gap-3">
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
      </div>
    );
  }

  // A zero pool is a real state (nothing funded yet), not an error — and
  // dividing by it would render three NaN-wide segments.
  if (total <= 0) {
    return (
      <p className="py-2 text-sm text-zinc-500">
        No capital allocated yet. Switch a stock on to give the engine a budget.
      </p>
    );
  }

  const share = (v: number) => (Math.max(0, v) / total) * 100;
  const visible = slices.filter((s) => s.value > 0);

  const working = total > 0 ? (deployed / total) * 100 : 0;

  return (
    <div>
      {/* The headline the bar is an answer to, stated in words above it. */}
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
          {inr(total, 0)}
        </span>
        <span className="text-xs text-zinc-500">
          under the engine · {working.toFixed(0)}% working
        </span>
      </div>

      <div
        className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full"
        role="img"
        aria-label={
          `Capital of ${inr(total, 0)}: ` +
          visible.map((s) => `${s.label} ${inr(s.value, 0)}`).join(', ')
        }
      >
        {visible.map((s) => (
          <div
            key={s.key}
            // `title` gives the hover readout without a JS tooltip layer; the
            // legend below already carries every value, so nothing is
            // hover-only.
            title={`${s.label}: ${inr(s.value, 0)} (${share(s.value).toFixed(1)}%)`}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{ width: `${share(s.value)}%`, background: s.color, minWidth: 3 }}
          />
        ))}
      </div>

      {/* Legend, always present: three series means identity cannot rest on
          position, and every value is direct-labelled rather than hover-only. */}
      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-3">
        {slices.map((s) => (
          <div key={s.key} className="flex items-start gap-2">
            <span
              aria-hidden="true"
              className="mt-[5px] h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: s.color, opacity: s.value > 0 ? 1 : 0.35 }}
            />
            <div className="min-w-0">
              <dt className="flex items-baseline gap-1.5 text-[11px] text-zinc-500">
                {s.label}
                <span className="tabular-nums text-zinc-400">{share(s.value).toFixed(0)}%</span>
              </dt>
              {/* Value in ink, not in the series colour — the swatch carries
                  identity, the text stays readable. */}
              <dd className="font-mono text-sm tabular-nums text-zinc-900 dark:text-zinc-100">
                {inr(s.value, 0)}
              </dd>
              {/* Wraps rather than truncates: these are short phrases, and a
                  clipped "T+1 — can buy, cannot wi…" loses the half that
                  matters at exactly the width where space is tight. */}
              <dd className="text-[10px] leading-tight text-zinc-400">{s.hint}</dd>
            </div>
          </div>
        ))}
      </dl>

      {/* Why the idle share is idle. Without this, "74% settled cash" reads as
          a mistake rather than as the ladder waiting for a dip.
          The wording adapts: when the ceiling is the whole pool, quoting the
          figure is tautological — it is the same number as the total directly
          above — so it says what that MEANS instead. */}
      {ceiling !== undefined && ceiling > 0 && (
        <p className="mt-4 border-t border-zinc-200 pt-3 text-[11px] leading-snug text-zinc-500 dark:border-zinc-800">
          {ceiling >= total * 0.99 ? (
            <>
              No reserve is held back — the ladder may deploy the whole pool. Cash sitting idle is
              the engine waiting for a dip, not capital with nowhere to go.
            </>
          ) : (
            <>
              The ladder may hold at most{' '}
              <span className="font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
                {inr(ceiling, 0)}
              </span>{' '}
              of cost basis at once ({((ceiling / total) * 100).toFixed(0)}% of the pool), so the
              rest is reserve by design rather than capital with nowhere to go.
            </>
          )}
        </p>
      )}
    </div>
  );
}
