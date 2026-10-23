'use client';

import { useState } from 'react';
import { api } from '../lib/api';
import { inr } from '../lib/format';
import { useNow } from '../lib/useNow';
import { usePolling } from '../lib/usePolling';
import { Card } from './ui';

/**
 * What the broker says the account holds.
 *
 * There is no "add money" button here and there cannot be one: funds move into
 * a broking account only through the broker's own app, by UPI or netbanking.
 * This panel exists to SHOW the balance the phone changed — the API and the
 * app are two windows onto one ledger, so money added on a phone appears here
 * on the next poll with nothing to synchronise.
 *
 * The panel's real job is to make a STALE number impossible to mistake for a
 * live one. A balance that quietly stopped updating is worse than no balance at
 * all, because every position size is derived from it.
 */
export function FundsPanel() {
  const funds = usePolling(() => api.funds(), 30_000);
  // Reading the clock during render is impure and this project's lint forbids
  // it. A 10s tick is enough to make a stale balance obvious.
  const now = useNow(10_000);
  const [busy, setBusy] = useState(false);
  const f = funds.data?.funds;

  const refresh = async () => {
    setBusy(true);
    try {
      await api.refreshFunds();
      await funds.refresh();
    } finally {
      setBusy(false);
    }
  };

  // `useNow` returns 0 until its first tick — treat that as "not measured yet"
  // rather than as 1970, which would report the balance as decades stale.
  const ageSec = f && now ? Math.max(0, Math.round((now - f.at) / 1000)) : 0;
  const stale = ageSec > 120;

  return (
    <Card
      title="Funds"
      action={
        <div className="flex items-center gap-2">
          {f && (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] ${
                f.simulated
                  ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                  : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
              }`}
              title={
                f.simulated
                  ? 'Not a real balance — this is RISK_CAPITAL from your config, because you are in paper mode or the broker could not be reached.'
                  : `Read from ${f.brokerName}`
              }
            >
              {f.simulated ? 'simulated' : f.brokerName}
            </span>
          )}
          <button
            onClick={refresh}
            disabled={busy}
            className="rounded-md border border-zinc-300 px-2 py-1 text-[11px] text-zinc-500 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            {busy ? 'Reading…' : 'Refresh'}
          </button>
        </div>
      }
    >
      {!f ? (
        <p className="text-sm text-zinc-500">{funds.loading ? 'Reading the broker…' : 'Funds unavailable.'}</p>
      ) : (
        <>
          {/* Two columns, not four. The dashboard now renders this in a
              half-width cell, and four currency figures across ~350px wrap
              mid-number — which on a balance is worse than taking two rows. */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Figure label="Cash at broker" value={inr(f.cash, 0)} strong />
            <Figure label="Deployable now" value={inr(f.deployable, 0)} note="after holds and charges" />
            <Figure label="Held for open orders" value={inr(f.reserved, 0)} note="released when they resolve" />
            <Figure label="Unsettled (T+1)" value={inr(f.unsettled, 0)} note="can buy, cannot withdraw" />
          </div>

          {f.simulated && (
            <p className="mt-3 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
              This is your configured <code>RISK_CAPITAL</code>, not a real balance
              {f.error ? ` — the broker could not be reached: ${f.error}` : ' (paper mode)'}.
            </p>
          )}

          <p className={`mt-2 text-[11px] ${stale ? 'font-medium text-rose-600 dark:text-rose-400' : 'text-zinc-400'}`}>
            {stale
              ? `Last read ${ageSec}s ago — this figure may be out of date.`
              : now
                ? `Read ${ageSec}s ago. Money added in your broker's app appears here on the next read.`
                : "Money added in your broker's app appears here on the next read."}
          </p>
        </>
      )}
    </Card>
  );
}

function Figure({ label, value, note, strong }: { label: string; value: string; note?: string; strong?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`tabular-nums ${strong ? 'text-lg font-semibold' : 'text-base'}`}>{value}</div>
      {note && <div className="text-[10px] text-zinc-400">{note}</div>}
    </div>
  );
}
