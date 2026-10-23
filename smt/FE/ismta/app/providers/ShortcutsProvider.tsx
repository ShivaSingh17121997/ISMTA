'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { NAV } from '../components/Sidebar';

export interface ShortcutRow {
  keys: string[];
  label: string;
}

/** The reference list — rendered by the `?` overlay and the settings page. */
export const SHORTCUTS: ShortcutRow[] = [
  { keys: ['?'], label: 'Show keyboard shortcuts' },
  { keys: ['Esc'], label: 'Close dialogs and menus' },
  { keys: ['b'], label: 'Buy — focus the order ticket on the trade page' },
  { keys: ['s'], label: 'Sell — focus the order ticket on the trade page' },
  ...NAV.map((n) => ({ keys: ['g', n.key], label: `Go to ${n.label}` })),
];

/** How long a bare `g` waits for its second key. */
const G_TIMEOUT_MS = 1_500;

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable || !!target.closest('[contenteditable=""],[contenteditable="true"]');
}

interface ShortcutsState {
  helpOpen: boolean;
  openHelp: () => void;
  closeHelp: () => void;
}

const ShortcutsContext = createContext<ShortcutsState>({ helpOpen: false, openHelp: () => {}, closeHelp: () => {} });

/**
 * Global keyboard shortcuts. `?` opens the help overlay; `g` then a NAV key
 * navigates; `b` / `s` are broadcast as `ismta:shortcut` for the trade page's
 * order ticket. Keystrokes inside inputs, textareas and contenteditable
 * elements are left alone, as are chords with Ctrl/Cmd/Alt.
 */
export function ShortcutsProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [helpOpen, setHelpOpen] = useState(false);
  /** Timestamp of the last bare `g`; 0 when none is pending. */
  const pendingG = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (e.key === 'Escape') {
        setHelpOpen(false);
        return;
      }
      if (isTyping(e.target)) return;

      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const now = Date.now();

      if (pendingG.current && now - pendingG.current < G_TIMEOUT_MS) {
        pendingG.current = 0;
        const item = NAV.find((n) => n.key === key);
        if (item) {
          e.preventDefault();
          setHelpOpen(false);
          router.push(item.href);
          return;
        }
      }
      if (e.key === '?') {
        e.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }
      if (key === 'g') {
        pendingG.current = now;
        return;
      }
      if (key === 'b' || key === 's') {
        window.dispatchEvent(new CustomEvent('ismta:shortcut', { detail: { key } }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  const openHelp = useCallback(() => setHelpOpen(true), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  const value = useMemo(() => ({ helpOpen, openHelp, closeHelp }), [helpOpen, openHelp, closeHelp]);

  return (
    <ShortcutsContext.Provider value={value}>
      {children}
      {helpOpen && <HelpOverlay onClose={closeHelp} />}
    </ShortcutsContext.Provider>
  );
}

export function useShortcuts(): ShortcutsState {
  return useContext(ShortcutsContext);
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[1.6rem] items-center justify-center rounded border border-zinc-300 bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
      {children}
    </kbd>
  );
}

/** The rows, with keys rendered as keycaps. Shared by the overlay and the settings page. */
export function ShortcutList({ compact = false }: { compact?: boolean }) {
  return (
    <ul className={compact ? 'space-y-1.5' : 'space-y-2'}>
      {SHORTCUTS.map((s) => (
        <li key={s.keys.join('+')} className="flex items-center justify-between gap-4 text-sm">
          <span className="text-zinc-600 dark:text-zinc-300">{s.label}</span>
          <span className="flex shrink-0 items-center gap-1">
            {s.keys.map((k, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span className="text-[10px] text-zinc-400">then</span>}
                <Kbd>{k}</Kbd>
              </span>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="shortcuts-title" className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded px-2 text-lg leading-none text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            ×
          </button>
        </div>
        <ShortcutList />
        <p className="mt-4 text-xs text-zinc-400">Shortcuts are ignored while typing in a field.</p>
      </div>
    </div>
  );
}
