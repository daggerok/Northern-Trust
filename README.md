# Northern Trust

One of the app's features lets you select Northern Trust ETFs in the Watchlist and aggregate their holdings to see how often each ticker appears across the selected funds. Repeated holdings make overlapping exposure visible: the more selected funds include a ticker, the greater its potential influence on the portfolio; gains in that holding may help, while declines may hurt, and actual impact also depends on each fund's position size.  Another feature makes it faster and easier to find funds with stronger growth over different periods, higher dividend yields or distributions, greater Total Return (price performance plus dividends), and other key performance metrics. A single-file client-side tool that reads the generated `./api/northerntrust` static feed (etfs.ntam.northerntrust.com funds list and per-fund full-data, holdings, pricing and distributions downloads - official NAV returns, expenses, yields, complete daily holdings and whole-life NAV history - with SEC EDGAR N-PORT-P and Yahoo Finance as fallbacks) into a searchable ETF/asset-class catalog with per-fund tabs, watchlist aggregation, ticker copy and CSV/TXT export - the same look, feel, columns and business logic as the sibling applications.

## Using Bun

```bash
bunx degit daggerok/Northern-Trust#main ./12345 && cd $_
bunx serve . -p 1234
open http://0:1234
```

The published application is available at <https://daggerok.github.io/Northern-Trust/>.

### Column types and filters

Every column of the ETF catalog and of the Watchlist, Holdings, History and Distributions tabs has a type: text (`ABC`), number (`123`), percentage (`%`), money (`$`), date (`D`), date and time (`DT`) or time of day (`T`). The type is detected from the texts the column shows (80% of the filled cells must agree, otherwise text) and is written in the badge next to the column title: click it to cycle the type, Shift+click to return to auto-detection. Dates are read as `2024-06-15`, `6/15/2024`, `15.06.2024`, `Jun 15, 2024` or `15-Jun-2024`, date and time as `2024-06-15T09:30:00Z` or `2024-06-15 09:30`, time as `09:30`, `16:00:00` or `9:30 PM`

A row of filter inputs sits under the column headers (the `Filters` button hides it, `Clear filters` empties it). Filters of different columns are combined with AND, the search box applies on top, and Copy Tickers and the exports use the filtered rows. Filters and type overrides are remembered in the browser

Inside one filter: a space means AND, a comma means OR, a leading `!` means NOT, `?` matches an empty or unavailable value and `!?` a value that is there; a value that is unavailable matches only `?` and negated conditions. An unquoted space ends the value, so quote values that contain one (`>="2024-06-15 09:30"`)

| Type | Examples |
| --- | --- |
| Text | `bank` contains, `"two words"`, `!bank`, `=exact`, `^starts`, `ends$`, `/regex/`, `tech, health` |
| Number, percentage, money | `>10`, `>=10 <50`, `=22` (matches what rounds to 22), `!=22`, `10..50`, `..50`, `10..`, `>1B` and `K` `M` `B` `T` suffixes, an optional `$` or `%` |
| Date, date and time | `>2024-06-01`, `2024` (the whole year), `2024-06` (the whole month), `2024-01..2024-06`, `today`, `yesterday`, `-7d..` (the last 7 days), `+2w`, `-3m`, `-1y` |
| Time | `>09:30`, `09:30..16:00`, `=12:00` (the whole minute) |

The `Columns` menu next to `Filters` lists every column of the ETF table from the first to the last, all of them shown by default, with a search box and the `All`, `Clear`, `Toggle` and `Reset` buttons. `Use` and `Ticker` are listed but locked. Hiding a column only removes it from the table: the filters, the sorting, the exports and Copy Tickers still use it. The choice is remembered in the browser (localStorage, never the data) and the menu is shown on the ETF catalog only

## Updating the static Northern Trust data

```bash
bun scripts/update-data.ts
```

Defaults for every supported control live in `scripts/update-data.config.json`. Run `bun scripts/update-data.ts --help` to print each control with its meaning and usage examples. All supplied filters use **AND** logic.

Precedence: file defaults < `advanced` JSON < nonblank inputs < protected Actions variable/env. Locally, the environment variables listed below (or their `NORTHERNTRUST_<NAME>` form, which wins) override the file, and an explicitly set variable wins even when empty (it clears the control). The **Update Northern Trust ETF data** GitHub Actions workflow runs weekly with the file defaults and exposes 24 of the controls as manual inputs; a blank input inherits the file value. The `advanced` input takes a JSON object of any other control, for example `{"STORE_RAW_DOWNLOADS": "true", "TOTAL_RETURN_10Y": "10:"}`. The CLI and the workflow share the same resolver, and the output directory is fixed to `api/northerntrust`.

### Data sources

| Block | Source |
| --- | --- |
| Catalog (all US Northern Trust ETFs) | `https://etfs.ntam.northerntrust.com/us/en/individual/funds` (the server-rendered [funds list](https://etfs.ntam.northerntrust.com/us/en/individual/funds) with the embedded funds-list JSON: tickers, names, asset class, pricing, month-end returns) |
| Fund facts, returns, yields per fund | `https://etfs.ntam.northerntrust.com/content/dam/ntflexshares/fund/<ticker>/<ticker>-all.csv` (per-fund full-data CSV: fund facts, month/quarter-end NAV returns, SEC + dividend yields, e.g. [QLC](https://etfs.ntam.northerntrust.com/content/dam/ntflexshares/fund/qlc/qlc-all.csv)) |
| Holdings per fund | `https://etfs.ntam.northerntrust.com/content/dam/ntflexshares/fund/<ticker>/<ticker>-holdings.csv` (daily full holdings with CUSIP/ISIN/SEDOL; `<ticker>-monthly-holdings.csv` when a fund publishes no daily file) |
| Daily history, distributions | `https://etfs.ntam.northerntrust.com/content/dam/ntflexshares/fund/<ticker>/<ticker>_pricing.json` (official NAV history) + `.../<ticker>-distributions.csv` (dividend schedule) |
| Fallback | SEC EDGAR N-PORT-P + Yahoo Finance chart API as fallbacks |

### Metrics and caveats

Each fund carries a derived `metrics` object that powers the catalog columns shared with the sibling sites:

- `ytd` / `tr1y` - official YTD and 1-year returns -> *YTD Return*, *TR 1Y*
- `cagr3y` / `cagr5y` / `cagr10y` - published annualized 3Y/5Y/10Y figures -> *CAGR 3Y/5Y/10Y*
- `tr3y` / `tr5y` / `tr10y` - cumulative 3Y/5Y/10Y figures `(1 + CAGR)^n - 1` -> *TR 3Y/5Y/10Y*
- `siAnn` - since-inception annualized -> *SI Ann.*; only for funds with at least one year of history, `null` otherwise
- `dividendYield` - 12-month trailing yield or indicated yield (latest distribution x frequency / price)
- `dividendYieldBasis` - code of the definition behind `dividendYield`, `null` exactly when `dividendYield` is `null`; it always travels with the yield it describes (see the table below)
- `secYield` - 30-day SEC yield when published; an unpublished value is shown as unavailable, not as 0
- `returnsBasis` - mandatory non-empty label of how the returns were computed: official Northern Trust NAV total returns, the same with gaps filled from the daily NAV history, or derived from the NAV history / Yahoo adjusted closes (an estimate)
- `performanceAsOf` - ISO `YYYY-MM-DD` date the returns are as of: the official month-end performance table date, or the last history date when derived; not the NAV date; `null` when unknown and for funds that have no return figure at all (young funds), so a date never travels without numbers

| `dividendYieldBasis` | Meaning for Northern Trust |
| --- | --- |
| `official-trailing-12m` | the `12-Month Dividend Yield` of the official full-data CSV |
| `indicated` | estimate: latest distribution x inferred payments per year / market price, used when Northern Trust publishes no yield (also kept for a retained row that was stored as indicated) |
| `official-other` | a published yield stored without a known definition (legacy rows only) |
| `official-distribution-rate`, `computed-trailing-12m` | part of the shared standard, not used by this feed |

Caveats:

- Expense ratio: `terValue` (index row) and `expenseRatio.value` (meta) are the NET ratio after waivers, `terGrossValue` and `expenseRatio.gross` the GROSS one (`null` when not published). The `TER` filter applies to the net ratio. Rows published before this change keep the gross value in `terValue` until the next refresh of that fund
- Dates: `returns.monthEnd.asOfDate` is the date of the official month-end table; `returns.monthEnd.priceReturnsAsOf` is the later date up to which `qtd` and every figure Northern Trust does not publish (young funds, filled periods) are computed from the daily NAV history. A fund without any official figure is dated by its NAV history only
- SEC yield: TIPS funds (TIPA to TIPD, TDTF, TDTT) published negative SEC yields on Sep 25 2026 (about -2.1 to -2.4) and positive ones on Oct 2 2026; the value is kept as the source publishes it for its own date (`yields.secYieldKind` names the date)
- Fund-level consistency: a fund is computed completely in memory and written once (history and holdings pages first, then `meta.json`, stale pages last; the index is written at the end of the run). If the full-data CSV, the holdings CSV or the pricing JSON fails for a fund that already has a published state (a missing file, HTTP 404, counts as an honest "none", any other error does not), the whole fund keeps its previous state and counts as a failure; the SEC and Yahoo fallbacks apply to new funds only. The Yahoo schema (`Date/Close/Adj Close/Volume`) never replaces a published official NAV history, and an older N-PORT-P filing never replaces fresher published holdings. A fund with a `meta.json` but no index row is rebuilt into the index; a row without `meta.json` has `dataFile: null` and a full `metrics` object of nulls
- Run behavior: every request has a 45 s timeout (headers and body) and is retried per `MAX_RETRIES`; files are written through a temporary file and renamed; a rerun with identical upstream data writes nothing; the run stops taking new funds after 25 minutes, still writes the full index and saves a cursor so the next run resumes; funds new to the catalog are printed as `NEW FUNDS: A, B` (and added to the step summary); the process exits with an error when every examined fund failed
- Returns, NAV history and distributions come from Northern Trust's own downloads; the Yahoo Finance chart API is used only as a fallback, and values derived from it (including indicated yield and price-based returns) are estimates
- SEC EDGAR N-PORT-P is used only for funds whose holdings CSV lists no holdings
- `TICKERS` combines with AUM, TER, yield and return filters using AND logic; it does not override them; a return filter excludes funds whose value for that period is `null`
- Funds not selected for a successful update keep their prior published metadata and data files
- AUM, TER, yield and return filters are evaluated against the freshly downloaded catalog values (or the previously published catalog) before the heavier per-fund downloads

### Update controls

| Control | Default | Meaning |
| --- | --: | --- |
| `MAX_FETCHES` | `0` (all) | Batch size: with a positive value the updater continues after the committed cursor in `api/northerntrust/update-state.json`; empty or `0` is a full pass, every fund is refreshed in one run. Only funds that pass `TICKERS` and the filters count, the cursor wraps around and belongs to one filter set (a cursor saved for other filters is ignored). Legacy alias `NORTHERNTRUST_LIMIT` |
| `REQUEST_SLEEP` | `1` | Minimum delay in seconds between request starts on the same pacing lane, including retries. |
| `CONCURRENCY` | `2` | Number of parallel fund update workers. Request starts are spaced by `REQUEST_SLEEP` within each pacing lane. |
| `MAX_RETRIES` | `2` | Retries after the initial request (integer >= 1). Only network errors and HTTP 403/408/425/429/5xx are retried with exponential backoff. |
| `TICKERS` | empty (all) | Space-, comma- or semicolon-separated ticker allowlist, e.g. `QLC SKOR TIPA TXCA`. |
| `AUM` | `:` | Net Assets range. Each bound may be a USD amount or `K`/`M`/`B`/`T`, or one of `nano`, `micro`, `small`, `mid`, `large`. Anything else (for example `abc:` or two colons) is an error. |
| `TER` | `:` | NET expense ratio range in % (strict `min:max`). |
| `DIVIDEND_YIELD` | `:` | Dividend-yield percentage range. |
| `SEC_YIELD` | `:` | SEC-yield percentage range. |
| `HOLDINGS_PAGE_SIZE` | `250` | Rows in each generated current-holdings JSON page. |
| `HISTORY_PAGE_SIZE` | `1000` | Rows in each generated daily-history JSON page. Legacy alias `HISTORICAL_PAGE_SIZE` |
| `HISTORY_RANGE` | `max` | `max` or `Ny` (for example `5y`): how far back the Yahoo fallback history reaches, sent as explicit `period1`/`period2`; anything else is an error. The official Northern Trust history always covers the fund's whole life. |
| `EDGAR_FALLBACK` | `true` | SEC EDGAR Form N-PORT-P fallback for funds whose holdings CSV lists no holdings. |
| `SKIP_YAHOO` | `false` | Never call the Yahoo chart API; previously published history rows are kept. |
| `SKIP_NORTHERNTRUST` | `false` | Keep the previously published Northern Trust catalog, holdings and returns; only run the fallbacks. |
| `STORE_RAW_DOWNLOADS` | `false` | Store the source downloads under `api/northerntrust/raw`. In Actions the optional repository variable `STORE_RAW_DOWNLOADS` overrides it when nonblank. |
| `SEC_UA` | `daggerok ETF feed daggerok@gmail.com` | SEC User-Agent with the declared contact SEC policy requires; redacted in config logs. The protected repository variable `SEC_UA` wins over every other layer when nonblank. |
| `CATALOG_URL` | empty (official funds list) | Override the catalog page URL (`https`, or `http` for localhost). |
| `VERBOSE` | `false` | Print per-fund retry and fallback notices. |
| `USE_SYSTEM_CA` | `auto` | TLS trust store: `auto` restarts the updater once with Bun's `--use-system-ca` when a request fails with an untrusted-certificate error; `true` always uses the system CA store; `false` never restarts. Not an individual workflow input: use `advanced`, the config file or the CLI environment. |
| `PERFORMANCE_YTD` / `_1Y` / `_3Y` / `_5Y` / `_10Y` | `:` | Annualized return ranges (strict `min:max`). |
| `TOTAL_RETURN_YTD` / `_1Y` / `_3Y` / `_5Y` / `_10Y` | `:` | Cumulative return ranges (strict `min:max`). |

### Examples

```bash
MAX_FETCHES=10 bun scripts/update-data.ts
TICKERS="QLC SKOR TIPA TXCA" bun scripts/update-data.ts
AUM="1B:" TER=":0.5" bun scripts/update-data.ts
PERFORMANCE_1Y="15:" bun scripts/update-data.ts
```

## TypeScript and verification

The browser app is intentionally build-free: `index.html` carries the markup, styles and bootstrap, and `app.tsx` is TypeScript compiled in the browser with Babel standalone - no build step, no bundler, no `tsconfig.json` needed. Bun runs TypeScript out of the box.

Verification before every publish:

```bash
bun install --frozen-lockfile
bun test
bun build --target=bun scripts/update-data.ts --outfile=/dev/null
git diff --check
```

## Brands table

| Brand | Where to get the data |
| --- | --- |
| **AAM** | [aamlive.com](https://www.aamlive.com/ETF) \| [AAM](https://daggerok.github.io/AAM/) |
| **abrdn (Aberdeen)** | [aberdeeninvestments.com](https://www.aberdeeninvestments.com/en-us/investor/funds/etfs) \| [aberdeen](https://daggerok.github.io/aberdeen/) |
| **Amplify** | [amplifyetfs.com](https://amplifyetfs.com/) \| [Amplify](https://daggerok.github.io/Amplify/) |
| **ARK Invest** | [ark-funds.com](https://www.ark-funds.com/our-etfs/) \| [ARK](https://daggerok.github.io/ARK/) |
| **Capital Group** | [capitalgroup.com](https://www.capitalgroup.com/advisor/investments/exchange-traded-funds.html) \| [Capital-Group](https://daggerok.github.io/Capital-Group/) |
| **Fidelity** | [fidelity.com](https://www.fidelity.com/etfs) \| [Fidelity](https://daggerok.github.io/Fidelity/) |
| **First Trust** | [ftportfolios.com](https://www.ftportfolios.com/Retail/etf/etflist.aspx) \| [First-Trust](https://daggerok.github.io/First-Trust/) |
| **Franklin Templeton** | [franklintempleton.com](https://www.franklintempleton.com/investments/options/exchange-traded-funds) \| [Franklin](https://daggerok.github.io/Franklin/) |
| **Global X** | [globalxetfs.com/explore](https://www.globalxetfs.com/explore) \| [Global-X](https://daggerok.github.io/Global-X/) |
| **Goldman Sachs** | [am.gs.com](https://am.gs.com/en-us/individual/funds?locale=en-us&audience=individual&sf=funds&filters=funds%7CETF&limit=100) \| [Goldman-Sachs](https://daggerok.github.io/Goldman-Sachs/) |
| **Invesco** | [invesco.com](https://www.invesco.com/us/en/financial-products/etfs.html) \| [Invesco](https://daggerok.github.io/Invesco/) |
| **iShares** | [ishares.com](https://www.ishares.com/) \| [iShares](https://daggerok.github.io/iShares/) |
| **JPMorgan** | [am.jpmorgan.com](https://am.jpmorgan.com/us/en/asset-management/adv/products/fund-explorer/etf) \| [JPMorgan](https://daggerok.github.io/JPMorgan/) |
| **NEOS** | [neosfunds.com](https://neosfunds.com/#explore-etfs) \| [Neos](https://daggerok.github.io/Neos/) |
| **Northern Trust** | [etfs.ntam.northerntrust.com](https://etfs.ntam.northerntrust.com/us/en/individual/funds) \| [Northern-Trust](https://daggerok.github.io/Northern-Trust/) |
| **Pacer ETFs** | [paceretfs.com](https://www.paceretfs.com/products/) \| [Pacer](https://daggerok.github.io/Pacer/) |
| **Parametric** | [eatonvance.com](https://www.eatonvance.com/products/etfs.html) \| [Parametric](https://daggerok.github.io/Parametric/) |
| **ProShares** | [proshares.com](https://www.proshares.com/our-etfs/find-proshares-etfs) \| [ProShares](https://daggerok.github.io/ProShares/) |
| **Schwab** | [schwabassetmanagement.com](https://www.schwabassetmanagement.com/products) \| [Schwab](https://daggerok.github.io/Schwab/) |
| **SP Funds** | [sp-funds.com](https://www.sp-funds.com/) \| [SP-Funds](https://daggerok.github.io/SP-Funds/) |
| **SPDR** | [ssga.com](https://www.ssga.com/us/en/intermediary/etfs/fund-finder) \| [SPDR](https://daggerok.github.io/SPDR/) |
| **Sprott ETFs** | [sprottetfs.com](https://sprottetfs.com/) \| [Sprott](https://daggerok.github.io/Sprott/) |
| **Tema ETFs** | [temaetfs.com](https://temaetfs.com/funds) \| [Tema](https://daggerok.github.io/Tema/) |
| **Themes ETFs** | [themesetfs.com/etfs](https://themesetfs.com/etfs) \| [Themes](https://daggerok.github.io/Themes/) |
| **VanEck** | [vaneck.com](https://www.vaneck.com/us/en/etf-mutual-fund-finder/) \| [VanEck](https://daggerok.github.io/VanEck/) |
| **Vanguard** | [investor.vanguard.com](https://investor.vanguard.com/etf/list) \| [Vanguard](https://daggerok.github.io/Vanguard/) |
| **VictoryShares** | [vcm.com VictoryShares ETFs](https://www.vcm.com/products/victoryshares-etfs/victoryshares-etfs-list) \| [VictoryShares](https://daggerok.github.io/VictoryShares/) |
| **WisdomTree** | [wisdomtree.com](https://www.wisdomtree.com/investments) \| [WisdomTree](https://daggerok.github.io/WisdomTree/) |
| **Xtrackers** | [etf.dws.com](https://etf.dws.com/en-us/etf-products/) \| [Xtrackers](https://daggerok.github.io/Xtrackers/) |

## Sibling applications

| Application | Data provider | Repository |
| --- | --- | --- |
| AAM | Official AAM catalog/detail HTML + full holdings XLS + SEC N-PORT holdings fallback + Yahoo market history/dividends | [AAM](https://github.com/daggerok/AAM) |
| abrdn (Aberdeen) | Official Aberdeen gateway + SEC N-PORT holdings fallback + Yahoo history/dividends | [aberdeen](https://github.com/daggerok/aberdeen) |
| Amplify | Amplify ETFs Firestore data feed + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [Amplify](https://github.com/daggerok/Amplify) |
| ARK Invest | ark-funds.com fund pages + overview/NAV-history/performance JSON + official daily holdings CSV + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance distributions/history fallback | [ARK](https://github.com/daggerok/ARK) |
| Capital Group | Official Capital Group fund data + SEC N-PORT holdings fallback + Yahoo history fallback | [Capital-Group](https://github.com/daggerok/Capital-Group) |
| Fidelity | SEC EDGAR N-PORT-P + Yahoo Finance | [Fidelity](https://github.com/daggerok/Fidelity) |
| First Trust | ftportfolios.com official ETF list + fund summary, holdings, distribution and price-history export pages + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history fallback | [First-Trust](https://github.com/daggerok/First-Trust) |
| Franklin Templeton | franklintempleton.com ETF listings + product pages + SEC EDGAR N-PORT-P | [Franklin](https://github.com/daggerok/Franklin) |
| Global X | globalxetfs.com Next.js catalog and fund pages + dated full-holdings CSV | [Global-X](https://github.com/daggerok/Global-X) |
| Goldman Sachs | am.gs.com fund finder + detail pages + SEC EDGAR N-PORT-P | [Goldman-Sachs](https://github.com/daggerok/Goldman-Sachs) |
| Invesco | invesco.com fund pages and sitemap + official Invesco fund API (monthly returns, NAV, AUM, yields, daily holdings, expense ratio) + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [Invesco](https://github.com/daggerok/Invesco) |
| iShares | iShares (BlackRock) product workbooks | [iShares](https://github.com/daggerok/iShares) |
| JPMorgan | am.jpmorgan.com fund explorer + product-data JSON | [JPMorgan](https://github.com/daggerok/JPMorgan) |
| NEOS | neosfunds.com lineup table + official fund pages + daily holdings CSV | [Neos](https://github.com/daggerok/Neos) |
| Northern Trust | etfs.ntam.northerntrust.com funds list + per-fund CSV/JSON downloads | [Northern-Trust](https://github.com/daggerok/Northern-Trust) |
| Pacer ETFs | paceretfs.com product catalog and fund pages (Cloudflare WAF; r.jina.ai proxy fallback) + SEC EDGAR N-PORT-P (Pacer Funds Trust) + Yahoo Finance history/dividends | [Pacer](https://github.com/daggerok/Pacer) |
| Parametric | eatonvance.com ETF catalog and Parametric product pages + SEC EDGAR N-PORT-P holdings + Yahoo Finance history/dividends | [Parametric](https://github.com/daggerok/Parametric) |
| ProShares | proshares.com ETF finder + fund pages + official data host | [ProShares](https://github.com/daggerok/ProShares) |
| Schwab | schwabassetmanagement.com product pages + CSV exports | [Schwab](https://github.com/daggerok/Schwab) |
| SP Funds | sp-funds.com homepage catalog, fund pages and daily holdings CSV + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [SP-Funds](https://github.com/daggerok/SP-Funds) |
| SPDR | SSGA / State Street public feeds | [SPDR](https://github.com/daggerok/SPDR) |
| Sprott ETFs | sprottetfs.com fund pages + SEC EDGAR N-PORT-P (Sprott Funds Trust) + Yahoo Finance history/dividends | [Sprott](https://github.com/daggerok/Sprott) |
| Tema ETFs | Tema official fund pages + dated daily holdings CSV; SEC EDGAR N-PORT-P holdings fallback only + Yahoo Finance price/history/dividend fallback | [Tema](https://github.com/daggerok/Tema) |
| Themes ETFs | themesetfs.com catalog + daily holdings CSV + Yahoo Finance history/dividends + SEC N-PORT-P holdings fallback | [Themes](https://github.com/daggerok/Themes) |
| VanEck | vaneck.com ETF finder + product pages | [VanEck](https://github.com/daggerok/VanEck) |
| Vanguard | Vanguard product pages + SEC EDGAR N-PORT-P | [Vanguard](https://github.com/daggerok/Vanguard) |
| VictoryShares | VCM VictoryShares catalog and product JSON + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance adjusted-market-price history | [VictoryShares](https://github.com/daggerok/VictoryShares) |
| WisdomTree | WisdomTree product table + SEC EDGAR N-PORT-P + Yahoo Finance | [WisdomTree](https://github.com/daggerok/WisdomTree) |
| Xtrackers | Official DWS catalog/US sitemap + PDP/XLSX + SEC N-PORT-P holdings fallback + Yahoo Finance daily prices/history/dividends | [Xtrackers](https://github.com/daggerok/Xtrackers) |

## License

[MIT - same as all sibling ETF repositories.](./LICENSE)

Northern Trust® and FlexShares® and the fund names/tickers referenced here are trademarks of Northern Trust Corporation. This is an independent, unofficial tool; it is not affiliated with, endorsed by, or sponsored by Northern Trust Corporation. All data is reproduced from Northern Trust's own public fund pages and downloads, public SEC EDGAR filings and Yahoo Finance for research purposes. All other trademarks, including index names, are the property of their respective owners.
