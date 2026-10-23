/**
 * Capital allocator tests — pure.
 *
 * The assertions that matter are the ones that protect the invariant: lots are
 * never moved, unsettled money is never moved, every funded book clears the
 * dust gate, and the rupees add up.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import {
  DEFAULT_ALLOCATION_PARAMS as P,
  bookCandidateFields,
  rungsForBudget,
  rungsForBook,
  manualBudgetError,
  manualRungs,
  minManualCash,
  allocate,
  allocatorPool,
  minViableBudget,
  type Candidate,
} from '../services/allocator/allocate';
import { strength } from '../services/allocator/strength';
import { rungFloor } from '../services/allocator/rungFloor';

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push(`  ✗ ${name}\n    ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
}

const cand = (symbol: string, score: number, over: Partial<Candidate> = {}): Candidate => ({
  symbol, score, trendUp: true, eligible: true, deployed: 0, unsettled: 0, cash: 300_000, openLots: 0, ...over,
});

// ─── sizing ───────────────────────────────────────────────────────────────
test('minimum viable budget clears the dust gate for the minimum rungs', () => {
  // 16,000 × 3 rungs / 0.85 = 56,470 → rounded up to ₹57,000
  assert.equal(minViableBudget(P), 57_000);
});

test('₹2 lakh funds at most three books at the defaults, not nineteen', () => {
  const cands = Array.from({ length: 19 }, (_, i) => cand(`S${String(i).padStart(2, '0')}`, 0.9 - i * 0.02));
  const plan = allocate(cands, P);
  assert.equal(plan.selected.length, 3, `selected ${plan.selected.length}`);
  assert.equal(plan.allocatable, 200_000);
  for (const a of plan.allocations.filter((x) => x.selected)) {
    assert.ok(a.targetCash >= 57_000, `${a.symbol} funded below the viable floor: ${a.targetCash}`);
    assert.equal(a.targetCash % 1000, 0, 'budgets round to ₹1,000');
    assert.ok(a.tranches >= P.minRungs && a.tranches <= P.maxRungs);
  }
});

test('stronger companies get more, and every rupee is accounted for', () => {
  const plan = allocate([cand('A', 0.9), cand('B', 0.6), cand('C', 0.4)], P);
  const [a, b, c] = ['A', 'B', 'C'].map((s) => plan.allocations.find((x) => x.symbol === s)!);
  assert.ok(a.targetCash >= b.targetCash && b.targetCash >= c.targetCash, 'monotone in score');
  const used = plan.allocations.reduce((s, x) => s + x.targetCash, 0);
  assert.equal(used + plan.unallocated, plan.allocatable, 'cash used + leftover = allocatable');
  assert.ok(plan.unallocated < 3000, `rounding leftover should be small: ${plan.unallocated}`);
});

test('the weakest funded book is pinned at the floor rather than starved', () => {
  // With three names and a lopsided score, the proportional share for C would
  // be under the floor; it must be pinned there, not dropped or underfunded.
  // No per-stock cap here: with one, A and B are capped and C gets more than the floor.
  const plan = allocate([cand('A', 0.95), cand('B', 0.9), cand('C', 0.36)], { ...P, maxWeightPct: undefined });
  const c = plan.allocations.find((x) => x.symbol === 'C')!;
  assert.equal(c.selected, true);
  assert.equal(c.targetCash, 57_000);
});

// ─── per-stock cap ────────────────────────────────────────────────────────
test('a lone qualifying stock is capped at 35% of capital, the rest left unallocated', () => {
  const plan = allocate([cand('ONLY', 0.9)], P);
  const a = plan.allocations[0];
  assert.equal(a.selected, true);
  assert.equal(a.targetBudget, 70_000);
  assert.equal(plan.unallocated, 130_000);
  assert.match(a.reason, /capped at 35%/);
});

test('what a capped stock cannot take is re-split among the others', () => {
  const plan = allocate([cand('A', 0.95), cand('B', 0.9), cand('C', 0.36)], P);
  const by = (s: string) => plan.allocations.find((x) => x.symbol === s)!;
  assert.equal(by('A').targetCash, 70_000);
  assert.equal(by('B').targetCash, 70_000);
  assert.equal(by('C').targetCash, 60_000, 'C takes the 60k the cap freed, above the 57k floor');
  assert.equal(plan.unallocated, 0);
});

test('lots and T+1 count toward the cap', () => {
  const plan = allocate([cand('A', 0.9, { deployed: 40_000, unsettled: 10_000, openLots: 2 }), cand('B', 0.5)], P);
  const a = plan.allocations.find((x) => x.symbol === 'A')!;
  assert.equal(a.targetBudget, 70_000);
  assert.equal(a.targetCash, 20_000);
});

test('a stock already at its cap is passed over for one that is not', () => {
  const plan = allocate([cand('FULL', 0.95, { deployed: 65_000, openLots: 3 }), cand('B', 0.5)], P);
  const full = plan.allocations.find((x) => x.symbol === 'FULL')!;
  assert.equal(full.selected, false);
  assert.match(full.reason, /per-stock cap/);
  assert.deepEqual(plan.selected, ['B']);
});

// ─── amounts the user fixed by hand ──────────────────────────────────────
test('a manual amount is given exactly, and the bot splits only what is left', () => {
  const plan = allocate([cand('MINE', 0.4, { manualBudget: 50_000 }), cand('A', 0.9), cand('B', 0.8)], P);
  const mine = plan.allocations.find((x) => x.symbol === 'MINE')!;
  assert.equal(mine.manual, true);
  assert.equal(mine.targetCash, 50_000);
  assert.equal(mine.rank, null, 'the bot does not rank a stock you sized');
  assert.equal(plan.manualCash, 50_000);
  const auto = plan.allocations.filter((x) => !x.manual && x.selected).reduce((s, x) => s + x.targetCash, 0);
  assert.ok(auto <= 150_000, `the bot spent ${auto} of the 150,000 left`);
  assert.ok(plan.unallocated >= 0);
});

test('a manual amount ignores the 35% cap, the strength floor and the trend filter', () => {
  const plan = allocate([cand('BIG', 0.1, { trendUp: false, manualBudget: 120_000 })], P);
  const big = plan.allocations[0];
  assert.equal(big.targetCash, 120_000);
  assert.equal(big.selected, true);
  assert.match(big.reason, /long-term trend is down/);
});

test('a manual amount counts lots and T+1 toward itself', () => {
  const plan = allocate([cand('M', 0.5, { deployed: 30_000, unsettled: 5_000, openLots: 2, manualBudget: 60_000 })], P);
  const m = plan.allocations[0];
  assert.equal(m.targetCash, 25_000);
  assert.equal(m.targetBudget, 60_000);
});

test('a manual amount below what is already in lots gives no new cash and keeps the lots', () => {
  const plan = allocate([cand('M', 0.5, { deployed: 40_000, openLots: 2, manualBudget: 10_000 })], P);
  const m = plan.allocations[0];
  assert.equal(m.targetCash, 0);
  assert.equal(m.selected, false);
  assert.equal(m.targetBudget, 40_000);
  assert.match(m.reason, /no new buys/);
});

test('₹0 by hand means no new money, even for the strongest stock', () => {
  const plan = allocate([cand('TOP', 0.99, { manualBudget: 0 }), cand('B', 0.5)], P);
  assert.equal(plan.allocations.find((x) => x.symbol === 'TOP')!.targetCash, 0);
  assert.deepEqual(plan.selected, ['B']);
});

test('manual amounts that no longer fit the pool are scaled down together, never overspent', () => {
  const plan = allocate([cand('X', 0.5, { manualBudget: 150_000 }), cand('Y', 0.5, { manualBudget: 150_000 })], P);
  const x = plan.allocations.find((a) => a.symbol === 'X')!;
  const y = plan.allocations.find((a) => a.symbol === 'Y')!;
  assert.equal(x.targetCash + y.targetCash, 200_000);
  assert.equal(x.targetCash, y.targetCash);
  assert.match(x.reason, /scaled down/);
  assert.ok(plan.unallocated >= 0);
});

test('manual rungs are what the new cash affords above the dust gate, at least one', () => {
  assert.equal(manualRungs(19_000, P), 1);
  assert.equal(manualRungs(60_000, P), 3);
  assert.equal(manualRungs(10_000_000, P), P.maxRungs);
});

test('the entry check refuses too little for one rung, and more than is free', () => {
  const none = { deployed: 0, unsettled: 0 };
  assert.match(manualBudgetError(10_000, none, [], P) ?? '', /too little for one rung/);
  assert.equal(manualBudgetError(minManualCash(P), none, [], P), null);
  assert.equal(manualBudgetError(0, none, [], P), null, '₹0 is always allowed');
  assert.match(manualBudgetError(250_000, none, [], P) ?? '', /most you can enter is ₹2,00,000/);
  // Another stock holds 80k in lots and has 50k fixed by hand: 70k is left.
  const other = { deployed: 80_000, unsettled: 0, manualBudget: 130_000 };
  assert.equal(manualBudgetError(70_000, none, [other], P), null);
  assert.match(manualBudgetError(71_000, none, [other], P) ?? '', /Only ₹70,000/);
  // This stock's own lots count toward its amount: with 20k in lots, 70k total is 50k of new money.
  assert.equal(manualBudgetError(70_000, { deployed: 20_000, unsettled: 0 }, [other], P), null);
  assert.match(manualBudgetError(71_000, { deployed: 20_000, unsettled: 0 }, [other], P) ?? '', /most you can enter is ₹70,000/);
  assert.match(manualBudgetError(-1, none, [], P) ?? '', /₹0 or more/);
});

// ─── index-ETF core ──────────────────────────────────────────────────────
const CORE = { ...P, corePct: 60 };

test('the core is topped up to its share first; stocks get the rest', () => {
  const plan = allocate([cand('NIFTYBEES', 0.6, { core: true }), cand('JUNIORBEES', 0.5, { core: true }), cand('A', 0.9), cand('B', 0.8)], CORE);
  const core = plan.allocations.filter((a) => a.core).reduce((s, a) => s + a.targetCash, 0);
  const stocks = plan.allocations.filter((a) => !a.core && a.selected).reduce((s, a) => s + a.targetCash, 0);
  assert.ok(core >= 119_000 && core <= 120_000, `core got ${core}`);
  assert.ok(stocks <= 80_000, `stocks got ${stocks}`);
  assert.equal(plan.coreCash, core);
});

test('a core ETF is not held to the 35% per-stock cap', () => {
  const plan = allocate([cand('NIFTYBEES', 0.6, { core: true })], CORE);
  assert.equal(plan.allocations[0].targetCash, 120_000);
  assert.match(plan.allocations[0].reason, /index core #1/);
});

test('a core already at its share takes no new cash; stocks do', () => {
  const plan = allocate([cand('NIFTYBEES', 0.6, { core: true, deployed: 125_000, openLots: 4 }), cand('A', 0.9)], CORE);
  const etf = plan.allocations.find((a) => a.symbol === 'NIFTYBEES')!;
  assert.equal(etf.targetCash, 0);
  assert.match(etf.reason, /at its 60% target/);
  assert.ok(plan.allocations.find((a) => a.symbol === 'A')!.targetCash > 0);
});

test('core money is not handed to stocks when the ETFs are in a downtrend', () => {
  const plan = allocate([cand('NIFTYBEES', 0.6, { core: true, trendUp: false }), cand('A', 0.9)], CORE);
  assert.equal(plan.coreCash, 0);
  const a = plan.allocations.find((x) => x.symbol === 'A')!;
  assert.ok(a.targetCash <= 80_000, 'the stock gets only the satellite share');
  assert.ok(plan.unallocated >= 119_000, 'the core share waits, unassigned');
});

test('with no ETF book, the core share is not reserved and stocks are funded as before', () => {
  const withCore = allocate([cand('A', 0.9), cand('B', 0.8)], CORE);
  const without = allocate([cand('A', 0.9), cand('B', 0.8)], { ...P, corePct: undefined });
  assert.deepEqual(withCore.allocations.map((x) => x.targetCash), without.allocations.map((x) => x.targetCash));
  assert.equal(withCore.coreCash, 0);
});

test('a new book gets the rungs its budget affords, not the global 12', () => {
  assert.equal(rungsForBudget(60_000, P), 3);
  assert.equal(rungsForBudget(10_000, P), P.minRungs);
  assert.equal(rungsForBudget(1_000_000, P), P.maxRungs);
});

test('new cash on a ladder that has bought 5 rungs adds rungs on top, instead of stranding it', () => {
  const c = cand('OPEN', 0.9, { deployed: 80_000, openLots: 5, epochFilled: 5, epochSpent: 80_000 });
  // ₹1,40,000 budget × 85% − ₹80,000 spent = ₹39,000 → 2 more ₹16,000 rungs.
  assert.equal(rungsForBook(c, 60_000, P, (x) => rungsForBudget(x, P)), 7);
  const plan = allocate([c], { ...P, maxWeightPct: undefined });
  const a = plan.allocations[0];
  assert.ok(a.tranches > 5, `got ${a.tranches} rungs on a ladder with 5 bought`);
  // A fresh book is sized exactly as before.
  assert.equal(rungsForBook(cand('NEW', 0.9), 60_000, P, (x) => rungsForBudget(x, P)), 3);
});

test('the defaults carry a 60% core', () => {
  assert.equal(P.corePct, 60);
  assert.equal(P.maxDeployPct, undefined);
  assert.equal(P.rescueRungs, undefined);
});

test('without a core share, an ETF competes with stocks exactly as before', () => {
  const NO_CORE = { ...P, corePct: undefined };
  const a = allocate([cand('NIFTYBEES', 0.6, { core: true }), cand('A', 0.9)], NO_CORE);
  const b = allocate([cand('NIFTYBEES', 0.6), cand('A', 0.9)], NO_CORE);
  assert.deepEqual(a.allocations.map((x) => x.targetCash), b.allocations.map((x) => x.targetCash));
});

// ─── deployment ceiling ──────────────────────────────────────────────────
test('the ceiling caps lots, T+1 and assigned cash together', () => {
  const plan = allocate([cand('A', 0.9, { deployed: 50_000, openLots: 2 }), cand('B', 0.8), cand('C', 0.7)], { ...P, maxDeployPct: 70 });
  const total = plan.committed + plan.allocations.reduce((s, a) => s + a.targetCash, 0);
  assert.ok(total <= 140_000, `books hold ${total}`);
  assert.equal(plan.heldBackByCeiling, 60_000);
});

test('a ceiling below what is already in lots assigns nothing and moves nothing', () => {
  const plan = allocate([cand('A', 0.9, { deployed: 150_000, openLots: 5 }), cand('B', 0.8)], { ...P, maxDeployPct: 50 });
  assert.equal(plan.allocations.reduce((s, a) => s + a.targetCash, 0), 0);
  assert.equal(plan.allocations.find((a) => a.symbol === 'A')!.targetBudget, 150_000);
});

// ─── stranded books ──────────────────────────────────────────────────────
test('rescue uses only money the ranked stocks left over', () => {
  const plan = allocate(
    [cand('A', 0.9), cand('OLD', 0.2, { deployed: 20_000, openLots: 1, epochFilled: 1, epochSpent: 20_000 })],
    { ...P, rescueRungs: 1 },
  );
  const old = plan.allocations.find((a) => a.symbol === 'OLD')!;
  assert.equal(old.rescue, true, 'A is capped at 35%, so money is left for the rescue');
  assert.equal(old.targetCash, 23_000);
  assert.ok(plan.unallocated >= 0);
});

test('no rescue for a dropped stock in a downtrend, or one with no lots', () => {
  const plan = allocate(
    [cand('A', 0.9), cand('DOWN', 0.5, { trendUp: false, deployed: 20_000, openLots: 1, epochFilled: 1, epochSpent: 20_000 }), cand('EMPTY', 0.3)],
    { ...P, rescueRungs: 1 },
  );
  assert.equal(plan.allocations.find((a) => a.symbol === 'DOWN')!.targetCash, 0);
  assert.equal(plan.allocations.find((a) => a.symbol === 'EMPTY')!.targetCash, 0);
});

test('stocks still holding lots can take up the book slots', () => {
  const held = [1, 2, 3].map((i) => cand(`H${i}`, 0.2, { deployed: 20_000, openLots: 1 }));
  const plan = allocate([...held, cand('A', 0.9), cand('B', 0.8)], { ...P, countHeldBooks: true });
  assert.deepEqual(plan.selected, ['A'], 'three of four slots are held, so one new name');
  assert.match(plan.allocations.find((a) => a.symbol === 'B')!.reason, /beyond the 1 books/);
  const off = allocate([...held, cand('A', 0.9), cand('B', 0.8)], P);
  assert.deepEqual(off.selected, ['A', 'B']);
});

test('the book helper reads lots, T+1 and the open ladder from a book', () => {
  const book = {
    symbol: 'X', instrument: 'ETF', cash: 5_000,
    openLots: [{ id: 'a', epoch: 1, level: 0, quoteSpent: 10_000, quantity: 1, fillPrice: 1, openedAt: 0 }],
    closedLots: [{ id: 'b', epoch: 1, level: 1, quoteSpent: 7_000, quantity: 1, fillPrice: 1, openedAt: 0 }],
    unsettled: [{ amount: 7_300, fromLotId: 'b', soldAt: 0, settlesAt: 0 }],
    epochs: [{ index: 1, anchorPrice: 1, openedAt: 0, levels: [1, 0.9, 0.8], filledLevels: [0, 1], status: 'OPEN' }],
  } as unknown as Parameters<typeof bookCandidateFields>[0];
  const f = bookCandidateFields(book);
  assert.equal(f.deployed, 10_000);
  assert.equal(f.unsettled, 7_300);
  assert.equal(f.core, true);
  assert.equal(f.epochFilled, 2);
  assert.equal(f.epochSpent, 17_000);
});

test('with every Phase 3 setting on, no plan overspends across random candidate sets', () => {
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let run = 0; run < 300; run++) {
    const n = 1 + Math.floor(rnd() * 8);
    const cands = Array.from({ length: n }, (_, i) =>
      cand(`S${i}`, 0.3 + rnd() * 0.7, {
        trendUp: rnd() < 0.8,
        core: rnd() < 0.3,
        ...(rnd() < 0.5 ? { deployed: Math.floor(rnd() * 50_000), openLots: 1, epochFilled: 1, epochSpent: 20_000 } : {}),
      }),
    );
    const params = { ...P, corePct: Math.floor(rnd() * 80), maxDeployPct: 50 + Math.floor(rnd() * 51), rescueRungs: 1, countHeldBooks: rnd() < 0.5 };
    const plan = allocate(cands, params);
    const assigned = plan.allocations.reduce((s, a) => s + a.targetCash, 0);
    assert.ok(assigned <= plan.allocatable + 1e-6, `run ${run}: assigned ${assigned} of ${plan.allocatable}`);
    assert.ok(plan.unallocated >= -1e-6, `run ${run}: unallocated ${plan.unallocated}`);
    assert.ok(plan.committed + assigned <= (params.totalCapital * params.maxDeployPct) / 100 + 1e-6 || assigned === 0);
  }
});

test('no funded budget ever exceeds the cap, across random candidate sets', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let run = 0; run < 300; run++) {
    const n = 1 + Math.floor(rnd() * 7);
    const cands = Array.from({ length: n }, (_, i) =>
      cand(`S${i}`, 0.35 + rnd() * 0.65, rnd() < 0.4 ? { deployed: Math.floor(rnd() * 60_000), openLots: 1 } : {}),
    );
    const plan = allocate(cands, P);
    for (const a of plan.allocations) {
      if (a.selected) assert.ok(a.targetBudget <= 70_000 + 1e-6, `${a.symbol} budget ${a.targetBudget} over the cap`);
    }
    assert.ok(plan.unallocated >= 0);
  }
});

// ─── the invariant, at the allocation layer ───────────────────────────────
test('open lots are never moved: deployed capital stays with its book', () => {
  const plan = allocate([cand('A', 0.9, { deployed: 80_000, openLots: 4 }), cand('B', 0.2)], P);
  const a = plan.allocations.find((x) => x.symbol === 'A')!;
  assert.equal(plan.committed, 80_000);
  assert.equal(plan.allocatable, 120_000);
  assert.ok(a.targetBudget >= 80_000, 'budget can never drop below what is already in lots');
  const b = plan.allocations.find((x) => x.symbol === 'B')!;
  assert.equal(b.selected, false);
  assert.equal(b.targetBudget, 0);
});

test('a deselected book keeps its lots and its unsettled proceeds', () => {
  const plan = allocate(
    [cand('A', 0.9), cand('B', 0.9), cand('C', 0.9), cand('D', 0.9), cand('E', 0.1, { deployed: 30_000, unsettled: 12_000, openLots: 2 })],
    P,
  );
  const e = plan.allocations.find((x) => x.symbol === 'E')!;
  assert.equal(e.selected, false);
  assert.equal(e.targetBudget, 42_000, 'deployed + unsettled, untouched');
  assert.equal(e.targetCash, 0, 'only its settled cash is released');
  assert.match(e.reason, /2 open lot\(s\) kept/);
});

test('when everything is committed to lots, nothing is funded and nothing breaks', () => {
  const plan = allocate([cand('A', 0.9, { deployed: 150_000, openLots: 6 }), cand('B', 0.8, { deployed: 60_000, openLots: 3 })], P);
  assert.equal(plan.allocatable, 0);
  assert.equal(plan.selected.length, 0);
  assert.match(plan.allocations[1].reason, /no allocatable capital/);
});

// ─── filters ──────────────────────────────────────────────────────────────
test('a downtrend is never funded, whatever its score', () => {
  const plan = allocate([cand('DOWN', 0.99, { trendUp: false }), cand('UP', 0.5)], P);
  assert.deepEqual(plan.selected, ['UP']);
  assert.match(plan.allocations.find((x) => x.symbol === 'DOWN')!.reason, /downtrend/);
});

test('below the strength threshold is not funded even with room', () => {
  const plan = allocate([cand('WEAK', 0.2)], P);
  assert.equal(plan.selected.length, 0);
  assert.match(plan.allocations[0].reason, /below 0.35/);
});

test('a company without enough history is skipped with its reason', () => {
  const plan = allocate([cand('NEW', 0.9, { eligible: false, reason: 'insufficient history (120 daily bars, need 200)' })], P);
  assert.equal(plan.selected.length, 0);
  assert.match(plan.allocations[0].reason, /insufficient history/);
});

test('ranks beyond what the capital can fund say so', () => {
  const plan = allocate([cand('A', 0.9), cand('B', 0.8), cand('C', 0.7), cand('D', 0.6)], P);
  assert.equal(plan.selected.length, 3);
  assert.match(plan.allocations.find((x) => x.symbol === 'D')!.reason, /rank #4, beyond the 3 books/);
});

// ─── strength score ───────────────────────────────────────────────────────
function series(n: number, drift: number, start = 100): { closes: number[]; highs: number[] } {
  const closes: number[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p *= 1 + drift + Math.sin(i / 5) * 0.004;
    closes.push(p);
  }
  return { closes, highs: closes.map((c) => c * 1.004) };
}

test('a steady uptrend scores high and reads as trending up', () => {
  const { closes, highs } = series(260, 0.0015);
  const s = strength('UP', closes, highs);
  assert.equal(s.eligible, true);
  assert.equal(s.trendUp, true);
  assert.ok(s.score > 0.7, `score ${s.score}`);
  assert.ok(s.ret3mPct > 0);
  assert.ok(s.distFromHighPct <= 0 && s.distFromHighPct > -5);
});

test('a steady downtrend scores low and is flagged, not merely ranked lower', () => {
  const { closes, highs } = series(260, -0.0015);
  const s = strength('DOWN', closes, highs);
  assert.equal(s.trendUp, false);
  assert.ok(s.score < 0.4, `score ${s.score}`);
});

test('a fresh listing is ineligible rather than scored on thin data', () => {
  const { closes, highs } = series(120, 0.002);
  const s = strength('NEW', closes, highs);
  assert.equal(s.eligible, false);
  assert.match(s.reason ?? '', /insufficient history \(120/);
  assert.equal(s.score, 0);
});

test('score is bounded 0..1', () => {
  for (const d of [-0.01, -0.003, 0, 0.003, 0.01]) {
    const { closes, highs } = series(260, d);
    const s = strength('X', closes, highs).score;
    assert.ok(s >= 0 && s <= 1, `drift ${d} → ${s}`);
  }
});

// ─── the pool: paper and live must mean the same thing ─────────────────────
test('a live account with lots allocates the same free cash as paper (lots are not subtracted twice)', () => {
  // One real account: ₹2,00,000 total, ₹58,000 of it in open lots.
  const books = [cand('A', 0.9, { deployed: 58_000, openLots: 2, cash: 0 }), cand('B', 0.8, { cash: 0 })];
  const paper = allocate(books, { ...P, totalCapital: allocatorPool({ funds: 200_000, simulated: true, deployed: 58_000, parked: 0 }) });
  // Live, the broker reports only the free cash — the lots were debited when they filled.
  const live = allocate(books, { ...P, totalCapital: allocatorPool({ funds: 142_000, simulated: false, deployed: 58_000, parked: 0 }) });
  assert.equal(paper.allocatable, 142_000);
  assert.equal(live.allocatable, 142_000, 'live must match paper; the old code gave ₹84,000');
});

test('cash parked by the sweep is still allocatable on a live account, and never double-counted in paper', () => {
  const books = [cand('A', 0.9, { cash: 0 })];
  const live = allocate(books, { ...P, totalCapital: allocatorPool({ funds: 50_000, simulated: false, deployed: 0, parked: 150_000 }) });
  assert.equal(live.allocatable, 200_000);
  assert.equal(allocatorPool({ funds: 200_000, simulated: true, deployed: 58_000, parked: 150_000 }), 200_000, 'paper cash is already the whole pool');
});

test('unsettled proceeds are still held back on a live account', () => {
  const books = [cand('A', 0.9, { deployed: 20_000, unsettled: 10_000, openLots: 1, cash: 0 })];
  const live = allocate(books, { ...P, totalCapital: allocatorPool({ funds: 100_000, simulated: false, deployed: 20_000, parked: 0 }) });
  assert.equal(live.allocatable, 90_000, 'the T+1 money waits a day even if the broker already counts it');
});

if (failures.length) {
  console.error(`✗ allocator: ${failures.length} failed, ${passed} passed`);
  console.error(failures.join('\n'));
  process.exit(1);
}

// ─── the per-stock rung floor for hand-set amounts ────────────────────

test('rung floor: a ₹1,700 stock needs one share, not ₹16,000', () => {
  const f = rungFloor(1718.7, 4, 'EQUITY', 15, 16_000);
  assert.equal(f.shares, 1);
  assert.equal(f.newCash, 2_100, '1 share ÷ 0.85 reserve, rounded up to ₹100');
});

test('rung floor: a cheap stock needs enough shares for the target to clear 1.5× the round trip', () => {
  const f = rungFloor(78, 4, 'EQUITY', 15, 16_000);
  assert.ok(f.shares > 1, 'one ₹78 share would hand the DP charge most of the profit');
  assert.ok(f.newCash < 2_000);
});

test('rung floor: a tighter scalp target needs a bigger rung', () => {
  assert.ok(rungFloor(1718.7, 1.5, 'EQUITY', 15, 16_000).shares > rungFloor(1718.7, 4, 'EQUITY', 15, 16_000).shares);
});

test('rung floor: never asks for more than the allocator cap, and falls back to it with no price', () => {
  assert.ok(rungFloor(5, 0.1, 'EQUITY', 15, 16_000).perRung <= 16_000);
  assert.equal(rungFloor(0, 4, 'EQUITY', 15, 16_000).perRung, 16_000);
});

test('manual amount: the per-stock floor replaces the fixed ₹19,000', () => {
  const none = { deployed: 0, unsettled: 0 };
  const floor = rungFloor(1718.7, 4, 'EQUITY', 15, 16_000);
  assert.equal(manualBudgetError(2_100, none, [], P, floor), null, '₹2,100 buys one SYRMA share');
  assert.match(manualBudgetError(2_000, none, [], P, floor) ?? '', /minimum is ₹2,100.*one share costs/);
  assert.match(manualBudgetError(2_000, none, [], P) ?? '', /minimum is ₹19,000/, 'no floor given: the old rule');
});

console.log(`✓ allocator: ${passed} passed`);
