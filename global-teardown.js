// global-teardown.js
const fs = require('fs');
const path = require('path');
const { mergeLedger } = require('./scripts/merge-ledger');

// Playwright calls this once after the whole suite finishes (wired via
// playwright.config.js `globalTeardown`) — the counterpart to global-setup.js.
module.exports = async () => {
  // Fold the per-worker ledger shards into data/e2e-run-ledger.xlsx. This is
  // the only place the workbook is written, and it runs after every worker
  // has exited, so there is exactly one writer (see src/utils/ledger.js).
  //
  // Teardown must never turn a green run red: a bookkeeping failure is worth
  // a warning, and the shards survive on disk for `npm run ledger:merge`.
  //
  // CPQ_SKIP_LEDGER_MERGE — set ONLY by scripts/run-parallel.js, which merges
  // once itself after every lane has exited. The merge is not safe to run
  // while a sibling PROCESS is still testing: mergeLedger() reads EVERY shard
  // in artifacts/ledger/, not just the ones belonging to this run, and deletes
  // the ones it consumes. So the first lane to finish would fold the other
  // lanes' in-progress rows into the workbook and delete their shards out from
  // under them. Deferring is what keeps the "exactly one writer" guarantee
  // true once there is more than one process.
  if (process.env.CPQ_SKIP_LEDGER_MERGE === '1') {
    console.log('Ledger merge deferred to scripts/run-parallel.js (shards left on disk).');
  } else {
    try {
      const result = mergeLedger();
      if (result.shards) {
        console.log(
          `Ledger: merged ${result.merged} row(s) from ${result.shards} shard(s) into ${result.workbook}`
        );
      }
    } catch (e) {
      console.warn(`Ledger merge failed (shards kept for \`npm run ledger:merge\`): ${e.message}`);
    }
  }

  // Session files are left in place locally so the next `npm run test:dev`
  // doesn't have to re-authenticate; on CI the runner is ephemeral anyway,
  // so we proactively wipe the token rather than leave it on disk.
  //
  // CPQ_REUSE_SESSION — the SAME hazard as the ledger merge above, and it bit
  // for real. That flag marks a CHILD launched by scripts/run-parallel.js, and
  // .auth/ is shared by every lane. On CI the first lane to finish was wiping
  // the session directory out from under the lanes still running, which they
  // then hit as
  //
  //   Error: Cannot find module '../../.auth/sf-session.json'
  //   Error: ENOENT: no such file or directory, open '.auth/session.json'
  //
  // — errors that name a missing file rather than the sibling process that
  // removed it, in lanes that had nothing wrong with them. Observed in the
  // nightly run of 2026-08-28 across the pricing-methods, solar and quote
  // lanes. A child cleans up nothing shared; the parent wipes once, after the
  // last lane has exited.
  if (process.env.CPQ_REUSE_SESSION === '1') return;

  const authDir = path.join(__dirname, '.auth');
  if (process.env.CI && fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
};
