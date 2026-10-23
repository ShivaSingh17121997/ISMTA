/**
 * Stock by stock: which names to be careful with in TODAY's conditions, and
 * which have tended to hold up better. Pure.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. A per-stock "it is too high, it will fall"
 * call was measured on this universe and lost money (WARNING_ENGINE.md): hot
 * stocks kept outperforming. So nothing here looks at "too high". Each stock is
 * scored only on things with evidence behind them, and every point carries a
 * plain-words reason:
 *
 *   - DOWN-DAY BETA: how much it moved on NIFTY's down days. A 1.3 means a 10%
 *     index fall has typically meant about 13% for this stock. Measured,
 *     stable, and the thing that decides how a fall feels.
 *   - 12-MONTH TREND (skipping the last month): momentum persists, so the
 *     weakest names have tended to stay weak. Same definition as the
 *     recommender's best-evidenced signal.
 *   - LONG-TERM TREND: below its own 200-day average.
 *   - SECTOR RECORD: how often its NSE industry beat the index in past falls.
 *   - TODAY'S NEWS TYPE: whether the active shock type usually hit or helped it
 *     on impact (events.ts EVENT_IMPACT).
 *   - NSE SURVEILLANCE: the exchange has flagged it (ASM / GSM / ESM).
 *
 * These are risk TAGS, not forecasts. A "careful" stock can still rise; high
 * down-day beta stocks also led past rebounds. The lists answer one question:
 * if the market falls further from here, which names have tended to hurt more,
 * and which less.
 */
import type { Surveillance } from '../accumulator/events';
import type { Calibration } from './calibrate';
import { EVENT_IMPACT, type EventLabel } from './events';
import { downBetaOf } from './exposure';
import type { Series } from './series';

export interface StockInput {
  symbol: string;
  sector: string;
  series: Series | undefined;
  surveillance?: Surveillance;
  held: boolean;
}

export interface Tag {
  /** + adds risk, − reduces it. */
  points: number;
  text: string;
}

export interface StockCall {
  symbol: string;
  sector: string;
  held: boolean;
  /** Higher = more care needed in today's conditions. */
  score: number;
  downBeta: number | null;
  /** Estimated move if NIFTY falls 10%, percent. */
  ifIndexMinus10Pct: number | null;
  /** 12-month return skipping the last month, as a fraction. */
  trend12m: number | null;
  belowLongTrend: boolean | null;
  tags: Tag[];
}

export interface StockCalls {
  careful: StockCall[];
  resilient: StockCall[];
  /** Stocks scored (enough history). */
  scored: number;
  activeEvents: EventLabel[];
}

export const LIST_SIZE = 10;
const CAREFUL_MIN = 3;
const RESILIENT_MAX = -2;

const pct0 = (x: number): string => `${Math.round(Math.abs(x) * 100)}%`;

function trendOf(s: Series): { m12: number | null; below200: boolean | null } {
  const c = s.close;
  const n = c.length;
  const m12 = n > 253 ? c[n - 22] / c[n - 253] - 1 : null;
  let below: boolean | null = null;
  if (n >= 200) {
    let sum = 0;
    for (let i = n - 200; i < n; i++) sum += c[i];
    below = c[n - 1] < sum / 200;
  }
  return { m12, below200: below };
}

export function scoreStocks(index: Series, inputs: StockInput[], cal: Calibration, active: EventLabel[]): StockCalls {
  const sectorRec = new Map((cal.sectors ?? []).map((s) => [s.sector, s.inFall] as const));
  // Trend ranks are relative to this universe, so "weak" means weak among peers.
  const base = inputs
    .filter((x) => x.series && x.series.close.length > 260)
    .map((x) => ({ x, beta: downBetaOf(index, x.series), ...trendOf(x.series!) }));
  const moms = base.map((b) => b.m12).filter((m): m is number => m != null).sort((a, b) => a - b);
  const rankOf = (m: number): number => moms.filter((v) => v < m).length / Math.max(1, moms.length);

  const calls: StockCall[] = base.map(({ x, beta, m12, below200 }) => {
    const tags: Tag[] = [];
    if (beta != null) {
      const ex = `If NIFTY falls 10%, it has typically fallen about ${(beta * 10).toFixed(0)}%.`;
      if (beta >= 1.2) tags.push({ points: 2, text: `Falls harder than the market (down-day beta ${beta.toFixed(2)}). ${ex}` });
      else if (beta >= 1.0) tags.push({ points: 1, text: `Falls about as much as the market or more (down-day beta ${beta.toFixed(2)}). ${ex}` });
      else if (beta <= 0.7) tags.push({ points: -2, text: `Falls much less than the market (down-day beta ${beta.toFixed(2)}). ${ex}` });
      else if (beta <= 0.85) tags.push({ points: -1, text: `Falls a bit less than the market (down-day beta ${beta.toFixed(2)}). ${ex}` });
    }
    if (m12 != null && moms.length >= 10) {
      const r = rankOf(m12);
      const move = `${m12 >= 0 ? 'up' : 'down'} ${pct0(m12)} over the past year (leaving out the last month)`;
      if (r <= 0.2) tags.push({ points: 2, text: `Weak trend: ${move}, weaker than ${Math.round((1 - r) * 100)}% of these stocks. Weak stocks have tended to stay weak.` });
      else if (r >= 0.8) tags.push({ points: -2, text: `Strong trend: ${move}, stronger than ${Math.round(r * 100)}% of these stocks. Strong stocks have tended to stay strong.` });
    }
    if (below200 === true) tags.push({ points: 1, text: 'Its price is below its own 200-day average, so its long-term trend is down.' });
    const rec = sectorRec.get(x.sector);
    if (rec && rec.n >= 5) {
      const share = rec.beat / rec.n;
      if (share <= 0.35) tags.push({ points: 1, text: `Its sector (${x.sector}) beat the index in only ${rec.beat} of ${rec.n} past falls.` });
      else if (share >= 0.7) tags.push({ points: -1, text: `Its sector (${x.sector}) beat the index in ${rec.beat} of ${rec.n} past falls.` });
    }
    // News counts ONCE per side, however many labels fire: today's war, oil
    // spike and rupee slide are one shock seen three ways, not three shocks.
    const hits: string[] = [];
    const helps: string[] = [];
    for (const label of active) {
      const imp = EVENT_IMPACT[label];
      if (!imp) continue;
      const matches = (i?: { symbols: string[]; industries: string[] }): boolean =>
        !!i && (i.symbols.includes(x.symbol) || i.industries.includes(x.sector));
      const name = label.replace(/-/g, ' ');
      if (matches(imp.hit) && !hits.some((h) => h.endsWith(imp.hit!.why))) hits.push(`${name}: ${imp.hit!.why}`);
      if (matches(imp.held) && !helps.some((h) => h.endsWith(imp.held!.why))) helps.push(`${name}: ${imp.held!.why}`);
    }
    if (hits.length) tags.push({ points: 2, text: `Today's news has usually hit stocks like this on impact (${hits.join('; ')}).` });
    if (helps.length) tags.push({ points: -2, text: `Today's news has usually helped stocks like this (${helps.join('; ')}).` });
    const sv = x.surveillance;
    if (sv && (sv.asm || sv.gsm || sv.esm)) {
      const which = [sv.asm && `ASM ${sv.asm}`, sv.gsm && `GSM ${sv.gsm}`, sv.esm && `ESM ${sv.esm}`].filter(Boolean).join(', ');
      tags.push({ points: 3, text: `NSE has it under surveillance (${which}): the exchange has flagged unusual price moves or weak finances.` });
    }
    return {
      symbol: x.symbol,
      sector: x.sector,
      held: x.held,
      score: tags.reduce((s, t) => s + t.points, 0),
      downBeta: beta,
      ifIndexMinus10Pct: beta == null ? null : Math.round(-10 * beta * 10) / 10,
      trend12m: m12,
      belowLongTrend: below200,
      tags: tags.sort((a, b) => Math.abs(b.points) - Math.abs(a.points)),
    };
  });

  const careful = calls
    .filter((c) => c.score >= CAREFUL_MIN)
    .sort((a, b) => b.score - a.score || (b.downBeta ?? 0) - (a.downBeta ?? 0))
    .slice(0, LIST_SIZE);
  const resilient = calls
    .filter((c) => c.score <= RESILIENT_MAX && !c.tags.some((t) => t.points >= 3))
    .sort((a, b) => a.score - b.score || (a.downBeta ?? 9) - (b.downBeta ?? 9))
    .slice(0, LIST_SIZE);
  // Holdings the user owns that land on the careful side but outside the top ten still deserve a mention.
  for (const c of calls) {
    if (c.held && c.score >= CAREFUL_MIN && !careful.includes(c)) careful.push(c);
  }
  return { careful, resilient, scored: calls.length, activeEvents: active };
}
