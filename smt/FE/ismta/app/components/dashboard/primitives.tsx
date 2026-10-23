'use client';

import { pnlColor } from '../../lib/format';

/**
 * The small pieces the dashboard is assembled from.
 *
 * The rule the old dashboard broke, and the reason these exist: EVERY TILE
 * LOOKED EQUALLY IMPORTANT. Four identical stat cards in a row make the reader
 * do the triage that the layout should have done for them. So there are now
 * three deliberate weights — hero (one number, very large), KPI (supporting,
 * compact) and inline (inside a card) — and a tile picks the weight that
 * matches how often it changes a decision.
 */

/**
 * A loading placeholder shaped like the thing it is standing in for.
 *
 * The old dashboard rendered an em-dash while data was in flight, which reads
 * as "zero" or "broken" rather than "loading" — a genuinely bad thing to show
 * beside a P&L figure. A pulsing block cannot be mistaken for a value.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded bg-zinc-200/70 motion-reduce:animate-none dark:bg-zinc-800/70 ${className}`}
    />
  );
}

/** Screen-reader announcement for a region that is still loading. */
export function LoadingLabel({ what }: { what: string }) {
  return (
    <span className="sr-only" role="status">
      Loading {what}
    </span>
  );
}

/**
 * A supporting metric. Deliberately quieter than the hero: a smaller number, a
 * label above rather than beside, and no border of its own — the tiles share a
 * single card so the eye reads them as one group rather than five decisions.
 */
export function KpiTile({
  label,
  value,
  sub,
  tone,
  loading,
}: {
  label: string;
  value: string;
  sub?: string;
  /** A signed number colours the value. Used ONLY for money that can lose. */
  tone?: number;
  loading?: boolean;
}) {
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="truncate text-[10px] font-medium uppercase tracking-wider text-zinc-500">
        {label}
      </div>
      {loading ? (
        <Skeleton className="mt-1.5 h-6 w-20" />
      ) : (
        <div
          className={`mt-0.5 truncate font-mono text-lg font-semibold tabular-nums ${
            tone !== undefined ? pnlColor(tone) : 'text-zinc-900 dark:text-zinc-100'
          }`}
        >
          {value}
        </div>
      )}
      {sub && !loading && <div className="truncate text-[11px] text-zinc-400">{sub}</div>}
    </div>
  );
}

/**
 * A row of KPI tiles sharing one surface, divided rather than boxed.
 *
 * Dividers instead of five separate cards: five bordered boxes read as five
 * unrelated things, where these are five facets of one position.
 */
export function KpiRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 divide-x divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 bg-white sm:grid-cols-3 lg:grid-cols-5 lg:divide-y-0 dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-950">
      {children}
    </div>
  );
}

/**
 * A heading that separates one system from another.
 *
 * The strategy engine used to sit under a bare `<h2>` that looked like a
 * paragraph, so its numbers appeared to belong to the accumulator totals above.
 * They do not — two P&L systems on one screen that silently add up is the worst
 * outcome here — so the boundary is now drawn rather than implied.
 */
export function SectionHeading({
  title,
  note,
  action,
}: {
  title: string;
  note?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3 mt-8 flex items-end justify-between gap-4 border-t border-zinc-200 pt-5 dark:border-zinc-800">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">
          {title}
        </h2>
        {note && <p className="mt-0.5 text-xs text-zinc-500">{note}</p>}
      </div>
      {action}
    </div>
  );
}
