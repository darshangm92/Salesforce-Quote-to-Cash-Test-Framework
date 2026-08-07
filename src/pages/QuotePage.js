// src/pages/QuotePage.js
const { BasePage } = require('./BasePage');

// Represents the native Lightning record page for SBQQ__Quote__c (not the
// Visualforce Quote Line Editor — that's QuoteLineEditorPage). This page is
// the jumping-off point into the QLE and the surface for editing header
// checkboxes (Primary, Order by Quote Line Group, Ordered).
//
// It is NOT an approvals surface. The Submit for Approval / status methods
// that used to live here were deleted on 2026-08-03 — see the note where they
// were, at the bottom of the class.

// Button and field labels, in one place.
const EDIT_ACTION_LABEL = 'Edit';
const EDIT_LINES_LABEL = 'Edit Lines';
const MODAL_SAVE_LABEL = 'Save';

// [VERIFY] Whether this org's Quote page layout exposes a Calculate button at
// all. CPQ ships the action, but putting it on the Lightning record page is a
// page-layout decision, not a package guarantee. calculate() reports its
// absence by name rather than timing out on a generic locator, because
// "there is no Calculate button here" is a finding about the org and should
// read as one.
const CALCULATE_LABEL = 'Calculate';

// Field labels as they appear in the record edit modal. These are *labels*,
// not API names, because that is what the modal exposes to a user and to
// getByRole. The API names they correspond to are noted for traceability.
const FIELD_LABELS = {
  primary: 'Primary',                              // SBQQ__Primary__c
  orderByQuoteLineGroup: 'Order By Quote Line Group', // SBQQ__OrderByQuoteLineGroup__c
  ordered: 'Ordered',                              // SBQQ__Ordered__c
  // CONFIRMED: SBQQ__LineItemsGrouped__c carries the label "Group Line Items",
  // not "Line Items Grouped".
  lineItemsGrouped: 'Group Line Items',            // SBQQ__LineItemsGrouped__c
};

// Related lists, by the child relationship API name in their Lightning route.
//
// Confirmed by describe against this org, not guessed: SBQQ__Quote__c's child
// relationship to Order is SBQQ__Orders__r. A wrong name here renders a
// Lightning error page rather than returning a 404, so the failure would read
// as an empty related list instead of a bad selector.
const SOBJECT = 'SBQQ__Quote__c';
const RELATED_LISTS = {
  orders: 'SBQQ__Orders__r',
};

// The Lightning record edit modal.
//
// #auraError is excluded explicitly and the result is filtered to the visible
// one: Lightning keeps a hidden <div role="dialog" id="auraError"> in every
// page, and it sorts before the real modal — so a plain `.first()` resolves to
// a dialog that is never visible and the wait times out with the modal open
// right there on screen.
const MODAL_SELECTOR = 'div[role="dialog"]:not(#auraError), .slds-modal';

class QuotePage extends BasePage {
  async open(instanceUrl, quoteId) {
    await this.openRecord(instanceUrl, quoteId);
  }

  editLinesButton() {
    // Placeholder — the custom "Edit Lines" button label/selector may differ per org.
    return this.page.getByRole('button', { name: EDIT_LINES_LABEL });
  }

  // Clicking "Edit Lines" navigates away from the Lightning record page to the
  // Visualforce QLE (apex/SBQQ__sb), so we wait for the new page to settle
  // rather than for the Lightning spinner, which won't be present there.
  async openLineEditor() {
    await this.editLinesButton().click();
    await this.page.waitForLoadState('domcontentloaded');
  }

  // -------------------------------------------------------------------------
  // Record edit modal
  // -------------------------------------------------------------------------

  editButton() {
    // `exact` matters: without it this also matches "Edit Lines", and the
    // journey silently ends up in the Quote Line Editor instead of the modal.
    return this.page.getByRole('button', { name: EDIT_ACTION_LABEL, exact: true });
  }

  editModal() {
    return this.page.locator(MODAL_SELECTOR).filter({ visible: true }).first();
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
   * Sets a checkbox to an explicit state rather than toggling it. Toggling is
   * how a re-run flips a field back off: check()/uncheck() are idempotent,
   * click() is not.
   */
  async setCheckbox(fieldLabel, checked = true) {
    const box = this.checkbox(fieldLabel);
    if (checked) await box.check();
    else await box.uncheck();
  }

  async setPrimary(checked = true) {
    await this.setCheckbox(FIELD_LABELS.primary, checked);
  }

  async setOrderByQuoteLineGroup(checked = true) {
    await this.setCheckbox(FIELD_LABELS.orderByQuoteLineGroup, checked);
  }

  // Checking this is what makes CPQ generate the Order(s) — one per quote line
  // group when SBQQ__OrderByQuoteLineGroup__c is also true. The Orders do not
  // exist when saveEdit() returns; poll the API for them.
  async setOrdered(checked = true) {
    await this.setCheckbox(FIELD_LABELS.ordered, checked);
  }

  /**
   * Whether the Quote Line Editor renders one section per quote line group or
   * a single flat line table.
   *
   * Unchecking this is not cosmetic on an amendment quote — it is what makes
   * the editor load at all. See the long note in src/flows/amendContract.js:
   * an amendment quote inherits SBQQ__LineItemsGrouped__c = true and gets
   * groups from this org's record-triggered Flow, but CPQ leaves every
   * amendment line with SBQQ__Group__c = null, and the grouped editor then
   * spins forever on lines it cannot place.
   */
  async setLineItemsGrouped(checked = true) {
    await this.setCheckbox(FIELD_LABELS.lineItemsGrouped, checked);
  }

  /**
   * A free-text field inside the edit modal, by its visible field label.
   *
   * getByRole('textbox') rather than a CSS chain into the field's container.
   * Lightning renders each field as a <lightning-input> custom element, and a
   * single CSS descendant selector does not cross a shadow boundary — but
   * getByRole resolves through open shadow roots, and the label-to-input
   * association is exactly what the accessibility tree records. The chained
   * .locator() form would work too; the role form additionally fails loudly
   * when the field is rendered read-only, which is a real possibility for a
   * formula or a field the running user cannot edit.
   */
  textField(fieldLabel) {
    return this.editModal().getByRole('textbox', { name: fieldLabel }).first();
  }

  /**
   * Sets one text field on the quote: opens the edit modal, types, saves.
   *
   * The whole open-edit-save round trip rather than a bare setter, because
   * that is the unit that has an observable outcome — a value typed into a
   * modal that is never saved changes nothing, and a test asserting on the
   * record afterwards would fail for a reason that has nothing to do with the
   * behaviour under test.
   *
   * Passing an empty string CLEARS the field. Select-all then type is used
   * rather than fill(), matching QuoteLineEditorPage.typeInto(): it produces
   * the keystroke events a component's model listens for, where fill() sets
   * the DOM value in one shot and can leave the field looking correct while
   * the model behind it stays stale.
   *
   * @param {string} fieldLabel  the label as the modal renders it, not the API name
   * @param {string} value       '' to clear
   */
  async setField(fieldLabel, value) {
    await this.openEdit();

    const input = this.textField(fieldLabel);
    await input.waitFor({ state: 'visible' });
    await input.click();
    await input.press('ControlOrMeta+a');
    if (String(value).length) {
      await input.pressSequentially(String(value), { delay: 20 });
    } else {
      // Select-all then Delete. pressSequentially('') is a no-op, so a clear
      // has to be an explicit deletion or the old value survives the save.
      await input.press('Delete');
    }

    await this.saveEdit();
  }

  // -------------------------------------------------------------------------
  // Calculate
  // -------------------------------------------------------------------------

  calculateButton() {
    return this.page
      .getByRole('button', { name: CALCULATE_LABEL, exact: true })
      .filter({ visible: true })
      .first();
  }

  /** Whether this org's page layout exposes the Calculate action. See CALCULATE_LABEL. */
  async hasCalculateButton() {
    return this.calculateButton().isVisible().catch(() => false);
  }

  /**
   * Runs CPQ's calculation from the quote RECORD page — not from the Quote
   * Line Editor, which has its own Calculate.
   *
   * This exists for one question: does a field edit re-price the quote on its
   * own, or only when calculation is asked for explicitly? A price that moves
   * only after this is called proves the field is absent from the org's
   * Calculating Fields field set. So the caller needs the two paths kept
   * separate, and this must never be folded into setField().
   *
   * Waiting on the record afterwards is the CALLER's job: the button returns
   * as soon as CPQ accepts the request, and the recalculated prices land
   * asynchronously. Poll for them through `sf`, never through the UI.
   */
  async calculate() {
    if (!(await this.hasCalculateButton())) {
      throw new Error(
        `No "${CALCULATE_LABEL}" button on this quote's Lightning record page. Whether CPQ's ` +
          'Calculate action appears here is a page-layout decision in this org, not something ' +
          'the managed package guarantees — add the action to the Quote layout, or update ' +
          'CALCULATE_LABEL in QuotePage if this org labels it differently.'
      );
    }
    await this.calculateButton().click();
    await this.waitForLightningReady();
  }

  // -------------------------------------------------------------------------
  // Related lists
  // -------------------------------------------------------------------------

  /**
   * Opens one related list's own full-page view and counts its rows.
   *
   * Deliberately NOT read off the record page. This org's Lightning pages put
   * related lists behind a "Related" tab, so on the default Details tab they
   * are not in the DOM at all — that tab carries only a "Related List Quick
   * Links" card, which is why matching a related list card by its heading
   * there times out. Navigating to the list's own route sidesteps the tab
   * entirely and renders exactly one list as a full table.
   *
   * Note this leaves the browser on the related list page, not the record
   * page. Callers that also want something from the record page should read it
   * first, or re-open afterwards.
   */
  async relatedListRowCount(instanceUrl, recordId, relationship) {
    await this.page.goto(
      `${instanceUrl}/lightning/r/${SOBJECT}/${recordId}/related/${relationship}/view`
    );
    await this.waitForLightningReady();

    const table = this.page.locator('table').first();
    await table.waitFor({ state: 'visible' });
    // <tbody> rows only. getByRole('row') would include the table's header
    // row, so every count would come back one too high — and a spot-check
    // that is reliably off by one is worse than no spot-check.
    return table.locator('tbody tr').count();
  }

  async ordersRelatedListRowCount(instanceUrl, quoteId) {
    return this.relatedListRowCount(instanceUrl, quoteId, RELATED_LISTS.orders);
  }

  /**
   * Saves the edit modal and waits for it to close.
   *
   * Waiting for the modal to detach — rather than just for the spinner — is
   * what distinguishes a successful save from a save blocked by a validation
   * rule, which leaves the modal open with an error banner.
   */
  async saveEdit() {
    // exact: true — getByRole matches the accessible name as a substring by
    // default, so { name: 'Save' } would also match "Save & New".
    await this.editModal()
      .getByRole('button', { name: MODAL_SAVE_LABEL, exact: true })
      .first()
      .click();
    await this.editModal().waitFor({ state: 'hidden' });
    await this.waitForLightningReady();
  }

  // -------------------------------------------------------------------------
  // Status / approvals
  //
  // DELETED 2026-08-03: statusField(), status(), submitForApprovalButton() and
  // submitForApproval(), along with src/pages/ApprovalPage.js. No test called
  // any of them, and none would have worked if one had — statusField() located
  // on `[data-field="SBQQ__Status__c"]`, and MEASURED 2026-08-02, this app's
  // cells carry `field`, not `data-field`. So they were not merely
  // unused, they were unused AND known-wrong, which is the worst combination
  // to leave in a page class: the next person reads a method that looks
  // supported, and finds out otherwise against the org.
  //
  // ContractPage.status() and OrderPage.status() are the VERIFIED pattern to
  // copy when a quote status read is actually needed — both are anchored on
  // the record-page highlights panel and are exercised by the journey.
  // -------------------------------------------------------------------------
}

module.exports = { QuotePage, FIELD_LABELS, RELATED_LISTS };
