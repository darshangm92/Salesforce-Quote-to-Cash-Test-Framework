// tests/config/smartwatch-attributes.spec.js
//
// WHAT THIS PROVES
// ----------------
// When a customer orders a configurable smartwatch, the choices they make —
// case size, colour, plug type for their country, the engraving on the back,
// and the material of each watch band — survive all the way from the
// configuration screen onto the quote and then onto the order that gets
// fulfilled. It also proves the choices are scoped correctly: some settings are
// meant to apply to the whole watch and others only to the one band they were
// set on.
//
// WHY IT MATTERS
// --------------
// These attributes are the build instructions. If one is dropped between the
// screen and the order, the factory builds the wrong thing — the wrong plug for
// the country, the wrong engraving, the wrong band — and nobody finds out until
// it ships.
//
// WHY SOME ASSERTIONS ARE ON THE SCREEN
// --------------------------------------
// Same narrow exception as the solar spec: the steps that prove a required
// value CANNOT be removed have no record to read, because nothing is saved.
// Everything that does persist — every attribute that lands on a quote line or
// an order product — is asserted against the record through `sf`.
//
// HOW IT WORKS
// ------------
// `createSimpleQuote` seeds a flat quote, then two configurator sessions run.
// The first explores defaults and constraints and deliberately ends in Cancel,
// which is what makes the "the quote has no lines" assertion afterwards mean
// something. The second configures for real and commits, and the spec then
// follows the values onto the saved lines and finally onto an Order.
//
// One thing to know before touching the band assertions: this bundle offers the
// SAME product twice, so a lookup by product name matches two rows and quietly
// reads whichever came first. Every band accessor takes an occurrence index for
// that reason, and the spec anchors it to a counted fact rather than assuming.
//
// IF THIS FAILS, LOOK HERE FIRST
// ------------------------------
//  1. If an attribute is missing from the saved lines, check whether it is
//     supposed to apply to options as well as the parent — that single setting
//     on the attribute record decides how many lines it lands on.
//  2. If the engraving default is wrong, look at the quote's primary contact
//     rather than at the configurator; the default is built from their name.
//  3. If ordering fails with the modal refusing to close, the quote is not
//     primary — an order cannot be created without a primary quote.
//
// ---------------------------------------------------------------------------
//
// The Smartwatch bundle's CONFIGURATION ATTRIBUTES, end to end: how they
// render, default, validate and persist. Bundle-level attributes (Size,
// Accent), a feature-scoped attribute with a hidden picklist value (Outlet
// Standard), a text attribute defaulted from the quote's Primary Contact
// (Engraving), the global attributes in the Product Option Drawer of the two
// watch bands (Material, Color, Accent), and the propagation of all of those
// onto Quote Lines and then onto Order Products through twin fields.
//
// The behavior under test is CPQ's configuration-attribute machinery. Not
// pricing, and not the quote lifecycle past Order generation — the Order is
// left in Draft, never activated and never contracted.
//
// WHY SOME ASSERTIONS ARE IN THE UI
// ---------------------------------
// This suite asserts in the API, not the DOM — with one standing exception,
// configurator constraint tests. The steps that rely on it here assert NOTHING
// PERSISTS or nothing CAN be changed, where there is no record to read and the
// screen is the only place the outcome exists:
//
//   step 5   Outlet Standard renders inside its feature and not above it
//   step 6   the excluded picklist value is not on offer
//   steps 7-9 the three required attributes cannot be emptied
//   step 10  the Engraving override holds in the box
//   step 13  a fresh session's Engraving is the default, not the override
//   steps 14-16 the drawer defaults, and that editing one band leaves the other alone
//
// Step 11's "the quote has no lines after Cancel" is an API assertion of the
// same idea. Every step whose outcome DOES persist — 17 onward — is asserted
// against the record through `sf`.
//
// WHY TWO SESSIONS, AND WHY THE FIRST ONE IS THROWN AWAY
// ------------------------------------------------------
// A configurator entry costs about a minute of app cold start, and only a
// SUCCESSFUL Save exits — so the session count is "how many times must CPQ
// accept a Save", not "how many scenarios are there". Session A explores
// defaults and constraints and ends in Cancel, which is what makes the
// zero-lines assertion at step 11 meaningful. Session B configures and commits.
//
// WHAT THIS SPEC DOES NOT ASSERT, AND WHY
// ---------------------------------------
// The source scenario's steps 7-9 asked for a rejected Save: clear a required
// attribute, Save, expect the rejection. That is NOT PERFORMABLE against this
// org, and not for a reason the test can work around. All three required
// attributes arrive already populated from their picklists' own defaults, and
// CPQ withholds "--None--" from a required attribute that already has a value,
// so none of them can ever be emptied through this screen. There is no
// reachable Save rejection anywhere in this bundle. The steps instead prove
// the invariant those steps existed to establish — that the value cannot be
// removed — and say so at the step. See "_requiredAttributesCannotBeCleared"
// in data/smartwatch-bundle.json for the measurements.
const { test, expect } = require('../../src/fixtures/cpqFixtures');
const { loadJson } = require('../../src/utils/dataProvider');
const { createSimpleQuote } = require('../../src/flows');
const { runId } = require('../../src/utils/runContext');
const { escapeSoql } = require('../../src/utils/waitForAsync');
const session = require('../../.auth/sf-session.json');

const data = loadJson('smartwatch-bundle.json');

const BUNDLE = data.bundle;
const ATTR = data.bundleAttributes;
const BANDS = data.watchBands;
const WATCH_BANDS = data.features.watchBands.name;
const CHARGING = data.features.chargingOptions.name;

// Ungrouped quote: every per-line call into the Quote Line Editor passes null
// as the group name, which is that class's flat-quote path.
const NO_GROUP = null;

// Totals DERIVED from the data file, never written down a second time.
const EXPECTED_LINE_TOTAL = data.expectedFinalLines.length;

/** The sentinel the data file uses for "derive this from the Primary Contact". */
const ENGRAVING_DEFAULT_TOKEN = '@engravingDefault';

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

/** One band's recorded expectations, by role ("included" / "spare"). */
function band(role) {
  const found = BANDS.find((b) => b.role === role);
  if (!found) throw new Error(`data/smartwatch-bundle.json has no "${role}" watch band recorded.`);
  return found;
}

test.describe('Smartwatch bundle configuration attributes', {
  tag: [
    '@type:regression',
    '@domain:config',
    '@domain:orders',
    '@risk:high',
    '@speed:slow',
    '@quota:heavy',
  ],
}, () => {
  test('configuration attributes render, default, resist clearing, and propagate to the order',
    async ({ cpqData, sf, quotePage, quoteLineEditor, productSelection, productConfiguration }) => {
      // Two configurator entries plus order generation. Each entry pays the
      // app's cold-start cost, and the project default of 120s is nowhere near
      // enough for even one.
      //
      // MEASURED at 3.8 minutes end to end against the Developer org on
      // 2026-07-31 (4.2 minutes including global setup), with no retry and no
      // "[configurator] still busy" warnings. The budget is 20, i.e. over five
      // times that, and the headroom is deliberate: the failure this spec
      // exists to report is a configuration-attribute defect, and a run cut off
      // by its own timeout reports org slowness as if it were one.
      //
      // It is well under the solar suite's 7.9 minutes despite two configurator
      // entries, because this bundle has five options to that one's twelve and
      // this scenario asserts nothing about quantities — so it pays none of the
      // editability probes that dominate that spec's runtime.
      test.setTimeout(20 * 60_000);

      cpqData.setStage('config');

      let quoteId;
      let contact;
      let expectedEngraving;

      // =====================================================================
      // Setup — seed against the org's sample Account and its Contact
      // =====================================================================
      await test.step('setup — seed an ungrouped quote carrying a Primary Contact', async () => {
        // The Account is resolved by createSimpleQuote, which throws by name if
        // its Industry is the one that makes this org's Flow create quote line
        // groups. The Contact has to be resolved first, though, because it is
        // seeded ONTO the quote — so the Account is resolved here as well and
        // handed straight back to the flow by name.
        const [account] = await sf.query(
          `SELECT Id, Name, Industry FROM Account WHERE Name = '${escapeSoql(data.account.name)}' LIMIT 1`
        );
        expect(
          account,
          `Account "${data.account.name}" was not found. This suite quotes against accounts that ` +
            'already exist in the org — it never creates one.'
        ).toBeTruthy();

        // Scoped to the resolved AccountId, never by name alone: a Contact
        // surname is not unique across an org, and quoting the wrong person's
        // name would make the Engraving assertions meaningless rather than red.
        const contacts = await sf.query(
          'SELECT Id, FirstName, LastName FROM Contact ' +
            `WHERE AccountId = '${escapeSoql(account.Id)}' ` +
            `AND LastName = '${escapeSoql(data.contact.lastName)}' LIMIT 1`
        );
        expect(
          contacts.length,
          `No Contact named "${data.contact.lastName}" under Account "${data.account.name}" ` +
            `(${account.Id}). The Engraving attribute defaults from the quote's Primary Contact, ` +
            'so this scenario cannot run without one.'
        ).toBeGreaterThan(0);
        [contact] = contacts;

        // Built from the CONTACT RECORD, never hardcoded. The separator comes
        // from the data file because it is a property of this org's
        // EngravingDefault__c formula — and it is an EMPTY string, not a space.
        // See "_nameSeparator" in the data file for the measurement.
        expectedEngraving =
          `${contact.FirstName}${ATTR.engraving.nameSeparator}${contact.LastName}`;

        const seeded = await createSimpleQuote({ cpqData, sf }, {
          accountName: data.account.name,
          // Run-marked: the Account is shared across runs and specs, so a bare
          // fixed name accumulates records nobody can tell apart afterwards.
          opportunityName: `${data.opportunity.baseName} [${runId()}]`,
          closeDate: isoDate(plusDays(data.opportunity.closeDateOffsetDays)),
          stage: data.opportunity.stage,
          quoteFields: {
            SBQQ__LineItemsGrouped__c: data.quote.lineItemsGrouped,
            SBQQ__PrimaryContact__c: contact.Id,
          },
        });
        quoteId = seeded.quoteId;

        console.log(
          `Quoting against "${seeded.accountName}" (${seeded.accountId}), ` +
            `Industry = ${JSON.stringify(seeded.industry)}, ` +
            `Primary Contact = ${contact.FirstName} ${contact.LastName} (${contact.Id})`
        );

        // The seed is what the Engraving default is derived from, so it is
        // asserted rather than assumed — a quote whose Primary Contact silently
        // failed to stick would make every Engraving assertion below vacuous.
        const quote = await sf.record('SBQQ__Quote__c', quoteId, [
          'Id', 'SBQQ__PrimaryContact__c', 'SBQQ__LineItemsGrouped__c',
        ]);
        expect(quote.SBQQ__PrimaryContact__c, 'the quote carries the Primary Contact').toBe(contact.Id);
        expect(quote.SBQQ__LineItemsGrouped__c, 'the quote is ungrouped').toBe(false);
      });

      await test.step('setup — open an empty line editor from the quote record page', async () => {
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
      // SESSION A — throwaway, ends in Cancel
      // =====================================================================

      await test.step('step 3 — selecting the bundle hands off to the configurator', async () => {
        await quoteLineEditor.openAddProducts(NO_GROUP);
        // selectBundle expects the selection screen to go away. addProducts()
        // would treat exactly that as a failure.
        await productSelection.selectBundle(BUNDLE);
        await productConfiguration.waitForReady();

        expect(
          await productConfiguration.isOpen(),
          `selecting "${BUNDLE.name}" should open the product configurator`
        ).toBe(true);

        // This bundle's features declare no SBQQ__Category__c, so CPQ renders
        // no tab strip at all and every feature is on screen at once. Asserted
        // rather than merely relied on: if categories are ever added, the
        // feature sections move behind tabs and every locator below would start
        // failing somewhere less obvious than here.
        expect(
          await productConfiguration.tabLabels(),
          'this bundle sets no feature Category, so the configurator renders no tabs'
        ).toEqual(data.tabs);
        expect(
          await productConfiguration.featureNames(),
          'feature sections, in document order'
        ).toEqual(data.featureOrder);
      });

      // =====================================================================
      // Step 4 — read every default BEFORE mutating anything
      // =====================================================================
      await test.step('step 4 — every attribute arrives with its recorded default', async () => {
        // The two watch bands are the SAME product, so the ordinals used below
        // are anchored to a checked fact rather than to an assumption. If an
        // admin removes one of the pair, this fails here and names the reason,
        // instead of an occurrence: 1 lookup timing out on a missing row.
        expect(
          await productConfiguration.optionRowCount(WATCH_BANDS, band('included').optionName),
          `the "${WATCH_BANDS}" feature should offer "${band('included').optionName}" twice — two ` +
            'Product Option records pointing at one product. The spec addresses them by ordinal.'
        ).toBe(BANDS.length);

        for (const key of ['size', 'accent']) {
          const attribute = ATTR[key];
          expect(
            await productConfiguration.globalAttributeOptions(attribute.label),
            `"${attribute.label}" picklist, in full`
          ).toEqual(attribute.picklistValues);
          expect(
            await productConfiguration.globalAttributeValue(attribute.label),
            `"${attribute.label}" default`
          ).toBe(attribute.default);
        }

        // Read from the Contact record, not from a literal — see the setup step.
        expect(
          await productConfiguration.textAttributeValue(ATTR.engraving.label),
          `"${ATTR.engraving.label}" is pre-populated from the quote's Primary Contact ` +
            `(${contact.FirstName} / ${contact.LastName}) through ` +
            `${ATTR.engraving.defaultField}, whose formula joins them with ` +
            `${JSON.stringify(ATTR.engraving.nameSeparator)}`
        ).toBe(expectedEngraving);

        // NOT empty, unlike the source scenario's expectation. The field
        // carries its own picklist default and CPQ has already applied it.
        expect(
          await productConfiguration.globalAttributeValue(ATTR.outletStandard.label, {
            within: ATTR.outletStandard.feature,
          }),
          `"${ATTR.outletStandard.label}" default. MEASURED as ` +
            `"${ATTR.outletStandard.default}" — the attribute is required but is NOT empty on ` +
            'entry, because Outlet_Standard__c defines its own default picklist value.'
        ).toBe(ATTR.outletStandard.default);

        // Selection state read directly rather than through readConfiguration().
        // That helper also probes each option's quantity editability, which costs
        // seconds per option because proving a quantity read-only requires
        // exhausting every retry — and this scenario asserts nothing about
        // quantities. Paying for a measurement nobody reads is how a suite
        // gets slow without getting stronger.
        for (const expected of data.defaults) {
          const at = { occurrence: expected.occurrence };
          expect(
            await productConfiguration.isSelected(expected.feature, expected.option, at),
            `"${expected.key}" selected by default`
          ).toBe(expected.selected);
          expect(
            await productConfiguration.isSelectionLocked(expected.feature, expected.option, at),
            `"${expected.key}" selection locked (SBQQ__Required__c = ${expected.required})`
          ).toBe(expected.selectionLocked);
        }
      });

      // =====================================================================
      // Step 5 — the feature-scoped attribute renders inside its feature
      // =====================================================================
      await test.step(
        `step 5 — "${ATTR.outletStandard.label}" renders inside the "${CHARGING}" feature`,
        async () => {
          expect(
            await productConfiguration.isAttributeWithinFeature(
              CHARGING, ATTR.outletStandard.label
            ),
            `"${ATTR.outletStandard.label}" carries SBQQ__Feature__c, so CPQ must render it ` +
              `inside the "${CHARGING}" section`
          ).toBe(true);

          // The other half, and the half that actually carries the claim. An
          // attribute is "bundle-level" precisely when it is NOT inside any
          // feature, so the bundle-level set is everything on screen minus
          // every feature's own — asserting placement rather than existence.
          const everything = await productConfiguration.attributeLabels();
          const withinFeatures = [];
          for (const feature of data.featureOrder) {
            withinFeatures.push(...(await productConfiguration.attributeLabels({ within: feature })));
          }
          const bundleLevel = everything.filter((label) => !withinFeatures.includes(label));

          expect(
            bundleLevel,
            'the bundle-level attribute block, in document order'
          ).toEqual([ATTR.size.label, ATTR.accent.label, ATTR.engraving.label]);
          expect(
            bundleLevel,
            `"${ATTR.outletStandard.label}" is feature-scoped, so it must NOT appear among the ` +
              'bundle-level attributes'
          ).not.toContain(ATTR.outletStandard.label);
          expect(
            await productConfiguration.isAttributeWithinFeature(
              WATCH_BANDS, ATTR.outletStandard.label
            ),
            `"${ATTR.outletStandard.label}" belongs to "${CHARGING}" only, not to "${WATCH_BANDS}"`
          ).toBe(false);
        }
      );

      // =====================================================================
      // Step 6 — the hidden picklist value
      // =====================================================================
      await test.step(
        `step 6 — "${ATTR.outletStandard.label}" does not offer the excluded value`,
        async () => {
          const offered = await productConfiguration.globalAttributeOptions(
            ATTR.outletStandard.label, { within: ATTR.outletStandard.feature }
          );

          // Asserted in full rather than by absence alone: a picklist that had
          // lost several values would still pass a bare "does not contain"
          // check while offering the user something quite different.
          expect(
            offered,
            `"${ATTR.outletStandard.label}" picklist, in full`
          ).toEqual(ATTR.outletStandard.picklistLabels);

          // Both spellings. SBQQ__HiddenValues__c stores the API value with no
          // space; the picklist renders long labels. Checking only one form
          // would let a rename through.
          for (const spelling of [
            ATTR.outletStandard.excludedValue,
            ATTR.outletStandard.excludedValueLabel,
          ]) {
            expect(
              offered,
              `"${spelling}" is listed in SBQQ__HiddenValues__c on the Configuration Attribute, ` +
                'so the configurator must not offer it. Offered: ' + offered.join(', ')
            ).not.toContain(spelling);
          }
        }
      );

      // =====================================================================
      // Steps 7-9 — the required attributes cannot be emptied
      //
      // The source scenario asked for a rejected Save per attribute. Not
      // performable here: all three arrive populated and CPQ never offers
      // "--None--" for a required attribute that already has a value, so the
      // precondition cannot be reached at any point in the run. What IS
      // observable — and is the invariant those steps existed to establish —
      // is that the value cannot be removed. See the header note and
      // "_requiredAttributesCannotBeCleared" in the data file.
      //
      // A constraint assertion in the Section 0 rule 3 sense: it proves a
      // change CANNOT be made, so the screen is the only place the outcome
      // exists.
      // =====================================================================
      for (const [index, key] of ['outletStandard', 'size', 'accent'].entries()) {
        const attribute = ATTR[key];
        const scope = attribute.position === 'feature' ? { within: attribute.feature } : {};

        await test.step(
          `step ${7 + index} — required "${attribute.label}" cannot be emptied`,
          async () => {
            const offered = await productConfiguration.globalAttributeOptions(attribute.label, scope);

            expect(
              offered,
              `"${attribute.label}" picklist offers its real values`
            ).toEqual(expect.arrayContaining(
              attribute.picklistLabels || attribute.picklistValues
            ));
            expect(
              await productConfiguration.canClearGlobalAttribute(attribute.label, scope),
              `"${attribute.label}" is required (SBQQ__Required__c = true) and already carries ` +
                `"${attribute.default}", so CPQ must withhold the empty choice. ` +
                `Offered: ${offered.join(', ')}`
            ).toBe(false);

            // Still holding its default, untouched by the read above.
            expect(
              await productConfiguration.globalAttributeValue(attribute.label, scope),
              `"${attribute.label}" still holds its default`
            ).toBe(attribute.default);
          }
        );
      }

      // =====================================================================
      // Step 10 — the free-text override
      // =====================================================================
      await test.step(`step 10 — "${ATTR.engraving.label}" accepts a free-text override`, async () => {
        await productConfiguration.clearTextAttribute(ATTR.engraving.label);
        expect(
          await productConfiguration.textAttributeValue(ATTR.engraving.label),
          `"${ATTR.engraving.label}" is not required, so unlike the picklists above it CAN be emptied`
        ).toBe('');

        await productConfiguration.setTextAttribute(ATTR.engraving.label, ATTR.engraving.override);
        expect(
          await productConfiguration.textAttributeValue(ATTR.engraving.label),
          `"${ATTR.engraving.label}" holds exactly what was typed`
        ).toBe(ATTR.engraving.override);
      });

      // =====================================================================
      // Step 11 — Cancel, and prove nothing was written
      // =====================================================================
      await test.step('step 11 — Cancel leaves the quote with no lines at all', async () => {
        await productConfiguration.cancel();

        expect(
          await productConfiguration.isOpen(),
          'Cancel closes the configurator'
        ).toBe(false);

        const lines = await sf.query(
          'SELECT Id, SBQQ__ProductCode__c FROM SBQQ__QuoteLine__c ' +
            `WHERE SBQQ__Quote__c = '${escapeSoql(quoteId)}'`
        );
        expect(
          lines,
          'a cancelled configurator session writes nothing — and since the configurator\'s Save ' +
            'commits only to the editor anyway, this also confirms no Quick Save slipped through'
        ).toHaveLength(0);
      });

      // =====================================================================
      // SESSION B — committing
      // =====================================================================
      await test.step('step 12 — re-enter the configurator on a fresh configuration', async () => {
        // CANCELLING THE CONFIGURATOR RETURNS TO THE PRODUCT SELECTION SCREEN,
        // NOT TO THE QUOTE LINE EDITOR. MEASURED on 2026-07-31: a page snapshot
        // taken here shows the selection grid's Select / Select & Add More /
        // Cancel buttons, and waiting for the editor's Add Products button
        // instead burned the full 180s readiness budget before failing.
        //
        // That makes sense — the configurator was reached FROM this screen, so
        // Cancel unwinds one step rather than all the way out — but it means
        // there is no Add Products to click again: the screen is already open.
        // Asserted rather than assumed, and asserted HERE rather than by
        // leaning on selectBundle()'s own waitForReady() — that one throws a
        // bundle-shaped message written for a different caller, which would
        // misdescribe this failure entirely.
        await expect(
          productSelection.searchInput(),
          'after cancelling the configurator the product selection screen should still be open, ' +
            'so there is no Add Products button to click again'
        ).toBeVisible({ timeout: 120_000 });

        await productSelection.selectBundle(BUNDLE);
        await productConfiguration.waitForReady();

        expect(await productConfiguration.isOpen(), 'the configurator reopened').toBe(true);
      });

      await test.step(`step 13 — "${ATTR.engraving.label}" is the default again, not the override`, async () => {
        const value = await productConfiguration.textAttributeValue(ATTR.engraving.label);

        expect(
          value,
          `"${ATTR.engraving.label}" is derived from the Primary Contact on every fresh ` +
            'configuration'
        ).toBe(expectedEngraving);
        // Named explicitly, which is what makes this a real check rather than a
        // restatement of the line above: the cancelled session's override must
        // not have become the default for the next one.
        expect(
          value,
          `the override typed at step 10 (${JSON.stringify(ATTR.engraving.override)}) was ` +
            'cancelled, so it must not survive into a new configuration'
        ).not.toBe(ATTR.engraving.override);
      });

      // =====================================================================
      // Steps 14-15 — both watch band drawers
      // =====================================================================
      for (const role of ['included', 'spare']) {
        const current = band(role);
        const stepNumber = role === 'included' ? 14 : 15;

        await test.step(`step ${stepNumber} — the ${role} watch band's drawer`, async () => {
          // Addressed by ORDINAL, not by name: both rows are the same product.
          const at = { occurrence: current.occurrence };

          await productConfiguration.openDrawer(WATCH_BANDS, current.optionName, at);

          expect(
            await productConfiguration.drawerFieldLabels(WATCH_BANDS, current.optionName, at),
            `the ${role} band's drawer shows exactly these attributes, in document order`
          ).toEqual(data.drawerAttributeLabels);

          for (const label of data.drawerAttributeLabels) {
            expect(
              await productConfiguration.drawerAttributeValue(
                WATCH_BANDS, current.optionName, label, at
              ),
              `"${label}" on the ${role} band (Product Option ${current.productOption})`
            ).toBe(current.drawerDefaults[label]);
          }
        });
      }

      // =====================================================================
      // Step 16 — editing one band must not touch the other
      // =====================================================================
      await test.step('step 16 — changing Color on one band leaves the other alone', async () => {
        const target = band(data.colorChange.band);
        const other = BANDS.find((b) => b.role !== data.colorChange.band);
        const at = { occurrence: target.occurrence };
        const otherAt = { occurrence: other.occurrence };
        const label = data.colorChange.label;

        // Color is a DEPENDENT picklist driven by Material, so the replacement
        // has to be one the org is currently offering for THIS band. Asserted
        // rather than assumed: selecting a value that is not on offer fails
        // with an opaque "did not find some options" timeout that names nothing.
        const offered = await productConfiguration.drawerAttributeOptions(
          WATCH_BANDS, target.optionName, label, at
        );
        expect(
          offered,
          `"${data.colorChange.value}" must be offered for the ${target.role} band, whose ` +
            `Material is "${target.drawerDefaults.Material}". Offered: ${offered.join(', ')}`
        ).toContain(data.colorChange.value);

        await productConfiguration.setDrawerAttribute(
          WATCH_BANDS, target.optionName, label, data.colorChange.value, at
        );

        expect(
          await productConfiguration.drawerAttributeValue(WATCH_BANDS, target.optionName, label, at),
          `"${label}" on the ${target.role} band after the change`
        ).toBe(data.colorChange.value);
        expect(
          await productConfiguration.drawerAttributeValue(
            WATCH_BANDS, other.optionName, label, otherAt
          ),
          `"${label}" on the ${other.role} band must be untouched. Both rows are the same product, ` +
            'so a drawer addressed by name rather than by row ordinal would have written to ' +
            'whichever came first — this is the assertion that would catch it.'
        ).toBe(data.colorChange.otherBandUnchanged);
      });

      // =====================================================================
      // Step 17 — the values that get committed
      // =====================================================================
      await test.step('step 17 — set the attributes that will be committed', async () => {
        await productConfiguration.setGlobalAttribute(ATTR.size.label, ATTR.size.committedValue);
        await productConfiguration.setGlobalAttribute(ATTR.accent.label, ATTR.accent.committedValue);
        // Selected by LABEL, read back as VALUE — they differ for this
        // picklist. See "_picklistLabels" in the data file.
        await productConfiguration.setGlobalAttribute(
          ATTR.outletStandard.label,
          ATTR.outletStandard.committedLabel,
          { within: ATTR.outletStandard.feature }
        );

        expect(
          await productConfiguration.globalAttributeValue(ATTR.size.label),
          `"${ATTR.size.label}" after being set`
        ).toBe(ATTR.size.committedValue);
        expect(
          await productConfiguration.globalAttributeValue(ATTR.accent.label),
          `"${ATTR.accent.label}" after being set`
        ).toBe(ATTR.accent.committedValue);
        expect(
          await productConfiguration.globalAttributeValue(ATTR.outletStandard.label, {
            within: ATTR.outletStandard.feature,
          }),
          `"${ATTR.outletStandard.label}" after being set — selected by label ` +
            `"${ATTR.outletStandard.committedLabel}", stored as its value`
        ).toBe(ATTR.outletStandard.committedValue);
      });

      // =====================================================================
      // Step 18 — Save, then Quick Save
      // =====================================================================
      await test.step('step 18 — the Save is accepted and the editor commits the lines', async () => {
        await productConfiguration.save();

        expect(
          await productConfiguration.saveErrors(),
          'Save with every required attribute satisfied'
        ).toEqual([]);
        expect(
          await productConfiguration.isOpen(),
          'a successful Save exits the configurator'
        ).toBe(false);

        // The configurator's Save commits to the EDITOR, not to the database.
        // Quick Save is what writes the lines — see "_persistence" in the data
        // file. Position is re-established rather than assumed.
        await quoteLineEditor.waitForEditorReady();
        await quoteLineEditor.quickSave();
      });

      // =====================================================================
      // Steps 19-20 — assert the quote lines, per product
      // =====================================================================
      await test.step('steps 19-20 — the quote lines carry the configured attributes', async () => {
        const expectedCodes = data.expectedFinalLines.map((l) => l.productCode);

        // Restricted to the expected product codes so this is a real condition
        // rather than one the pre-save state already satisfies.
        await sf.pollForRecords(
          'SELECT Id FROM SBQQ__QuoteLine__c ' +
            `WHERE SBQQ__Quote__c = '${escapeSoql(quoteId)}' AND SBQQ__ProductCode__c IN (` +
            `${expectedCodes.map((code) => `'${escapeSoql(code)}'`).join(', ')})`,
          {
            expect: EXPECTED_LINE_TOTAL,
            label: 'quote lines matching the expected configuration',
            timeout: 180_000,
          }
        );

        // Now read them ALL — unfiltered, so anything unexpected still surfaces.
        const lines = await sf.query(
          'SELECT Id, SBQQ__ProductCode__c, SBQQ__Quantity__c, SBQQ__RequiredBy__c, ' +
            `SBQQ__Product__r.Name, ${data.twinFields.join(', ')} ` +
            `FROM SBQQ__QuoteLine__c WHERE SBQQ__Quote__c = '${escapeSoql(quoteId)}'`
        );
        const presentCodes = lines.map((l) => l.SBQQ__ProductCode__c).sort();
        expect(
          lines,
          `total quote lines. Present: ${presentCodes.join(', ')}`
        ).toHaveLength(EXPECTED_LINE_TOTAL);

        // CPQ-created records the suite caused to exist — recorded so the
        // ledger is a true account of what this run made.
        for (const line of lines) {
          cpqData.track('SBQQ__QuoteLine__c', line.Id, {
            name: line.SBQQ__Product__r && line.SBQQ__Product__r.Name,
            parentId: quoteId,
          });
        }

        // Per product code, never by index and never by count alone.
        for (const expected of data.expectedFinalLines) {
          const line = lines.find((l) => l.SBQQ__ProductCode__c === expected.productCode);
          expect(
            line,
            `"${expected.name}" (${expected.productCode}) is missing from the quote. ` +
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

          // Every twin field on every line, nulls included. The nulls carry as
          // much of the claim as the values: Accent__c being absent from the
          // chargers is what proves SBQQ__ApplyToProductOptions__c = false
          // actually confines it to the bundle parent.
          for (const [field, raw] of Object.entries(expected.attributes)) {
            const want = raw === ENGRAVING_DEFAULT_TOKEN ? expectedEngraving : raw;
            const got = line[field] === undefined ? null : line[field];
            expect(
              got,
              `${field} on the "${expected.name}" line`
            ).toBe(want);
          }
        }

        for (const absent of data.absentFinalLines) {
          expect(
            lines.find((l) => l.SBQQ__ProductCode__c === absent),
            `"${absent}" is offered by the bundle but was never selected, so it must NOT be on ` +
              'the quote'
          ).toBeFalsy();
        }

        // The spare band cannot be asserted absent by product code — it shares
        // SMARTWATCHBAND with the included band. Exactly one such line, plus
        // the total above, is what pins it down.
        expect(
          lines.filter((l) => l.SBQQ__ProductCode__c === band('spare').productCode),
          'exactly one Smartwatch Band line: the included band. The spare band is the same ' +
            'product, so its absence shows up as the COUNT of this code rather than as a ' +
            'missing code.'
        ).toHaveLength(1);
      });

      // =====================================================================
      // Steps 21-22 — order the quote and assert the twin fields
      // =====================================================================
      await test.step('steps 21-22 — ordering carries every attribute onto the Order Products', async () => {
        // Ordering REQUIRES a primary quote in this org: with SBQQ__Primary__c
        // false the record edit modal refuses to close and reports
        // "Opportunity must have a primary quote in order to create an order."
        // A record-triggered Flow sets it on insert, so this is a precondition
        // read rather than a UI step — and asserting it here means a change to
        // that Flow fails with its own name instead of as a stuck modal.
        const before = await sf.record('SBQQ__Quote__c', quoteId, ['Id', 'SBQQ__Primary__c']);
        expect(
          before.SBQQ__Primary__c,
          'the quote must be primary before it can be ordered — this org sets SBQQ__Primary__c ' +
            'through a record-triggered Flow on insert'
        ).toBe(true);

        await quotePage.open(session.instanceUrl, quoteId);
        await quotePage.openEdit();
        await quotePage.setOrdered(true);
        await quotePage.saveEdit();

        const orders = await sf.pollForRecords(
          'SELECT Id, OrderNumber, Status FROM Order ' +
            `WHERE SBQQ__Quote__c = '${escapeSoql(quoteId)}'`,
          {
            expect: data.expected.orderCount,
            label: 'Orders generated from the quote',
            timeout: 180_000,
          }
        );
        expect(orders, 'Orders generated from the quote').toHaveLength(data.expected.orderCount);

        const [order] = orders;
        expect(order.Status, 'the generated Order is left in Draft — this spec never activates it')
          .toBe(data.expected.orderStatus);

        // An Order CPQ created on the suite's behalf. Nothing in _create()
        // touches it, so without this stamp the sweeper would reject it and
        // nothing would ever reclaim it.
        await cpqData.stampExisting('Order', order.Id, {
          name: order.OrderNumber,
          parentId: quoteId,
        });

        const orderItems = await sf.pollForRecords(
          `SELECT Id, OrderId, Quantity, Product2.Name, Product2.ProductCode, ${data.twinFields.join(', ')} ` +
            `FROM OrderItem WHERE OrderId = '${escapeSoql(order.Id)}'`,
          {
            expect: EXPECTED_LINE_TOTAL,
            label: 'Order Products generated from the quote lines',
            timeout: 180_000,
          }
        );

        // Order Products have no Description to stamp. Their ledger row plus a
        // correct parentId is what lets the sweeper verify them by ancestry.
        for (const item of orderItems) {
          cpqData.track('OrderItem', item.Id, {
            name: item.Product2 && item.Product2.Name,
            parentId: item.OrderId,
          });
        }

        for (const expected of data.expectedFinalLines) {
          const item = orderItems.find(
            (i) => i.Product2 && i.Product2.ProductCode === expected.productCode
          );
          expect(
            item,
            `"${expected.name}" (${expected.productCode}) is missing from the Order`
          ).toBeTruthy();

          for (const [field, raw] of Object.entries(expected.attributes)) {
            const want = raw === ENGRAVING_DEFAULT_TOKEN ? expectedEngraving : raw;
            const got = item[field] === undefined ? null : item[field];
            expect(
              got,
              `${field} on the "${expected.name}" Order Product — the twin of the same field on ` +
                'its quote line'
            ).toBe(want);
          }
        }
      });

      // =====================================================================
      // Step 23 — one thin UI spot-check
      // =====================================================================
      await test.step('step 23 — the quote\'s Orders related list shows the generated Order', async () => {
        // The page class navigates to the related list's own route rather than
        // reading the record page, because this org keeps related lists behind
        // a "Related" tab.
        expect(
          await quotePage.ordersRelatedListRowCount(session.instanceUrl, quoteId),
          'Orders related list rows on the quote'
        ).toBe(data.expected.orderCount);
      });
    });
});
