'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { useSystem } from '../providers/SystemProvider';
import BrandMark from './BrandMark';

/**
 * Primary navigation. One entry per page; the order is the order a trading day
 * is read in: what is happening, what to do, what it cost, is the system safe.
 *
 * `key` is the second key of the `g` shortcut (`g d` → dashboard).
 */
export const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: '📊', key: 'd' },
  { href: '/accumulator', label: 'Accumulator', icon: '📥', key: 'a' },
  { href: '/recommendations', label: 'Recommendations', icon: '🎯', key: 'r' },
  { href: '/trading/live', label: 'Trade', icon: '⚡', key: 't' },
  { href: '/strategies', label: 'Strategies', icon: '🧠', key: 's' },
  { href: '/backtest', label: 'Backtest', icon: '📈', key: 'b' },
  { href: '/analytics', label: 'Analytics', icon: '📉', key: 'n' },
  { href: '/risk', label: 'Risk', icon: '🛡️', key: 'k' },
  { href: '/market-weather', label: 'Market Weather', icon: '🌦️', key: 'w' },
  { href: '/global-markets', label: 'Global Markets', icon: '🌍', key: 'o' },
  { href: '/foreign-stocks', label: 'Foreign Stocks', icon: '🌐', key: 'f' },
  { href: '/tax', label: 'Tax', icon: '🧾', key: 'x' },
  { href: '/system', label: 'System', icon: '🩺', key: 'y' },
  { href: '/audit', label: 'Audit log', icon: '📜', key: 'l' },
  { href: '/settings', label: 'Settings', icon: '⚙️', key: ',' },
];

export function isNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + '/');
}

/** The list of links, shared by the desktop sidebar and the phone drawer. */
export function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-1 flex-col gap-1 px-3" aria-label="Primary">
      {NAV.map((item) => {
        const active = isNavActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
              active
                ? 'bg-blue-600 text-white'
                : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900'
            }`}
          >
            <span aria-hidden="true">{item.icon}</span>
            <span className="flex-1">{item.label}</span>
            <kbd
              className={`hidden font-mono text-[10px] md:inline ${active ? 'text-blue-200' : 'text-zinc-300 dark:text-zinc-600'}`}
              aria-hidden="true"
            >
              g {item.key}
            </kbd>
          </Link>
        );
      })}
    </nav>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2 px-5 py-5">
      <BrandMark size={28} />
      <div>
        <div className="text-sm font-semibold tracking-tight">ISMTA</div>
        <div className="text-xs text-zinc-500">Algo Trading</div>
      </div>
    </div>
  );
}

/** Which broker the orders go to — the one line that must never be wrong. */
function BrokerLine() {
  const { system } = useSystem();
  const b = system?.broker;
  const text =
    b === 'paper'
      ? 'Paper trading mode'
      : b === 'zerodha'
        ? 'Zerodha — live orders'
        : b === 'groww'
          ? 'Groww — live orders'
          : b
            ? `${b} — live orders`
            : '…';
  const live = !!b && b !== 'paper';
  return (
    <div className={`px-5 py-4 text-xs ${live ? 'font-medium text-rose-500' : 'text-zinc-400'}`}>{text}</div>
  );
}

/** Desktop sidebar: hidden below the md breakpoint, where `MobileNav` takes over. */
export function Sidebar() {
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-zinc-200 bg-white md:flex dark:border-zinc-800 dark:bg-zinc-950">
      <Brand />
      <NavList />
      <BrokerLine />
    </aside>
  );
}

/** Phone drawer, opened by the hamburger in the top bar. */
export function MobileNav({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <div className={`fixed inset-0 z-50 md:hidden ${open ? '' : 'pointer-events-none'}`} aria-hidden={!open}>
      <div
        className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${open ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className={`absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-white shadow-xl transition-transform duration-200 dark:bg-zinc-950 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between pr-3">
          <Brand />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="rounded-lg p-2 text-xl leading-none text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900"
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <NavList onNavigate={onClose} />
        </div>
        <BrokerLine />
      </aside>
    </div>
  );
}
