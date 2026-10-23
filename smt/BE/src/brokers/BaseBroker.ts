import { Order, OrderRequest } from '../types';

export interface BrokerOrderResult {
  brokerOrderId: string;
  status: Order['status'];
  filledPrice?: number;
  filledQuantity: number;
  rejectionReason?: string;
}

/**
 * What the BROKER says you have. Never what this application thinks you have.
 *
 * Cash lives at the broker, and the broker's ledger is the only true copy of
 * it. Money arrives by UPI from a phone, leaves as brokerage and taxes, and
 * moves when a trade is placed by hand outside this system — none of which this
 * process can see. So funds are read every cycle and never mirrored into a
 * local ledger that would immediately begin to drift.
 */
export interface BrokerFunds {
  /** Free cash the broker will let you spend right now, rupees. */
  cash: number;
  /** Cash already committed to open positions and working orders. */
  usedMargin: number;
  /**
   * Sale proceeds not yet settled. Indian cash equity settles T+1: this money
   * can fund a new BUY today but cannot be withdrawn, so it counts toward
   * buying power and must not be counted as withdrawable.
   */
  unsettled: number;
  /** When this was read, so a stale figure can be seen rather than trusted. */
  at: number;
  /** Whatever the broker actually returned, for the funds screen and debugging. */
  raw?: unknown;
}

/** One holding as the BROKER reports it — the truth to reconcile against. */
export interface BrokerHolding {
  symbol: string;
  quantity: number;
  averagePrice: number;
}

/**
 * Abstract broker interface. Every concrete broker (PaperBroker, ZerodhaBroker,
 * GrowwBroker, …) implements this contract so the OrderManager and StrategyEngine
 * are broker-agnostic. This is the Adapter pattern from Phase 1 of the plan.
 */
export abstract class BaseBroker {
  abstract readonly name: string;

  /** Returns true when the broker is ready to accept orders. */
  abstract isConnected(): boolean;

  /** Last traded price for a symbol. */
  abstract getLtp(symbol: string): number;

  /** Place an order; resolves once the broker has acknowledged/filled it. */
  abstract placeOrder(req: OrderRequest): Promise<BrokerOrderResult>;

  /** Cancel a working order. */
  abstract cancelOrder(brokerOrderId: string): Promise<boolean>;

  /** Free cash and margin, read from the broker. */
  abstract getFunds(): Promise<BrokerFunds>;

  /**
   * The CURRENT state of an order, re-read from the broker.
   *
   * Placing an order and having it accepted are not the same as having it
   * filled, and the difference is where a strategy built on breakeven
   * arithmetic gets quietly poisoned: an assumed fill price that the trade
   * never happened at makes every downstream number wrong while looking
   * perfectly healthy. Adapters that can ask the broker what really happened
   * must do so; ones that cannot may return the placement result.
   */
  abstract getOrder(brokerOrderId: string): Promise<BrokerOrderResult>;

  /**
   * Holdings as the broker sees them. Optional: an adapter that cannot report
   * them returns null, and reconciliation is skipped rather than faked.
   */
  async getHoldings(): Promise<BrokerHolding[] | null> {
    return null;
  }
}
