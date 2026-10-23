'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useChartPalette } from '../../lib/chartPalette';

/**
 * The equity curve, at hero size.
 *
 * ONE series, so there is no legend — the heading above it names the line, and
 * a legend box for a single series is furniture. Identity is carried by the
 * heading and the direct end-label rather than by colour alone.
 *
 * Hand-rolled SVG rather than Recharts, which the analytics page uses. A hero
 * curve wants an area fill that fades, a crosshair that snaps to the nearest
 * day, and an end-cap dot — all of which are ~40 lines here and a fight with
 * `ResponsiveContainer` there. The full charted view with axes, the benchmark
 * and a tooltip table still lives on /analytics; this is the glance version.
 *
 * Measured in real pixels via ResizeObserver rather than a scaled viewBox.
 * `preserveAspectRatio="none"` would stretch the stroke to different weights
 * horizontally and vertically, which is the usual way sparklines end up looking
 * subtly wrong.
 */

export interface SparkPoint {
  label: string;
  value: number;
}

export function Sparkline({
  points,
  height = 96,
  /** Formats the value in the tooltip and on the end label. */
  format,
  ariaLabel,
}: {
  points: SparkPoint[];
  height?: number;
  format: (n: number) => string;
  ariaLabel: string;
}) {
  const palette = useChartPalette();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [reduceMotion, setReduceMotion] = useState(false);

  // Width has to come from the DOM: the curve is drawn in device pixels.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReduceMotion(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  const n = points.length;
  // Below two points there is no line to draw, and a single dot implying a
  // trend would be a lie.
  if (n < 2 || width <= 0) {
    return (
      <div ref={wrapRef} style={{ height }} className="flex items-center text-xs text-zinc-400">
        {n < 2 ? 'Not enough history yet to draw a curve.' : ''}
      </div>
    );
  }

  const padY = 6;
  const values = points.map((p) => p.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  // A dead-flat series would divide by zero; centre it instead.
  const span = hi - lo || Math.abs(hi) || 1;
  const x = (i: number) => (i / (n - 1)) * width;
  const y = (v: number) => padY + (1 - (v - lo) / span) * (height - padY * 2);

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(p.value).toFixed(2)}`).join(' ');
  const area = `${line} L${width.toFixed(2)},${height} L0,${height} Z`;

  const first = points[0].value;
  const last = points[n - 1].value;
  const up = last >= first;
  // The curve is coloured by direction, and direction is ALSO stated in words
  // beside the hero number — never colour alone.
  const stroke = up ? palette.good : palette.bad;
  const gradId = `spark-${up ? 'up' : 'down'}`;

  const active = hover === null ? null : points[hover];

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - rect.left) / rect.width;
    setHover(Math.max(0, Math.min(n - 1, Math.round(rel * (n - 1)))));
  };

  return (
    <div ref={wrapRef} className="relative" style={{ height }}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        className="touch-none"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>

        <path d={area} fill={`url(#${gradId})`} />
        <path
          d={line}
          fill="none"
          stroke={stroke}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Crosshair. Snaps to the nearest day so the readout is a real
            observation rather than an interpolation. */}
        {active && (
          <g pointerEvents="none">
            <line
              x1={x(hover!)}
              y1={0}
              x2={x(hover!)}
              y2={height}
              stroke={palette.axis}
              strokeWidth={1}
            />
            {/* 2px surface ring, so the marker stays legible over the fill. */}
            <circle cx={x(hover!)} cy={y(active.value)} r={5} fill={palette.surface} />
            <circle cx={x(hover!)} cy={y(active.value)} r={4} fill={stroke} />
          </g>
        )}

        {/* End cap: where the series is now. */}
        <circle
          cx={x(n - 1)}
          cy={y(last)}
          r={3.5}
          fill={stroke}
          stroke={palette.surface}
          strokeWidth={2}
          className={reduceMotion ? undefined : 'animate-pulse'}
        />
      </svg>

      {active && (
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-zinc-200 bg-white px-2 py-1 text-[11px] shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
          style={{
            // Clamped so the tooltip never hangs off either edge.
            left: Math.min(Math.max(x(hover!), 54), Math.max(width - 54, 54)),
          }}
        >
          <span className="font-mono tabular-nums text-zinc-900 dark:text-zinc-100">
            {format(active.value)}
          </span>
          <span className="ml-1.5 text-zinc-400">{active.label}</span>
        </div>
      )}
    </div>
  );
}
