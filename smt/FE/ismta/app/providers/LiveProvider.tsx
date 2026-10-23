'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { Notice } from '../lib/types';
import { useWebSocket, WsMessage } from '../lib/useWebSocket';
import { useSystem } from './SystemProvider';
import { useToast } from './ToastProvider';

export interface LiveEvent {
  id: string;
  kind: 'signal' | 'trade' | 'order';
  text: string;
  tone: 'green' | 'red' | 'blue' | 'neutral';
  ts: number;
}

interface LiveState {
  connected: boolean;
  quotes: Record<string, number>;
  events: LiveEvent[];
}

// A per-symbol tick ring (`history`) used to live here too, held in a ref and
// handed out through the context. Nothing read it, and exposing a mutable ref
// through render is exactly what `react-hooks/refs` forbids. Gone.
const LiveContext = createContext<LiveState>({
  connected: false,
  quotes: {},
  events: [],
});

const MAX_EVENTS = 40;

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const [quotes, setQuotes] = useState<Record<string, number>>({});
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const seq = useRef(0);
  const { push: pushToast } = useToast();
  const { refresh: refreshSystem } = useSystem();

  const pushEvent = useCallback((kind: LiveEvent['kind'], text: string, tone: LiveEvent['tone']) => {
    seq.current += 1;
    const now = Date.now();
    const ev: LiveEvent = { id: `${now}-${seq.current}`, kind, text, tone, ts: now };
    setEvents((prev) => [ev, ...prev].slice(0, MAX_EVENTS));
  }, []);

  const onMessage = useCallback(
    (msg: WsMessage) => {
      if (msg.type === 'tick') {
        const tick = msg.data as { symbol: string; ltp: number; timestamp: number };
        setQuotes((q) => (q[tick.symbol] === tick.ltp ? q : { ...q, [tick.symbol]: tick.ltp }));
      } else if (msg.type === 'snapshot') {
        const arr = msg.data as { symbol: string; ltp: number }[];
        setQuotes(Object.fromEntries(arr.map((q) => [q.symbol, q.ltp])));
      } else if (msg.type === 'signal') {
        const s = msg.data as { action: string; symbol: string; reason: string; acted: boolean };
        if (s.action === 'HOLD') return;
        pushEvent(
          'signal',
          `${s.action} signal · ${s.symbol} — ${s.reason}${s.acted ? ' (executed)' : ''}`,
          s.action === 'BUY' ? 'green' : 'red',
        );
      } else if (msg.type === 'trade') {
        const t = msg.data as { event: string; trade: { symbol: string; side: string; pnl: number } };
        if (t.event === 'opened') {
          pushEvent('trade', `Opened ${t.trade.side} ${t.trade.symbol}`, 'blue');
        } else {
          pushEvent(
            'trade',
            `Closed ${t.trade.symbol} · P&L ${t.trade.pnl.toFixed(2)}`,
            t.trade.pnl >= 0 ? 'green' : 'red',
          );
        }
      } else if (msg.type === 'order') {
        const o = msg.data as { event: string; reason?: string };
        if (o.event === 'rejected') pushEvent('order', `Order rejected — ${o.reason}`, 'neutral');
      } else if (msg.type === 'notice') {
        const n = msg.data as Partial<Notice>;
        const level = n.level === 'critical' || n.level === 'warn' ? n.level : 'info';
        pushToast(level, String(n.text ?? ''));
        // A halt or a reconciliation mismatch changes the system status;
        // do not make the top bar wait for the 30 s poll.
        if (level !== 'info') refreshSystem();
      }
    },
    [pushEvent, pushToast, refreshSystem],
  );

  const { connected } = useWebSocket(onMessage);

  const value = useMemo<LiveState>(() => ({ connected, quotes, events }), [connected, quotes, events]);

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveState {
  return useContext(LiveContext);
}
