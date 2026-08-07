// playwright.config.js
const { defineConfig, devices } = require('@playwright/test');

// Browser dimension. Chromium is the default for all suites and CI.
// Override per run with BROWSER=firefox or BROWSER=webkit (see Section 3.5).
const BROWSER = (process.env.BROWSER || 'chromium').toLowerCase();
const BROWSER_DEVICE = {
  chromium: devices['Desktop Chrome'],
  firefox: devices['Desktop Firefox'],
  webkit: devices['Desktop Safari'],
}[BROWSER];

if (!BROWSER_DEVICE) {
  throw new Error(`Unsupported BROWSER "${BROWSER}". Use chromium, firefox, or webkit.`);
}

// Org dimension. SF_ENV selects the org global-setup.js authenticates against,
// which makes it the only project that can meaningfully run: a --project=uat
// run whose session was minted against the Developer org is not testing UAT,
// it is testing developer under a misleading name.
//
// Emitting ONLY the matching project makes that pairing structural instead of
// a convention someone has to remember. It is also what stops every script
// that passes no --project — test:pr, test:smoke, test:regression, test:serial,
// test:journey — from silently running the whole suite three times, once per
// org project, against the single org that was actually authenticated.
//
// Consequence, and it is the intended one: `--project=sandbox` without
// SF_ENV=sandbox now fails with "Project(s) 'sandbox' not found" rather than
// running against the wrong org. The npm scripts in package.json pair the two,
// and CI sets SF_ENV before invoking them.
const ORGS = ['developer', 'sandbox', 'uat'];
const SF_ENV = process.env.SF_ENV || 'developer';

if (!ORGS.includes(SF_ENV)) {
  throw new Error(`Unsupported SF_ENV "${SF_ENV}". Use ${ORGS.join(', ')}.`);
}

module.exports = defineConfig({
  testDir: './tests',
  // CPQ calculate/save round-trips can be slow, so the per-test timeout is
  // generous; expect() polls faster since individual assertions shouldn't
  // need the full test budget.
  timeout: 120_000,
  expect: { timeout: 30_000 },

  fullyParallel: true,
  // Fewer workers on CI to avoid overwhelming the org with concurrent API/UI
  // sessions; more locally since a dev machine can take it.
  workers: process.env.CI ? 2 : 4,
  // Retries absorb Lightning/Visualforce timing flakiness only. Do not raise
  // this to hide a real product defect — investigate any test that only passes
  // on retry. Journeys opt out entirely with retries: 0 on their describe.
  retries: process.env.CI ? 2 : 1,
  // Fails the build if a `test.only` was accidentally left committed.
  forbidOnly: !!process.env.CI,

  // Runs once before/after the whole suite: authenticates via the Salesforce
  // API and saves a reusable browser session (see global-setup.js), so
  // individual tests never hit the interactive login page.
  globalSetup: require.resolve('./global-setup'),
  globalTeardown: require.resolve('./global-teardown'),

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['allure-playwright', { resultsDir: 'allure-results' }],
    // A machine-readable summary of the run, for scripts/run-parallel.js's
    // per-lane pass/fail/flaky counts and for anything else that needs to read
    // a result without parsing console output.
    //
    // THE PATH COMES FROM THE ENVIRONMENT, AND THAT IS NOT A STYLE CHOICE.
    // scripts/run-parallel.js runs several lanes as concurrent processes, and a
    // hardcoded path here would make every one of them write the same file —
    // as many writers as there are concurrent lanes, one target, and only the
    // last one to finish survives. The runner therefore sets
    // CPQ_JSON_REPORT=artifacts/last-run-<lane>.json per child, exactly as it
    // already gives each lane its own playwright-report/<lane> and
    // test-results/<lane>. A plain single-process run keeps the default.
    ['json', { outputFile: process.env.CPQ_JSON_REPORT || 'artifacts/last-run.json' }],
  ],

  use: {
    // Headless on CI for speed; headed locally so failures are easy to watch live.
    headless: !!process.env.CI,
    // Reuses the logged-in session global-setup.js wrote, so every test starts
    // already authenticated instead of going through the UI login screen.
    storageState: '.auth/session.json',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },

  // Exactly one project, named for the org SF_ENV selected — see the ORGS
  // block above for why the list is not all three. The browser comes from
  // BROWSER (default Chromium), so the project runs on the chosen browser.
  projects: [
    { name: SF_ENV, use: { ...BROWSER_DEVICE }, metadata: { env: SF_ENV, browser: BROWSER } },
  ],
});
