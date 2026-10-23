'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { AuthUser, SessionPhase } from '../lib/types';
import { formatDuration, istClock, istDayLabel, istTime, nextOpenAt, phaseFor, useNow } from '../lib/useNow';
import { useAuth } from '../providers/AuthProvider';
import { useSystem } from '../providers/SystemProvider';

type Pill = SessionPhase | 'holiday' | 'weekend';

const PILL_STYLE: Record<Pill, string> = {
  open: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  pre_open: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  post_close: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  closed: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
  holiday: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  weekend: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
};
const PILL_LABEL: Record<Pill, string> = {
  open: 'Open',
  pre_open: 'Pre-open',
  post_close: 'Post-close',
  closed: 'Closed',
  holiday: 'Holiday',
  weekend: 'Weekend',
};

const BROKER: Record<string, { label: string; cls: string }> = {
  paper: { label: 'Paper', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  zerodha: { label: 'Zerodha', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
  groww: { label: 'Groww', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
};

/**
 * Top bar: the session (phase pill, IST clock, time to the next open), the
 * feed's age, a HALTED pill when the process-wide halt is engaged, the broker
 * the orders go to, the live-socket dot and the user menu.
 *
 * It used to show "Today P&L" from the strategy engine's daily bucket. That
 * bucket outlived the trades behind it, so every page carried a loss that no
 * longer existed. P&L now lives on the dashboard, computed from the books
 * that actually hold the capital.
 *
 * `/api/system` is polled once, in SystemProvider; this only reads it.
 */
export function Topbar({ connected, onMenu }: { connected: boolean; onMenu: () => void }) {
  const { user, logout } = useAuth();
  const { system } = useSystem();
  const now = useNow(1000);

  // Phase: the server says whether today trades (it holds the holiday list);
  // the fixed NSE timings are applied to the live clock here, so the pill
  // flips at 09:15:00 rather than up to 30 s later.
  const tradingDay = system?.session.tradingDay ?? true;
  const phase: SessionPhase = now ? phaseFor(now, tradingDay) : (system?.session.phase ?? 'closed');
  let pill: Pill = phase;
  if (system && !tradingDay) {
    const dow = now ? istClock(now).dayOfWeek : 1;
    pill = dow === 0 || dow === 6 ? 'weekend' : 'holiday';
  }
  const opensAt = now && system && phase !== 'open' ? nextOpenAt(now, tradingDay) : null;

  const feed = system?.feed ?? null;
  const feedAge = feed?.lastPassAt && now ? Math.max(0, Math.round((now - feed.lastPassAt) / 1000)) : null;
  const feedTone =
    feedAge === null
      ? 'text-zinc-400'
      : feedAge > 180
        ? 'text-rose-600 dark:text-rose-400'
        : feedAge > 60
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-zinc-500';

  const broker = system ? (BROKER[system.broker] ?? { label: system.broker, cls: BROKER.zerodha.cls }) : null;

  return (
    <header className="flex items-center gap-2 border-b border-zinc-200 bg-white px-3 py-2 md:gap-4 md:px-6 md:py-3 dark:border-zinc-800 dark:bg-zinc-950">
      <button
        type="button"
        onClick={onMenu}
        aria-label="Open navigation"
        className="-ml-1 rounded-lg p-2 text-zinc-600 hover:bg-zinc-100 md:hidden dark:text-zinc-300 dark:hover:bg-zinc-900"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M3 5h14M3 10h14M3 15h14" strokeLinecap="round" />
        </svg>
      </button>

      <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        <span
          title={connected ? 'Live feed connected' : 'Reconnecting…'}
          className={`inline-block h-2 w-2 shrink-0 rounded-full ${connected ? 'bg-emerald-500' : 'bg-rose-500'}`}
        />
        <span className="hidden text-zinc-500 lg:inline">{connected ? 'Live feed connected' : 'Reconnecting…'}</span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${PILL_STYLE[pill]}`}
          title={system?.session.describe ?? 'Session phase'}
          data-testid="phase-pill"
        >
          {PILL_LABEL[pill]}
        </span>
        <span className="shrink-0 font-mono text-xs text-zinc-600 tabular-nums dark:text-zinc-300" title="Indian Standard Time">
          {now ? istTime(now) : '--:--:--'}
          <span className="hidden sm:inline"> IST</span>
        </span>
        {opensAt !== null && (
          <span className="hidden truncate text-xs text-zinc-400 sm:inline" title={`Next open: ${istDayLabel(opensAt)} 09:15 IST`}>
            opens in {formatDuration(opensAt - now)}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 text-sm md:gap-3">
        {feed ? (
          <span
            className={`font-mono text-xs tabular-nums ${feedTone}`}
            title={
              feedAge === null
                ? 'The feed has not completed a pass yet'
                : `Last feed pass ${feedAge}s ago · ${feed.priced}/${feed.tracked} priced${feed.running ? '' : ' · NOT RUNNING'}`
            }
          >
            feed {feedAge === null ? '—' : `${feedAge}s`}
          </span>
        ) : system ? (
          <span className="text-xs text-zinc-400" title="Data source">
            {system.dataSource}
          </span>
        ) : null}
        {system?.halted && (
          <Link
            href="/system"
            className="animate-pulse rounded-full bg-rose-600 px-2 py-0.5 text-xs font-semibold text-white"
            title={system.halts.map((h) => `${h.key}: ${h.reason}`).join('\n') || 'Trading halted'}
          >
            HALTED
          </Link>
        )}
        {broker && (
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${broker.cls}`} title="Broker">
            {broker.label}
          </span>
        )}
        <UserMenu user={user} onLogout={logout} />
      </div>
    </header>
  );
}

function UserMenu({ user, onLogout }: { user: AuthUser | null; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const initials =
    (user?.name ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((s) => s[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full pr-1 hover:bg-zinc-100 md:pr-2 dark:hover:bg-zinc-900"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">
          {initials}
        </span>
        <span className="hidden text-zinc-700 md:inline dark:text-zinc-200">{user?.name ?? '…'}</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-full right-0 z-50 mt-2 w-56 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-950"
        >
          <div className="px-3 py-2">
            <div className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">{user?.name}</div>
            <div className="truncate text-xs text-zinc-500">{user?.email}</div>
            <div className="mt-1 text-[10px] uppercase tracking-wide text-zinc-400">
              {user?.role}
              {user?.totpEnabled ? ' · 2FA on' : ''}
            </div>
          </div>
          <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
          <Link
            role="menuitem"
            href="/settings"
            onClick={() => setOpen(false)}
            className="block rounded px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            Settings
          </Link>
          <Link
            role="menuitem"
            href="/system"
            onClick={() => setOpen(false)}
            className="block rounded px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            System status
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={onLogout}
            className="block w-full rounded px-3 py-1.5 text-left text-sm text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
