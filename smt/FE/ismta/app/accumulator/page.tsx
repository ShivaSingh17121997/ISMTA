'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AllocatorPanel } from '../components/AllocatorPanel';
import { StockModeTable } from '../components/StockModeTable';
import { Badge, Card, PageHeader, ToggleSwitch } from '../components/ui';
import { api } from '../lib/api';
import type { Instrument } from '../lib/types';
import { usePolling } from '../lib/usePolling';

/**
 * No-loss mode: add stocks, see how the allocator sized them, flip modes.
 *
 * This page used to render a full chart, stat strip and lot table for every
 * book — nineteen charts, each fetching candles every minute, all duplicating
 * the per-stock page. Now it is the search box, the allocator's plan, and the
 * same compact table the dashboard uses. Everything per-stock lives at
 * /accumulator/SYMBOL, one click from the symbol.
 */
export default function AccumulatorPage() {
  const state = usePolling(() => api.accumulator(), 4000);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── company search ──
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Instrument[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [searching, setSearching] = useState(false);
  const [budget, setBudget] = useState(60000);

  // Debounced search. Every setState lives inside the timer callback: the
  // project's react-hooks rule forbids synchronous setState in an effect body.
  useEffect(() => {
    const q = query.trim();
    const id = setTimeout(async () => {
      if (!q) {
        setResults([]);
        return;
      }
      setSearching(true);
      try {
        const r = await api.instruments(q, 30);
        setResults(r.results);
        setTotal(r.total);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSearching(false);
      }
    }, q ? 250 : 0);
    return () => clearTimeout(id);
  }, [query]);

  const books = state.data?.books ?? [];
  // The global `params.tranches` is only the default; every book carries its
  // own rung count (the allocator sets it from what the book can afford), so
  // the intro quotes what the books actually use.
  const rungCounts = [...new Set(books.map((b) => b.report.tranches))].sort((a, b) => a - b);
  const rungsText =
    rungCounts.length === 0
      ? 'a ladder of rungs'
      : rungCounts.length === 1
        ? `${rungCounts[0]} rungs per book`
        : `${rungCounts[0]}–${rungCounts[rungCounts.length - 1]} rungs per book`;
  const params = state.data?.params;
  const bookBySymbol = new Map(books.map((b) => [b.book.symbol, b.book]));

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      state.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  /** ETFs are listed in the same master as stocks; this guesses from the name. */
  const looksLikeEtf = (i: Instrument) => /\bETF\b|BEES/i.test(`${i.symbol} ${i.name}`);

  return (
    <div>
      <PageHeader
        title="No-loss mode"
        subtitle="Pick a listed company, switch it on, and the bot buys its dips and sells each lot only above cost"
      />

      <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
        <span className="font-semibold">This trades one risk for another.</span> No lot is ever sold at
        a loss, so every closed trade is a profit — and the cost is unrealised drawdown and capital
        locked up for as long as recovery takes. If a company never recovers, its open lots are a total
        loss while the win rate still reads 100%. Single stocks carry that risk; index ETFs mostly do
        not. Every order is <strong>CNC delivery</strong>; nothing here is intraday.
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      )}

      {/* ── company search ── */}
      <Card
        title="Find a company"
        className="mb-6"
        action={
          total !== null ? (
            <span className="text-xs text-zinc-500">{total.toLocaleString('en-IN')} NSE listed companies</span>
          ) : undefined
        }
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-500">
            Symbol or company name
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. SYRMA, SCI, Shipping Corporation…"
              autoFocus
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-500">
            Initial budget (₹)
            <input
              type="number"
              min={1000}
              step={1000}
              value={budget}
              onChange={(e) => setBudget(Number(e.target.value))}
              title="Only until the allocator's next pass. It re-sizes every book from the paper pool by strength, and funds only the strongest."
              className="w-44 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </label>
        </div>

        {query.trim() && (
          <div className="mt-4 overflow-x-auto">
            {searching && results.length === 0 ? (
              <p className="py-3 text-sm text-zinc-500">Searching…</p>
            ) : results.length === 0 ? (
              <p className="py-3 text-sm text-zinc-500">No listed company matches “{query.trim()}”.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="py-2 text-left font-medium">Symbol</th>
                    <th className="py-2 text-left font-medium">Company</th>
                    <th className="py-2 text-left font-medium">Series</th>
                    <th className="py-2 text-left font-medium">Listed</th>
                    <th className="py-2 text-right font-medium">No-loss mode</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((i) => {
                    const existing = bookBySymbol.get(i.symbol);
                    const tradable = i.series === 'EQ' || i.series === 'BE';
                    return (
                      <tr key={i.symbol} className="border-t border-zinc-100 dark:border-zinc-800">
                        <td className="py-2 font-mono text-xs font-semibold">
                          {existing ? (
                            <Link href={`/accumulator/${encodeURIComponent(i.symbol)}`} className="hover:underline">
                              {i.symbol}
                            </Link>
                          ) : (
                            i.symbol
                          )}
                        </td>
                        <td className="py-2">{i.name}</td>
                        <td className="py-2">
                          <Badge tone={tradable ? 'neutral' : 'amber'}>{i.series}</Badge>
                        </td>
                        <td className="py-2 text-zinc-500">{i.listedOn}</td>
                        <td className="py-2 text-right">
                          {existing ? (
                            <div className="flex flex-col items-end gap-0.5">
                              <ToggleSwitch
                                on={!!existing.enabled}
                                busy={busy === i.symbol}
                                onToggle={() => run(i.symbol, () => api.toggleAccumulator(i.symbol))}
                              />
                              {/* The allocator's verdict, so a switch that goes green and a book
                                  that then sits at ₹0 never look like the same thing. */}
                              {existing.allocatorNote && (
                                <span
                                  className={`max-w-[16rem] truncate text-[10px] ${
                                    existing.allocatorPaused ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'
                                  }`}
                                  title={existing.allocatorNote}
                                >
                                  {existing.allocatorPaused ? 'no capital: ' : 'funded: '}
                                  {existing.allocatorNote}
                                </span>
                              )}
                            </div>
                          ) : (
                            <button
                              disabled={!tradable || busy === i.symbol}
                              onClick={() =>
                                run(i.symbol, () =>
                                  api.createAccumulator({
                                    symbol: i.symbol,
                                    instrument: looksLikeEtf(i) ? 'ETF' : 'EQUITY',
                                    budget,
                                    enabled: true,
                                  }),
                                )
                              }
                              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
                              title={tradable ? `Open a ₹${budget.toLocaleString('en-IN')} book and switch on` : 'Only EQ/BE series trade as normal delivery'}
                            >
                              {busy === i.symbol ? 'Opening…' : 'Turn on'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {params && (
          <p className="mt-4 text-xs text-zinc-500">
            Turning a company on opens a book that anchors a ladder only {params.startDiscountPct}% below
            its {params.hiLookbackDays}-day high, buys {rungsText}, {params.stepPct}% apart with{' '}
            {params.minBuyGapMs / 3600000}h between buys, and sells each lot {params.targetPct}% over its
            fee-inclusive breakeven, with {params.reservePct}% held back. The allocator then decides which
            books get the capital and how many rungs each can afford.
          </p>
        )}
      </Card>

      {/* ── capital allocator ── */}
      <AllocatorPanel
        names={new Map(books.map((b) => [b.book.symbol, b.book.name ?? b.book.symbol]))}
        onChanged={() => state.refresh()}
      />

      {/* ── every book, compact ── */}
      <StockModeTable
        rows={books}
        profile={state.data?.scalpProfile}
        swing={state.data?.params}
        loading={state.loading}
        onAction={state.refresh}
        emptyMessage="Nothing switched on yet. Search above and turn a company on; its chart, lots and history will be one click away on its own page."
      />
    </div>
  );
}
