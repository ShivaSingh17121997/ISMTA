/**
 * How a resident Indian can actually reach each market, as researched on
 * 2026-10-09 (sources: AMFI NAV file, Value Research 9 Oct 2026, ICICI Pru
 * Tax Reckoner 2026-27, Vested on Budget 2026).
 *
 * THE BIG CAVEAT: India-listed international ETFs trade far above the value of
 * what they hold, because Indian funds hit their overseas investment caps
 * (US$7bn industry-wide, US$1bn for overseas ETFs, US$1bn per fund house) and
 * cannot create new units. Since SEBI re-centred the ±20% price band on the
 * previous traded price (7 Sep 2026), premiums can compound; a NAV-based band
 * returns from 1 Apr 2027, which would likely collapse them. The service
 * computes each ETF's LIVE premium from its NSE price and AMFI's NAV, and the
 * page shows it next to the name. A strong market reached through an ETF at a
 * 60% premium is not a good buy.
 *
 * Most Indian international mutual funds were closed to lump sums on 8 Oct
 * 2026. This list changes week to week, so the text says "check before you buy".
 */

export interface AccessInstrument {
  name: string;
  how: 'nse-etf' | 'india-fof' | 'lrs';
  /** NSE symbol for ETFs (Yahoo `<symbol>.NS`). */
  symbol?: string;
  /** AMFI scheme code, to read the ETF's NAV and compute its premium. */
  amfiCode?: string;
  note?: string;
}

export interface AccessRoute {
  summary: string;
  instruments: AccessInstrument[];
}

const LRS = (etf: string, what: string): AccessInstrument => ({
  name: `${etf} (US-listed ${what} ETF)`,
  how: 'lrs',
  symbol: etf,
  note: 'needs an overseas account under LRS',
});

const NO_INDIA_ROUTE = 'There is no India-listed ETF for this market. The practical route is a US-listed country ETF through an overseas account under LRS.';

export const ACCESS_ROUTES: Record<string, AccessRoute> = {
  US: {
    summary:
      'The easiest market to reach. On NSE: US index ETFs, but check the premium first. Directly: any US stock or ETF through an LRS platform (Vested, INDmoney, ICICI Direct Global and others; Zerodha has announced US stocks via GIFT City but launch is unconfirmed).',
    instruments: [
      { name: 'Motilal Oswal Nasdaq 100 ETF', how: 'nse-etf', symbol: 'MON100', amfiCode: '114984' },
      { name: 'Mirae Asset S&P 500 Top 50 ETF', how: 'nse-etf', symbol: 'MASPTOP50', amfiCode: '149169' },
      { name: 'Mirae Asset NYSE FANG+ ETF', how: 'nse-etf', symbol: 'MAFANG', amfiCode: '148927' },
      { name: 'VOO / SPY (S&P 500) or single US stocks', how: 'lrs', note: 'needs an overseas account under LRS; bought at the real price, no premium' },
    ],
  },
  'US-TECH': {
    summary: 'The Nasdaq 100 is reachable on NSE through MON100, the least distorted of India\'s US ETFs, or directly through QQQ under LRS.',
    instruments: [
      { name: 'Motilal Oswal Nasdaq 100 ETF', how: 'nse-etf', symbol: 'MON100', amfiCode: '114984' },
      { name: 'Motilal Oswal Nasdaq Q50 ETF (Nasdaq stocks ranked 101–150)', how: 'nse-etf', symbol: 'MONQ50', amfiCode: '149438' },
      { name: 'QQQ (Nasdaq 100)', how: 'lrs', note: 'needs an overseas account under LRS' },
    ],
  },
  HK: {
    summary: 'Reachable on NSE through two Hang Seng ETFs. Hang Seng BeES has traded closest to its real value.',
    instruments: [
      { name: 'Nippon India ETF Hang Seng BeES', how: 'nse-etf', symbol: 'HNGSNGBEES', amfiCode: '140095' },
      { name: 'Mirae Asset Hang Seng TECH ETF', how: 'nse-etf', symbol: 'MAHKTECH', amfiCode: '149379' },
      LRS('EWH', 'Hong Kong'),
    ],
  },
  CN: {
    summary: 'No India-listed mainland China ETF. Hong Kong ETFs on NSE hold many Chinese companies listed in Hong Kong; mainland A-shares need an overseas account.',
    instruments: [
      { name: 'Nippon India ETF Hang Seng BeES (Chinese companies listed in Hong Kong)', how: 'nse-etf', symbol: 'HNGSNGBEES', amfiCode: '140095' },
      LRS('MCHI', 'China'),
    ],
  },
  JP: {
    summary: 'No India-listed Japan ETF. Nippon India Japan Equity Fund exists but was not taking new lump sums on 8 Oct 2026; check before you buy.',
    instruments: [{ name: 'Nippon India Japan Equity Fund', how: 'india-fof', note: 'check whether it is open to new money' }, LRS('EWJ', 'Japan')],
  },
  TW: {
    summary: 'No India-listed Taiwan ETF. Nippon India Taiwan Equity Fund exists but was not taking new lump sums on 8 Oct 2026; check before you buy.',
    instruments: [{ name: 'Nippon India Taiwan Equity Fund', how: 'india-fof', note: 'check whether it is open to new money' }, LRS('EWT', 'Taiwan')],
  },
  KR: { summary: NO_INDIA_ROUTE, instruments: [LRS('EWY', 'South Korea')] },
  UK: {
    summary: 'No India-listed UK ETF. Invesco India Pan European Equity FoF (Europe-wide, includes the UK) took new SIPs only, up to ₹10 lakh per day, on 8 Oct 2026.',
    instruments: [{ name: 'Invesco India Pan European Equity FoF', how: 'india-fof', note: 'SIPs only' }, LRS('EWU', 'UK')],
  },
  DE: {
    summary: 'No India-listed Germany ETF. Europe-wide exposure: Invesco India Pan European Equity FoF (SIPs only on 8 Oct 2026).',
    instruments: [{ name: 'Invesco India Pan European Equity FoF', how: 'india-fof', note: 'SIPs only' }, LRS('EWG', 'Germany')],
  },
  FR: {
    summary: 'No India-listed France ETF. Europe-wide exposure: Invesco India Pan European Equity FoF (SIPs only on 8 Oct 2026).',
    instruments: [{ name: 'Invesco India Pan European Equity FoF', how: 'india-fof', note: 'SIPs only' }, LRS('EWQ', 'France')],
  },
  CH: { summary: NO_INDIA_ROUTE, instruments: [LRS('EWL', 'Switzerland')] },
  NL: { summary: NO_INDIA_ROUTE, instruments: [LRS('EWN', 'Netherlands')] },
  IT: { summary: NO_INDIA_ROUTE, instruments: [LRS('EWI', 'Italy')] },
  ES: { summary: NO_INDIA_ROUTE, instruments: [LRS('EWP', 'Spain')] },
  SE: { summary: NO_INDIA_ROUTE, instruments: [LRS('EWD', 'Sweden')] },
  CA: { summary: NO_INDIA_ROUTE, instruments: [LRS('EWC', 'Canada')] },
  BR: {
    summary: 'HSBC Brazil Fund reopened in Aug 2026 with a ₹2 lakh per month cap but was not open to lump sums on 8 Oct 2026; check before you buy. Otherwise a US-listed Brazil ETF under LRS.',
    instruments: [{ name: 'HSBC Brazil Fund', how: 'india-fof', note: 'capped; check whether it is open' }, LRS('EWZ', 'Brazil')],
  },
  MX: { summary: NO_INDIA_ROUTE, instruments: [LRS('EWW', 'Mexico')] },
  AU: { summary: NO_INDIA_ROUTE, instruments: [LRS('EWA', 'Australia')] },
  SG: { summary: NO_INDIA_ROUTE, instruments: [LRS('EWS', 'Singapore')] },
  ID: { summary: NO_INDIA_ROUTE, instruments: [LRS('EIDO', 'Indonesia')] },
  MY: { summary: NO_INDIA_ROUTE, instruments: [LRS('EWM', 'Malaysia')] },
  IL: { summary: NO_INDIA_ROUTE, instruments: [LRS('EIS', 'Israel')] },
  TR: { summary: NO_INDIA_ROUTE, instruments: [LRS('TUR', 'Turkey')] },
};

/** All India-listed ETFs with a NAV to compare against. */
export const INDIA_ETFS: { symbol: string; amfiCode: string; name: string }[] = (() => {
  const seen = new Map<string, { symbol: string; amfiCode: string; name: string }>();
  for (const r of Object.values(ACCESS_ROUTES)) {
    for (const i of r.instruments) if (i.how === 'nse-etf' && i.symbol && i.amfiCode) seen.set(i.symbol, { symbol: i.symbol, amfiCode: i.amfiCode, name: i.name });
  }
  return [...seen.values()];
})();

/** Above this premium to NAV the page calls the ETF overpriced. */
export const PREMIUM_WARN = 0.05;

/** Tax and cost facts for FY2026-27, shown once on the page. */
export const INVESTING_ABROAD_FACTS: string[] = [
  'Tax on India-listed international ETFs: long term after 12 months at 12.5%, no ₹1.25 lakh exemption; short term at your slab rate.',
  'Tax on international mutual funds and foreign shares held directly: long term after 24 months at 12.5%; short term at your slab rate.',
  'US dividends: 25% withheld in the US; taxed again at your slab rate in India, with a credit for the US tax (file Form 67).',
  'LRS: up to US$250,000 a year. 20% TCS on investment remittances above ₹10 lakh a year; it comes back as a credit when you file, but the cash is tied up until then.',
  'Direct US holdings: declare them every year in Schedule FA of your return. US estate tax can apply above US$60,000 of US assets.',
  'FX: platforms usually charge about 1.5–2.5% to convert rupees to dollars, plus a bank remittance fee.',
];

/** Parse AMFI's NAVAll.txt into code → { nav, date }. Pure. */
export function parseAmfiNav(text: string): Map<string, { nav: number; date: string }> {
  const out = new Map<string, { nav: number; date: string }>();
  for (const line of text.split(/\r?\n/)) {
    const c = line.split(';');
    if (c.length < 6 || !/^\d+$/.test(c[0].trim())) continue;
    const nav = Number(c[c.length - 2]);
    if (Number.isFinite(nav) && nav > 0) out.set(c[0].trim(), { nav, date: c[c.length - 1].trim() });
  }
  return out;
}
