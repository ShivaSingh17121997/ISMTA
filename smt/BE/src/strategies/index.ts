import { BaseStrategy } from './BaseStrategy';
import { BreakoutStrategy } from './BreakoutStrategy';
import { MACrossoverStrategy } from './MACrossoverStrategy';
import { MeanReversionStrategy } from './MeanReversionStrategy';
import { MLEnsembleStrategy } from './MLEnsembleStrategy';
import { MomentumStrategy } from './MomentumStrategy';
import { NtbBreakoutStrategy } from './NtbBreakoutStrategy';
import { NtbMeanRevStrategy } from './NtbMeanRevStrategy';
import { NtbPullbackStrategy } from './NtbPullbackStrategy';
import { SupertrendStrategy } from './SupertrendStrategy';
import { VWAPStrategy } from './VWAPStrategy';

const registry: Record<string, BaseStrategy> = {
  MA_CROSSOVER: new MACrossoverStrategy(),
  MOMENTUM: new MomentumStrategy(),
  MEAN_REVERSION: new MeanReversionStrategy(),
  BREAKOUT: new BreakoutStrategy(),
  VWAP: new VWAPStrategy(),
  SUPERTREND: new SupertrendStrategy(),
  ML_ENSEMBLE: new MLEnsembleStrategy(),
  // NTB port — these three share one exit engine (the trailing stop); the entry
  // is the only thing that varies between them.
  NTB_BREAKOUT: new NtbBreakoutStrategy(),
  NTB_PULLBACK: new NtbPullbackStrategy(),
  NTB_MEANREV: new NtbMeanRevStrategy(),
};

export function getStrategy(type: string): BaseStrategy | undefined {
  return registry[type];
}

export function listStrategyTypes(): { type: string; defaultParams: Record<string, number> }[] {
  return Object.values(registry).map((s) => ({ type: s.type, defaultParams: s.defaultParams }));
}

export { BaseStrategy } from './BaseStrategy';
export type { StrategyContext } from './BaseStrategy';
