// src/flows/quoteSimpleProducts.js
//
// Flow: get from "a scenario description" to "the SBQQ__QuoteLine__c rows that
// CPQ's price rules produced for it".
//
// This is the seven-step sequence every spec in tests/pricing/ runs, and the
// only things that differ between them are the seed values, the products and
// the expectations:
//
//   1. resolve the Account the scenario needs (by name, or by predicate)
//   2. seed an ungrouped, non-primary quote against it
//   3. reach the Quote Line Editor the way a user does — record page,
//      Edit Lines — never by navigating straight to /apex/SBQQ__sb
//   4. add every product in ONE selection round
//   5. read the displayed prices, BEFORE any Quick Save and without ever
//      clicking Calculate
//   6. Quick Save, which is what actually writes the rows
//   7. poll for them
//
// WHY THIS IS A FLOW AND NOT A HELPER IN tests/
// ---------------------------------------------
// It spans several page objects, it polls for the org's asynchronous work, and
// it is only complete once the resulting records exist — which is what makes
// it a business transition rather than a test helper. Eight specs each
// reimplementing the waits is how the waits drift apart.
//
// WHY IT DOES NOT JUST CALL ProductSelectionPage.addProducts()
// ------------------------------------------------------------
// addProducts() runs the whole selection round and returns to the editor, and
// by then the selection grid — the ONLY place a product's pre-rule price book
// price is visible in the UI — is gone. So the round is driven here with the
// same public methods addProducts() uses, pausing after each selection to read
// the row. The rule addProducts() exists to enforce still holds and is the
// reason for the shape below: a NEW SEARCH DISCARDS THE PREVIOUS TICK, so
// products are committed with selectAndAddMore() between searches and
// confirmed once at the end. Ticking four products across four searches and
// confirming once leaves exactly one line on the quote.
//
// BUNDLES TAKE THEIR OWN ROUND, AND THAT IS FORCED BY THE PRODUCT
// ----------------------------------------------------------------
// A configurable product does not come back to the selection screen — CPQ
// navigates to the configurator instead — so it cannot share a selection round
// with simple products. Each bundle therefore gets its own Add Products round:
// select, configure, Save, land back in the editor. The simple products follow
// in one round afterwards, and everything ends up on ONE quote, which is what
// keeps an in-quote negative control meaningful.
//
// This is not hypothetical tidiness. Measured against this org on 2026-08-01:
// LAPTOP13 carries SBQQ__ConfigurationType__c = 'Allowed' with
// SBQQ__ConfigurationEvent__c = 'Always', exactly like LAPTOP15 — so Scenario
// 5's "add the laptop and the cart" is a bundle round plus a simple round, not
// the single round it looks like on paper.
//
// WHY NOTHING HERE CALLS calculate()
// ----------------------------------
// Several of these scenarios turn on the claim that adding a line triggers
// CPQ's calculation sequence by itself. An explicit Calculate would satisfy
// that claim rather than test it, and would destroy the evidence either way.
const { createSimpleQuote } = require('./createSimpleQuote');
const { resolveAccount, isoDate, plusDays } = require('../utils/pricingData');
const { escapeSoql } = require('../utils/waitForAsync');

// Every price field these scenarios assert on, read in one query.
//
// SBQQ__OriginalPrice__c is the price book price CPQ started from and
// SBQQ__ListPrice__c is what the rules left; a scenario that asserts only the
// literal misses a rule computing from the wrong base, which is exactly what
// happens when a price book changes underneath it.
const QUOTE_LINE_FIELDS = [
  'Id',
  'SBQQ__ProductCode__c',
  'SBQQ__ProductName__c',
  'SBQQ__Quantity__c',
  'SBQQ__OriginalPrice__c',
  'SBQQ__ListPrice__c',
  'SBQQ__SpecialPrice__c',
  'SBQQ__SpecialPriceType__c',
  'SBQQ__NetPrice__c',
  'SBQQ__RequiredBy__c',
];

/** The SOQL that reads every line on one quote. Exported so callers can re-poll. */
function quoteLineSoql(quoteId, extraWhere = '') {
  return (
    `SELECT ${QUOTE_LINE_FIELDS.join(', ')} FROM SBQQ__QuoteLine__c ` +
    `WHERE SBQQ__Quote__c = '${escapeSoql(quoteId)}'${extraWhere ? ` AND ${extraWhere}` : ''}`
  );
}

/**
 * Lines keyed by SBQQ__ProductCode__c.
 *
 * By code, never by name: product names are not unique, so a name-keyed map
 * silently collapses two lines into one and the assertion then runs against
 * whichever survived.
 */
function byProductCode(lines) {
  const map = {};
  for (const line of lines) map[line.SBQQ__ProductCode__c] = line;
  return map;
}

/** Throws naming the codes that ARE present, which is what makes a miss diagnosable. */
function requireLine(map, productCode, context = '') {
  const line = map[productCode];
  if (!line) {
    throw new Error(
      `No quote line with SBQQ__ProductCode__c = "${productCode}"${context ? ` (${context})` : ''}. ` +
        `Codes present: ${Object.keys(map).join(', ') || '(none)'}. ` +
        'A missing code usually means data/pricing-rules.json records a different code than the ' +
        'org does — the product was still added, under its real code.'
    );
  }
  return line;
}

/**
 * @param {object} deps  cpqData, sf, quotePage, quoteLineEditor, productSelection,
 *        and productConfiguration when `bundles` is used
 * @param {object} options
 * @param {object} options.account            an `accounts` entry from the data file
 * @param {string} options.accountKey         that entry's key, for logs and errors
 * @param {string} options.opportunityName    should carry the run marker
 * @param {Array<{name: string, productCode: string}>} [options.products] simple products,
 *        added in ONE selection round
 * @param {Array<{name, productCode, option?: {feature, name, productCode, tab}}>} [options.bundles]
 *        configurable products, each added in its own round through the configurator
 * @param {object} [options.quoteFields]      extra SBQQ__Quote__c fields
 * @param {object} [options.opportunityFields] extra Opportunity fields
 * @param {number} [options.closeDateOffsetDays=90]
 * @param {function} [options.onSelectionRow] async ({ product, rowText }) => {} — called on the
 *        selection screen, while the grid is still narrowed to that product
 * @param {function} [options.onConfigured]   async ({ bundle }) => {} — called in the configurator,
 *        after any option selection and BEFORE Save
 * @param {function} [options.onBeforeQuickSave] async ({ displayedPrices, quoteId }) => {} —
 *        called after the lines are in the editor and BEFORE anything is written
 * @returns {Promise<{account, quoteId, opportunityId, displayedPrices, rowTexts, lines, linesByCode}>}
 */
async function quoteSimpleProducts(deps, options) {
  const { cpqData, sf, quotePage, quoteLineEditor, productSelection, productConfiguration } = deps;
  const {
    account: accountEntry,
    accountKey = 'account',
    opportunityName,
    products = [],
    bundles = [],
    quoteFields = {},
    opportunityFields = {},
    closeDateOffsetDays = 90,
    onSelectionRow,
    onConfigured,
    onBeforeQuickSave,
    instanceUrl,
  } = options;

  if (!products.length && !bundles.length) {
    throw new Error('quoteSimpleProducts needs at least one product or bundle.');
  }
  if (bundles.length && !productConfiguration) {
    throw new Error(
      'quoteSimpleProducts was given bundles but no productConfiguration fixture. A configurable ' +
        'product opens the configurator, and there is nothing here that can drive it.'
    );
  }
  if (!instanceUrl) throw new Error('quoteSimpleProducts needs an instanceUrl.');

  // The codes the finished quote must hold. Polling on THESE rather than on a
  // row count is what makes a bundle safe to wait for: a bundle contributes a
  // parent line plus however many options its defaults select, so the count is
  // not knowable here — but the codes under test are.
  const expectCodes = [
    ...products.map((p) => p.productCode),
    ...bundles.map((b) => b.productCode),
    ...bundles.filter((b) => b.option).map((b) => b.option.productCode),
  ];

  // ---- 1. the Account this scenario needs -----------------------------------
  const account = await resolveAccount(sf, accountEntry, accountKey);

  // ---- 2. seed --------------------------------------------------------------
  const seeded = await createSimpleQuote({ cpqData, sf }, {
    accountName: account.name,
    opportunityName,
    closeDate: isoDate(plusDays(closeDateOffsetDays)),
    quoteFields,
    opportunityFields,
  });

  // ---- 3. reach the editor the way a user does ------------------------------
  await quotePage.open(instanceUrl, seeded.quoteId);
  await quotePage.openLineEditor();
  // allowEmpty: a freshly seeded UNGROUPED quote paints neither a group
  // section nor a line table, so the default readiness signal waits on an
  // element that is never coming and burns its full 180s budget.
  await quoteLineEditor.waitForEditorReady({ allowEmpty: true });

  // ---- 4a. one round per BUNDLE --------------------------------------------
  //
  // Bundles first, so the simple round below always ends on the editor with
  // every line present — which keeps the price capture at step 5 a single
  // reading of the finished quote rather than one per round.
  for (const bundle of bundles) {
    await quoteLineEditor.openAddProducts(null);
    await productSelection.selectBundle(bundle);
    await productConfiguration.waitForReady();

    if (bundle.option) {
      // <iron-pages> renders only the selected tab's panel, so a feature on an
      // unopened tab is not in the DOM at all.
      if (bundle.option.tab) await productConfiguration.openTab(bundle.option.tab);
      await productConfiguration.setOptionSelected(
        bundle.option.feature, bundle.option.name, true
      );
      await productConfiguration.waitForSelected(bundle.option.feature, bundle.option.name, true);
    }

    if (onConfigured) await onConfigured({ bundle });

    const outcome = await productConfiguration.save();
    if (outcome !== 'exited') {
      throw new Error(
        `The configurator rejected "${bundle.name}": ` +
          `${(await productConfiguration.saveErrors()).join(' | ') || '(no message)'}`
      );
    }

    // An accepted Save returns to the Quote Line Editor — but it commits to
    // the EDITOR, not to the database. Nothing exists until the Quick Save
    // below. MEASURED: zero SBQQ__QuoteLine__c rows immediately after a
    // successful configurator Save, eleven after Quick Save.
    await quoteLineEditor.waitForEditorReady();
  }

  // ---- 4b. one round for every SIMPLE product ------------------------------
  const rowTexts = {};
  if (products.length) {
    await quoteLineEditor.openAddProducts(null);
    await productSelection.waitForReady();

    for (let i = 0; i < products.length; i += 1) {
      const item = products[i];
      await productSelection.selectProduct(item);

      // Read the row while the grid is still narrowed to this product. This is
      // the pre-rule price: the selection screen shows the price book price,
      // before any price rule has had a chance to run.
      rowTexts[item.productCode] = await productSelection.rowText(item);
      if (onSelectionRow) {
        await onSelectionRow({ product: item, rowText: rowTexts[item.productCode] });
      }

      // Commit before searching again — see the header note.
      if (i < products.length - 1) await productSelection.selectAndAddMore(item.name);
    }

    await productSelection.waitForNotBusy();
    await productSelection.confirmButton().click();
    await productSelection.waitForLightningReady();
  }

  // ---- 5. what the editor priced, before anything is written ---------------
  await quoteLineEditor.waitForCalculation();
  const displayedPrices = await quoteLineEditor.capturePrices(null);
  if (onBeforeQuickSave) {
    await onBeforeQuickSave({ displayedPrices, quoteId: seeded.quoteId });
  }

  // ---- 6. Quick Save is what creates the rows -------------------------------
  //
  // Nothing exists in the database before this. Measured for the bundle
  // configurator and true for a plain add as well: the editor holds the lines
  // client-side until it is told to commit.
  //
  // [VERIFY] That Quick Save also persists the CALCULATOR's output —
  // SBQQ__ListPrice__c and SBQQ__SpecialPrice__c — rather than only the line
  // itself, with the priced fields landing on a full Save. What is measured so
  // far is that Quick Save creates the lines. If a run finds the
  // price fields null or unpriced here, the fix is a full save() in this flow,
  // not a longer poll: polling would wait out its whole budget on a value that
  // is not coming.
  await quoteLineEditor.quickSave();

  // ---- 7. the records ------------------------------------------------------
  //
  // Polled, not queried once: a query issued the instant Quick Save returns
  // can see zero rows.
  //
  // Polled on the CODES rather than on a row count. A bundle contributes a
  // parent plus whatever its defaults select, so a count is unknowable here
  // AND satisfiable by the wrong rows — the trap where a poll is satisfied
  // instantly by rows that already existed before the change under test.
  // Naming the codes waits on the condition the caller actually needs.
  const wanted = expectCodes.map((code) => `'${escapeSoql(code)}'`).join(', ');
  await sf.pollForRecords(
    quoteLineSoql(seeded.quoteId, `SBQQ__ProductCode__c IN (${wanted})`),
    {
      expect: expectCodes.length,
      label: `quote lines ${expectCodes.join(', ')} on ${opportunityName}`,
    }
  );

  // Then read the WHOLE quote, so a bundle's other option lines are tracked
  // for teardown and available to any assertion that wants them.
  const lines = await sf.query(quoteLineSoql(seeded.quoteId));

  for (const line of lines) {
    cpqData.track('SBQQ__QuoteLine__c', line.Id, {
      name: line.SBQQ__ProductCode__c,
      parentId: seeded.quoteId,
    });
  }

  return {
    account,
    ...seeded,
    displayedPrices,
    rowTexts,
    lines,
    linesByCode: byProductCode(lines),
  };
}

module.exports = {
  quoteSimpleProducts,
  quoteLineSoql,
  byProductCode,
  requireLine,
  QUOTE_LINE_FIELDS,
};
