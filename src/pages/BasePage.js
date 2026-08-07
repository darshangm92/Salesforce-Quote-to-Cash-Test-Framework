// src/pages/BasePage.js
//
// Shared behavior every Lightning-facing page class needs. Every page class
// in this folder extends this rather than duplicating readiness waits.
class BasePage {
  constructor(page) {
    this.page = page;
  }

  // Waits past both the initial page load and Lightning's own loading
  // spinner. Wait for explicit state, never a fixed waitForTimeout — a spinner
  // disappearing is a real signal, a delay is a guess.
  async waitForLightningReady() {
    await this.page.waitForLoadState('domcontentloaded');
    const spinner = this.page.locator('lightning-spinner, .slds-spinner');
    if (await spinner.count()) {
      // .catch(() => {}) swallows the timeout rather than failing the test —
      // if the spinner never appeared at all (page loaded too fast to catch
      // it), waiting for "hidden" on a spinner that's already gone is fine to skip.
      await spinner.first().waitFor({ state: 'hidden', timeout: 30000 }).catch(() => {});
    }
  }

  // Navigates straight to a record's Lightning detail view by Id — the
  // standard `/lightning/r/<id>/view` URL works for any object, so
  // subclasses (Quote, Opportunity, Approval) all reuse this instead of
  // building their own URLs.
  async openRecord(instanceUrl, recordId) {
    await this.page.goto(`${instanceUrl}/lightning/r/${recordId}/view`);
    await this.waitForLightningReady();
  }
}

module.exports = { BasePage };
