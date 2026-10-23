import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { authenticate, AuthedRequest } from '../middleware/auth';
import { getInstrument } from '../services/instruments';
import { marketData } from '../services/MarketDataService';
import { store } from '../store/memoryStore';
import { Watchlist } from '../types';

const router = Router();
router.use(authenticate);

const MAX_LISTS = 25;
const MAX_SYMBOLS = 250;

function own(req: AuthedRequest, id: string): Watchlist | undefined {
  const w = store.watchlists.get(id);
  return w && w.userId === req.userId ? w : undefined;
}

/** Validate a symbol against the NSE master when it is loaded; always upper-case it. */
function normalise(symbol: unknown): { symbol?: string; error?: string } {
  if (typeof symbol !== 'string' || !symbol.trim()) return { error: 'symbol required' };
  const sym = symbol.trim().toUpperCase();
  if (store.instruments.size > 0 && !getInstrument(sym) && !['NIFTY', 'BANKNIFTY'].includes(sym)) {
    return { error: `${sym} is not in the NSE listed-company master` };
  }
  return { symbol: sym };
}

router.get('/', (req: AuthedRequest, res) => {
  const lists = store.watchlistsByUser(req.userId!);
  res.json({
    watchlists: lists.map((w) => ({
      ...w,
      quotes: Object.fromEntries(w.symbols.map((s) => [s, { ltp: marketData.getPrice(s), reference: marketData.getReference(s) || null }])),
    })),
  });
});

router.post('/', (req: AuthedRequest, res) => {
  const { name, symbols } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name required' });
  if (store.watchlistsByUser(req.userId!).length >= MAX_LISTS) return res.status(422).json({ error: `at most ${MAX_LISTS} watchlists` });
  const syms: string[] = [];
  for (const s of Array.isArray(symbols) ? symbols : []) {
    const n = normalise(s);
    if (n.error) return res.status(422).json({ error: n.error });
    if (n.symbol && !syms.includes(n.symbol)) syms.push(n.symbol);
  }
  const now = Date.now();
  const w: Watchlist = { id: uuid(), userId: req.userId!, name: name.trim(), symbols: syms.slice(0, MAX_SYMBOLS), notes: {}, createdAt: now, updatedAt: now };
  store.watchlists.set(w.id, w);
  syms.forEach((s) => marketData.registerSymbol(s));
  return res.status(201).json({ watchlist: w });
});

router.patch('/:id', (req: AuthedRequest, res) => {
  const w = own(req, req.params.id);
  if (!w) return res.status(404).json({ error: 'not found' });
  const { name, symbols, notes } = req.body ?? {};
  if (typeof name === 'string' && name.trim()) w.name = name.trim();
  if (Array.isArray(symbols)) {
    const syms: string[] = [];
    for (const s of symbols) {
      const n = normalise(s);
      if (n.error) return res.status(422).json({ error: n.error });
      if (n.symbol && !syms.includes(n.symbol)) syms.push(n.symbol);
    }
    w.symbols = syms.slice(0, MAX_SYMBOLS);
    syms.forEach((s) => marketData.registerSymbol(s));
  }
  if (notes && typeof notes === 'object') {
    for (const [k, v] of Object.entries(notes as Record<string, unknown>)) {
      if (typeof v === 'string') w.notes[k.toUpperCase()] = v.slice(0, 500);
    }
  }
  w.updatedAt = Date.now();
  store.watchlists.set(w.id, w);
  return res.json({ watchlist: w });
});

router.post('/:id/symbols', (req: AuthedRequest, res) => {
  const w = own(req, req.params.id);
  if (!w) return res.status(404).json({ error: 'not found' });
  const n = normalise(req.body?.symbol);
  if (n.error || !n.symbol) return res.status(422).json({ error: n.error ?? 'symbol required' });
  if (w.symbols.length >= MAX_SYMBOLS) return res.status(422).json({ error: `at most ${MAX_SYMBOLS} symbols per list` });
  if (!w.symbols.includes(n.symbol)) w.symbols.push(n.symbol);
  marketData.registerSymbol(n.symbol);
  w.updatedAt = Date.now();
  store.watchlists.set(w.id, w);
  return res.json({ watchlist: w });
});

router.delete('/:id/symbols/:symbol', (req: AuthedRequest, res) => {
  const w = own(req, req.params.id);
  if (!w) return res.status(404).json({ error: 'not found' });
  const sym = req.params.symbol.toUpperCase();
  w.symbols = w.symbols.filter((s) => s !== sym);
  delete w.notes[sym];
  w.updatedAt = Date.now();
  store.watchlists.set(w.id, w);
  return res.json({ watchlist: w });
});

router.delete('/:id', (req: AuthedRequest, res) => {
  const w = own(req, req.params.id);
  if (!w) return res.status(404).json({ error: 'not found' });
  store.watchlists.delete(w.id);
  return res.json({ ok: true });
});

export default router;
