'use client';

import { useMemo, useState, type CSSProperties } from 'react';
import { Card } from './ui';
import { inr } from '../lib/format';
import { istYmd } from '../lib/ist';
import type { AccumulatorClosedLot } from '../lib/types';
import { useNow } from '../lib/useNow';

/**
 * Calendar heatmap of realised P&L, one cell per day — a trading journal month
 * at a glance. Ported from the NTB bot's daily P&L calendar.
 *
 * Design intent, kept from the original: untraded days recede, traded days
 * carry a tint whose intensity scales with the biggest day of the month on
 * screen. "What kind of month was this" reads from across the room, and no
 * single day screams.
 *
 * ONE DELIBERATE CHANGE FROM NTB. It buckets by IST, not by the browser's
 * timezone. NTB trades crypto around the clock, so "the calendar you live in"
 * is the right call there. This is the NSE cash segment: a trading day is an
 * IST day, every other date in this app (day highs, the allocator's trading
 * day, T+1 settlement) is computed in IST, and a calendar that disagreed with
 * them would put a 15:20 IST sale on the wrong square for anyone travelling.
 *
 * A note on what these squares can show. Every closed lot is a profit by
 * construction, so red days are impossible here and their styling exists only
 * because the component would be lying if it could not draw one. The absence
 * of red is not evidence the strategy works — the risk lives in open lots that
 * have not been sold, which no closed-trade calendar can show.
 */

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const UP = '16,185,129'; // emerald-500
const DOWN = '244,63,94'; // rose-500

interface DayAgg {
  pnl: number;
  n: number;
}

export function DailyPnlCalendar({
  lots,
  title = 'Daily profit',
}: {
  /** Closed lots. Bucketed by the IST day each one was SOLD. */
  lots: AccumulatorClosedLot[];
  title?: string;
}) {
  // The month on screen is an OFFSET from the current month, not a stored
  // date. That keeps the clock out of render entirely and makes "you cannot
  // browse into the future" a check on the offset rather than on two dates.
  const now = useNow(60_000);
  const [monthOffset, setMonthOffset] = useState(0);

  // A lot that opened in March and sold in June counts entirely on the June
  // day. That is the honest bucketing for this engine: the profit is booked on
  // the sale, and the months in between are lock-up, not performance.
  const byDay = useMemo(() => {
    const m = new Map<string, DayAgg>();
    for (const lot of lots) {
      const { y, m: mo, d } = istYmd(lot.closedAt);
      const k = `${y}-${mo}-${d}`;
      const cur = m.get(k) ?? { pnl: 0, n: 0 };
      cur.pnl += lot.pnl;
      cur.n += 1;
      m.set(k, cur);
    }
    return m;
  }, [lots]);

  const today = istYmd(now);
  const anchorDate = new Date(Date.UTC(today.y, today.m + monthOffset, 1));
  const year = anchorDate.getUTCFullYear();
  const mon = anchorDate.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, mon + 1, 0)).getUTCDate();
  // JS weeks start Sunday; this calendar starts Monday.
  const leadingBlanks = (new Date(Date.UTC(year, mon, 1)).getUTCDay() + 6) % 7;

  const days = useMemo(
    () =>
      Array.from({ length: daysInMonth }, (_, i) => ({
        day: i + 1,
        agg: byDay.get(`${year}-${mon}-${i + 1}`) ?? null,
      })),
    [byDay, year, mon, daysInMonth],
  );

  // Every hook above this line runs unconditionally. `useNow` reports 0 for the
  // first frame; rendering that would draw January 1970.
  if (now === 0) {
    return (
      <Card title={title}>
        <p className="text-sm text-zinc-500">Loading…</p>
      </Card>
    );
  }

  const traded = days.filter((d) => d.agg);
  const monthPnl = traded.reduce((s, d) => s + d.agg!.pnl, 0);
  const monthTrades = traded.reduce((s, d) => s + d.agg!.n, 0);
  const greenDays = traded.filter((d) => d.agg!.pnl > 0).length;
  const redDays = traded.filter((d) => d.agg!.pnl < 0).length;
  const best = traded.reduce<(typeof days)[number] | null>(
    (b, d) => (b === null || d.agg!.pnl > b.agg!.pnl ? d : b),
    null,
  );
  const worst = traded.reduce<(typeof days)[number] | null>(
    (w, d) => (w === null || d.agg!.pnl < w.agg!.pnl ? d : w),
    null,
  );
  // Intensity is relative to the month on screen, so a quiet month is still legible.
  const maxAbs = Math.max(1e-9, ...traded.map((d) => Math.abs(d.agg!.pnl)));

  const isCurrentMonth = monthOffset === 0;
  const monthLabel = new Date(Date.UTC(year, mon, 1)).toLocaleString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const monthShort = new Date(Date.UTC(year, mon, 1)).toLocaleString('en-IN', {
    month: 'short',
    timeZone: 'UTC',
  });

  const step = (delta: number) => setMonthOffset((o) => Math.min(0, o + delta));

  const cellStyle = (agg: DayAgg | null): CSSProperties => {
    if (!agg || agg.pnl === 0) return {};
    const ratio = Math.abs(agg.pnl) / maxAbs;
    const rgb = agg.pnl > 0 ? UP : DOWN;
    return {
      background: `linear-gradient(160deg, rgba(${rgb},${0.05 + 0.16 * ratio}) 0%, rgba(${rgb},${0.1 + 0.26 * ratio}) 100%)`,
      borderColor: `rgba(${rgb},${0.25 + 0.4 * ratio})`,
    };
  };

  return (
    <Card
      title={title}
      action={
        <div className="flex items-center gap-1">
          <NavButton label="Previous month" onClick={() => step(-1)}>
            ‹
          </NavButton>
          <span className="min-w-[8.5rem] text-center text-sm font-semibold tracking-tight">
            {monthLabel}
          </span>
          <NavButton label="Next month" disabled={isCurrentMonth} onClick={() => step(1)}>
            ›
          </NavButton>
        </div>
      }
    >
      <div className="grid grid-cols-7 gap-1.5">
        {WEEKDAYS.map((w, i) => (
          <div
            key={w}
            className={`pb-1 text-center text-[9px] font-medium uppercase tracking-[0.14em] ${
              i >= 5 ? 'text-zinc-300 dark:text-zinc-700' : 'text-zinc-500'
            }`}
          >
            {w}
          </div>
        ))}
        {Array.from({ length: leadingBlanks }, (_, i) => (
          <div key={`blank-${i}`} />
        ))}
        {days.map(({ day, agg }) => {
          const isToday = isCurrentMonth && day === today.d;
          const isFuture = isCurrentMonth && day > today.d;
          return (
            <div
              key={day}
              style={cellStyle(agg)}
              title={
                agg
                  ? `${monthShort} ${day}: ${inr(agg.pnl)} from ${agg.n} lot${agg.n === 1 ? '' : 's'}`
                  : isFuture
                    ? undefined
                    : `${monthShort} ${day}: nothing sold`
              }
              className={`group relative flex min-h-14 flex-col rounded-lg border px-1.5 py-1 transition ${
                agg
                  ? 'hover:brightness-110'
                  : isFuture
                    ? 'border-transparent'
                    : 'border-transparent bg-zinc-100/60 hover:bg-zinc-100 dark:bg-zinc-900/50 dark:hover:bg-zinc-900'
              } ${isToday ? 'ring-1 ring-blue-500/70' : ''}`}
            >
              <div className="flex items-start justify-between">
                <span
                  className={`font-mono text-[10px] leading-none tabular-nums ${
                    isToday
                      ? 'font-bold text-blue-600 dark:text-blue-400'
                      : isFuture
                        ? 'text-zinc-300 dark:text-zinc-700'
                        : agg
                          ? 'text-zinc-700 dark:text-zinc-300'
                          : 'text-zinc-400 dark:text-zinc-600'
                  }`}
                >
                  {day}
                </span>
                {agg && agg.n > 1 && (
                  <span className="rounded-sm bg-white/50 px-1 font-mono text-[8px] leading-[1.4] text-zinc-500 dark:bg-black/30">
                    {agg.n}×
                  </span>
                )}
              </div>
              {agg && (
                <span
                  className={`mt-auto self-end font-mono text-[11px] font-semibold leading-tight tabular-nums ${
                    agg.pnl > 0
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : agg.pnl < 0
                        ? 'text-rose-600 dark:text-rose-400'
                        : 'text-zinc-500'
                  }`}
                >
                  {inr(agg.pnl, 0)}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t border-zinc-200 pt-2.5 dark:border-zinc-800">
        <div className="flex items-baseline gap-2">
          <span className="text-[9px] font-medium uppercase tracking-[0.14em] text-zinc-500">
            {monthShort} total
          </span>
          <span
            className={`font-mono text-sm font-semibold tabular-nums ${
              monthPnl > 0
                ? 'text-emerald-600 dark:text-emerald-400'
                : monthPnl < 0
                  ? 'text-rose-600 dark:text-rose-400'
                  : ''
            }`}
          >
            {inr(monthPnl)}
          </span>
          <span className="text-[11px] text-zinc-500">
            {monthTrades} lot{monthTrades === 1 ? '' : 's'} sold
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-500">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-[3px] bg-emerald-500/80" />
            <span className="font-mono tabular-nums text-zinc-700 dark:text-zinc-300">{greenDays}</span>
            <span className="ml-1.5 inline-block h-2 w-2 rounded-[3px] bg-rose-500/80" />
            <span className="font-mono tabular-nums text-zinc-700 dark:text-zinc-300">{redDays}</span>
            <span className="ml-0.5">days</span>
          </span>
          {best?.agg && (
            <span>
              best{' '}
              <span className="font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
                {inr(best.agg.pnl)}
              </span>
              <span className="text-zinc-400">
                {' '}
                · {monthShort} {best.day}
              </span>
            </span>
          )}
          {worst?.agg && worst.agg.pnl < 0 && (
            <span>
              worst{' '}
              <span className="font-mono tabular-nums text-rose-600 dark:text-rose-400">
                {inr(worst.agg.pnl)}
              </span>
              <span className="text-zinc-400">
                {' '}
                · {monthShort} {worst.day}
              </span>
            </span>
          )}
        </div>
      </div>

      {traded.length === 0 && (
        <p className="mt-3 text-center text-xs text-zinc-500">
          Nothing sold in {monthLabel}.{' '}
          {lots.length > 0
            ? `Use the arrows to browse other months — ${lots.length} closed lot${lots.length === 1 ? '' : 's'} in history.`
            : 'A square appears on the day a lot is sold, and a lot is only sold above its fee-inclusive cost.'}
        </p>
      )}
      <p className="mt-2 text-[10px] text-zinc-400">
        Days are IST, bucketed by the day a lot was SOLD. A lot held for months books its whole
        profit on one square; the months of lock-up before it are not shown here.
      </p>
    </Card>
  );
}

function NavButton({
  children,
  label,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="h-7 w-7 rounded text-lg leading-none text-zinc-500 hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800"
    >
      {children}
    </button>
  );
}
