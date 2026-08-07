// tests/pricing/referral-list-price.spec.js
//
// WHAT THIS PROVES
// ----------------
// When a quote carries a referral code from a partner campaign, the promoted
// product is priced at the campaign rate automatically. Two tests: one enters
// the code exactly as documented, the other enters it capitalised. Both are
// expected to work, because CPQ compares text without regard to case — which
// means a rep who types "Tradeshow" instead of "tradeshow" still gets the deal
// they promised the customer.
//
// WHY IT MATTERS
// --------------
// Campaign pricing that depends on exact capitalisation is a support ticket
// waiting to happen: the customer was promised a price, the rep typed the code,
// and the quote came out at full price with nothing on screen explaining why.
//
// HOW IT WORKS
// ------------
// Each test seeds its own quote through `quoteSimpleProducts`, with the
// referral code set at seed time rather than typed onto a saved quote — the
// code is a precondition here, not the behaviour under test, and typing it
// would cost a full re-entry into the Quote Line Editor per test. The first
// test also carries a control product on the same quote to prove the rule is
// scoped to one product rather than to the whole quote. Assertions read the
// saved lines through `sf`; the price book price is read live from
// `PricebookEntry` rather than written down, so a catalogue reprice cannot
// produce a false failure.
//
// IF THIS FAILS, LOOK HERE FIRST
// ------------------------------
//  1. If only the capitalised test fails, CPQ's text comparison has changed
//     behaviour — that is a genuine finding and the log line printed by that
//     test spells out which of the two prices means which.
//  2. If both fail, check the `Referral List Price` rule and the custom
//     `ReferralCode__c` field on the quote still exist and still match
//     `_rulesAsConfigured` in data/pricing-rules.json.
//  3. If the price is right but the control product also moved, a second rule
//     is firing on this quote.
//
// ---------------------------------------------------------------------------
//
// The `Referral List Price` rule (source Scenario 14, plus Scenario 15 steps 2
// and 7) — a price rule whose action writes a STATIC list price onto a matching
// line, conditioned on the QUOTE's ReferralCode__c: SMARTBLINDS on a quote
// whose code is 'tradeshow' is priced at 125.
//
// The rule's condition is probed two ways: a matching code, and a
// differently-CASED one.
//
// WHY THE REFERRAL CODE IS SEEDED OVER THE API AND NOT TYPED ON THE QUOTE
// -----------------------------------------------------------------------
// Both tests need a quote carrying a different ReferralCode__c before its lines
// exist. Typing it onto the saved quote record instead would mean, per test:
// open the record, edit, save, re-enter the Quote Line Editor — and re-entering
// the QLE costs a cold app start. Four round trips across two tests, to
// establish a PRECONDITION rather than to test anything.
//
// Editing the field on an ALREADY PRICED quote — where the edit is the
// behaviour under test rather than a way of arranging one — was covered by a
// spec that was removed after the 2026-08-01 run. What it MEASURED: clearing
// ReferralCode__c left SMARTBLINDS at 125 against an SBQQ__OriginalPrice__c of
// 150, across three runs — a rule-written SBQQ__ListPrice__c is not re-derived
// when its condition goes away. Whether that is intended is still open, and
// nothing here re-tests it.
//
// WHY THE MATCHING-CODE TEST CARRIES A CONTROL PRODUCT ON THE SAME QUOTE
// -----------------------------------------------------------------------
// A rule that fires correctly and a rule that fires on everything are
// indistinguishable from a single line. The control rides on the same quote,
// under the same account, the same referral code and the same calculation — so
// the only thing separating it from the line under test is the rule's product
// condition. Its assertion is RELATIONAL (SBQQ__ListPrice__c ===
// SBQQ__OriginalPrice__c), which is what lets it work without anyone having to
// look its price book price up first.
const { test } = require('../../src/fixtures/cpqFixtures');
const { loadJson } = require('../../src/utils/dataProvider');
const { quoteSimpleProducts, requireLine } = require('../../src/flows');
const {
  product,
  requireNumber,
  pricebookUnitPrice,
} = require('../../src/utils/pricingData');
const {
  expectMoney,
  expectMoneyNot,
  expectDisplayed,
  expectSelectionRow,
} = require('./expectations');
const { captureEvidence } = require('../../src/utils/evidence');
const { runId } = require('../../src/utils/runContext');
const session = require('../../.auth/sf-session.json');

const data = loadJson('pricing-rules.json');
const SCENARIOS = data.scenarios.staticListPrice;

// Every quote here is UNGROUPED, so every per-line call into the Quote Line
// Editor passes null as the group name — that class's flat-quote path.
const NO_GROUP = null;

// [VERIFY] Reasoned from the solar configurator suite's measured 7.9 minutes,
// not measured for this flow. One cold QLE load alone exceeds the project
// default of 120s. Tighten against a real run.
const TIMEOUT_MS = data.timeouts.singleSessionMinutes * 60_000;

test.describe('Referral List Price', {
  tag: ['@type:regression', '@domain:pricing', '@speed:slow'],
}, () => {
  // ==========================================================================
  // Scenario 14 + Scenario 15 step 2
  // ==========================================================================
  test('a matching referral code prices SMARTBLINDS statically',
    async ({ cpqData, sf, page, quotePage, quoteLineEditor, productSelection }, testInfo) => {
      test.setTimeout(TIMEOUT_MS);
      cpqData.setStage('pricing');

      const scenario = SCENARIOS.referralTradeshow;
      const smartblinds = product(data, 'smartblinds');
      const control = product(data, 'control');

      const result = await quoteSimpleProducts(
        { cpqData, sf, quotePage, quoteLineEditor, productSelection },
        {
          instanceUrl: session.instanceUrl,
          account: data.accounts[scenario.account],
          accountKey: scenario.account,
          opportunityName: `${scenario.opportunityBaseName} ${runId()}`,
          // The precondition, seeded rather than typed. See the header.
          quoteFields: scenario.quoteFields,
          products: [smartblinds, control],
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

      const line = requireLine(
        result.linesByCode, smartblinds.productCode, 'Referral List Price'
      );
      const expectedListPrice = requireNumber(
        scenario.expect.smartblinds.SBQQ__ListPrice__c,
        'scenarios.staticListPrice.referralTradeshow.expect.smartblinds.SBQQ__ListPrice__c'
      );
      expectMoney(
        line.SBQQ__ListPrice__c,
        expectedListPrice,
        `${smartblinds.productCode} SBQQ__ListPrice__c with ReferralCode__c = ` +
          `'${scenario.quoteFields.ReferralCode__c}'`
      );

      // The relationship half. A static list price action must leave the price
      // it started FROM untouched — SBQQ__OriginalPrice__c is still the price
      // book price. Read live from PricebookEntry rather than written down,
      // because a hardcoded copy of the price book is a second source of truth
      // that drifts without anyone noticing.
      const bookPrice = await pricebookUnitPrice(sf, result.pricebookId, smartblinds.productCode);
      expectMoney(
        line.SBQQ__OriginalPrice__c,
        bookPrice,
        `${smartblinds.productCode} SBQQ__OriginalPrice__c should still be the price book price`
      );
      expectMoneyNot(
        line.SBQQ__ListPrice__c,
        line.SBQQ__OriginalPrice__c,
        `${smartblinds.productCode}: the rule must move the list price AWAY from the price book ` +
          'price — if the two are equal, nothing distinguishes this from the rule not firing'
      );

      // Scenario 15 step 2 — the rule's product condition, isolated. This
      // quote HAS the matching referral code, so the control line proves the
      // rule is scoped to Smartblinds rather than to the quote.
      const controlLine = requireLine(
        result.linesByCode, control.productCode, 'the in-quote negative'
      );
      expectMoney(
        controlLine.SBQQ__ListPrice__c,
        controlLine.SBQQ__OriginalPrice__c,
        `${control.productCode} must be untouched even on a quote that matches the referral rule`
      );

      expectDisplayed(result.displayedPrices, smartblinds.productCode, expectedListPrice);
      await captureEvidence(
        quoteLineEditor.lineTable(NO_GROUP),
        testInfo,
        `03-smartblinds-referral-list-price-${expectedListPrice}`
      );
    });

  // ==========================================================================
  // Scenario 15 step 7 — case sensitivity
  // ==========================================================================
  test('a capitalised referral code matches too — CPQ compares text case-insensitively',
    async ({ cpqData, sf, quotePage, quoteLineEditor, productSelection }, testInfo) => {
      test.setTimeout(TIMEOUT_MS);
      cpqData.setStage('pricing');

      const scenario = SCENARIOS.referralCapitalised;
      const smartblinds = product(data, 'smartblinds');

      const result = await quoteSimpleProducts(
        { cpqData, sf, quotePage, quoteLineEditor, productSelection },
        {
          instanceUrl: session.instanceUrl,
          account: data.accounts[scenario.account],
          accountKey: scenario.account,
          opportunityName: `${scenario.opportunityBaseName} ${runId()}`,
          quoteFields: scenario.quoteFields,
          products: [smartblinds],
          closeDateOffsetDays: data.closeDateOffsetDays,
          onBeforeQuickSave: async () => {
            await captureEvidence(
              quoteLineEditor.lineTable(NO_GROUP), testInfo, '04-editor-priced-before-save'
            );
          },
        }
      );

      const line = requireLine(
        result.linesByCode, smartblinds.productCode, 'Referral List Price, capitalised code'
      );

      // REPORT THE MEASUREMENT BEFORE REQUIRING THE EXPECTATION.
      //
      // This test established a fact nobody had written down: whether CPQ's
      // price-condition text comparison is case-sensitive. The 2026-08-01 run
      // answered it — case-INsensitive, so a capitalised code still matches —
      // and the data file now carries that answer. The log stays because it is
      // what makes ONE failing run sufficient if the behaviour ever changes:
      // without it the only way to learn what the org actually did is to open
      // a trace.
      const matchingPrice = SCENARIOS.referralTradeshow.expect.smartblinds.SBQQ__ListPrice__c;
      const bookPrice = data.products.smartblinds.pricebookPrice;
      console.log(
        `[measurement] ReferralCode__c = '${scenario.quoteFields.ReferralCode__c}' (capitalised) ` +
          `produced ${smartblinds.productCode} SBQQ__ListPrice__c = ${line.SBQQ__ListPrice__c} ` +
          `(SBQQ__OriginalPrice__c = ${line.SBQQ__OriginalPrice__c}).\n` +
          `  ${matchingPrice} means the comparison is case-INsensitive; ` +
          `${bookPrice} means it is case-sensitive.\n` +
          '  The recorded expectation is at data/pricing-rules.json ' +
          'scenarios.staticListPrice.referralCapitalised.expect.smartblinds.SBQQ__ListPrice__c.'
      );

      const expectedListPrice = requireNumber(
        scenario.expect.smartblinds.SBQQ__ListPrice__c,
        'scenarios.staticListPrice.referralCapitalised.expect.smartblinds.SBQQ__ListPrice__c'
      );
      expectMoney(
        line.SBQQ__ListPrice__c,
        expectedListPrice,
        `${smartblinds.productCode} SBQQ__ListPrice__c with ReferralCode__c = ` +
          `'${scenario.quoteFields.ReferralCode__c}' (capitalised)`
      );

      expectDisplayed(result.displayedPrices, smartblinds.productCode, expectedListPrice);
      await captureEvidence(
        quoteLineEditor.lineTable(NO_GROUP), testInfo, '05-smartblinds-capitalised-referral'
      );
    });

});
