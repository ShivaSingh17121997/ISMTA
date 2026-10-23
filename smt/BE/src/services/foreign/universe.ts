/**
 * The foreign-stock universe: what a resident Indian can actually buy abroad.
 *
 * Under LRS, Indian platforms (Vested, INDmoney, ICICI Direct Global, GIFT City
 * brokers) reach US-listed shares, so the universe is US-listed:
 *   - the S&P 500, fetched from the maintained open dataset (symbol, name,
 *     GICS sector, SEC CIK);
 *   - plus large non-US companies whose shares trade in the US as ADRs, so a
 *     strong Taiwanese or Dutch company is reachable the same way.
 *
 * Today's members only: a company that left the index after collapsing is not
 * here, which flatters any backtest (survivorship). Stated wherever results show.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../utils/logger';

export interface ForeignStock {
  ticker: string;
  name: string;
  sector: string;
  /** SEC Central Index Key; null for ADRs (they file 20-F, not 10-K). */
  cik: number | null;
  /** Country of the company (US for S&P 500 members). */
  country: string;
  kind: 'sp500' | 'adr';
  /** Date the company joined the S&P 500 (YYYY-MM-DD); null for ADRs. The backtest uses a stock only from this date. */
  added: string | null;
}

const SP500_URL = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';
const CACHE = path.join(process.cwd(), '.cache', 'foreign', 'sp500.csv');
const TTL_MS = 7 * 86_400_000;

/** Large non-US companies listed in the US (ADRs or direct listings), by GICS-style sector. */
export const ADRS: ForeignStock[] = [
  ['TSM', 'TSMC', 'Information Technology', 'Taiwan'],
  ['ASML', 'ASML', 'Information Technology', 'Netherlands'],
  ['SAP', 'SAP', 'Information Technology', 'Germany'],
  ['ARM', 'Arm Holdings', 'Information Technology', 'United Kingdom'],
  ['SONY', 'Sony', 'Consumer Discretionary', 'Japan'],
  ['TM', 'Toyota', 'Consumer Discretionary', 'Japan'],
  ['NVO', 'Novo Nordisk', 'Health Care', 'Denmark'],
  ['AZN', 'AstraZeneca', 'Health Care', 'United Kingdom'],
  ['NVS', 'Novartis', 'Health Care', 'Switzerland'],
  ['SNY', 'Sanofi', 'Health Care', 'France'],
  ['SHEL', 'Shell', 'Energy', 'United Kingdom'],
  ['TTE', 'TotalEnergies', 'Energy', 'France'],
  ['BP', 'BP', 'Energy', 'United Kingdom'],
  ['HSBC', 'HSBC', 'Financials', 'United Kingdom'],
  ['MUFG', 'Mitsubishi UFJ', 'Financials', 'Japan'],
  ['RY', 'Royal Bank of Canada', 'Financials', 'Canada'],
  ['TD', 'Toronto-Dominion Bank', 'Financials', 'Canada'],
  ['UL', 'Unilever', 'Consumer Staples', 'United Kingdom'],
  ['DEO', 'Diageo', 'Consumer Staples', 'United Kingdom'],
  ['BHP', 'BHP', 'Materials', 'Australia'],
  ['RIO', 'Rio Tinto', 'Materials', 'United Kingdom'],
  ['BABA', 'Alibaba', 'Consumer Discretionary', 'China'],
  ['PDD', 'PDD Holdings', 'Consumer Discretionary', 'China'],
  ['SHOP', 'Shopify', 'Information Technology', 'Canada'],
  ['MELI', 'MercadoLibre', 'Consumer Discretionary', 'Argentina'],
  ['SE', 'Sea Limited', 'Communication Services', 'Singapore'],
  ['NU', 'Nu Holdings', 'Financials', 'Brazil'],
  ['SPOT', 'Spotify', 'Communication Services', 'Sweden'],
].map(([ticker, name, sector, country]) => ({ ticker, name, sector, cik: null, country, kind: 'adr' as const, added: null }));

/** Parse the S&P 500 constituents CSV. Pure. Quoted fields may contain commas. */
export function parseSp500(csv: string): ForeignStock[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  const out: ForeignStock[] = [];
  for (const line of lines.slice(1)) {
    const cells: string[] = [];
    let cur = '';
    let q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) {
        cells.push(cur);
        cur = '';
      } else cur += ch;
    }
    cells.push(cur);
    const [symbol, name, sector, , , added, cik] = cells;
    if (!symbol || !name) continue;
    // Yahoo writes share classes with a dash (BRK-B), the dataset with a dot (BRK.B).
    out.push({ ticker: symbol.trim().replace('.', '-'), name: name.trim(), sector: (sector || 'Unclassified').trim(), cik: Number(cik) || null, country: 'United States', kind: 'sp500', added: /^\d{4}-\d{2}-\d{2}/.test(added ?? '') ? added.slice(0, 10) : null });
  }
  return out;
}

/** S&P 500 members (cached a week) plus the ADR list. Falls back to the cached copy if the fetch fails. */
export async function loadForeignUniverse(): Promise<ForeignStock[]> {
  let csv: string | null = null;
  try {
    if (Date.now() - fs.statSync(CACHE).mtimeMs < TTL_MS) csv = fs.readFileSync(CACHE, 'utf8');
  } catch {
    csv = null;
  }
  if (!csv) {
    try {
      const res = await fetch(SP500_URL, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      csv = await res.text();
      fs.mkdirSync(path.dirname(CACHE), { recursive: true });
      fs.writeFileSync(CACHE, csv);
    } catch (e) {
      logger.warn(`S&P 500 list: ${e instanceof Error ? e.message : e}`);
      try {
        csv = fs.readFileSync(CACHE, 'utf8');
      } catch {
        csv = '';
      }
    }
  }
  const sp = parseSp500(csv);
  const have = new Set(sp.map((s) => s.ticker));
  return [...sp, ...ADRS.filter((a) => !have.has(a.ticker))];
}
