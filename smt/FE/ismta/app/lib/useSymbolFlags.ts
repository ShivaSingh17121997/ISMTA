'use client';

/**
 * Per-symbol warnings the order ticket and the stock table show before a
 * trade: surveillance stage (ASM/GSM/ESM), trade-for-trade series, and an
 * upcoming corporate event (ex-date, record date, results) inside a few days.
 *
 * Read from the backend's market-events module (NSE ASM/GSM/ESM lists and the
 * board-meeting calendar), refreshed every ten minutes.
 */
import { api } from './api';
import { usePolling } from './usePolling';

export interface SymbolEvent {
  kind: 'ex-date' | 'record' | 'results' | 'agm' | 'buyback' | 'other';
  /** YYYY-MM-DD */
  date: string;
  detail: string;
}

export interface SymbolFlags {
  symbol: string;
  series?: string;
  asm?: string;
  gsm?: string;
  esm?: string;
  priceBandPct?: number;
  upcoming: SymbolEvent[];
  /** one-line warnings, ready to show */
  warnings: string[];
  loading: boolean;
}

const EMPTY = (symbol: string): SymbolFlags => ({ symbol, upcoming: [], warnings: [], loading: false });

export function useSymbolFlags(symbol: string | null | undefined): SymbolFlags {
  const sym = (symbol ?? '').trim().toUpperCase();
  const state = usePolling(() => (sym ? api.symbolFlags(sym) : Promise.resolve(null)), 10 * 60_000);
  const d = state.data;
  if (!sym) return EMPTY('');
  if (!d || d.symbol !== sym) return { ...EMPTY(sym), loading: state.loading };
  return {
    symbol: sym,
    ...(d.asm ? { asm: d.asm } : {}),
    ...(d.gsm ? { gsm: d.gsm } : {}),
    ...(d.esm ? { esm: d.esm } : {}),
    upcoming: d.upcoming.map((e) => ({ kind: e.kind, date: e.date, detail: e.detail })),
    warnings: d.warnings,
    loading: false,
  };
}
