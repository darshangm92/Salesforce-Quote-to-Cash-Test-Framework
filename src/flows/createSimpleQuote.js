// src/flows/createSimpleQuote.js
//
// Flow: get to "an UNGROUPED quote exists against a pre-existing Account".
//
// The sibling of createQuoteWithGroups, and deliberately not a parameter on
// it. That flow's whole reason to exist is the poll for the quote line groups
// this org's record-triggered Flow creates; this one's is the opposite —
// asserting that no groups appear, because the bundle configurator suite
// depends on a single flat line table.
//
// WHY THE ACCOUNT'S INDUSTRY IS A HARD PRECONDITION
// -------------------------------------------------
// In this org, quote line groups are created by a record-triggered Flow whose
// entry condition is the Account's Industry. An Account with Industry =
// 'Retail' gets groups on every quote insert regardless of what this flow
// asks for, and a grouped quote renders a different Quote Line Editor with
// different locators.
//
// So a mismatch throws here rather than skipping, branching, or falling back
// to the grouped path. A silent branch would produce a test that passes while
// exercising a different surface than the one it claims to — which is worse
// than a red build, because nobody goes looking for it.
const { escapeSoql } = require('../utils/waitForAsync');

// The Industry value that makes this org's Flow create quote line groups.
// Confirmed 2026-07-30 against the Developer org; see the note above.
const GROUPING_INDUSTRY = 'Retail';

/**
 * @param {object} deps
 * @param {import('../api/CpqDataFactory').CpqDataFactory} deps.cpqData
 * @param {object} deps.sf  the read-only `sf` fixture
 * @param {object} options
 * @param {string} options.accountName      existing Account to quote against
 * @param {string} options.opportunityName  should carry the run marker — the
 *        Account is shared, so an unmarked name accumulates indistinguishable
 *        records under it
 * @param {string} options.closeDate        yyyy-mm-dd, required by Salesforce
 * @param {string} [options.stage]          Opportunity StageName
 * @param {string} [options.pricebookId]    defaults to the org's active standard book
 * @param {object} [options.quoteFields]    extra SBQQ__Quote__c fields
 * @param {object} [options.opportunityFields] extra Opportunity fields
 * @returns {Promise<{accountId, accountName, industry, opportunityId, quoteId, pricebookId}>}
 */
async function createSimpleQuote({ cpqData, sf }, options) {
  const {
    accountName,
    opportunityName,
    closeDate,
    stage,
    quoteFields = {},
    // Extra Opportunity fields, for rules conditioned on the OPPORTUNITY
    // rather than on the quote or the account — Scenario 3's price rule keys
    // off Opportunity.Type = 'New Customer', and setting it at seed is the
    // difference between a rule that can fire and one that never can.
    //
    // Passed through as-is rather than enumerated. Enumerating would mean this
    // flow acquiring a named parameter for every field a future scenario
    // conditions on, and the whole point of the flow is the quote shape, not
    // the field list.
    opportunityFields = {},
  } = options;

  if (!accountName) throw new Error('createSimpleQuote needs an accountName.');
  if (!opportunityName) throw new Error('createSimpleQuote needs an opportunityName.');
  if (!closeDate) throw new Error('createSimpleQuote needs a closeDate (yyyy-mm-dd).');

  // The Account is looked up, never created — this suite quotes against the
  // org's pre-existing sample accounts. registerExisting() is what records it
  // with sweepEligible = false, so the sweeper can never delete something the
  // suite did not make.
  const accounts = await sf.query(
    `SELECT Id, Name, Industry FROM Account WHERE Name = '${escapeSoql(accountName)}' LIMIT 1`
  );
  if (!accounts || !accounts.length) {
    throw new Error(
      `Account "${accountName}" not found. This flow quotes against accounts that already ` +
        'exist in the org — create it manually or point the data file at one that does.'
    );
  }
  const account = accounts[0];

  // The guard is the default and stays the default. It is opt-OUT rather than
  // opt-in because every caller but one wants a flat quote, and a caller that
  // silently got a grouped one would fail much later on a locator that expects
  // no groups.
  //
  // expectGroups is for the ONE scenario whose subject IS the grouping:
  // tests/quote/optional-lines.spec.js marks a whole quote line group Optional
  // and asserts the flag cascades, so it needs precisely the Account this
  // guard exists to keep out. It asserts the groups appeared afterwards, which
  // is the check that makes the opt-in safe — asking for groups and silently
  // getting none would otherwise be indistinguishable from asking for a flat
  // quote.
  if (account.Industry === GROUPING_INDUSTRY && !options.expectGroups) {
    throw new Error(
      `Account "${account.Name}" (${account.Id}) has Industry = '${account.Industry}'. In this ` +
        'org that is what drives the record-triggered Flow to create quote line groups, so the ' +
        'quote would render a GROUPED Quote Line Editor and this suite\'s ungrouped assumptions ' +
        'would not hold. Point the data file at an Account whose Industry is anything else, ' +
        'rather than working around it here. If your scenario WANTS the groups, pass ' +
        'expectGroups: true and assert they arrived.'
    );
  }
  if (options.expectGroups && account.Industry !== GROUPING_INDUSTRY) {
    throw new Error(
      `createSimpleQuote was asked for a GROUPED quote (expectGroups) but Account "${account.Name}" ` +
        `has Industry = '${account.Industry}', not '${GROUPING_INDUSTRY}'. In this org the groups ` +
        'come from a record-triggered Flow keyed on Industry, so this quote would come out flat ' +
        'and every group-scoped locator downstream would resolve to nothing.'
    );
  }
  cpqData.registerExisting('Account', account.Id, { name: account.Name });

  // The Opportunity MUST carry a price book.
  //
  // Creating one through the UI assigns one automatically; creating it over
  // REST does not, and without Pricebook2Id Salesforce cannot create
  // Opportunity Products at all. Resolved by query rather than stored as an
  // Id, so this survives a different org — no hardcoded record Ids anywhere.
  const pricebookId = options.pricebookId || (await resolveStandardPricebookId(sf));

  const opportunityId = await cpqData.opportunity(account.Id, {
    name: opportunityName,
    closeDate,
    Pricebook2Id: pricebookId,
    ...(stage ? { stage } : {}),
    // Last, so a caller can override Pricebook2Id or any default above.
    ...opportunityFields,
  });

  const quoteId = await cpqData.quote(opportunityId, account.Id, {
    // Grouping is left to the ORG when a caller expects groups. Forcing the
    // flag here would make the test assert against a state it had set itself,
    // rather than against the automation that is the actual precondition.
    SBQQ__LineItemsGrouped__c: !!options.expectGroups,
    // Nothing in a configurator scenario needs a primary quote, and marking it
    // primary would kick off the opportunity sync — asynchronous work that is
    // irrelevant here and would only add noise to the run.
    SBQQ__Primary__c: false,
    ...quoteFields,
  });

  return {
    accountId: account.Id,
    accountName: account.Name,
    industry: account.Industry,
    opportunityId,
    quoteId,
    pricebookId,
  };
}

/** The org's standard price book, which is what CPQ quotes default to. */
async function resolveStandardPricebookId(sf) {
  const books = await sf.query(
    'SELECT Id, Name FROM Pricebook2 WHERE IsStandard = true AND IsActive = true LIMIT 1'
  );
  if (!books || !books.length) {
    throw new Error(
      'No active standard Pricebook2 found. An Opportunity without a price book cannot hold ' +
        'Opportunity Products at all. Pass options.pricebookId explicitly if this org uses a ' +
        'non-standard book.'
    );
  }
  return books[0].Id;
}

module.exports = { createSimpleQuote };
