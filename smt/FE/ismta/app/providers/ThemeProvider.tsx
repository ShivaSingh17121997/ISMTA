'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const KEY = 'ismta_theme';
const MQ = '(prefers-color-scheme: dark)';

/**
 * Theme preference, persisted in localStorage and applied as a `dark` class on
 * <html> (Tailwind's class-based dark variant; see globals.css). "system"
 * follows the OS and is the default; the boot script in layout.tsx applies the
 * same rule before first paint so there is no flash.
 *
 * localStorage is read through `useSyncExternalStore`: the server snapshot is
 * "system", the client snapshot is the stored value, and React reconciles the
 * two after hydration without a setState-in-effect.
 */
const listeners = new Set<() => void>();

function readTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function readResolved(): ResolvedTheme {
  const t = readTheme();
  if (t !== 'system') return t;
  try {
    return window.matchMedia(MQ).matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const mq = window.matchMedia(MQ);
  const onMq = () => cb();
  mq.addEventListener('change', onMq);
  // Another tab changing the preference.
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) cb();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    mq.removeEventListener('change', onMq);
    window.removeEventListener('storage', onStorage);
  };
}

function emit(): void {
  for (const l of listeners) l();
}

interface ThemeState {
  theme: Theme;
  resolved: ResolvedTheme;
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeState>({ theme: 'system', resolved: 'light', setTheme: () => {} });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSyncExternalStore(subscribe, readTheme, () => 'system' as Theme);
  const resolved = useSyncExternalStore(subscribe, readResolved, () => 'light' as ResolvedTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', resolved === 'dark');
    root.style.colorScheme = resolved;
  }, [resolved]);

  const setTheme = useCallback((t: Theme) => {
    try {
      if (t === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, t);
    } catch {
      /* storage unavailable: the choice lasts until reload */
    }
    emit();
  }, []);

  const value = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  return useContext(ThemeContext);
}
