'use client';

import { useEffect, useRef, useState } from 'react';
import { api, tradingApi } from '../lib/api';
import { inr, num } from '../lib/format';
import { usePolling } from '../lib/usePolling';
import { useSymbolFlags } from '../lib/useSymbolFlags';
import type { OrderKind, OrderPreview, PlaceOrderResponse, Position, ProductType } from '../lib/types';
import { Badge, Card } from './ui';

/**
 * Manual order entry, in two steps.
 *
 * Nothing is sent from the first click. PREVIEW asks the server what the order
 * would cost — charges per leg, fee-inclusive breakeven, whether the instrument
 * is tradable at all, how old the quote is — and only then is CONFIRM offered,
 * and only while the exchange is in continuous trading and nothing is halted.
 * A refusal from the server is shown word for word: the gate's reason is the
 * one piece of copy this ticket must never paraphrase.
 *
 * Every confirm carries a fresh `clientOrderId` (a retried click cannot double
 * a position) and the LTP the ticket showed as `referencePrice` (a fill far
 * from the price you decided on is not the trade you decided on).
 */

// ── NSE tick ladder (circular effective 2025-04-15) — mirrors BE/src/services/nse.ts ──
export function tickSize(price: number): number {
  const p = Math.abs(price);
  if (p < 250) return 0.01;
  if (p < 1_000) return 0.05;
  if (p < 5_000) return 0.1;
  if (p < 10_000) return 0.5;
  if (p < 20_000) return 1;
  return 5;
}
export function roundToTick(price: number, mode: 'nearest' | 'up' | 'down' = 'nearest'): number {
  if (!Number.isFinite(price) || price <= 0) return price;
  const tick = tickSize(price);
  const units = price / tick;
  const snapped = mode === 'up' ? Math.ceil(units) : mode === 'down' ? Math.floor(units) : Math.round(units);
  return Math.round(snapped * tick * 100) / 100;
}
export function onTick(price: number): boolean {
  if (!(price > 0)) return false;
  const units = price / tickSize(price);
  return Math.abs(units - Math.round(units)) < 1e-6;
}

const inputCls =
  'w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm tabular-nums dark:border-zinc-700 disabled:opacity-50';
const smallInputCls =
  'w-full rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-xs tabular-nums dark:border-zinc-700';

function ageLabel(ms: number | null): string {
  if (ms == null) return 'no quote';
  if (ms < 1000) return 'just now';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s old`;
  return `${Math.round(ms / 60_000)} min old`;
}

export function OrderTicket({
  symbol,
  ltp,
  position,
  onPlaced,
}: {
  symbol: string;
  ltp: number;
  /** the open position on `symbol`, if any */
  position?: Position | null;
  onPlaced: () => void;
}) {
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [product, setProduct] = useState<ProductType>('CNC');
  const [orderType, setOrderType] = useState<OrderKind>('MARKET');
  const [priceText, setPriceText] = useState('');
  const [quantity, setQuantity] = useState(1);

  // position-size calculator
  const [riskMode, setRiskMode] = useState<'pct' | 'inr'>('pct');
  const [riskValue, setRiskValue] = useState(1);
  const [stopText, setStopText] = useState('');

  // preview → confirm
  const [preview, setPreview] = useState<{ key: string; data: OrderPreview; ltp: number } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PlaceOrderResponse | null>(null);
  const qtyRef = useRef<HTMLInputElement>(null);

  const funds = usePolling(() => api.funds(), 15_000);
  const system = usePolling(() => tradingApi.system(), 5_000);
  const flags = useSymbolFlags(symbol);
  const deployable = funds.data?.funds.deployable ?? 0;

  // Keyboard shortcuts from the shell: B / S preset the side and jump to quantity.
  useEffect(() => {
    const onShortcut = (e: Event) => {
      const key = (e as CustomEvent<{ key?: string }>).detail?.key;
      if (key === 'b') setSide('BUY');
      else if (key === 's') setSide('SELL');
      else return;
      qtyRef.current?.focus();
      qtyRef.current?.select();
    };
    window.addEventListener('ismta:shortcut', onShortcut);
    return () => window.removeEventListener('ismta:shortcut', onShortcut);
  }, []);

  const limitPrice = Number(priceText);
  const limitValid = orderType !== 'LIMIT' || (limitPrice > 0 && onTick(limitPrice));
  const entry = orderType === 'LIMIT' && limitPrice > 0 ? limitPrice : ltp;
  const notional = entry * quantity;
  const tick = tickSize(entry || ltp || 100);

  // The preview is only valid for the exact order it was asked for; any edit
  // invalidates it, so a stale preview can never be confirmed.
  const key = [symbol, side, product, orderType, orderType === 'LIMIT' ? limitPrice : 'MKT', quantity].join('|');
  const live = preview && preview.key === key ? preview : null;
  const shownResult = result && result.order.symbol === symbol ? result : null;

  // ── sizing ──
  const stop = Number(stopText);
  const riskInr = riskMode === 'pct' ? (deployable * riskValue) / 100 : riskValue;
  const perShare = stop > 0 && entry > 0 ? Math.abs(entry - stop) : 0;
  const rawQty = perShare > 0 ? Math.floor(riskInr / perShare) : 0;
  const capQty = entry > 0 ? Math.floor(deployable / entry) : 0;
  const sizedQty = Math.max(0, Math.min(rawQty, capQty));
  const capped = rawQty > capQty && capQty > 0;
  const sizedRisk = sizedQty * perShare;
  const sizedPct = deployable > 0 ? (sizedRisk / deployable) * 100 : 0;
  const stopWrongSide = stop > 0 && entry > 0 && (side === 'BUY' ? stop >= entry : stop <= entry);

  // ── session gate (mirrors the server's pre-trade gate; the server still decides) ──
  const phase = system.data?.session.phase;
  const halted = system.data?.halted ?? false;
  const sessionReason = !system.data
    ? 'session state unknown — waiting for /api/system'
    : halted
      ? 'trading halted'
      : phase !== 'open'
        ? `market ${phase}: ${system.data.session.describe} — orders are accepted 09:15–15:30 IST`
        : null;
  const tradableReason = live && !live.data.tradable ? live.data.tradableReason : null;
  const blockReason = sessionReason ?? tradableReason;

  const doPreview = async () => {
    setError(null);
    setResult(null);
    if (!(quantity >= 1)) return setError('quantity must be at least 1');
    if (!limitValid) return setError(`a LIMIT order needs a price on the ₹${tick} tick grid`);
    setPreviewing(true);
    try {
      const data = await tradingApi.orderPreview({
        symbol,
        side,
        quantity,
        product,
        price: orderType === 'LIMIT' ? limitPrice : undefined,
      });
      setPreview({ key, data, ltp });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'preview failed');
    } finally {
      setPreviewing(false);
    }
  };

  const doConfirm = async () => {
    if (!live || blockReason) return;
    setSending(true);
    setError(null);
    try {
      const r = await tradingApi.placeTicketOrder({
        symbol,
        side,
        quantity,
        orderType,
        product,
        price: orderType === 'LIMIT' ? limitPrice : undefined,
        // The LTP on screen at the moment of the click; the preview's if the feed went quiet.
        referencePrice: ltp > 0 ? ltp : live.ltp,
        clientOrderId: crypto.randomUUID(),
      });
      setResult(r);
      setPreview(null);
      onPlaced();
    } catch (e) {
      // The gate's reason, verbatim.
      setError(e instanceof Error ? e.message : 'order failed');
    } finally {
      setSending(false);
    }
  };

  const posQty = position?.quantity ?? 0;
  const reduces = posQty !== 0 && (side === 'SELL' ? posQty > 0 : posQty < 0);
  const overDeployable = live ? live.data.notional > deployable : notional > deployable;

  return (
    <Card
      title="Order Ticket"
      action={
        <span className="text-[11px] text-zinc-400">
          {system.data ? (
            <>
              <Badge tone={halted ? 'red' : phase === 'open' ? 'green' : 'amber'}>
                {halted ? 'HALTED' : (phase ?? '…').replace('_', '-')}
              </Badge>
            </>
          ) : (
            '…'
          )}
        </span>
      }
    >
      <div className="space-y-3">
        <div className="flex items-baseline justify-between text-sm">
          <span className="font-semibold">{symbol}</span>
          <span className="tabular-nums text-zinc-500">
            LTP <span className="font-medium text-zinc-800 dark:text-zinc-100">{ltp > 0 ? num(ltp) : '—'}</span>
          </span>
        </div>
        {posQty !== 0 && (
          <p className="text-xs text-zinc-500">
            Position: <span className={`tabular-nums ${posQty > 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{posQty > 0 ? '+' : ''}{posQty}</span> @ {num(position?.avgPrice ?? 0)}
            {reduces && ` · this ${side} reduces it`}
          </p>
        )}

        {/* side */}
        <div className="grid grid-cols-2 gap-2">
          {(['BUY', 'SELL'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSide(s)}
              className={`rounded-md py-2 text-sm font-medium ${
                side === s
                  ? s === 'BUY'
                    ? 'bg-emerald-600 text-white'
                    : 'bg-rose-600 text-white'
                  : 'border border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300'
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        {/* product + type */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="mb-1 block text-xs text-zinc-500">Product</label>
            <div className="flex rounded-md border border-zinc-300 text-xs dark:border-zinc-700">
              {(['CNC', 'MIS'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setProduct(p)}
                  title={p === 'CNC' ? 'Delivery' : 'Intraday — squared off by 15:20'}
                  className={`flex-1 py-1.5 ${product === p ? 'bg-blue-600 text-white' : 'text-zinc-600 dark:text-zinc-300'}`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-zinc-500">Type</label>
            <div className="flex rounded-md border border-zinc-300 text-xs dark:border-zinc-700">
              {(['MARKET', 'LIMIT'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    setOrderType(t);
                    if (t === 'LIMIT' && !priceText && ltp > 0) setPriceText(String(roundToTick(ltp)));
                  }}
                  className={`flex-1 py-1.5 ${orderType === t ? 'bg-blue-600 text-white' : 'text-zinc-600 dark:text-zinc-300'}`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* price + quantity */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="mb-1 block text-xs text-zinc-500">
              {orderType === 'LIMIT' ? `Limit price (tick ₹${tick})` : 'Price'}
            </label>
            <input
              type="number"
              min={0}
              step={tick}
              value={orderType === 'LIMIT' ? priceText : ''}
              placeholder={orderType === 'MARKET' ? 'at market' : ''}
              disabled={orderType === 'MARKET'}
              onChange={(e) => setPriceText(e.target.value)}
              onBlur={() => {
                if (orderType === 'LIMIT' && limitPrice > 0 && !onTick(limitPrice)) setPriceText(String(roundToTick(limitPrice)));
              }}
              className={`${inputCls} ${orderType === 'LIMIT' && !limitValid ? 'border-rose-400' : ''}`}
            />
            {orderType === 'LIMIT' && priceText && !limitValid && (
              <p className="mt-1 text-[11px] text-rose-500">Not on the ₹{tick} tick grid — snaps on blur.</p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs text-zinc-500">Quantity</label>
            <input
              ref={qtyRef}
              type="number"
              min={1}
              step={1}
              value={quantity}
              onChange={(e) => setQuantity(Math.max(0, Math.floor(Number(e.target.value))))}
              className={inputCls}
            />
          </div>
        </div>
        <div className="flex justify-between text-xs text-zinc-400">
          <span>Notional {inr(notional, 0)}</span>
          <span className={overDeployable && !live ? 'text-rose-500' : ''}>
            deployable {funds.data ? inr(deployable, 0) : '…'}
          </span>
        </div>

        {/* sizing */}
        <details className="rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <summary className="cursor-pointer text-xs font-medium text-zinc-600 dark:text-zinc-300">
            Position size from risk
          </summary>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <div>
              <label className="mb-1 block text-[11px] text-zinc-500">Risk</label>
              <input
                type="number"
                min={0}
                step={riskMode === 'pct' ? 0.25 : 100}
                value={riskValue}
                onChange={(e) => setRiskValue(Number(e.target.value))}
                className={smallInputCls}
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-zinc-500">as</label>
              <div className="flex rounded-md border border-zinc-300 text-[11px] dark:border-zinc-700">
                {(['pct', 'inr'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setRiskMode(m);
                      setRiskValue(m === 'pct' ? 1 : Math.round(deployable * 0.01));
                    }}
                    className={`flex-1 py-1 ${riskMode === m ? 'bg-blue-600 text-white' : 'text-zinc-600 dark:text-zinc-300'}`}
                  >
                    {m === 'pct' ? '% deployable' : '₹'}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-zinc-500">Stop price</label>
              <input
                type="number"
                min={0}
                step={tick}
                value={stopText}
                onChange={(e) => setStopText(e.target.value)}
                className={`${smallInputCls} ${stopWrongSide ? 'border-rose-400' : ''}`}
              />
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-500">
            <span>
              risk {inr(riskInr, 0)} ÷ {perShare > 0 ? num(perShare) : '—'}/share ={' '}
              <span className="font-semibold text-zinc-800 dark:text-zinc-100">{sizedQty}</span> shares
              {capped && <span className="text-amber-600"> (capped by deployable)</span>}
              {stopWrongSide && (
                <span className="text-rose-500"> — stop must be {side === 'BUY' ? 'below' : 'above'} entry</span>
              )}
            </span>
            <span>
              ₹ at risk <span className="tabular-nums">{inr(sizedRisk, 0)}</span> · {sizedPct.toFixed(2)}% of deployable
            </span>
            <button
              type="button"
              disabled={sizedQty < 1 || stopWrongSide}
              onClick={() => setQuantity(sizedQty)}
              className="rounded border border-zinc-300 px-2 py-0.5 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Use {sizedQty}
            </button>
          </div>
        </details>

        {/* flags (filled in by the events module; empty today) */}
        {flags.warnings.length > 0 && (
          <ul className="space-y-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            {flags.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}

        {/* step 1: preview */}
        {!live && (
          <button
            type="button"
            onClick={doPreview}
            disabled={previewing || quantity < 1 || !limitValid}
            className="w-full rounded-md bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {previewing ? 'Previewing…' : `Preview ${side} ${quantity} ${symbol} (${orderType === 'LIMIT' ? `LIMIT ${num(limitPrice)}` : 'MARKET'})`}
          </button>
        )}

        {/* step 2: the preview and the confirm */}
        {live && (
          <div className="space-y-2 rounded-md border border-blue-300 bg-blue-50/60 p-3 text-xs dark:border-blue-900 dark:bg-blue-950/30">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-blue-900 dark:text-blue-200">
                Preview · {side} {live.data.quantity} {symbol} · {product} · {orderType === 'LIMIT' ? `LIMIT ${num(live.data.price)}` : `MARKET ~${num(live.data.price)}`}
              </span>
              <button type="button" onClick={() => setPreview(null)} className="text-zinc-500 hover:underline">
                edit
              </button>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 tabular-nums">
              <dt className="text-zinc-500">Entry charges</dt>
              <dd className="text-right">{inr(live.data.charges.entry.total)}</dd>
              <dt className="text-zinc-500">Exit charges</dt>
              <dd className="text-right">{inr(live.data.charges.exit.total)}</dd>
              <dt className="text-zinc-500">Round trip</dt>
              <dd className="text-right">
                {inr(live.data.charges.roundTrip)} ({live.data.charges.roundTripPct.toFixed(3)}%)
              </dd>
              <dt className="text-zinc-500">Breakeven</dt>
              <dd className="text-right font-medium">{num(live.data.breakeven)}</dd>
              <dt className="text-zinc-500">Notional vs deployable</dt>
              <dd className={`text-right ${overDeployable ? 'font-semibold text-rose-600' : ''}`}>
                {inr(live.data.notional, 0)} / {inr(deployable, 0)}
                {overDeployable && ' — over'}
              </dd>
              <dt className="text-zinc-500">Existing position</dt>
              <dd className="text-right">
                {live.data.existingPosition === 0 ? 'none' : `${live.data.existingPosition > 0 ? '+' : ''}${live.data.existingPosition}`}
              </dd>
              <dt className="text-zinc-500">Previous close</dt>
              <dd className="text-right">{live.data.reference != null ? num(live.data.reference) : '—'}</dd>
              <dt className="text-zinc-500">Quote</dt>
              <dd className={`text-right ${live.data.quoteAgeMs != null && live.data.quoteAgeMs > 90_000 ? 'text-rose-500' : ''}`}>
                {ageLabel(live.data.quoteAgeMs)}
              </dd>
              {ltp > 0 && live.ltp > 0 && ltp !== live.ltp && (
                <>
                  <dt className="text-zinc-500">LTP since preview</dt>
                  <dd className="text-right">
                    {num(live.ltp)} → {num(ltp)}
                  </dd>
                </>
              )}
            </dl>
            {!live.data.tradable && (
              <p className="rounded border border-rose-300 bg-rose-50 px-2 py-1 font-medium text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
                Not tradable: {live.data.tradableReason}
              </p>
            )}
            {flags.warnings.map((w) => (
              <p key={w} className="text-amber-700 dark:text-amber-300">
                {w}
              </p>
            ))}
            <p className={`${blockReason ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
              Session: {system.data?.session.describe ?? '…'}
              {halted && ' · HALTED'}
            </p>
            <button
              type="button"
              onClick={doConfirm}
              disabled={sending || !!blockReason}
              title={blockReason ?? undefined}
              className={`w-full rounded-md py-2 text-sm font-semibold text-white disabled:opacity-50 ${
                side === 'BUY' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'
              }`}
            >
              {sending
                ? 'Sending…'
                : blockReason
                  ? `Cannot send — ${blockReason}`
                  : `Confirm ${side} ${live.data.quantity} ${symbol}`}
            </button>
          </div>
        )}

        {error && (
          <p className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </p>
        )}

        {shownResult && (
          <div
            className={`space-y-1 rounded-md border px-3 py-2 text-xs ${
              shownResult.order.status === 'FILLED'
                ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
                : 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'
            }`}
          >
            <p className="font-semibold">
              {shownResult.order.status} · {shownResult.order.side} {shownResult.order.filledQuantity}
              {shownResult.order.filledQuantity !== shownResult.order.quantity && `/${shownResult.order.quantity}`} {symbol}
              {shownResult.order.filledPrice ? ` @ ${num(shownResult.order.filledPrice)}` : ''}
            </p>
            {shownResult.order.slippageBps != null && (
              <p>
                Slippage {shownResult.order.slippageBps > 0 ? '+' : ''}
                {shownResult.order.slippageBps.toFixed(1)} bps vs reference{' '}
                {shownResult.order.referencePrice != null ? num(shownResult.order.referencePrice) : ''}
                {shownResult.order.slippageBps > 0 ? ' (against you)' : shownResult.order.slippageBps < 0 ? ' (in your favour)' : ''}
              </p>
            )}
            {shownResult.adjustment && (
              <p className="rounded border border-amber-400 bg-amber-100 px-2 py-1 font-semibold text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
                {shownResult.adjustment}
              </p>
            )}
            {shownResult.order.rejectionReason && <p className="text-rose-600">{shownResult.order.rejectionReason}</p>}
            {shownResult.order.charges != null && <p className="text-zinc-500">charges {inr(shownResult.order.charges)}</p>}
          </div>
        )}
      </div>
    </Card>
  );
}
