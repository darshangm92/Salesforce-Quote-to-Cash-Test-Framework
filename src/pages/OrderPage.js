// src/pages/OrderPage.js
const { BasePage } = require('./BasePage');

// The native Lightning record page for a standard Order.
//
// Nothing here is a Visualforce iframe. The frameLocator handling in
// QuoteLineEditorPage/ProductSelectionPage exists for the CPQ Quote Line
// Editor alone and must not be copied into this class — an Order record page
// is ordinary Lightning, reached through BasePage.openRecord().

// Header actions and modal buttons, in one place.
const EDIT_ACTION_LABEL = 'Edit';
const MODAL_SAVE_LABEL = 'Save';
const ACTIVATE_ACTION_LABEL = 'Activate';

// [VERIFY] The Activate confirmation dialog's button label. Salesforce ships
// this as a second "Activate" button, but a customised confirmation may read
// "Yes" or "OK" instead. Confirm with `npx playwright codegen <instance-url>`
// against a draft Order (README Section 12) and change this one constant.
const CONFIRM_ACTIVATE_LABEL = 'Activate';

// Field labels as the record edit modal shows them — labels, not API names,
// because that is what getByRole sees. API names noted for traceability.
const FIELD_LABELS = {
  contracted: 'Contracted', // SBQQ__Contracted__c
  status: 'Status',         // Status (standard, unprefixed)
};

// Related lists, by the child relationship API name in their Lightning route.
// Confirmed by describe against this org: Order's child relationship to
// OrderItem is the standard OrderItems.
const SOBJECT = 'Order';
const RELATED_LISTS = {
  orderProducts: 'OrderItems',
};

// The Lightning record edit modal. Copied verbatim from QuotePage, and
// deliberately so: #auraError is a hidden <div role="dialog"> that Lightning
// keeps on every page and that sorts BEFORE the real modal, so a plain
// .first() resolves to a dialog that never becomes visible and the wait times
// out with the modal open on screen. Excluding it and filtering to the visible
// one is the version that works.
const MODAL_SELECTOR = 'div[role="dialog"]:not(#auraError), .slds-modal';

// Where Lightning renders a record page's action buttons.
//
// Scoping the header action matters here in a way it does not elsewhere: the
// page action and the confirmation dialog's button share the accessible name
// "Activate", so an unscoped getByRole('button', { name: 'Activate' }) matches
// both and fails strict mode on the very first click. The two are modelled as
// separate locators for that reason.
// [VERIFY] Confirm the ribbon element against your org via codegen; the
// selector list below covers the layouts Lightning currently ships.
const ACTIONS_RIBBON_SELECTOR =
  'runtime_platform_actions-actions-ribbon, .slds-page-header, .forceActionsContainer';

class OrderPage extends BasePage {
  async open(instanceUrl, orderId) {
    await this.openRecord(instanceUrl, orderId);
  }

  // -------------------------------------------------------------------------
  // Record edit modal
  // -------------------------------------------------------------------------

  editButton() {
    // exact: true throughout this class — getByRole matches the accessible
    // name as a substring by default, which is how { name: 'Edit' } silently
    // picks up an "Edit Lines"-style button on a neighbouring layout.
    return this.actionsRibbon()
      .getByRole('button', { name: EDIT_ACTION_LABEL, exact: true })
      .first();
  }

  // The visible Lightning modal. The edit modal and the activation
  // confirmation are the same construct and never coexist, so both names
  // resolve here — but they are named separately because a reader of
  // activate() should not have to wonder why it waits on an "edit" modal.
  modal() {
    return this.page.locator(MODAL_SELECTOR).filter({ visible: true }).first();
  }

  editModal() {
    return this.modal();
  }

  confirmDialog() {
    return this.modal();
  }

  async openEdit() {
    await this.editButton().click();
    await this.editModal().waitFor({ state: 'visible' });
  }

  /** A checkbox inside the edit modal, by its visible field label. */
  checkbox(fieldLabel) {
    return this.editModal().getByRole('checkbox', { name: fieldLabel });
  }

  /**
   * Sets a checkbox to an explicit state rather than toggling it. check() and
   * uncheck() are idempotent; click() is not, so a re-run against a partially
   * completed journey would flip Contracted straight back off.
   */
  async setCheckbox(fieldLabel, checked = true) {
    const box = this.checkbox(fieldLabel);
    if (checked) await box.check();
    else await box.uncheck();
  }

  // Checking this is what makes CPQ generate the Contract (and its
  // Subscriptions) or the Assets, depending on the products on the order.
  // Neither exists when saveEdit() returns — poll the API for them.
  async setContracted(checked = true) {
    await this.setCheckbox(FIELD_LABELS.contracted, checked);
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
  // Activation
  // -------------------------------------------------------------------------

  actionsRibbon() {
    return this.page.locator(ACTIONS_RIBBON_SELECTOR).first();
  }

  /** The Activate action in the record page header — never the dialog's. */
  activateAction() {
    return this.actionsRibbon()
      .getByRole('button', { name: ACTIVATE_ACTION_LABEL, exact: true })
      .first();
  }

  /** The Activate button inside the confirmation dialog — never the header's. */
  confirmActivateButton() {
    return this.confirmDialog()
      .getByRole('button', { name: CONFIRM_ACTIVATE_LABEL, exact: true })
      .first();
  }

  /**
   * Activates the order and waits for the confirmation dialog to close.
   *
   * The dialog closing means Salesforce accepted the click, nothing more. The
   * Status flip and everything CPQ does behind it are asynchronous, so the
   * caller still has to poll the record rather than trust the UI settling.
   */
  async activate() {
    await this.activateAction().click();
    await this.confirmDialog().waitFor({ state: 'visible' });
    await this.confirmActivateButton().click();
    await this.confirmDialog().waitFor({ state: 'hidden' });
    await this.waitForLightningReady();
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  statusField() {
    // Addressed by field label rather than by position: the highlights panel's
    // field order is page-layout configuration and not ours to depend on.
    return this.page
      .locator('records-highlights-details-item')
      .filter({ hasText: FIELD_LABELS.status })
      .first();
  }

  /**
   * The rendered Status. The highlights item contains both the label and the
   * value ("Status\nActivated"), so the label is stripped off the front —
   * which is also why callers should assert with toContain rather than an
   * exact match. Correctness lives in the record; this is a spot-check.
   */
  async status() {
    const text = await this.statusField().innerText();
    return text.replace(new RegExp(`^\\s*${FIELD_LABELS.status}\\s*`), '').trim();
  }

  // -------------------------------------------------------------------------
  // Related lists
  // -------------------------------------------------------------------------

  /**
   * Opens one related list's own full-page view and counts its rows.
   *
   * Not read off the record page: this org's Lightning pages put related lists
   * behind a "Related" tab, so they are absent from the DOM on the default
   * Details tab. Navigating to the list's own route sidesteps the tab and
   * renders exactly one list as a full table.
   *
   * Leaves the browser on the related list page, not the record page.
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

  async orderProductsRelatedListRowCount(instanceUrl, orderId) {
    return this.relatedListRowCount(instanceUrl, orderId, RELATED_LISTS.orderProducts);
  }
}

module.exports = { OrderPage, FIELD_LABELS, RELATED_LISTS };
