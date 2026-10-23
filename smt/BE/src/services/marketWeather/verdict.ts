/**
 * The one-word answer at the top of the screen: invest, invest in steps, or
 * hold new money. Pure.
 *
 * WHY THERE IS NO "SELL" AND NO BLANKET "DO NOT INVEST". Both were tested on
 * 28 years of Sensex history (MARKET_WEATHER.md) and lost money: every exit
 * rule fell behind simply holding the same average amount, and staying out
 * after rallies missed the gains that followed. The strongest supported
 * version of "don't invest now" is HOLD — keep what you own, pause NEW money —
 * and it appears only when a sign whose pause rule beat holding less in both
 * halves of history is on (summary.supportedSignals).
 *
 *   hold             a supported sign is on
 *   invest-in-steps  the market is in a correction or worse, fear just spiked,
 *                    or the level is stormy/severe: keep investing, split it
 *   invest           otherwise: carry on with the normal plan
 *
 * The example uses real numbers from today's state so the instruction can be
 * followed as written. Every string goes through the banned-phrase test.
 */
import type { Analogs, SignalRead } from './odds';
import type { MarketState } from './regime';
import { calmOn, turbulenceOn, type Level } from './summary';

export type Action = 'invest' | 'invest-in-steps' | 'hold';

/** How the steps are sized: the default four quarters, smaller steps in turbulence, or front-loaded when fear is priced high. */
export type StepPlan = 'standard' | 'smaller' | 'front-loaded';

export interface Verdict {
  action: Action;
  steps: StepPlan;
  /** Short, shouted: "INVEST IN STEPS". */
  title: string;
  /** One sentence a beginner can act on. */
  oneLine: string;
  /** A worked example with rupees and index levels. */
  example: string;
  /** Plain-words reasons. */
  why: string[];
  /** What this verdict never means. */
  never: string;
}

const inr = (n: number): string => `₹${Math.round(n).toLocaleString('en-IN')}`;
const lvl = (n: number): string => Math.round(n).toLocaleString('en-IN');
const p0 = (x: number | null | undefined): string => (x == null ? '–' : `${Math.round(x * 100)}%`);

export function verdictOf(
  state: MarketState,
  signals: SignalRead[],
  supported: string[],
  analogs: Analogs | null,
  level: Level,
  indexLabel = 'NIFTY 50',
): Verdict {
  const onSupported = signals.filter((s) => s.on === true && supported.includes(s.id));
  const year = analogs?.forward.find((f) => f.horizonDays === 252);
  const never = 'It never means "sell what you own". Selling on warnings lost money in every test.';

  if (onSupported.length) {
    return {
      action: 'hold',
      steps: 'standard',
      title: 'HOLD — PAUSE NEW MONEY',
      oneLine: 'Keep the shares you already own. Put fresh money aside for now instead of buying more.',
      example:
        `Say you planned to invest ${inr(100000)} this month. Park it in a liquid fund or savings account and wait until this sign switches off — ` +
        'it has usually lasted a few weeks to about three months. Your existing shares stay as they are.',
      why: [
        `"${onSupported[0].label}" is on. ${onSupported[0].reason}`,
        'In past data, pausing new buying after this sign beat simply holding less stock, in both halves of history. It is the only sign that passed that test.',
      ],
      never,
    };
  }

  const turb = turbulenceOn(signals);
  const calm = calmOn(signals);
  // Turbulence wins over the calm cue: when both fire, the plain four-step plan is used.
  const steps: StepPlan = turb.length && calm.length ? 'standard' : turb.length ? 'smaller' : calm.length ? 'front-loaded' : 'standard';
  const falling = state.phase === 'correction' || state.phase === 'bear';
  const choppy = turb.length > 0 || level === 'stormy' || level === 'severe';
  if (falling || choppy) {
    const why: string[] = [];
    if (falling) why.push(`${indexLabel} is ${Math.abs(state.fromAthPct).toFixed(1)}% below its high. Prices could fall further before they recover, so buying everything on one day is the riskiest way in.`);
    for (const t of turb) why.push(`${t.label}: a 5%+ dip within the next month has been more likely than usual, so the steps are smaller and further apart.`);
    for (const c of calm) why.push(`${c.label}: the 3 months after this beat the normal return in both halves of history, so more goes in now.`);
    if (year?.median != null && year.shareHigher != null && analogs) {
      why.push(
        `In ${analogs.episodes.length} similar past situations the index was higher a year later ${p0(year.shareHigher)} of the time. Stopping completely has usually meant missing the recovery.`,
      );
    }
    if (analogs?.worstFurtherFallP10 != null && analogs.worstFurtherFallP10 < -0.1) {
      why.push(`But in the worst tenth of those cases it first fell another ${p0(-analogs.worstFurtherFallP10)}, which is why the money is split.`);
    }
    const c = state.close;
    const example =
      steps === 'smaller'
        ? `Say you have ${inr(100000)} to invest. Rough weeks are likely, so use five smaller parts: ${inr(20000)} now, then ${inr(20000)} each if ${indexLabel} drops to around ` +
          `${lvl(c * 0.96)}, ${lvl(c * 0.92)}, ${lvl(c * 0.88)} and ${lvl(c * 0.84)}. If it does not fall, add one part every three weeks instead.`
        : steps === 'front-loaded'
          ? `Say you have ${inr(100000)} to invest. Fear is priced high, which has been a good time to buy, so put about ${inr(40000)} in now. Add ${inr(20000)} if ${indexLabel} ` +
            `drops to around ${lvl(c * 0.965)}, another near ${lvl(c * 0.93)}, and the last near ${lvl(c * 0.895)}. If it does not fall, add one part every two weeks instead.`
          : `Say you have ${inr(100000)} to invest. Put about ${inr(25000)} in now. Add another ${inr(25000)} if ${indexLabel} drops to around ${lvl(c * 0.965)}, ` +
            `another near ${lvl(c * 0.93)}, and the last near ${lvl(c * 0.895)}. If it does not fall, add one part every two weeks instead, so you are never left waiting forever.`;
    return {
      action: 'invest-in-steps',
      steps,
      title: steps === 'smaller' ? 'INVEST IN SMALLER STEPS' : steps === 'front-loaded' ? 'INVEST IN STEPS — MORE NOW' : 'INVEST IN STEPS',
      oneLine:
        steps === 'smaller'
          ? 'Keep investing, but in smaller parts spaced further apart: the next few weeks are likely to be rough.'
          : steps === 'front-loaded'
            ? 'Keep investing in parts, and put a bigger first part in now: fear is priced high.'
            : 'Keep investing, but split your money into parts instead of putting it all in today.',
      example,
      why,
      never,
    };
  }

  return {
    action: 'invest',
    steps,
    title: 'INVEST AS PLANNED',
    oneLine: 'No tested warning sign is on. Carry on with your normal plan, for example your monthly SIP.',
    example: `If you invest ${inr(10000)} every month, keep doing exactly that. There is no reason in the data to wait or to rush.`,
    why: ['The market is not in a correction, fear is not spiking, and the one tested warning sign is off.'],
    never,
  };
}
