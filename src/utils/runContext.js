// src/utils/runContext.js
//
// Identity and continuity for a single suite execution:
//   - runId()      a stable token that marks every record the run creates
//   - stamp()      the Description string written onto stampable sObjects
//   - saveState()/loadState()   hand-off between stages of a journey
//   - resumeGuard()             re-enter a journey partway through
//
// Nothing here talks to Salesforce. It is required by CpqDataFactory, the
// ledger, the flows layer and the sweeper, so it must stay dependency-free
// apart from node builtins.
const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, '..', '..', 'artifacts', 'state');

// Salesforce Description on Order (and several other standard objects) is a
// 255-char *text area*, not a long text area, so the stamp is capped to the
// smallest common limit rather than per-object.
// [VERIFY] If you want the untruncated stamp on Opportunity (32,000 chars),
// raise this per-object via a map instead of a single constant.
const STAMP_MAX_LENGTH = 255;

const RUN_ID_PATTERN = /^E2E-\d{8}-\d{6}-[a-z0-9]{4}$/;

function two(n) {
  return String(n).padStart(2, '0');
}

// E2E-<yyyymmdd>-<hhmmss>-<4 random chars>
function generateRunId(now = new Date()) {
  const date = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`;
  const time = `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  const suffix = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `E2E-${date}-${time}-${suffix}`;
}

let _runId;

// Memoised for the life of the process. CPQ_RUN_ID takes priority when set,
// which is how a run keeps one identity across several processes: Playwright
// forks its workers from the runner, and forked children inherit process.env,
// so calling runId() in the runner pins the value for everyone downstream.
//
// global-setup.js is what does that calling, and it has to — nothing else runs
// in the runner process. If it ever stops, every worker mints its own id and a
// single invocation can end up writing ledger rows under two of them, because
// Playwright starts a replacement worker after a worker-level failure.
//
// CI should also set CPQ_RUN_ID explicitly so the value survives a job that
// shells out to the sweeper separately.
function runId() {
  if (_runId) return _runId;
  const fromEnv = process.env.CPQ_RUN_ID;
  _runId = fromEnv && RUN_ID_PATTERN.test(fromEnv) ? fromEnv : generateRunId();
  process.env.CPQ_RUN_ID = _runId;
  return _runId;
}

// Wall-clock start of the run, recovered from the runId so every worker
// reports the same runStartedAt in the ledger even though each worker
// process starts at a different moment.
function runStartedAt() {
  const match = /^E2E-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(runId());
  if (!match) return new Date().toISOString();
  const [, y, mo, d, h, mi, s] = match.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).toISOString();
}

function env() {
  return process.env.SF_ENV || 'developer';
}

// The marker written into Description fields. The sweeper's SOQL safety net
// matches on the leading literal, so changing this shape means changing
// MARKER_PREFIX in scripts/cleanup-e2e-data.js too.
function stamp(specFile, testTitle) {
  const parts = [
    'E2E',
    `run=${runId()}`,
    `env=${env()}`,
    `spec=${specFile || 'unknown'}`,
    `test=${testTitle || 'unknown'}`,
    `created=${new Date().toISOString()}`,
  ];
  const full = parts.join(' | ');
  return full.length > STAMP_MAX_LENGTH ? full.slice(0, STAMP_MAX_LENGTH) : full;
}

function statePath(key) {
  if (!/^[\w.-]+$/.test(String(key))) {
    throw new Error(`Invalid state key "${key}" — use word characters, dots and dashes only.`);
  }
  return path.join(STATE_DIR, `${key}.json`);
}

// Persists a stage's output so a later stage (or a resumed run) can pick it
// up. Journeys run serially in one worker, but the file makes the hand-off
// survive a crash, which is the case RESUME_FROM exists for.
function saveState(key, obj) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(statePath(key), JSON.stringify(obj, null, 2), 'utf-8');
  return statePath(key);
}

function loadState(key) {
  const file = statePath(key);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function clearState(key) {
  const file = statePath(key);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

// Returns true when this stage sits *before* RESUME_FROM in the ordered
// stage list, i.e. it has already run and should be skipped. Intended for
// `test.skip(resumeGuard('order', STAGES), 'resuming from a later stage')`.
// Unset RESUME_FROM (the normal case) always returns false.
function resumeGuard(stageName, orderedStages) {
  const resumeFrom = process.env.RESUME_FROM;
  if (!resumeFrom) return false;
  if (!Array.isArray(orderedStages) || !orderedStages.length) {
    throw new Error('resumeGuard() needs the ordered stage list to compare against.');
  }
  const target = orderedStages.indexOf(resumeFrom);
  if (target === -1) {
    throw new Error(
      `RESUME_FROM="${resumeFrom}" is not one of the declared stages: ${orderedStages.join(', ')}`
    );
  }
  const current = orderedStages.indexOf(stageName);
  if (current === -1) {
    throw new Error(
      `Stage "${stageName}" is not one of the declared stages: ${orderedStages.join(', ')}`
    );
  }
  return current < target;
}

module.exports = {
  runId,
  // Exported for scripts/run-parallel.js, which assigns one id per lane from
  // the PARENT process rather than letting each child mint its own. The format
  // has to stay in one place: runId() validates CPQ_RUN_ID against
  // RUN_ID_PATTERN and silently ignores anything that does not match, so a
  // caller hand-rolling the string would find its id quietly discarded.
  generateRunId,
  RUN_ID_PATTERN,
  runStartedAt,
  stamp,
  saveState,
  loadState,
  clearState,
  resumeGuard,
  env,
  STAMP_MAX_LENGTH,
  STATE_DIR,
};
