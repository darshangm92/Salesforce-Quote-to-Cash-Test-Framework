// src/flows/createQuoteWithGroups.js
//
// Flow: get to "a grouped quote exists and its groups are ready".
//
// Seeds Opportunity + Quote against a pre-existing Account, then waits for
// the org's record-triggered Flow to create the Quote Line Groups. The wait
// is the whole point — the groups do not exist at the moment the Quote insert
// returns, so anything that navigates straight to the Quote Line Editor after
// creating a grouped quote is racing the platform.
const { pollForRecords, escapeSoql } = require('../utils/waitForAsync');

const DEFAULT_GROUP_COUNT = 2;

/**
 * @param {object} deps
 * @param {import('../api/CpqDataFactory').CpqDataFactory} deps.cpqData
 * @param {object} deps.sf  the read-only `sf` fixture
 * @param {object} options
 * @param {string} options.accountName        existing Account to quote against
 * @param {string} options.opportunityName
 * @param {string} options.closeDate          yyyy-mm-dd, required by Salesforce
 * @param {string} [options.stage]            Opportunity StageName
 * @param {object} [options.quoteFields]      extra SBQQ__Quote__c fields
 * @param {number} [options.expectedGroups=2] how many groups the Flow creates
 * @param {number} [options.timeout]          poll budget in ms
 * @returns {Promise<{accountId, opportunityId, quoteId, groups, groupIdsByName}>}
 */
async function createQuoteWithGroups({ cpqData, sf }, options) {
  const {
    accountName,
    opportunityName,
    closeDate,
    stage,
    quoteFields = {},
    expectedGroups = DEFAULT_GROUP_COUNT,
    timeout,
  } = options;

  if (!accountName) throw new Error('createQuoteWithGroups needs an accountName.');
  if (!closeDate) throw new Error('createQuoteWithGroups needs a closeDate (yyyy-mm-dd).');

  // The Account is looked up, never created: this suite quotes against the
  // org's pre-existing sample accounts, and the sweeper is forbidden from
  // touching Accounts at all. registerExisting() records it in the ledger
  // with sweepEligible=false so that stays true by construction.
  const accounts = await sf.query(
    `SELECT Id, Name FROM Account WHERE Name = '${escapeSoql(accountName)}' LIMIT 1`
  );
  if (!accounts || !accounts.length) {
    throw new Error(
      `Account "${accountName}" not found. This flow quotes against accounts that already ` +
        'exist in the org — create it manually or point the data file at one that does.'
    );
  }
  const accountId = accounts[0].Id;
  cpqData.registerExisting('Account', accountId, { name: accounts[0].Name });

  // The Opportunity MUST carry a price book.
  //
  // Creating an Opportunity through the UI assigns one automatically; creating
  // it over the REST API does not. Without Pricebook2Id, Salesforce cannot
  // create OpportunityLineItems at all — so marking the quote Primary appears
  // to succeed while producing zero Opportunity Products and leaving
  // Opportunity.Amount null. That failure surfaces minutes later as a sync
  // timeout with nothing to point at, which is why it is set here at creation.
  const pricebookId = options.pricebookId || (await resolveStandardPricebookId(sf));

  const opportunityId = await cpqData.opportunity(accountId, {
    name: opportunityName,
    closeDate,
    Pricebook2Id: pricebookId,
    ...(stage ? { stage } : {}),
  });

  const quoteId = await cpqData.quote(opportunityId, accountId, {
    SBQQ__LineItemsGrouped__c: true,
    SBQQ__Primary__c: false,
    ...quoteFields,
  });

  const groupSoql =
    'SELECT Id, Name, SBQQ__Number__c FROM SBQQ__QuoteLineGroup__c ' +
    `WHERE SBQQ__Quote__c = '${escapeSoql(quoteId)}' ORDER BY SBQQ__Number__c`;

  const groups = await pollForRecords(sfClientShim(sf), groupSoql, {
    expect: expectedGroups,
    label: `SBQQ__QuoteLineGroup__c for quote ${quoteId}`,
    ...(timeout ? { timeout } : {}),
  });

  // Groups are Flow-created rather than factory-created, so register them
  // explicitly — otherwise they are invisible to both teardown and the sweeper.
  const groupIdsByName = {};
  for (const group of groups) {
    groupIdsByName[group.Name] = group.Id;
    cpqData.track('SBQQ__QuoteLineGroup__c', group.Id, {
      name: group.Name,
      parentId: quoteId,
    });
  }

  return { accountId, opportunityId, quoteId, groups, groupIdsByName };
}

// pollForRecords wants a client with .query(); the `sf` fixture exposes
// exactly that, so this is a shape adapter rather than a wrapper.
function sfClientShim(sf) {
  return { query: (soql) => sf.query(soql) };
}

/** The org's standard price book, which is what CPQ quotes default to. */
async function resolveStandardPricebookId(sf) {
  const books = await sf.query(
    'SELECT Id, Name FROM Pricebook2 WHERE IsStandard = true AND IsActive = true LIMIT 1'
  );
  if (!books || !books.length) {
    throw new Error(
      'No active standard Pricebook2 found. An Opportunity without a price book cannot hold ' +
        'Opportunity Products, so the primary-quote sync would silently produce nothing. Pass ' +
        'options.pricebookId explicitly if this org uses a non-standard book.'
    );
  }
  return books[0].Id;
}

module.exports = { createQuoteWithGroups };
