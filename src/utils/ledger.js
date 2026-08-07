// src/utils/ledger.js
//
// Phase one of the two-phase run ledger.
//
// Every record the suite creates is appended here as one JSON line. At the
// end of the run, scripts/merge-ledger.js folds all shards into
// data/e2e-run-ledger.xlsx and deletes them.
//
// Why two phases: several Playwright workers run concurrently, and .xlsx is a
// zip container that must be rewritten wholesale. Two workers rewriting it at
// once corrupts it. A single-line append to a per-worker file, opened with
// O_APPEND, is safe across processes on every platform we run on, so each
// worker owns its own shard and nothing is ever rewritten in place.
const fs = require('fs');
const path = require('path');
const { runId, runStartedAt, env } = require('./runContext');

const LEDGER_DIR = path.join(__dirname, '..', '..', 'artifacts', 'ledger');
const WORKBOOK_PATH = path.join(__dirname, '..', '..', 'data', 'e2e-run-ledger.xlsx');
const DATA_SHEET = 'Ledger';
const NOTES_SHEET = 'Notes';

// Column order is the contract between the writer here, merge-ledger.js and
// the sweeper. Adding a column means appending to this list, never inserting.
const LEDGER_COLUMNS = [
  'runId',
  'runStartedAt',
  'env',
  'specFile',
  'testTitle',
  'stage',
  'sobject',
  'recordId',
  'recordName',
  'parentId',
  'createdAt',
  'sweepEligible',
];

const COLUMN_NOTES = [
  ['Column', 'Meaning'],
  ['runId', 'Run token (E2E-<yyyymmdd>-<hhmmss>-<rand>) shared by every record one suite execution created.'],
  ['runStartedAt', 'ISO-8601 start of the run, derived from runId so all workers agree.'],
  ['env', 'SF_ENV the run targeted: developer, sandbox or uat.'],
  ['specFile', 'Spec that created the record, relative to the repo root.'],
  ['testTitle', 'Title of the test that created the record.'],
  ['stage', 'Journey stage (quote, order, contract, asset, renewal-forecast, amendment, renewal-quote) or blank for a single-stage test.'],
  ['sobject', 'Salesforce sObject API name, e.g. SBQQ__Quote__c.'],
  ['recordId', '15/18-char Salesforce Id.'],
  ['recordName', 'Name/label at creation time — for humans reading the sheet; not used for matching.'],
  ['parentId', 'Id of the record this one hangs off, used by the sweeper to traverse to objects with no Description field.'],
  ['createdAt', 'ISO-8601 creation time, the field the sweeper compares against RETENTION_DAYS.'],
  ['sweepEligible', 'TRUE only when the suite created the record. FALSE for anything resolved by lookup, so scripts/cleanup-e2e-data.js can never delete a record the suite did not make.'],
];

function shardDir() {
  return LEDGER_DIR;
}

function workbookPath() {
  return WORKBOOK_PATH;
}

// TEST_WORKER_INDEX is set by Playwright in every worker process. Anything
// else (the sweeper, a scratch script) writes to the "main" shard.
function workerIndex() {
  return process.env.TEST_WORKER_INDEX ?? 'main';
}

function shardPath() {
  return path.join(LEDGER_DIR, `${runId()}-${workerIndex()}.jsonl`);
}

/**
 * Appends one row to this worker's shard.
 *
 * @param {object} row
 * @param {string} row.sobject
 * @param {string} row.recordId
 * @param {string} [row.recordName]
 * @param {string} [row.parentId]
 * @param {string} [row.specFile]
 * @param {string} [row.testTitle]
 * @param {string} [row.stage]
 * @param {boolean} [row.sweepEligible=true]
 */
function append(row) {
  if (!row || !row.sobject || !row.recordId) {
    throw new Error('Ledger rows need at least { sobject, recordId }.');
  }

  const entry = {
    runId: runId(),
    runStartedAt: runStartedAt(),
    env: env(),
    specFile: row.specFile || '',
    testTitle: row.testTitle || '',
    stage: row.stage || '',
    sobject: row.sobject,
    recordId: row.recordId,
    recordName: row.recordName || '',
    parentId: row.parentId || '',
    createdAt: row.createdAt || new Date().toISOString(),
    sweepEligible: row.sweepEligible !== false,
  };

  try {
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    // One write of one complete line. Partial lines are what a JSONL reader
    // cannot recover from, so never split this into multiple appends.
    fs.appendFileSync(shardPath(), `${JSON.stringify(entry)}\n`, 'utf-8');
  } catch (e) {
    // The ledger is bookkeeping, not the test's subject. Losing a row is
    // worth a warning; it is never worth failing a passing test.
    console.warn(`Ledger append failed for ${entry.sobject} ${entry.recordId}: ${e.message}`);
  }

  return entry;
}

/**
 * Reads shards on disk. Returns { rows, files } — files are the shards consumed.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.runIds] restrict to shards belonging to these runs.
 *
 * WHY THE FILTER EXISTS. Without it this reads EVERY shard in the directory,
 * which is correct for `npm run ledger:merge` (its whole job is to sweep up
 * whatever is lying about, including rows a crashed run left behind) but wrong
 * for a merge that runs while another Playwright process is still testing —
 * it would consume that run's in-progress rows and delete its shards.
 * scripts/run-parallel.js passes the run ids it assigned to its own lanes so
 * it can never take a shard that is not its own. Omitting the option keeps the
 * original take-everything behaviour.
 *
 * Matching is on the `<runId>-` filename prefix (see shardPath). Run ids are
 * fixed-length, so no id can be a prefix of another.
 */
function readShards({ runIds } = {}) {
  if (!fs.existsSync(LEDGER_DIR)) return { rows: [], files: [] };

  const scoped = Array.isArray(runIds) && runIds.length
    ? (name) => runIds.some((id) => name.startsWith(`${id}-`))
    : () => true;

  const files = fs
    .readdirSync(LEDGER_DIR)
    .filter((f) => f.endsWith('.jsonl') && scoped(f))
    .map((f) => path.join(LEDGER_DIR, f));

  const rows = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        rows.push(JSON.parse(trimmed));
      } catch (e) {
        // A torn final line means the process died mid-write. Skip it loudly
        // rather than aborting the merge and losing every other row.
        console.warn(`Skipping malformed ledger line ${path.basename(file)}:${i + 1}: ${e.message}`);
      }
    });
  }

  return { rows, files };
}

module.exports = {
  append,
  readShards,
  shardDir,
  shardPath,
  workbookPath,
  LEDGER_COLUMNS,
  COLUMN_NOTES,
  DATA_SHEET,
  NOTES_SHEET,
};
