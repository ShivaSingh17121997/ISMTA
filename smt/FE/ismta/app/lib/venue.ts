import { useSystem } from '../providers/SystemProvider';

/**
 * True while this user's orders go to their real Zerodha account. The server
 * already leaves paper history out of live responses (BE services/venueView);
 * this is for screens that choose a default, such as the tax view.
 */
export function useTradingLive(): boolean {
  const { system } = useSystem();
  return system?.brokerConnection?.tradingMode === 'live';
}
