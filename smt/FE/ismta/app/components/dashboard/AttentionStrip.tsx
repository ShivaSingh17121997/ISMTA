'use client';

import Link from 'next/link';

/**
 * What needs a human, right now — and nothing else.
 *
 * The old dashboard had no triage layer at all. A process-wide halt, a feed
 * that stopped updating, a breached daily-loss limit and a lot sitting 20%
 * underwater were all discoverable, but only by visiting /system and /risk and
 * reading a table. On a screen whose job is "should I do something?", that is
 * the one question the layout refused to answer.
 *
 * Three rules keep it from becoming wallpaper:
 *
 *  1. IT IS EMPTY WHEN THINGS ARE FINE. A strip that always shows something
 *     trains the eye to skip it, and then it is useless on the day it matters.
 *     "All clear" is one quiet line, not a green banner.
 *  2. EVERY ITEM IS ACTIONABLE. If there is nothing the reader could do about
 *     it, it is a statistic and belongs in the KPI row instead.
 *  3. SEVERITY IS NEVER COLOUR ALONE. Each item carries an icon and a word, so
 *     it survives greyscale, colour blindness and forced-colors mode.
 */

export type AttentionLevel = 'critical' | 'warning' | 'info';

export interface AttentionItem {
  level: AttentionLevel;
  /** Short enough to scan in a list. */
  message: string;
  /** Where to go to deal with it. */
  href?: string;
  hrefLabel?: string;
}

const STYLE: Record<AttentionLevel, { chip: string; icon: string; word: string; dot: string }> = {
  critical: {
    chip: 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-900/70 dark:bg-rose-950/40 dark:text-rose-200',
    icon: '■',
    word: 'Critical',
    dot: 'text-rose-600 dark:text-rose-400',
  },
  warning: {
    chip: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-200',
    icon: '▲',
    word: 'Warning',
    dot: 'text-amber-600 dark:text-amber-400',
  },
  info: {
    chip: 'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300',
    icon: '●',
    word: 'Note',
    dot: 'text-zinc-400',
  },
};

const ORDER: Record<AttentionLevel, number> = { critical: 0, warning: 1, info: 2 };

export function AttentionStrip({ items, loading }: { items: AttentionItem[]; loading?: boolean }) {
  if (loading) return null;

  if (!items.length) {
    return (
      <p className="mb-5 flex items-center gap-2 text-xs text-zinc-400">
        <span aria-hidden="true" className="text-emerald-500">
          ✓
        </span>
        Nothing needs attention — no halts, no breached limits, feed is current.
      </p>
    );
  }

  const sorted = [...items].sort((a, b) => ORDER[a.level] - ORDER[b.level]);
  const worst = sorted[0].level;

  return (
    <section
      aria-label="Needs attention"
      // `assertive` only when something is actually critical; a warning
      // interrupting a screen reader mid-sentence would be its own bug.
      aria-live={worst === 'critical' ? 'assertive' : 'polite'}
      className="mb-5 space-y-2"
    >
      {sorted.map((item, i) => {
        const s = STYLE[item.level];
        return (
          <div
            key={`${item.level}-${i}`}
            className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm ${s.chip}`}
          >
            <span className={`shrink-0 text-xs ${s.dot}`} aria-hidden="true">
              {s.icon}
            </span>
            {/* The severity WORD, so the meaning does not live in the colour. */}
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider opacity-80">
              {s.word}
            </span>
            <span className="min-w-0 flex-1">{item.message}</span>
            {item.href && (
              <Link
                href={item.href}
                className="shrink-0 rounded-md px-2 py-0.5 text-xs font-medium underline decoration-current/40 underline-offset-2 hover:decoration-current focus:outline-none focus-visible:ring-2 focus-visible:ring-current"
              >
                {item.hrefLabel ?? 'Open'}
              </Link>
            )}
          </div>
        );
      })}
    </section>
  );
}
