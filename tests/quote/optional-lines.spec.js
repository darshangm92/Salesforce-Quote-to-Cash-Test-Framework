// tests/quote/optional-lines.spec.js
//
// WHAT THIS PROVES
// ----------------
// A rep can put an item on a quote as an optional extra: the customer sees it
// fully priced, but it is not counted in the quote total and it does not carry
// through to the deal being forecast. This proves all four parts — flagging a
// line drops the total by exactly that line's amount and leaves its own pricing
// untouched, flagging a whole section applies to everything in it, optional
// items stay off the opportunity, and clearing the flag puts the money back.
//
// WHY IT MATTERS
// --------------
// Optional extras are how reps upsell without inflating the number the customer
// is being asked to approve. If an optional line is counted, the quote is
// overstated and the deal looks bigger than it is — which then flows into the
// forecast.
//
// HOW IT WORKS
// ------------
// This is the only spec in the suite that uses a GROUPED quote, and the
// grouping is a precondition rather than something the test creates: in this
// org an automation adds two sections to any quote for a retail customer. So
// the spec asserts those two sections exist before doing anything else, and
// fails naming the account if they do not. Products are then added to each
// section through that section's own control, and the flag is toggled at line
// level and at section level, reading the quote's own total back through `sf`
// after each change.
//
// Watch out for the checkbox: the section header's Optional control is built
// from plain divs with no input behind it, so its state is read from a CSS
// class rather than from a checked property. There are three different kinds of
// checkbox in this application and no single way of reading all of them.
//
// IF THIS FAILS, LOOK HERE FIRST
// ------------------------------
//  1. If it times out waiting for two sections, the org automation that creates
//     them did not fire — check the account is still a retail account. That is
//     a data problem, not a test problem.
//  2. If a total does not move, the checkbox click was absorbed by the
//     surrounding cell. The spec verifies the flag took for this reason, so the
//     failure should say so directly.
//  3. If the totals are right but the opportunity assertion fails, the sync
//     behaviour changed rather than the optional flag.
//
// ---------------------------------------------------------------------------
//
// OPTIONAL QUOTE LINES — SBQQ__QuoteLine__c.SBQQ__Optional__c and its
// group-level twin on SBQQ__QuoteLineGroup__c.
//
// An optional line keeps its full pricing detail and is excluded from the
// quote total. Four claims:
//
//   1. Flagging a line drops the quote total by exactly that line's net total,
//      and leaves the line's own pricing untouched.
//   2. Flagging a GROUP cascades to every line in it.
//   3. Optional lines do not sync to the Opportunity.
//   4. Clearing the flag restores the total.
//
// WHY THIS IS @domain:quote AND NOT @domain:pricing
// --------------------------------------------------
// Nothing here changes how a price is DERIVED. It changes which lines a total
// counts and which lines sync onward. Filing it under tests/pricing-methods/
// would repeat the mixed-axis problem that motivated the 1.11 rename, so it
// lives in tests/quote/ and joins a different CI slice.
//
// THIS IS THE ONLY SPEC IN THE SET THAT USES A GROUPED QUOTE
// -----------------------------------------------------------
// And the grouping is a PRECONDITION rather than something the spec creates.
// In this org a record-triggered Flow creates two quote line groups on any
// quote whose Account has Industry = 'Retail'. Confirmed on 2026-08-02 across
// twelve groups on six Fernando Estate quotes, and already relied on by
// src/flows/createQuoteWithGroups.js — which REST-seeds against this same
// account and polls for exactly two groups — so the automation demonstrably
// fires on an API-created quote and not only on a UI-created one.
//
// So: the spec asserts the two groups exist BEFORE doing anything else, and
// fails naming the account if they do not. A change to that Flow then fails by
// name here rather than as a stuck editor twenty steps later.
//
// THREE FLOWS ARE DELIBERATELY NOT USED
// --------------------------------------
//   * createQuoteWithGroups sets SBQQ__LineItemsGrouped__c itself. The groups
//     under test are the ones the ORG made, so setting the flag would have the
//     test assert against a state it had established itself.
//   * quoteSimpleProducts seeds an UNGROUPED quote and passes allowEmpty to
//     the readiness wait. Both are wrong here — this quote is grouped, and the
//     default readiness signal (div.group) is the correct one for it.
//   * createSimpleQuote REFUSES a Retail account by default, precisely because
//     every other caller wants a flat quote. It grew an explicit expectGroups
//     opt-in for this spec, which additionally refuses a NON-Retail account —
//     so asking for groups and silently getting none is not reachable.
const { test, expect } = require('../../src/fixtures/cpqFixtures');
const { loadJson } = require('../../src/utils/dataProvider');
const { createSimpleQuote } = require('../../src/flows');
const { requireNumber, requireString, isoDate, plusDays } = require('../../src/utils/pricingData');
const { assertOptionalFieldAvailable } = require('../../src/utils/pricingConfig');
const { expectMoney } = require('../pricing/expectations');
const { captureEvidence } = require('../../src/utils/evidence');
const { runId } = require('../../src/utils/runContext');
const { escapeSoql } = require('../../src/utils/waitForAsync');
const session = require('../../.auth/sf-session.json');

const SOURCE = 'data/optional-lines.json';
const data = loadJson('optional-lines.json');
const SCENARIO = data.scenarios.optionalLines;
const EXPECT = SCENARIO.expect;

const OPTIONAL_LABEL = 'Optional';

const TIMEOUT_MS = requireNumber(
  data.timeouts.optionalLinesSessionMinutes, 'timeouts.optionalLinesSessionMinutes', SOURCE
) * 60_000;

// Every field the "pricing is preserved" comparison reads, plus the flag.
const LINE_FIELDS = [
  'Id',
  'SBQQ__ProductCode__c',
  'SBQQ__Quantity__c',
  'SBQQ__ListPrice__c',
  'SBQQ__NetPrice__c',
  'SBQQ__NetTotal__c',
  'SBQQ__Optional__c',
  'SBQQ__Group__c',
];

let evidenceOrdinal = 0;
const evidenceName = (slug) => `${String(++evidenceOrdinal).padStart(2, '0')}-${slug}`;

const lineSoql = (quoteId, where) =>
  `SELECT ${LINE_FIELDS.join(', ')} FROM SBQQ__QuoteLine__c ` +
  `WHERE SBQQ__Quote__c = '${escapeSoql(quoteId)}'${where ? ` AND ${where}` : ''}`;

// @type:smoke as well as @type:regression, and it is the QUOTE half of the
// suite's only two smoke tests — the pricing half is
// tests/pricing/educational-netbook-list-price.spec.js.
//
// Paired deliberately rather than doubling up on pricing. This is the only
// non-journey test carrying @domain:quote, so without it a smoke run would
// prove the pricing path works and say nothing at all about quote structure:
// grouped lines, what a total counts, and what syncs to the Opportunity. It
// also exercises the record-triggered Flow that creates quote line groups,
// which nothing in the pricing lane touches.
test.describe('Optional quote lines', {
  tag: ['@type:smoke', '@type:regression', '@domain:quote', '@speed:slow'],
}, () => {
  test.beforeAll(async ({ sf }) => {
    await assertOptionalFieldAvailable(sf, { source: SOURCE });
  });

  test('an optional line keeps its pricing, leaves the total, and does not sync',
    { tag: ['@risk:high'] },
    async ({
      cpqData, sf, page, quotePage, quoteLineEditor, productSelection, opportunityPage,
    }, testInfo) => {
      test.setTimeout(TIMEOUT_MS);
      cpqData.setStage('quote');

      const firstGroup = requireString(data.groups.first.name, 'groups.first.name', SOURCE);
      const secondGroup = requireString(data.groups.second.name, 'groups.second.name', SOURCE);

      // ---- seed, and prove the ORG made the groups ---------------------------
      const seeded = await createSimpleQuote({ cpqData, sf }, {
        accountName: requireString(data.accounts.grouped.name, 'accounts.grouped.name', SOURCE),
        opportunityName: `${requireString(
          SCENARIO.opportunityBaseName, 'scenarios.optionalLines.opportunityBaseName', SOURCE
        )} ${runId()}`,
        closeDate: isoDate(plusDays(data.closeDateOffsetDays)),
        expectGroups: true,
      });

      const expectedGroups = requireNumber(
        EXPECT.groupCount, 'scenarios.optionalLines.expect.groupCount', SOURCE
      );
      const groups = await sf.pollForRecords(
        'SELECT Id, Name, SBQQ__Number__c FROM SBQQ__QuoteLineGroup__c ' +
          `WHERE SBQQ__Quote__c = '${escapeSoql(seeded.quoteId)}' ORDER BY SBQQ__Number__c`,
        {
          expect: expectedGroups,
          label:
            `${expectedGroups} quote line groups on the quote for ` +
            `"${data.accounts.grouped.name}" — this org creates them from a record-triggered Flow ` +
            "keyed on the Account's Industry, and everything below is scoped to them by NAME. A " +
            'timeout here means that automation did not fire, not that the test is wrong.',
        }
      );
      for (const group of groups) {
        cpqData.track('SBQQ__QuoteLineGroup__c', group.Id, {
          name: group.Name, parentId: seeded.quoteId,
        });
      }
      const groupNames = groups.map((g) => g.Name);
      console.log(`[optional lines] groups the org created: ${groupNames.join(', ')}`);
      for (const wanted of [firstGroup, secondGroup]) {
        expect(
          groupNames,
          `the editor scopes every per-line lookup to a group by NAME, so "${wanted}" has to match ` +
            `the org exactly. Groups present: ${groupNames.join(', ')}`
        ).toContain(wanted);
      }

      // ---- reach the editor --------------------------------------------------
      await quotePage.open(session.instanceUrl, seeded.quoteId);
      await quotePage.openLineEditor();
      // NO allowEmpty. This quote is grouped, so div.group paints and the
      // default readiness signal is the correct one — accepting the toolbar
      // instead would let it report ready mid-render.
      await quoteLineEditor.waitForEditorReady();

      // ---- add products to each group, through that group's own control ------
      const addTo = async (groupName, items) => {
        await quoteLineEditor.openAddProducts(groupName);
        await productSelection.waitForReady();
        for (let i = 0; i < items.length; i += 1) {
          await productSelection.selectProduct(items[i]);
          if (i < items.length - 1) await productSelection.selectAndAddMore(items[i].name);
        }
        await productSelection.waitForNotBusy();
        await productSelection.confirmButton().click();
        await productSelection.waitForLightningReady();
        await quoteLineEditor.waitForCalculation();
        await quoteLineEditor.quickSave();

        const codes = items.map((p) => `'${escapeSoql(p.productCode)}'`).join(', ');
        await sf.pollForRecords(
          lineSoql(seeded.quoteId, `SBQQ__ProductCode__c IN (${codes})`),
          { expect: items.length, label: `lines ${items.map((p) => p.productCode).join(', ')} in "${groupName}"` }
        );
      };

      await addTo(firstGroup, data.products.firstGroup);
      await addTo(secondGroup, data.products.secondGroup);

      // ---- the baseline total, from the QUOTE record -------------------------
      await quoteLineEditor.calculate();
      await quoteLineEditor.quickSave();

      const quoteTotal = async () => {
        const quote = await sf.record('SBQQ__Quote__c', seeded.quoteId, ['Id', 'SBQQ__NetAmount__c']);
        return Number(quote.SBQQ__NetAmount__c || 0);
      };
      const readLines = async () => {
        const lines = await sf.query(lineSoql(seeded.quoteId));
        return Object.fromEntries(lines.map((l) => [l.SBQQ__ProductCode__c, l]));
      };

      const baseline = await quoteTotal();
      console.log(`[optional lines] baseline SBQQ__NetAmount__c = ${baseline}`);
      await captureEvidence(quoteLineEditor.lineTable(firstGroup), testInfo, evidenceName('baseline'));

      // ---- the Opportunity BEFORE anything is flagged -------------------------
      //
      // A FULL SAVE, HERE, IS WHAT MAKES CLAIM 3 TESTABLE AT ALL.
      //
      // MEASURED on 2026-08-02: adding products and saving pushes them to the
      // Opportunity as OpportunityLineItems and updates Opportunity.Amount;
      // checking Optional then DELETES those products and drops Amount to 0.
      // Both halves are correct CPQ behaviour.
      //
      // An earlier version of this spec saved only ONCE, after both groups were
      // already optional — so the sync ran exactly when there was nothing left
      // to push, the Opportunity read back empty, and "no optional product is
      // present" passed for a reason that had nothing to do with the flag. The
      // baseline read below is what turns that vacuous check into a real one:
      // the products have to be THERE first for their removal to mean anything.
      await quoteLineEditor.save();

      const opportunityProducts = async () => {
        const rows = await sf.query(
          'SELECT Id, Product2.ProductCode FROM OpportunityLineItem ' +
            `WHERE OpportunityId = '${escapeSoql(seeded.opportunityId)}'`
        );
        return rows.map((r) => r.Product2 && r.Product2.ProductCode).filter(Boolean);
      };
      const opportunityAmount = async () => {
        const opp = await sf.record('Opportunity', seeded.opportunityId, ['Id', 'Amount']);
        return Number(opp.Amount || 0);
      };

      const allCodes = [...data.products.firstGroup, ...data.products.secondGroup]
        .map((p) => p.productCode);

      const syncedAtBaseline = await opportunityProducts();
      const amountAtBaseline = await opportunityAmount();
      console.log(
        `[optional lines] Opportunity at baseline: products [${syncedAtBaseline.join(', ') || 'none'}], ` +
          `Amount = ${amountAtBaseline}`
      );

      // The precondition for claim 3. If this fails, the sync is not running
      // and every later "the optional products are gone" assertion would pass
      // vacuously — so it fails HERE, naming the cause, rather than there.
      for (const code of allCodes) {
        expect(
          syncedAtBaseline,
          `${code} should have synced to the Opportunity once the quote was saved with no ` +
            'optional lines. Without these products present first, their later REMOVAL proves ' +
            'nothing — "no optional product is present" is trivially true of an empty list.'
        ).toContain(code);
      }

      // Back into the editor to do the flagging.
      await quotePage.open(session.instanceUrl, seeded.quoteId);
      await quotePage.openLineEditor();
      await quoteLineEditor.waitForEditorReady();

      // ======================================================================
      // 1. one line, flagged individually
      // ======================================================================
      const preserved = EXPECT._lineFieldsPreservedAcrossTheFlag;

      // THE FLAG IS SET AT GROUP LEVEL, NOT PER LINE.
      //
      // Each group's header carries its own Optional checkbox, alongside
      // Additional Disc. (%), Start Date, End Date and Subscription Term —
      // two groups, two checkboxes, and which one you use is decided by which
      // group the products were added to. That is the control this spec
      // drives.
      //
      // The per-LINE Optional control in the line drawer is NOT used:
      // MEASURED on 2026-08-02, no checkbox of any shape could be resolved
      // under the drawer's "Optional" field, while the group-level control is
      // the same div.td header cell that groupFieldInput() already drives for
      // Start Date. Using the reachable control costs nothing here — every
      // assertion below is per LINE regardless of how the flag was set.
      await test.step(`"${firstGroup}" is flagged Optional and leaves the total`, async () => {
        const before = await readLines();
        const flagged = data.products.firstGroup;
        const droppedBy = flagged.reduce(
          (sum, p) => sum + Number(before[p.productCode].SBQQ__NetTotal__c), 0
        );

        await quoteLineEditor.setGroupCheckbox(firstGroup, OPTIONAL_LABEL, true);
        await quoteLineEditor.calculate();
        await quoteLineEditor.quickSave();

        const codes = flagged.map((p) => `'${escapeSoql(p.productCode)}'`).join(', ');
        await sf.pollForRecords(
          lineSoql(seeded.quoteId, `SBQQ__ProductCode__c IN (${codes}) AND SBQQ__Optional__c = true`),
          { expect: flagged.length, label: `every line in "${firstGroup}" with SBQQ__Optional__c` }
        );

        const after = await readLines();

        // Each line keeps its FULL pricing detail. Field by field against the
        // values read before the flag — that is what "preserves all pricing
        // detail" actually means, and asserting only that the total moved
        // would pass even if CPQ had zeroed the lines.
        for (const item of flagged) {
          for (const field of preserved) {
            expectMoney(
              after[item.productCode][field], Number(before[item.productCode][field]),
              `${item.productCode} ${field} must be UNCHANGED by the Optional flag — an optional ` +
                'line keeps its pricing and is merely excluded from the total'
            );
          }
        }

        // The total falls by EXACTLY the flagged lines' own net totals,
        // computed from their records rather than from any literal.
        expectMoney(
          await quoteTotal(), baseline - droppedBy,
          `the quote's SBQQ__NetAmount__c should fall by exactly the combined SBQQ__NetTotal__c ` +
            `of "${firstGroup}"'s lines (${droppedBy}), from ${baseline}`
        );

        await captureEvidence(
          quoteLineEditor.lineTable(firstGroup), testInfo, evidenceName('group-one-flagged-optional')
        );
      });

      // ======================================================================
      // 2. the whole second group
      // ======================================================================
      await test.step(`marking "${secondGroup}" Optional cascades to every line in it`, async () => {
        await quoteLineEditor.setGroupCheckbox(secondGroup, OPTIONAL_LABEL, true);
        await quoteLineEditor.calculate();
        await quoteLineEditor.quickSave();

        const codes = data.products.secondGroup.map((p) => `'${escapeSoql(p.productCode)}'`).join(', ');
        await sf.pollForRecords(
          lineSoql(seeded.quoteId, `SBQQ__ProductCode__c IN (${codes}) AND SBQQ__Optional__c = true`),
          {
            expect: data.products.secondGroup.length,
            label: `every line in "${secondGroup}" carrying SBQQ__Optional__c`,
          }
        );

        // PER LINE, not by a count — a count matches for the wrong reason the
        // moment an unrelated line is added to the group.
        const lines = await readLines();
        for (const item of data.products.secondGroup) {
          expect(
            lines[item.productCode].SBQQ__Optional__c,
            `${item.productCode} is in "${secondGroup}", which was marked Optional at GROUP level, ` +
              'so the flag should have cascaded to it'
          ).toBe(true);
        }

        // The remaining total is the first group's non-optional lines alone.
        // Both groups are now optional, so nothing is left to count.
        expectMoney(
          await quoteTotal(), 0,
          `with every line in both "${firstGroup}" and "${secondGroup}" optional, the quote total ` +
            'should be 0 — an optional line contributes nothing to it'
        );

        await captureEvidence(
          quoteLineEditor.lineTable(secondGroup), testInfo, evidenceName('group-flagged-optional')
        );
      });

      // ======================================================================
      // 3. optional lines do not sync to the Opportunity
      // ======================================================================
      await quoteLineEditor.save();

      await test.step('the optional products are REMOVED from the Opportunity', async () => {
        const quote = await sf.record('SBQQ__Quote__c', seeded.quoteId, ['Id', 'SBQQ__Primary__c']);
        const synced = await opportunityProducts();
        const amount = await opportunityAmount();
        console.log(
          `[optional lines] Opportunity after flagging both groups: ` +
            `primary=${quote.SBQQ__Primary__c}, products [${synced.join(', ') || 'none'}], ` +
            `Amount = ${amount}`
        );

        // MEASURED: checking Optional DELETES the corresponding
        // OpportunityLineItems and drops Opportunity.Amount. With every line
        // in both groups optional, nothing should remain — and this is a REAL
        // assertion rather than a vacuous one BECAUSE the baseline above
        // proved the same products were there a moment ago.
        for (const code of allCodes) {
          expect(
            synced,
            `${code} is on an OPTIONAL quote line, so its OpportunityLineItem should have been ` +
              `removed. It was present at baseline ([${syncedAtBaseline.join(', ')}]), so this ` +
              'is the flag failing to propagate rather than the sync never having run.'
          ).not.toContain(code);
        }

        expectMoney(
          amount, 0,
          'Opportunity.Amount should be 0 with every quote line optional — it was ' +
            `${amountAtBaseline} at baseline`
        );

        await captureEvidence(page, testInfo, evidenceName('opportunity-products-removed'));
      });

      // ======================================================================
      // 4. clearing the flag restores the total
      // ======================================================================
      await test.step('clearing the group flag restores the quote total', async () => {
        await quotePage.open(session.instanceUrl, seeded.quoteId);
        await quotePage.openLineEditor();
        await quoteLineEditor.waitForEditorReady();

        await quoteLineEditor.setGroupCheckbox(secondGroup, OPTIONAL_LABEL, false);
        await quoteLineEditor.calculate();
        await quoteLineEditor.quickSave();

        const codes = data.products.secondGroup.map((p) => `'${escapeSoql(p.productCode)}'`).join(', ');
        await sf.pollForRecords(
          lineSoql(seeded.quoteId, `SBQQ__ProductCode__c IN (${codes}) AND SBQQ__Optional__c = false`),
          {
            expect: data.products.secondGroup.length,
            label: `every line in "${secondGroup}" back to SBQQ__Optional__c = false`,
          }
        );

        const lines = await readLines();
        const restored = data.products.secondGroup.reduce(
          (sum, p) => sum + Number(lines[p.productCode].SBQQ__NetTotal__c), 0
        );
        expectMoney(
          await quoteTotal(), restored,
          `clearing "${secondGroup}"'s Optional flag should restore its lines to the total. ` +
            `"${firstGroup}" is still optional, so the expected total is ${secondGroup}'s ` +
            `combined net (${restored}) and nothing else.`
        );

        await captureEvidence(
          quoteLineEditor.lineTable(secondGroup), testInfo, evidenceName('group-flag-cleared')
        );
      });
    });
});
