'use client';

import { useState } from 'react';
import { api } from '../lib/api';
import { dateTime, inr } from '../lib/format';
import { usePolling } from '../lib/usePolling';
import type { SweepEvent } from '../lib/types';
import { Card, ToggleSwitch } from './ui';

/**
 * The idle-cash sweep: the books' spare settled cash, parked in a liquid ETF
 * while it waits for a dip, and sold back the moment a rung needs it.
 *
 * The panel answers three questions in order: is it on, how much is parked and
 * what has it earned, and is any of it locked (the T1 rule) right now. Locked
 * matters because a dip that arrives while units are locked is funded only
 * from the buffer.
 */
export function SweepPanel() {
  const sweep = usePolling(() => api.sweep(), 30_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = sweep.data;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await sweep.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const parkable = s ? Math.max(0, s.cashOnHand - s.buffer) : 0;
  const yieldPct = s?.yieldPct ?? null;
  const lastEvent = s?.events.find((e) => e.kind !== 'SKIP');
  const status = s?.events[0];

  return (
    <Card
      title="Idle cash sweep"
      action={
        s && (
          <div className="flex items-center gap-3">
            {s.venue && (
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] ${
                  s.venue === 'paper'
                    ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                    : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                }`}
              >
                {s.venue === 'paper' ? 'simulated' : 'live'}
              </span>
            )}
            <ToggleSwitch
              on={s.enabled}
              busy={busy}
              label={s.enabled ? 'On' : 'Off'}
              title={
                s.enabled
                  ? 'Switch off: parked units are sold back as the T1 rule allows'
                  : `Park spare cash in ${s.symbol} after ${s.params.parkFrom} IST each trading day`
              }
              onToggle={() => act(() => api.setSweep(!s.enabled))}
            />
          </div>
        )
      }
    >
      {!s ? (
        <p className="text-sm text-zinc-500">{sweep.loading ? 'Reading the sweep…' : 'Sweep unavailable.'}</p>
      ) : (
        <>
          {s.haltedReason && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">
              <span>Halted: {s.haltedReason}</span>
              <button
                onClick={() => act(() => api.releaseSweepHalt())}
                disabled={busy}
                className="rounded border border-rose-300 px-2 py-0.5 text-[11px] hover:bg-rose-100 disabled:opacity-50 dark:border-rose-800 dark:hover:bg-rose-950"
              >
                I have checked the broker — clear
              </button>
            </div>
          )}

          {!s.enabled && s.units === 0 ? (
            <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
              <strong className="text-zinc-900 dark:text-zinc-100">{inr(s.idleCash, 0)}</strong>{' '}of the books&apos; cash is
              waiting for dips and earning nothing. Switched on, everything above a{' '}
              {inr(s.buffer, 0)} buffer (what every active book could spend in one session) is parked in{' '}
              {s.symbol}
              {yieldPct != null && <> — currently about {yieldPct.toFixed(1)}% a year</>} — after {s.params.parkFrom} IST,
              and sold back automatically when a rung needs it.
              {yieldPct != null && parkable >= s.params.minParkRs && (
                <>
                  {' '}At today&apos;s figures that is roughly{' '}
                  <strong className="text-emerald-700 dark:text-emerald-400">
                    {inr((parkable * yieldPct) / 100, 0)} a year
                  </strong>{' '}
                  before tax.
                </>
              )}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-4">
              <Figure
                label={`Parked in ${s.symbol}`}
                value={inr(s.parkedValue, 0)}
                note={`${s.units.toLocaleString('en-IN')} units @ ${inr(s.price, 2)}`}
                strong
              />
              <Figure
                label="Earned so far"
                value={inr(s.gain, 0)}
                note={yieldPct != null ? `ETF running at ~${yieldPct.toFixed(1)}%/yr, after charges` : 'after charges'}
                tone={s.gain}
              />
              <Figure
                label="Cash in the account"
                value={inr(s.cashOnHand, 0)}
                note={`buffer ${inr(s.buffer, 0)} — one session of rungs`}
              />
              <Figure
                label="Locked (T1)"
                value={`${s.lockedUnits.toLocaleString('en-IN')} units`}
                note={
                  s.lockedUnits > 0 && s.nextUnlockDate
                    ? `usable from ${s.nextUnlockDate}`
                    : 'all units can fund a rung'
                }
              />
            </div>
          )}

          {error && <p className="mt-3 text-xs text-rose-600 dark:text-rose-400">{error}</p>}

          <div className="mt-3 space-y-1 text-[11px] text-zinc-500">
            {lastEvent && <EventLine e={lastEvent} />}
            {status && status !== lastEvent && status.kind === 'SKIP' && (
              <p>
                <span className="text-zinc-400">Now:</span> {status.detail}
              </p>
            )}
            <p className="text-zinc-400">
              Parks once a day ({s.params.parkFrom}–{s.params.parkUntil} IST, after the last rung can fire), never less than{' '}
              {inr(s.params.minParkRs, 0)} — each sale pays a flat DP charge. Units bought today fund a rung only from
              the second trading day. Gains are taxed at your slab rate.
            </p>
          </div>
        </>
      )}
    </Card>
  );
}

function EventLine({ e }: { e: SweepEvent }) {
  const tone =
    e.kind === 'PARK' || e.kind === 'REDEEM'
      ? 'text-sky-700 dark:text-sky-400'
      : e.kind === 'HALT' || e.kind === 'REJECT'
        ? 'text-rose-600 dark:text-rose-400'
        : 'text-zinc-500';
  return (
    <p>
      <span className="tabular-nums text-zinc-400">{dateTime(e.at)}</span>{' '}
      <span className={`font-medium ${tone}`}>{e.kind}</span> {e.detail}
    </p>
  );
}

function Figure({ label, value, note, strong, tone }: { label: string; value: string; note?: string; strong?: boolean; tone?: number }) {
  const color =
    tone == null || tone === 0
      ? ''
      : tone > 0
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-rose-600 dark:text-rose-400';
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`tabular-nums ${strong ? 'text-lg font-semibold' : 'text-base'} ${color}`}>{value}</div>
      {note && <div className="text-[10px] text-zinc-400">{note}</div>}
    </div>
  );
}
