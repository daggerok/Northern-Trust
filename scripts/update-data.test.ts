/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  CONTROL_NAMES,
  runUpdater,
  setApiRootForTests,
  configureFetchForTests,
  paceRequests,
  fetchWithRetry,
  chartUrl,
  emptyMetrics,
  indexRowFromMeta,
  isOlderReport,
  isCertError,
  installSystemCa,
  readConfig,
  resolveControls,
  runtimeControls,
  parseRange,
  parseAumRange,
  normalizeNumberText,
  parseCsv,
  findHeaderRowIndex,
  csvRecords,
  pickColumn,
  normalizeNorthernTrustCategory,
  northernTrustCikFor,
  decodeNorthernTrustEntities,
  parseNorthernTrustCatalog,
  parseNorthernTrustFacts,
  parseNorthernTrustHoldings,
  parseNorthernTrustPricing,
  parseNorthernTrustDistributionsCsv,
  compareHoldingRows,
  navTotalReturnDays,
  reinvestmentCoverageStart,
  DIVIDEND_SCHEDULE_CAP,
  decodeDividendFrequency,
  annualizedSinceInception,
  weightsSum,
  parseNport,
  parseNportAccessions,
  nportUrlFor,
  pickEftsCik,
  parseFundTickerMap,
  parseCompanyTickerMap,
  edgarSeriesFilingsUrl,
  parseEdgarAtomFilings,
  parseChart,
  priceReturns,
  lastCompletedQuarterEnd,
  annualizedToTotal,
  totalToAnnualized,
  indicatedYield,
  inferDistributionFrequency,
  deriveCatalogMetrics,
  ensureMetricsContract,
  labelToIsoDate,
  formatEdgarDate,
  fractionToPercent,
  toIsoDate,
  isoToEpoch,
  epochToIsoDate,
  numberOrNull,
  normalizeHoldingName,
  normalizeHoldingNameCore,
  cleanHoldingTicker,
  northernTrustFundPageUrl,
  northernTrustFileUrl,
  northernTrustAllCsvUrl,
  northernTrustHoldingsCsvUrl,
  northernTrustDistributionsCsvUrl,
  northernTrustPricingJsonUrl,
  northernTrustEtfChartsJsonUrl,
  HOLDINGS_HEADERS,
  BOND_SHEET_HEADERS,
  HISTORY_HEADERS,
  YAHOO_HISTORY_HEADERS,
} from './update-data';

// ---------------------------------------------------------------------------
// Range parsers (same contract as daggerok/iShares, daggerok/SPDR, daggerok/Fidelity)
// ---------------------------------------------------------------------------

describe('parseRange', () => {
  test('empty and ":" mean no restriction', () => {
    expect(parseRange('', 'X')).toBeUndefined();
    expect(parseRange(':', 'X')).toBeUndefined();
  });

  test('inclusive bounds', () => {
    expect(parseRange('1:5', 'X')).toEqual({ min: 1, max: 5 });
    expect(parseRange('2:', 'X')).toEqual({ min: 2, max: undefined });
    expect(parseRange(':3', 'X')).toEqual({ min: undefined, max: 3 });
  });

  test('percent signs and $ signs are optional', () => {
    expect(parseRange('0.1%:0.5%', 'X')).toEqual({ min: 0.1, max: 0.5 });
    expect(parseRange('$1:$2', 'X')).toEqual({ min: 1, max: 2 });
  });

  test('colonless values are rejected', () => {
    expect(() => parseRange('15', 'X')).toThrow(/colon is required/);
  });

  test('min greater than max is rejected', () => {
    expect(() => parseRange('5:1', 'X')).toThrow(/must not exceed/);
  });
});

describe('parseAumRange', () => {
  test('empty and ":" mean no restriction', () => {
    expect(parseAumRange('')).toBeUndefined();
    expect(parseAumRange(':')).toBeUndefined();
  });

  test('numeric bounds with K/M/B/T suffixes', () => {
    expect(parseAumRange('10M:2B')).toEqual({ min: 10_000_000, max: 2_000_000_000 });
    expect(parseAumRange('1B:')).toEqual({ min: 1_000_000_000, max: undefined });
  });

  test('preset bounds', () => {
    expect(parseAumRange('nano')).toEqual({ min: 0, max: 10_000_000 });
    expect(parseAumRange('micro')).toEqual({ min: 10_000_000, max: 300_000_000 });
    expect(parseAumRange('small')).toEqual({ min: 300_000_000, max: 2_000_000_000 });
    expect(parseAumRange('mid')).toEqual({ min: 2_000_000_000, max: 10_000_000_000 });
    expect(parseAumRange('large')).toEqual({ min: 10_000_000_000, max: undefined });
  });

  test('colonless values are rejected', () => {
    expect(() => parseAumRange('42')).toThrow(/colon is required/);
  });
});

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

describe('normalizeNumberText', () => {
  test('expands scientific notation', () => {
    expect(normalizeNumberText('2.97057744E8')).toBe('297057744');
    expect(normalizeNumberText('1.5e-3')).toBe('0.0015');
  });

  test('keeps plain numbers and text untouched', () => {
    expect(normalizeNumberText('1,234.56')).toBe('1234.56');
    expect(normalizeNumberText('Apple Inc')).toBe('Apple Inc');
    expect(normalizeNumberText('')).toBe('');
    expect(normalizeNumberText('-')).toBe('-');
  });
});

describe('numberOrNull', () => {
  test('accepts the issuer placeholder styles', () => {
    expect(numberOrNull('--')).toBeNull();
    expect(numberOrNull('—')).toBeNull();
    expect(numberOrNull('N/A')).toBeNull();
    expect(numberOrNull('4.56')).toBe(4.56);
    expect(numberOrNull('$1,234.56')).toBe(1234.56);
    expect(numberOrNull('0.40%')).toBe(0.4);
  });
});

describe('toIsoDate / formatEdgarDate', () => {
  test('US and ISO dates both normalize to ISO', () => {
    expect(toIsoDate('08/21/2026')).toBe('2026-08-21');
    expect(toIsoDate('2026-08-21')).toBe('2026-08-21');
    expect(toIsoDate('2026-8-1')).toBe('2026-08-01');
    expect(toIsoDate('n/a')).toBe('n/a');
  });

  test('the feed renders "Mon D YYYY"', () => {
    expect(formatEdgarDate('2026-06-30')).toBe('Jun 30 2026');
  });

  test('epoch days convert to ISO', () => {
    expect(isoToEpoch('2026-01-15')).toBe(Date.UTC(2026, 0, 15) / 1000);
    expect(isoToEpoch('nope')).toBeNull();
  });
});

describe('parseCsv / header detection', () => {
  test('handles quotes, embedded commas and CRLF', () => {
    const rows = parseCsv('a,b\r\n"x, y","say ""hi"""\r\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ]);
  });

  test('drops blank lines and strips a BOM', () => {
    const rows = parseCsv('\uFEFFTicker,Name\r\n\r\nQLC,Northern Trust US Quality Large Cap ETF\r\n');
    expect(rows).toEqual([
      ['Ticker', 'Name'],
      ['QLC', 'Northern Trust US Quality Large Cap ETF'],
    ]);
  });

  test('finds the header row after preamble lines', () => {
    const rows = parseCsv(['Northern Trust', 'Daily holdings', '', 'Date,CUSIP,Name,Ticker,Market Value-Base,Fund Weight %,Shares Held', '09/25/2026,67066G104,NVIDIA,NVDA,1,7.8,100'].join('\n'));
    const headerIndex = findHeaderRowIndex(rows, ['Ticker', 'CUSIP', 'Fund Weight']);
    expect(headerIndex).toBe(2);
    expect(rows[headerIndex][0]).toBe('Date');
    expect(findHeaderRowIndex(rows, ['Nope'])).toBe(-1);
  });

  test('csvRecords keeps the first of two identically named columns', () => {
    const rows = parseCsv('Fund Ticker,Ticker,Name\nQQQ,QQQ,Apple Inc');
    const records = csvRecords(rows, 0);
    expect(pickColumn(records[0], ['Ticker'])).toBe('QQQ');
    expect(pickColumn(records[0], ['Name'])).toBe('Apple Inc');
    expect(pickColumn(records[0], ['Missing'])).toBe('');
  });

  test('csvRecords skips empty rows and trims cells', () => {
    const rows = parseCsv('Ticker,Name\n QLC , Northern Trust US Quality Large Cap ETF \n,,\n');
    expect(csvRecords(rows, 0)).toEqual([{ Ticker: 'QLC', Name: 'Northern Trust US Quality Large Cap ETF' }]);
  });
});

// ---------------------------------------------------------------------------
// Catalog layer: the funds-list page JSON
// ---------------------------------------------------------------------------

// Live shape captured 2026-09-27 from
// https://etfs.ntam.northerntrust.com/us/en/individual/funds (data-content
// JSON, entities as served). QLC: seasoned equity fund; GUNR: two asset-class
// tags; TXCA: five days old, every performance cell "--"; TEST: synthetic
// edge row (no page path, minimal pricing).
const NORTHERN_CATALOG_PAGE_FIXTURE = (() => {
  const document = {
    sectionTitle: 'SEARCH FUNDS',
    fundList: [
      {
        ticker: 'QLC',
        assetClassTags: { equity: 'Equity' },
        investmentObjectiveTags: { 'capital-appreciation': 'Capital Appreciation' },
        pagePath: '/us/en/individual/funds/qlc',
        pricing: {
          'fund-name': 'Northern Trust US Quality Large Cap ETF',
          'closing-market-price': '$92.01',
          'as-of-date': '09/25/2026',
          'inception-date': '09/23/2015',
          'gross-expense-ratio': '0.26%',
          'net-expense-ratio': '0.25%',
        },
        'monthly-performance-nav': {
          'month-end-as-of-date': '08/31/2026',
          '1-mo': '2.01%', qtd: '2.61%', ytd: '14.50%', '1-yr': '24.89%',
          '3-yr': '23.97%', '5-yr': '14.34%', '7-yr': '17.19%',
          '10-yr': '14.73%', 'since-inception': '14.31%',
        },
        'monthly-performance-market': {
          'month-end-as-of-date': '08/31/2026',
          '1-mo': '1.99%', qtd: '2.64%', ytd: '14.38%', '1-yr': '24.91%',
          '3-yr': '23.95%', '5-yr': '14.32%', '7-yr': '17.18%',
          '10-yr': '14.74%', 'since-inception': '14.31%',
        },
        'quarterly-performance-nav': {
          'quarter-end-as-of-date': '06/30/2026',
          '1-mo': '.09%', qtd: '15.37%', ytd: '11.58%', '1-yr': '27.77%',
          '3-yr': '23.68%', '5-yr': '15.05%', '7-yr': '16.53%',
          '10-yr': '14.91%', 'since-inception': '14.28%',
        },
      },
      {
        ticker: 'GUNR',
        assetClassTags: { 'real-assets': 'Real Assets', equity: 'Equity' },
        investmentObjectiveTags: { 'risk-management': 'Risk Management' },
        pagePath: '/us/en/individual/funds/gunr',
        pricing: {
          'fund-name': 'Northern Trust Morningstar Global Upstream Natural Resources ETF',
          'closing-market-price': '$53.83',
          'as-of-date': '09/25/2026',
          'inception-date': '09/16/2011',
          'gross-expense-ratio': '0.47%',
          'net-expense-ratio': '0.46%',
        },
        'monthly-performance-nav': {
          'month-end-as-of-date': '08/31/2026',
          '1-mo': '7.75%', qtd: '14.36%', ytd: '23.91%', '1-yr': '34.22%',
          '3-yr': '14.62%', '5-yr': '12.54%', '7-yr': '12.78%',
          '10-yr': '11.24%', 'since-inception': '6.25%',
        },
      },
      {
        ticker: 'TXCA',
        assetClassTags: { 'fixed-income': 'Fixed Income' },
        investmentObjectiveTags: { 'income-generation': 'Income Generation' },
        pagePath: '/us/en/individual/funds/txca',
        pricing: {
          'fund-name': 'Northern Trust California Intermediate Tax-Exempt Bond ETF',
          'closing-market-price': '$49.50',
          'as-of-date': '09/25/2026',
          'inception-date': '09/22/2026',
          'gross-expense-ratio': '0.06%',
          'net-expense-ratio': '0.06%',
        },
        'monthly-performance-nav': {
          'month-end-as-of-date': '--',
          '1-mo': '--', qtd: '--', ytd: '--', '1-yr': '--',
          '3-yr': '--', '5-yr': '--', '7-yr': '--',
          '10-yr': '--', 'since-inception': '--',
        },
      },
      {
        ticker: 'TEST',
        assetClassTags: {},
        investmentObjectiveTags: {},
        pricing: { 'fund-name': 'Synthetic Edge Fund' },
      },
    ],
  };
  const featured = { title: 'FEATURED FUNDS', links: [] };
  const escaped = (value: unknown): string => JSON.stringify(value).replace(/"/g, '&#34;');
  return `<html><body><div data-content="${escaped(featured)}"></div><div data-content="${escaped(document)}"></div></body></html>`;
})();

describe('parseNorthernTrustCatalog', () => {
  test('reads every fund row with ticker, name, class, objective and pricing', () => {
    const funds = parseNorthernTrustCatalog(NORTHERN_CATALOG_PAGE_FIXTURE);
    expect(funds.map((fund) => fund.ticker)).toEqual(['GUNR', 'QLC', 'TEST', 'TXCA']);
    const qlc = funds.find((fund) => fund.ticker === 'QLC')!;
    expect(qlc.name).toBe('Northern Trust US Quality Large Cap ETF');
    expect(qlc.category).toBe('Equity');
    expect(qlc.categoryPath).toBe('Equity / Capital Appreciation');
    expect(qlc.inception).toBe('2015-09-23');
    expect(qlc.ter).toBe(0.25);
    expect(qlc.terGross).toBe(0.26);
    expect(qlc.close).toBe(92.01);
    expect(qlc.asOfDate).toBe('2026-09-25');
    expect(qlc.returns).toEqual({ ytd: 14.5, yr1: 24.89, yr3: 23.97, yr5: 14.34, yr10: 14.73, sinceInception: 14.31 });
    expect(qlc.returnsAsOfDate).toBe('2026-08-31');
    expect(qlc.mo1).toBe(2.01);
    expect(qlc.marketReturns.ytd).toBe(14.38);
    expect(qlc.quarterEnd.ytd).toBe(11.58);
    expect(qlc.quarterEndAsOfDate).toBe('2026-06-30');
    expect(qlc.fundPage).toBe('https://etfs.ntam.northerntrust.com/us/en/individual/funds/qlc');
    expect(qlc.trustCik).toBe('0001491978');
    expect(qlc.source).toBe('northerntrust');
  });

  test('joins several asset-class tags deterministically and seeds the registrant', () => {
    const funds = parseNorthernTrustCatalog(NORTHERN_CATALOG_PAGE_FIXTURE);
    const gunr = funds.find((fund) => fund.ticker === 'GUNR')!;
    expect(gunr.category).toBe('Equity / Real Assets');
    expect(gunr.trustCik).toBe('0001491978');
    const txca = funds.find((fund) => fund.ticker === 'TXCA')!;
    expect(txca.category).toBe('Fixed Income');
    expect(txca.inception).toBe('2026-09-22');
    expect(txca.trustCik).toBe('0000916620');
  });

  test('unpublished "--" cells become nulls, missing page paths fall back to the builder', () => {
    const funds = parseNorthernTrustCatalog(NORTHERN_CATALOG_PAGE_FIXTURE);
    const txca = funds.find((fund) => fund.ticker === 'TXCA')!;
    expect(txca.returns).toEqual({ ytd: null, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null });
    expect(txca.returnsAsOfDate).toBeNull();
    expect(txca.mo1).toBeNull();
    expect(txca.nav).toBeNull();
    const edge = funds.find((fund) => fund.ticker === 'TEST')!;
    expect(edge.category).toBe('ETF');
    expect(edge.fundPage).toBe('https://etfs.ntam.northerntrust.com/us/en/individual/funds/test');
  });

  test('a page without the funds-list JSON fails loudly', () => {
    expect(() => parseNorthernTrustCatalog('<html><body>no funds here</body></html>')).toThrow(/funds-list JSON not found/);
    expect(() => parseNorthernTrustCatalog('')).toThrow(/funds-list JSON not found/);
  });
});
describe('northernTrustCikFor', () => {
  test('maps the Northern Funds series to its own registrant', () => {
    for (const ticker of ['TIPA', 'MUNA', 'TAXS', 'TAXI', 'TAXT', 'TXCA', 'TXNY', 'NOEQ']) {
      expect(northernTrustCikFor(ticker)).toBe('0000916620');
    }
    expect(northernTrustCikFor('tipa')).toBe('0000916620');
  });

  test('every other ticker defaults to FlexShares Trust', () => {
    for (const ticker of ['QLC', 'SKOR', 'GUNR', 'ESG', 'TILT']) {
      expect(northernTrustCikFor(ticker)).toBe('0001491978');
    }
  });
});

describe('decodeNorthernTrustEntities', () => {
  test('decodes the attribute-escaped entities of the data-content JSON', () => {
    expect(decodeNorthernTrustEntities('&#34;QLC&#34;')).toBe('"QLC"');
    expect(decodeNorthernTrustEntities('JPMORGAN CHASE &#38; CO')).toBe('JPMORGAN CHASE & CO');
    expect(decodeNorthernTrustEntities('a &amp; b')).toBe('a & b');
    expect(decodeNorthernTrustEntities('&amp;#34;')).toBe('"');
    expect(decodeNorthernTrustEntities('&lt;x&gt; &quot;y&quot; &#39;z&#39;')).toBe('<x> "y" \'z\'');
    expect(decodeNorthernTrustEntities(null)).toBe('');
  });
});
describe('normalizeNorthernTrustCategory', () => {
  test('keeps the published asset class, collapsed and trimmed', () => {
    expect(normalizeNorthernTrustCategory('Equity')).toBe('Equity');
    expect(normalizeNorthernTrustCategory('  Fixed   Income ')).toBe('Fixed Income');
    expect(normalizeNorthernTrustCategory('Real Assets')).toBe('Real Assets');
  });

  test('missing classes fall back to ETF', () => {
    expect(normalizeNorthernTrustCategory('')).toBe('ETF');
    expect(normalizeNorthernTrustCategory(null)).toBe('ETF');
    expect(normalizeNorthernTrustCategory(undefined)).toBe('ETF');
  });
});

// ---------------------------------------------------------------------------
// Northern Trust per-fund downloads
// ---------------------------------------------------------------------------
// Real qlc-all.csv lines captured 2026-09-27 (sections after the
// quarter-end grid are ignored by the feed and omitted here).
const NORTHERN_FACTS_FIXTURE = `Data as of 09/25/2026
Fund Facts
Inception,"09/23/2015"
Primary Exchange,"CBOE"
TICKER,"QLC"
Related Index,"NTUQVM"
CUSIP,"33939L746"
Shares Outstanding,""
Shares Outstanding,"12,275,001"
Gross Expense Ratio,".26"%
Net Expense Ratio,".25"%
No. of Holdings,"162.00"
Total Net Assets,$1129188730.60
SEC Subsidized Yield (as of 09/25/2026),".95"%
SEC Unsubsidized Yield (as of 09/25/2026),".94"%
Distribution Yield,".97"%
12-Month Dividend Yield,".95"%
Premium/Discount,".0208"
NAV Price,$91.99
Pricing
Market Price,$92.01
Month-End Performance (as of 08/31/2026),1 Month,QTD,YTD,1 Year,3 Year,5 Year,7 Year,10 Year,Since Inception
"S&P 500 Index (SPXT)","2.72","2.66","13.14","20.38","21.04","12.79","16.53","15.38","15.37"
"Northern Trust Quality Large Cap Index (NTUQVMTR)","2.01","2.66","14.64","25.25","24.31","14.68","17.53","15.06","14.65"
"Market Price","1.99","2.64","14.38","24.91","23.95","14.32","17.18","14.74","14.31"
"NAV","2.01","2.61","14.50","24.89","23.97","14.34","17.19","14.73","14.31"
Quarter-End Performance (as of 06/30/2026),1 Month,QTD,YTD,1 Year,3 Year,5 Year,7 Year,10 Year,Since Inception
"Market Price","-.05","15.27","11.44","27.49","23.66","15.01","16.54","14.90","14.27"
"NAV",".09","15.37","11.58","27.77","23.68","15.05","16.53","14.91","14.28"
Sector (%)
"Information Technology","36.20"`;

const NORTHERN_ETFCHARTS_FIXTURE = {
  name: 'QLC',
  Ticker: 'QLC',
  AsOfDate: '09/25/2026',
  FundName: 'Northern Trust US Quality Large Cap ETF',
  AssetType: 'Equity',
};

describe('parseNorthernTrustFacts', () => {
  test('reads fund facts, pricing and both official return grids', () => {
    const facts = parseNorthernTrustFacts(NORTHERN_FACTS_FIXTURE, NORTHERN_ETFCHARTS_FIXTURE, 'QLC');
    expect(facts.ticker).toBe('QLC');
    expect(facts.name).toBe('Northern Trust US Quality Large Cap ETF');
    expect(facts.cusip).toBe('33939L746');
    expect(facts.exchange).toBe('CBOE');
    expect(facts.assetClass).toBe('Equity');
    expect(facts.benchmark).toBe('NTUQVM');
    expect(facts.inception).toBe('2015-09-23');
    expect(facts.grossExpense).toBe(0.26);
    expect(facts.netExpense).toBe(0.25);
    expect(facts.nav).toBe(91.99);
    expect(facts.navDate).toBe('2026-09-25');
    expect(facts.marketPrice).toBe(92.01);
    expect(facts.premiumDiscount).toBe(0.0208);
    expect(facts.netAssets).toBe(1129188730.6);
    expect(facts.sharesOutstanding).toBe(12275001);
    expect(facts.numberOfHoldings).toBe(162);
    expect(facts.dividendYield).toBe(0.95);
    expect(facts.secYield).toBe(0.95);
    expect(facts.unsubsidizedSecYield).toBe(0.94);
    expect(facts.monthEnd).toEqual({
      ytd: 14.5, yr1: 24.89, yr3: 23.97, yr5: 14.34, yr10: 14.73,
      sinceInception: 14.31, asOfDate: '2026-08-31', mo1: 2.01, mo3: null,
    });
    expect(facts.monthEndMarket.ytd).toBe(14.38);
    expect(facts.quarterEnd.ytd).toBe(11.58);
    expect(facts.quarterEnd.asOfDate).toBe('2026-06-30');
    expect(facts.holdings).toBeNull();
  });

  test('a duplicated key keeps its last non-empty value, "N/A" indexes stay blank', () => {
    const facts = parseNorthernTrustFacts(
      NORTHERN_FACTS_FIXTURE.replace('Related Index,"NTUQVM"', 'Related Index,"N/A"'),
      NORTHERN_ETFCHARTS_FIXTURE,
      'QLC',
    );
    expect(facts.sharesOutstanding).toBe(12275001);
    expect(facts.benchmark).toBe('');
  });

  test('the published distribution frequency rides along for the frequency chain', () => {
    const ladder = parseNorthernTrustFacts(
      NORTHERN_FACTS_FIXTURE.replace('Total Net Assets,', 'Income Distribution Frequency,"Monthly"\nTotal Net Assets,'),
      { ...NORTHERN_ETFCHARTS_FIXTURE, AssetType: 'Fixed Income' },
      'TIPA',
    );
    expect(ladder.frequencyCode).toBe('Monthly');
    expect(ladder.assetClass).toBe('Fixed Income');
    expect(decodeDividendFrequency(ladder.frequencyCode)).toEqual({ frequency: 'Monthly', paymentsPerYear: 12 });
  });

  test('young funds without performance grids still parse (TXCA shape)', () => {
    const facts = parseNorthernTrustFacts(
      `Data as of 09/25/2026\nFund Facts\nInception,"09/22/2026"\nPrimary Exchange,"NASDAQ"\nTICKER,"TXCA"\nRelated Index,"MUMFCA"\nCUSIP,"66516K855"\nGross Expense Ratio,".06"%\nNet Expense Ratio,".06"%\nNo. of Holdings,"299.00"\nTotal Net Assets,$7419138.35\nSEC Subsidized Yield (as of 09/25/2026),"NA"%\n12-Month Dividend Yield,"NA"%\nNAV Price,$49.46\nPricing\nMarket Price,$49.50\nSector (%)\n"City","25.29"`,
      null,
      'TXCA',
    );
    expect(facts.cusip).toBe('66516K855');
    expect(facts.secYield).toBeNull();
    expect(facts.dividendYield).toBeNull();
    expect(facts.assetClass).toBe('ETF');
    expect(facts.monthEnd.asOfDate).toBeNull();
    expect(facts.monthEnd.ytd).toBeNull();
    expect(facts.quarterEnd.asOfDate).toBeNull();
  });

  test('an empty download fails loudly', () => {
    expect(() => parseNorthernTrustFacts('', null, 'QLC')).toThrow(/full-data CSV is empty/);
  });
});
const NORTHERN_EQUITY_HOLDINGS_FIXTURE = `Date,CUSIP,ISIN,SEDOL,Name,Ticker,Market Value-Local,Market Value-Base,Fund Weight %,Shares Held,Coupon,Maturity,Sector Type,Country
09/25/2026,67066G104,US67066G1040,2379504,NVIDIA CORP COMMON STOCK USD 0.001,NVDA,89170033.16,89170033.16,7.8138,396188,.000,,Information Technology,United States
09/25/2026,46625H100,US46625H1005,2190385,JPMORGAN CHASE &#38; CO COMMON STOCK USD 1,JPM,21522898.28,21522898.28,1.8860,62738,.000,,Financials,United States`;

const NORTHERN_BOND_HOLDINGS_FIXTURE = `Date,CUSIP,ISIN,SEDOL,Name,Ticker,Market Value-Local,Market Value-Base,Fund Weight %,Shares Held,Coupon,Maturity,Sector Type,Country
09/25/2026,USD_CCASH,,,CASH,,22393826.03,22393826.03,2.4820,22393826,.000,,,
09/25/2026,30303M8U9,US30303M8U95,BMWF4N7,META PLATFORMS INC CALLABLE NOTES FIXED 4.75%,,6603714.95,6603714.95,.7319,7130000,4.750,08/15/2034,Industrial,United States`;

describe('parseNorthernTrustHoldings', () => {
  test('maps the equity columns onto the shared sheet and decodes entities', () => {
    const holdings = parseNorthernTrustHoldings(NORTHERN_EQUITY_HOLDINGS_FIXTURE, 'QLC')!;
    expect(holdings.headers).toEqual(HOLDINGS_HEADERS);
    expect(holdings.asOfDate).toBe('2026-09-25');
    expect(holdings.container).toBe('holdings.csv');
    expect(holdings.rows).toHaveLength(2);
    expect(holdings.rows[0]).toEqual({
      Name: 'NVIDIA CORP COMMON STOCK USD 0.001',
      Ticker: 'NVDA',
      Identifier: '67066G104',
      Weight: '7.8138',
      'Market Value': '89170033.16',
      'Shares Held': '396188',
      'Asset Category': 'Information Technology',
    });
    expect(holdings.rows[1].Name).toBe('JPMORGAN CHASE & CO COMMON STOCK USD 1');
  });

  test('".000" coupon filler alone never promotes the sheet to bond columns', () => {
    const holdings = parseNorthernTrustHoldings(NORTHERN_EQUITY_HOLDINGS_FIXTURE, 'QLC')!;
    expect(holdings.headers).not.toContain('Coupon');
    expect(weightsSum(holdings.rows)).toBe(9.6998);
  });

  test('bond positions keep coupon/maturity and ticker-less rows stay keyed', () => {
    const holdings = parseNorthernTrustHoldings(NORTHERN_BOND_HOLDINGS_FIXTURE, 'SKOR')!;
    expect(holdings.headers).toEqual(BOND_SHEET_HEADERS);
    expect(holdings.rows).toHaveLength(2);
    expect(holdings.rows[0].Name).toBe('CASH');
    expect(holdings.rows[0].Ticker).toBe('-');
    expect(holdings.rows[0].Identifier).toBe('USD_CCASH');
    expect(holdings.rows[1].Ticker).toBe('-');
    expect(holdings.rows[1].Coupon).toBe('4.75');
    expect(holdings.rows[1].Maturity).toBe('Aug 15 2034');
    expect(holdings.rows[1]['Asset Category']).toBe('Industrial');
  });

  test('canonical order keeps reruns byte-identical', () => {
    expect(compareHoldingRows({ Weight: '1', 'Market Value': '2', Name: 'B' }, { Weight: '2', 'Market Value': '1', Name: 'A' })).toBeGreaterThan(0);
    expect(compareHoldingRows({ Weight: '1', 'Market Value': '1', Name: 'A' }, { Weight: '1', 'Market Value': '1', Name: 'B' })).toBeLessThan(0);
  });

  test('a header without positions returns null, a missing header throws', () => {
    expect(parseNorthernTrustHoldings('Date,CUSIP,Name,Ticker,Market Value-Local,Market Value-Base,Fund Weight %,Shares Held', 'QLC')).toBeNull();
    expect(() => parseNorthernTrustHoldings('Fund Name,Price\nX,1', 'QLC')).toThrow(/header row not found/);
  });
});

describe('decodeDividendFrequency', () => {
  test('maps cadence codes to the shared frequency words', () => {
    expect(decodeDividendFrequency('MDEC')).toEqual({ frequency: 'Monthly', paymentsPerYear: 12 });
    expect(decodeDividendFrequency('QDEC')).toEqual({ frequency: 'Quarterly', paymentsPerYear: 4 });
    expect(decodeDividendFrequency('SDEC')).toEqual({ frequency: 'Semi-annually', paymentsPerYear: 2 });
    expect(decodeDividendFrequency('YDEC')).toEqual({ frequency: 'Annually', paymentsPerYear: 1 });
    expect(decodeDividendFrequency('DACC')).toEqual({ frequency: 'Daily', paymentsPerYear: null });
    expect(decodeDividendFrequency('')).toBeNull();
    expect(decodeDividendFrequency(null)).toBeNull();
    expect(decodeDividendFrequency('ZZZ')).toBeNull();
  });

  test('decodes the published Northern Trust frequency words by first letter', () => {
    expect(decodeDividendFrequency('Monthly')).toEqual({ frequency: 'Monthly', paymentsPerYear: 12 });
    expect(decodeDividendFrequency('Quarterly')).toEqual({ frequency: 'Quarterly', paymentsPerYear: 4 });
    expect(decodeDividendFrequency('Semi-annually')).toEqual({ frequency: 'Semi-annually', paymentsPerYear: 2 });
    expect(decodeDividendFrequency('Annually')).toEqual({ frequency: 'Annually', paymentsPerYear: 1 });
    expect(decodeDividendFrequency('N/A')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Historical-data layer
// ---------------------------------------------------------------------------

// Real qlc_pricing.json rows captured 2026-09-27 (shuffled with a repeated
// date to pin the ordering/dedup contract).
const NORTHERN_PRICING_FIXTURE = [
  { TICKER: 'QLC', AS_OF_DATE: '01/02/2020', NET_ASSET_VALUE: '37.03', CLOSING_MARKET_PRICE: '37.00', PREMIUM_DISCOUNT: '-.03' },
  { TICKER: 'QLC', AS_OF_DATE: '01/02/2019', NET_ASSET_VALUE: '30.34', CLOSING_MARKET_PRICE: '30.21', PREMIUM_DISCOUNT: '-.13' },
  { TICKER: 'QLC', AS_OF_DATE: '01/02/2020', NET_ASSET_VALUE: '37.04', CLOSING_MARKET_PRICE: '37.01', PREMIUM_DISCOUNT: '-.02' },
  { TICKER: 'QLC', AS_OF_DATE: 'bogus', NET_ASSET_VALUE: '1', CLOSING_MARKET_PRICE: '1', PREMIUM_DISCOUNT: '0' },
];

// Real qlc-distributions.csv rows captured 2026-09-27 plus a TIPA-style
// zero-amount row: future ex-dates and zero rows never enter the schedule.
const NORTHERN_DISTRIBUTIONS_FIXTURE = `Ex-Date,Record Date,Payable Date,Income,Short-Term Capital Gains,Long-Term Capital Gains,Return of Capital,Total Distribution
12/18/2026,12/18/2026,12/24/2026,,,,,
09/18/2026,09/18/2026,09/24/2026,.224696,0,0,0,.224696
09/01/2026,09/01/2026,09/08/2026,0,0,0,0,0
06/18/2026,06/18/2026,06/25/2026,.2215,0,0,0,.2215`;

describe('parseNorthernTrustPricing', () => {
  test('reads the daily rows ascending by date, last duplicate wins', () => {
    const points = parseNorthernTrustPricing(NORTHERN_PRICING_FIXTURE, 'QLC');
    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({ date: '2019-01-02', nav: 30.34, marketPrice: 30.21, premiumDiscount: -0.13 });
    expect(points[1]).toEqual({ date: '2020-01-02', nav: 37.04, marketPrice: 37.01, premiumDiscount: -0.02 });
  });

  test('a non-list payload fails loudly', () => {
    expect(() => parseNorthernTrustPricing({ AS_OF_DATE: '01/02/2020' }, 'QLC')).toThrow(/not a daily list/);
  });
});

describe('parseNorthernTrustDistributionsCsv', () => {
  test('keeps paid distributions ascending, skips future and zero rows', () => {
    const dividends = parseNorthernTrustDistributionsCsv(NORTHERN_DISTRIBUTIONS_FIXTURE, 'QLC');
    expect(dividends).toHaveLength(2);
    expect(dividends[0]).toEqual({
      epoch: isoToEpoch('2026-06-18'),
      amount: 0.2215,
      exDate: '2026-06-18',
      payDate: '2026-06-25',
      recordDate: '2026-06-18',
      reinvestNav: null,
      type: '',
    });
    expect(dividends[1].exDate).toBe('2026-09-18');
    expect(dividends[1].amount).toBe(0.224696);
  });

  test('a missing header fails loudly', () => {
    expect(() => parseNorthernTrustDistributionsCsv('Fund Name,Price\nX,1', 'QLC')).toThrow(/header row not found/);
  });
});
describe('navTotalReturnDays', () => {
  test('reinvests each published distribution at its reinvestment NAV', () => {
    const points = [
      { date: '2026-08-29', nav: 56.3, marketPrice: 56.31, premiumDiscount: 0.0178 },
      { date: '2026-09-01', nav: 55.9, marketPrice: 55.92, premiumDiscount: 0.0358 },
      { date: '2026-09-17', nav: 56.4101, marketPrice: 56.43, premiumDiscount: 0.0353 },
    ];
    const dividends = [{ epoch: isoToEpoch('2026-09-01')!, amount: 0.37421, exDate: '2026-09-01', payDate: '', recordDate: '', reinvestNav: 55.9, type: 'DVDYLD' }];
    const days = navTotalReturnDays(points, dividends);
    expect(days.map((day) => day.date)).toEqual(['2026-08-29', '2026-09-01', '2026-09-17']);
    expect(days[0]).toEqual({ date: '2026-08-29', close: 56.3, adjClose: 56.3, volume: 0 });
    const factor = 1 + 0.37421 / 55.9;
    expect(days[1].adjClose).toBeCloseTo(55.9 * factor, 6);
    expect(days[2].adjClose).toBeCloseTo(56.4101 * factor, 6);
    // Total return over the window = price return plus the reinvested payout.
    expect(days[2].adjClose / days[0].adjClose - 1).toBeCloseTo((56.4101 * factor) / 56.3 - 1, 6);
  });

  test('uses the ex-date NAV when no reinvestment NAV is published and skips pre-history payouts', () => {
    const points = [
      { date: '2026-09-01', nav: 50, marketPrice: 50, premiumDiscount: 0 },
      { date: '2026-09-02', nav: 51, marketPrice: 51, premiumDiscount: 0 },
    ];
    const dividends = [
      { epoch: isoToEpoch('2026-08-01')!, amount: 1, exDate: '2026-08-01', payDate: '', recordDate: '', reinvestNav: null, type: '' },
      { epoch: isoToEpoch('2026-09-01')!, amount: 0.5, exDate: '2026-09-01', payDate: '', recordDate: '', reinvestNav: null, type: '' },
    ];
    const days = navTotalReturnDays(points, dividends);
    expect(days[0].adjClose).toBeCloseTo(50 * 1.01, 6);
    expect(days[1].adjClose).toBeCloseTo(51 * 1.01, 6);
    expect(navTotalReturnDays([], dividends)).toEqual([]);
  });
});

describe('reinvestmentCoverageStart', () => {
  const dividend = (exDate: string, amount = 0.067) => ({ epoch: isoToEpoch(exDate)!, amount, exDate, payDate: '', recordDate: '', reinvestNav: null, type: 'DVDYLD' });
  const points = [
    { date: '2025-12-10', nav: 100.06, marketPrice: 100.06, premiumDiscount: 0 },
    { date: '2026-09-18', nav: 100.11, marketPrice: 100.16, premiumDiscount: 0.05 },
  ];

  test('a schedule shorter than the page cap is complete: covered since the first NAV', () => {
    expect(DIVIDEND_SCHEDULE_CAP).toBe(12);
    expect(reinvestmentCoverageStart(points, [])).toBe('2025-12-10');
    expect(reinvestmentCoverageStart(points, [dividend('2026-05-01'), dividend('2026-06-01')])).toBe('2025-12-10');
  });

  test('a capped weekly schedule covers one payment interval before its earliest ex-date', () => {
    const weekly = ['07/06', '07/10', '07/17', '07/24', '07/31', '08/07', '08/14', '08/21', '08/28', '09/04', '09/11', '09/18']
      .map((md) => dividend(`2026-${md.replace('/', '-')}`));
    expect(weekly.length).toBe(DIVIDEND_SCHEDULE_CAP);
    // median gap 7 days -> 2026-07-06 minus 7 days
    expect(reinvestmentCoverageStart(points, weekly)).toBe('2026-06-29');
  });

  test('never reaches back before the first NAV and is null without NAV points', () => {
    const monthly = Array.from({ length: 12 }, (_, i) => dividend(`2026-${String(i + 1).padStart(2, '0')}-01`));
    const young = [{ date: '2026-06-15', nav: 50, marketPrice: 50, premiumDiscount: 0 }, points[1]];
    expect(reinvestmentCoverageStart(young, monthly)).toBe('2026-06-15');
    expect(reinvestmentCoverageStart([], monthly)).toBeNull();
  });
});

describe('annualizedSinceInception', () => {
  test('publishes the official since-inception figure only once the fund is a year old', () => {
    expect(annualizedSinceInception(11.25, '2020-05-20', '2026-08-31')).toBe(11.25);
    expect(annualizedSinceInception(1.9, '2026-07-30', '2026-08-31')).toBeNull();
    expect(annualizedSinceInception(1.9, '2025-08-31', '2026-08-31')).toBe(1.9);
    expect(annualizedSinceInception(null, '2020-05-20', '2026-08-31')).toBeNull();
    expect(annualizedSinceInception(5, null, '2026-08-31')).toBe(5);
  });
});

describe('sheet headers', () => {
  test('official history rows carry NAV, market price and premium/discount; Yahoo fallback keeps the sibling layout', () => {
    expect(HISTORY_HEADERS).toEqual(['Date', 'NAV', 'Market Price', 'Premium/Discount']);
    expect(YAHOO_HISTORY_HEADERS).toEqual(['Date', 'Close', 'Adj Close', 'Volume']);
  });
});

describe('nport fixtures', () => {
  test('parses positions, identifiers and the report period', () => {
    const xml = `
      <nportRegDoc><genInfo><regName>J.P. Morgan Exchange-Traded Fund Trust</regName><regCik>0001485894</regCik>
      <seriesName>JPMorgan Equity Premium Income ETF</seriesName><seriesId>S000068402</seriesId>
      <repPdDate>2026-06-30</repPdDate></genInfo>
      <invstOrSec><name>Apple Inc</name><cusip>037833100</cusip><balance>124827810</balance>
      <valUSD>26312454069.90</valUSD><pctVal>8.24</pctVal><assetCat>EC</assetCat></invstOrSec>
      <invstOrSec><title>US TREASURY 4.125% 05/15/2028</title>
      <identifiers><cusip value="912810H80"/></identifiers><balance>5000000</balance>
      <valUSD>5100000</valUSD><pctVal>2.5</pctVal><assetCat>OB</assetCat></invstOrSec>
      </nportRegDoc>`;
    const parsed = parseNport(xml);
    expect(parsed.seriesName).toBe('JPMorgan Equity Premium Income ETF');
    expect(parsed.regCik).toBe('0001485894');
    expect(parsed.repPdDate).toBe('2026-06-30');
    expect(parsed.holdings.length).toBe(2);
    expect(parsed.holdings[0].Identifier).toBe('037833100');
    expect(parsed.holdings[0].Ticker).toBe('-');
    expect(parsed.holdings[1].Identifier).toBe('912810H80');
    expect(parsed.holdings[1].Name).toBe('US TREASURY 4.125% 05/15/2028');
    expect(parsed.totalValue).toBeCloseTo(26317554069.9, 1);
    expect(parsed.netAssets).toBeNull();
  });

  test('reads the reported net assets when the filing carries a fundInfo block', () => {
    const parsed = parseNport(
      '<genInfo><seriesName>JPMorgan BetaBuilders U.S. Equity ETF</seriesName><repPdDate>2026-04-30</repPdDate></genInfo>' +
        '<fundInfo><totAssets>88500000000.00</totAssets><netAssets>87850000000.00</netAssets></fundInfo>' +
        '<invstOrSec><name>MGM Resorts International</name><cusip>552953101</cusip><valUSD>180990316.32</valUSD><pctVal>0.2059893365</pctVal></invstOrSec>',
    );
    expect(parsed.netAssets).toBe(87850000000);
    expect(parsed.holdings.length).toBe(1);
  });

  test('falls back to other identifiers when the CUSIP is N/A', () => {
    const parsed = parseNport(
      '<invstOrSec><name>FUND X</name><cusip>N/A</cusip><identifiers><other value="XSCUSIP1"/></identifiers><valUSD>10</valUSD></invstOrSec>',
    );
    expect(parsed.holdings[0].Identifier).toBe('XSCUSIP1');
  });

  test('tolerates empty bodies and missing values', () => {
    expect(() => parseNport('')).not.toThrow();
    const parsed = parseNport('<genInfo><seriesName>Empty</seriesName></genInfo>');
    expect(parsed.holdings).toEqual([]);
    expect(parsed.totalValue).toBe(0);
  });

  test('submissions parser keeps only NPORT-P forms and builds the archive URL', () => {
    const accessions = parseNportAccessions({
      cik: '913760',
      filings: {
        recent: {
          form: ['NPORT-P', '13F-HR', 'NPORT-P'],
          accessionNumber: ['0000913760-26-000111', '0000913760-26-000112', '0000913760-26-000113'],
          filingDate: ['2026-07-21', '2026-08-10', '2026-04-21'],
          reportDate: ['2026-06-30', '2026-06-30', '2026-03-31'],
        },
      },
    });
    expect(accessions.map((entry) => entry.accession)).toEqual(['0000913760-26-000111', '0000913760-26-000113']);
    expect(accessions[0].url).toBe(nportUrlFor('0000913760', '0000913760-26-000111'));
    expect(accessions[0].url).toContain('/Archives/edgar/data/913760/000091376026000111/primary_doc.xml');
  });
});

describe('pickEftsCik', () => {
  const payload = {
    hits: [
      { _source: { display_names: { cik: 12345, names: ['Some Other Trust'] } } },
      { _source: { display_names: { cik: 1485894, names: ['JPMorgan Equity Premium Income ETF', 'J.P. MORGAN EXCHANGE-TRADED FUND TRUST'] } } },
    ],
  };
  test('chooses the registrant whose name matches the fund', () => {
    expect(pickEftsCik(payload, 'JPMorgan Equity Premium Income ETF')).toBe('0001485894');
  });

  test('returns null when nothing matches', () => {
    expect(pickEftsCik(payload, 'Unknown Fund')).toBeNull();
  });

  test('reads the real EDGAR full-text search payload shape', () => {
    const real = {
      hits: {
        total: { value: 2, relation: 'eq' },
        hits: [
          { _source: { ciks: ['0001667919'], display_names: ['FIRST TRUST EXCHANGE-TRADED FUND VIII  (CIK 0001667919)'] } },
          { _source: { ciks: ['0001485894'], display_names: ['J.P. MORGAN EXCHANGE-TRADED FUND TRUST  (CIK 0001485894)'] } },
        ],
      },
    };
    expect(pickEftsCik(real, 'J.P. Morgan Exchange-Traded Fund Trust')).toBe('0001485894');
    expect(pickEftsCik(real, '')).toBe('0001667919');
  });
});

describe('SEC lookup tables', () => {
  const fundTickers = {
    fields: ['cik', 'seriesId', 'classId', 'symbol'],
    data: [
      [1485894, 'S000068402', 'C000218810', 'JEPI'],
      [1485894, 'S000054790', 'C000172198', 'JPST'],
      [1485894, 'S000061995', 'C000200806', 'bbjp'],
      [0, 'S000000000', 'C000000000', 'ZZZ'],
    ],
  };

  test('maps every ticker to its registrant CIK and series', () => {
    const map = parseFundTickerMap(fundTickers);
    expect(map.get('JEPI')).toEqual({ cik: '0001485894', seriesId: 'S000068402', classId: 'C000218810' });
    expect(map.get('JPST')?.cik).toBe('0001485894');
    expect(map.get('BBJP')?.seriesId).toBe('S000061995');
    expect(map.has('ZZZ')).toBe(false);
  });

  test('tolerates an unusable payload', () => {
    expect(parseFundTickerMap({}).size).toBe(0);
    expect(parseFundTickerMap({ fields: ['cik'], data: ['nope'] }).size).toBe(0);
  });

  test('maps issuer names back to exchange tickers', () => {
    const map = parseCompanyTickerMap({
      '0': { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA CORP' },
      '1': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
      '2': { cik_str: 1, ticker: '', title: 'No Ticker Inc' },
    });
    expect(map.get(normalizeHoldingName('NVIDIA Corp'))).toBe('NVDA');
    expect(map.get(normalizeHoldingName('Apple Inc.'))).toBe('AAPL');
    expect(map.get(normalizeHoldingName('No Ticker Inc'))).toBeUndefined();
  });
});

describe('EDGAR series filings', () => {
  const atom = `<?xml version="1.0" encoding="ISO-8859-1"?>
    <feed>
      <entry>
        <accession-number>0001209466-26-000952</accession-number>
        <filing-date>2026-06-29</filing-date>
        <filing-href>https://www.sec.gov/Archives/edgar/data/1209466/000120946626000952/0001209466-26-000952-index.htm</filing-href>
        <filing-type>NPORT-P</filing-type>
      </entry>
      <entry>
        <accession-number>0001209466-26-000514</accession-number>
        <filing-date>2026-04-01</filing-date>
        <filing-href>https://www.sec.gov/Archives/edgar/data/1209466/000120946626000514/0001209466-26-000514-index.htm</filing-href>
        <filing-type>NPORT-P</filing-type>
      </entry>
      <entry>
        <accession-number>0001209466-26-000001</accession-number>
        <filing-date>2026-01-05</filing-date>
        <filing-type>N-CEN</filing-type>
      </entry>
    </feed>`;

  test('builds the browse-edgar Atom URL for one series', () => {
    const url = edgarSeriesFilingsUrl('S000060812', 5);
    expect(url).toContain('https://www.sec.gov/cgi-bin/browse-edgar?');
    expect(url).toContain('CIK=S000060812');
    expect(url).toContain('type=NPORT-P');
    expect(url).toContain('output=atom');
    expect(url).toContain('count=5');
  });

  test('keeps N-PORT-P entries newest first and builds the primary document URL', () => {
    const filings = parseEdgarAtomFilings(atom);
    expect(filings.map((entry) => entry.accession)).toEqual(['0001209466-26-000952', '0001209466-26-000514']);
    expect(filings[0].filed).toBe('2026-06-29');
    expect(filings[0].url).toBe('https://www.sec.gov/Archives/edgar/data/1209466/000120946626000952/primary_doc.xml');
  });

  test('tolerates an empty or unrelated feed', () => {
    expect(parseEdgarAtomFilings('')).toEqual([]);
    expect(parseEdgarAtomFilings('<feed><entry><filing-type>10-K</filing-type></entry></feed>')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// History fallback layer (Yahoo chart)
// ---------------------------------------------------------------------------

function chartFixture(options: { closes?: (number | null)[]; adj?: (number | null)[]; dividends?: Record<string, { date: number; amount: number }> } = {}) {
  const start = Date.UTC(2020, 0, 2) / 1000;
  const closes = options.closes ?? [100, 105, 110, 111, 120];
  const adj = options.adj ?? closes;
  const timestamps = closes.map((_, index) => start + index * 86_400);
  return {
    chart: {
      result: [
        {
          meta: {
            fullExchangeName: 'NasdaqGS',
            longName: 'JPMorgan Equity Premium Income ETF',
            navPrice: 706.3,
            regularMarketPrice: 706.32,
            regularMarketTime: Date.UTC(2026, 7, 21, 20, 0) / 1000,
            firstTradeDate: start,
          },
          timestamp: timestamps,
          indicators: { quote: [{ close: closes, volume: timestamps.map(() => 1000) }], adjclose: [{ adjclose: adj }] },
          events: { dividends: options.dividends ?? {} },
        },
      ],
    },
  };
}

describe('chart fixtures', () => {
  test('builds trading days, skips null closes, keeps adjusted closes', () => {
    const chart = parseChart(chartFixture({ closes: [100, null, 110], adj: [90, null, 99] }));
    expect(chart.days.map((day) => day.close)).toEqual([100, 110]);
    expect(chart.days.map((day) => day.adjClose)).toEqual([90, 99]);
    expect(chart.navPrice).toBe(706.3);
    expect(chart.exchangeName).toBe('NasdaqGS');
  });

  test('falls back to raw closes when adjclose is absent', () => {
    const payload = chartFixture({ closes: [100, 101] }) as any;
    delete payload.chart.result[0].indicators.adjclose;
    const chart = parseChart(payload);
    expect(chart.days.map((day) => day.adjClose)).toEqual([100, 101]);
  });

  test('sorts dividends chronologically and drops non-positive amounts', () => {
    const chart = parseChart(
      chartFixture({
        dividends: {
          '2': { date: Date.UTC(2026, 5, 15) / 1000, amount: 0.7 },
          '1': { date: Date.UTC(2026, 2, 15) / 1000, amount: 0.65 },
          '0': { date: Date.UTC(2025, 11, 15) / 1000, amount: -1 },
        },
      }),
    );
    expect(chart.dividends.map((entry) => entry.amount)).toEqual([0.65, 0.7]);
  });

  test('throws on an empty result', () => {
    expect(() => parseChart({ chart: { result: [] } })).toThrow(/empty result/);
  });
});

describe('priceReturns', () => {
  const days = [
    { date: '2015-01-02', close: 100, adjClose: 100, volume: 1 },
    { date: '2022-01-03', close: 200, adjClose: 195, volume: 1 },
    { date: '2023-01-03', close: 220, adjClose: 214, volume: 1 },
    { date: '2026-01-02', close: 300, adjClose: 290, volume: 1 },
    { date: '2026-06-30', close: 320, adjClose: 310, volume: 1 },
    { date: '2026-07-01', close: 322, adjClose: 312, volume: 1 },
    { date: '2026-08-21', close: 340, adjClose: 330, volume: 1 },
  ];
  const now = new Date(Date.UTC(2026, 7, 21));

  test('derives YTD, 1Y, CAGRs and SI anchored to the last close', () => {
    const returns = priceReturns(days, now);
    expect(returns.asOfDate).toBe('2026-08-21');
    // Each anchor is the last trading day at or before the period start, so a
    // thin fixture keeps falling back to the newest day that is early enough.
    expect(returns.ytd).toBeCloseTo(54.21, 2); // 2023-01-03 (the 2026-01-01 anchor)
    expect(returns.yr1).toBeCloseTo(54.21, 2); // 2023-01-03 (nothing between 2025 and 2023)
    expect(returns.cagr3y).toBeCloseTo(15.53, 2); // 2026-01-02 (3y before 2026-08-21)
    expect(returns.mo1).toBeCloseTo(5.77, 2); // 2026-07-01 (the 2026-07-21 anchor)
    expect(returns.siAnn).toBeGreaterThan(0);
  });

  test('young funds produce nulls instead of made-up returns', () => {
    const young = priceReturns([{ date: '2026-08-20', close: 10, adjClose: 10, volume: 1 }], now);
    expect(young.asOfDate).toBe('2026-08-20');
    expect(young.ytd).toBeNull();
    expect(young.cagr3y).toBeNull();
    expect(young.siAnn).toBeNull();
  });

  test('empty history yields an empty returns block', () => {
    expect(priceReturns([], now).asOfDate).toBe('');
  });

  test('windows that start before the reinvestment coverage are not derived', () => {
    // A weekly payer whose schedule only covers the last 12 payments: the
    // since-inception, YTD and 1Y windows would miss reinvestments and must
    // stay null, while the quarter-to-date and 1-month windows are derived.
    const covered = priceReturns(days, now, '2026-06-29');
    expect(covered.siAnn).toBeNull();
    expect(covered.ytd).toBeNull();
    expect(covered.yr1).toBeNull();
    expect(covered.cagr3y).toBeNull();
    expect(covered.qtd).toBeCloseTo(pctChangeOf(312, 330), 2); // anchored at 2026-07-01 (quarter start)
    expect(covered.mo1).toBeCloseTo(pctChangeOf(312, 330), 2); // anchored at 2026-07-01 (the 2026-07-21 anchor)
    // Coverage from the first day changes nothing.
    expect(priceReturns(days, now, '2015-01-02')).toEqual(priceReturns(days, now));
  });
});

function pctChangeOf(start: number, end: number): number {
  return ((end - start) / start) * 100;
}

describe('lastCompletedQuarterEnd', () => {
  test('anchors to the last completed quarter', () => {
    expect(lastCompletedQuarterEnd(new Date(Date.UTC(2026, 7, 21))).toISOString().slice(0, 10)).toBe('2026-06-30');
    expect(lastCompletedQuarterEnd(new Date(Date.UTC(2026, 0, 15))).toISOString().slice(0, 10)).toBe('2025-12-31');
    expect(lastCompletedQuarterEnd(new Date(Date.UTC(2026, 4, 1))).toISOString().slice(0, 10)).toBe('2026-03-31');
    expect(lastCompletedQuarterEnd(new Date(Date.UTC(2026, 10, 1))).toISOString().slice(0, 10)).toBe('2026-09-30');
  });
});

// ---------------------------------------------------------------------------
// Derived metrics
// ---------------------------------------------------------------------------

describe('annualizedToTotal / totalToAnnualized', () => {
  test('annualizedToTotal inverts annualization exactly', () => {
    expect(annualizedToTotal(20.15, 3)).toBeCloseTo(73.45, 2);
    expect(annualizedToTotal(null, 3)).toBeNull();
    expect(annualizedToTotal(10, 0)).toBeNull();
  });

  test('round-trips through totalToAnnualized', () => {
    expect(totalToAnnualized(annualizedToTotal(12.5, 5), 5)).toBeCloseTo(12.5, 1);
  });

  test('guards bad input', () => {
    expect(totalToAnnualized('n/a' as any, 5)).toBeNull();
  });
});

describe('indicatedYield', () => {
  test('computes latest distribution x frequency / price', () => {
    expect(indicatedYield(0.7, 4, 706.32)).toBeCloseTo(0.4, 1);
    expect(indicatedYield(0.65, 12, 41.72)).toBe(18.7);
  });

  test('guards missing pieces', () => {
    expect(indicatedYield(null, 4, 10)).toBeNull();
    expect(indicatedYield(0.5, 0, 10)).toBeNull();
    expect(indicatedYield(0.5, 4, 0)).toBeNull();
  });
});

describe('inferDistributionFrequency', () => {
  test('detects quarterly and monthly cadences', () => {
    const quarterly = [0, 1, 2, 3].map((i) => ({ epoch: Date.UTC(2026, 0 + i * 3, 15) / 1000, amount: 1 }));
    expect(inferDistributionFrequency(quarterly).frequency).toBe('Quarterly');
    const monthly = Array.from({ length: 6 }, (_, i) => ({ epoch: Date.UTC(2026, i, 15) / 1000, amount: 1 }));
    expect(inferDistributionFrequency(monthly)).toEqual({ frequency: 'Monthly', paymentsPerYear: 12 });
  });

  test('no distributions means None (commodity / crypto style funds)', () => {
    expect(inferDistributionFrequency([])).toEqual({ frequency: 'None', paymentsPerYear: null });
  });
});

describe('deriveCatalogMetrics', () => {
  test('official Northern Trust returns win over the derived ones', () => {
    const metrics = deriveCatalogMetrics(
      { ytd: 15.97, yr1: 18.34, yr3: 20.15, yr5: 17.42, yr10: 16.88, sinceInception: 19.44 },
      { asOfDate: '2026-08-21', ytd: 13.79, yr1: 54.21, cagr3y: 18.99, cagr5y: 12, cagr10y: 11, siAnn: 10, mo1: 1, qtd: 2 },
      0.44,
      null,
      null,
      null,
      706.32,
      null,
      '2026-08-31',
    );
    expect(metrics.ytd).toBe(15.97);
    expect(metrics.tr1y).toBe(18.34);
    expect(metrics.cagr3y).toBe(20.15);
    expect(metrics.tr3y).toBe(annualizedToTotal(20.15, 3));
    expect(metrics.dividendYield).toBe(0.44);
    expect(metrics.secYield).toBeNull();
    expect(metrics.returnsBasis).toContain('official Northern Trust NAV total returns');
    expect(metrics.performanceAsOf).toBe('2026-08-31');
    expect(Object.keys(metrics).slice(-2)).toEqual(['returnsBasis', 'performanceAsOf']);
  });

  test('official returns with derived gaps keep the official table date', () => {
    const metrics = deriveCatalogMetrics(
      { ytd: 1, yr1: 2, yr3: null, yr5: null, yr10: null, sinceInception: null },
      { asOfDate: '2026-09-25', ytd: 9, yr1: 9, cagr3y: 5, cagr5y: null, cagr10y: null, siAnn: null, mo1: null, qtd: null },
      null,
      null,
      null,
      null,
      null,
      null,
      '2026-08-31',
    );
    expect(metrics.cagr3y).toBe(5);
    expect(metrics.returnsBasis).toContain('missing figure filled');
    expect(metrics.performanceAsOf).toBe('2026-08-31');
  });

  test('official returns without a table date leave performanceAsOf null, never the NAV date', () => {
    const metrics = deriveCatalogMetrics(
      { ytd: 1, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null },
      { asOfDate: '2026-09-25', ytd: null, yr1: null, cagr3y: null, cagr5y: null, cagr10y: null, siAnn: null, mo1: null, qtd: null },
      null, null, null, null, null,
    );
    expect(metrics.performanceAsOf).toBeNull();
    expect(String(metrics.returnsBasis).length).toBeGreaterThan(0);
  });

  test('ensureMetricsContract backfills a published row offline and puts the fields last', () => {
    const official = ensureMetricsContract({
      metrics: { ytd: 1, returnsBasis: 'official Northern Trust NAV total returns (x)', secYield: 2 },
      returns: { monthEnd: { asOfDate: 'Aug 31 2026' } },
    }).metrics as Record<string, unknown>;
    expect(official.performanceAsOf).toBe('2026-08-31');
    expect(Object.keys(official)).toEqual(['ytd', 'secYield', 'returnsBasis', 'performanceAsOf']);
    const unknown = ensureMetricsContract({ metrics: { returnsBasis: '-' } }).metrics as Record<string, unknown>;
    expect(unknown.returnsBasis).not.toBe('-');
    expect(unknown.performanceAsOf).toBeNull();
    const derived = ensureMetricsContract({ metrics: { ytd: 1.2, returnsBasis: 'derived from the daily NAV history (old text)' } }, '2026-09-25').metrics as Record<string, unknown>;
    expect(derived.performanceAsOf).toBe('2026-09-25');
    // a date without a single return figure is dropped
    const noReturns = ensureMetricsContract({ metrics: { returnsBasis: 'derived from the daily NAV history (old text)', performanceAsOf: '2026-09-25' } }, '2026-09-25').metrics as Record<string, unknown>;
    expect(noReturns.performanceAsOf).toBeNull();
    expect(String(derived.returnsBasis)).toContain('not official NAV returns');
    expect(labelToIsoDate('Feb 30 2026')).toBeNull();
  });

  test('falls back to derived returns and the indicated yield', () => {
    const metrics = deriveCatalogMetrics(
      { ytd: null, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null },
      { asOfDate: '2026-08-21', ytd: 13.79, yr1: 54.21, cagr3y: 18.99, cagr5y: null, cagr10y: null, siAnn: null, mo1: null, qtd: null },
      null,
      null,
      0.65,
      12,
      41.72,
    );
    expect(metrics.ytd).toBe(13.79);
    expect(metrics.tr1y).toBe(54.21);
    expect(metrics.cagr5y).toBeNull();
    expect(metrics.dividendYield).toBe(18.7);
    expect(metrics.dividendYieldText).toBe('18.70%');
    expect(metrics.returnsBasis).toContain('not official NAV returns');
    expect(metrics.performanceAsOf).toBe('2026-08-21');
  });

  test('official cumulative figures replace the annualized-to-total approximation', () => {
    const metrics = deriveCatalogMetrics(
      { ytd: 5.36, yr1: 9.05, yr3: 9.51, yr5: 10.02, yr10: null, sinceInception: 11.25 },
      { asOfDate: '2026-09-18', ytd: 3.7, yr1: 9, cagr3y: 9.4, cagr5y: 10, cagr10y: null, siAnn: 11, mo1: 1, qtd: 2 },
      8.42,
      7.59,
      0.37421,
      12,
      56.24,
      { yr1: 9.05, yr3: 31.33, yr5: 61.17, yr10: null, sinceInception: 95.24 },
    );
    expect(metrics.tr3y).toBe(31.33);
    expect(metrics.tr5y).toBe(61.17);
    expect(metrics.tr10y).toBeNull();
    expect(metrics.cagr3y).toBe(9.51);
    expect(metrics.secYield).toBe(7.59);
    expect(metrics.secYieldText).toBe('7.59%');
  });
});

// ---------------------------------------------------------------------------
// Holding name normalization and the ticker seed
// ---------------------------------------------------------------------------

describe('normalizeHoldingName', () => {
  test('strips legal-form suffixes and fillers', () => {
    expect(normalizeHoldingName('Apple Inc.')).toBe('APPLE');
    expect(normalizeHoldingName('Microsoft Corp Common Stock')).toBe('MICROSOFT');
    expect(normalizeHoldingName('THE BOEING CO')).toBe('BOEING');
    // share classes are canonicalized, never dropped: GOOG and GOOGL must not collide
    expect(normalizeHoldingName('Alphabet Inc. Class C Capital Stock')).toBe('ALPHABET CL C');
    expect(normalizeHoldingName('Alphabet Inc. Class A Common Stock')).toBe('ALPHABET CL A');
    expect(normalizeHoldingName('Alphabet Inc Cl C')).toBe('ALPHABET CL C');
  });

  test('core form drops the remaining spaces', () => {
    expect(normalizeHoldingNameCore('Apple Inc.')).toBe('APPLE');
  });

  test('share classes stay distinguishable', () => {
    expect(normalizeHoldingName('Alphabet Inc Cl A')).not.toBe(normalizeHoldingName('Alphabet Inc Cl C'));
  });

  test('a trailing security word is peeled, a lone one is not', () => {
    expect(normalizeHoldingName('Berkshire Hathaway Inc Del')).toBe('BERKSHIRE HATHAWAY');
    // "Cap Stk" is not in the filler/suffix vocabulary (it is only normalized,
    // never dropped): the class marker survives, which is what matters.
    expect(normalizeHoldingName('Berkshire Hathaway Inc Cap Stk Cl A')).toBe('BERKSHIRE HATHAWAY CL A');
    expect(normalizeHoldingName('Berkshire Hathaway Inc Cap Stock Class A')).toBe('BERKSHIRE HATHAWAY CL A');
  });

  test('empty and junk names normalize to empty', () => {
    expect(normalizeHoldingName('')).toBe('');
    expect(normalizeHoldingName('---')).toBe('');
  });
});

describe('cleanHoldingTicker', () => {
  test('keeps class-share markers', () => {
    expect(cleanHoldingTicker('brk-b')).toBe('BRK-B');
    expect(cleanHoldingTicker('SCE^L')).toBe('SCE^L');
    expect(cleanHoldingTicker('BF/A')).toBe('BF/A');
  });

  test('rejects placeholders', () => {
    expect(cleanHoldingTicker('')).toBe('');
    expect(cleanHoldingTicker('N/A')).toBe('');
    expect(cleanHoldingTicker('see file')).toBe('');
  });
});

describe('etfs.ntam.northerntrust.com URL builders', () => {
  test('northernTrustFundPageUrl builds the ticker-keyed fund page', () => {
    expect(northernTrustFundPageUrl('QLC')).toBe('https://etfs.ntam.northerntrust.com/us/en/individual/funds/qlc');
    expect(northernTrustFundPageUrl('qlc')).toBe('https://etfs.ntam.northerntrust.com/us/en/individual/funds/qlc');
  });

  test('northernTrustFileUrl builds the per-fund download URLs', () => {
    expect(northernTrustFileUrl('QLC', 'qlc-all.csv')).toBe(
      'https://etfs.ntam.northerntrust.com/content/dam/ntflexshares/fund/qlc/qlc-all.csv',
    );
  });

  test('per-fund download builders cover every artifact the updater reads', () => {
    expect(northernTrustAllCsvUrl('QLC')).toBe('https://etfs.ntam.northerntrust.com/content/dam/ntflexshares/fund/qlc/qlc-all.csv');
    expect(northernTrustHoldingsCsvUrl('SKOR')).toBe(
      'https://etfs.ntam.northerntrust.com/content/dam/ntflexshares/fund/skor/skor-holdings.csv',
    );
    expect(northernTrustDistributionsCsvUrl('TIPA')).toBe(
      'https://etfs.ntam.northerntrust.com/content/dam/ntflexshares/fund/tipa/tipa-distributions.csv',
    );
    expect(northernTrustPricingJsonUrl('QLC')).toBe('https://etfs.ntam.northerntrust.com/content/dam/ntflexshares/fund/qlc/qlc_pricing.json');
    expect(northernTrustEtfChartsJsonUrl('QLC')).toBe(
      'https://etfs.ntam.northerntrust.com/content/dam/ntflexshares/fund/qlc/qlc_etfcharts.json',
    );
  });

  test('fractionToPercent converts the published fractions and keeps nulls', () => {
    expect(fractionToPercent(0.0536)).toBe(5.36);
    expect(fractionToPercent(0.0951)).toBe(9.51);
    expect(fractionToPercent('0.1')).toBe(10);
    expect(fractionToPercent(null)).toBeNull();
    expect(fractionToPercent('--')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

// NOTE: the app.tsx client-section regression tests (extracted
// formatDividendFrequency, frequency labels, per-ticker queue, header summary)
// are appended verbatim from the pinned sibling once app.tsx/index.html land.

// Client-side catalog helpers (app.tsx)
//
// app.tsx is compiled in the browser by Babel standalone and calls init() at
// module scope, so it cannot be imported here. The catalog's frequency column
// is nevertheless a pure function of the published data and its coded labels
// are what the column sorts on, so its source is extracted and exercised
// directly instead of being left untested.
// ---------------------------------------------------------------------------

const APP_SOURCE = readFileSync(new URL('../app.tsx', import.meta.url), 'utf8');

function extractClientFunction(name: string): (...args: any[]) => any {
  const match = new RegExp(`\\nfunction ${name}\\(([^)]*)\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(APP_SOURCE);
  if (!match) throw new Error(`${name} not found in app.tsx`);
  const parameters = match[1]
    .split(',')
    .map(parameter => parameter.split(':')[0].split('=')[0].trim())
    .filter(Boolean)
    .join(', ');
  return new Function(parameters, match[2]) as (...args: any[]) => any;
}

const formatDividendFrequency = extractClientFunction('formatDividendFrequency');

describe('formatDividendFrequency (catalog Frequency column)', () => {
  test('codes the published cadences with a sortable two-digit prefix', () => {
    expect(formatDividendFrequency('Monthly')).toBe('01 - Monthly');
    expect(formatDividendFrequency('Quarterly')).toBe('04 - Quarterly');
    expect(formatDividendFrequency('Semi-annually')).toBe('06 - Semi-annually');
    expect(formatDividendFrequency('Annually')).toBe('12 - Annually');
    expect(formatDividendFrequency('None')).toBe('00 - None');
    expect(formatDividendFrequency('Unknown')).toBe('00 - Unknown');
    expect(formatDividendFrequency('Irregular')).toBe('99 - Irregular');
  });

  test('accepts the hyphenated spellings and is case-insensitive', () => {
    expect(formatDividendFrequency('semi-annually')).toBe('06 - Semi-annually');
    expect(formatDividendFrequency('Semi-Annual')).toBe('06 - Semi-annually');
    expect(formatDividendFrequency('semiannual')).toBe('06 - Semi-annually');
    expect(formatDividendFrequency('annual')).toBe('12 - Annually');
    expect(formatDividendFrequency('monthly')).toBe('01 - Monthly');
  });

  test('treats missing data as "00 - None" instead of dropping the cell', () => {
    expect(formatDividendFrequency(undefined)).toBe('00 - None');
    expect(formatDividendFrequency(null)).toBe('00 - None');
    expect(formatDividendFrequency('')).toBe('00 - None');
    expect(formatDividendFrequency('  ')).toBe('00 - None');
    expect(formatDividendFrequency('-')).toBe('00 - None');
  });

  test('passes an unknown published value through unchanged', () => {
    expect(formatDividendFrequency('Weekly')).toBe('Weekly');
    expect(formatDividendFrequency('Daily')).toBe('Daily');
  });

  test('the updater emits the spellings the column codes (decodeDividendFrequency + inferDistributionFrequency)', () => {
    for (const word of ['Monthly', 'Quarterly', 'Semi-annually', 'Annually']) {
      expect(formatDividendFrequency(decodeDividendFrequency(word)!.frequency)).toMatch(/^\d\d - /);
    }
    const semiannual = inferDistributionFrequency([
      { epoch: isoToEpoch('2025-06-20')!, amount: 1 },
      { epoch: isoToEpoch('2025-12-20')!, amount: 1 },
      { epoch: isoToEpoch('2026-06-20')!, amount: 1 },
    ]);
    expect(semiannual).toEqual({ frequency: 'Semi-annually', paymentsPerYear: 2 });
    expect(formatDividendFrequency(semiannual.frequency)).toBe('06 - Semi-annually');
  });

  test('coded labels sort in descending cadence order without extra comparators', () => {
    const codes = ['Monthly', 'Quarterly', 'Semi-annually', 'Annually', 'None', 'Irregular']
      .map(formatDividendFrequency)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    expect(codes).toEqual(['00 - None', '01 - Monthly', '04 - Quarterly', '06 - Semi-annually', '12 - Annually', '99 - Irregular']);
  });
});


import { test as frequencyLabelTest, expect as frequencyLabelExpect } from 'bun:test';
frequencyLabelTest('Frequency placeholders display None and existing cadence labels stay unchanged', async () => {
  const text = await Bun.file(new URL('../app.tsx', import.meta.url)).text();
  const start = /^([ \t]*)function (formatDividendFrequency|formatDistributionFrequency)\(/m.exec(text);
  frequencyLabelExpect(start).not.toBeNull();
  const tail = text.slice(start!.index);
  const end = new RegExp('^' + start![1] + '\u007d', 'm').exec(tail);
  frequencyLabelExpect(end).not.toBeNull();
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(tail.slice(0, end!.index + end![0].length));
  const format = new Function(js + '; return ' + start![2] + ';')();
  for (const value of [null, undefined, '', '  ', '-', '‐', '‑', '‒', '–', '—', ' — ']) {
    frequencyLabelExpect(format(value)).toBe('00 - None');
  }
  for (const [input, expected] of [
    ['None', '00 - None'], ['Unknown', '00 - Unknown'], ['Monthly', '01 - Monthly'],
    ['Quarterly', '04 - Quarterly'], ['Semi-annually', '06 - Semi-annually'],
    ['Annually', '12 - Annually'], ['Irregular', '99 - Irregular'],
  ]) frequencyLabelExpect(format(input)).toBe(expected);
});


import { test as queueTest, describe as queueDescribe, expect as queueExpect } from 'bun:test';

async function tickerChainHarness() {
 const app=await Bun.file(new URL('../app.tsx',import.meta.url)).text();
 const source=app.match(/^function withTickerChain<T>\([\s\S]*?^\}/m)?.[0];
 queueExpect(source).toBeDefined();
 const javascript=new Bun.Transpiler({loader:'ts'}).transformSync(source!);
 const chains=new Map<string,Promise<void>>();
 const enqueue=new Function('holdingsChains',`${javascript}; return withTickerChain;`)(chains) as
  <T>(ticker:string,fn:()=>Promise<T>)=>Promise<T>;
 return {chains,enqueue};
}

queueDescribe('per-ticker queue preserves caller results and stores completion-only promises',()=>{
 queueTest('successful generic result reaches caller, not the internal queue',async()=>{
  const {chains,enqueue}=await tickerChainHarness();
  const value={rows:[['AGEM']]};
  queueExpect(await enqueue('AGEM',async()=>value)).toBe(value);
  queueExpect(await chains.get('AGEM')).toBeUndefined();
 });
 queueTest('rejection reaches caller without poisoning the next queued task',async()=>{
  const {chains,enqueue}=await tickerChainHarness();
  const error=new Error('page failed');
  const work=enqueue('AGEM',async()=>{throw error;});
  const observed=work.catch(reason=>reason);
  const settled=chains.get('AGEM');
  const next=enqueue('AGEM',async()=>42);
  queueExpect(await observed).toBe(error);
  queueExpect(await settled).toBeUndefined();
  queueExpect(await next).toBe(42);
  queueExpect(await chains.get('AGEM')).toBeUndefined();
 });
 queueTest('synchronous callback throws also leave the queue usable',async()=>{
  const {chains,enqueue}=await tickerChainHarness();
  const error=new Error('synchronous failure');
  queueExpect(await enqueue('AGEM',()=>{throw error;}).catch(reason=>reason)).toBe(error);
  queueExpect(await chains.get('AGEM')).toBeUndefined();
  queueExpect(await enqueue('AGEM',async()=>'recovered')).toBe('recovered');
 });
 queueTest('same-ticker work stays serial while other tickers run independently',async()=>{
  const {chains,enqueue}=await tickerChainHarness();
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const events:string[]=[];
  const first=enqueue('AGEM',async()=>{events.push('first');await gate;events.push('done');return 1;});
  const second=enqueue('AGEM',async()=>{events.push('second');return 2;});
  try {
   queueExpect(await enqueue('SGOL',async()=>3)).toBe(3);
   queueExpect(events).toEqual(['first']);
  } finally { release(); }
  queueExpect(await Promise.all([first,second])).toEqual([1,2]);
  queueExpect(events).toEqual(['first','done','second']);
  queueExpect(await chains.get('AGEM')).toBeUndefined();
  queueExpect(await chains.get('SGOL')).toBeUndefined();
 });
});


import { test as headerTest, expect as headerExpect } from 'bun:test';
async function headerSummaryHarness() {
  const source = await Bun.file(new URL('../app.tsx', import.meta.url)).text();
  const match = /^([ \t]*)function renderHeaderSummary\(/m.exec(source);
  headerExpect(match).not.toBeNull();
  const tail = source.slice(match!.index);
  const end = new RegExp('^' + match![1] + '}', 'm').exec(tail)!;
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(tail.slice(0, end.index + end[0].length));
  const makeNode = (text = ''): any => {
    const node: any = { textContent: text, childNodes: [], dataset: {}, listeners: {} };
    node.replaceChildren = (...children: any[]) => { node.childNodes = children; };
    node.append = (...children: any[]) => { node.childNodes.push(...children); };
    node.addEventListener = (name: string, listener: any) => { node.listeners[name] = listener; };
    return node;
  };
  const panel = makeNode(), subtitle = makeNode(), details = makeNode('Data: source link and updated timestamp');
  subtitle.append(details);
  const document = { getElementById: () => panel, createTextNode: makeNode, createElement: () => makeNode() };
  const render = new Function('document', js + '; return renderHeaderSummary;')(document);
  const text = () => subtitle.childNodes.map((n: any) => n.textContent).join('');
  return { render, panel, subtitle, details, makeNode, text };
}
headerTest('header has no visible subtitle without selection; original details nodes are retained', async () => {
  const h = await headerSummaryHarness();
  h.render(h.subtitle, new Set(), null, () => {});
  headerExpect(h.text()).toBe('');
  headerExpect(h.panel.childNodes).toEqual([h.details]);
  headerExpect(h.panel.childNodes[0]).toBe(h.details);
});
headerTest('header shows sorted selected tickers only, preserving click activation and highlight', async () => {
  const h = await headerSummaryHarness(); const activated: string[] = [];
  h.render(h.subtitle, new Set(['ZZZ', 'AAA']), 'AAA', (ticker: string) => activated.push(ticker));
  headerExpect(h.text()).toBe('2 selected: AAA, ZZZ');
  const links = h.subtitle.childNodes.filter((n: any) => n.dataset.headerFund);
  headerExpect(links[0].className).toContain('underline');
  links[1].listeners.click({ preventDefault() {} });
  headerExpect(activated).toEqual(['ZZZ']);
  headerExpect(h.panel.childNodes[0]).toBe(h.details);
});
headerTest('all selected still lists tickers; clear replaces both summary and selection', async () => {
  const h = await headerSummaryHarness();
  h.render(h.subtitle, new Set(['CCC','AAA','BBB']), 'BBB', () => {});
  headerExpect(h.text()).toBe('3 selected: AAA, BBB, CCC');
  const next = h.makeNode('Fresh detail context'); h.subtitle.replaceChildren(next);
  h.render(h.subtitle, new Set(), null, () => {});
  headerExpect(h.text()).toBe(''); headerExpect(h.panel.childNodes).toEqual([next]);
});
headerTest('header markup supplies a focusable counter and hidden rich panel with dismissal', async () => {
  const html = await Bun.file(new URL('../index.html', import.meta.url)).text();
  headerExpect(html).toMatch(/<button[^>]*aria-controls="app-summary"[^>]*id="ticker-count"/);
  headerExpect(html).toContain('id="app-summary" role="region" aria-label="ETF catalog information" hidden');
  headerExpect(html).toContain("event.key !== 'Escape'");
  headerExpect(html).toContain("trigger.addEventListener('focus', show)");
  headerExpect(html).toContain("trigger.addEventListener('pointerenter'");
});

// ---------------------------------------------------------------------------
// Controls, config file, README and workflow parity
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const file = () => JSON.parse(read('scripts/update-data.config.json'));
const workflow = () => read('.github/workflows/update-data.yml');
const workflowInputs = (text: string) =>
  [...text.slice(text.indexOf('    inputs:'), text.indexOf('\npermissions:')).matchAll(/^      (\w+):$/gm)].map((m) => m[1]);

test('configuration precedence: file < advanced < nonblank input < environment', () => {
  const c = resolveControls(
    { CONCURRENCY: 2, TICKERS: 'QLC' },
    { CONCURRENCY: 3, TICKERS: 'SKOR' },
    { CONCURRENCY: '4', TICKERS: '' },
    { CONCURRENCY: '6', NORTHERNTRUST_CONCURRENCY: '5' },
  );
  expect(c.CONCURRENCY).toBe('5');
  expect(c.TICKERS).toBe('SKOR');
  expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
  expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }).CONCURRENCY).toBe('3');
  expect(resolveControls({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: 'false' }).SKIP_YAHOO).toBe('false');
});

test('blank input inherits the file value; advanced may deliberately set an empty string', () => {
  expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
  expect(resolveControls({ TICKERS: 'QLC' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
});

test('an explicitly set empty environment variable clears the control', () => {
  expect(resolveControls({ TICKERS: 'QLC' }, {}, { TICKERS: 'SKOR' }, { TICKERS: '' }).TICKERS).toBe('');
  expect(readConfig(resolveControls({ TICKERS: 'QLC' }, {}, {}, { NORTHERNTRUST_TICKERS: '' })).tickers).toEqual([]);
  expect(resolveControls({ TICKERS: 'QLC' }, {}, {}, { TICKERS: undefined }).TICKERS).toBe('QLC');
});

test('legacy environment aliases keep working', () => {
  expect(resolveControls({}, {}, {}, { NORTHERNTRUST_LIMIT: '7' }).MAX_FETCHES).toBe('7');
  expect(resolveControls({}, {}, {}, { HISTORICAL_PAGE_SIZE: '500' }).HISTORY_PAGE_SIZE).toBe('500');
  expect(resolveControls({}, {}, {}, { NORTHERNTRUST_STORE_RAW_DOWNLOADS: 'true' }).STORE_RAW_DOWNLOADS).toBe('true');
  expect(resolveControls({}, {}, {}, { NORTHERNTRUST_LIMIT: '7', MAX_FETCHES: '9' }).MAX_FETCHES).toBe('9');
});

test('scheduled path (empty inputs and advanced) equals the config defaults', () => {
  const defaults = file();
  const scheduled = resolveControls(defaults, JSON.parse('{}'), {}, {});
  expect(scheduled).toEqual(defaults);
  const config = readConfig(scheduled);
  expect(config.tickers).toEqual([]);
  expect(config.maxFetches).toBe(0);
  expect(config.requestSleep).toBe(1);
  expect(config.concurrency).toBe(2);
  expect(config.holdingsPageSize).toBe(250);
  expect(config.historyPageSize).toBe(1000);
  expect(config.maxRetries).toBe(2);
  expect(config.historyRange).toBe('max');
  expect(config.edgarFallback).toBe(true);
  expect(config.skipYahoo).toBe(false);
  expect(config.skipNorthernTrust).toBe(false);
  expect(config.storeRawDownloads).toBe(false);
  expect(config.aumRange).toBeUndefined();
  expect(config.terRange).toBeUndefined();
  expect(config.dividendYieldRange).toBeUndefined();
  expect(config.secYieldRange).toBeUndefined();
  expect(config.performanceRanges).toEqual({});
  expect(config.totalReturnRanges).toEqual({});
  expect(config.secUa).toBe('daggerok ETF feed daggerok@gmail.com');
  expect(config.catalogUrl).toBe('https://etfs.ntam.northerntrust.com/us/en/individual/funds');
});

test('runtimeControls reads the checked-in file and lets the environment override it', async () => {
  expect(await runtimeControls({})).toEqual(file());
  const controls = await runtimeControls({ TICKERS: 'QLC SKOR', MAX_RETRIES: '1' });
  expect(controls.TICKERS).toBe('QLC SKOR');
  expect(readConfig(controls).tickers).toEqual(['QLC', 'SKOR']);
  expect(readConfig(controls).maxRetries).toBe(1);
});

test('resolver rejects invalid JSON shapes, unknown keys, non-scalars, newlines and bad values', () => {
  for (const value of [
    { UNKNOWN: 1 }, { OUTPUT_DIR: '/tmp' }, { SEC_UA: 'x\nEVIL=yes' }, { TICKERS: 'QLC\r\nEVIL=1' }, { TICKERS: 'a\0b' },
    { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 }, { MAX_RETRIES: '1.5' }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' },
    { SKIP_YAHOO: 'sometimes' }, { AUM: '5' }, { TER: '2:1' }, { PERFORMANCE_1Y: '10' },
    { CATALOG_URL: 'ftp://example.com' }, { TICKERS: ['QLC'] }, { TICKERS: { a: 1 } }, { TICKERS: null }, null, [], 'text',
  ]) {
    expect(() => resolveControls(value)).toThrow();
  }
  expect(() => resolveControls({}, { SEC_UA: 'x\rfoo' })).toThrow();
  expect(() => resolveControls({}, [])).toThrow();
  expect(() => resolveControls({}, {}, { TICKERS: 'x\ny' })).toThrow();
  expect(() => resolveControls({}, {}, {}, { NORTHERNTRUST_SEC_UA: 'x\0bad' })).toThrow();
  expect(() => JSON.parse('{not json')).toThrow();
});

test('provider filters survive the resolver', () => {
  const config = readConfig(resolveControls(file(), { AUM: '1B:', TER: ':0.5', PERFORMANCE_1Y: '15:', TOTAL_RETURN_10Y: ':50' }, { TICKERS: 'qlc, skor' }));
  expect(config.aumRange).toEqual({ min: 1e9, max: undefined });
  expect(config.terRange).toEqual({ min: undefined, max: 0.5 });
  expect(config.performanceRanges['1Y']).toEqual({ min: 15, max: undefined });
  expect(config.totalReturnRanges['10Y']).toEqual({ min: undefined, max: 50 });
  expect(config.tickers).toEqual(['QLC', 'SKOR']);
});

test('config keys, CONTROL_NAMES, README and --help stay in sync', () => {
  expect(Object.keys(file()).sort()).toEqual([...CONTROL_NAMES].sort());
  expect(Object.values(file()).every((value) => typeof value === 'string')).toBe(true);
  expect(Object.entries(file()).filter(([, value]) => String(value).includes('@'))).toEqual([['SEC_UA', 'daggerok ETF feed daggerok@gmail.com']]);
  const doc = read('README.md');
  const help = Bun.spawnSync(['bun', 'scripts/update-data.ts', '--help'], { cwd: new URL('..', import.meta.url).pathname }).stdout.toString();
  for (const name of CONTROL_NAMES) {
    // README lists the five tenors of PERFORMANCE_* / TOTAL_RETURN_* on one row: `PREFIX_YTD` / `_1Y` / ...
    const tenor = name.match(/^(PERFORMANCE|TOTAL_RETURN)_(1Y|3Y|5Y|10Y)$/);
    expect(doc).toContain(tenor ? '`_' + tenor[2] + '`' : '`' + name + '`');
    if (tenor) expect(doc).toContain('`' + tenor[1] + '_YTD`');
    expect(help).toContain(tenor ? `${tenor[1]}_YTD` : name);
  }
  expect(doc).toContain('scripts/update-data.config.json');
});

test('workflow: input limit, advanced input, schedule, fixed output dir, no direct interpolation', () => {
  const text = workflow();
  const names = workflowInputs(text);
  expect(names.length).toBeLessThanOrEqual(25);
  expect(names).toContain('advanced');
  expect(text).toContain("default: '{}'");
  for (const name of names.filter((n) => n !== 'advanced')) expect(CONTROL_NAMES).toContain(name.toUpperCase() as never);
  expect(new Set(names).size).toBe(names.length);
  expect(text).toContain("cron: '0 0 * * 0'");
  expect(text).not.toMatch(/^  push:/m);
  expect(text).toContain('toJSON(inputs)');
  expect(text).toContain('resolveControls');
  expect(text).not.toMatch(/\$\{\{\s*(inputs|github\.event\.inputs)\./);
  expect(text).not.toMatch(/inputs\.\w+ \|\| '/);
  expect(text).not.toMatch(/OUTPUT_DIR|OUT_DIR/);
  expect(text).toContain('git add api/northerntrust\n          if git diff --cached --quiet -- api/northerntrust');
  expect([...text.matchAll(/git add (\S+)/g)].map((m) => m[1])).toEqual(['api/northerntrust']);
  expect(text).toContain('if: ${{ !cancelled() }}');
  expect(text).not.toContain('bunx tsc');
});

test('workflow: protected repository variables win and nothing is dropped from the old input set', () => {
  const text = workflow();
  expect(text).toContain('PROTECTED_SEC_UA: ${{ vars.SEC_UA }}');
  expect(text).toContain('PROTECTED_STORE_RAW_DOWNLOADS: ${{ vars.STORE_RAW_DOWNLOADS }}');
  const individual = workflowInputs(text).filter((n) => n !== 'advanced').map((n) => n.toUpperCase());
  // Controls not exposed as an individual input stay reachable through `advanced` and the config file.
  const hidden = CONTROL_NAMES.filter((name) => !individual.includes(name));
  expect(hidden.sort()).toEqual(['CATALOG_URL', 'SEC_UA', 'STORE_RAW_DOWNLOADS', 'TOTAL_RETURN_10Y', 'USE_SYSTEM_CA', 'VERBOSE']);
  for (const name of hidden) expect(() => resolveControls(file(), { [name]: file()[name] })).not.toThrow();
});

test('updater only writes inside api/northerntrust', () => {
  const source = read('scripts/update-data.ts');
  expect(source).toContain("new URL('../api/northerntrust/', import.meta.url)");
  expect(CONTROL_NAMES).not.toContain('OUTPUT_DIR' as never);
});

test('README structure and shared sections', () => {
  const doc = read('README.md');
  const headings = [...doc.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  expect(headings).toEqual([
    'Using Bun',
    'Updating the static Northern Trust data',
    'TypeScript and verification',
    'Brands table',
    'Sibling applications',
    'License',
  ]);
  for (const heading of ['### Data sources', '### Metrics and caveats', '### Update controls', '### Examples']) expect(doc).toContain(heading);
  expect(doc).toContain('file defaults < `advanced` JSON < nonblank inputs < protected Actions variable/env');
});

describe('system CA support', () => {
  test('USE_SYSTEM_CA resolver: auto/true/false case-insensitive, rejects maybe, default auto', () => {
    expect(file().USE_SYSTEM_CA).toBe('auto');
    expect(resolveControls(file()).USE_SYSTEM_CA).toBe('auto');
    for (const mode of ['auto', 'true', 'false', 'AUTO', 'True', 'FALSE']) {
      expect(resolveControls(file(), {}, {}, { USE_SYSTEM_CA: mode }).USE_SYSTEM_CA).toBe(mode.toLowerCase());
    }
    expect(() => resolveControls(file(), {}, {}, { USE_SYSTEM_CA: 'maybe' })).toThrow();
    expect(() => resolveControls(file(), { USE_SYSTEM_CA: 'maybe' })).toThrow();
  });

  test('isCertError matches certificate errors, directly or through cause', () => {
    expect(isCertError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
    expect(isCertError(new Error('unable to get local issuer certificate'))).toBe(true);
    expect(isCertError(new Error('fetch failed', { cause: new Error('unable to get local issuer certificate') }))).toBe(true);
    expect(isCertError({ code: 'ECONNRESET' })).toBe(false);
    expect(isCertError(new Error('HTTP 403 Forbidden'))).toBe(false);
    expect(isCertError(null)).toBe(false);
  });

  test('installSystemCa wraps fetch only in auto mode and restarts once on certificate errors', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    const reexec = (() => { calls++; return undefined as never; }) as () => never;
    try {
      installSystemCa('false', reexec, false);
      expect(globalThis.fetch).toBe(original);
      installSystemCa('auto', reexec, true);
      expect(globalThis.fetch).toBe(original);
      installSystemCa('true', reexec, true);
      expect(calls).toBe(0);
      installSystemCa('true', reexec, false);
      expect(calls).toBe(1);
      globalThis.fetch = original; // the real reexec never returns; the stub does and falls through to wrapping

      calls = 0;
      let next: () => Promise<Response> = async () => new Response('ok');
      globalThis.fetch = (async () => next()) as unknown as typeof fetch;
      const stub = globalThis.fetch;
      installSystemCa('auto', reexec, false);
      expect(globalThis.fetch).not.toBe(stub);
      expect(await (await globalThis.fetch('https://example.invalid/')).text()).toBe('ok');
      expect(calls).toBe(0);
      next = async () => { throw new Error('ECONNRESET'); };
      await expect(globalThis.fetch('https://example.invalid/')).rejects.toThrow('ECONNRESET');
      expect(calls).toBe(0);
      const originalError = console.error;
      console.error = () => {};
      try {
        next = async () => { throw new Error('fetch failed', { cause: { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' } }); };
        await globalThis.fetch('https://example.invalid/');
      } finally { console.error = originalError; }
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ---------------------------------------------------------------------------
// Mocked end-to-end pipeline (fetch mocked, temporary api root, no network)
// ---------------------------------------------------------------------------

type MockFund = { ticker: string; young?: boolean };
const MOCK_FUNDS: MockFund[] = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'].map((ticker) => ({ ticker }));

function mockCatalogPage(funds: MockFund[]): string {
  const fundList = funds.map((fund) => {
    const entry = structuredClone(JSON.parse(decodeNorthernTrustEntities(/data-content="([^"]*fundList[^"]*)"/.exec(NORTHERN_CATALOG_PAGE_FIXTURE)![1])).fundList[0]) as Record<string, any>;
    entry.ticker = fund.ticker;
    entry.pagePath = `/us/en/individual/funds/${fund.ticker.toLowerCase()}`;
    entry.pricing['fund-name'] = `Northern Trust ${fund.ticker} ETF`;
    if (fund.young) {
      for (const block of ['monthly-performance-nav', 'monthly-performance-market', 'quarterly-performance-nav']) {
        for (const key of Object.keys(entry[block])) if (!/as-of-date/.test(key)) entry[block][key] = '--';
      }
    }
    return entry;
  });
  const escaped = (value: unknown): string => JSON.stringify(value).replace(/"/g, '&#34;');
  return `<html><body><div data-content="${escaped({ fundList })}"></div></body></html>`;
}

function mockFacts(fund: MockFund): string {
  let text = NORTHERN_FACTS_FIXTURE.replace('TICKER,"QLC"', `TICKER,"${fund.ticker}"`).replace('CUSIP,"33939L746"', `CUSIP,"33939${fund.ticker}"`);
  if (fund.young) text = text.split('\n').map((line) => (/^"(NAV|Market Price|S&P|Northern Trust Quality)/.test(line) ? line.replace(/"[-\d.]+"/g, '"--"') : line)).join('\n');
  return text;
}

function mockPricing(fund: MockFund): unknown[] {
  const rows: unknown[] = [];
  const add = (date: string, nav: number) => rows.push({ TICKER: fund.ticker, AS_OF_DATE: date, NET_ASSET_VALUE: String(nav), CLOSING_MARKET_PRICE: String(nav + 0.01), PREMIUM_DISCOUNT: '0.01' });
  if (!fund.young) for (const [i, year] of [2019, 2020, 2021, 2022, 2023, 2024, 2025].entries()) add(`01/02/${year}`, 30 + i * 3);
  for (let day = 10; day <= 25; day++) add(`09/${String(day).padStart(2, '0')}/2026`, 90 + (day - 10) * 0.1);
  return rows;
}

type MockRequest = { url: string };
function installMockFetch(options: { delayMs?: number; failAll?: string[]; failPricing?: string[]; failDistributions?: Record<string, number>; emptyPricing?: string[]; funds?: MockFund[]; yahoo?: boolean } = {}): { requests: MockRequest[]; peak: () => number } {
  const requests: MockRequest[] = [];
  let inFlight = 0;
  let peak = 0;
  const funds = options.funds ?? MOCK_FUNDS;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    requests.push({ url });
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      const ok = (body: string, type = 'text/plain') => new Response(body, { status: 200, headers: { 'content-type': type } });
      if (/\/individual\/funds$/.test(url)) return ok(mockCatalogPage(funds), 'text/html');
      const match = /\/fund\/([a-z]+)\/\1([-_])([a-z]+)\.(csv|json)$/.exec(url);
      const fund = match ? funds.find((item) => item.ticker.toLowerCase() === match[1]) : undefined;
      if (match && fund) {
        const kind = match[3];
        if (kind === 'all' && options.failAll?.includes(fund.ticker)) return new Response('boom', { status: 500 });
        if (kind === 'all') return ok(mockFacts(fund));
        if (kind === 'etfcharts') return ok(JSON.stringify({ ...NORTHERN_ETFCHARTS_FIXTURE, Ticker: fund.ticker, FundName: `Northern Trust ${fund.ticker} ETF` }), 'application/json');
        if (kind === 'holdings') return ok(NORTHERN_EQUITY_HOLDINGS_FIXTURE);
        if (kind === 'pricing') {
          if (options.failPricing?.includes(fund.ticker)) return new Response('boom', { status: 500 });
          return ok(JSON.stringify(options.emptyPricing?.includes(fund.ticker) ? [] : mockPricing(fund)), 'application/json');
        }
        if (kind === 'distributions') {
          const status = options.failDistributions?.[fund.ticker];
          return status ? new Response('boom', { status }) : ok(NORTHERN_DISTRIBUTIONS_FIXTURE);
        }
      }
      if (/query1\.finance\.yahoo\.com/.test(url) && options.yahoo) {
        return ok(JSON.stringify({ chart: { result: [{ meta: { exchangeName: 'PCX', regularMarketPrice: 50 }, timestamp: [1780000000, 1780086400], indicators: { quote: [{ close: [50, 51], volume: [1, 2], open: [50, 51], high: [50, 51], low: [50, 51] }], adjclose: [{ adjclose: [50, 51] }] } }] } }), 'application/json');
      }
      return new Response('not found', { status: 404 });
    } finally {
      inFlight -= 1;
    }
  }) as typeof fetch;
  return { requests, peak: () => peak };
}

const pipelineControls = (extra: Record<string, string> = {}) =>
  readConfig(resolveControls({}, {}, {}, { REQUEST_SLEEP: '0', CONCURRENCY: '1', SKIP_YAHOO: 'true', EDGAR_FALLBACK: 'false', ...extra }));

async function withTempFeed<T>(run: (root: URL) => Promise<T>): Promise<T> {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const dir = await mkdtemp(join(tmpdir(), 'nt-feed-'));
  setApiRootForTests(pathToFileURL(`${dir}/`));
  try {
    return await run(pathToFileURL(`${dir}/`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const readJsonFile = async (root: URL, path: string) => JSON.parse(await Bun.file(new URL(path, root)).text());
const readIndex = async (root: URL): Promise<{ funds: Record<string, any>[]; counts: Record<string, number> }> => readJsonFile(root, 'index.json');

describe('strict controls (no silent fallbacks)', () => {
  test('AUM and range bounds with a stray colon or a non-number are errors', () => {
    expect(() => parseAumRange('abc:')).toThrow(/AUM/);
    expect(() => parseAumRange('1B:2B:3B')).toThrow(/exactly one colon/);
    expect(() => parseAumRange('x1B:')).toThrow(/AUM/);
    expect(() => parseRange('1:2:3', 'PERFORMANCE_1Y')).toThrow(/exactly one colon/);
    expect(parseAumRange('1B:')).toEqual({ min: 1e9, max: undefined });
  });

  test('HISTORY_RANGE accepts only max or Ny, CATALOG_URL must be https', () => {
    expect(() => resolveControls({}, {}, {}, { HISTORY_RANGE: 'garbage' })).toThrow(/HISTORY_RANGE/);
    expect(() => resolveControls({}, {}, {}, { HISTORY_RANGE: '6mo' })).toThrow(/HISTORY_RANGE/);
    expect(resolveControls({}, {}, {}, { HISTORY_RANGE: '5y' }).HISTORY_RANGE).toBe('5y');
    expect(() => resolveControls({}, {}, {}, { CATALOG_URL: 'http://etfs.ntam.northerntrust.com/x' })).toThrow(/CATALOG_URL/);
    expect(() => resolveControls({}, {}, {}, { CATALOG_URL: 'ftp://x.test' })).toThrow(/CATALOG_URL/);
    expect(() => resolveControls({}, {}, {}, { CATALOG_URL: 'not a url' })).toThrow(/CATALOG_URL/);
    expect(resolveControls({}, {}, {}, { CATALOG_URL: 'https://etfs.ntam.northerntrust.com/us/en/individual/funds' }).CATALOG_URL).toContain('https://');
    expect(resolveControls({}, {}, {}, { CATALOG_URL: 'http://localhost:8080/funds' }).CATALOG_URL).toBe('http://localhost:8080/funds');
  });

  test('HISTORY_RANGE really shrinks the Yahoo request: explicit period1/period2, never range=', () => {
    const now = Date.UTC(2026, 8, 25);
    const max = new URL(chartUrl('QLC', { historyRange: 'max' }, now));
    const five = new URL(chartUrl('QLC', { historyRange: '5y' }, now));
    expect(max.searchParams.get('period1')).toBe('0');
    expect(Number(five.searchParams.get('period1'))).toBe(Math.floor(now / 1000 - 5 * 365.25 * 86_400));
    expect(five.searchParams.get('period2')).toBe(String(Math.floor(now / 1000)));
    expect(five.searchParams.has('range')).toBe(false);
  });
});

describe('fetch layer', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; configureFetchForTests({ timeoutMs: 45_000, sleepMs: 0, deadlineMs: 25 * 60_000 }); });

  test('every fetch has a timeout and a hanging request is retried then fails', async () => {
    configureFetchForTests({ timeoutMs: 30, sleepMs: 0, lanes: 1 });
    let calls = 0;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls += 1;
      const signal = init?.signal;
      if (!signal) { await new Promise((resolve) => setTimeout(resolve, 150)); return new Response('late', { status: 200 }); }
      return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }) as typeof fetch;
    await expect(fetchWithRetry('https://example.test/x', 't', {}, 1)).rejects.toThrow(/network error/);
    expect(calls).toBe(2);
  });

  test('pacing reserves the lane slot synchronously: 6 simultaneous requests on 2 lanes start 0,0,S,S,2S,2S', async () => {
    configureFetchForTests({ sleepMs: 200, lanes: 2 });
    const t0 = Date.now();
    const starts: number[] = [];
    await Promise.all([0, 1, 2, 3, 4, 5].map(async () => { await paceRequests(); starts.push(Date.now() - t0); }));
    starts.sort((a, b) => a - b);
    expect(starts[1]).toBeLessThan(100);
    expect(starts[2]).toBeGreaterThanOrEqual(150);
    expect(starts[3]).toBeGreaterThanOrEqual(150);
    expect(starts[4]).toBeGreaterThanOrEqual(350);
    expect(starts[5]).toBeGreaterThanOrEqual(350);
  });
});

describe('metrics, dates and source hygiene', () => {
  test('a derived since-inception needs at least one year of history', () => {
    const day = (date: string, adjClose: number) => ({ date, close: adjClose, adjClose, volume: 1 });
    expect(priceReturns([day('2025-11-25', 100), day('2026-09-25', 110)], new Date('2026-09-26T00:00:00Z')).siAnn).toBeNull();
    expect(priceReturns([day('2024-09-25', 100), day('2026-09-25', 121)], new Date('2026-09-26T00:00:00Z')).siAnn).toBeCloseTo(10, 1);
  });

  test('performanceAsOf is null when the fund has no return at all, never a date without figures', () => {
    const none = deriveCatalogMetrics(
      { ytd: null, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null },
      { asOfDate: '2026-09-25', ytd: null, yr1: null, cagr3y: null, cagr5y: null, cagr10y: null, siAnn: null, mo1: 0.5, qtd: 0.4 },
      null, null, null, null, null,
    );
    expect(none.performanceAsOf).toBeNull();
    expect(none.returnsBasis).toBeTruthy();
    const some = deriveCatalogMetrics(
      { ytd: null, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null },
      { asOfDate: '2026-09-25', ytd: 1.2, yr1: null, cagr3y: null, cagr5y: null, cagr10y: null, siAnn: null, mo1: 0.5, qtd: 0.4 },
      null, null, null, null, null,
    );
    expect(some.performanceAsOf).toBe('2026-09-25');
  });

  test('an N-PORT filing older than the published holdings never replaces them', () => {
    expect(isOlderReport('2026-06-30', '2026-08-31')).toBe(true);
    expect(isOlderReport('2026-08-31', '2026-08-31')).toBe(false);
    expect(isOlderReport('2026-09-30', '2026-08-31')).toBe(false);
    expect(isOlderReport('2026-06-30', '')).toBe(false);
  });

  test('emptyMetrics carries the full contract key set with null, never 0', () => {
    const metrics = emptyMetrics();
    expect(Object.keys(metrics)).toEqual(['ytd', 'tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr5y', 'cagr10y', 'siAnn', 'dividendYield', 'dividendYieldText', 'secYield', 'secYieldText', 'returnsBasis', 'performanceAsOf']);
    expect(Object.values(metrics).includes(0)).toBe(false);
    expect(metrics.returnsBasis).toBeTruthy();
  });

  test('the updater source has no stray non-Latin identifiers and no copy-pasted JPMorgan registrant comment', () => {
    const source = readFileSync(new URL('./update-data.ts', import.meta.url), 'utf8');
    expect(/[\u0600-\u06FF]/.test(source)).toBe(false);
    expect(source).not.toContain('The JPMorgan ETF registrant CIK');
  });

  test('the catalog TER is NET with the gross beside it', () => {
    const funds = parseNorthernTrustCatalog(NORTHERN_CATALOG_PAGE_FIXTURE);
    const qlc = funds.find((fund) => fund.ticker === 'QLC')!;
    expect(qlc.ter).toBe(0.25);
    expect(qlc.terGross).toBe(0.26);
  });
});

describe('update pipeline (mocked fetch, temporary api root)', () => {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  afterEach(() => {
    globalThis.fetch = realFetch;
    console.log = realLog;
    configureFetchForTests({ timeoutMs: 45_000, sleepMs: 0, deadlineMs: 25 * 60_000 });
    // runUpdater throws on a failed run; keep the test process exit status clean regardless
    (globalThis as any).process.exitCode = 0;
  });
  const capture = (): string[] => { const lines: string[] = []; console.log = (...args: unknown[]) => { lines.push(args.join(' ')); }; return lines; };

  test('a one-ticker run keeps every published row and file', async () => {
    capture();
    installMockFetch();
    await withTempFeed(async (root) => {
      await runUpdater(pipelineControls());
      expect((await readIndex(root)).funds.length).toBe(6);
      const mock = installMockFetch();
      await runUpdater(pipelineControls({ TICKERS: 'CCC' }));
      const index = await readIndex(root);
      expect(index.funds.map((fund) => fund.ticker)).toEqual(['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF']);
      expect(index.counts.funds).toBe(6);
      expect(mock.requests.some((request) => request.url.includes('/ccc/'))).toBe(true);
      expect(mock.requests.some((request) => request.url.includes('/aaa/'))).toBe(false);
    });
  });

  test('terValue is the NET expense ratio, terGrossValue the gross one', async () => {
    capture();
    installMockFetch();
    await withTempFeed(async (root) => {
      await runUpdater(pipelineControls({ TICKERS: 'AAA' }));
      const row = (await readIndex(root)).funds.find((fund) => fund.ticker === 'AAA')!;
      expect(row.terValue).toBe(0.25);
      expect(row.terGrossValue).toBe(0.26);
      expect(row.ter).toBe('0.25%');
      const meta = await readJsonFile(root, 'funds/AAA/meta.json');
      expect(meta.expenseRatio.value).toBe(0.25);
      expect(meta.expenseRatio.gross).toBe(0.26);
      expect(meta.expenseRatio.net).toBe(0.25);
    });
  });

  test('MAX_FETCHES counts only funds that pass the filters, so a late ticker is reached', async () => {
    capture();
    installMockFetch();
    await withTempFeed(async (root) => {
      await runUpdater(pipelineControls({ TICKERS: 'FFF', MAX_FETCHES: '1' }));
      expect((await readJsonFile(root, 'funds/FFF/meta.json')).ticker).toBe('FFF');
      expect((await readJsonFile(root, 'update-state.json')).cursor).toBe('FFF');
    });
  });

  test('the cursor wraps around and is ignored for a different filter set', async () => {
    capture();
    installMockFetch();
    await withTempFeed(async (root) => {
      const seen: string[] = [];
      for (let run = 0; run < 4; run++) {
        await runUpdater(pipelineControls({ MAX_FETCHES: '2' }));
        seen.push((await readJsonFile(root, 'update-state.json')).cursor);
      }
      expect(seen).toEqual(['BBB', 'DDD', 'FFF', 'BBB']);
      await runUpdater(pipelineControls({ MAX_FETCHES: '1', TICKERS: 'CCC' }));
      expect((await readJsonFile(root, 'update-state.json')).cursor).toBe('CCC');
    });
  });

  test('a run where no fund received fresh data fails instead of exiting green', async () => {
    capture();
    installMockFetch();
    await withTempFeed(async (root) => {
      await runUpdater(pipelineControls());
      globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
      await expect(runUpdater(pipelineControls())).rejects.toThrow(/every examined fund failed/);
      expect((await readIndex(root)).funds.length).toBe(6);
    });
  });

  test('CONCURRENCY really runs funds in parallel: peak in-flight 1 at c=1, N at c=N', async () => {
    capture();
    for (const [concurrency, expected] of [[1, 1], [3, 3]] as const) {
      const mock = installMockFetch({ delayMs: 15 });
      await withTempFeed(async () => {
        await runUpdater(pipelineControls({ CONCURRENCY: String(concurrency) }));
      });
      expect(mock.peak()).toBe(expected);
    }
  });

  test('an unchanged rerun writes nothing and leaves no temporary files', async () => {
    capture();
    installMockFetch();
    const { readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const snapshot = (dir: string): Record<string, number> => {
      const out: Record<string, number> = {};
      const walk = (path: string): void => {
        for (const name of readdirSync(path)) {
          const full = join(path, name);
          if (statSync(full).isDirectory()) walk(full); else out[full] = statSync(full).mtimeMs;
        }
      };
      walk(dir);
      return out;
    };
    await withTempFeed(async (root) => {
      await runUpdater(pipelineControls());
      const dir = fileURLToPath(root);
      const first = snapshot(dir);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await runUpdater(pipelineControls());
      expect(snapshot(dir)).toEqual(first);
      expect(Object.keys(first).some((name) => name.endsWith('.tmp'))).toBe(false);
    });
  });

  test('new funds are announced as NEW FUNDS', async () => {
    const lines = capture();
    installMockFetch({ funds: MOCK_FUNDS.slice(0, 2) });
    await withTempFeed(async () => {
      await runUpdater(pipelineControls());
      installMockFetch();
      await runUpdater(pipelineControls({ TICKERS: 'AAA' }));
    });
    expect(lines).toContain('NEW FUNDS: CCC, DDD, EEE, FFF');
  });

  test('a fund whose full-data CSV failed keeps its previous complete state, byte for byte', async () => {
    capture();
    installMockFetch();
    await withTempFeed(async (root) => {
      await runUpdater(pipelineControls());
      const before = { meta: await Bun.file(new URL('funds/BBB/meta.json', root)).text(), row: (await readIndex(root)).funds[1] };
      installMockFetch({ failAll: ['BBB'] });
      await runUpdater(pipelineControls({ MAX_RETRIES: '1' }));
      expect(await Bun.file(new URL('funds/BBB/meta.json', root)).text()).toBe(before.meta);
      expect((await readIndex(root)).funds[1]).toEqual(before.row);
    });
  });

  test('a failing pricing JSON keeps the fund, a missing distributions file (404) is an honest none, a 500 keeps the fund', async () => {
    capture();
    installMockFetch();
    await withTempFeed(async (root) => {
      await runUpdater(pipelineControls());
      const before = await Bun.file(new URL('funds/CCC/meta.json', root)).text();
      // the only examined fund fails, so the run reports failure, but the fund itself stays untouched
      installMockFetch({ failPricing: ['CCC'] });
      await expect(runUpdater(pipelineControls({ TICKERS: 'CCC', MAX_RETRIES: '1' }))).rejects.toThrow(/every examined fund failed/);
      expect(await Bun.file(new URL('funds/CCC/meta.json', root)).text()).toBe(before);
      installMockFetch({ failDistributions: { CCC: 500 } });
      await expect(runUpdater(pipelineControls({ TICKERS: 'CCC', MAX_RETRIES: '1' }))).rejects.toThrow(/every examined fund failed/);
      expect(await Bun.file(new URL('funds/CCC/meta.json', root)).text()).toBe(before);
      installMockFetch({ failDistributions: { CCC: 404 } });
      await runUpdater(pipelineControls({ TICKERS: 'CCC' }));
      expect((await readJsonFile(root, 'funds/CCC/meta.json')).ticker).toBe('CCC');
    });
  });

  test('an official NAV history is never replaced by the Yahoo schema', async () => {
    capture();
    installMockFetch();
    await withTempFeed(async (root) => {
      await runUpdater(pipelineControls());
      const headersBefore = (await readJsonFile(root, 'funds/AAA/history/001.json')).headers;
      expect(headersBefore).toContain('NAV');
      installMockFetch({ emptyPricing: ['AAA'], yahoo: true });
      await runUpdater(pipelineControls({ SKIP_YAHOO: 'false', TICKERS: 'AAA' }));
      expect((await readJsonFile(root, 'funds/AAA/history/001.json')).headers).toEqual(headersBefore);
      expect((await readJsonFile(root, 'funds/AAA/meta.json')).history.source).toBe('previous run');
    });
  });

  test('a fund that lost its index row is rebuilt from meta.json, a row without meta gets dataFile null and full metrics', async () => {
    capture();
    installMockFetch();
    const { writeFile } = await import('node:fs/promises');
    await withTempFeed(async (root) => {
      await runUpdater(pipelineControls());
      const index = await readIndex(root);
      const trimmed = { ...index, funds: index.funds.filter((fund) => fund.ticker !== 'DDD').concat([{ ticker: 'ZZZ', name: 'Ghost' }]) };
      await writeFile(new URL('index.json', root), JSON.stringify(trimmed), 'utf8');
      installMockFetch();
      await runUpdater(pipelineControls({ TICKERS: 'AAA' }));
      const after = await readIndex(root);
      expect(after.funds.map((fund) => fund.ticker)).toEqual(['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'ZZZ']);
      const ddd = after.funds.find((fund) => fund.ticker === 'DDD')!;
      expect(ddd.dataFile).toBe('./funds/DDD/meta.json');
      expect(ddd.metrics.ytd).toBe(14.5);
      expect(ddd.terValue).toBe(0.25);
      expect(ddd.holdings).toBeGreaterThan(0);
      const ghost = after.funds.find((fund) => fund.ticker === 'ZZZ')!;
      expect(ghost.dataFile).toBeNull();
      expect(Object.keys(ghost.metrics)).toEqual(Object.keys(emptyMetrics()));
      expect(ghost.metrics.returnsBasis).toBeTruthy();
    });
  });

  test('indexRowFromMeta matches the row the updater wrote', async () => {
    capture();
    installMockFetch();
    await withTempFeed(async (root) => {
      await runUpdater(pipelineControls({ TICKERS: 'AAA' }));
      const row = (await readIndex(root)).funds[0];
      const rebuilt = indexRowFromMeta(await readJsonFile(root, 'funds/AAA/meta.json'));
      expect(rebuilt.metrics).toEqual(row.metrics);
      for (const key of ['ticker', 'name', 'cusip', 'ter', 'terValue', 'terGrossValue', 'navValue', 'aumValue', 'closePriceValue', 'holdings', 'history', 'dataFile', 'asOfDate', 'inceptionDate', 'exchange']) {
        expect(rebuilt[key]).toEqual(row[key]);
      }
      expect(rebuilt.returns).toEqual(row.returns);
      expect(rebuilt.distributions).toEqual(row.distributions);
    });
  });

  test('a young fund without any return has performanceAsOf null, and its month-end block is dated by its price history', async () => {
    capture();
    installMockFetch({ funds: [{ ticker: 'AAA', young: true }] });
    await withTempFeed(async (root) => {
      await runUpdater(pipelineControls());
      const row = (await readIndex(root)).funds[0];
      expect(Object.values(row.metrics).some((value) => typeof value === 'number' && !['dividendYield', 'secYield'].includes(String(value)))).toBe(true);
      expect(row.metrics.ytd).toBeNull();
      expect(row.metrics.tr1y).toBeNull();
      expect(row.metrics.performanceAsOf).toBeNull();
      expect(row.returns.monthEnd.asOfDate).toBe('Sep 25 2026');
      expect(row.returns.monthEnd.priceReturnsAsOf).toBe('Sep 25 2026');
    });
  });

  test('an official month-end table keeps its own date and reports the later price-return date separately', async () => {
    capture();
    installMockFetch();
    await withTempFeed(async (root) => {
      await runUpdater(pipelineControls({ TICKERS: 'AAA' }));
      const row = (await readIndex(root)).funds[0];
      expect(row.returns.monthEnd.asOfDate).toBe('Aug 31 2026');
      expect(row.returns.monthEnd.priceReturnsAsOf).toBe('Sep 25 2026');
      expect(row.metrics.performanceAsOf).toBe('2026-08-31');
    });
  });

  test('SEC_YIELD is a working filter, not a no-op', async () => {
    capture();
    await withTempFeed(async (root) => {
      installMockFetch();
      await runUpdater(pipelineControls());
      const mock = installMockFetch();
      await runUpdater(pipelineControls({ SEC_YIELD: '20:' }));
      expect(mock.requests.some((request) => /-all\.csv|_pricing\.json/.test(request.url))).toBe(false);
      expect((await readIndex(root)).funds.length).toBe(6);
    });
  });

  test('the soft deadline stops taking funds, still writes the full index and resumes where it stopped', async () => {
    capture();
    installMockFetch({ delayMs: 25 });
    await withTempFeed(async (root) => {
      await runUpdater(pipelineControls());
      configureFetchForTests({ deadlineMs: 60 });
      await runUpdater(pipelineControls());
      const state = await readJsonFile(root, 'update-state.json');
      expect(state.partial).toBe(true);
      expect(state.cursor).not.toBeNull();
      expect(state.cursor).not.toBe('FFF');
      expect((await readIndex(root)).funds.length).toBe(6);
      configureFetchForTests({ deadlineMs: 25 * 60_000 });
      await runUpdater(pipelineControls());
      const done = await readJsonFile(root, 'update-state.json');
      expect(done.partial).toBe(false);
      expect(done.cursor).toBeNull();
    });
  });
});
