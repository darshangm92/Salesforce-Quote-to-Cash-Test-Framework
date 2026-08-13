// scripts/prepare-allure.js
//
// Prepares allure-results/ for `allure generate`. Runs as the first half of
// `npm run allure:ci`, immediately before the generator, and does exactly two
// things: it refuses to let an EMPTY result set become a published report, and
// it seeds the previous published report's trend files so the Trend widget
// carries forward instead of restarting at one point every night.
//
// WHY THE GUARD IS THE FIRST THING HERE
// --------------------------------------
// `allure generate` over an empty (or missing) allure-results/ does not fail.
// It writes a complete, valid-looking report containing zero tests, exits 0,
// and the publish job then deploys it over the top of yesterday's real one. So
// the failure surface is a green nightly and a live site that says nothing ran
// — the silent-success shape this repo treats as worse than a red build, and
// the same reasoning readWorkflowSlices() in scripts/lint-tags.js states for
// its own throw. A guard that quietly degrades when the thing it guards has
// gone missing is not a guard.
//
// The count is of `*-result.json` files specifically, not of directory entries.
// allure-results/ is dominated by attachments — this suite writes an evidence
// PNG per documented validation point (src/utils/evidence.js, Section 3.19) —
// so a run that produced nothing but attachments, or a partially-downloaded CI
// artifact, would still leave a non-empty directory. One `*-result.json` is
// written per test, so counting those is counting tests.
//
// WHY HISTORY IS SEEDED FROM A FIXED PATH
// -----------------------------------------
// Allure's trend is not computed from the results — it is read out of
// allure-results/history/ and carried into the new report. The publish job
// fetches those files from the CURRENTLY PUBLISHED site into .allure-history/,
// because that site is the only copy of them: allure-report/ is gitignored and
// CI starts from a clean checkout every night. Nothing about the trend survives
// unless it makes that round trip.
//
// A MISSING .allure-history/ IS NOT AN ERROR, and this is the one place the
// script deliberately does not fail. The first publish has no site to read
// from, and an access-controlled Pages site answers the fetch with a 403, so
// both legitimate cases arrive here looking identical to a lost directory. It
// logs which happened and continues; the trend restarts, which is a cosmetic
// loss, and failing the publish over it would throw away a perfectly good
// report to protect a chart.
//
// This takes NO ARGUMENTS, on purpose. `npm run allure:ci -- --something`
// appends to the LAST command in a chained npm script, not the first, so an
// argument meant for this script would silently land on `allure generate`
// instead. A fixed path cannot be passed to the wrong half.
//
// Run: npm run allure:ci   (this script, then `allure generate`)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESULTS_DIR = path.join(ROOT, 'allure-results');
const HISTORY_SOURCE = path.join(ROOT, '.allure-history');
const HISTORY_DEST = path.join(RESULTS_DIR, 'history');

// The history files allure-commandline 2.43.0 writes into allure-report/history/,
// READ FROM THE ALLURE 2.43.0 SOURCE ON 2026-08-13 rather than assumed:
// HistoryPlugin.HISTORY_FILE_NAME, HistoryTrendPlugin.JSON_FILE_NAME, and
// JSON_FILE_NAME on each of DurationTrendPlugin, CategoriesTrendPlugin and
// RetryTrendPlugin.
//
// history-trend.json is the one that is easy to leave out and the one that
// matters most: it backs the Trend widget on the Overview page. history.json is
// the per-test retry/flakiness record and keeps 5 prior results per test; the
// four *-trend.json files keep 20 runs each, which is Allure's built-in default
// and is not configured anywhere here.
const HISTORY_FILES = [
  'history.json',
  'history-trend.json',
  'duration-trend.json',
  'categories-trend.json',
  'retry-trend.json',
];

/**
 * Number of `*-result.json` files in allure-results/ — one per test.
 * Returns 0 for a missing directory rather than throwing, so the caller owns
 * the whole "nothing to publish" message and states it one way.
 */
function countResults(dir = RESULTS_DIR) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((name) => name.endsWith('-result.json')).length;
}

/**
 * THROWS when there is nothing to publish. See the header: an empty result set
 * generates a valid report with zero tests in it, which would deploy green over
 * a good one and prove nothing.
 */
function assertResultsPresent(dir = RESULTS_DIR) {
  const count = countResults(dir);
  if (count === 0) {
    throw new Error(
      `No *-result.json files in ${dir}. Refusing to generate a report from an empty ` +
        'result set — `allure generate` would happily produce a valid report with zero ' +
        'tests in it, exit 0, and publish over the last good one. Run the suite first ' +
        '(npm run test:parallel), or in CI check that the allure-results-suite artifact ' +
        'downloaded into the workspace root.'
    );
  }
  return count;
}

/**
 * Copies whatever previous-run history exists into allure-results/history/.
 * Returns the file names copied — an empty array is a legitimate first publish.
 */
function seedHistory(source = HISTORY_SOURCE, dest = HISTORY_DEST) {
  if (!fs.existsSync(source)) return [];

  const available = HISTORY_FILES.filter((name) => fs.existsSync(path.join(source, name)));
  if (!available.length) return [];

  fs.mkdirSync(dest, { recursive: true });
  for (const name of available) {
    fs.copyFileSync(path.join(source, name), path.join(dest, name));
  }
  return available;
}

function main() {
  const results = assertResultsPresent();
  const copied = seedHistory();

  console.log(`prepare-allure — ${results} test result(s) in ${path.relative(ROOT, RESULTS_DIR)}.`);

  if (copied.length) {
    console.log(
      `prepare-allure — carried ${copied.length} history file(s) forward from ` +
        `${path.relative(ROOT, HISTORY_SOURCE)}: ${copied.join(', ')}.`
    );
  } else {
    // Expected on the first publish, and whenever the site is access-controlled
    // and answered the fetch with a 403. Says so plainly: this job runs
    // unattended at night and its log is the only record anyone will read.
    console.log(
      `prepare-allure — no previous history found in ${path.relative(ROOT, HISTORY_SOURCE)}; ` +
        'this run starts a new trend. Expected on a first publish.'
    );
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`prepare-allure — ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  countResults,
  assertResultsPresent,
  seedHistory,
  HISTORY_FILES,
  RESULTS_DIR,
  HISTORY_SOURCE,
  HISTORY_DEST,
};
