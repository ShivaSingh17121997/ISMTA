import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { authenticate, AuthedRequest } from '../middleware/auth';
import { store } from '../store/memoryStore';
import { getStrategy, listStrategyTypes } from '../strategies';
import { strategyEngine } from '../services/StrategyEngine';
import { DirectionFilter, ExitMode, StrategyConfig } from '../types';

const router = Router();
router.use(authenticate);

const EXIT_MODES: ExitMode[] = ['static', 'trailing'];
const DIRECTIONS: DirectionFilter[] = ['long', 'short', 'both'];

/** NTB models manage their own exits; the original 7 keep static SL/TP. */
function defaultExitMode(type: string): ExitMode {
  return type.startsWith('NTB_') ? 'trailing' : 'static';
}

// Available strategy types + their default params.
router.get('/types', (_req, res) => res.json({ types: listStrategyTypes() }));

// List the current user's strategies.
router.get('/', (req: AuthedRequest, res) => {
  res.json({ strategies: store.strategiesByUser(req.userId!) });
});

// Create a strategy.
router.post('/', (req: AuthedRequest, res) => {
  const { name, type, symbols, params, quantity, exitMode, direction } = req.body ?? {};
  const strat = type ? getStrategy(type) : undefined;
  if (!strat) return res.status(400).json({ error: 'invalid strategy type' });
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return res.status(400).json({ error: 'symbols[] required' });
  }
  if (symbols.some((s: unknown) => typeof s !== 'string' || !s.trim())) {
    return res.status(400).json({ error: 'every symbol must be a non-empty text symbol, e.g. "RELIANCE"' });
  }
  if (exitMode != null && !EXIT_MODES.includes(exitMode)) {
    return res.status(400).json({ error: `exitMode must be one of ${EXIT_MODES.join('|')}` });
  }
  if (direction != null && !DIRECTIONS.includes(direction)) {
    return res.status(400).json({ error: `direction must be one of ${DIRECTIONS.join('|')}` });
  }
  const cfg: StrategyConfig = {
    id: uuid(),
    userId: req.userId!,
    name: name ?? `${type} strategy`,
    type,
    symbols: symbols.map((s: string) => s.trim().toUpperCase()),
    params: { ...strat.defaultParams, ...(params ?? {}) },
    quantity: Number(quantity) > 0 ? Number(quantity) : 1,
    exitMode: exitMode ?? defaultExitMode(type),
    direction: direction ?? 'both',
    enabled: false,
    createdAt: Date.now(),
  };
  store.strategies.set(cfg.id, cfg);
  cfg.symbols.forEach((s) => strategyEngine.ensureSymbol(s));
  return res.status(201).json({ strategy: cfg });
});

// Get one strategy + its signal history.
router.get('/:id', (req: AuthedRequest, res) => {
  const cfg = store.strategies.get(req.params.id);
  if (!cfg || cfg.userId !== req.userId) return res.status(404).json({ error: 'not found' });
  return res.json({ strategy: cfg, signals: strategyEngine.getSignalHistory(cfg.id) });
});

// Update params / quantity / symbols.
router.patch('/:id', (req: AuthedRequest, res) => {
  const cfg = store.strategies.get(req.params.id);
  if (!cfg || cfg.userId !== req.userId) return res.status(404).json({ error: 'not found' });
  const { params, quantity, symbols, name, exitMode, direction } = req.body ?? {};
  if (params) cfg.params = { ...cfg.params, ...params };
  if (Number(quantity) > 0) cfg.quantity = Number(quantity);
  if (Array.isArray(symbols) && symbols.some((s: unknown) => typeof s !== 'string' || !s.trim())) {
    return res.status(400).json({ error: 'every symbol must be a non-empty text symbol, e.g. "RELIANCE"' });
  }
  if (Array.isArray(symbols) && symbols.length) cfg.symbols = symbols.map((s: string) => s.trim().toUpperCase());
  if (name) cfg.name = name;

  // Runtime-mutable by design (spec Phase 3) — it only ever gates entries, so
  // flipping it can never strand an open position.
  if (direction != null) {
    if (!DIRECTIONS.includes(direction)) {
      return res.status(400).json({ error: `direction must be one of ${DIRECTIONS.join('|')}` });
    }
    cfg.direction = direction;
  }

  // exitMode is NOT runtime-mutable while a position is open: an open trailing
  // trade carries engine state (peak/trough/armed/stopPct) that the static path
  // would ignore, silently orphaning its stop.
  if (exitMode != null && exitMode !== cfg.exitMode) {
    if (!EXIT_MODES.includes(exitMode)) {
      return res.status(400).json({ error: `exitMode must be one of ${EXIT_MODES.join('|')}` });
    }
    const openTrade = store
      .openTradesByUser(req.userId!)
      .some((t) => t.strategyId === cfg.id);
    if (openTrade) {
      return res.status(409).json({ error: 'cannot change exitMode while a position is open' });
    }
    cfg.exitMode = exitMode;
  }

  store.strategies.set(cfg.id, cfg);
  return res.json({ strategy: cfg });
});

// Enable / disable.
router.post('/:id/toggle', (req: AuthedRequest, res) => {
  const cfg = store.strategies.get(req.params.id);
  if (!cfg || cfg.userId !== req.userId) return res.status(404).json({ error: 'not found' });
  cfg.enabled = !cfg.enabled;
  store.strategies.set(cfg.id, cfg);
  if (cfg.enabled) cfg.symbols.forEach((s) => strategyEngine.ensureSymbol(s));
  return res.json({ strategy: cfg });
});

router.delete('/:id', (req: AuthedRequest, res) => {
  const cfg = store.strategies.get(req.params.id);
  if (!cfg || cfg.userId !== req.userId) return res.status(404).json({ error: 'not found' });
  store.strategies.delete(cfg.id);
  return res.json({ ok: true });
});

export default router;
