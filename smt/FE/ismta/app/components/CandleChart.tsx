'use client';

import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';

/**
 * Candlestick chart on TradingView's Lightweight Charts (v5) — the canvas
 * engine behind TradingView's own charts, open source under Apache-2.0. Used
 * here because a general-purpose SVG chart library cannot draw a candlestick
 * with a volume pane and price lines at 60fps over thousands of bars.
 *
 * Time axis is shown in IST: Lightweight Charts renders UTC, so every bar time
 * is shifted by +5:30 before it goes in. That is a display offset only — the
 * bar's own timestamp is never altered anywhere else.
 */

export interface Bar {
  /** epoch ms */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface PriceLine {
  price: number;
  color: string;
  title: string;
  style?: 'solid' | 'dashed' | 'dotted';
  /**
   * Print this line's price on the right axis. Default true. Set false for
   * secondary lines (unfilled rungs): their tags stack on top of the live
   * price and the targets and hide them, and the line's title still says
   * what it is.
   */
  axisLabel?: boolean;
}

const IST_OFFSET_S = 5.5 * 3600;
const toTime = (ms: number): UTCTimestamp => (Math.floor(ms / 1000) + IST_OFFSET_S) as UTCTimestamp;

function palette(dark: boolean) {
  return {
    text: dark ? '#a1a1aa' : '#52525b',
    grid: dark ? 'rgba(63,63,70,0.35)' : 'rgba(228,228,231,0.9)',
    border: dark ? '#3f3f46' : '#e4e4e7',
    up: '#10b981',
    down: '#f43f5e',
    volUp: 'rgba(16,185,129,0.35)',
    volDown: 'rgba(244,63,94,0.35)',
  };
}

// en-IN grouping, like every other price in the app (₹1,773.30, not ₹1773.30).
// One formatter instance: Lightweight Charts calls this for every axis tick.
const INR_AXIS = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const lineStyle = (s: PriceLine['style']): LineStyle =>
  s === 'dashed' ? LineStyle.Dashed : s === 'dotted' ? LineStyle.Dotted : LineStyle.Solid;

interface Handles {
  chart: IChartApi;
  candles: ISeriesApi<'Candlestick'>;
  volume: ISeriesApi<'Histogram'> | null;
}

/** Replace the series data. Returns the last bar, which the live tick paints into. */
function paintBars(h: Handles, bars: Bar[]): Bar | null {
  const p = palette(window.matchMedia('(prefers-color-scheme: dark)').matches);
  const seen = new Set<number>();
  const candles: { time: UTCTimestamp; open: number; high: number; low: number; close: number }[] = [];
  const volume: { time: UTCTimestamp; value: number; color: string }[] = [];
  for (const b of bars) {
    const t = toTime(b.time);
    if (seen.has(t)) continue;
    seen.add(t);
    candles.push({ time: t, open: b.open, high: b.high, low: b.low, close: b.close });
    volume.push({ time: t, value: b.volume ?? 0, color: b.close >= b.open ? p.volUp : p.volDown });
  }
  h.candles.setData(candles);
  h.volume?.setData(volume);
  h.chart.timeScale().fitContent();
  const last = bars[bars.length - 1];
  return last ? { ...last } : null;
}

/** Replace the horizontal price lines. */
function paintLines(h: Handles, existing: IPriceLine[], lines: PriceLine[]): IPriceLine[] {
  for (const l of existing) h.candles.removePriceLine(l);
  return lines
    .filter((l) => Number.isFinite(l.price) && l.price > 0)
    .map((l) =>
      h.candles.createPriceLine({
        price: l.price,
        color: l.color,
        lineWidth: 1,
        lineStyle: lineStyle(l.style),
        axisLabelVisible: l.axisLabel !== false,
        title: l.title,
      }),
    );
}

export function CandleChart({
  bars,
  livePrice,
  priceLines,
  height = 320,
  showVolume = true,
}: {
  bars: Bar[];
  /** The latest print. Overlays the last bar (updates its close/high/low). */
  livePrice?: number;
  priceLines?: PriceLine[];
  height?: number;
  showVolume?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handlesRef = useRef<Handles | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  /** The bar the live tick is drawn into. Accumulates high/low across ticks. */
  const liveBarRef = useRef<Bar | null>(null);

  // Price lines change identity every poll; key the effect on their content.
  const linesKey = JSON.stringify(priceLines ?? []);

  // 1. Create the chart. Re-created only when its geometry options change; the
  //    data and line effects below also depend on those, so they repaint.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const p = palette(mq.matches);

    const chart = createChart(el, {
      height,
      width: el.clientWidth,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: p.text,
        attributionLogo: false,
      },
      grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: p.border },
      timeScale: { borderColor: p.border, timeVisible: true, secondsVisible: false },
      localization: { locale: 'en-IN', priceFormatter: (v: number) => INR_AXIS.format(v) },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: p.up,
      downColor: p.down,
      borderUpColor: p.up,
      borderDownColor: p.down,
      wickUpColor: p.up,
      wickDownColor: p.down,
    });
    let volume: ISeriesApi<'Histogram'> | null = null;
    if (showVolume) {
      // The volume pane shares the right axis. Without these, the histogram's
      // own last-value marker prints there as a stray "₹0.00" — meaningless
      // for an index, and noise on a stock.
      volume = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
        lastValueVisible: false,
        priceLineVisible: false,
      });
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    }
    handlesRef.current = { chart, candles, volume };
    linesRef.current = [];

    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    const onTheme = (e: MediaQueryListEvent): void => {
      const q = palette(e.matches);
      chart.applyOptions({
        layout: { textColor: q.text },
        grid: { vertLines: { color: q.grid }, horzLines: { color: q.grid } },
        rightPriceScale: { borderColor: q.border },
        timeScale: { borderColor: q.border },
      });
    };
    mq.addEventListener('change', onTheme);

    return () => {
      mq.removeEventListener('change', onTheme);
      ro.disconnect();
      chart.remove();
      handlesRef.current = null;
      linesRef.current = [];
    };
  }, [height, showVolume]);

  // 2. History → series data.
  useEffect(() => {
    const h = handlesRef.current;
    if (!h) return;
    liveBarRef.current = paintBars(h, bars);
  }, [bars, height, showVolume]);

  // 3. Price lines → recreated when their content changes.
  useEffect(() => {
    const h = handlesRef.current;
    if (!h) return;
    linesRef.current = paintLines(h, linesRef.current, JSON.parse(linesKey) as PriceLine[]);
  }, [linesKey, height, showVolume]);

  // 4. Live tick → painted into the last bar without refetching history.
  useEffect(() => {
    const h = handlesRef.current;
    const b = liveBarRef.current;
    if (!h || !b || livePrice === undefined || !(livePrice > 0)) return;
    b.high = Math.max(b.high, livePrice);
    b.low = Math.min(b.low, livePrice);
    b.close = livePrice;
    h.candles.update({ time: toTime(b.time), open: b.open, high: b.high, low: b.low, close: b.close });
  }, [livePrice]);

  // The lines are drawn on a canvas, so nothing in the DOM says what is painted;
  // this attribute does, for a headless check and for anyone inspecting the page.
  return <div ref={containerRef} data-price-lines={linesKey} style={{ width: '100%', height }} />;
}
