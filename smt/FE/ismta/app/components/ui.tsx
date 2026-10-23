'use client';

import { pnlColor } from '../lib/format';

export function Card({
  title,
  children,
  className = '',
  action,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950 ${className}`}
    >
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between">
          {title && <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{title}</h3>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

export function StatCard({
  label,
  value,
  sub,
  colored,
}: {
  label: string;
  value: string;
  sub?: string;
  colored?: number;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div
        className={`mt-2 text-2xl font-semibold tabular-nums ${
          colored !== undefined ? pnlColor(colored) : 'text-zinc-900 dark:text-zinc-50'
        }`}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-zinc-400">{sub}</div>}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'green' | 'red' | 'blue' | 'amber';
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
    green: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
    red: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
    blue: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    amber: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  };
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

/**
 * The on/off switch used everywhere a mode is toggled.
 *
 * `role="switch"` with `aria-checked` rather than a styled checkbox, so a
 * screen reader announces the state and the space bar works. Green when on;
 * `locked` renders a static chip instead, for a mode that is unavailable rather
 * than merely off — the two must never look the same.
 */
export function ToggleSwitch({
  on,
  busy = false,
  disabled = false,
  locked = false,
  title,
  label,
  onToggle,
}: {
  on: boolean;
  busy?: boolean;
  disabled?: boolean;
  locked?: boolean;
  title?: string;
  label?: string;
  onToggle: () => void;
}) {
  if (locked) {
    return (
      <span
        title={title}
        className="cursor-help text-[10px] uppercase tracking-wide text-zinc-400 dark:text-zinc-600"
      >
        locked
      </span>
    );
  }
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label ?? (on ? 'On' : 'Off')}
      disabled={busy || disabled}
      title={title}
      onClick={onToggle}
      className="inline-flex items-center gap-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span
        className={`relative inline-block h-5 w-9 shrink-0 rounded-full transition-colors ${
          on ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-700'
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
            on ? 'left-[18px]' : 'left-0.5'
          }`}
        />
      </span>
      {label && (
        <span className={on ? 'text-emerald-700 dark:text-emerald-400' : 'text-zinc-500'}>{label}</span>
      )}
    </button>
  );
}

/** Compact stat tile for a strip inside a card. `StatCard` is the full-size one. */
export function MiniStat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  /** A signed number colours the value green/red/grey. */
  tone?: number;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <span className="text-[9px] uppercase tracking-wide text-zinc-500">{label}</span>
      <div className={`font-mono text-lg font-semibold tabular-nums ${tone !== undefined ? pnlColor(tone) : ''}`}>
        {value}
      </div>
      {sub && <span className="block truncate text-[10px] text-zinc-400">{sub}</span>}
    </div>
  );
}

/** One line of a definition list: label on the left, value on the right, optional hint under the label. */
export function DlRow({
  label,
  value,
  hint,
  valueClass,
}: {
  label: string;
  value: string;
  hint?: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-zinc-500">
        {label}
        {hint && <span className="block text-xs text-zinc-400">{hint}</span>}
      </dt>
      <dd className={`shrink-0 tabular-nums ${valueClass ?? ''}`}>{value}</dd>
    </div>
  );
}

/** Text colour for an accumulator engine-log event kind. */
export function eventKindColor(kind: string): string {
  if (kind === 'FILL') return 'text-emerald-600 dark:text-emerald-400';
  if (kind === 'REFUSED' || kind === 'REJECT' || kind === 'HALT') return 'text-rose-600 dark:text-rose-400';
  if (kind === 'SETTLED') return 'text-amber-600 dark:text-amber-400';
  if (kind === 'LADDER') return 'text-blue-600 dark:text-blue-400';
  return 'text-zinc-400';
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-6 flex items-end justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
