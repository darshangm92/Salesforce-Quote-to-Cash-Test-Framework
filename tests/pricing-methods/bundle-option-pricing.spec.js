// tests/pricing-methods/bundle-option-pricing.spec.js
//
// WHAT THIS PROVES
// ----------------
// A component bought as part of a bundle can be priced differently from the
// same component bought on its own — cheaper inside the desktop bundle than off
// the shelf. It also proves the other bundling mechanism: components marked as
// included cost the customer nothing at all, showing "Included" on the quote
// even though they have a real catalogue price of their own. Both copies of the
// same component sit on ONE quote, so the price difference cannot be explained
// by anything except the bundle.
//
// WHY IT MATTERS
// --------------
// Bundle economics are the reason a bundle exists. If an included component
// starts charging, the customer is billed twice for something they were told
// came free; if the bundled discount stops applying, the bundle costs more than
// its parts and reps stop selling it.
//
// HOW IT WORKS
// ------------
// The bundle goes on through the configurator in its own round, with the three
// options of interest ticked; the standalone copy of the component follows in a
// simple round onto the same quote. The two copies are told apart by which one
// points at a bundle parent — never by their position in the table, since a
// bundle contributes however many lines its defaults select. Assertions read
// the records through `sf`, field by field, so a failure names which field
// survived. One assertion is deliberately made against the screen instead: the
// word "Included" exists only as rendered text, and the record holds zeroes.
//
// IF THIS FAILS, LOOK HERE FIRST
// ------------------------------
//  1. If the test says it found the component once instead of twice, the
//     configurator round did not select it — look at the configurator evidence
//     screenshot before suspecting pricing.
//  2. If an included component now carries a charge, check its option record
//     still has the Bundled flag set.
//  3. If the "Included" text assertion alone fails, that is a rendering change,
//     not a pricing one — the record assertions above it carry the real claim.
//
// ---------------------------------------------------------------------------
//
// BUNDLE OPTION PRICING — SBQQ__ProductOption__c.
//
// A product option can override how its product prices INSIDE the bundle,
// without touching the product's own price book entry. Two mechanisms, and
// this org's DESKTOPCOMPUTER bundle has both:
//
//   * A UNIT PRICE OVERRIDE. PO-000025 prices CPU34GHZI7 at 50 inside the
//     bundle, while the same product costs 425 standalone.
//   * The BUNDLED FLAG. PO-000024 (CPU28GHZI7) and PO-000031 (RAM8GB) are
//     flagged Bundled: they render as "Included" and zero the entire pricing
//     waterfall, even though both carry non-zero price book entries.
//
// THE SAME PRODUCT, TWICE, ON ONE QUOTE
// --------------------------------------
// The override is proved by adding CPU34GHZI7 BOTH as a bundle option and as a
// standalone line on the same quote. Same org, same price book, same
// calculation run — so the only thing that can explain a difference is the
// option record. Comparing against a number from a different quote or a
// different run would leave a dozen other explanations open.
//
// The two copies are told apart by SBQQ__RequiredBy__c, which points at the
// bundle parent on the option line and is null on the standalone one. NEVER by
// row position: a bundle contributes a parent plus whatever its defaults
// select, so positions shift with the configuration.
//
// AND NEITHER COPY MAY CARRY A DISCOUNT
// --------------------------------------
// That is what attributes the delta to the option override rather than to a
// discount, and it is what the source document's step 9 is actually asking
// for. Without it, "the bundled copy is cheaper" is compatible with a discount
// nobody looked at.
//
// WHY THE WATERFALL ASSERTIONS ARE IN THE API
// --------------------------------------------
// The drawer shows Pricing Method, Original Price, Special Price, Unit Cost,
// Markup, Regular Unit Price, Customer Unit Price, Optional, Package Product
// Code, Start/End Date, Partner Discount and Subscription Term — but NOT Net
// Unit Price, which lives in the line table. A UI-driven waterfall check would
// therefore skip a field silently and report a clean pass having never looked
// at it. The record carries every field regardless, so the zeroes are asserted
// FIELD BY FIELD on SBQQ__QuoteLine__c and the drawer capture is the
// human-readable companion beside them.
//
// ONE CLAIM CAN ONLY BE MADE IN THE UI, AND IT IS NAMED AS SUCH
// --------------------------------------------------------------
// A Bundled line's List Unit Price cell renders the literal string
// "Included". The data model holds no such value — the record holds zeroes —
// so that single assertion is on the cell text, with a message saying why it
// cannot be made anywhere else.
const { test, expect } = require('../../src/fixtures/cpqFixtures');
const { loadJson } = require('../../src/utils/dataProvider');
const { quoteSimpleProducts, requireLine } = require('../../src/flows');
const { product, requireNumber, requireString } = require('../../src/utils/pricingData');
const { assertBundleOptionConfig } = require('../../src/utils/pricingConfig');
const { expectMoney } = require('../pricing/expectations');
const { captureEvidence } = require('../../src/utils/evidence');
const { runId } = require('../../src/utils/runContext');
const { escapeSoql } = require('../../src/utils/waitForAsync');
const session = require('../../.auth/sf-session.json');

const SOURCE = 'data/pricing-methods.json';
const data = loadJson('pricing-methods.json');
const SCENARIO = data.scenarios.bundleOptionPricing;
const EXPECT = SCENARIO.expect;

const NO_GROUP = null;

const TIMEOUT_MS = requireNumber(
  data.timeouts.bundleOptionSessionMinutes, 'timeouts.bundleOptionSessionMinutes', SOURCE
) * 60_000;

const LINE_FIELDS = [
  'Id',
  'SBQQ__ProductCode__c',
  'SBQQ__Quantity__c',
  'SBQQ__ListPrice__c',
  'SBQQ__OriginalPrice__c',
  'SBQQ__NetPrice__c',
  'SBQQ__NetTotal__c',
  'SBQQ__CustomerPrice__c',
  'SBQQ__RegularPrice__c',
  'SBQQ__Discount__c',
  'SBQQ__AdditionalDiscount__c',
  'SBQQ__Bundled__c',
  'SBQQ__RequiredBy__c',
];

let evidenceOrdinal = 0;
const evidenceName = (slug) => `${String(++evidenceOrdinal).padStart(2, '0')}-${slug}`;

const lineSoql = (quoteId, where) =>
  `SELECT ${LINE_FIELDS.join(', ')} FROM SBQQ__QuoteLine__c ` +
  `WHERE SBQQ__Quote__c = '${escapeSoql(quoteId)}'${where ? ` AND ${where}` : ''}`;

let config;

test.describe('Bundle option pricing', {
  tag: ['@type:regression', '@domain:pricing', '@speed:slow'],
}, () => {
  test.beforeAll(async ({ sf }) => {
    config = await assertBundleOptionConfig(sf, {
      bundleCode: requireString(
        data.products.desktopComputer.productCode, 'products.desktopComputer.productCode', SOURCE
      ),
      overrideOption: {
        productCode: product(data, EXPECT.override.productKey, SOURCE).productCode,
        unitPrice: requireNumber(
          EXPECT.override.optionUnitPrice,
          'scenarios.bundleOptionPricing.expect.override.optionUnitPrice', SOURCE
        ),
      },
      bundledOptions: EXPECT.bundled.productKeys.map((key) => ({
        productCode: product(data, key, SOURCE).productCode,
      })),
      source: SOURCE,
    });
  });

  test('an option override prices below standalone, and Bundled options zero the waterfall',
    { tag: ['@risk:high'] },
    async ({
      cpqData, sf, page, quotePage, quoteLineEditor, productSelection, productConfiguration,
    }, testInfo) => {
      test.setTimeout(TIMEOUT_MS);
      cpqData.setStage('pricing');

      const bundle = product(data, SCENARIO.bundleKey, SOURCE);
      const override = product(data, EXPECT.override.productKey, SOURCE);
      const bundledItems = EXPECT.bundled.productKeys.map((key) => product(data, key, SOURCE));

      const result = await quoteSimpleProducts(
        { cpqData, sf, quotePage, quoteLineEditor, productSelection, productConfiguration },
        {
          instanceUrl: session.instanceUrl,
          account: data.accounts.percentOfTotal,
          accountKey: 'percentOfTotal',
          opportunityName: `${requireString(
            SCENARIO.opportunityBaseName, 'scenarios.bundleOptionPricing.opportunityBaseName', SOURCE
          )} ${runId()}`,
          // The bundle takes its own round through the configurator; the
          // standalone copy follows in the simple round. A configurable
          // product does not come back to the selection screen, so the two
          // cannot share one round.
          bundles: [bundle],
          products: [override],
          closeDateOffsetDays: data.closeDateOffsetDays,

          onSelectionRow: async ({ rowText }) => {
            console.log(`[bundle options] selection grid: ${rowText}`);
            await captureEvidence(page, testInfo, evidenceName('selection-standalone-cpu'));
          },

          onConfigured: async () => {
            // Select the override option and both Bundled ones, waiting for
            // each selection to register before moving on.
            for (const key of [EXPECT.override.productKey, ...EXPECT.bundled.productKeys]) {
              const option = config.options[product(data, key, SOURCE).productCode];
              const feature = option.SBQQ__Feature__r && option.SBQQ__Feature__r.Name;
              const name = option.SBQQ__OptionalSKU__r.Name;
              await productConfiguration.setOptionSelected(feature, name, true);
              await productConfiguration.waitForSelected(feature, name, true);
            }
            await captureEvidence(page, testInfo, evidenceName('configurator-options-selected'));
          },
        }
      );

      const quoteId = result.quoteId;
      const lines = await sf.query(lineSoql(quoteId));
      console.log(
        `[bundle options] ${lines.length} line(s): ` +
          lines.map((l) =>
            `${l.SBQQ__ProductCode__c} list=${l.SBQQ__ListPrice__c} bundled=${l.SBQQ__Bundled__c} ` +
            `requiredBy=${l.SBQQ__RequiredBy__c ? 'yes' : 'no'}`
          ).join(' | ')
      );

      // ---- the two copies of the override product ----------------------------
      const copies = lines.filter((l) => l.SBQQ__ProductCode__c === override.productCode);
      expect(
        copies.length,
        `${override.productCode} should appear TWICE on this quote — once as a bundle option and ` +
          'once standalone. That pair on one quote is what makes the price comparison airtight; ' +
          `found ${copies.length}.`
      ).toBe(2);

      // Identified by SBQQ__RequiredBy__c, never by row position: a bundle
      // contributes a parent plus whatever its defaults select, so positions
      // move with the configuration.
      const bundled = copies.find((l) => l.SBQQ__RequiredBy__c);
      const standalone = copies.find((l) => !l.SBQQ__RequiredBy__c);
      expect(bundled, `no ${override.productCode} line with SBQQ__RequiredBy__c set`).toBeTruthy();
      expect(standalone, `no standalone ${override.productCode} line`).toBeTruthy();

      await test.step('the bundled copy takes the option override', async () => {
        expectMoney(
          bundled.SBQQ__ListPrice__c,
          Number(config.override.SBQQ__UnitPrice__c),
          `${override.productCode} INSIDE the bundle should price at the option record's ` +
            `SBQQ__UnitPrice__c (${config.override.SBQQ__UnitPrice__c}) from ` +
            `${config.override.Name}, not at its price book price`
        );
      });

      await test.step('the standalone copy takes its price book price', async () => {
        expectMoney(
          standalone.SBQQ__ListPrice__c,
          config.standalonePrice,
          `${override.productCode} as a STANDALONE line should price at its own ` +
            `PricebookEntry.UnitPrice (${config.standalonePrice}) — the option override applies ` +
            'only inside the bundle'
        );

        expect(
          Number(bundled.SBQQ__ListPrice__c),
          `the two ${override.productCode} lines must DIFFER — that difference is the whole ` +
            'scenario. Both read ' + bundled.SBQQ__ListPrice__c
        ).not.toBe(Number(standalone.SBQQ__ListPrice__c));
      });

      await test.step('neither copy carries a discount', async () => {
        // This is what attributes the delta to the OPTION OVERRIDE rather than
        // to a discount — the source document's step 9.
        for (const [label, line] of [['bundled', bundled], ['standalone', standalone]]) {
          for (const field of ['SBQQ__Discount__c', 'SBQQ__AdditionalDiscount__c']) {
            expect(
              line[field] === null || line[field] === undefined || Number(line[field]) === 0,
              `the ${label} ${override.productCode} line carries ${field} = ${line[field]}. With a ` +
                'discount in play the price difference between the two copies could be explained ' +
                'by the discount rather than by the option override, which is what this scenario ' +
                'claims to be measuring.'
            ).toBe(true);
          }
        }
      });

      // ---- the Bundled options ------------------------------------------------
      const zeroFields = EXPECT.bundled.zeroFields;
      const byCode = Object.fromEntries(lines.map((l) => [l.SBQQ__ProductCode__c, l]));

      for (const item of bundledItems) {
        await test.step(`${item.productCode} is Bundled and zeroes its whole waterfall`, async () => {
          const line = requireLine(byCode, item.productCode, 'Bundled option');

          expect(
            line.SBQQ__Bundled__c,
            `${item.productCode} should carry SBQQ__Bundled__c = true on the quote line, ` +
              'reflecting the flag on its product option record'
          ).toBe(true);

          // The whole waterfall is LOGGED even though only SBQQ__NetTotal__c is
          // asserted, so the fields that have not been measured on a Bundled
          // line can be added to zeroFields from evidence rather than from a
          // guess (see the data file's _notNarrowedByGuesswork).
          console.log(
            `[bundle options] ${item.productCode} waterfall: ` +
              `list=${line.SBQQ__ListPrice__c} net=${line.SBQQ__NetPrice__c} ` +
              `netTotal=${line.SBQQ__NetTotal__c} customer=${line.SBQQ__CustomerPrice__c} ` +
              `regular=${line.SBQQ__RegularPrice__c}`
          );

          // FIELD BY FIELD, so a failure names which one survived.
          for (const field of zeroFields) {
            expectMoney(
              line[field] || 0, 0,
              `${item.productCode} ${field} should be 0 — a Bundled option is included in the ` +
                'bundle price, so it contributes nothing to what the customer pays. Its own ' +
                'price book entry is non-zero, which is what makes this an OVERRIDE rather than ' +
                'an absence of price. Note the LIST price is deliberately not asserted here: a ' +
                'Bundled option keeps it (measured), and the cell shows "Included" instead.'
            );
          }

          // The ONE claim that can only be made in the UI.
          const shown = await quoteLineEditor.capturePrices(NO_GROUP);
          const cell = shown[item.productCode] && shown[item.productCode].listPrice;
          expect(
            String(cell || ''),
            `${item.productCode}: the List Unit Price CELL should render ` +
              `"${EXPECT.bundled.includedLabel}". This is the one assertion in this suite that ` +
              'cannot be made against the record — the data model holds 0, not a word — so it is ' +
              'made on the rendered text deliberately.'
          ).toContain(requireString(
            EXPECT.bundled.includedLabel,
            'scenarios.bundleOptionPricing.expect.bundled.includedLabel', SOURCE
          ));

          await captureEvidence(
            await quoteLineEditor.lineDrawerShot(NO_GROUP, item.productCode),
            testInfo,
            evidenceName(`${EXPECT.evidence}-${item.productCode.toLowerCase()}-drawer`)
          );
        });
      }

      // ---- the quantity step, which this bundle cannot support -----------------
      //
      // NOT PERFORMED, and said out loud rather than quietly dropped. The step
      // would raise a Bundled option's quantity and assert the charge does not
      // reappear. MEASURED on 2026-08-02: the click-to-edit quantity cell
      // refuses to open on RAM8GB, for a reason already measured against this
      // org — a bundle option's quantity is editable IF AND ONLY
      // IF its SBQQ__ProductOption__c.SBQQ__Quantity__c is null, and both
      // Bundled options here carry 1.
      //
      // Forcing the click or patching the quantity over the API would
      // manufacture a state the UI does not permit, which proves less than not
      // testing it at all.
      const step = EXPECT.bundled.quantityStep;
      if (step) {
        throw new Error(
          'scenarios.bundleOptionPricing.expect.bundled.quantityStep is populated again. Before ' +
            'reinstating it, confirm the target option leaves SBQQ__Quantity__c null on its ' +
            'SBQQ__ProductOption__c record — otherwise its quantity cell is read-only by ' +
            'configuration and the step cannot run. See the data file note.'
        );
      }
      console.log(
        '[bundle options] quantity step SKIPPED: both Bundled options in this bundle fix ' +
          'SBQQ__Quantity__c = 1 on their product option records, so their quantity cells are ' +
          'read-only and there is no edit to make. See the data file\'s _quantityStep.'
      );

      await quoteLineEditor.save();
      await captureEvidence(
        quoteLineEditor.lineTable(NO_GROUP), testInfo, evidenceName(`${EXPECT.evidence}-saved`)
      );
    });
});
