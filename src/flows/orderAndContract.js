// src/flows/orderAndContract.js
//
// Flow: get from "a saved quote" to "its Order is activated and contracted,
// and the contract's subscriptions have settled".
//
// The amendment stages run this twice. Folding it into a flow rather than
// repeating it in the spec is the point of the layer (Section 3.15): the
// transition spans two screens, three asynchronous waits and a field-lock
// ordering constraint, none of which belongs in a test body — and none of
// which should be written down twice.
//
// ORDERING IS NOT A STYLE CHOICE HERE
// -----------------------------------
// Stamp before activating. scripts/cleanup-e2e-data.js reverts an activated
// Order's Status to Draft before it will touch the record, which is the
// framework's own evidence that these are field-locked once active. A PATCH
// after activation fails, and an Order the sweeper finds unstamped is one it
// rejects outright and nothing ever reclaims.
const { escapeSoql } = require('../utils/waitForAsync');

// The Salesforce Status value an Order reaches on activation. Order's picklist
// is exactly ['Draft', 'Activated'].
const ACTIVATED = 'Activated';

/**
 * @param {object} deps
 * @param {import('../api/CpqDataFactory').CpqDataFactory} deps.cpqData
 * @param {object} deps.sf            read-only `sf` fixture
 * @param {object} deps.quotePage
 * @param {object} deps.orderPage
 * @param {object} options
 * @param {string} options.instanceUrl
 * @param {string} options.quoteId
 * @param {number} [options.expectedOrderCount=1]  how many Orders the quote
 *        should split into; 1 for an ungrouped amendment quote
 * @param {string} [options.parentId]  what the Orders hang off in the ledger
 * @param {number} [options.timeout]   poll budget for each async step, in ms
 * @returns {Promise<{orderIds: string[], orders: object[]}>}
 */
async function orderAndContract({ cpqData, sf, quotePage, orderPage }, options) {
  const {
    instanceUrl,
    quoteId,
    expectedOrderCount = 1,
    parentId,
    timeout = 180_000,
  } = options;

  if (!quoteId) throw new Error('orderAndContract needs a quoteId.');

  // ---------------------------------------------------------------------------
  // Precondition. CPQ does not generate Orders from a non-primary quote, and
  // that failure surfaces two steps later as a poll timing out on zero rows —
  // which reads like a CPQ defect rather than a missing flag.
  //
  // CPQ marks an amendment quote primary on its amendment Opportunity when it
  // creates it, so the normal path reads `true` here and touches nothing. The
  // UI branch exists for the case where it does not, and it is a UI edit
  // rather than a PATCH because the `sf` fixture is read-only by contract and
  // writes belong to the behaviour under test.
  // ---------------------------------------------------------------------------
  const before = await sf.record('SBQQ__Quote__c', quoteId, ['Id', 'SBQQ__Primary__c']);
  if (!before) {
    throw new Error(`Quote ${quoteId} was not found — the caller handed this flow a stale Id.`);
  }
  const needsPrimary = before.SBQQ__Primary__c !== true;
  if (needsPrimary) {
    console.log(
      `Quote ${quoteId} is not primary; setting it in the same edit as Ordered. CPQ normally ` +
        'marks an amendment quote primary on creation, so this branch running is worth noticing.'
    );
  }

  // ---------------------------------------------------------------------------
  // 1. Ordered.
  // ---------------------------------------------------------------------------
  await quotePage.open(instanceUrl, quoteId);
  await quotePage.openEdit();
  if (needsPrimary) await quotePage.setPrimary(true);
  await quotePage.setOrdered(true);
  await quotePage.saveEdit();

  const orders = await sf.pollForRecords(
    `SELECT Id, OrderNumber, Status FROM Order WHERE SBQQ__Quote__c = '${escapeSoql(quoteId)}'`,
    {
      expect: expectedOrderCount,
      label: `Orders generated from quote ${quoteId}`,
      timeout,
    }
  );

  // Stamp every Order BEFORE activating — see the header note.
  for (const order of orders) {
    await cpqData.stampExisting('Order', order.Id, {
      name: order.OrderNumber,
      parentId: parentId || quoteId,
    });
  }

  // Order Products have no Description to stamp. Their ledger row plus a
  // correct parentId is what lets the sweeper verify them by ancestry.
  const orderItems = await sf.query(
    'SELECT Id, OrderId, Product2.Name FROM OrderItem ' +
      `WHERE OrderId IN (${orders.map((o) => `'${escapeSoql(o.Id)}'`).join(', ')})`
  );
  for (const item of orderItems) {
    cpqData.track('OrderItem', item.Id, {
      name: item.Product2 && item.Product2.Name,
      parentId: item.OrderId,
    });
  }

  // ---------------------------------------------------------------------------
  // 2. Activate, then contract.
  //
  // Both are per-Order, and both are asynchronous behind the click. The
  // dialog closing and the modal closing each mean only that Salesforce
  // accepted the interaction — not that the work behind it finished. Wait on
  // the record, never on the UI settling.
  // ---------------------------------------------------------------------------
  for (const order of orders) {
    await orderPage.open(instanceUrl, order.Id);
    await orderPage.activate();
    await sf.pollForFieldValue('Order', order.Id, 'Status', ACTIVATED, {
      label: `Order ${order.OrderNumber} (${order.Id}) Status -> ${ACTIVATED}`,
      timeout,
    });

    await orderPage.open(instanceUrl, order.Id);
    await orderPage.openEdit();
    await orderPage.setContracted(true);
    await orderPage.saveEdit();
    await sf.pollForFieldValue('Order', order.Id, 'SBQQ__Contracted__c', true, {
      label: `Order ${order.OrderNumber} (${order.Id}) SBQQ__Contracted__c -> true`,
      timeout,
    });
  }

  return { orderIds: orders.map((o) => o.Id), orders };
}

module.exports = { orderAndContract, ACTIVATED };
