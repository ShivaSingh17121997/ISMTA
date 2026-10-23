import { config } from '../config';
import { kiteService } from '../services/KiteService';
import { logger } from '../utils/logger';
import { BaseBroker } from './BaseBroker';
import { PaperBroker } from './PaperBroker';
import { ZerodhaBroker } from './ZerodhaBroker';
import { GrowwBroker } from './GrowwBroker';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
let envKite: any = null;

/**
 * The Kite client for BROKER=zerodha from .env. Reuses the market-data client
 * when it runs on the same .env token; otherwise builds one. (BROKER=zerodha
 * used to reject every order unless DATA_SOURCE=zerodha was also set.)
 */
function envKiteClient(): any {
  if (kiteService.source === 'env' && kiteService.client) return kiteService.client;
  if (!envKite && config.zerodha.apiKey && config.zerodha.accessToken) {
    try {
      const { KiteConnect } = require('kiteconnect');
      envKite = new KiteConnect({ api_key: config.zerodha.apiKey });
      envKite.setAccessToken(config.zerodha.accessToken);
    } catch {
      envKite = null;
    }
  }
  return envKite;
}

/**
 * The server-wide default adapter, from the BROKER env var. Users who connect
 * their own Zerodha account in Settings and switch it to live are routed to
 * their own adapter by `brokerFor` in ./registry instead.
 */
function createBroker(): BaseBroker {
  switch (config.broker) {
    case 'zerodha':
      logger.info('Using ZerodhaBroker adapter (.env credentials, for every user)');
      return new ZerodhaBroker({
        client: envKiteClient,
        unavailableReason: () =>
          'Zerodha (.env) not connected — set ZERODHA_API_KEY and a fresh ZERODHA_ACCESS_TOKEN (npm run kite:login)',
        label: 'env',
      });
    case 'groww':
      logger.info('Using GrowwBroker adapter');
      return new GrowwBroker();
    case 'paper':
    default:
      logger.info('Using PaperBroker adapter (simulated)');
      return new PaperBroker();
  }
}

export const broker: BaseBroker = createBroker();
export { BaseBroker } from './BaseBroker';
