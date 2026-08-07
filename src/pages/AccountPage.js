// src/pages/AccountPage.js
const { BasePage } = require('./BasePage');

// The native Lightning record page for a standard Account.
//
// Deliberately minimal: the only thing the subscription lifecycle journey does
// on this page is spot-check that Assets appeared. Accounts are pre-existing
// sample data — looked up, never created, and on the sweeper's denylist so
// they are never deleted — so this class has no edit, save or action surface
// at all, and should not grow one without a scenario that needs it.

// Related lists, by the child relationship API name in their Lightning route.
// Confirmed by describe against this org: Account's child relationship to
// Asset via AccountId is the standard Assets. Account carries two other Asset
// relationships — ProvidedAssets and ServicedAssets, through different lookups
// — and neither is where this journey's assets land.
const SOBJECT = 'Account';
const RELATED_LISTS = {
  assets: 'Assets',
};

class AccountPage extends BasePage {
  async open(instanceUrl, accountId) {
    await this.openRecord(instanceUrl, accountId);
  }

  /**
   * Opens one related list's own full-page view and counts its rows.
   *
   * Not read off the record page: this org's Lightning pages put related lists
   * behind a "Related" tab, so on the default Details tab they are not in the
   * DOM at all — that tab carries only a "Related List Quick Links" card.
   * Navigating to the list's own route sidesteps the tab entirely and renders
   * exactly one list as a full table.
   *
   * Note for callers: this Account's Assets list is NOT scoped to one run.
   * The sample accounts are shared, so assert non-emptiness here and leave the
   * exact count to the API, which can filter by lineage.
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

  async assetsRelatedListRowCount(instanceUrl, accountId) {
    return this.relatedListRowCount(instanceUrl, accountId, RELATED_LISTS.assets);
  }
}

module.exports = { AccountPage, RELATED_LISTS };
