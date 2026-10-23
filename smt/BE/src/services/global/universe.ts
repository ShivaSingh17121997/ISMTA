/**
 * The countries the Global Markets page compares, with the index, the currency
 * conversion to USD, and a curated list of each market's largest companies.
 *
 * CURRENCY. Everything is ranked in RUPEES, because that is what an Indian
 * investor earns: the local index move plus the move of that currency against
 * the rupee. `fx` gives USD per unit of local currency: a Yahoo "XXXUSD=X"
 * quote already is that; a "XXX=X" quote is local-per-USD and is inverted.
 *
 * NOT COVERED: Thailand (^SET.BK) and Saudi Arabia (^TASI.SR) — Yahoo serves only
 * the latest bar for those indices, and a ranking needs years of history.
 *
 * THE STOCK LISTS ARE HAND-PICKED from today's biggest companies, so they carry
 * survivorship bias (yesterday's giants that collapsed are not here). They are
 * used to name the leaders inside a strong market, never to claim a backtest.
 */

export interface FxSpec {
  ticker: string;
  /** true when the quote is local currency per USD (JPY=X), false when USD per local (EURUSD=X). */
  invert: boolean;
}

export interface Leader {
  ticker: string;
  name: string;
}

export interface Country {
  code: string;
  name: string;
  region: 'Americas' | 'Europe' | 'Asia-Pacific' | 'Middle East & Africa' | 'India';
  index: string;
  indexName: string;
  currency: string;
  /** null for USD markets (and India, which is already in rupees). */
  fx: FxSpec | null;
  leaders: Leader[];
}

const inv = (ticker: string): FxSpec => ({ ticker, invert: true });
const dir = (ticker: string): FxSpec => ({ ticker, invert: false });

export const INR_PER_USD = 'INR=X';

export const COUNTRIES: Country[] = [
  {
    code: 'US', name: 'United States', region: 'Americas', index: '^GSPC', indexName: 'S&P 500', currency: 'USD', fx: null,
    leaders: [
      { ticker: 'NVDA', name: 'Nvidia' }, { ticker: 'MSFT', name: 'Microsoft' }, { ticker: 'AAPL', name: 'Apple' },
      { ticker: 'AMZN', name: 'Amazon' }, { ticker: 'GOOGL', name: 'Alphabet' }, { ticker: 'META', name: 'Meta' },
      { ticker: 'AVGO', name: 'Broadcom' }, { ticker: 'JPM', name: 'JPMorgan Chase' }, { ticker: 'LLY', name: 'Eli Lilly' },
      { ticker: 'BRK-B', name: 'Berkshire Hathaway' }, { ticker: 'XOM', name: 'Exxon Mobil' }, { ticker: 'COST', name: 'Costco' },
    ],
  },
  {
    code: 'US-TECH', name: 'United States (Nasdaq 100)', region: 'Americas', index: '^NDX', indexName: 'Nasdaq 100', currency: 'USD', fx: null,
    leaders: [],
  },
  {
    code: 'CA', name: 'Canada', region: 'Americas', index: '^GSPTSE', indexName: 'S&P/TSX Composite', currency: 'CAD', fx: inv('CAD=X'),
    leaders: [
      { ticker: 'RY.TO', name: 'Royal Bank of Canada' }, { ticker: 'TD.TO', name: 'Toronto-Dominion Bank' }, { ticker: 'SHOP.TO', name: 'Shopify' },
      { ticker: 'ENB.TO', name: 'Enbridge' }, { ticker: 'CNR.TO', name: 'Canadian National Railway' }, { ticker: 'BN.TO', name: 'Brookfield' },
    ],
  },
  {
    code: 'BR', name: 'Brazil', region: 'Americas', index: '^BVSP', indexName: 'Bovespa', currency: 'BRL', fx: inv('BRL=X'),
    leaders: [
      { ticker: 'PETR4.SA', name: 'Petrobras' }, { ticker: 'VALE3.SA', name: 'Vale' }, { ticker: 'ITUB4.SA', name: 'Itaú Unibanco' },
      { ticker: 'BBDC4.SA', name: 'Bradesco' }, { ticker: 'WEGE3.SA', name: 'WEG' }, { ticker: 'ABEV3.SA', name: 'Ambev' },
    ],
  },
  {
    code: 'MX', name: 'Mexico', region: 'Americas', index: '^MXX', indexName: 'IPC', currency: 'MXN', fx: inv('MXN=X'),
    leaders: [
      { ticker: 'WALMEX.MX', name: 'Walmart de México' }, { ticker: 'AMXB.MX', name: 'América Móvil' },
      { ticker: 'GFNORTEO.MX', name: 'Banorte' }, { ticker: 'FEMSAUBD.MX', name: 'FEMSA' }, { ticker: 'GMEXICOB.MX', name: 'Grupo México' },
    ],
  },
  {
    code: 'UK', name: 'United Kingdom', region: 'Europe', index: '^FTSE', indexName: 'FTSE 100', currency: 'GBP', fx: dir('GBPUSD=X'),
    leaders: [
      { ticker: 'AZN.L', name: 'AstraZeneca' }, { ticker: 'SHEL.L', name: 'Shell' }, { ticker: 'HSBA.L', name: 'HSBC' },
      { ticker: 'ULVR.L', name: 'Unilever' }, { ticker: 'RIO.L', name: 'Rio Tinto' }, { ticker: 'RR.L', name: 'Rolls-Royce' }, { ticker: 'BA.L', name: 'BAE Systems' },
    ],
  },
  {
    code: 'DE', name: 'Germany', region: 'Europe', index: '^GDAXI', indexName: 'DAX', currency: 'EUR', fx: dir('EURUSD=X'),
    leaders: [
      { ticker: 'SAP.DE', name: 'SAP' }, { ticker: 'SIE.DE', name: 'Siemens' }, { ticker: 'ALV.DE', name: 'Allianz' },
      { ticker: 'DTE.DE', name: 'Deutsche Telekom' }, { ticker: 'RHM.DE', name: 'Rheinmetall' }, { ticker: 'MBG.DE', name: 'Mercedes-Benz' },
    ],
  },
  {
    code: 'FR', name: 'France', region: 'Europe', index: '^FCHI', indexName: 'CAC 40', currency: 'EUR', fx: dir('EURUSD=X'),
    leaders: [
      { ticker: 'MC.PA', name: 'LVMH' }, { ticker: 'TTE.PA', name: 'TotalEnergies' }, { ticker: 'SAN.PA', name: 'Sanofi' },
      { ticker: 'AIR.PA', name: 'Airbus' }, { ticker: 'OR.PA', name: "L'Oréal" }, { ticker: 'SU.PA', name: 'Schneider Electric' },
    ],
  },
  {
    code: 'CH', name: 'Switzerland', region: 'Europe', index: '^SSMI', indexName: 'SMI', currency: 'CHF', fx: inv('CHF=X'),
    leaders: [
      { ticker: 'NESN.SW', name: 'Nestlé' }, { ticker: 'NOVN.SW', name: 'Novartis' }, { ticker: 'ZURN.SW', name: 'Zurich Insurance' },
      { ticker: 'UBSG.SW', name: 'UBS' }, { ticker: 'ABBN.SW', name: 'ABB' },
    ],
  },
  {
    code: 'NL', name: 'Netherlands', region: 'Europe', index: '^AEX', indexName: 'AEX', currency: 'EUR', fx: dir('EURUSD=X'),
    leaders: [
      { ticker: 'ASML.AS', name: 'ASML' }, { ticker: 'INGA.AS', name: 'ING' }, { ticker: 'PRX.AS', name: 'Prosus' }, { ticker: 'ADYEN.AS', name: 'Adyen' },
    ],
  },
  {
    code: 'IT', name: 'Italy', region: 'Europe', index: 'FTSEMIB.MI', indexName: 'FTSE MIB', currency: 'EUR', fx: dir('EURUSD=X'),
    leaders: [
      { ticker: 'UCG.MI', name: 'UniCredit' }, { ticker: 'ISP.MI', name: 'Intesa Sanpaolo' }, { ticker: 'ENEL.MI', name: 'Enel' },
      { ticker: 'RACE.MI', name: 'Ferrari' }, { ticker: 'ENI.MI', name: 'Eni' },
    ],
  },
  {
    code: 'ES', name: 'Spain', region: 'Europe', index: '^IBEX', indexName: 'IBEX 35', currency: 'EUR', fx: dir('EURUSD=X'),
    leaders: [
      { ticker: 'SAN.MC', name: 'Banco Santander' }, { ticker: 'ITX.MC', name: 'Inditex' }, { ticker: 'IBE.MC', name: 'Iberdrola' }, { ticker: 'BBVA.MC', name: 'BBVA' },
    ],
  },
  {
    code: 'SE', name: 'Sweden', region: 'Europe', index: '^OMX', indexName: 'OMX Stockholm 30', currency: 'SEK', fx: inv('SEK=X'),
    leaders: [
      { ticker: 'ATCO-A.ST', name: 'Atlas Copco' }, { ticker: 'INVE-B.ST', name: 'Investor AB' }, { ticker: 'VOLV-B.ST', name: 'Volvo' }, { ticker: 'ERIC-B.ST', name: 'Ericsson' },
    ],
  },
  {
    code: 'JP', name: 'Japan', region: 'Asia-Pacific', index: '^N225', indexName: 'Nikkei 225', currency: 'JPY', fx: inv('JPY=X'),
    leaders: [
      { ticker: '7203.T', name: 'Toyota' }, { ticker: '6758.T', name: 'Sony' }, { ticker: '8306.T', name: 'Mitsubishi UFJ' },
      { ticker: '6861.T', name: 'Keyence' }, { ticker: '9984.T', name: 'SoftBank Group' }, { ticker: '8035.T', name: 'Tokyo Electron' }, { ticker: '6501.T', name: 'Hitachi' },
    ],
  },
  {
    code: 'HK', name: 'Hong Kong', region: 'Asia-Pacific', index: '^HSI', indexName: 'Hang Seng', currency: 'HKD', fx: inv('HKD=X'),
    leaders: [
      { ticker: '0700.HK', name: 'Tencent' }, { ticker: '9988.HK', name: 'Alibaba' }, { ticker: '1299.HK', name: 'AIA' },
      { ticker: '0005.HK', name: 'HSBC (HK)' }, { ticker: '3690.HK', name: 'Meituan' }, { ticker: '1810.HK', name: 'Xiaomi' },
    ],
  },
  {
    code: 'CN', name: 'China (mainland)', region: 'Asia-Pacific', index: '000001.SS', indexName: 'Shanghai Composite', currency: 'CNY', fx: inv('CNY=X'),
    leaders: [
      { ticker: '600519.SS', name: 'Kweichow Moutai' }, { ticker: '601318.SS', name: 'Ping An' }, { ticker: '300750.SZ', name: 'CATL' },
      { ticker: '600036.SS', name: 'China Merchants Bank' }, { ticker: '601398.SS', name: 'ICBC' },
    ],
  },
  {
    code: 'KR', name: 'South Korea', region: 'Asia-Pacific', index: '^KS11', indexName: 'KOSPI', currency: 'KRW', fx: inv('KRW=X'),
    leaders: [
      { ticker: '005930.KS', name: 'Samsung Electronics' }, { ticker: '000660.KS', name: 'SK Hynix' }, { ticker: '373220.KS', name: 'LG Energy Solution' },
      { ticker: '005380.KS', name: 'Hyundai Motor' }, { ticker: '035420.KS', name: 'Naver' },
    ],
  },
  {
    code: 'TW', name: 'Taiwan', region: 'Asia-Pacific', index: '^TWII', indexName: 'TAIEX', currency: 'TWD', fx: inv('TWD=X'),
    leaders: [
      { ticker: '2330.TW', name: 'TSMC' }, { ticker: '2317.TW', name: 'Hon Hai (Foxconn)' }, { ticker: '2454.TW', name: 'MediaTek' },
      { ticker: '2308.TW', name: 'Delta Electronics' }, { ticker: '2382.TW', name: 'Quanta Computer' },
    ],
  },
  {
    code: 'AU', name: 'Australia', region: 'Asia-Pacific', index: '^AXJO', indexName: 'S&P/ASX 200', currency: 'AUD', fx: dir('AUDUSD=X'),
    leaders: [
      { ticker: 'BHP.AX', name: 'BHP' }, { ticker: 'CBA.AX', name: 'Commonwealth Bank' }, { ticker: 'CSL.AX', name: 'CSL' },
      { ticker: 'WBC.AX', name: 'Westpac' }, { ticker: 'NAB.AX', name: 'National Australia Bank' },
    ],
  },
  {
    code: 'SG', name: 'Singapore', region: 'Asia-Pacific', index: '^STI', indexName: 'Straits Times', currency: 'SGD', fx: inv('SGD=X'),
    leaders: [
      { ticker: 'D05.SI', name: 'DBS' }, { ticker: 'O39.SI', name: 'OCBC' }, { ticker: 'U11.SI', name: 'UOB' }, { ticker: 'Z74.SI', name: 'Singtel' },
    ],
  },
  {
    code: 'ID', name: 'Indonesia', region: 'Asia-Pacific', index: '^JKSE', indexName: 'Jakarta Composite', currency: 'IDR', fx: inv('IDR=X'),
    leaders: [
      { ticker: 'BBCA.JK', name: 'Bank Central Asia' }, { ticker: 'BBRI.JK', name: 'Bank Rakyat' }, { ticker: 'TLKM.JK', name: 'Telkom Indonesia' }, { ticker: 'BMRI.JK', name: 'Bank Mandiri' },
    ],
  },
  {
    code: 'MY', name: 'Malaysia', region: 'Asia-Pacific', index: '^KLSE', indexName: 'FTSE Bursa KLCI', currency: 'MYR', fx: inv('MYR=X'),
    leaders: [
      { ticker: '1155.KL', name: 'Maybank' }, { ticker: '1295.KL', name: 'Public Bank' }, { ticker: '5347.KL', name: 'Tenaga Nasional' },
    ],
  },
  {
    code: 'IL', name: 'Israel', region: 'Middle East & Africa', index: '^TA125.TA', indexName: 'TA-125', currency: 'ILS', fx: inv('ILS=X'),
    leaders: [
      { ticker: 'TEVA.TA', name: 'Teva' }, { ticker: 'LUMI.TA', name: 'Bank Leumi' }, { ticker: 'POLI.TA', name: 'Bank Hapoalim' }, { ticker: 'ESLT.TA', name: 'Elbit Systems' },
    ],
  },
  {
    code: 'TR', name: 'Turkey', region: 'Middle East & Africa', index: 'XU100.IS', indexName: 'BIST 100', currency: 'TRY', fx: inv('TRY=X'),
    leaders: [
      { ticker: 'THYAO.IS', name: 'Turkish Airlines' }, { ticker: 'BIMAS.IS', name: 'BIM' }, { ticker: 'KCHOL.IS', name: 'Koç Holding' },
    ],
  },
  {
    code: 'IN', name: 'India (your home market)', region: 'India', index: '^BSESN', indexName: 'Sensex', currency: 'INR', fx: null,
    leaders: [],
  },
];

export const COUNTRY_BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c] as const));
