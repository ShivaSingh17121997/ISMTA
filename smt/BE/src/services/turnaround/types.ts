/**
 * Turnaround candidates — the shapes the engine hands to the interface.
 *
 * Deliberately a different entry plan from the future-stars category. A future
 * star has no natural stop: it is a multi-year hold through drawdowns that
 * would take out any sensible level, so the honest risk number there is "what
 * it costs if the thesis breaks". A turnaround is the opposite — the base it is
 * bought on IS the level, and if the stock loses it, the reason for buying has
 * gone. That makes real risk-based sizing possible here, and it is used.
 */
import { PillarScore, RiskFlag } from '../futurestars/types';
import type { Growth } from '../futurestars/types';
import type { Shareholding } from '../futurestars/shareholding';
import type { TurnPrice, TurnVerdict } from './score';

export interface TurnEntry {
  /** the level that confirms the base has held */
  trigger: string;
  triggerPrice: number | null;
  /** below this the base has failed and the reason for owning it is gone */
  stop: number;
  stopDistancePct: number;
  /** rupees committed if the trigger fires */
  amount: number;
  quantity: number;
  pctOfCapital: number;
  riskAmount: number;
  /** how long the thesis gets before it is abandoned for going nowhere */
  timeStop: string;
  /** the next filing that can confirm or kill it */
  nextCheck: string;
  holdLabel: string;
  warnings: string[];
}

export interface Turnaround {
  rank: number;
  symbol: string;
  name: string;
  sector: string;
  themes: string[];
  score: number;
  verdict: TurnVerdict;
  funded: boolean;
  /** what fell, what did not, and what would confirm it */
  thesis: string;
  pillars: PillarScore[];
  growth: Growth;
  shareholding: Shareholding;
  risks: RiskFlag[];
  entry: TurnEntry;
  price: TurnPrice;
}

export interface TurnaroundRun {
  at: number;
  tradingDay: string;
  capital: number;
  universeSize: number;
  measured: number;
  scored: number;
  candidates: Turnaround[];
  rejected: { symbol: string; name: string; reason: string }[];
  skipped: { symbol: string; reason: string }[];
  totalIfAllTriggered: number;
  categoryCapPct: number;
  concentration: {
    fundedCount: number;
    recommendedMinimum: number;
    tooConcentrated: boolean;
    note: string;
  };
  sources: string;
  evidence: string;
  disclaimer: string;
}
