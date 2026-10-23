'use client';

import { useEffect, useRef, useState } from 'react';
import { tradingApi } from '../lib/api';
import { num, pct } from '../lib/format';
import { usePolling } from '../lib/usePolling';
import type { WatchlistView } from '../lib/types';
import { INDEX_INSTRUMENTS, InstrumentSearch } from './InstrumentSearch';
import { Badge, Card } from './ui';

/**
 * Named watchlists, one tab each. Rows show the live LTP and the change
 * against the previous close; a click selects the symbol for the chart and the
 * ticket. Symbols come from the NSE master via the typeahead; the two indices
 * can be added for reference (the ticket will say they are not tradable).
 *
 * With no lists at all, "My watchlist" is created once from whatever the feed
 * is pricing right now, minus the indices — so the page is never empty on a
 * fresh account.
 */

const INDICES = new Set(['NIFTY', 'BANKNIFTY']);
const ACTIVE_KEY = 'ismta_watchlist_active';

type SortMode = 'none' | 'desc' | 'asc';

interface Row {
  symbol: string;
  ltp: number;
  reference: number | null;
  changePct: number | null;
  note?: string;
}

export function WatchlistPanel({
  selected,
  onSelect,
  quotes,
}: {
  selected: string;
  onSelect: (symbol: string) => void;
  /** live ticks from the feed, symbol → LTP */
  quotes: Record<string, number>;
}) {
  const lists = usePolling(() => tradingApi.watchlists(), 5_000);
  const [activeId, setActiveId] = useState<string | null>(() => {
    try {
      return typeof window !== 'undefined' ? localStorage.getItem(ACTIVE_KEY) : null;
    } catch {
      return null;
    }
  });
  const [sort, setSort] = useState<SortMode>('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noteEdit, setNoteEdit] = useState<{ symbol: string; text: string } | null>(null);
  /** set once a seed has been attempted, or the user deleted a list — never re-seed behind their back */
  const seededRef = useRef(false);

  const all: WatchlistView[] = lists.data?.watchlists ?? [];
  const active = all.find((w) => w.id === activeId) ?? all[0] ?? null;
  const loaded = lists.data !== null;
  const count = all.length;
  const { refresh } = lists;

  const feedSymbols = Object.keys(quotes)
    .filter((s) => quotes[s] > 0 && !INDICES.has(s))
    .sort();
  const feedKey = feedSymbols.join(',');

  // Seed "My watchlist" once, from the feed, when the account has no lists.
  useEffect(() => {
    if (!loaded || count > 0 || seededRef.current || !feedKey) return;
    seededRef.current = true;
    // Not cancelled on cleanup: the guard above makes a second run impossible,
    // and a re-render must not be able to swallow the one seed.
    setTimeout(async () => {
      try {
        await tradingApi.createWatchlist({ name: 'My watchlist', symbols: feedKey.split(',') });
        refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'could not create the watchlist');
      }
    }, 0);
  }, [loaded, count, feedKey, refresh]);

  const choose = (id: string) => {
    setActiveId(id);
    try {
      localStorage.setItem(ACTIVE_KEY, id);
    } catch {
      /* private mode */
    }
  };

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const rows: Row[] = active
    ? active.symbols.map((symbol) => {
        const q = active.quotes[symbol];
        const ltp = quotes[symbol] ?? q?.ltp ?? 0;
        const reference = q?.reference ?? null;
        const changePct = ltp > 0 && reference ? ((ltp - reference) / reference) * 100 : null;
        return { symbol, ltp, reference, changePct, note: active.notes[symbol] };
      })
    : [];
  if (sort !== 'none') {
    rows.sort((a, b) => {
      const x = a.changePct ?? Number.NEGATIVE_INFINITY;
      const y = b.changePct ?? Number.NEGATIVE_INFINITY;
      return sort === 'desc' ? y - x : x - y;
    });
  }

  const newList = () => {
    const name = prompt('Name for the new watchlist');
    if (!name?.trim()) return;
    void run(async () => {
      const r = await tradingApi.createWatchlist({ name: name.trim() });
      choose(r.watchlist.id);
    });
  };
  const rename = () => {
    if (!active) return;
    const name = prompt('Rename watchlist', active.name);
    if (!name?.trim() || name.trim() === active.name) return;
    void run(() => tradingApi.patchWatchlist(active.id, { name: name.trim() }));
  };
  const remove = () => {
    if (!active) return;
    if (!confirm(`Delete watchlist "${active.name}" (${active.symbols.length} symbols)?`)) return;
    seededRef.current = true;
    void run(() => tradingApi.deleteWatchlist(active.id));
  };
  const seedFromFeed = () => {
    seededRef.current = true;
    void run(async () => {
      const r = await tradingApi.createWatchlist({ name: 'My watchlist', symbols: feedSymbols });
      choose(r.watchlist.id);
    });
  };
  const saveNote = () => {
    if (!active || !noteEdit) return;
    const { symbol, text } = noteEdit;
    setNoteEdit(null);
    void run(() => tradingApi.patchWatchlist(active.id, { notes: { [symbol]: text.trim() } }));
  };

  return (
    <Card
      title="Watchlist"
      action={
        <div className="flex items-center gap-1 text-[11px]">
          <button type="button" onClick={newList} disabled={busy} className="rounded border border-zinc-300 px-2 py-0.5 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
            + New list
          </button>
          {active && (
            <>
              <button type="button" onClick={rename} disabled={busy} title="Rename" className="rounded border border-zinc-300 px-2 py-0.5 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
                Rename
              </button>
              <button type="button" onClick={remove} disabled={busy} title="Delete this list" className="rounded border border-rose-300 px-2 py-0.5 text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-900 dark:hover:bg-rose-950/40">
                Delete
              </button>
            </>
          )}
        </div>
      }
    >
      {/* tabs */}
      {all.length > 0 && (
        <div className="scroll-thin mb-3 flex gap-1 overflow-x-auto">
          {all.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => choose(w.id)}
              className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs ${
                active?.id === w.id
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                  : 'border border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300'
              }`}
            >
              {w.name} <span className="opacity-60">{w.symbols.length}</span>
            </button>
          ))}
        </div>
      )}

      {error && <p className="mb-2 text-xs text-rose-500">{error}</p>}

      {!loaded && <p className="py-6 text-center text-sm text-zinc-400">Loading watchlists…</p>}
      {loaded && !active && (
        <div className="py-4 text-center text-sm text-zinc-400">
          <p>No watchlists yet.</p>
          <button type="button" onClick={seedFromFeed} disabled={busy || feedSymbols.length === 0} className="mt-2 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            Create “My watchlist” from the {feedSymbols.length} priced symbols
          </button>
        </div>
      )}

      {active && (
        <>
          <InstrumentSearch
            placeholder={`Add to ${active.name}…`}
            extras={INDEX_INSTRUMENTS}
            exclude={active.symbols}
            compact
            className="mb-2"
            onSelect={(i) => void run(() => tradingApi.addWatchlistSymbol(active.id, i.symbol))}
          />
          <div className="scroll-thin max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white text-[10px] uppercase tracking-wide text-zinc-400 dark:bg-zinc-950">
                <tr>
                  <th className="py-1 text-left font-medium">Symbol</th>
                  <th className="py-1 text-right font-medium">LTP</th>
                  <th className="py-1 text-right font-medium">
                    <button
                      type="button"
                      onClick={() => setSort((s) => (s === 'none' ? 'desc' : s === 'desc' ? 'asc' : 'none'))}
                      title="Sort by change vs previous close"
                      className="hover:underline"
                    >
                      Chg% {sort === 'desc' ? '↓' : sort === 'asc' ? '↑' : ''}
                    </button>
                  </th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-4 text-center text-xs text-zinc-400">
                      Empty — search above to add a symbol.
                    </td>
                  </tr>
                )}
                {rows.map((r) => {
                  const isSel = r.symbol === selected;
                  const tone = r.changePct == null ? 'text-zinc-400' : r.changePct > 0 ? 'text-emerald-500' : r.changePct < 0 ? 'text-rose-500' : 'text-zinc-400';
                  return (
                    <tr
                      key={r.symbol}
                      onClick={() => onSelect(r.symbol)}
                      className={`cursor-pointer border-t border-zinc-100 dark:border-zinc-900 ${
                        isSel ? 'bg-blue-600 text-white' : 'hover:bg-zinc-100 dark:hover:bg-zinc-900'
                      }`}
                    >
                      <td className="py-1.5 pr-2">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium">{r.symbol}</span>
                          {INDICES.has(r.symbol) && <Badge tone={isSel ? 'neutral' : 'blue'}>index</Badge>}
                        </div>
                        {noteEdit?.symbol === r.symbol ? (
                          <input
                            autoFocus
                            value={noteEdit.text}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setNoteEdit({ symbol: r.symbol, text: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveNote();
                              if (e.key === 'Escape') setNoteEdit(null);
                            }}
                            onBlur={saveNote}
                            placeholder="note — Enter to save"
                            className="mt-0.5 w-full rounded border border-zinc-300 bg-white px-1 py-0.5 text-[11px] text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                          />
                        ) : (
                          r.note && <div className={`truncate text-[11px] ${isSel ? 'text-blue-100' : 'text-zinc-400'}`}>{r.note}</div>
                        )}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{r.ltp > 0 ? num(r.ltp) : '—'}</td>
                      <td className={`py-1.5 text-right tabular-nums ${isSel ? 'text-white' : tone}`}>
                        {r.changePct == null ? '—' : pct(r.changePct)}
                      </td>
                      <td className="py-1.5 pl-1 text-right">
                        <span className={`flex justify-end gap-0.5 text-[11px] ${isSel ? 'text-blue-100' : 'text-zinc-400'}`}>
                          <button
                            type="button"
                            title="Edit note"
                            onClick={(e) => {
                              e.stopPropagation();
                              setNoteEdit({ symbol: r.symbol, text: r.note ?? '' });
                            }}
                            className="rounded px-1 hover:bg-black/10"
                          >
                            ✎
                          </button>
                          <button
                            type="button"
                            title={`Remove ${r.symbol}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              void run(() => tradingApi.removeWatchlistSymbol(active.id, r.symbol));
                            }}
                            className="rounded px-1 hover:bg-black/10"
                          >
                            ×
                          </button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[10px] text-zinc-400">Chg% is against the previous close; LTP is the live feed.</p>
        </>
      )}
    </Card>
  );
}
