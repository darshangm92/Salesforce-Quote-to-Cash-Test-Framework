// src/pages/ContractAmendmentPage.js
const { BasePage } = require('./BasePage');

// CPQ's amendment confirmation screen — the page the Contract's Amend action
// navigates to, before any amendment quote exists.
//
// This is VISUALFORCE, not Lightning. Confirmed against this org: clicking
// Amend on the Contract lands on
//
//   /apex/AmendContract?id=<contractId>
//
// rendered inside a single Visualforce iframe within one.app. So every locator
// here goes through a frameLocator, exactly like QuoteLineEditorPage and
// unlike ContractPage / OrderPage, which are ordinary Lightning record pages.
//
// The screen lists the contract's subscriptions with their quantities and
// offers two buttons. Confirming is what creates the amendment quote (and its
// amendment Opportunity) and opens the Quote Line Editor on it; cancelling
// returns to the Contract having created nothing.

// CONFIRMED. The iframe carries title="Amend Contract", which is what
// distinguishes it. That is a stronger discriminator than the vfFrameId name
// pattern the QLE has to fall back on: the QLE page renders TWO vfFrameId
// iframes and neither name nor title tells them apart, whereas this screen
// renders exactly one and titles it.
const AMEND_FRAME_SELECTOR = 'iframe[title="Amend Contract"]';

// CONFIRMED. Both buttons are Visualforce submit inputs:
//
//   <input type="submit" value="Amend"  onclick="toggleLoadingMask(true)" class="sbBtn">
//   <input type="submit" value="Cancel" class="sbBtn">
//
// An <input type="submit"> exposes role=button with its value as the
// accessible name, so getByRole finds them. exact: true is not optional —
// without it { name: 'Amend' } is a substring match and would also hit the
// heading text "Amend Contract" if the org ever renders that as a control.
const AMEND_LABEL = 'Amend';
const CANCEL_LABEL = 'Cancel';

// CONFIRMED. The subscription table renders as ordinary Visualforce table
// markup on this screen — not the shadow-DOM Polymer grid the QLE uses — so a
// plain tbody row count is meaningful here.
const SUBSCRIPTION_TABLE_SELECTOR = 'table';

// Loading this screen is a Visualforce round trip against the managed package.
// It is far quicker than the QLE's cold start, but still not instant.
const READY_TIMEOUT_MS = 120_000;

class ContractAmendmentPage extends BasePage {
  constructor(page) {
    super(page);
    this.screen = page.frameLocator(AMEND_FRAME_SELECTOR);
  }

  amendButton() {
    return this.screen.getByRole('button', { name: AMEND_LABEL, exact: true }).first();
  }

  cancelButton() {
    return this.screen.getByRole('button', { name: CANCEL_LABEL, exact: true }).first();
  }

  /**
   * Waits until the confirmation screen is interactive.
   *
   * Anchored on the Amend button rather than on the subscription table: the
   * button is the thing the next step clicks, and waiting for what you are
   * about to use is the only wait that cannot pass too early.
   */
  async waitForReady() {
    await this.amendButton().waitFor({ state: 'visible', timeout: READY_TIMEOUT_MS });
  }

  /** How many subscriptions the screen says it will carry into the amendment. */
  async subscriptionRowCount() {
    await this.waitForReady();
    const table = this.screen.locator(SUBSCRIPTION_TABLE_SELECTOR).first();
    await table.waitFor({ state: 'visible', timeout: READY_TIMEOUT_MS });
    return table.locator('tbody tr').count();
  }

  /**
   * Confirms the amendment.
   *
   * This is the write. CPQ creates the amendment Opportunity and the amendment
   * Quote, then navigates to the Quote Line Editor on that quote — so callers
   * follow this with QuoteLineEditorPage.waitForEditorReady() and resolve the
   * new quote's Id from the API, never from the URL (the QLE address is
   * base64-encoded into a one.app fragment).
   */
  async confirm() {
    await this.waitForReady();
    await this.amendButton().click();
    await this.waitForLightningReady();
  }

  /** Backs out without creating anything. */
  async cancel() {
    await this.waitForReady();
    await this.cancelButton().click();
    await this.waitForLightningReady();
  }
}

module.exports = { ContractAmendmentPage, AMEND_FRAME_SELECTOR };
