/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CONTROL_NAMES, readConfig, resolveControls, runtimeControls } from './update-data';

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
  expect(config.secUa).toContain('NorthernTrust');
  expect(config.catalogUrl).toBe('https://etfs.ntam.northerntrust.com/us/en/individual/funds');
});

test('runtimeControls reads the checked-in file and lets the environment override it', async () => {
  expect(await runtimeControls({})).toEqual(file());
  const controls = await runtimeControls({ TICKERS: 'QLC SKOR', MAX_RETRIES: '0' });
  expect(controls.TICKERS).toBe('QLC SKOR');
  expect(readConfig(controls).tickers).toEqual(['QLC', 'SKOR']);
  expect(readConfig(controls).maxRetries).toBe(0);
});

test('resolver rejects invalid JSON shapes, unknown keys, non-scalars, newlines and bad values', () => {
  for (const value of [
    { UNKNOWN: 1 }, { OUTPUT_DIR: '/tmp' }, { SEC_UA: 'x\nEVIL=yes' }, { TICKERS: 'QLC\r\nEVIL=1' }, { TICKERS: 'a\0b' },
    { CONCURRENCY: 0 }, { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' },
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
  expect(JSON.stringify(file())).not.toMatch(/@(?!daggerok\.example\.com)/);
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
  expect(hidden.sort()).toEqual(['CATALOG_URL', 'SEC_UA', 'STORE_RAW_DOWNLOADS', 'TOTAL_RETURN_10Y', 'VERBOSE']);
  for (const name of hidden) expect(() => resolveControls(file(), { [name]: file()[name] })).not.toThrow();
});

test('updater only writes inside api/northerntrust', () => {
  const source = read('scripts/update-data.ts');
  expect(source).toContain("new URL('../api/northerntrust/', import.meta.url)");
  expect(CONTROL_NAMES).not.toContain('OUTPUT_DIR' as never);
});
