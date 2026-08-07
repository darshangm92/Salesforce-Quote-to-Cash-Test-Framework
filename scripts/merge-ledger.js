// scripts/merge-ledger.js
//
// Phase two of the two-phase run ledger (see src/utils/ledger.js for phase
// one and the reasoning). Folds every per-worker JSONL shard into
// data/e2e-run-ledger.xlsx, then deletes the shards it consumed.
//
// Runs single-threaded, after the workers have exited — called from
// global-teardown.js and exposed as `npm run ledger:merge`. Nothing else may
// write the workbook.
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const {
  readShards,
  workbookPath,
  LEDGER_COLUMNS,
  COLUMN_NOTES,
  DATA_SHEET,
  NOTES_SHEET,
} = require('../src/utils/ledger');

// Normalises a row to the column contract: fixed key order, no stray keys,
// booleans rendered as TRUE/FALSE so the sheet reads the same whether it was
// written by us or edited by hand in Excel.
function toSheetRow(row) {
  const out = {};
  for (const column of LEDGER_COLUMNS) {
    const value = row[column];
    if (column === 'sweepEligible') {
      out[column] = isTruthy(value) ? 'TRUE' : 'FALSE';
    } else {
      out[column] = value === undefined || value === null ? '' : String(value);
    }
  }
  return out;
}

function isTruthy(value) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return false;
  return !/^(false|0|no)$/i.test(String(value).trim());
}

function readExistingRows(file) {
  if (!fs.existsSync(file)) return [];
  try {
    const workbook = XLSX.readFile(file);
    const sheet = workbook.Sheets[DATA_SHEET] || workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) return [];
    return XLSX.utils.sheet_to_json(sheet, { defval: '' });
  } catch (e) {
    // A corrupt workbook must not cost us this run's shards. Move it aside
    // and start a fresh one rather than throwing away data we can still read.
    const salvaged = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, salvaged);
    console.warn(`Existing ledger workbook was unreadable (${e.message}); moved to ${salvaged}.`);
    return [];
  }
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.keepShards=false] leave shards on disk (for debugging)
 * @param {string[]} [opts.runIds] merge ONLY the shards belonging to these
 *        runs. Omit to merge everything on disk, which is what
 *        `npm run ledger:merge` and globalTeardown want — sweeping up rows a
 *        crashed run left behind is the point of them. scripts/run-parallel.js
 *        passes its own lanes' ids, because it may run alongside another
 *        Playwright process whose shards it must not consume.
 * @returns {{ merged: number, added: number, total: number, shards: number, workbook: string }}
 */
function mergeLedger(opts = {}) {
  const { keepShards = false, runIds } = opts;
  const file = workbookPath();
  const { rows, files } = readShards({ runIds });

  if (!rows.length && !files.length) {
    return { merged: 0, added: 0, total: readExistingRows(file).length, shards: 0, workbook: file };
  }

  const existing = readExistingRows(file).map(toSheetRow);
  // One record can legitimately be appended twice (a retry re-creates it and
  // gets a new Id; a re-merge replays a shard). Key on run + object + Id so a
  // replay is idempotent but a genuine second record still gets its own row.
  const seen = new Set(existing.map((r) => `${r.runId}|${r.sobject}|${r.recordId}`));

  const added = [];
  for (const row of rows.map(toSheetRow)) {
    const key = `${row.runId}|${row.sobject}|${row.recordId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(row);
  }

  const all = existing.concat(added);

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(all, { header: LEDGER_COLUMNS }),
    DATA_SHEET
  );
  // Second sheet documents the columns for anyone opening the file in Excel —
  // spreadsheets have nowhere else to put a comment. loadExcel() reads the
  // first sheet, so a trailing Notes sheet is invisible to any reader.
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet(COLUMN_NOTES),
    NOTES_SHEET
  );

  fs.mkdirSync(path.dirname(file), { recursive: true });
  XLSX.writeFile(workbook, file);

  if (!keepShards) {
    for (const shard of files) {
      try {
        fs.unlinkSync(shard);
      } catch (e) {
        console.warn(`Could not remove consumed shard ${shard}: ${e.message}`);
      }
    }
  }

  return {
    merged: rows.length,
    added: added.length,
    total: all.length,
    shards: files.length,
    workbook: file,
  };
}

if (require.main === module) {
  const keepShards = process.argv.includes('--keep-shards');
  const result = mergeLedger({ keepShards });
  console.log(
    `Ledger: read ${result.merged} row(s) from ${result.shards} shard(s), ` +
      `added ${result.added} new, ${result.total} total in ${result.workbook}`
  );
}

module.exports = { mergeLedger };
