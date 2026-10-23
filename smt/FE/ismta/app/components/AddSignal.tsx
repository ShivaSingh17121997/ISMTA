'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { inr } from '../lib/format';
import type { AddLight, AddSignal, AddSignalsResponse } from '../lib/types';
import { usePolling } from '../lib/usePolling';

/**
 * The "add money now?" light, shared by the stock table and the
 * recommendations page. Logic lives on the server (services/addSignal); this
 * only draws it.
 *
 * Always dot + word + colour, never colour alone, so it reads for colour-blind
 * eyes and in a screenshot pasted into a chat. Click opens the reasons; the
 * light is only useful if the "why" is one click away.
 */

const STYLE: Record<AddLight, { dot: string; pill: string }> = {
  green: {
    dot: 'bg-emerald-500',
    pill: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
  },
  yellow: {
    dot: 'bg-amber-400',
    pill: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  },
  red: {
    dot: 'bg-rose-500',
    pill: 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300',
  },
  grey: {
    dot: 'bg-zinc-400',
    pill: 'border-zinc-300 bg-zinc-50 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400',
  },
};

/** What the pill says under its label: the amount or share to add now. */
function subline(s: AddSignal): string {
  if (s.light === 'red') return 'pause new money';
  if (s.light === 'grey') return 'no data';
  if (s.nowAmount > 0) {
    const shares = s.nowShares !== null ? ` · ${s.nowShares} sh` : '';
    return `${inr(s.nowAmount, 0)} now${shares}${s.nowPct < 100 ? ` · ${s.nowPct}%` : ''}`;
  }
  return s.label === 'Under 1 share' ? 'plan too small' : `${s.nowPct}% of usual`;
}

export function AddSignalPill({
  signal,
  loading,
  align = 'left',
}: {
  signal: AddSignal | undefined;
  loading?: boolean;
  /** Which side the reasons panel opens towards. */
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  if (!signal) {
    return <span className="text-[10px] text-zinc-400">{loading ? 'checking…' : '—'}</span>;
  }
  const st = STYLE[signal.light];

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={signal.action}
        data-light={signal.light}
        className={`flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-left ${st.pill}`}
      >
        <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${st.dot}`} />
        <span className="flex flex-col leading-tight">
          <span className="text-[11px] font-semibold">{signal.label}</span>
          <span className="text-[9px] opacity-80 tabular-nums">{subline(signal)}</span>
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={`Add money to ${signal.symbol}?`}
          className={`absolute top-full z-30 mt-1 w-72 rounded-lg border border-zinc-200 bg-white p-3 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900 ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          <div className="mb-1 flex items-center gap-1.5 font-semibold">
            <span aria-hidden className={`h-2 w-2 rounded-full ${st.dot}`} />
            {signal.symbol}: {signal.label}
          </div>
          <p className="mb-2 text-zinc-800 dark:text-zinc-200">{signal.action}</p>
          {signal.planned > 0 && signal.light !== 'red' && signal.light !== 'grey' && (
            <div className="mb-2 grid grid-cols-2 gap-1 text-center">
              <Mini label="Add now" value={inr(signal.nowAmount, 0)} sub={shares(signal.nowShares)} />
              <Mini label="Room allowed" value={inr(signal.planned, 0)} sub={`${signal.nowPct}% of it`} />
            </div>
          )}
          <ul className="list-disc space-y-1 pl-4 text-zinc-600 dark:text-zinc-400">
            {signal.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          {signal.notes.length > 0 && (
            <ul className="mt-2 space-y-1 border-t border-zinc-200 pt-2 text-[11px] text-zinc-500 dark:border-zinc-800">
              {signal.notes.map((n) => (
                <li key={n}>ℹ {n}</li>
              ))}
            </ul>
          )}
          <p className="mt-2 border-t border-zinc-200 pt-2 text-[10px] text-zinc-400 dark:border-zinc-800">
            About new money only. It never means sell what you own. Not investment advice.
          </p>
        </div>
      )}
    </div>
  );
}

const shares = (n: number | null): string | undefined => (n === null ? undefined : `${n} share${n === 1 ? '' : 's'}`);

function Mini({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded bg-zinc-100 px-1 py-1 dark:bg-zinc-800">
      <div className="text-[9px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="font-mono text-[11px] tabular-nums">{value}</div>
      {sub && <div className="text-[9px] text-zinc-500">{sub}</div>}
    </div>
  );
}

/** One line above a list: how many of each colour, and the market read they share. */
export function AddSignalSummary({
  data,
  error,
  onRefresh,
  refreshing,
}: {
  data: AddSignalsResponse | null;
  error?: string | null;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  if (!data) {
    return error ? (
      <p className="mb-3 text-[11px] text-rose-600 dark:text-rose-400">Add-money lights unavailable: {error}</p>
    ) : (
      <p className="mb-3 text-[11px] text-zinc-500">Checking whether each stock is a good add right now… (first check can take ~30s)</p>
    );
  }
  const c = data.counts;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-zinc-200 px-3 py-2 text-[11px] dark:border-zinc-800">
      <span className="font-semibold">Add money?</span>
      <Count light="green" n={c.green} word="add now" />
      <Count light="yellow" n={c.yellow} word="smaller" />
      <Count light="red" n={c.red} word="wait" />
      {c.grey > 0 && <Count light="grey" n={c.grey} word="no data" />}
      <span className="text-zinc-500">
        · Market: <span className="font-medium">{data.market ? data.market.title : 'still loading'}</span>
      </span>
      {data.staleNote && <span className="text-amber-700 dark:text-amber-400">· {data.staleNote}</span>}
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="ml-auto rounded border border-zinc-300 px-1.5 py-0.5 text-[10px] text-zinc-500 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-900"
          title="Recompute now instead of using the 10-minute cache"
        >
          {refreshing ? '…' : 'Recheck'}
        </button>
      )}
      <span className="basis-full text-[10px] text-zinc-400">
        Click a light for the reasons. Green: buy now. Yellow: buy now, but less — a very bumpy or thinly traded stock.
        Red only for tested or hard reasons (market HOLD sign, NSE surveillance, bad news, engine block, stock already at
        the {data.capPct}% limit). No light ever says &quot;wait for a dip&quot;: in a 10-year test that cost money.
      </span>
    </div>
  );
}

function Count({ light, n, word }: { light: AddLight; n: number; word: string }) {
  return (
    <span className="flex items-center gap-1">
      <span aria-hidden className={`h-2 w-2 rounded-full ${STYLE[light].dot}`} />
      <span className="tabular-nums font-medium">{n}</span> {word}
    </span>
  );
}

/**
 * Fetch the lights for one screen. Five-minute poll — the server caches ten,
 * and nothing behind a light moves faster than that. `recheck` forces a
 * recompute, then re-reads.
 */
export function useAddSignals(kind: 'books' | 'recommendations') {
  const poll = usePolling(() => api.addSignals(kind), 300_000);
  const [rechecking, setRechecking] = useState(false);
  const { refresh } = poll;
  // Stable, so a caller can list it as an effect dependency.
  const recheck = useCallback(async () => {
    setRechecking(true);
    try {
      await api.addSignals(kind, true);
      refresh();
    } finally {
      setRechecking(false);
    }
  }, [kind, refresh]);
  return { ...poll, recheck, rechecking };
}
