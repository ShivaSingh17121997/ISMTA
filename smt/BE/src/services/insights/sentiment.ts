/**
 * Lexicon-based headline sentiment.
 *
 * This is deliberately simple: a signed dictionary of financial-news words plus
 * a per-headline negation flip. It is not machine learning and does not try to
 * be — a bag-of-words lexicon on a *domain-specific* vocabulary consistently
 * beats generic sentiment models when the goal is a soft directional bias on
 * finance headlines. That is all we need: a nudge, weighted by news count and
 * capped, that then combines with technicals in the horizon scorer.
 *
 * What this file explicitly does NOT do:
 *   - it does not attempt to interpret price targets, ratings, or numbers.
 *   - it does not swing more than ±1 on any single headline; the scorer that
 *     consumes this treats even a strong story as a small tilt, not a mandate.
 *   - it does not pretend to detect sarcasm, satire, or paywalled context.
 */
export interface HeadlineScore {
  title: string;
  score: number;
  hits: string[];
}

export interface AggregateSentiment {
  /** Average of headline scores in [-1, 1]. 0 when there are no headlines. */
  score: number;
  /** How many headlines contributed. */
  count: number;
  /** Split of positive / neutral / negative headlines. */
  positive: number;
  negative: number;
  neutral: number;
  /** Per-headline breakdown for the UI to show *why*. */
  headlines: HeadlineScore[];
}

/**
 * Word → weight. Weights are small on purpose: the aggregate is an average
 * across all matches in a headline, so packing extreme values into individual
 * words does not make the score more informative, only noisier.
 */
const LEXICON: Record<string, number> = {
  // ── positive ──
  surge: 1, surged: 1, rally: 1, rallies: 1, rallied: 1, jump: 0.8, jumps: 0.8, jumped: 0.8,
  soar: 1, soared: 1, gains: 0.7, gain: 0.6, up: 0.4, rises: 0.6, rose: 0.6, climb: 0.6, climbed: 0.6,
  outperform: 0.9, outperforms: 0.9, beat: 0.8, beats: 0.8, exceed: 0.8, exceeded: 0.8,
  upgrade: 1, upgraded: 1, upgrades: 1, buy: 0.7, overweight: 0.7,
  bullish: 1, positive: 0.5, strong: 0.5, robust: 0.6, healthy: 0.5,
  profit: 0.6, profits: 0.6, profitable: 0.7, growth: 0.6, growing: 0.5, expand: 0.5, expansion: 0.5,
  record: 0.6, high: 0.3, highs: 0.4, target: 0.3, dividend: 0.4, buyback: 0.7,
  order: 0.4, orders: 0.4, contract: 0.4, deal: 0.3, wins: 0.6, won: 0.5, awarded: 0.6,
  launch: 0.4, launched: 0.4, approval: 0.7, approved: 0.7, cleared: 0.5,

  // ── negative ──
  plunge: -1, plunged: -1, plunges: -1, tumble: -1, tumbled: -1, tumbles: -1,
  slump: -0.9, slumped: -0.9, drops: -0.7, drop: -0.7, fell: -0.7, falls: -0.7, fall: -0.6,
  crash: -1.2, crashes: -1.2, crashed: -1.2, sink: -0.9, sank: -0.9, slide: -0.7, slid: -0.7,
  loss: -0.8, losses: -0.8, losing: -0.7, miss: -0.7, missed: -0.7, misses: -0.7,
  downgrade: -1, downgraded: -1, downgrades: -1, sell: -0.6, underweight: -0.6, underperform: -0.9,
  bearish: -1, weak: -0.5, weakness: -0.5, negative: -0.5, disappointing: -0.8, disappointed: -0.7,
  probe: -0.6, investigation: -0.7, fraud: -1.2, scam: -1.2, scandal: -1.1,
  fine: -0.5, penalty: -0.7, penalties: -0.7, lawsuit: -0.8, sued: -0.7,
  layoff: -0.9, layoffs: -0.9, cut: -0.4, cuts: -0.4, recall: -0.9, recalled: -0.9,
  bankruptcy: -1.5, insolvency: -1.5, default: -1.2, defaults: -1.2, delisting: -1.3, delisted: -1.3,
  raid: -0.9, raids: -0.9, warns: -0.6, warning: -0.6, guidance: -0.1,
};

/** Words that flip the polarity of what follows in the same clause. */
const NEGATORS = new Set(['no', 'not', 'never', 'without', 'lacks', 'fails', 'failed', 'unable']);

/** Split "Reliance shares plunge 5%" → ["reliance", "shares", "plunge", "5"]. */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    // Split on anything that is not a letter or digit; keeps "5%" as "5".
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Score one headline in [-1, 1]. Ties negation to the *previous* token, which
 * catches the common "no growth", "not profitable", "fails to beat" patterns
 * without needing a parser.
 *
 * When several lexicon words hit, the headline score is the mean of their
 * (negation-adjusted) weights, then clamped. That prevents a headline of
 * "record profit, growth surge, dividend upgrade" from swamping four separate
 * neutral headlines just because it happens to pack four hits.
 */
export function scoreHeadline(title: string): HeadlineScore {
  const tokens = tokenize(title);
  const hits: string[] = [];
  let sum = 0;
  let count = 0;
  for (let i = 0; i < tokens.length; i++) {
    const w = LEXICON[tokens[i]];
    if (w == null) continue;
    const negated = i > 0 && NEGATORS.has(tokens[i - 1]);
    const contrib = negated ? -w : w;
    sum += contrib;
    count += 1;
    hits.push(negated ? `not ${tokens[i]}` : tokens[i]);
  }
  const raw = count === 0 ? 0 : sum / count;
  const score = Math.max(-1, Math.min(1, raw));
  return { title, score, hits };
}

export function aggregateSentiment(titles: string[]): AggregateSentiment {
  const headlines = titles.map((t) => scoreHeadline(t));
  const scored = headlines.filter((h) => h.hits.length > 0);
  const sum = scored.reduce((s, h) => s + h.score, 0);
  const score = scored.length === 0 ? 0 : sum / scored.length;
  return {
    score,
    count: headlines.length,
    positive: scored.filter((h) => h.score > 0.1).length,
    negative: scored.filter((h) => h.score < -0.1).length,
    // A headline with no lexicon hits counts as neutral, on purpose — an
    // unclassifiable headline is not evidence of anything, so it should
    // neither prop up nor pull down the aggregate.
    neutral: headlines.length - scored.filter((h) => Math.abs(h.score) > 0.1).length,
    headlines,
  };
}
