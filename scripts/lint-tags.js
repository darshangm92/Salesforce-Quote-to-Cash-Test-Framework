// scripts/lint-tags.js
//
// Enforces the tag taxonomy across tests/. THE ALLOWLIST BELOW IS THE
// AUTHORITY — EXACT_TAGS and PATTERN_TAGS are the taxonomy, not a copy of one
// kept somewhere else, so adding a tag means adding it here.
//
// A tag scheme is only worth having if `--grep` can be trusted, and a typo'd
// tag fails silently: `--grep @type:smok` matches nothing and the run goes
// green having tested nothing at all. This lint turns that into a build
// failure at the point the tag is written.
//
// Checks:
//   1. Every tag comes from the allowlist below.
//   2. Tags use Playwright's `tag` option, never a title suffix — title tags
//      leak into reported test names and Allure history.
//   3. Every test carries at least one @type: and one @domain:.
//   4. Journey tests (@type:journey, or any spec under tests/journeys/)
//      additionally carry a @stage:.
//
// Run: npm run lint:tags
const fs = require('fs');
const path = require('path');

const TESTS_DIR = path.join(__dirname, '..', 'tests');
const ROOT = path.join(__dirname, '..');

const EXACT_TAGS = new Set([
  '@type:smoke', '@type:regression', '@type:e2e', '@type:api', '@type:negative', '@type:journey',

  '@domain:quote', '@domain:config', '@domain:pricing', '@domain:approvals',
  '@domain:orders', '@domain:contracts', '@domain:amend', '@domain:renewal', '@domain:assets',

  '@stage:quote', '@stage:order', '@stage:contract', '@stage:asset',
  '@stage:renewal-forecast', '@stage:amendment', '@stage:renewal-quote',
  '@stage:renewal',

  '@journey:subscription', '@journey:asset', '@journey:bundle',

  '@risk:high', '@risk:medium', '@risk:low',

  '@speed:fast', '@speed:slow',

  '@serial', '@quota:heavy', '@flaky', '@wip', '@skip-de',
]);

// Parameterised tags: the prefix is fixed, the value is free within a shape.
const PATTERN_TAGS = [
  { label: '@persona:<name>', re: /^@persona:[a-z0-9][a-z0-9-]*$/ },
  { label: '@jira:<KEY-NNN>', re: /^@jira:[A-Z][A-Z0-9]+-\d+$/ },
];

// The 1.3 tag scheme, retired in 1.4. Named explicitly so the error tells you
// what to write instead rather than just that you're wrong.
const RETIRED_TAGS = {
  '@quote': '@domain:quote',
  '@pricing': '@domain:pricing',
  '@approval': '@domain:approvals',
  '@smoke': '@type:smoke',
  '@regression': '@type:regression',
  '@slow': '@speed:slow',
};

/**
 * Every *.spec.js under `dir`, recursively, as absolute paths.
 *
 * EXPORTED, and scripts/run-parallel.js derives its lanes from it rather than
 * walking tests/ a second time. Two walkers would be two definitions of "what
 * counts as a spec", and they would disagree the first time one of them grew a
 * rule the other did not — a spec this lint checked but no lane ran, or the
 * reverse. Non-spec siblings (tests/pricing/expectations.js,
 * tests/journeys/subscription-stages.js, the READMEs) are excluded here, once.
 */
function listSpecs(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSpecs(full));
    else if (/\.spec\.js$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Matches a test/describe declaration and, when present, its options object:
//   test('title', { tag: [...] }, async () => {})
//   test.describe.serial('title', { tag: [...] }, () => {})
// `test.skip(condition, reason)` has no leading string literal and is
// correctly ignored — that form is a runtime skip, not a declaration.
const DECL = /\btest(\.describe)?((?:\.(?:only|skip|fixme|serial|parallel))*)\s*\(\s*(['"`])((?:\\.|(?!\3)[\s\S])*?)\3\s*(?:,\s*(\{[^{}]*\}))?/g;

function extractTags(optionsText) {
  if (!optionsText) return [];
  const tagMatch = /\btag\s*:\s*(\[[^\]]*\]|(['"`])(?:\\.|(?!\2).)*\2)/.exec(optionsText);
  if (!tagMatch) return [];
  return tagMatch[1].match(/@[\w:.\-]+/g) || [];
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

function validateTag(tag) {
  if (EXACT_TAGS.has(tag)) return null;
  for (const pattern of PATTERN_TAGS) {
    if (pattern.re.test(tag)) return null;
  }
  if (RETIRED_TAGS[tag]) {
    return `"${tag}" was retired when the flat tags became namespaced — use "${RETIRED_TAGS[tag]}".`;
  }
  const prefix = tag.split(':')[0];
  const near = [...EXACT_TAGS].filter((t) => t.startsWith(`${prefix}:`));
  const hint = near.length ? ` Valid ${prefix}: tags are ${near.join(', ')}.` : '';
  return `"${tag}" is not in the taxonomy (see EXACT_TAGS in scripts/lint-tags.js).${hint}`;
}

function lintFile(file) {
  const source = fs.readFileSync(file, 'utf-8');
  const relative = path.relative(ROOT, file).replace(/\\/g, '/');
  const isJourneyPath = relative.startsWith('tests/journeys/');
  const errors = [];

  // Describe-level tags apply to every test they contain. Resolving the exact
  // nesting would need a real parser; treating them as file-wide is the safe
  // direction, since it can only make a test look better-tagged than it is
  // and never invents a failure.
  const fileTags = new Set();
  const declarations = [];

  let match;
  DECL.lastIndex = 0;
  while ((match = DECL.exec(source)) !== null) {
    const isDescribe = !!match[1];
    const title = match[4];
    const tags = extractTags(match[5]);
    const line = lineOf(source, match.index);

    if (/(^|\s)@[\w:.-]+/.test(title)) {
      errors.push(
        `${relative}:${line}  tag in the title ("${title}") — move it to the tag option: ` +
          "test('title', { tag: ['@type:...', '@domain:...'] }, fn)"
      );
    }

    for (const tag of tags) {
      const problem = validateTag(tag);
      if (problem) errors.push(`${relative}:${line}  ${problem}`);
    }

    if (isDescribe) tags.forEach((t) => fileTags.add(t));
    else declarations.push({ title, tags, line });
  }

  const tests = [];

  for (const declaration of declarations) {
    const effective = new Set([...declaration.tags, ...fileTags]);
    const has = (prefix) => [...effective].some((t) => t.startsWith(prefix));

    if (!has('@type:')) {
      errors.push(`${relative}:${declaration.line}  "${declaration.title}" has no @type: tag.`);
    }
    if (!has('@domain:')) {
      errors.push(`${relative}:${declaration.line}  "${declaration.title}" has no @domain: tag.`);
    }
    if ((effective.has('@type:journey') || isJourneyPath) && !has('@stage:')) {
      errors.push(
        `${relative}:${declaration.line}  "${declaration.title}" is a journey stage but has no @stage: tag.`
      );
    }

    tests.push({
      file: relative,
      line: declaration.line,
      title: declaration.title,
      tags: [...effective],
    });
  }

  return { errors, testCount: declarations.length, tests };
}

// ---------------------------------------------------------------------------
// Merge-gate slice coverage
//
// Checks 1-4 above prove every tag is SPELLED correctly. They prove nothing
// about whether the CI slices that select on those tags actually match
// anything, and that is the same silent-selector failure one level up — the
// tags are all valid, and the job still runs zero tests.
//
// MEASURED on 2026-08-03: three of the merge gate's five slices matched ZERO
// tests. `smoke` selects @type:smoke, which no test carried; `order-contract`
// and `amend-renewal-assets` select domains that exist only on journey stages,
// which every PR slice then grep-inverts back out. Playwright exits 1 on "No
// tests found", so those three jobs had been failing on every pull request.
//
// The check runs in BOTH directions, because each catches a different bug:
//
//   1. No slice may match zero tests. That is either a permanently red job
//      (Playwright's default) or, if anyone ever adds --pass-with-no-tests to
//      quiet it, a green job that tested nothing.
//   2. Every test the gate would run must be claimed by at least one slice.
//      Otherwise a test is committed, tagged correctly, linted clean, and
//      never actually run by CI — which fails green, the one failure mode this
//      repo treats as worse than a red build.
//
// The slice table is PARSED from the workflow rather than restated here. A
// second copy would be a second definition of what CI runs, and the first time
// the two disagreed the lint would be proving something about a table nobody
// executes — exactly the trap run-parallel.js's coverage guard fell into once,
// passing while the runner resolved something else entirely.
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'playwright.yml');

/**
 * The merge gate's slices, read out of playwright.yml.
 *
 * Deliberately THROWS rather than returning an empty list when it cannot find
 * the matrix or the grep-invert. A guard that quietly disables itself when the
 * file it reads is restructured is worse than no guard, because the run still
 * goes green and nobody learns the check stopped happening.
 */
function readWorkflowSlices() {
  if (!fs.existsSync(WORKFLOW)) {
    throw new Error(`Merge-gate workflow not found at ${path.relative(ROOT, WORKFLOW)}.`);
  }
  const source = fs.readFileSync(WORKFLOW, 'utf-8');

  const slices = [];
  const sliceRe = /^\s*-\s*slice:\s*(\S+)\s*\n\s*select:\s*'([^']*)'/gm;
  let match;
  while ((match = sliceRe.exec(source)) !== null) {
    const select = /--grep\s+"([^"]*)"/.exec(match[2]);
    if (!select) {
      throw new Error(
        `Slice "${match[1]}" in ${path.basename(WORKFLOW)} has a select: with no --grep "..." ` +
          `— this lint cannot tell what it runs. Got: ${match[2]}`
      );
    }
    slices.push({ name: match[1], grep: select[1] });
  }

  if (!slices.length) {
    throw new Error(
      `No "- slice: <name>" / "select: '...'" pairs found in ${path.basename(WORKFLOW)}. ` +
        'If the matrix was restructured, update readWorkflowSlices() to match — do not ' +
        'delete this check, it is the only thing proving the gate runs anything.'
    );
  }

  const invert = /--grep-invert\s+"([^"]*)"/.exec(source);
  if (!invert) {
    throw new Error(
      `No --grep-invert "..." found in ${path.basename(WORKFLOW)}. Every PR slice is supposed ` +
        'to carry one (journeys, quota-heavy and WIP are excluded from the gate).'
    );
  }

  return { slices, invert: invert[1] };
}

/**
 * What Playwright matches --grep against: the reported test title with its
 * tags appended. Reproduced here rather than shelling out to
 * `playwright test --list` once per slice, which would need a config load and
 * an authenticated session for a question that is answerable from the source.
 */
function grepTarget(test) {
  return `${test.file} ${test.title} ${test.tags.join(' ')}`;
}

function checkSliceCoverage(tests) {
  const { slices, invert } = readWorkflowSlices();
  const invertRe = new RegExp(invert);

  // What the gate would run at all: everything the shared grep-invert keeps.
  const gated = tests.filter((t) => !invertRe.test(grepTarget(t)));

  const errors = [];
  const claimed = new Set();
  const summary = [];

  for (const slice of slices) {
    const re = new RegExp(slice.grep);
    const matched = gated.filter((t) => re.test(grepTarget(t)));
    matched.forEach((t) => claimed.add(t));
    summary.push({ name: slice.name, grep: slice.grep, count: matched.length });

    if (!matched.length) {
      const everMatches = tests.some((t) => re.test(grepTarget(t)));
      errors.push(
        `merge-gate slice "${slice.name}" (--grep "${slice.grep}") matches 0 of ${gated.length} ` +
          'gated test(s), so the job fails with "No tests found" on every run. ' +
          (everMatches
            ? 'Those tests exist but are excluded by the shared --grep-invert ' +
              `("${invert}") — the slice belongs in nightly.yml, not the merge gate.`
            : 'No test anywhere carries a tag this selector matches — either tag some tests, ' +
              'or drop the slice from the matrix.')
      );
    }
  }

  for (const test of gated) {
    if (!claimed.has(test)) {
      errors.push(
        `${test.file}:${test.line}  "${test.title}" is not claimed by any merge-gate slice, ` +
          'so CI never runs it. Add a slice, or widen one, in .github/workflows/playwright.yml.'
      );
    }
  }

  return { errors, summary, gatedCount: gated.length };
}

function main() {
  const specs = listSpecs(TESTS_DIR);

  if (!specs.length) {
    console.log('lint:tags — no spec files found under tests/. Nothing to check.');
    return;
  }

  let errors = [];
  let tests = 0;
  let allTests = [];
  for (const spec of specs) {
    const result = lintFile(spec);
    errors = errors.concat(result.errors);
    tests += result.testCount;
    allTests = allTests.concat(result.tests);
  }

  // Only worth asking once the tags themselves are trustworthy: a mistyped tag
  // would otherwise be reported a second time as an unclaimed test, which
  // points at the workflow instead of at the typo that actually caused it.
  let coverage = null;
  if (!errors.length) {
    coverage = checkSliceCoverage(allTests);
    errors = errors.concat(coverage.errors);
  }

  if (errors.length) {
    console.error(`lint:tags — ${errors.length} problem(s) in ${specs.length} spec file(s):\n`);
    for (const error of errors) console.error(`  ${error}`);
    console.error('\nTaxonomy: EXACT_TAGS and PATTERN_TAGS in scripts/lint-tags.js.');
    process.exitCode = 1;
    return;
  }

  console.log(`lint:tags — ${tests} test(s) in ${specs.length} spec file(s), all tags valid.`);
  console.log(`lint:tags — merge gate runs ${coverage.gatedCount} test(s) across ` +
    `${coverage.summary.length} slice(s), each non-empty and every gated test claimed:`);
  for (const slice of coverage.summary) {
    console.log(`             ${String(slice.count).padStart(3)}  ${slice.name}`);
  }
}

if (require.main === module) main();

module.exports = {
  EXACT_TAGS,
  PATTERN_TAGS,
  RETIRED_TAGS,
  lintFile,
  listSpecs,
  TESTS_DIR,
  readWorkflowSlices,
  checkSliceCoverage,
};
