'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Polls an async fetcher on an interval; returns data, loading and error. */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs = 4000,
): { data: T | null; loading: boolean; error: string | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  // Keep the ref on the latest fetcher without writing it during render.
  // A layout effect commits before the polling effect below runs, so the
  // first fetch still sees this render's fetcher.
  useLayoutEffect(() => {
    fetcherRef.current = fetcher;
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      try {
        const d = await fetcherRef.current();
        if (alive) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Error');
      } finally {
        if (alive) setLoading(false);
      }
    };
    run();
    const id = setInterval(run, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [intervalMs, tick]);

  return { data, loading, error, refresh: () => setTick((t) => t + 1) };
}
