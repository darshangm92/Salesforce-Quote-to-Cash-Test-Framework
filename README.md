# Salesforce CPQ E2E Automation — Getting Started

A Playwright + JavaScript end-to-end suite for Salesforce CPQ (SBQQ managed package): price rules, pricing methods, the bundle configurator, quote structure, and the full quote → order → contract → asset → amendment → renewal lifecycle. Data is seeded and torn down through the REST API; the UI is driven for real, and assertions read the records that UI produced — not the rendered DOM.

Read this file to get running. For *why* something is built the way it is, the reasoning lives next to the code: every spec opens with a plain-English `WHAT THIS PROVES / WHY IT MATTERS / HOW IT WORKS / IF THIS FAILS` header, [tests/README.md](tests/README.md) maps the suite, and each `tests/<folder>/README.md` covers its own domain.

**Stack:** Node.js 20+, Playwright Test (JavaScript, CommonJS), Salesforce CPQ (SBQQ managed package), Allure.

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [One-time project setup](#2-one-time-project-setup)
3. [How login/authentication works here](#3-how-loginauthentication-works-here)
4. [Running the tests](#4-running-the-tests)
5. [Updating selectors for your org](#5-updating-selectors-for-your-org)
6. [Project structure map](#6-project-structure-map)
7. [Writing a new test](#7-writing-a-new-test)
8. [Adding a new page object](#8-adding-a-new-page-object)
9. [Extending the API layer (CpqDataFactory)](#9-extending-the-api-layer-cpqdatafactory)
10. [Adding new test data](#10-adding-new-test-data)
11. [Debugging a failing test](#11-debugging-a-failing-test)
12. [Working with Claude Code to enrich this project](#12-working-with-claude-code-to-enrich-this-project)
13. [CI/CD](#13-cicd)
14. [Gotchas](#14-gotchas)
15. [Command cheat sheet](#15-command-cheat-sheet)

---

## 1. Prerequisites

- Node.js 20 LTS or newer
- A Salesforce org with **Salesforce CPQ (SBQQ managed package)** installed — Developer Edition, Sandbox, or UAT
- Access to that org's **Setup** menu, to create a Connected App (or External Client App) and pre-authorize the running user
- This repo already bootstrapped (`playwright.config.js`, `src/`, `data/`, `tests/` all exist — if you're reading this, that part is done)

---

## 2. One-time project setup

```bash
npm ci
npx playwright install --with-deps   # only needed if browsers aren't already installed
```

### 2.1 Create a Connected App (one time, per org)

This suite authenticates with the **OAuth 2.0 JWT Bearer flow**, not username/password. Two reasons that isn't a style choice: the username-password flow can't answer an MFA challenge (no field exists for it), and it's unsupported outright on Salesforce's newer External Client App model. If your org enforces MFA — most do now — username/password simply cannot authenticate a headless test run.

1. In Salesforce **Setup → App Manager → New Connected App** (or **New External Client App** on orgs where Connected App creation is admin-restricted).
2. Under **API (Enable OAuth Settings)**, check "Enable OAuth Settings" and **"Use digital signatures"**.
3. OAuth Scope: **api** is sufficient.
4. Generate the key pair locally — this also writes the cert you'll upload:
   ```bash
   npm run generate:jwt-cert
   ```
   This writes `.certs/server.key` and `.certs/server.crt` (both gitignored — never commit them). Upload `.certs/server.crt` where the app asks for a certificate under "Use digital signatures".
5. Save, then wait a few minutes for the app to activate.
6. Under **Manage → Edit Policies**, set **Permitted Users** to "Admin approved users are pre-authorized", then add the running user's profile or a permission set under **Manage Profiles** / **Manage Permission Sets**.
7. Note the **Consumer Key** from **Manage Consumer Details** — that's your JWT `iss` claim.

### 2.2 Configure `.env`

```bash
cp .env.example .env
```

Fill in the real values — see the comments in [.env.example](.env.example):

| Variable | Where it comes from |
|---|---|
| `SF_ENV` | `developer`, `sandbox`, or `uat` — must match the `--project` you run with |
| `SF_USERNAME` | Your Salesforce username for the org under test — must be pre-authorized on the Connected App (2.1 step 6) |
| `SF_CONSUMER_KEY` | Connected App → Manage Consumer Details (2.1 step 7) |
| `SF_JWT_PRIVATE_KEY` | Leave unset locally — `src/config/env.js` reads `.certs/server.key` directly. Only set this (or inject it as a CI secret) if the PEM has to come from an env var instead of a file. |

`.env`, `.auth/`, and `.certs/` are all gitignored — never commit them.

---

## 3. How login/authentication works here

**There is no interactive login step, and tests must never add one.** Here's what actually happens:

1. Before any test runs, Playwright calls **[global-setup.js](global-setup.js)** once.
2. It calls **[src/api/SalesforceAuth.js](src/api/SalesforceAuth.js)**, which signs a JWT (issuer = Consumer Key, subject = `SF_USERNAME`, audience = the org's login URL) with the private key from `.certs/server.key`, and exchanges it for an access token via the `urn:ietf:params:oauth:grant-type:jwt-bearer` grant.
3. The resulting access token + instance URL are written to `.auth/sf-session.json` — this is what `SalesforceRestClient` reads for every API call (seeding/tearing down Accounts, Opportunities, Quotes, ...).
4. Separately, global-setup opens a real (headless) browser, navigates to `<instanceUrl>/secur/frontdoor.jsp?sid=<accessToken>` — Salesforce's mechanism for exchanging an API session for a logged-in browser session — and saves that as `.auth/session.json` (a Playwright `storageState`).
5. `playwright.config.js` sets `use.storageState: '.auth/session.json'` globally, so **every test's browser context starts already logged in**. No test ever sees the login page, and this reliably bypasses MFA prompts too.

**To point at a different org:** change `SF_ENV` in `.env` (or set it inline) and use the matching `--project` flag — they must agree. `playwright.config.js` deliberately emits **exactly one project**, named for `SF_ENV`; a mismatch fails immediately (`Project(s) "uat" not found. Available projects: "developer"`) instead of silently running against the wrong org:

```bash
npm run test:dev       # SF_ENV=developer --project=developer
npm run test:sandbox   # SF_ENV=sandbox   --project=sandbox
npm run test:uat       # SF_ENV=uat       --project=uat
```

`.auth/` is gitignored and regenerated on every run — never commit it, and don't hand-edit it.

---

## 4. Running the tests

```bash
# Full suite against Developer org (default, Chromium), single process
npm run test:dev

# Full suite, one Playwright process per independent scenario, running
# concurrently — see Section 4.1
npm run test:parallel

# The merge gate: everything except journeys, quota-heavy, WIP, and
# Developer-org-incompatible tests
npm run test:pr

# Smoke vs full regression
npm run test:smoke
npm run test:regression

# Multi-stage journeys (serial, one worker — see Gotchas)
npm run test:journey

# Tests that mutate shared org config, serialized
npm run test:serial

# A single spec file
npx playwright test tests/pricing/no-rule-fires.spec.js

# By title substring
npx playwright test -g "volume discount"

# Headed / step-debug
npm run test:headed
npm run test:debug

# Cross-browser spot checks (Chromium is the default/reference browser)
npm run test:firefox
npm run test:webkit
```

### 4.1 Lane parallelism (`npm run test:parallel`)

The whole suite, one Playwright process per **lane**, running concurrently and reporting in the time of the slowest lane rather than the sum — measured at **~19 minutes** wall clock against a **~52 minute** lane-duration sum. Lanes are **derived automatically**, one per immediate subdirectory of `tests/` (with two documented overrides — `config/` splits into two independent lanes, `journeys/` stays one lane pinned to a single worker because its two files are one ordered scenario). A coverage guard aborts the run by name if any spec is unclaimed or double-claimed by a lane, so this can't silently drop coverage as the suite grows.

```bash
npm run test:parallel                                # everything, 3 lanes at a time (default)
npm run test:parallel -- --lanes=smartwatch,solar    # just the two configurator lanes, ~10 min
npm run test:parallel -- --print-lanes               # show the resolved lane table + coverage check, no run, no auth
npm run test:parallel -- --max-concurrent=2          # gentler on a loaded org
```

`--max-concurrent` defaults to 3 because the scarce resource is the **org**, not the machine — every lane is another browser driving another Quote Line Editor against one API limit. Other Playwright arguments (e.g. `--headed`) pass through to every lane.

### Slicing by tag

Tags are namespaced (`@type:`, `@domain:`, `@stage:`, `@risk:`, …) — the full taxonomy is the allowlist in [scripts/lint-tags.js](scripts/lint-tags.js). Select any axis with `--grep`:

```bash
npx playwright test --grep "@domain:pricing"
npx playwright test --grep "@domain:config|@domain:quote"
npx playwright test --grep-invert "@speed:slow|@quota:heavy|@wip"

# Combine env + domain
SF_ENV=uat npx playwright test --project=uat --grep "@domain:pricing"

# To AND two axes, use a lookahead — a second --grep REPLACES the first
# rather than ANDing with it, which is the easiest way to run the wrong slice.
npx playwright test --grep "(?=.*@domain:pricing)(?=.*@risk:high)"
```

Validate every tag against the taxonomy before you push:

```bash
npm run lint:tags
```

This matters more than it looks. A typo'd tag doesn't error — it just makes `--grep` match nothing, and the run goes green having tested nothing at all. The lint also checks the reverse direction: every test the merge gate would run must be claimed by at least one of its CI slices, so a correctly-tagged test can't be committed and never actually get run.

### Keeping data around to investigate a failure

```bash
npm run test:keep-data   # CPQ_SKIP_CLEANUP=1 — records survive the run
```

`cleanup()` then reports what it *would* have deleted instead of deleting it, so you can open the records in the org. The scheduled sweeper reclaims them later (Section 13).

### Reports and evidence

```bash
npm run report          # open the last Playwright HTML report
npm run allure:generate # build the Allure report from allure-results/
npm run allure:serve    # generate + open Allure in one step
```

Beyond the pass/fail report, every spec also captures a screenshot at each documented validation point (`src/utils/evidence.js`) into gitignored `artifacts/evidence/<spec-file>/<ordinal>-<slug>.png`, attached automatically to the HTML and Allure reports. These are evidence, not visual-regression baselines — nothing ever diffs them — but they're useful when a run needs to be reviewed by someone who isn't going to open the org.

---

## 5. Updating selectors for your org

CPQ's managed-package markup varies by version and org configuration, so selectors are org-specific by nature. The page classes in `src/pages/` distinguish two kinds of comment, and it's worth knowing the difference before changing anything:

- **`CONFIRMED` / `MEASURED` / `READ FROM THE ORG`** — read off a real Developer org's live DOM while writing the corresponding test. Most of this suite is in this state today: the Quote Line Editor, product selection, the bundle configurator, Orders, Contracts, Amendments, and Accounts all have selectors and behavior verified against a running org, often with the specific trap that would otherwise bite documented right next to the fix (see the examples below).
- **`Placeholder`** — a small remainder (mainly `QuotePage.editLinesButton()` and a couple of others called out inline) that hasn't been exercised by a passing test yet and should be confirmed against your org before you rely on it.

A `CONFIRMED` selector is still a fact about *one* org on *one* date — CPQ markup can differ across managed-package versions, so treat every selector as something to spot-check against your org rather than something guaranteed to match on sight, even where it's marked confirmed. If you find one that doesn't hold in your org, fix it in the page class and leave a comment saying what you found and when — don't just delete the old note, since it may still be correct for other orgs/versions.

**Non-obvious things already discovered in this org, worth knowing before you start clicking around your own:**
- The classic Quote Line Editor and the product selection/configurator screens all render inside a **Visualforce iframe** — everything in those page classes goes through `page.frameLocator(...)`.
- The Quote Line Editor's editable cells carry a `field` attribute, **not** `data-field`.
- The bundle configurator uses **three different kinds of checkbox** (Polymer `<paper-checkbox>`, real `<input type="checkbox">`, and div-built controls with no input/role/aria at all) — each needs a different read strategy. See `ProductConfigurationPage.js`.
- A rejected Save's error toasts persist until the *next* Save and decay on their own timer — read them immediately after a Save, never later.

### 5.1 Find the Quote Line Editor's iframe (start here if it doesn't match your org)

1. Log into your org normally in a regular browser and open any Quote record.
2. Click into the Quote Line Editor (the classic Visualforce editor).
3. Open DevTools → Elements, and find the `<iframe>` that wraps the editor content. Note its `title` or `name` attribute.
4. Update the `editor` locator in [src/pages/QuoteLineEditorPage.js](src/pages/QuoteLineEditorPage.js) (`EDITOR_FRAME_SELECTOR`, exported and reused by `ProductSelectionPage.js` and `ProductConfigurationPage.js` so all three page classes target the same frame from one place).

### 5.2 Find selectors for buttons/fields

The fastest way is **Playwright's codegen**, which records real selectors as you click around:

```bash
npx playwright codegen https://your-instance.my.salesforce.com
```

Log in manually in the codegen browser (this is a one-off manual exploration tool — it's not part of the test suite and never touches the automated auth flow), then click "Edit Lines", "Add Products", "Calculate", etc. Codegen prints the locator it used for each click — copy the good ones (prefer role-based, e.g. `getByRole('button', { name: '...' })`, over generated CSS/XPath) into the matching page class method.

Alternatively, use DevTools directly: right-click an element → Inspect, note its accessible role/name or a stable attribute, and hand-write the locator. Note that shadow DOM shows up a lot in the configurator — chained `.locator()` calls pierce an open shadow root, but `innerHTML`/`evaluateAll('*')` and `closest()` do not.

### 5.3 Where each page class's selectors live

| Page class | What it covers |
|---|---|
| [QuoteLineEditorPage.js](src/pages/QuoteLineEditorPage.js) | iframe locator, Calculate/Save/Add Products, line cells (quantity, discount, net total), quote line group headers, the per-line drawer |
| [ProductSelectionPage.js](src/pages/ProductSelectionPage.js) | search box, product row, "Add to Quote" |
| [ProductConfigurationPage.js](src/pages/ProductConfigurationPage.js) | the bundle configurator: features, options, quantities, global and option-level configuration attributes, the three checkbox flavors |
| [QuotePage.js](src/pages/QuotePage.js) | "Edit Lines", field edits via the record edit modal, Calculate |
| [OpportunityPage.js](src/pages/OpportunityPage.js) | Quotes related list, quote row link, the record edit modal |
| [OrderPage.js](src/pages/OrderPage.js) | Order record surfaces |
| [ContractPage.js](src/pages/ContractPage.js) | Contract record surfaces, the Amend action |
| [ContractAmendmentPage.js](src/pages/ContractAmendmentPage.js) | CPQ's Visualforce `/apex/AmendContract` confirmation screen |
| [AccountPage.js](src/pages/AccountPage.js) | Account record surfaces |

There is deliberately no `ApprovalPage.js` and no `approvalPage` fixture — an earlier version existed but was deleted, unused and built on unverified selectors. Add it back with the approvals suite that needs it, against selectors read from your org.

**Rule to keep:** selectors live only in page classes, never in spec files. If a selector behaves differently across browsers, fix it in the page class — don't special-case a spec.

**Where flows fit:** a page class knows how to click things on *one* screen. A multi-screen business transition ("quote becomes an order") belongs in [src/flows/](src/flows/) instead — see Section 7.1. The dependency runs one way only: flows may require page classes, page classes may never require flows.

---

## 6. Project structure map

```
data/                    Test data — JSON and Excel (see Section 10)
  home-security.json       Scenario data for the pricing suite's shared control account
  solar-bundle.json        Scenario data for the bundle-configurator (constraints) suite
  smartwatch-bundle.json   Scenario data for the configuration-attribute suite
  pricing-rules.json       Scenario data for the price-rule suite (tests/pricing/)
  pricing-methods.json     Scenario data for the pricing-method suite (tests/pricing-methods/)
  optional-lines.json      Scenario data for the quote-structure suite (tests/quote/)
  contract-<number>-extract.xlsx   Org field reference, written by extract:contract (read-only)
  e2e-run-ledger.xlsx      Merged run ledger (gitignored) — what the suite created, and when
scripts/
  generate-jwt-cert.js     One-time JWT Bearer Flow key pair (Section 2.1)
  lint-tags.js             Enforces the tag taxonomy (npm run lint:tags) — the taxonomy allowlist lives here
  run-parallel.js          One process per independent scenario, lanes derived from tests/ (Section 4.1)
  merge-ledger.js          Ledger shards -> data/e2e-run-ledger.xlsx
  extract-contract.js      Read-only Contract + Subscription field dump (npm run extract:contract)
  cleanup-e2e-data.js      Standalone scheduled data sweeper (Section 13)
src/
  config/env.js           Resolves SF_ENV -> login URL/API version, reads .env
  api/
    SalesforceAuth.js      JWT Bearer Flow token retrieval (used once, by global-setup.js)
    SalesforceRestClient.js Thin REST wrapper: create / query / delete a single sObject
    CpqDataFactory.js       CPQ setup, record stamping, ledger, ordered teardown
  pages/                   One class per UI surface — see Section 5.3 table
  flows/                   Business transitions: pages + polling + API assertion
    index.js
    createQuoteWithGroups.js
    createSimpleQuote.js    Ungrouped quote against a looked-up Account
    quoteSimpleProducts.js  Seed -> QLE -> add products -> Quick Save -> the saved lines
    amendContract.js        Drives an amendment through the Visualforce confirmation screen
    orderAndContract.js     Order -> activate -> Contract, polling for the org's async work
    openFlatQuoteEditor.js  Works around a grouped-editor hang on CPQ-generated quotes
  fixtures/cpqFixtures.js  Wires cpqData (write) + sf (read-only) + every page-class fixture
  utils/
    excelReader.js          xlsx -> array of row objects
    dataProvider.js         loadJson() / loadExcel(), both scoped to data/
    waitForAsync.js         Polls the API for CPQ's async work (Flows, Apex) — never a fixed wait
    runContext.js           runId, record stamping, journey state hand-off
    ledger.js               Per-worker JSONL ledger shards
    evidence.js             Run-evidence screenshots, one per validation point
    pricingConfig.js        Read-only org pricing-method config guards (fail before the browser opens)
    pricingData.js          data-file guards (fail-by-name on an unresolved placeholder) + Account resolution
tests/
  README.md                Folder map, every spec and what it proves, tag rules, the lane rule
  config/                  Bundle configuration + configuration attributes — @domain:config
  pricing/                 Price RULES, one spec per SBQQ__PriceRule__c — @domain:pricing
    expectations.js          Shared assertion vocabulary — not a spec
  pricing-methods/         Pricing METHODS (block, percent-of-total, cost-plus, bundle, contracted) — @domain:pricing
  quote/                   What a total counts and what carries through — @domain:quote
  journeys/                Quote -> order -> contract -> asset -> amendment -> renewal, serial, @type:journey
    subscription-stages.js   Shared stage list + state key both journey specs resume against
artifacts/                Gitignored — ledger shards, journey state, evidence screenshots
.auth/ .certs/            Gitignored — session artifacts and the JWT key pair
global-setup.js / global-teardown.js
playwright.config.js
```

Two files in that tree are not specs and not page classes, and both sit where they do for a reason. `tests/pricing/expectations.js` imports `expect`, so it belongs on the `tests/` side of the layering line — a util under `src/` is required by page classes and flows, which have no business depending on the test framework. `src/utils/pricingData.js` and `src/utils/pricingConfig.js` hold the other half: reading data files and read-only org configuration safely, which nothing test-framework-shaped is involved in.

**Layering, one direction only:**

```
tests/  ->  src/flows/  ->  src/pages/  +  src/api/  +  src/utils/
```

Nothing in `src/pages/` may require anything from `src/flows/`.

---

## 7. Writing a new test

The guiding rule is **act in the UI, assert in the API, spot-check the UI**. CPQ correctness lives in the data model, not in what Lightning renders — a formatted `12,000.00` in the DOM proves the DOM updated, not that the quote is right. (The one documented exception is a configurator *constraint* test — a rejected Save or refused deselect writes nothing, so there's no record to assert on. See `tests/config/solar-bundle-configuration.spec.js`.)

**Steps:**

1. Create `tests/<domain>/<name>.spec.js` — or `tests/journeys/<name>.spec.js` for a multi-stage flow. Check [tests/README.md](tests/README.md) for which folder (and lane) it belongs in; a spec in an existing folder joins that folder's parallel lane automatically.
2. Add scenario data to a file in `data/` (JSON via `loadJson`, or Excel via `loadExcel` — see Section 10) rather than hardcoding values in the spec. Keep each scenario's expected outcome in the same object as its inputs.
3. Pull in fixtures, never construct page objects yourself:
   ```js
   const { test, expect } = require('../../src/fixtures/cpqFixtures');
   const { loadJson } = require('../../src/utils/dataProvider');
   const { createQuoteWithGroups } = require('../../src/flows');
   const session = require('../../.auth/sf-session.json');
   ```
4. Seed data through `cpqData` (never the UI). If the setup spans several records and has to wait on the org's async work, use a **flow** instead of repeating it in the spec:
   ```js
   const { quoteId, groupIdsByName } = await createQuoteWithGroups({ cpqData, sf }, {
     accountName: s.account,
     opportunityName: s.opportunity,
     closeDate: '2026-12-31',
   });
   ```
5. Drive the UI behavior under test through the page-object fixtures: `quoteLineEditor`, `productSelection`, `productConfiguration`, `quotePage`, `opportunityPage`, `orderPage`, `contractPage`, `contractAmendment`, `accountPage`.
6. **Assert against the records**, using the read-only `sf` fixture — then keep at most a light UI spot-check so a rendering regression still gets caught:
   ```js
   const quote = await sf.record('SBQQ__Quote__c', quoteId, ['Id', 'SBQQ__NetTotal__c']);
   expect(quote.SBQQ__NetTotal__c).toBe(s.expect.SBQQ__NetTotal__c);
   ```
   `sf` is read-only by contract. Writes go through `cpqData` so they land in the run ledger and get torn down.
7. **Never wait on a fixed timeout for the org's async work.** Record-triggered Flows and queueable Apex finish long after the spinner clears — poll the API, and put the value you're waiting for in the query condition itself (a poll for "the row exists" is satisfied instantly by a pre-edit row and reports a save that hasn't landed as a value that's simply wrong):
   ```js
   const groups = await sf.pollForRecords(soql, { expect: 2 });
   await sf.pollForFieldValue('SBQQ__Quote__c', quoteId, 'SBQQ__Primary__c', true);
   ```
8. Tag the test from the allowlist in [scripts/lint-tags.js](scripts/lint-tags.js) — **at minimum one `@type:` and one `@domain:`**, via the `tag` option, never in the title:
   ```js
   test('quote line group totals roll up',
     { tag: ['@type:regression', '@domain:quote', '@risk:high'] },
     async ({ cpqData, sf, quoteLineEditor }) => { /* ... */ });
   ```
   Journey stages also carry a `@stage:`. Run `npm run lint:tags` before pushing — an invalid tag doesn't error, it just silently matches nothing.
9. No cleanup code needed in the test body — `cpqData`'s fixture teardown in `cpqFixtures.js` calls `cleanup()` automatically after the test finishes.
10. Run it locally: `npx playwright test tests/<domain>/<name>.spec.js --project=developer`.

### 7.1 Adding a flow

A **flow** is a business transition — several page objects, plus polling for async work, plus an API assertion that the transition landed. It goes in [src/flows/](src/flows/) and is re-exported from `src/flows/index.js`. [createQuoteWithGroups.js](src/flows/createQuoteWithGroups.js) is the smallest complete example.

Add one when the same multi-screen transition is about to appear in a second spec, not before — an empty flow file is a promise the framework can't keep.

---

## 8. Adding a new page object

1. Create `src/pages/YourPage.js`, extending `BasePage`:
   ```js
   const { BasePage } = require('./BasePage');

   class YourPage extends BasePage {
     async open(instanceUrl, recordId) {
       await this.openRecord(instanceUrl, recordId); // native Lightning record page
       // or: await this.page.goto(`${instanceUrl}/apex/...`) for a Visualforce page
     }

     someButton() {
       return this.page.getByRole('button', { name: 'Some Button' }); // confirm against your org
     }

     async doSomething() {
       await this.someButton().click();
       await this.waitForLightningReady(); // or the QLE's own "calculating" wait pattern
     }
   }

   module.exports = { YourPage };
   ```
2. Register it as a fixture in [src/fixtures/cpqFixtures.js](src/fixtures/cpqFixtures.js):
   ```js
   const { YourPage } = require('../pages/YourPage');
   // ...inside test.extend({ ... }):
   yourPage: async ({ page }, use) => {
     await use(new YourPage(page));
   },
   ```
3. Use it in a spec via `async ({ yourPage }) => { ... }`.
4. Prefer role-based locators over deep CSS/XPath; use `npx playwright codegen` (Section 5.2) to find real selectors. Confirm every selector against a real page load before trusting it — see Section 5 for traps already found in this org (shadow DOM, the `field` vs `data-field` attribute, the three checkbox flavors).

---

## 9. Extending the API layer (CpqDataFactory)

`CpqDataFactory` currently supports `account()`, `opportunity()`, and `quote()` as create methods, plus `track()` / `registerExisting()` / `stampExisting()` for records created or looked up outside the factory that still need to land in the ledger or the sweep. To seed another object type, add a method following the same pattern:

```js
async contract(quoteId, fields = {}) {
  const id = await this.client.create('Contract', { SBQQ__Quote__c: quoteId, ...fields });
  this.created.push({ sobject: 'Contract', id }); // required — this is what makes cleanup() find and delete it
  return id;
}
```

Rules to keep:
- Always push `{ sobject, id }` onto `this.created` right after a successful create, so teardown can find it.
- Creation order in a test should mirror parent → child (Account → Opportunity → Quote → ...); `cleanup()` deletes in reverse automatically.
- If you need to look something up rather than create it, use `client.query(soql)` directly (see `SalesforceRestClient.query`) — no need to route it through `CpqDataFactory` unless it also needs teardown tracking. Use `registerExisting()` for a looked-up record you want in the ledger but never want the sweeper to delete (this suite's Accounts, for example — see Section 13.1).
- Use real CPQ field API names with the `SBQQ__` prefix — `SBQQ__Quote__c`, `SBQQ__NetTotal__c`, `SBQQ__AdditionalDiscount__c`. An unknown field name fails the whole create with `INVALID_FIELD`.

---

## 10. Adding new test data

- **JSON** (`data/*.json`): add a new file or extend an existing one, then `loadJson('yourfile.json')` from a spec. Keep each scenario's expected outcome (e.g. `expectedNetTotal`) *in the same object* as its inputs, so the assertion never drifts out of sync with the data that produced it.
- **Excel** (`data/*.xlsx`): one column per field, with the expected outcome last. To generate/update an `.xlsx` from a script, use the `xlsx` package already in `devDependencies`:
  ```js
  const XLSX = require('xlsx');
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'YourSheetName');
  XLSX.writeFile(wb, 'data/your-file.xlsx');
  ```
  Then read it with `loadExcel('your-file.xlsx')`. Since spreadsheet cells can't hold code comments, add a second "Notes" sheet documenting the columns for anyone opening the file directly in Excel — [scripts/merge-ledger.js](scripts/merge-ledger.js) does exactly this for `e2e-run-ledger.xlsx`. `loadExcel()` defaults to the first sheet, so a Notes sheet appended after the data sheet is safely ignored by readers.
- Values you don't know yet (real pricing, real product codes) should be left as an **explicit placeholder** — e.g. `"[SPECIFY] confirm after inspecting org pricing"` — rather than a guessed number. A guessed number that happens to look plausible is worse than an obvious placeholder, because it hides that the scenario isn't actually validated yet. `src/utils/pricingData.js`'s guards (`requireNumber`, `requireString`, `product`) throw naming the exact dotted path when a placeholder survives into a test, so an unresolved value fails loudly instead of passing green.

---

## 11. Debugging a failing test

```bash
npx playwright show-report                      # last HTML report
npx playwright show-trace test-results/<path>/trace.zip
npm run test:headed                              # watch it run
npm run test:debug                               # step through with the Inspector
```

Trace, video, and screenshot are all retained automatically on failure (`playwright.config.js`), so `show-trace` on a failed run's trace.zip is usually the fastest path to a root cause — it replays the exact DOM state, network calls, and console output at the moment of failure. `artifacts/evidence/` (Section 4) is worth a look too: it's a screenshot per documented validation point, not just per failure, so you can see what the screen looked like at each step leading up to one.

---

## 12. Working with Claude Code to enrich this project

The conventions an agent needs are already in the repo, next to the code that follows them: the orientation header at the top of every spec, [tests/README.md](tests/README.md) and the per-folder READMEs, the tag allowlist in [scripts/lint-tags.js](scripts/lint-tags.js), and the reasoning comments in `src/pages/` and `src/flows/`. Point at those rather than restating the rules each session. The load-bearing ones are worth stating up front anyway: Page Object Pattern, API-driven setup and teardown, external data files, namespaced tags via the `tag` option, and **act in the UI, assert in the API**.

Comments in this codebase carry real weight: anything marked `CONFIRMED`, `MEASURED`, or `READ FROM THE ORG` is an observation of a real org on a real date, not a guess — those are the reason the numbers in this suite can be trusted, and they should never be rewritten or "tidied up," only superseded by a newer dated observation placed alongside the old one.

**What Claude Code can and can't do here:**
- It **can** read/write files, run `npm`/`npx playwright` commands, run `node --check` and `--list` to validate syntax and test discovery, and generate xlsx/JSON data files.
- It **cannot** log into your Salesforce org or drive a live browser session against it interactively — it doesn't have your credentials or a way to click around your org. That means it can't discover new selectors on its own if your org's markup differs from what's already confirmed here.

**The effective workflow, in order, when a selector doesn't hold in your org:**

1. **You inspect the org** — use `npx playwright codegen <your-instance-url>` (Section 5.2) or DevTools to find real selectors/markup for the screen that's failing.
2. **You paste what you found to Claude Code** — the recorded codegen locator, or the raw HTML snippet from DevTools, plus which page class it belongs in. For example:
   > "In my org, the Add Products button is `<button title='Add Products' class='...'>`. Update `ProductSelectionPage.js`'s `addProductsButton()` to match."
3. **Claude Code updates the page class** and can immediately validate the change (`node --check`, `npx playwright test --list`) before you re-run the real suite.
4. **Repeat per screen** until the suite is green against your org.

**Other things worth asking Claude Code for:**
- *"Run `npm run test:pr -- --project=developer` and tell me what fails."* — it can execute and read the output, though it still can't see the browser UI itself, so pair this with a screenshot, the HTML report, or the evidence screenshots (Section 4) if the failure is visual.
- *"Add a new pricing scenario to `data/pricing-rules.json` for a 15% discount tier."*
- *"Add a page object for [some other CPQ screen], following the same pattern as QuotePage.js, and wire it into cpqFixtures.js."*
- *"Add a `contract()` method to CpqDataFactory for [some object], following the account/opportunity/quote pattern."*
- *"I got this error running the pricing-methods suite: [paste error]. What's wrong?"*
- If you want CI to also cover Firefox/WebKit (Chromium is the reference browser and the merge-gate default; the other two are for spot-checks), ask Claude Code to extend the GitHub Actions matrix per the note in `.github/workflows/playwright.yml`.

**When asking for a change**, mention the file path if you know it (e.g. `src/pages/QuotePage.js`) — it makes the edit faster and more precise than a vague "fix the submit button."

---

## 13. CI/CD

Two workflows, plus a sweeper you can also run by hand.

**[.github/workflows/playwright.yml](.github/workflows/playwright.yml) — the merge gate.** Runs on every push/PR to `main`, Chromium only, and can be manually dispatched against `developer`/`sandbox`/`uat`. A `lint` job runs `npm run lint:tags` first and gates everything else. The test job is a matrix of **tag slices** (`smoke`, `quote-config`, `pricing-approvals`) rather than folders, so a test moves between slices by changing its tags. Every slice carries `--grep-invert "@type:journey|@quota:heavy|@wip|@skip-de"` — **journeys never run on a PR**, because a full lifecycle walk is far too slow to sit in front of one.

**[.github/workflows/nightly.yml](.github/workflows/nightly.yml) — the full suite and the sweep.** Two jobs on separate schedules that deliberately do not depend on each other:

- `suite` runs `npm run test:parallel` — every spec under `tests/`, lane by lane, not just journeys. This is the only scheduled run that covers the domains (`@domain:orders`, `@domain:contracts`, `@domain:amend`, `@domain:renewal`, `@domain:assets`) that exist only on journey stages and are excluded from the PR gate.
- `sweep` runs `npm run cleanup:e2e -- --confirm`.

The sweep is **not** chained to the suite job. Data gets left behind exactly when a run crashes, so a cleanup that only runs after a passing test job is a cleanup that never runs when it's needed — the two are scheduled a couple of hours apart instead, so the sweep never races a run that's still writing records.

**Secrets** (`SF_USERNAME`, `SF_CONSUMER_KEY`, `SF_JWT_PRIVATE_KEY`) must be added under the repo's **Settings → Secrets and variables → Actions** — never committed. `SF_JWT_PRIVATE_KEY` holds the PEM *content* of `.certs/server.key`, not the file. The Developer org is the only one wired up with a Connected App in this example setup — point `SF_ENV`/the workflow dispatch input at `sandbox` or `uat` only once that org has its own Connected App (Section 2.1).

### 13.1 The run ledger and the data sweeper

Every record the suite creates is stamped into its `Description` (`E2E | run=<runId> | env=… | spec=… | test=… | created=…`) and written to a per-worker JSONL shard under `artifacts/ledger/`. At the end of the run, `global-teardown.js` merges the shards into `data/e2e-run-ledger.xlsx` — one row per record, plus a `Notes` sheet documenting the columns. The workbook is **gitignored**: it's a binary that changes every run, and nothing depends on its history (the sweeper falls back to a SOQL marker net, and then to descending from a marked ancestor, for anything not in the current file — see the script's own header for the full three-source strategy).

Why two phases: several workers appending to one `.xlsx` would corrupt it, since a workbook has to be rewritten wholesale. Single-line appends to a per-worker file are safe across processes.

```bash
npm run ledger:merge                          # merge shards by hand (e.g. after a crash)
npm run cleanup:e2e                           # DRY RUN — prints the plan, deletes nothing
npm run cleanup:e2e -- --confirm              # actually delete
npm run cleanup:e2e -- --confirm --retention-days=3
```

The sweeper defaults to **3 days** of retention and to **dry-run** — deleting requires an explicit `--confirm`. It only ever touches an exhaustive allowlist of E2E-created objects (quote lines, groups, quotes, orders, order items, contracts, subscriptions, assets, opportunity line items, opportunities), and it hard-refuses to touch CPQ configuration, the product catalog, price rules, Flows, or **any `Account`** — this suite quotes against pre-existing sample accounts it did not create. Records resolved by lookup are recorded with `sweepEligible = false`, so the sweeper can never delete something the suite didn't make.

The platform traps it handles are documented in the script's own header: a primary, synced quote cannot be deleted (clear `SBQQ__Primary__c` and `Opportunity.SyncedQuoteId` first); activated Orders and Contracts cannot be deleted, nor can an activated Order's OrderItems be touched (revert `Status` to `Draft` first); and children must go strictly before parents.

### 13.2 Extracting org field reference (`npm run extract:contract`)

A read-only, standalone script — not part of any test run — that authenticates on its own and dumps every `Contract` and `SBQQ__Subscription__c` field (describe metadata plus live value) for a given Contract Number into `data/contract-<number>-extract.xlsx`:

```bash
npm run extract:contract -- 00000100
npm run extract:contract -- 00000100 --subscriptions-only
```

Useful before seeding a Contract/Subscription tree directly through the API, since a page layout shows neither which of a Contract's ~160 fields the API will actually accept nor which ones CPQ populates on its own.

---

## 14. Gotchas

- The Quote Line Editor, product selection, and the bundle configurator all render inside a **Visualforce iframe**, not native Lightning components — always go through `page.frameLocator(...)`, never `page` directly.
- After **Calculate**, wait for the "calculating"/busy indicator to clear — never a fixed `waitForTimeout`. Match on the indicator's **visibility**, not its presence: some busy flags stay present in the DOM at rest and only toggle visible/hidden.
- **A cleared spinner does not mean the data is ready.** Record-triggered Flows and queueable Apex run off the request thread and finish well after the DOM settles. Poll the API with `sf.pollForRecords(...)` / `sf.pollForFieldValue(...)` instead, and put the value you're waiting for in the query condition — a poll for "the row exists" is satisfied instantly by a pre-edit row.
- **Assert on records, not on rendered strings.** `expect(quote.SBQQ__NetTotal__c)`, not a formatted total read off the screen. A rendered total proves the DOM updated, nothing more. (The named exception: configurator constraint tests, where a rejected action writes no record at all — see `tests/config/solar-bundle-configuration.spec.js`.)
- CPQ fields carry the `SBQQ__` namespace — use exact API names. The Quote Line Editor's cells carry a `field` attribute, not `data-field`.
- `frontdoor.jsp` is what keeps tests off the interactive login page and out of MFA prompts (Section 3).
- Every test owns and tears down its own data — never rely on another test's records; serialize only tests that mutate shared org config (a Price Rule, an approval setting) with `test.describe.configure({ mode: 'serial' })` and tag them `@serial`.
- **Journeys must run with `--workers=1`.** Their stages hand state to each other through `artifacts/state/` and must run in order, in one worker. `npm run test:journey` pins this, and journeys also opt out of retries (`retries: 0`) — a retry restarts the whole journey at stage 1 rather than resuming, which would seed a duplicate record tree and burn the retry budget on data cleanup, not on genuine flakiness.
- **Accounts are looked up, never created or deleted** by this suite. They're on the sweeper's denylist.
- **A typo'd tag fails silently** — `--grep` matches nothing and the run passes green having tested nothing. Run `npm run lint:tags`.
- Chromium is the reference browser for the merge gate; use `BROWSER=firefox`/`BROWSER=webkit` for spot-checks, and fix any browser-specific selector issue in the page class, not the spec.
- **`test:parallel` (Section 4.1) is a lane-per-scenario runner, not `playwright test --workers=N`.** Playwright's serial mode only orders tests *within one file*, so with several spec files a free worker can start a journey's later stage before an earlier one has written the state file it reads. Each lane is its own process, and only the journeys lane runs multi-file with `--workers=1` internally.

---

## 15. Command cheat sheet

| Task | Command |
|---|---|
| Install deps | `npm ci` |
| Install browsers | `npx playwright install --with-deps` |
| Generate JWT key pair | `npm run generate:jwt-cert` |
| Run against Dev org | `npm run test:dev` |
| Run against Sandbox | `npm run test:sandbox` |
| Run against UAT | `npm run test:uat` |
| Full suite, lanes in parallel | `npm run test:parallel` |
| Fast configurator-only loop | `npm run test:parallel -- --lanes=smartwatch,solar` |
| Show lane mapping (no run) | `npm run test:parallel -- --print-lanes` |
| Merge-gate slice | `npm run test:pr` |
| Smoke only | `npm run test:smoke` |
| Regression only | `npm run test:regression` |
| Journeys (serial) | `npm run test:journey` |
| Serial tests only | `npm run test:serial` |
| One domain | `npx playwright test --grep "@domain:pricing"` |
| One file | `npx playwright test tests/pricing/no-rule-fires.spec.js` |
| By title | `npx playwright test -g "volume discount"` |
| Headed | `npm run test:headed` |
| Step-debug | `npm run test:debug` |
| Keep data for debugging | `npm run test:keep-data` |
| Firefox / WebKit | `npm run test:firefox` / `npm run test:webkit` |
| Validate tags | `npm run lint:tags` |
| Merge ledger shards | `npm run ledger:merge` |
| Sweep old E2E data (dry run) | `npm run cleanup:e2e` |
| Sweep old E2E data (execute) | `npm run cleanup:e2e -- --confirm` |
| Extract org Contract/Subscription fields | `npm run extract:contract -- <contract-number>` |
| Find real selectors | `npx playwright codegen <url>` |
| Open last report | `npm run report` |
| Open a trace | `npx playwright show-trace <path-to-trace.zip>` |
| Generate/open Allure | `npm run allure:generate` / `npm run allure:open` / `npm run allure:serve` |
