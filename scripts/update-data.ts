#!/usr/bin/env bun
// Bun provides Node-compatible fs/promises and process globals for this script.
/// <reference types="bun" />
import { appendFile, mkdir, readFile, readdir, rm, rename, writeFile, readFile as outputReadFile, readdir as outputReadDir } from 'node:fs/promises';
import { createHash as outputCreateHash } from 'node:crypto';
import { join as outputJoin } from 'node:path';
import { fileURLToPath as outputFileURLToPath } from 'node:url';

// Console presentation; no changes to provider requests or persisted data.
/** Presentation only: no requests, writes, filtering, or changes to updater state. */

const outputClean = (value: unknown): string => String(value ?? 'null').replace(/[\r\n\t]+/g, ' ');
/** Presentation only: per-fund retry and fallback notices are printed when VERBOSE is enabled. */
const outputVerbose = (): boolean => /^(1|true|yes|on)$/i.test((globalThis as any).process?.env?.VERBOSE ?? '');
function outputNote(message: string): void { if (outputVerbose()) console.warn(message); }
/** Names are the canonical environment knobs, not internal parser properties. */
function outputConfigEntries(config: Record<string, any>): [string, string][] {
  const values = new Map<string, string>();
  const aliases: Record<string, string> = {
    requestSleepSeconds: 'REQUEST_SLEEP', categories: 'CATEGORY',
    aumRange: 'AUM', terRange: 'TER', dividendYieldRange: 'DIVIDEND_YIELD', secYieldRange: 'SEC_YIELD',
    performanceRanges: 'PERFORMANCE', totalReturnRanges: 'TOTAL_RETURN',
    skipVanEck: 'SKIP_VANECK', skipProShares: 'SKIP_PROSHARES',
    skipWisdomTree: 'SKIP_WISDOMTREE', skipGoldmanSachs: 'SKIP_GOLDMANSACHS',
    skipGlobalX: 'SKIP_GLOBALX', skipNorthernTrust: 'SKIP_NORTHERNTRUST',
  };
  const range = (v: any): string => typeof v === 'string' ? v : v?.source ?? `${Number.isFinite(v?.min) ? v.min : ''}:${Number.isFinite(v?.max) ? v.max : ''}`;
  for (const [key, value] of Object.entries(config)) {
    if (['proxyGapMs', 'fetchTimeoutMs', 'retryDelayMs'].includes(key)) continue;
    const name = aliases[key] ?? (/^[A-Z0-9_]+$/.test(key) ? key : key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase());
    if (name === 'PERFORMANCE' || name === 'TOTAL_RETURN') {
      for (const period of ['YTD', '1Y', '3Y', '5Y', '10Y']) values.set(`${name}_${period}`, range(value?.[period]));
    } else if (['AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD'].includes(name)) {
      values.set(name, range(value));
    } else {
      values.set(name, value instanceof Set ? [...value].join(',') || 'all' : Array.isArray(value) ? value.join(',') || 'all' : outputClean(value));
    }
  }
  const first = ['MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY'];
  return [...values].sort(([a], [b]) => {
    const ai = first.indexOf(a), bi = first.indexOf(b);
    return (ai < 0 ? first.length : ai) - (bi < 0 ? first.length : bi) || a.localeCompare(b);
  });
}
function outputConfigValue(key: string, value: string): string {
  if (/TOKEN|PASSWORD|SECRET|COOKIE|SEC_UA/i.test(key)) return '<redacted>';
  if (key === 'TICKERS' && ['', 'null', 'undefined'].includes(value)) return 'all';
  return outputClean(value);
}
function outputPrintConfig(brand: string, config: Record<string, any>): void {
  const entries: [string, string][] = [...outputConfigEntries(config), ['VERBOSE', String(outputVerbose())]];
  console.log(`[ config   ] ${brand} updater:\n${entries.map(([key, value]) => `              ${key}=${outputConfigValue(key, value)}`).join('\n')}`);
}
function outputHasOutputFilters(config: Record<string, any>): boolean {
  return outputConfigEntries(config).some(([name, value]) =>
    /^(CATEGORY|AUM|TER|DIVIDEND_YIELD|SEC_YIELD|PERFORMANCE_|TOTAL_RETURN_)/.test(name) &&
    !['', ':', 'null', 'all'].includes(value));
}
function outputPrintFilter(selected: number, total: number, deferred = false): void {
  console.log(`[ filter   ] ${selected} of ${total} funds ${deferred ? 'selected for evaluation (data-dependent filters applied per fund)' : 'pass filters'}`);
}
function outputStable(value: any): any {
  if (Array.isArray(value)) return value.map(outputStable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => !['generatedAt', 'catalogReadAt'].includes(key)).map(key => [key, outputStable(value[key])]));
  return value;
}
function outputContentKey(value: unknown): string { return JSON.stringify(outputStable(value)) ?? 'null'; }
async function outputInspectFund(root: URL | string, ticker: string): Promise<{ digest: string; meta: any }> {
  const dir = outputJoin(root instanceof URL ? outputFileURLToPath(root) : root, 'funds', ticker);
  const hash = outputCreateHash('sha256');
  async function visit(path: string): Promise<void> {
    const entries = await outputReadDir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) await visit(outputJoin(path, entry.name));
      else if (entry.name.endsWith('.json')) {
        const text = await outputReadFile(outputJoin(path, entry.name), 'utf8').catch(() => '');
        hash.update(outputJoin(path.slice(dir.length), entry.name));
        try { hash.update(outputContentKey(JSON.parse(text))); } catch { hash.update(text); }
      }
    }
  }
  await visit(dir);
  const meta = await outputReadFile(outputJoin(dir, 'meta.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  return { digest: hash.digest('hex'), meta };
}
const outputCount = (value: any): unknown => typeof value === 'number' ? value : Array.isArray(value) ? value.length : value?.totalRows ?? value?.rows?.length ?? null;
const outputScalar = (value: any): any => value && typeof value === 'object' ? value.display ?? value.value ?? null : value;
const outputUnits: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, THOUSAND: 1e3, MILLION: 1e6, BILLION: 1e9, TRILLION: 1e12 };
function outputMoney(value: any): string {
  const raw = value && typeof value === 'object' && typeof value.value === 'number' && Number.isFinite(value.value) ? value.value : outputScalar(value);
  if (raw === null || raw === undefined || raw === '—' || raw === '--') return 'null';
  const text = String(raw).replace(/[$,\s]/g, '');
  const match = text.match(/^([+-]?[\d.]+)(K|M|B|T|Thousand|Million|Billion|Trillion)?$/i);
  if (!match) return outputClean(raw);
  const number = Number(match[1]) * (outputUnits[match[2]?.toUpperCase() ?? ''] ?? 1);
  if (!Number.isFinite(number)) return 'null';
  for (const [unit, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${unit}`;
  }
  return `$${number.toFixed(2)}`;
}
/** Yields: rounded to 2 decimals without trailing zeros; placeholders are omitted like null. */
function outputPercent(value: any): unknown {
  const raw = outputScalar(value);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Number(raw.toFixed(2)) : null;
  const text = String(raw).trim().replace(/%$/, '').trim();
  if (['', '-', '—', '--', 'n/a'].includes(text.toLowerCase())) return null;
  const number = Number(text.replace(/,/g, ''));
  return Number.isFinite(number) ? Number(number.toFixed(2)) : outputClean(raw);
}
function outputFundLine(index: number, total: number, ticker: string, status: string, data: any = {}, reason?: unknown): string {
  const width = Math.max(2, String(total).length);
  const metrics = data.metrics ?? {};
  // Presentation only. Keep valid zero/false values; omit unavailable fields.
  // outputMoney returns the string 'null' for an unavailable monetary value.
  const field = (key: string, value: unknown): string =>
    value === null || value === undefined || value === 'null' ? '' : `${key}=${outputClean(value)}`;
  const sources = [
    field('official', data.officialHistoryCount),
    field('yahoo', data.yahooHistoryCount),
  ].filter(part => part !== '').join(' ');
  const detail = [
    field('port', data.portId ?? data.portfolioId),
    field('history', outputCount(data.history ?? data.historyCount)),
    sources ? `(${sources})` : '',
    field('holdings', outputCount(data.holdings ?? data.holdingsCount)),
    field('divs', outputCount(data.worksheets?.Distributions ?? data.distributions)),
    field('netAssets', outputMoney(data.netAssets ?? data.aum)),
    field('total', outputMoney(data.totalFundNetAssets ?? data.totalNetAssets)),
    field('div', outputPercent(data.trailingYield ?? data.yields?.effectiveYield ?? data.yields?.dividendYield ?? data.dividendYield ?? metrics.dividendYield)),
    field('sec', outputPercent(data.secYield ?? data.yields?.secYield ?? metrics.secYield)),
    field('wp', data.workplaceRaw),
  ].filter(part => part !== '').join(' ');
  return `[ ${`${String(index).padStart(width)}/${total}`.padEnd(8)} ] ${outputClean(ticker).padEnd(5)} ${status.padEnd(9)}${detail ? ` ${detail}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}
function outputCreateReporter(root: URL | string, total: number) {
  let completed = 0;
  const tally = new Map<string, number>();
  return {
    before: (ticker: string) => outputInspectFund(root, ticker),
    async result(ticker: string, before: { digest: string }, status?: string, reason?: unknown, extra: any = {}) {
      const after = await outputInspectFund(root, ticker);
      const final = status ?? (before.digest === after.digest ? 'unchanged' : 'updated');
      tally.set(final, (tally.get(final) ?? 0) + 1);
      console.log(outputFundLine(++completed, total, ticker, final, { ...after.meta, ...extra }, reason));
    },
    /** First [ done ] line: the statuses of every fund line this reporter printed. */
    summary(startedAt: number): string {
      const order = ['updated', 'unchanged', 'kept', 'skipped', 'failed'];
      const statuses = [...order, ...[...tally.keys()].filter(status => !order.includes(status))];
      return `[ done     ] ${completed} fund${completed === 1 ? '' : 's'}: ${statuses.map(status => `${tally.get(status) ?? 0} ${status}`).join(', ')} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    },
  };
}
/** Second [ done ] line: published totals. */
function outputCounts(funds: number, holdings: number, history: number): string {
  return `[ done     ] counts: ${funds.toLocaleString('en-US')} funds / ${holdings.toLocaleString('en-US')} holdings rows / ${history.toLocaleString('en-US')} history rows`;
}


// Northern Trust (US ETFs) static data updater.
//
// Fetches the public Northern Trust ETF catalog (the funds-list JSON embedded
// in etfs.ntam.northerntrust.com/us/en/individual/funds), the per-fund
// full-data CSV (fund facts, expenses, yields, official month/quarter-end
// returns), the per-fund daily holdings CSV, the per-fund daily pricing JSON
// (NAV / market price / premium-discount since inception) and the per-fund
// distributions CSV, then writes a deterministic, paginated static JSON API
// under ./api/northerntrust — the same design as the daggerok/JPMorgan,
// daggerok/Invesco, daggerok/SPDR, daggerok/Fidelity and daggerok/WisdomTree
// updaters (zero dependencies, Bun only: node:fs/promises + fetch).
//
// Data sources
//   - catalog + fund metrics  : funds-list page data-content JSON (every
//     listed Northern Trust ETF: ticker, name, asset class, investment
//     objective, inception, market price, expenses, official month-end and
//     quarter-end NAV / market-price returns)
//   - per-fund facts + returns : <ticker>-all.csv (gross/net expense ratio,
//     exchange, CUSIP, NAV, market price, premium/discount, net assets,
//     12-month dividend yield, SEC subsidized/unsubsidized yields, published
//     distribution frequency, month/quarter-end NAV + market-price returns)
//   - per-fund asset type      : <ticker>_etfcharts.json ("AssetType")
//   - per-fund holdings        : <ticker>-holdings.csv (daily full holdings
//     with CUSIP/ISIN/SEDOL identifiers, weight, market value, shares, coupon,
//     maturity, sector, country)
//   - per-fund daily history   : <ticker>_pricing.json (daily NAV, market price
//     and premium/discount since inception)
//   - per-fund distributions   : <ticker>-distributions.csv (ex/record/payable
//     dates, income, gains, return of capital, totals)
//   - holdings fallback        : SEC EDGAR Form N-PORT-P (FlexShares Trust CIK
//     0001491978, Northern Funds CIK 0000916620 — the two registrants behind
//     the Northern Trust ETF line-up)
//   - history fallback         : Yahoo Finance public chart API (used only when
//     the official history is unavailable; Yahoo throttles data-center IPs)
//
// Filters, pagination, idempotent writes, the SEC/Yahoo fallback layers and
// the console output contract are shared with the sibling updaters; only this
// file's Northern Trust fetch/parse layer is brand-specific.
type JsonRecord = Record<string, any>;

const NORTHERN_SITE = 'https://etfs.ntam.northerntrust.com';
const NORTHERN_CATALOG_PATH = '/us/en/individual/funds';
const NORTHERN_CATALOG_PAGE = `${NORTHERN_SITE}${NORTHERN_CATALOG_PATH}`;
const NORTHERN_FUND_FILES = `${NORTHERN_SITE}/content/dam/ntflexshares/fund`;

// Northern Trust keys its fund pages by ticker:
// "https://etfs.ntam.northerntrust.com/us/en/individual/funds/qlc".
export function northernTrustFundPageUrl(ticker: string): string {
  return `${NORTHERN_CATALOG_PAGE}/${String(ticker ?? '').toLowerCase()}`;
}

export function northernTrustFileUrl(ticker: string, file: string): string {
  const slug = String(ticker ?? '').toLowerCase();
  return `${NORTHERN_FUND_FILES}/${slug}/${file}`;
}

// The human-facing "Full Data Download" CSV behind each fund page: fund facts,
// pricing, official month/quarter-end performance, allocations and the
// distribution schedule in one file.
export function northernTrustAllCsvUrl(ticker: string): string {
  const slug = String(ticker ?? '').toLowerCase();
  return northernTrustFileUrl(ticker, `${slug}-all.csv`);
}

// The daily full-holdings CSV behind each fund page.
export function northernTrustHoldingsCsvUrl(ticker: string): string {
  const slug = String(ticker ?? '').toLowerCase();
  return northernTrustFileUrl(ticker, `${slug}-holdings.csv`);
}

// The distribution-schedule CSV behind each fund page.
export function northernTrustDistributionsCsvUrl(ticker: string): string {
  const slug = String(ticker ?? '').toLowerCase();
  return northernTrustFileUrl(ticker, `${slug}-distributions.csv`);
}

// The daily NAV / market-price / premium-discount history JSON of one fund.
export function northernTrustPricingJsonUrl(ticker: string): string {
  const slug = String(ticker ?? '').toLowerCase();
  return northernTrustFileUrl(ticker, `${slug}_pricing.json`);
}

// The fund-snapshot JSON of one fund (asset type, allocation pies, top 10).
export function northernTrustEtfChartsJsonUrl(ticker: string): string {
  const slug = String(ticker ?? '').toLowerCase();
  return northernTrustFileUrl(ticker, `${slug}_etfcharts.json`);
}
const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YAHOO_BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

// Official SEC lookup tables (public, no key): ETF/mutual-fund ticker ->
// registrant CIK + series/class ids, and operating company name -> ticker.
const SEC_FUND_TICKERS_URL = 'https://www.sec.gov/files/company_tickers_mf.json';
const SEC_COMPANY_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SEC_UA_DEFAULT = 'daggerok ETF feed daggerok@gmail.com';

let API_ROOT = new URL('../api/northerntrust/', import.meta.url);
let INDEX_FILE = new URL('index.json', API_ROOT);
let STATE_FILE = new URL('update-state.json', API_ROOT);

/** Tests point the writers at a temporary directory instead of ./api/northerntrust. */
export function setApiRootForTests(root: URL): void {
  API_ROOT = root;
  INDEX_FILE = new URL('index.json', root);
  STATE_FILE = new URL('update-state.json', root);
}

const HOLDINGS_PAGE_SIZE_FALLBACK = 250;
const HISTORY_PAGE_SIZE_FALLBACK = 1000;
const CONCURRENCY_FALLBACK = 2;
const REQUEST_SLEEP_FALLBACK = 1;
const MAX_RETRIES_FALLBACK = 2;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad3(value: number): string {
  return String(value).padStart(3, '0');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeTicker(raw: unknown): string {
  return String(raw ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function cleanText(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\u00ae/g, '') // ®
    .replace(/\u2122/g, '') // ™
    .replace(/&#174;|&reg;/gi, '')
    .replace(/&#8482;|&trade;/gi, '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// "2.97057744E8" -> "297057744"; keeps non-numeric text untouched (same as SPDR).
export function normalizeNumberText(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (text === '' || text === '-') return text;
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text.replace(/,/g, ''))) return text;
  const number = Number(text.replace(/,/g, ''));
  if (!Number.isFinite(number) || Math.abs(number) >= 1e21) return text;
  return number.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 10 });
}

export function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text === '—' || text === '-' || text === '--' || /^n\/?a$/i.test(text)) return null;
  // Percent first, then plain numbers: "0.40%" -> 0.4, "$1,234.56" -> 1234.56.
  const parsed = Number(text.replace(/[$,\s]/g, '').replace(/%$/i, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// Some issuers publish yields and returns as fractions (0.0536 = 5.36%);
// expense ratios and premium/discount figures arrive in percent already.
export function fractionToPercent(value: unknown): number | null {
  const number = numberOrNull(value);
  return number === null ? null : round(number * 100, 4);
}

// "2026-06-30" -> "Jun 30 2026" (the display style shared with the sibling apps).
export function formatEdgarDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!match) return String(iso || '');
  const [, year, month, day] = match;
  return `${MONTHS[Number(month) - 1] ?? month} ${day} ${year}`;
}

export function epochToIsoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

export function formatEpochDate(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  return `${MONTHS[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, '0')} ${date.getUTCFullYear()}`;
}

export function formatUsDate(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}/${date.getUTCFullYear()}`;
}

// "08/21/2026" / "2026-08-21T00:00:00Z" / "Aug 21 2026" -> "2026-08-21" as plain calendar text (shared calendar-dates
// block, never the local time zone); anything else passes through untouched so an unexpected source format never
// silently corrupts a date column.
export function toIsoDate(raw: unknown): string {
  const text = String(raw ?? '').trim();
  return calendarIso(text) ?? text;
}

// ISO date -> epoch seconds (UTC midnight), NaN-safe.
export function isoToEpoch(iso: string): number | null {
  const value = Date.parse(`${toIsoDate(iso)}T00:00:00Z`);
  return Number.isFinite(value) ? Math.floor(value / 1000) : null;
}

export function formatAumDisplay(value: number): string {
  return `$${(value / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} M`;
}

// ---------------------------------------------------------------------------
// Updater configuration (environment variables, iShares/SPDR/Fidelity-style)
// ---------------------------------------------------------------------------

type Range = { min?: number; max?: number };
type ReturnPeriod = 'YTD' | '1Y' | '3Y' | '5Y' | '10Y';
const RETURN_PERIODS: readonly ReturnPeriod[] = ['YTD', '1Y', '3Y', '5Y', '10Y'];
type RangeMap = Partial<Record<ReturnPeriod, Range>>;

type UpdaterConfig = {
  concurrency: number;
  requestSleep: number;
  maxFetches: number;
  holdingsPageSize: number;
  historyPageSize: number;
  storeRawDownloads: boolean;
  maxRetries: number;
  tickers: string[];
  historyRange: string;
  catalogUrl: string;
  secUa: string;
  skipYahoo: boolean;
  skipNorthernTrust: boolean;
  edgarFallback: boolean;
  aumRange?: Range & { source?: string };
  terRange?: Range;
  dividendYieldRange?: Range;
  secYieldRange?: Range;
  performanceRanges: RangeMap;
  totalReturnRanges: RangeMap;
};

const AUM_PRESET_BOUNDS = {
  nano: { min: 0, max: 10_000_000 },
  micro: { min: 10_000_000, max: 300_000_000 },
  small: { min: 300_000_000, max: 2_000_000_000 },
  mid: { min: 2_000_000_000, max: 10_000_000_000 },
  large: { min: 10_000_000_000, max: undefined },
} as const;
type AumPreset = keyof typeof AUM_PRESET_BOUNDS;

const AMOUNT_SUFFIXES: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

function envValue(env: Record<string, string | undefined>, name: string, aliases: string[] = []): string {
  for (const key of [`NORTHERNTRUST_${name}`, name, ...aliases]) {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return '';
}

function parsePositiveInt(raw: string, fallback: number): number {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseNonNegativeFloat(raw: string, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseBoolean(raw: string, fallback = false): boolean {
  const text = String(raw ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  return fallback;
}

// Strict "min:max" ranges (same parser and errors as the sibling repos).
export function parseRange(raw: string, label: string): Range | undefined {
  const text = String(raw ?? '').trim();
  if (text === '' || text === ':') return undefined;
  if (!text.includes(':')) {
    throw new Error(`${label}: "${text}" must use the "min:max" range syntax (a colon is required)`);
  }
  const colonParts = text.split(':');
  if (colonParts.length !== 2) throw new Error(`${label}: "${text}" must contain exactly one colon (min:max)`);
  const [rawMin, rawMax] = colonParts;
  const parseBound = (bound: string): number | undefined => {
    const cleaned = bound.trim().replace(/%$/, '').replace(/[$,]/g, '');
    if (cleaned === '') return undefined;
    const value = Number(cleaned);
    if (!Number.isFinite(value)) throw new Error(`${label}: "${bound.trim()}" is not a number`);
    return value;
  };
  const min = parseBound(rawMin);
  const max = parseBound(rawMax);
  if (min === undefined && max === undefined) return undefined;
  if (min !== undefined && max !== undefined && min > max) {
    throw new Error(`${label}: min (${min}) must not exceed max (${max})`);
  }
  return { min, max };
}

function parseAumBound(bound: string): number | undefined {
  const cleaned = bound.trim().replace(/[$,]/g, '');
  if (cleaned === '') return undefined;
  const suffixMatch = /^(\d+(?:\.\d+)?|\.\d+)([KMBT])$/i.exec(cleaned);
  if (suffixMatch) return Number(suffixMatch[1]) * (AMOUNT_SUFFIXES[suffixMatch[2].toUpperCase()] ?? 1);
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) throw new Error(`AUM: "${bound.trim()}" is not an amount, a K/M/B/T suffix or a preset`);
  return value;
}

export function parseAumRange(raw: string): (Range & { source?: string }) | undefined {
  const text = String(raw ?? '').trim();
  if (text === '' || text === ':') return undefined;
  const lower = text.toLowerCase();
  for (const preset of Object.keys(AUM_PRESET_BOUNDS) as AumPreset[]) {
    if (lower === preset) return { ...AUM_PRESET_BOUNDS[preset] } as Range & { source?: string };
  }
  if (!text.includes(':')) {
    throw new Error(`AUM: "${text}" must use the "min:max" range syntax (a colon is required)`);
  }
  const aumParts = text.split(':');
  if (aumParts.length !== 2) throw new Error(`AUM: "${text}" must contain exactly one colon (min:max)`);
  const [rawMin, rawMax] = aumParts;
  const min = parseAumBound(rawMin);
  const max = parseAumBound(rawMax);
  if (min === undefined && max === undefined) return undefined;
  if (min !== undefined && max !== undefined && min > max) {
    throw new Error(`AUM: min (${min}) must not exceed max (${max})`);
  }
  return { min, max };
}

function parseRanges(env: Record<string, string | undefined>, prefix: 'PERFORMANCE' | 'TOTAL_RETURN'): RangeMap {
  const ranges: RangeMap = {};
  for (const period of RETURN_PERIODS) {
    const parsed = parseRange(envValue(env, `${prefix}_${period}`), `${prefix}_${period}`);
    if (parsed) ranges[period] = parsed;
  }
  return ranges;
}

export function readConfig(env: Record<string, string | undefined> = process.env): UpdaterConfig {
  return {
    concurrency: parsePositiveInt(envValue(env, 'CONCURRENCY'), CONCURRENCY_FALLBACK),
    requestSleep: parseNonNegativeFloat(envValue(env, 'REQUEST_SLEEP'), REQUEST_SLEEP_FALLBACK),
    maxFetches: parsePositiveInt(envValue(env, 'MAX_FETCHES', ['NORTHERNTRUST_LIMIT']), 0),
    holdingsPageSize: parsePositiveInt(envValue(env, 'HOLDINGS_PAGE_SIZE'), HOLDINGS_PAGE_SIZE_FALLBACK),
    historyPageSize: parsePositiveInt(envValue(env, 'HISTORY_PAGE_SIZE', ['HISTORICAL_PAGE_SIZE']), HISTORY_PAGE_SIZE_FALLBACK),
    storeRawDownloads: parseBoolean(envValue(env, 'STORE_RAW_DOWNLOADS', ['NORTHERNTRUST_STORE_RAW_DOWNLOADS']), false),
    maxRetries: parsePositiveInt(envValue(env, 'MAX_RETRIES'), MAX_RETRIES_FALLBACK),
    tickers: envValue(env, 'TICKERS')
      .split(/[\s,;]+/)
      .map(sanitizeTicker)
      .filter(Boolean),
    historyRange: envValue(env, 'HISTORY_RANGE') || 'max',
    catalogUrl: envValue(env, 'CATALOG_URL') || NORTHERN_CATALOG_PAGE,
    secUa: envValue(env, 'SEC_UA') || SEC_UA_DEFAULT,
    skipYahoo: parseBoolean(envValue(env, 'SKIP_YAHOO'), false),
    skipNorthernTrust: parseBoolean(envValue(env, 'SKIP_NORTHERNTRUST'), false),
    edgarFallback: parseBoolean(envValue(env, 'EDGAR_FALLBACK'), true),
    aumRange: parseAumRange(envValue(env, 'AUM')),
    terRange: parseRange(envValue(env, 'TER'), 'TER'),
    dividendYieldRange: parseRange(envValue(env, 'DIVIDEND_YIELD'), 'DIVIDEND_YIELD'),
    secYieldRange: parseRange(envValue(env, 'SEC_YIELD'), 'SEC_YIELD'),
    performanceRanges: parseRanges(env, 'PERFORMANCE'),
    totalReturnRanges: parseRanges(env, 'TOTAL_RETURN'),
  };
}
function rangeLabel(range?: Range): string {
  if (!range) return 'any';
  const min = range.min === undefined ? '' : String(range.min);
  const max = range.max === undefined ? '' : String(range.max);
  return `${min}:${max}`;
}

function configLines(config: UpdaterConfig): string[] {
  return [
    `CONCURRENCY         ${config.concurrency}`,
    `REQUEST_SLEEP       ${config.requestSleep} s between outgoing request starts`,
    `MAX_FETCHES         ${config.maxFetches === 0 ? 'all eligible funds (full pass, cursor ignored)' : `${config.maxFetches} per run (resumes after the saved cursor)`}`,
    `HOLDINGS_PAGE_SIZE  ${config.holdingsPageSize}`,
    `HISTORY_PAGE_SIZE   ${config.historyPageSize}`,
    `STORE_RAW_DOWNLOADS ${config.storeRawDownloads ? 'on' : 'off'}`,
    `MAX_RETRIES         ${config.maxRetries}`,
    `TICKERS             ${config.tickers.length ? config.tickers.join(' ') : 'all Northern Trust ETFs in the catalog'}`,
    `HISTORY_RANGE       ${config.historyRange} (max or Ny, explicit period1/period2, Yahoo fallback history only)`,
    `CATALOG_URL         ${config.catalogUrl}`,
    `AUM                 ${rangeLabel(config.aumRange)}`,
    `TER                 ${rangeLabel(config.terRange)}`,
    `DIVIDEND_YIELD      ${rangeLabel(config.dividendYieldRange)}`,
    `SEC_YIELD           ${rangeLabel(config.secYieldRange)}`,
    `PERFORMANCE_*       ${RETURN_PERIODS.filter((p) => config.performanceRanges[p]).map((p) => `${p}=${rangeLabel(config.performanceRanges[p])}`).join(' ') || 'any'}`,
    `TOTAL_RETURN_*      ${RETURN_PERIODS.filter((p) => config.totalReturnRanges[p]).map((p) => `${p}=${rangeLabel(config.totalReturnRanges[p])}`).join(' ') || 'any'}`,
    `SEC_UA              ${config.secUa ? '(set, redacted)' : '(not set)'}`,
    `SKIP_YAHOO          ${config.skipYahoo}`,
    `SKIP_NORTHERNTRUST  ${config.skipNorthernTrust}`,
    `EDGAR_FALLBACK      ${config.edgarFallback}`,
  ];
}
const USAGE = `
Northern Trust ETF static data updater (Bun, no dependencies).

  bun ./scripts/update-data.ts            update ./api/northerntrust from etfs.ntam.northerntrust.com (+ SEC / Yahoo fallbacks)
  ./scripts/update-data.ts -h | --help    print this help

Defaults live in scripts/update-data.config.json. Precedence: config file <
advanced JSON (workflow only) < nonblank workflow inputs < environment
variables (NORTHERNTRUST_<NAME> wins over <NAME>). The CLI and the workflow
use the same resolver. Strict "min:max" ranges; AND logic.

Controls (environment variables):

  MAX_FETCHES          Batch size: continue after the ticker cursor saved in
                       api/northerntrust/update-state.json. Empty or 0 (the default)
                       means a full pass: every Northern Trust ETF in the catalog is
                       refreshed in one run, starting from the first ticker,
                       and the cursor is reset when it finishes. Only funds that
                       pass TICKERS and the filters count; the cursor wraps and
                       is ignored for a different filter set.
                       Legacy alias: NORTHERNTRUST_LIMIT.
  REQUEST_SLEEP        Minimum seconds between outgoing request starts,
                       including retries (default 1). The issuer site and the
                       SEC both throttle bursty clients; the SEC allows at most
                       10 requests per second, Yahoo throttles hard, keep >= 1.
  CONCURRENCY          Parallel fund workers (default 2). Starts are still
                       globally spaced by REQUEST_SLEEP.
  MAX_RETRIES          Retries after the initial request (default 2; at least 1). Only
                       network errors and HTTP 403/408/425/429/5xx responses
                       are retried with bounded exponential backoff.
  TICKERS              Space-, comma- or semicolon-separated ticker allowlist,
                       for example "QLC SKOR TIPA"; a ticker that is neither in
                       the live catalog nor a published fund is an error before
                       any fund request.
  AUM                  Net assets range in USD: "min:max". Bounds accept plain
                       amounts or K/M/B/T suffixes; a whole-value preset may be
                       one of nano, micro, small, mid, large.
  TER                  NET expense ratio range in percent, e.g. "0.1:0.5".
  DIVIDEND_YIELD       Dividend-yield range in percent (the 12-month dividend
                       yield published by Northern Trust, indicated when derived here).
  SEC_YIELD            SEC yield range in percent.
  PERFORMANCE_YTD      Annualized return ranges (also 1Y, 3Y, 5Y, 10Y).
  TOTAL_RETURN_YTD     Cumulative return ranges (also 1Y, 3Y, 5Y, 10Y).
  HOLDINGS_PAGE_SIZE   Rows per generated current-holdings JSON page (default 250).
  HISTORY_PAGE_SIZE    Rows per generated price-history JSON page (default 1000).
                       Legacy alias: HISTORICAL_PAGE_SIZE.
  STORE_RAW_DOWNLOADS  Store the source funds-list / full-data / holdings /
                       pricing / distributions downloads under
                       api/northerntrust/raw (1/true/yes/on).
                       Legacy alias: NORTHERNTRUST_STORE_RAW_DOWNLOADS.
  HISTORY_RANGE        max or Ny (e.g. 5y): reach of the Yahoo fallback history,
                       sent as explicit period1/period2 (default "max"); the
                       official Northern Trust history always covers the whole
                       life of the fund. Anything else is an error.
  CATALOG_URL          Override the catalog page URL (https, or http for localhost;
                       the funds list behind
                       ${NORTHERN_CATALOG_PAGE}).
  EDGAR_FALLBACK       0/false to skip the SEC EDGAR Form N-PORT-P fallback for
                       funds whose holdings CSV has no positions
                       (default on; needs the declared SEC_UA).
  SEC_UA               Override the declared SEC User-Agent (SEC policy
                       requires a declared contact for automated access).
  VERBOSE              1/true to print per-fund retry and fallback notices.
  USE_SYSTEM_CA        TLS trust store: auto (default) restarts the updater once
                       with Bun's --use-system-ca when a request fails with an
                       untrusted-certificate error; true always uses the system
                       CA store; false never restarts.
  SKIP_YAHOO           1/true to never call the Yahoo chart API, even when the
                       official Northern Trust history is unavailable for a fund
                       (previously published history rows are kept instead).
  SKIP_NORTHERNTRUST   1/true to skip every Northern Trust download: a fund with
                       published data keeps it unchanged (reported kept), a
                       fund without it gets only the fallbacks (SEC N-PORT-P
                       holdings, Yahoo history).

AUM, TER, yield and return filters are evaluated against the freshly
downloaded catalog values (or the previously published catalog) before the
heavier per-fund downloads. Funds that are filtered out (or that fail) keep
their previously published files, exactly like the sibling updaters.

Examples:

  MAX_FETCHES=10 ./scripts/update-data.ts
  TICKERS="QLC SKOR TIPA" ./scripts/update-data.ts
  AUM="1B:" TER=":0.5" ./scripts/update-data.ts
  PERFORMANCE_1Y="15:" ./scripts/update-data.ts
  STORE_RAW_DOWNLOADS=1 ./scripts/update-data.ts
  SKIP_YAHOO=1 ./scripts/update-data.ts
`;
// Fetch layer with global pacing and bounded retries (SPDR/Fidelity-style)
// ---------------------------------------------------------------------------

// One pacing lane per concurrent worker (sized from config.concurrency in
// main()). A single shared gate capped total throughput at one request per
// REQUEST_SLEEP no matter how high CONCURRENCY was set; CONCURRENCY workers
// now each get their own paced lane, so concurrency actually multiplies
// throughput as documented instead of only overlapping wait time.
let nextRequestAtLanes: number[] = [0];
let requestSleepMs = REQUEST_SLEEP_FALLBACK * 1000;
let fetchTimeoutMs = 45_000;
// The workflow times out at 30 minutes: stop taking new funds after 25 and still write the index
let softDeadlineMs = 25 * 60_000;

/** Tests shrink the per-request timeout and set the pacing lanes directly. */
export function configureFetchForTests(options: { timeoutMs?: number; sleepMs?: number; lanes?: number; deadlineMs?: number }): void {
  if (options.deadlineMs !== undefined) softDeadlineMs = options.deadlineMs;
  if (options.timeoutMs !== undefined) fetchTimeoutMs = options.timeoutMs;
  if (options.sleepMs !== undefined) requestSleepMs = options.sleepMs;
  if (options.lanes !== undefined) nextRequestAtLanes = new Array(Math.max(1, options.lanes)).fill(0);
}

/**
 * Reserves the earliest free lane slot synchronously (before any await), so
 * concurrent callers can never pick the same slot: N workers on N lanes start
 * together, the next request on a lane starts REQUEST_SLEEP after the last.
 */
export async function paceRequests(): Promise<void> {
  let lane = 0;
  for (let i = 1; i < nextRequestAtLanes.length; i++) if (nextRequestAtLanes[i] < nextRequestAtLanes[lane]) lane = i;
  const now = Date.now();
  const start = Math.max(now, nextRequestAtLanes[lane]);
  nextRequestAtLanes[lane] = start + requestSleepMs;
  if (start > now) await sleep(start - now);
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** A plain HTTP 404: the file does not exist (an honest "none"), unlike a timeout or a 5xx. */
function isNotFound(error: unknown): boolean {
  return error instanceof HttpError && error.status === 404;
}

/** `fetchWithRetry` already prefixes its messages with the fetch label, so a
    caller that prints its own tag must not repeat the label. */
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^\[[^\]]*\] ?/, '');
}

/**
 * One paced attempt per try, each with its own timeout that covers the headers
 * AND the body read; a timeout or a failed body read is retried like any
 * network error, up to maxRetries more times.
 */
async function fetchAttempts<T>(
  url: string,
  label: string,
  init: RequestInit,
  maxRetries: number,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await paceRequests();
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(fetchTimeoutMs), ...init });
      if (response.ok) return await read(response);
      const retryable = [403, 408, 425, 429].includes(response.status) || response.status >= 500;
      if (!retryable) throw new HttpError(`${label}: HTTP ${response.status} ${response.statusText}`, response.status, false);
      lastError = new HttpError(`${label}: HTTP ${response.status} (attempt ${attempt + 1} of ${maxRetries + 1})`, response.status, true);
    } catch (error) {
      if (error instanceof HttpError && !error.retryable) throw error;
      lastError = error instanceof HttpError ? error : new Error(`${label}: network error (${String(error)})`);
    }
    if (attempt < maxRetries) await sleep(Math.min(30_000, 1_000 * 2 ** attempt) + 250);
  }
  throw lastError instanceof Error ? lastError : new Error(`${label}: failed`);
}

export async function fetchWithRetry(
  url: string,
  label: string,
  init: RequestInit = {},
  maxRetries = 2,
): Promise<Response> {
  return fetchAttempts(url, label, init, maxRetries, async (response) => response);
}

function yahooHeaders(): Record<string, string> {
  return { 'User-Agent': YAHOO_BROWSER_UA, Accept: 'application/json' };
}

function secHeaders(config: UpdaterConfig): Record<string, string> {
  return { 'User-Agent': config.secUa, Accept: 'application/json,*/*' };
}

// etfs.ntam.northerntrust.com answers a plain browser UA for both the HTML
// pages and the per-fund CSV/JSON downloads.
function northernTrustHeaders(): Record<string, string> {
  return { 'User-Agent': YAHOO_BROWSER_UA, Accept: 'application/json,text/csv,text/plain,*/*' };
}

async function fetchText(url: string, label: string, headers: Record<string, string>, config: UpdaterConfig): Promise<string> {
  return fetchAttempts(url, label, { headers }, config.maxRetries, (response) => response.text());
}

async function fetchJson(url: string, label: string, headers: Record<string, string>, config: UpdaterConfig): Promise<JsonRecord> {
  const text = await fetchText(url, label, headers, config);
  try {
    return JSON.parse(text) as JsonRecord;
  } catch {
    throw new Error(`${label}: response is not valid JSON`);
  }
}

// ---------------------------------------------------------------------------
// CSV layer (RFC-4180 subset) — the Northern Trust full-data, holdings and distributions
// downloads are plain CSV files, unlike SPDR's XLSX
// ---------------------------------------------------------------------------

export type CsvTable = string[][];

export function parseCsv(text: string): CsvTable {
  const rows: CsvTable = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += char;
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  return rows;
}

// Header lookups ignore case, spaces and punctuation: issuers pad
// their CSV headers with spaces (", Fund Name, Ticker, CUSIP, NAV") and rename
// columns far more often than it changes their meaning.
function headerKey(name: unknown): string {
  return String(name ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/**
 * Issuers append legal/footer lines (disclaimers after a blank line)
 * to its downloads and may prefix them with a title, so the header row is
 * located by content instead of by a fixed row index.
 */
export function findHeaderRowIndex(rows: CsvTable, requiredColumns: string[]): number {
  const required = requiredColumns.map(headerKey);
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const cells = (rows[i] || []).map(headerKey);
    if (cells.length < 3) continue;
    if (required.every((name) => cells.includes(name))) return i;
  }
  return -1;
}

/** Rows keyed by header name (original spelling preserved, first wins). */
export function csvRecords(rows: CsvTable, headerIndex: number): JsonRecord[] {
  const headers = (rows[headerIndex] || []).map((cell) => cleanText(cell));
  const records: JsonRecord[] = [];
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.some((cell) => String(cell ?? '').trim() !== '')) continue;
    const record: JsonRecord = {};
    for (let c = 0; c < headers.length; c++) {
      const header = headers[c];
      if (!header || Object.prototype.hasOwnProperty.call(record, header)) continue;
      record[header] = String(row[c] ?? '').trim();
    }
    records.push(record);
  }
  return records;
}

/** First non-empty value among the candidate column names. */
export function pickColumn(record: JsonRecord, candidates: string[]): string {
  const wanted = candidates.map(headerKey);
  const keys = Object.keys(record);
  for (const name of wanted) {
    for (const key of keys) {
      if (headerKey(key) !== name) continue;
      const value = record[key];
      if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
    }
  }
  return '';
}

function pickNumber(record: JsonRecord, candidates: string[]): number | null {
  return numberOrNull(pickColumn(record, candidates));
}

function pickDate(record: JsonRecord, candidates: string[]): string {
  const raw = pickColumn(record, candidates);
  return raw ? toIsoDate(raw) : '';
}

// ---------------------------------------------------------------------------
// Catalog layer: the etfs.ntam.northerntrust.com funds-list page JSON
// ---------------------------------------------------------------------------

export type CatalogReturns = {
  ytd: number | null;
  yr1: number | null;
  yr3: number | null;
  yr5: number | null;
  yr10: number | null;
  sinceInception: number | null;
};

// Cumulative multi-year figures as published (the exact inverse of the
// annualized ones is only an approximation once rounding gets involved).
export type CumulativeReturns = { yr1: number | null; yr3: number | null; yr5: number | null; yr10: number | null; sinceInception: number | null };

export type OfficialReturns = CatalogReturns & {
  asOfDate: string | null;
  mo1: number | null;
  mo3: number | null;
};

export type CatalogFund = {
  ticker: string;
  name: string;
  category: string;
  categoryPath: string;
  inception: string | null;
  exchange: string;
  cusip: string;
  isin: string;
  benchmark: string;
  ter: number | null; // NET expense ratio (after waivers); the only number when just one is published
  terGross?: number | null; // GROSS expense ratio when published
  nav: number | null;
  close: number | null;
  premiumDiscount: number | null;
  netAssets: number | null;
  dividendYield: number | null;
  dividendYieldBasis?: YieldBasis | null; // code of the retained yield (rows rebuilt from the previous index)
  secYield: number | null;
  distributionRate: number | null;
  asOfDate: string | null;
  returns: CatalogReturns;
  returnsAsOfDate: string | null;
  mo1: number | null;
  marketReturns: CatalogReturns;
  quarterEnd: CatalogReturns;
  quarterEndAsOfDate: string | null;
  fundPage: string;
  source: 'northerntrust' | 'previous index' | 'seed';
};

const EMPTY_RETURNS: CatalogReturns = { ytd: null, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null };
const EMPTY_CUMULATIVE: CumulativeReturns = { yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null };

// The two registrants behind the Northern Trust ETF line-up (see the funds
// list legal footer): the legacy FlexShares series and the newer Northern
// Funds series (muni bond ETFs, distributing ladders, NOEQ). The SEC fund ticker
// table gives the registrant and series per fund at run time; this map names the
// registrant only for a fund that table does not list yet (the N-PORT fallback
// then finds the fund's filing by its name).
const FLEXSHARES_TRUST_CIK = '0001491978';
const NORTHERN_FUNDS_CIK = '0000916620';
const NORTHERN_FUNDS_TICKERS = new Set([
  'MUNA', 'MUNJ', 'MUNB', 'MUNF', 'MUNC', 'MUNG', 'MUND', 'MUNH',
  'TIPA', 'TIPE', 'TIPB', 'TIPF', 'TIPC', 'TIPG', 'TIPD', 'TIPH',
  'TAXS', 'TAXI', 'TAXT', 'TXCA', 'TXNY', 'NOEQ',
]);

export function northernTrustCikFor(ticker: string): string {
  return NORTHERN_FUNDS_TICKERS.has(String(ticker ?? '').toUpperCase()) ? NORTHERN_FUNDS_CIK : FLEXSHARES_TRUST_CIK;
}

// etfs.ntam.northerntrust.com groups its line-up by asset class ("Equity",
// "Fixed Income", "Real Assets"). The catalog tabs use the asset class
// verbatim; the full path (asset class + investment objective) is kept in
// meta.json for provenance.
export function normalizeNorthernTrustCategory(raw: unknown): string {
  const text = cleanText(raw).replace(/\s+/g, ' ');
  return text || 'ETF';
}

function fractionReturns(block: unknown): CatalogReturns {
  const source = (block && typeof block === 'object' ? block : {}) as JsonRecord;
  return {
    ytd: fractionToPercent(source.ytd),
    yr1: fractionToPercent(source.yr1 ?? source.oneYear),
    yr3: fractionToPercent(source.yr3 ?? source.threeYears),
    yr5: fractionToPercent(source.yr5 ?? source.fiveYears),
    yr10: fractionToPercent(source.yr10 ?? source.tenYears),
    sinceInception: fractionToPercent(source.inception ?? source.sinceInception),
  };
}

function isoOrNull(raw: unknown): string | null {
  const iso = toIsoDate(raw);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

// Attribute-escaped entities of the funds-list data-content JSON documents
// ("&#34;" for quotes, "&amp;" inside tooltips). &amp; decodes first so a
// double-escaped sequence still resolves.
export function decodeNorthernTrustEntities(raw: unknown): string {
  return String(raw ?? '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => {
      const point = Number(code);
      return Number.isFinite(point) && point > 0 && point < 0x10ffff ? String.fromCodePoint(point) : _match;
    });
}

function northernTrustTagLabels(tags: unknown): string[] {
  if (!tags || typeof tags !== 'object') return [];
  return Object.keys(tags as JsonRecord)
    .sort()
    .map((key) => cleanText((tags as JsonRecord)[key]))
    .filter((label) => label !== '');
}

function northernTrustBlockReturns(block: unknown): CatalogReturns {
  const source = (block && typeof block === 'object' ? block : {}) as JsonRecord;
  return {
    ytd: numberOrNull(source.ytd),
    yr1: numberOrNull(source['1-yr']),
    yr3: numberOrNull(source['3-yr']),
    yr5: numberOrNull(source['5-yr']),
    yr10: numberOrNull(source['10-yr']),
    sinceInception: numberOrNull(source['since-inception']),
  };
}

/**
 * The funds-list page embeds one JSON document per component in data-content
 * attributes; the "SEARCH FUNDS" document carries the whole catalog as
 * `fundList` (ticker, page path, asset-class/investment-objective tags, the
 * pricing block and the official month/quarter-end NAV + market-price
 * performance blocks — percents with a trailing "%", "--" when unpublished).
 */
export function parseNorthernTrustCatalog(html: string): CatalogFund[] {
  const source = String(html ?? '');
  const documents: JsonRecord[] = [];
  const pattern = /data-content="([\s\S]*?)"/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    try {
      const parsed: unknown = JSON.parse(decodeNorthernTrustEntities(match[1]));
      if (parsed && typeof parsed === 'object') documents.push(parsed as JsonRecord);
    } catch {
      // Not a JSON component (tooltip text, plain labels) — keep scanning.
    }
  }
  const catalog = documents.find((doc) => Array.isArray(doc.fundList));
  if (!catalog) throw new Error('Northern Trust catalog: funds-list JSON not found');
  const funds = new Map<string, CatalogFund>();
  for (const raw of catalog.fundList as JsonRecord[]) {
    if (!raw || typeof raw !== 'object') continue;
    const ticker = sanitizeTicker(raw.ticker);
    if (!ticker || funds.has(ticker)) continue;
    const pricing = (raw.pricing ?? {}) as JsonRecord;
    const name = cleanText(pricing['fund-name']);
    if (!name) continue;
    const category = normalizeNorthernTrustCategory(northernTrustTagLabels(raw.assetClassTags).join(' / '));
    const objective = northernTrustTagLabels(raw.investmentObjectiveTags)[0] ?? '';
    const monthlyNav = (raw['monthly-performance-nav'] ?? {}) as JsonRecord;
    const monthlyMarket = (raw['monthly-performance-market'] ?? {}) as JsonRecord;
    const quarterlyNav = (raw['quarterly-performance-nav'] ?? {}) as JsonRecord;
    const pagePath = cleanText(raw.pagePath);
    funds.set(ticker, {
      ticker,
      name,
      category,
      categoryPath: objective ? `${category} / ${objective}` : category,
      inception: isoOrNull(pricing['inception-date']),
      exchange: '',
      cusip: '',
      isin: '',
      benchmark: '',
      ter: numberOrNull(pricing['net-expense-ratio']) ?? numberOrNull(pricing['gross-expense-ratio']),
      terGross: numberOrNull(pricing['gross-expense-ratio']),
      nav: null,
      close: numberOrNull(pricing['closing-market-price']),
      premiumDiscount: null,
      netAssets: null,
      dividendYield: null,
      secYield: null,
      distributionRate: null,
      asOfDate: isoOrNull(pricing['as-of-date']),
      returns: northernTrustBlockReturns(monthlyNav),
      returnsAsOfDate: isoOrNull(monthlyNav['month-end-as-of-date']),
      mo1: numberOrNull(monthlyNav['1-mo']),
      marketReturns: northernTrustBlockReturns(monthlyMarket),
      quarterEnd: northernTrustBlockReturns(quarterlyNav),
      quarterEndAsOfDate: isoOrNull(quarterlyNav['quarter-end-as-of-date']),
      fundPage: pagePath ? `${NORTHERN_SITE}${pagePath}` : northernTrustFundPageUrl(ticker),
      source: 'northerntrust',
    });
  }
  if (!funds.size) throw new Error('Northern Trust catalog: no ETF rows');
  return [...funds.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
}
export const HOLDINGS_HEADERS = ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Asset Category'];
export const BOND_SHEET_HEADERS = [...HOLDINGS_HEADERS, 'Coupon', 'Maturity'];
/** Funds whose holdings legitimately fail a holdingsGuard check (geared, futures, look-through, top-N lists): ticker, or '*' for every fund -> relaxed checks. */
export const HOLDINGS_GUARD_RELAX: Record<string, string[]> = {};
/** Funds the issuer closed, each confirmed from an SEC filing or the issuer notice (`source`): never fetched or guarded, last published data kept, index row marked closed. */
export const CLOSED_FUNDS: ClosedFund[] = [];

export type ParsedHoldings = {
  asOfDate: string | null;
  container?: string;
  headers: string[];
  rows: JsonRecord[];
};

// Dividend-frequency codes and words ("MDEC" = monthly, December fiscal
// year-end; Northern Trust publishes the plain word instead). The first
// letter is the cadence; any suffix does not matter here.
export const DIVIDEND_FREQUENCY_CODES: Record<string, { frequency: string; paymentsPerYear: number | null }> = {
  M: { frequency: 'Monthly', paymentsPerYear: 12 },
  Q: { frequency: 'Quarterly', paymentsPerYear: 4 },
  S: { frequency: 'Semi-annually', paymentsPerYear: 2 },
  H: { frequency: 'Semi-annually', paymentsPerYear: 2 },
  Y: { frequency: 'Annually', paymentsPerYear: 1 },
  A: { frequency: 'Annually', paymentsPerYear: 1 },
  W: { frequency: 'Weekly', paymentsPerYear: 52 },
  D: { frequency: 'Daily', paymentsPerYear: null },
};

export function decodeDividendFrequency(code: unknown): { frequency: string; paymentsPerYear: number | null } | null {
  const text = String(code ?? '').trim().toUpperCase();
  if (!text) return null;
  return DIVIDEND_FREQUENCY_CODES[text[0]] ?? null;
}


export type ProductData = {
  ticker: string;
  name: string;
  cusip: string;
  isin: string;
  exchange: string;
  assetClass: string;
  benchmark: string;
  inception: string | null;
  listingDate: string | null;
  grossExpense: number | null;
  netExpense: number | null;
  nav: number | null;
  navDate: string | null;
  marketPrice: number | null;
  marketPriceDate: string | null;
  premiumDiscount: number | null;
  netAssets: number | null;
  netAssetsDate: string | null;
  sharesOutstanding: number | null;
  numberOfHoldings: number | null;
  dividendYield: number | null;
  dividendYieldDate: string | null;
  dividendYieldKind: string;
  secYield: number | null;
  secYieldDate: string | null;
  secYieldKind: string;
  unsubsidizedSecYield: number | null;
  frequencyCode: string;
  latestDividend: { exDate: string; amount: number; payDate: string; recordDate: string } | null;
  monthEnd: OfficialReturns;
  monthEndMarket: OfficialReturns;
  cumulative: CumulativeReturns;
  cumulativeAsOfDate: string | null;
  holdings: ParsedHoldings | null;
};

function performanceRow(rows: unknown, factor: RegExp): JsonRecord | null {
  if (!Array.isArray(rows)) return null;
  for (const row of rows as JsonRecord[]) {
    if (row && factor.test(String(row.performanceFactor ?? ''))) return row;
  }
  return null;
}

function officialReturnsFrom(row: JsonRecord | null): OfficialReturns {
  return {
    ...fractionReturns(row),
    asOfDate: isoOrNull(row?.effectiveDate),
    mo1: fractionToPercent(row?.oneMonth ?? row?.mt1),
    mo3: fractionToPercent(row?.threeMonths ?? row?.mt3),
  };
}


/** Published order: weight desc, then market value desc, then name / identifier / ticker (code-unit order, locale independent). */
export function compareHoldingRows(a: JsonRecord, b: JsonRecord): number {
  const numeric = (value: unknown): number => numberOrNull(value) ?? Number.NEGATIVE_INFINITY;
  const text = (x: unknown, y: unknown): number => (String(x ?? '') < String(y ?? '') ? -1 : String(x ?? '') > String(y ?? '') ? 1 : 0);
  const byWeight = numeric(b.Weight) - numeric(a.Weight);
  if (byWeight) return byWeight;
  const byValue = numeric(b['Market Value']) - numeric(a['Market Value']);
  if (byValue) return byValue;
  return text(a.Name, b.Name) || text(a.Identifier, b.Identifier) || text(a.Ticker, b.Ticker);
}

/**
 * Daily full-holdings CSV: one header row (Date, CUSIP, ISIN, SEDOL, Name,
 * Ticker, Market Value-Local, Market Value-Base, Fund Weight %, Shares Held,
 * Coupon, Maturity, Sector Type, Country) then one row per position. Bonds
 * carry no exchange ticker; cash rows carry neither ticker nor sector. The
 * Coupon/Maturity columns are kept only when at least one position reports a
 * real coupon or maturity (bond funds) — equity downloads fill every coupon
 * cell with ".000".
 */
export function parseNorthernTrustHoldings(text: string, ticker: string, listings: Map<string, string> | null = null): ParsedHoldings | null {
  const rows = parseCsv(text);
  const headerIndex = findHeaderRowIndex(rows, ['Name', 'Ticker', 'Fund Weight']);
  if (headerIndex < 0) throw new Error(`${ticker}: holdings CSV header row not found`);
  const holdings: JsonRecord[] = [];
  let asOf = '';
  let hasBondColumns = false;
  for (const record of csvRecords(rows, headerIndex)) {
    const name = cleanText(decodeNorthernTrustEntities(pickColumn(record, ['Name'])));
    if (!name) continue;
    if (!asOf) asOf = isoOrNull(pickColumn(record, ['Date'])) ?? '';
    const weight = numberOrNull(pickColumn(record, ['Fund Weight %', 'Fund Weight']));
    const marketValue = numberOrNull(pickColumn(record, ['Market Value-Base', 'Market Value']));
    const shares = numberOrNull(pickColumn(record, ['Shares Held']));
    const coupon = numberOrNull(pickColumn(record, ['Coupon']));
    const maturity = isoOrNull(pickColumn(record, ['Maturity', 'Maturity Date']));
    if ((coupon !== null && coupon !== 0) || maturity) hasBondColumns = true;
    const identifier = cleanText(pickColumn(record, ['CUSIP', 'ISIN', 'SEDOL'])).toUpperCase();
    const row: JsonRecord = {
      Name: name,
      Ticker: holdingTickerFor(record, listings),
      Identifier: identifier || '-',
      Weight: weight === null ? '' : String(round(weight, 6)),
      'Market Value': marketValue === null ? '' : normalizeNumberText(String(round(marketValue, 2))),
      'Shares Held': shares === null ? '-' : normalizeNumberText(String(shares)),
      'Asset Category': cleanText(pickColumn(record, ['Sector Type', 'Sector'])) || '-',
    };
    row['Coupon'] = coupon === null ? '' : String(round(coupon, 4));
    row['Maturity'] = maturity ? formatEdgarDate(maturity) : '';
    holdings.push(row);
  }
  if (!holdings.length) return null;
  // The download arrives in descending weight order but breaks ties
  // differently from one request to the next; a canonical tie-break keeps
  // reruns byte-identical.
  holdings.sort(compareHoldingRows);
  const headers = hasBondColumns ? BOND_SHEET_HEADERS : HOLDINGS_HEADERS;
  return {
    asOfDate: asOf || null,
    container: 'holdings.csv',
    headers,
    rows: holdings.map((row) => {
      const next: JsonRecord = {};
      for (const header of headers) next[header] = row[header] ?? '';
      return next;
    }),
  };
}
/**
 * NT-1: the holdings CSV gives the LOCAL code of a foreign listing and has no exchange column (TLTE lists `000100` for Yuhan
 * in Korea and for TCL Technology in China, `PG` for Procter & Gamble Hygiene in India, GUNR and TLTE `PEP` for PPB Group in
 * Malaysia). The Watchlist groups positions by ticker, so a bare ticker is published only for a U.S. listing: a position
 * traded in U.S. dollars (equal local and base market values) with a U.S. ISIN (ADRs included) or the United States as its
 * country (Linde, Accenture), or a foreign issuer whose ticker the Nasdaq Trader directories list for the same company (Q33:
 * NXPI, TEL, AER, CHKP; shared nport-reader `nportUsListed`, `listings` from `loadUsListings`, none when they failed). A
 * foreign listing, debt, a preferred share, a future or cash publishes '-' and stays keyed by its CUSIP, ISIN or SEDOL Identifier.
 */
export function holdingTickerFor(record: JsonRecord, listings: Map<string, string> | null = null): string {
  const ticker = cleanHoldingTicker(pickColumn(record, ['Ticker']));
  if (!ticker) return '-';
  const coupon = numberOrNull(pickColumn(record, ['Coupon']));
  const debt = (coupon !== null && coupon !== 0) || Boolean(pickColumn(record, ['Maturity', 'Maturity Date']));
  const cashOrDerivative = /cash|derivative/i.test(pickColumn(record, ['Sector Type', 'Sector']));
  const preferred = /\bPREFERENCE\b|\bPREFERRED STOCK\b|\bPFD\b/i.test(pickColumn(record, ['Name']));
  if (debt || cashOrDerivative || preferred) return '-';
  const local = numberOrNull(pickColumn(record, ['Market Value-Local']));
  const base = numberOrNull(pickColumn(record, ['Market Value-Base']));
  const usd = local === null || base === null || local === base;
  const isin = pickColumn(record, ['ISIN']).toUpperCase();
  const country = cleanText(pickColumn(record, ['Country'])).toLowerCase();
  if (!usd) return '-';
  if (isin.startsWith('US') || country === 'united states') return ticker;
  return nportUsListed(listings, ticker, decodeNorthernTrustEntities(pickColumn(record, ['Name']))) ? ticker : '-';
}

export function weightsSum(rows: JsonRecord[]): number {
  return round(rows.reduce((sum, row) => sum + (numberOrNull(row.Weight) || 0), 0), 4);
}

/**
 * Holdings weights in percent. Only a sheet whose weights add up to about 1 (0.5..1.5) carries fractions and is
 * scaled by 100 once (0.6 + 0.400006 -> 60 + 40.0006); a percent sheet (about 100) stays as is, and any other total
 * stays untouched so the holdings guard rejects it and the fund keeps its published state (a broken percent file
 * summing to 0.007 is never turned into 0.7).
 */
export function weightsAsPercent(rows: JsonRecord[]): JsonRecord[] {
  const sum = weightsSum(rows);
  if (!(sum > 0.5 && sum < 1.5)) return rows;
  return rows.map((row) => ({ ...row, Weight: String(round((numberOrNull(row.Weight) || 0) * 100, 6)) }));
}

export type NorthernTrustFacts = ProductData & {
  quarterEnd: OfficialReturns;
  quarterEndMarket: OfficialReturns;
};

type NorthernTrustGrid = { asOf: string | null; header: string[]; rows: string[][] };

function northernTrustOfficialReturns(grid: NorthernTrustGrid | null, label: string): OfficialReturns {
  const empty: OfficialReturns = { ...EMPTY_RETURNS, asOfDate: grid?.asOf ?? null, mo1: null, mo3: null };
  if (!grid) return empty;
  const row = grid.rows.find((candidate) => cleanText(candidate[0] ?? '') === label);
  if (!row) return empty;
  const at = (tenor: string): number | null => {
    const index = grid.header.findIndex((cell) => cell === tenor);
    return index < 0 ? null : numberOrNull(row[index + 1]);
  };
  return {
    ytd: at('YTD'),
    yr1: at('1 Year'),
    yr3: at('3 Year'),
    yr5: at('5 Year'),
    yr10: at('10 Year'),
    sinceInception: at('Since Inception'),
    asOfDate: grid.asOf,
    mo1: at('1 Month'),
    mo3: null,
  };
}

/**
 * Full-data CSV sections: a "Data as of MM/DD/YYYY" stamp, "Fund Facts" and
 * "Pricing" key/value pairs, "Month-End Performance (as of ...)" and
 * "Quarter-End Performance (as of ...)" NAV/Market Price/benchmark grids, then
 * allocation sections this feed ignores (sector, top 10, market cap, style,
 * distributions, country — the sibling schema has no slots for them). Section
 * layouts differ by fund type (equity/bond/ladder) and young funds omit the
 * performance grids entirely, so every section is optional.
 */
export function parseNorthernTrustFacts(allCsv: string, etfCharts: JsonRecord | null, ticker: string): NorthernTrustFacts {
  const rows = parseCsv(allCsv);
  if (!rows.length) throw new Error(`${ticker}: full-data CSV is empty`);
  let asOf: string | null = null;
  const facts = new Map<string, string>();
  let monthEnd: NorthernTrustGrid | null = null;
  let quarterEnd: NorthernTrustGrid | null = null;
  let mode: 'facts' | 'month' | 'quarter' | 'ignore' = 'ignore';
  let header: string[] = [];
  let grid: string[][] = [];
  let gridAsOf: string | null = null;
  const flush = (): void => {
    if (mode === 'month') monthEnd = { asOf: gridAsOf, header, rows: grid };
    else if (mode === 'quarter') quarterEnd = { asOf: gridAsOf, header, rows: grid };
    header = [];
    grid = [];
    gridAsOf = null;
  };
  for (const row of rows) {
    const first = cleanText(row[0] ?? '');
    const stamp = /^Data as of\s+(.+)$/.exec(first);
    if (stamp) {
      flush();
      asOf = isoOrNull(stamp[1]);
      mode = 'ignore';
      continue;
    }
    if (first === 'Fund Facts' || first === 'Pricing') {
      flush();
      mode = 'facts';
      continue;
    }
    if (first.startsWith('Month-End Performance') || first.startsWith('Quarter-End Performance')) {
      flush();
      mode = first.startsWith('Month-End') ? 'month' : 'quarter';
      header = row.slice(1).map((cell) => cleanText(cell));
      gridAsOf = isoOrNull(/as of\s+(\d{1,2}\/\d{1,2}\/\d{4})/.exec(first)?.[1] ?? '');
      continue;
    }
    if (row.length < 2) {
      // A lone cell is the next section title (sector, top 10, ...) — the
      // key/value and grid rows below always carry value cells.
      flush();
      mode = 'ignore';
      continue;
    }
    if (mode === 'facts') {
      const value = cleanText(row.slice(1).join(','));
      if (value !== '' || !facts.has(first)) facts.set(first, value);
    } else if (mode === 'month' || mode === 'quarter') {
      grid.push(row);
    }
  }
  flush();
  // A 200 error page (HTML) or a download without a filled Fund Facts or Pricing section is a failed source, never
  // an all-null fund: the caller keeps the previous complete state instead of publishing nulls next to fresh holdings.
  if (!Array.from(facts.values()).some((value) => value !== '')) throw new Error(`${ticker}: full-data CSV has no Fund Facts or Pricing values`);
  const get = (key: string): string => facts.get(key) ?? '';
  const prefixed = (prefix: string): string => {
    for (const [key, value] of facts) if (key.startsWith(prefix)) return value;
    return '';
  };
  const relatedIndex = cleanText(get('Related Index'));
  const benchmark = !relatedIndex || /^(n\/a|na|-+|—+)$/i.test(relatedIndex) ? '' : relatedIndex;
  return {
    ticker: ticker.toUpperCase(),
    name: cleanText(etfCharts?.FundName),
    cusip: cleanText(get('CUSIP')).toUpperCase(),
    isin: '',
    exchange: cleanText(get('Primary Exchange')),
    assetClass: etfCharts ? normalizeNorthernTrustCategory(etfCharts.AssetType) : 'ETF',
    benchmark,
    inception: isoOrNull(get('Inception')),
    listingDate: null,
    grossExpense: numberOrNull(get('Gross Expense Ratio')),
    netExpense: numberOrNull(get('Net Expense Ratio')),
    nav: numberOrNull(get('NAV Price')),
    navDate: asOf,
    marketPrice: numberOrNull(get('Market Price')),
    marketPriceDate: asOf,
    premiumDiscount: numberOrNull(get('Premium/Discount')),
    netAssets: numberOrNull(get('Total Net Assets')),
    netAssetsDate: asOf,
    sharesOutstanding: numberOrNull(get('Shares Outstanding')),
    numberOfHoldings: numberOrNull(get('No. of Holdings')),
    dividendYield: numberOrNull(get('12-Month Dividend Yield')),
    dividendYieldDate: asOf,
    dividendYieldKind: '12-month dividend yield (official Northern Trust full-data CSV)',
    secYield: numberOrNull(prefixed('SEC Subsidized Yield')),
    secYieldDate: asOf,
    secYieldKind: 'SEC subsidized yield (official Northern Trust full-data CSV)',
    unsubsidizedSecYield: numberOrNull(prefixed('SEC Unsubsidized Yield')),
    frequencyCode: cleanText(get('Income Distribution Frequency')),
    latestDividend: null,
    monthEnd: northernTrustOfficialReturns(monthEnd, 'NAV'),
    monthEndMarket: northernTrustOfficialReturns(monthEnd, 'Market Price'),
    cumulative: { ...EMPTY_CUMULATIVE },
    cumulativeAsOfDate: null,
    holdings: null,
    quarterEnd: northernTrustOfficialReturns(quarterEnd, 'NAV'),
    quarterEndMarket: northernTrustOfficialReturns(quarterEnd, 'Market Price'),
  };
}
// Historical-data layer: daily NAV / market price history, the dividend
// schedule and the quarter-end returns of one fund
// ---------------------------------------------------------------------------

export const HISTORY_HEADERS = ['Date', 'NAV', 'Market Price', 'Premium/Discount'];
export const YAHOO_HISTORY_HEADERS = ['Date', 'Close', 'Adj Close', 'Volume'];

export type HistoryPoint = { date: string; nav: number | null; marketPrice: number | null; premiumDiscount: number | null };

export type OfficialDividend = { epoch: number; amount: number; exDate: string; payDate: string; recordDate: string; reinvestNav: number | null; type: string };

export type ParsedHistoricalData = {
  points: HistoryPoint[]; // ascending by date
  dividends: OfficialDividend[]; // ascending by ex-date
  quarterEnd: OfficialReturns;
  quarterEndMarket: OfficialReturns;
  monthlyReturns: Array<{ date: string; value: number }>;
};

/**
 * Daily pricing JSON: one object per trading day since inception (AS_OF_DATE,
 * NET_ASSET_VALUE, CLOSING_MARKET_PRICE, PREMIUM_DISCOUNT, ...), ascending by
 * date for the history pages and the derived metrics.
 */
export function parseNorthernTrustPricing(payload: unknown, ticker: string): HistoryPoint[] {
  const list = Array.isArray(payload) ? payload : null;
  if (!list) throw new Error(`${ticker}: pricing JSON is not a daily list`);
  const byDate = new Map<string, HistoryPoint>();
  for (const raw of list as JsonRecord[]) {
    const date = isoOrNull(raw?.AS_OF_DATE);
    if (!date) continue;
    byDate.set(date, {
      date,
      nav: numberOrNull(raw?.NET_ASSET_VALUE),
      marketPrice: numberOrNull(raw?.CLOSING_MARKET_PRICE),
      premiumDiscount: numberOrNull(raw?.PREMIUM_DISCOUNT),
    });
  }
  return [...byDate.values()]
    .filter((point) => point.nav !== null || point.marketPrice !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Distributions CSV: one row per ex-date (Ex-Date, Record Date, Payable Date,
 * Income, Short/Long-Term Capital Gains, Return of Capital, Total
 * Distribution). Future ex-dates with empty amounts and zero-amount rows are
 * skipped, exactly like the sibling dividend schedules.
 */
export function parseNorthernTrustDistributionsCsv(text: string, ticker: string): OfficialDividend[] {
  const rows = parseCsv(text);
  const headerIndex = findHeaderRowIndex(rows, ['Ex-Date', 'Total Distribution']);
  if (headerIndex < 0) throw new Error(`${ticker}: distributions CSV header row not found`);
  const dividends: OfficialDividend[] = [];
  for (const record of csvRecords(rows, headerIndex)) {
    const exDate = isoOrNull(pickColumn(record, ['Ex-Date']));
    const amount = numberOrNull(pickColumn(record, ['Total Distribution']));
    const epoch = exDate ? isoToEpoch(exDate) : null;
    if (!exDate || epoch === null || amount === null || amount <= 0) continue;
    dividends.push({
      epoch,
      amount,
      exDate,
      payDate: isoOrNull(pickColumn(record, ['Payable Date'])) ?? '',
      recordDate: isoOrNull(pickColumn(record, ['Record Date'])) ?? '',
      reinvestNav: null,
      type: '',
    });
  }
  dividends.sort((a, b) => a.epoch - b.epoch || a.amount - b.amount);
  return dividends;
}

/**
 * Turns the official NAV history into the adjusted daily series the derived
 * metrics consume: `close` is the NAV, `adjClose` is the NAV with every
 * published distribution reinvested at its reinvestment NAV (ex-date NAV when
 * the issuer omits it) — a NAV total-return index. Only the published dividend
 * window is adjusted (the fund page lists the last 12 payments), so windows
 * that start before `reinvestmentCoverageStart` are never derived from it.
 */
export function navTotalReturnDays(points: HistoryPoint[], dividends: OfficialDividend[]): ChartDay[] {
  const navPoints = points.filter((point) => point.nav !== null && point.nav > 0);
  if (!navPoints.length) return [];
  const sortedDividends = [...dividends].sort((a, b) => a.epoch - b.epoch);
  let factor = 1;
  let next = 0;
  const days: ChartDay[] = [];
  for (let i = 0; i < navPoints.length; i++) {
    const point = navPoints[i];
    while (next < sortedDividends.length && sortedDividends[next].exDate <= point.date) {
      const dividend = sortedDividends[next];
      const reinvestNav = dividend.reinvestNav && dividend.reinvestNav > 0 ? dividend.reinvestNav : point.nav;
      if (reinvestNav && reinvestNav > 0 && dividend.exDate >= navPoints[0].date) factor *= 1 + dividend.amount / reinvestNav;
      next += 1;
    }
    days.push({
      date: point.date,
      close: round(point.nav as number, 6),
      adjClose: round((point.nav as number) * factor, 6),
      volume: 0,
    });
  }
  return days;
}

/** The fund page's dividend schedule publishes at most this many payments. */
export const DIVIDEND_SCHEDULE_CAP = 12;

/**
 * First date from which the reinvestment index above is complete. A schedule
 * shorter than the cap is the fund's whole payout history, so the index is
 * complete from the first NAV. A capped schedule may hide older payments: the
 * index is then trusted only from one payment interval (the median gap between
 * the listed ex-dates) before the earliest listed ex-date — a window starting
 * earlier would miss reinvestments and understate a frequent payer's return.
 */
export function reinvestmentCoverageStart(points: HistoryPoint[], dividends: OfficialDividend[]): string | null {
  const navPoints = points.filter((point) => point.nav !== null && point.nav > 0);
  if (!navPoints.length) return null;
  if (dividends.length < DIVIDEND_SCHEDULE_CAP) return navPoints[0].date;
  const epochs = dividends.map((dividend) => dividend.epoch).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < epochs.length; i++) gaps.push(epochs[i] - epochs[i - 1]);
  gaps.sort((a, b) => a - b);
  const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  const covered = epochToIsoDate(epochs[0] - medianGap);
  return covered > navPoints[0].date ? covered : navPoints[0].date;
}

// ---------------------------------------------------------------------------
// Holding tickers
//
// Northern Trust labels every exchange-listed holding with a ticker, but its
// bond and cash rows come back blank. Those rows keep "-" and are keyed by
// their CUSIP/ISIN/SEDOL Identifier in the Watchlist (see holdingTickerFor for
// foreign listings). N-PORT positions (EDGAR fallback) get tickers from the
// shared nport-reader block (nportTickers: U.S. equities only).
// ---------------------------------------------------------------------------

// Holding tickers keep their class-share markers (SCE^L, BF/A, BRK-B): they
// are the real exchange symbols, unlike fund tickers which sanitizeTicker
// upper-cases and strips everything but letters/digits.
const HOLDING_TICKER_PLACEHOLDERS = new Set(['', 'N/A', 'NA', 'NONE', 'NIL', 'NULL', '-', '--', '---', 'SEE FILE', 'VARIES']);

export function cleanHoldingTicker(raw: unknown): string {
  const symbol = String(raw ?? '').trim().toUpperCase();
  if (HOLDING_TICKER_PLACEHOLDERS.has(symbol)) return '';
  return /^[A-Z0-9][A-Z0-9.^/-]*$/.test(symbol) ? symbol : '';
}

// ---------------------------------------------------------------------------
// SEC EDGAR Form N-PORT-P fallback: the shared nport-reader block at the end of
// this file finds, reads and checks the filing; this layer only loads the SEC
// ticker tables once per run and maps a filing to the published sheet.
// ---------------------------------------------------------------------------

/** One run's SEC state: the two SEC ticker tables (each loaded once) and the N-PORT reader cache (submissions and documents). */
let secState: { funds: Promise<Map<string, NportSeriesRef>> | null; names: Promise<Map<string, string>> | null; reader: Map<string, unknown> } = { funds: null, names: null, reader: new Map() };

/** A fresh SEC state for a run (runUpdater and tests). */
export function resetSecState(): void {
  secState = { funds: null, names: null, reader: new Map() };
}

/** SEC's ticker -> registrant CIK + series id table, loaded once per run (a failed load is asked again by the next fund). */
function loadFundTickerTable(config: UpdaterConfig): Promise<Map<string, NportSeriesRef>> {
  if (!secState.funds) {
    const loading = fetchJson(SEC_FUND_TICKERS_URL, '[ edgar    ] fund ticker table', secHeaders(config), config).then((payload) => parseSecFundTickers(payload));
    secState.funds = loading;
    loading.catch(() => { if (secState.funds === loading) secState.funds = null; });
  }
  return secState.funds;
}

/** SEC's company name -> ticker table for the N-PORT rows, loaded once per run. */
function loadCompanyNames(config: UpdaterConfig): Promise<Map<string, string>> {
  if (!secState.names) {
    const loading = fetchJson(SEC_COMPANY_TICKERS_URL, '[ edgar    ] company ticker table', secHeaders(config), config).then((payload) => parseSecCompanyNames(payload));
    secState.names = loading;
    loading.catch(() => { if (secState.names === loading) secState.names = null; });
  }
  return secState.names;
}

/** Nasdaq Trader symbol directories for the N-PORT rows (shared nport-reader `readUsListings`), loaded once per run: a row with a
 * foreign ISIN keeps a ticker only for the company's own U.S. listing in U.S. dollars (Linde, NXP, IMAX). null when either failed. */
let usListings: Promise<Map<string, string> | null> | null = null;
function loadUsListings(getText: (url: string, label: string) => Promise<string>): Promise<Map<string, string> | null> {
  if (!usListings) usListings = readUsListings(getText);
  return usListings;
}

/**
 * The Northern Trust holdings sheet of an N-PORT filing: HOLDINGS_HEADERS, plus Coupon and Maturity (Mon DD YYYY) when the
 * filing holds debt, in the published order (compareHoldingRows). A missing number stays empty (never 0), a missing text is
 * '-'. Tickers come from nportTickers (U.S. common stock only: SEC files some preferred shares under the common stock's
 * symbol), so a preferred, debt, fund or derivative row is keyed by its Identifier.
 */
export function nportHoldingsSheet(filing: NportFiling, tickers: ReadonlyArray<string>): { headers: string[]; rows: JsonRecord[] } {
  const debt = filing.positions.some((position) => Boolean(position.maturity) || position.coupon !== null);
  const rows: JsonRecord[] = filing.positions.map((position, index) => ({
    Name: position.name || '-',
    Ticker: tickers[index] || '-',
    Identifier: nportIdentifier(position) || '-',
    Weight: nportCell(position.weight),
    'Market Value': nportCell(position.value, 2),
    'Shares Held': nportCell(position.balance),
    'Asset Category': position.assetCat || '-',
    ...(debt ? { Coupon: nportCell(position.coupon), Maturity: position.maturity ? formatEdgarDate(position.maturity) : '' } : {}),
  }));
  rows.sort(compareHoldingRows);
  return { headers: debt ? BOND_SHEET_HEADERS : HOLDINGS_HEADERS, rows };
}

// ---------------------------------------------------------------------------
// Yahoo chart layer: daily history, distributions, quote meta
// ---------------------------------------------------------------------------

// adjCloseRaw: Yahoo's unrounded value, only used to tell float noise from a real change (never persisted).
export type ChartDay = { date: string; close: number; adjClose: number; volume: number; adjCloseRaw?: number };

export type ParsedChart = {
  exchangeName: string;
  longName: string;
  navPrice: number | null;
  regularMarketPrice: number | null;
  regularMarketTime: number | null;
  firstTradeDate: number | null;
  days: ChartDay[];
  dividends: Array<{ epoch: number; amount: number }>;
};

export function parseChart(payload: JsonRecord): ParsedChart {
  const result = (payload?.chart?.result || [])[0] as JsonRecord | undefined;
  if (!result) throw new Error('chart: empty result');
  const meta = (result.meta || {}) as JsonRecord;
  const timestamps: number[] = result.timestamp || [];
  const quote = ((result.indicators || {}).quote || [])[0] as JsonRecord | undefined;
  const adj = ((result.indicators || {}).adjclose || [])[0] as JsonRecord | undefined;
  const closes: unknown[] = (quote && quote.close) || [];
  const volumes: unknown[] = (quote && quote.volume) || [];
  const adjCloses: unknown[] = (adj && adj.adjclose) || closes;
  const days: ChartDay[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (typeof close !== 'number' || !Number.isFinite(close)) continue;
    const adjClose = typeof adjCloses[i] === 'number' && Number.isFinite(adjCloses[i] as number) ? (adjCloses[i] as number) : close;
    days.push({
      date: epochToIsoDate(timestamps[i]),
      close: round(close, 6),
      // Yahoo recomputes the split/dividend-adjusted close on every request;
      // at 6 decimals the last digit or two jitters between otherwise
      // identical requests, making every history row (and the fund) look
      // "updated" on every single run. 2 decimals is well past any
      // meaningful precision for a price and absorbs that jitter.
      adjClose: round(adjClose, 2),
      volume: typeof volumes[i] === 'number' ? (volumes[i] as number) : 0,
      adjCloseRaw: adjClose,
    });
  }
  const events = ((result.events || {}) as JsonRecord).dividends as Record<string, JsonRecord> | undefined;
  const dividends = Object.values(events || {})
    .map((event) => ({ epoch: Number(event.date), amount: Number(event.amount) }))
    .filter((event) => Number.isFinite(event.epoch) && Number.isFinite(event.amount) && event.amount > 0)
    .sort((a, b) => a.epoch - b.epoch);
  return {
    exchangeName: String(meta.fullExchangeName || meta.exchangeName || ''),
    longName: String(meta.longName || meta.shortName || ''),
    navPrice: numberOrNull(meta.navPrice),
    regularMarketPrice: numberOrNull(meta.regularMarketPrice) ?? numberOrNull(meta.previousClose),
    regularMarketTime: numberOrNull(meta.regularMarketTime),
    firstTradeDate: numberOrNull(meta.firstTradeDate),
    days,
    dividends,
  };
}

export function chartUrl(ticker: string, config: Pick<UpdaterConfig, 'historyRange'>, nowMs: number = Date.now()): string {
  // Explicit period1/period2: `range=max` silently downgrades to monthly bars.
  const period2 = Math.floor(nowMs / 1000);
  let period1 = 0; // "max"
  const yearsMatch = /^(\d+)y$/i.exec(config.historyRange.trim());
  if (yearsMatch) period1 = Math.floor(period2 - Number(yearsMatch[1]) * 365.25 * 86_400);
  return `${YAHOO_CHART_URL}/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d&events=div%7Csplit`;
}

// ---------------------------------------------------------------------------
// Derived catalog metrics (unit-tested helpers, sibling parity)
// ---------------------------------------------------------------------------

// (1 + CAGR)^n - 1 — the exact inverse of annualizing (same helper as SPDR).
export function annualizedToTotal(annualizedPercent: number | null | undefined, years: number): number | null {
  if (typeof annualizedPercent !== 'number' || !Number.isFinite(annualizedPercent)) return null;
  if (years <= 0) return null;
  return round(((1 + annualizedPercent / 100) ** years - 1) * 100, 2);
}

export function totalToAnnualized(totalPercent: number | null | undefined, years: number): number | null {
  if (typeof totalPercent !== 'number' || !Number.isFinite(totalPercent)) return null;
  if (years <= 0) return null;
  return round(((1 + totalPercent / 100) ** (1 / years) - 1) * 100, 2);
}

// Indicated yield: latest distribution x payments per year / price — used only
// when the product list publishes no trailing-12-month yield for the fund.
export function indicatedYield(
  latestDistribution: number | null | undefined,
  paymentsPerYear: number | null | undefined,
  price: number | null | undefined,
): number | null {
  if (typeof latestDistribution !== 'number' || typeof paymentsPerYear !== 'number' || typeof price !== 'number') return null;
  if (!Number.isFinite(latestDistribution) || !Number.isFinite(paymentsPerYear) || !Number.isFinite(price) || price <= 0) return null;
  if (paymentsPerYear <= 0 || latestDistribution <= 0) return null;
  return round(((latestDistribution * paymentsPerYear) / price) * 100, 2);
}

export function inferDistributionFrequency(
  dividends: Array<{ epoch: number; amount: number }>,
): { frequency: string; paymentsPerYear: number | null } {
  if (!dividends.length) return { frequency: 'None', paymentsPerYear: null };
  const recent = dividends.slice(-9);
  if (recent.length < 2) return { frequency: 'Unknown', paymentsPerYear: null };
  const gapsDays: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const gap = (recent[i].epoch - recent[i - 1].epoch) / 86_400;
    if (gap > 14 && gap < 400) gapsDays.push(gap);
  }
  if (!gapsDays.length) return { frequency: 'Unknown', paymentsPerYear: null };
  gapsDays.sort((a, b) => a - b);
  const medianGap = gapsDays[Math.floor(gapsDays.length / 2)];
  if (medianGap >= 300) return { frequency: 'Annually', paymentsPerYear: 1 };
  if (medianGap >= 150) return { frequency: 'Semi-annually', paymentsPerYear: 2 };
  if (medianGap >= 75) return { frequency: 'Quarterly', paymentsPerYear: 4 };
  if (medianGap >= 25) return { frequency: 'Monthly', paymentsPerYear: 12 };
  return { frequency: 'Irregular', paymentsPerYear: null };
}

export type PriceReturns = {
  asOfDate: string;
  ytd: number | null;
  yr1: number | null;
  cagr3y: number | null;
  cagr5y: number | null;
  cagr10y: number | null;
  siAnn: number | null;
  mo1: number | null;
  qtd: number | null;
};

const EMPTY_PRICE_RETURNS: PriceReturns = {
  asOfDate: '', ytd: null, yr1: null, cagr3y: null, cagr5y: null, cagr10y: null, siAnn: null, mo1: null, qtd: null,
};

function pctChange(start: number, end: number): number {
  return round(((end - start) / start) * 100, 2);
}

function annualized(start: number, end: number, years: number): number | null {
  if (start <= 0 || years <= 0) return null;
  return round(((end / start) ** (1 / years) - 1) * 100, 2);
}

// Total returns from an adjusted daily series anchored to the last trading day
// at or before `now`. The series is the official Northern Trust NAV with published
// distributions reinvested (or Yahoo adjusted closes in the fallback path).
// Northern Trust publishes official returns for most funds, so these only fill the
// gaps (young funds, quarter-to-date) and drive the History-derived blocks.
export function priceReturns(days: ChartDay[], now = new Date(), coveredFrom: string | null = null): PriceReturns {
  const empty: PriceReturns = { ...EMPTY_PRICE_RETURNS };
  if (!days.length) return empty;
  const last = days[days.length - 1];
  // A window is derivable only when its anchor day lies inside the span the
  // adjusted series covers (see reinvestmentCoverageStart).
  const anchored = (day: ChartDay | null): day is ChartDay => day !== null && day.date < last.date && (coveredFrom === null || day.date >= coveredFrom);
  const lastEpoch = Date.parse(`${last.date}T00:00:00Z`) / 1000;
  const atOrBefore = (iso: string): ChartDay | null => {
    const target = Date.parse(`${iso}T00:00:00Z`) / 1000;
    if (Number.isNaN(target)) return null;
    let found: ChartDay | null = null;
    for (const day of days) {
      if (Date.parse(`${day.date}T00:00:00Z`) / 1000 <= target) found = day;
      else break;
    }
    return found;
  };
  const yearsAgo = (years: number): ChartDay | null => {
    const date = new Date(now.getTime());
    date.setUTCFullYear(date.getUTCFullYear() - years);
    return atOrBefore(date.toISOString().slice(0, 10));
  };
  const ytdStart = atOrBefore(`${now.getUTCFullYear()}-01-01`);
  const mo1Start = new Date(now.getTime() - 31 * 86_400_000).toISOString().slice(0, 10);
  const quarterStart = `${now.getUTCFullYear()}-${String(Math.floor(now.getUTCMonth() / 3) * 3 + 1).padStart(2, '0')}-01`;
  const year1 = yearsAgo(1);
  const year3 = yearsAgo(3);
  const year5 = yearsAgo(5);
  const year10 = yearsAgo(10);
  const first = days[0];
  const siYears = (lastEpoch - Date.parse(`${first.date}T00:00:00Z`) / 1000) / (365.25 * 86_400);
  const mo1StartDay = atOrBefore(mo1Start);
  const qtdStartDay = atOrBefore(quarterStart);
  return {
    asOfDate: last.date,
    ytd: anchored(ytdStart) && ytdStart.adjClose > 0 ? pctChange(ytdStart.adjClose, last.adjClose) : null,
    yr1: anchored(year1) ? pctChange(year1.adjClose, last.adjClose) : null,
    cagr3y: anchored(year3) ? annualized(year3.adjClose, last.adjClose, 3) : null,
    cagr5y: anchored(year5) ? annualized(year5.adjClose, last.adjClose, 5) : null,
    cagr10y: anchored(year10) ? annualized(year10.adjClose, last.adjClose, 10) : null,
    siAnn: siYears >= 1 && anchored(first) ? annualized(first.adjClose, last.adjClose, siYears) : null,
    mo1: anchored(mo1StartDay) ? pctChange(mo1StartDay.adjClose, last.adjClose) : null,
    qtd: anchored(qtdStartDay) ? pctChange(qtdStartDay.adjClose, last.adjClose) : null,
  };
}

export function lastCompletedQuarterEnd(now = new Date()): Date {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based
  if (month <= 2) return new Date(Date.UTC(year - 1, 11, 31)); // Jan-Mar -> Dec 31
  if (month <= 5) return new Date(Date.UTC(year, 2, 31)); // Apr-Jun -> Mar 31
  if (month <= 8) return new Date(Date.UTC(year, 5, 30)); // Jul-Sep -> Jun 30
  return new Date(Date.UTC(year, 8, 30)); // Oct-Dec -> Sep 30
}

/** A strict YYYY-MM-DD calendar date, or null (never an empty string). */
export function isoDateOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && calendarIso(value) === value ? value : null;
}

/** Honest, never-empty label of how `metrics` returns were computed (STANDARD.md 9a). */
export function returnsBasisLabel(hasOfficial: boolean): string {
  return hasOfficial
    ? 'official Northern Trust NAV total returns (funds-list JSON + full-data CSV), any missing figure filled from the daily NAV history with distributions reinvested (performanceAsOf is the official month-end table date, filled periods end at returns.monthEnd.priceReturnsAsOf)'
    : 'derived from the daily NAV history with published distributions reinvested (or Yahoo adjusted closes), not official NAV returns; performanceAsOf is the last history date (null when the fund has no return yet)';
}

/** Parses the published "Aug 31 2026" label back to ISO, or null. */
export function labelToIsoDate(label: unknown): string | null {
  const text = String(label ?? '');
  return /^[A-Za-z]{3} \d{2} \d{4}$/.test(text) ? calendarIso(text) : null;
}

/**
 * Makes a previously published index row satisfy the metrics contract
 * (STANDARD.md 9a) without refetching: keeps a valid basis and date, otherwise
 * derives them from the stored returns block. Both fields end up last.
 */
export function ensureMetricsContract(row: JsonRecord, lastHistoryDate: string | null = null): JsonRecord {
  const { returnsBasis, performanceAsOf, ...rest } = ((row.metrics as JsonRecord) || {}) as JsonRecord;
  const old = typeof returnsBasis === 'string' ? returnsBasis.trim() : '';
  const official = /^official/.test(old);
  const derived = /^derived/.test(old);
  const basis = official || derived ? returnsBasisLabel(official) : old && old !== '-' ? old : 'previously published returns (basis not recorded)';
  const monthEnd = ((row.returns as JsonRecord)?.monthEnd as JsonRecord) || {};
  const hasReturns = ['ytd', 'tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr5y', 'cagr10y', 'siAnn'].some((key) => typeof (rest as JsonRecord)[key] === 'number');
  const asOf = !hasReturns ? null : isoDateOrNull(performanceAsOf as string | null) ?? (official ? labelToIsoDate(monthEnd.asOfDate) : derived ? isoDateOrNull(lastHistoryDate) : null);
  return { ...row, metrics: { ...rest, returnsBasis: basis, performanceAsOf: asOf } };
}

export const YIELD_BASES = ['official-trailing-12m', 'official-distribution-rate', 'official-other', 'computed-trailing-12m', 'indicated'] as const;
export type YieldBasis = (typeof YIELD_BASES)[number];

/** Valid code or null; anything else (legacy or foreign value) is unknown. */
export function yieldBasisOrNull(value: unknown): YieldBasis | null {
  return (YIELD_BASES as readonly unknown[]).includes(value) ? (value as YieldBasis) : null;
}

/** Maps the stored free-text yield kind of a fund (meta.json yields.dividendYieldKind) to a code. */
export function yieldBasisFromKind(kind: unknown): YieldBasis | null {
  const text = String(kind ?? '');
  if (text.startsWith('12-month dividend yield (official Northern Trust')) return 'official-trailing-12m';
  if (text.startsWith('indicated')) return 'indicated';
  return null;
}

/**
 * Merges the official Northern Trust returns with the ones derived from the adjusted
 * daily series. Official figures win wherever they exist (they are NAV total
 * returns — the same basis the sibling apps publish); derived figures fill
 * the gaps for young funds and for funds Northern Trust lists without returns.
 */
export function deriveCatalogMetrics(
  official: CatalogReturns,
  derived: PriceReturns,
  publishedDividendYield: number | null,
  publishedSecYield: number | null,
  latestDistribution: number | null,
  paymentsPerYear: number | null,
  price: number | null,
  officialCumulative: CumulativeReturns | null = null,
  officialAsOf: string | null = null,
  publishedYieldBasis: YieldBasis | null = null,
): JsonRecord {
  const coalesce = (value: number | null | undefined): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const ytd = coalesce(official.ytd) ?? coalesce(derived.ytd);
  const tr1y = coalesce(official.yr1) ?? coalesce(derived.yr1);
  const cagr3y = coalesce(official.yr3) ?? coalesce(derived.cagr3y);
  const cagr5y = coalesce(official.yr5) ?? coalesce(derived.cagr5y);
  const cagr10y = coalesce(official.yr10) ?? coalesce(derived.cagr10y);
  const siAnn = coalesce(official.sinceInception) ?? coalesce(derived.siAnn);
  const hasOfficial = Object.values(official).some((value) => value !== null);
  const publishedYield = coalesce(publishedDividendYield);
  const dividendYield = publishedYield ?? indicatedYield(latestDistribution, paymentsPerYear, price);
  // the code travels with the yield it describes: null exactly when the yield is null
  const dividendYieldBasis: YieldBasis | null = dividendYield === null
    ? null
    : publishedYield === null ? 'indicated' : publishedYieldBasis ?? 'official-other';
  const text = (value: number | null): string | null => (value === null ? null : `${value.toFixed(2)}%`);
  return {
    ytd,
    tr1y,
    tr3y: coalesce(officialCumulative?.yr3) ?? annualizedToTotal(cagr3y, 3),
    tr5y: coalesce(officialCumulative?.yr5) ?? annualizedToTotal(cagr5y, 5),
    tr10y: coalesce(officialCumulative?.yr10) ?? annualizedToTotal(cagr10y, 10),
    cagr3y,
    cagr5y,
    cagr10y,
    siAnn,
    dividendYield,
    dividendYieldText: text(dividendYield) ?? '—',
    dividendYieldBasis,
    secYield: coalesce(publishedSecYield),
    secYieldText: text(coalesce(publishedSecYield)) ?? '—',
    returnsBasis: returnsBasisLabel(hasOfficial),
    // the date the returns are as of; null when the fund has no return at all (a date without figures is a lie)
    performanceAsOf: [ytd, tr1y, cagr3y, cagr5y, cagr10y, siAnn].every((value) => value === null)
      ? null
      : hasOfficial ? isoDateOrNull(officialAsOf) : isoDateOrNull(derived.asOfDate),
  };
}

// ---------------------------------------------------------------------------
// Eligibility filters (AND logic, iShares semantics)
// ---------------------------------------------------------------------------

function inRange(value: number | null | undefined, range?: Range): boolean {
  if (!range) return true;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (range.min !== undefined && value < range.min) return false;
  if (range.max !== undefined && value > range.max) return false;
  return true;
}

function annualizedValue(metrics: JsonRecord, period: ReturnPeriod): number | null {
  if (period === 'YTD') return numberOrNull(metrics.ytd);
  if (period === '1Y') return numberOrNull(metrics.tr1y);
  return numberOrNull(metrics[`cagr${period.toLowerCase()}`]);
}

function cumulativeValue(metrics: JsonRecord, period: ReturnPeriod): number | null {
  const key = period === 'YTD' ? 'ytd' : period === '1Y' ? 'tr1y' : `tr${period.toLowerCase()}`;
  return numberOrNull(metrics[key]);
}

function fundFilterReasons(
  candidate: { ticker: string; aumValue?: number | null; terValue?: number | null; metrics: JsonRecord },
  config: UpdaterConfig,
): string[] {
  const reasons: string[] = [];
  if (config.tickers.length && !config.tickers.includes(candidate.ticker)) reasons.push('TICKERS');
  if (config.aumRange && !inRange(candidate.aumValue ?? null, config.aumRange)) reasons.push('AUM');
  if (config.terRange && !inRange(candidate.terValue ?? null, config.terRange)) reasons.push('TER');
  if (config.dividendYieldRange && !inRange(numberOrNull(candidate.metrics.dividendYield), config.dividendYieldRange)) {
    reasons.push('DIVIDEND_YIELD');
  }
  if (config.secYieldRange && !inRange(numberOrNull(candidate.metrics.secYield), config.secYieldRange)) reasons.push('SEC_YIELD');
  for (const period of RETURN_PERIODS) {
    const performance = config.performanceRanges[period];
    if (performance && !inRange(annualizedValue(candidate.metrics, period), performance)) reasons.push(`PERFORMANCE_${period}`);
    const total = config.totalReturnRanges[period];
    if (total && !inRange(cumulativeValue(candidate.metrics, period), total)) reasons.push(`TOTAL_RETURN_${period}`);
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Deterministic writers (iShares/SPDR/Fidelity-style)
// ---------------------------------------------------------------------------

// Comparing raw text would treat a run that only refreshed generatedAt (with
// every fund's actual data unchanged) as a real change and rewrite the file
// every time. Compare with both timestamps stripped instead.
export function samePublishedContent(previous: string, value: unknown): boolean {
  const withoutRunTimestamp = (item: unknown): unknown => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const { generatedAt, savedAt, ...content } = item as Record<string, unknown>;
    return content;
  };
  try {
    return JSON.stringify(withoutRunTimestamp(JSON.parse(previous))) === JSON.stringify(withoutRunTimestamp(value));
  } catch { return false; }
}

async function writeIfChanged(file: URL, value: unknown): Promise<boolean> {
  const next = `${JSON.stringify(value, null, 1)}\n`;
  let previous: string | null = null;
  try {
    previous = await readFile(file, 'utf8');
  } catch {
    // First write.
  }
  if (previous === next || (previous !== null && samePublishedContent(previous, value))) return false;
  // tmp file + rename: a killed run leaves the old complete file, never a truncated one
  const tmp = new URL(`${file.href}.${process.pid}.tmp`);
  await writeFile(tmp, next, 'utf8');
  await rename(tmp, file);
  return true;
}

async function writePages(
  dir: URL,
  ticker: string,
  kind: 'holdings' | 'history',
  headers: string[],
  rows: JsonRecord[],
  pageSize: number,
): Promise<{ pages: string[]; pageSize: number; totalRows: number; cleanup: () => Promise<void> }> {
  await mkdir(new URL(`${kind}/`, dir), { recursive: true });
  const pages: string[] = [];
  if (rows.length) {
    const pageCount = Math.ceil(rows.length / pageSize);
    for (let page = 1; page <= pageCount; page++) {
      const slice = rows.slice((page - 1) * pageSize, page * pageSize);
      const name = `${kind}/${pad3(page)}.json`;
      await writeIfChanged(new URL(name, dir), {
        ticker,
        page,
        pageSize,
        totalRows: rows.length,
        headers,
        rows: slice,
      });
      pages.push(name);
    }
  }
  // Stale pages are removed only after the new meta.json is written (see processFund)
  return { pages, pageSize, totalRows: rows.length, cleanup: () => removeStalePages(dir, kind, new Set(pages)) };
}

async function removeStalePages(fundDir: URL, kind: 'holdings' | 'history', kept: Set<string>): Promise<void> {
  const kindDir = new URL(`${kind}/`, fundDir);
  let entries: string[] = [];
  try {
    entries = await readdir(kindDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.endsWith('.json') && !kept.has(`${kind}/${entry}`)) {
      await rm(new URL(entry, kindDir), { force: true });
    }
  }
}

type UpdateState = { cursor: string | null; savedAt: string; scope?: string; partial?: boolean };

async function readUpdateState(): Promise<UpdateState | null> {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8')) as UpdateState;
  } catch {
    return null;
  }
}

/** The filter set a cursor belongs to: a cursor saved for other filters is never reused. */
// Funds this run walks: TICKERS narrows the catalog before the worker pool (funds outside it keep
// their published rows and print no fund line), then the saved cursor rotates the order.
export function runOrder<T extends { ticker: string }>(universe: T[], tickers: string[], cursor: string | null): T[] {
  const selected = universe.filter((fund) => !tickers.length || tickers.includes(fund.ticker));
  const index = cursor ? selected.findIndex((fund) => fund.ticker === cursor) : -1;
  return index >= 0 ? selected.slice(index + 1).concat(selected.slice(0, index + 1)) : selected.slice();
}

export function cursorScope(config: UpdaterConfig): string {
  return JSON.stringify([config.tickers, config.aumRange ?? null, config.terRange ?? null, config.dividendYieldRange ?? null, config.secYieldRange ?? null, config.performanceRanges, config.totalReturnRanges]);
}

async function writeUpdateState(lastProcessedTicker: string | null, scope: string, partial: boolean): Promise<void> {
  await writeIfChanged(STATE_FILE, {
    cursor: lastProcessedTicker,
    scope,
    partial,
    savedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
}

const METRIC_KEYS = [
  'ytd', 'tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr5y', 'cagr10y', 'siAnn',
  'dividendYield', 'dividendYieldText', 'dividendYieldBasis', 'secYield', 'secYieldText', 'returnsBasis', 'performanceAsOf',
] as const;

/** Metrics object with the full contract key set: null for unavailable, never 0. */
export function emptyMetrics(basis = 'not available: this fund has no published metrics yet'): JsonRecord {
  const metrics: JsonRecord = {};
  for (const key of METRIC_KEYS) metrics[key] = null;
  metrics.dividendYieldText = '—';
  metrics.secYieldText = '—';
  metrics.returnsBasis = basis;
  return metrics;
}

/** Same key set everywhere: the code is null exactly when dividendYield is null; legacy rows without a code get it from the stored kind text. */
export function withYieldBasis(metrics: JsonRecord, meta: JsonRecord | null = null): JsonRecord {
  if (numberOrNull(metrics.dividendYield) === null) return { ...metrics, dividendYieldBasis: null };
  const basis = yieldBasisOrNull(metrics.dividendYieldBasis)
    ?? yieldBasisFromKind((meta?.yields as JsonRecord | undefined)?.dividendYieldKind)
    ?? 'official-other';
  return { ...metrics, dividendYieldBasis: basis };
}

async function readPreviousMeta(ticker: string): Promise<JsonRecord | null> {
  try {
    return JSON.parse(await readFile(new URL(`funds/${ticker}/meta.json`, API_ROOT), 'utf8')) as JsonRecord;
  } catch {
    return null;
  }
}

/**
 * Rebuilds an index row from a fund's meta.json, so a crash between the meta and
 * the index write (or a hand-trimmed index) never drops a fund from the feed.
 */
export function indexRowFromMeta(meta: JsonRecord): JsonRecord {
  const ticker = String(meta.ticker);
  const display = (value: unknown): string => (typeof value === 'string' && value ? value : '—');
  const expense = (meta.expenseRatio as JsonRecord) || {};
  const gross = numberOrNull(expense.gross);
  const inceptionIso = (meta.inception as JsonRecord)?.fundInceptionDate as string | null | undefined;
  const distributions = (meta.distributions as JsonRecord) || {};
  const lastDistribution = Array.isArray(distributions.rows) && distributions.rows.length ? distributions.rows[distributions.rows.length - 1] : null;
  const returns = (meta.returns as JsonRecord) || {};
  return {
    ticker,
    name: String(meta.name ?? ticker),
    category: String(meta.category ?? 'ETF'),
    fundPage: (meta.source as JsonRecord)?.fundPage ?? null,
    dataFile: `./funds/${ticker}/meta.json`,
    cusip: (meta.identifiers as JsonRecord)?.cusip ?? null,
    isin: (meta.identifiers as JsonRecord)?.isin ?? null,
    ter: display(expense.display),
    terValue: numberOrNull(expense.value),
    terGross: gross === null ? '—' : `${gross}%`,
    terGrossValue: gross,
    nav: display((meta.nav as JsonRecord)?.display),
    navValue: numberOrNull((meta.nav as JsonRecord)?.value),
    aum: display((meta.aum as JsonRecord)?.display),
    aumValue: numberOrNull((meta.aum as JsonRecord)?.value),
    asOfDate: (meta.nav as JsonRecord)?.asOfDate ?? '—',
    inceptionDate: inceptionIso ? formatEdgarDate(inceptionIso) : '—',
    exchange: (meta.inception as JsonRecord)?.exchange ?? '',
    closePrice: display((meta.marketPrice as JsonRecord)?.display),
    closePriceValue: numberOrNull((meta.marketPrice as JsonRecord)?.value),
    premiumDiscount: display((meta.premiumDiscount as JsonRecord)?.display),
    premiumDiscountValue: numberOrNull((meta.premiumDiscount as JsonRecord)?.value),
    distributions: {
      frequency: distributions.frequency ?? '—',
      exDate: lastDistribution ? lastDistribution[0] : '—',
      dividend: lastDistribution ? lastDistribution[1] : '—',
    },
    returns: { monthEnd: returns.monthEnd ?? {}, quarterEnd: returns.quarterEnd ?? null },
    metrics: withYieldBasis(
      (meta.metrics as JsonRecord) ?? emptyMetrics('rebuilt from meta.json without stored metrics: refreshed by the next run'),
      meta,
    ),
    holdings: numberOrNull((meta.holdings as JsonRecord)?.totalRows) ?? 0,
    history: numberOrNull((meta.history as JsonRecord)?.totalRows) ?? 0,
  };
}

async function readPreviousIndex(): Promise<Map<string, JsonRecord>> {
  const map = new Map<string, JsonRecord>();
  try {
    const payload = JSON.parse(await readFile(INDEX_FILE, 'utf8')) as JsonRecord;
    for (const fund of payload.funds || []) {
      if (fund && typeof fund.ticker === 'string') map.set(fund.ticker, fund);
    }
  } catch {
    // First run.
  }
  // Every fund with a meta.json belongs to the feed, even when the index lost its row.
  let tickers: string[] = [];
  try {
    tickers = await readdir(new URL('funds/', API_ROOT));
  } catch {
    // No funds yet.
  }
  for (const ticker of tickers.sort()) {
    if (map.has(ticker)) continue;
    const meta = await readPreviousMeta(ticker);
    if (meta && typeof meta.ticker === 'string') map.set(ticker, indexRowFromMeta(meta));
  }
  return map;
}

async function readPreviousSheet(ticker: string, kind: 'holdings' | 'history'): Promise<JsonRecord[]> {
  const rows: JsonRecord[] = [];
  let page = 1;
  for (;;) {
    let payload: JsonRecord;
    try {
      payload = JSON.parse(await readFile(new URL(`funds/${ticker}/${kind}/${pad3(page)}.json`, API_ROOT), 'utf8')) as JsonRecord;
    } catch {
      return rows;
    }
    rows.push(...(payload.rows || []));
    const totalRows = numberOrNull(payload.totalRows);
    if (totalRows !== null && rows.length >= totalRows) return rows;
    if (!(payload.rows || []).length) return rows;
    page += 1;
  }
}

// Tickers that received at least one fresh source in this run (see runUpdater's exit status).
const freshTickers = new Set<string>();

/** True when the published history is the official NAV sheet (not the Yahoo fallback schema). */
async function officialHistoryPublished(ticker: string): Promise<boolean> {
  return (await readPreviousSheetHeaders(ticker, 'history')).includes('NAV');
}

async function readPreviousSheetHeaders(ticker: string, kind: 'holdings' | 'history'): Promise<string[]> {
  try {
    const payload = JSON.parse(await readFile(new URL(`funds/${ticker}/${kind}/${pad3(1)}.json`, API_ROOT), 'utf8')) as JsonRecord;
    return Array.isArray(payload.headers) ? (payload.headers as string[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fund assembly
// ---------------------------------------------------------------------------

// Official history rows (newest last, like the sibling Yahoo-based sheets):
// the NAV, the closing market price and the premium/discount Northern Trust
// publishes for every business day since inception.
function officialHistoryRows(points: HistoryPoint[]): JsonRecord[] {
  return points.map((point) => ({
    Date: formatEdgarDate(point.date),
    NAV: point.nav === null ? '' : String(point.nav),
    'Market Price': point.marketPrice === null ? '' : String(point.marketPrice),
    'Premium/Discount': point.premiumDiscount === null ? '' : String(point.premiumDiscount),
  }));
}

// Yahoo's adjusted close is float32 and its last digits move with the request's period2, so a value
// sitting on a cent boundary (31.544998 vs 31.545001) flips between runs. Within that noise the
// published cent is kept: a rerun with the same source data changes nothing.
export const ADJ_CLOSE_NOISE = 1e-4;
export function keepPublishedAdjClose(days: ChartDay[], previous: JsonRecord[]): ChartDay[] {
  const published = new Map<string, number>();
  for (const row of previous) {
    const adjClose = numberOrNull(row['Adj Close']);
    if (adjClose !== null) published.set(String(row.Date), adjClose);
  }
  return days.map((day) => {
    const prior = published.get(formatEdgarDate(day.date));
    if (prior === undefined || prior === day.adjClose) return day;
    return Math.abs((day.adjCloseRaw ?? day.adjClose) - prior) <= 0.005 + ADJ_CLOSE_NOISE ? { ...day, adjClose: prior } : day;
  });
}

// Yahoo fallback rows, identical to the sibling feeds.
function historyRows(days: ChartDay[]): JsonRecord[] {
  return days.map((day) => ({
    Date: formatEdgarDate(day.date),
    Close: String(day.close),
    'Adj Close': String(day.adjClose),
    Volume: String(day.volume),
  }));
}

// Array rows (not objects): meta.distributions feeds renderDistributionsTable
// directly, same as the sibling worksheet shape.
function distributionRows(dividends: Array<{ epoch: number; amount: number }>): string[][] {
  return dividends.map((dividend) => [formatUsDate(dividend.epoch), String(round(dividend.amount, 6))]);
}

function mergeOfficial(primary: CatalogReturns | null, secondary: CatalogReturns | null): CatalogReturns {
  const pick = (key: keyof CatalogReturns): number | null => primary?.[key] ?? secondary?.[key] ?? null;
  return { ytd: pick('ytd'), yr1: pick('yr1'), yr3: pick('yr3'), yr5: pick('yr5'), yr10: pick('yr10'), sinceInception: pick('sinceInception') };
}

function returnsBlock(
  derived: PriceReturns,
  official: CatalogReturns,
  officialMo1: number | null,
  asOfDate: string | null,
  quarterEnd: CatalogReturns,
  quarterEndAsOfDate: string | null,
  previous: JsonRecord,
): JsonRecord | null {
  const hasOfficial = Object.values(official).some((value) => value !== null);
  const hasDerived = Boolean(derived.asOfDate);
  if (!hasOfficial && !hasDerived) return (previous.returns as JsonRecord) ?? null;
  const text = (value: number | null | undefined): string => (value === null || value === undefined ? '—' : `${value.toFixed(2)}%`);
  // The label must match the numbers: the official date only when an official figure exists, the
  // date of the adjusted series otherwise; mo1/qtd and derived tenors carry priceReturnsAsOf.
  const hasOfficialFigure = hasOfficial || officialMo1 !== null;
  const asOf = hasOfficialFigure ? asOfDate || derived.asOfDate : derived.asOfDate || asOfDate;
  const mo1 = officialMo1 ?? derived.mo1;
  const hasQuarterEnd = Object.values(quarterEnd).some((value) => value !== null);
  const quarterAnchor = quarterEndAsOfDate || lastCompletedQuarterEnd().toISOString().slice(0, 10);
  return {
    derivedFrom: hasOfficial
      ? `official Northern Trust NAV total returns (funds-list JSON + full-data CSV); ${officialMo1 === null ? 'mo1/qtd' : 'qtd'} derived from the daily NAV history with published distributions reinvested`
      : hasDerived && derived.asOfDate
        ? 'derived from the official daily NAV history with published distributions reinvested (NAV total return), not official published returns'
        : 'adjusted market-price closes (Yahoo chart API), not official NAV returns',
    monthEnd: {
      asOfDate: asOf ? formatEdgarDate(asOf) : '—',
      // qtd (and every figure not published officially) is computed from the daily NAV history up to
      // this date, which is later than the official month-end in asOfDate
      priceReturnsAsOf: derived.asOfDate ? formatEdgarDate(derived.asOfDate) : null,
      mo1,
      mo1Text: text(mo1),
      qtd: derived.qtd,
      qtdText: text(derived.qtd),
      ytd: official.ytd ?? derived.ytd,
      ytdText: text(official.ytd ?? derived.ytd),
      yr1: official.yr1 ?? derived.yr1,
      yr1Text: text(official.yr1 ?? derived.yr1),
      yr3: official.yr3 ?? derived.cagr3y,
      yr3Text: text(official.yr3 ?? derived.cagr3y),
      yr5: official.yr5 ?? derived.cagr5y,
      yr5Text: text(official.yr5 ?? derived.cagr5y),
      yr10: official.yr10 ?? derived.cagr10y,
      yr10Text: text(official.yr10 ?? derived.cagr10y),
      sinceInception: official.sinceInception ?? derived.siAnn,
      sinceInceptionText: text(official.sinceInception ?? derived.siAnn),
    },
    quarterEnd: hasQuarterEnd
      ? {
          asOfDate: formatEdgarDate(quarterAnchor),
          ytd: quarterEnd.ytd,
          yr1: quarterEnd.yr1,
          yr3: quarterEnd.yr3,
          yr5: quarterEnd.yr5,
          yr10: quarterEnd.yr10,
          sinceInception: quarterEnd.sinceInception,
        }
      : { asOfDate: formatEdgarDate(quarterAnchor), ytd: null, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null },
  };
}

async function storeRaw(ticker: string, name: string, payload: unknown): Promise<void> {
  const rawDir = new URL(`raw/${ticker}/`, API_ROOT);
  await mkdir(rawDir, { recursive: true });
  await writeFile(new URL(name, rawDir), `${JSON.stringify(payload, null, 1)}\n`, 'utf8');
}

async function processFund(
  fund: CatalogFund,
  config: UpdaterConfig,
  previous: JsonRecord,
): Promise<JsonRecord | 'kept' | null> {
  const ticker = fund.ticker;

  // Filters run against fresh catalog values (or the previous catalog when
  // etfs.ntam.northerntrust.com is unavailable) before any per-fund download happens.
  const preMetrics = deriveCatalogMetrics(
    fund.returns,
    EMPTY_PRICE_RETURNS,
    fund.dividendYield ?? numberOrNull((previous.metrics as JsonRecord)?.dividendYield),
    fund.secYield,
    null,
    null,
    fund.close,
  );
  const reasons = fundFilterReasons(
    { ticker, aumValue: fund.netAssets ?? numberOrNull(previous.aumValue), terValue: fund.ter ?? numberOrNull(previous.terValue), metrics: preMetrics },
    config,
  );
  if (reasons.length) {
    return null;
  }

  const fundDir = new URL(`funds/${ticker}/`, API_ROOT);
  const previousMeta = await readPreviousMeta(ticker);
  // SKIP_NORTHERNTRUST: a fund with a published state keeps it as a whole (files and index row untouched). Rebuilding
  // it without the Northern Trust downloads would mix the index row's subset (no net TER, no distribution rows, no
  // inception) into meta.json; the SEC/Yahoo fallbacks are only for funds without published data.
  if (config.skipNorthernTrust && previousMeta) return 'kept';

  const catalogCusip = fund.cusip || String((previous as JsonRecord).cusip ?? '');

  // 1) Full-data CSV (fund facts + official returns), the fund-snapshot JSON
  //    and the daily holdings CSV; SEC Form N-PORT-P as the holdings fallback.
  let product: NorthernTrustFacts | null = null;
  if (!config.skipNorthernTrust) {
    try {
      const allCsv = await fetchText(northernTrustAllCsvUrl(ticker), `[ product  ] ${ticker}`, northernTrustHeaders(), config);
      let charts: JsonRecord | null = null;
      try {
        charts = await fetchJson(northernTrustEtfChartsJsonUrl(ticker), `[ product  ] ${ticker}`, northernTrustHeaders(), config);
      } catch (error) {
        outputNote(`[ product  ] ${ticker}: fund-snapshot JSON unavailable (${errorMessage(error)}) — asset type from the catalog`);
      }
      product = parseNorthernTrustFacts(allCsv, charts, ticker);
      if (config.storeRawDownloads) {
        await storeRaw(ticker, `all-${(product.navDate || 'latest').replace(/-/g, '')}.csv`, allCsv);
        if (charts) await storeRaw(ticker, `etfcharts-${(product.navDate || 'latest').replace(/-/g, '')}.json`, charts);
      }
      try {
        const holdingsCsv = await fetchText(northernTrustHoldingsCsvUrl(ticker), `[ holdings ] ${ticker}`, northernTrustHeaders(), config);
        const parsed = parseNorthernTrustHoldings(holdingsCsv, ticker, await loadUsListings((url, label) => fetchText(url, `[ holdings ] ${label}`, secHeaders(config), config)));
        if (parsed) {
          product.holdings = parsed;
          if (config.storeRawDownloads) await storeRaw(ticker, `holdings-${(parsed.asOfDate || 'latest').replace(/-/g, '')}.csv`, holdingsCsv);
        } else {
          outputNote(`[ holdings ] ${ticker}: holdings CSV lists no positions${config.edgarFallback ? ' — trying SEC EDGAR N-PORT-P' : ''}`);
        }
      } catch (error) {
        // a missing file (404) means "no positions"; any other failure of a fund that already has a
        // published state keeps that whole state
        if (previousMeta && !isNotFound(error)) throw new Error(`${errorMessage(error)} - kept the previous complete state of ${ticker}`);
        outputNote(`[ holdings ] ${ticker}: ${errorMessage(error)}${config.edgarFallback ? ' — trying SEC EDGAR N-PORT-P' : ''}`);
      }
    } catch (error) {
      // A fund that already has a complete published state keeps it as a whole: never new catalog
      // values next to stale holdings, returns or history (the SEC/Yahoo fallbacks are for new funds).
      if (previousMeta) throw new Error(`${errorMessage(error)} - kept the previous complete state of ${ticker}`);
      outputNote(`[ product  ] ${ticker}: ${errorMessage(error)}${config.edgarFallback ? ' — holdings via SEC EDGAR N-PORT-P' : ''}`);
    }
  }

  let holdings: ParsedHoldings | null = product?.holdings ?? null;
  let holdingsSource = 'etfs.ntam.northerntrust.com daily holdings CSV (full positions with CUSIP/ISIN/SEDOL identifiers)';
  let holdingsDownload = northernTrustHoldingsCsvUrl(ticker);
  let nport: NportFiling | null = null;
  // Weights that arrived as fractions instead of percent are normalized once.
  if (holdings) holdings.rows = weightsAsPercent(holdings.rows);

  if (!holdings && config.edgarFallback) {
    try {
      // The fund's own newest filing, read only when strictly newer than the published holdings (shared nport-reader
      // block). A fund missing from SEC's fund ticker table (a new Northern Funds ETF) is found by its name among the
      // registrant's filings: Northern Funds files about 47 series per report period.
      const ref = (await loadFundTickerTable(config)).get(ticker);
      const published = (previousMeta?.holdings as JsonRecord | undefined) ?? {};
      const read = await readNportHoldings(
        ref ? { ticker, cik: ref.cik, seriesId: ref.seriesId } : { ticker, cik: northernTrustCikFor(ticker), name: fund.name },
        { asOf: calendarIso(published.asOfDate) ?? published.asOfDate, rows: numberOrNull(published.totalRows) ?? 0 },
        (url, label) => fetchText(url, `[ nport    ] ${label}`, secHeaders(config), config),
        { cache: secState.reader, ...(ref ? {} : { maxDocuments: 50 }) },
      );
      if ('problem' in read) outputNote(`[ nport    ] ${read.problem} — keeping previous holdings`);
      else {
        const sheet = nportHoldingsSheet(read.filing, nportTickers(read.filing.positions, await loadCompanyNames(config).catch(() => null), await loadUsListings((url, label) => fetchText(url, `[ nport    ] ${label}`, secHeaders(config), config))));
        nport = read.filing;
        holdings = { asOfDate: read.filing.repPdDate || null, headers: sheet.headers, rows: sheet.rows };
        holdingsDownload = read.url;
        holdingsSource = `SEC EDGAR Form N-PORT-P (accession ${read.candidate.accession}, report period ${read.filing.repPdDate || 'n/a'})`;
      }
    } catch (error) {
      outputNote(`[ nport    ] ${ticker}: ${errorMessage(error)} — keeping previous holdings`);
    }
  }

  // Kept holdings keep the source line and download they were published from (an N-PORT sheet stays labelled N-PORT)
  if (!holdings && previousMeta) {
    holdingsSource = String((previousMeta.holdings as JsonRecord | undefined)?.source ?? holdingsSource);
    holdingsDownload = String((previousMeta.source as JsonRecord | undefined)?.holdingsDownload ?? holdingsDownload);
  }

  // Fresh holdings (CSV or N-PORT) that look broken (no weight column, non-numeric weights, a bad weight sum,
  // half the rows gone) never replace the published ones: the fund keeps its previous complete state and fails.
  if (holdings) {
    // Q24: an all-blank weight sheet never replaces a published sheet with numeric weights, whatever is relaxed
    const publishedWeights = previousMeta ? holdingsWeightCount(await readPreviousSheetHeaders(ticker, 'holdings'), await readPreviousSheet(ticker, 'holdings')) : null;
    const holdingsProblem = holdingsGuard(holdings.headers, holdings.rows, numberOrNull((previousMeta?.holdings as JsonRecord | undefined)?.totalRows), HOLDINGS_GUARD_RELAX[ticker] ?? HOLDINGS_GUARD_RELAX['*'] ?? [], publishedWeights);
    if (holdingsProblem) throw new Error(`holdings guard: ${holdingsProblem} - ${previousMeta ? `kept the previous complete state of ${ticker}` : 'no data published for this fund yet'}`);
  }

  const holdingsRows: JsonRecord[] = holdings ? holdings.rows : await readPreviousSheet(ticker, 'holdings');
  const holdingsHeaders = holdings?.headers.length
    ? holdings.headers
    : (await readPreviousSheetHeaders(ticker, 'holdings')) || HOLDINGS_HEADERS;
  // kept holdings keep their published date (the index row's holdings field is a row count, not the sheet)
  const holdingsAsOf = holdings?.asOfDate || (((previousMeta?.holdings as JsonRecord | undefined)?.asOfDate as string | undefined) ?? null);

  // 2) Daily pricing JSON (official NAV / market price history) + the
  //    distributions CSV (dividend schedule); the Yahoo chart only as the
  //    fallback. Quarter-end returns come from the full-data CSV above.
  let historical: ParsedHistoricalData | null = null;
  if (!config.skipNorthernTrust) {
    try {
      const payload = await fetchJson(northernTrustPricingJsonUrl(ticker), `[ history  ] ${ticker}`, northernTrustHeaders(), config);
      const points = parseNorthernTrustPricing(payload, ticker);
      let officialDividends: OfficialDividend[] = [];
      try {
        const distCsv = await fetchText(northernTrustDistributionsCsvUrl(ticker), `[ history  ] ${ticker}`, northernTrustHeaders(), config);
        officialDividends = parseNorthernTrustDistributionsCsv(distCsv, ticker);
        if (config.storeRawDownloads) await storeRaw(ticker, `distributions-${(points.at(-1)?.date || 'latest').replace(/-/g, '')}.csv`, distCsv);
      } catch (error) {
        // a missing distributions file (404) is an honest "none"; any other failure of a fund with a
        // published state keeps that whole state
        if (previousMeta && !isNotFound(error)) throw new Error(`${errorMessage(error)} - kept the previous complete state of ${ticker}`);
        outputNote(`[ history  ] ${ticker}: distributions CSV unavailable (${errorMessage(error)}) — yields from the full-data CSV`);
      }
      historical = {
        points,
        dividends: officialDividends,
        quarterEnd: product?.quarterEnd ?? { ...EMPTY_RETURNS, asOfDate: null, mo1: null, mo3: null },
        quarterEndMarket: product?.quarterEndMarket ?? { ...EMPTY_RETURNS, asOfDate: null, mo1: null, mo3: null },
        monthlyReturns: [],
      };
      if (!historical.points.length) {
        outputNote(`[ history  ] ${ticker}: pricing JSON has no daily rows${config.skipYahoo ? '' : ' — trying the Yahoo chart feed'}`);
        historical = historical.dividends.length || historical.quarterEnd.asOfDate ? historical : null;
      }
      if (config.storeRawDownloads) await storeRaw(ticker, `pricing-${(historical?.points.at(-1)?.date || 'latest').replace(/-/g, '')}.json`, payload);
    } catch (error) {
      if (previousMeta && /kept the previous complete state/.test(errorMessage(error))) throw error;
      if (previousMeta && !isNotFound(error)) throw new Error(`${errorMessage(error)} - kept the previous complete state of ${ticker}`);
      outputNote(`[ history  ] ${ticker}: ${errorMessage(error)}${config.skipYahoo ? ' — keeping previous history' : ' — trying the Yahoo chart feed'}`);
    }
  }

  let chartDays: ChartDay[] = [];
  let history: JsonRecord[] = [];
  let historyHeaders: string[] = HISTORY_HEADERS;
  let dividends: Array<{ epoch: number; amount: number }> = historical?.dividends ?? [];
  let exchangeName = '';
  let navFromChart: number | null = null;
  let priceFromChart: number | null = null;
  let marketTime: number | null = null;
  let firstTradeDate: number | null = null;
  let historySource = 'etfs.ntam.northerntrust.com daily pricing JSON (NAV, market price and premium/discount since inception)';

  let coveredFrom: string | null = null;
  if (historical?.points.length) {
    chartDays = navTotalReturnDays(historical.points, historical.dividends);
    coveredFrom = reinvestmentCoverageStart(historical.points, historical.dividends);
    history = officialHistoryRows(historical.points);
  } else if (!config.skipYahoo && !(await officialHistoryPublished(ticker))) {
    // The Yahoo schema (Date/Close/Adj Close/Volume) never replaces a published official NAV history
    try {
      const fetched = parseChart(await fetchJson(chartUrl(ticker, config), `[ chart    ] ${ticker}`, yahooHeaders(), config));
      const publishedHistory = await readPreviousSheet(ticker, 'history');
      // A HISTORY_RANGE window never shrinks the published history (and with it 3y, 5y, 10y and since inception);
      // a window that does not join the published rows is a failed chart: the published history stays
      const chart = /^\d+y$/i.test(config.historyRange.trim())
        ? mergeWindowedChart(fetched, publishedHistory, Array.isArray(previousMeta?.distributions?.rows) ? previousMeta.distributions.rows : [])
        : fetched;
      if (!chart) throw new Error(`chart window does not join the published history (${config.historyRange})`);
      exchangeName = chart.exchangeName;
      navFromChart = chart.navPrice;
      priceFromChart = chart.regularMarketPrice;
      marketTime = chart.regularMarketTime;
      firstTradeDate = chart.firstTradeDate;
      if (!dividends.length) dividends = chart.dividends;
      chartDays = keepPublishedAdjClose(chart.days, publishedHistory);
      history = historyRows(chartDays);
      historyHeaders = YAHOO_HISTORY_HEADERS;
      historySource = 'Yahoo Finance public chart API (adjusted close)';
    } catch (error) {
      outputNote(`[ chart    ] ${ticker}: ${errorMessage(error)} — keeping previous history`);
    }
  }

  // A new fund that no source answered publishes nothing: it fails and keeps a catalog-only index row (dataFile null).
  const anyFresh = Boolean(product || historical?.points.length || chartDays.length || (holdings && holdings.rows.length));
  if (!anyFresh && !previousMeta) throw new Error(`no source returned data for ${ticker} - no data published for this fund yet`);

  const haveFreshHistory = history.length > 0;
  if (!haveFreshHistory) {
    history = await readPreviousSheet(ticker, 'history');
    const previousHeaders = await readPreviousSheetHeaders(ticker, 'history');
    historyHeaders = previousHeaders.length ? previousHeaders : HISTORY_HEADERS;
  }
  const derivedAll = chartDays.length ? priceReturns(chartDays, new Date(), coveredFrom) : EMPTY_PRICE_RETURNS;

  // The dividend schedule lists the last payments; the product-data "latest
  // dividend" backs it up when the schedule is empty.
  if (!dividends.length && product?.latestDividend) {
    const epoch = isoToEpoch(product.latestDividend.exDate);
    if (epoch !== null) dividends = [{ epoch, amount: product.latestDividend.amount }];
  }
  const latestDividend = dividends.length ? dividends[dividends.length - 1] : null;
  const decodedFrequency = decodeDividendFrequency(product?.frequencyCode);
  const inferredFrequency = dividends.length >= 2 ? inferDistributionFrequency(dividends) : null;
  const frequency =
    decodedFrequency && decodedFrequency.paymentsPerYear !== null
      ? decodedFrequency
      : inferredFrequency && inferredFrequency.paymentsPerYear !== null
        ? inferredFrequency
        : decodedFrequency
          ? decodedFrequency
          : dividends.length
            ? inferDistributionFrequency(dividends)
            : { frequency: String((previous.distributions as JsonRecord)?.frequency || '—'), paymentsPerYear: null };

  // Official returns: full-data CSV month-end "At NAV" (also carries 1-month)
  // backed by the funds-list JSON block; quarter-end from the full-data CSV.
  // The shared "younger than one year" rule (calendar anniversary of the inception, inclusive; an unknown date keeps
  // the value): no 1-year or since-inception return before the first anniversary, no 3, 5 or 10-year one before those,
  // the same for the official month-end and quarter-end tables and the derived figures, so the metrics and both
  // published tables agree. Northern Trust publishes a cumulative since-inception figure for a fund younger than a year.
  const inception = product?.inception ?? fund.inception ?? null;
  const returnsAsOfDate = product?.monthEnd.asOfDate ?? fund.returnsAsOfDate ?? null;
  const OFFICIAL_HORIZONS = { yr1: 1, yr3: 3, yr5: 5, yr10: 10, sinceInception: 1 };
  const official = withoutYoungReturns(mergeOfficial(product?.monthEnd ?? null, fund.returns), inception, returnsAsOfDate, OFFICIAL_HORIZONS);
  const derived = withoutYoungReturns(derivedAll, inception, derivedAll.asOfDate, { yr1: 1, cagr3y: 3, cagr5y: 5, cagr10y: 10, siAnn: 1 });
  const quarterEndSource = historical?.quarterEnd.asOfDate ? historical.quarterEnd : fund.quarterEnd;
  const quarterEndAsOfDate = historical?.quarterEnd.asOfDate ?? fund.quarterEndAsOfDate ?? null;
  const quarterEnd: CatalogReturns = withoutYoungReturns({ ...quarterEndSource }, inception, quarterEndAsOfDate, OFFICIAL_HORIZONS);

  // terValue is the NET expense ratio (after waivers; the only number when just one is published),
  // terGrossValue the GROSS one when published
  const ter = product?.netExpense ?? product?.grossExpense ?? fund.ter ?? numberOrNull(previous.terValue);
  const terGross = product ? product.grossExpense : fund.terGross ?? numberOrNull(previous.terGrossValue);
  const nav = product?.nav ?? fund.nav ?? navFromChart ?? numberOrNull(previous.navValue);
  const price = product?.marketPrice ?? fund.close ?? priceFromChart ?? numberOrNull(previous.closePriceValue);
  const dividendYield = product?.dividendYield ?? fund.dividendYield;
  // a fresh CSV yield is the official trailing 12-month one; a retained yield keeps the code it was stored with
  const publishedYieldBasis: YieldBasis | null = product?.dividendYield !== null && product?.dividendYield !== undefined
    ? 'official-trailing-12m'
    : fund.dividendYield !== null && fund.dividendYield !== undefined
      ? fund.dividendYieldBasis ?? yieldBasisOrNull((previous.metrics as JsonRecord)?.dividendYieldBasis) ?? yieldBasisFromKind((previousMeta?.yields as JsonRecord)?.dividendYieldKind)
      : null;
  const secYield = product?.secYield ?? fund.secYield;

  const metrics = deriveCatalogMetrics(
    official,
    derived,
    dividendYield,
    secYield,
    latestDividend ? latestDividend.amount : null,
    frequency.paymentsPerYear,
    price,
    product?.cumulative ?? null,
    returnsAsOfDate,
    publishedYieldBasis,
  );

  const distributions = dividends.length ? distributionRows(dividends) : (((previous.distributions?.rows as JsonRecord[]) || []) as string[][]);

  // Without a fresh etfs.ntam.northerntrust.com catalog the filed N-PORT-P
  // series name is the most authoritative fund name available.
  const name =
    product?.name || (fund.source !== 'northerntrust' && nport?.seriesName) || fund.name || String(previous.name ?? '') || ticker;
  const premiumDiscount =
    product?.premiumDiscount ?? fund.premiumDiscount ?? (nav && price ? round(((price - nav) / nav) * 100, 2) : null);
  // Fresh etfs.ntam.northerntrust.com net assets win; when the catalog row only
  // comes from the previously published index (site unavailable), the N-PORT-P
  // net assets of the filing we just parsed are the authoritative number.
  const nportValue = nport ? nport.positions.reduce((sum, position) => sum + (position.value ?? 0), 0) : 0;
  const nportNetAssets = nport ? nport.netAssets ?? (nportValue ? round(nportValue, 2) : null) : null;
  const catalogNetAssets = product?.netAssets ?? (fund.source === 'northerntrust' ? fund.netAssets : null);
  const netAssets = catalogNetAssets ?? nportNetAssets ?? fund.netAssets ?? numberOrNull(previous.aumValue);
  const navAsOfDate = product?.navDate ?? fund.asOfDate ?? null;
  const returnsData = returnsBlock(derived, official, product?.monthEnd.mo1 ?? fund.mo1 ?? null, returnsAsOfDate, quarterEnd, quarterEndAsOfDate, previous);
  const asOfLabel = navAsOfDate ? formatEdgarDate(navAsOfDate) : marketTime ? formatEpochDate(marketTime) : String(previous.asOfDate ?? '—');
  const category = product?.assetClass && product.assetClass !== 'ETF' ? product.assetClass : fund.category;
  const benchmark = product?.benchmark || fund.benchmark;
  const exchange = product?.exchange || fund.exchange || exchangeName || String(previous.exchange ?? '');
  const fundPage = northernTrustFundPageUrl(ticker);

  const meta: JsonRecord = {
    ticker,
    name,
    category,
    categoryPath: benchmark ? `${category} / ${benchmark}` : category,
    source: {
      fundPage,
      productData: northernTrustAllCsvUrl(ticker),
      historicalData: northernTrustPricingJsonUrl(ticker),
      holdingsDownload,
      pricesDownload: northernTrustPricingJsonUrl(ticker),
      yahooChart: `${YAHOO_CHART_URL}/${encodeURIComponent(ticker)}`,
      holdingsSource,
      historySource: haveFreshHistory ? historySource : (((previous.source as JsonRecord)?.historySource as string) ?? 'previous run'),
      provider: 'Northern Trust public ETF data (funds-list JSON + per-fund CSV/JSON downloads) + SEC EDGAR Form N-PORT-P (fallback) + Yahoo Finance public chart API (fallback)',
    },
    identifiers: { cusip: product?.cusip || catalogCusip || null, isin: product?.isin || fund.isin || null, indexTicker: benchmark || null },
    inception: {
      fundInceptionDate: inception,
      shareClassInceptionDate: product?.listingDate ?? null,
      exchange: exchange || null,
    },
    expenseRatio: {
      display: ter === null ? '—' : `${ter}%`,
      value: ter,
      gross: terGross,
      net: product?.netExpense ?? null,
    },
    nav: { display: nav === null ? '—' : `$${nav.toFixed(2)}`, value: nav, asOfDate: asOfLabel },
    marketPrice: {
      display: price === null ? '—' : `$${price.toFixed(2)}`,
      value: price,
      asOfDate: product?.marketPriceDate ? formatEdgarDate(product.marketPriceDate) : asOfLabel,
    },
    premiumDiscount: { display: premiumDiscount === null ? '—' : `${premiumDiscount.toFixed(2)}%`, value: premiumDiscount },
    aum: {
      display: netAssets === null ? '—' : formatAumDisplay(netAssets),
      value: netAssets,
      asOfDate:
        catalogNetAssets !== null && (product?.netAssetsDate || navAsOfDate)
          ? formatEdgarDate((product?.netAssetsDate || navAsOfDate) as string)
          : nportNetAssets !== null && nport?.repPdDate
            ? formatEdgarDate(nport.repPdDate)
            : (((previous.aum as JsonRecord)?.asOfDate as string) ?? '—'),
      source:
        catalogNetAssets !== null
          ? product?.netAssets !== null && product?.netAssets !== undefined
            ? 'etfs.ntam.northerntrust.com full-data CSV total net assets'
            : 'etfs.ntam.northerntrust.com funds-list pricing block'
          : nportNetAssets !== null
            ? `SEC Form N-PORT-P net assets (report period ${nport?.repPdDate || 'n/a'})`
            : 'previous run',
    },
    yields: {
      dividendYield: metrics.dividendYield,
      dividendYieldText: metrics.dividendYieldText,
      dividendYieldBasis: metrics.dividendYieldBasis,
      dividendYieldKind:
        product?.dividendYield !== null && product?.dividendYield !== undefined
          ? `${product.dividendYieldKind}${product.dividendYieldDate ? `, as of ${formatEdgarDate(product.dividendYieldDate)}` : ''}`
          : metrics.dividendYield !== null
            ? 'indicated (latest distribution x payments per year / market price)'
            : 'not published: no distributions yet',
      distributionRate: fund.distributionRate,
      secYield: metrics.secYield,
      secYieldText: metrics.secYieldText,
      secYieldKind:
        product?.secYield !== null && product?.secYield !== undefined
          ? `${product.secYieldKind}${product.secYieldDate ? `, as of ${formatEdgarDate(product.secYieldDate)}` : ''}`
          : secYield !== null
            ? 'SEC yield (funds-list pricing block)'
            : 'not published by Northern Trust for this fund',
      unsubsidizedSecYield: product?.unsubsidizedSecYield ?? null,
    },
    returns: returnsData,
    distributions: {
      frequency: frequency.frequency,
      paymentsPerYear: frequency.paymentsPerYear,
      frequencyCode: product?.frequencyCode || null,
      headers: ['Ex-Date', 'Amount'],
      rows: distributions,
    },
  };
  // Order: pages first, then meta.json, stale pages last, the index row at the end of the run
  await mkdir(fundDir, { recursive: true });
  const { cleanup: cleanHoldingsPages, ...holdingsManifest } = await writePages(fundDir, ticker, 'holdings', holdingsHeaders, holdingsRows, config.holdingsPageSize);
  const { cleanup: cleanHistoryPages, ...historyManifest } = await writePages(fundDir, ticker, 'history', historyHeaders, history, config.historyPageSize);
  meta.holdings = { ...holdingsManifest, asOfDate: holdingsAsOf, asOf: holdingsAsOf ? formatEdgarDate(holdingsAsOf) : '—', source: holdingsSource };
  meta.history = { ...historyManifest, asOf: haveFreshHistory && derived.asOfDate ? formatEdgarDate(derived.asOfDate) : (((previous.history as JsonRecord)?.asOf as string) ?? '—'), source: haveFreshHistory ? historySource : 'previous run' };
  meta.metrics = metrics;
  await writeIfChanged(new URL('meta.json', fundDir), meta);
  await cleanHoldingsPages();
  await cleanHistoryPages();
  if (anyFresh) freshTickers.add(ticker);

  const monthEnd = ((returnsData as JsonRecord)?.monthEnd as JsonRecord) || {};
  return {
    ticker,
    name,
    category,
    fundPage,
    dataFile: `./funds/${ticker}/meta.json`,
    cusip: product?.cusip || catalogCusip || null,
    isin: product?.isin || fund.isin || null,
    ter: ter === null ? '—' : `${ter}%`,
    terValue: ter,
    terGross: terGross === null ? '—' : `${terGross}%`,
    terGrossValue: terGross,
    nav: nav === null ? '—' : `$${nav.toFixed(2)}`,
    navValue: nav,
    aum: netAssets === null ? '—' : formatAumDisplay(netAssets),
    aumValue: netAssets,
    asOfDate: asOfLabel,
    inceptionDate: inception
      ? formatEdgarDate(inception)
      : firstTradeDate
        ? formatEpochDate(firstTradeDate)
        : (previous.inceptionDate || '—'),
    exchange,
    closePrice: price === null ? '—' : `$${price.toFixed(2)}`,
    closePriceValue: price,
    premiumDiscount: premiumDiscount === null ? '—' : `${premiumDiscount.toFixed(2)}%`,
    premiumDiscountValue: premiumDiscount,
    distributions: {
      frequency: frequency.frequency,
      exDate: latestDividend ? formatUsDate(latestDividend.epoch) : '—',
      dividend: latestDividend ? String(round(latestDividend.amount, 6)) : '—',
    },
    returns: { monthEnd, quarterEnd: ((returnsData as JsonRecord)?.quarterEnd as JsonRecord) || null },
    metrics,
    holdings: holdingsRows.length,
    history: history.length,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runUpdater(config: UpdaterConfig): Promise<void> {
  requestSleepMs = Math.max(0, config.requestSleep) * 1000;
  nextRequestAtLanes = new Array(Math.max(1, config.concurrency)).fill(0);
  const startedAt = Date.now();
  const deadlineAt = Date.now() + softDeadlineMs;
  freshTickers.clear();
  resetSecState();

  outputPrintConfig('Northern Trust', config);

  // 1) Catalog discovery: funds-list page JSON, previous index, seed.
  const catalog = new Map<string, CatalogFund>();
  let catalogSource = 'previous api/northerntrust/index.json';
  const previousIndex = await readPreviousIndex();

  if (!config.skipNorthernTrust) {
    try {
      const page = await fetchText(config.catalogUrl, '[ catalog  ] funds list', northernTrustHeaders(), config);
      for (const fund of parseNorthernTrustCatalog(page)) catalog.set(fund.ticker, fund);
      if (config.storeRawDownloads) {
        const rawDir = new URL('raw/', API_ROOT);
        await mkdir(rawDir, { recursive: true });
        await writeFile(new URL(`funds-list-${new Date().toISOString().slice(0, 10)}.html`, rawDir), page, 'utf8');
      }
      catalogSource = 'etfs.ntam.northerntrust.com ETF funds-list JSON';
    } catch (error) {
      console.warn(`[ catalog  ] ${errorMessage(error)} — falling back to the published feed`);
    }
  }
  // The live catalog (null when only the published feed is known): a catalog-only row it no longer lists is dropped, never retried.
  const live = catalog.size ? Array.from(catalog.keys()) : null;
  const previousRows = Array.from(previousIndex.values());
  if (!catalog.size) {
    for (const [ticker, row] of previousIndex) catalog.set(ticker, catalogFundFromIndex(ticker, row));
  } else {
    // Funds with published data that disappeared from the download keep their published row (the
    // updater never deletes on a suspiciously small catalog).
    for (const [ticker, row] of previousIndex) {
      if (!catalog.has(ticker) && row.dataFile) catalog.set(ticker, catalogFundFromIndex(ticker, row));
    }
  }
  // Q27: a TICKERS entry outside the live catalog and the published funds stops the run before any fund request
  assertKnownTickers(config.tickers.length ? config.tickers : null, knownTickers(live, previousRows), 'the Northern Trust catalog or published feed');

  // Without the Northern Trust catalog (a failed download or SKIP_NORTHERNTRUST) the run covers only the published
  // feed: the SEC registrant tables also list every Northern Funds mutual fund class, which must never enter the ETF
  // feed. New ETFs arrive with the next good catalog.

  const universe = [...catalog.values()].sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
  if (!universe.length) {
    console.log(
      '[ done     ] nothing to do: etfs.ntam.northerntrust.com is unreachable and the published ' +
        'api/northerntrust/index.json is empty or missing — run this where etfs.ntam.northerntrust.com resolves, e.g. ' +
        'the "Update Northern Trust ETF data" GitHub Actions workflow',
    );
    return;
  }
  console.log(`[ catalog  ] ${universe.length} Northern Trust ETFs (${catalogSource})`);

  // 2) Bounded, resumable batch run over the catalog (iShares/SPDR cursor).
  // A TICKERS run never reads, writes or deletes the cursor (First-Trust rule).
  const useCursor = config.tickers.length === 0;
  const state = useCursor ? await readUpdateState() : null;
  // A plain `bun ./scripts/update-data.ts` (no MAX_FETCHES) always walks the
  // whole catalog from the top and clears the cursor afterwards; the saved
  // cursor only rotates the queue for explicitly bounded batch runs, exactly
  // like the sibling SPDR / iShares updaters.
  // The cursor also resumes a run that stopped at the soft deadline, and is only
  // used for the same filter set it was saved for.
  const scope = cursorScope(config);
  const cursor = (config.maxFetches > 0 || state?.partial === true) && state?.scope === scope ? state?.cursor || null : null;
  // A closed fund leaves the queue before any request or MAX_FETCHES slot: never fetched, guarded or reported.
  const ordered = withoutClosedFunds(runOrder(universe, config.tickers, cursor), (fund) => fund.ticker, CLOSED_FUNDS);

  const queue = ordered.map((fund) => ({ fund }));
  const results: JsonRecord[] = [];
  // MAX_FETCHES counts only funds that pass the filters; funds a filter rejects are
  // examined (and move the cursor) but cost no batch slot.
  let passed = 0;
  let pending = 0;
  let started = 0;
  let deadlineHit = false;
  let failures = 0;
  const failedTickers = new Set<string>();

  outputPrintFilter(ordered.length, universe.length, outputHasOutputFilters({ ...config, tickers: [] }));
  const output = outputCreateReporter(API_ROOT, config.maxFetches > 0 ? Math.min(config.maxFetches, ordered.length) : ordered.length);
  async function worker(): Promise<void> {
    for (;;) {
      // never start more funds than the batch still needs: wait for in-flight ones to resolve
      while (config.maxFetches > 0 && passed + pending >= config.maxFetches) {
        if (pending === 0) return;
        await sleep(5);
      }
      if (Date.now() > deadlineAt) {
        deadlineHit = true;
        return;
      }
      const item = queue.shift();
      if (!item) return;
      started += 1;
      pending += 1;
      const before = await output.before(item.fund.ticker);
      try {
        // a catalog-only row (dataFile null) is no published data: the fund is processed like a new one
        const previousRow = previousIndex.get(item.fund.ticker);
        const row = await processFund(item.fund, config, previousRow && previousRow.dataFile ? previousRow : {});
        if (row === 'kept') {
          await output.result(item.fund.ticker, before, 'kept', 'SKIP_NORTHERNTRUST: published state kept');
          continue;
        }
        if (row) {
          results.push(row);
          passed += 1;
        }
        await output.result(item.fund.ticker, before, row ? undefined : 'skipped');
      } catch (error) {
        failures += 1;
        failedTickers.add(item.fund.ticker);
        await output.result(item.fund.ticker, before, 'failed', String(error));
      } finally {
        pending -= 1;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, config.concurrency) }, () => worker()));
  const lastExamined = started > 0 ? ordered[started - 1].ticker : cursor;
  if (deadlineHit) console.log(`[ deadline ] soft deadline reached after ${started} funds - the rest keeps its published rows and the next run resumes after ${lastExamined}`);

  // Funds not selected for a successful update keep their previously published rows.
  // A fund that failed this run without any published meta.json (new, or listed only by a catalog-only row)
  // still gets a catalog-only row: dataFile null, no figures, the full metrics key set.
  const keptFromPrevious: JsonRecord[] = [];
  const catalogOnly: JsonRecord[] = [];
  const kept = new Map<string, JsonRecord>(withoutStalePlaceholders(previousRows, live).map((row) => [String(row.ticker), row] as [string, JsonRecord]));
  for (const fund of universe) {
    if (results.some((row) => row.ticker === fund.ticker)) continue;
    const previousRow = kept.get(fund.ticker);
    if (failedTickers.has(fund.ticker) && !(await readPreviousMeta(fund.ticker))) catalogOnly.push(catalogOnlyRow(fund));
    else if (previousRow) keptFromPrevious.push(ensureMetricsContract(previousRow));
  }
  const rows: JsonRecord[] = [];
  for (const row of [...results, ...keptFromPrevious, ...catalogOnly]) rows.push(await withMetaContract(row));
  // the 52-week range of every row from its published history pages (shared range-52w block)
  const funds = await withRange52w(API_ROOT, markClosedFunds(rows.sort((a, b) => String(a.ticker).localeCompare(String(b.ticker))), CLOSED_FUNDS));

  const counts = {
    funds: funds.length,
    holdings: funds.reduce((sum, fund) => sum + (numberOrNull(fund.holdings) || 0), 0),
    history: funds.reduce((sum, fund) => sum + (numberOrNull(fund.history) || 0), 0),
  };

  await writeIfChanged(INDEX_FILE, {
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: {
      provider: 'Northern Trust Asset Management (US ETFs)',
      market: 'us',
      site: NORTHERN_SITE,
      catalog: NORTHERN_CATALOG_PAGE,
      catalogDownload: config.catalogUrl,
      productData: `${NORTHERN_FUND_FILES}/{ticker}/{ticker}-all.csv`,
      holdings: `${NORTHERN_FUND_FILES}/{ticker}/{ticker}-holdings.csv`,
      history: `${NORTHERN_FUND_FILES}/{ticker}/{ticker}_pricing.json`,
    },
    counts,
    funds,
  });

  // Q28: a fund is announced on its first successful publish (a catalog-only row is not published), new catalog-only rows as pending
  const newFunds = newFundsLines(newFundsReport(previousRows, funds));
  for (const line of newFunds) console.log(line);

  // Full passes reset the cursor: the next run starts from the top again.
  if (useCursor) await writeUpdateState(config.maxFetches > 0 || deadlineHit ? lastExamined : null, scope, deadlineHit);

  console.log(output.summary(startedAt));
  console.log(outputCounts(counts.funds, counts.holdings, counts.history));
  console.log(
    `[ cursor   ] ${!useCursor ? 'TICKERS run: cursor untouched' : (config.maxFetches > 0 || deadlineHit) && lastExamined ? `next run continues after ${lastExamined}` : 'full pass complete (cursor reset)'}`,
  );

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### Northern Trust data update\n\n- updated: ${results.length}\n- kept from previous runs: ${keptFromPrevious.length}\n- failed: ${failures}\n${deadlineHit ? '- stopped at the soft deadline, the next run resumes\n' : ''}- counts: ${counts.funds} funds / ${counts.holdings.toLocaleString('en-US')} holdings rows / ${counts.history.toLocaleString('en-US')} history rows\n`,
      'utf8',
    );
    if (newFunds.length) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### NEW FUNDS\n\n${newFunds.join('\n')}\n`, 'utf8');
  }

  // Every examined fund failed to get any fresh source: surface it as a failed run
  const offline = config.skipNorthernTrust && config.skipYahoo && !config.edgarFallback;
  if (!offline && passed + failures > 0 && freshTickers.size === 0) {
    throw new Error(`every examined fund failed: no fund received fresh data (${passed} kept, ${failures} errors)`);
  }
}

/** Rows keep a full metrics object, and dataFile is null when the fund has no meta.json. */
async function withMetaContract(row: JsonRecord): Promise<JsonRecord> {
  const previousMeta = await readPreviousMeta(String(row.ticker));
  const hasMeta = previousMeta !== null;
  const metrics = withYieldBasis({ ...emptyMetrics(), ...((row.metrics as JsonRecord) || {}) }, previousMeta);
  if (!metrics.returnsBasis) metrics.returnsBasis = emptyMetrics().returnsBasis;
  return { ...row, dataFile: hasMeta ? row.dataFile ?? `./funds/${row.ticker}/meta.json` : null, metrics };
}


/** Index row of a catalog fund without published data: catalog identity only, dataFile null, no figures, empty metrics. */
export function catalogOnlyRow(fund: CatalogFund): JsonRecord {
  const terGross = fund.terGross ?? null;
  return {
    ticker: fund.ticker,
    name: fund.name,
    category: fund.category,
    fundPage: fund.fundPage,
    dataFile: null,
    cusip: fund.cusip || null,
    isin: fund.isin || null,
    ter: fund.ter === null ? '—' : `${fund.ter}%`,
    terValue: fund.ter,
    terGross: terGross === null ? '—' : `${terGross}%`,
    terGrossValue: terGross,
    nav: '—',
    navValue: null,
    aum: '—',
    aumValue: null,
    asOfDate: '—',
    inceptionDate: fund.inception ? formatEdgarDate(fund.inception) : '—',
    exchange: fund.exchange || '',
    closePrice: '—',
    closePriceValue: null,
    premiumDiscount: '—',
    premiumDiscountValue: null,
    distributions: { frequency: '—', exDate: '—', dividend: '—' },
    returns: { monthEnd: {}, quarterEnd: null },
    metrics: emptyMetrics(),
    holdings: 0,
    history: 0,
  };
}

function catalogFundFromIndex(ticker: string, row: JsonRecord): CatalogFund {
  const metrics = (row.metrics as JsonRecord) || {};
  const monthEnd = ((row.returns as JsonRecord)?.monthEnd as JsonRecord) || {};
  const quarterEnd = ((row.returns as JsonRecord)?.quarterEnd as JsonRecord) || {};
  const cusip = String(row.cusip ?? '').toUpperCase();
  const name = String(row.name ?? ticker);
  return {
    ticker,
    name,
    category: String(row.category ?? 'ETF'),
    categoryPath: String(row.category ?? 'ETF'),
    inception: null,
    exchange: String(row.exchange ?? ''),
    cusip,
    isin: String(row.isin ?? '').toUpperCase(),
    benchmark: '',
    ter: numberOrNull(row.terValue),
    terGross: numberOrNull(row.terGrossValue),
    nav: numberOrNull(row.navValue),
    close: numberOrNull(row.closePriceValue),
    premiumDiscount: numberOrNull(row.premiumDiscountValue),
    netAssets: numberOrNull(row.aumValue),
    dividendYield: numberOrNull(metrics.dividendYield),
    dividendYieldBasis: yieldBasisOrNull(metrics.dividendYieldBasis),
    secYield: numberOrNull(metrics.secYield),
    distributionRate: null,
    asOfDate: null,
    returns: {
      ytd: numberOrNull(monthEnd.ytd),
      yr1: numberOrNull(monthEnd.yr1),
      yr3: numberOrNull(monthEnd.yr3),
      yr5: numberOrNull(monthEnd.yr5),
      yr10: numberOrNull(monthEnd.yr10),
      sinceInception: numberOrNull(monthEnd.sinceInception),
    },
    returnsAsOfDate: isoDateOrNull(metrics.performanceAsOf as string | null),
    mo1: numberOrNull(monthEnd.mo1),
    marketReturns: { ...EMPTY_RETURNS },
    quarterEnd: {
      ytd: numberOrNull(quarterEnd.ytd),
      yr1: numberOrNull(quarterEnd.yr1),
      yr3: numberOrNull(quarterEnd.yr3),
      yr5: numberOrNull(quarterEnd.yr5),
      yr10: numberOrNull(quarterEnd.yr10),
      sinceInception: numberOrNull(quarterEnd.sinceInception),
    },
    quarterEndAsOfDate: null,
    fundPage: String(row.fundPage ?? northernTrustFundPageUrl(ticker)),
    source: 'previous index',
  };
}

// --- TLS trust store (identical in every ETF repo) ---
const SYSTEM_CA_MARKER = 'ETF_UPDATER_SYSTEM_CA';
const CERT_ERROR = /UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|unable to get (?:local )?issuer certificate|self[- ]signed certificate|certificate has expired/i;

export function isCertError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; cause?: unknown } | null;
  return CERT_ERROR.test(`${String(e?.code ?? '')} ${String(e?.message ?? '')}`) || (e?.cause ? isCertError(e.cause) : false);
}

export function systemCaActive(env: Record<string, string | undefined> = process.env, execArgv: string[] = process.execArgv): boolean {
  return execArgv.includes('--use-system-ca') || env.NODE_USE_SYSTEM_CA === '1' || env[SYSTEM_CA_MARKER] === '1';
}

export function reexecWithSystemCa(): never {
  const child = Bun.spawnSync([process.execPath, '--use-system-ca', ...process.argv.slice(1)], {
    env: { ...process.env, [SYSTEM_CA_MARKER]: '1' },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  process.exit(child.exitCode ?? 1);
}

/** mode: auto (restart once on an untrusted-certificate error), true (restart now), false (never). */
export function installSystemCa(mode: string, reexec: () => never = reexecWithSystemCa, active: boolean = systemCaActive()): void {
  if (mode === 'false' || active) return;
  if (mode === 'true') reexec();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    try { return await realFetch(...args); }
    catch (error) {
      if (!isCertError(error)) throw error;
      console.error('[ notice   ] TLS certificate not trusted; restarting once with --use-system-ca');
      return reexec();
    }
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Controls: config file < advanced JSON < nonblank inputs < environment
// ---------------------------------------------------------------------------

// Allowlisted scalar controls only, so GitHub Actions can resolve them without
// interpolating user input into bash. The CLI and the workflow share
// resolveControls. Precedence: scripts/update-data.config.json < advanced JSON
// < nonblank named inputs < environment (`NORTHERNTRUST_<KEY>` wins over `<KEY>`).
export const CONTROL_NAMES = [
  'MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY', 'MAX_RETRIES', 'TICKERS',
  'AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD',
  'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'HISTORY_RANGE',
  'EDGAR_FALLBACK', 'SKIP_YAHOO', 'SKIP_NORTHERNTRUST', 'STORE_RAW_DOWNLOADS',
  'SEC_UA', 'CATALOG_URL', 'VERBOSE', 'USE_SYSTEM_CA',
  ...['PERFORMANCE', 'TOTAL_RETURN'].flatMap((prefix) => ['YTD', '1Y', '3Y', '5Y', '10Y'].map((period) => `${prefix}_${period}`)),
] as const;
export type ControlName = (typeof CONTROL_NAMES)[number];
export const CONFIG_FILE_URL = new URL('./update-data.config.json', import.meta.url);

// Legacy environment spellings that keep working next to `NORTHERNTRUST_<KEY>` and `<KEY>`.
const CONTROL_ALIASES: Record<string, string[]> = {
  MAX_FETCHES: ['NORTHERNTRUST_LIMIT'],
  HISTORY_PAGE_SIZE: ['HISTORICAL_PAGE_SIZE'],
};

export function resolveControls(
  file: unknown = {},
  advanced: unknown = {},
  inputs: unknown = {},
  env: Record<string, string | undefined> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  const known = new Set<string>(CONTROL_NAMES);
  const apply = (value: unknown, skipEmpty = false): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be a JSON object');
    for (const [key, raw] of Object.entries(value)) {
      if (!known.has(key)) throw new Error(`Unknown updater control: ${key}`);
      if (skipEmpty && (raw === '' || raw === undefined || raw === null)) continue;
      if (!['string', 'number', 'boolean'].includes(typeof raw)) throw new Error(`${key}: expected string, number or boolean`);
      const text = String(raw);
      if (/[\r\n\0]/.test(text)) throw new Error(`${key}: multiline/control characters are not allowed`);
      result[key] = text;
    }
  };
  apply(file);
  apply(advanced);
  apply(inputs, true);
  for (const key of CONTROL_NAMES) {
    const value = [`NORTHERNTRUST_${key}`, key, ...(CONTROL_ALIASES[key] ?? [])].map((name) => env[name]).find((candidate) => candidate !== undefined);
    if (value !== undefined) apply({ [key]: value });
  }
  for (const key of ['MAX_FETCHES', 'CONCURRENCY', 'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'MAX_RETRIES']) {
    const v = result[key];
    if (v === undefined || v === '') continue;
    const min = key === 'MAX_FETCHES' ? 0 : 1;
    if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) < min) throw new Error(`${key}: expected integer >= ${min}`);
  }
  if (result.REQUEST_SLEEP && (!Number.isFinite(Number(result.REQUEST_SLEEP)) || Number(result.REQUEST_SLEEP) < 0)) throw new Error('REQUEST_SLEEP: expected nonnegative seconds');
  for (const key of ['EDGAR_FALLBACK', 'SKIP_YAHOO', 'SKIP_NORTHERNTRUST', 'STORE_RAW_DOWNLOADS', 'VERBOSE']) {
    if (result[key] && !/^(0|1|true|false|yes|no|y|n|on|off)$/i.test(result[key])) throw new Error(`${key}: expected boolean`);
  }
  if (result.USE_SYSTEM_CA !== undefined) {
    const mode = result.USE_SYSTEM_CA.toLowerCase();
    if (!['auto', 'true', 'false'].includes(mode)) throw new Error('USE_SYSTEM_CA: expected auto, true or false');
    result.USE_SYSTEM_CA = mode;
  }
  if (result.HISTORY_RANGE?.trim() && !/^(max|[1-9]\d{0,2}y)$/i.test(result.HISTORY_RANGE.trim())) {
    throw new Error('HISTORY_RANGE: expected max or a whole number of years such as 5y or 10y');
  }
  if (result.CATALOG_URL?.trim()) {
    // https only; plain http is accepted for a local mirror (offline test runs)
    const value = result.CATALOG_URL.trim();
    let valid = /^https:\/\/\S+$/i.test(value) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?$/i.test(value);
    if (valid) { try { new URL(value); } catch { valid = false; } }
    if (!valid) throw new Error('CATALOG_URL: expected an https URL (http only for localhost)');
  }
  readConfig(result); // validate every min:max filter before any request or write
  return result;
}

export async function runtimeControls(env: Record<string, string | undefined> = process.env): Promise<Record<string, string>> {
  let file: unknown = {};
  try { file = JSON.parse(await readFile(CONFIG_FILE_URL, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return resolveControls(file, {}, {}, env);
}

// ---------------------------------------------------------------------------
// Entry point (kept at the end: runUpdater() relies on the let bindings above)
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2), env: Record<string, string | undefined> = process.env): Promise<void> {
  if (argv.some((arg) => arg === '--help' || arg === '-h')) {
    console.log(USAGE.trim());
    return;
  }
  if (argv.length) throw new Error(`unsupported argument(s): ${argv.join(' ')}. Use --help for usage.`);
  const controls = await runtimeControls(env);
  installSystemCa(controls.USE_SYSTEM_CA ?? 'auto');
  if (controls.VERBOSE !== undefined && env === process.env) process.env.VERBOSE = controls.VERBOSE;
  await runUpdater(readConfig(controls));
}

if ((import.meta as { main?: boolean }).main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}

// <holdings-guard> shared block of .claude/tools/etfs/etf-std/holdings-guard.block.ts, applied by apply-holdings-guard.ts: never edit it in one repo
/**
 * Sanity check of a fund's new holdings before they replace the published ones. Returns why they must be rejected
 * (the caller then keeps the fund's previous state and reports it as failed), or null when they may be written.
 * An empty sheet passes only when nothing was published before. Otherwise a Name and a weight column (Weight,
 * Weight (%) or Market Weight) are required, >= 80% of the rows carry a numeric weight, the weights add up to
 * 50..150 and the sheet keeps >= 50% of the previously published rows. `relax` switches off the checks a fund
 * legitimately fails: 'numeric' and 'sum' (geared, inverse, futures, look-through, top-N lists) and 'count'. No relax lets
 * a sheet without a single numeric weight replace a published sheet that had numeric weights (`previousWeights`: how many
 * rows of the published sheet carry a numeric weight, see holdingsWeightCount; open-items etfs Q24).
 * Rows are arrays in header order or objects keyed by the header text. A fund in the brand's CLOSED_FUNDS never reaches the guard.
 */
export function holdingsGuard(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, previousRows: number | null | undefined, relax: ReadonlyArray<string> = [], previousWeights: number | null = null): string | null {
  const previous = Number(previousRows) > 0 ? Number(previousRows) : 0;
  if (!rows.length) return previous ? `no holdings rows (${previous} published)` : null;
  const names = headers.map((header) => String(header).trim().toLowerCase());
  const nameAt = names.indexOf('name');
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  if (nameAt < 0 || weightAt < 0) return `no ${nameAt < 0 ? 'Name' : 'weight'} column (headers: ${headers.join(', ') || 'none'})`;
  const weights = holdingsGuardWeights(headers, rows, weightAt);
  const numeric = weights.count;
  const sum = weights.sum;
  if (numeric === 0 && Number(previousWeights) > 0) return `no row has a numeric weight, the published sheet had ${Number(previousWeights)}`;
  if (relax.indexOf('numeric') < 0 && numeric < rows.length * 0.8) return `only ${numeric} of ${rows.length} rows have a numeric weight`;
  if (relax.indexOf('sum') < 0 && (sum < 50 || sum > 150)) return `weights add up to ${sum.toFixed(2)}, outside 50..150`;
  if (relax.indexOf('count') < 0 && previous && rows.length < previous * 0.5) return `${rows.length} rows, less than half of the ${previous} published`;
  return null;
}

/** How many rows carry a numeric weight (Weight, Weight (%) or Market Weight column), 0 without such a column: pass it for the published sheet as holdingsGuard's previousWeights. */
export function holdingsWeightCount(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>): number {
  const names = headers.map((header) => String(header).trim().toLowerCase());
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  return weightAt < 0 ? 0 : holdingsGuardWeights(headers, rows, weightAt).count;
}

/** Count and sum of the numeric weights in column weightAt; rows are arrays in header order or objects keyed by the header text. */
function holdingsGuardWeights(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, weightAt: number): { count: number; sum: number } {
  let count = 0;
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    const row: any = rows[i];
    const weight = holdingsGuardNumber(Array.isArray(row) ? row[weightAt] : row && typeof row === 'object' ? row[headers[weightAt]] : undefined);
    if (weight !== null) {
      count++;
      sum += weight;
    }
  }
  return { count, sum };
}

/** A weight cell as a number: %, $, commas and spaces are ignored, (x) is negative; null when it is no plain number (a zero-width character inside counts as broken). */
function holdingsGuardNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value === null || value === undefined ? '' : value).replace(/[ \t ,%$]/g, '').replace(/−/g, '-');
  const negative = /^\(.*\)$/.test(text);
  if (negative) text = text.slice(1, -1);
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  return negative ? -Number(text) : Number(text);
}

/** A fund its issuer closed (liquidated, delisted or merged away), confirmed from an official source: an SEC filing or the issuer's notice. */
export type ClosedFund = { ticker: string; closed: string; source: string };

/**
 * The brand's CLOSED_FUNDS entry for a ticker, or null. A closed fund is never fetched, never guarded and never reported failed: it keeps
 * its last published data and its index row carries `status: 'closed'`, `closedDate` and `closedSource`. A malformed entry throws, so a
 * typo (no ISO date, no https source) never ships.
 */
export function closedFund(list: ReadonlyArray<ClosedFund>, ticker: unknown): ClosedFund | null {
  const wanted = String(ticker === null || ticker === undefined ? '' : ticker).trim().toUpperCase();
  let found: ClosedFund | null = null;
  for (let i = 0; i < list.length; i++) {
    const fund = list[i];
    if (!/^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(fund.ticker) || !/^\d{4}-\d{2}-\d{2}$/.test(fund.closed) || !/^https:\/\/\S+$/.test(fund.source)) throw new Error(`CLOSED_FUNDS: ${fund.ticker} needs an upper-case ticker, an ISO closing date and an https source`);
    if (fund.ticker === wanted) found = fund;
  }
  return found;
}

/** The index rows with every closed fund marked (`status: 'closed'`, `closedDate`, `closedSource`); other rows are returned as they are. */
export function markClosedFunds<T extends object>(rows: ReadonlyArray<T>, list: ReadonlyArray<ClosedFund>): T[] {
  return rows.map((row) => {
    const fund = closedFund(list, (row as { ticker?: unknown }).ticker);
    return fund ? ({ ...row, status: 'closed', closedDate: fund.closed, closedSource: fund.source } as T) : row;
  });
}

/** A run's queue without the closed funds, which are named once in the log: they are neither fetched nor counted as failed. */
export function withoutClosedFunds<T>(queue: ReadonlyArray<T>, tickerOf: (item: T) => string, list: ReadonlyArray<ClosedFund>): T[] {
  const closed: string[] = [];
  const open: T[] = [];
  for (let i = 0; i < queue.length; i++) {
    if (closedFund(list, tickerOf(queue[i]))) closed.push(tickerOf(queue[i]));
    else open.push(queue[i]);
  }
  if (closed.length) console.log(`[ closed   ] ${closed.join(', ')}: closed by the issuer, published data kept`);
  return open;
}
// </holdings-guard>

// <nport-reader> shared block of .claude/tools/etfs/etf-std/nport-reader.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * SEC EDGAR Form N-PORT-P holdings reader (open-items etfs ETF-H2), one copy for every brand. Pure functions plus one reader
 * that takes the brand's own `getText(url, label)` (its SEC User-Agent, timeout, retries and pacing). Rules it enforces:
 * - identifiers come from the position itself: `<cusip>` text (or a `value` attribute), `<isin value>`, `<ticker value>`,
 *   `<other value>`; a derivative's reference instrument (inside `<derivativeInfo>`) never lends its identifiers to the position
 * - CUSIP `000000000` and `N/A` are missing; a missing weight or value is null (an empty cell), never 0
 * - a ticker only for a common-stock row (assetCat EC, not a CVR, right, warrant or escrow line) traded in USD with a U.S.
 *   ISIN or none, or with a foreign ISIN when the Nasdaq Trader directories list that ticker for the same company (a U.S.
 *   listing such as Linde, NXP, IMAX); renamed issuers through `nportRenamedIssuers`; an abbreviated or reordered name the
 *   exact key misses through a looser key that must name one company (`nportLooseKey`, Q35: `Lowe's Cos` = `LOWES COMPANIES`,
 *   `SCHWAB CHARLES CORP`); never one ticker on two different securities (`nportTickers`)
 * - identity: the filing must name the fund's own series id, or, with no series id known, the fund's name (`nportIdentity`)
 * - freshness: the report period must be strictly newer than the published holdings (`nportIsFresh`)
 * - filings come newest report period first from the registrant's own archive folder, never from the filer agent's CIK
 *   (the accession number prefix)
 */
export type NportPosition = {
  name: string;
  title: string;
  lei: string;
  cusip: string;
  isin: string;
  ticker: string;
  other: string;
  otherDesc: string;
  balance: number | null;
  units: string;
  currency: string;
  /** valUSD, null when the filing has none */
  value: number | null;
  /** pctVal: percent of net assets (0.5 = 0.5%), null when the filing has none */
  weight: number | null;
  payoff: string;
  assetCat: string;
  issuerCat: string;
  country: string;
  /** derivCat of the position's derivativeInfo (FUT, FWD, SWP, OPT, ...), empty for a security */
  derivative: string;
  /** debtSec annualizedRt and maturityDt (ISO), null and '' for a non-debt row */
  coupon: number | null;
  maturity: string;
};

export type NportFiling = {
  seriesId: string;
  seriesName: string;
  regName: string;
  regCik: string;
  /** report period end (genInfo repPdDate) as ISO, '' when missing */
  repPdDate: string;
  netAssets: number | null;
  totalAssets: number | null;
  positions: NportPosition[];
};

export type NportCandidate = { accession: string; filed: string; period: string; cik: string };
export type NportSeriesRef = { cik: string; seriesId: string; classId: string };

/** XML text: entities decoded, tags dropped, whitespace collapsed. */
function nportText(raw: string): string {
  return String(raw)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_m: string, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m: string, dec: string) => String.fromCharCode(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[\s ]+/g, ' ')
    .trim();
}

/** Text of the first `<tag>` (any namespace prefix) in `xml`, '' when absent. */
function nportTag(xml: string, tag: string): string {
  const match = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${tag}>`, 'i').exec(xml);
  return match ? nportText(match[1]) : '';
}

/** The `attribute` of the first `<tag ...>` (any namespace prefix) in `xml`, '' when absent. */
function nportAttr(xml: string, tag: string, attribute: string): string {
  const match = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}\\s[^>]*?\\b${attribute}\\s*=\\s*"([^"]*)"`, 'i').exec(xml);
  return match ? nportText(match[1]) : '';
}

/** A plain decimal or exponent number, null for an empty, N/A or broken cell. */
function nportNumber(raw: string): number | null {
  const text = String(raw).replace(/[\s,]/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** An identifier code, '' for N/A, NONE and all zeros (CUSIP 000000000 means "no CUSIP"). */
function nportCode(raw: string): string {
  const text = String(raw).trim().toUpperCase();
  return !text || /^(N\/?A|NONE|-+|0+)$/.test(text) ? '' : text;
}

/** ISO date of an N-PORT date (YYYY-MM-DD, possibly with a time), '' otherwise. */
function nportIso(raw: unknown): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw === null || raw === undefined ? '' : raw).trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

/** One N-PORT-P primary_doc.xml (or the full submission .txt that embeds it) as series facts and positions. */
export function parseNportFiling(xml: string): NportFiling {
  const text = String(xml === null || xml === undefined ? '' : xml);
  const genInfo = /<(?:[A-Za-z0-9_.-]+:)?genInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?genInfo>/i.exec(text);
  const fundInfo = /<(?:[A-Za-z0-9_.-]+:)?fundInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?fundInfo>/i.exec(text);
  const gen = genInfo ? genInfo[1] : '';
  const fund = fundInfo ? fundInfo[1].replace(/<(?:[A-Za-z0-9_.-]+:)?returnInfo\b[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?returnInfo>/gi, ' ') : '';
  const positions: NportPosition[] = [];
  const blocks = /<(?:[A-Za-z0-9_.-]+:)?invstOrSec\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?invstOrSec>/gi;
  let block: RegExpExecArray | null;
  while ((block = blocks.exec(text)) !== null) {
    const raw = block[1];
    const derivativeInfo = /<(?:[A-Za-z0-9_.-]+:)?derivativeInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?derivativeInfo>/i.exec(raw);
    // The reference instrument of a derivative (SPY for a SPY option, a bond for a CDS) is another security: drop it first.
    const own = raw.replace(/<(?:[A-Za-z0-9_.-]+:)?derivativeInfo\b[^>]*>[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?derivativeInfo>/gi, ' ');
    const identifiers = /<(?:[A-Za-z0-9_.-]+:)?identifiers\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?identifiers>/i.exec(own);
    const ids = identifiers ? identifiers[1] : '';
    const debt = /<(?:[A-Za-z0-9_.-]+:)?debtSec\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?debtSec>/i.exec(own);
    const name = nportTag(own, 'name');
    positions.push({
      name: name && !/^N\/?A$/i.test(name) ? name : nportTag(own, 'title'),
      title: nportTag(own, 'title'),
      lei: nportCode(nportTag(own, 'lei')),
      cusip: nportCode(nportTag(own, 'cusip') || nportAttr(ids, 'cusip', 'value')),
      isin: nportCode(nportAttr(ids, 'isin', 'value')),
      ticker: nportCode(nportAttr(ids, 'ticker', 'value')),
      other: nportCode(nportAttr(ids, 'other', 'value')),
      otherDesc: nportAttr(ids, 'other', 'otherDesc'),
      balance: nportNumber(nportTag(own, 'balance')),
      units: nportTag(own, 'units'),
      currency: (nportTag(own, 'curCd') || nportAttr(own, 'currencyConditional', 'curCd')).toUpperCase(),
      value: nportNumber(nportTag(own, 'valUSD')),
      weight: nportNumber(nportTag(own, 'pctVal')),
      payoff: nportTag(own, 'payoffProfile'),
      assetCat: (nportTag(own, 'assetCat') || nportAttr(own, 'assetConditional', 'assetCat')).toUpperCase(),
      issuerCat: (nportTag(own, 'issuerCat') || nportAttr(own, 'issuerConditional', 'issuerCat')).toUpperCase(),
      country: nportTag(own, 'invCountry').toUpperCase(),
      derivative: derivativeInfo ? (/\bderivCat\s*=\s*"([^"]*)"/i.exec(derivativeInfo[1]) || ['', 'OTHER'])[1].toUpperCase() : '',
      coupon: debt ? nportNumber(nportTag(debt[1], 'annualizedRt')) : null,
      maturity: debt ? nportIso(nportTag(debt[1], 'maturityDt')) : '',
    });
  }
  return {
    seriesId: nportTag(gen, 'seriesId').toUpperCase(),
    seriesName: nportTag(gen, 'seriesName'),
    regName: nportTag(gen, 'regName'),
    regCik: nportTag(gen, 'regCik').replace(/\D/g, ''),
    repPdDate: nportIso(nportTag(gen, 'repPdDate')),
    netAssets: nportNumber(nportTag(fund, 'netAssets')),
    totalAssets: nportNumber(nportTag(fund, 'totAssets')),
    positions,
  };
}

/**
 * A number as sheet text: '' for null, no exponent, at most `digits` decimals (trailing zeros dropped), and no binary float
 * artifact: `115797518.01` stays `115797518.01`, not the `115797518.01000001` of `toFixed(8)`.
 */
export function nportCell(value: number | null, digits = 8): string {
  if (value === null || !Number.isFinite(value)) return '';
  const fixed = value.toFixed(digits);
  // the shortest text of the rounded number; toFixed only where that text would be an exponent (very small or large numbers)
  const shortest = String(Number(fixed));
  if (!/e/i.test(shortest)) return shortest;
  return fixed.indexOf('.') < 0 ? fixed : fixed.replace(/0+$/, '').replace(/\.$/, '');
}

/** The position's own identifier for a sheet: CUSIP, else ISIN, else the "other" code (a Bloomberg or internal id), else ''. */
export function nportIdentifier(position: NportPosition): string {
  return position.cusip || position.isin || position.other;
}

/**
 * A company name as a lookup key: upper case, punctuation and legal suffixes dropped, `CLASS A` -> `CL A`. Initials are one
 * word whether written with dots, spaces or a slash (`N.V.` = `N V` = `NV`, `C.H. ROBINSON` = `C H ROBINSON`, `A/S` = `A S`,
 * `S.A.B. de C.V.` = `SAB DE CV`), `PUBLIC LIMITED COMPANY` is `plc`, and a leading `US` stays (`U.S. BANCORP` is not
 * `BANCORP, INC.`), so both spellings of one issuer give one key.
 */
export function nportNameKey(value: unknown): string {
  // EDGAR adds a state or qualifier suffix to company titles ("COSTCO WHOLESALE CORP /NEW", "BANK OF AMERICA CORP /DE/",
  // "US BANCORP \DE\", "ACUITY INC. (DE)"): drop a trailing one
  const raw = String(value === null || value === undefined ? '' : value).replace(/(?:\s*(?:[\/\\]\s*[A-Za-z]{2,3}\s*[\/\\]?|\(\s*[A-Za-z]{2,3}\s*\)))+\s*$/, '');
  let text = nportText(raw).toUpperCase().replace(/['’]/g, '').replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').trim();
  text = text.replace(/\bCLASS\s+([A-Z])\b/g, 'CL $1').replace(/\bCL\s+([A-Z])\b/g, 'CL $1');
  // a run of single letters is one word, never the class letter after CL
  const words: string[] = [];
  let joining = false;
  text.split(' ').forEach((word) => {
    const letter = /^[A-Z]$/.test(word);
    if (letter && joining) words[words.length - 1] += word;
    else words.push(word);
    joining = letter && (joining || words[words.length - 2] !== 'CL');
  });
  text = words.join(' ').replace(/\bPUBLIC (?:(?:LIMITED|LTD)(?: (?:COMP[A-Z]*|CO))?|(?:COMPANY|CO) (?:LIMITED|LTD))\b/g, 'PLC').replace(/\b(?:S DE RL )?DE CV\b/g, ' ');
  const share = /\bCL [A-Z]\b/.exec(text);
  text = text.replace(/\b(THE|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|SA|SAB|NV|AG|SE|SPA|AS|ASA|ORDINARY|COMMON|STOCK|SHS|SHARES|ADR|DEPOSITARY|RECEIPT|USD|US|REG|REGISTERED)\b/g, (word: string, _name: string, at: number) => (word === 'US' && at === 0 ? word : ' ')).replace(/\s+/g, ' ').trim();
  if (share && !/\bCL [A-Z]\b/.test(text)) text = `${text} ${share[0]}`;
  return text;
}

/**
 * Abbreviated words of issuer names (open-items etfs Q35) -> one spelling, each seen in N-PORT-P filings of the brands against
 * the SEC company_tickers.json title of the same CUSIP issuer (2026-10-26): `LOWES COS` / `LOWES COMPANIES`, `AMERIPRISE FINL`,
 * `VICI PPTYS`, `TAIWAN SEMICONDUCTOR MFG`, `ZIONS BANCORP NA` / `ZIONS BANCORPORATION NATIONAL ASSOCIATION`. '' drops the word.
 */
function nportLooseWords(): Record<string, string> {
  return {
    COS: '', COMPANIES: '', AND: '', OF: '', NA: '', NATIONAL_ASSOCIATION: '', INCORPORATION: '', REIT: '',
    BANCORPORATION: 'BANCORP', FINL: 'FINANCIAL', PPTYS: 'PROPERTIES', PPTY: 'PROPERTY', MFG: 'MANUFACTURING', GRP: 'GROUP',
    HLDGS: 'HOLDINGS', HLDG: 'HOLDING', INTL: 'INTERNATIONAL', SVCS: 'SERVICES', TECH: 'TECHNOLOGIES', TECHNOLOGY: 'TECHNOLOGIES',
    SYS: 'SYSTEMS', NATL: 'NATIONAL', RES: 'RESOURCES', RLTY: 'REALTY', INDS: 'INDUSTRIES', INS: 'INSURANCE', BROS: 'BROTHERS', SVGS: 'SAVINGS',
  };
}

/**
 * The second, looser company key (open-items etfs Q35), used only for a row the exact key (`nportNameKey`) left without a
 * ticker: a Bloomberg location or article after a slash dropped (`Charles Schwab Corp/The`, `Energy Fuels Inc/canada`; never a
 * one-word start like `RE/MAX`), abbreviations read as one word (`nportLooseWords`), the share class dropped (the caller picks
 * the class) and the words sorted, so EDGAR's reordered titles meet the usual order: `SCHWAB CHARLES CORP` = `Charles Schwab
 * Corp`, `HORTON D R INC` = `DR Horton Inc`, `PRICE T ROWE GROUP INC` = `T Rowe Price Group Inc`. Several companies can share a
 * loose key: `parseSecCompanyNames` and `parseUsListings` keep such a key empty, so it never gives a ticker.
 */
export function nportLooseKey(value: unknown): string {
  let raw = String(value === null || value === undefined ? '' : value).trim();
  const slash = /^(.*\s\S*[A-Za-z]{2}[.,]?)\s*\/\s*([A-Za-z][A-Za-z .,']*)$/.exec(raw);
  if (slash) raw = slash[1];
  // a trailing EDGAR or Bloomberg qualifier after the legal form: `CHEVRON CORP NEW`, `US BANCORP DEL`, `PROGRESSIVE CORP OHIO`
  raw = raw.replace(/\b(CORP(?:ORATION)?|INC(?:ORPORATED)?|CO(?:MPANY)?|LTD|BANCORP|GROUP|GRP|TRUST|HOLDINGS?)\.?,?\s+(?:NEW|DEL|REINCORPORATION|OHIO|AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\.?$/i, '$1');
  const words = nportLooseWords();
  const key = nportNameKey(raw).replace(/ CL [A-Z]$/, '').replace(/\bNATIONAL ASSOCIATION\b/g, 'NATIONAL_ASSOCIATION');
  return key.split(' ').map((word) => (Object.prototype.hasOwnProperty.call(words, word) ? words[word] : word)).filter(Boolean).sort().join(' ');
}

/**
 * SEC company_tickers.json -> name key -> ticker (the first, largest company wins a shared key; the class-less key is added too).
 * Each loose key (`nportLooseKey`) is added as `\u0001<loose key>` -> the company's tickers, space-separated in the table's
 * order, or '' when two companies (CIKs) share it; `nportTickers` reads them for rows the exact key misses.
 */
export function parseSecCompanyNames(payload: unknown): Map<string, string> {
  const names = new Map<string, string>();
  const loose = new Map<string, { cik: string; tickers: string[] } | null>();
  const rows = payload && typeof payload === 'object' ? Object.keys(payload as object).map((key) => (payload as Record<string, unknown>)[key]) : [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as { ticker?: unknown; title?: unknown; cik_str?: unknown } | null;
    if (!row || typeof row !== 'object') continue;
    const ticker = String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
    const key = nportNameKey(row.title);
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) || !key) continue;
    if (!names.has(key)) names.set(key, ticker);
    const core = key.replace(/ CL [A-Z]$/, '');
    if (core && !names.has(core)) names.set(core, ticker);
    const looseKey = nportLooseKey(row.title);
    const cik = String(row.cik_str === null || row.cik_str === undefined ? '' : row.cik_str).replace(/\D/g, '');
    if (!looseKey || !Number(cik)) continue;
    const seen = loose.get(looseKey);
    if (seen === undefined) loose.set(looseKey, { cik: String(Number(cik)), tickers: [ticker] });
    else if (seen && seen.cik === String(Number(cik))) { if (seen.tickers.indexOf(ticker) < 0) seen.tickers.push(ticker); }
    else loose.set(looseKey, null);
  }
  loose.forEach((seen, looseKey) => names.set(`\u0001${looseKey}`, seen ? seen.tickers.join(' ') : ''));
  return names;
}

/** SEC company_tickers_mf.json -> fund ticker -> registrant CIK (10 digits), series id, class id. */
export function parseSecFundTickers(payload: unknown): Map<string, NportSeriesRef> {
  const map = new Map<string, NportSeriesRef>();
  const record = (payload && typeof payload === 'object' ? payload : {}) as { fields?: unknown; data?: unknown };
  const fields = Array.isArray(record.fields) ? record.fields.map(String) : [];
  const rows = Array.isArray(record.data) ? record.data : [];
  const at = (row: unknown[], field: string): string => (fields.indexOf(field) < 0 ? '' : String(row[fields.indexOf(field)] === null || row[fields.indexOf(field)] === undefined ? '' : row[fields.indexOf(field)]).trim());
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const ticker = at(row, 'symbol').toUpperCase();
    const cik = at(row, 'cik').replace(/\D/g, '');
    const seriesId = at(row, 'seriesId').toUpperCase();
    if (!ticker || !Number(cik) || !/^S\d{9}$/.test(seriesId) || map.has(ticker)) continue;
    map.set(ticker, { cik: `0000000000${Number(cik)}`.slice(-10), seriesId, classId: at(row, 'classId').toUpperCase() });
  }
  return map;
}

/**
 * Is the row a contingent value right, a right, a warrant or an escrow line filed as equity? A placeholder CUSIP or ISIN
 * (`436CVR021`, `US009CVR0445`, `549ESC028`, `866CNT017`) says so; so does the name or title (`NOVO NORDISK A/S - CVR`,
 * `XYZ INC RIGHTS`, `... WARRANT FEB 2026`, `Luby's Inc Escrow`), except on a CUSIP with the common-stock issue number 10
 * (Schwab titles Enovix common stock 293594107 "Enovix Corp Warrants"). `CVR` as the first word is a company (CVR Energy).
 */
function nportIsRight(position: NportPosition): boolean {
  if (/^[0-9A-Z]{3}(?:CVR|ESC|CNT)/.test(position.cusip) || /^US[0-9A-Z]{3}(?:CVR|ESC|CNT)/.test(position.isin)) return true;
  if (/^[0-9A-Z]{6}10[0-9]$/.test(position.cusip)) return false;
  return [position.name, position.title].some((text) => /\S\s*\bCVRS?\b|\bCONTINGENT\b|\bRIGHTS?\b|\bRTS\b|\bWARRANTS?\b|\bWTS\b|\bESCROW\b/i.test(text));
}

/**
 * Renamed issuers (open-items etfs Q33): N-PORT filers keep an issuer's old name for months while SEC's company_tickers.json
 * titles only the new one, so the name match misses (JPMorgan JEPI's Exxon). Old name key (`nportNameKey`) -> [ticker, CUSIP
 * issuer number (the first six characters)]. Used only when the SEC table has no such key, the row's CUSIP (or U.S. ISIN) has
 * that issuer number and the SEC table still lists the ticker. Each entry was confirmed on 2026-10-26: an EC row without a
 * ticker in the N-PORT-P filings of large U.S. equity funds (VTI, SCHB, ITOT, JEPI, IWB, VB, SCHA, FNDX, FNDA, ...) whose name
 * is a former EDGAR name of the CIK that has the ticker today (data.sec.gov submissions `formerNames`, the date the old name
 * ended), the ticker the CIK's only common stock in the Nasdaq Trader directories. Add an entry only with the same evidence.
 * A function, not a const: blocks sit at the end of update-data.ts, below the top-level run, so only declarations are hoisted.
 */
export function nportRenamedIssuers(): Array<[string, string, string]> {
  return [
    ['AADI BIOSCIENCE', 'WHWK', '00032Q'], // CIK 1422142 Whitehawk Therapeutics, Inc., former EDGAR name until 2025-03-18
    ['ABACUS LIFE', 'ABX', '00258Y'], // CIK 1814287 Abacus Global Management, Inc., former EDGAR name until 2025-02-04
    ['ACUITY BRANDS', 'AYI', '00508Y'], // CIK 1144215 ACUITY INC. (DE), former EDGAR name until 2025-04-17
    ['AEROVATE THERAPEUTICS', 'JBIO', '008064'], // CIK 1798749 Jade Biosciences, Inc., former EDGAR name until 2025-04-30
    ['AILERON THERAPEUTICS', 'RNTX', '00887A'], // CIK 1420565 Rein Therapeutics, Inc., former EDGAR name until 2024-12-09
    ['ALLOVIR', 'KLRS', '482929'], // CIK 1754068 Kalaris Therapeutics, Inc., former EDGAR name until 2025-03-12
    ['AMC NETWORKS', 'AMCX', '00164V'], // CIK 1514991 AMC Global Media Inc., former EDGAR name until 2026-04-03
    ['AMMO', 'POWW', '00175J'], // CIK 1015383 Outdoor Holding Co, former EDGAR name until 2025-04-24
    ['ARDENT HEALTH PARTNERS', 'ARDT', '03980N'], // CIK 1756655 Ardent Health, Inc., former EDGAR name until 2025-05-23
    ['ARENA GROUP HOLDINGS', 'PAAI', '040044'], // CIK 894871 Paradium.AI, Inc., former EDGAR name until 2026-08-13
    ['ATEGRITY SPECIALTY HOLDINGS LLC', 'ASIC', '04681Y'], // CIK 2040491 Ategrity Specialty Insurance Co Holdings, former EDGAR name until 2025-06-11
    ['BAKKT HOLDINGS', 'BKKT', '05759B'], // CIK 1820302 Bakkt, Inc., former EDGAR name until 2026-01-20
    ['BED BATH AND BEYOND', 'NXH', '690370'], // CIK 1130713 NEIGHBORHOOD INTELLIGENCE, INC., former EDGAR name until 2026-08-14
    ['BLACKROCK FUNDING', 'BLK', '09290D'], // CIK 2012383 BlackRock, Inc., former EDGAR name until 2024-10-01
    ['BRIGHTSPHERE INVESTMENT GROUP', 'AAMI', '10948W'], // CIK 1748824 Acadian Asset Management Inc., former EDGAR name until 2024-11-14
    ['CARA THERAPEUTICS', 'TVRD', '140755'], // CIK 1346830 Tvardi Therapeutics, Inc., former EDGAR name until 2025-04-11
    ['CEA INDUSTRIES', 'BNC', '86887P'], // CIK 1482541 BNB Standard Corp, former EDGAR name until 2026-09-21
    ['CHROMADEX', 'NAGE', '171077'], // CIK 1386570 Niagen Bioscience, Inc., former EDGAR name until 2025-03-10
    ['CLEANCORE SOLUTIONS', 'ZONE', '184492'], // CIK 1956741 Zone Frontier Inc., former EDGAR name until 2026-08-20
    ['CORPORATE OFFICE PROPERTIES TRUST', 'CDP', '22002T'], // CIK 860546 COPT DEFENSE PROPERTIES, former EDGAR name until 2023-09-14
    ['CULLINAN ONCOLOGY', 'CGEM', '230031'], // CIK 1789972 Cullinan Therapeutics, Inc., former EDGAR name until 2024-04-02
    ['DIME COMMUNITY BANCSHARES', 'DCOM', '25432X'], // CIK 846617 Dime Commercial Bancshares, Inc. /NY/, former EDGAR name until 2026-05-27
    ['DOMO', 'HUCK', '257554'], // CIK 1505952 Huckleberry.ai, Inc., former EDGAR name until 2026-09-03
    ['EASTSIDE DISTILLING', 'BLNE', '277802'], // CIK 1534708 Beeline Holdings, Inc., former EDGAR name until 2025-03-11
    ['EQUITY RESIDENTIAL', 'VMRK', '29476L'], // CIK 906107 VIVMARK RESIDENTIAL, former EDGAR name until 2026-08-12
    ['EXP WORLD HOLDINGS', 'AGNT', '30212W'], // CIK 1495932 AGNT, Inc., former EDGAR name until 2026-06-01
    ['EXXON MOBIL', 'XOM', '30231G'], // holding company reorganization: XOM is CIK 2115436 ExxonMobil Holdings Corp since 2026, the old Exxon Mobil Corp is CIK 34088
    ['EYEPOINT PHARMACEUTICALS', 'EYPT', '30233G'], // CIK 1314102 EyePoint, Inc., former EDGAR name until 2025-12-08
    ['EZFILL HOLDINGS', 'NXXT', '652941'], // CIK 1817004 NEXTNRG, INC., former EDGAR name until 2025-02-14
    ['FORTUNE BRANDS HOME AND SECURITY', 'FBIN', '34964C'], // CIK 1519751 Fortune Brands Innovations, Inc., former EDGAR name until 2022-12-14
    ['FRANKLIN RESOURCES', 'BEN', '354613'], // CIK 38777 FRANKLIN TEMPLETON INC, former EDGAR name until 2026-08-14
    ['FREYR BATTERY', 'TE', '35834F'], // CIK 1992243 T1 Energy Inc., former EDGAR name until 2025-02-14
    ['GALLAGHER ARTHUR J AND', 'AJG', '363576'], // CIK 354190 Arthur J. Gallagher & Co., former EDGAR name until 2019-08-14
    ['GRAINGER WW', 'GWW', '384802'], // CIK 277135 W.W. GRAINGER, INC., former EDGAR name until 2019-10-15
    ['GRAY TELEVISION', 'GTN', '389375'], // CIK 43196 GRAY MEDIA, INC, former EDGAR name until 2025-02-24
    ['GREAT AJAX', 'RPT', '38983D'], // CIK 1614806 Rithm Property Trust Inc., former EDGAR name until 2024-11-13
    ['GREENIDGE GENERATION HOLDINGS', 'VIP', '39531G'], // CIK 1844971 Vulcan Infrastructure & Power Inc., former EDGAR name until 2026-07-09
    ['HANNON ARMSTRONG SUSTAINABLE INFRASTRUCTURE CAPITAL', 'HASI', '41068X'], // CIK 1561894 HA Sustainable Infrastructure Capital, Inc., former EDGAR name until 2024-07-02
    ['HARTFORD FINANCIAL SERVICES GROUP', 'HIG', '416515'], // CIK 874766 HARTFORD INSURANCE GROUP, INC., former EDGAR name until 2025-01-30
    ['HELIX ENERGY SOLUTIONS GROUP', 'HOS', '42330P'], // CIK 866829 HORNBECK OFFSHORE SERVICES, INC., former EDGAR name until 2026-08-31
    ['HYSTER YALE MATERIALS HANDLING', 'HY', '449172'], // CIK 1173514 HYSTER-YALE, INC., former EDGAR name until 2024-05-30
    ['IAC', 'PPLI', '44891N'], // CIK 1800227 People Inc, former EDGAR name until 2026-06-02
    ['IDENTIV', 'INVE', '45170X'], // CIK 1036044 INVE Technologies, Inc., former EDGAR name until 2026-08-25
    ['IRHYTHM TECHNOLOGIES', 'IRTC', '450056'], // CIK 1388658 iRhythm Holdings, Inc., former EDGAR name until 2026-01-12
    ['ISSUER DIRECT', 'ACCS', '46520M'], // CIK 843006 ACCESS Newswire Inc., former EDGAR name until 2025-01-16
    ['JANOVER', 'DFDV', '47100L'], // CIK 1805526 DeFi Development Corp., former EDGAR name until 2025-04-15
    ['JOHN BEAN TECHNOLOGIES', 'JBTM', '477839'], // CIK 1433660 JBT MAREL Corp, former EDGAR name until 2024-12-20
    ['LENDINGCLUB', 'HAPN', '52603A'], // CIK 1409970 Happen, Inc., former EDGAR name until 2026-06-18
    ['LIXTE BIOTECHNOLOGY HOLDINGS', 'NMAD', '539319'], // CIK 1335105 NOMAD POWER SOLUTIONS, INC., former EDGAR name until 2026-07-02
    ['MKS INSTRUMENTS', 'MKSI', '55306N'], // CIK 1049502 MKS INC, former EDGAR name until 2025-05-15
    ['MONTANA TECHNOLOGIES', 'AIRJ', '612160'], // CIK 1855474 AirJoule Technologies Corp., former EDGAR name until 2024-10-21
    ['MULTIPLAN', 'CTEV', '62548M'], // CIK 1793229 Claritev Corp, former EDGAR name until 2025-02-07
    ['NEWPARK RESOURCES', 'NPKI', '651718'], // CIK 71829 NPK International Inc., former EDGAR name until 2024-12-03
    ['ONCOLOGY INSTITUTE', 'STLN', '68236X'], // CIK 1799191 Starling Oncology, Inc., former EDGAR name until 2026-08-03
    ['OREILLY AUTOMOTIVE', 'ORLY', '67103H'], // CIK 898173 O REILLY AUTOMOTIVE INC, former EDGAR name until 1998-04-10
    ['ORION OFFICE REIT', 'ONL', '68629Y'], // CIK 1873923 Orion Properties Inc., former EDGAR name until 2025-03-07
    ['PALTALK', 'IPM', '69764K'], // CIK 1355839 INTELLIGENT PROTECTION MANAGEMENT CORP., former EDGAR name until 2025-01-02
    ['PARAMOUNT SKYDANCE', 'SKYD', '69932A'], // CIK 2041610 Skydance Corp, former EDGAR name until 2026-10-06
    ['PIEDMONT OFFICE REALTY TRUST', 'PDM', '720190'], // CIK 1042776 Piedmont Realty Trust, Inc., former EDGAR name until 2025-06-02
    ['PIERIS PHARMACEUTICALS', 'PVLA', '697947'], // CIK 1583648 PALVELLA THERAPEUTICS, INC., former EDGAR name until 2024-12-12
    ['PLUS THERAPEUTICS', 'CNSY', '72941H'], // CIK 1095981 CERENOME, INC., former EDGAR name until 2026-07-01
    ['RUMBLE', 'RUM', '78137L'], // CIK 1830081 RUM Group Inc., former EDGAR name until 2026-06-17
    ['SCHWEITZER MAUDUIT INTERNATIONAL', 'MATV', '808541'], // CIK 1000623 Mativ Holdings, Inc., former EDGAR name until 2022-07-01
    ['SEQLL', 'CIRC', '048592'], // CIK 1605888 CIRCLE8 GROUP INC, former EDGAR name until 2024-06-06
    ['SHOE CARNIVAL', 'SHOE', '824889'], // CIK 895447 SHOE STATION GROUP INC, former EDGAR name until 2026-06-11
    ['TANGER FACTORY OUTLET CENTERS', 'SKT', '875465'], // CIK 899715 TANGER INC., former EDGAR name until 2023-11-15
    ['TECNOGLASS', 'TGLS', '87877F'], // CIK 1534675 Tecnoglass Holdings Inc., former EDGAR name until 2026-07-07
    ['TEMPUR SEALY INTERNATIONAL', 'SGI', '88023U'], // CIK 1206264 SOMNIGROUP INTERNATIONAL INC., former EDGAR name until 2025-02-14
    ['TEVOGEN BIO HOLDINGS', 'TVGN', '88165K'], // CIK 1860871 Tevogen Inc., former EDGAR name until 2026-07-30
    ['TORO COMBINECO', 'TTGT', '87874R'], // CIK 2018064 TechTarget, Inc., former EDGAR name until 2024-11-20
    ['VIAD', 'PRSU', '92552R'], // CIK 884219 Pursuit Attractions & Hospitality, Inc., former EDGAR name until 2024-12-31
    ['WELLGISTICS HEALTH', 'MEDS', '949503'], // CIK 2030763 DataMeds AI, Inc., former EDGAR name until 2026-07-21
    ['ZOOM VIDEO COMMUNICATIONS', 'ZM', '98980L'], // CIK 1585521 Zoom Communications, Inc., former EDGAR name until 2024-11-12
    ['ZYMEWORKS DELAWARE', 'ZYME', '98985Y'], // CIK 1937653 Zymeworks Inc., former EDGAR name until 2022-10-13
  ];
}

/** Nasdaq Trader symbol directories: Nasdaq listings, and NYSE, NYSE American, NYSE Arca, Cboe and IEX listings. */
export function nportUsListingsUrls(): string[] {
  return ['https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt', 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt'];
}

/**
 * The Nasdaq Trader symbol directories (the texts of `nportUsListingsUrls()`, in any order) as U.S.-listed symbol -> security
 * name; test issues and ETFs left out, CQS class dots as SEC dashes (`BRK.B` -> `BRK-B`). An issuer listed under several
 * symbols (Liberty Global LBTYA, LBTYB, LBTYK) also gets the entry `\u0000<name key>` -> its symbols, which `nportUsListed` reads
 * to require the share class. null unless every text is a whole directory (a header with Security Name and the File Creation
 * Time footer), so a failed or cut download changes nothing.
 */
export function parseUsListings(texts: ReadonlyArray<string>): Map<string, string> | null {
  const listings = new Map<string, string>();
  if (!texts.length) return null;
  for (let t = 0; t < texts.length; t++) {
    const lines = String(texts[t] === null || texts[t] === undefined ? '' : texts[t]).split(/\r?\n/).filter((line) => line.trim());
    const header = (lines[0] || '').split('|').map((cell) => cell.trim().toUpperCase());
    const nameAt = header.indexOf('SECURITY NAME'), testAt = header.indexOf('TEST ISSUE'), etfAt = header.indexOf('ETF');
    if (nameAt < 0 || !/^FILE CREATION TIME/i.test(lines[lines.length - 1] || '')) return null;
    for (let i = 1; i < lines.length - 1; i++) {
      const cells = lines[i].split('|');
      const symbol = String(cells[0] || '').trim().toUpperCase().replace(/[./ ]/g, '-');
      if (!symbol || String(cells[testAt] || '').trim() === 'Y' || String(cells[etfAt] || '').trim() === 'Y' || listings.has(symbol)) continue;
      listings.set(symbol, String(cells[nameAt] || '').trim());
    }
  }
  const issuers = new Map<string, string[]>();
  const loose = new Map<string, string[]>();
  listings.forEach((name, symbol) => {
    const key = nportNameKey(nportIssuerName(name));
    if (key) issuers.set(key, (issuers.get(key) || []).concat(symbol));
    const looseKey = nportLooseKey(nportIssuerName(name));
    if (looseKey && nportListedCommon(name)) loose.set(looseKey, (loose.get(looseKey) || []).concat(symbol));
  });
  issuers.forEach((symbols, key) => { if (symbols.length > 1) listings.set(`\u0000${key}`, symbols.join(' ')); });
  loose.forEach((symbols, looseKey) => listings.set(`\u0001${looseKey}`, symbols.join(' ')));
  return listings;
}

/** Is a symbol directory security name a company's own common or ordinary shares (not preferred, depositary, notes, warrants, units, rights)? */
function nportListedCommon(name: string): boolean {
  return !/\bDEPOSITARY\b|\bADSS?\b|\bADRS?\b|\bREGISTRY\b|\bPREFERRED\b|\bPREF\b|\bPFD\b|\bNOTES?\b|\bDEBENTURES?\b|\bWARRANTS?\b|\bUNITS?\b|\bRIGHTS?\b|%|\bDUE\s+\d{4}\b|\bPERPETUAL\b|\bCUMULATIVE\b|\bSUBORDINATED\b|\bTRUST\s+(?:SECURITIES|CERTIFICATES)\b|\bETNS?\b|\bEXCHANGE[- ]TRADED\b/i.test(name);
}

/** The share class a name or title states (`Class C`, `CL C`, `Series A`, `LIBERTY GLOBAL-C`), '' for none. */
function nportShareClass(...texts: unknown[]): string {
  for (let i = 0; i < texts.length; i++) {
    const text = String(texts[i] === null || texts[i] === undefined ? '' : texts[i]);
    const match = /\b(?:CLASS|CL|SERIES|SER)\.?\s+([A-Z])\b/i.exec(text) || /[A-Z]-\s?([A-Z])(?:\s|$)/i.exec(text);
    if (match) return match[1].toUpperCase();
  }
  return '';
}

/** Both symbol directories through the brand's `getText`, null when one fails (`parseUsListings`); load once per run. */
export async function readUsListings(getText: (url: string, label: string) => Promise<string>): Promise<Map<string, string> | null> {
  try {
    return parseUsListings(await Promise.all(nportUsListingsUrls().map((url) => getText(url, `Nasdaq Trader ${url.replace(/^.*\//, '')}`))));
  } catch {
    return null;
  }
}

/** A security or sheet name without its share description: `Accenture plc Class A Ordinary Shares (Ireland)` -> `Accenture plc`. */
function nportIssuerName(value: unknown): string {
  return String(value === null || value === undefined ? '' : value).split(' - ')[0]
    .replace(/\s+(?:\(|(?:CLASS|SERIES)\s+[A-Z]\b|COMMON\b|ORDINARY\b|SUBORDINATE\b|SUB\.?\s+VOT|(?:LIMITED|RESTRICTED)\s+VOTING\b|VOTING\b|SHARES?\b|STOCK\b|AMERICAN\s+DEPOSITARY\b|TRADING\s+UNDER\b)[\s\S]*$/i, '');
}

/**
 * Is `ticker` the company's own U.S. listing? The Nasdaq Trader directories (`parseUsListings`) list it under the same company
 * (same name key, or one key the start of the other: `BUNGE GLOBAL` and the directory's `BUNGE`, a name cut short after two words
 * or more: `CHECK POINT SOFTWARE TECH`), and not as depositary or New York registry shares, which are another security than
 * the foreign line (Shell's SHEL ADR, ASML's New York shares). When the issuer has several listed classes, the name or title
 * must state the listed class (Liberty Latin America Class C is LILAK, not LILA). False without listings. Callers check that
 * the line trades in U.S. dollars: a Toronto or London line of the same company in its own currency never gets the U.S. ticker.
 */
export function nportUsListed(listings: Map<string, string> | null, ticker: string, name: unknown, title: unknown = ''): boolean {
  if (!listings) return false;
  const listed = listings.get(String(ticker).trim().toUpperCase().replace(/[./ ]/g, '-'));
  if (listed === undefined || /\bDEPOSITARY\b|\bADSS?\b|\bADRS?\b|\bREGISTRY\b/i.test(listed)) return false;
  const a = nportNameKey(nportIssuerName(listed)), b = nportNameKey(nportIssuerName(name));
  if (!a || !b) return false;
  const short = a.length < b.length ? a : b, long = a.length < b.length ? b : a;
  if (a !== b && !(short.length >= 4 && long.indexOf(`${short} `) === 0) && !(short.split(' ').length >= 2 && long.indexOf(short) === 0)) return false;
  const listedClass = nportShareClass(listed);
  return !listedClass || !listings.has(`\u0000${a}`) || nportShareClass(name, title) === listedClass;
}

/**
 * Exchange tickers for the positions, in their order ('' for none). A ticker is given only to a common-stock row (assetCat
 * EC; a preferred EP, a CVR, right, warrant or escrow line gets none, a name match would give it the issuer's common ticker):
 * - U.S. ISIN or none, traded in USD (or with no currency): the filer's own `<ticker value>`, else the SEC issuer-name table
 *   (`names`) when the row has a CUSIP or a U.S. ISIN, else a renamed issuer (`nportRenamedIssuers`)
 * - foreign ISIN (Linde IE, NXP NL, IMAX CA): only traded in USD and only when the symbol directories (`listings`,
 *   `parseUsListings`) confirm the filer's or the name-matched ticker for the same company (`nportUsListed`); a local line in
 *   another currency, and every foreign row without listings, gets none
 * A ticker that lands on two different securities (Alphabet A and C, an ordinary share and its ADR) is dropped from the
 * name-matched rows; when the filer itself gave it to two securities it is dropped from all of them. Rows still without a
 * ticker get the second, looser name match (`nportLooseTickers`), which never changes a ticker given here. Bonds, cash, funds
 * and derivatives stay identifier-keyed.
 */
export function nportTickers(positions: ReadonlyArray<NportPosition>, names: Map<string, string> | null = null, listings: Map<string, string> | null = null): string[] {
  const fromFiler: boolean[] = [];
  const secTickers = new Set<string>();
  if (names) names.forEach((ticker, key) => { if (key.charAt(0) !== '\u0001') secTickers.add(ticker); });
  const renames = nportRenamedIssuers();
  const renamed = (position: NportPosition, key: string): string => {
    const issuer = (position.cusip || (/^US[0-9A-Z]{10}$/.test(position.isin) ? position.isin.slice(2, 11) : '')).slice(0, 6);
    const hit = renames.filter((entry) => entry[0] === key && entry[2] === issuer && secTickers.has(entry[1]))[0];
    return hit ? hit[1] : '';
  };
  const tickers = positions.map((position, index) => {
    fromFiler[index] = false;
    const equity = position.assetCat === 'EC' && !position.derivative && !nportIsRight(position);
    const foreign = Boolean(position.isin) && position.isin.slice(0, 2) !== 'US';
    const usd = foreign ? position.currency === 'USD' && Boolean(listings) : !position.currency || position.currency === 'USD';
    if (!equity || !usd) return '';
    const filer = /^[A-Z][A-Z0-9.-]{0,9}$/.test(position.ticker) ? position.ticker : '';
    const key = nportNameKey(position.name);
    const named = names && (/^[0-9A-Z]{9}$/.test(position.cusip) || /^[A-Z]{2}[0-9A-Z]{10}$/.test(position.isin)) ? names.get(key) || names.get(key.replace(/ CL [A-Z]$/, '')) || '' : '';
    if (!foreign) {
      fromFiler[index] = Boolean(filer);
      return filer || named || (names ? renamed(position, key) : '');
    }
    if (filer && nportUsListed(listings, filer, position.name, position.title)) {
      fromFiler[index] = true;
      return filer;
    }
    return named && nportUsListed(listings, named, position.name, position.title) ? named : '';
  });
  const securities = new Map<string, { keys: string[]; filer: string[] }>();
  tickers.forEach((ticker, index) => {
    if (!ticker) return;
    const position = positions[index];
    const key = position.cusip || position.isin || position.other || nportNameKey(position.name);
    const seen = securities.get(ticker) || { keys: [], filer: [] };
    if (seen.keys.indexOf(key) < 0) seen.keys.push(key);
    if (fromFiler[index] && seen.filer.indexOf(key) < 0) seen.filer.push(key);
    securities.set(ticker, seen);
  });
  const exact = tickers.map((ticker, index) => {
    const seen = ticker ? securities.get(ticker) : undefined;
    if (!seen || seen.keys.length < 2) return ticker;
    return seen.filer.length === 1 && fromFiler[index] ? ticker : '';
  });
  return nportLooseTickers(positions, exact, names, listings);
}

/**
 * The second name match (open-items etfs Q35) for the common-stock rows `nportTickers` left without a ticker; the tickers it
 * already gave never change. The row's loose key (`nportLooseKey`) must name one company: in the SEC table (`\u0001` entries of
 * `parseSecCompanyNames`, one CIK) and/or in the symbol directories (`\u0001` entries of `parseUsListings`, common shares only),
 * and when both know the key they must agree on the company. Of that company's tickers only its listed common shares count
 * (with one SEC ticker and no listing, that ticker); several of them (Fox, Lennar, Zillow) need the class the row states in its
 * name or title, matched to the listed security name, else no ticker. A foreign ISIN needs the directory listing of the same
 * key (its own U.S. shares, never depositary ones). A ticker that a row of `exact` holds for another security, or that this pass
 * finds for two securities, is dropped.
 */
function nportLooseTickers(positions: ReadonlyArray<NportPosition>, exact: string[], names: Map<string, string> | null, listings: Map<string, string> | null): string[] {
  if (!names) return exact;
  const companyOf = new Map<string, string>();
  names.forEach((tickers, key) => { if (key.charAt(0) === '\u0001' && tickers) tickers.split(' ').forEach((ticker) => companyOf.set(ticker, key)); });
  const securityOf = (position: NportPosition): string => position.cusip || position.isin || position.other || nportNameKey(position.name);
  const listedClass = (symbol: string): string => nportShareClass(listings ? listings.get(symbol) : '');
  const found = positions.map((position, index) => {
    if (exact[index] || position.assetCat !== 'EC' || position.derivative || nportIsRight(position)) return '';
    const foreign = Boolean(position.isin) && position.isin.slice(0, 2) !== 'US';
    if (foreign ? position.currency !== 'USD' || !listings : position.currency && position.currency !== 'USD') return '';
    if (!/^[0-9A-Z]{9}$/.test(position.cusip) && !/^[A-Z]{2}[0-9A-Z]{10}$/.test(position.isin)) return '';
    const key = nportLooseKey(position.name);
    if (!key) return '';
    const sec = names.get(`\u0001${key}`);
    const listed = listings ? listings.get(`\u0001${key}`) : undefined;
    if (sec === '' || (sec === undefined && listed === undefined) || (foreign && !listed)) return '';
    const listedSymbols = listed ? listed.split(' ') : [];
    // the company: the SEC entry of the key, else the one SEC entry every listed symbol of the key belongs to
    const company = sec !== undefined ? `\u0001${key}` : companyOf.get(listedSymbols[0]) || '';
    if (!company || listedSymbols.some((symbol) => companyOf.get(symbol) !== company)) return '';
    const tickers = String(names.get(company) || '').split(' ').filter(Boolean);
    const common = tickers.filter((ticker) => listings && listings.has(ticker) && nportListedCommon(String(listings.get(ticker))));
    const candidates = common.length ? common : tickers.length === 1 && !foreign ? tickers : [];
    if (foreign && candidates.some((ticker) => listedSymbols.indexOf(ticker) < 0)) return '';
    const wanted = nportShareClass(position.name, position.title);
    if (candidates.length === 1) return !wanted || !listings || !listings.has(candidates[0]) || !listedClass(candidates[0]) || listedClass(candidates[0]) === wanted ? candidates[0] : '';
    const classed = wanted ? candidates.filter((ticker) => listedClass(ticker) === wanted) : [];
    return classed.length === 1 ? classed[0] : '';
  });
  const taken = new Map<string, string[]>();
  exact.forEach((ticker, index) => { if (ticker) taken.set(ticker, (taken.get(ticker) || []).concat(securityOf(positions[index]))); });
  found.forEach((ticker, index) => {
    if (!ticker) return;
    const seen = taken.get(ticker) || [];
    if (seen.indexOf(securityOf(positions[index])) < 0) taken.set(ticker, seen.concat(securityOf(positions[index])));
  });
  return exact.map((ticker, index) => ticker || (found[index] && (taken.get(found[index]) || []).length === 1 ? found[index] : ''));
}

/** The browse-edgar Atom feed of one series' NPORT-P filings. */
export function nportSeriesFeedUrl(seriesId: string, count = 10): string {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(String(seriesId).toUpperCase())}&type=NPORT-P&dateb=&owner=include&count=${count}&output=atom`;
}

/** The registrant's submissions JSON (report periods of its recent filings). */
export function nportSubmissionsUrl(cik: string): string {
  return `https://data.sec.gov/submissions/CIK${`0000000000${Number(String(cik).replace(/\D/g, '')) || 0}`.slice(-10)}.json`;
}

/** primary_doc.xml of a filing in the registrant's own folder. Throws without a registrant CIK: the accession prefix is the filer agent. */
export function nportDocumentUrl(registrantCik: string, accession: string): string {
  const cik = Number(String(registrantCik).replace(/\D/g, ''));
  if (!cik) throw new Error(`N-PORT ${accession}: no registrant CIK (the accession prefix is the filer agent, never used as the folder)`);
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${String(accession).replace(/-/g, '')}/primary_doc.xml`;
}

/** NPORT-P entries of a browse-edgar Atom feed (amendments and other forms skipped), with the registrant CIK of the filing link. */
export function parseNportFeed(atom: string): NportCandidate[] {
  const out: NportCandidate[] = [];
  const entries = /<entry>([\s\S]*?)<\/entry>/gi;
  let entry: RegExpExecArray | null;
  while ((entry = entries.exec(String(atom === null || atom === undefined ? '' : atom))) !== null) {
    const body = entry[1];
    const form = (nportTag(body, 'filing-type') || nportAttr(body, 'category', 'term')).toUpperCase();
    const accession = nportTag(body, 'accession-number');
    if (form !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    const folder = /\/Archives\/edgar\/data\/(\d+)\//i.exec(nportTag(body, 'filing-href'));
    out.push({ accession, filed: nportIso(nportTag(body, 'filing-date')), period: nportIso(nportTag(body, 'period')), cik: folder ? folder[1] : '' });
  }
  return out;
}

/** NPORT-P filings of a registrant's submissions JSON (`filings.recent`), with report periods; the registrant is the JSON's own CIK. */
export function parseNportSubmissions(payload: unknown): NportCandidate[] {
  const record = (payload && typeof payload === 'object' ? payload : {}) as { cik?: unknown; filings?: { recent?: Record<string, unknown> } };
  const recent = record.filings && record.filings.recent ? record.filings.recent : {};
  const column = (name: string): unknown[] => (Array.isArray(recent[name]) ? (recent[name] as unknown[]) : []);
  const forms = column('form'), accessions = column('accessionNumber'), filed = column('filingDate'), periods = column('reportDate');
  const cik = String(record.cik === null || record.cik === undefined ? '' : record.cik).replace(/\D/g, '');
  const out: NportCandidate[] = [];
  for (let i = 0; i < forms.length; i++) {
    const accession = String(accessions[i] === null || accessions[i] === undefined ? '' : accessions[i]);
    if (String(forms[i]).toUpperCase() !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    out.push({ accession, filed: nportIso(filed[i]), period: nportIso(periods[i]), cik });
  }
  return out;
}

/**
 * Candidates newest report period first, then newest filing: a late filing for an older period never wins. A missing
 * period is taken from `known` (the registrant's submissions) by accession; candidates still without one go last.
 */
export function nportNewestFirst(candidates: ReadonlyArray<NportCandidate>, known: ReadonlyArray<NportCandidate> = []): NportCandidate[] {
  const periods = new Map<string, string>();
  for (let i = 0; i < known.length; i++) if (known[i].period) periods.set(known[i].accession, known[i].period);
  return candidates
    .map((candidate) => (candidate.period ? candidate : { ...candidate, period: periods.get(candidate.accession) || '' }))
    .sort((a, b) => (a.period && b.period ? b.period.localeCompare(a.period) : a.period ? -1 : b.period ? 1 : 0) || b.filed.localeCompare(a.filed));
}

/**
 * Does the filing belong to the fund? With a series id: only the same series id. Without one: the normalized series name
 * equals the fund name, or (`loose`, reported to the caller) one contains the other. Returns the problem, or null.
 */
export function nportIdentity(filing: Pick<NportFiling, 'seriesId' | 'seriesName'>, fund: { seriesId?: string | null; name?: string | null }): { problem: string | null; loose: boolean } {
  const wantedSeries = String(fund.seriesId || '').trim().toUpperCase();
  if (wantedSeries) return { problem: filing.seriesId === wantedSeries ? null : `names series ${filing.seriesId || 'none'}, not ${wantedSeries}`, loose: false };
  const filed = nportNameKey(filing.seriesName), wanted = nportNameKey(fund.name);
  if (!filed || !wanted) return { problem: 'no series id and no fund name to match', loose: false };
  if (filed === wanted) return { problem: null, loose: false };
  if (filed.indexOf(wanted) >= 0 || wanted.indexOf(filed) >= 0) return { problem: null, loose: true };
  return { problem: `names series "${filing.seriesName}", not "${String(fund.name)}"`, loose: false };
}

/**
 * May a filing replace the published holdings? Nothing published (no rows): any dated or undated report. Otherwise only a
 * report period strictly newer than the published holdings date; both must be ISO dates (convert the brand's display
 * date first), an unknown date on either side keeps the published sheet.
 */
export function nportIsFresh(repPdDate: unknown, publishedAsOf: unknown, publishedRows: unknown): boolean {
  if (!(Number(publishedRows) > 0)) return true;
  const report = nportIso(repPdDate), published = nportIso(publishedAsOf);
  return Boolean(report && published && String(publishedAsOf).trim().length === 10 && report > published);
}

export type NportRead = { filing: NportFiling; candidate: NportCandidate; url: string; loose: boolean } | { problem: string };

/**
 * The newest N-PORT-P filing of one fund, or why there is none. Candidates: the series' Atom feed (when a series id is known;
 * an empty feed means no filing yet) with periods from the registrant's submissions, else (no series id, or the feed failed)
 * the registrant's NPORT-P filings themselves; newest period first.
 * Documents are read until one passes the identity check (at most `maxDocuments`); that newest own filing is returned only
 * when it is fresh against the published holdings (`published.asOf` ISO, `published.rows`). Errors of the optional
 * submissions request are tolerated; others come back as `problem`. `cache` (one Map per run) keeps the submissions and
 * the parsed documents, so funds of one registrant share requests.
 */
export async function readNportHoldings(
  fund: { ticker: string; cik: string; seriesId?: string | null; name?: string | null },
  published: { asOf?: unknown; rows?: unknown },
  getText: (url: string, label: string) => Promise<string>,
  options: { maxDocuments?: number; cache?: Map<string, unknown> } = {},
): Promise<NportRead> {
  const cache = options.cache || new Map<string, unknown>();
  const once = async <T>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!cache.has(key)) cache.set(key, load().catch((error: unknown) => { cache.delete(key); throw error; }));
    return (await cache.get(key)) as T;
  };
  const cik = String(fund.cik || '').replace(/\D/g, '');
  if (!Number(cik)) return { problem: `${fund.ticker}: no registrant CIK` };
  let known: NportCandidate[] = [];
  try {
    known = await once(`submissions:${Number(cik)}`, async () => parseNportSubmissions(JSON.parse(await getText(nportSubmissionsUrl(cik), `${fund.ticker} N-PORT periods`))));
  } catch {
    known = [];
  }
  // null: no series feed (no series id, or the feed failed), so the registrant's own NPORT-P filings are scanned instead
  let candidates: NportCandidate[] | null = null;
  try {
    if (fund.seriesId) candidates = parseNportFeed(await getText(nportSeriesFeedUrl(fund.seriesId), `${fund.ticker} N-PORT filings`));
  } catch (error) {
    if (!known.length) return { problem: `${fund.ticker}: N-PORT filings unavailable (${error instanceof Error ? error.message : String(error)})` };
  }
  const sorted = nportNewestFirst(candidates || known, known);
  if (!sorted.length) return { problem: `${fund.ticker}: no NPORT-P filing yet` };
  const limit = Math.max(1, options.maxDocuments || (candidates ? 3 : 12));
  const misses: string[] = [];
  for (let i = 0; i < sorted.length && i < limit; i++) {
    const candidate = sorted[i];
    const url = nportDocumentUrl(Number(candidate.cik) ? candidate.cik : cik, candidate.accession);
    let filing: NportFiling;
    try {
      filing = await once(`document:${url}`, async () => parseNportFiling(await getText(url, `${fund.ticker} N-PORT ${candidate.accession}`)));
    } catch (error) {
      misses.push(`${candidate.accession} unreadable (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const identity = nportIdentity(filing, fund);
    if (identity.problem) {
      misses.push(`${candidate.accession} ${identity.problem}`);
      continue;
    }
    if (!filing.positions.length) return { problem: `${fund.ticker}: ${candidate.accession} has no positions` };
    if (!nportIsFresh(filing.repPdDate, published.asOf, published.rows)) return { problem: `${fund.ticker}: N-PORT ${filing.repPdDate || 'undated'} is not newer than the published holdings (${String(published.asOf || 'undated')})` };
    return { filing, candidate, url, loose: identity.loose };
  }
  return { problem: `${fund.ticker}: no N-PORT-P filing of its own${misses.length ? `: ${misses.join('; ')}` : ''}` };
}
// </nport-reader>

// <calendar-dates> shared block of .claude/tools/etfs/etf-std/calendar-dates.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * A calendar date as ISO `YYYY-MM-DD`, or null. Pure text work, never `Date.parse` or local getters, so a run in Tokyo
 * publishes the same day as CI (open-items etfs ETF-H4). Accepts ISO (`2026-10-24`, with a time the date part is kept as
 * written), `2026/10/24`, U.S. `10/24/2026` and `10-24-26` (two-digit years up to 69 are 20xx), month names in either order
 * (`Oct 24, 2026`, `October 24 2026`, `Sept. 30, 2026`, `24 Oct 2026`, `24-Oct-26`), an optional weekday or `as of` in front.
 * A day that does not exist (`02/30/2026`) is null.
 */
export function calendarIso(value: unknown): string | null {
  const text = String(value === null || value === undefined ? '' : value).replace(/[\s ]+/g, ' ').trim()
    .replace(/^as of:? /i, '').replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,? /i, '');
  const year = (raw: string): number => (raw.length === 2 ? (Number(raw) <= 69 ? 2000 : 1900) + Number(raw) : Number(raw));
  const month = (raw: string): number => {
    const word = raw.toLowerCase();
    const names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    for (let i = 0; i < names.length; i++) if (word.length >= 3 && names[i].indexOf(word) === 0) return i + 1;
    return 0;
  };
  let y = 0, m = 0, d = 0, match: RegExpExecArray | null;
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(text)) || (match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text))) {
    y = Number(match[1]); m = Number(match[2]); d = Number(match[3]);
  } else if ((match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = Number(match[1]); d = Number(match[2]);
  } else if ((match = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(text))) {
    y = Number(match[3]); m = month(match[1]); d = Number(match[2]);
  } else if ((match = /^(\d{1,2})(?:st|nd|rd|th)?[ -]([A-Za-z]{3,9})\.?,?[ -](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = month(match[2]); d = Number(match[1]);
  } else {
    return null;
  }
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1 || d > days[m - 1]) return null;
  return `${y}-${m < 10 ? '0' : ''}${m}-${d < 10 ? '0' : ''}${d}`;
}

/**
 * Is the fund at least `years` old on `asOf`? Calendar anniversary, inclusive: a fund started 2025-10-24 is one year old on
 * 2026-10-24 (a 29 February start on 1 March). Unknown or unreadable dates answer true, so a value is never dropped for want
 * of a date. The shared "younger than one year" rule: since-inception returns are annualized only from one year on.
 */
export function fundAgeAtLeast(inception: unknown, asOf: unknown, years: number): boolean {
  const start = calendarIso(inception), end = calendarIso(asOf);
  if (!start || !end) return true;
  return end >= `${Number(start.slice(0, 4)) + years}${start.slice(4)}`;
}

/**
 * The returns with every horizon the fund is too young for set to null: `horizons` maps a key of `returns` to the years it
 * needs (`{ yr1: 1, cagr3y: 3, siAnn: 1 }`). Keys that are absent or already null stay as they are; the object is copied.
 */
export function withoutYoungReturns<T extends object>(returns: T, inception: unknown, asOf: unknown, horizons: Record<string, number>): T {
  const out: Record<string, unknown> = { ...(returns as Record<string, unknown>) };
  const keys = Object.keys(horizons);
  for (let i = 0; i < keys.length; i++) {
    if (out[keys[i]] !== undefined && out[keys[i]] !== null && !fundAgeAtLeast(inception, asOf, horizons[keys[i]])) out[keys[i]] = null;
  }
  return out as T;
}
// </calendar-dates>

// <windowed-chart> shared block of .claude/tools/etfs/etf-std/windowed-chart.block.ts, applied by apply-block.ts: never edit it in one repo
export type WindowedChartDay = { date: string; close: number; adjClose: number; volume: number; adjCloseRaw?: number };
export type WindowedChartDividend = { epoch: number; amount: number };

/**
 * A HISTORY_RANGE window (`period1` N years back) never shrinks the published history, and with it the 3y, 5y, 10y and
 * since-inception returns (open-items etfs Q25; was a byte-identical copy in Fidelity, Invesco and JPMorgan). The published
 * rows older than the first fresh day are put in front of the fresh days; their Adj Close is rescaled by the ratio measured on
 * the overlapping days (Yahoo re-adjusts the whole series after each distribution). Published distributions older than the
 * window are kept as well. Returns the chart unchanged when nothing published is older, and null when the window cannot be
 * joined safely (no overlap, Close changed, inconsistent or implausible ratio): the caller then keeps the fund as published.
 * `published` rows carry `Date` (any calendarIso form), `Close`, `Adj Close`, `Volume`; distribution rows are
 * [date, amount, ...] arrays. The chart's days must be sorted by ISO date.
 */
export function mergeWindowedChart<C extends { days: WindowedChartDay[]; dividends: WindowedChartDividend[] }>(chart: C, published: ReadonlyArray<Record<string, unknown>>, publishedDistributions: ReadonlyArray<unknown> = []): C | null {
  if (!chart.days.length || !published.length) return chart;
  const num = (value: unknown): number | null => {
    const text = String(value === null || value === undefined ? '' : value).replace(/[\s,$]/g, '');
    return text && Number.isFinite(Number(text)) ? Number(text) : null;
  };
  const firstFresh = chart.days[0].date;
  const rows: Array<{ date: string; close: number; adjClose: number; volume: number }> = [];
  for (let i = 0; i < published.length; i++) {
    const date = calendarIso(published[i].Date), close = num(published[i].Close), adjClose = num(published[i]['Adj Close']);
    if (date && close !== null && adjClose !== null && adjClose > 0) rows.push({ date, close, adjClose, volume: num(published[i].Volume) || 0 });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const older = rows.filter((row) => row.date < firstFresh);
  if (!older.length) return chart;
  const byDate = new Map<string, { close: number; adjClose: number }>();
  for (let i = 0; i < rows.length; i++) byDate.set(rows[i].date, rows[i]);
  const adjRatios: number[] = [];
  const closeRatios: number[] = [];
  for (let i = 0; i < chart.days.length; i++) {
    const day = chart.days[i];
    const prior = byDate.get(day.date);
    if (!prior) continue;
    adjRatios.push((day.adjCloseRaw === undefined ? day.adjClose : day.adjCloseRaw) / prior.adjClose);
    if (prior.close > 0) closeRatios.push(day.close / prior.close);
  }
  if (!adjRatios.length) return null;
  const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  if (closeRatios.length && Math.abs(mean(closeRatios) - 1) > 1e-3) return null;
  if (Math.max.apply(null, adjRatios) / Math.min.apply(null, adjRatios) - 1 > 5e-3) return null;
  const measured = mean(adjRatios);
  if (measured < 0.5 || measured > 1.001) return null;
  const factor = Math.abs(measured - 1) < 1e-4 ? 1 : measured;
  const days: WindowedChartDay[] = older.map((row) => {
    const raw = row.adjClose * factor;
    return { date: row.date, close: row.close, adjClose: factor === 1 ? row.adjClose : Math.round(raw * 100) / 100, volume: row.volume, adjCloseRaw: raw };
  });
  const firstFreshEpoch = Date.UTC(Number(firstFresh.slice(0, 4)), Number(firstFresh.slice(5, 7)) - 1, Number(firstFresh.slice(8, 10))) / 1000;
  const kept: WindowedChartDividend[] = [];
  for (let i = 0; i < publishedDistributions.length; i++) {
    const cells = publishedDistributions[i];
    const date = Array.isArray(cells) ? calendarIso(cells[0]) : null;
    const amount = Array.isArray(cells) ? num(cells[1]) : null;
    if (!date || amount === null || amount <= 0) continue;
    const epoch = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 1000;
    if (epoch < firstFreshEpoch) kept.push({ epoch, amount });
  }
  kept.sort((a, b) => a.epoch - b.epoch);
  return { ...chart, days: days.concat(chart.days), dividends: kept.concat(chart.dividends.filter((dividend) => dividend.epoch >= firstFreshEpoch)) };
}
// </windowed-chart>

// <fund-selection> shared block of .claude/tools/etfs/etf-std/fund-selection.block.ts, applied by apply-block.ts: never edit it in one repo
/** An index row as far as these helpers read it: the ticker and whether it has published data (`dataFile`, null for a catalog-only row). */
export type FundSelectionRow = { ticker?: unknown; dataFile?: unknown };

function fundSelectionTicker(row: FundSelectionRow): string {
  return String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
}

/**
 * The tickers a TICKERS entry may name: the live catalog plus every fund with published data (closed funds included). When
 * the live catalog could not be read (`live` null) every previous index row counts, since nothing tells a real catalog-only
 * row from a stale one. A catalog-only row from an earlier mistyped TICKERS run is therefore not "known" (open-items etfs Q27).
 */
export function knownTickers(live: ReadonlyArray<string> | null, previous: ReadonlyArray<FundSelectionRow>): string[] {
  const out: string[] = [];
  const add = (ticker: string): void => { if (ticker && out.indexOf(ticker) < 0) out.push(ticker); };
  if (live) for (let i = 0; i < live.length; i++) add(String(live[i]).trim().toUpperCase());
  for (let i = 0; i < previous.length; i++) if (!live || previous[i].dataFile) add(fundSelectionTicker(previous[i]));
  return out;
}

/** Throws before any fund request when TICKERS names a fund outside `known` (see knownTickers): a clear error, nothing fetched or written. */
export function assertKnownTickers(selected: ReadonlyArray<string> | null, known: ReadonlyArray<string>, where: string): void {
  const unknown = (selected || []).map((ticker) => String(ticker).trim().toUpperCase()).filter((ticker) => ticker && known.indexOf(ticker) < 0);
  if (unknown.length) throw new Error(`TICKERS: ${unknown.join(', ')} not in ${where}; nothing was fetched or written`);
}

/**
 * The index rows without stale catalog-only rows: a row with no published data whose ticker the live catalog no longer lists
 * (an earlier mistyped TICKERS entry, a fund withdrawn before launch). Rows with data always stay; nothing is dropped when the
 * live catalog could not be read (`live` null).
 */
export function withoutStalePlaceholders<T extends FundSelectionRow>(rows: ReadonlyArray<T>, live: ReadonlyArray<string> | null): T[] {
  if (!live) return rows.slice();
  const listed = live.map((ticker) => String(ticker).trim().toUpperCase());
  return rows.filter((row) => Boolean(row.dataFile) || listed.indexOf(fundSelectionTicker(row)) >= 0);
}

/**
 * New funds of a run (open-items etfs Q28): `published` - first published in this run (the previous index had no row for it,
 * or only a catalog-only one), so a fund whose first read failed is announced when it finally succeeds; `pending` - new in the
 * catalog this run but not published yet. Nothing is reported on a first run (empty previous index).
 */
export function newFundsReport(previous: ReadonlyArray<FundSelectionRow>, next: ReadonlyArray<FundSelectionRow>): { published: string[]; pending: string[] } {
  const report = { published: [] as string[], pending: [] as string[] };
  if (!previous.length) return report;
  const before = new Map<string, boolean>();
  for (let i = 0; i < previous.length; i++) before.set(fundSelectionTicker(previous[i]), Boolean(previous[i].dataFile));
  for (let i = 0; i < next.length; i++) {
    const ticker = fundSelectionTicker(next[i]);
    if (!ticker || before.get(ticker)) continue;
    if (next[i].dataFile) report.published.push(ticker);
    else if (!before.has(ticker)) report.pending.push(ticker);
  }
  report.published.sort();
  report.pending.sort();
  return report;
}

/** The log and step-summary lines of a newFundsReport: `NEW FUNDS: A, B` and `NEW FUNDS (not published yet): C`; none when empty. */
export function newFundsLines(report: { published: ReadonlyArray<string>; pending: ReadonlyArray<string> }): string[] {
  const lines: string[] = [];
  if (report.published.length) lines.push(`NEW FUNDS: ${report.published.join(', ')}`);
  if (report.pending.length) lines.push(`NEW FUNDS (not published yet): ${report.pending.join(', ')}`);
  return lines;
}
// </fund-selection>

// <range-52w> shared block of .claude/tools/etfs/etf-std/range-52w.block.ts, applied by apply-block.ts: never edit it in one repo
export type Range52w = {
  week52Low: number | null; week52High: number | null; range52w: number | null; range52wClose: number | null; range52wAsOf: string | null;
  range52wSince: string | null; range52wBasis: string | null;
};

/**
 * The price columns of a history sheet, tried in this order: the market close first, NAV only when no market price is
 * published. A function, not a const: the block sits at the end of update-data.ts, after the top-level `await main()`.
 */
export function range52wColumns(): string[] {
  return ['Close', 'Market Price', 'NAV', 'NAV per Share'];
}

/** The seven `metrics` keys of the 52-week range, all null: a catalog-only row and a fund without history carry this. */
export function range52wEmpty(): Range52w {
  return { week52Low: null, week52High: null, range52w: null, range52wClose: null, range52wAsOf: null, range52wSince: null, range52wBasis: null };
}

/**
 * The 52-week range from the closes of a fund's published history sheet (owner, 2026-10-29: closes, not intraday highs and
 * lows; no extra requests). `headers` are the sheet headers, `rows` objects keyed by header or arrays in header order.
 * - Price column: the first of range52wColumns() with at least two numeric values (`$1,234.50` reads as 1234.5); the date
 *   column is `Date`, else `As Of`, else the first header. Dates go through calendarIso, so every published format works
 * - Window: the last dated close and every close up to 52 weeks (364 days) before it. `week52Low` and `week52High` are the
 *   lowest and highest close of the window, `range52w` the position of the last close between them in percent
 *   (0 = at the low, 100 = at the high, 2 decimals). The last close is part of the window, so it never falls outside;
 *   `range52wClose` and `range52wAsOf` are that close and its date (it can differ from the row's closePrice source)
 * - A fund with less than 52 weeks of history gets the range since its first published close, and `range52wSince` names
 *   that date (owner: "alternative" - the range since launch with a note); a full window has `range52wSince: null`
 * - `range52wBasis` names the column used. Fewer than two closes give range52wEmpty(); a flat window (high = low) keeps
 *   low and high but `range52w: null`, never a made-up 0 or 50
 */
export function range52wMetrics(headers: string[], rows: unknown[]): Range52w {
  const list = Array.isArray(headers) ? headers.map((h) => String(h)) : [];
  const dateHeader = list.indexOf('Date') >= 0 ? 'Date' : list.indexOf('As Of') >= 0 ? 'As Of' : list[0];
  const cell = (row: unknown, header: string): unknown => {
    if (Array.isArray(row)) return row[list.indexOf(header)];
    return row && typeof row === 'object' ? (row as Record<string, unknown>)[header] : undefined;
  };
  const price = (value: unknown): number | null => {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
    const text = String(value === null || value === undefined ? '' : value).replace(/[$,\s]/g, '');
    if (!/^\d+(\.\d+)?$/.test(text)) return null;
    const number = Number(text);
    return number > 0 ? number : null;
  };
  const all = Array.isArray(rows) ? rows : [], columns = range52wColumns();
  for (let c = 0; c < columns.length; c++) {
    const column = columns[c];
    if (list.indexOf(column) < 0 || !dateHeader) continue;
    const points: Array<{ date: string; close: number }> = [];
    for (let i = 0; i < all.length; i++) {
      const date = calendarIso(cell(all[i], dateHeader)), close = price(cell(all[i], column));
      if (date && close !== null) points.push({ date, close });
    }
    if (points.length < 2) continue;
    points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const last = points[points.length - 1];
    const end = Date.UTC(Number(last.date.slice(0, 4)), Number(last.date.slice(5, 7)) - 1, Number(last.date.slice(8, 10)));
    const start = new Date(end - 364 * 86400000).toISOString().slice(0, 10);
    const window = points.filter((p) => p.date >= start);
    if (window.length < 2) continue;
    let low = window[0].close, high = window[0].close;
    for (let i = 1; i < window.length; i++) { low = Math.min(low, window[i].close); high = Math.max(high, window[i].close); }
    const round = (value: number, digits: number): number => Number(value.toFixed(digits));
    return {
      week52Low: round(low, 4), week52High: round(high, 4),
      range52w: high > low ? round(((last.close - low) / (high - low)) * 100, 2) : null, range52wClose: round(last.close, 4), range52wAsOf: last.date,
      range52wSince: points[0].date > start ? points[0].date : null,
      range52wBasis: column,
    };
  }
  return range52wEmpty();
}
/**
 * The index rows with the five 52-week keys in every `metrics`, computed from each fund's published history pages
 * (`funds/<T>/history/*.json` under `feedRoot`, the folder of index.json). Call it on the final rows right before
 * index.json is written: updated, unchanged and kept funds all get the range of the history they publish, a row without
 * `dataFile` or without history pages gets range52wEmpty(). A row without a `metrics` object is left as it is. The seven
 * keys go in front of `returnsBasis` and `performanceAsOf`, so those two stay the last keys of `metrics`.
 */
export async function withRange52w<T>(feedRoot: URL | string, funds: T[]): Promise<T[]> {
  const fs = await import('node:fs/promises');
  const { pathToFileURL } = await import('node:url');
  const root = feedRoot instanceof URL ? new URL(feedRoot.href.replace(/\/?$/, '/')) : new URL(pathToFileURL(String(feedRoot).replace(/\/?$/, '/')).href); // global URL, also with older @types/node (Amplify)
  const out: T[] = [];
  for (const fund of Array.isArray(funds) ? funds : []) {
    const row = fund as unknown as Record<string, unknown>;
    if (!row || typeof row !== 'object' || !row.metrics || typeof row.metrics !== 'object') { out.push(fund); continue; }
    let range = range52wEmpty();
    const dataFile = typeof row.dataFile === 'string' ? row.dataFile : '';
    if (dataFile) {
      const dir = new URL(`${dataFile.replace(/^\.\//, '').replace(/[^/]*$/, '')}history/`, root);
      const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((name) => /\.json$/.test(name)).sort();
      let headers: string[] = [];
      const rows: unknown[] = [];
      for (const name of names) {
        const page = await fs.readFile(new URL(name, dir), 'utf8').then((text) => JSON.parse(text)).catch(() => null);
        if (!page || !Array.isArray(page.rows)) continue;
        if (!headers.length && Array.isArray(page.headers)) headers = page.headers;
        for (const item of page.rows) rows.push(item);
      }
      range = range52wMetrics(headers, rows);
    }
    // the range keys go in front of returnsBasis and performanceAsOf, which stay the last two keys (metrics contract)
    const metrics: Record<string, unknown> = {}, old = row.metrics as Record<string, unknown>, tail = ['returnsBasis', 'performanceAsOf'];
    for (const key of Object.keys(old)) if (tail.indexOf(key) < 0 && !(key in range)) metrics[key] = old[key];
    Object.assign(metrics, range);
    for (const key of tail) if (key in old) metrics[key] = old[key];
    out.push({ ...row, metrics } as unknown as T);
  }
  return out;
}
// </range-52w>
