// tests/pricing/lookup-netbook-price.spec.js
//
// WHAT THIS PROVES
// ----------------
// Some pricing is not written into a rule at all — it lives in a table that the
// business maintains, keyed by the customer's industry, their service level and
// the product. This proves CPQ reads the right row out of that table. Two
// different products are quoted for the SAME customer and must come back at two
// DIFFERENT prices, which is the only way to tell a genuine per-product lookup
// apart from a rule writing one number for the whole account.
//
// WHY IT MATTERS
// --------------
// A lookup table is how the business changes prices without asking anyone to
// edit a rule. If the lookup resolves the wrong row, or one row for everything,
// every quote for that industry is wrong and the table's owners have no way to
// see it from their side.
//
// HOW IT WORKS
// ------------
// `quoteSimpleProducts` seeds a quote for the account whose industry and
// service level the table covers, and adds both netbook products in one
// selection round. Before asserting prices it checks that the quote's industry
// and service-level fields are actually populated — an empty one silently
// matches no row, and the price failure that follows would point at the rule
// instead of at the data. Then three assertions on the saved records: each
// product's expected price, and that the two differ.
//
// IF THIS FAILS, LOOK HERE FIRST
// ------------------------------
//  1. If the test fails complaining that a quote field is empty, the ACCOUNT is
//     missing its Industry or SLA — fix the account, not the test.
//  2. If both products come back at the SAME price, the lookup is resolving one
//     row for the quote instead of one per product. That is the defect this
//     pair of products exists to catch.
//  3. If both prices are wrong but still differ, the underlying
//     `IndustryPrice__c` rows have been edited — compare against the expected
//     values in data/pricing-rules.json.
//
// ---------------------------------------------------------------------------
//
// The `Lookup Netbook Price` rule (source Scenario 6) — a Lookup Query price
// rule. The rule does not carry a price at all: it resolves a row of the custom
// IndustryPrice__c object using the account's Industry and SLA plus the
// product, and writes that row's price onto the line.
//
// TWO PRODUCTS AGAINST ONE ACCOUNT IS THE ENTIRE POINT
// -----------------------------------------------------
// A single product cannot distinguish a lookup that resolves a row PER PRODUCT
// from a rule that writes one constant for the account: both would produce the
// expected number. Two products under the same Industry and the same SLA, each
// landing on its own price, is the smallest configuration that separates them —
// which is why the final assertion is that the two prices DIFFER, and why that
// assertion is not redundant with the two literals above it.
//
// WHAT IS DELIBERATELY NOT BUILT HERE
// -----------------------------------
// The full 16-row Industry x Product x SLA matrix is out of scope: it multiplies
// the run time by eight and adds no new mechanism once the per-product
// resolution above is proven. So is Scenario 7's multiple-matching-rows case,
// which needs a duplicate IndustryPrice__c record — that would mean extending
// CpqDataFactory's stampable map and the sweeper's allowlist, and would force
// these tests to run serially. Only Scenario 7's ZERO-row case ships, folded
// into no-rule-fires.spec.js where an account whose Industry has no row leaves
// every price untouched.
const { test, expect } = require('../../src/fixtures/cpqFixtures');
const { loadJson } = require('../../src/utils/dataProvider');
const { quoteSimpleProducts, requireLine } = require('../../src/flows');
const {
  product,
  requireNumber,
  moneyEquals,
  assertQuoteContextPopulated,
  QUOTE_LOOKUP_FIELDS,
} = require('../../src/utils/pricingData');
const { expectMoney, expectDisplayed, expectSelectionRow } = require('./expectations');
const { captureEvidence } = require('../../src/utils/evidence');
const { runId } = require('../../src/utils/runContext');
const session = require('../../.auth/sf-session.json');

const data = loadJson('pricing-rules.json');
const SCENARIO = data.scenarios.lookupPrice;

// Ungrouped quote — the flat-quote path through QuoteLineEditorPage.
const NO_GROUP = null;

// [VERIFY] Reasoned from the solar suite's measured 7.9 minutes, not measured
// for this flow.
const TIMEOUT_MS = data.timeouts.singleSessionMinutes * 60_000;

test.describe('Lookup Netbook Price', {
  tag: ['@type:regression', '@domain:pricing', '@speed:slow'],
}, () => {
  test('the lookup resolves a distinct price per product for one Industry and SLA',
    { tag: ['@risk:high'] },
    async ({ cpqData, sf, page, quotePage, quoteLineEditor, productSelection }, testInfo) => {
      test.setTimeout(TIMEOUT_MS);
      cpqData.setStage('pricing');

      const netbook = product(data, 'netbook');
      const netbookPro = product(data, 'netbookPro');

      const result = await quoteSimpleProducts(
        { cpqData, sf, quotePage, quoteLineEditor, productSelection },
        {
          instanceUrl: session.instanceUrl,
          account: data.accounts[SCENARIO.account],
          accountKey: SCENARIO.account,
          opportunityName: `${SCENARIO.opportunityBaseName} ${runId()}`,
          products: [netbook, netbookPro],
          closeDateOffsetDays: data.closeDateOffsetDays,
          onSelectionRow: async ({ product: item, rowText }) => {
            expectSelectionRow(rowText, item, data.products[item.key].pricebookPrice);
            await captureEvidence(page, testInfo, `01-selection-${item.productCode}`);
          },
          onBeforeQuickSave: async () => {
            await captureEvidence(
              quoteLineEditor.lineTable(NO_GROUP), testInfo, '02-editor-priced-before-save'
            );
          },
        }
      );

      // BOTH fields, and that is specific to this scenario: the lookup query
      // matches IPIndustry__c against AccountIndustry__c AND IPSLA__c against
      // AccountSLA__c, so an empty SLA silently matches no row and the price
      // assertions below would report the wrong cause entirely. Scenario 1
      // deliberately asks for Industry only — see QUOTE_CONTEXT_FIELDS.
      await assertQuoteContextPopulated(sf, result.quoteId, QUOTE_LOOKUP_FIELDS);

      const netbookLine = requireLine(result.linesByCode, netbook.productCode, 'scenario 6');
      const proLine = requireLine(result.linesByCode, netbookPro.productCode, 'scenario 6');

      const expectedNetbook = requireNumber(
        SCENARIO.expect.netbook.SBQQ__ListPrice__c,
        'scenarios.lookupPrice.expect.netbook.SBQQ__ListPrice__c'
      );
      const expectedPro = requireNumber(
        SCENARIO.expect.netbookPro.SBQQ__ListPrice__c,
        'scenarios.lookupPrice.expect.netbookPro.SBQQ__ListPrice__c'
      );

      expectMoney(
        netbookLine.SBQQ__ListPrice__c,
        expectedNetbook,
        `${netbook.productCode} SBQQ__ListPrice__c from the ` +
          `${result.account.industry} lookup row`
      );
      expectMoney(
        proLine.SBQQ__ListPrice__c,
        expectedPro,
        `${netbookPro.productCode} SBQQ__ListPrice__c from the ` +
          `${result.account.industry} lookup row`
      );

      // The claim the pair exists to make. Not redundant with the two literals:
      // they would both still pass if someone replaced the lookup with a rule
      // that happened to write the same numbers, but only a PER-PRODUCT
      // resolution can put two different prices on one account's quote.
      expect(
        moneyEquals(netbookLine.SBQQ__ListPrice__c, proLine.SBQQ__ListPrice__c),
        `${netbook.productCode} and ${netbookPro.productCode} came back at the same list price ` +
          `(${netbookLine.SBQQ__ListPrice__c}) on one account — the lookup is resolving a single ` +
          'row for the whole quote rather than one row per product'
      ).toBe(false);

      expectDisplayed(result.displayedPrices, netbook.productCode, expectedNetbook);
      await captureEvidence(
        quoteLineEditor.lineTable(NO_GROUP),
        testInfo,
        `03-lookup-prices-${expectedNetbook}-and-${expectedPro}`
      );
    });
});
