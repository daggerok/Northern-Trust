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
    skipNorthernTrust: 'SKIP_NORTHERNTRUST',
  };
  const range = (v: any): string => v?.source ?? `${Number.isFinite(v?.min) ? v.min : ''}:${Number.isFinite(v?.max) ? v.max : ''}`;
  for (const [key, value] of Object.entries(config)) {
    const name = aliases[key] ?? key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
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
function outputPrintConfig(brand: string, config: Record<string, any>): void {
  const entries: [string, string][] = [...outputConfigEntries(config), ['VERBOSE', String(outputVerbose())]];
  console.log(`[ config   ] ${brand} updater:\n${entries.map(([key, value]) => `              ${key}=${/TOKEN|PASSWORD|SECRET|COOKIE|^SEC_UA$/i.test(key) ? '<redacted>' : outputClean(value)}`).join('\n')}`);
}
function outputHasOutputFilters(config: Record<string, any>): boolean {
  return outputConfigEntries(config).some(([name, value]) =>
    /^(TICKERS|CATEGORY|AUM|TER|DIVIDEND_YIELD|SEC_YIELD|PERFORMANCE_|TOTAL_RETURN_)/.test(name) &&
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
function outputMoney(value: any): string {
  const raw = outputScalar(value);
  if (raw === null || raw === undefined || raw === '—' || raw === '--') return 'null';
  const text = String(raw).replace(/[$,\s]/g, '');
  const match = text.match(/^([+-]?[\d.]+)([KMBT])?$/i);
  if (!match) return outputClean(raw);
  const number = Number(match[1]) * ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[match[2]?.toUpperCase() as 'K' | 'M' | 'B' | 'T'] ?? 1);
  if (!Number.isFinite(number)) return 'null';
  for (const [unit, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${unit}`;
  }
  return `$${number.toFixed(2)}`;
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
    field('div', outputScalar(data.trailingYield ?? data.yields?.effectiveYield ?? data.yields?.dividendYield ?? data.dividendYield ?? metrics.dividendYield)),
    field('sec', outputScalar(data.secYield ?? data.yields?.secYield ?? metrics.secYield)),
    field('wp', data.workplaceRaw),
  ].filter(part => part !== '').join(' ');
  return `[ ${String(index).padStart(width)}/${String(total).padEnd(width)}  ] ${outputClean(ticker).padEnd(5)} ${status.padEnd(9)}${detail ? ` ${detail}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}
function outputCreateReporter(root: URL | string, total: number) {
  let completed = 0;
  return {
    before: (ticker: string) => outputInspectFund(root, ticker),
    async result(ticker: string, before: { digest: string }, status?: string, reason?: unknown, extra: any = {}) {
      const after = await outputInspectFund(root, ticker);
      console.log(outputFundLine(++completed, total, ticker, status ?? (before.digest === after.digest ? 'unchanged' : 'updated'), { ...after.meta, ...extra }, reason));
    },
  };
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
const YAHOO_SEARCH_URL = 'https://query1.finance.yahoo.com/v1/finance/search';
const YAHOO_BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const SEC_DATA_HOST = 'https://data.sec.gov';
const SEC_EFTS_HOST = 'https://efts.sec.gov/LATEST';
const EDGAR_ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';
const EDGAR_BROWSE_URL = 'https://www.sec.gov/cgi-bin/browse-edgar';
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

// "08/21/2026" / "2026-08-21T00:00:00Z" -> "2026-08-21"; anything else passes
// through untouched so an unexpected source format never silently corrupts a
// date column.
export function toIsoDate(raw: unknown): string {
  const text = String(raw ?? '').trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  return text;
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
                       for example "QLC SKOR TIPA".
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
  SKIP_NORTHERNTRUST   1/true to keep the previously published catalog values,
                       holdings and official returns; only the fallbacks
                       (SEC N-PORT-P holdings, Yahoo history) run.

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
  trustCik: string | null;
  source: 'northerntrust' | 'previous index' | 'seed';
};

const EMPTY_RETURNS: CatalogReturns = { ytd: null, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null };
const EMPTY_CUMULATIVE: CumulativeReturns = { yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null };

// The two registrants behind the Northern Trust ETF line-up (see the funds
// list legal footer): the legacy FlexShares series and the newer Northern
// Funds series (muni bond ETFs, distributing ladders, NOEQ). The SEC ticker
// table confirms the registrant per fund at run time; this map only seeds the
// EDGAR fallback before the first lookup.
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
      trustCik: northernTrustCikFor(ticker),
      source: 'northerntrust',
    });
  }
  if (!funds.size) throw new Error('Northern Trust catalog: no ETF rows');
  return [...funds.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
}
export const HOLDINGS_HEADERS = ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Asset Category'];
export const BOND_SHEET_HEADERS = [...HOLDINGS_HEADERS, 'Coupon', 'Maturity'];

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
export function parseNorthernTrustHoldings(text: string, ticker: string): ParsedHoldings | null {
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
      Ticker: cleanHoldingTicker(pickColumn(record, ['Ticker'])) || '-',
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
export function weightsSum(rows: JsonRecord[]): number {
  return round(rows.reduce((sum, row) => sum + (numberOrNull(row.Weight) || 0), 0), 4);
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
// Holding ticker resolution
//
// Northern Trust labels every exchange-listed holding with a ticker, but its
// bond and cash rows come back blank. Those rows keep "-" and are keyed by
// their CUSIP/ISIN/SEDOL Identifier in the Watchlist — the exact convention
// daggerok/SPDR and daggerok/Fidelity use. N-PORT positions (EDGAR fallback)
// are resolved from
// the SEC company-ticker table; the Yahoo symbol search stays available with a
// STRICT name match so a fuzzy hit can never pin the wrong security.
// ---------------------------------------------------------------------------

const HOLDING_NAME_SUFFIXES = new Set([
  'STOCK', 'COMMON', 'PREFERRED', 'PFD', 'SHARES', 'ORDINARY', 'DEPOSITARY', 'ADS', 'ADR',
  'INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED', 'PLC',
  'PUBLIC', 'SA', 'SAS', 'SARL', 'SRL', 'SL', 'KG', 'AG', 'BA', 'BV', 'NV', 'OY', 'SE',
  'AS', 'AB', 'AD', 'KK', 'KABUSHIKI', 'KAISHA', 'PTY', 'PT', 'SFC', 'ANONIMA', 'GMBH',
  'HOLDINGS', 'HLDGS', 'DEL', 'NEW', 'DELISTED', 'REPR', 'GROUP', 'TR', 'TRUST', 'NOTE',
  'NL', 'SPA', 'LP', 'LC', 'LLC', 'CAP', 'STK', 'SHS',
  'NOTES', 'BOND', 'BONDS', 'SER', 'SERIES',
]);
const HOLDING_NAME_PHRASES = new Set([
  'COMMON STOCK', 'PREFERRED STOCK', 'DEPOSITARY SHARES', 'AMERICAN DEPOSITARY SHARES',
  'ORDINARY SHARES', 'LIABILITY CO', 'S A', 'N V', 'B V', 'PRIVATE LTD', 'PUBLIC LTD',
]);
// Words that carry no identity at all: dropped wherever they sit at the edge
// of a filed name, so "The Coca-Cola Co" and "Coca CO" meet.
const HOLDING_NAME_FILLERS = new Set([
  'THE', 'OF', 'AND', 'FOR', 'DE', 'LA', 'LE', 'VAN', 'VON', 'DER', 'DEN', 'DI', 'Y',
  'E', 'DU', 'DA', 'LOS', 'LAS', 'EL', 'AL', 'DEL', 'NPV', 'PAR', 'VAL', 'USD', 'EUR',
  'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'HKD', 'CNY', 'SEK', 'NOK', 'NZD', 'MXN', 'INR',
]);

// Trailing share-class / security-type designations. The class letter is kept
// and canonicalized ("... Class C Capital Stock" -> "... Cl C") rather than
// dropped, so GOOG vs GOOGL — like BF/A vs BF/B — never collide.
const SHARE_CLASS_RE = /(?:\s+(?:CLASS|CL))\s+([A-Z])\b\s*$/;
// Words that only describe the security, never the issuer; safe to peel off the
// end of a filed name (and, once a share class is known, from behind it).
const SECURITY_TYPE_WORDS = new Set([
  'STOCK', 'STK', 'SHARES', 'SHS', 'SH', 'SHARE', 'CAPITAL', 'CAP', 'COMMON', 'ORDINARY',
  'GENERAL', 'VOTING', 'NON', 'NONVOTING', 'NVOTING', 'CONVERTIBLE', 'DEPOSITARY', 'PAID',
  'SUBORDINATED', 'NOTES', 'NOTE', 'SER', 'SERIES', 'LIABILITY', 'NEW', 'REP', 'REPR',
]);

export function normalizeHoldingName(raw: unknown): string {
  const text = String(raw ?? '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  let tokens = text.split(' ').filter(Boolean);
  let classLetter = '';
  let changed = true;
  while (changed && tokens.length > 1) {
    changed = false;
    const withClass = tokens.join(' ').match(SHARE_CLASS_RE);
    if (withClass) {
      classLetter = withClass[1];
      tokens = tokens.slice(0, tokens.length - 2); // drop "Class C" (or "Cl C")
      changed = true;
    }
    const last = tokens[tokens.length - 1];
    if (SECURITY_TYPE_WORDS.has(last) && tokens.length > 1) {
      tokens.pop(); // "... Capital Stock" -> "... Capital"
      changed = true;
      continue;
    }
    if (tokens.length >= 2 && HOLDING_NAME_PHRASES.has(`${tokens[tokens.length - 2]} ${last}`)) {
      tokens = tokens.slice(0, -2);
      changed = true;
      continue;
    }
    if (HOLDING_NAME_SUFFIXES.has(last)) {
      tokens.pop();
      changed = true;
      continue;
    }
    while (tokens.length > 2 && HOLDING_NAME_FILLERS.has(tokens[tokens.length - 1])) {
      tokens.pop(); // keep peeling: a filler may hide the next legal-form suffix
      changed = true;
    }
  }
  while (tokens.length > 1 && HOLDING_NAME_FILLERS.has(tokens[0])) tokens.shift();
  const body = tokens.join(' ').trim();
  return classLetter ? `${body} CL ${classLetter}`.replace(/\s+/g, ' ').trim() : body;
}

export function normalizeHoldingNameCore(raw: unknown): string {
  return normalizeHoldingName(raw).replace(/ /g, '');
}

// Holding tickers keep their class-share markers (SCE^L, BF/A, BRK-B): they
// are the real exchange symbols, unlike fund tickers which sanitizeTicker
// upper-cases and strips everything but letters/digits.
const HOLDING_TICKER_PLACEHOLDERS = new Set(['', 'N/A', 'NA', 'NONE', 'NIL', 'NULL', '-', '--', '---', 'SEE FILE', 'VARIES']);

export function cleanHoldingTicker(raw: unknown): string {
  const symbol = String(raw ?? '').trim().toUpperCase();
  if (HOLDING_TICKER_PLACEHOLDERS.has(symbol)) return '';
  return /^[A-Z0-9][A-Z0-9.^/-]*$/.test(symbol) ? symbol : '';
}

export function yahooSearchUrl(name: string): string {
  return `${YAHOO_SEARCH_URL}?q=${encodeURIComponent(name)}&quotesCount=10&newsCount=0&enableFuzzyQuery=false`;
}

// Strict matcher for Yahoo search payloads: the quote's long name must
// normalize to the same name (or token-core) as the filed holding name. Only
// EQUITY/ETF quotes are accepted, and single/two-word holdings may additionally
// match by token containment (e.g. "BULLISH" -> "Bullish BLCM Inc").
export function pickSearchTicker(name: string, payload: JsonRecord): string | null {
  const matches: unknown[] = Array.isArray(payload?.quoteMatches) ? payload.quoteMatches : [];
  const norm = normalizeHoldingName(name);
  if (!norm) return null;
  const core = norm.replace(/ /g, '');
  const tokens = norm.split(' ');
  for (const match of matches) {
    if (!match || typeof match !== 'object') continue;
    const record = match as JsonRecord;
    const quoteType = String(record.quoteType || '').toUpperCase();
    if (quoteType !== 'EQUITY' && quoteType !== 'ETF') continue;
    const symbol = cleanHoldingTicker(record.symbol);
    if (!symbol) continue;
    const longName = String(record.longname || record.shortname || '');
    const candidate = normalizeHoldingName(longName);
    if (!candidate) continue;
    if (candidate === norm || candidate.replace(/ /g, '') === core) return symbol;
    if (tokens.length <= 2 && tokens.every((token) => candidate.includes(token))) return symbol;
  }
  return null;
}

// ---------------------------------------------------------------------------
// SEC EDGAR fallback layer: N-PORT-P positions for funds the issuer site does
// not publish holdings for, resolved through the EDGAR full-text search API.
// ---------------------------------------------------------------------------

export type NportAccession = { accession: string; filed: string; reportDate: string; url: string };

export function nportUrlFor(cik: string, accession: string): string {
  return `${EDGAR_ARCHIVES}/${Number(String(cik).replace(/^0+/, '') || 0)}/${String(accession).replace(/-/g, '')}/primary_doc.xml`;
}

export function parseNportAccessions(submissions: JsonRecord): NportAccession[] {
  const recent = submissions?.filings?.recent;
  const result: NportAccession[] = [];
  if (!recent || !Array.isArray(recent.form)) return result;
  for (let i = 0; i < recent.form.length; i++) {
    if (recent.form[i] !== 'NPORT-P') continue;
    const accession: string = String(recent.accessionNumber?.[i] || '');
    if (!accession) continue;
    result.push({
      accession,
      filed: String(recent.filingDate?.[i] || ''),
      reportDate: String(recent.reportDate?.[i] || ''),
      url: nportUrlFor(String(submissions.cik || '0'), accession),
    });
  }
  return result;
}

// EDGAR publishes the authoritative "ticker -> registrant CIK + series id"
// table for every ETF and mutual fund class; it is the reliable way to reach a
// fund's own N-PORT-P filing (the full-text search is only a last resort).
export type SecSeriesRef = { cik: string; seriesId: string; classId: string };

export function parseFundTickerMap(payload: JsonRecord): Map<string, SecSeriesRef> {
  const map = new Map<string, SecSeriesRef>();
  const fields: string[] = Array.isArray(payload?.fields) ? payload.fields.map((field: unknown) => String(field)) : [];
  const rows: unknown[] = Array.isArray(payload?.data) ? payload.data : [];
  const at = (row: unknown[], field: string): string => {
    const index = fields.indexOf(field);
    return index >= 0 ? String(row[index] ?? '') : '';
  };
  for (const raw of rows) {
    if (!Array.isArray(raw)) continue;
    const ticker = sanitizeTicker(at(raw, 'symbol'));
    if (!ticker || map.has(ticker)) continue;
    const cik = at(raw, 'cik').replace(/\D/g, '');
    if (!cik || Number(cik) === 0) continue;
    map.set(ticker, {
      cik: cik.padStart(10, '0'),
      seriesId: at(raw, 'seriesId').toUpperCase(),
      classId: at(raw, 'classId').toUpperCase(),
    });
  }
  return map;
}

// Operating-company name -> exchange ticker, so N-PORT positions (which carry
// CUSIP/ISIN but never a ticker) still land in the watchlist with a symbol.
export function parseCompanyTickerMap(payload: JsonRecord): Map<string, string> {
  const map = new Map<string, string>();
  const rows = payload && typeof payload === 'object' ? Object.values(payload as JsonRecord) : [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as JsonRecord;
    const ticker = cleanHoldingTicker(record.ticker);
    const title = String(record.title ?? '');
    if (!ticker || !title) continue;
    for (const key of [normalizeHoldingName(title), normalizeHoldingNameCore(title)]) {
      if (key && !map.has(key)) map.set(key, ticker);
    }
  }
  return map;
}

export function edgarSeriesFilingsUrl(seriesId: string, count = 10): string {
  const params = new URLSearchParams({
    action: 'getcompany',
    CIK: String(seriesId || '').toUpperCase(),
    type: 'NPORT-P',
    dateb: '',
    owner: 'include',
    count: String(count),
    output: 'atom',
  });
  return `${EDGAR_BROWSE_URL}?${params.toString()}`;
}

// browse-edgar's Atom feed for one series: the newest N-PORT-P accessions of
// exactly that fund, newest first.
export function parseEdgarAtomFilings(xml: string): NportAccession[] {
  const result: NportAccession[] = [];
  for (const entry of String(xml || '').matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
    const body = entry[1];
    const form = tagValue(body, 'filing-type') || tagValue(body, 'type');
    if (form && form.toUpperCase() !== 'NPORT-P') continue;
    const accession = tagValue(body, 'accession-number') || tagValue(body, 'accession-nunber');
    if (!accession) continue;
    const hrefMatch = /<filing-href>([\s\S]*?)<\/filing-href>/i.exec(body);
    const cikMatch = hrefMatch ? /\/edgar\/data\/(\d+)\//.exec(cleanText(hrefMatch[1])) : null;
    result.push({
      accession,
      filed: tagValue(body, 'filing-date'),
      reportDate: tagValue(body, 'period') || '',
      url: nportUrlFor(cikMatch ? cikMatch[1] : accession.slice(0, 10), accession),
    });
  }
  return result;
}

function tagValue(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return match ? cleanText(match[1]) : '';
}

export type NportHolding = JsonRecord;

export type ParsedNport = {
  regName: string;
  regCik: string;
  seriesName: string;
  seriesId: string;
  repPdDate: string;
  holdings: NportHolding[];
  totalValue: number;
  netAssets: number | null;
};

// Minimal, forgiving N-PORT-P XML reader (machine-generated schemas only),
// in the same spirit as SPDR's hand-rolled ZIP/OOXML workbook reader.
export function parseNport(xml: string): ParsedNport {
  const genInfoMatch = /<genInfo>([\s\S]*?)<\/genInfo>/i.exec(xml);
  const genInfo = genInfoMatch ? genInfoMatch[1] : String(xml || '').slice(0, 4000);
  const fundInfoMatch = /<fundInfo>([\s\S]*?)<\/fundInfo>/i.exec(xml);
  const fundInfo = fundInfoMatch ? fundInfoMatch[1] : '';
  const holdings: NportHolding[] = [];
  const blockRe = /<invstOrSec>([\s\S]*?)<\/invstOrSec>/g;
  let block: RegExpExecArray | null;
  let totalValue = 0;
  while ((block = blockRe.exec(xml)) !== null) {
    const body = block[1];
    const name = tagValue(body, 'name') || tagValue(body, 'title') || '-';
    const cusip = tagValue(body, 'cusip');
    let identifier = cusip && cusip.toUpperCase() !== 'N/A' ? cusip : '';
    if (!identifier) {
      // Real EDGAR schema: <identifiers><isin value="..."/><other value="..."/></identifiers>
      for (const tagMatch of body.matchAll(/<(isin|sedol|other|cusip)[^>]*value="([^"]+)"/gi)) {
        identifier = cleanText(tagMatch[2]);
        if (identifier) break;
      }
    }
    const weight = normalizeNumberText(tagValue(body, 'pctVal'));
    const valueMatch = /<valUSD[^>]*>([\s\S]*?)<\/valUSD>/i.exec(body);
    const value = Number(valueMatch ? valueMatch[1].replace(/[,\s]/g, '') : tagValue(body, 'curVal'));
    const balance = normalizeNumberText(tagValue(body, 'balance'));
    holdings.push({
      Name: name,
      Ticker: '-',
      Identifier: identifier || '-',
      Weight: weight === '' ? '0' : weight,
      'Market Value': Number.isFinite(value) ? String(value) : '0',
      'Shares Held': balance === '' ? '-' : balance,
      'Asset Category': tagValue(body, 'assetCat') || '-',
    });
    if (Number.isFinite(value)) totalValue += value;
  }
  return {
    regName: tagValue(genInfo, 'regName'),
    regCik: tagValue(genInfo, 'regCik'),
    seriesName: tagValue(genInfo, 'seriesName'),
    seriesId: tagValue(genInfo, 'seriesId'),
    repPdDate: toIsoDate(tagValue(genInfo, 'repPdDate')),
    holdings,
    totalValue,
    netAssets: numberOrNull(normalizeNumberText(tagValue(fundInfo, 'netAssets'))),
  };
}

// EDGAR full-text search maps a fund ticker to the registrant that filed its
// N-PORT-P, so the fallback works for every Northern Trust ETF without a hand-kept
// CIK table.
export function eftsSearchUrl(query: string): string {
  const params = new URLSearchParams({
    q: `"${query}"`,
    forms: 'NPORT-P',
    dateRange: 'custom',
    start: '0',
    end: String(25),
  });
  return `${SEC_EFTS_HOST}/search-index?${params.toString()}`;
}

export function pickEftsCik(payload: JsonRecord, fundName: string): string | null {
  // EDGAR returns { hits: { hits: [...] } }; older/simplified payloads (and the
  // unit-test fixtures) use a flat { hits: [...] } array.
  const hits: unknown[] = Array.isArray(payload?.hits)
    ? (payload.hits as unknown[])
    : Array.isArray((payload?.hits as JsonRecord)?.hits)
      ? ((payload.hits as JsonRecord).hits as unknown[])
      : [];
  const wanted = normalizeHoldingName(fundName);
  for (const raw of hits) {
    if (!raw || typeof raw !== 'object') continue;
    const hit = raw as JsonRecord;
    const source = (hit._source || {}) as JsonRecord;
    const display = source.display_names;
    // Real payload: display_names is ["NAME  (CIK 0001209466)", ...].
    const names: string[] = Array.isArray(display)
      ? display.map((entry: unknown) => String(entry))
      : Array.isArray((display as JsonRecord)?.names)
        ? ((display as JsonRecord).names as unknown[]).map((entry) => String(entry))
        : [];
    const fromDisplay = names.map((name) => /\(CIK\s*(\d{4,10})\)/i.exec(name)).find(Boolean);
    const ciks: string[] = Array.isArray(source.ciks) ? source.ciks.map((entry: unknown) => String(entry)) : [];
    const rawCik = String((display as JsonRecord)?.cik || fromDisplay?.[1] || ciks[0] || '');
    const cik = rawCik.replace(/\D/g, '').padStart(10, '0');
    if (!cik || cik === '0000000000') continue;
    if (wanted && names.length) {
      const matched = names.some((name) => {
        const normalized = normalizeHoldingName(name.replace(/\(CIK\s*\d+\)/i, ''));
        return normalized && (wanted.includes(normalized) || normalized.includes(wanted));
      });
      if (!matched) continue;
    }
    return cik;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Yahoo chart layer: daily history, distributions, quote meta
// ---------------------------------------------------------------------------

export type ChartDay = { date: string; close: number; adjClose: number; volume: number };

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
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

/** Honest, never-empty label of how `metrics` returns were computed (STANDARD.md 9a). */
export function returnsBasisLabel(hasOfficial: boolean): string {
  return hasOfficial
    ? 'official Northern Trust NAV total returns (funds-list JSON + full-data CSV), any missing figure filled from the daily NAV history with distributions reinvested (performanceAsOf is the official month-end table date, filled periods end at returns.monthEnd.priceReturnsAsOf)'
    : 'derived from the daily NAV history with published distributions reinvested (or Yahoo adjusted closes), not official NAV returns; performanceAsOf is the last history date (null when the fund has no return yet)';
}

const MONTH_NUMBER: Record<string, string> = Object.fromEntries(MONTHS.map((name, index) => [name, String(index + 1).padStart(2, '0')]));

/** Parses the published "Aug 31 2026" label back to ISO, or null. */
export function labelToIsoDate(label: unknown): string | null {
  const match = /^([A-Za-z]{3}) (\d{2}) (\d{4})$/.exec(String(label ?? ''));
  const month = match ? MONTH_NUMBER[match[1]] : undefined;
  return match && month ? isoDateOrNull(`${match[3]}-${month}-${match[2]}`) : null;
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

/** True when an N-PORT report period is older than the holdings already published (ISO or any toIsoDate form). */
export function isOlderReport(reportPeriod: string, publishedAsOf: string): boolean {
  if (!reportPeriod || !publishedAsOf) return false;
  return toIsoDate(reportPeriod) < toIsoDate(publishedAsOf);
}

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

// Northern Trust annualizes returns beyond one year only; a since-inception figure
// of a fund younger than one year is cumulative and must not be published in
// the "SI Ann." column (the derived annualization, >= 1 year of history, fills in).
export function annualizedSinceInception(value: number | null, inception: string | null, asOfDate: string | null): number | null {
  if (value === null) return null;
  const start = inception ? isoToEpoch(inception) : null;
  const end = asOfDate ? isoToEpoch(asOfDate) : null;
  if (start === null || end === null) return value;
  return (end - start) / 86_400 >= 365 ? value : null;
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
): Promise<JsonRecord | null> {
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
        const parsed = parseNorthernTrustHoldings(holdingsCsv, ticker);
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
  let holdingsEdgar: ParsedNport | null = null;
  if (holdings) {
    const sum = weightsSum(holdings.rows);
    if (sum > 0 && sum < 1) {
      // Weights arrived as fractions instead of percent: normalize once.
      holdings.rows = holdings.rows.map((row) => ({ ...row, Weight: String(round((numberOrNull(row.Weight) || 0) * 100, 6)) }));
    }
  }

  if (!holdings && config.edgarFallback) {
    try {
      const filing = await resolveNportFiling(fund, config);
      if (filing) {
        const parsed = parseNport(await fetchText(filing.accession.url, `[ nport    ] ${ticker}`, secHeaders(config), config));
        // A registrant files one N-PORT-P per series: only accept the document
        // that really belongs to this fund, never the trust's newest filing.
        const filedSeries = normalizeHoldingName(parsed.seriesName);
        const wantedSeries = normalizeHoldingName(fund.name);
        const belongsToFund = filing.seriesId
          ? !parsed.seriesId || parsed.seriesId.toUpperCase() === filing.seriesId.toUpperCase()
          : Boolean(filedSeries && wantedSeries && (filedSeries === wantedSeries || filedSeries.includes(wantedSeries) || wantedSeries.includes(filedSeries)));
        const publishedHoldingsAsOf = String((previousMeta?.holdings as JsonRecord)?.asOfDate ?? '');
        if (!belongsToFund) {
          outputNote(`[ edgar    ] ${ticker}: ${filing.accession.accession} reports "${parsed.seriesName || 'unknown series'}" — skipped`);
        } else if (isOlderReport(parsed.repPdDate || '', publishedHoldingsAsOf)) {
          // never replace fresher published holdings with an older filing
          outputNote(`[ edgar    ] ${ticker}: N-PORT-P report period ${parsed.repPdDate} is older than the published holdings (${publishedHoldingsAsOf}) — keeping them`);
        } else if (parsed.holdings.length) {
          holdingsEdgar = parsed;
          holdings = {
            asOfDate: parsed.repPdDate || null,
            headers: HOLDINGS_HEADERS,
            rows: fillNportTickers(parsed.holdings, await loadCompanyTickerMap(config)),
          };
          holdingsSource = `SEC EDGAR Form N-PORT-P (accession ${filing.accession.accession}, report period ${parsed.repPdDate || 'n/a'})`;
        }
      }
    } catch (error) {
      outputNote(`[ edgar    ] ${ticker}: ${errorMessage(error)} — keeping previous holdings`);
    }
  }

  const holdingsRows: JsonRecord[] = holdings ? holdings.rows : await readPreviousSheet(ticker, 'holdings');
  const holdingsHeaders = holdings?.headers.length
    ? holdings.headers
    : (await readPreviousSheetHeaders(ticker, 'holdings')) || HOLDINGS_HEADERS;
  const holdingsAsOf = holdings?.asOfDate || (((previous.holdings as JsonRecord)?.asOfDate as string) ?? null);

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
      const chart = parseChart(await fetchJson(chartUrl(ticker, config), `[ chart    ] ${ticker}`, yahooHeaders(), config));
      exchangeName = chart.exchangeName;
      navFromChart = chart.navPrice;
      priceFromChart = chart.regularMarketPrice;
      marketTime = chart.regularMarketTime;
      firstTradeDate = chart.firstTradeDate;
      if (!dividends.length) dividends = chart.dividends;
      chartDays = chart.days;
      history = historyRows(chart.days);
      historyHeaders = YAHOO_HISTORY_HEADERS;
      historySource = 'Yahoo Finance public chart API (adjusted close)';
    } catch (error) {
      outputNote(`[ chart    ] ${ticker}: ${errorMessage(error)} — keeping previous history`);
    }
  }

  const haveFreshHistory = history.length > 0;
  if (!haveFreshHistory) {
    history = await readPreviousSheet(ticker, 'history');
    const previousHeaders = await readPreviousSheetHeaders(ticker, 'history');
    historyHeaders = previousHeaders.length ? previousHeaders : HISTORY_HEADERS;
  }
  const derived = chartDays.length ? priceReturns(chartDays, new Date(), coveredFrom) : EMPTY_PRICE_RETURNS;

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
  const inception = product?.inception ?? fund.inception ?? null;
  const returnsAsOfDate = product?.monthEnd.asOfDate ?? fund.returnsAsOfDate ?? null;
  const official = mergeOfficial(product?.monthEnd ?? null, fund.returns);
  official.sinceInception = annualizedSinceInception(official.sinceInception, inception, returnsAsOfDate);
  const quarterEndSource = historical?.quarterEnd.asOfDate ? historical.quarterEnd : fund.quarterEnd;
  const quarterEndAsOfDate = historical?.quarterEnd.asOfDate ?? fund.quarterEndAsOfDate ?? null;
  const quarterEnd: CatalogReturns = { ...quarterEndSource };
  quarterEnd.sinceInception = annualizedSinceInception(quarterEnd.sinceInception, inception, quarterEndAsOfDate);

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
    product?.name || (fund.source !== 'northerntrust' && holdingsEdgar?.seriesName) || fund.name || String(previous.name ?? '') || ticker;
  const premiumDiscount =
    product?.premiumDiscount ?? fund.premiumDiscount ?? (nav && price ? round(((price - nav) / nav) * 100, 2) : null);
  // Fresh etfs.ntam.northerntrust.com net assets win; when the catalog row only
  // comes from the previously published index (site unavailable), the N-PORT-P
  // net assets of the filing we just parsed are the authoritative number.
  const nportNetAssets = holdingsEdgar
    ? holdingsEdgar.netAssets ?? (holdingsEdgar.totalValue ? round(holdingsEdgar.totalValue, 2) : null)
    : null;
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
      holdingsDownload: northernTrustHoldingsCsvUrl(ticker),
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
          : nportNetAssets !== null && holdingsEdgar?.repPdDate
            ? formatEdgarDate(holdingsEdgar.repPdDate)
            : (((previous.aum as JsonRecord)?.asOfDate as string) ?? '—'),
      source:
        catalogNetAssets !== null
          ? product?.netAssets !== null && product?.netAssets !== undefined
            ? 'etfs.ntam.northerntrust.com full-data CSV total net assets'
            : 'etfs.ntam.northerntrust.com funds-list pricing block'
          : nportNetAssets !== null
            ? `SEC Form N-PORT-P net assets (report period ${holdingsEdgar?.repPdDate || 'n/a'})`
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
  if (product || historical?.points.length || chartDays.length || (holdings && holdings.rows.length)) freshTickers.add(ticker);

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

// The Northern Trust ETF registrant CIK (FlexShares Trust or Northern Funds) for a fund, needed only by the EDGAR
// fallback: the seed may pin it, otherwise it is read from the official SEC
// "ticker -> registrant CIK + series id" table and, as a last resort,
// discovered through the EDGAR full-text search API (cached per run).
const cikByTicker = new Map<string, string | null>();

// Lazily fetched, cached-per-run SEC lookup tables.
let fundTickerMap: Map<string, SecSeriesRef> | null = null;
let companyTickerMap: Map<string, string> | null = null;

async function loadFundTickerMap(config: UpdaterConfig): Promise<Map<string, SecSeriesRef>> {
  if (fundTickerMap) return fundTickerMap;
  try {
    const payload = await fetchJson(SEC_FUND_TICKERS_URL, '[edgar   ] fund ticker table', secHeaders(config), config);
    fundTickerMap = parseFundTickerMap(payload);
    outputNote(`[ edgar    ] SEC fund ticker table: ${fundTickerMap.size} ETF / mutual-fund share classes`);
  } catch (error) {
    console.warn(`[ edgar    ] fund ticker table: ${errorMessage(error)} — falling back to full-text search`);
    fundTickerMap = new Map<string, SecSeriesRef>();
  }
  return fundTickerMap;
}

async function loadCompanyTickerMap(config: UpdaterConfig): Promise<Map<string, string>> {
  if (companyTickerMap) return companyTickerMap;
  try {
    const payload = await fetchJson(SEC_COMPANY_TICKERS_URL, '[ edgar    ] company ticker table', secHeaders(config), config);
    companyTickerMap = parseCompanyTickerMap(payload);
    outputNote(`[ edgar    ] SEC company ticker table: ${companyTickerMap.size} issuer names`);
  } catch (error) {
    console.warn(`[ edgar    ] company ticker table: ${errorMessage(error)} — N-PORT tickers stay "-"`);
    companyTickerMap = new Map<string, string>();
  }
  return companyTickerMap;
}

// N-PORT positions carry CUSIP/ISIN but never a ticker; the SEC company table
// turns the filed issuer name back into an exchange symbol so the watchlist
// export stays usable, exactly like the sibling Fidelity updater.
function fillNportTickers(rows: NportHolding[], names: Map<string, string>): NportHolding[] {
  if (!names.size) return rows;
  return rows.map((row) => {
    if (cleanHoldingTicker(row.Ticker)) return row;
    const name = String(row.Name ?? '');
    const ticker = names.get(normalizeHoldingName(name)) || names.get(normalizeHoldingNameCore(name)) || '';
    return ticker ? { ...row, Ticker: ticker } : row;
  });
}

async function resolveRegistrantCik(fund: CatalogFund, config: UpdaterConfig): Promise<string | null> {
  if (cikByTicker.has(fund.ticker)) return cikByTicker.get(fund.ticker) as string | null;
  let cik: string | null = fund.trustCik || null;
  if (!cik) {
    const table = await loadFundTickerMap(config);
    cik = table.get(fund.ticker)?.cik || null;
  }
  if (!cik) {
    try {
      const payload = await fetchJson(eftsSearchUrl(fund.ticker), `[edgar   ] search ${fund.ticker}`, secHeaders(config), config);
      cik = pickEftsCik(payload, fund.name);
    } catch (error) {
      outputNote(`[ edgar    ] search ${fund.ticker}: ${errorMessage(error)}`);
    }
  }
  cikByTicker.set(fund.ticker, cik);
  return cik;
}

// The fund's own newest N-PORT-P filing. The SEC series id gives an exact,
// one-request answer (browse-edgar Atom, filtered to that series); scanning the
// whole registrant's submissions is the fallback when the series is unknown.
async function resolveNportFiling(
  fund: CatalogFund,
  config: UpdaterConfig,
): Promise<{ accession: NportAccession; cik: string; seriesId: string } | null> {
  const table = await loadFundTickerMap(config);
  const ref = table.get(fund.ticker) || null;
  if (ref?.seriesId) {
    try {
      const atom = await fetchText(edgarSeriesFilingsUrl(ref.seriesId), `[edgar   ] ${fund.ticker} series ${ref.seriesId}`, secHeaders(config), config);
      const [newest] = parseEdgarAtomFilings(atom);
      if (newest) return { accession: newest, cik: ref.cik, seriesId: ref.seriesId };
    } catch (error) {
      outputNote(`[ edgar    ] ${fund.ticker} series ${ref.seriesId}: ${errorMessage(error)} — scanning registrant submissions`);
    }
  }
  const cik = ref?.cik || (await resolveRegistrantCik(fund, config));
  if (!cik) return null;
  try {
    const submissions = await fetchJson(`${SEC_DATA_HOST}/submissions/CIK${cik}.json`, `[edgar   ] ${cik} submissions`, secHeaders(config), config);
    const [newest] = parseNportAccessions(submissions);
    if (newest) return { accession: newest, cik, seriesId: ref?.seriesId || '' };
  } catch (error) {
    outputNote(`[ edgar    ] ${fund.ticker}: ${errorMessage(error)}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runUpdater(config: UpdaterConfig): Promise<void> {
  requestSleepMs = Math.max(0, config.requestSleep) * 1000;
  nextRequestAtLanes = new Array(Math.max(1, config.concurrency)).fill(0);
  const deadlineAt = Date.now() + softDeadlineMs;
  freshTickers.clear();

  outputPrintConfig('Northern Trust', config);
  console.log('');

  // 1) Catalog discovery: funds-list page JSON, previous index, seed.
  const catalog = new Map<string, CatalogFund>();
  let catalogSource = 'previous api/northerntrust/index.json';
  const previousIndex = await readPreviousIndex();

  if (!config.skipNorthernTrust) {
    try {
      const page = await fetchText(config.catalogUrl, '[catalog ] funds list', northernTrustHeaders(), config);
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
  if (!catalog.size) {
    for (const [ticker, row] of previousIndex) catalog.set(ticker, catalogFundFromIndex(ticker, row));
  } else {
    // Funds that disappeared from the download keep their published row (the
    // updater never deletes on a suspiciously small catalog).
    for (const [ticker, row] of previousIndex) {
      if (!catalog.has(ticker)) catalog.set(ticker, catalogFundFromIndex(ticker, row));
    }
  }

  // When etfs.ntam.northerntrust.com is unreachable the SEC registrant tables
  // still list every share class of FlexShares Trust and Northern Funds, so a
  // no-argument full pass keeps covering the complete product line instead of
  // only the published feed.
  if (catalogSource !== 'etfs.ntam.northerntrust.com ETF funds-list JSON' && config.edgarFallback) {
    const table = await loadFundTickerMap(config);
    const registrantCiks = new Set<string>();
    for (const ticker of catalog.keys()) {
      const ref = table.get(ticker);
      if (ref) registrantCiks.add(ref.cik);
    }
    if (!registrantCiks.size) registrantCiks.add(FLEXSHARES_TRUST_CIK.replace(/^0+/, '')).add(NORTHERN_FUNDS_CIK.replace(/^0+/, ''));
    let discovered = 0;
    for (const [ticker, ref] of table) {
      if (!registrantCiks.has(ref.cik) || catalog.has(ticker)) continue;
      catalog.set(ticker, { ...catalogFundFromIndex(ticker, {}), source: 'seed' });
      discovered += 1;
    }
    if (discovered) {
      console.log(`[ catalog  ] +${discovered} funds discovered through the SEC registrant tables`);
      catalogSource = `${catalogSource} + SEC registrant tables`;
    }
  }

  const universe = [...catalog.values()].sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
  if (!universe.length) {
    console.log(
      '[done    ] nothing to do: etfs.ntam.northerntrust.com is unreachable and the published ' +
        'api/northerntrust/index.json is empty or missing — run this where etfs.ntam.northerntrust.com resolves, e.g. ' +
        'the "Update Northern Trust ETF data" GitHub Actions workflow',
    );
    return;
  }
  console.log(`[ catalog  ] ${universe.length} Northern Trust ETFs (${catalogSource})`);
  const newFunds = universe.map((fund) => fund.ticker).filter((ticker) => !previousIndex.has(ticker));
  if (newFunds.length) console.log(`NEW FUNDS: ${newFunds.join(', ')}`);

  // 2) Bounded, resumable batch run over the catalog (iShares/SPDR cursor).
  const state = await readUpdateState();
  // A plain `bun ./scripts/update-data.ts` (no MAX_FETCHES) always walks the
  // whole catalog from the top and clears the cursor afterwards; the saved
  // cursor only rotates the queue for explicitly bounded batch runs, exactly
  // like the sibling SPDR / iShares updaters.
  // The cursor also resumes a run that stopped at the soft deadline, and is only
  // used for the same filter set it was saved for.
  const scope = cursorScope(config);
  const cursor = (config.maxFetches > 0 || state?.partial === true) && state?.scope === scope ? state?.cursor || null : null;
  const cursorIndex = cursor ? universe.findIndex((fund) => fund.ticker === cursor) : -1;
  const ordered =
    cursorIndex >= 0
      ? universe.slice(cursorIndex + 1).concat(universe.slice(0, cursorIndex + 1))
      : universe.slice();

  const queue = ordered.map((fund) => ({ fund }));
  const results: JsonRecord[] = [];
  // MAX_FETCHES counts only funds that pass the filters; funds a filter rejects are
  // examined (and move the cursor) but cost no batch slot.
  let passed = 0;
  let pending = 0;
  let started = 0;
  let deadlineHit = false;
  let failures = 0;

  outputPrintFilter(universe.length, universe.length, outputHasOutputFilters(config));
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
        const row = await processFund(item.fund, config, previousIndex.get(item.fund.ticker) || {});
        if (row) {
          results.push(row);
          passed += 1;
        }
        await output.result(item.fund.ticker, before, row ? undefined : 'skipped');
      } catch (error) {
        failures += 1;
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
  const keptFromPrevious = universe
    .filter((fund) => !results.some((row) => row.ticker === fund.ticker))
    .map((fund) => previousIndex.get(fund.ticker))
    .filter(Boolean)
    .map((row) => ensureMetricsContract(row as JsonRecord)) as JsonRecord[];
  const funds: JsonRecord[] = [];
  for (const row of [...results, ...keptFromPrevious]) funds.push(await withMetaContract(row));
  funds.sort((a, b) => String(a.ticker).localeCompare(String(b.ticker)));

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

  // Full passes reset the cursor: the next run starts from the top again.
  await writeUpdateState(config.maxFetches > 0 || deadlineHit ? lastExamined : null, scope, deadlineHit);

  console.log('');
  console.log(`[ done     ] ${results.length} funds updated, ${keptFromPrevious.length} kept from previous runs, ${failures} failures`);
  console.log(`[ done     ] counts: ${counts.funds} funds / ${counts.holdings.toLocaleString('en-US')} holdings rows / ${counts.history.toLocaleString('en-US')} history rows`);
  console.log(
    `[ cursor   ] ${(config.maxFetches > 0 || deadlineHit) && lastExamined ? `next run continues after ${lastExamined}` : 'full pass complete (cursor reset)'}`,
  );

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### Northern Trust data update\n\n- updated: ${results.length}\n- kept from previous runs: ${keptFromPrevious.length}\n- failed: ${failures}\n${newFunds.length ? `- NEW FUNDS: ${newFunds.join(', ')}\n` : ''}${deadlineHit ? '- stopped at the soft deadline, the next run resumes\n' : ''}- counts: ${counts.funds} funds / ${counts.holdings.toLocaleString('en-US')} holdings rows / ${counts.history.toLocaleString('en-US')} history rows\n`,
      'utf8',
    );
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
    trustCik: null,
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
