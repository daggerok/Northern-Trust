/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CONTROL_NAMES,
  DIVIDEND_SCHEDULE_CAP,
  HOLDINGS_HEADERS,
  BOND_SHEET_HEADERS,
  annualizedSinceInception,
  annualizedToTotal,
  chartUrl,
  compareHoldingRows,
  configureFetchForTests,
  decodeDividendFrequency,
  deriveCatalogMetrics,
  edgarSeriesFilingsUrl,
  emptyMetrics,
  ensureMetricsContract,
  fetchWithRetry,
  fractionToPercent,
  indexRowFromMeta,
  withYieldBasis,
  yieldBasisFromKind,
  indicatedYield,
  inferDistributionFrequency,
  installSystemCa,
  isCertError,
  isoToEpoch,
  isOlderReport,
  labelToIsoDate,
  navTotalReturnDays,
  normalizeHoldingName,
  nportUrlFor,
  northernTrustAllCsvUrl,
  northernTrustCikFor,
  northernTrustDistributionsCsvUrl,
  northernTrustEtfChartsJsonUrl,
  northernTrustFundPageUrl,
  northernTrustHoldingsCsvUrl,
  northernTrustPricingJsonUrl,
  numberOrNull,
  paceRequests,
  parseAumRange,
  parseChart,
  parseCompanyTickerMap,
  parseCsv,
  parseEdgarAtomFilings,
  parseFundTickerMap,
  parseNport,
  parseNportAccessions,
  parseNorthernTrustCatalog,
  parseNorthernTrustDistributionsCsv,
  parseNorthernTrustFacts,
  parseNorthernTrustHoldings,
  parseNorthernTrustPricing,
  parseRange,
  pickEftsCik,
  priceReturns,
  readConfig,
  reinvestmentCoverageStart,
  resolveControls,
  runUpdater,
  runtimeControls,
  setApiRootForTests,
  toIsoDate,
  totalToAnnualized,
  weightsSum,
  cleanHoldingTicker,
  lastCompletedQuarterEnd,
} from './update-data';

// ---------------------------------------------------------------------------
// Shared setup: every test starts from the same state and leaves nothing behind
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
const realLog = console.log;
const realNow = Date.now;
const realTz = process.env.TZ;

beforeEach(() => {
  process.env.TZ = 'UTC';
  console.log = () => {};
  configureFetchForTests({ timeoutMs: 45_000, sleepMs: 0, lanes: 1, deadlineMs: 25 * 60_000 });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  Date.now = realNow;
  if (realTz === undefined) delete process.env.TZ;
  else process.env.TZ = realTz;
  process.exitCode = 0;
  configureFetchForTests({ timeoutMs: 45_000, sleepMs: 0, lanes: 1, deadlineMs: 25 * 60_000 });
});

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const configFile = (): Record<string, string> => JSON.parse(read('scripts/update-data.config.json'));
const escapeAttr = (value: unknown): string => JSON.stringify(value).replace(/"/g, '&#34;');

// ---------------------------------------------------------------------------
// Fixtures (tiny, inline; shapes captured from the live provider 2026-09-27)
// ---------------------------------------------------------------------------

const GRID_KEYS = ['1-mo', 'qtd', 'ytd', '1-yr', '3-yr', '5-yr', '7-yr', '10-yr', 'since-inception'];
const grid = (dateKey: string, date: string, values: string[]) => ({
  [dateKey]: date,
  ...Object.fromEntries(GRID_KEYS.map((key, index) => [key, values[index]])),
});

// QLC: seasoned equity fund; GUNR: two asset-class tags; TXCA: days old, every
// performance cell "--"; TEST: synthetic edge row (no page path, minimal pricing).
const CATALOG_DOCUMENT = {
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
      'monthly-performance-nav': grid('month-end-as-of-date', '08/31/2026', ['2.01%', '2.61%', '14.50%', '24.89%', '23.97%', '14.34%', '17.19%', '14.73%', '14.31%']),
      'monthly-performance-market': grid('month-end-as-of-date', '08/31/2026', ['1.99%', '2.64%', '14.38%', '24.91%', '23.95%', '14.32%', '17.18%', '14.74%', '14.31%']),
      'quarterly-performance-nav': grid('quarter-end-as-of-date', '06/30/2026', ['.09%', '15.37%', '11.58%', '27.77%', '23.68%', '15.05%', '16.53%', '14.91%', '14.28%']),
    },
    {
      ticker: 'GUNR',
      assetClassTags: { 'real-assets': 'Real Assets', equity: 'Equity' },
      investmentObjectiveTags: { 'risk-management': 'Risk Management' },
      pagePath: '/us/en/individual/funds/gunr',
      pricing: { 'fund-name': 'Northern Trust Global Upstream Natural Resources ETF', 'inception-date': '09/16/2011' },
    },
    {
      ticker: 'TXCA',
      assetClassTags: { 'fixed-income': 'Fixed Income' },
      investmentObjectiveTags: {},
      pagePath: '/us/en/individual/funds/txca',
      pricing: { 'fund-name': 'Northern Trust California Tax-Exempt Bond ETF', 'inception-date': '09/22/2026', 'net-expense-ratio': '0.06%' },
      'monthly-performance-nav': grid('month-end-as-of-date', '--', GRID_KEYS.map(() => '--')),
    },
    { ticker: 'TEST', assetClassTags: {}, investmentObjectiveTags: {}, pricing: { 'fund-name': 'Synthetic Edge Fund' } },
  ],
};
const CATALOG_PAGE = `<html><body><div data-content="${escapeAttr({ title: 'FEATURED' })}"></div><div data-content="${escapeAttr(CATALOG_DOCUMENT)}"></div></body></html>`;

const FACTS_CSV = `Data as of 09/25/2026
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
"Market Price","1.99","2.64","14.38","24.91","23.95","14.32","17.18","14.74","14.31"
"NAV","2.01","2.61","14.50","24.89","23.97","14.34","17.19","14.73","14.31"
Quarter-End Performance (as of 06/30/2026),1 Month,QTD,YTD,1 Year,3 Year,5 Year,7 Year,10 Year,Since Inception
"Market Price","-.05","15.27","11.44","27.49","23.66","15.01","16.54","14.90","14.27"
"NAV",".09","15.37","11.58","27.77","23.68","15.05","16.53","14.91","14.28"
Sector (%)
"Information Technology","36.20"`;

const ETFCHARTS = { Ticker: 'QLC', AsOfDate: '09/25/2026', FundName: 'Northern Trust US Quality Large Cap ETF', AssetType: 'Equity' };

const HOLDINGS_HEADER = 'Date,CUSIP,ISIN,SEDOL,Name,Ticker,Market Value-Local,Market Value-Base,Fund Weight %,Shares Held,Coupon,Maturity,Sector Type,Country';
const EQUITY_HOLDINGS_CSV = `${HOLDINGS_HEADER}
09/25/2026,67066G104,US67066G1040,2379504,NVIDIA CORP COMMON STOCK USD 0.001,NVDA,89170033.16,89170033.16,7.8138,396188,.000,,Information Technology,United States
09/25/2026,46625H100,US46625H1005,2190385,JPMORGAN CHASE &#38; CO COMMON STOCK USD 1,JPM,21522898.28,21522898.28,1.8860,62738,.000,,Financials,United States`;
const BOND_HOLDINGS_CSV = `${HOLDINGS_HEADER}
09/25/2026,USD_CCASH,,,CASH,,22393826.03,22393826.03,2.4820,22393826,.000,,,
09/25/2026,30303M8U9,US30303M8U95,BMWF4N7,META PLATFORMS INC CALLABLE NOTES FIXED 4.75%,,6603714.95,6603714.95,.7319,7130000,4.750,08/15/2034,Industrial,United States`;

// shuffled, with a repeated date and a bogus row
const PRICING_JSON = [
  { TICKER: 'QLC', AS_OF_DATE: '01/02/2020', NET_ASSET_VALUE: '37.03', CLOSING_MARKET_PRICE: '37.00', PREMIUM_DISCOUNT: '-.03' },
  { TICKER: 'QLC', AS_OF_DATE: '01/02/2019', NET_ASSET_VALUE: '30.34', CLOSING_MARKET_PRICE: '30.21', PREMIUM_DISCOUNT: '-.13' },
  { TICKER: 'QLC', AS_OF_DATE: '01/02/2020', NET_ASSET_VALUE: '37.04', CLOSING_MARKET_PRICE: '37.01', PREMIUM_DISCOUNT: '-.02' },
  { TICKER: 'QLC', AS_OF_DATE: 'bogus', NET_ASSET_VALUE: '1', CLOSING_MARKET_PRICE: '1', PREMIUM_DISCOUNT: '0' },
];

// a future ex-date and a zero row never enter the schedule
const DISTRIBUTIONS_CSV = `Ex-Date,Record Date,Payable Date,Income,Short-Term Capital Gains,Long-Term Capital Gains,Return of Capital,Total Distribution
12/18/2026,12/18/2026,12/24/2026,,,,,
09/18/2026,09/18/2026,09/24/2026,.224696,0,0,0,.224696
09/01/2026,09/01/2026,09/08/2026,0,0,0,0,0
06/18/2026,06/18/2026,06/25/2026,.2215,0,0,0,.2215`;

const navPoint = (date: string, nav: number) => ({ date, nav, marketPrice: nav, premiumDiscount: 0 });
const dividend = (exDate: string, amount = 0.067, reinvestNav: number | null = null) => ({
  epoch: isoToEpoch(exDate)!, amount, exDate, payDate: '', recordDate: '', reinvestNav, type: '',
});
const NO_RETURNS = { ytd: null, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null };
const derivedReturns = (extra: Record<string, unknown> = {}) => ({
  asOfDate: '2026-09-25', ytd: null, yr1: null, cagr3y: null, cagr5y: null, cagr10y: null, siAnn: null, mo1: null, qtd: null, ...extra,
});

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

describe('controls', () => {
  test('precedence is file < advanced < nonblank input < env, with brand aliases', () => {
    const merged = resolveControls(
      { CONCURRENCY: 2, TICKERS: 'QLC' },
      { CONCURRENCY: 3, TICKERS: 'SKOR' },
      { CONCURRENCY: '4', TICKERS: '' },
      { CONCURRENCY: '6', NORTHERNTRUST_CONCURRENCY: '5' },
    );
    expect(merged.CONCURRENCY).toBe('5');
    expect(merged.TICKERS).toBe('SKOR');
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }).CONCURRENCY).toBe('3');
    expect(resolveControls({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: 'false' }).SKIP_YAHOO).toBe('false');
    // blank input inherits, advanced may set empty, an explicitly empty env var clears
    expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
    expect(resolveControls({ TICKERS: 'QLC' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ TICKERS: 'QLC' }, {}, { TICKERS: 'SKOR' }, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ TICKERS: 'QLC' }, {}, {}, { TICKERS: undefined }).TICKERS).toBe('QLC');
    // brand and legacy aliases
    expect(resolveControls({}, {}, {}, { NORTHERNTRUST_LIMIT: '7' }).MAX_FETCHES).toBe('7');
    expect(resolveControls({}, {}, {}, { NORTHERNTRUST_LIMIT: '7', MAX_FETCHES: '9' }).MAX_FETCHES).toBe('9');
    expect(resolveControls({}, {}, {}, { HISTORICAL_PAGE_SIZE: '500' }).HISTORY_PAGE_SIZE).toBe('500');
    expect(resolveControls({}, {}, {}, { NORTHERNTRUST_STORE_RAW_DOWNLOADS: 'true' }).STORE_RAW_DOWNLOADS).toBe('true');
    expect(readConfig(resolveControls({ TICKERS: 'QLC' }, {}, {}, { NORTHERNTRUST_TICKERS: '' })).tickers).toEqual([]);
  });

  test('the checked-in config matches CONTROL_NAMES and the scheduled path equals the defaults', async () => {
    const defaults = configFile();
    expect(Object.keys(defaults).sort()).toEqual([...CONTROL_NAMES].sort());
    expect(Object.values(defaults).every((value) => typeof value === 'string')).toBe(true);
    expect(defaults.SEC_UA).toBe('daggerok ETF feed daggerok@gmail.com');
    expect(defaults.USE_SYSTEM_CA).toBe('auto');
    expect(resolveControls(defaults, {}, {}, {})).toEqual(defaults);
    const config = readConfig(defaults);
    expect(config).toMatchObject({ tickers: [], maxFetches: 0, concurrency: 2, maxRetries: 2, historyRange: 'max', edgarFallback: true, skipYahoo: false });
    expect(config.aumRange).toBeUndefined();
    expect(config.performanceRanges).toEqual({});
    expect(await runtimeControls({})).toEqual(defaults);
    const overridden = await runtimeControls({ TICKERS: 'QLC SKOR', MAX_RETRIES: '1' });
    expect(readConfig(overridden).tickers).toEqual(['QLC', 'SKOR']);
    expect(readConfig(overridden).maxRetries).toBe(1);
  });

  test('filters and ranges survive the resolver', () => {
    const config = readConfig(resolveControls(configFile(), { AUM: '1B:', TER: ':0.5', PERFORMANCE_1Y: '15:', TOTAL_RETURN_10Y: ':50' }, { TICKERS: 'qlc, skor' }));
    expect(config.aumRange).toEqual({ min: 1e9, max: undefined });
    expect(config.terRange).toEqual({ min: undefined, max: 0.5 });
    expect(config.performanceRanges['1Y']).toEqual({ min: 15, max: undefined });
    expect(config.totalReturnRanges['10Y']).toEqual({ min: undefined, max: 50 });
    expect(config.tickers).toEqual(['QLC', 'SKOR']);
    expect(parseRange(':', 'X')).toBeUndefined();
    expect(parseRange('0.1%:0.5%', 'X')).toEqual({ min: 0.1, max: 0.5 });
    expect(parseAumRange('10M:2B')).toEqual({ min: 10_000_000, max: 2_000_000_000 });
    expect(parseAumRange('large')).toEqual({ min: 10_000_000_000, max: undefined });
  });

  test('invalid values are errors, never silent fallbacks', () => {
    const bad: unknown[] = [
      { UNKNOWN: 1 }, { OUTPUT_DIR: '/tmp' }, { SEC_UA: 'x\nEVIL=yes' }, { TICKERS: 'QLC\r\nEVIL=1' }, { TICKERS: 'a\0b' },
      { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 }, { MAX_RETRIES: '1.5' }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: '-1' },
      { VERBOSE: 'maybe' }, { SKIP_YAHOO: 'sometimes' }, { USE_SYSTEM_CA: 'maybe' },
      { AUM: '5' }, { AUM: 'abc:' }, { AUM: '1B:2B:3B' }, { TER: '2:1' }, { PERFORMANCE_1Y: '10' }, { PERFORMANCE_1Y: '1:2:3' },
      { HISTORY_RANGE: 'garbage' }, { HISTORY_RANGE: '6mo' },
      { CATALOG_URL: 'ftp://example.com' }, { CATALOG_URL: 'http://etfs.ntam.northerntrust.com/x' }, { CATALOG_URL: 'not a url' },
      { TICKERS: ['QLC'] }, { TICKERS: { a: 1 } }, { TICKERS: null }, null, [], 'text',
    ];
    for (const value of bad) expect(() => resolveControls(value)).toThrow();
    expect(() => resolveControls({}, [])).toThrow();
    expect(() => resolveControls({}, { SEC_UA: 'x\rfoo' })).toThrow();
    expect(() => resolveControls({}, {}, { TICKERS: 'x\ny' })).toThrow();
    expect(() => resolveControls({}, {}, {}, { NORTHERNTRUST_SEC_UA: 'x\0bad' })).toThrow();
    expect(() => resolveControls({}, {}, {}, { HISTORY_RANGE: 'garbage' })).toThrow(/HISTORY_RANGE/);
    expect(() => parseRange('15', 'X')).toThrow(/colon is required/);
    expect(() => parseRange('5:1', 'X')).toThrow(/must not exceed/);
    expect(() => parseAumRange('42')).toThrow(/colon is required/);
    expect(resolveControls({}, {}, {}, { HISTORY_RANGE: '5y' }).HISTORY_RANGE).toBe('5y');
    expect(resolveControls({}, {}, {}, { CATALOG_URL: 'http://localhost:8080/funds' }).CATALOG_URL).toBe('http://localhost:8080/funds');
    for (const mode of ['auto', 'true', 'false', 'AUTO', 'True', 'FALSE']) {
      expect(resolveControls(configFile(), {}, {}, { USE_SYSTEM_CA: mode }).USE_SYSTEM_CA).toBe(mode.toLowerCase());
    }
  });
});

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

describe('parsing', () => {
  test('catalog: fields the hub reads, "--" cells become null, missing page path falls back', () => {
    const funds = parseNorthernTrustCatalog(CATALOG_PAGE);
    expect(funds.map((fund) => fund.ticker)).toEqual(['GUNR', 'QLC', 'TEST', 'TXCA']);
    const byTicker = (ticker: string) => funds.find((fund) => fund.ticker === ticker)!;
    const qlc = byTicker('QLC');
    expect(qlc).toMatchObject({
      name: 'Northern Trust US Quality Large Cap ETF', category: 'Equity', categoryPath: 'Equity / Capital Appreciation',
      inception: '2015-09-23', ter: 0.25, terGross: 0.26, close: 92.01, asOfDate: '2026-09-25', mo1: 2.01,
      returnsAsOfDate: '2026-08-31', quarterEndAsOfDate: '2026-06-30', trustCik: '0001491978', source: 'northerntrust',
      fundPage: 'https://etfs.ntam.northerntrust.com/us/en/individual/funds/qlc',
    });
    expect(qlc.returns).toEqual({ ytd: 14.5, yr1: 24.89, yr3: 23.97, yr5: 14.34, yr10: 14.73, sinceInception: 14.31 });
    expect(qlc.marketReturns.ytd).toBe(14.38);
    expect(qlc.quarterEnd.ytd).toBe(11.58);
    expect(byTicker('GUNR').category).toBe('Equity / Real Assets');
    const txca = byTicker('TXCA');
    expect(txca.trustCik).toBe('0000916620');
    expect(txca.returns).toEqual(NO_RETURNS);
    expect(txca.returnsAsOfDate).toBeNull();
    expect(txca.mo1).toBeNull();
    expect(txca.nav).toBeNull();
    expect(byTicker('TEST').category).toBe('ETF');
    expect(byTicker('TEST').fundPage).toBe('https://etfs.ntam.northerntrust.com/us/en/individual/funds/test');
    expect(() => parseNorthernTrustCatalog('<html>no funds here</html>')).toThrow(/funds-list JSON not found/);
    for (const ticker of ['TIPA', 'TXCA', 'tipa']) expect(northernTrustCikFor(ticker)).toBe('0000916620');
    for (const ticker of ['QLC', 'GUNR']) expect(northernTrustCikFor(ticker)).toBe('0001491978');
  });

  test('fund facts: official grids, duplicate keys, young fund, N/A and empty download', () => {
    const facts = parseNorthernTrustFacts(FACTS_CSV, ETFCHARTS, 'QLC');
    expect(facts).toMatchObject({
      ticker: 'QLC', cusip: '33939L746', exchange: 'CBOE', assetClass: 'Equity', benchmark: 'NTUQVM', inception: '2015-09-23',
      grossExpense: 0.26, netExpense: 0.25, nav: 91.99, navDate: '2026-09-25', marketPrice: 92.01, premiumDiscount: 0.0208,
      netAssets: 1129188730.6, sharesOutstanding: 12275001, numberOfHoldings: 162, dividendYield: 0.95, secYield: 0.95,
      unsubsidizedSecYield: 0.94, holdings: null,
    });
    expect(facts.monthEnd).toEqual({ ytd: 14.5, yr1: 24.89, yr3: 23.97, yr5: 14.34, yr10: 14.73, sinceInception: 14.31, asOfDate: '2026-08-31', mo1: 2.01, mo3: null });
    expect(facts.monthEndMarket.ytd).toBe(14.38);
    expect(facts.quarterEnd).toMatchObject({ ytd: 11.58, asOfDate: '2026-06-30' });
    expect(parseNorthernTrustFacts(FACTS_CSV.replace('Related Index,"NTUQVM"', 'Related Index,"N/A"'), ETFCHARTS, 'QLC').benchmark).toBe('');
    const monthly = parseNorthernTrustFacts(FACTS_CSV.replace('Total Net Assets,', 'Income Distribution Frequency,"Monthly"\nTotal Net Assets,'), { ...ETFCHARTS, AssetType: 'Fixed Income' }, 'TIPA');
    expect(decodeDividendFrequency(monthly.frequencyCode)).toEqual({ frequency: 'Monthly', paymentsPerYear: 12 });
    const young = parseNorthernTrustFacts(
      'Data as of 09/25/2026\nFund Facts\nInception,"09/22/2026"\nTICKER,"TXCA"\nCUSIP,"66516K855"\nGross Expense Ratio,".06"%\nNet Expense Ratio,".06"%\nSEC Subsidized Yield (as of 09/25/2026),"NA"%\n12-Month Dividend Yield,"NA"%\nNAV Price,$49.46\nPricing\nMarket Price,$49.50',
      null,
      'TXCA',
    );
    expect(young.cusip).toBe('66516K855');
    expect(young.secYield).toBeNull();
    expect(young.dividendYield).toBeNull();
    expect(young.assetClass).toBe('ETF');
    expect(young.monthEnd.asOfDate).toBeNull();
    expect(young.monthEnd.ytd).toBeNull();
    expect(young.quarterEnd.asOfDate).toBeNull();
    expect(() => parseNorthernTrustFacts('', null, 'QLC')).toThrow(/full-data CSV is empty/);
  });

  test('holdings: equity columns, bond columns, canonical order, missing header', () => {
    const equity = parseNorthernTrustHoldings(EQUITY_HOLDINGS_CSV, 'QLC')!;
    expect(equity.headers).toEqual(HOLDINGS_HEADERS);
    expect(equity.headers).not.toContain('Coupon');
    expect(equity).toMatchObject({ asOfDate: '2026-09-25', container: 'holdings.csv' });
    expect(equity.rows[0]).toEqual({
      Name: 'NVIDIA CORP COMMON STOCK USD 0.001', Ticker: 'NVDA', Identifier: '67066G104', Weight: '7.8138',
      'Market Value': '89170033.16', 'Shares Held': '396188', 'Asset Category': 'Information Technology',
    });
    expect(equity.rows[1].Name).toBe('JPMORGAN CHASE & CO COMMON STOCK USD 1');
    expect(weightsSum(equity.rows)).toBe(9.6998);
    const bonds = parseNorthernTrustHoldings(BOND_HOLDINGS_CSV, 'SKOR')!;
    expect(bonds.headers).toEqual(BOND_SHEET_HEADERS);
    expect(bonds.rows[0]).toMatchObject({ Name: 'CASH', Ticker: '-', Identifier: 'USD_CCASH' });
    expect(bonds.rows[1]).toMatchObject({ Ticker: '-', Coupon: '4.75', Maturity: 'Aug 15 2034', 'Asset Category': 'Industrial' });
    expect(compareHoldingRows({ Weight: '1', 'Market Value': '2', Name: 'B' }, { Weight: '2', 'Market Value': '1', Name: 'A' })).toBeGreaterThan(0);
    expect(compareHoldingRows({ Weight: '1', 'Market Value': '1', Name: 'A' }, { Weight: '1', 'Market Value': '1', Name: 'B' })).toBeLessThan(0);
    expect(parseNorthernTrustHoldings('Date,CUSIP,Name,Ticker,Market Value-Local,Market Value-Base,Fund Weight %,Shares Held', 'QLC')).toBeNull();
    expect(() => parseNorthernTrustHoldings('Fund Name,Price\nX,1', 'QLC')).toThrow(/header row not found/);
  });

  test('pricing and distributions: ascending, last duplicate wins, future and zero rows skipped', () => {
    const points = parseNorthernTrustPricing(PRICING_JSON, 'QLC');
    expect(points).toEqual([
      { date: '2019-01-02', nav: 30.34, marketPrice: 30.21, premiumDiscount: -0.13 },
      { date: '2020-01-02', nav: 37.04, marketPrice: 37.01, premiumDiscount: -0.02 },
    ]);
    expect(() => parseNorthernTrustPricing({ AS_OF_DATE: '01/02/2020' }, 'QLC')).toThrow(/not a daily list/);
    const dividends = parseNorthernTrustDistributionsCsv(DISTRIBUTIONS_CSV, 'QLC');
    expect(dividends.map((entry) => entry.exDate)).toEqual(['2026-06-18', '2026-09-18']);
    expect(dividends[0]).toEqual({ epoch: isoToEpoch('2026-06-18'), amount: 0.2215, exDate: '2026-06-18', payDate: '2026-06-25', recordDate: '2026-06-18', reinvestNav: null, type: '' });
    expect(dividends[1].amount).toBe(0.224696);
    expect(() => parseNorthernTrustDistributionsCsv('Fund Name,Price\nX,1', 'QLC')).toThrow(/header row not found/);
  });

  test('csv and number helpers: quotes, CRLF, BOM, placeholders become null, never 0', () => {
    expect(parseCsv('﻿a,"b,c","d ""e"""\r\n1,2,3\r\n\r\n')).toEqual([['a', 'b,c', 'd "e"'], ['1', '2', '3']]);
    for (const placeholder of ['--', '-', 'N/A', 'NA', '', '  ', null, undefined]) expect(numberOrNull(placeholder)).toBeNull();
    expect(numberOrNull('1,234.5')).toBe(1234.5);
    expect(numberOrNull('0')).toBe(0);
    expect(toIsoDate('09/25/2026')).toBe('2026-09-25');
    expect(toIsoDate('2026-09-25')).toBe('2026-09-25');
    expect(fractionToPercent('0.1')).toBe(10);
    expect(fractionToPercent(null)).toBeNull();
    expect(fractionToPercent('--')).toBeNull();
  });

  test('frequency decoding and download URLs', () => {
    expect(decodeDividendFrequency('MDEC')).toEqual({ frequency: 'Monthly', paymentsPerYear: 12 });
    expect(decodeDividendFrequency('Semi-annually')).toEqual({ frequency: 'Semi-annually', paymentsPerYear: 2 });
    expect(decodeDividendFrequency('DACC')).toEqual({ frequency: 'Daily', paymentsPerYear: null });
    for (const none of ['', null, 'ZZZ', 'N/A']) expect(decodeDividendFrequency(none)).toBeNull();
    const base = 'https://etfs.ntam.northerntrust.com';
    expect(northernTrustFundPageUrl('qlc')).toBe(`${base}/us/en/individual/funds/qlc`);
    expect(northernTrustAllCsvUrl('QLC')).toBe(`${base}/content/dam/ntflexshares/fund/qlc/qlc-all.csv`);
    expect(northernTrustHoldingsCsvUrl('SKOR')).toBe(`${base}/content/dam/ntflexshares/fund/skor/skor-holdings.csv`);
    expect(northernTrustDistributionsCsvUrl('TIPA')).toBe(`${base}/content/dam/ntflexshares/fund/tipa/tipa-distributions.csv`);
    expect(northernTrustPricingJsonUrl('QLC')).toBe(`${base}/content/dam/ntflexshares/fund/qlc/qlc_pricing.json`);
    expect(northernTrustEtfChartsJsonUrl('QLC')).toBe(`${base}/content/dam/ntflexshares/fund/qlc/qlc_etfcharts.json`);
  });

  test('N-PORT: positions, identifiers, net assets, NPORT-P filter, freshness guard', () => {
    const parsed = parseNport(`
      <nportRegDoc><genInfo><regName>Trust</regName><regCik>0001485894</regCik><seriesName>Fund A</seriesName><repPdDate>2026-06-30</repPdDate></genInfo>
      <fundInfo><netAssets>87850000000.00</netAssets></fundInfo>
      <invstOrSec><name>Apple Inc</name><cusip>037833100</cusip><balance>1</balance><valUSD>100.5</valUSD><pctVal>8.24</pctVal><assetCat>EC</assetCat></invstOrSec>
      <invstOrSec><title>US TREASURY 4.125% 05/15/2028</title><identifiers><cusip value="912810H80"/></identifiers><valUSD>50</valUSD><pctVal>2.5</pctVal></invstOrSec>
      <invstOrSec><name>FUND X</name><cusip>N/A</cusip><identifiers><other value="XSCUSIP1"/></identifiers><valUSD>10</valUSD></invstOrSec>
      </nportRegDoc>`);
    expect(parsed).toMatchObject({ seriesName: 'Fund A', regCik: '0001485894', repPdDate: '2026-06-30', netAssets: 87850000000 });
    expect(parsed.holdings.map((row) => row.Identifier)).toEqual(['037833100', '912810H80', 'XSCUSIP1']);
    expect(parsed.holdings[0].Ticker).toBe('-');
    expect(parsed.holdings[1].Name).toBe('US TREASURY 4.125% 05/15/2028');
    expect(parsed.totalValue).toBeCloseTo(160.5, 6);
    const empty = parseNport('<genInfo><seriesName>Empty</seriesName></genInfo>');
    expect(empty.holdings).toEqual([]);
    expect(empty.netAssets).toBeNull();
    const accessions = parseNportAccessions({
      cik: '913760',
      filings: { recent: { form: ['NPORT-P', '13F-HR', 'NPORT-P'], accessionNumber: ['0000913760-26-000111', '0000913760-26-000112', '0000913760-26-000113'], filingDate: ['2026-07-21', '2026-08-10', '2026-04-21'], reportDate: ['2026-06-30', '2026-06-30', '2026-03-31'] } },
    });
    expect(accessions.map((entry) => entry.accession)).toEqual(['0000913760-26-000111', '0000913760-26-000113']);
    expect(accessions[0].url).toBe(nportUrlFor('0000913760', '0000913760-26-000111'));
    expect(isOlderReport('2026-06-30', '2026-08-31')).toBe(true);
    expect(isOlderReport('2026-08-31', '2026-08-31')).toBe(false);
    expect(isOlderReport('2026-06-30', '')).toBe(false);
  });

  test('SEC lookups: registrant by name, ticker maps, EDGAR series Atom feed', () => {
    const hits = { hits: { hits: [
      { _source: { ciks: ['0001667919'], display_names: ['FIRST TRUST EXCHANGE-TRADED FUND VIII  (CIK 0001667919)'] } },
      { _source: { ciks: ['0001485894'], display_names: ['J.P. MORGAN EXCHANGE-TRADED FUND TRUST  (CIK 0001485894)'] } },
    ] } };
    expect(pickEftsCik(hits, 'J.P. Morgan Exchange-Traded Fund Trust')).toBe('0001485894');
    expect(pickEftsCik({ hits: [] }, 'Unknown Fund')).toBeNull();
    const tickers = parseFundTickerMap({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [[1485894, 'S000068402', 'C000218810', 'jepi'], [0, 'S0', 'C0', 'ZZZ']] });
    expect(tickers.get('JEPI')).toEqual({ cik: '0001485894', seriesId: 'S000068402', classId: 'C000218810' });
    expect(tickers.has('ZZZ')).toBe(false);
    expect(parseFundTickerMap({}).size).toBe(0);
    const names = parseCompanyTickerMap({ 0: { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA CORP' }, 1: { cik_str: 1, ticker: '', title: 'No Ticker Inc' } });
    expect(names.get(normalizeHoldingName('NVIDIA Corp'))).toBe('NVDA');
    expect(names.has(normalizeHoldingName('No Ticker Inc'))).toBe(false);
    const url = edgarSeriesFilingsUrl('S000060812', 5);
    for (const part of ['https://www.sec.gov/cgi-bin/browse-edgar?', 'CIK=S000060812', 'type=NPORT-P', 'output=atom', 'count=5']) expect(url).toContain(part);
    const atom = `<feed>
      <entry><accession-number>0001209466-26-000952</accession-number><filing-date>2026-06-29</filing-date><filing-type>NPORT-P</filing-type>
        <filing-href>https://www.sec.gov/Archives/edgar/data/1209466/000120946626000952/0001209466-26-000952-index.htm</filing-href></entry>
      <entry><accession-number>0001209466-26-000001</accession-number><filing-date>2026-01-05</filing-date><filing-type>N-CEN</filing-type></entry>
    </feed>`;
    const filings = parseEdgarAtomFilings(atom);
    expect(filings.map((entry) => entry.accession)).toEqual(['0001209466-26-000952']);
    expect(filings[0].url).toBe('https://www.sec.gov/Archives/edgar/data/1209466/000120946626000952/primary_doc.xml');
    expect(parseEdgarAtomFilings('')).toEqual([]);
  });

  test('Yahoo chart and holding names: null closes skipped, adjclose fallback, share classes stay distinct', () => {
    const start = Date.UTC(2020, 0, 2) / 1000;
    const chart = (closes: (number | null)[], adj: (number | null)[] | null, dividends: Record<string, { date: number; amount: number }> = {}) => ({
      chart: { result: [{
        meta: { fullExchangeName: 'NasdaqGS', navPrice: 706.3 },
        timestamp: closes.map((_, index) => start + index * 86_400),
        indicators: { quote: [{ close: closes, volume: closes.map(() => 1000) }], ...(adj ? { adjclose: [{ adjclose: adj }] } : {}) },
        events: { dividends },
      }] },
    });
    const parsed = parseChart(chart([100, null, 110], [90, null, 99]));
    expect(parsed.days.map((day) => day.close)).toEqual([100, 110]);
    expect(parsed.days.map((day) => day.adjClose)).toEqual([90, 99]);
    expect(parsed.navPrice).toBe(706.3);
    expect(parseChart(chart([100, 101], null)).days.map((day) => day.adjClose)).toEqual([100, 101]);
    const dividends = parseChart(chart([100], [100], {
      2: { date: Date.UTC(2026, 5, 15) / 1000, amount: 0.7 }, 1: { date: Date.UTC(2026, 2, 15) / 1000, amount: 0.65 }, 0: { date: Date.UTC(2025, 11, 15) / 1000, amount: -1 },
    })).dividends;
    expect(dividends.map((entry) => entry.amount)).toEqual([0.65, 0.7]);
    expect(() => parseChart({ chart: { result: [] } })).toThrow(/empty result/);
    expect(normalizeHoldingName('Microsoft Corp Common Stock')).toBe('MICROSOFT');
    expect(normalizeHoldingName('Alphabet Inc. Class C Capital Stock')).toBe('ALPHABET CL C');
    expect(normalizeHoldingName('Alphabet Inc Cl A')).not.toBe(normalizeHoldingName('Alphabet Inc Cl C'));
    expect(normalizeHoldingName('---')).toBe('');
    expect(cleanHoldingTicker('brk-b')).toBe('BRK-B');
    expect(cleanHoldingTicker('N/A')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Mocked provider + temp feed (shared by metrics, pipeline and network)
// ---------------------------------------------------------------------------

type MockFund = { ticker: string; young?: boolean };
const MOCK_FUNDS: MockFund[] = ['AAA', 'BBB', 'CCC'].map((ticker) => ({ ticker }));

function mockCatalogPage(funds: MockFund[]): string {
  const fundList = funds.map((fund) => {
    const entry = structuredClone(CATALOG_DOCUMENT.fundList[0]) as Record<string, any>;
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
  return `<html><body><div data-content="${escapeAttr({ fundList })}"></div></body></html>`;
}

function mockFacts(fund: MockFund): string {
  let text = FACTS_CSV.replace('TICKER,"QLC"', `TICKER,"${fund.ticker}"`).replace('CUSIP,"33939L746"', `CUSIP,"33939${fund.ticker}"`);
  if (fund.young) text = text.split('\n').map((line) => (/^"(NAV|Market Price)"/.test(line) ? line.replace(/"[-\d.]+"/g, '"--"') : line)).join('\n');
  return text;
}

function mockPricing(fund: MockFund): unknown[] {
  const rows: unknown[] = [];
  const add = (date: string, nav: number) => rows.push({ TICKER: fund.ticker, AS_OF_DATE: date, NET_ASSET_VALUE: String(nav), CLOSING_MARKET_PRICE: String(nav + 0.01), PREMIUM_DISCOUNT: '0.01' });
  if (!fund.young) for (const [i, year] of [2019, 2020, 2021, 2022, 2023, 2024, 2025].entries()) add(`01/02/${year}`, 30 + i * 3);
  for (let day = 10; day <= 25; day++) add(`09/${String(day).padStart(2, '0')}/2026`, 90 + (day - 10) * 0.1);
  return rows;
}

type MockOptions = { delayMs?: number; failAll?: string[]; failPricing?: string[]; failDistributions?: Record<string, number>; emptyPricing?: string[]; funds?: MockFund[]; yahoo?: boolean; onRequest?: () => void };

function installMockFetch(options: MockOptions = {}): { urls: string[]; peak: () => number } {
  const urls: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const funds = options.funds ?? MOCK_FUNDS;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    options.onRequest?.();
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
        if (kind === 'all') return options.failAll?.includes(fund.ticker) ? new Response('boom', { status: 500 }) : ok(mockFacts(fund));
        if (kind === 'etfcharts') return ok(JSON.stringify({ ...ETFCHARTS, Ticker: fund.ticker, FundName: `Northern Trust ${fund.ticker} ETF` }), 'application/json');
        if (kind === 'holdings') return ok(EQUITY_HOLDINGS_CSV);
        if (kind === 'pricing') {
          if (options.failPricing?.includes(fund.ticker)) return new Response('boom', { status: 500 });
          return ok(JSON.stringify(options.emptyPricing?.includes(fund.ticker) ? [] : mockPricing(fund)), 'application/json');
        }
        if (kind === 'distributions') {
          const status = options.failDistributions?.[fund.ticker];
          return status ? new Response('boom', { status }) : ok(DISTRIBUTIONS_CSV);
        }
      }
      if (/query1\.finance\.yahoo\.com/.test(url) && options.yahoo) {
        return ok(JSON.stringify({ chart: { result: [{ meta: { exchangeName: 'PCX', regularMarketPrice: 50 }, timestamp: [1780000000, 1780086400], indicators: { quote: [{ close: [50, 51], volume: [1, 2] }], adjclose: [{ adjclose: [50, 51] }] } }] } }), 'application/json');
      }
      return new Response('not found', { status: 404 });
    } finally {
      inFlight -= 1;
    }
  }) as typeof fetch;
  return { urls, peak: () => peak };
}

// REQUEST_SLEEP and CONCURRENCY are set explicitly: nothing leaks in from the environment
const pipelineControls = (extra: Record<string, string> = {}) =>
  readConfig(resolveControls({}, {}, {}, { REQUEST_SLEEP: '0', CONCURRENCY: '1', SKIP_YAHOO: 'true', EDGAR_FALLBACK: 'false', ...extra }));

async function withTempFeed<T>(run: (root: URL) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'nt-feed-'));
  setApiRootForTests(pathToFileURL(`${dir}/`));
  try {
    return await run(pathToFileURL(`${dir}/`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const readJson = async (root: URL, path: string) => JSON.parse(await Bun.file(new URL(path, root)).text());
const readIndex = async (root: URL): Promise<{ funds: Record<string, any>[]; counts: Record<string, number> }> => readJson(root, 'index.json');
const readText = (root: URL, path: string) => Bun.file(new URL(path, root)).text();

function snapshot(dir: string): Record<string, { mtime: number; text: string }> {
  const out: Record<string, { mtime: number; text: string }> = {};
  const walk = (path: string): void => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[full] = { mtime: statSync(full).mtimeMs, text: readFileSync(full, 'utf8') };
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

describe('metrics', () => {
  test('young funds: horizons the fund is too young for stay null, never invented', () => {
    const day = (date: string, adjClose: number) => ({ date, close: adjClose, adjClose, volume: 1 });
    const now = new Date(Date.UTC(2026, 7, 21));
    const young = priceReturns([day('2026-08-20', 10)], now);
    expect(young.asOfDate).toBe('2026-08-20');
    expect([young.ytd, young.yr1, young.cagr3y, young.siAnn]).toEqual([null, null, null, null]);
    expect(priceReturns([], now).asOfDate).toBe('');
    const sinceInception = (first: string, last: string, value: number) => priceReturns([day(first, 100), day(last, value)], new Date('2026-09-26T00:00:00Z')).siAnn;
    expect(sinceInception('2025-11-25', '2026-09-25', 110)).toBeNull();
    expect(sinceInception('2024-09-25', '2026-09-25', 121)).toBeCloseTo(10, 1);
    expect(annualizedSinceInception(1.9, '2026-07-30', '2026-08-31')).toBeNull();
    expect(annualizedSinceInception(1.9, '2025-08-31', '2026-08-31')).toBe(1.9);
    expect(annualizedSinceInception(null, '2020-05-20', '2026-08-31')).toBeNull();
    expect(annualizedToTotal(null, 3)).toBeNull();
    expect(annualizedToTotal(10, 0)).toBeNull();
    expect(totalToAnnualized('n/a' as any, 5)).toBeNull();
    expect(totalToAnnualized(annualizedToTotal(12.5, 5), 5)).toBeCloseTo(12.5, 1);
    expect(indicatedYield(null, 4, 10)).toBeNull();
    expect(indicatedYield(0.5, 4, 0)).toBeNull();
    expect(indicatedYield(0.65, 12, 41.72)).toBe(18.7);
  });

  test('derived returns: anchors, reinvestment coverage and quarter ends', () => {
    const days = [
      { date: '2015-01-02', close: 100, adjClose: 100, volume: 1 },
      { date: '2022-01-03', close: 200, adjClose: 195, volume: 1 },
      { date: '2023-01-03', close: 220, adjClose: 214, volume: 1 },
      { date: '2026-01-02', close: 300, adjClose: 290, volume: 1 },
      { date: '2026-07-01', close: 322, adjClose: 312, volume: 1 },
      { date: '2026-08-21', close: 340, adjClose: 330, volume: 1 },
    ];
    const now = new Date(Date.UTC(2026, 7, 21));
    const returns = priceReturns(days, now);
    expect(returns.asOfDate).toBe('2026-08-21');
    expect(returns.ytd).toBeCloseTo(54.21, 2);
    expect(returns.cagr3y).toBeCloseTo(15.53, 2);
    expect(returns.mo1).toBeCloseTo(5.77, 2);
    const covered = priceReturns(days, now, '2026-06-29');
    expect([covered.siAnn, covered.ytd, covered.yr1, covered.cagr3y]).toEqual([null, null, null, null]);
    expect(covered.qtd).toBeCloseTo(((330 - 312) / 312) * 100, 2);
    expect(priceReturns(days, now, '2015-01-02')).toEqual(returns);
    const iso = (date: Date) => date.toISOString().slice(0, 10);
    expect(iso(lastCompletedQuarterEnd(new Date(Date.UTC(2026, 7, 21))))).toBe('2026-06-30');
    expect(iso(lastCompletedQuarterEnd(new Date(Date.UTC(2026, 0, 15))))).toBe('2025-12-31');

    const points = [navPoint('2025-12-10', 100.06), navPoint('2026-09-18', 100.11)];
    expect(DIVIDEND_SCHEDULE_CAP).toBe(12);
    expect(reinvestmentCoverageStart(points, [dividend('2026-05-01')])).toBe('2025-12-10');
    const weekly = ['07-06', '07-10', '07-17', '07-24', '07-31', '08-07', '08-14', '08-21', '08-28', '09-04', '09-11', '09-18'].map((md) => dividend(`2026-${md}`));
    expect(reinvestmentCoverageStart(points, weekly)).toBe('2026-06-29');
    expect(reinvestmentCoverageStart([], weekly)).toBeNull();
    const monthly = Array.from({ length: 12 }, (_, i) => dividend(`2026-${String(i + 1).padStart(2, '0')}-01`));
    expect(reinvestmentCoverageStart([navPoint('2026-06-15', 50), points[1]], monthly)).toBe('2026-06-15');

    const reinvested = navTotalReturnDays([navPoint('2026-08-29', 56.3), navPoint('2026-09-01', 55.9), navPoint('2026-09-17', 56.4101)], [dividend('2026-09-01', 0.37421, 55.9)]);
    const factor = 1 + 0.37421 / 55.9;
    expect(reinvested[0].adjClose).toBe(56.3);
    expect(reinvested[1].adjClose).toBeCloseTo(55.9 * factor, 6);
    expect(reinvested[2].adjClose).toBeCloseTo(56.4101 * factor, 6);
    const exNav = navTotalReturnDays([navPoint('2026-09-01', 50), navPoint('2026-09-02', 51)], [dividend('2026-08-01', 1), dividend('2026-09-01', 0.5)]);
    expect(exNav[0].adjClose).toBeCloseTo(50.5, 6);
    expect(navTotalReturnDays([], [dividend('2026-09-01')])).toEqual([]);

    expect(inferDistributionFrequency([0, 1, 2, 3].map((i) => ({ epoch: Date.UTC(2026, i * 3, 15) / 1000, amount: 1 }))).frequency).toBe('Quarterly');
    expect(inferDistributionFrequency(Array.from({ length: 6 }, (_, i) => ({ epoch: Date.UTC(2026, i, 15) / 1000, amount: 1 })))).toEqual({ frequency: 'Monthly', paymentsPerYear: 12 });
    expect(inferDistributionFrequency([])).toEqual({ frequency: 'None', paymentsPerYear: null });
  });

  test('returnsBasis and performanceAsOf travel together; null, never 0', () => {
    const keys = ['ytd', 'tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr5y', 'cagr10y', 'siAnn', 'dividendYield', 'dividendYieldText', 'dividendYieldBasis', 'secYield', 'secYieldText', 'returnsBasis', 'performanceAsOf'];
    expect(Object.keys(emptyMetrics())).toEqual(keys);
    expect(Object.values(emptyMetrics()).includes(0)).toBe(false);
    expect(emptyMetrics().returnsBasis).toBeTruthy();

    const official = deriveCatalogMetrics(
      { ytd: 15.97, yr1: 18.34, yr3: 20.15, yr5: 17.42, yr10: 16.88, sinceInception: 19.44 },
      derivedReturns({ asOfDate: '2026-08-21', ytd: 13.79, yr1: 54.21, cagr3y: 18.99, siAnn: 10, mo1: 1, qtd: 2 }),
      0.44, null, null, null, 706.32, null, '2026-08-31',
    );
    expect(official).toMatchObject({ ytd: 15.97, tr1y: 18.34, cagr3y: 20.15, dividendYield: 0.44, secYield: null, performanceAsOf: '2026-08-31' });
    expect(official.tr3y).toBe(annualizedToTotal(20.15, 3));
    expect(official.returnsBasis).toContain('official Northern Trust NAV total returns');
    expect(Object.keys(official).slice(-2)).toEqual(['returnsBasis', 'performanceAsOf']);

    const filled = deriveCatalogMetrics({ ...NO_RETURNS, ytd: 1, yr1: 2 }, derivedReturns({ ytd: 9, yr1: 9, cagr3y: 5 }), null, null, null, null, null, null, '2026-08-31');
    expect(filled.cagr3y).toBe(5);
    expect(filled.returnsBasis).toContain('missing figure filled');
    expect(filled.performanceAsOf).toBe('2026-08-31');

    // official returns without a table date: never fall back to the NAV date
    expect(deriveCatalogMetrics({ ...NO_RETURNS, ytd: 1 }, derivedReturns(), null, null, null, null, null).performanceAsOf).toBeNull();
    // no return figure at all: no date either
    const none = deriveCatalogMetrics(NO_RETURNS, derivedReturns({ mo1: 0.5, qtd: 0.4 }), null, null, null, null, null);
    expect(none.performanceAsOf).toBeNull();
    expect(none.returnsBasis).toBeTruthy();
    expect(none.ytd).toBeNull();

    const derived = deriveCatalogMetrics(NO_RETURNS, derivedReturns({ ytd: 13.79, yr1: 54.21, cagr3y: 18.99 }), null, null, 0.65, 12, 41.72);
    expect(derived).toMatchObject({ ytd: 13.79, tr1y: 54.21, cagr5y: null, dividendYield: 18.7, dividendYieldText: '18.70%', performanceAsOf: '2026-09-25' });
    expect(derived.returnsBasis).toContain('not official NAV returns');

    const cumulative = deriveCatalogMetrics(
      { ytd: 5.36, yr1: 9.05, yr3: 9.51, yr5: 10.02, yr10: null, sinceInception: 11.25 },
      derivedReturns({ ytd: 3.7, yr1: 9, cagr3y: 9.4 }), 8.42, 7.59, 0.37421, 12, 56.24,
      { yr1: 9.05, yr3: 31.33, yr5: 61.17, yr10: null, sinceInception: 95.24 },
    );
    expect([cumulative.tr3y, cumulative.tr5y, cumulative.tr10y, cumulative.secYield, cumulative.secYieldText]).toEqual([31.33, 61.17, null, 7.59, '7.59%']);

    const backfilled = ensureMetricsContract({ metrics: { ytd: 1, returnsBasis: 'official Northern Trust NAV total returns (x)', secYield: 2 }, returns: { monthEnd: { asOfDate: 'Aug 31 2026' } } }).metrics as Record<string, unknown>;
    expect(backfilled.performanceAsOf).toBe('2026-08-31');
    expect(Object.keys(backfilled)).toEqual(['ytd', 'secYield', 'returnsBasis', 'performanceAsOf']);
    const unknown = ensureMetricsContract({ metrics: { returnsBasis: '-' } }).metrics as Record<string, unknown>;
    expect(unknown.returnsBasis).not.toBe('-');
    expect(unknown.performanceAsOf).toBeNull();
    const noReturns = ensureMetricsContract({ metrics: { returnsBasis: 'derived from the daily NAV history (old text)', performanceAsOf: '2026-09-25' } }, '2026-09-25').metrics as Record<string, unknown>;
    expect(noReturns.performanceAsOf).toBeNull();
    expect(labelToIsoDate('Feb 30 2026')).toBeNull();
  });

  test('dividendYieldBasis: a code per yield source, null exactly when the yield is null', () => {
    const basis = (published: number | null, latest: number | null, retained: any = null) =>
      deriveCatalogMetrics(NO_RETURNS, derivedReturns(), published, null, latest, 12, 41.72, null, null, retained);
    // official CSV yield
    expect(basis(0.95, null, 'official-trailing-12m')).toMatchObject({ dividendYield: 0.95, dividendYieldBasis: 'official-trailing-12m' });
    // no published yield: indicated from the latest distribution
    expect(basis(null, 0.65)).toMatchObject({ dividendYield: 18.7, dividendYieldBasis: 'indicated' });
    // a retained indicated yield keeps its code, never the official one
    expect(basis(18.7, null, 'indicated').dividendYieldBasis).toBe('indicated');
    // published yield without a known code: provider-published, definition unknown
    expect(basis(1.2, null).dividendYieldBasis).toBe('official-other');
    // no yield: null code
    expect(basis(null, null)).toMatchObject({ dividendYield: null, dividendYieldBasis: null });
    expect(basis(null, null, 'official-trailing-12m').dividendYieldBasis).toBeNull();
    // stored kind text -> code
    expect(yieldBasisFromKind('12-month dividend yield (official Northern Trust full-data CSV), as of Sep 25 2026')).toBe('official-trailing-12m');
    expect(yieldBasisFromKind('indicated (latest distribution x payments per year / market price)')).toBe('indicated');
    expect(yieldBasisFromKind('not published: no distributions yet')).toBeNull();
    // legacy metrics without a code get one from the kind, or null with a null yield
    const meta = { yields: { dividendYieldKind: 'indicated (latest distribution x payments per year / market price)' } };
    expect(withYieldBasis({ dividendYield: 3 }, meta).dividendYieldBasis).toBe('indicated');
    expect(withYieldBasis({ dividendYield: null, dividendYieldBasis: 'indicated' }).dividendYieldBasis).toBeNull();
    expect(withYieldBasis({ dividendYield: 3, dividendYieldBasis: 'bogus' }).dividendYieldBasis).toBe('official-other');
  });

  test('every index row has the same metrics key set; TER is net with gross beside it; dates stay honest', async () => {
    installMockFetch({ funds: [{ ticker: 'AAA' }, { ticker: 'BBB' }, { ticker: 'CCC', young: true }] });
    await withTempFeed(async (root) => {
      await runUpdater(pipelineControls());
      const { funds } = await readIndex(root);
      expect(funds.map((fund) => fund.ticker)).toEqual(['AAA', 'BBB', 'CCC']);
      for (const fund of funds) {
        expect(Object.keys(fund.metrics)).toEqual(Object.keys(emptyMetrics()));
        expect(Object.values(fund.metrics).includes(0)).toBe(false);
        expect(fund.metrics.returnsBasis).toBeTruthy();
      }
      const [seasoned, , young] = funds;
      // the mock CSV publishes a 12-month yield for every fund: official code, never null next to a yield
      for (const fund of funds) expect([fund.metrics.dividendYield !== null, fund.metrics.dividendYieldBasis]).toEqual([true, 'official-trailing-12m']);
      expect([seasoned.terValue, seasoned.terGrossValue, seasoned.ter]).toEqual([0.25, 0.26, '0.25%']);
      const meta = await readJson(root, 'funds/AAA/meta.json');
      expect(meta.expenseRatio).toMatchObject({ value: 0.25, gross: 0.26, net: 0.25 });
      // official month-end table keeps its own date, the later price-return date is reported separately
      expect(seasoned.returns.monthEnd).toMatchObject({ asOfDate: 'Aug 31 2026', priceReturnsAsOf: 'Sep 25 2026' });
      expect(seasoned.metrics.performanceAsOf).toBe('2026-08-31');
      expect(seasoned.metrics.ytd).toBe(14.5);
      // a fund too young for any return: null figures, no performanceAsOf
      expect(young.metrics.ytd).toBeNull();
      expect(young.metrics.tr1y).toBeNull();
      expect(young.metrics.performanceAsOf).toBeNull();
      expect(young.returns.monthEnd.priceReturnsAsOf).toBe('Sep 25 2026');
    });
  });
});

// ---------------------------------------------------------------------------
// pipeline (mocked fetch, temporary api root, no network)
// ---------------------------------------------------------------------------

describe('pipeline', () => {
  test('a one-ticker run keeps every published row; an unknown ticker keeps them too', async () => {
    installMockFetch();
    await withTempFeed(async (root) => {
      await runUpdater(pipelineControls());
      expect((await readIndex(root)).funds.length).toBe(3);
      const mock = installMockFetch();
      await runUpdater(pipelineControls({ TICKERS: 'CCC' }));
      const index = await readIndex(root);
      expect(index.funds.map((fund) => fund.ticker)).toEqual(['AAA', 'BBB', 'CCC']);
      expect(index.counts.funds).toBe(3);
      expect(mock.urls.some((url) => url.includes('/ccc/'))).toBe(true);
      expect(mock.urls.some((url) => url.includes('/aaa/'))).toBe(false);
      expect(readdirSync(fileURLToPath(new URL('funds/', root))).sort()).toEqual(['AAA', 'BBB', 'CCC']);
      // an unknown ticker selects nothing and must not shrink the feed
      await runUpdater(pipelineControls({ TICKERS: 'NOPE' }));
      expect((await readIndex(root)).funds.map((fund) => fund.ticker)).toEqual(['AAA', 'BBB', 'CCC']);
    });
  });

  test('a second identical run writes nothing: same bytes, same mtimes, no temp files', async () => {
    installMockFetch();
    await withTempFeed(async (root) => {
      await runUpdater(pipelineControls());
      const dir = fileURLToPath(root);
      const first = snapshot(dir);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await runUpdater(pipelineControls());
      expect(snapshot(dir)).toEqual(first);
      expect(Object.keys(first).some((name) => name.endsWith('.tmp'))).toBe(false);
    });
  });

  test('a failed source keeps the fund exactly as published', async () => {
    installMockFetch();
    await withTempFeed(async (root) => {
      await runUpdater(pipelineControls());
      const before = { meta: await readText(root, 'funds/BBB/meta.json'), row: (await readIndex(root)).funds[1] };
      installMockFetch({ failAll: ['BBB'] });
      await runUpdater(pipelineControls({ MAX_RETRIES: '1' }));
      expect(await readText(root, 'funds/BBB/meta.json')).toBe(before.meta);
      expect((await readIndex(root)).funds[1]).toEqual(before.row);

      // pricing or distributions failing (500) keeps the fund; a missing distributions file (404) is an honest none
      const ccc = await readText(root, 'funds/CCC/meta.json');
      for (const failing of [{ failPricing: ['CCC'] }, { failDistributions: { CCC: 500 } }]) {
        installMockFetch(failing);
        await expect(runUpdater(pipelineControls({ TICKERS: 'CCC', MAX_RETRIES: '1' }))).rejects.toThrow(/every examined fund failed/);
        expect(await readText(root, 'funds/CCC/meta.json')).toBe(ccc);
      }
      installMockFetch({ failDistributions: { CCC: 404 } });
      await runUpdater(pipelineControls({ TICKERS: 'CCC' }));
      expect((await readJson(root, 'funds/CCC/meta.json')).ticker).toBe('CCC');

      // nothing fresh anywhere: the run fails instead of exiting green and the index stays whole
      globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
      await expect(runUpdater(pipelineControls())).rejects.toThrow(/every examined fund failed/);
      expect((await readIndex(root)).funds.length).toBe(3);
    });
  });

  test('an official NAV history is never replaced by the Yahoo schema', async () => {
    installMockFetch();
    await withTempFeed(async (root) => {
      await runUpdater(pipelineControls());
      const headers = (await readJson(root, 'funds/AAA/history/001.json')).headers;
      expect(headers).toContain('NAV');
      installMockFetch({ emptyPricing: ['AAA'], yahoo: true });
      await runUpdater(pipelineControls({ SKIP_YAHOO: 'false', TICKERS: 'AAA' }));
      expect((await readJson(root, 'funds/AAA/history/001.json')).headers).toEqual(headers);
      expect((await readJson(root, 'funds/AAA/meta.json')).history.source).toBe('previous run');
    });
  });

  test('a lost index row is rebuilt from meta.json; a row without meta has dataFile null and full metrics', async () => {
    installMockFetch();
    await withTempFeed(async (root) => {
      await runUpdater(pipelineControls());
      const index = await readIndex(root);
      // BBB is a legacy row without the code: kept rows get it back from the stored meta kind
      const legacy = index.funds.map((fund) => (fund.ticker === 'BBB' ? { ...fund, metrics: Object.fromEntries(Object.entries(fund.metrics).filter(([key]) => key !== 'dividendYieldBasis')) } : fund));
      const trimmed = { ...index, funds: legacy.filter((fund) => fund.ticker !== 'CCC').concat([{ ticker: 'ZZZ', name: 'Ghost' }]) };
      await writeFile(new URL('index.json', root), JSON.stringify(trimmed), 'utf8');
      installMockFetch();
      await runUpdater(pipelineControls({ TICKERS: 'AAA' }));
      const after = await readIndex(root);
      expect(after.funds.map((fund) => fund.ticker)).toEqual(['AAA', 'BBB', 'CCC', 'ZZZ']);
      const rebuilt = after.funds.find((fund) => fund.ticker === 'CCC')!;
      expect(rebuilt.dataFile).toBe('./funds/CCC/meta.json');
      expect(rebuilt.metrics.ytd).toBe(14.5);
      expect(rebuilt.metrics.dividendYieldBasis).toBe('official-trailing-12m');
      expect(after.funds.find((fund) => fund.ticker === 'BBB')!.metrics.dividendYieldBasis).toBe('official-trailing-12m');
      expect(rebuilt.holdings).toBeGreaterThan(0);
      const ghost = after.funds.find((fund) => fund.ticker === 'ZZZ')!;
      expect(ghost.dataFile).toBeNull();
      expect(Object.keys(ghost.metrics)).toEqual(Object.keys(emptyMetrics()));
      expect(ghost.metrics.returnsBasis).toBeTruthy();
      expect(ghost.metrics.dividendYieldBasis).toBeNull();
      // the offline rebuild equals the row the updater wrote
      const written = after.funds[0];
      const again = indexRowFromMeta(await readJson(root, 'funds/AAA/meta.json'));
      expect(again.metrics).toEqual(written.metrics);
      for (const key of ['ticker', 'name', 'cusip', 'ter', 'terValue', 'terGrossValue', 'navValue', 'aumValue', 'holdings', 'history', 'dataFile', 'asOfDate', 'inceptionDate']) {
        expect(again[key]).toEqual(written[key]);
      }
    });
  });

  test('MAX_FETCHES batches resume with a wrapping cursor that a different filter set ignores', async () => {
    installMockFetch();
    await withTempFeed(async (root) => {
      const cursors: string[] = [];
      for (let run = 0; run < 4; run++) {
        await runUpdater(pipelineControls({ MAX_FETCHES: '1' }));
        cursors.push((await readJson(root, 'update-state.json')).cursor);
      }
      expect(cursors).toEqual(['AAA', 'BBB', 'CCC', 'AAA']);
      await runUpdater(pipelineControls({ MAX_FETCHES: '1', TICKERS: 'CCC' }));
      expect((await readJson(root, 'update-state.json')).cursor).toBe('CCC');
      expect((await readIndex(root)).funds.length).toBe(3);
    });
  });

  test('filters are working: SEC_YIELD out of range fetches no fund data and keeps all rows', async () => {
    await withTempFeed(async (root) => {
      installMockFetch();
      await runUpdater(pipelineControls());
      const mock = installMockFetch();
      await runUpdater(pipelineControls({ SEC_YIELD: '20:' }));
      expect(mock.urls.some((url) => /-all\.csv|_pricing\.json/.test(url))).toBe(false);
      expect((await readIndex(root)).funds.length).toBe(3);
    });
  });

  test('the soft deadline stops taking funds, still writes the full index and resumes where it stopped', async () => {
    // a fake clock that advances 1 s per request: deterministic, no real waiting
    let clock = realNow();
    Date.now = () => clock;
    installMockFetch({ onRequest: () => { clock += 1000; } });
    await withTempFeed(async (root) => {
      await runUpdater(pipelineControls());
      configureFetchForTests({ deadlineMs: 3000 });
      await runUpdater(pipelineControls());
      const state = await readJson(root, 'update-state.json');
      expect(state.partial).toBe(true);
      expect(state.cursor).not.toBeNull();
      expect(state.cursor).not.toBe('CCC');
      expect((await readIndex(root)).funds.length).toBe(3);
      configureFetchForTests({ deadlineMs: 25 * 60_000 });
      await runUpdater(pipelineControls());
      expect(await readJson(root, 'update-state.json')).toMatchObject({ partial: false, cursor: null });
    });
  });
});

// ---------------------------------------------------------------------------
// network
// ---------------------------------------------------------------------------

describe('network', () => {
  test('a hanging request times out, is retried a bounded number of times, then fails', async () => {
    configureFetchForTests({ timeoutMs: 50 });
    let calls = 0;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls += 1;
      const signal = init?.signal;
      if (!signal) { await new Promise((resolve) => setTimeout(resolve, 200)); return new Response('late', { status: 200 }); } // no timeout signal: the request would succeed late
      return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }) as typeof fetch;
    await expect(fetchWithRetry('https://example.test/x', 't', {}, 1)).rejects.toThrow(/network error/);
    expect(calls).toBe(2);
    // a plain 404 is final: one attempt, no retries
    calls = 0;
    globalThis.fetch = (async () => { calls += 1; return new Response('', { status: 404 }); }) as typeof fetch;
    await expect(fetchWithRetry('https://example.test/x', 't', {}, 5)).rejects.toThrow(/HTTP 404/);
    expect(calls).toBe(1);
  });

  test('pacing reserves lane slots up front: 6 simultaneous requests on 2 lanes wait 0,0,S,S,2S,2S', async () => {
    // fake clock and timer: the requested waits are exact, nothing really sleeps
    const waits: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    Date.now = () => 1_000_000;
    (globalThis as any).setTimeout = (callback: () => void, ms: number) => { waits.push(ms); return realSetTimeout(callback, 0); };
    try {
      configureFetchForTests({ sleepMs: 200, lanes: 2 });
      await Promise.all([0, 1, 2, 3, 4, 5].map(() => paceRequests()));
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(waits.sort((a, b) => a - b)).toEqual([200, 200, 400, 400]);
  });

  test('CONCURRENCY runs funds in parallel: peak in-flight 1 at c=1, N at c=N', async () => {
    for (const [concurrency, expected] of [[1, 1], [3, 3]] as const) {
      const mock = installMockFetch({ delayMs: 15 });
      await withTempFeed(async () => {
        await runUpdater(pipelineControls({ CONCURRENCY: String(concurrency) }));
      });
      expect(mock.peak()).toBe(expected);
    }
  });

  test('HISTORY_RANGE shrinks the Yahoo request: explicit period1/period2, never range=', () => {
    const now = Date.UTC(2026, 8, 25);
    const max = new URL(chartUrl('QLC', { historyRange: 'max' }, now));
    const five = new URL(chartUrl('QLC', { historyRange: '5y' }, now));
    expect(max.searchParams.get('period1')).toBe('0');
    expect(Number(five.searchParams.get('period1'))).toBe(Math.floor(now / 1000 - 5 * 365.25 * 86_400));
    expect(five.searchParams.get('period2')).toBe(String(Math.floor(now / 1000)));
    expect(five.searchParams.has('range')).toBe(false);
  });

  test('USE_SYSTEM_CA: certificate errors restart once, only in auto mode', async () => {
    expect(isCertError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
    expect(isCertError(new Error('fetch failed', { cause: new Error('unable to get local issuer certificate') }))).toBe(true);
    expect(isCertError({ code: 'ECONNRESET' })).toBe(false);
    expect(isCertError(null)).toBe(false);
    let restarts = 0;
    const reexec = (() => { restarts++; return undefined as never; }) as () => never;
    const original = globalThis.fetch;
    installSystemCa('false', reexec, false);
    expect(globalThis.fetch).toBe(original);
    installSystemCa('true', reexec, false);
    expect(restarts).toBe(1);
    globalThis.fetch = original;
    let next: () => Promise<Response> = async () => new Response('ok');
    const stub = (async () => next()) as unknown as typeof fetch;
    globalThis.fetch = stub;
    installSystemCa('auto', reexec, false);
    expect(globalThis.fetch).not.toBe(stub);
    expect(await (await globalThis.fetch('https://example.invalid/')).text()).toBe('ok');
    next = async () => { throw new Error('ECONNRESET'); };
    await expect(globalThis.fetch('https://example.invalid/')).rejects.toThrow('ECONNRESET');
    expect(restarts).toBe(1);
    const realError = console.error;
    console.error = () => {};
    try {
      next = async () => { throw new Error('fetch failed', { cause: { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' } }); };
      await globalThis.fetch('https://example.invalid/');
    } finally {
      console.error = realError;
    }
    expect(restarts).toBe(2);
  });
});
