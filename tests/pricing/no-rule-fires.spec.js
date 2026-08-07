// tests/pricing/no-rule-fires.spec.js
//
// WHAT THIS PROVES
// ----------------
// That the org's pricing rules stay switched OFF when they should be. One quote
// is built for a customer who qualifies for none of them, carrying one product
// from each rule, and every line must come back at its ordinary catalogue
// price. This is the counterweight to every other spec in this folder: those
// prove a discount arrives when it is earned, and this proves the same
// discounts do not arrive when it is not.
//
// WHY IT MATTERS
// --------------
// A rule that fires on everything looks identical to a rule that works, from
// the inside of a test that only ever quotes qualifying customers. The money
// leaks quietly and in the customer's favour, so nobody reports it.
//
// HOW IT WORKS
// ------------
// One account is chosen that violates every rule's condition at once — wrong
// industry, too many employees, owns no laptops, no referral code, no
// new-customer flag. `quoteSimpleProducts` puts four products on a single
// quote (one of them a bundle, which takes its own configurator round) and the
// assertions are RELATIONAL: each line's selling price must still equal the
// price it started from. That phrasing is deliberate — listing four expected
// numbers instead would fail every time the catalogue was repriced, which
// teaches people to ignore this test. A second assertion catches rules that
// discount through a negotiated price rather than the catalogue one.
//
// IF THIS FAILS, LOOK HERE FIRST
// ------------------------------
//  1. Read the account line the test logs first. Every assertion rests on that
//     one account still failing all four conditions, and an admin editing its
//     industry or headcount is far likelier than a rule regressing.
//  2. The failure message names WHICH rule the failing product stands in for —
//     start from that rule, not from the product.
//  3. If the netbook specifically fails, the account's industry has gained a
//     row in the pricing lookup table. That condition cannot be expressed in
//     the account query, so it is deliberately left to fail loudly here.
//
// ---------------------------------------------------------------------------
//
// The negative control: ONE quote that no price rule in the org may touch,
// carrying one product from each of them. It covers five scenarios' negative
// halves at the cost of a single Quote Line Editor session:
//
//   Scenario 2 steps 4-5   NETBOOK on a non-Education account
//   Scenario 3 step 10     SDCARD256GB on an Opportunity that is not New Customer
//   Scenario 5 step 12     LAPTOP13 on an account the summary-variable rule does not name
//   Scenario 7 zero-row    an Industry with no IndustryPrice__c row at all
//   Scenario 15 steps 4-5  SMARTBLINDS on a quote with no referral code
//
// WHY ONE QUOTE RATHER THAN FIVE
// ------------------------------
// Each of these asserts the same thing — that a price was NOT changed — and
// the conditions they violate are independent, so one quote that violates all
// five at once is not a weaker test than five quotes that violate one each. It
// is the same coverage for a fifth of the org time, and it removes four
// opportunities for the five quotes to drift apart in how they were built.
//
// WHY THE ASSERTION IS RELATIONAL, NOT A LIST OF EXPECTED PRICES
// ---------------------------------------------------------------
// SBQQ__ListPrice__c === SBQQ__OriginalPrice__c says "no rule moved this",
// which is exactly the claim, and it needs no price book price written down
// anywhere. Listing five expected numbers instead would make this spec fail
// every time the catalogue was repriced — a false alarm that teaches people to
// ignore it — while proving nothing extra.
//
// THE ACCOUNT IS THE WHOLE PRECONDITION, SO IT IS LOGGED
// ------------------------------------------------------
// It must be non-Education, have 50 or more employees, own no laptop assets,
// and have an Industry with no IndustryPrice__c row. Verified against the org
// on 2026-08-01 for Burlington Textiles Corp of America — Banking (no
// IndustryPrice__c row exists for anything but Education and Healthcare),
// 9,000 employees, no LAPTOP1* assets.
//
// The predicate in data/pricing-rules.json expresses the first three. The
// fourth is not expressible in SOQL, because a semi-join can only compare Ids
// and not a picklist value, so it is left to fail loudly rather than be
// half-enforced: an account whose Industry DID have a row would fire the
// lookup and fail the netbook assertion below by name. The fix would then be
// to pin `accounts.negativeControl.name` elsewhere — not to loosen this.
//
// LAPTOP13 IS A BUNDLE, SO IT TAKES ITS OWN ROUND
// ------------------------------------------------
// Measured on 2026-08-01: it opens the configurator rather than returning to
// the selection screen. The other three products are simple and share one
// round. All four still land on ONE quote, which is what makes this a single
// session rather than four.
const { test, expect } = require('../../src/fixtures/cpqFixtures');
const { loadJson } = require('../../src/utils/dataProvider');
const { quoteSimpleProducts, requireLine } = require('../../src/flows');
const { product, requireString } = require('../../src/utils/pricingData');
const { expectMoney, expectDisplayed } = require('./expectations');
const { captureEvidence } = require('../../src/utils/evidence');
const { runId } = require('../../src/utils/runContext');
const session = require('../../.auth/sf-session.json');

const data = loadJson('pricing-rules.json');
const SCENARIO = data.scenarios.negativeControl;

// Ungrouped quote — the flat-quote path through QuoteLineEditorPage.
const NO_GROUP = null;

// [VERIFY] Four products in one selection round on top of a cold QLE load.
// Reasoned from the solar suite's measured 7.9 minutes, not measured here.
const TIMEOUT_MS = data.timeouts.singleSessionMinutes * 60_000;

/** Which rule each line stands in for, so a failure names the rule it broke. */
const COVERS = {
  netbook: 'Educational Netbook List Price (account is not Education) and ' +
    'Lookup Netbook Price (the Industry has no IndustryPrice__c row)',
  sdCard: 'New Customer SD Card List Price (the Opportunity is not New Customer)',
  smartblinds: 'Referral List Price (no referral code is set)',
  laptop13: 'Repeated Laptop List Price (the account holds no laptop assets)',
};

/** Every product this quote carries, bundles and simple products alike. */
const ASSERTED_KEYS = [...(SCENARIO.bundles || []), ...SCENARIO.products];

test.describe('No price rule fires', {
  tag: ['@type:regression', '@type:negative', '@domain:pricing', '@speed:slow'],
}, () => {
  test('a quote satisfying no rule\'s conditions leaves every line at its price book price',
    async ({
      cpqData, sf, quotePage, quoteLineEditor, productSelection, productConfiguration,
    }, testInfo) => {
      test.setTimeout(TIMEOUT_MS);
      cpqData.setStage('pricing');

      const result = await quoteSimpleProducts(
        { cpqData, sf, quotePage, quoteLineEditor, productSelection, productConfiguration },
        {
          instanceUrl: session.instanceUrl,
          account: data.accounts[SCENARIO.account],
          accountKey: SCENARIO.account,
          opportunityName: `${SCENARIO.opportunityBaseName} ${runId()}`,
          // No referral code, no Opportunity Type. Their ABSENCE is the
          // precondition, so neither is set — stating them as empty here would
          // read as an oversight rather than as the point.
          bundles: (SCENARIO.bundles || []).map((key) => product(data, key)),
          products: SCENARIO.products.map((key) => product(data, key)),
          closeDateOffsetDays: data.closeDateOffsetDays,
          onBeforeQuickSave: async () => {
            await captureEvidence(
              quoteLineEditor.lineTable(NO_GROUP), testInfo, '01-editor-priced-before-save'
            );
          },
        }
      );

      // The precondition, in the run output. Every assertion below rests on it.
      console.log(
        `[negative control] "${result.account.name}": Industry=${result.account.industry}, ` +
          `NumberOfEmployees=${result.account.employees}. No referral code, no Opportunity Type. ` +
          'If any assertion below fails, check this account still satisfies all four ' +
          'requirements before suspecting a rule.'
      );

      const notCustom = requireString(
        SCENARIO.expect.everyLine.specialPriceTypeIsNot,
        'scenarios.negativeControl.expect.everyLine.specialPriceTypeIsNot'
      );

      for (const key of ASSERTED_KEYS) {
        const item = product(data, key);
        const line = requireLine(result.linesByCode, item.productCode, COVERS[key] || key);

        // The claim: no rule moved this price.
        expectMoney(
          line.SBQQ__ListPrice__c,
          line.SBQQ__OriginalPrice__c,
          `${item.productCode} — ${COVERS[key] || key}: SBQQ__ListPrice__c must still equal ` +
            'SBQQ__OriginalPrice__c'
        );

        // And no rule wrote a special price either. A special-price action
        // leaves SBQQ__ListPrice__c alone, so the equality above cannot see it.
        expect(
          line.SBQQ__SpecialPriceType__c,
          `${item.productCode} carries SBQQ__SpecialPriceType__c = ` +
            `'${line.SBQQ__SpecialPriceType__c}' with SBQQ__SpecialPrice__c = ` +
            `${line.SBQQ__SpecialPrice__c} — a price rule fired on the negative control`
        ).not.toBe(notCustom);
      }

      expectDisplayed(result.displayedPrices, product(data, ASSERTED_KEYS[0]).productCode);
      await captureEvidence(
        quoteLineEditor.lineTable(NO_GROUP), testInfo, '02-no-rule-fired-on-any-line'
      );
    });
});
