// src/flows/index.js
//
// The flows layer. A flow is a business transition — several page objects,
// plus polling for the org's async work, plus an API assertion that the
// transition actually landed in the data model.
//
// Layering rule, one direction only:
//
//   tests/  ->  src/flows/  ->  src/pages/  +  src/api/  +  src/utils/
//
// Nothing in src/pages/ may require anything from src/flows/. A page class
// knows how to click things on one screen and nothing about why.
//
// Flows arrive with the scenarios that need them; this file is not a
// placeholder registry to pre-populate.
const { createQuoteWithGroups } = require('./createQuoteWithGroups');
const { createSimpleQuote } = require('./createSimpleQuote');
const { amendContract } = require('./amendContract');
const { orderAndContract } = require('./orderAndContract');
const { openFlatQuoteEditor } = require('./openFlatQuoteEditor');
const {
  quoteSimpleProducts,
  quoteLineSoql,
  byProductCode,
  requireLine,
} = require('./quoteSimpleProducts');

module.exports = {
  createQuoteWithGroups,
  createSimpleQuote,
  amendContract,
  orderAndContract,
  openFlatQuoteEditor,
  quoteSimpleProducts,
  quoteLineSoql,
  byProductCode,
  requireLine,
};
