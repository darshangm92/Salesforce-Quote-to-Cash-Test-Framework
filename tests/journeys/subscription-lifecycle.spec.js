// tests/journeys/subscription-lifecycle.spec.js
//
// WHAT THIS PROVES
// ----------------
// The first half of the deal's life, end to end: a rep builds a quote with two
// sections, marks it as the deal to go with, turns it into orders, and turns
// those orders into the records the business bills and services from. One
// section becomes a contract with ongoing subscriptions; the other becomes
// installed equipment the customer owns. Four stages, each one starting from
// what the previous stage actually produced rather than from seeded data.
//
// WHY IT MATTERS
// --------------
// This is the path every piece of revenue in the system takes. A break anywhere
// along it means a signed deal that never becomes something billable — and
// because each step is a different team's screen, a break in the middle is
// exactly the kind of thing nobody owns until a customer complains.
//
// HOW IT WORKS
// ------------
// Stages 1 to 4 live in this file; stages 5 to 7 (renewal forecast, amendments,
// renewal quote) are in `subscription-renewal.spec.js` and run against the
// contract this file leaves behind. Each stage is a separate `test()` inside a
// serial describe, which buys a report reading "stage 2 failed, 3 onward
// skipped" instead of one opaque failure in a twenty-minute test. Ids travel
// between stages through a state file on disk, and this file deliberately opts
// out of the usual per-test cleanup — otherwise stage 1's teardown would delete
// the quote stage 2 opens. Nothing is kept forever: the records still get
// ledger rows and the scheduled sweeper reclaims them later.
//
// Retries are OFF for journeys. A retry restarts a serial group at stage 1,
// which seeds a whole new record tree rather than resuming, so a retry here
// costs a duplicate lineage and five minutes before it even reaches the stage
// that failed.
//
// IF THIS FAILS, LOOK HERE FIRST
// ------------------------------
//  1. Read WHICH stage failed. Later stages assert against records CPQ
//     generated, so a stage-3 failure usually means stage 2 produced something
//     unexpected rather than stage 3 being wrong.
//  2. If stage 1 times out reaching the editor, the quote's two sections were
//     not created — that automation is keyed on the account, same precondition
//     as tests/quote/optional-lines.spec.js.
//  3. If a stage fails on a poll, read the SOQL in the error. These stages wait
//     on the org's asynchronous work, and a poll that waits on the wrong
//     condition reports slowness as a wrong value.
//
// ---------------------------------------------------------------------------
//
// The canonical subscription lifecycle: quote -> order -> contract -> asset ->
// amendment -> renewal. Stage 1 is implemented here; later stages append to
// this file and consume the records this one leaves behind.
//
// WHY SEPARATE test() BLOCKS RATHER THAN test.step()
// --------------------------------------------------
// Each stage is its own test under a serial describe. That buys per-stage
// Allure entries, a per-stage trace, and a report that reads "stage 2 failed,
// 3 onward skipped" instead of one opaque failure inside a 20-minute test.
// The cost is that fixtures are re-created per stage, which is why the shared
// record Ids travel through `ctx` and runContext's saveState().
//
// WHY THIS STAGE RETAINS ITS DATA
// -------------------------------
// Every test gets its own `cpqData` instance, so stage 1's teardown would
// delete the very quote stage 2 opens. cpqData.retainForJourney() opts this
// stage out of teardown; the records still carry ledger rows with
// sweepEligible = true, so the scheduled sweeper reclaims them after
// RETENTION_DAYS. Nothing is retained forever.
const { test, expect } = require('../../src/fixtures/cpqFixtures');
const { loadJson } = require('../../src/utils/dataProvider');
const { createQuoteWithGroups } = require('../../src/flows');
const { QuoteLineEditorPage } = require('../../src/pages/QuoteLineEditorPage');
const { runId, runStartedAt, saveState, loadState, resumeGuard } = require('../../src/utils/runContext');
const { escapeSoql } = require('../../src/utils/waitForAsync');
const { STAGES, STATE_KEY } = require('./subscription-stages');
const session = require('../../.auth/sf-session.json');

const data = loadJson('home-security.json');

// Total lines the quote should hold once both groups are populated. Derived,
// never written down twice.
const EXPECTED_LINE_TOTAL = data.groups.reduce((n, g) => n + g.expectedLineCount, 0);

// Order Products expected across both orders once the quote is ordered — one
// per quote line. Derived from the data file's per-group counts for the same
// reason as above.
const EXPECTED_ORDER_ITEM_TOTAL = Object.values(data.expected.ordersByGroup)
  .reduce((n, count) => n + count, 0);

// The two group names, read from the data file rather than written down again.
// Their order follows the `groups` array: the first is contracted into Assets
// (stage 4), the second into a Contract with Subscriptions (stage 3).
const [ONE_TIME_PURCHASES, ONGOING_SERVICES] = data.groups.map((group) => group.name);

// The Salesforce Status value both Order and Contract reach on activation. A
// platform picklist value, confirmed on both objects — Order's picklist is
// exactly ['Draft', 'Activated'].
const ACTIVATED = 'Activated';

// Shared across stages. Only preloaded from disk when resuming — otherwise a
// stale file from a previous run would leak Ids into a fresh journey.
let ctx = process.env.RESUME_FROM ? loadState(STATE_KEY) || {} : {};

// ---------------------------------------------------------------------------
// Date helpers. Every date is computed at runtime: a journey that chains into
// renewals must not carry a fixed close date, and a hardcoded start date goes
// stale the moment the year rolls over.
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');

/** yyyy-mm-dd, the format Salesforce Date fields use over REST. */
function isoDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function firstOfNextYear(now = new Date()) {
  return new Date(now.getFullYear() + 1, 0, 1);
}

function plusDays(days, from = new Date()) {
  const date = new Date(from);
  date.setDate(date.getDate() + days);
  return date;
}

/** Salesforce returns 18-char Ids; anything stored elsewhere may be 15-char. */
function sameId(a, b) {
  return !!a && !!b && String(a).slice(0, 15) === String(b).slice(0, 15);
}

/**
 * Fails immediately, and by name, when a stage is missing state an earlier
 * stage was supposed to leave behind.
 *
 * Without this an absent Id reaches a SOQL string as the literal "undefined",
 * comes back as MALFORMED_QUERY several calls later, and points the reader at
 * the wrong stage entirely.
 */
function requireCtx(...keys) {
  const missing = keys.filter((key) => !ctx || ctx[key] === undefined || ctx[key] === null);
  if (!missing.length) return;
  throw new Error(
    `Journey state is missing: ${missing.join(', ')}. Run the earlier stages in the same ` +
      `invocation, or set RESUME_FROM to replay from artifacts/state/${STATE_KEY}.json.`
  );
}

/** Renders an array of Ids as a SOQL IN (...) list. */
function soqlIdList(ids) {
  return ids.map((id) => `'${escapeSoql(id)}'`).join(', ');
}

/** Records a stage as complete and persists the hand-off to the next one. */
function completeStage(stage) {
  ctx.completedStages = [...(ctx.completedStages || []), stage];
  saveState(STATE_KEY, ctx);
}

/** Sums expected quantity per product name across all groups. */
function expectedQuantityByProduct() {
  const totals = new Map();
  for (const group of data.groups) {
    for (const product of group.products) {
      totals.set(product.name, (totals.get(product.name) || 0) + product.quantity);
    }
  }
  return totals;
}

test.describe('Subscription lifecycle', {
  tag: ['@type:journey', '@journey:subscription', '@domain:quote',
        '@serial', '@quota:heavy', '@speed:slow', '@risk:high'],
}, () => {
  // retries: 0 is deliberate, and specific to journeys.
  //
  // A retry of a serial group restarts it from stage 1, which does not resume
  // anything — it seeds a NEW Opportunity and Quote and drives the whole editor
  // again. So every mid-journey failure leaves a complete duplicate record tree
  // behind and costs another five minutes before reaching the stage that
  // actually failed. Twice over, at the project's CI setting of 2.
  //
  // The project-level retry budget stays where it is for ordinary specs, where
  // a retry is cheap and re-runs exactly the test that flaked. Here it is
  // neither. Genuine org slowness is already absorbed
  // by the poll timeouts in every stage, so what a retry buys is duplicated
  // data, not a truer result.
  test.describe.configure({ mode: 'serial', retries: 0 });

  test('stage 1 — grouped quote lines persist and sync to the opportunity',
    { tag: ['@stage:quote'] },
    async ({ cpqData, sf, quotePage, quoteLineEditor, productSelection }) => {
      test.skip(resumeGuard('quote', STAGES), `resuming from "${process.env.RESUME_FROM}"`);

      // Nine products added one group at a time, each with its own
      // recalculation, plus the primary-quote sync poll at the end. The
      // 120s project default is nowhere near enough.
      test.setTimeout(15 * 60_000);

      cpqData.setStage('quote');
      cpqData.retainForJourney('stage 2 (order) opens this quote and its lines');

      // ---------------------------------------------------------------------
      // Seed. The Account is resolved by name and never created — see the
      // flow, which registers it with sweepEligible = false.
      // ---------------------------------------------------------------------
      const startDate = firstOfNextYear();

      const seeded = await createQuoteWithGroups({ cpqData, sf }, {
        accountName: data.account.name,
        // The runId suffix keeps concurrent and repeated runs distinguishable
        // in the org without making the name unrecognisable to a human.
        opportunityName: `${data.opportunity.baseName} [${runId()}]`,
        closeDate: isoDate(plusDays(data.opportunity.closeDateOffsetDays)),
        stage: data.opportunity.stage,
        // Explicit price book for the Opportunity — see "_pricebook" in the
        // data file for why this is not optional.
        pricebookId: data.opportunity.pricebookId,
        expectedGroups: data.groups.length,
        quoteFields: {
          SBQQ__LineItemsGrouped__c: data.quote.lineItemsGrouped,
          SBQQ__Primary__c: data.quote.primaryAtSeed,
        },
      });

      // The groups are created by a record-triggered Flow, not by the suite.
      // createQuoteWithGroups polls for them; this confirms they came back
      // under the names the data file and the UI steps both rely on.
      for (const group of data.groups) {
        expect(
          seeded.groupIdsByName[group.name],
          `The record-triggered Flow did not create a quote line group named "${group.name}". ` +
            `Groups found: ${Object.keys(seeded.groupIdsByName).join(', ') || '(none)'}`
        ).toBeTruthy();
      }

      ctx = {
        runId: runId(),
        accountId: seeded.accountId,
        oppId: seeded.opportunityId,
        quoteId: seeded.quoteId,
        groupIds: seeded.groupIdsByName,
        startDate: isoDate(startDate),
        subscriptionTerm: data.quote.subscriptionTerm,
      };
      saveState(STATE_KEY, ctx);

      // ---------------------------------------------------------------------
      // Act in the UI.
      // ---------------------------------------------------------------------

      // By Id, never by quote number: Q-000NN is auto-generated and differs
      // every run.
      await quotePage.open(session.instanceUrl, ctx.quoteId);
      await quotePage.openLineEditor();
      // The QLE is a Polymer app behind a Visualforce iframe and takes over a
      // minute to become interactive. Until it does, its loading spinner
      // covers the page and swallows clicks.
      await quoteLineEditor.waitForEditorReady();

      // Start Date and Subscription Term are set on the QUOTE-level "Quote
      // Information" panel at the top of the editor, not on either group's
      // header block. Both fields exist in all three places; only the
      // quote-level values apply across every group, which is what this
      // journey is about.
      await quoteLineEditor.setStartDate(startDate);
      await quoteLineEditor.setSubscriptionTerm(data.quote.subscriptionTerm);

      // Quick Save, not Save: it commits the header without leaving the
      // editor, so the product steps below don't have to pay another 60-120s
      // of app startup to get back in.
      await quoteLineEditor.quickSave();

      // Verify the header landed at quote level before adding anything. If a
      // value had gone into a group's field instead, these two reads would
      // come back empty — and catching that here beats discovering it after
      // nine products have been added against the wrong dates.
      expect(
        await quoteLineEditor.startDateValue(),
        'quote-level Start Date after Quick Save'
      ).toBe(QuoteLineEditorPage.displayDate(startDate));
      expect(
        await quoteLineEditor.subscriptionTermValue(),
        'quote-level Subscription Term after Quick Save'
      ).toBe(String(data.quote.subscriptionTerm));

      // And confirm it reached the record, since Quick Save commits — the UI
      // showing a value is not the same as the value persisting.
      await sf.pollForRecord(
        'SELECT Id, SBQQ__StartDate__c, SBQQ__SubscriptionTerm__c FROM SBQQ__Quote__c ' +
          `WHERE Id = '${escapeSoql(ctx.quoteId)}' AND SBQQ__StartDate__c = ${ctx.startDate} ` +
          `AND SBQQ__SubscriptionTerm__c = ${data.quote.subscriptionTerm}`,
        { label: 'quote header committed by Quick Save' }
      );

      // Pass 1 — populate both groups, committing after each.
      //
      // Products first, quantities second. Adding a product is a round trip
      // through the selection screen and back; interleaving quantity edits
      // would mean re-entering the editor's line table between every add.
      let expectedLinesSoFar = 0;
      for (const group of data.groups) {
        // Add Products is per group header — this is what puts the lines in
        // the right group. See the group-scoping note in QuoteLineEditorPage.
        await quoteLineEditor.openAddProducts(group.name);
        // Pass the whole product object: the grid is disambiguated by
        // productCode, not by name (see ProductSelectionPage.rowIndexOf).
        await productSelection.addProducts(group.products);

        // Quick Save commits the new lines to the quote. Until this runs they
        // exist only in the editor's client-side state, so a failure later
        // would lose them entirely.
        await quoteLineEditor.quickSave();

        expectedLinesSoFar += group.expectedLineCount;
        await sf.pollForRecords(
          `SELECT Id FROM SBQQ__QuoteLine__c WHERE SBQQ__Quote__c = '${escapeSoql(ctx.quoteId)}'`,
          {
            expect: expectedLinesSoFar,
            label: `quote lines committed after populating "${group.name}"`,
          }
        );
      }

      // Pass 2 — set the quantities the data file marks as UI-driven.
      // Addressed by product code: line rows are matched on
      // SBQQ__ProductCode__c, which is unique, unlike the product name.
      for (const group of data.groups) {
        for (const product of group.products.filter((p) => p.setQuantityInUi)) {
          await quoteLineEditor.setQuantity(group.name, product.productCode, product.quantity);
        }
      }

      // Capture what the editor priced, per line, before committing. Kept in
      // journey state for later stages; monetary correctness is still asserted
      // against the records, not against these strings.
      ctx.prices = {};
      for (const group of data.groups) {
        ctx.prices[group.name] = await quoteLineEditor.capturePrices(group.name);
      }
      saveState(STATE_KEY, ctx);
      console.log(`Captured line prices:\n${JSON.stringify(ctx.prices, null, 2)}`);

      // Commit the quantity edits before leaving the editor.
      await quoteLineEditor.quickSave();

      // ---------------------------------------------------------------------
      // Thin UI assertions — deliberately checked here, in the editor, rather
      // than after Save. These elements only exist in the QLE; Save navigates
      // away from it. Persistence is proven by the API assertions below, so
      // what this checks is narrower and honest: the editor reflects the edits
      // that are about to be committed.
      // ---------------------------------------------------------------------
      for (const group of data.groups) {
        expect(
          await quoteLineEditor.lineCount(group.name),
          `line count rendered in "${group.name}"`
        ).toBe(group.expectedLineCount);

        for (const product of group.products.filter((p) => p.setQuantityInUi)) {
          // Compared as a number: the editor renders "2.00", not "2".
          expect(
            Number(await quoteLineEditor.quantityValue(group.name, product.productCode)),
            `quantity rendered for "${product.name}" in "${group.name}"`
          ).toBe(product.quantity);
        }
      }

      await quoteLineEditor.save();

      // Step 11: mark the quote Primary and order by group. Navigating
      // explicitly rather than assuming where Save landed — CPQ versions
      // differ on whether Save returns to the record page or stays put.
      await quotePage.open(session.instanceUrl, ctx.quoteId);
      await quotePage.openEdit();
      await quotePage.setPrimary(true);
      await quotePage.setOrderByQuoteLineGroup(true);
      await quotePage.saveEdit();

      // ---------------------------------------------------------------------
      // Assert in the API. This is where correctness actually lives.
      // ---------------------------------------------------------------------

      // 1. Quote lines: right count per group, right quantity per product.
      //
      // SBQQ__Group__c confirmed as the group lookup on SBQQ__QuoteLine__c in
      // this org's package version. If a future version renames it, the query
      // returns rows with the field absent and the per-group filter silently
      // finds zero — the assertion message below is written to make that obvious.
      const lines = await sf.pollForRecords(
        'SELECT Id, SBQQ__Quantity__c, SBQQ__Group__c, SBQQ__Product__r.Name ' +
          `FROM SBQQ__QuoteLine__c WHERE SBQQ__Quote__c = '${escapeSoql(ctx.quoteId)}'`,
        { expect: EXPECTED_LINE_TOTAL, label: 'quote lines' }
      );
      expect(lines, 'total quote lines').toHaveLength(EXPECTED_LINE_TOTAL);

      // Flow-created and UI-created records the suite caused to exist — record
      // them so the ledger is a true account of what this run made.
      for (const line of lines) {
        cpqData.track('SBQQ__QuoteLine__c', line.Id, {
          name: line.SBQQ__Product__r && line.SBQQ__Product__r.Name,
          parentId: ctx.quoteId,
        });
      }

      for (const group of data.groups) {
        const groupId = ctx.groupIds[group.name];
        const inGroup = lines.filter((l) => sameId(l.SBQQ__Group__c, groupId));

        expect(
          inGroup,
          `lines assigned to group "${group.name}" (${groupId}) via SBQQ__Group__c`
        ).toHaveLength(group.expectedLineCount);

        for (const product of group.products) {
          const line = inGroup.find(
            (l) => l.SBQQ__Product__r && l.SBQQ__Product__r.Name === product.name
          );
          expect(line, `"${product.name}" is missing from group "${group.name}"`).toBeTruthy();
          expect(
            line.SBQQ__Quantity__c,
            `SBQQ__Quantity__c for "${product.name}" in "${group.name}"`
          ).toBe(product.quantity);
        }
      }

      // 2. Quote header.
      const quote = await sf.record('SBQQ__Quote__c', ctx.quoteId, [
        'Id',
        'SBQQ__StartDate__c',
        'SBQQ__SubscriptionTerm__c',
        'SBQQ__Primary__c',
        'SBQQ__OrderByQuoteLineGroup__c',
        'SBQQ__LineItemsGrouped__c',
        // The quote's total is SBQQ__NetAmount__c. SBQQ__NetTotal__c is a
        // QUOTE LINE field and does not exist on SBQQ__Quote__c at all.
        'SBQQ__NetAmount__c',
      ]);

      expect(quote.SBQQ__StartDate__c, 'SBQQ__StartDate__c').toBe(ctx.startDate);
      expect(quote.SBQQ__SubscriptionTerm__c, 'SBQQ__SubscriptionTerm__c')
        .toBe(data.quote.subscriptionTerm);
      expect(quote.SBQQ__Primary__c, 'SBQQ__Primary__c').toBe(true);
      expect(quote.SBQQ__OrderByQuoteLineGroup__c, 'SBQQ__OrderByQuoteLineGroup__c').toBe(true);
      expect(quote.SBQQ__LineItemsGrouped__c, 'SBQQ__LineItemsGrouped__c').toBe(true);

      // 3. The sync assertion: marking the quote Primary must produce matching
      //    Opportunity Products.
      //
      // Polled, not read once — CPQ performs this sync asynchronously and the
      // UI returns well before the OpportunityLineItems exist. Reading once
      // here would fail roughly as often as the org is busy.
      //
      // IF THIS FAILS, CHECK THE ORG BEFORE DEBUGGING THE TEST. Two settings
      // outside the automation's control break it:
      //   a) [VERIFY] the CPQ package setting that enables writing Opportunity
      //      Products from a primary quote (Setup -> Installed Packages ->
      //      Salesforce CPQ -> Configure -> Line Editor / Quote; the label
      //      varies by version). With it off, zero rows appear and this poll
      //      times out with a correct-but-unhelpful message.
      //   b) every product needs a PricebookEntry in the Opportunity's price
      //      book. A product without one is skipped silently, so the count
      //      comes up short rather than erroring.
      const oppLines = await sf.pollForRecords(
        'SELECT Id, Quantity, Product2Id, Product2.Name FROM OpportunityLineItem ' +
          `WHERE OpportunityId = '${escapeSoql(ctx.oppId)}'`,
        {
          expect: EXPECTED_LINE_TOTAL,
          label: 'opportunity products synced from the primary quote',
          timeout: 180_000,
        }
      );
      expect(oppLines, 'total opportunity products').toHaveLength(EXPECTED_LINE_TOTAL);

      for (const oppLine of oppLines) {
        cpqData.track('OpportunityLineItem', oppLine.Id, {
          name: oppLine.Product2 && oppLine.Product2.Name,
          parentId: ctx.oppId,
        });
      }

      const actualByProduct = new Map();
      for (const oppLine of oppLines) {
        const name = (oppLine.Product2 && oppLine.Product2.Name) || '(unknown product)';
        actualByProduct.set(name, (actualByProduct.get(name) || 0) + oppLine.Quantity);
      }
      for (const [name, quantity] of expectedQuantityByProduct()) {
        expect(
          actualByProduct.get(name),
          `Opportunity Product quantity for "${name}"`
        ).toBe(quantity);
      }

      // Amount is populated by the same sync, so it gets the same treatment.
      const [opportunity] = await sf.pollForRecords(
        `SELECT Id, Amount FROM Opportunity WHERE Id = '${escapeSoql(ctx.oppId)}' AND Amount != null`,
        { expect: 1, label: 'Opportunity.Amount populated by the quote sync', timeout: 180_000 }
      );
      expect(opportunity.Amount, 'Opportunity.Amount').not.toBeNull();
      // toBeCloseTo, not toBe: both sides are currency doubles that have been
      // through CPQ's rounding, and an exact float comparison would fail on a
      // sub-cent difference that means nothing.
      expect(opportunity.Amount, 'Opportunity.Amount vs the quote SBQQ__NetAmount__c')
        .toBeCloseTo(quote.SBQQ__NetAmount__c, 2);

      ctx.netAmount = quote.SBQQ__NetAmount__c;
      ctx.completedStages = ['quote'];
      saveState(STATE_KEY, ctx);
    });

  // ===========================================================================
  // Stage 2 — Ordered
  //
  // No API-seeded data from here on. Every record these three stages assert
  // against is one CPQ produced in response to a UI action, which is precisely
  // the behavior under test. Seeding an Order would test nothing.
  // ===========================================================================
  test('stage 2 — checking Ordered splits the quote into one activated Order per group',
    { tag: ['@stage:order', '@domain:orders'] },
    async ({ cpqData, sf, quotePage, orderPage }) => {
      test.skip(resumeGuard('order', STAGES), `resuming from "${process.env.RESUME_FROM}"`);

      // Order generation, eight Order Products, then two activations — each
      // with its own asynchronous settling window. Tune from a real run.
      test.setTimeout(10 * 60_000);

      cpqData.setStage('order');
      cpqData.retainForJourney('stages 3 and 4 contract these orders');

      requireCtx('quoteId', 'oppId', 'groupIds');

      // -----------------------------------------------------------------------
      // Precondition, checked first because it is cheap and because getting it
      // wrong is unreadable later. A quote that is not primary, or not
      // ordered-by-group, yields ONE order instead of two — and that surfaces
      // three assertions further down as a count mismatch that reads like a CPQ
      // defect rather than a missing setup step.
      // -----------------------------------------------------------------------
      const quote = await sf.record('SBQQ__Quote__c', ctx.quoteId, [
        'Id',
        'SBQQ__Primary__c',
        'SBQQ__OrderByQuoteLineGroup__c',
      ]);
      expect(
        quote,
        `Quote ${ctx.quoteId} was not found. Stage 1 (quote) is supposed to leave it behind — ` +
          're-run stage 1 rather than debugging stage 2.'
      ).toBeTruthy();
      expect(
        quote.SBQQ__Primary__c,
        `SBQQ__Primary__c is false on quote ${ctx.quoteId}. Stage 1 (quote) sets it, and CPQ does ` +
          'not generate orders from a non-primary quote. This is a missing precondition, not a defect.'
      ).toBe(true);
      expect(
        quote.SBQQ__OrderByQuoteLineGroup__c,
        `SBQQ__OrderByQuoteLineGroup__c is false on quote ${ctx.quoteId}. Stage 1 (quote) sets it; ` +
          'without it CPQ generates one order for the whole quote instead of one per group, and ' +
          'every count below fails for the wrong reason.'
      ).toBe(true);

      // The run window, captured once here and carried forward. Stage 4 keeps
      // it as the bound for the CreatedDate fallback its lineage query replaces.
      ctx.runStartedAt = ctx.runStartedAt || runStartedAt();
      saveState(STATE_KEY, ctx);

      // -----------------------------------------------------------------------
      // Act in the UI.
      // -----------------------------------------------------------------------
      await quotePage.open(session.instanceUrl, ctx.quoteId);
      await quotePage.openEdit();
      await quotePage.setOrdered(true);
      await quotePage.saveEdit();

      // -----------------------------------------------------------------------
      // Assert in the API.
      // -----------------------------------------------------------------------
      const orders = await sf.pollForRecords(
        `SELECT Id, OrderNumber, Status FROM Order WHERE SBQQ__Quote__c = '${escapeSoql(ctx.quoteId)}'`,
        {
          expect: data.expected.orderCount,
          label: 'Orders generated from the quote',
          timeout: 180_000,
        }
      );
      expect(orders, 'Orders generated from the quote').toHaveLength(data.expected.orderCount);

      // Which Order came from which group.
      //
      // There is NO field linking an Order to its originating
      // SBQQ__QuoteLineGroup__c — Order's only CPQ lookup is SBQQ__Quote__c,
      // confirmed by describe against this org's package version. So the
      // mapping is resolved by traversal: every Order Product carries the quote
      // line it came from, and the quote line carries its group.
      //
      // Never by related-list position and never by OrderNumber sequence.
      // Neither is deterministic.
      const orderItems = await sf.pollForRecords(
        'SELECT Id, OrderId, Product2.Name, SBQQ__QuoteLine__r.SBQQ__Group__c FROM OrderItem ' +
          `WHERE OrderId IN (${soqlIdList(orders.map((order) => order.Id))})`,
        {
          expect: EXPECTED_ORDER_ITEM_TOTAL,
          label: 'Order Products across both orders',
          timeout: 180_000,
        }
      );

      const groupNameById = new Map(
        Object.entries(ctx.groupIds).map(([name, id]) => [String(id).slice(0, 15), name])
      );

      ctx.orderIds = {};
      for (const order of orders) {
        const items = orderItems.filter((item) => sameId(item.OrderId, order.Id));

        const groupNames = new Set(
          items.map((item) => {
            const line = item.SBQQ__QuoteLine__r;
            const groupId = line && line.SBQQ__Group__c;
            return groupId ? groupNameById.get(String(groupId).slice(0, 15)) : undefined;
          })
        );

        expect(
          groupNames.size,
          `Order ${order.OrderNumber} (${order.Id}) draws its Order Products from ` +
            `${groupNames.size} quote line group(s). One order per group means exactly one. ` +
            `Groups seen: ${[...groupNames].map((n) => n || '(unrecognised)').join(', ')}`
        ).toBe(1);

        const [groupName] = [...groupNames];
        expect(
          groupName,
          `Order ${order.OrderNumber} (${order.Id}) maps to a quote line group that is not one of ` +
            `stage 1's (${Object.keys(ctx.groupIds).join(', ')}). Either SBQQ__Group__c is unset ` +
            'on the quote lines, or this order came from a different quote.'
        ).toBeTruthy();

        expect(
          ctx.orderIds[groupName],
          `Two Orders both map to group "${groupName}" — the quote did not split per group.`
        ).toBeUndefined();

        expect(
          items,
          `Order Products on the "${groupName}" order (${order.Id})`
        ).toHaveLength(data.expected.ordersByGroup[groupName]);

        ctx.orderIds[groupName] = order.Id;
      }

      expect(
        Object.keys(ctx.orderIds).sort(),
        'every quote line group produced exactly one Order'
      ).toEqual(Object.keys(data.expected.ordersByGroup).sort());
      saveState(STATE_KEY, ctx);

      // -----------------------------------------------------------------------
      // Stamp BEFORE activating. Non-negotiable ordering: unblock() in
      // scripts/cleanup-e2e-data.js reverts Status to Draft before it will
      // touch an activated Order, which is the framework's own evidence that
      // these records are field-locked once active. A PATCH after activation
      // would fail, and an Order the sweeper finds unstamped is one it rejects
      // outright and nothing ever reclaims.
      // -----------------------------------------------------------------------
      for (const [groupName, orderId] of Object.entries(ctx.orderIds)) {
        const order = orders.find((candidate) => sameId(candidate.Id, orderId));
        await cpqData.stampExisting('Order', orderId, {
          name: (order && order.OrderNumber) || groupName,
          parentId: ctx.quoteId,
        });
      }

      // Order Products have no Description to stamp. Their ledger row plus a
      // correct parentId is what lets the sweeper verify them by ancestry.
      for (const item of orderItems) {
        cpqData.track('OrderItem', item.Id, {
          name: item.Product2 && item.Product2.Name,
          parentId: item.OrderId,
        });
      }

      // Thin UI spot-check, and nothing else. The page class navigates to the
      // Orders related list's own route rather than reading the record page,
      // because this org keeps related lists behind a "Related" tab.
      expect(
        await quotePage.ordersRelatedListRowCount(session.instanceUrl, ctx.quoteId),
        'Orders related list rows on the quote'
      ).toBe(data.expected.orderCount);

      // Activate each order. The two are independent; the sequence is fixed
      // only so the run log reads the same way every time.
      for (const groupName of Object.keys(data.expected.ordersByGroup)) {
        const orderId = ctx.orderIds[groupName];
        await orderPage.open(session.instanceUrl, orderId);
        await orderPage.activate();

        // The dialog closing means the click was accepted, nothing more.
        await sf.pollForFieldValue('Order', orderId, 'Status', ACTIVATED, {
          label: `"${groupName}" Order ${orderId} Status -> ${ACTIVATED}`,
          timeout: 180_000,
        });
      }

      completeStage('order');
    });

  // ===========================================================================
  // Stage 3 — Contracted, on the subscription order
  // ===========================================================================
  test('stage 3 — contracting the Ongoing Services order generates and activates a Contract',
    { tag: ['@stage:contract', '@domain:contracts'] },
    async ({ cpqData, sf, orderPage, contractPage }) => {
      test.skip(resumeGuard('contract', STAGES), `resuming from "${process.env.RESUME_FROM}"`);

      test.setTimeout(10 * 60_000);

      cpqData.setStage('contract');
      cpqData.retainForJourney('the amendment and renewal stages consume this contract');

      requireCtx('quoteId', 'groupIds', 'orderIds');

      const orderId = ctx.orderIds[ONGOING_SERVICES];
      expect(
        orderId,
        `Stage 2 (order) recorded no Order for "${ONGOING_SERVICES}". Known orders: ` +
          `${Object.keys(ctx.orderIds).join(', ') || '(none)'}`
      ).toBeTruthy();

      // -----------------------------------------------------------------------
      // Act in the UI.
      // -----------------------------------------------------------------------
      await orderPage.open(session.instanceUrl, orderId);
      await orderPage.openEdit();
      await orderPage.setContracted(true);
      await orderPage.saveEdit();

      // -----------------------------------------------------------------------
      // Assert in the API.
      // -----------------------------------------------------------------------
      // Contract.SBQQ__Order__c is CPQ's lookup back to the generating Order,
      // confirmed by describe against this org's package version. pollForRecord
      // throws on more than one row, so "exactly 1" is enforced, not assumed.
      // Contract has no Name field — it is ContractNumber.
      const contract = await sf.pollForRecord(
        `SELECT Id, ContractNumber, Status FROM Contract WHERE SBQQ__Order__c = '${escapeSoql(orderId)}'`,
        {
          label: `Contract generated from the "${ONGOING_SERVICES}" order`,
          timeout: 180_000,
        }
      );
      ctx.contractId = contract.Id;
      saveState(STATE_KEY, ctx);

      // Stamped before Activate, for the same reason as the Orders in stage 2:
      // the sweeper reverts an activated Contract to Draft before it can touch
      // it, which is the framework's own evidence the record is field-locked
      // once active.
      await cpqData.stampExisting('Contract', ctx.contractId, {
        name: contract.ContractNumber,
        parentId: orderId,
      });

      const subscriptions = await sf.pollForRecords(
        'SELECT Id, Name, SBQQ__Product__r.Name, SBQQ__QuoteLine__r.SBQQ__Group__c ' +
          `FROM SBQQ__Subscription__c WHERE SBQQ__Contract__c = '${escapeSoql(ctx.contractId)}'`,
        {
          expect: data.expected.subscriptionCount,
          label: 'subscriptions under the contract',
          timeout: 180_000,
        }
      );
      expect(subscriptions, 'subscriptions under the contract')
        .toHaveLength(data.expected.subscriptionCount);

      for (const subscription of subscriptions) {
        cpqData.track('SBQQ__Subscription__c', subscription.Id, {
          name: (subscription.SBQQ__Product__r && subscription.SBQQ__Product__r.Name)
            || subscription.Name,
          parentId: ctx.contractId,
        });
      }

      // Lineage, not just arithmetic. Four subscriptions sourced from the WRONG
      // group would satisfy a bare count and prove nothing about the split.
      const ongoingGroupId = ctx.groupIds[ONGOING_SERVICES];
      for (const subscription of subscriptions) {
        const line = subscription.SBQQ__QuoteLine__r;
        expect(
          !!(line && line.SBQQ__Group__c && sameId(line.SBQQ__Group__c, ongoingGroupId)),
          `Subscription ${subscription.Name} traces back to quote line group ` +
            `${(line && line.SBQQ__Group__c) || '(none)'}, not to "${ONGOING_SERVICES}" ` +
            `(${ongoingGroupId}).`
        ).toBe(true);
      }

      await contractPage.open(session.instanceUrl, ctx.contractId);
      await contractPage.activate();
      await sf.pollForFieldValue('Contract', ctx.contractId, 'Status', ACTIVATED, {
        label: `Contract ${contract.ContractNumber} Status -> ${ACTIVATED}`,
        timeout: 180_000,
      });

      // Thin UI spot-check. Re-opened so the page reflects the activation the
      // API just confirmed, and the status badge is read BEFORE the related
      // list count — that call navigates away to the related list's own route.
      await contractPage.open(session.instanceUrl, ctx.contractId);
      // toContain, not toBe: the highlights panel renders the field label and
      // its value together. The record already proved the status above.
      expect(await contractPage.status(), 'Contract status badge').toContain(ACTIVATED);
      expect(
        await contractPage.subscriptionsRelatedListRowCount(session.instanceUrl, ctx.contractId),
        'Subscriptions related list rows on the contract'
      ).toBe(data.expected.subscriptionCount);

      completeStage('contract');
    });

  // ===========================================================================
  // Stage 4 — Contracted, on the one-time order
  // ===========================================================================
  test('stage 4 — contracting the One-time Purchases order generates assets per conversion rule',
    { tag: ['@stage:asset', '@domain:assets'] },
    async ({ cpqData, sf, orderPage, accountPage }) => {
      test.skip(resumeGuard('asset', STAGES), `resuming from "${process.env.RESUME_FROM}"`);

      test.setTimeout(10 * 60_000);

      cpqData.setStage('asset');
      cpqData.retainForJourney('the amendment and renewal stages consume these assets');

      requireCtx('oppId', 'orderIds');

      const orderId = ctx.orderIds[ONE_TIME_PURCHASES];
      expect(
        orderId,
        `Stage 2 (order) recorded no Order for "${ONE_TIME_PURCHASES}". Known orders: ` +
          `${Object.keys(ctx.orderIds).join(', ') || '(none)'}`
      ).toBeTruthy();

      // Resolved here rather than added to stage 1's state, so stage 1 stays
      // untouched. The quote's account is the Opportunity's account.
      const [opportunity] = await sf.query(
        `SELECT Id, AccountId FROM Opportunity WHERE Id = '${escapeSoql(ctx.oppId)}'`
      );
      expect(
        opportunity,
        `Opportunity ${ctx.oppId} was not found — the saved journey state is stale.`
      ).toBeTruthy();
      ctx.accountId = opportunity.AccountId;
      saveState(STATE_KEY, ctx);

      // -----------------------------------------------------------------------
      // Act in the UI.
      // -----------------------------------------------------------------------
      await orderPage.open(session.instanceUrl, orderId);
      await orderPage.openEdit();
      await orderPage.setContracted(true);
      await orderPage.saveEdit();

      // -----------------------------------------------------------------------
      // Assert in the API. Assets are scoped by LINEAGE.
      //
      // Asset.SBQQ__OrderProduct__c is CPQ's lookup back to the OrderItem that
      // produced the asset, confirmed by describe against this org's package
      // version. That narrows the search to exactly the order this stage
      // contracted, which is what makes the count below both exact and immune
      // to a concurrent run.
      //
      // The fallback, if a package version ever drops that field, is
      // AccountId + CreatedDate >= soqlDateTime(new Date(ctx.runStartedAt)).
      // It is strictly weaker: two journeys running against the same Account
      // inside one window would each see the other's assets. Journeys run at
      // --workers=1, so that only bites on overlapping CI invocations — but it
      // is a real limitation, and the reason lineage is preferred here.
      //
      // Filtering on Description is not an option in either form. Salesforce
      // rejects it outright — "field 'Description' can not be filtered in a
      // query call [INVALID_FIELD]" — as soqlNetCandidates() in the sweeper
      // already documents.
      // -----------------------------------------------------------------------
      const orderItems = await sf.query(
        `SELECT Id FROM OrderItem WHERE OrderId = '${escapeSoql(orderId)}'`
      );
      expect(
        orderItems,
        `The "${ONE_TIME_PURCHASES}" order (${orderId}) has no Order Products to trace assets from.`
      ).not.toHaveLength(0);

      const assets = await sf.pollForRecords(
        'SELECT Id, Name, AccountId, Product2.Name, SBQQ__OrderProduct__c FROM Asset ' +
          `WHERE SBQQ__OrderProduct__c IN (${soqlIdList(orderItems.map((item) => item.Id))})`,
        {
          expect: data.expected.assetCount,
          label: 'assets generated from the one-time order',
          timeout: 180_000,
        }
      );
      expect(assets, 'assets generated from the one-time order')
        .toHaveLength(data.expected.assetCount);

      for (const asset of assets) {
        await cpqData.stampExisting('Asset', asset.Id, {
          name: asset.Name,
          parentId: ctx.accountId,
        });
      }

      const countByProduct = new Map();
      for (const asset of assets) {
        const name = (asset.Product2 && asset.Product2.Name) || '(unknown product)';
        countByProduct.set(name, (countByProduct.get(name) || 0) + 1);
      }

      // Asserted per product, including the zero. A total of 5 arrived at
      // through the wrong distribution is a passing test that proves nothing,
      // which is why "Home Security Installation" expecting 0 is written out
      // and checked rather than inferred from the total.
      for (const [productName, expected] of Object.entries(data.expected.assetsByProduct)) {
        expect(
          countByProduct.get(productName) || 0,
          `assets for "${productName}" — SBQQ__AssetConversion__c is ` +
            `${JSON.stringify(expected.assetConversion)} (${expected._note})`
        ).toBe(expected.count);
      }

      // Thin UI spot-check, deliberately non-empty rather than an exact count.
      // The account is shared pre-existing sample data that other runs also
      // quote against, so its Assets related list is not scoped to this run and
      // an exact count here would be flaky by construction.
      expect(
        await accountPage.assetsRelatedListRowCount(session.instanceUrl, ctx.accountId),
        'Assets related list rows on the account'
      ).toBeGreaterThan(0);

      completeStage('asset');
    });
});
