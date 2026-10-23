import cors from 'cors';
import express from 'express';
import { config } from './config';
import { errorHandler, notFound } from './middleware/errorHandler';
import { logger } from './utils/logger';
import accumulatorRoutes from './routes/accumulator';
import recommendationRoutes from './routes/recommendations';
import futureStarsRoutes from './routes/futureStars';
import turnaroundRoutes from './routes/turnarounds';
import fundsRoutes from './routes/funds';
import sweepRoutes from './routes/sweep';
import authRoutes from './routes/auth';
import brokerRoutes from './routes/brokerConnection';
import backtestRoutes from './routes/backtest';
import marketRoutes from './routes/market';
import orderRoutes from './routes/orders';
import portfolioRoutes from './routes/portfolio';
import riskRoutes from './routes/risk';
import strategyRoutes from './routes/strategies';
import systemRoutes from './routes/system';
import auditRoutes from './routes/audit';
import triggerRoutes from './routes/triggers';
import watchlistRoutes from './routes/watchlists';
import analyticsRoutes from './routes/analytics';
import taxRoutes from './routes/tax';
import journalRoutes from './routes/journal';
import marketWeatherRoutes from './routes/marketWeather';
import globalMarketsRoutes from './routes/globalMarkets';
import foreignStocksRoutes from './routes/foreignStocks';
import addSignalRoutes from './routes/addSignals';

/** http(s)://localhost or 127.0.0.1, any port. Dev only. */
const LOCALHOST = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function createApp(): express.Express {
  const app = express();

  app.use(
    cors({
      origin(origin, cb) {
        // No Origin header = not a browser (curl, server-to-server, health checks).
        if (!origin) return cb(null, true);
        if (config.corsOrigins.includes(origin)) return cb(null, true);

        // Development: accept any localhost port. Next.js falls back to 3001,
        // 3002… when a port is taken, so a single pinned origin breaks silently
        // and presents as an unexplained "CORS error" with a 0-byte response.
        if (config.env !== 'production' && LOCALHOST.test(origin)) return cb(null, true);

        // Refuse by omitting the header rather than throwing — a throw here
        // becomes a 500 and hides the real reason from the browser console.
        logger.warn(
          `CORS: blocked origin ${origin} (allowed: ${config.corsOrigins.join(', ')}). ` +
            `Set CORS_ORIGIN to include it.`,
        );
        return cb(null, false);
      },
      credentials: true,
    }),
  );
  app.use(express.json());

  app.get('/health', (_req, res) =>
    res.json({ status: 'ok', broker: config.broker, env: config.env, ts: Date.now() }),
  );

  app.use('/api/auth', authRoutes);
  app.use('/api/broker', brokerRoutes);
  app.use('/api/strategies', strategyRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/portfolio', portfolioRoutes);
  app.use('/api/risk', riskRoutes);
  app.use('/api/market', marketRoutes);
  app.use('/api/backtest', backtestRoutes);
  app.use('/api/accumulator', accumulatorRoutes);
  app.use('/api/recommendations', recommendationRoutes);
  app.use('/api/future-stars', futureStarsRoutes);
  app.use('/api/turnarounds', turnaroundRoutes);
  app.use('/api/funds', fundsRoutes);
  app.use('/api/sweep', sweepRoutes);
  app.use('/api/system', systemRoutes);
  app.use('/api/audit', auditRoutes);
  app.use('/api/triggers', triggerRoutes);
  app.use('/api/watchlists', watchlistRoutes);
  app.use('/api/analytics', analyticsRoutes);
  app.use('/api/tax', taxRoutes);
  app.use('/api/journal', journalRoutes);
  app.use('/api/market-weather', marketWeatherRoutes);
  app.use('/api/global-markets', globalMarketsRoutes);
  app.use('/api/foreign-stocks', foreignStocksRoutes);
  app.use('/api/add-signals', addSignalRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
