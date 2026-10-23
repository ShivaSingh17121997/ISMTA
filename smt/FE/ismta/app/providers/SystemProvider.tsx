'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { shellApi } from '../lib/api';
import type { SystemReport } from '../lib/types';
import { useAuth } from './AuthProvider';

interface SystemState {
  system: SystemReport | null;
  error: string | null;
  /** Pull now instead of waiting for the next 30 s tick — after a halt, a reconcile, a notice. */
  refresh: () => void;
}

const SystemContext = createContext<SystemState>({ system: null, error: null, refresh: () => {} });

const POLL_MS = 30_000;

/**
 * The one place `/api/system` is polled. The top bar (phase, feed age, halted,
 * broker), the sidebar footer, the settings page and the system page all read
 * this; none of them fetch it themselves.
 */
export function SystemProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const authed = !!user;
  const [system, setSystem] = useState<SystemReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!authed) return;
    let alive = true;
    const run = async () => {
      try {
        const s = await shellApi.system();
        if (alive) {
          setSystem(s);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'System status unavailable');
      }
    };
    void run();
    const id = setInterval(run, POLL_MS);
    // A 30 s cadence paused in a background tab is stale on return; re-pull on focus.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [authed, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const value = useMemo(() => ({ system, error, refresh }), [system, error, refresh]);
  return <SystemContext.Provider value={value}>{children}</SystemContext.Provider>;
}

export function useSystem(): SystemState {
  return useContext(SystemContext);
}
