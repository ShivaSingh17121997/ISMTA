'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { Badge, Card, PageHeader } from '../components/ui';
import { shellApi } from '../lib/api';
import { inr } from '../lib/format';
import type { BufferSeedState, EquitySnapshot, ReconcileResult, StaticIpCheck, SystemReport } from '../lib/types';
import { formatDuration, istDateTime, useNow } from '../lib/useNow';
import { useSystem } from '../providers/SystemProvider';
import { useToast } from '../providers/ToastProvider';

const BTN =
  'rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900';
const BTN_DANGER =
  'rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50';
const INPUT =
  'w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100';

/** One in-flight action at a time, with its error. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}

/**
 * System status: everything that decides whether an order may go out right
 * now, and the buttons that exercise each check by hand.
 */
export default function SystemPage() {
  const { system, error, refresh } = useSystem();
  const now = useNow(1000);

  if (!system) {
    return (
      <div>
        <PageHeader title="System" subtitle="Halts, guards, feed, alerts, reconciliation" />
        <p className="text-sm text-zinc-500">{error ?? 'Loading…'}</p>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="System"
        subtitle={`${system.session.describe} · broker ${system.broker} · data ${system.dataSource}`}
        action={
          <button type="button" onClick={refresh} className={BTN}>
            Refresh
          </button>
        }
      />

      {system.jwtSecretIsDefault && (
        <div
          role="alert"
          className="mb-4 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <span className="font-semibold">JWT secret is the default.</span> Anyone with the source can forge a session
          token. Set <code className="font-mono">JWT_SECRET</code> to a long random string in{' '}
          <code className="font-mono">BE/.env</code> and restart the backend.{' '}
          <Link href="/settings" className="underline">
            Settings
          </Link>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        <HaltsCard system={system} refresh={refresh} />
        <OrderRateCard system={system} />
        <GuardsCard system={system} />
        <FeedCard system={system} now={now} />
        <AlertsCard system={system} refresh={refresh} />
        <ReconcileCard system={system} refresh={refresh} now={now} />
        <BuffersCard system={system} />
        <SnapshotCard />
      </div>
    </div>
  );
}

// ─── Halts ────────────────────────────────────────────────
function HaltsCard({ system, refresh }: { system: SystemReport; refresh: () => void }) {
  const { push } = useToast();
  const { busy, error, run } = useAction();
  const [reason, setReason] = useState('');
  const manual = system.halts.find((h) => h.key === 'manual');

  const engage = () => {
    const r = reason.trim();
    if (!r) return;
    if (
      !window.confirm(
        `Halt ALL trading now?\n\nEvery order is blocked — exits included — until the halt is released.\n\nReason: ${r}`,
      )
    )
      return;
    run(async () => {
      await shellApi.setHalt(true, r);
      setReason('');
      push('warn', `Trading halted by hand: ${r}`);
      refresh();
    });
  };

  const release = () => {
    if (!window.confirm('Release the manual halt? Orders resume immediately.')) return;
    run(async () => {
      await shellApi.setHalt(false);
      push('info', 'Manual halt released.');
      refresh();
    });
  };

  return (
    <Card
      title="Halts"
      action={system.halted ? <Badge tone="red">HALTED</Badge> : <Badge tone="green">trading allowed</Badge>}
    >
      {system.halts.length === 0 ? (
        <p className="text-sm text-zinc-500">No halts. Every order still passes the per-trade guards.</p>
      ) : (
        <ul className="space-y-2">
          {system.halts.map((h) => (
            <li key={h.key} className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm dark:border-rose-900 dark:bg-rose-950/30">
              <span className="font-mono text-xs font-semibold text-rose-700 uppercase dark:text-rose-300">{h.key}</span>
              <div className="text-rose-800 dark:text-rose-200">{h.reason}</div>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        {manual ? (
          <button type="button" onClick={release} disabled={busy} className={BTN}>
            {busy ? 'Working…' : 'Release manual halt'}
          </button>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (goes in the audit log)"
              className={INPUT}
              onKeyDown={(e) => {
                if (e.key === 'Enter') engage();
              }}
            />
            <button type="button" onClick={engage} disabled={busy || !reason.trim()} className={BTN_DANGER}>
              {busy ? 'Working…' : 'Halt trading'}
            </button>
          </div>
        )}
        {error && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
        <p className="mt-2 text-xs text-zinc-400">
          A process-wide halt blocks exits too. To stop only new entries for one book, use its kill switch.
        </p>
      </div>
    </Card>
  );
}

// ─── Order rate ───────────────────────────────────────────
function Meter({ label, value, limit }: { label: string; value: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (value / limit) * 100) : 0;
  const tone = pct >= 90 ? 'bg-rose-500' : pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-zinc-500">{label}</span>
        <span className="font-mono text-zinc-700 tabular-nums dark:text-zinc-200">
          {value} / {limit > 0 ? limit : '∞'}
        </span>
      </div>
      <div
        className="mt-1 h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={value}
        aria-label={label}
      >
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(pct, value > 0 ? 2 : 0)}%` }} />
      </div>
    </div>
  );
}

function OrderRateCard({ system }: { system: SystemReport }) {
  const r = system.orderRate;
  return (
    <Card title="Order rate">
      <div className="space-y-3">
        <Meter label="Last second" value={r.lastSecond} limit={r.limits.perSecond} />
        <Meter label="Last minute" value={r.lastMinute} limit={r.limits.perMinute} />
        <Meter label="Today" value={r.today} limit={r.limits.perDay} />
      </div>
      <p className="mt-3 text-xs text-zinc-400">
        Above {r.limits.perSecond}/s SEBI requires the algo to be registered; {r.limits.perMinute}/min and{' '}
        {r.limits.perDay}/day are the broker&apos;s limits.
      </p>
    </Card>
  );
}

// ─── Guards ───────────────────────────────────────────────
function GuardsCard({ system }: { system: SystemReport }) {
  const { busy, error, run } = useAction();
  const [ip, setIp] = useState<StaticIpCheck | null>(null);
  const g = system.guards;
  const applies = system.broker !== 'paper' && !!g.staticIp;

  const check = () =>
    run(async () => {
      setIp(await shellApi.checkIp());
    });

  return (
    <Card title="Guards">
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">Max quote age</dt>
          <dd className="font-mono tabular-nums">{Math.round(g.maxQuoteAgeMs / 1000)}s</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">Max fill deviation</dt>
          <dd className="font-mono tabular-nums">{g.maxFillDeviationPct}%</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">Static IP</dt>
          <dd className="text-right">
            {g.staticIp ? (
              <span className="font-mono">{g.staticIp}</span>
            ) : (
              <span className="text-zinc-400">not configured</span>
            )}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">Stale quotes</dt>
          <dd className="text-right">
            {g.staleSymbols.length === 0 ? (
              <Badge tone="green">none</Badge>
            ) : (
              <span className="font-mono text-xs text-amber-700 dark:text-amber-300">{g.staleSymbols.join(', ')}</span>
            )}
          </dd>
        </div>
      </dl>
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <button type="button" onClick={check} disabled={busy} className={BTN}>
          {busy ? 'Checking…' : 'Check IP now'}
        </button>
        {ip && (
          <span className="text-xs">
            {ip.ok ? <Badge tone="green">ok</Badge> : <Badge tone="red">mismatch</Badge>}{' '}
            <span className="font-mono text-zinc-600 dark:text-zinc-300">
              {ip.ip ?? (applies ? 'public IP unknown' : 'not checked')}
            </span>
            {ip.expected && <span className="text-zinc-400"> · expected {ip.expected}</span>}
          </span>
        )}
        {error && <span className="text-xs text-rose-600 dark:text-rose-400">{error}</span>}
      </div>
      {!applies && (
        <p className="mt-2 text-xs text-zinc-400">
          The static-IP check only halts with a live broker and BROKER_STATIC_IP set; here it always passes.
        </p>
      )}
    </Card>
  );
}

// ─── Feed ─────────────────────────────────────────────────
function FeedCard({ system, now }: { system: SystemReport; now: number }) {
  const f = system.feed;
  if (!f) {
    return (
      <Card title="Feed" action={<Badge tone="amber">{system.dataSource}</Badge>}>
        <p className="text-sm text-zinc-500">
          No external feed: DATA_SOURCE={system.dataSource}. Prices are generated, not the market&apos;s.
        </p>
      </Card>
    );
  }
  const age = f.lastPassAt && now ? now - f.lastPassAt : null;
  const ageTone =
    age === null
      ? 'text-zinc-400'
      : age > 180_000
        ? 'text-rose-600 dark:text-rose-400'
        : age > 60_000
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-emerald-600 dark:text-emerald-400';
  return (
    <Card
      title="Feed"
      action={f.running ? <Badge tone="green">running</Badge> : <Badge tone="red">stopped</Badge>}
    >
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">Source</dt>
          <dd>{system.dataSource}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">Last pass</dt>
          <dd className={`font-mono tabular-nums ${ageTone}`}>
            {age === null ? '—' : `${formatDuration(age)} ago`}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">Priced / tracked</dt>
          <dd className="font-mono tabular-nums">
            {f.priced} / {f.tracked}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">Market open (feed&apos;s view)</dt>
          <dd>{f.marketOpen ? 'yes' : 'no'}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">Unpriced</dt>
          <dd className="text-right">
            {f.unpriced.length === 0 ? (
              <Badge tone="green">none</Badge>
            ) : (
              <span className="font-mono text-xs text-amber-700 dark:text-amber-300">{f.unpriced.join(', ')}</span>
            )}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">Stale (&gt; {Math.round(system.guards.maxQuoteAgeMs / 1000)}s)</dt>
          <dd className="text-right">
            {system.guards.staleSymbols.length === 0 ? (
              <Badge tone="green">none</Badge>
            ) : (
              <span className="font-mono text-xs text-rose-700 dark:text-rose-300">
                {system.guards.staleSymbols.join(', ')}
              </span>
            )}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

// ─── Alerts ───────────────────────────────────────────────
function AlertsCard({ system, refresh }: { system: SystemReport; refresh: () => void }) {
  const { push } = useToast();
  const { busy, error, run } = useAction();
  const [last, setLast] = useState<string | null>(null);
  const n = system.notifier;

  const test = () =>
    run(async () => {
      const r = await shellApi.testAlert();
      setLast(r.sent ? 'Test alert sent.' : `Not sent${r.notifier.lastError ? `: ${r.notifier.lastError}` : ' — notifier not configured'}`);
      push(r.sent ? 'info' : 'warn', r.sent ? 'Test alert sent to the configured channel.' : 'Test alert was not sent.');
      refresh();
    });

  return (
    <Card
      title="Alerts"
      action={n.configured ? <Badge tone="green">configured</Badge> : <Badge tone="neutral">not configured</Badge>}
    >
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">Sent</dt>
          <dd className="font-mono tabular-nums">{n.sent}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">Failures</dt>
          <dd className={`font-mono tabular-nums ${n.failures > 0 ? 'text-rose-600 dark:text-rose-400' : ''}`}>
            {n.failures}
          </dd>
        </div>
        {n.lastError && (
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-500">Last error</dt>
            <dd className="text-right text-xs text-rose-600 dark:text-rose-400">{n.lastError}</dd>
          </div>
        )}
      </dl>
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <button type="button" onClick={test} disabled={busy} className={BTN}>
          {busy ? 'Sending…' : 'Send test alert'}
        </button>
        {last && <span className="text-xs text-zinc-500">{last}</span>}
        {error && <span className="text-xs text-rose-600 dark:text-rose-400">{error}</span>}
      </div>
      {!n.configured && (
        <p className="mt-2 text-xs text-zinc-400">
          Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in BE/.env to receive halts and mismatches on your phone.
        </p>
      )}
    </Card>
  );
}

// ─── Reconciliation ───────────────────────────────────────
function ReconcileTable({ r }: { r: ReconcileResult }) {
  if (!r.supported) {
    return <p className="text-sm text-zinc-500">Not applicable: the {'paper'} broker has no ledger to compare against.</p>;
  }
  if (r.rows.length === 0) return <p className="text-sm text-zinc-500">No books to reconcile.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-zinc-500 uppercase">
          <tr>
            <th className="py-1 pr-3">Symbol</th>
            <th className="py-1 pr-3 text-right">Book</th>
            <th className="py-1 pr-3 text-right">Broker</th>
            <th className="py-1 text-right">Diff</th>
          </tr>
        </thead>
        <tbody>
          {r.rows.map((row) => (
            <tr key={row.symbol} className={row.difference !== 0 ? 'text-rose-700 dark:text-rose-300' : ''}>
              <td className="py-1 pr-3 font-medium">{row.symbol}</td>
              <td className="py-1 pr-3 text-right font-mono tabular-nums">{row.expected}</td>
              <td className="py-1 pr-3 text-right font-mono tabular-nums">{row.actual}</td>
              <td className="py-1 text-right font-mono tabular-nums">
                {row.difference > 0 ? '+' : ''}
                {row.difference}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReconcileCard({ system, refresh, now }: { system: SystemReport; refresh: () => void; now: number }) {
  const { push } = useToast();
  const { busy, error, run } = useAction();
  const [result, setResult] = useState<ReconcileResult | null>(null);
  const rc = system.reconcile;
  const shown = result ?? rc.last;

  const runNow = () =>
    run(async () => {
      const r = await shellApi.reconcile();
      setResult(r);
      if (r.mismatched.length) push('critical', `Reconciliation found ${r.mismatched.length} mismatch(es). Affected books are halted.`);
      else if (r.supported) push('info', 'Reconciliation clean: broker holdings match the books.');
      refresh();
    });

  return (
    <Card
      title="Reconciliation"
      action={
        rc.enabled ? <Badge tone="green">every {rc.everyMin} min</Badge> : <Badge tone="neutral">scheduled: off</Badge>
      }
    >
      {shown ? (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <span>
              Last run {istDateTime(shown.at)}
              {now ? ` (${formatDuration(now - shown.at)} ago)` : ''} · {shown.reason}
            </span>
            {shown.supported && (
              shown.mismatched.length ? (
                <Badge tone="red">{shown.mismatched.length} mismatched</Badge>
              ) : (
                <Badge tone="green">clean</Badge>
              )
            )}
            {shown.error && <span className="text-rose-600 dark:text-rose-400">{shown.error}</span>}
          </div>
          <ReconcileTable r={shown} />
        </>
      ) : (
        <p className="text-sm text-zinc-500">No reconciliation has run yet.</p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <button type="button" onClick={runNow} disabled={busy} className={BTN}>
          {busy ? 'Running…' : 'Run now'}
        </button>
        {error && <span className="text-xs text-rose-600 dark:text-rose-400">{error}</span>}
      </div>
    </Card>
  );
}

// ─── Strategy buffers ─────────────────────────────────────
const SEED_TONE: Record<BufferSeedState, 'green' | 'amber' | 'red' | 'neutral'> = {
  real: 'green',
  seeding: 'amber',
  synthetic: 'amber',
  failed: 'red',
  none: 'neutral',
};

function BuffersCard({ system }: { system: SystemReport }) {
  const rows = system.strategyBuffers;
  return (
    <Card title="Strategy buffers" action={<span className="text-xs text-zinc-400">{rows.length} symbols</span>}>
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500">No strategy is subscribed to any symbol.</p>
      ) : (
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-zinc-500 uppercase">
              <tr>
                <th className="py-1 pr-3">Symbol</th>
                <th className="py-1 pr-3">Seed</th>
                <th className="py-1 text-right">Bars</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.symbol} className="border-t border-zinc-100 dark:border-zinc-900">
                  <td className="py-1.5 pr-3 font-medium">{b.symbol}</td>
                  <td className="py-1.5 pr-3">
                    <Badge tone={SEED_TONE[b.seed] ?? 'neutral'}>{b.seed}</Badge>
                  </td>
                  <td className="py-1.5 text-right font-mono tabular-nums">{b.bars}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-zinc-400">
        <span className="text-emerald-600 dark:text-emerald-400">real</span> = seeded from market history;{' '}
        <span className="text-amber-600 dark:text-amber-400">seeding</span> = still loading;{' '}
        <span className="text-rose-600 dark:text-rose-400">failed</span> = signals on that symbol are not trustworthy.
      </p>
    </Card>
  );
}

// ─── Snapshot ─────────────────────────────────────────────
function SnapshotCard() {
  const { push } = useToast();
  const { busy, error, run } = useAction();
  const [snaps, setSnaps] = useState<EquitySnapshot[] | null>(null);

  const take = () =>
    run(async () => {
      const r = await shellApi.snapshot();
      setSnaps(r.snapshots);
      push('info', `Equity snapshot taken for ${r.snapshots.length} account(s).`);
    });

  return (
    <Card title="Equity snapshot">
      <p className="text-sm text-zinc-500">
        One row per day of equity, cash and deployed capital — the series the analytics page charts. Taken
        automatically after the close; take one by hand after a manual change.
      </p>
      {snaps && (
        <ul className="mt-3 space-y-1 text-sm">
          {snaps.map((s) => (
            <li key={s.userId} className="flex flex-wrap justify-between gap-x-4 rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-900">
              <span className="text-zinc-500">{s.day}</span>
              <span className="font-mono tabular-nums">
                equity {inr(s.equity, 0)} · cash {inr(s.cash, 0)} · deployed {inr(s.deployed, 0)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <button type="button" onClick={take} disabled={busy} className={BTN}>
          {busy ? 'Taking…' : 'Take now'}
        </button>
        {error && <span className="text-xs text-rose-600 dark:text-rose-400">{error}</span>}
      </div>
    </Card>
  );
}
