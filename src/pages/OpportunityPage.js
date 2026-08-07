// src/pages/OpportunityPage.js
const { BasePage } = require('./BasePage');

// The native Lightning record page for Opportunity.
//
// Most Opportunities in this suite are seeded through the API (CpqDataFactory),
// since the UI is for validating behavior and not for building data — so this
// class started life as a read-only surface.
//
// The renewal stages changed that. The renewal Opportunity is created by CPQ,
// not by the suite, and it needs renaming through the UI so a human opening
// the org can tell which run produced it. Hence the edit modal below.

const EDIT_ACTION_LABEL = 'Edit';
const MODAL_SAVE_LABEL = 'Save';

// Field labels as the record edit modal shows them — labels, not API names.
const FIELD_LABELS = {
  name: 'Opportunity Name', // Name
};

// Related lists, by the child relationship API name in their Lightning route.
// Confirmed by describe against this org: Opportunity's child relationship to
// OpportunityLineItem is the standard OpportunityLineItems, and to
// SBQQ__Quote__c it is SBQQ__Quotes2__r (through SBQQ__Opportunity2__c).
const SOBJECT = 'Opportunity';
const RELATED_LISTS = {
  products: 'OpportunityLineItems',
  quotes: 'SBQQ__Quotes2__r',
};

// The Lightning record edit modal. #auraError is excluded and the result
// filtered to the visible one for the reason QuotePage and OrderPage both spell
// out: Lightning keeps a hidden <div role="dialog" id="auraError"> on every
// page and it sorts BEFORE the real modal, so a plain .first() resolves to a
// dialog that never becomes visible and the wait times out with the modal open
// right there on screen.
const MODAL_SELECTOR = 'div[role="dialog"]:not(#auraError), .slds-modal';

// Where Lightning renders a record page's action buttons. Scoping the header
// action keeps { name: 'Edit' } off the details panel's inline "Edit <field>"
// buttons, which are numerous on an Opportunity.
const ACTIONS_RIBBON_SELECTOR =
  'runtime_platform_actions-actions-ribbon, .slds-page-header, .forceActionsContainer';

class OpportunityPage extends BasePage {
  async open(instanceUrl, opportunityId) {
    await this.openRecord(instanceUrl, opportunityId);
  }

  // -------------------------------------------------------------------------
  // Record edit modal
  // -------------------------------------------------------------------------

  actionsRibbon() {
    return this.page.locator(ACTIONS_RIBBON_SELECTOR).first();
  }

  editButton() {
    // exact: true — getByRole matches the accessible name as a substring by
    // default, so { name: 'Edit' } would also match "Edit Close Date" and every
    // other inline-edit control in the details panel.
    return this.actionsRibbon()
      .getByRole('button', { name: EDIT_ACTION_LABEL, exact: true })
      .first();
  }

  editModal() {
    return this.page.locator(MODAL_SELECTOR).filter({ visible: true }).first();
  }

  async openEdit() {
    await this.editButton().click();
    await this.editModal().waitFor({ state: 'visible' });
  }

  nameInput() {
    return this.editModal().getByRole('textbox', { name: FIELD_LABELS.name });
  }

  /**
   * Renames the Opportunity.
   *
   * fill(), not pressSequentially: this is an ordinary Lightning text input,
   * not one of the QLE's Polymer-bound Visualforce fields.
   */
  async setName(name) {
    await this.nameInput().fill(name);
  }

  /**
   * Saves the edit modal and waits for it to close.
   *
   * Waiting for the modal to detach — rather than just for the spinner — is
   * what distinguishes a real save from one blocked by a validation rule,
   * which leaves the modal open with an error banner.
   */
  async saveEdit() {
    await this.editModal()
      .getByRole('button', { name: MODAL_SAVE_LABEL, exact: true })
      .first()
      .click();
    await this.editModal().waitFor({ state: 'hidden' });
    await this.waitForLightningReady();
  }

  // -------------------------------------------------------------------------
  // Related lists
  // -------------------------------------------------------------------------

  /**
   * Opens one related list's own full-page view and counts its rows.
   *
   * Not read off the record page: this org's Lightning pages put related lists
   * behind a "Related" tab, so on the default Details tab they are not in the
   * DOM at all. Navigating to the list's own route sidesteps the tab entirely
   * and renders exactly one list as a full table.
   *
   * Leaves the browser on the related list page, not the record page — read
   * anything you want from the record page BEFORE calling this.
   */
  async relatedListRowCount(instanceUrl, recordId, relationship) {
    await this.page.goto(
      `${instanceUrl}/lightning/r/${SOBJECT}/${recordId}/related/${relationship}/view`
    );
    await this.waitForLightningReady();

    const table = this.page.locator('table').first();
    await table.waitFor({ state: 'visible' });
    // <tbody> rows only — getByRole('row') would count the header row too.
    return table.locator('tbody tr').count();
  }

  async productsRelatedListRowCount(instanceUrl, opportunityId) {
    return this.relatedListRowCount(instanceUrl, opportunityId, RELATED_LISTS.products);
  }

  async quotesRelatedListRowCount(instanceUrl, opportunityId) {
    return this.relatedListRowCount(instanceUrl, opportunityId, RELATED_LISTS.quotes);
  }
}

module.exports = { OpportunityPage, FIELD_LABELS, RELATED_LISTS };
