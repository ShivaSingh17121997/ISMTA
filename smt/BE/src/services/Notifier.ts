/**
 * Push alerts. Telegram first, because a bot token and a chat id are the whole
 * setup and it reaches a phone with no app store involved.
 *
 * Unconfigured, every alert is logged and nothing is sent — so the call sites
 * can fire unconditionally. Messages are coalesced: repeated alerts with the
 * same key inside `quietMs` are counted, not resent, so a flapping feed does
 * not produce a hundred pings.
 */
import { config } from '../config';
import { logger } from '../utils/logger';

export type AlertLevel = 'info' | 'warn' | 'critical';

interface Pending {
  count: number;
  timer: NodeJS.Timeout;
}

class Notifier {
  private lastSent = new Map<string, number>();
  private pending = new Map<string, Pending>();
  private sentCount = 0;
  private failures = 0;
  private lastError: string | null = null;

  get configured(): boolean {
    return !!(config.telegram.botToken && config.telegram.chatId);
  }

  /**
   * @param key   dedupe key — repeats within `quietMs` are folded into one message
   * @param text  the message; keep it short, it lands on a phone
   */
  async alert(level: AlertLevel, key: string, text: string, quietMs = 5 * 60_000): Promise<void> {
    const line = `${level === 'critical' ? '🚨' : level === 'warn' ? '⚠️' : 'ℹ️'} ${text}`;
    logger.log(level === 'critical' ? 'error' : level === 'warn' ? 'warn' : 'info', `[alert:${key}] ${text}`);
    if (!this.configured) return;

    const now = Date.now();
    const last = this.lastSent.get(key) ?? 0;
    if (now - last < quietMs) {
      const p = this.pending.get(key);
      if (p) {
        p.count += 1;
      } else {
        const timer = setTimeout(() => {
          const q = this.pending.get(key);
          this.pending.delete(key);
          if (q) void this.send(`${line}\n(and ${q.count} more like it in the last ${Math.round(quietMs / 60_000)} min)`);
        }, quietMs - (now - last));
        timer.unref?.();
        this.pending.set(key, { count: 1, timer });
      }
      return;
    }
    this.lastSent.set(key, now);
    await this.send(line);
  }

  /** Free-form message with no dedupe — daily summaries and the like. */
  async send(text: string): Promise<boolean> {
    if (!this.configured) return false;
    const url = `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: config.telegram.chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
      this.sentCount += 1;
      this.lastError = null;
      return true;
    } catch (e) {
      this.failures += 1;
      this.lastError = e instanceof Error ? e.message : String(e);
      logger.warn(`Telegram send failed: ${this.lastError}`);
      return false;
    }
  }

  status(): { configured: boolean; sent: number; failures: number; lastError: string | null } {
    return { configured: this.configured, sent: this.sentCount, failures: this.failures, lastError: this.lastError };
  }
}

export const notifier = new Notifier();
