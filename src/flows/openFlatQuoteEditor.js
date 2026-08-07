// src/flows/openFlatQuoteEditor.js
//
// Flow: get a CPQ-GENERATED quote open in the Quote Line Editor, in the one
// state where the editor will actually render it.
//
// WHY THIS EXISTS — READ BEFORE "SIMPLIFYING" IT AWAY
// ---------------------------------------------------
// Quotes CPQ generates for itself — amendment quotes and renewal quotes —
// arrive in a state that hangs their own editor in this org. Measured against
// the Developer org on 2026-07-28, on both an amendment quote (Q-00144) and a
// renewal quote (Q-00152):
//
//   * the generated quote inherits SBQQ__LineItemsGrouped__c = true from the
//     quote or contract it descends from;
//   * this org's record-triggered Flow fires on EVERY SBQQ__Quote__c insert,
//     so the generated quote gets its own "One-time Purchases" and "Ongoing
//     Services" groups as well;
//   * but CPQ creates the generated quote's lines with SBQQ__Group__c = null.
//
// The editor is therefore in grouped mode, with two empty groups and every
// line belonging to neither — and it spins forever. sf-loading-spinner stays
// show="true" past four minutes, no line table is ever painted, and nothing in
// the DOM or the browser console says why. Unchecking Group Line Items makes
// the same quote paint a flat table in about ten seconds.
//
// This is org-shaped, not CPQ-shaped: an org whose Flow did not create groups
// on every quote insert would not see it. Hence the flag is checked rather
// than assumed, and the unchecking is skipped when it is already false.
//
// Done through the UI rather than a PATCH because `sf` is read-only by
// contract and this is a state change a user would make on the record page.
const { escapeSoql } = require('../utils/waitForAsync');

/**
 * @param {object} deps
 * @param {object} deps.sf              read-only `sf` fixture
 * @param {object} deps.quotePage
 * @param {object} deps.quoteLineEditor
 * @param {object} options
 * @param {string} options.instanceUrl
 * @param {string} options.quoteId
 * @param {string} [options.label]      what to call the quote in log lines
 * @returns {Promise<{ungrouped: boolean}>} whether it had to be ungrouped
 */
async function openFlatQuoteEditor({ sf, quotePage, quoteLineEditor }, options) {
  const { instanceUrl, quoteId, label = `quote ${options.quoteId}` } = options;

  if (!quoteId) throw new Error('openFlatQuoteEditor needs a quoteId.');

  const [quote] = await sf.query(
    'SELECT Id, Name, SBQQ__LineItemsGrouped__c FROM SBQQ__Quote__c ' +
      `WHERE Id = '${escapeSoql(quoteId)}'`
  );
  if (!quote) throw new Error(`Quote ${quoteId} was not found.`);

  const ungrouped = !!quote.SBQQ__LineItemsGrouped__c;
  if (ungrouped) {
    console.log(
      `${label} (${quote.Name}) came back grouped with its lines ungrouped — unchecking Group ` +
        'Line Items so the Quote Line Editor can render it.'
    );
    await quotePage.open(instanceUrl, quoteId);
    await quotePage.openEdit();
    await quotePage.setLineItemsGrouped(false);
    await quotePage.saveEdit();

    await sf.pollForFieldValue('SBQQ__Quote__c', quoteId, 'SBQQ__LineItemsGrouped__c', false, {
      label: `${label} SBQQ__LineItemsGrouped__c -> false`,
    });
  }

  // Navigated to explicitly rather than relying on wherever the caller's last
  // action landed. CPQ does navigate to the editor after an amendment is
  // confirmed, but on a quote that still needs ungrouping that navigation
  // lands on the hung editor above — so this goes back to the record page and
  // takes Edit Lines from a known state.
  await quotePage.open(instanceUrl, quoteId);
  await quotePage.openLineEditor();
  await quoteLineEditor.waitForEditorReady();

  return { ungrouped };
}

module.exports = { openFlatQuoteEditor };
