/**
 * Your book's exposure to a market fall. Pure.
 *
 * The one per-stock number that held up in the research is DOWNSIDE BETA: how
 * much a stock moved on the index's down days. FMCG sat near 0.5, PSU banks
 * near 1.3. So "if NIFTY falls 10%, what does my book do" is answered as the
 * value-weighted down-day beta of the holdings, times −10%. It is an estimate
 * from two years of daily history, not a promise, and is labelled that way.
 *
 * IT IS CONDITIONALLY DEFENSIVE. It held up in 10 of 11 past falls because a
 * falling rupee helps an exporter — but in 2022 and in the 2026 AI scare it was
 * the thing falling. So IT counts as defensive only when no active shock is
 * US-, rates- or AI-driven.
 */
import type { EventLabel } from './events';
import { splitBeta } from './sectors';
import type { Series } from './series';
import { alignTo } from './series';

export const DEFENSIVE_SECTORS = ['Fast Moving Consumer Goods', 'Healthcare', 'Telecommunication'];
export const CONDITIONAL_DEFENSIVE = 'Information Technology';
/** Shocks under which IT stops being a haven. */
const IT_HOSTILE: EventLabel[] = ['global-financial', 'sector-disruption', 'rates'];
const GOLD_SYMBOLS = new Set(['GOLDBEES', 'GOLDIETF', 'GOLD1', 'HDFCGOLD', 'SBIGOLD', 'AXISGOLD', 'GOLDCASE']);
/** Two years of trading days. */
export const BETA_WINDOW = 504;
const MIN_BETA_DAYS = 120;

export interface Holding {
  symbol: string;
  quantity: number;
  price: number;
}

export interface HoldingExposure {
  symbol: string;
  value: number;
  weight: number;
  sector: string;
  downBeta: number | null;
  /** Estimated move if the index falls 10%, percent. */
  ifIndexMinus10Pct: number | null;
  defensive: boolean;
}

export interface BookExposure {
  totalValue: number;
  /** Value-weighted down-day beta of the holdings that have one. */
  downBeta: number | null;
  ifIndexMinus10Pct: number | null;
  /** Share of value in defensive sectors and gold. */
  defensiveShare: number;
  /** Share of value with a measured beta. */
  coverage: number;
  holdings: HoldingExposure[];
  bySector: { sector: string; weight: number }[];
  itDefensive: boolean;
}

export function isDefensive(symbol: string, sector: string, activeShocks: EventLabel[]): boolean {
  if (GOLD_SYMBOLS.has(symbol.toUpperCase())) return true;
  if (DEFENSIVE_SECTORS.includes(sector)) return true;
  if (sector === CONDITIONAL_DEFENSIVE) return !activeShocks.some((s) => IT_HOSTILE.includes(s));
  return false;
}

/** Down-day beta of a stock against the index over the last `window` index days. */
export function downBetaOf(index: Series, stock: Series | undefined, window = BETA_WINDOW): number | null {
  if (!stock) return null;
  const n = index.dates.length;
  const from = Math.max(1, n - window);
  const y = alignTo(index.dates, stock, false, 4);
  let have = 0;
  for (let i = from; i < n; i++) if (y[i] != null && y[i - 1] != null) have++;
  if (have < MIN_BETA_DAYS) return null;
  return splitBeta(index.close, y, from).down;
}

export function bookExposure(
  holdings: Holding[],
  betaOf: (symbol: string) => number | null,
  sectorOf: (symbol: string) => string,
  activeShocks: EventLabel[] = [],
): BookExposure {
  const rows = holdings.filter((h) => h.quantity > 0 && h.price > 0);
  const total = rows.reduce((s, h) => s + h.quantity * h.price, 0);
  const itDefensive = !activeShocks.some((s) => IT_HOSTILE.includes(s));
  const out: HoldingExposure[] = rows.map((h) => {
    const value = h.quantity * h.price;
    const sector = sectorOf(h.symbol);
    const b = betaOf(h.symbol);
    return {
      symbol: h.symbol,
      value: Math.round(value),
      weight: total ? value / total : 0,
      sector,
      downBeta: b,
      ifIndexMinus10Pct: b == null ? null : Math.round(-10 * b * 10) / 10,
      defensive: isDefensive(h.symbol, sector, activeShocks),
    };
  });
  const measured = out.filter((h) => h.downBeta != null);
  const mw = measured.reduce((s, h) => s + h.weight, 0);
  const beta = mw > 0 ? measured.reduce((s, h) => s + h.weight * h.downBeta!, 0) / mw : null;
  const bySector = new Map<string, number>();
  for (const h of out) bySector.set(h.sector, (bySector.get(h.sector) ?? 0) + h.weight);
  return {
    totalValue: Math.round(total),
    downBeta: beta == null ? null : Math.round(beta * 100) / 100,
    ifIndexMinus10Pct: beta == null ? null : Math.round(-10 * beta * 10) / 10,
    defensiveShare: out.filter((h) => h.defensive).reduce((s, h) => s + h.weight, 0),
    coverage: mw,
    holdings: out.sort((a, b) => (a.ifIndexMinus10Pct ?? 0) - (b.ifIndexMinus10Pct ?? 0)),
    bySector: [...bySector].map(([sector, weight]) => ({ sector, weight })).sort((a, b) => b.weight - a.weight),
    itDefensive,
  };
}
