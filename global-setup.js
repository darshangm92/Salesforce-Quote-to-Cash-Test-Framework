// global-setup.js
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { authenticate } = require('./src/api/SalesforceAuth');
const { runId } = require('./src/utils/runContext');
const { clearEvidence, EVIDENCE_ROOT } = require('./src/utils/evidence');

// .auth/ is gitignored — these files are regenerated on every run and must
// never be committed, since sf-session.json holds a live access token.
const AUTH_DIR = path.join(__dirname, '.auth');
const STORAGE_STATE = path.join(AUTH_DIR, 'session.json');

// Playwright calls this once before any test runs (wired via
// playwright.config.js `globalSetup`). It authenticates once via the
// Salesforce REST API and produces two artifacts every test reuses:
// sf-session.json (read by SalesforceRestClient for API calls) and
// session.json (a Playwright storageState, loaded by `use.storageState`
// so every browser context starts already logged in).
module.exports = async () => {
  // Pin the run id HERE, in the runner process, before any worker is forked.
  //
  // runId() memoises into process.env.CPQ_RUN_ID, and Playwright forks its
  // workers from this process, so calling it here is what actually makes one
  // invocation share one run id. Without it every worker mints its own — and
  // that is not a theoretical concern: Playwright starts a REPLACEMENT worker
  // after a worker-level failure, so a single `npm run test:journey` could
  // write its records under two different run ids, splitting one run across
  // two sets of ledger rows and breaking any check that treats the run id as
  // the identity of an invocation.
  //
  // CPQ_RUN_ID set by the caller still wins (runId() prefers it), which is how
  // CI and the RESUME_FROM workflow pin a run id from outside.
  console.log(`Run id: ${runId()}`);

  // Empty the evidence tree so what is on disk afterwards is exactly this
  // run's output, with no leftovers from a previous one masquerading as
  // current results.
  //
  // GUARDED, AND THE GUARD IS THE WHOLE POINT. CPQ_REUSE_SESSION marks a
  // CHILD process that is sharing a parent's authenticated session. A child
  // that cleared this would delete its siblings' screenshots mid-run — so the
  // parent clears once, before it spawns anything, and no child ever does.
  // It runs before the reuse check below for the same reason: the only process
  // that reaches it is the parent, and it must clear before it spawns.
  if (!process.env.CPQ_REUSE_SESSION) {
    clearEvidence();
    console.log(`Evidence: ${EVIDENCE_ROOT} (cleared)`);
  }

  // CPQ_REUSE_SESSION — set ONLY by scripts/run-parallel.js, which runs this
  // file once itself and then launches several Playwright processes at the
  // same time.
  //
  // Without it each of those processes would re-authenticate and rewrite
  // .auth/sf-session.json and .auth/session.json while its siblings were
  // reading them. Those files are read by every SalesforceRestClient and by
  // `use.storageState`, so a torn write fails a whole lane for a reason that
  // has nothing to do with the test. Re-auth is skipped only when both files
  // are actually present; otherwise this falls through and authenticates
  // normally, so the flag can never leave a run without a session.
  if (process.env.CPQ_REUSE_SESSION === '1'
    && fs.existsSync(path.join(AUTH_DIR, 'sf-session.json'))
    && fs.existsSync(STORAGE_STATE)) {
    console.log('Reusing the session already written by scripts/run-parallel.js.');
    return;
  }

  const { accessToken, instanceUrl } = await authenticate();

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  // Raw token + instance URL, consumed by SalesforceRestClient.loadSession()
  // for direct REST calls (account/opportunity/quote setup and teardown).
  fs.writeFileSync(
    path.join(AUTH_DIR, 'sf-session.json'),
    JSON.stringify({ accessToken, instanceUrl }, null, 2)
  );

  // frontdoor.jsp exchanges the API session for a logged-in browser session,
  // so tests never touch the interactive login page (and never trip MFA).
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Explicit, because globalSetup does NOT inherit `use.navigationTimeout`
  // from playwright.config.js — it runs outside any project, so this was the
  // one navigation in the suite still on Playwright's 30s default. That is out
  // of step with every other wait here (the editor readiness budget is 180s,
  // the async polls 180-300s), and when it fired the whole run died before a
  // single test had started, with an error naming frontdoor.jsp rather than
  // the slow network underneath it.
  await page.goto(`${instanceUrl}/secur/frontdoor.jsp?sid=${accessToken}`, {
    timeout: 120_000,
  });
  // 'networkidle' never resolves in Lightning — it keeps background polling
  // alive indefinitely. Wait for DOM readiness and the Lightning spinner
  // instead, matching BasePage.waitForLightningReady().
  await page.waitForLoadState('domcontentloaded');
  const spinner = page.locator('lightning-spinner, .slds-spinner');
  if (await spinner.count()) {
    await spinner.first().waitFor({ state: 'hidden', timeout: 30000 }).catch(() => {});
  }
  await page.context().storageState({ path: STORAGE_STATE });
  await browser.close();
};
