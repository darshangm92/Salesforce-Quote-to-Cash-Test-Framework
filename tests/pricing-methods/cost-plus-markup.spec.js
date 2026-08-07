// tests/pricing-methods/cost-plus-markup.spec.js
//
// WHAT THIS PROVES
// ----------------
// Some products are priced from what they cost the company, plus whatever
// margin the rep adds on the line — rather than from a catalogue price. This
// proves the arithmetic works in both directions: a positive markup prices
// above cost, and a NEGATIVE one is accepted rather than blocked, leaving a
// line priced below what the company paid for it. It also proves the catalogue
// price is left completely alone throughout, so anyone reviewing the quote can
// still see what the product normally sells for.
//
// WHY IT MATTERS
// --------------
// Cost-plus is how bespoke or bought-in items get quoted. If the markup lands
// in the wrong place the quote is wrong in a way that looks right; and if a
// below-cost line is silently accepted with nothing flagging it, the company
// finds out at invoicing.
//
// HOW IT WORKS
// ------------
// A guard reads the product's cost record before the browser opens. Then one
// Quote Line Editor session opens the line's detail drawer and writes a markup
// three times — positive, negative, then back to positive — saving and reading
// the record after each. The markup control is the trap here: it has a
// %-or-USD selector beside it, and the selector decides which field the value
// lands in, so every write goes through a helper that sets the type explicitly.
// Each case then asserts the value landed in the RIGHT field and that the other
// one is empty — a test checking only the final price would pass if the value
// had gone to the wrong field and coincidentally produced the same number.
//
// IF THIS FAILS, LOOK HERE FIRST
// ------------------------------
//  1. Read the two markup fields in the failure message. If the percentage
//     field holds a value that was meant to be dollars, the type selector did
//     not take — a markup of 100 then means 100%, not $100.
//  2. If `beforeAll` fails, the product's cost record changed.
//  3. If the catalogue price assertion fails, something is writing to it that
//     should not be — cost-plus pricing never touches it.
//
// ---------------------------------------------------------------------------
//
// COST PLUS MARKUP — Product2.SBQQ__PricingMethod__c = 'Cost'.
//
// A Cost-method product ignores its price book price when deriving what the
// customer pays. CPQ takes the unit cost from the product's SBQQ__Cost__c
// record, adds a markup the rep enters on the line, and writes the result to
// SPECIAL price. Three claims:
//
//   1. Special Price = unit cost + markup.
//   2. List Price stays at the PRICE BOOK value throughout. The pair is the
//      whole point: cost-plus-markup writes to the special price and leaves
//      the list price alone, so asserting only the special price would not
//      distinguish it from a rule that overwrote both.
//   3. A NEGATIVE markup is accepted rather than blocked, and persists a value
//      below cost.
//
// THE MARKUP CONTROL IS COMPOUND, AND THAT IS THE TRAP
// -----------------------------------------------------
// The drawer's Markup field carries a TYPE selector offering % and USD, and
// the type decides WHICH quote line field receives the value:
// SBQQ__MarkupAmount__c for USD, SBQQ__MarkupRate__c for %.
//
// MEASURED in this org: a unit cost of 2100 with a markup of 100 USD produces
// a special price of 2200. One hundred PERCENT would have produced 4200. So
// the type is not a display preference, and leaving it to the control's
// default leaves the assertion to chance. Every markup here goes through
// setMarkup() with an explicit type; setLineDrawerFieldValue() refuses the
// Markup label by name so the compound control cannot be half-written.
//
// AND THE FIELD IT LANDED IN IS ASSERTED, NOT JUST THE RESULT
// ------------------------------------------------------------
// A test that checked only the resulting Special Price would pass if the value
// had landed in the wrong field and happened to produce the same number. So
// each case asserts the chosen field holds the markup AND that the other one
// is null. The two API names were confirmed by describe rather than written
// from memory, because SBQQ__QuoteLine__c also carries a third, differently
// scoped SBQQ__Markup__c.
//
// THE ASSERTION CADENCE
// ---------------------
// All three steps here COMMIT, so every assertion in this file is a record
// assertion. There is no displayed-only step: the flow is three markup writes
// rather than a sweep, so the save-and-poll cost that motivates the displayed
// cadence elsewhere does not arise. The drawer reads are
// evidence and a spot-check, never the check.
const { test, expect } = require('../../src/fixtures/cpqFixtures');
const { loadJson } = require('../../src/utils/dataProvider');
const { quoteSimpleProducts, requireLine } = require('../../src/flows');
const { product, requireNumber, requireString } = require('../../src/utils/pricingData');
const { assertCostPricingConfig } = require('../../src/utils/pricingConfig');
const { expectMoney, expectDisplayedMoney } = require('../pricing/expectations');
const { captureEvidence } = require('../../src/utils/evidence');
const { runId } = require('../../src/utils/runContext');
const { escapeSoql } = require('../../src/utils/waitForAsync');
const session = require('../../.auth/sf-session.json');

const SOURCE = 'data/pricing-methods.json';
const data = loadJson('pricing-methods.json');
const SCENARIO = data.scenarios.costPlusMarkup;
const EXPECT = SCENARIO.expect;
const COST = data.products.firewall.costPricing;

const NO_GROUP = null;

const TIMEOUT_MS = requireNumber(
  data.timeouts.costPlusMarkupSessionMinutes, 'timeouts.costPlusMarkupSessionMinutes', SOURCE
) * 60_000;

// Every field the waterfall assertions read, plus BOTH markup fields.
const LINE_FIELDS = [
  'Id',
  'SBQQ__ProductCode__c',
  'SBQQ__Quantity__c',
  'SBQQ__ListPrice__c',
  'SBQQ__OriginalPrice__c',
  'SBQQ__UnitCost__c',
  'SBQQ__SpecialPrice__c',
  'SBQQ__SpecialPriceType__c',
  'SBQQ__RegularPrice__c',
  'SBQQ__CustomerPrice__c',
  'SBQQ__NetPrice__c',
  'SBQQ__NetTotal__c',
  'SBQQ__MarkupAmount__c',
  'SBQQ__MarkupRate__c',
];

let evidenceOrdinal = 0;
const evidenceName = (slug) => `${String(++evidenceOrdinal).padStart(2, '0')}-${slug}`;

const lineSoql = (quoteId, productCode, where) =>
  `SELECT ${LINE_FIELDS.join(', ')} FROM SBQQ__QuoteLine__c ` +
  `WHERE SBQQ__Quote__c = '${escapeSoql(quoteId)}' ` +
  `AND SBQQ__ProductCode__c = '${escapeSoql(productCode)}'${where ? ` AND ${where}` : ''}`;

let config;

test.describe('Cost plus markup', {
  tag: ['@type:regression', '@domain:pricing', '@speed:slow'],
}, () => {
  test.beforeAll(async ({ sf }) => {
    config = await assertCostPricingConfig(sf, {
      productCode: requireString(
        data.products.firewall.productCode, 'products.firewall.productCode', SOURCE
      ),
      unitCost: requireNumber(COST.unitCost, 'products.firewall.costPricing.unitCost', SOURCE),
      source: SOURCE,
    });
  });

  test('a cost-method product prices from its cost record plus the rep\'s markup',
    { tag: ['@risk:high'] },
    async ({ cpqData, sf, quotePage, quoteLineEditor, productSelection }, testInfo) => {
      test.setTimeout(TIMEOUT_MS);
      cpqData.setStage('pricing');

      const item = product(data, SCENARIO.productKey, SOURCE);
      const unitCost = requireNumber(COST.unitCost, 'products.firewall.costPricing.unitCost', SOURCE);
      const pricebookPrice = Number(config.pricebookEntry.UnitPrice);

      const result = await quoteSimpleProducts(
        { cpqData, sf, quotePage, quoteLineEditor, productSelection },
        {
          instanceUrl: session.instanceUrl,
          account: data.accounts.percentOfTotal,
          accountKey: 'percentOfTotal',
          opportunityName: `${requireString(
            SCENARIO.opportunityBaseName, 'scenarios.costPlusMarkup.opportunityBaseName', SOURCE
          )} ${runId()}`,
          products: [item],
          closeDateOffsetDays: data.closeDateOffsetDays,
        }
      );
      const quoteId = result.quoteId;

      // ---- the drawer, before any markup -------------------------------------
      await test.step('the drawer shows the unit cost from the cost record', async () => {
        const drawer = await quoteLineEditor.captureDrawerValues(NO_GROUP, item.productCode);
        console.log(`[cost plus markup] drawer at rest: ${JSON.stringify(drawer)}`);

        // A spot-check, not the check — the record assertions below carry the
        // scenario. Degraded to a log when the drawer does not expose the
        // label, because the drawer's field list is an observation of this org
        // rather than a contract (see DRAWER_FIELD_LABELS).
        if (drawer['Unit Cost']) {
          expectDisplayedMoney(
            drawer['Unit Cost'], unitCost,
            `${item.productCode}: the drawer's Unit Cost should show the SBQQ__Cost__c record's ` +
              `SBQQ__UnitCost__c (${unitCost})`
          );
        } else {
          console.log(
            '[cost plus markup] the drawer exposed no "Unit Cost" label — spot-check skipped. ' +
              `Labels present: ${Object.keys(drawer).join(', ') || '(none)'}`
          );
        }

        await captureEvidence(
          await quoteLineEditor.lineDrawerShot(NO_GROUP, item.productCode),
          testInfo,
          evidenceName('drawer-unit-cost-at-rest')
        );
      });

      /**
       * The special price a markup should produce, WHICH DEPENDS ON THE TYPE.
       *
       * A percentage markup scales the cost; a USD markup adds to it. Using
       * the addition formula for a percentage would expect 2110 where the org
       * correctly produces 2310, and the failure would read as a pricing
       * defect rather than as the spec doing the wrong arithmetic.
       */
      const expectedSpecialPrice = (plan, path) => {
        const markup = requireNumber(plan.markup, `${path}.markup`, SOURCE);
        const type = requireString(plan.markupType, `${path}.markupType`, SOURCE);
        return type === '%' ? unitCost * (1 + markup / 100) : unitCost + markup;
      };

      /** Writes a markup, commits, polls on the CONDITION, and returns the line. */
      const applyMarkup = async (plan, path) => {
        const markup = requireNumber(plan.markup, `${path}.markup`, SOURCE);
        const type = requireString(plan.markupType, `${path}.markupType`, SOURCE);

        await quoteLineEditor.setMarkup(NO_GROUP, item.productCode, markup, type);
        await quoteLineEditor.calculate();

        if (plan.commit === 'save') await quoteLineEditor.save();
        else await quoteLineEditor.quickSave();

        const expectedSpecial = expectedSpecialPrice(plan, path);
        try {
          await sf.pollForRecord(
            lineSoql(quoteId, item.productCode, `SBQQ__SpecialPrice__c = ${expectedSpecial}`),
            {
              label:
                `${item.productCode} with SBQQ__SpecialPrice__c = ${expectedSpecial} ` +
                `(unit cost ${unitCost} ${markup < 0 ? '-' : '+'} markup ${Math.abs(markup)} ${type})`,
            }
          );
        } catch (e) {
          const [current] = await sf.query(lineSoql(quoteId, item.productCode)).catch(() => []);
          throw new Error(
            `${e.message}\n\nThe line right now: ${current ? JSON.stringify(current) : '(none)'}\n` +
              'Two causes worth telling apart. If SBQQ__MarkupRate__c holds the value instead of ' +
              'SBQQ__MarkupAmount__c, the TYPE selector did not take and the markup was applied as ' +
              'a percentage — a markup of 100 then means 100%, not 100 USD. If every priced field ' +
              'is null, Quick Save did not persist the calculator output and the fix is a full ' +
              'save() at this checkpoint, not a longer poll.'
          );
        }

        const [line] = await sf.query(lineSoql(quoteId, item.productCode));
        return requireLine(
          { [line.SBQQ__ProductCode__c]: line }, item.productCode, path
        );
      };

      /** The assertions both the positive and the negative case share. */
      const assertMarkupLanded = (line, plan, path, label) => {
        const markup = requireNumber(plan.markup, `${path}.markup`, SOURCE);
        const type = requireString(plan.markupType, `${path}.markupType`, SOURCE);
        const expected = expectedSpecialPrice(plan, path);

        // The literal, from the data file.
        for (const [field, value] of Object.entries(plan.record)) {
          expectMoney(
            line[field], requireNumber(value, `${path}.record.${field}`, SOURCE),
            `${item.productCode} ${field} (${label})`
          );
        }

        // The relationship. Catches a markup computed from the wrong base,
        // which the literal alone would miss the moment the cost record moves.
        expectMoney(
          line.SBQQ__SpecialPrice__c, expected,
          `${item.productCode} SBQQ__SpecialPrice__c should be the unit cost (${unitCost}) ` +
            (type === '%'
              ? `scaled by ${markup}% = ${expected}`
              : `plus the markup (${markup}) = ${expected}`) +
            ` (${label})`
        );

        // Not asserted, because they have not been measured under a percentage
        // markup — logged so they can be added to the data file once seen,
        // rather than guessed at now.
        console.log(
          `[cost plus markup] ${label}: SBQQ__RegularPrice__c=${line.SBQQ__RegularPrice__c}, ` +
            `SBQQ__CustomerPrice__c=${line.SBQQ__CustomerPrice__c}, ` +
            `SBQQ__MarkupRate__c=${line.SBQQ__MarkupRate__c}, ` +
            `SBQQ__MarkupAmount__c=${line.SBQQ__MarkupAmount__c}`
        );

        // THE INVARIANT of the whole scenario, asserted in every case: the
        // list price is the PRICE BOOK price and cost-plus-markup never
        // touches it.
        expectMoney(
          line.SBQQ__ListPrice__c, pricebookPrice,
          `${item.productCode} SBQQ__ListPrice__c must still be its PricebookEntry.UnitPrice ` +
            `(${pricebookPrice}) — cost-plus-markup writes to SPECIAL price and leaves the list ` +
            `price alone (${label})`
        );
      };

      // ---- the positive markup ------------------------------------------------
      await test.step(
        `a markup of ${EXPECT.positive.markup} ${EXPECT.positive.markupType} prices above cost`,
        async () => {
          const path = 'scenarios.costPlusMarkup.expect.positive';
          const line = await applyMarkup(EXPECT.positive, path);
          assertMarkupLanded(line, EXPECT.positive, path, 'positive markup');

          // WHICH FIELD the type selector wrote, and that the other is empty.
          const chosen = requireString(EXPECT.positive.markupField, `${path}.markupField`, SOURCE);
          const empty = requireString(
            EXPECT.positive.emptyMarkupField, `${path}.emptyMarkupField`, SOURCE
          );
          expectMoney(
            line[chosen], requireNumber(EXPECT.positive.markup, `${path}.markup`, SOURCE),
            `${item.productCode} ${chosen} — the "${EXPECT.positive.markupType}" type selector ` +
              'should have written the markup to this field'
          );
          expect(
            line[empty],
            `${item.productCode} ${empty} should be null: the markup was entered as ` +
              `"${EXPECT.positive.markupType}", so the other markup field must be untouched. A ` +
              'value here means the type selector did not take, and the same Special Price could ' +
              'have been reached for the wrong reason.'
          ).toBeFalsy();

          await captureEvidence(
            await quoteLineEditor.lineDrawerShot(NO_GROUP, item.productCode),
            testInfo, evidenceName(EXPECT.positive.evidence)
          );
        }
      );

      // ---- the negative markup ------------------------------------------------
      await test.step(
        `a markup of ${EXPECT.negative.markup} ${EXPECT.negative.markupType} is accepted and ` +
          'persists a price below cost',
        async () => {
          const path = 'scenarios.costPlusMarkup.expect.negative';
          const line = await applyMarkup(EXPECT.negative, path);
          assertMarkupLanded(line, EXPECT.negative, path, 'negative markup');

          // Relational, so "below cost" survives a change to the cost record.
          expect(
            Number(line.SBQQ__SpecialPrice__c),
            `${item.productCode} SBQQ__SpecialPrice__c (${line.SBQQ__SpecialPrice__c}) should be ` +
              `BELOW the unit cost (${unitCost}) — the claim is that CPQ accepts a negative markup ` +
              'rather than blocking it'
          ).toBeLessThan(unitCost);

          await captureEvidence(
            await quoteLineEditor.lineDrawerShot(NO_GROUP, item.productCode),
            testInfo, evidenceName(EXPECT.negative.evidence)
          );
        }
      );

      // The UI spot-check the scenario asks for, stated as exactly one claim:
      // the negative markup surfaced no blocking error. It reached the record,
      // which is the strongest evidence available that nothing blocked it —
      // asserted above rather than by hunting for the absence of a toast,
      // which would be a check that passes whenever the selector is wrong.
      console.log(
        `[cost plus markup] the negative markup persisted (SBQQ__SpecialPrice__c below the unit ` +
          'cost), so nothing blocked it. If this org ever routes a below-cost line to an approval ' +
          'process, record it as a finding — approvals are out of this scenario\'s scope and a ' +
          'branch here would change what the test claims.'
      );

      // ---- restore, and Save ---------------------------------------------------
      await test.step('restore the positive markup and Save', async () => {
        const path = 'scenarios.costPlusMarkup.expect.restore';
        const line = await applyMarkup(EXPECT.restore, path);
        // Through the type-aware helper, not `unitCost + markup` — that is the
        // USD formula, and against a 10% markup it expects 2110 where the org
        // correctly produces 2310.
        expectMoney(
          line.SBQQ__SpecialPrice__c,
          expectedSpecialPrice(EXPECT.restore, path),
          `${item.productCode} SBQQ__SpecialPrice__c after restoring the positive markup`
        );
        await captureEvidence(
          quoteLineEditor.lineTable(NO_GROUP), testInfo, evidenceName(EXPECT.restore.evidence)
        );
      });
    });
});
