import { NextFunction, Request, Response } from 'express';

/**
 * Fixed-window limiter keyed by client IP. In-memory: this is a single-process
 * app and the point is to make a password guess cost seconds, not to survive
 * a distributed attack.
 */
export function rateLimit(opts: { windowMs: number; max: number; message?: string }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    let h = hits.get(key);
    if (!h || h.resetAt <= now) {
      h = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, h);
    }
    h.count += 1;
    if (h.count > opts.max) {
      res.setHeader('Retry-After', String(Math.ceil((h.resetAt - now) / 1000)));
      res.status(429).json({ error: opts.message ?? 'Too many attempts. Try again shortly.' });
      return;
    }
    // Opportunistic cleanup so the map cannot grow without bound.
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    next();
  };
}
