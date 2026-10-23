'use client';

import { useState } from 'react';
import { tradingApi } from '../lib/api';
import { dateTime, num } from '../lib/format';
import type { OrderKind, Position, ProductType, Trigger, TriggerCreateRequest, TriggerLeg } from '../lib/types';
import type { PriceLine } from './CandleChart';
import { roundToTick, tickSize } from './OrderTicket';
import { Badge, Card } from './ui';

/**
 * Standing triggers — GTT, OCO and trailing stops — for the selected symbol.
 *
 * The list comes from the page (it polls `/api/triggers` once and shares the
 * result with the chart); this panel renders it and owns the create form. The
 * form is keyed on the symbol upstairs, so switching symbols resets it to that
 * symbol's defaults: SELL legs sized to the open position, if there is one.
 */

const LEG_COLOR: Record<TriggerLeg['role'], string> = {
  target: '#10b981',
  stop: '#f43f5e',
  single: '#f59e0b',
};

/** Chart lines for every ACTIVE trigger on `symbol`; gone the moment the trigger ends. */
export function triggerPriceLines(triggers: Trigger[], symbol: string): PriceLine[] {
  const lines: PriceLine[] = [];
  for (const t of triggers) {
    if (t.status !== 'ACTIVE' || t.symbol !== symbol) continue;
    for (const l of t.legs) {
      lines.push({
        price: l.triggerPrice,
        color: LEG_COLOR[l.role],
        title: `GTT ${l.role} ${l.side} ${l.quantity}${t.trailPct && (l.role === 'stop' || l.role === 'single') ? ` trail ${t.trailPct}%` : ''}`,
        style: l.role === 'target' ? 'dashed' : 'solid',
      });
    }
  }
  return lines;
}

const STATUS_TONE: Record<Trigger['status'], 'green' | 'red' | 'blue' | 'amber' | 'neutral'> = {
  ACTIVE: 'green',
  TRIGGERED: 'blue',
  CANCELLED: 'neutral',
  EXPIRED: 'amber',
  FAILED: 'red',
};

const inputCls =
  'w-full rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-xs tabular-nums dark:border-zinc-700';

function legText(l: TriggerLeg): string {
  return `${l.side} ${l.quantity} @ ${num(l.triggerPrice)} ${l.orderType === 'LIMIT' ? `(LIMIT ${num(l.price ?? 0)})` : '(MKT)'}`;
}

export function TriggersPanel({
  symbol,
  ltp,
  position,
  triggers,
  loading,
  onChanged,
}: {
  symbol: string;
  ltp: number;
  position?: Position | null;
  triggers: Trigger[];
  loading: boolean;
  onChanged: () => void;
}) {
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const active = triggers.filter((t) => t.status === 'ACTIVE').sort((a, b) => (a.symbol === symbol ? -1 : 0) - (b.symbol === symbol ? -1 : 0) || b.createdAt - a.createdAt);
  const history = triggers.filter((t) => t.status !== 'ACTIVE').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30);

  const cancel = async (t: Trigger) => {
    if (!confirm(`Cancel this ${t.kind.toUpperCase()} trigger on ${t.symbol}?\n${t.legs.map((l) => `${l.role} ${legText(l)}`).join('\n')}`)) return;
    setCancelling(t.id);
    setError(null);
    try {
      await tradingApi.cancelTrigger(t.id);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'cancel failed');
    } finally {
      setCancelling(null);
    }
  };

  return (
    <Card title="Triggers (GTT / OCO / trailing)" action={<span className="text-[11px] text-zinc-400">{active.length} active</span>}>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Keyed on the position too: the portfolio arrives after first paint, and the
            defaults (side, quantity) are read once at mount. */}
        <TriggerForm key={`${symbol}|${position?.quantity ?? 0}`} symbol={symbol} ltp={ltp} position={position} onCreated={onChanged} />

        <div className="lg:col-span-2">
          {error && <p className="mb-2 text-xs text-rose-500">{error}</p>}
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Active</h4>
          {loading && triggers.length === 0 && <p className="py-3 text-xs text-zinc-400">Loading…</p>}
          {!loading && active.length === 0 && <p className="py-3 text-xs text-zinc-400">No active triggers.</p>}
          <ul className="space-y-2">
            {active.map((t) => (
              <li
                key={t.id}
                className={`rounded-md border px-3 py-2 text-xs ${
                  t.symbol === symbol ? 'border-blue-300 dark:border-blue-900' : 'border-zinc-200 dark:border-zinc-800'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{t.symbol}</span>
                  <Badge tone="blue">{t.kind.toUpperCase()}</Badge>
                  <Badge tone="neutral">{t.product}</Badge>
                  {t.trailPct ? <Badge tone="amber">trail {t.trailPct}%</Badge> : null}
                  {t.autoCancelWhenFlat && <span className="text-[10px] text-zinc-400">auto-cancel when flat</span>}
                  <span className="ml-auto text-[10px] text-zinc-400">expires {dateTime(t.expiresAt)}</span>
                  <button
                    type="button"
                    onClick={() => cancel(t)}
                    disabled={cancelling === t.id}
                    className="rounded border border-rose-300 px-2 py-0.5 text-[11px] text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-900 dark:hover:bg-rose-950/40"
                  >
                    {cancelling === t.id ? 'Cancelling…' : 'Cancel'}
                  </button>
                </div>
                <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 tabular-nums">
                  {t.legs.map((l) => (
                    <li key={l.role} className="flex items-center gap-1">
                      <span className="inline-block h-2 w-2 rounded-full" style={{ background: LEG_COLOR[l.role] }} />
                      <span className="capitalize text-zinc-500">{l.role}</span> {legText(l)}
                      <span className="text-zinc-400">fires {l.fireWhen}</span>
                    </li>
                  ))}
                </ul>
                {t.note && <p className="mt-1 text-zinc-500">{t.note}</p>}
              </li>
            ))}
          </ul>

          <h4 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-zinc-500">History</h4>
          {history.length === 0 ? (
            <p className="py-2 text-xs text-zinc-400">Nothing has fired, expired or been cancelled yet.</p>
          ) : (
            <div className="scroll-thin max-h-56 overflow-y-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-zinc-200 text-left uppercase text-zinc-400 dark:border-zinc-800">
                    <th className="py-1 pr-3 font-medium">When</th>
                    <th className="py-1 pr-3 font-medium">Symbol</th>
                    <th className="py-1 pr-3 font-medium">Legs</th>
                    <th className="py-1 pr-3 font-medium">Status</th>
                    <th className="py-1 pr-3 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((t) => (
                    <tr key={t.id} className="border-b border-zinc-100 align-top dark:border-zinc-900">
                      <td className="py-1 pr-3 whitespace-nowrap text-zinc-500">{dateTime(t.updatedAt)}</td>
                      <td className="py-1 pr-3 font-medium">{t.symbol}</td>
                      <td className="py-1 pr-3 tabular-nums">
                        {t.legs.map((l) => (
                          <div key={l.role}>
                            <span className="capitalize text-zinc-500">{l.role}</span> {legText(l)}
                          </div>
                        ))}
                      </td>
                      <td className="py-1 pr-3">
                        <Badge tone={STATUS_TONE[t.status]}>{t.status}</Badge>
                      </td>
                      <td className="py-1 pr-3 text-zinc-500">
                        {t.firedLeg ? `${t.firedLeg} fired` : ''}
                        {t.failReason ? ` ${t.failReason}` : ''}
                        {t.note ? ` · ${t.note}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

/**
 * The create form. Keyed on the symbol by the parent, so every field starts
 * from the symbol's defaults: SELL legs (protecting a long) sized to the open
 * position, or BUY legs when the position is short.
 */
function TriggerForm({
  symbol,
  ltp,
  position,
  onCreated,
}: {
  symbol: string;
  ltp: number;
  position?: Position | null;
  onCreated: () => void;
}) {
  const posQty = position?.quantity ?? 0;
  const [kind, setKind] = useState<'oco' | 'single'>('oco');
  const [product, setProduct] = useState<ProductType>('CNC');
  const [side, setSide] = useState<'BUY' | 'SELL'>(posQty < 0 ? 'BUY' : 'SELL');
  const [quantity, setQuantity] = useState(Math.abs(posQty) || 1);
  const [targetText, setTargetText] = useState('');
  const [stopText, setStopText] = useState('');
  const [singleText, setSingleText] = useState('');
  const [targetType, setTargetType] = useState<OrderKind>('MARKET');
  const [stopType, setStopType] = useState<OrderKind>('MARKET');
  const [singleType, setSingleType] = useState<OrderKind>('MARKET');
  const [targetLimit, setTargetLimit] = useState('');
  const [stopLimit, setStopLimit] = useState('');
  const [singleLimit, setSingleLimit] = useState('');
  const [targetPct, setTargetPct] = useState(3);
  const [stopPct, setStopPct] = useState(2);
  const [trailOn, setTrailOn] = useState(false);
  const [trailPct, setTrailPct] = useState(2);
  const [note, setNote] = useState('');
  const [autoCancel, setAutoCancel] = useState(true);
  const [expires, setExpires] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const tick = tickSize(ltp || 100);
  // For a SELL pair (protecting a long) the target is above and the stop below;
  // a BUY pair (protecting a short) is the mirror image.
  const applyTarget = () => {
    if (!(ltp > 0)) return;
    const p = side === 'SELL' ? ltp * (1 + targetPct / 100) : ltp * (1 - targetPct / 100);
    setTargetText(String(roundToTick(p, side === 'SELL' ? 'up' : 'down')));
  };
  const applyStop = () => {
    if (!(ltp > 0)) return;
    const p = side === 'SELL' ? ltp * (1 - stopPct / 100) : ltp * (1 + stopPct / 100);
    setStopText(String(roundToTick(p, side === 'SELL' ? 'down' : 'up')));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setCreated(null);
    const legs: TriggerCreateRequest['legs'] =
      kind === 'oco'
        ? [
            { role: 'target', side, triggerPrice: Number(targetText), orderType: targetType, price: targetType === 'LIMIT' ? Number(targetLimit) : undefined, quantity },
            { role: 'stop', side, triggerPrice: Number(stopText), orderType: stopType, price: stopType === 'LIMIT' ? Number(stopLimit) : undefined, quantity },
          ]
        : [{ role: 'single', side, triggerPrice: Number(singleText), orderType: singleType, price: singleType === 'LIMIT' ? Number(singleLimit) : undefined, quantity }];
    const body: TriggerCreateRequest = {
      symbol,
      product,
      kind,
      legs,
      trailPct: trailOn ? trailPct : undefined,
      // Expiry at the close of the chosen IST day.
      expiresAt: expires ? new Date(`${expires}T15:30:00+05:30`).getTime() : undefined,
      note: note.trim() || undefined,
      autoCancelWhenFlat: autoCancel,
    };
    setBusy(true);
    try {
      const r = await tradingApi.createTrigger(body);
      setCreated(`Created ${r.trigger.kind.toUpperCase()} ${r.trigger.id.slice(0, 8)} on ${r.trigger.symbol}`);
      setTargetText('');
      setStopText('');
      setSingleText('');
      setNote('');
      onCreated();
    } catch (err) {
      // The server's validation errors, verbatim.
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  const legRow = (
    label: string,
    color: string,
    text: string,
    setText: (v: string) => void,
    type: OrderKind,
    setType: (t: OrderKind) => void,
    limit: string,
    setLimit: (v: string) => void,
    helper?: React.ReactNode,
  ) => (
    <div className="rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
      <div className="mb-1 flex items-center gap-2">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
        <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-300">{label}</span>
        {helper}
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        <input
          type="number"
          min={0}
          step={tick}
          value={text}
          placeholder="trigger price"
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            const n = Number(text);
            if (n > 0) setText(String(roundToTick(n)));
          }}
          className={`${inputCls} col-span-2`}
          aria-label={`${label} trigger price`}
        />
        <select value={type} onChange={(e) => setType(e.target.value as OrderKind)} className={inputCls} aria-label={`${label} order type`}>
          <option value="MARKET">MKT</option>
          <option value="LIMIT">LIMIT</option>
        </select>
        {type === 'LIMIT' && (
          <input
            type="number"
            min={0}
            step={tick}
            value={limit}
            placeholder="limit price"
            onChange={(e) => setLimit(e.target.value)}
            className={`${inputCls} col-span-3`}
            aria-label={`${label} limit price`}
          />
        )}
      </div>
    </div>
  );

  return (
    // noValidate: the browser's step/min checks would silently block submit on a
    // value like 3% with step 0.5; the server is the validator and its errors are shown.
    <form onSubmit={submit} noValidate className="space-y-2 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-semibold">
          New trigger · {symbol} <span className="font-normal text-zinc-500">LTP {ltp > 0 ? num(ltp) : '—'}</span>
        </span>
        {posQty !== 0 && (
          <span className="text-[10px] text-zinc-500">
            position {posQty > 0 ? '+' : ''}
            {posQty}
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        <select value={kind} onChange={(e) => setKind(e.target.value as 'oco' | 'single')} className={inputCls} aria-label="Trigger kind">
          <option value="oco">OCO (target + stop)</option>
          <option value="single">Single</option>
        </select>
        <select value={side} onChange={(e) => setSide(e.target.value as 'BUY' | 'SELL')} className={inputCls} aria-label="Side">
          <option value="SELL">SELL</option>
          <option value="BUY">BUY</option>
        </select>
        <select value={product} onChange={(e) => setProduct(e.target.value as ProductType)} className={inputCls} aria-label="Product">
          <option value="CNC">CNC</option>
          <option value="MIS">MIS</option>
        </select>
      </div>

      <div className="grid grid-cols-3 items-center gap-1.5">
        <label className="text-[11px] text-zinc-500">Quantity</label>
        <input
          type="number"
          min={1}
          step={1}
          value={quantity}
          onChange={(e) => setQuantity(Math.max(0, Math.floor(Number(e.target.value))))}
          className={`${inputCls} col-span-2`}
          aria-label="Trigger quantity"
        />
      </div>

      {kind === 'oco' ? (
        <>
          {legRow(
            'Target',
            LEG_COLOR.target,
            targetText,
            setTargetText,
            targetType,
            setTargetType,
            targetLimit,
            setTargetLimit,
            <span className="ml-auto flex items-center gap-1 text-[10px] text-zinc-500">
              <input type="number" min={0.1} step="any" value={targetPct} onChange={(e) => setTargetPct(Number(e.target.value))} className="w-12 rounded border border-zinc-300 bg-transparent px-1 py-0.5 dark:border-zinc-700" aria-label="Target percent" />
              <button type="button" onClick={applyTarget} className="rounded border border-zinc-300 px-1.5 py-0.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
                {side === 'SELL' ? '+' : '−'}% from LTP
              </button>
            </span>,
          )}
          {legRow(
            'Stop',
            LEG_COLOR.stop,
            stopText,
            setStopText,
            stopType,
            setStopType,
            stopLimit,
            setStopLimit,
            <span className="ml-auto flex items-center gap-1 text-[10px] text-zinc-500">
              <input type="number" min={0.1} step="any" value={stopPct} onChange={(e) => setStopPct(Number(e.target.value))} className="w-12 rounded border border-zinc-300 bg-transparent px-1 py-0.5 dark:border-zinc-700" aria-label="Stop percent" />
              <button type="button" onClick={applyStop} className="rounded border border-zinc-300 px-1.5 py-0.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
                {side === 'SELL' ? '−' : '+'}% from LTP
              </button>
            </span>,
          )}
        </>
      ) : (
        legRow('Trigger', LEG_COLOR.single, singleText, setSingleText, singleType, setSingleType, singleLimit, setSingleLimit)
      )}

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={trailOn} onChange={(e) => setTrailOn(e.target.checked)} />
          Trailing stop
        </label>
        {trailOn && (
          <span className="flex items-center gap-1">
            <input type="number" min={0.1} max={49} step="any" value={trailPct} onChange={(e) => setTrailPct(Number(e.target.value))} className="w-14 rounded border border-zinc-300 bg-transparent px-1 py-0.5 dark:border-zinc-700" aria-label="Trail percent" />
            % behind the extreme (never loosens)
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5" title="A stop that outlives its position is a naked order">
          <input type="checkbox" checked={autoCancel} onChange={(e) => setAutoCancel(e.target.checked)} />
          Auto-cancel when flat
        </label>
        <label className="flex items-center gap-1.5 text-zinc-500">
          Expires
          <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} className="rounded border border-zinc-300 bg-transparent px-1 py-0.5 dark:border-zinc-700" aria-label="Expiry date" />
          <span className="text-[10px]">(blank = 1 year)</span>
        </label>
      </div>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className={inputCls} aria-label="Trigger note" />

      {error && (
        <p className="rounded-md border border-rose-300 bg-rose-50 px-2 py-1.5 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">{error}</p>
      )}
      {created && <p className="text-emerald-600 dark:text-emerald-400">{created}</p>}
      <button
        type="submit"
        disabled={busy || quantity < 1}
        className="w-full rounded-md bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? 'Creating…' : `Create ${kind === 'oco' ? 'OCO' : 'trigger'}`}
      </button>
    </form>
  );
}
