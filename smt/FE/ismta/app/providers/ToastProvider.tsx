'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Notice } from '../lib/types';

export interface Toast extends Notice {
  id: number;
}

interface ToastState {
  toasts: Toast[];
  push: (level: Notice['level'], text: string) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastState>({ toasts: [], push: () => {}, dismiss: () => {} });

/** ms until auto-dismiss; 0 = stays until closed. A critical notice is never allowed to scroll away unseen. */
const TTL: Record<Notice['level'], number> = { info: 6_000, warn: 10_000, critical: 0 };
const MAX_VISIBLE = 5;

const TONE: Record<Notice['level'], string> = {
  info: 'border-blue-200 bg-white text-zinc-800 dark:border-blue-900 dark:bg-zinc-950 dark:text-zinc-100',
  warn: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100',
  critical: 'border-rose-400 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/70 dark:text-rose-100',
};
const DOT: Record<Notice['level'], string> = {
  info: 'bg-blue-500',
  warn: 'bg-amber-500',
  critical: 'bg-rose-500 animate-pulse',
};

/**
 * Top-right toasts for WebSocket `notice` frames and for the outcome of
 * actions on the system page. Info and warnings dismiss themselves; a
 * critical one stays until the user closes it.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (level: Notice['level'], text: string) => {
      seq.current += 1;
      const id = seq.current;
      setToasts((prev) => {
        const next = [...prev, { id, level, text }];
        // Keep the stack short: drop the oldest non-critical when it overflows.
        while (next.length > MAX_VISIBLE) {
          const i = next.findIndex((t) => t.level !== 'critical');
          if (i < 0) break;
          next.splice(i, 1);
        }
        return next;
      });
      const ttl = TTL[level];
      if (ttl) timers.current.set(id, setTimeout(() => dismiss(id), ttl));
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
    };
  }, []);

  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed top-4 right-4 left-4 z-[100] flex max-w-sm flex-col gap-2 sm:left-auto sm:w-full"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.level === 'critical' ? 'alert' : 'status'}
            className={`pointer-events-auto flex items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg ${TONE[t.level]}`}
          >
            <span className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${DOT[t.level]}`} />
            <div className="min-w-0 flex-1 break-words">
              {t.level === 'critical' && <span className="mr-1 font-semibold uppercase">Critical</span>}
              {t.text}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="-mr-1 shrink-0 rounded px-1 text-lg leading-none opacity-60 hover:opacity-100"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastState {
  return useContext(ToastContext);
}
