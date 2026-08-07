// tests/pricing/educational-netbook-list-price.spec.js
//
// WHAT THIS PROVES
// ----------------
// A school or university buying a netbook automatically gets the discounted
// education price, without a sales rep having to know about it or type it in.
// The discount is also correctly targeted: another product sitting on the very
// same quote, for the same customer, is left at its normal catalogue price.
// Both halves matter — a discount that applies to everything is as wrong as one
// that applies to nothing.
//
// WHY IT MATTERS
// --------------
// If the rule stops firing, education customers are quoted at full price and
// the company loses deals it had already agreed the pricing for. If it fires
// too broadly, every product on an education quote is silently discounted and
// margin walks out of the door unnoticed.
//
// HOW IT WORKS
// ------------
// The `quoteSimpleProducts` flow looks up the education account named in
// `data/pricing-rules.json`, seeds an Opportunity and an ungrouped Quote over
// the API, then drives the real Quote Line Editor to add two products in one
// selection round — the netbook and a deliberately unrelated control product.
// Nothing clicks Calculate: adding a line is supposed to trigger CPQ's
// calculation by itself, and an explicit Calculate would grant that rather than
// test it. After Quick Save the assertions read the saved records through the
// read-only `sf` fixture, never the screen. `cpqData` owns the seeded records
// and tears them down.
//
// IF THIS FAILS, LOOK HERE FIRST
// ------------------------------
//  1. Has the price rule itself changed? Open `Educational Netbook List Price`
//     in Setup and compare it against the `_rulesAsConfigured` block in
//     data/pricing-rules.json, which records how it was configured when this
//     test was written.
//  2. Has the account changed? The rule keys off the account's Industry. The
//     run log prints which account was resolved and its Industry — if that is
//     no longer Education, the data file is pointing at the wrong record.
//  3. Did the control product's price move? Its assertion is relational, so a
//     catalogue reprice cannot break it — but a rule newly targeting the
//     control product would, and that is a real finding rather than noise.
//
// ---------------------------------------------------------------------------
//
// The `Educational Netbook List Price` rule (source Scenario 1, plus Scenario 2
// step 2's in-quote negative) — a price rule whose action writes a STATIC list
// price onto a matching line: NETBOOK on an Education account is priced at 400,
// whatever the price book says.
//
// WHY THE TEST CARRIES A CONTROL PRODUCT ON THE SAME QUOTE
// ---------------------------------------------------------
// A rule that fires correctly and a rule that fires on everything are
// indistinguishable from a single line. The control product rides on the same
// quote, under the same account and the same calculation — so the only thing
// separating it from the line under test is the rule's product condition. Its
// assertion is RELATIONAL (SBQQ__ListPrice__c === SBQQ__OriginalPrice__c),
// which is what lets it work without anyone having to look its price book
// price up first.
//
// The org's other static-list-price rule, `Referral List Price`, is a separate
// rule against a separate account and product and lives in
// referral-list-price.spec.js. The two shared a file when this suite was
// organised by price-action mechanism; nothing relates them except that
// mechanism.
const { test } = require('../../src/fixtures/cpqFixtures');
const { loadJson } = require('../../src/utils/dataProvider');
const { quoteSimpleProducts, requireLine } = require('../../src/flows');
const {
  product,
  requireNumber,
  assertQuoteContextPopulated,
} = require('../../src/utils/pricingData');
const {
  expectMoney,
  expectDisplayed,
  expectSelectionRow,
} = require('./expectations');
const { captureEvidence } = require('../../src/utils/evidence');
const { runId } = require('../../src/utils/runContext');
const session = require('../../.auth/sf-session.json');

const data = loadJson('pricing-rules.json');
const SCENARIO = data.scenarios.staticListPrice.educationNetbook;

// The quote is UNGROUPED, so every per-line call into the Quote Line Editor
// passes null as the group name — that class's flat-quote path.
const NO_GROUP = null;

// [VERIFY] Reasoned from the solar configurator suite's measured 7.9 minutes,
// not measured for this flow. One cold QLE load alone exceeds the project
// default of 120s. Tighten against a real run.
const TIMEOUT_MS = data.timeouts.singleSessionMinutes * 60_000;

// @type:smoke as well as @type:regression, and it is the PRICING half of the
// suite's only two smoke tests. MEASURED 2026-08-03: 59.7s, the fastest test in
// the suite, and it is fast for the right reason rather than by being shallow —
// it walks the whole stack end to end (JWT auth, API seed, account lookup, a
// cold Quote Line Editor, a product selection round, CPQ calculation, Quick
// Save, then a record assertion), so almost any breakage in the framework's
// plumbing surfaces here first.
//
// Before this tag existed the merge gate's `smoke` slice selected @type:smoke
// and matched nothing, so Playwright exited 1 with "No tests found" on every
// pull request. `npm run lint:tags` now fails on an empty slice, which is what
// stops the pair from drifting apart again.
test.describe('Educational Netbook List Price', {
  tag: ['@type:smoke', '@type:regression', '@domain:pricing', '@speed:slow'],
}, () => {
  test('an Education account prices NETBOOK statically and leaves other lines alone',
    { tag: ['@risk:high'] },
    async ({ cpqData, sf, page, quotePage, quoteLineEditor, productSelection }, testInfo) => {
      test.setTimeout(TIMEOUT_MS);
      cpqData.setStage('pricing');

      const netbook = product(data, 'netbook');
      const control = product(data, 'control');

      const result = await quoteSimpleProducts(
        { cpqData, sf, quotePage, quoteLineEditor, productSelection },
        {
          instanceUrl: session.instanceUrl,
          account: data.accounts[SCENARIO.account],
          accountKey: SCENARIO.account,
          opportunityName: `${SCENARIO.opportunityBaseName} ${runId()}`,
          products: [netbook, control],
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

      // AccountIndustry__c only. The Education rule reads nothing else, and
      // Kevco Inc.'s Account.SLA__c is EMPTY — which is not a gap but the
      // reason this scenario is unambiguous: the Lookup Netbook Price rule
      // targets the same field for the same product, and no IndustryPrice__c
      // row can match an empty SLA, so the 400 below can only have come from
      // the Education rule. Asserting SLA were populated would fail the one
      // scenario whose correctness depends on it being blank.
      await assertQuoteContextPopulated(sf, result.quoteId);

      // Act in the UI, assert in the API.
      const netbookLine = requireLine(
        result.linesByCode, netbook.productCode, 'Educational Netbook List Price'
      );
      const expectedListPrice = requireNumber(
        SCENARIO.expect.netbook.SBQQ__ListPrice__c,
        'scenarios.staticListPrice.educationNetbook.expect.netbook.SBQQ__ListPrice__c'
      );
      expectMoney(
        netbookLine.SBQQ__ListPrice__c,
        expectedListPrice,
        `${netbook.productCode} SBQQ__ListPrice__c`
      );

      // Scenario 2 step 2 — the rule's product condition, isolated. Same
      // quote, same account, same calculation; only the product differs.
      const controlLine = requireLine(
        result.linesByCode, control.productCode, 'the in-quote negative'
      );
      expectMoney(
        controlLine.SBQQ__ListPrice__c,
        controlLine.SBQQ__OriginalPrice__c,
        `${control.productCode} must be untouched: SBQQ__ListPrice__c should equal ` +
          'SBQQ__OriginalPrice__c'
      );

      expectDisplayed(result.displayedPrices, netbook.productCode, expectedListPrice);
      await captureEvidence(
        quoteLineEditor.lineTable(NO_GROUP),
        testInfo,
        `03-netbook-list-price-${expectedListPrice}`
      );
    });

});
