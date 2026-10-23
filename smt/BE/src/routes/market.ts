import { Router } from 'express';
import { config } from '../config';
import { authenticate } from '../middleware/auth';
import { kiteService } from '../services/KiteService';
import { marketData } from '../services/MarketDataService';
import { fetchYahooCandles } from '../services/yahoo';
import { yahooFeed } from '../services/YahooFeed';
import { getInstrument, searchInstruments } from '../services/instruments';
import { store } from '../store/memoryStore';
import { marketEvents } from '../services/marketEvents';

const router = Router();
router.use(authenticate);

// Live watchlist prices.
/** Surveillance stage and upcoming board meetings for one symbol, for the UI's warnings. */
router.get('/flags/:symbol', async (req, res) => {
  res.json(await marketEvents.flags(req.params.symbol));
});

router.get('/quotes', (_req, res) => {
  res.json({ quotes: marketData.getAllPrices(), symbols: marketData.symbols });
});

// NSE listed-company master: search by symbol or name.
router.get('/instruments', (req, res) => {
  const q = String(req.query.q ?? '');
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  res.json({ total: store.instruments.size, results: searchInstruments(q, limit) });
});

router.get('/instruments/:symbol', (req, res) => {
  const i = getInstrument(req.params.symbol);
  if (!i) return res.status(404).json({ error: 'not a listed NSE company' });
  return res.json({ instrument: i });
});

// Latest price for a symbol.
router.get('/quote/:symbol', (req, res) => {
  const ltp = marketData.getPrice(req.params.symbol);
  if (!ltp) return res.status(404).json({ error: 'unknown symbol' });
  return res.json({ symbol: req.params.symbol.toUpperCase(), ltp });
});

// Feed health: which source is live and whether every tracked symbol is priced.
router.get('/feed', (_req, res) => {
  res.json(
    config.dataSource === 'yahoo'
      ? { dataSource: 'yahoo', ...yahooFeed.getStatus() }
      : { dataSource: config.dataSource, running: marketData.symbols.length > 0 },
  );
});

/**
 * Historical OHLC candles for charts.
 *
 *   ?range=1d&interval=1m   intraday (Yahoo ranges: 1d 5d 1mo 3mo 6mo 1y 2y 5y 10y)
 *   ?range=6mo&interval=1d  daily    (intervals: 1m 5m 15m 30m 60m 1d 1wk)
 *
 * Source order: Kite history when DATA_SOURCE=zerodha and connected; otherwise
 * Yahoo. The simulator's synthetic history is served ONLY under DATA_SOURCE=sim
 * and is labelled so — a chart of invented bars must never look like a real one.
 */
router.get('/candles/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const range = String(req.query.range ?? '1d');
  const interval = String(req.query.interval ?? '1m');
  const count = Math.min(Number(req.query.count) || 200, 2000);
  let candles = [] as ReturnType<typeof marketData.generateHistory>;
  let source = 'none';

  if (config.dataSource === 'zerodha' && kiteService.isConnected()) {
    candles = await kiteService.getHistorical(symbol, 'minute', 5);
    if (candles.length) source = 'zerodha';
  }
  if (!candles.length && config.dataSource !== 'sim') {
    candles = await fetchYahooCandles(symbol, range, interval);
    if (candles.length) source = 'yahoo';
  }
  if (!candles.length && config.dataSource === 'sim') {
    candles = marketData.generateHistory(symbol, count);
    source = 'sim';
  }
  res.json({ symbol, source, range, interval, candles });
});

export default router;
