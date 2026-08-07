// tests/pricing/new-customer-sd-card-list-price.spec.js
//
// WHAT THIS PROVES
// ----------------
// A new-customer deal gets a fixed amount taken off the SD card's catalogue
// price, and the discount is CALCULATED from that catalogue price rather than
// being a hardcoded number that happens to look right today. The difference
// matters: if the catalogue price changes tomorrow, a calculated discount
// follows it and a hardcoded one silently stops being a discount at all.
//
// WHY IT MATTERS
// --------------
// New-customer incentives are how deals get won. If the rule stops firing, reps
// quote full price on exactly the deals the incentive existed to close — and if
// it computes from a stale base, the company gives away more or less than it
// intended without anyone seeing a change.
//
// HOW IT WORKS
// ------------
// `quoteSimpleProducts` seeds the Opportunity with its Type set to the value
// the rule requires — the rule reads the Opportunity, not the quote, and
// nothing defaults that field on a record created over the API, so a run
// without it could never fire the rule at all. Two products go on in one
// selection round: the SD card and a router that shares everything with it
// except the product code. Three assertions follow on the saved records: the
// base the formula starts from, the resulting price, and the arithmetic
// relating them.
//
// IF THIS FAILS, LOOK HERE FIRST
// ------------------------------
//  1. If the base price assertion fails first, the catalogue moved — update the
//     expected values in data/pricing-rules.json rather than the arithmetic.
//  2. If the base is right but the result is not, the rule's formula changed.
//  3. If the router also moved, the rule's product condition is no longer
//     scoping it to the SD card.
//
// ---------------------------------------------------------------------------
//
// The `New Customer SD Card List Price` rule (source Scenario 3) — a price
// action whose Source is a FORMULA rather than a static value: SDCARD256GB's
// list price becomes its price book price minus 25, on a quote whose
// Opportunity Type is 'New Customer'.
//
// WHY THIS SCENARIO ASSERTS A RELATIONSHIP AND NOT JUST A NUMBER
// --------------------------------------------------------------
// A static-price rule and a formula rule are indistinguishable from the
// resulting number alone: 60 is 60 whether the action wrote it directly or
// computed it from 85. The scenario is about the FORMULA, so the assertion has
// to be about the arithmetic — SBQQ__ListPrice__c === SBQQ__OriginalPrice__c
// minus 25 — and the literal 60 is the second half, catching a rule that
// stopped firing at all. Either assertion alone would miss a real defect: the
// literal misses a rule computing from the wrong base the moment the price
// book changes, and the relationship misses a rule replaced by a static action
// that happens to write the same number today.
//
// WHY THE OPPORTUNITY TYPE IS SEEDED
// ----------------------------------
// The rule's condition reads Opportunity.Type, not anything on the quote, and
// createSimpleQuote creates the Opportunity over REST — where nothing defaults
// it. Setting it at seed through opportunityFields is the difference between a
// rule that can fire and one that never can; a run without it would fail on
// the price and say nothing about why.
//
// THE ROUTER LINE IS THE NEGATIVE, AND IT RIDES ON THE SAME QUOTE
// ---------------------------------------------------------------
// It shares the account, the quote and the Opportunity Type, so the ONLY thing
// separating it from the SD card is the rule's product-code condition. That
// isolates one half of a two-part condition in a single session — a separate
// quote could not, because it would differ in more than one way.
const { test } = require('../../src/fixtures/cpqFixtures');
const { loadJson } = require('../../src/utils/dataProvider');
const { quoteSimpleProducts, requireLine } = require('../../src/flows');
const { product, requireNumber } = require('../../src/utils/pricingData');
const { expectMoney, expectDisplayed, expectSelectionRow } = require('./expectations');
const { captureEvidence } = require('../../src/utils/evidence');
const { runId } = require('../../src/utils/runContext');
const session = require('../../.auth/sf-session.json');

const data = loadJson('pricing-rules.json');
const SCENARIO = data.scenarios.formulaListPrice;

// Ungrouped quote — the flat-quote path through QuoteLineEditorPage.
const NO_GROUP = null;

// [VERIFY] Reasoned from the solar suite's measured 7.9 minutes, not measured
// for this flow. Tighten against a real run.
const TIMEOUT_MS = data.timeouts.singleSessionMinutes * 60_000;

test.describe('New Customer SD Card List Price', {
  tag: ['@type:regression', '@domain:pricing', '@speed:slow'],
}, () => {
  test('a New Customer opportunity discounts the SD card by formula and leaves the router alone',
    async ({ cpqData, sf, page, quotePage, quoteLineEditor, productSelection }, testInfo) => {
      test.setTimeout(TIMEOUT_MS);
      cpqData.setStage('pricing');

      const sdCard = product(data, 'sdCard');
      const router = product(data, 'router');

      const result = await quoteSimpleProducts(
        { cpqData, sf, quotePage, quoteLineEditor, productSelection },
        {
          instanceUrl: session.instanceUrl,
          account: data.accounts[SCENARIO.account],
          accountKey: SCENARIO.account,
          opportunityName: `${SCENARIO.opportunityBaseName} ${runId()}`,
          // The rule's Opportunity-side condition. See the header.
          opportunityFields: SCENARIO.opportunityFields,
          products: [sdCard, router],
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

      // ---- the line the rule targets ---------------------------------------
      const sdCardLine = requireLine(result.linesByCode, sdCard.productCode, 'scenario 3');

      const expectedOriginal = requireNumber(
        SCENARIO.expect.sdCard.SBQQ__OriginalPrice__c,
        'scenarios.formulaListPrice.expect.sdCard.SBQQ__OriginalPrice__c'
      );
      const expectedList = requireNumber(
        SCENARIO.expect.sdCard.SBQQ__ListPrice__c,
        'scenarios.formulaListPrice.expect.sdCard.SBQQ__ListPrice__c'
      );
      const discount = requireNumber(
        SCENARIO.expect.sdCard.listPriceEqualsOriginalMinus,
        'scenarios.formulaListPrice.expect.sdCard.listPriceEqualsOriginalMinus'
      );

      // The base the formula computes FROM. A rule reading the wrong base is
      // the failure a literal expected price cannot see.
      expectMoney(
        sdCardLine.SBQQ__OriginalPrice__c,
        expectedOriginal,
        `${sdCard.productCode} SBQQ__OriginalPrice__c (the price book price the formula starts from)`
      );

      // The literal — catches a rule that has stopped firing.
      expectMoney(
        sdCardLine.SBQQ__ListPrice__c,
        expectedList,
        `${sdCard.productCode} SBQQ__ListPrice__c`
      );

      // The relationship — catches a rule computing from the wrong base, and
      // is the only assertion here that is actually about the FORMULA.
      expectMoney(
        sdCardLine.SBQQ__ListPrice__c,
        Number(sdCardLine.SBQQ__OriginalPrice__c) - discount,
        `${sdCard.productCode}: the formula should be SBQQ__OriginalPrice__c - ${discount}`
      );

      // ---- the product-condition negative, on the same quote ---------------
      const routerLine = requireLine(
        result.linesByCode, router.productCode, 'scenario 3 step 10 — the in-quote negative'
      );
      expectMoney(
        routerLine.SBQQ__ListPrice__c,
        routerLine.SBQQ__OriginalPrice__c,
        `${router.productCode} must be untouched on a quote that DOES match the ` +
          "rule's Opportunity Type condition: SBQQ__ListPrice__c should equal SBQQ__OriginalPrice__c"
      );

      expectDisplayed(result.displayedPrices, sdCard.productCode, expectedList);
      await captureEvidence(
        quoteLineEditor.lineTable(NO_GROUP),
        testInfo,
        `03-sdcard-formula-list-price-${expectedList}`
      );
    });
});
