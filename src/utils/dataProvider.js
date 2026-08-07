// src/utils/dataProvider.js
//
// Single entry point specs use to load scenario data — every path resolves
// relative to data/, so specs just pass a filename instead of building paths
// themselves. Pricing and quoting are inherently data-driven, so scenarios
// live in files rather than in the specs that run them.
const fs = require('fs');
const path = require('path');
const { readSheet } = require('./excelReader');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// Reads a JSON file from data/ and parses it (e.g. pricing-rules.json,
// home-security.json). Both files this line used to name were deleted long
// before it was corrected — cpq-quotes.json in 1.4, accounts.json in 1.15.
function loadJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, fileName), 'utf-8'));
}

// Reads a worksheet from an Excel file in data/ (e.g. cpq-pricing.xlsx) via
// excelReader; `sheet` is optional and defaults to the first sheet.
function loadExcel(fileName, sheet) {
  return readSheet(path.join(DATA_DIR, fileName), sheet);
}

module.exports = { loadJson, loadExcel };
