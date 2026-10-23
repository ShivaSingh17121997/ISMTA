'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { inr, pnlColor } from '../lib/format';
import type { ForceSellResult } from '../lib/types';
import { usePolling } from '../lib/usePolling';

/**
 * The Sell button's dialog: sell chosen lots NOW, at market, even below cost.
 *
 * The bot never sells under cost on its own; this is the one place a person
 * can. So the dialog shows what the sale would book BEFORE it is pressed — net
 * of every charge, from the server's own cost model (the flat DP charge makes
 * "price × qty − cost" wrong by up to 1.7% on a small lot) — names the amount on
 * the confirm button, and says plainly when it is a loss.
 *
 * The server decides whether a sale can go out right now (market hours, venue,
 * halts); the dialog shows that reason and disables the button rather than
 * guessing.
 */
export function ForceSellDialog({
  symbol,
  onClose,
  onDone,
}: {
  symbol: string;
  onClose: () => void;
  /** Called after a sale was attempted, so the table refreshes. */
  onDone: () => void;
}) {
  const preview = usePolling(() => api.forceSellPreview(symbol), 15_000);
  const p = preview.data;
  // Lots left OUT of the sale. Every lot is in by default, and a lot that
  // appears on a refresh is in too, without an effect to sync a selection.
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [stopBuying, setStopBuying] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ForceSellResult | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const lots = p?.lots ?? [];
  const chosen = lots.filter((l) => !excluded.has(l.id));
  const qty = chosen.reduce((s, l) => s + l.quantity, 0);
  const proceeds = chosen.reduce((s, l) => s + l.estProceeds, 0);
  const pnl = chosen.reduce((s, l) => s + l.estPnl, 0);
  const blocked = p?.blocker ?? null;
  const canSell = !!p && !blocked && chosen.length > 0 && !busy && !result;

  function toggle(id: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function sell() {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.forceSell(symbol, chosen.map((l) => l.id), stopBuying));
    } catch (e) {
      // A 409 carries the engine's refusal and nothing was sent.
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      onDone();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => !busy && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="force-sell-title"
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-zinc-200 bg-white p-5 text-left shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="force-sell-title" className="text-base font-semibold">
              Sell {symbol} now, at market
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              {p ? <>Price now {inr(p.mark)} · </> : null}
              {p?.venue === 'live' ? (
                <span className="font-medium text-rose-600 dark:text-rose-400">real shares on your Zerodha account</span>
              ) : (
                'paper lots (simulated)'
              )}
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 disabled:opacity-40 dark:hover:bg-zinc-900"
          >
            ✕
          </button>
        </div>

        <p className="mt-3 rounded-lg bg-zinc-100 px-3 py-2 text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
          The bot never sells a lot below its cost on its own. This button does: the chosen lots
          are sold straight away at the market price, <strong>even at a loss</strong>, and the
          result is final.
        </p>

        {preview.loading && !p ? (
          <p className="mt-4 text-sm text-zinc-500">Loading lots…</p>
        ) : preview.error && !p ? (
          <p className="mt-4 text-sm text-rose-600 dark:text-rose-400">{preview.error}</p>
        ) : lots.length === 0 && !result ? (
          <p className="mt-4 text-sm text-zinc-500">This stock has no open lots.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wide text-zinc-500">
                <tr className="border-b border-zinc-200 dark:border-zinc-800">
                  <th className="px-2 py-1.5 text-left font-medium">Sell</th>
                  <th className="px-2 py-1.5 text-left font-medium">Rung</th>
                  <th className="px-2 py-1.5 text-right font-medium">Qty</th>
                  <th className="px-2 py-1.5 text-right font-medium">Bought at</th>
                  <th className="px-2 py-1.5 text-right font-medium">Cost</th>
                  <th className="px-2 py-1.5 text-right font-medium">You get (est.)</th>
                  <th className="px-2 py-1.5 text-right font-medium">Result (est.)</th>
                </tr>
              </thead>
              <tbody>
                {lots.map((l) => (
                  <tr key={l.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                    <td className="px-2 py-1.5">
                      <input
                        type="checkbox"
                        checked={!excluded.has(l.id)}
                        disabled={busy || !!result}
                        onChange={() => toggle(l.id)}
                        aria-label={`Sell lot on rung ${l.level}`}
                      />
                    </td>
                    <td className="px-2 py-1.5 font-mono">{l.level}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{l.quantity}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{inr(l.fillPrice)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{inr(l.quoteSpent, 0)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{inr(l.estProceeds, 0)}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${pnlColor(l.estPnl)}`}>{inr(l.estPnl, 0)}</td>
                  </tr>
                ))}
              </tbody>
              {chosen.length > 0 && (
                <tfoot>
                  <tr className="border-t border-zinc-300 font-medium dark:border-zinc-700">
                    <td className="px-2 py-1.5" colSpan={2}>
                      {chosen.length} of {lots.length}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{qty}</td>
                    <td />
                    <td className="px-2 py-1.5 text-right tabular-nums">{inr(chosen.reduce((s, l) => s + l.quoteSpent, 0), 0)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{inr(proceeds, 0)}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${pnlColor(pnl)}`}>{inr(pnl, 0)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
            <p className="mt-1 text-[10px] text-zinc-500">
              Estimates at today&apos;s price, after every selling charge. A market order fills at
              whatever the market pays, so the final figure can differ a little.
            </p>
          </div>
        )}

        {!result && chosen.length > 0 && pnl < 0 && (
          <p className="mt-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
            <strong>This books a loss of about {inr(-pnl, 0)}.</strong>{' '}
            {p?.venue === 'live'
              ? 'It is real money once sold and cannot be undone.'
              : 'These are paper lots, so no real money moves, but the loss is recorded and cannot be undone.'}
          </p>
        )}

        {!result && (
          <label className="mt-3 flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={stopBuying}
              disabled={busy}
              onChange={(e) => setStopBuying(e.target.checked)}
            />
            <span>
              <strong>Stop new buys on {symbol}</strong>{' '}(turns the Kill switch on). Recommended:
              otherwise the bot may buy this stock again as soon as the next minute, because the
              price is below its recent high.
              {p?.killSwitchEngaged ? ' The Kill switch is already on.' : ''}
            </span>
          </label>
        )}

        {blocked && !result && (
          <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            <strong>Can&apos;t sell right now.</strong>{' '}{blocked}
          </p>
        )}

        {error && (
          <p className="mt-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </p>
        )}

        {result && <Outcome result={result} />}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            {result ? 'Close' : 'Cancel'}
          </button>
          {!result && (
            <button
              onClick={() => void sell()}
              disabled={!canSell}
              className="rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy
                ? 'Selling…'
                : chosen.length === 0
                  ? 'Choose a lot'
                  : `Sell ${chosen.length} lot${chosen.length === 1 ? '' : 's'} at market · ${pnl < 0 ? 'loss' : 'profit'} ≈ ${inr(Math.abs(pnl), 0)}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Outcome({ result }: { result: ForceSellResult }) {
  const total = result.sold.reduce((s, l) => s + l.pnl, 0);
  return (
    <div className="mt-3 space-y-1.5 text-xs">
      {result.sold.length > 0 && (
        <p className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
          Sold {result.sold.length} lot{result.sold.length === 1 ? '' : 's'} (
          {result.sold.map((l) => `${l.quantity} @ ${inr(l.price)}`).join(', ')}). Result{' '}
          <span className={pnlColor(total)}>{inr(total, 2)}</span>.{' '}
          {result.killSwitchEngaged ? 'Kill switch is on: no new buys.' : ''}
        </p>
      )}
      {result.failed.map((f) => (
        <p
          key={f.lotId}
          className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
        >
          Not sold ({f.lotId}): {f.reason}
        </p>
      ))}
      {result.halted && (
        <p className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          The stock is now halted: {result.halted}
        </p>
      )}
    </div>
  );
}
