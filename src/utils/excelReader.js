// src/utils/excelReader.js
//
// Thin wrapper around the `xlsx` library — converts one worksheet into an
// array of plain objects (one per row, keyed by header), the same shape
// loadJson() returns for JSON data files, so callers can treat the two data
// sources interchangeably.
const XLSX = require('xlsx');

// Defaults to the first sheet in the workbook when sheetName is omitted —
// data/cpq-pricing.xlsx only has one data sheet ("PricingScenarios") plus a
// human-readable "Notes" sheet, so callers don't normally need to pass one.
function readSheet(filePath, sheetName) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[sheetName || workbook.SheetNames[0]];
  // defval: '' fills blank cells with an empty string instead of omitting
  // the key entirely, so every row object has a consistent shape.
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

module.exports = { readSheet };
