// src/flows/amendContract.js
//
// Flow: get from "an activated Contract" to "its amendment quote is open in
// the Quote Line Editor and its Id is known".
//
// This is a business transition in the Section 3.15 sense — it spans three
// screens (the Contract's edit modal, CPQ's Visualforce amendment
// confirmation, the QLE), waits on work the platform does off the request
// thread, and is only actually complete once the records exist.
//
// WHY THE QUOTE ID COMES FROM THE API AND NOT THE URL
// ---------------------------------------------------
// Confirming the amendment navigates to the QLE, but in Lightning that address
// is base64-encoded into a one.app fragment rather than sitting in the URL as
// /apex/SBQQ__sb?id=<quoteId>. Parsing it back out would couple this flow to
// an encoding Salesforce owns. The amendment quote is identifiable in the data
// model instead: SBQQ__MasterContract__c points at the contract it amends.
const { escapeSoql } = require('../utils/waitForAsync');
const { openFlatQuoteEditor } = require('./openFlatQuoteEditor');

// SBQQ__Quote__c.SBQQ__Type__c picklist, confirmed by describe against this
// org's package version: Quote, Renewal, Amendment, Re-Quote.
const AMENDMENT_TYPE = 'Amendment';

/**
 * @param {object} deps
 * @param {import('../api/CpqDataFactory').CpqDataFactory} deps.cpqData
 * @param {object} deps.sf                    read-only `sf` fixture
 * @param {object} deps.contractPage
 * @param {object} deps.contractAmendment     ContractAmendmentPage
 * @param {object} deps.quotePage
 * @param {object} deps.quoteLineEditor
 * @param {object} options
 * @param {string} options.instanceUrl
 * @param {string} options.contractId         the activated Contract to amend
 * @param {string} options.amendmentStartDate yyyy-mm-dd
 * @param {string[]} [options.knownQuoteIds]  amendment quotes already made
 *        against this contract, excluded so a second amendment finds the new
 *        one rather than re-finding the first
 * @param {number} [options.timeout]          poll budget in ms
 * @returns {Promise<{quoteId: string, opportunityId: string|undefined}>}
 */
async function amendContract(
  { cpqData, sf, contractPage, contractAmendment, quotePage, quoteLineEditor },
  options
) {
  const {
    instanceUrl,
    contractId,
    amendmentStartDate,
    knownQuoteIds = [],
    timeout = 180_000,
  } = options;

  if (!contractId) throw new Error('amendContract needs a contractId.');
  if (!amendmentStartDate) {
    throw new Error('amendContract needs an amendmentStartDate (yyyy-mm-dd).');
  }

  // ---------------------------------------------------------------------------
  // 1. Amendment Start Date, on the Contract's record edit modal.
  //
  // This is what makes CPQ pro-rate. Without it the amendment starts at the
  // contract's own start date and every pro-rated figure downstream comes out
  // as a full-term amount — a wrong number rather than an error.
  // ---------------------------------------------------------------------------
  await contractPage.open(instanceUrl, contractId);
  await contractPage.openEdit();
  await contractPage.setAmendmentStartDate(amendmentStartDate);
  await contractPage.saveEdit();

  // The modal closing means Salesforce accepted the save, nothing more. Read
  // the record back before spending a QLE load on a date that never landed —
  // and a date that never lands is not hypothetical here, it is what happens
  // when the datepicker popover is dismissed with Escape instead of Tab (see
  // ContractPage.setAmendmentStartDate).
  //
  // Written as a raw poll rather than sf.pollForFieldValue() because the value
  // is a DATE. pollForFieldValue renders its expected value through
  // formatSoqlValue(), which quotes strings — and a quoted date literal is
  // rejected outright: "value of filter criterion for field
  // 'SBQQ__AmendmentStartDate__c' must be of type date and should not be
  // enclosed in quotes [INVALID_FIELD]". A SOQL Date literal is bare yyyy-mm-dd,
  // which is why it is interpolated directly here, the same way the lifecycle
  // spec filters on SBQQ__StartDate__c.
  const amendmentStartLiteral = String(amendmentStartDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(amendmentStartLiteral)) {
    throw new Error(
      `amendmentStartDate must be yyyy-mm-dd for an unquoted SOQL date literal, got ` +
        `"${amendmentStartLiteral}".`
    );
  }
  await sf.pollForRecords(
    'SELECT Id, SBQQ__AmendmentStartDate__c FROM Contract ' +
      `WHERE Id = '${escapeSoql(contractId)}' ` +
      `AND SBQQ__AmendmentStartDate__c = ${amendmentStartLiteral}`,
    {
      expect: 1,
      label: `Contract ${contractId} SBQQ__AmendmentStartDate__c -> ${amendmentStartLiteral}`,
    }
  );

  // ---------------------------------------------------------------------------
  // 2. Amend, then Amend again on the Visualforce confirmation screen.
  //
  // Two clicks with the same name on two different surfaces. Both page classes
  // scope their locator so neither can match the other's — see the notes in
  // ContractPage.amendAction() and ContractAmendmentPage.
  // ---------------------------------------------------------------------------
  await contractPage.amend();
  await contractAmendment.confirm();

  // ---------------------------------------------------------------------------
  // 3. Resolve the amendment quote.
  //
  // Polled, not read once: the quote is created by the managed package during
  // the confirmation round trip and the browser can arrive at the editor
  // before the insert is visible to a separate REST session.
  // ---------------------------------------------------------------------------
  const exclusion = knownQuoteIds.length
    ? ` AND Id NOT IN (${knownQuoteIds.map((id) => `'${escapeSoql(id)}'`).join(', ')})`
    : '';

  const quote = await sf.pollForRecord(
    'SELECT Id, Name, SBQQ__Type__c, SBQQ__LineItemsGrouped__c, SBQQ__Opportunity2__c, ' +
      'SBQQ__StartDate__c, SBQQ__EndDate__c FROM SBQQ__Quote__c ' +
      `WHERE SBQQ__MasterContract__c = '${escapeSoql(contractId)}' ` +
      `AND SBQQ__Type__c = '${AMENDMENT_TYPE}'${exclusion}`,
    {
      label: `amendment quote for contract ${contractId}`,
      timeout,
    }
  );

  // No Description field on SBQQ__Quote__c, so a ledger row plus a correct
  // parentId is what lets the sweeper reach this by ancestry (Section 3.17).
  cpqData.track('SBQQ__Quote__c', quote.Id, {
    name: quote.Name,
    parentId: quote.SBQQ__Opportunity2__c || contractId,
  });

  // CPQ also spins up an amendment Opportunity. It carries a Description and
  // nothing else will ever make it reclaimable, so stamp it — an unstamped
  // CPQ-generated Opportunity is a record the sweeper rejects outright.
  let opportunityId = quote.SBQQ__Opportunity2__c;
  if (opportunityId) {
    const [opportunity] = await sf.query(
      `SELECT Id, Name FROM Opportunity WHERE Id = '${escapeSoql(opportunityId)}'`
    );
    await cpqData.stampExisting('Opportunity', opportunityId, {
      name: opportunity && opportunity.Name,
      parentId: contractId,
    });
  } else {
    opportunityId = undefined;
  }

  // ---------------------------------------------------------------------------
  // 4. Open the editor.
  //
  // Delegated, because a CPQ-generated quote needs ungrouping before its own
  // editor will render it at all — the reasoning, and the measurements behind
  // it, live in openFlatQuoteEditor. Renewal quotes need exactly the same
  // treatment, which is why it is a flow rather than a step inlined here.
  // ---------------------------------------------------------------------------
  await openFlatQuoteEditor({ sf, quotePage, quoteLineEditor }, {
    instanceUrl,
    quoteId: quote.Id,
    label: `amendment quote for contract ${contractId}`,
  });

  return { quoteId: quote.Id, opportunityId, quote };
}

module.exports = { amendContract, AMENDMENT_TYPE };
