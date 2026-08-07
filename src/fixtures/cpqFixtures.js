// src/fixtures/cpqFixtures.js
const base = require('@playwright/test');
const path = require('path');
const { CpqDataFactory } = require('../api/CpqDataFactory');
const { SalesforceRestClient } = require('../api/SalesforceRestClient');
const { pollForRecords, pollForRecord, pollForFieldValue } = require('../utils/waitForAsync');
const { QuoteLineEditorPage } = require('../pages/QuoteLineEditorPage');
const { ProductSelectionPage } = require('../pages/ProductSelectionPage');
const { ProductConfigurationPage } = require('../pages/ProductConfigurationPage');
const { QuotePage } = require('../pages/QuotePage');
const { OpportunityPage } = require('../pages/OpportunityPage');
const { OrderPage } = require('../pages/OrderPage');
const { ContractPage } = require('../pages/ContractPage');
const { ContractAmendmentPage } = require('../pages/ContractAmendmentPage');
const { AccountPage } = require('../pages/AccountPage');

// Extending the base test with one fixture per page class keeps specs free
// of `new SomePage(page)` boilerplate and guarantees every spec gets the
// same wiring. Page interactions live in page classes, never in specs.
const test = base.test.extend({
  // Read-only API access, for assertions.
  //
  // Worker-scoped on purpose: a serial journey walks several stages through
  // one worker, and rebuilding the HTTP request context per stage burns API
  // calls and adds latency to no benefit.
  //
  // Read-only by contract — no create, no update, no delete. Writes go
  // through `cpqData` so they land in the ledger and get torn down. If you
  // find yourself wanting sf.create(), you want cpqData.
  sf: [
    async ({}, use) => {
      const client = new SalesforceRestClient();
      await use({
        query: (soql) => client.query(soql),

        // Single record by Id. `fields` defaults to Id alone, because a
        // caller that doesn't name its fields almost always meant to.
        record: async (sobject, id, fields = ['Id']) => {
          const list = Array.isArray(fields) ? fields.join(', ') : String(fields);
          const records = await client.query(
            `SELECT ${list} FROM ${sobject} WHERE Id = '${id}'`
          );
          return (records && records[0]) || undefined;
        },

        pollForRecords: (soql, opts) => pollForRecords(client, soql, opts),
        pollForRecord: (soql, opts) => pollForRecord(client, soql, opts),
        pollForFieldValue: (sobject, id, field, expected, opts) =>
          pollForFieldValue(client, sobject, id, field, expected, opts),
      });
      await client.dispose();
    },
    { scope: 'worker' },
  ],

  // Seeds and tears down CPQ data per test. testInfo supplies the spec path
  // and test title that get stamped onto records and written to the ledger.
  cpqData: async ({}, use, testInfo) => {
    const factory = new CpqDataFactory({
      specFile: path.relative(process.cwd(), testInfo.file).replace(/\\/g, '/'),
      testTitle: testInfo.title,
    });
    await use(factory);
    await factory.cleanup();
  },
  quoteLineEditor: async ({ page }, use) => {
    await use(new QuoteLineEditorPage(page));
  },
  productSelection: async ({ page }, use) => {
    await use(new ProductSelectionPage(page));
  },
  productConfiguration: async ({ page }, use) => {
    await use(new ProductConfigurationPage(page));
  },
  quotePage: async ({ page }, use) => {
    await use(new QuotePage(page));
  },
  opportunityPage: async ({ page }, use) => {
    await use(new OpportunityPage(page));
  },
  // No approvalPage fixture. src/pages/ApprovalPage.js was deleted on
  // 2026-08-03: no test requested it, every selector in it was an unverified
  // placeholder, and its status locator was built on a `data-field` attribute
  // this app does not use — MEASURED 2026-08-02, this app's cells carry
  // `field`. Add the page class back with the approvals suite that needs it,
  // against selectors read from the org — the same reason flows are not
  // scaffolded ahead of the scenarios that need them. Nothing that was
  // deleted would have survived that reading.
  orderPage: async ({ page }, use) => {
    await use(new OrderPage(page));
  },
  contractPage: async ({ page }, use) => {
    await use(new ContractPage(page));
  },
  contractAmendment: async ({ page }, use) => {
    await use(new ContractAmendmentPage(page));
  },
  accountPage: async ({ page }, use) => {
    await use(new AccountPage(page));
  },
});

module.exports = { test, expect: base.expect };
