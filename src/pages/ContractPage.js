// src/pages/ContractPage.js
const { BasePage } = require('./BasePage');

// The native Lightning record page for a standard Contract — the record CPQ
// generates when an Order carrying subscription products is marked Contracted.
// Native Lightning throughout; no Visualforce iframe is involved.
//
// The one exception is Amend. That action navigates AWAY from this page to
// CPQ's Visualforce confirmation screen, which is ContractAmendmentPage's
// business — this class only knows how to click the action.

const EDIT_ACTION_LABEL = 'Edit';
const MODAL_SAVE_LABEL = 'Save';
const ACTIVATE_ACTION_LABEL = 'Activate';
const AMEND_ACTION_LABEL = 'Amend';

// [VERIFY] The Activate confirmation dialog's button label on Contract. Same
// caveat as OrderPage: Salesforce ships a second "Activate" button, but a
// customised confirmation may read "Yes" or "OK". Confirm with
// `npx playwright codegen <instance-url>` against a draft Contract.
const CONFIRM_ACTIVATE_LABEL = 'Activate';

// Field labels as the record edit modal shows them — labels, not API names,
// because that is what getByRole sees. API names noted for traceability.
//
// CONFIRMED against this org by opening the modal and probing each role:
//   Renewal Term          -> role=spinbutton  (SBQQ__RenewalTerm__c, a double)
//   Renewal Forecast      -> role=checkbox    (SBQQ__RenewalForecast__c)
//   Renewal Quoted        -> role=checkbox    (SBQQ__RenewalQuoted__c)
//   Amendment Start Date  -> role=textbox     (SBQQ__AmendmentStartDate__c)
//
// The role differences are why there is no single generic setter here: a
// getByRole('textbox') for Renewal Term matches nothing at all.
const FIELD_LABELS = {
  status: 'Status',                            // Status (standard, unprefixed)
  renewalTerm: 'Renewal Term',                 // SBQQ__RenewalTerm__c
  renewalForecast: 'Renewal Forecast',         // SBQQ__RenewalForecast__c
  renewalQuoted: 'Renewal Quoted',             // SBQQ__RenewalQuoted__c
  amendmentStartDate: 'Amendment Start Date',  // SBQQ__AmendmentStartDate__c
};

// Related lists, by the child relationship API name in their Lightning route.
// Confirmed by describe against this org:
//   SBQQ__Subscriptions__r        <- SBQQ__Subscription__c.SBQQ__Contract__c
//   SBQQ__RenewalOpportunities__r <- Opportunity.SBQQ__RenewedContract__c
//
// Note the second one carefully: it is the CHILD relationship from Opportunity
// back to Contract, not the SBQQ__RenewalOpportunity__c lookup that sits on
// Contract itself. Those are two different things and only the child
// relationship name works in a related-list route.
const SOBJECT = 'Contract';
const RELATED_LISTS = {
  subscriptions: 'SBQQ__Subscriptions__r',
  renewalOpportunities: 'SBQQ__RenewalOpportunities__r',
};

// See OrderPage for why #auraError is excluded and the result filtered to the
// visible dialog — Lightning keeps a hidden error dialog on every page and it
// sorts first, so a plain .first() waits forever on something invisible.
const MODAL_SELECTOR = 'div[role="dialog"]:not(#auraError), .slds-modal';

// CONFIRMED against this org: runtime_platform_actions-actions-ribbon is
// present and holds Edit, Amend, New Contact, New Opportunity.
//
// Scoping is required, not cosmetic. "Activate" collides with the activation
// dialog's own button, and "Amend" collides with the Amend button on the
// Visualforce confirmation screen the action navigates to. An unscoped
// getByRole matches both and fails strict mode on the very first click.
const ACTIONS_RIBBON_SELECTOR =
  'runtime_platform_actions-actions-ribbon, .slds-page-header, .forceActionsContainer';

// The date format the Lightning record edit modal's date input expects, which
// follows the running user's Locale in Setup — not ISO-8601. Typing an ISO
// date into an en-US input either fails validation or, worse, parses to the
// wrong day silently.
//
// Kept as its own constant rather than imported from QuoteLineEditorPage: that
// one describes a Visualforce input inside the QLE, and the two happening to
// agree today is not a reason to couple a Lightning modal to it.
// [VERIFY] 'M/D/YYYY' is en-US. Change this if the automation user's Locale
// differs.
const DATE_INPUT_FORMAT = 'M/D/YYYY';

/** Formats a Date for the Lightning date input (see DATE_INPUT_FORMAT). */
function formatDateForInput(date, format = DATE_INPUT_FORMAT) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const pad = (n) => String(n).padStart(2, '0');

  switch (format) {
    case 'M/D/YYYY': return `${m}/${d}/${y}`;
    case 'D/M/YYYY': return `${d}/${m}/${y}`;
    case 'DD/MM/YYYY': return `${pad(d)}/${pad(m)}/${y}`;
    case 'YYYY-MM-DD': return `${y}-${pad(m)}-${pad(d)}`;
    default:
      throw new Error(
        `Unsupported DATE_INPUT_FORMAT "${format}" in ContractPage. Add it to ` +
          'formatDateForInput() rather than formatting the date at the call site.'
      );
  }
}

/** Accepts a Date or a yyyy-mm-dd string and returns a Date. */
function toDate(value) {
  if (value instanceof Date) return value;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!match) {
    throw new Error(
      `Expected a Date or a yyyy-mm-dd string, got "${value}". Salesforce Date fields travel as ` +
        'yyyy-mm-dd over REST, so that is the only string form accepted here.'
    );
  }
  const [, y, m, d] = match.map(Number);
  return new Date(y, m - 1, d);
}

class ContractPage extends BasePage {
  async open(instanceUrl, contractId) {
    await this.openRecord(instanceUrl, contractId);
  }

  // -------------------------------------------------------------------------
  // Record edit modal
  // -------------------------------------------------------------------------

  actionsRibbon() {
    return this.page.locator(ACTIONS_RIBBON_SELECTOR).first();
  }

  editButton() {
    // exact: true throughout — getByRole matches the accessible name as a
    // substring by default, which is how { name: 'Edit' } silently picks up an
    // "Edit Status"-style inline-edit button from the details panel.
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
   * completed journey would flip Renewal Forecast straight back off.
   */
  async setCheckbox(fieldLabel, checked = true) {
    const box = this.checkbox(fieldLabel);
    if (checked) await box.check();
    else await box.uncheck();
  }

  /**
   * Checking this is what makes CPQ generate the renewal Opportunity, with the
   * contract's subscriptions copied onto it as Opportunity Products and any
   * product carrying an SBQQ__RenewalProduct__c substituted for its successor.
   * None of that exists when saveEdit() returns — poll the API for it.
   */
  async setRenewalForecast(checked = true) {
    await this.setCheckbox(FIELD_LABELS.renewalForecast, checked);
  }

  /**
   * Checking this is what makes CPQ generate the renewal Quote against the
   * renewal Opportunity. Same asynchrony caveat as setRenewalForecast().
   */
  async setRenewalQuoted(checked = true) {
    await this.setCheckbox(FIELD_LABELS.renewalQuoted, checked);
  }

  /** Renewal Term renders as a spinbutton, not a textbox — see FIELD_LABELS. */
  renewalTermInput() {
    return this.editModal().getByRole('spinbutton', { name: FIELD_LABELS.renewalTerm });
  }

  async setRenewalTerm(months) {
    await this.renewalTermInput().fill(String(months));
  }

  amendmentStartDateInput() {
    return this.editModal().getByRole('textbox', { name: FIELD_LABELS.amendmentStartDate });
  }

  /**
   * Sets Amendment Start Date, which is what makes CPQ pro-rate an amendment
   * from a mid-term date rather than from the contract's start.
   *
   * This is an ordinary Lightning date input, so fill() is correct here — the
   * pressSequentially dance in QuoteLineEditorPage exists for the QLE's
   * Polymer-bound Visualforce inputs and does not apply to a Lightning modal.
   *
   * Tab afterwards, NOT Escape. Typing into the field opens a datepicker
   * popover that overlays the modal footer, so focus has to leave the field
   * before Save is clickable — but Escape does not just close the popover, it
   * closes the whole SLDS dialog and DISCARDS the edit. That failure is
   * particularly nasty: the modal is gone, so the next click on Save times out
   * having "resolved" a button that then detaches, and the record is left
   * untouched with nothing in the error naming the cause.
   *
   * Tab moves focus to the next field, which dismisses the popover and keeps
   * the modal open.
   *
   * @param {Date|string} date  a Date, or yyyy-mm-dd as Salesforce returns it
   */
  async setAmendmentStartDate(date) {
    const input = this.amendmentStartDateInput();
    await input.fill(formatDateForInput(toDate(date)));
    await input.press('Tab');
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

  /** The value formatDateForInput() would produce — for comparing against the UI. */
  static displayDate(date) {
    return formatDateForInput(toDate(date));
  }

  // -------------------------------------------------------------------------
  // Activation
  // -------------------------------------------------------------------------

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
   * Activates the contract and waits for the confirmation dialog to close.
   * The dialog closing only means the click was accepted — poll the record for
   * the Status flip rather than trusting the UI settling.
   */
  async activate() {
    await this.activateAction().click();
    await this.confirmDialog().waitFor({ state: 'visible' });
    await this.confirmActivateButton().click();
    await this.confirmDialog().waitFor({ state: 'hidden' });
    await this.waitForLightningReady();
  }

  // -------------------------------------------------------------------------
  // Amend
  // -------------------------------------------------------------------------

  /**
   * The Amend action in the record page header.
   *
   * Ribbon-scoped and exact for the reason spelled out at
   * ACTIONS_RIBBON_SELECTOR: the confirmation screen this action navigates to
   * carries its own button named "Amend", and an unscoped locator would match
   * both once that screen renders.
   */
  amendAction() {
    return this.actionsRibbon()
      .getByRole('button', { name: AMEND_ACTION_LABEL, exact: true })
      .first();
  }

  /**
   * Clicks Amend and leaves the browser on CPQ's Visualforce amendment
   * confirmation screen (/apex/AmendContract). Nothing is created yet — the
   * amendment quote appears only once that screen's own Amend is confirmed,
   * which is ContractAmendmentPage.confirm().
   */
  async amend() {
    await this.amendAction().click();
    await this.waitForLightningReady();
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  statusField() {
    return this.page
      .locator('records-highlights-details-item')
      .filter({ hasText: FIELD_LABELS.status })
      .first();
  }

  /**
   * The rendered Status. The highlights item holds the label and the value
   * together, so the label is stripped off the front and callers should assert
   * with toContain. The record is what proves correctness; this is a spot-check.
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
   * Leaves the browser on the related list page — read the status badge from
   * the record page BEFORE calling this.
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

  async subscriptionsRelatedListRowCount(instanceUrl, contractId) {
    return this.relatedListRowCount(instanceUrl, contractId, RELATED_LISTS.subscriptions);
  }

  async renewalOpportunitiesRelatedListRowCount(instanceUrl, contractId) {
    return this.relatedListRowCount(instanceUrl, contractId, RELATED_LISTS.renewalOpportunities);
  }
}

module.exports = { ContractPage, FIELD_LABELS, RELATED_LISTS, formatDateForInput, DATE_INPUT_FORMAT };
