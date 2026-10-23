'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { Instrument } from '../lib/types';
import { Badge } from './ui';

/**
 * Typeahead over the NSE listed-company master (`/api/market/instruments`).
 *
 * One component for every place a symbol is chosen — the watchlist, the
 * backtest, the strategy form — so the same 2,500-company universe is
 * searchable everywhere and nothing hard-codes eight symbols.
 *
 * `extras` lets a caller offer rows the master does not have (the two indices
 * the feed prices). They are matched client-side and merged ahead of the
 * server results. Pass a module-level constant: the list is filtered during
 * render, not fetched.
 */

/** The indices the feed prices. Reference only — the order gate refuses them. */
export const INDEX_INSTRUMENTS: Instrument[] = [
  { symbol: 'NIFTY', name: 'NIFTY 50 index — reference only, not tradable', series: 'INDEX', isin: '', listedOn: '', faceValue: 0 },
  { symbol: 'BANKNIFTY', name: 'NIFTY Bank index — reference only, not tradable', series: 'INDEX', isin: '', listedOn: '', faceValue: 0 },
];

const TRADABLE_SERIES = new Set(['EQ', 'BE', 'BZ']);

function seriesTone(series: string): 'neutral' | 'amber' | 'blue' {
  if (series === 'INDEX') return 'blue';
  return TRADABLE_SERIES.has(series) ? 'neutral' : 'amber';
}

export function InstrumentSearch({
  onSelect,
  placeholder = 'Symbol or company name…',
  autoFocus = false,
  extras,
  exclude,
  clearOnSelect = true,
  initialQuery = '',
  className = '',
  compact = false,
  disabled = false,
}: {
  onSelect: (instrument: Instrument) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** rows to offer beyond the NSE master (see INDEX_INSTRUMENTS); pass a stable reference */
  extras?: Instrument[];
  /** symbols to hide from the results (already chosen) */
  exclude?: string[];
  /** empty the box after a pick (true) or leave the picked symbol in it */
  clearOnSelect?: boolean;
  initialQuery?: string;
  className?: string;
  /** smaller input for a card header */
  compact?: boolean;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<Instrument[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  // Debounced fetch. Every setState sits inside the timer callback — the
  // project's react-hooks rule forbids a synchronous setState in an effect body.
  useEffect(() => {
    const q = query.trim();
    const id = setTimeout(async () => {
      if (!q) {
        setResults([]);
        setSearching(false);
        return;
      }
      setSearching(true);
      try {
        const r = await api.instruments(q, 12);
        setResults(r.results);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSearching(false);
      }
    }, q ? 200 : 0);
    return () => clearTimeout(id);
  }, [query]);

  // Close on an outside click.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const q = query.trim().toUpperCase();
  const excluded = new Set((exclude ?? []).map((s) => s.toUpperCase()));
  const extraMatches = q
    ? (extras ?? []).filter((i) => i.symbol.includes(q) || i.name.toUpperCase().includes(q))
    : [];
  const merged = [...extraMatches, ...results.filter((r) => !extraMatches.some((x) => x.symbol === r.symbol))].filter(
    (i) => !excluded.has(i.symbol.toUpperCase()),
  );
  const showList = open && q.length > 0;

  const pick = (i: Instrument) => {
    onSelect(i);
    setQuery(clearOnSelect ? '' : i.symbol);
    setOpen(false);
    setActive(0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, Math.max(0, merged.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      if (showList && merged[active]) {
        e.preventDefault();
        pick(merged[active]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const inputCls = compact
    ? 'w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100'
    : 'w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100';

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <input
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label="Search instruments"
        value={query}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className={`${inputCls} disabled:opacity-50`}
      />
      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="scroll-thin absolute left-0 z-30 mt-1 max-h-72 w-full min-w-72 overflow-y-auto rounded-md border border-zinc-200 bg-white py-1 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
        >
          {searching && merged.length === 0 && <li className="px-3 py-2 text-xs text-zinc-500">Searching…</li>}
          {!searching && merged.length === 0 && !error && (
            <li className="px-3 py-2 text-xs text-zinc-500">No listed company matches “{query.trim()}”.</li>
          )}
          {error && <li className="px-3 py-2 text-xs text-rose-500">{error}</li>}
          {merged.map((i, idx) => (
            <li
              key={i.symbol}
              role="option"
              aria-selected={idx === active}
              onMouseDown={(e) => {
                // mousedown, not click: the input's blur would otherwise close the list first
                e.preventDefault();
                pick(i);
              }}
              onMouseEnter={() => setActive(idx)}
              className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 ${
                idx === active ? 'bg-blue-600 text-white' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
            >
              <span className="w-24 shrink-0 font-mono text-xs font-semibold">{i.symbol}</span>
              <span className={`min-w-0 flex-1 truncate text-xs ${idx === active ? 'text-blue-100' : 'text-zinc-500'}`}>
                {i.name}
              </span>
              <Badge tone={seriesTone(i.series)}>{i.series}</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Chips for the chosen symbols plus a search box that appends to them. */
export function InstrumentMultiSelect({
  value,
  onChange,
  extras,
  placeholder = 'Add a symbol…',
  max,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  extras?: Instrument[];
  placeholder?: string;
  max?: number;
}) {
  const full = max != null && value.length >= max;
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {value.length === 0 && <span className="text-xs text-zinc-400">No symbols chosen yet.</span>}
        {value.map((sym) => (
          <span
            key={sym}
            className="inline-flex items-center gap-1 rounded-full bg-blue-600 py-1 pl-2.5 pr-1.5 text-xs font-medium text-white"
          >
            {sym}
            <button
              type="button"
              aria-label={`Remove ${sym}`}
              onClick={() => onChange(value.filter((s) => s !== sym))}
              className="rounded-full px-1 leading-none hover:bg-blue-500"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <InstrumentSearch
        onSelect={(i) => {
          if (!value.includes(i.symbol)) onChange([...value, i.symbol]);
        }}
        exclude={value}
        extras={extras}
        placeholder={full ? `At most ${max} symbols` : placeholder}
        disabled={full}
      />
    </div>
  );
}
