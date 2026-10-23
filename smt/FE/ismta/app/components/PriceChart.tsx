'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { CandleChart, type Bar, type PriceLine } from './CandleChart';

/**
 * A symbol's candlestick chart: real history from `/api/market/candles`
 * (refreshed every minute) with the live price painted into the last bar
 * between refreshes. The caption names the data source, so a chart built from
 * the simulator's synthetic bars can never be mistaken for a real one.
 */
export function PriceChart({
  symbol,
  livePrice,
  range = '1d',
  interval = '1m',
  priceLines,
  height = 320,
  showVolume = true,
}: {
  symbol: string;
  livePrice?: number;
  /** Yahoo range: 1d 5d 1mo 3mo 6mo 1y 2y 5y 10y */
  range?: string;
  /** Yahoo interval: 1m 5m 15m 30m 60m 1d 1wk */
  interval?: string;
  priceLines?: PriceLine[];
  height?: number;
  showVolume?: boolean;
}) {
  const [bars, setBars] = useState<Bar[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const r = await api.candles(symbol, range, interval);
        if (!alive) return;
        setBars(
          r.candles.map((c) => ({
            time: c.timestamp,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
          })),
        );
        setSource(r.source);
        setUpdatedAt(Date.now());
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [symbol, range, interval]);

  const synthetic = source === 'sim';

  return (
    <div>
      {error && <p className="mb-2 text-xs text-rose-500">{error}</p>}
      {synthetic && (
        <p className="mb-2 rounded border border-rose-300 bg-rose-50 px-2 py-1 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          SYNTHETIC bars — DATA_SOURCE=sim. This is not {symbol}&apos;s price history.
        </p>
      )}
      {bars.length === 0 && !error && (
        <p className="mb-2 text-xs text-zinc-400">Loading {symbol} {interval} bars…</p>
      )}
      <CandleChart
        bars={bars}
        livePrice={livePrice}
        priceLines={priceLines}
        height={height}
        showVolume={showVolume}
      />
      {source && source !== 'none' && (
        <p className="mt-1 text-right text-[11px] tabular-nums text-zinc-400">
          {bars.length} bars · {interval} · source <span className="font-medium">{source}</span> ·
          history refreshed {updatedAt ? new Date(updatedAt).toLocaleTimeString('en-IN') : '—'} ·
          live tick overlays the last bar
        </p>
      )}
      {source === 'none' && (
        <p className="mt-1 text-right text-[11px] text-rose-500">No bars available for {symbol} from the feed.</p>
      )}
    </div>
  );
}
