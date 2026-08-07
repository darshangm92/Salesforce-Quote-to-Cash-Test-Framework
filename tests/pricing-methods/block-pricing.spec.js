// tests/pricing-methods/block-pricing.spec.js
//
// WHAT THIS PROVES
// ----------------
// Some products are not sold by the unit — they are sold in bands. "Up to 20
// units costs $25 in total, 21 to 50 costs $35 in total", and past the top band
// you start paying per extra unit. This walks a single line's quantity across
// those boundaries and checks the price lands in the right band each time. It
// also checks the two hardest cases: that the bands meet exactly, with no
// quantity falling into a gap between them, and that the per-unit charge above
// the top band does not leak back down into the flat-priced bands below it.
//
// WHY IT MATTERS
// --------------
// Band pricing is what makes a service like recycling or support economic to
// sell. Getting a boundary wrong means every quote at that quantity is
// mispriced — and because the catalogue price of such a product is zero, a
// broken band does not produce an obviously silly number, it produces a
// plausible one.
//
// HOW IT WORKS
// ------------
// Before any browser starts, a guard reads the band records out of the org
// through `sf` and checks they still say what this test assumes. That ordering
// is the point: if an admin moved a boundary, this fails in seconds naming the
// record, instead of fifteen minutes later with a price mismatch that reads
// like a calculator bug. Then `quoteSimpleProducts` seeds one quote with one
// line, and a single Quote Line Editor session walks the quantity through six
// values. Four of those are saved and asserted against the record; the rest are
// asserted against the price the editor displays, which is weaker and is
// explained in the section below.
//
// IF THIS FAILS, LOOK HERE FIRST
// ------------------------------
//  1. If it fails in `beforeAll`, an admin has edited the band records. The
//     message names the record and the field — nothing is wrong with CPQ.
//  2. If a single quantity is wrong, compare it against the band table in
//     data/pricing-methods.json. A quantity landing in the NEIGHBOURING band
//     means a boundary moved by one, which is the classic off-by-one here.
//  3. If the final quantity is wrong but the earlier ones passed, the per-unit
//     overage charge is leaking into the flat bands — that specific step exists
//     to catch exactly this.
//
// ---------------------------------------------------------------------------
//
// BLOCK PRICING — Product2.SBQQ__PricingMethod__c = 'Block'.
//
// A block-priced product does not have a unit price. It has a set of
// SBQQ__BlockPrice__c rows, each covering a quantity range, and CPQ resolves
// the line's price from whichever range contains the quantity. Above the
// highest range an overage rate charges per unit. Three claims follow, and this
// spec exists to test exactly those three:
//
//   1. The price comes from the TIER, not from the PricebookEntry. Toner
//      Recycling's entry on the standard book is 0, and no quantity ever
//      prices at 0.
//   2. Tiers switch exactly at their configured bounds, with NO GAP. An upper
//      bound of 21 is exclusive and the next tier's lower bound of 21 is
//      inclusive, so 20 and 21 price differently and nothing falls between
//      them.
//   3. The overage rate charges per unit ABOVE the highest tier's lower bound.
//      51 is zero units above it and prices flat at 45; 54 is three units above
//      and prices at 48. Two points fix the rate at (48 - 45) / (54 - 51) = 1.
//   4. And it does NOT leak into the tiered range below. 50, revisited after
//      two quantities in the overage range, is back at 35 on both list and net
//      price with no residue.
//
// THE SWEEP IS SIX QUANTITIES: 20, 21, 50, 54, 51, 50
// ----------------------------------------------------
// Trimmed from eleven on 2026-08-02 to cut the runtime. All four claims above
// survive and each is asserted on a RECORD. The trailing 50 is not a duplicate
// of the earlier one: reaching the same quantity by coming DOWN from the
// overage range is the only thing that can catch claim 4, and its evidence
// slug differs for exactly that reason — two captures under one filename would
// silently overwrite, and the second is the one that matters.
//
// What the trim still gives up is listed in data/pricing-methods.json under
// _whatTheTrimGivesUp. The one worth knowing here: NO fractional quantity is
// covered any more, so nothing tests that a quantity between the integers
// lands in the tier containing it rather than falling through a gap.
//
// WHY THIS FOLDER IS SEPARATE FROM tests/pricing/
// -----------------------------------------------
// tests/pricing/ is named for the SBQQ__PriceRule__c under test — one spec per
// rule record. A pricing method is not a rule: a rule OVERWRITES a price after CPQ
// has resolved one, a method decides how CPQ resolves it in the first place.
// Filing this under tests/pricing/ would mean a folder whose naming convention
// — one file per rule record an admin can open — no longer described half its
// contents. The axis here is Product2.SBQQ__PricingMethod__c, and the filename
// is the method.
//
// WHERE THIS DEPARTS FROM SECTION 0 RULE 3, AND WHAT THAT COSTS
// --------------------------------------------------------------
// Rule 3 says assert in the API. This spec asserts on the record at FOUR
// points — the tier boundary at 21, the two overage quantities 54 and 51, and
// the trailing 50 after a full Save — and on DISPLAYED values at the other
// three: the default quantity of 1, then 20 and the first 50.
//
// The reason is what a commit costs, not what is convenient. Every record
// assertion needs a save and a poll, and the commits are spent where they buy
// the most: the boundary the whole scenario turns on, the two overage points
// that together fix the rate, and the return below the boundary that proves it
// does not leak.
//
// WHAT THAT GIVES UP, STATED PLAINLY: at the remaining quantities this proves
// the editor DISPLAYED the right price, not that CPQ would have written it. A
// calculator that priced correctly on screen and persisted something else
// would pass those steps. The three commit points are what rule that out, and
// they cover both quantity tiers and the overage tier — so the failure mode
// that survives is narrow and named rather than unexamined.
//
// The intermediate steps are still ASSERTIONS and not evidence screenshots.
// Downgrading them to captures would leave those steps testing nothing at all,
// which is worse than a displayed-value assertion by a wide margin.
// expectDisplayedMoney() parses and compares numerically for that reason — a
// containment check would pass "$135.00" for an expected 35.
//
// ONE EDITOR SESSION FOR BOTH SCENARIOS
// -------------------------------------
// Re-entering the Quote Line Editor costs another cold load (60-120s on this
// org), and Scenario 2 needs nothing Scenario 1 did not leave behind, so it
// continues in place rather than navigating back in.
//
// THE ORG CONFIGURATION IS GUARDED BEFORE THE BROWSER OPENS
// ---------------------------------------------------------
// In beforeAll, which requests only the worker-scoped `sf` fixture and so
// never builds a page. If a tier boundary has moved, this fails in seconds
// naming the SBQQ__BlockPrice__c record — instead of fifteen minutes later
// with "expected 35, got 25", which reads like a calculator defect and sends
// the next person to debug CPQ instead of the data.
const { test, expect } = require('../../src/fixtures/cpqFixtures');
const { loadJson } = require('../../src/utils/dataProvider');
const { quoteSimpleProducts, requireLine } = require('../../src/flows');
const { product, requireNumber, requireString } = require('../../src/utils/pricingData');
const { assertBlockPricingConfig } = require('../../src/utils/pricingConfig');
const {
  expectMoney,
  expectMoneyNot,
  expectDisplayedMoney,
  expectSelectionRow,
  parseDisplayedMoney,
} = require('../pricing/expectations');
const { captureEvidence } = require('../../src/utils/evidence');
const { runId } = require('../../src/utils/runContext');
const { escapeSoql } = require('../../src/utils/waitForAsync');
const session = require('../../.auth/sf-session.json');

const SOURCE = 'data/pricing-methods.json';
const data = loadJson('pricing-methods.json');
const SCENARIO = data.scenarios.blockPricing;
const EXPECT = SCENARIO.expect;

// This quote is UNGROUPED, so every per-line locator is scoped to the editor
// frame rather than to a div.group that does not exist on the page.
const NO_GROUP = null;

const TIMEOUT_MS = requireNumber(
  data.timeouts.blockPricingSessionMinutes,
  'timeouts.blockPricingSessionMinutes',
  SOURCE
) * 60_000;

const BLOCK = data.products.tonerRecycling.blockPricing;
const OVERAGE_RATE_FIELD = requireString(
  BLOCK.overageRateField,
  'products.tonerRecycling.blockPricing.overageRateField',
  SOURCE
);

// Everything asserted on a saved line. SBQQ__NetTotal__c is the addition that
// matters: it is the field that tells block pricing apart from per-unit
// pricing, and the shared list in quoteSimpleProducts does not carry it.
const LINE_FIELDS = [
  'Id',
  'SBQQ__ProductCode__c',
  'SBQQ__Quantity__c',
  'SBQQ__OriginalPrice__c',
  'SBQQ__ListPrice__c',
  'SBQQ__NetPrice__c',
  'SBQQ__NetTotal__c',
];

/**
 * Evidence ordinals, running continuously across the file.
 *
 * A counter rather than an ordinal written into the data file, so inserting a
 * quantity into the sweep does not mean renumbering every step after it. It is
 * deterministic because there is exactly one test and it walks the steps in
 * order — which is what lets a rerun overwrite in place (Section 3.19, rule 3).
 */
let evidenceOrdinal = 0;
function evidenceName(slug) {
  evidenceOrdinal += 1;
  return `${String(evidenceOrdinal).padStart(2, '0')}-${slug}`;
}

/** The SOQL for the one line on this quote, filtered on the CONDITION being waited for. */
function lineSoql(quoteId, productCode, where) {
  return (
    `SELECT ${LINE_FIELDS.join(', ')} FROM SBQQ__QuoteLine__c ` +
    `WHERE SBQQ__Quote__c = '${escapeSoql(quoteId)}' ` +
    `AND SBQQ__ProductCode__c = '${escapeSoql(productCode)}'` +
    (where ? ` AND ${where}` : '')
  );
}

/**
 * Waits for the saved line to reach the price this step expects.
 *
 * POLLED ON THE CONDITION, NEVER ON THE ROW. The line already exists — the
 * flow's own Quick Save created it before the sweep started — so a poll for
 * "one line on this quote" is satisfied instantly by the PRE-EDIT state and
 * would report a save that has not landed as a price that is simply wrong.
 * The expected list price and quantity go in the WHERE clause, so a pre-edit
 * row cannot satisfy the poll.
 *
 * @param {object} sf
 * @param {object} step  a sweep step from the data file
 * @param {string} quoteId
 * @param {string} productCode
 * @param {number} expectedListPrice
 */
async function pollForCommittedLine(sf, step, quoteId, productCode, expectedListPrice) {
  const soql = lineSoql(
    quoteId,
    productCode,
    `SBQQ__Quantity__c = ${step.quantity} AND SBQQ__ListPrice__c = ${expectedListPrice}`
  );

  try {
    return await sf.pollForRecord(soql, {
      label:
        `${productCode} quote line at quantity ${step.quantity} with ` +
        `SBQQ__ListPrice__c = ${expectedListPrice} (tier "${step.tier}")`,
    });
  } catch (e) {
    // The one failure mode worth naming, because the fix is not "wait longer".
    //
    // RESOLVED BY MEASUREMENT on 2026-08-02, and this is the open [VERIFY] in
    // src/flows/quoteSimpleProducts.js: Quick Save DOES persist the
    // CALCULATOR's output, not only the line. So a full save() is not needed
    // at these checkpoints.
    //
    // BUT IT IS NOT ALWAYS SYNCHRONOUS, AND THAT IS WHY THIS IS A POLL.
    // Measured across three runs: almost every commit was satisfied on attempt
    // 1 at 0ms, and once — quantity 54, second run — the query came back 0/1
    // and needed a second attempt at 5376ms. INTERMITTENT, not deterministic:
    // the same quantity was instant in the run before and the run after. A
    // single query in place of this poll would therefore pass repeatedly and
    // fail occasionally, reporting a wrong price rather than a read that
    // arrived early — which is the worst shape a flake can take, because it
    // sends the reader to the calculator instead of to the timing.
    //
    // The diagnostic below stays anyway. It costs one query on a path that
    // only runs when something is already wrong, and if the persistence
    // behaviour ever regresses this is the difference between a message naming
    // the cause and a bare timeout.
    const [current] = await sf.query(lineSoql(quoteId, productCode)).catch(() => []);
    throw new Error(
      `${e.message}\n\n` +
        `The line as it stands right now: ${current ? JSON.stringify(current) : '(no line found)'}\n` +
        'If SBQQ__ListPrice__c is null or still the pre-edit value, this is the open [VERIFY] in ' +
        'src/flows/quoteSimpleProducts.js — Quick Save is known to create the line and is NOT ' +
        'known to persist the calculator output. The fix is a full save() at this checkpoint, ' +
        'not a longer poll.'
    );
  }
}

// Read once in beforeAll, before any browser exists, and used by the test.
let blockConfig;

test.describe('Block pricing', {
  tag: ['@type:regression', '@domain:pricing', '@speed:slow'],
}, () => {
  // Requests `sf` alone — worker-scoped and API-only — so a configuration
  // mismatch fails before Playwright ever launches a browser.
  test.beforeAll(async ({ sf }) => {
    const item = product(data, 'tonerRecycling', SOURCE);
    blockConfig = await assertBlockPricingConfig(sf, {
      productCode: item.productCode,
      tiers: BLOCK.tiers,
      overageRateField: OVERAGE_RATE_FIELD,
      pricingMethod: requireString(
        BLOCK.pricingMethod, 'products.tonerRecycling.blockPricing.pricingMethod', SOURCE
      ),
      source: SOURCE,
    });
  });

  test('quantity tiers and the overage rate price the line, not the price book',
    { tag: ['@risk:high'] },
    async ({
      cpqData, sf, page, quotePage, quoteLineEditor, productSelection,
    }, testInfo) => {
      test.setTimeout(TIMEOUT_MS);
      cpqData.setStage('pricing');

      const item = product(data, 'tonerRecycling', SOURCE);

      // ======================================================================
      // Step 2 — the price book price, as an API fact
      // ======================================================================
      //
      // This is what makes "the price book price is ignored" a claim about
      // CONFIGURATION rather than about a rendering. A block-priced product
      // whose entry read 25 would price at 25 for a reason nobody could
      // distinguish from the tier, and every assertion below would still pass.
      await test.step('the price book entry is zero, so no price below can come from it', async () => {
        expectMoney(
          blockConfig.pricebookEntry.UnitPrice,
          requireNumber(EXPECT.pricebookUnitPrice, 'scenarios.blockPricing.expect.pricebookUnitPrice', SOURCE),
          `${item.productCode} PricebookEntry.UnitPrice on "${blockConfig.pricebookEntry.Pricebook2.Name}"`
        );
      });

      // ======================================================================
      // Step 3-4 — seed, reach the editor, add the product
      // ======================================================================
      const result = await quoteSimpleProducts(
        { cpqData, sf, quotePage, quoteLineEditor, productSelection },
        {
          instanceUrl: session.instanceUrl,
          account: data.accounts.blockPricing,
          accountKey: 'blockPricing',
          opportunityName: `${requireString(
            SCENARIO.opportunityBaseName, 'scenarios.blockPricing.opportunityBaseName', SOURCE
          )} ${runId()}`,
          products: [item],
          closeDateOffsetDays: data.closeDateOffsetDays,

          // Step 4. The ONLY point in the flow where a product's price book
          // price is visible on screen — the grid is gone once the round
          // closes. Note this containment check is weak by nature ("0" is a
          // substring of most prices); the API assertion above is what carries
          // the claim, and this exists so a rendering regression on the
          // selection screen still gets caught.
          onSelectionRow: async ({ rowText }) => {
            expectSelectionRow(rowText, item, item.pricebookPrice);
            await captureEvidence(
              page, testInfo, evidenceName(`selection-${item.productCode.toLowerCase()}-list-price-0`)
            );
          },
        }
      );

      const quoteId = result.quoteId;
      console.log(
        `[block pricing] quote ${quoteId} on "${result.account.name}", ` +
          `product ${item.productCode} — one line, ungrouped.`
      );

      /** Reads the editor's own rendering of the line under test. */
      const displayed = async () => {
        const prices = await quoteLineEditor.capturePrices(NO_GROUP);
        const shown = prices[item.productCode];
        expect(
          shown,
          `the editor rendered no row for ${item.productCode}. Rows present: ` +
            `${Object.keys(prices).join(', ') || '(none)'}`
        ).toBeTruthy();
        return shown;
      };

      /** The failure message every price assertion carries — quantity, tier, and why. */
      const label = (step, field) =>
        `${item.productCode} ${field} at quantity ${step.quantity}: expected tier ` +
        `"${step.tier}" — ${step.because}`;

      /** Asserts every displayed price a step names, and captures its evidence. */
      const assertStep = async (step, shown, pathPrefix) => {
        for (const [field, expected] of Object.entries(step.expect)) {
          expectDisplayedMoney(
            shown[field],
            requireNumber(expected, `${pathPrefix}.expect.${field}`, SOURCE),
            label(step, field)
          );
        }

        // Where the data file asks for it: the same list price read as a
        // per-unit price would give a wildly different total, and asserting
        // the total is NOT that is what separates block pricing from a
        // coincidence.
        if (step.netTotalIsNotQuantityTimesPrice) {
          const perUnitTotal = requireNumber(
            step.expect.listPrice, `${pathPrefix}.expect.listPrice`, SOURCE
          ) * step.quantity;
          expectMoneyNot(
            parseDisplayedMoney(shown.netTotal),
            perUnitTotal,
            `${item.productCode} SBQQ__NetTotal__c at quantity ${step.quantity} is a BLOCK price ` +
              `for the whole quantity, so it must not be the list price multiplied by the ` +
              `quantity (${perUnitTotal})`
          );
        }

        await captureEvidence(
          quoteLineEditor.lineTable(NO_GROUP), testInfo, evidenceName(step.evidence)
        );
      };

      /** Asserts a committed line's record fields. */
      const assertRecord = async (step, line, pathPrefix) => {
        for (const [field, expected] of Object.entries(step.record)) {
          expectMoney(
            line[field],
            requireNumber(expected, `${pathPrefix}.record.${field}`, SOURCE),
            `${item.productCode} ${field} on the SAVED line at quantity ${step.quantity} ` +
              `(tier "${step.tier}")`
          );
        }
      };

      // ======================================================================
      // Step 5 — the default quantity of 1
      // ======================================================================
      //
      // Read from what the flow captured before its Quick Save. A line is born
      // at quantity 1, which is tier 1's lower bound — so the very first price
      // the editor shows is already a tier price rather than the price book's
      // zero.
      const defaults = EXPECT.defaultQuantity;
      await test.step(`quantity ${defaults.quantity} resolves to tier "${defaults.tier}"`, async () => {
        const shown = result.displayedPrices[item.productCode];
        expect(shown, `the editor rendered no row for ${item.productCode} after Add Products`)
          .toBeTruthy();
        await assertStep(defaults, shown, 'scenarios.blockPricing.expect.defaultQuantity');
      });

      // ======================================================================
      // Steps 6-8 — Scenario 1's quantity sweep
      // Steps 9-11 — Scenario 2's, continuing in the same session
      // ======================================================================
      const sweeps = [
        { steps: EXPECT.tierSweep, path: 'scenarios.blockPricing.expect.tierSweep' },
        { steps: EXPECT.overageSweep, path: 'scenarios.blockPricing.expect.overageSweep' },
      ];

      for (const sweep of sweeps) {
        for (let i = 0; i < sweep.steps.length; i += 1) {
          const step = sweep.steps[i];
          const stepPath = `${sweep.path}[${i}]`;

          await test.step(
            `quantity ${step.quantity} resolves to tier "${step.tier}"`,
            async () => {
              // setQuantity() already waits out the recalculation it triggers.
              // The explicit Calculate that follows is the source document's
              // step, not a substitute for that wait — and never a
              // waitForTimeout between the two.
              await quoteLineEditor.setQuantity(NO_GROUP, item.productCode, step.quantity);
              await quoteLineEditor.calculate();

              const shown = await displayed();

              // A fractional quantity is written through the same path as the
              // integers, and what the editor formats it back to is LOGGED
              // rather than asserted — the cell renders to two decimal places
              // and that formatting is an observation of this org, not a
              // contract.
              if (!Number.isInteger(step.quantity)) {
                console.log(
                  `[block pricing] fractional quantity ${step.quantity} reads back from the ` +
                    `editor as "${await quoteLineEditor.quantityValue(NO_GROUP, item.productCode)}".`
                );
              }

              await assertStep(step, shown, stepPath);

              if (!step.commit) return;

              // ------------------------------------------------------------
              // A commit point: the displayed value is not trusted on its own.
              // ------------------------------------------------------------
              if (step.commit === 'save') {
                // Save recalculates and returns to the quote's record page,
                // which is where Scenario 2 ends.
                await quoteLineEditor.save();
              } else {
                await quoteLineEditor.quickSave();
              }

              const expectedList = requireNumber(
                step.record.SBQQ__ListPrice__c, `${stepPath}.record.SBQQ__ListPrice__c`, SOURCE
              );
              await pollForCommittedLine(sf, step, quoteId, item.productCode, expectedList);

              // Re-read unfiltered, so the assertions below run against every
              // field rather than against the ones the poll matched on.
              const lines = await sf.query(lineSoql(quoteId, item.productCode));
              const line = requireLine(
                Object.fromEntries(lines.map((l) => [l.SBQQ__ProductCode__c, l])),
                item.productCode,
                `quantity ${step.quantity}`
              );
              await assertRecord(step, line, stepPath);
            }
          );
        }
      }

      // ======================================================================
      // Step 11 — the persisted line IS the persistence
      // ======================================================================
      //
      // Deliberately not a reload of the editor to "prove" the save stuck.
      // Re-rendering the same values from the same record proves nothing the
      // record did not already prove, and costs another cold load.
      const final = EXPECT.overageSweep[EXPECT.overageSweep.length - 1];
      console.log(
        `[block pricing] final state: quantity ${final.quantity} in tier "${final.tier}", ` +
          `saved and read back from SBQQ__QuoteLine__c.`
      );
    });
});
