'use client';

import { useEffect, useState } from 'react';
import { Badge, Card, PageHeader } from '../components/ui';
import { shellApi } from '../lib/api';
import type { AuditEntry } from '../lib/types';
import { istClock, istDayLabel, istMidnight, istTime, useNow } from '../lib/useNow';
import { useToast } from '../providers/ToastProvider';

const KINDS = ['order', 'risk', 'fill', 'reject', 'guard', 'engine', 'auth', 'reconcile', 'system', 'journal'];

type SinceKey = '1h' | 'today' | '7d' | 'all';
const SINCE: { key: SinceKey; label: string }[] = [
  { key: '1h', label: 'Last hour' },
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: 'all', label: 'All' },
];
const LIMIT_STEP = 500;
const LIMIT_MAX = 2000;

function sinceFor(key: SinceKey, now: number): number | undefined {
  switch (key) {
    case '1h':
      return now - 3_600_000;
    case 'today':
      return istMidnight(now);
    case '7d':
      return now - 7 * 86_400_000;
    default:
      return undefined;
  }
}

type Tone = 'neutral' | 'green' | 'red' | 'blue' | 'amber';
const KIND_TONE: Record<string, Tone> = {
  reject: 'red',
  guard: 'red',
  risk: 'amber',
  reconcile: 'amber',
  system: 'amber',
  fill: 'green',
  order: 'blue',
  engine: 'blue',
  auth: 'neutral',
};

const INPUT =
  'rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100';
const BTN =
  'rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900';

/**
 * The audit trail, newest first. Filters by kind, symbol and window; "Load
 * more" widens the window (1h → today → 7d → all) and then raises the limit
 * to the server's cap of 2000.
 */
export default function AuditPage() {
  const [kind, setKind] = useState('');
  const [symbol, setSymbol] = useState('');
  const [symbolQ, setSymbolQ] = useState('');
  const [since, setSince] = useState<SinceKey>('today');
  const [limit, setLimit] = useState(LIMIT_STEP);
  const [result, setResult] = useState<{ key: string; entries: AuditEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const { push } = useToast();
  const now = useNow(60_000);

  // Debounce the symbol box so every keystroke is not a request.
  useEffect(() => {
    const id = setTimeout(() => setSymbolQ(symbol.trim().toUpperCase()), 300);
    return () => clearTimeout(id);
  }, [symbol]);

  const key = `${kind}|${symbolQ}|${since}|${limit}`;
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { entries } = await shellApi.audit({
          kind: kind || undefined,
          symbol: symbolQ || undefined,
          since: sinceFor(since, Date.now()),
          limit,
        });
        if (alive) {
          setResult({ key, entries });
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Could not load the audit log');
      }
    })();
    return () => {
      alive = false;
    };
  }, [key, kind, symbolQ, since, limit]);

  const loading = result?.key !== key;
  const entries = result?.entries ?? [];
  const canLoadMore = since !== 'all' || (entries.length >= limit && limit < LIMIT_MAX);

  const loadMore = () => {
    if (since !== 'all') {
      const i = SINCE.findIndex((s) => s.key === since);
      setSince(SINCE[Math.min(i + 1, SINCE.length - 1)].key);
    } else {
      setLimit((l) => Math.min(LIMIT_MAX, l + LIMIT_STEP));
    }
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const at = Date.now();
      const blob = await shellApi.auditCsv({ since: sinceFor(since, at), limit: LIMIT_MAX });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-${istClock(at).date}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      push('warn', `Export failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      setExporting(false);
    }
  };

  const today = now ? istClock(now).date : '';

  return (
    <div>
      <PageHeader
        title="Audit log"
        subtitle="Every order, refusal, guard, halt and login — newest first"
        action={
          <button type="button" onClick={exportCsv} disabled={exporting} className={BTN}>
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        }
      />

      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
            Kind
            <select value={kind} onChange={(e) => setKind(e.target.value)} className={`${INPUT} mt-1 block`}>
              <option value="">All kinds</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
            Symbol
            <input
              type="text"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="e.g. SYRMA"
              className={`${INPUT} mt-1 block w-36 font-mono uppercase`}
            />
          </label>
          <div className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
            Since
            <div role="radiogroup" className="mt-1 flex overflow-hidden rounded-lg border border-zinc-300 dark:border-zinc-700">
              {SINCE.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  role="radio"
                  aria-checked={since === s.key}
                  onClick={() => {
                    setSince(s.key);
                    setLimit(LIMIT_STEP);
                  }}
                  className={`px-3 py-1.5 text-xs ${
                    since === s.key
                      ? 'bg-blue-600 text-white'
                      : 'bg-white text-zinc-600 hover:bg-zinc-100 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <span className="ml-auto text-xs text-zinc-400">
            {loading ? 'Loading…' : `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`}
          </span>
        </div>
      </Card>

      {error && (
        <p role="alert" className="mb-4 text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}

      <Card className="p-0 sm:p-0">
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs text-zinc-500 uppercase">
              <tr className="border-b border-zinc-200 dark:border-zinc-800">
                <th className="px-4 py-2">Time (IST)</th>
                <th className="px-2 py-2">Kind</th>
                <th className="px-2 py-2">Symbol</th>
                <th className="px-2 py-2">Detail</th>
                <th className="px-4 py-2 text-right">Data</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-zinc-400">
                    {loading ? 'Loading…' : 'Nothing in this window. Widen it with "Load more".'}
                  </td>
                </tr>
              )}
              {entries.map((e) => {
                const expanded = open === e.id;
                const hasData = !!e.data && Object.keys(e.data).length > 0;
                const sameDay = istClock(e.at).date === today;
                return (
                  <AuditRow
                    key={e.id}
                    entry={e}
                    expanded={expanded}
                    hasData={hasData}
                    sameDay={sameDay}
                    onToggle={() => setOpen(expanded ? null : e.id)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
        {canLoadMore && (
          <div className="border-t border-zinc-200 px-4 py-3 text-center dark:border-zinc-800">
            <button type="button" onClick={loadMore} disabled={loading} className={BTN}>
              {since !== 'all'
                ? `Load more (widen to ${SINCE[SINCE.findIndex((s) => s.key === since) + 1].label.toLowerCase()})`
                : `Load more (up to ${Math.min(LIMIT_MAX, limit + LIMIT_STEP)})`}
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}

function AuditRow({
  entry: e,
  expanded,
  hasData,
  sameDay,
  onToggle,
}: {
  entry: AuditEntry;
  expanded: boolean;
  hasData: boolean;
  sameDay: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className={`border-b border-zinc-100 align-top dark:border-zinc-900 ${hasData ? 'cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900/60' : ''}`}
        onClick={hasData ? onToggle : undefined}
      >
        <td className="px-4 py-2 font-mono text-xs whitespace-nowrap text-zinc-600 tabular-nums dark:text-zinc-300">
          {istTime(e.at)}
          {!sameDay && <span className="block text-[10px] text-zinc-400">{istDayLabel(e.at)}</span>}
        </td>
        <td className="px-2 py-2">
          <Badge tone={KIND_TONE[e.kind] ?? 'neutral'}>{e.kind}</Badge>
        </td>
        <td className="px-2 py-2 font-mono text-xs whitespace-nowrap">{e.symbol ?? ''}</td>
        <td className="px-2 py-2 text-zinc-800 dark:text-zinc-100">{e.detail}</td>
        <td className="px-4 py-2 text-right">
          {hasData && (
            <button
              type="button"
              onClick={(ev) => {
                ev.stopPropagation();
                onToggle();
              }}
              aria-expanded={expanded}
              className="text-xs text-blue-600 hover:underline dark:text-blue-400"
            >
              {expanded ? 'hide' : 'json'}
            </button>
          )}
        </td>
      </tr>
      {expanded && hasData && (
        <tr className="border-b border-zinc-100 dark:border-zinc-900">
          <td colSpan={5} className="px-4 py-2">
            <pre className="scroll-thin max-h-72 overflow-auto rounded-lg bg-zinc-50 p-3 font-mono text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
              {JSON.stringify(e.data, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
