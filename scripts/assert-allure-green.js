// scripts/assert-allure-green.js
//
// Decides whether a run's allure-results/ is ALL GREEN, for the showcase
// publish in .github/workflows/allure-showcase.yml. That workflow republishes
// the report of the most recent scheduled nightly whose results are clean, to
// a separate public site, and this script is the only thing that decides
// "clean". It reads, counts and reports. It never edits, filters or deletes a
// result file: a gate that could make a run green is not a gate.
//
// WHAT "ALL GREEN" MEANS HERE
// ----------------------------
// Across every `*-result.json` in allure-results/: zero failed, zero broken,
// zero of any status this script does not recognise, and at least one passed.
// Skipped is allowed and is reported in the summary line, because a skip is a
// deliberate runner decision (a fixme, a resume guard) rather than an outcome.
//
// WHY RESULT FILES ARE COUNTED RATHER THAN UNIQUE TESTS
// -------------------------------------------------------
// allure-playwright writes one result file per ATTEMPT, not per test. A test
// that failed and then passed on retry leaves its failed attempt behind as a
// file of its own, beside the passing one. Collapsing files to unique tests
// (by historyId, say) and keeping the last attempt is the obvious approach and
// was rejected: it would show a flaky run as clean, and the showcase exists to
// show a run that was clean on the first attempt. Counting files is what keeps
// a retried pass out of it. The cost is that the counts are attempts, not
// tests, which is why the summary line says "result file(s)".
//
// WHY AN UNRECOGNISED STATUS IS NOT GREEN
// -----------------------------------------
// Allure defines passed, failed, broken and skipped, plus `unknown` for a
// result whose outcome was never recorded (a worker killed mid-test, a
// reporter that did not finish). A status this script does not know is a
// result it cannot vouch for. Letting it through would make the gate fail
// OPEN on exactly the runs that went most wrong, so it goes into `other` and
// fails the gate.
//
// WHY "NOT GREEN" EXITS 0
// -------------------------
// A red nightly is a normal night, not a broken publish. The workflow reads
// `green` from $GITHUB_OUTPUT and skips the publish with a notice. If this
// exited non-zero on a red run, every red nightly would also turn the showcase
// workflow red, and a red showcase run would stop meaning "the publish itself
// broke". Exit 1 is reserved for input this script cannot judge: a missing
// directory, no result files at all, or a result file that does not parse.
// Each of those means the artifact is wrong, not that the tests were.
//
// Run: node scripts/assert-allure-green.js   (no arguments, reads allure-results/)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESULTS_DIR = path.join(ROOT, 'allure-results');

const KNOWN = ['passed', 'failed', 'broken', 'skipped'];

/**
 * Reads every `*-result.json` in `dir` and returns their `status` values.
 * THROWS on a missing directory, an empty result set, or a file that does not
 * parse. See the header for why those are errors and a red run is not.
 */
function readStatuses(dir = RESULTS_DIR) {
  if (!fs.existsSync(dir)) {
    throw new Error(`${dir} does not exist. Nothing to judge; check that the results artifact downloaded.`);
  }
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('-result.json'));
  if (!files.length) {
    throw new Error(
      `No *-result.json files in ${dir}. An empty result set is not a green run; ` +
        'check that the allure-results-suite artifact downloaded into the workspace root.'
    );
  }
  return files.map((name) => {
    const file = path.join(dir, name);
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')).status;
    } catch (error) {
      throw new Error(`${name} does not parse as JSON (${error.message}). Refusing to judge a partial result set.`);
    }
  });
}

/** Tallies statuses into passed/failed/broken/skipped/other and a total. */
function tally(statuses) {
  const counts = { passed: 0, failed: 0, broken: 0, skipped: 0, other: 0, total: statuses.length };
  for (const status of statuses) {
    if (KNOWN.includes(status)) counts[status] += 1;
    else counts.other += 1;
  }
  return counts;
}

/** Green: no failed, no broken, no unrecognised status, at least one passed. */
function isGreen(counts) {
  return counts.failed === 0 && counts.broken === 0 && counts.other === 0 && counts.passed > 0;
}

function summaryLine(counts, green) {
  return (
    `assert-allure-green: ${counts.total} result file(s): passed=${counts.passed} failed=${counts.failed} ` +
    `broken=${counts.broken} skipped=${counts.skipped} other=${counts.other} -> ${green ? 'GREEN' : 'NOT GREEN'}`
  );
}

function writeOutputs(counts, green, outputFile = process.env.GITHUB_OUTPUT) {
  if (!outputFile) return;
  const lines = [
    `green=${green}`,
    `passed=${counts.passed}`,
    `failed=${counts.failed}`,
    `broken=${counts.broken}`,
    `skipped=${counts.skipped}`,
    `total=${counts.total}`,
  ];
  fs.appendFileSync(outputFile, `${lines.join('\n')}\n`);
}

function main() {
  const counts = tally(readStatuses());
  const green = isGreen(counts);
  console.log(summaryLine(counts, green));
  writeOutputs(counts, green);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`assert-allure-green: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { readStatuses, tally, isGreen, summaryLine, writeOutputs, RESULTS_DIR };
