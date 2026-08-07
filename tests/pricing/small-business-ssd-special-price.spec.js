// tests/pricing/small-business-ssd-special-price.spec.js
//
// WHAT THIS PROVES
// ----------------
// Small businesses get a negotiated price on the hard drive inside a laptop
// bundle; larger companies buying the identical bundle do not. Two tests that
// differ in ONE thing — the customer's headcount — so any difference in the
// resulting price can only be explained by the size of the customer. The
// discount is also applied as a negotiated price rather than by rewriting the
// catalogue price, which is what keeps the original price visible on the quote
// for anyone reviewing the deal.
//
// WHY IT MATTERS
// --------------
// This is segment pricing. If it leaks to large customers the company discounts
// deals it never meant to; if it stops reaching small ones, the segment it was
// built to win is quoted at enterprise rates.
//
// HOW IT WORKS
// ------------
// Both tests run the same helper and differ only in which account they seed
// against — written once precisely so the two cannot drift apart and turn a
// real difference in outcome into an argument about whether they did the same
// thing. The laptop is a bundle, so each test enters the CPQ configurator,
// ticks the SSD option and saves. That option selection is asserted on screen,
// because before the save there is no record to read; every PRICE assertion
// afterwards reads `SBQQ__QuoteLine__c` through `sf`. Note the configurator's
// own Save does not write to the database — the editor's Quick Save does, which
// is why the record poll comes after it.
//
// IF THIS FAILS, LOOK HERE FIRST
// ------------------------------
//  1. Check the headcount on both accounts. The rule's threshold is fewer than
//     50 employees, and the negative test logs the figure it found — an edit to
//     either account flips the expected outcome.
//  2. If the test times out inside the configurator, the bundle's option layout
//     changed: which feature holds the SSD, and which tab that feature sits on,
//     are both recorded in data/pricing-rules.json and both are required.
//  3. If the price is right but the type is wrong, something other than this
//     rule produced the number.
//
// ---------------------------------------------------------------------------
//
// The `Small Business SSD Special Price` rule (source Scenario 4) — a price
// action whose Target Field is SBQQ__SpecialPrice__c rather than the list
// price, conditioned on the ACCOUNT: the SSD512 option inside the LAPTOP15
// bundle is given a custom special price of 80 when the account has fewer than
// 50 employees, and is left alone when it does not (step 12).
//
// WHY THIS SPEC COSTS MORE THAN THE OTHERS
// ----------------------------------------
// LAPTOP15 is a BUNDLE, so each test pays a configurator entry — about a
// minute of app cold start — on top of the Quote Line Editor's own. Hence the
// longer budget. Nothing here can be batched away: the two tests differ in the
// account, which is decided at seed, so they cannot share a session.
//
// selectBundle() RATHER THAN addProducts(), AND THAT IS NOT INTERCHANGEABLE
// -------------------------------------------------------------------------
// The two disagree about what success looks like. addProducts() ends by
// waiting for the selection screen to still be usable, and treats it vanishing
// as a failure — with an error blaming the selection screen, which is exactly
// right for a simple product filed as a bundle by mistake and exactly wrong
// here. For a bundle the screen vanishing IS the success signal: CPQ navigates
// to the configurator instead of coming back. Putting a bundle through
// addProducts() produces a two-minute timeout with a misleading message.
//
// WHERE THE CONFIGURATOR EXCEPTION APPLIES, AND WHERE IT DOES NOT
// ---------------------------------------------------------------
// Configurator CONSTRAINT tests are exempt from asserting on records,
// because a rejected Save writes nothing and there is no
// record to read. That exemption covers exactly one thing here — the option
// selection, whose only outcome before Save is on screen. Every PRICE
// assertion below reads SBQQ__QuoteLine__c. The exception is about what
// exists, not about what is convenient.
//
// AND THE CONFIGURATOR'S SAVE DOES NOT WRITE TO THE DATABASE
// ----------------------------------------------------------
// It commits to the Quote Line Editor. The editor's own Quick Save is what
// creates the lines — MEASURED for the solar bundle on 2026-07-30:
// zero SBQQ__QuoteLine__c rows immediately after a successful configurator
// Save, eleven after Quick Save. So the poll below comes after Quick Save and
// not before; polling earlier would wait out its whole budget on rows that
// were never written.
const { test, expect } = require('../../src/fixtures/cpqFixtures');
const { loadJson } = require('../../src/utils/dataProvider');
const { quoteSimpleProducts, requireLine } = require('../../src/flows');
const { product, requireNumber, requireString } = require('../../src/utils/pricingData');
const { expectMoney, expectDisplayed } = require('./expectations');
const { captureEvidence } = require('../../src/utils/evidence');
const { runId } = require('../../src/utils/runContext');
const session = require('../../.auth/sf-session.json');

const data = loadJson('pricing-rules.json');
const SCENARIO = data.scenarios.specialPrice;

// Ungrouped quote — the flat-quote path through QuoteLineEditorPage.
const NO_GROUP = null;

// [VERIFY] A configurator entry on top of a QLE cold load. Reasoned from the
// solar suite's measured 7.9 minutes for five entries, not measured here.
const TIMEOUT_MS = data.timeouts.configuratorSessionMinutes * 60_000;

/** The bundle's option under test, with its data-file placeholders enforced. */
function ssdOption() {
  const entry = data.products.laptop15.option;
  return {
    // [VERIFY] Which SBQQ__ProductFeature__c holds SSD512, and which tab that
    // feature sits on. Both are required: <iron-pages> renders only the
    // selected tab's panel, so a feature on an unopened tab is not in the DOM
    // at all and every lookup against it times out naming the feature rather
    // than the tab.
    feature: requireString(entry.feature, 'products.laptop15.option.feature'),
    tab: entry.tab,
    name: requireString(entry.name, 'products.laptop15.option.name'),
    productCode: requireString(entry.productCode, 'products.laptop15.option.productCode'),
  };
}

/**
 * Seeds a quote, configures LAPTOP15 with SSD512 selected, and returns the
 * saved lines.
 *
 * Shared by the positive and the negative test because the only thing that
 * differs between them is the Account — which is the whole point of the pair.
 * Writing the flow twice would let the two drift and turn a real difference in
 * outcome into an argument about whether they did the same thing.
 *
 * Delegates to quoteSimpleProducts(), which grew a `bundles` option once
 * LAPTOP13 turned out to be configurable too (see that flow's header). Keeping
 * a second bundle path here would mean two places where "select, configure,
 * Save, Quick Save, poll" could drift apart — and the whole point of the pair
 * below is that the two runs are identical apart from the account.
 */
async function quoteLaptopWithSsd(deps, { scenario, accountKey, testInfo, evidencePrefix }) {
  const laptop = product(data, 'laptop15');
  const option = ssdOption();

  const result = await quoteSimpleProducts(deps, {
    instanceUrl: session.instanceUrl,
    account: data.accounts[accountKey],
    accountKey,
    opportunityName: `${scenario.opportunityBaseName} ${runId()}`,
    bundles: [{ ...laptop, option }],
    closeDateOffsetDays: data.closeDateOffsetDays,

    onConfigured: async () => {
      // The configurator exception (see the header) applies to exactly this:
      // the selection has no record behind it until the editor is saved, so
      // the screen is the only place the outcome exists.
      expect(
        await deps.productConfiguration.isSelected(option.feature, option.name),
        `${option.name} should be selected in the configurator before Save`
      ).toBe(true);
      await captureEvidence(deps.page, testInfo, `${evidencePrefix}-configurator-ssd-selected`);
    },

    onBeforeQuickSave: async () => {
      await captureEvidence(
        deps.quoteLineEditor.lineTable(NO_GROUP),
        testInfo,
        `${evidencePrefix}-editor-priced-before-save`
      );
    },
  });

  return { ...result, option };
}

test.describe('Small Business SSD Special Price', {
  tag: ['@type:regression', '@domain:pricing', '@speed:slow'],
}, () => {
  // ==========================================================================
  // Scenario 4 — the rule fires
  // ==========================================================================
  test('a small employer gets a custom special price on the SSD option',
    { tag: ['@risk:high'] },
    // Destructured rather than taken as one object: Playwright inspects the
    // parameter list to decide which fixtures to build, and rejects a
    // non-destructured first argument outright.
    async ({
      cpqData, sf, page, quotePage, quoteLineEditor, productSelection, productConfiguration,
    }, testInfo) => {
      test.setTimeout(TIMEOUT_MS);
      cpqData.setStage('pricing');

      const scenario = SCENARIO.positive;
      const result = await quoteLaptopWithSsd(
        { cpqData, sf, page, quotePage, quoteLineEditor, productSelection, productConfiguration },
        { scenario, accountKey: scenario.account, testInfo, evidencePrefix: '01' }
      );

      const line = requireLine(result.linesByCode, result.option.productCode, 'scenario 4');
      const expected = scenario.expect.SSD512;

      const expectedOriginal = requireNumber(
        expected.SBQQ__OriginalPrice__c,
        'scenarios.specialPrice.positive.expect.SSD512.SBQQ__OriginalPrice__c'
      );
      const expectedList = requireNumber(
        expected.SBQQ__ListPrice__c,
        'scenarios.specialPrice.positive.expect.SSD512.SBQQ__ListPrice__c'
      );
      const expectedSpecial = requireNumber(
        expected.SBQQ__SpecialPrice__c,
        'scenarios.specialPrice.positive.expect.SSD512.SBQQ__SpecialPrice__c'
      );
      const multiplier = requireNumber(
        expected.specialPriceEqualsListPriceTimes,
        'scenarios.specialPrice.positive.expect.SSD512.specialPriceEqualsListPriceTimes'
      );

      expectMoney(
        line.SBQQ__OriginalPrice__c, expectedOriginal, 'SSD512 SBQQ__OriginalPrice__c'
      );
      expectMoney(line.SBQQ__ListPrice__c, expectedList, 'SSD512 SBQQ__ListPrice__c');

      // The literal — catches a rule that stopped firing.
      expectMoney(line.SBQQ__SpecialPrice__c, expectedSpecial, 'SSD512 SBQQ__SpecialPrice__c');

      // The relationship — catches a rule computing from the wrong base, which
      // the literal alone would miss the moment the option's list price moves.
      expectMoney(
        line.SBQQ__SpecialPrice__c,
        Number(line.SBQQ__ListPrice__c) * multiplier,
        `SSD512: the special price should be SBQQ__ListPrice__c * ${multiplier}`
      );

      // The type is what distinguishes a rule-written special price from one
      // CPQ derived some other way, so it is asserted rather than assumed.
      expect(
        line.SBQQ__SpecialPriceType__c,
        'SSD512 SBQQ__SpecialPriceType__c — a rule-written special price is Custom'
      ).toBe(requireString(
        expected.SBQQ__SpecialPriceType__c,
        'scenarios.specialPrice.positive.expect.SSD512.SBQQ__SpecialPriceType__c'
      ));

      expectDisplayed(result.displayedPrices, result.option.productCode);
      await captureEvidence(
        quoteLineEditor.lineTable(NO_GROUP),
        testInfo,
        `02-ssd-special-price-${expectedSpecial}`
      );
    });

  // ==========================================================================
  // Scenario 4 step 12 — the rule does not fire
  // ==========================================================================
  test('a large employer gets no special price on the same option',
    { tag: ['@type:negative'] },
    async ({
      cpqData, sf, page, quotePage, quoteLineEditor, productSelection, productConfiguration,
    }, testInfo) => {
      test.setTimeout(TIMEOUT_MS);
      cpqData.setStage('pricing');

      const scenario = SCENARIO.negative;
      const result = await quoteLaptopWithSsd(
        { cpqData, sf, page, quotePage, quoteLineEditor, productSelection, productConfiguration },
        { scenario, accountKey: scenario.account, testInfo, evidencePrefix: '03' }
      );

      // The account is the ONLY difference from the test above, so this is
      // worth stating in the output — it is what the negative rests on.
      console.log(
        `[scenario 4 step 12] "${result.account.name}" has ` +
          `NumberOfEmployees=${result.account.employees}; the rule requires fewer than 50.`
      );

      const line = requireLine(
        result.linesByCode, result.option.productCode, 'scenario 4 step 12'
      );

      expect(
        line.SBQQ__SpecialPriceType__c,
        `SSD512 carries SBQQ__SpecialPriceType__c = '${line.SBQQ__SpecialPriceType__c}' with ` +
          `SBQQ__SpecialPrice__c = ${line.SBQQ__SpecialPrice__c} on an account with ` +
          `${result.account.employees} employees — the rule's account condition is not being applied`
      ).not.toBe(requireString(
        scenario.expect.SSD512.specialPriceTypeIsNot,
        'scenarios.specialPrice.negative.expect.SSD512.specialPriceTypeIsNot'
      ));

      expectDisplayed(result.displayedPrices, result.option.productCode);
      await captureEvidence(
        quoteLineEditor.lineTable(NO_GROUP), testInfo, '04-ssd-no-special-price'
      );
    });
});
