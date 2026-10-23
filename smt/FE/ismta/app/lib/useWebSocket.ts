'use client';

import { useEffect, useRef, useState } from 'react';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:4000/ws';

export interface WsMessage {
  /** `notice` is a one-off system message (halt, reconciliation mismatch) shown as a toast. */
  type: 'tick' | 'signal' | 'trade' | 'order' | 'snapshot' | 'notice';
  data: unknown;
  ts?: number;
}

/**
 * Subscribes to the backend WebSocket and invokes `onMessage` for each event.
 * Auto-reconnects with a fixed backoff. Returns the live connection status.
 */
export function useWebSocket(onMessage: (msg: WsMessage) => void): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const cbRef = useRef(onMessage);
  // Written in an effect, not during render (react-hooks/refs): the socket
  // effect below never re-runs, so it reads the latest callback through here.
  useEffect(() => {
    cbRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let attempt = 0;

    const connect = () => {
      if (closed) return;
      // Don't bother (re)connecting while the tab is hidden — resume on focus.
      if (typeof document !== 'undefined' && document.hidden) return;

      // The server refuses an upgrade without a valid token (browsers cannot
      // set headers on a WebSocket, so it rides in the query string).
      let token: string | null = null;
      try {
        token = localStorage.getItem('ismta_token');
      } catch {
        token = null;
      }
      if (!token) {
        // Not logged in yet — try again shortly rather than burn a 401.
        retry = setTimeout(connect, 1500);
        return;
      }
      ws = new WebSocket(`${WS_URL}${WS_URL.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`);
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        // Exponential backoff capped at 15s (avoids reconnect storms).
        const delay = Math.min(1000 * 2 ** attempt++, 15000);
        retry = setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
      ws.onmessage = (ev) => {
        try {
          cbRef.current(JSON.parse(ev.data) as WsMessage);
        } catch {
          /* ignore malformed frames */
        }
      };
    };

    const onVisible = () => {
      if (!closed && document.visibilityState === 'visible' && ws?.readyState !== WebSocket.OPEN) {
        if (retry) clearTimeout(retry);
        attempt = 0;
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      document.removeEventListener('visibilitychange', onVisible);
      ws?.close();
    };
  }, []);

  return { connected };
}
