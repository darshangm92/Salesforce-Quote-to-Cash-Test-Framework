#!/usr/bin/env node
// scripts/run-parallel.js
//
// Runs the WHOLE suite CONCURRENTLY as one Playwright process per lane, and
// merges the ledger once at the end.
//
// WHAT A LANE IS, AND WHERE LANES COME FROM
// ------------------------------------------
// A lane is one Playwright process over one slice of tests/. Lanes are DERIVED
// from the directory tree rather than listed by hand: every immediate
// subdirectory of tests/ becomes a lane, and LANE_OVERRIDES below is the only
// exception. Each override states its own reason.
//
// Deriving rather than enumerating is what stops the list going stale. The
// previous version named three scenarios explicitly, covering 4 spec files;
// tests/pricing/ (7), tests/pricing-methods/ (5) and tests/quote/ (1) were
// added afterwards and never added here. So `npm run test:parallel` ran 4 of
// 17 spec files and reported a green run over the 4. A hand-maintained list of
// what to run is a list that eventually disagrees with what exists, and it
// fails GREEN — the same silent-success failure the lane selector and the tag
// lint already guard against.
//
// The coverage guard below is the other half of that: every spec listSpecs()
// finds must be claimed by exactly one lane, or the run aborts naming the file.
// A spec dropped into a new folder therefore either becomes its own lane or
// stops the run — it can never be silently skipped again.
//
// WHY ONE PROCESS PER LANE RATHER THAN ONE RUN WITH --workers=N
// --------------------------------------------------------------
// The obvious approach — a single `playwright test --workers=N` over every
// spec file — is WRONG, and silently so. The two subscription journey files
// are not independent: `subscription-renewal.spec.js` (stages 5-7) reads the
// state file `subscription-lifecycle.spec.js` (stages 1-4) writes, they share
// a STATE_KEY, and renewal's freshness guard rejects state from another run.
// Playwright's serial mode only orders tests WITHIN a file, and there is no
// way to pin two files to one worker in order — so a free worker would start
// renewal while lifecycle was still running, and stage 5 would fail on a
// state file that did not exist yet.
//
// One process per LANE makes the unit of parallelism the thing that is
// actually independent. The journeys lane runs the whole tests/journeys folder
// with --workers=1, which is what keeps stages 1-7 in order, exactly as
// `npm run test:journey` already does.
//
// THREE THINGS HAVE TO BE SERIALISED, ALL MEASURED AGAINST THIS REPO
// ------------------------------------------------------------------
// 1. AUTH. Every Playwright invocation runs globalSetup, which writes
//    .auth/sf-session.json and .auth/session.json. Three processes writing
//    those files while the others read them is a torn-JSON race that would
//    fail whole lanes for no real reason. So this script authenticates ONCE up
//    front and the children skip it via CPQ_REUSE_SESSION.
//
// 2. THE LEDGER MERGE. globalTeardown calls mergeLedger(), which reads EVERY
//    shard in artifacts/ledger/ — not just its own run's — and deletes the ones
//    it consumed. A lane finishing early would therefore swallow the rows of
//    the two lanes still running, and they would be merged into the workbook
//    under the wrong run before those lanes had finished writing. So children
//    skip the merge via CPQ_SKIP_LEDGER_MERGE and this script merges once,
//    after the last lane exits.
//
// 3. OUTPUT DIRECTORIES. The HTML reporter and the per-test artifact folder
//    are single paths in playwright.config.js, so three processes would write
//    the same tree. Each lane gets its own. allure-results is deliberately
//    NOT split: allure-playwright writes one uniquely-named file per test, so
//    concurrent writes to one directory are safe and keeping them together is
//    what lets a single `npm run allure:generate` cover the whole run.
//
// SELECTING LANES. `--lanes=smartwatch,solar` restricts the run; omitting it
// runs all of them. The journeys lane is the long pole and cannot be made
// faster — it is one record lineage, strictly sequential — so selection is the
// lever that gives a fast loop without touching a passing journey:
//
//   npm run test:parallel -- --lanes=smartwatch,solar   # ~10m, fast feedback
//   npm run test:parallel                               # everything
//   npm run test:parallel -- --print-lanes              # the mapping, no run
//   npm run test:parallel -- --max-concurrent=2         # gentler on the org
//
// CAPPING CONCURRENCY. Lanes run at most `--max-concurrent` at a time (default
// 3), longest estimate first, and the rest queue. The cap exists because the
// scarce resource is the ORG, not this machine: every lane is another browser
// driving another Quote Line Editor against one Developer org and one API
// limit. It is a real limit rather than a precaution — MEASURED 2026-08-01,
// two concurrent QLE cold loads timed out at 180s and passed on retry.
//
// --print-lanes prints the resolved table, each lane's files and the coverage
// result, then exits WITHOUT authenticating. It is how the mapping gets
// reviewed without paying for a run or touching the org.
//
// RUN IDS. Every lane gets its OWN run id, ASSIGNED HERE by the parent.
//
// Distinct rather than shared because ledger shards are named
// `<runId>-<workerIndex>.jsonl`: one id across three lanes would point them all
// at the same filename and have three processes appending to it concurrently.
// The ledger therefore shows this command as one run per lane — which is what
// it is.
//
// Assigned by the parent rather than minted by each child so that this script
// KNOWS WHICH SHARDS ARE ITS OWN. mergeLedger() otherwise consumes and deletes
// every shard in artifacts/ledger/ regardless of who wrote it, so a merge here
// would eat the in-progress rows of any other Playwright run happening at the
// same time — the same race note 2 closes for the children, still open at the
// parent until the ids were pinned. Scoping the merge also makes it a harmless
// no-op for invocations that ran no tests at all, such as `--list`, which
// previously still triggered a full unscoped merge.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Imported rather than reimplemented: runId() validates CPQ_RUN_ID against
// RUN_ID_PATTERN and silently ignores anything that does not match, so a
// hand-rolled id here would be discarded and each child would mint its own —
// leaving this script unable to tell which shards were its own.
const { generateRunId } = require(path.join(ROOT, 'src', 'utils', 'runContext'));

// The SAME spec enumerator scripts/lint-tags.js uses, imported rather than
// reimplemented. Two walkers would be two definitions of "what counts as a
// spec", and the first time they disagreed the result would be a spec the lint
// checked but no lane ran — silently.
const { listSpecs } = require(path.join(ROOT, 'scripts', 'lint-tags.js'));

const ORGS = ['developer', 'sandbox', 'uat'];
const SF_ENV = process.env.SF_ENV || 'developer';

if (!ORGS.includes(SF_ENV)) {
  console.error(`Unsupported SF_ENV "${SF_ENV}". Use ${ORGS.join(', ')}.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Lane derivation
// ---------------------------------------------------------------------------
//
// Lanes are selected by PATH, never by tag. No tag expression names the lanes
// this suite actually has — tests/config/ and tests/pricing/ are both
// @type:regression, and a --grep that happened to match a new spec later would
// silently change what runs concurrently. A path either is inside a lane or it
// is not, and the guard below proves which.

const TESTS_ROOT = 'tests';

/**
 * The only departures from "one lane per immediate subdirectory of tests/".
 * Keyed by directory name; each entry says why it is not the default.
 */
const LANE_OVERRIDES = {
  // SPLIT, because these are two independent scenarios that happen to share a
  // folder. Each is a single long configurator session against its own bundle,
  // seeding its own records, and neither reads anything the other writes — so
  // running them as one lane would serialise ~16 minutes of work that has no
  // reason to be sequential.
  config: [
    { name: 'smartwatch', paths: ['tests/config/smartwatch-attributes.spec.js'], estimateMin: 8 },
    { name: 'solar', paths: ['tests/config/solar-bundle-configuration.spec.js'], estimateMin: 8 },
  ],

  // NOT SPLIT, and pinned to one worker. The opposite case: these two files
  // are the SAME scenario. Stages 5-7 read the artifacts/state/ file stages
  // 1-4 write, they share a STATE_KEY, and the freshness guard rejects state
  // from another run. --workers=1 here is not a performance setting, it is
  // what keeps stages 1-7 in order — the same reason `npm run test:journey`
  // pins it.
  journeys: [
    { name: 'journeys', paths: ['tests/journeys'], workers: 1, estimateMin: 20 },
  ],
};

// Per-lane worker count when a lane does not name one.
//
// ONE, deliberately, and it is measured rather than cautious. MEASURED
// 2026-08-01: under --workers=2 two pricing tests failed their first attempt
// on a 180s Quote Line Editor readiness timeout and passed on retry: two
// concurrent QLE cold loads is already more than this org absorbs comfortably.
// Total concurrent browsers is governed by --max-concurrent instead, which is
// one number to reason about rather than a product of two.
const DEFAULT_LANE_WORKERS = 1;

// Rough minutes-per-spec, used ONLY to order the start queue for lanes that do
// not carry an explicit estimateMin. It is a scheduling heuristic and nothing
// else — never assert on it, and a wrong value costs some wall clock, never a
// wrong result.
const DEFAULT_MINUTES_PER_SPEC = 3;

/**
 * Every lane this repo has, derived from the tests/ tree.
 *
 * Directory order comes from readdirSync, which is alphabetical on every
 * platform this runs on — so the lane table is stable between invocations and
 * two runs are comparable.
 */
function deriveLanes() {
  const root = path.join(ROOT, TESTS_ROOT);
  if (!fs.existsSync(root)) fail(`No ${TESTS_ROOT}/ directory at ${root}.`);

  const lanes = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if (!entry.isDirectory()) continue;

    const override = LANE_OVERRIDES[entry.name];
    if (override) {
      for (const lane of override) lanes.push({ ...lane, from: `override:${entry.name}` });
      continue;
    }

    const dirPath = `${TESTS_ROOT}/${entry.name}`;
    const specCount = listSpecs(path.join(root, entry.name)).length;
    // A folder with no specs is not a lane. Playwright would exit non-zero on
    // "no tests found", failing the whole run over an empty directory.
    if (!specCount) continue;

    lanes.push({
      name: entry.name,
      paths: [dirPath],
      estimateMin: specCount * DEFAULT_MINUTES_PER_SPEC,
      from: 'derived',
    });
  }

  return lanes.map((lane) => ({
    workers: DEFAULT_LANE_WORKERS,
    estimateMin: DEFAULT_MINUTES_PER_SPEC,
    ...lane,
  }));
}

/** Every spec under tests/, repo-relative and forward-slashed. Resolved once. */
const ALL_SPECS = listSpecs(path.join(ROOT, TESTS_ROOT))
  .map((file) => path.relative(ROOT, file).replace(/\\/g, '/'))
  .sort();

// Each lane carries the EXPLICIT list of spec files it runs — see
// laneSpecFiles() for why a lane is never handed its directory.
const ALL_LANES = deriveLanes().map((lane) => ({
  ...lane,
  files: laneSpecFiles(lane, ALL_SPECS),
}));

/** Repo-relative, forward-slashed — the form every lane path is written in. */
function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

/**
 * A spec path, escaped so Playwright's positional-argument REGEX matches it
 * literally.
 *
 * Every one of these paths ends in `.spec.js`, and an unescaped `.` is a
 * regex wildcard. It happens to still match the literal dot, so nothing was
 * visibly broken — but `a.spec.js` would also match `axspec.js`, and relying on
 * that is relying on a filename that does not exist yet.
 */
function escapeForFilter(specPath) {
  return specPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Which lane claims a spec: the one whose path is the file itself or a
 * directory containing it. Returns every match, so a double-claim is visible
 * rather than resolved by first-wins.
 *
 * NOTE THE `${p}/` — IT IS LOAD-BEARING, AND ITS ABSENCE IS WHAT MADE THIS
 * FUNCTION DISAGREE WITH THE RUNNER ONCE ALREADY. A bare `startsWith(p)` would
 * let the lane path `tests/pricing` claim `tests/pricing-methods/...`, because
 * one is a string prefix of the other. See laneSpecFiles() for the other half
 * of that story.
 */
function lanesClaiming(specRelPath, lanes) {
  return lanes.filter((lane) =>
    lane.paths.some((p) => specRelPath === p || specRelPath.startsWith(`${p}/`))
  );
}

/**
 * The EXPLICIT spec files a lane runs, resolved through lanesClaiming().
 *
 * WHY LANES ARE HANDED FILES RATHER THAN THEIR DIRECTORY — THIS IS A FIXED BUG,
 * NOT A STYLE PREFERENCE. Playwright treats a positional argument as a REGULAR
 * EXPRESSION matched against the test file path, not as a directory. So passing
 * `tests/pricing` also matches `tests/pricing-methods/block-pricing.spec.js`,
 * because the lane path is a substring of it.
 *
 * MEASURED on 2026-08-03: the `pricing` lane ran 12 spec files instead of 7,
 * and all five of `tests/pricing-methods/` therefore ran TWICE — once in their
 * own lane and once inside `pricing`, concurrently, against one org. The run
 * still exited 0. Two tests went flaky on 180s Quote Line Editor readiness
 * timeouts, which is exactly what two lanes driving the same editor at
 * overlapping times would produce.
 *
 * The coverage guard did NOT catch it, and that is the part worth remembering:
 * the guard used correct path-prefix semantics and reported 17 specs each
 * claimed once, while the runner used Playwright's substring semantics and ran
 * 22. A guard that models something different from what actually executes
 * proves nothing about what actually executes.
 *
 * Resolving the files here, through the SAME function the guard uses, makes the
 * two agree by construction — there is now one definition of what a lane
 * contains, and it is the one that both gets checked and gets run.
 */
function laneSpecFiles(lane, specs) {
  return specs.filter((spec) => lanesClaiming(spec, [lane]).length > 0);
}

/**
 * Proves the lane table covers tests/ exactly: every spec claimed once, none
 * claimed twice.
 *
 * THIS IS THE POINT OF THE WHOLE DERIVATION. A spec no lane claims is a spec
 * `npm run test:parallel` does not run, and nothing else would ever say so —
 * the run would be green and shorter, which is indistinguishable from a good
 * day. A spec two lanes claim runs twice against one org, doubling its writes
 * and racing itself.
 *
 * Checked against the FULL lane table, never against a --lanes subset:
 * narrowing the run is deliberate, so it must not be reported as a coverage
 * hole.
 *
 * @returns {{specs: string[], unclaimed: string[], doubled: Array<{spec, lanes}>}}
 */
function checkCoverage(lanes) {
  const specs = listSpecs(path.join(ROOT, TESTS_ROOT)).map(relative).sort();
  const unclaimed = [];
  const doubled = [];

  for (const spec of specs) {
    const claiming = lanesClaiming(spec, lanes);
    if (!claiming.length) unclaimed.push(spec);
    else if (claiming.length > 1) doubled.push({ spec, lanes: claiming.map((l) => l.name) });
  }

  return { specs, unclaimed, doubled };
}

/** Aborts naming the files, because "which file" is the entire fix. */
function assertCoverage(lanes) {
  const { unclaimed, doubled } = checkCoverage(lanes);

  if (unclaimed.length) {
    fail(
      `${unclaimed.length} spec file(s) belong to no lane, so \`npm run test:parallel\` would ` +
        'not run them:\n' +
        unclaimed.map((s) => `  ${s}`).join('\n') +
        '\n\nEvery immediate subdirectory of tests/ becomes a lane automatically. A spec directly ' +
        `in ${TESTS_ROOT}/ has no directory to derive one from — move it into a folder, or add an ` +
        'entry to LANE_OVERRIDES in this file. Nothing was run: a suite runner that quietly skips ' +
        'files is worse than one that stops.'
    );
  }

  if (doubled.length) {
    fail(
      `${doubled.length} spec file(s) are claimed by more than one lane, so they would run twice ` +
        'against one org:\n' +
        doubled.map((d) => `  ${d.spec} -> ${d.lanes.join(', ')}`).join('\n') +
        '\n\nCheck LANE_OVERRIDES in this file for a path that overlaps a derived lane.'
    );
  }
}

/** How many lanes may run at once when --max-concurrent is not given. */
const DEFAULT_MAX_CONCURRENT = 3;

/**
 * Pulls this script's OWN options out of the argument list: `--lanes`,
 * `--max-concurrent` and `--print-lanes`.
 *
 * `--lanes` accepts `--lanes=a,b` and `--lanes a,b` (and `--lane`, since
 * selecting a single lane is the common case and the plural reads wrong there).
 *
 * EVERY ONE OF THEM MUST BE REMOVED FROM THE FORWARDED ARGUMENTS. Whatever this
 * script does not recognise is passed verbatim to each lane's `playwright
 * test`, and Playwright rejects an unknown option outright — so leaving any of
 * these in the passthrough would break every lane it had just configured.
 *
 * @returns {{selected: string|null, maxConcurrent: number, printLanes: boolean, rest: string[]}}
 */
function parseArgs(argv) {
  const rest = [];
  let selected = null;
  let maxConcurrent = DEFAULT_MAX_CONCURRENT;
  let printLanes = false;

  /** Shared by both spellings of a value-taking option. */
  const takeValue = (arg, next) => {
    // A MISSING OR OPTION-SHAPED VALUE IS AN EMPTY SELECTION, NOT AN ABSENT
    // ONE. Leaving it undefined would make it indistinguishable from "the flag
    // was never passed", and `npm run test:parallel -- --lanes` would quietly
    // run every lane instead of erroring — the same silent-green failure
    // resolveLanes() exists to prevent. Measured: it launched all three lanes
    // before this guard was added.
    if (next === undefined || next.startsWith('-')) return { value: '', consumed: 0 };
    return { value: next, consumed: 1 };
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--print-lanes') {
      printLanes = true;
      continue;
    }

    if (arg === '--lanes' || arg === '--lane') {
      const taken = takeValue(arg, argv[i + 1]);
      selected = taken.value;
      i += taken.consumed;
      continue;
    }

    const laneMatch = /^--lanes?=(.*)$/.exec(arg);
    if (laneMatch) {
      selected = laneMatch[1];
      continue;
    }

    if (arg === '--max-concurrent') {
      const taken = takeValue(arg, argv[i + 1]);
      maxConcurrent = parseConcurrency(taken.value);
      i += taken.consumed;
      continue;
    }

    const concurrencyMatch = /^--max-concurrent=(.*)$/.exec(arg);
    if (concurrencyMatch) {
      maxConcurrent = parseConcurrency(concurrencyMatch[1]);
      continue;
    }

    rest.push(arg);
  }

  return { selected, maxConcurrent, printLanes, rest };
}

/**
 * A positive integer, or a hard error.
 *
 * Rejected rather than clamped: `--max-concurrent=0` means "run nothing", and
 * silently treating it as 1 would run the whole suite when the caller asked for
 * the opposite. NaN is the more likely typo (`--max-concurrent all`) and has
 * the same problem in reverse.
 */
function parseConcurrency(raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    fail(
      `--max-concurrent needs a positive whole number, got "${raw}". ` +
        `Omit it for the default of ${DEFAULT_MAX_CONCURRENT}.`
    );
  }
  return value;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Resolves a `--lanes` value to lane definitions.
 *
 * AN UNKNOWN NAME IS A HARD ERROR, deliberately. A selector that matches
 * nothing and exits 0 is the same silent-green failure a mistyped tag
 * produces: the run reports success having tested nothing,
 * and nobody goes looking. So a typo names itself and the valid lanes.
 *
 * Filtering ALL_LANES (rather than mapping over the names given) keeps the
 * declaration order and drops duplicates, so `--lanes solar,smartwatch` and
 * `--lanes smartwatch,solar,solar` both run the same two lanes in the same
 * order — the output is then comparable between invocations.
 */
function resolveLanes(spec) {
  const names = String(spec == null ? '' : spec)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

  const valid = ALL_LANES.map((lane) => lane.name);

  if (!names.length) {
    fail(`--lanes needs at least one lane name. Valid lanes: ${valid.join(', ')}.`);
  }

  const unknown = names.filter((name) => !valid.includes(name));
  if (unknown.length) {
    fail(
      `Unknown lane(s): ${unknown.join(', ')}. Valid lanes: ${valid.join(', ')}.\n` +
        'Nothing was run — a lane selector that matches nothing must fail rather than pass green.'
    );
  }

  return ALL_LANES.filter((lane) => names.includes(lane.name));
}

// Parsed at module scope, BEFORE main() runs — main()'s first act is to
// authenticate against the org, and a typo should not cost a round trip to
// Salesforce to discover.
const {
  selected: LANE_SELECTION,
  maxConcurrent: MAX_CONCURRENT,
  printLanes: PRINT_LANES,
  rest: PASSTHROUGH,
} = parseArgs(process.argv.slice(2));

// Before anything else reads the lane table. A coverage hole is a property of
// the REPO, not of this invocation, so it fails every invocation until it is
// fixed — including a narrowed --lanes run, which would otherwise be the one
// place someone could keep working while a spec silently went unrun.
assertCoverage(ALL_LANES);

/** The lanes this invocation will run. Everything downstream reads only this. */
const LANES = LANE_SELECTION == null ? ALL_LANES : resolveLanes(LANE_SELECTION);

/**
 * Longest lane first.
 *
 * With more lanes than slots the finish time is decided by when the LONGEST
 * lane starts: leaving the 20-minute journeys lane until a slot frees up adds
 * its whole duration to the wall clock. Ordering is a scheduling hint only —
 * `estimateMin` is never asserted on, and a wrong estimate costs wall clock
 * rather than a wrong result.
 *
 * Ties keep the derivation order, so the table stays comparable between runs.
 */
const RUN_ORDER = [...LANES].sort((a, b) => b.estimateMin - a.estimateMin);

/**
 * One distinct run id per lane, assigned by this process. See "RUN IDS" above.
 *
 * Uniqueness is enforced rather than assumed: generateRunId() is
 * `E2E-<date>-<hhmmss>-<4 random>`, so three calls in the same second differ
 * only in the random suffix and a collision — however unlikely — would put two
 * lanes back on one shard filename, which is the exact thing distinct ids
 * exist to prevent.
 */
const LANE_RUN_IDS = (() => {
  const assigned = new Map();
  const used = new Set();
  for (const lane of LANES) {
    let id = generateRunId();
    while (used.has(id)) id = generateRunId();
    used.add(id);
    assigned.set(lane.name, id);
  }
  return assigned;
})();

function stamp() {
  return new Date().toISOString().slice(11, 19);
}

/** Where a lane's JSON reporter output goes. One file per lane — see runLane. */
function laneJsonReport(laneName) {
  return path.join('artifacts', `last-run-${laneName}.json`);
}

/**
 * Per-lane test counts, read back from that lane's JSON report.
 *
 * Best-effort by design: a lane that died before writing a report still has an
 * exit code, and the exit code is what decides pass or fail. This only enriches
 * the summary, so it must never throw — a missing or half-written report gets
 * reported as unknown rather than turning a finished run into a crash.
 */
function laneCounts(laneName) {
  try {
    const file = path.join(ROOT, laneJsonReport(laneName));
    if (!fs.existsSync(file)) return null;

    const report = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const counts = { passed: 0, failed: 0, flaky: 0, skipped: 0 };

    // The JSON reporter nests suites arbitrarily deep, so the specs are walked
    // rather than read off the top level.
    const walk = (suites) => {
      for (const suite of suites || []) {
        for (const spec of suite.specs || []) {
          for (const test of spec.tests || []) {
            const status = test.status; // expected | unexpected | flaky | skipped
            if (status === 'expected') counts.passed += 1;
            else if (status === 'unexpected') counts.failed += 1;
            else if (status === 'flaky') counts.flaky += 1;
            else if (status === 'skipped') counts.skipped += 1;
          }
        }
        walk(suite.suites);
      }
    };
    walk(report.suites);

    return counts;
  } catch (e) {
    console.warn(`Could not read the JSON report for lane "${laneName}": ${e.message}`);
    return null;
  }
}

/**
 * Runs `lanes` with at most `limit` in flight at once.
 *
 * A pull-based pool rather than chunked batches: with batches, a slot sits idle
 * until every lane in its batch has finished, so one slow lane stalls the whole
 * group. Here a finishing lane immediately takes the next one off the queue.
 *
 * Results are written back at the lane's own index, so the summary order is the
 * order lanes were STARTED regardless of the order they finish in.
 */
async function runWithConcurrency(lanes, limit) {
  const results = new Array(lanes.length);
  let next = 0;

  const slot = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= lanes.length) return;
      results[index] = await runLane(lanes[index]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, lanes.length) }, slot));
  return results;
}

/**
 * Prints the resolved lane table, each lane's files, and the coverage result,
 * then exits WITHOUT authenticating.
 *
 * This is how the mapping gets reviewed without paying for a run — and without
 * touching the org, which is why it returns before main() is ever called. It
 * prints the FULL table even under --lanes, with the selection marked, because
 * the question it answers ("does every spec have a home?") is about the repo
 * rather than about this invocation.
 */
function printLanes() {
  const { specs, unclaimed, doubled } = checkCoverage(ALL_LANES);
  const selectedNames = new Set(LANES.map((lane) => lane.name));

  console.log(`Lanes derived from ${TESTS_ROOT}/ (SF_ENV=${SF_ENV}):\n`);
  console.log(
    `  ${'run'.padEnd(4)}${'lane'.padEnd(17)}${'workers'.padEnd(9)}${'est'.padEnd(7)}${'source'.padEnd(20)}files`
  );
  console.log(`  ${'-'.repeat(70)}`);

  for (const lane of RUN_ORDER.concat(
    ALL_LANES.filter((lane) => !selectedNames.has(lane.name))
  )) {
    // lane.files is what the lane will actually be handed on the command line,
    // so printing anything else here would show a mapping that is not the one
    // that runs — which is how the substring bug survived a --print-lanes review.
    const files = lane.files;
    const mark = selectedNames.has(lane.name) ? ' *  ' : '    ';
    console.log(
      `  ${mark}${lane.name.padEnd(17)}${String(lane.workers).padEnd(9)}` +
        `${`${lane.estimateMin}m`.padEnd(7)}${lane.from.padEnd(20)}${files.length}`
    );
    for (const file of files) console.log(`  ${' '.repeat(4)}  ${file}`);
  }

  console.log(
    `\n  * = selected by this invocation (${LANES.length} of ${ALL_LANES.length} lane(s)), ` +
      `max ${MAX_CONCURRENT} at a time, longest first.`
  );

  console.log('\nCoverage check:');
  console.log(`  ${specs.length} spec file(s) under ${TESTS_ROOT}/`);
  console.log(`  ${unclaimed.length} unclaimed`);
  console.log(`  ${doubled.length} claimed by more than one lane`);
  console.log(
    unclaimed.length || doubled.length
      ? '  RESULT: FAIL'
      : '  RESULT: PASS — every spec belongs to exactly one lane.'
  );
}

function runLane(lane) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      SF_ENV,
      // This lane's own run id, assigned by the parent — NOT inherited from
      // it. Sharing the parent's id would put every lane on one shard
      // filename; letting each child mint its own would leave the parent
      // unable to scope its merge. See "RUN IDS" in the header.
      CPQ_RUN_ID: LANE_RUN_IDS.get(lane.name),
      CPQ_REUSE_SESSION: '1',
      CPQ_SKIP_LEDGER_MERGE: '1',
      // Both names are set because the HTML reporter's env override was
      // renamed across Playwright versions; the unused one is ignored.
      PLAYWRIGHT_HTML_OUTPUT_DIR: path.join('playwright-report', lane.name),
      PLAYWRIGHT_HTML_REPORT: path.join('playwright-report', lane.name),
      // Per lane, for the same reason as the two directories above: the JSON
      // reporter's path is a single value in playwright.config.js, so every
      // concurrent lane would otherwise write the same file and the last one to
      // finish would be the only one left.
      CPQ_JSON_REPORT: laneJsonReport(lane.name),
    };

    const args = [
      'playwright', 'test',
      // The lane's resolved spec FILES, not its directory. See laneSpecFiles().
      ...lane.files.map(escapeForFilter),
      `--project=${SF_ENV}`,
      `--workers=${lane.workers}`,
      `--output=${path.join('test-results', lane.name)}`,
      ...PASSTHROUGH,
    ];

    // The run id is logged with the lane so a ledger row can be traced back to
    // the lane that wrote it without cross-referencing the child's own output.
    console.log(
      `[${stamp()}] ${lane.name.padEnd(10)} start  run=${LANE_RUN_IDS.get(lane.name)}  npx ${args.join(' ')}`
    );

    const child = spawn('npx', args, {
      cwd: ROOT,
      env,
      shell: true, // npx on Windows is a .cmd; spawn needs a shell to resolve it.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const lines = [];
    const capture = (buffer) => {
      const text = buffer.toString();
      lines.push(text);
      // Prefixed so three interleaved lanes stay readable.
      for (const line of text.split('\n')) {
        if (line.trim()) console.log(`[${lane.name}] ${line}`);
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    const startedAt = Date.now();
    child.on('close', (code) => {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      console.log(`[${stamp()}] ${lane.name.padEnd(10)} exit ${code} after ${seconds}s`);
      resolve({ lane: lane.name, code: code === null ? 1 : code, seconds });
    });
  });
}

async function main() {
  // ---------------------------------------------------------------------
  // 0. Empty artifacts/evidence/ ONCE, here, before anything is spawned.
  //
  //    This process is definitionally the parent, so it is the only one
  //    entitled to clear. Every lane it launches carries CPQ_REUSE_SESSION=1,
  //    which is exactly what stops the child's own globalSetup from clearing —
  //    a lane that did would delete its siblings' screenshots mid-run.
  //
  //    Done explicitly rather than left to the globalSetup call below, which
  //    would also clear (the parent has no CPQ_REUSE_SESSION set) but only as
  //    a side effect of a call this script makes for authentication. Relying
  //    on that would break silently the moment someone exported
  //    CPQ_REUSE_SESSION in their own shell: setup would skip both the auth
  //    and the clear, and the run would mix two runs' evidence together. The
  //    second clear inside globalSetup then runs harmlessly on an empty tree.
  // ---------------------------------------------------------------------
  const { clearEvidence, EVIDENCE_ROOT } = require(
    path.join(ROOT, 'src', 'utils', 'evidence.js')
  );
  clearEvidence();
  console.log(`[${stamp()}] evidence cleared: ${EVIDENCE_ROOT}`);

  // ---------------------------------------------------------------------
  // 1. Authenticate ONCE, before any lane starts. See note 1 in the header.
  // ---------------------------------------------------------------------
  const laneNames = LANES.map((lane) => lane.name).join(', ');
  console.log(
    `[${stamp()}] authenticating once for ${LANES.length} lane(s) — ${laneNames} — (SF_ENV=${SF_ENV})`
  );
  // Required lazily and AFTER the SF_ENV check, so a bad env fails on the
  // message above rather than inside dotenv/config resolution.
  await require(path.join(ROOT, 'global-setup.js'))();

  for (const file of ['sf-session.json', 'session.json']) {
    const full = path.join(ROOT, '.auth', file);
    if (!fs.existsSync(full)) {
      console.error(`Global setup did not produce .auth/${file}; aborting before any lane runs.`);
      process.exit(1);
    }
  }

  // ---------------------------------------------------------------------
  // 2. The selected lanes, longest first, at most MAX_CONCURRENT at a time.
  //
  //    CAPPED rather than unbounded. Every lane is a browser plus a Playwright
  //    process plus a share of one org's API limit, and the org is the scarce
  //    resource: MEASURED 2026-08-01, two concurrent Quote Line Editor cold
  //    loads already timed out at 180s and passed on retry. Launching every
  //    lane at once would turn that into the normal case and spend the retry
  //    budget on self-inflicted contention — retries are for infrastructure
  //    flakiness, never for contention this runner created itself.
  // ---------------------------------------------------------------------
  const startedAt = Date.now();
  const results = await runWithConcurrency(RUN_ORDER, MAX_CONCURRENT);
  const wall = Math.round((Date.now() - startedAt) / 1000);

  // ---------------------------------------------------------------------
  // 3. Merge the ledger ONCE, now that every lane has exited and nothing is
  //    still appending. See note 2 in the header.
  //
  //    SCOPED TO THIS RUN'S OWN LANES. An unscoped merge consumes and deletes
  //    every shard in artifacts/ledger/, so it would swallow the in-progress
  //    rows of any other Playwright run happening at the same time, and it
  //    fired even for invocations that ran no tests (`--list`). Scoping makes
  //    the no-test case a natural no-op — those lanes wrote no shards — and
  //    leaves anything a crashed run left behind for `npm run ledger:merge`,
  //    which is the command whose job that actually is.
  // ---------------------------------------------------------------------
  try {
    const { mergeLedger } = require(path.join(ROOT, 'scripts', 'merge-ledger.js'));
    const result = mergeLedger({ runIds: [...LANE_RUN_IDS.values()] });
    if (result && result.shards) {
      console.log(
        `Ledger: merged ${result.merged} row(s) from ${result.shards} shard(s) into ${result.workbook}`
      );
    }
  } catch (e) {
    // A bookkeeping failure must never turn a green run red — the shards
    // survive on disk for `npm run ledger:merge`.
    console.warn(`Ledger merge failed (shards kept for \`npm run ledger:merge\`): ${e.message}`);
  }

  console.log('\n─────────────── parallel run summary ───────────────');
  for (const r of results) {
    // Counts come from the lane's own JSON report; the exit CODE is what
    // decides pass or fail, so a lane whose report is missing still reports
    // correctly and just says less.
    const counts = laneCounts(r.lane);
    const detail = counts
      ? `${counts.passed} passed, ${counts.failed} failed, ` +
        `${counts.flaky} flaky, ${counts.skipped} skipped`
      : '(no JSON report)';
    console.log(
      `  ${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.lane.padEnd(17)}${`${r.seconds}s`.padEnd(8)}${detail}`
    );
  }
  // The EFFECTIVE concurrency, not the cap. With fewer lanes than the cap the
  // two differ, and reporting the cap describes a schedule that did not happen
  // — "3 at a time" for a two-lane run is simply false.
  const effective = Math.min(MAX_CONCURRENT, LANES.length);
  console.log(
    `  wall clock: ${wall}s (${effective} lane(s) at a time, longest first` +
      `${effective < MAX_CONCURRENT ? `; cap is ${MAX_CONCURRENT}` : ''})`
  );
  console.log('  reports: playwright-report/<lane>, artifacts/last-run-<lane>.json,');
  console.log('           combined allure-results/');

  // Worst lane wins, so CI fails if any lane failed.
  process.exit(results.some((r) => r.code !== 0) ? 1 : 0);
}

// --print-lanes answers a question about the repo, not about the org, so it
// returns before main() — which authenticates as its first real act.
if (PRINT_LANES) {
  printLanes();
} else {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
