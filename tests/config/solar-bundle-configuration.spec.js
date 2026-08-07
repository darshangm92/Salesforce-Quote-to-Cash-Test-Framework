// tests/config/solar-bundle-configuration.spec.js
//
// WHAT THIS PROVES
// ----------------
// That the product configurator stops a rep building a solar system that
// cannot be installed. When someone configures the bundle, the screen has to
// enforce the engineering rules: certain parts are mandatory, some can only be
// chosen one at a time, quantities have floors and ceilings, and one rule
// requires the number of microinverters to match the number of panels. This
// walks 31 steps through a single configurator session and checks each
// constraint both when it should block and when it should allow.
//
// WHY IT MATTERS
// --------------
// A configurator that lets an invalid combination through produces an order
// that fails at fulfilment or arrives at a customer site missing a part. The
// rules exist because the product genuinely does not work otherwise, so the
// screen is the last place to catch it before it becomes a delivery problem.
//
// WHY MOST ASSERTIONS ARE ON THE SCREEN HERE — READ THIS BEFORE COPYING IT
// ------------------------------------------------------------------------
// The house rule everywhere else in this suite is to act in the UI and assert
// against the saved record. This spec is the ONE documented exception, and the
// reason is narrow: a constraint test asserts that nothing was saved. A
// rejected Save writes no record, a refused deselect changes no field — there
// is literally nothing to read, so the screen is where the outcome exists.
// The moment a step DOES commit something, it goes back to asserting on the
// record through `sf`. Do not take this spec as a licence to assert on the DOM
// elsewhere.
//
// HOW IT WORKS
// ------------
// `createSimpleQuote` seeds a flat quote over the API, then everything happens
// in the configurator. The 31 steps are grouped into three sessions rather than
// 31, because only a SUCCESSFUL Save exits the configurator — a rejected one
// leaves you where you are, so all five rejection scenarios cost one session
// between them. Re-entering costs about a minute of application cold start,
// which is the single biggest lever on this spec's runtime.
//
// IF THIS FAILS, LOOK HERE FIRST
// ------------------------------
//  1. If a Save was expected to be rejected and was not, the product rule
//     behind that step was deactivated or its condition changed.
//  2. If the failure is a timeout waiting for the configurator, check the
//     bundle still has the features and tabs the data file names — a feature on
//     an unopened tab is not in the page at all.
//  3. If an error message assertion fails but the rejection happened, CPQ's
//     wording changed; that is a finding, not necessarily a defect.
//
// ---------------------------------------------------------------------------
//
// The Solar Controller Hub bundle configurator, end to end in one continuous
// session: default auto-configuration, per-feature quantity and selection
// constraints, feature and tab grouping, global and option-level configuration
// attributes, and the "Enforce Microinverter Quantity" product rule in BOTH
// its triggering and its non-triggering condition.
//
// The behavior under test is the CPQ product configurator. Not pricing, and
// not the quote lifecycle.
//
// WHY SOME ASSERTIONS ARE IN THE UI
// ---------------------------------
// This suite asserts in the API, not the DOM — with one standing exception,
// configurator constraint tests, and this spec is why. A constraint step asserts that NOTHING
// PERSISTS — a rejected Save writes no record, a refused deselect changes no
// field — so there is no record to read and the assertion is necessarily
// against the screen. Every step whose outcome DOES persist is still asserted
// on the record through `sf`.
//
// WHY ONE test() RATHER THAN A SERIAL DESCRIBE
// --------------------------------------------
// Unlike the journeys, this is a single continuous configurator session:
// selections made at step 7 are still in the editor's client-side state at
// step 31, and there is no record to hand between stages. Splitting it into
// per-stage tests would mean re-entering the configurator for every one, and a
// cold entry costs over a minute. test.step() gives the per-step reporting
// without paying that. Step numbers in the titles are the source scenario's.
//
// WHY THE SPEC DOES NOT ASSUME WHERE A SAVE LANDS
// -----------------------------------------------
// A REJECTED configurator Save stays put; an ACCEPTED one returns to the Quote
// Line Editor. Both were measured, but the spec re-establishes position
// explicitly after every Save rather than chaining on the assumption — the
// same defensiveness as the quotePage.open() comment in
// tests/journeys/subscription-lifecycle.spec.js.
//
// HOW THE 31 STEPS MAP ONTO 3 CONFIGURATOR SESSIONS
// --------------------------------------------------
// The rule that decides a session boundary is the one above: only an ACCEPTED
// Save exits. So the cost is not "one session per scenario", it is "one
// re-entry per acceptance", at roughly a minute of app cold start each.
//
//   session 1  steps 3-21   six Saves, five of them REJECTED — every
//                           constraint scenario is free, because a rejection
//                           does not exit. The accepted Save at 21 is the
//                           product rule's positive case and earns its exit.
//   session 2  steps 22-30  batteries, tab/feature grouping, the attribute
//                           read and both drawers — independent edits with no
//                           ordering between them, committed by ONE Save.
//   session 3  step 31      the product rule's non-triggering case, which
//                           keeps a Save to itself because the Save SUCCEEDING
//                           is the assertion.
//
// An earlier version spent five sessions on the same 31 steps by giving steps
// 24, 27 and 30 a Save each; step 27's committed nothing at all. Batching them
// removed two re-entries and no coverage — see the note above session 2.
const { test, expect } = require('../../src/fixtures/cpqFixtures');
const { loadJson } = require('../../src/utils/dataProvider');
const { createSimpleQuote } = require('../../src/flows');
const { runId } = require('../../src/utils/runContext');
const { escapeSoql } = require('../../src/utils/waitForAsync');
const session = require('../../.auth/sf-session.json');

const data = loadJson('solar-bundle.json');

const BUNDLE = data.bundle;
const GLOBAL_ATTRIBUTE = data.attributes.global;
const STEPS = data.steps;
const ERRORS = data.errors;

// Ungrouped quote: every per-line call into the Quote Line Editor passes null
// as the group name, which is that class's flat-quote path.
const NO_GROUP = null;

// Total lines expected at the end — DERIVED from the data file, never written
// down a second time.
const EXPECTED_LINE_TOTAL = data.expectedFinalLines.length;

/** yyyy-mm-dd, the format Salesforce Date fields use over REST. */
function isoDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function plusDays(days, from = new Date()) {
  const date = new Date(from);
  date.setDate(date.getDate() + days);
  return date;
}

/** The configurator renders quantities to two decimals ("5.00"), so compare as numbers. */
function quantity(rendered) {
  return Number(String(rendered).replace(/,/g, ''));
}

/** Every option in the bundle, flattened from the recorded defaults. */
const ALL_OPTIONS = data.defaults.map((d) => ({ feature: d.feature, option: d.option }));

/** The recorded default for one option, by name. */
function defaultFor(optionName) {
  const found = data.defaults.find((d) => d.option === optionName);
  if (!found) throw new Error(`data/solar-bundle.json has no default recorded for "${optionName}".`);
  return found;
}

/** Which tab a feature lives on, so a step can open it before reading. */
function tabOf(featureName) {
  const feature = data.features[featureName];
  if (!feature) throw new Error(`data/solar-bundle.json has no feature named "${featureName}".`);
  return feature.tab;
}

test.describe('Solar Controller Hub bundle configuration', {
  tag: ['@type:regression', '@domain:config', '@risk:high', '@speed:slow', '@quota:heavy'],
}, () => {
  test('the configurator enforces the bundle\'s options, features, attributes and product rule',
    async ({ cpqData, sf, quotePage, quoteLineEditor, productSelection, productConfiguration }) => {
      // Six Saves, five configurator entries, and the twelve editability
      // probes the default-configuration read needs. Every entry pays the
      // app's cold-start cost, which this org reports as "Large bundle
      // configuration enabled. It may take a minute to process your request."
      // The project default of 120s is not remotely enough.
      //
      // MEASURED at 7.9 minutes end to end against the Developer org on
      // 2026-07-31. The budget is 30, i.e. nearly four times that, and the
      // headroom is deliberate: the failure this spec exists to report is a
      // configurator defect, and a run cut off by its own timeout reports org
      // slowness as if it were one.
      test.setTimeout(30 * 60_000);

      cpqData.setStage('config');

      let quoteId;

      // =====================================================================
      // Step 1 — seed, open the editor, and confirm it starts empty
      // =====================================================================
      await test.step('step 1 — seed an ungrouped quote and open an empty line editor', async () => {
        const seeded = await createSimpleQuote({ cpqData, sf }, {
          accountName: data.account.name,
          // Run-marked: the Account is shared across runs and specs, so a bare
          // fixed name accumulates records nobody can tell apart afterwards.
          opportunityName: `${data.opportunity.baseName} [${runId()}]`,
          closeDate: isoDate(plusDays(data.opportunity.closeDateOffsetDays)),
          stage: data.opportunity.stage,
          quoteFields: {
            SBQQ__LineItemsGrouped__c: data.quote.lineItemsGrouped,
            SBQQ__Primary__c: data.quote.primaryAtSeed,
          },
        });
        quoteId = seeded.quoteId;

        // The flow throws on the grouping Industry rather than branching, so
        // reaching here means the ungrouped premise holds. Recorded anyway, so
        // the run log names the Account it actually quoted against.
        console.log(
          `Quoting against "${seeded.accountName}" (${seeded.accountId}), ` +
            `Industry = ${JSON.stringify(seeded.industry)}`
        );

        // Reached through the record page, which is the path a user takes.
        await quotePage.open(session.instanceUrl, quoteId);
        await quotePage.openLineEditor();
        // allowEmpty: an empty UNGROUPED quote paints neither a group section
        // nor a line table, so the default readiness signal never resolves.
        await quoteLineEditor.waitForEditorReady({ allowEmpty: true });

        expect(
          await quoteLineEditor.lineRows(NO_GROUP).count(),
          'the editor should start with no lines'
        ).toBe(0);
      });

      // =====================================================================
      // Step 2 — Add Products, and expect the configurator
      // =====================================================================
      await test.step('step 2 — selecting the bundle hands off to the configurator', async () => {
        await quoteLineEditor.openAddProducts(NO_GROUP);
        // selectBundle expects the selection screen to go away. addProducts()
        // would treat exactly that as a failure.
        await productSelection.selectBundle(BUNDLE);
        await productConfiguration.waitForReady();

        expect(
          await productConfiguration.isOpen(),
          `selecting "${BUNDLE.name}" should open the product configurator`
        ).toBe(true);
      });

      // =====================================================================
      // Step 3 — read the untouched default configuration
      //
      // Asserted per option BY NAME, including every unselected one. A total
      // that happens to match proves nothing about which options CPQ picked.
      // =====================================================================
      await test.step('step 3 — the default auto-configuration matches the recorded defaults', async () => {
        for (const tab of data.tabs) {
          await productConfiguration.openTab(tab.name);

          const optionsOnTab = ALL_OPTIONS.filter((o) => tabOf(o.feature) === tab.name);
          const state = await productConfiguration.readConfiguration(optionsOnTab);

          for (const { option } of optionsOnTab) {
            const expected = defaultFor(option);
            const actual = state[option];

            expect(actual.selected, `"${option}" selected by default`).toBe(expected.selected);
            expect(
              actual.selectionLocked,
              `"${option}" selection locked (SBQQ__Required__c = ${expected.required})`
            ).toBe(expected.selectionLocked);
            expect(quantity(actual.quantity), `"${option}" default quantity`).toBe(expected.quantity);
            expect(
              actual.quantityEditable,
              `"${option}" quantity editable`
            ).toBe(expected.quantityEditable);
          }
        }

        await productConfiguration.openTab(tabOf('Panels'));
      });

      // =====================================================================
      // The required global attribute, exercised here rather than at step 26.
      //
      // TWO ORG BEHAVIOURS FORCE THIS, BOTH MEASURED — see
      // "_requiredAttributeOrdering" in data/solar-bundle.json.
      //
      // 1. CPQ validates required attributes FIRST and short-circuits. With
      //    System Voltage empty, EVERY Save is rejected with "Please review
      //    required configuration attributes" and none of the constraint
      //    messages this spec exists to assert ever surfaces. So it has to be
      //    set before step 4.
      // 2. Once the attribute has a SAVED value, CPQ removes "--None--" from
      //    its picklist entirely — a required attribute cannot be cleared
      //    through the configurator at all. So step 26's literal instruction,
      //    "clear it and Save", is not performable at step 26's position.
      //
      // The behaviour step 26 was written to prove is therefore asserted here,
      // where the attribute is genuinely empty and the rejection is real. Step
      // 26 keeps its position and asserts the other half — that the value
      // cannot be cleared once set — and step 27 keeps the Save-succeeds half
      // plus the record assertion. Between them the required-attribute
      // behaviour is fully covered; nothing was dropped to make it pass.
      //
      // Deliberately after step 3, so the defaults are read untouched.
      // =====================================================================
      await test.step(
        `step 26 (performed here) — an empty required "${GLOBAL_ATTRIBUTE.label}" blocks Save`,
        async () => {
          // This IS step 26's assertion, performed at the only point in the
          // run where its precondition is reachable. The attribute starts
          // empty, so saving now exercises exactly the required-field
          // rejection the source scenario asked for — and it must be done
          // before anything else, because CPQ short-circuits on it.
          expect(
            await productConfiguration.globalAttributeValue(GLOBAL_ATTRIBUTE.label),
            `"${GLOBAL_ATTRIBUTE.label}" starts empty`
          ).toBe('');

          await productConfiguration.save();

          const errors = await productConfiguration.saveErrors();
          expect(errors, `Save with "${GLOBAL_ATTRIBUTE.label}" empty`).not.toEqual([]);
          expect(errors, 'the rejection names the required configuration attribute')
            .toContain(ERRORS.requiredAttribute);
          expect(
            await productConfiguration.globalAttributeValue(GLOBAL_ATTRIBUTE.label),
            `"${GLOBAL_ATTRIBUTE.label}" is still empty after the rejected Save`
          ).toBe('');
          expect(
            await productConfiguration.isOpen(),
            'a rejected Save stays in the configurator'
          ).toBe(true);

          // Now set it, so the constraint messages steps 4-21 assert can
          // actually surface. See the block comment above.
          await productConfiguration.setGlobalAttribute(
            GLOBAL_ATTRIBUTE.label,
            GLOBAL_ATTRIBUTE.value
          );
          expect(
            await productConfiguration.globalAttributeValue(GLOBAL_ATTRIBUTE.label),
            `"${GLOBAL_ATTRIBUTE.label}" after being set`
          ).toBe(GLOBAL_ATTRIBUTE.value);
        }
      );

      // =====================================================================
      // Steps 4-6 — the option minimum quantity
      // =====================================================================
      await test.step('step 4 — a quantity below the option minimum is rejected on Save', async () => {
        const step = STEPS.belowMinimumQuantity;
        await productConfiguration.setQuantity(step.feature, step.option, step.quantity);
        await productConfiguration.save();

        expect(
          await productConfiguration.saveErrors(),
          `Save with "${step.option}" at ${step.quantity}`
        ).toContain(ERRORS.minimumQuantity);
        // A rejected Save writes nothing, so there is no record to read — the
        // screen is the only place the outcome exists.
        expect(await productConfiguration.isOpen(), 'a rejected Save stays in the configurator').toBe(true);
      });

      await test.step('step 5 — a Required option cannot be deselected', async () => {
        const { feature, option } = STEPS.belowMinimumQuantity;
        // Captured immediately before the attempt rather than taken from the
        // data file: step 4 has already changed this quantity, so the
        // invariant worth proving is that the refused deselect changed
        // NOTHING — not that the quantity equals some particular number.
        const before = await productConfiguration.quantityValue(feature, option);

        await productConfiguration.toggleOption(feature, option);

        expect(await productConfiguration.isSelected(feature, option), `"${option}" still selected`).toBe(true);
        expect(
          await productConfiguration.isSelectionLocked(feature, option),
          `"${option}" selection still locked`
        ).toBe(true);
        expect(
          quantity(await productConfiguration.quantityValue(feature, option)),
          `"${option}" quantity unchanged by the refused deselect`
        ).toBe(quantity(before));
      });

      await test.step('step 6 — a quantity at or above the minimum is accepted', async () => {
        const step = STEPS.acceptedPanelQuantity;
        await productConfiguration.setQuantity(step.feature, step.option, step.quantity);

        expect(
          quantity(await productConfiguration.quantityValue(step.feature, step.option)),
          `"${step.option}" quantity after commit`
        ).toBe(step.quantity);
      });

      // =====================================================================
      // Steps 7-12 — the Panels feature minimum, and fixed option quantities
      // =====================================================================
      await test.step('step 7 — all three mounting kits can be selected at once', async () => {
        for (const kit of STEPS.mountingKits) {
          await productConfiguration.setOptionSelected(defaultFor(kit).feature, kit, true);
        }
        // All three at once — the Panels feature declares no maximum, so this
        // is the positive half of the constraint that steps 9-11 then break.
        for (const kit of STEPS.mountingKits) {
          expect(
            await productConfiguration.isSelected(defaultFor(kit).feature, kit),
            `"${kit}" selected`
          ).toBe(true);
        }

        // No error-region check here — see the note at step 16. Outside a
        // Save the region carries no information about the current step: it
        // holds whatever the last Save left, and those toasts additionally
        // auto-dismiss on a timer, so an empty-region assertion here passes or
        // fails on how long the preceding steps happened to take.
      });

      await test.step('step 8 — a mounting kit\'s quantity is fixed at 1 and not editable', async () => {
        for (const kit of STEPS.mountingKits) {
          const feature = defaultFor(kit).feature;
          expect(
            await productConfiguration.isQuantityEditable(feature, kit),
            `"${kit}" quantity editable — its Product Option fixes SBQQ__Quantity__c`
          ).toBe(false);
          expect(
            quantity(await productConfiguration.quantityValue(feature, kit)),
            `"${kit}" quantity`
          ).toBe(defaultFor(kit).quantity);
        }
      });

      await test.step('steps 9-11 — deselecting every mounting kit trips the Panels minimum', async () => {
        for (const kit of STEPS.mountingKits) {
          const feature = defaultFor(kit).feature;
          await productConfiguration.setOptionSelected(feature, kit, false);
          expect(await productConfiguration.isSelected(feature, kit), `"${kit}" deselected`).toBe(false);
        }

        await productConfiguration.save();

        const errors = await productConfiguration.saveErrors();
        expect(errors, 'Save with no mounting kit selected').not.toEqual([]);
        expect(errors, 'the rejection names the Panels feature minimum')
          .toContain(ERRORS.panelsFeatureMinimum);
        expect(await productConfiguration.isOpen(), 'a rejected Save stays in the configurator').toBe(true);
      });

      await test.step('step 12 — re-selecting two mounting kits clears the feature minimum', async () => {
        for (const kit of STEPS.reselectedKits) {
          const feature = defaultFor(kit).feature;
          await productConfiguration.setOptionSelected(feature, kit, true);
          expect(await productConfiguration.isSelected(feature, kit), `"${kit}" re-selected`).toBe(true);
        }
      });

      // =====================================================================
      // Steps 13-16 — the Inverters feature maximum of 1, and its minimum
      // =====================================================================
      await test.step('step 13 — selecting Microinverter auto-deselects Inverter', async () => {
        const replaced = STEPS.replacedInverter;
        const original = STEPS.finalInverter;
        const feature = defaultFor(replaced).feature;

        await productConfiguration.setOptionSelected(feature, replaced, true);
        await productConfiguration.waitForSelected(feature, original, false);

        // BOTH halves. Asserting only that Microinverter became selected would
        // pass even if the feature maximum were not enforced at all.
        expect(await productConfiguration.isSelected(feature, replaced), `"${replaced}" selected`).toBe(true);
        expect(
          await productConfiguration.isSelected(feature, original),
          `"${original}" auto-deselected by the Inverters maximum of ` +
            `${data.features[feature].maxOptionCount}`
        ).toBe(false);
      });

      await test.step('step 14 — Microinverter\'s quantity sits at its floor and is editable', async () => {
        const option = STEPS.replacedInverter;
        const feature = defaultFor(option).feature;

        expect(
          quantity(await productConfiguration.quantityValue(feature, option)),
          `"${option}" quantity defaults to its SBQQ__MinQuantity__c`
        ).toBe(STEPS.microinverterFloor);
        expect(
          await productConfiguration.isQuantityEditable(feature, option),
          `"${option}" quantity editable once selected`
        ).toBe(true);
      });

      await test.step('step 15 — deselecting Microinverter trips the Inverters minimum', async () => {
        const option = STEPS.replacedInverter;
        const feature = defaultFor(option).feature;

        await productConfiguration.setOptionSelected(feature, option, false);
        expect(await productConfiguration.isSelected(feature, option), `"${option}" deselected`).toBe(false);

        await productConfiguration.save();

        const errors = await productConfiguration.saveErrors();
        expect(errors, 'Save with no inverter selected').not.toEqual([]);
        expect(errors, 'the rejection names the Inverters feature minimum')
          .toContain(ERRORS.invertersFeatureMinimum);
        expect(await productConfiguration.isOpen(), 'a rejected Save stays in the configurator').toBe(true);
      });

      await test.step('step 16 — re-select Microinverter and commit its quantity', async () => {
        const option = STEPS.replacedInverter;
        const feature = defaultFor(option).feature;

        await productConfiguration.setOptionSelected(feature, option, true);
        expect(await productConfiguration.isSelected(feature, option), `"${option}" re-selected`).toBe(true);

        // Set explicitly rather than relying on the displayed floor: the cell
        // showing 5.00 is a default the app is rendering, not a value the
        // configuration has committed.
        await productConfiguration.setQuantity(feature, option, STEPS.microinverterAtRuleBreach);
        expect(
          quantity(await productConfiguration.quantityValue(feature, option)),
          `"${option}" quantity after commit`
        ).toBe(STEPS.microinverterAtRuleBreach);

        // No "errors are empty" assertion here, and that is deliberate.
        // MEASURED: CPQ leaves a rejected Save's toasts on screen until the
        // NEXT Save — fixing the configuration does not clear them. So at this
        // point the region still holds step 15's feature-minimum message, and
        // an empty-region check would be asserting on toast lifecycle rather
        // than on anything the re-selection did. What this step actually
        // proves is above: the option came back and its quantity committed.
        // Step 20's Save is where the region becomes meaningful again, and
        // save() clears it first so that reading is attributable.
      });

      // =====================================================================
      // Steps 17-19 — Required options in the Wiring feature
      // =====================================================================
      for (const [index, option] of STEPS.lockedWiringOptions.entries()) {
        await test.step(`step ${17 + index} — "${option}" cannot be deselected`, async () => {
          const expected = defaultFor(option);

          await productConfiguration.toggleOption(expected.feature, option);

          expect(
            await productConfiguration.isSelected(expected.feature, option),
            `"${option}" still selected after the deselect attempt`
          ).toBe(true);
          expect(
            quantity(await productConfiguration.quantityValue(expected.feature, option)),
            `"${option}" quantity unchanged`
          ).toBe(expected.quantity);
        });
      }

      // =====================================================================
      // Steps 20-21 — the product rule, in its triggering condition
      // =====================================================================
      await test.step('step 20 — too few microinverters trips the product rule', async () => {
        await productConfiguration.save();

        expect(
          await productConfiguration.saveErrors(),
          `Save with "${STEPS.acceptedPanelQuantity.option}" at ` +
            `${STEPS.acceptedPanelQuantity.quantity} against ` +
            `"${STEPS.replacedInverter}" at ${STEPS.microinverterAtRuleBreach} — ` +
            `the "${data.productRule.name}" rule`
        ).toContain(data.productRule.message);
        expect(await productConfiguration.isOpen(), 'a rejected Save stays in the configurator').toBe(true);
      });

      await test.step('step 21 — raising the microinverter quantity lets the Save through', async () => {
        const option = STEPS.replacedInverter;
        const feature = defaultFor(option).feature;

        await productConfiguration.setQuantity(feature, option, STEPS.microinverterSatisfyingRule);
        await productConfiguration.save();

        expect(await productConfiguration.saveErrors(), 'Save with the rule satisfied').toEqual([]);
        expect(await productConfiguration.isOpen(), 'a successful Save exits the configurator').toBe(false);

        // The configurator's Save commits to the EDITOR, not to the database.
        // Quick Save is what writes the lines — see "_persistence" in the data
        // file. Position is re-established rather than assumed.
        await quoteLineEditor.waitForEditorReady();
        await quoteLineEditor.quickSave();
      });

      // =====================================================================
      // Steps 22-30 — ONE configurator session
      //
      // WHY THESE ARE BATCHED, AND WHAT DECIDES A SESSION BOUNDARY
      // ----------------------------------------------------------
      // Only a SUCCESSFUL Save exits the configurator; a rejected one stays
      // put. That is the whole rule, and it means the constraint steps above
      // are free — steps 4 through 20 fire six Saves between them and all of
      // them share one session, because five were rejected.
      //
      // So the session count is not "how many scenarios are there", it is
      // "how many times must CPQ ACCEPT a Save", and each acceptance costs a
      // re-entry at roughly a minute of app cold start. Splitting steps 22-30
      // across three sessions spent three acceptances where the scenario needs
      // one: the batteries, the drawers and the attribute are independent
      // edits with no ordering between them, and step 27's Save committed
      // nothing at all — System Voltage was already on all eleven lines from
      // the Quick Save after step 21, which the poll showed by returning
      // 11/11 on its first attempt at 0ms.
      //
      // Steps 25 and 26 are pure READS and never needed a session of their
      // own; they ride along here.
      //
      // Nothing is given up by batching. Every edit is still asserted against
      // the record after the Save, and the nested test.step() calls keep the
      // per-step reporting the split version had. What IS given up is
      // per-Save failure attribution — if this Save were rejected, the message
      // would not say which edit caused it. That is an acceptable trade
      // BECAUSE none of these three edits can fail validation: none touches a
      // feature minimum, an option minimum or the product rule. The steps
      // where a Save's outcome IS the assertion — 20, 21 and 31 — deliberately
      // keep a Save to themselves.
      //
      // Tab order below is chosen to minimise switching: the attribute sits
      // above the tab strip, step 25 leaves us on Upsells, the batteries are
      // already there, and only the drawers need a switch back.
      // =====================================================================
      await test.step('steps 22-30 — one session: Battery Backup, tab grouping, the attribute and the drawers', async () => {
        await quoteLineEditor.reconfigureLine(NO_GROUP, BUNDLE.productCode);
        await productConfiguration.waitForReady();

        await test.step('step 26 — a required attribute cannot be cleared once it has a saved value', async () => {
          // MEASURED: on first entry the picklist offers
          // ["--None--", "120V", "240V"]; on re-entry with the value saved it
          // offers only ["120V", "240V"]. CPQ withholds the empty choice from a
          // required attribute that is already satisfied, so there is no way to
          // empty it through this screen.
          //
          // A constraint assertion in the Section 0 rule 3 sense — it proves a
          // change CANNOT be made, so the screen is the only place the outcome
          // exists.
          const options = await productConfiguration.globalAttributeOptions(GLOBAL_ATTRIBUTE.label);
          expect(
            options,
            `"${GLOBAL_ATTRIBUTE.label}" picklist offers its real values`
          ).toEqual(expect.arrayContaining(GLOBAL_ATTRIBUTE.picklistValues));
          expect(
            await productConfiguration.canClearGlobalAttribute(GLOBAL_ATTRIBUTE.label),
            `"${GLOBAL_ATTRIBUTE.label}" is required, so once set its picklist must not offer an ` +
              `empty choice. Options offered: ${options.join(', ')}`
          ).toBe(false);
          expect(
            await productConfiguration.globalAttributeValue(GLOBAL_ATTRIBUTE.label),
            `"${GLOBAL_ATTRIBUTE.label}" still holds the value set earlier in the run`
          ).toBe(GLOBAL_ATTRIBUTE.value);
        });

        await test.step('step 25 — tabs and their feature sections are grouped and ordered', async () => {
          expect(
            await productConfiguration.tabLabels(),
            'the configurator tab strip'
          ).toEqual(data.tabs.map((t) => t.name));

          for (const tab of data.tabs) {
            await productConfiguration.openTab(tab.name);
            // toEqual, not a membership check: the scenario specifies Inverters
            // directly below Panels, so document ORDER is part of the claim.
            expect(
              await productConfiguration.featureNames(),
              `feature sections on the "${tab.name}" tab, in document order`
            ).toEqual(tab.features);
          }
        });

        await test.step('steps 22-23 — select and quantify the Battery Backup options', async () => {
          // Already on the Upsells tab: step 25 left us there. openTab is a
          // no-op when the tab is current, so this stays correct if the
          // ordering above ever changes.
          await productConfiguration.openTab(tabOf(STEPS.batteryBackup[0].feature));

          for (const item of STEPS.batteryBackup) {
            await productConfiguration.setOptionSelected(item.feature, item.option, true);
            expect(
              await productConfiguration.isSelected(item.feature, item.option),
              `"${item.option}" selected`
            ).toBe(true);
          }

          for (const item of STEPS.batteryBackup) {
            expect(
              await productConfiguration.isQuantityEditable(item.feature, item.option),
              `"${item.option}" quantity editable`
            ).toBe(item.quantityEditable);

            if (item.quantityEditable) {
              await productConfiguration.setQuantity(item.feature, item.option, item.quantity);
            }
            expect(
              quantity(await productConfiguration.quantityValue(item.feature, item.option)),
              `"${item.option}" quantity`
            ).toBe(item.quantity);
          }
        });

        await test.step('steps 28-29 — set the attribute drawers on two mounting kits', async () => {
          for (const drawer of data.attributes.drawer) {
            await productConfiguration.openTab(tabOf(drawer.feature));
            for (const field of drawer.values) {
              await productConfiguration.setDrawerAttribute(
                drawer.feature,
                drawer.option,
                field.label,
                field.value
              );
            }
          }
        });

        // Meaningful here, unlike at steps 7 and 16, because no Save has run
        // in this session: the region started genuinely empty, so anything in
        // it would be a message these edits raised.
        expect(
          await productConfiguration.saveErrors(),
          'no errors raised while configuring, before any Save'
        ).toEqual([]);
      });

      await test.step('steps 24, 27, 30 — one Save commits all three, and each lands on its own lines', async () => {
        await productConfiguration.save();
        expect(
          await productConfiguration.saveErrors(),
          'Save after the batteries, the attribute and the drawers'
        ).toEqual([]);
        expect(await productConfiguration.isOpen(), 'a successful Save exits the configurator').toBe(false);

        await quoteLineEditor.waitForEditorReady();
        await quoteLineEditor.quickSave();

        const drawerFields = [...new Set(
          data.attributes.drawer.flatMap((d) => d.values.map((v) => v.field))
        )];

        // --- step 24: the Battery Backup lines ----------------------------
        //
        // Conditional on the COUNT rising, which is a real condition here: the
        // quote held eight lines before this Save and holds eleven after.
        // Scoped by SBQQ__Quote__c and nothing else — the Account is shared
        // sample data other runs quote against, so an account-scoped filter
        // would be flaky by construction.
        await sf.pollForRecords(
          `SELECT Id FROM SBQQ__QuoteLine__c WHERE SBQQ__Quote__c = '${escapeSoql(quoteId)}'`,
          {
            expect: EXPECTED_LINE_TOTAL,
            label: 'quote lines after the batched configurator save',
            timeout: 180_000,
          }
        );

        // A SECOND condition, and not redundant with the count above. Batching
        // three edits into one Save means one poll can only prove one of them
        // landed: the line count rising 8 -> 11 proves the batteries did, and
        // says nothing about whether the drawer fields have been written yet.
        // They are set in the same Save but are a field update rather than an
        // insert, so waiting on the count alone would let the drawer reads
        // below land on stale nulls.
        const drawerField = drawerFields[0];
        await sf.pollForRecords(
          `SELECT Id FROM SBQQ__QuoteLine__c WHERE SBQQ__Quote__c = '${escapeSoql(quoteId)}' ` +
            `AND ${drawerField} != null`,
          {
            expect: data.attributes.drawer.length,
            label: `quote lines carrying ${drawerField}`,
            timeout: 180_000,
          }
        );

        const lines = await sf.query(
          'SELECT Id, SBQQ__ProductCode__c, SBQQ__Quantity__c, SBQQ__RequiredBy__c, ' +
            `${GLOBAL_ATTRIBUTE.field}, ${drawerFields.join(', ')} ` +
            `FROM SBQQ__QuoteLine__c WHERE SBQQ__Quote__c = '${escapeSoql(quoteId)}'`
        );
        expect(lines, 'quote lines after the batched save').toHaveLength(EXPECTED_LINE_TOTAL);

        const lineFor = (optionName) => {
          const code = defaultFor(optionName).productCode;
          const line = lines.find((l) => l.SBQQ__ProductCode__c === code);
          expect(line, `"${optionName}" (${code}) is missing from the quote`).toBeTruthy();
          return line;
        };

        for (const item of STEPS.batteryBackup) {
          expect(
            lineFor(item.option).SBQQ__Quantity__c,
            `SBQQ__Quantity__c for "${item.option}"`
          ).toBe(item.quantity);
        }

        // --- step 27: the global attribute, on EVERY line ------------------
        //
        // SBQQ__ApplyToProductOptions__c is true, so CPQ stamps the value onto
        // every line in the bundle, not just the parent. Measured — see
        // "_appliesToAllLines" in the data file.
        const stamped = lines.filter((l) => l[GLOBAL_ATTRIBUTE.field] === GLOBAL_ATTRIBUTE.value);
        expect(
          stamped.length,
          `lines carrying ${GLOBAL_ATTRIBUTE.field} = "${GLOBAL_ATTRIBUTE.value}" ` +
            '(the attribute applies to product options, so every line in the bundle). ' +
            `Values seen: ${JSON.stringify(lines.map((l) => l[GLOBAL_ATTRIBUTE.field]))}`
        ).toBe(EXPECTED_LINE_TOTAL);

        // --- step 30: each drawer's values, on its own line ----------------
        //
        // Both drawers checked in the SAME pass, so cross-contamination cannot
        // slip through: the two options are given deliberately different
        // values for the same two fields.
        for (const drawer of data.attributes.drawer) {
          const line = lineFor(drawer.option);
          for (const field of drawer.values) {
            expect(
              line[field.field],
              `${field.field} on the "${drawer.option}" line ("${field.label}")`
            ).toBe(field.value);
          }
        }
      });

      // =====================================================================
      // Step 31 — the product rule in its NON-triggering condition
      // =====================================================================
      await test.step('step 31 — swapping back to Inverter saves cleanly, with no rule error', async () => {
        await quoteLineEditor.reconfigureLine(NO_GROUP, BUNDLE.productCode);
        await productConfiguration.waitForReady();

        const replaced = STEPS.replacedInverter;
        const restored = STEPS.finalInverter;
        const feature = defaultFor(restored).feature;

        await productConfiguration.openTab(tabOf(feature));
        await productConfiguration.setOptionSelected(feature, replaced, false);
        await productConfiguration.setOptionSelected(feature, restored, true);
        await productConfiguration.waitForSelected(feature, replaced, false);

        expect(await productConfiguration.isSelected(feature, restored), `"${restored}" selected`).toBe(true);
        expect(await productConfiguration.isSelected(feature, replaced), `"${replaced}" deselected`).toBe(false);

        await productConfiguration.save();

        // The whole point of step 31: the same solar panel quantity that trips
        // the rule at step 20 must NOT trip it once there are no
        // microinverters to count.
        expect(
          await productConfiguration.saveErrors(),
          `Save with "${restored}" selected — the "${data.productRule.name}" rule must not fire ` +
            `when "${replaced}" is absent, even at ${STEPS.acceptedPanelQuantity.quantity} solar panels`
        ).toEqual([]);
        expect(await productConfiguration.isOpen(), 'a successful Save exits the configurator').toBe(false);

        await quoteLineEditor.waitForEditorReady();
        await quoteLineEditor.quickSave();
      });

      // =====================================================================
      // Final state — assert in the API, per product
      // =====================================================================
      await test.step('final state — the quote\'s lines match the expected configuration', async () => {
        // POLL ON THE CONDITION, NOT ON A ROW THAT ALREADY EXISTS.
        //
        // Step 31 swapped one option for another, so the line COUNT is 11 both
        // before and after it. Polling for "11 lines on this quote" is
        // therefore satisfied instantly by the PRE-swap state — it returned on
        // attempt 1 at 0ms — and reports a swap that has not landed yet as a
        // missing product. Restricting the count to the expected product codes
        // makes it a real condition: only 10 of them match until INVERTER
        // replaces MICROINVERTER.
        const expectedCodes = data.expectedFinalLines.map((l) => l.productCode);
        await sf.pollForRecords(
          'SELECT Id FROM SBQQ__QuoteLine__c ' +
            `WHERE SBQQ__Quote__c = '${escapeSoql(quoteId)}' AND SBQQ__ProductCode__c IN (` +
            `${expectedCodes.map((code) => `'${escapeSoql(code)}'`).join(', ')})`,
          {
            expect: EXPECTED_LINE_TOTAL,
            label: 'final quote lines matching the expected configuration',
            timeout: 180_000,
          }
        );

        // Now read them ALL — unfiltered, so anything unexpected still shows up
        // for the absence checks below.
        const lines = await sf.query(
          'SELECT Id, SBQQ__ProductCode__c, SBQQ__Quantity__c, SBQQ__RequiredBy__c, ' +
            'SBQQ__Product__r.Name FROM SBQQ__QuoteLine__c ' +
            `WHERE SBQQ__Quote__c = '${escapeSoql(quoteId)}'`
        );
        const presentCodes = lines.map((l) => l.SBQQ__ProductCode__c).sort();
        expect(
          lines,
          `total quote lines. Present: ${presentCodes.join(', ')}`
        ).toHaveLength(EXPECTED_LINE_TOTAL);

        // Flow-created records the suite caused to exist — recorded so the
        // ledger is a true account of what this run made.
        for (const line of lines) {
          cpqData.track('SBQQ__QuoteLine__c', line.Id, {
            name: line.SBQQ__Product__r && line.SBQQ__Product__r.Name,
            parentId: quoteId,
          });
        }

        // Per product, never a bare total. The bundle parent is distinguished
        // from its options by SBQQ__RequiredBy__c: null on the parent,
        // populated on every option.
        for (const expected of data.expectedFinalLines) {
          const line = lines.find((l) => l.SBQQ__ProductCode__c === expected.productCode);
          expect(
            line,
            `"${expected.name}" (${expected.productCode}) is missing from the final quote. ` +
              `Lines present: ${presentCodes.join(', ')}`
          ).toBeTruthy();
          expect(
            line.SBQQ__Quantity__c,
            `SBQQ__Quantity__c for "${expected.name}"`
          ).toBe(expected.quantity);
          expect(
            line.SBQQ__RequiredBy__c === null || line.SBQQ__RequiredBy__c === undefined,
            `"${expected.name}" SBQQ__RequiredBy__c — null identifies the bundle parent, ` +
              'populated identifies an option'
          ).toBe(expected.bundleParent);
        }

        // Asserted explicitly by code rather than inferred from the total: a
        // count that happens to match proves nothing about which products are
        // on the quote.
        for (const absent of data.absentFinalLines) {
          expect(
            lines.find((l) => l.SBQQ__ProductCode__c === absent),
            `"${absent}" should NOT be on the final quote`
          ).toBeFalsy();
        }
      });
    });
});
