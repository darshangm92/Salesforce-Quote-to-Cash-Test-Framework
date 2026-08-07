// tests/pricing/repeated-laptop-list-price.spec.js
//
// WHAT THIS PROVES
// ----------------
// A customer who already owns ten or more laptops gets a loyalty discount on
// the next one. The interesting part is where that "ten or more" comes from: it
// is counted from the equipment the customer already owns, not from anything on
// the quote in front of the rep. So the discount appears on the first laptop
// they add, before the quote is anywhere near ten units. A laptop cart on the
// same quote is left alone, which proves the discount is scoped to laptops
// rather than to the whole qualifying customer.
//
// WHY IT MATTERS
// --------------
// This is a retention discount for the company's largest existing hardware
// customers. If it stops firing they are quoted the same price as a first-time
// buyer, which is exactly the wrong signal to send them at renewal.
//
// HOW IT WORKS
// ------------
// `quoteSimpleProducts` quotes against the account named in the data file — the
// one that already owns ten laptops. The laptop is a configurable bundle, so it
// takes its own trip through the configurator; the cart is a simple product and
// follows in a second round. Both end up on ONE quote, which is what makes the
// cart a sharp negative: it sits inside a quote where the loyalty condition is
// TRUE and is still not discounted. Assertions read the saved lines through
// `sf`, and check both the resulting price and the arithmetic behind it.
//
// IF THIS FAILS, LOOK HERE FIRST
// ------------------------------
//  1. Count the account's laptop assets. The threshold is exactly ten and the
//     account sits exactly on it, so deleting ONE asset stops the rule firing.
//     This is the most likely cause by a wide margin.
//  2. Check the summary variable behind the rule. Its Filter Field has been
//     misconfigured before. The trap: SBQQ__FilterField__c offers both labels
//     and API names, and `Product Code` is the LABEL of a field that does not
//     exist on Asset — Asset's is the standard `ProductCode`, with no space.
//     The picklist offers all four whatever the target object is, so the
//     obvious-looking choice silently matches no records and the sum is 0.
//  3. If the cart also moved, the price action is no longer scoped by product
//     code.
//
// ---------------------------------------------------------------------------
//
// The `Repeated Laptop List Price` rule (source Scenario 5) — a price rule
// whose condition is driven by a SUMMARY VARIABLE rather than by a field on the
// line: LAPTOP13 on the GenePoint quote is discounted by 100 off its price book
// price, and the laptop cart on the same quote is not (step 13).
//
// WHAT THE SUMMARY VARIABLE ACTUALLY AGGREGATES
// ---------------------------------------------
// READ FROM THE ORG on 2026-08-01, and not what the scenario's wording
// suggests: 'Laptop Asset Sum' is SUM(Quantity) over ASSET records whose
// product code starts with 'LAPTOP1', scoped to the quote's account. It is the
// account's INSTALLED BASE, not anything on the quote. GenePoint holds
// LAPTOP13 x8 and LAPTOP15 x2 — exactly 10, exactly the threshold.
//
// Two consequences worth stating, because both are invisible from the spec:
// nothing this test does to the quote can change whether the rule fires, and
// deleting either GenePoint asset drops the sum below 10 and stops it firing.
// That is also why the negative control's account predicate excludes accounts
// holding laptop assets — those two facts are the same fact.
//
// WHY THE CART LINE IS ON THE SAME QUOTE AND NOT IN ITS OWN TEST
// ---------------------------------------------------------------
// Once the account qualifies, the condition is satisfied for every line on the
// quote. That makes the cart the sharpest possible negative: it sits inside a
// quote where the condition is TRUE and is still left alone, which can only
// mean the price ACTION is scoped by product code. A separate quote could not
// show that — there the condition would be false and an untouched price would
// prove nothing.
//
// The account half of the condition is covered by no-rule-fires.spec.js, which
// quotes the same laptop against an account with no laptop assets.
//
// LAPTOP13 IS A BUNDLE, WHICH IS WHY THIS IS TWO ROUNDS AND NOT ONE
// ------------------------------------------------------------------
// Measured on 2026-08-01: SBQQ__ConfigurationType__c = 'Allowed' with
// SBQQ__ConfigurationEvent__c = 'Always', exactly like LAPTOP15. So it opens
// the configurator and cannot share a selection round with the cart. Its three
// features are each min 1 / max 1 and arrive with a default selected, so the
// configurator's Save is accepted without touching anything.
const { test } = require('../../src/fixtures/cpqFixtures');
const { loadJson } = require('../../src/utils/dataProvider');
const { quoteSimpleProducts, requireLine } = require('../../src/flows');
const { product, requireNumber } = require('../../src/utils/pricingData');
const { expectMoney, expectDisplayed, expectSelectionRow } = require('./expectations');
const { captureEvidence } = require('../../src/utils/evidence');
const { runId } = require('../../src/utils/runContext');
const session = require('../../.auth/sf-session.json');

const data = loadJson('pricing-rules.json');
const SCENARIO = data.scenarios.summaryVariable;

// Ungrouped quote — the flat-quote path through QuoteLineEditorPage.
const NO_GROUP = null;

// [VERIFY] Reasoned from the solar suite's measured 7.9 minutes, not measured
// for this flow.
const TIMEOUT_MS = data.timeouts.singleSessionMinutes * 60_000;

test.describe('Repeated Laptop List Price', {
  tag: ['@type:regression', '@domain:pricing', '@speed:slow'],
}, () => {
  test('ten or more laptop assets on the account discount the laptop and leave the cart alone',
    async ({
      cpqData, sf, page, quotePage, quoteLineEditor, productSelection, productConfiguration,
    }, testInfo) => {
      test.setTimeout(TIMEOUT_MS);
      cpqData.setStage('pricing');

      const laptop = product(data, 'laptop13');
      const cart = product(data, 'laptopCart');

      const result = await quoteSimpleProducts(
        { cpqData, sf, quotePage, quoteLineEditor, productSelection, productConfiguration },
        {
          instanceUrl: session.instanceUrl,
          account: data.accounts[SCENARIO.account],
          accountKey: SCENARIO.account,
          opportunityName: `${SCENARIO.opportunityBaseName} ${runId()}`,
          // The laptop is configurable and takes its own round; the cart is a
          // simple product. Both land on one quote — see the header.
          bundles: [laptop],
          products: [cart],
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
      const laptopLine = requireLine(result.linesByCode, laptop.productCode, 'scenario 5');

      const expectedList = requireNumber(
        SCENARIO.expect.laptop13.SBQQ__ListPrice__c,
        'scenarios.summaryVariable.expect.laptop13.SBQQ__ListPrice__c'
      );
      const discount = requireNumber(
        SCENARIO.expect.laptop13.listPriceEqualsOriginalMinus,
        'scenarios.summaryVariable.expect.laptop13.listPriceEqualsOriginalMinus'
      );

      // The literal — catches a rule that stopped firing.
      expectMoney(laptopLine.SBQQ__ListPrice__c, expectedList, 'LAPTOP13 SBQQ__ListPrice__c');

      // The relationship — catches a rule discounting from the wrong base,
      // which is invisible to the literal until the price book changes.
      expectMoney(
        laptopLine.SBQQ__ListPrice__c,
        Number(laptopLine.SBQQ__OriginalPrice__c) - discount,
        `LAPTOP13: the discount should be SBQQ__OriginalPrice__c - ${discount}`
      );

      // The rule is scoped to product codes STARTING WITH 'LAPTOP1', and
      // 'LAPTOPCART' does not — which is what makes the cart a negative even
      // though its name says "laptop".
      //
      // ---- step 13: the product scope, inside a quote where the condition
      //      is TRUE. See the header for why that is the sharp version.
      const cartLine = requireLine(
        result.linesByCode, cart.productCode, 'scenario 5 step 13 — the in-quote negative'
      );
      expectMoney(
        cartLine.SBQQ__ListPrice__c,
        cartLine.SBQQ__OriginalPrice__c,
        `${cart.productCode} rides on the same quote, where the summary variable's condition is ` +
          'satisfied — so an untouched SBQQ__ListPrice__c is what proves the price action is ' +
          'scoped to the laptop'
      );

      expectDisplayed(result.displayedPrices, laptop.productCode, expectedList);
      await captureEvidence(
        quoteLineEditor.lineTable(NO_GROUP),
        testInfo,
        `03-laptop13-list-price-${expectedList}`
      );
    });
});
