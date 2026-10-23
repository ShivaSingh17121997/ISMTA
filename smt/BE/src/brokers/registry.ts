import { brokerConnections } from '../services/BrokerConnectionService';
import { BaseBroker } from './BaseBroker';
import { broker as serverBroker } from './index';
import { ZerodhaBroker } from './ZerodhaBroker';

const userBrokers = new Map<string, ZerodhaBroker>();

/**
 * The broker for one user's orders, funds and holdings.
 *
 * A user whose own connection is in LIVE mode gets their own Zerodha adapter —
 * including after the session expires. Falling back to paper there would book
 * simulated fills into books that hold real shares; an expired session instead
 * rejects every order with a reason that says to reconnect. Everyone else gets
 * the server default from BROKER (paper unless .env says otherwise).
 */
export function brokerFor(userId?: string | null): BaseBroker {
  if (userId && brokerConnections.isLive(userId)) {
    let b = userBrokers.get(userId);
    if (!b) {
      b = new ZerodhaBroker({
        client: () => brokerConnections.clientFor(userId),
        unavailableReason: () => brokerConnections.unavailableReason(userId),
        label: userId,
      });
      userBrokers.set(userId, b);
    }
    return b;
  }
  return serverBroker;
}

/** Is any order on this server going to a real exchange? Static-IP checks and reconciliation only matter then. */
export function anyLiveBroker(): boolean {
  return serverBroker.name !== 'paper' || brokerConnections.liveUserIds().length > 0;
}

/** Where an adapter's fills happen. A book's lots belong to exactly one venue. */
export function venueOf(b: BaseBroker): 'paper' | 'live' {
  return b.name === 'paper' ? 'paper' : 'live';
}
