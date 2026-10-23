/**
 * Pre-trade guards that are about the SYSTEM rather than the trade: order-rate
 * limits, the broker's static-IP requirement, and a process-wide trading halt.
 *
 * Pure where it can be (the rate limiter takes an explicit clock) so it is
 * testable without timers. The IP check is the one thing here that talks to
 * the network, and it fails CLOSED: when the broker is live and the whitelisted
 * IP is configured, an unknown public IP halts orders rather than letting the
 * broker reject them one by one.
 *
 * Why the numbers: SEBI's retail-algo framework (effective for all brokers
 * 1 Apr 2026) registers any algo above 10 orders/second/exchange with the
 * exchange; below it a self-built tool for your own account needs no
 * registration. Kite additionally enforces 400 orders/minute and 5,000/day.
 */
import { anyLiveBroker } from '../brokers/registry';
import { config } from '../config';
import { logger } from '../utils/logger';
import { isMongoConnected } from '../store/db';
import { SystemStateModel } from '../store/models';

export interface RateVerdict {
  ok: boolean;
  reason?: string;
}

/** Sliding-window counters over 1 s, 1 min and 1 day. */
export class OrderRateLimiter {
  private stamps: number[] = [];

  constructor(
    private readonly perSecond: number,
    private readonly perMinute: number,
    private readonly perDay: number,
  ) {}

  /** Would an order sent at `now` be within every limit? Does not record it. */
  check(now: number = Date.now()): RateVerdict {
    this.prune(now);
    const inSecond = this.count(now - 1_000);
    const inMinute = this.count(now - 60_000);
    const inDay = this.stamps.length;
    if (this.perSecond > 0 && inSecond >= this.perSecond) {
      return { ok: false, reason: `order rate: ${inSecond} in the last second (limit ${this.perSecond}/s — above it SEBI requires the algo to be registered)` };
    }
    if (this.perMinute > 0 && inMinute >= this.perMinute) {
      return { ok: false, reason: `order rate: ${inMinute} in the last minute (broker limit ${this.perMinute}/min)` };
    }
    if (this.perDay > 0 && inDay >= this.perDay) {
      return { ok: false, reason: `order rate: ${inDay} today (broker limit ${this.perDay}/day)` };
    }
    return { ok: true };
  }

  /** Record an order sent at `now`. */
  record(now: number = Date.now()): void {
    this.stamps.push(now);
  }

  snapshot(now: number = Date.now()): { lastSecond: number; lastMinute: number; today: number } {
    this.prune(now);
    return { lastSecond: this.count(now - 1_000), lastMinute: this.count(now - 60_000), today: this.stamps.length };
  }

  private count(since: number): number {
    let n = 0;
    for (let i = this.stamps.length - 1; i >= 0 && this.stamps[i] > since; i--) n++;
    return n;
  }

  private prune(now: number): void {
    const dayAgo = now - 86_400_000;
    let i = 0;
    while (i < this.stamps.length && this.stamps[i] <= dayAgo) i++;
    if (i) this.stamps.splice(0, i);
  }
}

export const orderRateLimiter = new OrderRateLimiter(
  config.guards.ordersPerSecond,
  config.guards.ordersPerMinute,
  config.guards.ordersPerDay,
);

/**
 * Process-wide trading halt. Distinct from the per-user kill switch: this is
 * the system saying "I cannot trust my own environment" — wrong public IP,
 * feed dead, reconciliation mismatch — and it blocks EVERY order including
 * exits, because an exit sent from an unregistered IP is rejected anyway and
 * an exit against a dead feed fills at a price nobody saw.
 */
/**
 * Halts a person set by hand survive a restart; the automatic ones (static IP,
 * feed health) are re-derived by their own checks and must not be resurrected.
 */
const PERSISTED_HALTS = new Set(['manual']);

export class TradingHalt {
  private reasons = new Map<string, string>();

  /** `prefix` namespaces the stored documents; tests use their own. */
  constructor(private readonly prefix = 'halt:') {}

  set(key: string, reason: string): void {
    if (!this.reasons.has(key)) logger.error(`TRADING HALTED [${key}]: ${reason}`);
    this.reasons.set(key, reason);
    if (PERSISTED_HALTS.has(key)) this.persist(key, reason);
  }

  clear(key: string): void {
    if (this.reasons.delete(key)) logger.warn(`Trading halt cleared [${key}]`);
    if (PERSISTED_HALTS.has(key)) this.persist(key, null);
  }

  /** Re-engage halts a person left on before the last shutdown. Call once at boot, after Mongo connects. */
  async restore(): Promise<void> {
    if (!isMongoConnected()) return;
    const docs = await SystemStateModel.find({ _id: { $in: [...PERSISTED_HALTS].map((k) => `${this.prefix}${k}`) } }).lean();
    for (const d of docs) {
      const key = String(d._id).slice(this.prefix.length);
      const reason = String((d as { reason?: unknown }).reason ?? 'restored after restart');
      this.reasons.set(key, reason);
      logger.error(`TRADING HALTED [${key}] (restored after restart): ${reason}`);
    }
  }

  private persist(key: string, reason: string | null): void {
    if (!isMongoConnected()) return;
    const _id = `${this.prefix}${key}`;
    const op = reason === null
      ? SystemStateModel.deleteOne({ _id })
      : SystemStateModel.replaceOne({ _id }, { _id, reason, at: Date.now() }, { upsert: true });
    void op.exec().catch((e: unknown) => logger.error(`could not persist halt ${key}: ${e instanceof Error ? e.message : e}`));
  }

  get active(): boolean {
    return this.reasons.size > 0;
  }

  describe(): string {
    return [...this.reasons.entries()].map(([k, v]) => `${k}: ${v}`).join('; ');
  }

  list(): { key: string; reason: string }[] {
    return [...this.reasons.entries()].map(([key, reason]) => ({ key, reason }));
  }
}

export const tradingHalt = new TradingHalt();

/** Public IPv4 of this process, via two independent services. Null when both fail. */
export async function publicIp(timeoutMs = 5_000): Promise<string | null> {
  for (const url of ['https://api.ipify.org?format=json', 'https://ifconfig.me/ip']) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue;
      const text = (await res.text()).trim();
      const ip = text.startsWith('{') ? (JSON.parse(text) as { ip?: string }).ip ?? '' : text;
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/**
 * Compare the public IP with the broker-whitelisted one. Only meaningful for a
 * live broker with BROKER_STATIC_IP set; paper mode never halts on this.
 */
export async function checkStaticIp(): Promise<{ ok: boolean; ip: string | null; expected: string }> {
  const expected = config.guards.staticIp.trim();
  if (!anyLiveBroker() || !expected) return { ok: true, ip: null, expected };
  const ip = await publicIp();
  if (ip === expected) {
    tradingHalt.clear('static-ip');
    return { ok: true, ip, expected };
  }
  tradingHalt.set(
    'static-ip',
    ip
      ? `public IP ${ip} is not the whitelisted ${expected}; the broker will reject every order`
      : `could not determine the public IP; the whitelisted one is ${expected}`,
  );
  return { ok: false, ip, expected };
}
