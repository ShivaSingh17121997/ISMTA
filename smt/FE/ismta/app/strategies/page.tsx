'use client';

import Link from 'next/link';
import { useState } from 'react';
import { InstrumentMultiSelect } from '../components/InstrumentSearch';
import { Badge, Card, PageHeader } from '../components/ui';
import { api, tradingApi } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type { StrategyBufferStatus, StrategyType } from '../lib/types';

/** What the engine's candle buffer for a symbol is doing, in the words the card shows. */
function bufferLabel(b: StrategyBufferStatus | undefined): { text: string; tone: 'neutral' | 'green' | 'red' | 'amber' } {
  if (!b || b.seed === 'none') return { text: 'no buffer', tone: 'neutral' };
  if (b.seed === 'seeding') return { text: 'seeding', tone: 'amber' };
  if (b.seed === 'real') return { text: `real ${b.bars} bars`, tone: 'green' };
  if (b.seed === 'synthetic') return { text: `synthetic ${b.bars} bars`, tone: 'amber' };
  return { text: 'failed: not evaluating', tone: 'red' };
}

export default function StrategiesPage() {
  const strategies = usePolling(() => api.strategies(), 5000);
  const types = usePolling(() => api.strategyTypes(), 60000);
  const system = usePolling(() => tradingApi.system(), 5000);
  const [busy, setBusy] = useState<string | null>(null);

  const buffers = new Map((system.data?.strategyBuffers ?? []).map((b) => [b.symbol, b]));

  const toggle = async (id: string) => {
    setBusy(id);
    try {
      await api.toggleStrategy(id);
      strategies.refresh();
    } finally {
      setBusy(null);
    }
  };
  const remove = async (id: string) => {
    if (!confirm('Delete this strategy?')) return;
    setBusy(id);
    try {
      await api.deleteStrategy(id);
      strategies.refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <PageHeader title="Strategies" subtitle="Create, configure and toggle automated strategies" />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card title={`Your strategies (${strategies.data?.strategies.length ?? 0})`}>
            <div className="space-y-3">
              {strategies.data?.strategies.length === 0 && (
                <p className="py-6 text-center text-sm text-zinc-400">No strategies yet — create one →</p>
              )}
              {strategies.data?.strategies.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/strategies/${s.id}`} className="font-medium hover:underline">
                        {s.name}
                      </Link>
                      <Badge tone="blue">{s.type.replace('_', ' ')}</Badge>
                      <Badge tone={s.enabled ? 'green' : 'neutral'}>{s.enabled ? 'LIVE' : 'OFF'}</Badge>
                      {s.exitMode && <span className="text-[10px] uppercase text-zinc-400">{s.exitMode}</span>}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                      {s.symbols.map((sym) => {
                        const b = bufferLabel(buffers.get(sym));
                        return (
                          <span key={sym} className="inline-flex items-center gap-1 rounded-full border border-zinc-200 py-0.5 pl-2 pr-1 dark:border-zinc-800">
                            <span className="font-medium text-zinc-700 dark:text-zinc-200">{sym}</span>
                            <Badge tone={b.tone}>{system.data ? b.text : '…'}</Badge>
                          </span>
                        );
                      })}
                      <span>· qty {s.quantity}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      onClick={() => toggle(s.id)}
                      disabled={busy === s.id}
                      className={`rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 ${
                        s.enabled ? 'bg-amber-600 hover:bg-amber-700' : 'bg-emerald-600 hover:bg-emerald-700'
                      }`}
                    >
                      {s.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      onClick={() => remove(s.id)}
                      disabled={busy === s.id}
                      className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11px] text-zinc-400">
              Buffer state is from /api/system: <em>seeding</em> = history still loading, <em>real N bars</em> = evaluating on
              real candles, <em>synthetic</em> = invented bars (sim only), <em>failed</em> = no history, so the strategy is not
              evaluating that symbol.
            </p>
          </Card>
        </div>

        <CreateStrategyForm types={types.data?.types ?? []} onCreated={strategies.refresh} />
      </div>
    </div>
  );
}

function CreateStrategyForm({ types, onCreated }: { types: StrategyType[]; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('MA_CROSSOVER');
  const [selected, setSelected] = useState<string[]>(['RELIANCE']);
  const [quantity, setQuantity] = useState(10);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setSaving(true);
    try {
      await api.createStrategy({ name: name || undefined, type: type as never, symbols: selected, quantity });
      setName('');
      setSelected(['RELIANCE']);
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Create strategy">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="mb-1 block text-xs text-zinc-500">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My strategy"
            className="w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-zinc-500">Type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
          >
            {types.map((t) => (
              <option key={t.type} value={t.type}>
                {t.type.replace('_', ' ')}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-zinc-500">Symbols (any NSE-listed company)</label>
          <InstrumentMultiSelect value={selected} onChange={setSelected} placeholder="Search symbol or company…" />
        </div>
        <div>
          <label className="mb-1 block text-xs text-zinc-500">Quantity</label>
          <input
            type="number"
            min={1}
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
            className="w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
          />
        </div>
        {err && <p className="text-xs text-rose-500">{err}</p>}
        <button
          type="submit"
          disabled={saving || selected.length === 0}
          className="w-full rounded-md bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? 'Creating…' : 'Create strategy'}
        </button>
      </form>
    </Card>
  );
}
