import http from 'http';
import jwt from 'jsonwebtoken';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from '../config';
import { marketData } from './MarketDataService';
import { orderManager } from './OrderManager';
import { strategyEngine } from './StrategyEngine';
import { logger } from '../utils/logger';

/**
 * Broadcasts real-time events to connected dashboards over WebSocket:
 *  - `tick`         price updates
 *  - `signal`       new strategy signals
 *  - `trade`        trade opened/closed
 *  - `order`        order filled/rejected
 *
 * AUTHENTICATED. The socket carries every fill and every signal, and it used to
 * accept any connection at all. The client passes its JWT as `?token=` on the
 * upgrade request (browsers cannot set headers on a WebSocket); anything else
 * is refused before the upgrade completes.
 */
/** A WebSocket augmented with a liveness flag for the heartbeat. */
type LiveSocket = WebSocket & { isAlive?: boolean; userId?: string };

export class WebSocketManager {
  private wss: WebSocketServer | null = null;
  private heartbeat: NodeJS.Timeout | null = null;

  attach(server: http.Server): void {
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
      verifyClient: (info, done) => {
        const userId = this.userFromRequest(info.req);
        if (!userId) {
          logger.debug('WS upgrade refused: missing or invalid token');
          done(false, 401, 'Unauthorized');
          return;
        }
        (info.req as http.IncomingMessage & { userId?: string }).userId = userId;
        done(true);
      },
    });

    this.wss.on('connection', (ws: LiveSocket, req: http.IncomingMessage & { userId?: string }) => {
      ws.isAlive = true;
      ws.userId = req.userId;
      ws.on('pong', () => (ws.isAlive = true)); // browser auto-replies to ping frames
      logger.debug(`WS client connected (${ws.userId})`);
      ws.send(JSON.stringify({ type: 'snapshot', data: marketData.getAllPrices() }));
      ws.on('close', () => logger.debug('WS client disconnected'));
      ws.on('error', (e) => logger.debug(`WS client error: ${e.message}`));
    });

    // Heartbeat: drop zombie sockets and keep healthy ones alive through proxies.
    this.heartbeat = setInterval(() => {
      this.wss?.clients.forEach((c) => {
        const ws = c as LiveSocket;
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
      });
    }, 30_000);
    this.wss.on('close', () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
    });

    marketData.on('tick', (tick) => this.broadcast('tick', tick));
    strategyEngine.on('signal', (sig) => this.broadcast('signal', sig));
    // Orders and trades belong to one user. With real accounts connected, another
    // user's fills are their private financial data, not a dashboard feed.
    orderManager.on('trade:opened', (t) => this.sendToUser(t?.userId, 'trade', { event: 'opened', trade: t }));
    orderManager.on('trade:closed', (t) => this.sendToUser(t?.userId, 'trade', { event: 'closed', trade: t }));
    orderManager.on('order:filled', (o) => this.sendToUser(o?.userId, 'order', { event: 'filled', order: o }));
    orderManager.on('order:rejected', (r) => this.sendToUser(r?.req?.userId, 'order', { event: 'rejected', ...r }));

    logger.info('WebSocketManager attached at /ws (token required)');
  }

  /** The user behind an upgrade request, or null. Token in `?token=` or a Bearer header. */
  private userFromRequest(req: http.IncomingMessage): string | null {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const header = req.headers.authorization;
      const token = url.searchParams.get('token') ?? (header?.startsWith('Bearer ') ? header.slice(7) : null);
      if (!token) return null;
      const payload = jwt.verify(token, config.jwt.secret) as jwt.JwtPayload;
      return typeof payload.sub === 'string' ? payload.sub : null;
    } catch {
      return null;
    }
  }

  broadcast(type: string, data: unknown): void {
    if (!this.wss) return;
    const payload = JSON.stringify({ type, data, ts: Date.now() });
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  /** Send to one user's sockets only. An event with no owner goes to everyone, as before. */
  sendToUser(userId: string | undefined, type: string, data: unknown): void {
    if (!userId) return this.broadcast(type, data);
    if (!this.wss) return;
    const payload = JSON.stringify({ type, data, ts: Date.now() });
    for (const client of this.wss.clients) {
      const ws = client as LiveSocket;
      if (ws.userId === userId && ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  /** Push a one-off notice (halt, reconciliation mismatch) to every dashboard. */
  notice(level: 'info' | 'warn' | 'critical', text: string): void {
    this.broadcast('notice', { level, text });
  }
}

export const wsManager = new WebSocketManager();
