import { v4 as uuid } from 'uuid';
import { config } from '../config';
import { marketData } from '../services/MarketDataService';
import { roundToTick } from '../services/nse';
import { OrderRequest } from '../types';
import { logger } from '../utils/logger';
import { BaseBroker, BrokerFunds, BrokerOrderResult } from './BaseBroker';

/**
 * Simulated broker. Fills MARKET orders instantly at the current LTP
 * (plus a small slippage) and LIMIT orders at the limit price. Requires
 * no credentials, so the entire platform runs end-to-end in paper mode.
 */
export class PaperBroker extends BaseBroker {
  readonly name = 'paper';
  private slippageBps: number;
  /**
   * Every fill this broker has produced, so `getOrder` can answer honestly
   * instead of re-deriving a price. Paper fills are instantaneous, so this is
   * a record of what happened rather than a poll of what might have.
   */
  private fills = new Map<string, BrokerOrderResult>();

  constructor(slippageBps = 2) {
    super();
    this.slippageBps = slippageBps;
  }

  isConnected(): boolean {
    return true;
  }

  getLtp(symbol: string): number {
    return marketData.getPrice(symbol);
  }

  async placeOrder(req: OrderRequest): Promise<BrokerOrderResult> {
    const ltp = this.getLtp(req.symbol);
    if (!ltp) {
      return {
        brokerOrderId: uuid(),
        status: 'REJECTED',
        filledQuantity: 0,
        rejectionReason: `No market data for ${req.symbol}`,
      };
    }

    let fillPrice: number;

    if (req.simulatedFillPrice != null && req.simulatedFillPrice > 0) {
      // The engine's stop-fill model (cappedStopFill) decided this price: a
      // resting stop fills at ITS LEVEL, not at the adverse extreme we happened
      // to observe. Honouring it here is what stops a 1% stop being booked as a
      // 6% loss. Live brokers ignore this — there the exchange decides.
      fillPrice = req.simulatedFillPrice;
    } else if (req.orderType === 'LIMIT' && req.price) {
      // A marketable limit trades at the market when the market is better —
      // a sell limit under the LTP fills at the LTP, a buy limit over it at the
      // LTP. Booking the limit instead understated every gap-up exit.
      fillPrice = req.side === 'SELL' ? Math.max(req.price, ltp) : Math.min(req.price, ltp);
    } else {
      fillPrice = ltp;
    }

    // Apply slippage against the trader for market orders. A price the engine
    // already modelled (simulatedFillPrice) is taken as final.
    if (req.orderType === 'MARKET' && req.simulatedFillPrice == null) {
      const slip = (this.slippageBps / 10000) * ltp;
      fillPrice = req.side === 'BUY' ? ltp + slip : ltp - slip;
    }

    // A real fill happens at a real tick, and the tick is a price-dependent
    // ladder on NSE (₹0.01 under ₹250 … ₹5 above ₹20,000). Rounding to 2dp
    // would invent prices the exchange cannot print.
    fillPrice = roundToTick(fillPrice);
    logger.debug(`PaperBroker fill: ${req.side} ${req.quantity} ${req.symbol} @ ${fillPrice}`);

    const result: BrokerOrderResult = {
      brokerOrderId: uuid(),
      status: 'FILLED',
      filledPrice: fillPrice,
      filledQuantity: req.quantity,
    };
    this.fills.set(result.brokerOrderId, result);
    return result;
  }

  async cancelOrder(_brokerOrderId: string): Promise<boolean> {
    return true; // paper orders fill instantly; nothing to cancel
  }

  async getOrder(brokerOrderId: string): Promise<BrokerOrderResult> {
    return (
      this.fills.get(brokerOrderId) ?? {
        brokerOrderId,
        status: 'REJECTED',
        filledQuantity: 0,
        rejectionReason: 'unknown order id',
      }
    );
  }

  /**
   * Paper mode has no broker to ask, so the configured capital IS the balance.
   * Reported through the same interface as a live broker so that everything
   * downstream — sizing, reservations, the funds panel — runs the identical
   * code path in paper and in production. A path only exercised with real money
   * is a path nobody has tested.
   */
  async getFunds(): Promise<BrokerFunds> {
    return {
      cash: config.risk.capital,
      usedMargin: 0,
      unsettled: 0,
      at: Date.now(),
      raw: { source: 'RISK_CAPITAL (paper mode — no broker queried)' },
    };
  }
}
