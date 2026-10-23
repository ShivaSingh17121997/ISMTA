/**
 * The ONE resolver for the trailing engine's parameters.
 *
 * Both the live path (OrderManager.manageTrailing) and the backtester call this,
 * with the same precedence: strategy params override env config. Two separate
 * resolvers is how `optimize()` ends up recommending a `trailPct` that live
 * trading silently ignores — which would undercut the port's central claim that
 * the identical engine runs in both.
 */
import { brokerFor } from '../brokers/registry';
import { config } from '../config';
import { TrailingConfig } from '../strategies/trailingStop';
import { roundStopToTick } from './nse';

function pick(params: Record<string, number> | undefined, key: string, fallback: number): number {
  const v = params?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * @param params  the StrategyConfig's params (per-strategy override)
 * @param allowDca pass false to force DCA off regardless of config — the
 *   backtester does this, since it cannot model a multi-leg averaged position.
 */
export function resolveTrailingConfig(
  params?: Record<string, number>,
  allowDca = true,
): TrailingConfig {
  return {
    activationPct: pick(params, 'activationPct', config.ntb.activationPct),
    trailPct: pick(params, 'trailPct', config.ntb.trailPct),
    stopLossPct: pick(params, 'stopLossPct', config.ntb.stopLossPct),
    takeProfitPct: pick(params, 'takeProfitPct', config.ntb.takeProfitPct),
    dca: {
      enabled: allowDca && config.ntb.dca.enabled,
      maxSafetyOrders: pick(params, 'dcaMaxSafetyOrders', config.ntb.dca.maxSafetyOrders),
      deviationPct: pick(params, 'dcaDeviationPct', config.ntb.dca.deviationPct),
      stepScale: pick(params, 'dcaStepScale', config.ntb.dca.stepScale),
      volumeScale: pick(params, 'dcaVolumeScale', config.ntb.dca.volumeScale),
      finalStopPct: pick(params, 'dcaFinalStopPct', config.ntb.dca.finalStopPct),
    },
    // Every protection level lands on the NSE tick grid, widening rather than
    // tightening — so it is placeable as a real SL-M and the backtest models
    // where a real stop would actually sit.
    roundStop: roundStopToTick,
  };
}

/**
 * Can we honestly claim a stop filled at its level when we have no candle context?
 *
 * True in paper/backtest (the engine controls the fill), and true live only when
 * a real exchange stop order was actually placed. ZerodhaBroker does not place
 * SL-M orders today, so this is false in live — and the fill falls back to the
 * observed price rather than a flattering fiction.
 */
export function assumeRestingStop(userId?: string): boolean {
  return brokerFor(userId).name === 'paper' || config.ntb.useExchangeStop;
}
