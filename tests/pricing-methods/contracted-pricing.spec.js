// tests/pricing-methods/contracted-pricing.spec.js
//
// WHAT THIS PROVES
// ----------------
// Prices negotiated with one customer apply to that customer and nobody else.
// Two shapes are covered: a flat price agreed for one named product, and a
// blanket discount agreed across a whole product family without naming any
// product at all. Three tests prove they reach the right lines on the right
// account, that they do not stack on top of each other, that they do not reach
// a different customer, and that once the agreement expires new quotes go back
// to normal pricing while quotes written during the agreement keep what they
// were given.
//
// WHY IT MATTERS
// --------------
// A negotiated price leaking to another customer means giving away a discount
// that was traded for something. A negotiated price that stops applying means
// breaking a commitment the company made in writing, on the customer's next
// order.
//
// HOW IT WORKS
// ------------
// A guard reads both agreement records out of the org first and checks they do
// not overlap — if they did, "they do not stack" could not be distinguished
// from "only one of them happened to apply". Each test then quotes the same
// four products through `quoteSimpleProducts`, changing only the account, and
// reads the saved lines through `sf`. The blanket discount is asserted
// relationally against each line's own price, so a catalogue reprice cannot
// produce a false failure; the flat price is asserted as a literal, because a
// flat price is exactly what that record configures.
//
// The expiry test is the one to know about: it reads TWO hand-staged records
// that no automation maintains — an agreement whose end date has passed, and a
// quote written before that date. A test cannot create a record in the past,
// and creating the agreement itself would break this suite's read-only rule on
// configuration.
//
// IF THIS FAILS, LOOK HERE FIRST
// ------------------------------
//  1. If the expiry test fails saying a staged quote is missing, someone
//     deleted the fixture. The message names the staging note that explains how
//     to recreate it — do not delete the step instead.
//  2. If `beforeAll` fails, an agreement record was edited or expired.
//  3. If the out-of-scope test fails, a negotiated price has been attached to
//     the wrong account — check which account the run log says it resolved.
//
// ---------------------------------------------------------------------------
//
// CONTRACTED PRICING — SBQQ__ContractedPrice__c.
//
// A contracted price is account-scoped pricing that overrides the price book
// without touching it. It comes in two shapes, and this org has one of each on
// GenePoint:
//
//   * PRODUCT-SPECIFIC. CP-00000 names PRINTERTONER and sets a flat 100.
//   * FILTER-BASED. CP-00001 names no product at all — it matches Product
//     Family 'Miscellaneous' and takes 5% off every line that qualifies.
//
// Four claims:
//
//   1. Both write to SBQQ__SpecialPrice__c and leave SBQQ__ListPrice__c at the
//      price book value. The PAIR is the claim — asserting the special price
//      alone would not distinguish contracted pricing from a rule that
//      overwrote both.
//   2. The filter discounts every matching product without naming any of them.
//   3. The two DO NOT STACK on a line that could match both.
//   4. Neither applies to an account outside their scope.
//
// WHY CLAIM 3 IS TESTABLE AT ALL
// -------------------------------
// PRINTERTONER is Product Family 'Consumable', not 'Miscellaneous', so it is
// matched by the specific record and NOT by the filter. The guard asserts that
// non-overlap explicitly rather than trusting it: if the two overlapped by
// construction, "they do not stack" could not be told apart from "only one of
// them happened to apply", and the test would be reporting a coincidence.
//
// ASSERT RELATIONALLY WHERE THE VALUE IS DERIVED
// -----------------------------------------------
// The filter's effect is asserted per product as "this line's special price is
// its OWN list price less 5%", computed from the line's own
// SBQQ__ListPrice__c. Two literals (47.50 and 14.25) would fail the moment the
// catalogue is repriced, while the behaviour was intact. The flat contracted
// price IS a literal, because a flat price is what that record configures —
// and it comes from the guard's reading of the record, not from a number typed
// into a spec.
//
// THE ASSERTION CADENCE
// ---------------------
// Every test here commits, so every assertion is a record assertion. The
// drawer is opened for EVIDENCE only: every field the source document reads
// from it exists on the quote line, so there is nothing the drawer can tell us
// that the record cannot tell us better.
const { test, expect } = require('../../src/fixtures/cpqFixtures');
const { loadJson } = require('../../src/utils/dataProvider');
const { quoteSimpleProducts, requireLine } = require('../../src/flows');
const { product, requireNumber, requireString } = require('../../src/utils/pricingData');
const {
  assertContractedPricingConfig,
  assertExpiredContractedPrice,
} = require('../../src/utils/pricingConfig');
const { expectMoney, expectMoneyNot } = require('../pricing/expectations');
const { captureEvidence } = require('../../src/utils/evidence');
const { runId } = require('../../src/utils/runContext');
const { escapeSoql } = require('../../src/utils/waitForAsync');
const session = require('../../.auth/sf-session.json');

const SOURCE = 'data/pricing-methods.json';
const data = loadJson('pricing-methods.json');
const SCENARIO = data.scenarios.contractedPricing;
const EXPECT = SCENARIO.expect;

const NO_GROUP = null;

const TIMEOUT_MS = requireNumber(
  data.timeouts.contractedPricingSessionMinutes, 'timeouts.contractedPricingSessionMinutes', SOURCE
) * 60_000;

const LINE_FIELDS = [
  'Id',
  'SBQQ__ProductCode__c',
  'SBQQ__Quantity__c',
  'SBQQ__ListPrice__c',
  'SBQQ__OriginalPrice__c',
  'SBQQ__SpecialPrice__c',
  'SBQQ__SpecialPriceType__c',
  'SBQQ__NetPrice__c',
  'SBQQ__NetTotal__c',
];

let evidenceOrdinal = 0;
const evidenceName = (slug) => `${String(++evidenceOrdinal).padStart(2, '0')}-${slug}`;

const lineSoql = (quoteId, where) =>
  `SELECT ${LINE_FIELDS.join(', ')} FROM SBQQ__QuoteLine__c ` +
  `WHERE SBQQ__Quote__c = '${escapeSoql(quoteId)}'${where ? ` AND ${where}` : ''}`;

/** The four products every quote in this file carries, in one selection round. */
function quotedProducts() {
  return [
    product(data, EXPECT.inScope.specific.productKey, SOURCE),
    ...EXPECT.inScope.filterMatched.productKeys.map((key) => product(data, key, SOURCE)),
    product(data, EXPECT.inScope.control.productKey, SOURCE),
  ];
}

/**
 * True when a line shows no sign of any contracted adjustment.
 *
 * MEASURED on 2026-08-02, and it corrected this helper: CPQ populates
 * SBQQ__SpecialPrice__c on EVERY line, defaulted to the list price. ROUTER on
 * an account with no contracted price at all comes back as
 * ListPrice=100, OriginalPrice=100, SpecialPrice=100 — so an earlier version
 * that required the special price to be NULL failed both tests on a line that
 * was behaving perfectly.
 *
 * The right test is therefore RELATIONAL in both halves: the list price has
 * not moved off the price book value, and the special price has not been
 * discounted BELOW the list price. A null special price still counts as
 * unadjusted, since some lines genuinely have none.
 */
function hasNoContractedAdjustment(line) {
  const special = line.SBQQ__SpecialPrice__c;
  const list = Number(line.SBQQ__ListPrice__c);
  const listUnmoved = list === Number(line.SBQQ__OriginalPrice__c);
  const specialUnadjusted =
    special === null || special === undefined || Number(special) >= list;
  return listUnmoved && specialUnadjusted;
}

let config;

test.describe('Contracted pricing', {
  tag: ['@type:regression', '@domain:pricing', '@speed:slow'],
}, () => {
  test.beforeAll(async ({ sf }) => {
    config = await assertContractedPricingConfig(sf, {
      accountName: requireString(
        data.accounts.genepoint.name, 'accounts.genepoint.name', SOURCE
      ),
      specific: {
        productCode: product(data, EXPECT.inScope.specific.productKey, SOURCE).productCode,
        price: requireNumber(
          EXPECT.inScope.specific.contractedPrice,
          'scenarios.contractedPricing.expect.inScope.specific.contractedPrice', SOURCE
        ),
      },
      filter: {
        field: 'Product Family',
        value: 'Miscellaneous',
        operator: 'equals',
        discount: requireNumber(
          EXPECT.inScope.filterMatched.discountPercent,
          'scenarios.contractedPricing.expect.inScope.filterMatched.discountPercent', SOURCE
        ),
      },
      source: SOURCE,
    });
  });

  // ==========================================================================
  // Test 1 — both mechanisms apply, and neither touches the list price
  // ==========================================================================
  test('a contracted price overrides through special price and leaves list price alone',
    { tag: ['@risk:high'] },
    async ({ cpqData, sf, quotePage, quoteLineEditor, productSelection }, testInfo) => {
      test.setTimeout(TIMEOUT_MS);
      cpqData.setStage('pricing');

      const specific = product(data, EXPECT.inScope.specific.productKey, SOURCE);
      const control = product(data, EXPECT.inScope.control.productKey, SOURCE);
      const matched = EXPECT.inScope.filterMatched.productKeys.map((k) => product(data, k, SOURCE));
      const discount = requireNumber(
        EXPECT.inScope.filterMatched.discountPercent,
        'scenarios.contractedPricing.expect.inScope.filterMatched.discountPercent', SOURCE
      );

      const result = await quoteSimpleProducts(
        { cpqData, sf, quotePage, quoteLineEditor, productSelection },
        {
          instanceUrl: session.instanceUrl,
          account: data.accounts.genepoint,
          accountKey: 'genepoint',
          opportunityName: `${requireString(
            SCENARIO.opportunityBaseName, 'scenarios.contractedPricing.opportunityBaseName', SOURCE
          )} ${runId()}`,
          products: quotedProducts(),
          closeDateOffsetDays: data.closeDateOffsetDays,
        }
      );
      const quoteId = result.quoteId;

      const lines = await sf.query(lineSoql(quoteId));
      const byCode = Object.fromEntries(lines.map((l) => [l.SBQQ__ProductCode__c, l]));
      console.log(
        `[contracted pricing] in scope on "${result.account.name}": ` +
          lines.map((l) =>
            `${l.SBQQ__ProductCode__c} list=${l.SBQQ__ListPrice__c} ` +
            `special=${l.SBQQ__SpecialPrice__c} type=${l.SBQQ__SpecialPriceType__c}`
          ).join(' | ')
      );

      // ---- the product-specific record ---------------------------------------
      await test.step(`${specific.productCode} takes its flat contracted price`, async () => {
        const line = requireLine(byCode, specific.productCode, 'product-specific contracted price');
        const contracted = Number(config.specific.SBQQ__Price__c);

        expectMoney(
          line.SBQQ__SpecialPrice__c, contracted,
          `${specific.productCode} SBQQ__SpecialPrice__c should be the flat contracted price from ` +
            `${config.specific.Name} (${contracted})`
        );

        // The other half of the pair. Contracted pricing writes to the special
        // price ONLY; a list price that moved would mean something overwrote
        // the price book, which is a different mechanism entirely.
        expectMoney(
          line.SBQQ__ListPrice__c, Number(line.SBQQ__OriginalPrice__c),
          `${specific.productCode} SBQQ__ListPrice__c must still equal SBQQ__OriginalPrice__c — a ` +
            'contracted price overrides through the special price and leaves the price book value ' +
            'untouched'
        );

        // ---- claim 3: the two do not stack ----------------------------------
        //
        // BOTH halves. Asserting only that the price is the flat 100 would
        // pass if the flat price and the discounted price happened to
        // coincide, which is exactly the coincidence this scenario is about.
        const ifStacked = Number(line.SBQQ__ListPrice__c) * (1 - discount / 100);
        expectMoneyNot(
          line.SBQQ__SpecialPrice__c, ifStacked,
          `${specific.productCode} must NOT be its list price less the filter's ${discount}% ` +
            `(${ifStacked}). It is matched by the product-specific record, and the two mechanisms ` +
            'must not stack. (Product Family is ' +
            `'${(config.specific.SBQQ__Product__r || {}).Family}', outside the filter's ` +
            `'${config.filter.SBQQ__FilterValue__c}', so only the flat price should apply.)`
        );

        await captureEvidence(
          await quoteLineEditor.lineDrawerShot(NO_GROUP, specific.productCode),
          testInfo, evidenceName(`${EXPECT.inScope.evidence}-${specific.productCode.toLowerCase()}`)
        );
      });

      // ---- the filter-based record -------------------------------------------
      for (const item of matched) {
        await test.step(`${item.productCode} takes the filter's ${discount}% without being named`, async () => {
          const line = requireLine(byCode, item.productCode, 'filter-matched contracted price');

          // RELATIONALLY, from the line's own list price — so this survives a
          // catalogue reprice that a literal would not.
          expectMoney(
            line.SBQQ__SpecialPrice__c,
            Number(line.SBQQ__ListPrice__c) * (1 - discount / 100),
            `${item.productCode} SBQQ__SpecialPrice__c should be its OWN list price ` +
              `(${line.SBQQ__ListPrice__c}) less ${discount}%, applied by ${config.filter.Name}, ` +
              `which matches ${config.filter.SBQQ__FilterField__c} ` +
              `${config.filter.SBQQ__Operator__c} '${config.filter.SBQQ__FilterValue__c}' and ` +
              'names no product at all'
          );

          expectMoney(
            line.SBQQ__ListPrice__c, Number(line.SBQQ__OriginalPrice__c),
            `${item.productCode} SBQQ__ListPrice__c must still equal SBQQ__OriginalPrice__c`
          );

          await captureEvidence(
            await quoteLineEditor.lineDrawerShot(NO_GROUP, item.productCode),
            testInfo, evidenceName(`${EXPECT.inScope.evidence}-${item.productCode.toLowerCase()}`)
          );
        });
      }

      // ---- the out-of-filter control -----------------------------------------
      await test.step(`${control.productCode} is outside both and is left alone`, async () => {
        const line = requireLine(byCode, control.productCode, 'contracted pricing control');
        expect(
          hasNoContractedAdjustment(line),
          `${control.productCode} is in a Product Family outside the filter and has no contracted ` +
            'price record of its own, so it should carry no adjustment at all — but it reads ' +
            `SBQQ__ListPrice__c=${line.SBQQ__ListPrice__c}, ` +
            `SBQQ__OriginalPrice__c=${line.SBQQ__OriginalPrice__c}, ` +
            `SBQQ__SpecialPrice__c=${line.SBQQ__SpecialPrice__c}`
        ).toBe(true);
      });

      // ======================================================================
      // Test 2's work, continuing in the SAME session — the percentage is
      // per-unit rather than a one-off adjustment.
      // ======================================================================
      const quantityStep = EXPECT.quantity;
      const target = product(data, quantityStep.productKey, SOURCE);
      const quantity = requireNumber(
        quantityStep.quantity, 'scenarios.contractedPricing.expect.quantity.quantity', SOURCE
      );

      await test.step(
        `the ${discount}% still holds on ${target.productCode} at quantity ${quantity}`,
        async () => {
          await quoteLineEditor.setQuantity(NO_GROUP, target.productCode, quantity);
          await quoteLineEditor.calculate();
          await quoteLineEditor.save();

          await sf.pollForRecord(
            lineSoql(quoteId, `SBQQ__ProductCode__c = '${escapeSoql(target.productCode)}' ` +
              `AND SBQQ__Quantity__c = ${quantity}`),
            {
              label:
                `${target.productCode} at quantity ${quantity} — a timeout with the quantity ` +
                'unchanged means the click-to-edit cell was missed rather than the org being slow',
            }
          );

          const [line] = await sf.query(
            lineSoql(quoteId, `SBQQ__ProductCode__c = '${escapeSoql(target.productCode)}'`)
          );

          expectMoney(
            line.SBQQ__SpecialPrice__c,
            Number(line.SBQQ__ListPrice__c) * (1 - discount / 100),
            `${target.productCode} at quantity ${quantity}: the contracted discount is a PER-UNIT ` +
              'percentage, so the special price must still be the unit list price less ' +
              `${discount}% — not the discount spread across the quantity`
          );

          // The unit price relationship is the claim; the total is what would
          // expose a discount that had been applied once rather than per unit.
          expectMoney(
            line.SBQQ__NetTotal__c, Number(line.SBQQ__NetPrice__c) * quantity,
            `${target.productCode} SBQQ__NetTotal__c should be the discounted unit price times ` +
              `${quantity}`
          );

          await captureEvidence(
            quoteLineEditor.lineTable(NO_GROUP), testInfo, evidenceName(quantityStep.evidence)
          );
        }
      );
    });

  // ==========================================================================
  // Test 3 — neither mechanism travels beyond its account
  // ==========================================================================
  test('neither contracted price applies to an account outside their scope',
    { tag: ['@type:negative'] },
    async ({ cpqData, sf, quotePage, quoteLineEditor, productSelection }, testInfo) => {
      test.setTimeout(TIMEOUT_MS);
      cpqData.setStage('pricing');

      const result = await quoteSimpleProducts(
        { cpqData, sf, quotePage, quoteLineEditor, productSelection },
        {
          instanceUrl: session.instanceUrl,
          account: data.accounts.contractedOutOfScope,
          accountKey: 'contractedOutOfScope',
          opportunityName: `${SCENARIO.opportunityBaseName} out of scope ${runId()}`,
          products: quotedProducts(),
          closeDateOffsetDays: data.closeDateOffsetDays,
        }
      );

      // The account is the ONLY difference from test 1, so it is worth stating
      // in the output — it is what the negative rests on.
      expect(
        result.account.name,
        'the out-of-scope test must not resolve to the very account the contracted prices are ' +
          'configured on, or it would assert that they do NOT apply where they do'
      ).not.toBe(data.accounts.genepoint.name);
      console.log(
        `[contracted pricing] out of scope: quoting "${result.account.name}", where the ` +
          `SBQQ__ContractedPrice__c records on "${data.accounts.genepoint.name}" must not reach.`
      );

      const lines = await sf.query(lineSoql(result.quoteId));
      expect(lines.length, 'expected all four products on the out-of-scope quote').toBe(4);

      for (const line of lines) {
        expect(
          hasNoContractedAdjustment(line),
          `${line.SBQQ__ProductCode__c} on "${result.account.name}" carries a contracted ` +
            'adjustment it should not: ' +
            `SBQQ__ListPrice__c=${line.SBQQ__ListPrice__c}, ` +
            `SBQQ__OriginalPrice__c=${line.SBQQ__OriginalPrice__c}, ` +
            `SBQQ__SpecialPrice__c=${line.SBQQ__SpecialPrice__c}. A contracted price is scoped to ` +
            'its own account; reaching this one would mean the scoping is not being applied.'
        ).toBe(true);
      }

      await captureEvidence(
        quoteLineEditor.lineTable(NO_GROUP), testInfo, evidenceName(EXPECT.outOfScope.evidence)
      );
    });

  // ==========================================================================
  // Source scenario 8 — expiration windowing
  // ==========================================================================
  //
  // Two claims that only mean anything together:
  //
  //   1. A line priced TODAY, after the window closed, does NOT get the
  //      contracted price.
  //   2. A line priced while the window was OPEN keeps what it was given.
  //
  // This shipped as a @wip fixme until 2026-08-02, and the blocker was never
  // technical: a test cannot create a record in the past, and creating the
  // contracted price itself would have violated this suite's read-only
  // configuration policy. Both records were staged by hand instead —
  // CP-00002's expiration moved to 2026-08-01, and Q-00415 created while the
  // price was still live. This spec READS both and writes neither.
  //
  // WHY THE GUARD IS NOT OPTIONAL HERE
  // -----------------------------------
  // "The contracted price did not apply" is ALSO what you observe when the
  // record was never there, when it names a different product, or when the
  // expiry has not passed yet. All three would make claim 1 pass while proving
  // nothing at all. assertExpiredContractedPrice() rules them out before the
  // browser opens, which is what makes a green run here mean something.
  test('an expired contracted price stops applying to new lines',
    { tag: ['@risk:high'] },
    async ({ cpqData, sf, quotePage, quoteLineEditor, productSelection }, testInfo) => {
      test.setTimeout(TIMEOUT_MS);
      cpqData.setStage('pricing');

      const plan = SCENARIO.expiration;
      const item = product(data, plan.productKey, SOURCE);
      const contracted = requireNumber(
        plan.contractedPrice, 'scenarios.contractedPricing.expiration.contractedPrice', SOURCE
      );

      // ---- the precondition, before any browser --------------------------
      const expired = await assertExpiredContractedPrice(sf, {
        accountName: requireString(data.accounts.genepoint.name, 'accounts.genepoint.name', SOURCE),
        productCode: item.productCode,
        contractedPrice: contracted,
        source: SOURCE,
      });

      // ======================================================================
      // Claim 2 — the grandfathered line still carries the price
      // ======================================================================
      //
      // Read first, because it is what proves the contracted price was REAL
      // and was reaching this product. Without it, claim 1 below is just a
      // line at its list price with no story attached.
      await test.step('a line priced before the expiry keeps the contracted price', async () => {
        const quoteName = requireString(
          plan.grandfatheredQuoteName,
          'scenarios.contractedPricing.expiration.grandfatheredQuoteName', SOURCE
        );

        const [staged] = await sf.query(
          'SELECT Id, Name FROM SBQQ__Quote__c ' +
            `WHERE Name = '${escapeSoql(quoteName)}' LIMIT 1`
        );
        if (!staged) {
          throw new Error(
            `The hand-staged quote "${quoteName}" is missing from this org. It was created while ` +
              `${expired.Name} was still live, and it is the ONLY evidence that the contracted ` +
              'price ever applied to this product — without it, the assertion below degrades to ' +
              '"a line costs its list price", which is true of almost every line. Re-stage it (see ' +
              `the _staging note in ${SOURCE}) rather than deleting this step.`
          );
        }

        // READ ONLY. Registered as existing so it lands in the ledger with
        // sweepEligible = false — the sweeper must never reclaim a fixture.
        cpqData.registerExisting('SBQQ__Quote__c', staged.Id, { name: staged.Name });

        const [line] = await sf.query(
          lineSoql(staged.Id, `SBQQ__ProductCode__c = '${escapeSoql(item.productCode)}'`)
        );
        expect(
          line,
          `the staged quote "${quoteName}" has no ${item.productCode} line`
        ).toBeTruthy();
        console.log(
          `[contracted expiration] grandfathered line on ${quoteName}: ` +
            `list=${line.SBQQ__ListPrice__c} special=${line.SBQQ__SpecialPrice__c} ` +
            `type=${line.SBQQ__SpecialPriceType__c}`
        );

        const expected = plan.expect.grandfathered;
        expectMoney(
          line.SBQQ__SpecialPrice__c,
          requireNumber(
            expected.SBQQ__SpecialPrice__c,
            'scenarios.contractedPricing.expiration.expect.grandfathered.SBQQ__SpecialPrice__c',
            SOURCE
          ),
          `${item.productCode} on "${quoteName}" should STILL carry the contracted price from ` +
            `${expired.Name}, even though it expired on ${expired.SBQQ__ExpirationDate__c} — the ` +
            'price was stamped onto the line when it was calculated, and an expiry does not ' +
            'reach back and re-price lines that already exist'
        );

        // The TYPE names the mechanism. 200 could in principle arrive some
        // other way; 'Contracted Price' could not.
        expect(
          line.SBQQ__SpecialPriceType__c,
          `${item.productCode} on "${quoteName}" should carry SBQQ__SpecialPriceType__c naming ` +
            'the mechanism, not merely a number that happens to match'
        ).toBe(requireString(
          expected.SBQQ__SpecialPriceType__c,
          'scenarios.contractedPricing.expiration.expect.grandfathered.SBQQ__SpecialPriceType__c',
          SOURCE
        ));

        expectMoney(
          line.SBQQ__ListPrice__c,
          requireNumber(
            expected.SBQQ__ListPrice__c,
            'scenarios.contractedPricing.expiration.expect.grandfathered.SBQQ__ListPrice__c', SOURCE
          ),
          `${item.productCode} on "${quoteName}": the list price is untouched even here — ` +
            'contracted pricing has only ever written to the special price'
        );
      });

      // ======================================================================
      // Claim 1 — a quote created TODAY does not get it
      // ======================================================================
      const afterExpiry = plan.expect.afterExpiry;
      const result = await quoteSimpleProducts(
        { cpqData, sf, quotePage, quoteLineEditor, productSelection },
        {
          instanceUrl: session.instanceUrl,
          account: data.accounts.genepoint,
          accountKey: 'genepoint',
          opportunityName: `${SCENARIO.opportunityBaseName} expired ${runId()}`,
          products: [item],
          closeDateOffsetDays: data.closeDateOffsetDays,
        }
      );

      const fresh = requireLine(
        result.linesByCode, item.productCode, 'expired contracted price'
      );
      console.log(
        `[contracted expiration] line priced today: list=${fresh.SBQQ__ListPrice__c} ` +
          `orig=${fresh.SBQQ__OriginalPrice__c} special=${fresh.SBQQ__SpecialPrice__c} ` +
          `type=${fresh.SBQQ__SpecialPriceType__c}`
      );

      expectMoney(
        fresh.SBQQ__ListPrice__c,
        requireNumber(
          afterExpiry.SBQQ__ListPrice__c,
          'scenarios.contractedPricing.expiration.expect.afterExpiry.SBQQ__ListPrice__c', SOURCE
        ),
        `${item.productCode} priced today should come back at its own PricebookEntry.UnitPrice — ` +
          `${expired.Name} expired on ${expired.SBQQ__ExpirationDate__c} and must no longer reach it`
      );

      // BOTH halves. The list price alone would not distinguish "the expired
      // price correctly did not apply" from "it applied and happened to equal
      // the list price" — the TYPE is what rules the second one out.
      expect(
        fresh.SBQQ__SpecialPriceType__c,
        `${item.productCode} priced today carries SBQQ__SpecialPriceType__c = ` +
          `'${fresh.SBQQ__SpecialPriceType__c}' with SBQQ__SpecialPrice__c = ` +
          `${fresh.SBQQ__SpecialPrice__c}. ${expired.Name} expired on ` +
          `${expired.SBQQ__ExpirationDate__c}, so no contracted price should have been applied at ` +
          'all — an expired window is still being honoured as if it were open'
      ).not.toBe(requireString(
        afterExpiry.specialPriceTypeIsNot,
        'scenarios.contractedPricing.expiration.expect.afterExpiry.specialPriceTypeIsNot', SOURCE
      ));

      // And it must not be the contracted NUMBER either, whatever the type says.
      expectMoneyNot(
        fresh.SBQQ__SpecialPrice__c, contracted,
        `${item.productCode} priced today must not be the expired contracted price ${contracted}`
      );

      // The same relational check the out-of-scope test uses: no contracted
      // adjustment of ANY kind, which also rules out CP-00001's family filter
      // reaching a product outside its family.
      expect(
        hasNoContractedAdjustment(fresh),
        `${item.productCode} priced today should carry no contracted adjustment at all: ` +
          `SBQQ__ListPrice__c=${fresh.SBQQ__ListPrice__c}, ` +
          `SBQQ__OriginalPrice__c=${fresh.SBQQ__OriginalPrice__c}, ` +
          `SBQQ__SpecialPrice__c=${fresh.SBQQ__SpecialPrice__c}`
      ).toBe(true);

      await captureEvidence(
        quoteLineEditor.lineTable(NO_GROUP), testInfo, evidenceName('contracted-price-expired')
      );
    });
});
