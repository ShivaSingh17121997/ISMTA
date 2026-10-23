/**
 * Government support and critical production — the CURATED pillar.
 *
 * Everything in this file is a hand-written judgement, not measured data, and
 * the interface says so: every star that scores on policy is labelled "curated
 * opinion" on screen. Two reasons to be blunt about that.
 *
 * First, there is no exchange feed for "is this company favoured by industrial
 * policy". NSE classifies HAL, BEL and SYRMA all as "Capital Goods"; the
 * connection between a company and the Production Linked Incentive scheme it
 * draws on exists only in prose.
 *
 * Second, and more important: a policy that is public is already priced. The
 * evidence on government-spending exposure (Belo, Gala & Li, JFE 2013) reads
 * as a RISK-FACTOR story — firms exposed to government demand earn a premium
 * for bearing political risk — not as a free lunch available to whoever reads
 * the newspaper. So this pillar is deliberately capped: it explains why a
 * company's order book might keep filling, and it is never, on its own, a
 * reason to buy.
 *
 * MAINTENANCE. Schemes expire, get expanded, and get quietly defunded. Each
 * entry carries the year it was announced or last expanded so staleness is
 * visible on screen. Review it every budget (February).
 *
 * Pure — no I/O, no clock.
 */
import { PolicyRead, PolicyTag } from './types';

interface SchemeDef {
  /** short label shown on screen */
  scheme: string;
  /** the year it was announced or last materially expanded */
  since: number;
  /** why exposure to it could grow a company, in one line */
  why: string;
  /** how much of the policy score one membership is worth, 0..1 */
  weight: number;
  members: string[];
}

/**
 * Schemes are ordered by how directly the money reaches a listed company's
 * revenue line. A capital subsidy on a plant the company is actually building
 * (semiconductors, solar cells) is more concrete than a demand-side aspiration.
 */
const SCHEMES: SchemeDef[] = [
  {
    scheme: 'India Semiconductor Mission',
    since: 2021,
    why: 'capital support of up to 50% for fabs and assembly/test plants under construction now',
    weight: 1.0,
    members: ['KAYNES', 'CGPOWER', 'TATAELXSI', 'RIR', 'ASMTEC', 'SPEL'],
  },
  {
    scheme: 'Electronics Component Manufacturing Scheme',
    since: 2025,
    why: 'incentives for passive components and sub-assemblies, the layer India still imports',
    weight: 0.9,
    members: ['DIXON', 'KAYNES', 'SYRMA', 'AMBER', 'AVALON', 'CYIENTDLM', 'ELIN', 'PGEL'],
  },
  {
    scheme: 'Defence indigenisation lists',
    since: 2020,
    why: 'positive-indigenisation lists bar imports of named systems, so domestic order books fill by rule',
    weight: 1.0,
    members: [
      'HAL', 'BEL', 'BDL', 'BEML', 'MAZDOCK', 'COCHINSHIP', 'GRSE', 'ZENTEC', 'PARAS',
      'DATAPATTNS', 'MTARTECH', 'ASTRAMICRO', 'SOLARINDS', 'APOLLO', 'IDEAFORGE', 'DYNAMATECH',
    ],
  },
  {
    scheme: 'Railway capex & Kavach',
    since: 2022,
    why: 'rolling stock, electrification and the Kavach signalling mandate are multi-year budgeted spends',
    weight: 0.8,
    members: ['RVNL', 'IRCON', 'TITAGARH', 'TEXRAIL', 'JWL', 'RITES', 'KERNEX', 'HBLENGINE', 'BEML', 'IRFC'],
  },
  {
    scheme: 'Power transmission & smart metering',
    since: 2021,
    why: 'the RDSS metering rollout and the transmission plan for renewable evacuation are funded orders',
    weight: 0.8,
    members: ['TARIL', 'APARINDS', 'KEC', 'KALPATPOWR', 'TECHNOE', 'GENUSPOWER', 'POWERGRID', 'HITACHIEN', 'TDPOWERSYS'],
  },
  {
    scheme: 'PLI: solar PV modules',
    since: 2021,
    why: 'domestic content rules plus module incentives, against a large import bill',
    weight: 0.8,
    members: ['WAAREEENER', 'PREMIERENE', 'VIKRAMSOLR', 'TATAPOWER', 'BOROSIL', 'INSOLATION'],
  },
  {
    scheme: 'PLI: advanced chemistry cells',
    since: 2021,
    why: 'battery cell manufacturing support; India imports nearly all cells today',
    weight: 0.8,
    members: ['EXIDEIND', 'ARE&M', 'OLAELEC', 'RELIANCE', 'AMARAJABAT'],
  },
  {
    scheme: 'National Critical Mineral Mission',
    since: 2025,
    why: 'exploration and processing support for minerals with no domestic supply chain',
    weight: 0.8,
    members: ['NMDC', 'HINDZINC', 'VEDL', 'GMDCLTD', 'MOIL'],
  },
  {
    scheme: 'Shipbuilding & maritime policy',
    since: 2025,
    why: 'shipbuilding clusters, a maritime development fund and a long order pipeline from the navy',
    weight: 0.7,
    members: ['COCHINSHIP', 'MAZDOCK', 'GRSE', 'SCI', 'GESHIP', 'ABSMARINE'],
  },
  {
    scheme: 'Green hydrogen & renewables (SIGHT)',
    since: 2023,
    why: 'electrolyser and green-hydrogen production incentives; early, capital-hungry, and slipping',
    weight: 0.5,
    members: ['NTPC', 'ADANIGREEN', 'RELIANCE', 'LT', 'JSWENERGY', 'IREDA', 'SUZLON', 'INOXWIND'],
  },
  {
    scheme: 'PLI: telecom & networking',
    since: 2021,
    why: 'domestic telecom gear against Chinese imports, with BSNL as an anchor buyer',
    weight: 0.6,
    members: ['HFCL', 'TEJASNET', 'STLTECH', 'ITI'],
  },
  {
    scheme: 'PLI: pharmaceuticals & APIs',
    since: 2020,
    why: 'bulk-drug parks and API incentives to cut dependence on Chinese intermediates',
    weight: 0.6,
    members: ['DIVISLAB', 'AUROPHARMA', 'GLAND', 'LAURUSLABS', 'NEULANDLAB'],
  },
  {
    scheme: 'Drones & space privatisation',
    since: 2021,
    why: 'drone PLI and the opening of space launch and satellites to private firms',
    weight: 0.6,
    members: ['IDEAFORGE', 'ZENTEC', 'PARAS', 'DATAPATTNS', 'CENTUM', 'MTARTECH'],
  },
  {
    scheme: 'Nuclear opening to private capital',
    since: 2025,
    why: 'the announced amendment of the atomic energy law would open a build-out to private suppliers — not yet law',
    weight: 0.4,
    members: ['LT', 'BHEL', 'WALCHANNAG', 'TATAPOWER'],
  },
];

/**
 * Strategic or import-substituting production. Distinct from a scheme: this is
 * about WHAT the company makes, not what it is paid to make. A company making
 * something the country currently imports has a demand floor that survives a
 * change of government; a company on a subsidy does not.
 */
const CRITICAL: Record<string, string[]> = {
  KAYNES: ['semiconductor assembly and test', 'defence and aerospace electronics'],
  CGPOWER: ['semiconductor assembly', 'transformers and switchgear'],
  SYRMA: ['electronics manufacturing for defence and medical'],
  DIXON: ['mobile and display module assembly'],
  AMBER: ['air-conditioner components', 'electronics for railways and defence'],
  AVALON: ['high-mix electronics for defence and industrial'],
  CYIENTDLM: ['aerospace and medical electronics'],
  HAL: ['military aero-engines and airframes'],
  BEL: ['radar and defence electronics'],
  BDL: ['guided missiles'],
  MAZDOCK: ['submarines and destroyers'],
  COCHINSHIP: ['aircraft carriers and ship repair'],
  GRSE: ['warships'],
  PARAS: ['defence optics and electromagnetic systems'],
  DATAPATTNS: ['defence electronics and test systems'],
  MTARTECH: ['nuclear and space precision components'],
  ASTRAMICRO: ['radio-frequency and radar sub-systems'],
  SOLARINDS: ['explosives and ammunition'],
  ZENTEC: ['combat training simulators and anti-drone systems'],
  IDEAFORGE: ['military drones'],
  TARIL: ['extra-high-voltage transformers'],
  APARINDS: ['conductors and speciality cables for the grid'],
  GENUSPOWER: ['smart electricity meters'],
  KERNEX: ['train collision-avoidance systems'],
  HBLENGINE: ['train control and industrial batteries'],
  TITAGARH: ['freight wagons and metro coaches'],
  JWL: ['freight wagons'],
  RVNL: ['railway infrastructure execution'],
  NMDC: ['iron ore'],
  HINDZINC: ['zinc, lead and silver'],
  MOIL: ['manganese ore'],
  WAAREEENER: ['solar cells and modules'],
  PREMIERENE: ['solar cells'],
  EXIDEIND: ['lithium-ion cell manufacturing'],
  'ARE&M': ['lithium-ion cells and automotive batteries'],
  HFCL: ['optical fibre and defence radio'],
  TEJASNET: ['telecom radio and transport equipment'],
  LAURUSLABS: ['active pharmaceutical ingredients'],
  NEULANDLAB: ['complex active pharmaceutical ingredients'],
  DIVISLAB: ['active pharmaceutical ingredients at scale'],
  IREDA: ['financing for renewable capacity'],
  SUZLON: ['wind turbines'],
  INOXWIND: ['wind turbines'],
};

/** Every symbol this file has an opinion about. */
export const POLICY_UNIVERSE: string[] = [
  ...new Set([...SCHEMES.flatMap((s) => s.members), ...Object.keys(CRITICAL)]),
].sort();

/** All scheme names, for the UI legend. */
export const ALL_SCHEMES: string[] = SCHEMES.map((s) => s.scheme);

/**
 * Policy exposure for one symbol.
 *
 * The raw score saturates deliberately: a company on four schemes is not four
 * times better placed than one on a single scheme it actually earns from, and
 * rewarding a long tag list would just reward whichever company I happened to
 * type most often.
 */
export function policyFor(symbol: string): PolicyRead {
  const sym = symbol.toUpperCase();
  const tags: PolicyTag[] = [];
  let weightSum = 0;
  for (const s of SCHEMES) {
    if (!s.members.includes(sym)) continue;
    tags.push({ scheme: s.scheme, why: s.why, since: s.since });
    weightSum += s.weight;
  }
  const critical = CRITICAL[sym] ?? [];
  // A strategic product line counts for as much as a mid-weight scheme, because
  // it does not depend on a subsidy surviving the next budget.
  if (critical.length) weightSum += 0.8;

  // 1 − e^(−x) saturates at 1: the first scheme is worth most, the fourth
  // barely moves the number.
  const raw = weightSum > 0 ? 1 - Math.exp(-weightSum) : 0;
  return { symbol: sym, tags, critical, raw: Math.round(raw * 1000) / 1000 };
}

/** Does this file have any opinion at all about this symbol? */
export function hasPolicyView(symbol: string): boolean {
  return policyFor(symbol).tags.length > 0 || (CRITICAL[symbol.toUpperCase()] ?? []).length > 0;
}
