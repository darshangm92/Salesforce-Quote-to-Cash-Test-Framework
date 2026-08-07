// tests/pricing-methods/percent-of-total.spec.js
//
// WHAT THIS PROVES
// ----------------
// Shipping insurance has no price of its own — it costs a percentage of the
// hardware it is insuring. This proves CPQ works that percentage out from the
// right set of lines: it counts the hardware, ignores everything that is not
// hardware however expensive that is, and follows the price the customer is
// ACTUALLY paying rather than the catalogue price, so a discount on the
// hardware reduces the insurance too. It also proves the insurance stops
// growing once it reaches its own listed maximum.
//
// WHY IT MATTERS
// --------------
// A derived price that counts the wrong lines is invisible on the quote — the
// number looks reasonable, and only someone recomputing it by hand would
// notice. Counting too much overcharges the customer; counting a discounted
// line at full price quietly does the same.
//
// HOW IT WORKS
// ------------
// Two tests. The first adds the insurance alongside a hardware line, checks the
// derived price, then discounts the hardware and checks the insurance follows
// it down. The second builds a quote with both counting and non-counting lines,
// grows each in turn, and checks only the counting ones move the insurance —
// finishing by growing one far enough to hit the cap. Every expectation is
// computed from what the other lines actually netted, read back through `sf`,
// rather than from a fixed number: a fixed number would fail the moment the
// catalogue changed, while the behaviour was perfectly intact.
//
// IF THIS FAILS, LOOK HERE FIRST
// ------------------------------
//  1. If `beforeAll` fails, the configuration moved — the percentage, the
//     category, or which products carry it. The message names the record.
//  2. If the derived price is wrong but the printed base is right, the
//     percentage changed. If the BASE is wrong, a product joined or left the
//     insured category — the run prints every contributing line and its total.
//  3. If only the capped step fails, compare the insurance product's own
//     catalogue price against the cap the test read live from the org.
//
// ---------------------------------------------------------------------------
//
// PERCENT OF TOTAL — Product2.SBQQ__PricingMethod__c = 'Percent Of Total'.
//
// A percent-of-total product has no price of its own. CPQ sums the quote lines
// that share its SBQQ__SubscriptionCategory__c, takes a configured percentage
// of that sum, and writes the result to the derived line's list price. Four
// claims follow:
//
//   1. The derived price is that percentage of the contributing lines' total.
//   2. The base is NET, not list — so a discount on a contributing line moves
//      the derived price.
//   3. A line WITHOUT the category contributes nothing, however large it is.
//   4. With SBQQ__DynamicPricingConstraint__c = 'List price is maximum', the
//      derived price stops at the product's own price book price.
//
// ASSERT RELATIONALLY, NOT AGAINST LITERALS. THIS IS THE POINT OF THIS FILE.
// --------------------------------------------------------------------------
// The source document's expected prices are literals — $250, $500. They are
// deliberately NOT the primary assertion here.
//
// A literal is only meaningful as a percentage of what the contributing lines
// ACTUALLY netted. The moment a contributor's pricing method, price book entry
// or discount changes, a literal fails while the behaviour is perfectly
// intact — the false alarm tests/pricing/no-rule-fires.spec.js exists to
// avoid. And this org already demonstrates it: FIREWALL carries the Insurance
// category AND SBQQ__PricingMethod__c = 'Cost', so any literal reasoned from
// its 2400 list price is already wrong today.
//
// So the primary assertion is always percent x SUM(contributors'
// SBQQ__NetTotal__c), every term read from one query over the quote's own
// lines. The cap is relational too: it asserts the value equals Shipping
// Insurance's PricebookEntry.UnitPrice read live, never the literal 500.
// Literals survive only as a gated secondary check on the first reading, and
// the gate is the guard's report of whether every contributor is still on List
// pricing. When it is not, the check is SKIPPED and the reason logged. Never
// failed — a catalogue change is not a pricing defect.
//
// CATEGORY MEMBERSHIP COMES FROM Product2, NOT FROM THE QUOTE LINE.
// -----------------------------------------------------------------
// Measured 2026-08-02: SBQQ__QuoteLine__c.SBQQ__SubscriptionCategory__c offers
// only [Hardware|Software] in this org, while Product2's offers
// [Hardware|Software|Insurance|Warranty]. Reading the LINE field to decide who
// contributes would find 'Insurance' missing and conclude that nothing does.
// So the sum is taken over lines whose PRODUCT carries the category, resolved
// through SBQQ__Product__r in the same query.
//
// THE ASSERTION CADENCE — ASSERT IN THE API, WITH A NAMED DISPLAYED-ONLY SET
// ---------------------------------------------------------------------------
// Commit points — Quick Save or Save followed by a poll — assert on records.
// The intermediate quantity steps assert on DISPLAYED values through
// capturePrices(). A displayed value proves the editor resolved the price, not
// that the record holds it. That is weaker, and it is the trade for not
// spending a save-and-poll cycle on every step of a five-step sweep. No step
// is downgraded to an evidence capture with no assertion.
const { test, expect } = require('../../src/fixtures/cpqFixtures');
const { loadJson } = require('../../src/utils/dataProvider');
const { quoteSimpleProducts, requireLine } = require('../../src/flows');
const { product, requireNumber, requireString } = require('../../src/utils/pricingData');
const { assertPercentOfTotalConfig } = require('../../src/utils/pricingConfig');
const { expectMoney, expectDisplayedMoney, expectSelectionRow, parseDisplayedMoney } = require('../pricing/expectations');
const { captureEvidence } = require('../../src/utils/evidence');
const { runId } = require('../../src/utils/runContext');
const { escapeSoql } = require('../../src/utils/waitForAsync');
const session = require('../../.auth/sf-session.json');

const SOURCE = 'data/pricing-methods.json';
const data = loadJson('pricing-methods.json');
const SCENARIO = data.scenarios.percentOfTotal;
const EXPECT = SCENARIO.expect;
const POT = data.products.shippingInsurance.percentOfTotal;

const NO_GROUP = null;

const TIMEOUT_MS = requireNumber(
  data.timeouts.percentOfTotalSessionMinutes, 'timeouts.percentOfTotalSessionMinutes', SOURCE
) * 60_000;

// Every field the base sum and the assertions need, plus the product's own
// category so membership is decided from Product2 (see the header).
const LINE_FIELDS = [
  'Id',
  'SBQQ__ProductCode__c',
  'SBQQ__Quantity__c',
  'SBQQ__ListPrice__c',
  'SBQQ__SpecialPrice__c',
  'SBQQ__NetPrice__c',
  'SBQQ__NetTotal__c',
  'SBQQ__Product__r.SBQQ__SubscriptionCategory__c',
  'SBQQ__Product__r.SBQQ__PricingMethod__c',
];

let evidenceOrdinal = 0;
const evidenceName = (slug) => `${String(++evidenceOrdinal).padStart(2, '0')}-${slug}`;

function lineSoql(quoteId, where) {
  return (
    `SELECT ${LINE_FIELDS.join(', ')} FROM SBQQ__QuoteLine__c ` +
    `WHERE SBQQ__Quote__c = '${escapeSoql(quoteId)}'${where ? ` AND ${where}` : ''}`
  );
}

/** The category a line's PRODUCT carries, or null. */
const lineCategory = (line) =>
  (line.SBQQ__Product__r && line.SBQQ__Product__r.SBQQ__SubscriptionCategory__c) || null;

/**
 * The base: summed net of every line carrying the category, EXCLUDING the
 * derived line itself.
 *
 * Excluding it matters — Shipping Insurance carries the very category it sums,
 * so including its own line would make the base depend on the answer.
 */
function summedBase(lines, category, derivedCode) {
  const contributors = lines.filter(
    (l) => lineCategory(l) === category && l.SBQQ__ProductCode__c !== derivedCode
  );
  const total = contributors.reduce((sum, l) => sum + Number(l.SBQQ__NetTotal__c || 0), 0);
  return { total, contributors };
}

/** One line of run output describing exactly how a base was arrived at. */
function describeBase(label, base, category) {
  return (
    `[percent of total] ${label}: base = ${base.total} from ${base.contributors.length} ` +
    `'${category}' line(s) — ` +
    (base.contributors
      .map((c) => `${c.SBQQ__ProductCode__c} qty ${c.SBQQ__Quantity__c} net ${c.SBQQ__NetTotal__c}`)
      .join('; ') || '(none)')
  );
}

let config;

test.describe('Percent of total', {
  tag: ['@type:regression', '@domain:pricing', '@speed:slow'],
}, () => {
  // `sf` alone — worker-scoped and API-only — so a configuration mismatch
  // fails before Playwright launches a browser.
  test.beforeAll(async ({ sf }) => {
    config = await assertPercentOfTotalConfig(sf, {
      productCode: requireString(
        data.products.shippingInsurance.productCode, 'products.shippingInsurance.productCode', SOURCE
      ),
      percent: requireNumber(POT.percent, 'products.shippingInsurance.percentOfTotal.percent', SOURCE),
      base: requireString(POT.base, 'products.shippingInsurance.percentOfTotal.base', SOURCE),
      category: requireString(POT.category, 'products.shippingInsurance.percentOfTotal.category', SOURCE),
      constraint: requireString(
        POT.constraint, 'products.shippingInsurance.percentOfTotal.constraint', SOURCE
      ),
      contributorCodes: [
        data.products.firewall.productCode,
        data.products.laptop13.productCode,
        data.products.laptop15.productCode,
      ],
      // The control's ABSENCE from the category is the entire exclusion claim.
      excludedCodes: [data.products.control.productCode],
      source: SOURCE,
    });
  });

  // ==========================================================================
  // Test 1 — the derivation, and that the base is Net
  // ==========================================================================
  test('the derived price is a percentage of the categorized lines\' net',
    { tag: ['@risk:high'] },
    async ({ cpqData, sf, page, quotePage, quoteLineEditor, productSelection }, testInfo) => {
      test.setTimeout(TIMEOUT_MS);
      cpqData.setStage('pricing');

      const step = EXPECT.derivation;
      const derived = product(data, 'shippingInsurance', SOURCE);
      const contributor = product(data, step.contributorKey, SOURCE);
      const control = product(data, 'control', SOURCE);
      const category = POT.category;
      const percent = requireNumber(POT.percent, 'products.shippingInsurance.percentOfTotal.percent', SOURCE);

      const result = await quoteSimpleProducts(
        { cpqData, sf, quotePage, quoteLineEditor, productSelection },
        {
          instanceUrl: session.instanceUrl,
          account: data.accounts.percentOfTotal,
          accountKey: 'percentOfTotal',
          opportunityName: `${requireString(
            SCENARIO.opportunityBaseName, 'scenarios.percentOfTotal.opportunityBaseName', SOURCE
          )} ${runId()}`,
          products: [derived, contributor, control],
          closeDateOffsetDays: data.closeDateOffsetDays,

          // The grid is the only place the derived product's own price book
          // price is visible — and it is the value CPQ is about to ignore.
          onSelectionRow: async ({ product: item, rowText }) => {
            if (item.productCode !== derived.productCode) return;
            expectSelectionRow(rowText, item, item.pricebookPrice);
            await captureEvidence(page, testInfo, evidenceName('selection-shipping-insurance'));
          },
        }
      );

      const quoteId = result.quoteId;

      // ---- the first reading -------------------------------------------------
      let lines = await sf.query(lineSoql(quoteId));
      let base = summedBase(lines, category, derived.productCode);
      const derivedLine = requireLine(
        Object.fromEntries(lines.map((l) => [l.SBQQ__ProductCode__c, l])),
        derived.productCode,
        'percent-of-total derivation'
      );

      // Required by the data file, and the reason is in its _logContributorState
      // note: a Cost-method product with no markup entered contributes an
      // amount this suite has not measured, and a base nobody can explain is a
      // base nobody will trust when an assertion eventually fails.
      const contributorLine = requireLine(
        Object.fromEntries(lines.map((l) => [l.SBQQ__ProductCode__c, l])),
        contributor.productCode,
        'percent-of-total contributor'
      );
      console.log(
        `[percent of total] contributor ${contributor.productCode} ` +
          `(${(contributorLine.SBQQ__Product__r || {}).SBQQ__PricingMethod__c} pricing): ` +
          `SBQQ__ListPrice__c=${contributorLine.SBQQ__ListPrice__c}, ` +
          `SBQQ__SpecialPrice__c=${contributorLine.SBQQ__SpecialPrice__c}, ` +
          `SBQQ__NetTotal__c=${contributorLine.SBQQ__NetTotal__c}`
      );
      console.log(describeBase('first reading', base, category));

      // PRIMARY: relational.
      expectMoney(
        derivedLine.SBQQ__ListPrice__c,
        (base.total * percent) / 100,
        `${derived.productCode} SBQQ__ListPrice__c should be ${percent}% of the summed net of the ` +
          `'${category}' lines (${base.total}), from ` +
          base.contributors.map((c) => `${c.SBQQ__ProductCode__c}=${c.SBQQ__NetTotal__c}`).join(' + ')
      );

      // SECONDARY: the source document's literal, gated on the contributors
      // still being on List pricing. Skipped-and-logged, never failed.
      if (config.literalsSafe && !isPlaceholderLike(step.literal)) {
        expectMoney(derivedLine.SBQQ__ListPrice__c, Number(step.literal),
          `${derived.productCode}: the source document's literal expectation`);
      } else {
        console.log(
          `[percent of total] literal check SKIPPED: contributors are ` +
            `${config.contributors.map((c) => `${c.productCode}=${c.pricingMethod}`).join(', ')}. ` +
            'A literal reasoned from list prices cannot be right when a contributor prices from ' +
            'cost, and failing here would report a catalogue change as a pricing defect.'
        );
      }

      await captureEvidence(
        quoteLineEditor.lineTable(NO_GROUP), testInfo, evidenceName(step.evidence)
      );

      // ---- the discount step: prove the base is NET -------------------------
      const discountStep = step.discountStep;
      await test.step(
        `a discount on ${contributor.productCode} moves the base, and the derived price with it`,
        async () => {
          const before = { base: base.total, derived: Number(derivedLine.SBQQ__ListPrice__c) };

          await quoteLineEditor.setQuantity(NO_GROUP, contributor.productCode, discountStep.quantity);
          await quoteLineEditor.applyAdditionalDiscount(
            NO_GROUP, contributor.productCode,
            requireNumber(discountStep.additionalDiscount,
              'scenarios.percentOfTotal.expect.derivation.discountStep.additionalDiscount', SOURCE)
          );
          await quoteLineEditor.calculate();

          // Displayed reading first — the intermediate cadence.
          const shown = await quoteLineEditor.capturePrices(NO_GROUP);
          expect(
            shown[derived.productCode],
            `the editor rendered no row for ${derived.productCode}`
          ).toBeTruthy();

          await quoteLineEditor.quickSave();

          lines = await sf.pollForRecords(
            lineSoql(quoteId, `SBQQ__ProductCode__c = '${escapeSoql(contributor.productCode)}' ` +
              `AND SBQQ__Quantity__c = ${discountStep.quantity}`),
            {
              label:
                `${contributor.productCode} at quantity ${discountStep.quantity} after the discount ` +
                '— if this times out with the quantity unchanged, the click-to-edit cell was ' +
                'missed rather than the org being slow; if it times out with the priced fields ' +
                'null, Quick Save did not persist the calculator output and the fix is a full ' +
                'save() here, not a longer poll',
            }
          ).then(() => sf.query(lineSoql(quoteId)));

          const after = summedBase(lines, category, derived.productCode);
          console.log(describeBase('after discount', after, category));

          const derivedAfter = requireLine(
            Object.fromEntries(lines.map((l) => [l.SBQQ__ProductCode__c, l])),
            derived.productCode, 'percent-of-total after discount'
          );

          // BOTH halves. The base must actually have moved, or "the derived
          // price tracked the base" is a claim about two unchanged numbers.
          expect(
            after.total,
            `the summed '${category}' base should have changed after a quantity of ` +
              `${discountStep.quantity} and a ${discountStep.additionalDiscount}% discount on ` +
              `${contributor.productCode}, but it is still ${before.base}. A Net base is what this ` +
              'whole step tests; if the base did not move, either the discount did not land or the ' +
              'base is not Net.'
          ).not.toBe(before.base);

          expectMoney(
            derivedAfter.SBQQ__ListPrice__c,
            (after.total * percent) / 100,
            `${derived.productCode} SBQQ__ListPrice__c should track the new summed net ` +
              `(${after.total}) at ${percent}% — the base is '${POT.base}', so a discount on a ` +
              'contributing line must move it'
          );

          await captureEvidence(
            quoteLineEditor.lineTable(NO_GROUP), testInfo, evidenceName(discountStep.evidence)
          );
        }
      );
    });

  // ==========================================================================
  // Test 2 — only categorized lines contribute, and the cap binds
  // ==========================================================================
  test('uncategorized lines contribute nothing and the price book price caps the result',
    { tag: ['@risk:high'] },
    async ({
      cpqData, sf, page, quotePage, quoteLineEditor, productSelection, productConfiguration,
    }, testInfo) => {
      test.setTimeout(TIMEOUT_MS);
      cpqData.setStage('pricing');

      const plan = EXPECT.categoryAndCap;
      const derived = product(data, plan.derived, SOURCE);
      const control = product(data, plan.control, SOURCE);
      const contributors = plan.contributors.map((key) => product(data, key, SOURCE));
      const category = POT.category;
      const percent = requireNumber(POT.percent, 'products.shippingInsurance.percentOfTotal.percent', SOURCE);

      // The contributors and the control go in FIRST; the percent-of-total
      // product follows in a SECOND round, so the percentage calculates
      // against lines that are already present.
      const result = await quoteSimpleProducts(
        { cpqData, sf, quotePage, quoteLineEditor, productSelection, productConfiguration },
        {
          instanceUrl: session.instanceUrl,
          account: data.accounts.percentOfTotal,
          accountKey: 'percentOfTotal',
          opportunityName: `${SCENARIO.opportunityBaseName} cap ${runId()}`,
          bundles: contributors.filter((c) => data.products[c.key].bundle),
          products: [control, ...contributors.filter((c) => !data.products[c.key].bundle)],
          closeDateOffsetDays: data.closeDateOffsetDays,
        }
      );
      const quoteId = result.quoteId;

      // ---- the second round, in the spec because the flow does one round ----
      await test.step(`add ${derived.productCode} in a second selection round`, async () => {
        await quoteLineEditor.openAddProducts(NO_GROUP);
        await productSelection.waitForReady();
        await productSelection.selectProduct(derived);
        await productSelection.waitForNotBusy();
        await productSelection.confirmButton().click();
        await productSelection.waitForLightningReady();
        await quoteLineEditor.waitForCalculation();
        await quoteLineEditor.quickSave();

        await sf.pollForRecords(
          lineSoql(quoteId, `SBQQ__ProductCode__c = '${escapeSoql(derived.productCode)}'`),
          { label: `the ${derived.productCode} line added in the second round` }
        );
      });

      const readAll = async () => {
        const lines = await sf.query(lineSoql(quoteId));
        const byCode = Object.fromEntries(lines.map((l) => [l.SBQQ__ProductCode__c, l]));
        return { lines, byCode, base: summedBase(lines, category, derived.productCode) };
      };

      const capPrice = Number(config.pricebookEntry.UnitPrice);

      // ---- baseline ----------------------------------------------------------
      let state = await readAll();
      console.log(describeBase('baseline', state.base, category));

      // WHICH product codes contribute, decided ONCE from the committed
      // baseline and reused for every displayed reading afterwards.
      //
      // Category membership is a property of Product2 and cannot change during
      // the test, so resolving it once here is safe — and it is the only way
      // to compute a base from the EDITOR, whose rows carry no category. It
      // also picks up any bundle option line that happens to carry the
      // category, which a data-file list of codes would have missed.
      const contributingCodes = state.base.contributors.map((c) => c.SBQQ__ProductCode__c);
      console.log(
        `[percent of total] contributing product codes: ${contributingCodes.join(', ') || '(none)'}`
      );

      /**
       * The base as the EDITOR currently shows it.
       *
       * Uncommitted steps must not read the record: the editor holds the edit
       * client-side and the record still carries the pre-edit values, so a
       * record read on an uncommitted step reports the state BEFORE the step
       * as though it were the state after. That is why an uncommitted step
       * reads displayed values, and it is not optional here — it is the
       * difference between asserting on this step and asserting on the last one.
       */
      const displayedBase = (shown) => {
        const parts = contributingCodes.map((code) => {
          const row = shown[code];
          const value = row ? parseDisplayedMoney(row.netTotal) : null;
          if (value === null) {
            throw new Error(
              `The editor showed no readable Net Total for contributing line "${code}" ` +
                `(cell: ${JSON.stringify(row && row.netTotal)}). The displayed base cannot be ` +
                'summed without it, and treating a missing cell as zero would silently shrink ' +
                'the base and make the derived price look correct for the wrong reason.'
            );
          }
          return { code, value };
        });
        return {
          total: parts.reduce((sum, p) => sum + p.value, 0),
          parts,
        };
      };
      expectMoney(
        state.byCode[derived.productCode].SBQQ__ListPrice__c,
        (state.base.total * percent) / 100,
        `${derived.productCode} baseline: ${percent}% of the summed '${category}' net ` +
          `(${state.base.total})`
      );
      await captureEvidence(
        quoteLineEditor.lineTable(NO_GROUP), testInfo, evidenceName(plan.steps[0].evidence)
      );

      // ---- the quantity manipulations ---------------------------------------
      for (const stepPlan of plan.steps.slice(1)) {
        const target = product(data, stepPlan.product, SOURCE);

        await test.step(`${stepPlan.step} (${target.productCode} -> ${stepPlan.quantity})`, async () => {
          // The BEFORE reading comes from the editor, not the record, for the
          // same reason the AFTER reading does — on an uncommitted step the
          // record is one step stale in both directions.
          const shownBefore = await quoteLineEditor.capturePrices(NO_GROUP);
          const derivedBefore = parseDisplayedMoney(shownBefore[derived.productCode].listPrice);
          const targetBefore = parseDisplayedMoney(shownBefore[target.productCode].netTotal);

          await quoteLineEditor.setQuantity(NO_GROUP, target.productCode, stepPlan.quantity);
          await quoteLineEditor.calculate();

          const shown = await quoteLineEditor.capturePrices(NO_GROUP);
          const shownDerived = shown[derived.productCode];
          expect(shownDerived, `the editor rendered no row for ${derived.productCode}`).toBeTruthy();

          const base = displayedBase(shown);
          const derivedAfter = parseDisplayedMoney(shownDerived.listPrice);
          console.log(
            `[percent of total] ${stepPlan.step}: displayed base = ${base.total} from ` +
              `${base.parts.map((p) => `${p.code}=${p.value}`).join(' + ')}; ` +
              `${derived.productCode} = ${derivedAfter}`
          );

          if (target.productCode === control.productCode) {
            // BOTH halves, per the data file's note. Asserting only that the
            // derived value held would pass if the quantity edit had silently
            // failed — which is exactly how a missed click-to-edit presents,
            // and exactly what this caught on the first run.
            expect(
              parseDisplayedMoney(shown[control.productCode].netTotal),
              `${control.productCode} carries no '${category}' category, so raising its quantity to ` +
                `${stepPlan.quantity} must raise its OWN net total — otherwise the quantity edit ` +
                'never landed and the exclusion assertion below would pass for the wrong reason'
            ).toBeGreaterThan(targetBefore);

            expectDisplayedMoney(
              shownDerived.listPrice, derivedBefore,
              `${derived.productCode} must be UNCHANGED when an uncategorized line grows. ` +
                `${control.productCode} has no SBQQ__SubscriptionCategory__c, so it contributes ` +
                'nothing to the base however large it gets'
            );
          } else {
            // A categorized contributor grew. Either the derivation tracks it,
            // or the cap has bound.
            const uncapped = (base.total * percent) / 100;
            if (uncapped > capPrice) {
              expectDisplayedMoney(
                shownDerived.listPrice, capPrice,
                `${derived.productCode} should be CAPPED at its own PricebookEntry.UnitPrice ` +
                  `(${capPrice}) — ${percent}% of the displayed '${category}' base (${base.total}) ` +
                  `would be ${uncapped}, and SBQQ__DynamicPricingConstraint__c is ` +
                  `'${POT.constraint}'. Read live from the org, never a literal.`
              );
            } else {
              expectDisplayedMoney(
                shownDerived.listPrice, uncapped,
                `${derived.productCode} should track the displayed '${category}' base ` +
                  `(${base.total}) at ${percent}%, still under the ${capPrice} cap`
              );
              expect(
                derivedAfter,
                `${derived.productCode} should have RISEN when a categorized contributor grew ` +
                  `(was ${derivedBefore})`
              ).toBeGreaterThan(derivedBefore);
            }
          }

          await captureEvidence(
            quoteLineEditor.lineTable(NO_GROUP), testInfo, evidenceName(stepPlan.evidence)
          );

          // ---- and only now, if this step commits, the RECORD -----------------
          if (!stepPlan.commit) return;

          await quoteLineEditor[stepPlan.commit === 'save' ? 'save' : 'quickSave']();
          await sf.pollForRecords(
            lineSoql(quoteId, `SBQQ__ProductCode__c = '${escapeSoql(target.productCode)}' ` +
              `AND SBQQ__Quantity__c = ${stepPlan.quantity}`),
            {
              label:
                `${target.productCode} at quantity ${stepPlan.quantity} — a timeout with the ` +
                'quantity unchanged means the click-to-edit cell was missed; a timeout with ' +
                'the priced fields null means Quick Save did not persist the calculator ' +
                'output, and the fix is a full save() here rather than a longer poll',
            }
          );

          const after = await readAll();
          console.log(describeBase(`${stepPlan.step} (committed)`, after.base, category));
          const recordDerived = Number(after.byCode[derived.productCode].SBQQ__ListPrice__c);
          const recordUncapped = (after.base.total * percent) / 100;

          expectMoney(
            recordDerived,
            recordUncapped > capPrice ? capPrice : recordUncapped,
            `${derived.productCode} SBQQ__ListPrice__c on the SAVED record after ${stepPlan.step}: ` +
              `${percent}% of the summed '${category}' net (${after.base.total})` +
              (recordUncapped > capPrice ? `, capped at the price book price ${capPrice}` : '')
          );
        });
      }
    });
});

/** Local placeholder probe — the data file may omit `literal` entirely. */
function isPlaceholderLike(value) {
  return value === undefined || value === null ||
    (typeof value === 'string' && /^\s*(\[SPECIFY\]|PLACEHOLDER)/i.test(value));
}
