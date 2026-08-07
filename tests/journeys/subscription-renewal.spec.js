// tests/journeys/subscription-renewal.spec.js
//
// WHAT THIS PROVES
// ----------------
// The second half of the deal's life, against the contract the first half
// produced. Three things a subscription business depends on: that flagging a
// contract for renewal creates next year's opportunity with the right renewal
// product substituted in, that mid-term changes to a live contract are charged
// pro-rata for the time remaining and roll into the EXISTING contract rather
// than spawning a second one, and that asking for a renewal quote produces one
// containing only the recurring items — not the one-off purchases.
//
// WHY IT MATTERS
// --------------
// Renewals are the revenue the business already has. A renewal opportunity that
// never appears is money quietly not forecast; an amendment that creates a
// second contract splits a customer's relationship in two and breaks every
// report that counts contracts; and a mid-term upgrade charged for a full year
// instead of the remaining months is an invoice the customer will dispute.
//
// HOW IT WORKS
// ------------
// This file SEEDS NOTHING. Every record it asserts against is one CPQ produced
// in response to a UI action — seeding a renewal opportunity would test
// nothing. It reads the contract Id from the state file that
// `subscription-lifecycle.spec.js` wrote, and a freshness guard fails the run
// immediately if that state belongs to a previous run. Without the guard,
// running this file on its own would happily amend last week's contract with
// every assertion still passing.
//
// One trap worth knowing: a CPQ-generated quote arrives with grouping switched
// on but its lines belonging to no group, and its editor then spins forever
// with nothing in the page explaining why. `openFlatQuoteEditor` turns grouping
// off, which is why it exists as a flow rather than an inline step.
//
// IF THIS FAILS, LOOK HERE FIRST
// ------------------------------
//  1. If it fails immediately on the freshness guard, stages 1 to 4 did not run
//     in this run. Run the whole journeys lane, not this file alone.
//  2. If the amendment stage reports more than one contract, check the count
//     rather than the contract's own order lookup — that lookup moves to the
//     most recent order and is not a reliable "which order made me" pointer.
//  3. If a poll times out on a date field, note that the polling helper cannot
//     compare dates directly; the surrounding code interpolates them for that
//     reason.
//
// ---------------------------------------------------------------------------
//
// The tail of the subscription lifecycle, stages 5 to 7, against the Contract
// that subscription-lifecycle.spec.js leaves behind:
//
//   5. renewal-forecast  checking Renewal Forecast generates a renewal
//                        Opportunity with the Renewal Product substituted
//   6. amendment         two amendments pro-rate correctly and roll into the
//                        EXISTING contract without creating a new one
//   7. renewal-quote     checking Renewal Quoted generates a renewal Quote
//                        holding only the subscription products
//
// WHY A SECOND FILE RATHER THAN MORE STAGES IN THE FIRST
// ------------------------------------------------------
// Stages 1-4 are a complete, independently runnable story: quote to order to
// contract to asset. These three are a second story told against the artefact
// the first one produced. Splitting them keeps either half runnable on its own
// and keeps one spec from growing past the point where a reader can hold it.
//
// The filename sorts after subscription-lifecycle.spec.js, which is how
// Playwright happens to order them — but ORDER IS NOT ENFORCED BY THE
// FILENAME. The freshness guard below is what actually enforces sequencing,
// and it must not be weakened on the assumption that alphabetical ordering
// holds.
//
// NO API-SEEDED DATA ANYWHERE IN THIS FILE
// ----------------------------------------
// Every record these stages assert against is one CPQ produced in response to
// a UI action. That is the behavior under test — seeding a renewal
// Opportunity, or an amendment quote, would test nothing at all.
const { test, expect } = require('../../src/fixtures/cpqFixtures');
const { loadJson } = require('../../src/utils/dataProvider');
const { amendContract, orderAndContract, openFlatQuoteEditor } = require('../../src/flows');
const { runId, saveState, loadState, resumeGuard } = require('../../src/utils/runContext');
const { escapeSoql } = require('../../src/utils/waitForAsync');
const { STAGES, STATE_KEY } = require('./subscription-stages');
const session = require('../../.auth/sf-session.json');

const data = loadJson('home-security.json');
const scenario = data.amendmentRenewal;

// The Salesforce Status an activated Contract carries.
const ACTIVATED = 'Activated';

// ---------------------------------------------------------------------------
// Journey state, loaded UNCONDITIONALLY.
//
// The lifecycle spec only preloads when RESUME_FROM is set, because a stale
// file would leak Ids into a fresh journey it is about to seed. This file
// seeds nothing: it has no way to produce a contract of its own, so state from
// disk is the only input it can ever have. Loading it always, and then
// checking that it belongs to THIS run, is what turns "silently amended last
// week's contract" into an immediate, named failure.
// ---------------------------------------------------------------------------
let ctx = loadState(STATE_KEY) || {};

// ---------------------------------------------------------------------------
// Freshness guard.
//
// Without it, running this file alone picks up whatever artifacts/state/
// happens to hold and amends a contract from a previous run — quietly, and
// with every assertion still passing, because the records really are there.
// That is the worst class of failure this suite can have: a green run against
// the wrong org data.
//
// WHY IT RUNS AT THE TOP OF STAGE 5 AND NOT AT MODULE SCOPE
// ----------------------------------------------------------
// Module scope is evaluated during COLLECTION, before a single test has run.
// At that moment stages 1-4 have not executed yet, so the state on disk still
// belongs to the previous run — and a module-scope throw cannot tell
// "stale state, and stages 1-4 are about to refresh it in this very
// invocation" from "stale state, and nothing is going to refresh it".
//
// Guarding at module scope therefore breaks `npm run test:journey` on any
// machine that has run the journey before, and does it with an error that
// tells you to run `npm run test:journey` — which is what you just ran.
//
// The top of stage 5 is the first moment the answer is actually knowable, and
// it is still before anything in this file touches the org. State is re-read
// from disk there for the same reason: this module's copy was loaded during
// collection, so it predates whatever stage 1 wrote.
//
// RESUME_FROM is the deliberate escape hatch. Setting it means "I know this
// state is from an earlier run and I want to continue it", which is exactly
// what the resume workflow is for.
// ---------------------------------------------------------------------------
function assertFreshState() {
  if (!ctx.runId || ctx.runId === runId() || process.env.RESUME_FROM) return;
  throw new Error(
    `Journey state in artifacts/state/${STATE_KEY}.json belongs to run ${ctx.runId}, but this ` +
      `process is run ${runId()}.\n\n` +
      'Stages 5-7 consume the Contract stages 1-4 produced, so running them against another ' +
      "run's state would amend a contract this invocation never made.\n\n" +
      'Either run the whole chain in one invocation, so stages 1-4 produce the contract this ' +
      'file then consumes:\n' +
      '  npm run test:journey\n\n' +
      'or replay deliberately against the earlier run:\n' +
      `  RESUME_FROM=renewal-forecast CPQ_RUN_ID=${ctx.runId} \\\n` +
      '    npx playwright test tests/journeys/subscription-renewal.spec.js --workers=1'
  );
}

// ---------------------------------------------------------------------------
// Date helpers. Every date is derived from the contract's own start date,
// never from new Date() — see the note on startDateOffsetMonths in the data
// file for why computing "six months from now" independently drifts.
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');

/** yyyy-mm-dd, the format Salesforce Date fields use over REST. */
function isoDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Parses the yyyy-mm-dd a Salesforce Date field returns into a local Date. */
function parseIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!match) throw new Error(`Expected a yyyy-mm-dd date, got "${value}".`);
  const [, y, m, d] = match.map(Number);
  return new Date(y, m - 1, d);
}

/**
 * N months after a yyyy-mm-dd date, as yyyy-mm-dd.
 *
 * Date.setMonth handles the year rollover, which is the whole reason this is
 * derived rather than written down: the contract starts on the first of next
 * year, so "twelve months after" crosses into the year after that.
 */
function plusMonths(isoStart, months) {
  const date = parseIsoDate(isoStart);
  date.setMonth(date.getMonth() + months);
  return isoDate(date);
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
    `Journey state is missing: ${missing.join(', ')}. Run stages 1-4 ` +
      '(tests/journeys/subscription-lifecycle.spec.js) in the same invocation, or set ' +
      `RESUME_FROM to replay from artifacts/state/${STATE_KEY}.json.`
  );
}

/** Records a stage as complete and persists the hand-off to the next one. */
function completeStage(stage) {
  ctx.completedStages = [...(ctx.completedStages || []), stage];
  saveState(STATE_KEY, ctx);
}

/** Renders an array of Ids as a SOQL IN (...) list. */
function soqlIdList(ids) {
  return ids.filter(Boolean).map((id) => `'${escapeSoql(id)}'`).join(', ');
}

/**
 * The scenario's headline claim: an amendment rolls into the EXISTING contract
 * and does not spawn a second one.
 *
 * Asserted by counting the contracts reachable from everything this journey
 * has created, and NOT by checking that no Contract points at the amendment
 * Order. That obvious-looking version is wrong twice over:
 *
 *   * `Contract.SBQQ__Order__c` is not a stable "the Order that created me"
 *     pointer. CPQ REPOINTS it to the most recent Order contracted into the
 *     contract — measured on 2026-07-28, contract 00000110 was created at
 *     15:04:43 from the original Ongoing Services order and by 15:10:19 its
 *     lookup had moved to amendment order 00000126.
 *   * so a "no contract points at this amendment order" check passes only in
 *     the window before CPQ gets round to repointing, which makes it both
 *     flaky and, when it passes, evidence of nothing.
 *
 * Counting is immune to the repointing: however CPQ moves the lookups around,
 * one contract is one contract.
 */
async function assertSingleContract(sf, expect, context) {
  const { contractId, quoteIds, orderIds, label } = context;

  const contracts = await sf.query(
    'SELECT Id, ContractNumber, SBQQ__Order__c, SBQQ__Quote__c FROM Contract ' +
      `WHERE SBQQ__Order__c IN (${soqlIdList(orderIds)}) ` +
      `OR SBQQ__Quote__c IN (${soqlIdList(quoteIds)})`
  );

  expect(
    contracts.map((c) => c.ContractNumber),
    `${label}: this journey's quotes and orders resolve to ${contracts.length} Contract(s). An ` +
      'amendment must roll into the contract it amends, not spawn another one.'
  ).toHaveLength(1);

  expect(
    sameId(contracts[0].Id, contractId),
    `${label}: the single contract in this journey's lineage is ${contracts[0].ContractNumber} ` +
      `(${contracts[0].Id}), but the journey is working against ${contractId}.`
  ).toBe(true);
}

/** Product names on a set of records, via a relationship path, as a Set. */
function productNames(records, path) {
  const names = new Set();
  for (const record of records) {
    const related = path.split('.').reduce((node, key) => (node ? node[key] : undefined), record);
    if (related) names.add(related);
  }
  return names;
}

test.describe('Subscription renewal and amendment', {
  tag: ['@type:journey', '@journey:subscription', '@domain:renewal',
        '@serial', '@quota:heavy', '@speed:slow', '@risk:high'],
}, () => {
  // retries: 0, for exactly the reason the lifecycle spec gives.
  //
  // A retry of a serial group restarts it at the first stage, and the first
  // stage here does not resume anything — it re-checks Renewal Forecast and
  // re-drives two amendments, each of which contracts an Order that cannot
  // then be deleted. So every mid-journey failure would leave a duplicate
  // record tree behind and spend another fifteen minutes before reaching the
  // stage that actually failed. Genuine org slowness is already absorbed by
  // the poll timeouts in each stage.
  test.describe.configure({ mode: 'serial', retries: 0 });

  // ===========================================================================
  // Stage 5 — Renewal Forecast
  // ===========================================================================
  test('stage 5 — checking Renewal Forecast generates a renewal opportunity with the renewal product substituted',
    { tag: ['@stage:renewal-forecast', '@domain:renewal'] },
    async ({ cpqData, sf, contractPage, opportunityPage }) => {
      test.skip(resumeGuard('renewal-forecast', STAGES), `resuming from "${process.env.RESUME_FROM}"`);

      // A contract edit, then CPQ generating an Opportunity and one
      // OpportunityLineItem per subscription, then a rename. Every step after
      // the first is asynchronous.
      test.setTimeout(10 * 60_000);

      cpqData.setStage('renewal-forecast');
      cpqData.retainForJourney('stages 6 and 7 amend this contract and quote its renewal');

      // Re-read what stages 1-4 wrote. This module's copy was loaded during
      // collection, before they ran, so it is stale by construction whenever
      // the whole chain runs in one invocation.
      ctx = loadState(STATE_KEY) || ctx;
      assertFreshState();

      requireCtx('contractId', 'oppId', 'accountId', 'quoteId', 'startDate', 'runId');

      // -----------------------------------------------------------------------
      // Preconditions: org configuration, ASSERTED and never created.
      //
      // Both of these are Setup data this suite depends on and does not own.
      // Checked here, first, because the alternative is a failure three
      // assertions later that reads like a CPQ defect — "Warranty is still on
      // the renewal opportunity" — when the real answer is that a field in
      // Setup was never populated.
      // -----------------------------------------------------------------------
      const substitution = scenario.org.renewalSubstitution;
      const [renewalSource] = await sf.query(
        'SELECT Id, Name, SBQQ__RenewalProduct__c, SBQQ__RenewalProduct__r.Name FROM Product2 ' +
          `WHERE Name = '${escapeSoql(substitution.from.name)}' LIMIT 1`
      );
      expect(
        renewalSource,
        `Product2 "${substitution.from.name}" does not exist in this org. Stage 5 substitutes it ` +
          `for "${substitution.to.name}" and tests nothing without it. ${substitution._setupPath}`
      ).toBeTruthy();
      expect(
        renewalSource.SBQQ__RenewalProduct__r && renewalSource.SBQQ__RenewalProduct__r.Name,
        `Product2 "${substitution.from.name}" has no Renewal Product set, so CPQ has nothing to ` +
          `substitute and the renewal opportunity will simply carry "${substitution.from.name}" ` +
          'forward. This is missing org configuration, not a CPQ defect. Fix it at: ' +
          substitution._setupPath
      ).toBe(substitution.to.name);

      // The successor's OWN list price. A substituted renewal line takes this
      // rather than the predecessor's carried-forward pricing, so it is read
      // from the org and asserted as a relationship further down — a literal
      // alone cannot tell "the substitution rule changed" apart from "someone
      // repriced Warranty Extension in the catalogue".
      const [successorPbe] = await sf.query(
        'SELECT Id, UnitPrice, Product2.Name FROM PricebookEntry ' +
          `WHERE Product2.ProductCode = '${escapeSoql(substitution.to.productCode)}' ` +
          `AND Pricebook2Id = '${escapeSoql(data.opportunity.pricebookId)}' AND IsActive = true LIMIT 1`
      );
      expect(
        successorPbe,
        `"${substitution.to.name}" (${substitution.to.productCode}) has no active PricebookEntry ` +
          `in the Opportunity's price book (${data.opportunity.pricebookId}). CPQ prices a ` +
          'substituted renewal line from that entry, so without it the substitution has no price ' +
          `to take. ${substitution._setupPath}`
      ).toBeTruthy();

      const replacement = scenario.org.replacementProduct;
      const [replacementPbe] = await sf.query(
        'SELECT Id, Product2Id, Product2.Name, UnitPrice FROM PricebookEntry ' +
          `WHERE Product2.ProductCode = '${escapeSoql(replacement.productCode)}' ` +
          `AND Pricebook2Id = '${escapeSoql(data.opportunity.pricebookId)}' AND IsActive = true LIMIT 1`
      );
      expect(
        replacementPbe,
        `"${replacement.name}" (${replacement.productCode}) has no active PricebookEntry in the ` +
          `Opportunity's price book (${data.opportunity.pricebookId}). Stage 6 adds it to an ` +
          'amendment quote, and a product without an entry cannot be quoted at all. ' +
          replacement._setupPath
      ).toBeTruthy();

      // -----------------------------------------------------------------------
      // Live-record guard. State on disk outlives the records the sweeper
      // reclaimed, so "the file says contractId" is not the same as "the
      // contract exists and is still activated".
      // -----------------------------------------------------------------------
      // ContractTerm is read for the pro-ration below, not for its own sake:
      // a carried-forward renewal price is the subscription's price scaled by
      // renewalTerm / ContractTerm, and taking the 24 from the org rather than
      // from the data file means the derivation follows the contract stage 1
      // actually produced.
      const contract = await sf.record('Contract', ctx.contractId, [
        'Id', 'ContractNumber', 'Status', 'StartDate', 'AccountId', 'ContractTerm',
      ]);
      expect(
        contract,
        `Contract ${ctx.contractId} was not found. The saved journey state is stale — the sweeper ` +
          'reclaims journey records after RETENTION_DAYS. Re-run stages 1-4 rather than debugging ' +
          'this stage.'
      ).toBeTruthy();
      expect(
        contract.Status,
        `Contract ${contract.ContractNumber} (${ctx.contractId}) is "${contract.Status}", not ` +
          `"${ACTIVATED}". CPQ does not forecast a renewal from a draft contract; stage 3 ` +
          'activates it, so this is a missing precondition rather than a defect.'
      ).toBe(ACTIVATED);

      // The subscriptions the renewal opportunity is built from — read now, so
      // the per-product assertions below compare against what the contract
      // actually holds rather than against a number written down twice.
      //
      // SBQQ__NetPrice__c is the predecessor pricing every carried-forward
      // renewal line is derived from. It is PER UNIT and already pro-rated over
      // the contract's own term (Offsite Video Storage nets 24 at quantity 2,
      // not 48), so the quantity does not enter into the derivation below.
      const subscriptions = await sf.query(
        'SELECT Id, SBQQ__Product__r.Name, SBQQ__Quantity__c, SBQQ__NetPrice__c ' +
          `FROM SBQQ__Subscription__c WHERE SBQQ__Contract__c = '${escapeSoql(ctx.contractId)}'`
      );
      expect(
        subscriptions,
        `Contract ${contract.ContractNumber} carries no subscriptions, so there is nothing to ` +
          'forecast a renewal from. Stage 3 is supposed to leave four behind.'
      ).toHaveLength(data.expected.subscriptionCount);

      // -----------------------------------------------------------------------
      // Act in the UI.
      // -----------------------------------------------------------------------
      await contractPage.open(session.instanceUrl, ctx.contractId);
      await contractPage.openEdit();
      await contractPage.setRenewalTerm(scenario.renewalForecast.renewalTerm);
      await contractPage.setRenewalForecast(true);
      await contractPage.saveEdit();

      // -----------------------------------------------------------------------
      // Assert in the API.
      // -----------------------------------------------------------------------
      const saved = await sf.record('Contract', ctx.contractId, [
        'Id', 'SBQQ__RenewalTerm__c', 'SBQQ__RenewalForecast__c',
      ]);
      expect(saved.SBQQ__RenewalTerm__c, 'Contract.SBQQ__RenewalTerm__c')
        .toBe(scenario.renewalForecast.renewalTerm);
      expect(saved.SBQQ__RenewalForecast__c, 'Contract.SBQQ__RenewalForecast__c').toBe(true);

      // Polled on the CONTRACT row with its lookup populated, rather than on
      // the Opportunity's reverse lookup. Both would work, but this one
      // depends only on SBQQ__RenewalOpportunity__c — a field already read
      // above — instead of on Opportunity.SBQQ__RenewedContract__c, and a
      // narrower dependency is a narrower thing to be wrong about.
      const [linked] = await sf.pollForRecords(
        'SELECT Id, SBQQ__RenewalOpportunity__c FROM Contract ' +
          `WHERE Id = '${escapeSoql(ctx.contractId)}' AND SBQQ__RenewalOpportunity__c != null`,
        {
          expect: 1,
          label: 'Contract.SBQQ__RenewalOpportunity__c populated by the renewal forecast',
          timeout: 300_000,
        }
      );
      const renewalOppId = linked.SBQQ__RenewalOpportunity__c;
      expect(renewalOppId, 'Contract.SBQQ__RenewalOpportunity__c').toBeTruthy();

      // Stamp it. CPQ created this Opportunity, it carries a Description, and
      // nothing else will ever make it reclaimable — an unstamped
      // CPQ-generated record is one the sweeper rejects outright (Section 3.17).
      const [renewalOpp] = await sf.query(
        `SELECT Id, Name FROM Opportunity WHERE Id = '${escapeSoql(renewalOppId)}'`
      );
      await cpqData.stampExisting('Opportunity', renewalOppId, {
        name: renewalOpp && renewalOpp.Name,
        parentId: ctx.contractId,
      });

      ctx.renewalOppId = renewalOppId;
      saveState(STATE_KEY, ctx);

      // One line per subscription on the contract.
      const renewalLines = await sf.pollForRecords(
        'SELECT Id, Quantity, UnitPrice, Product2Id, Product2.Name FROM OpportunityLineItem ' +
          `WHERE OpportunityId = '${escapeSoql(renewalOppId)}'`,
        {
          expect: data.expected.subscriptionCount,
          label: 'renewal opportunity products',
          timeout: 300_000,
        }
      );
      expect(renewalLines, 'renewal opportunity products')
        .toHaveLength(data.expected.subscriptionCount);

      for (const line of renewalLines) {
        cpqData.track('OpportunityLineItem', line.Id, {
          name: line.Product2 && line.Product2.Name,
          parentId: renewalOppId,
        });
      }

      // The substitution, asserted in BOTH directions and by name.
      //
      // A count that happens to match is a passing test that proves nothing:
      // four lines is four lines whether or not Warranty was replaced. So the
      // successor's presence and the predecessor's absence are each their own
      // assertion.
      const renewalProducts = productNames(renewalLines, 'Product2.Name');
      for (const name of scenario.renewalForecast.productsPresent) {
        expect(
          renewalProducts.has(name),
          `"${name}" is missing from the renewal opportunity. Products present: ` +
            `${[...renewalProducts].join(', ') || '(none)'}`
        ).toBe(true);
      }
      for (const name of scenario.renewalForecast.productsAbsent) {
        expect(
          renewalProducts.has(name),
          `"${name}" is still on the renewal opportunity. CPQ should have substituted it for ` +
            `"${substitution.to.name}" via Product2.SBQQ__RenewalProduct__c. Products present: ` +
            `${[...renewalProducts].join(', ')}`
        ).toBe(false);
      }

      // -----------------------------------------------------------------------
      // UnitPrice on EVERY renewal line, asserted two ways each.
      //
      // A renewal forecast prices its lines by TWO different models, and the
      // discriminator is substitution:
      //
      //   carried forward   the predecessor subscription's per-unit
      //                     SBQQ__NetPrice__c, scaled by
      //                     renewalTerm / ContractTerm
      //   substituted       the successor's OWN PricebookEntry.UnitPrice,
      //                     because a different product has no predecessor
      //                     price to carry
      //
      // Asserting only the substituted line — which is what this stage used to
      // do — cannot tell the two apart: a wrong number on Warranty Extension is
      // equally consistent with the substitution rule having moved and with the
      // pro-ration having moved. With all four pinned, a failure on the
      // successor ALONE means the substitution behaviour changed and a failure
      // across the other three means the pro-ration did.
      //
      // Each line gets a LITERAL (from the data file, read off a real forecast)
      // and the RELATIONSHIP that produces it (derived here from the contract's
      // own subscriptions and the successor's own price book entry). The
      // literal catches a model that stopped applying; the relationship catches
      // one computing from the wrong base, which a literal alone misses the
      // moment the catalogue changes.
      //
      // toBeCloseTo, not toBe, everywhere below: both sides are currency
      // doubles that have been through CPQ's rounding, and an exact float
      // comparison would fail on a sub-cent difference that means nothing.
      // -----------------------------------------------------------------------
      const expectedPrices = scenario.renewalForecast.expectedUnitPrices;
      const successorName = substitution.to.name;

      // Predecessor pricing, per product name, off the contract read above.
      const subscriptionNet = new Map(
        subscriptions.map((s) => [s.SBQQ__Product__r && s.SBQQ__Product__r.Name, s.SBQQ__NetPrice__c])
      );
      expect(
        contract.ContractTerm,
        `Contract ${contract.ContractNumber} has no ContractTerm, so a carried-forward renewal ` +
          'price cannot be pro-rated against it.'
      ).toBeGreaterThan(0);
      const prorationFactor = scenario.renewalForecast.renewalTerm / contract.ContractTerm;

      console.log(
        `Renewal pricing basis: renewalTerm ${scenario.renewalForecast.renewalTerm} / ContractTerm ` +
          `${contract.ContractTerm} = x${prorationFactor}. Contract subscription net prices: ` +
          JSON.stringify(Object.fromEntries(subscriptionNet))
      );

      // A stale expectation is as bad as a missing one: it means a line the
      // forecast stopped producing is still "covered" by a number nothing
      // compares against.
      expect(
        Object.keys(expectedPrices).sort(),
        'renewalForecast.expectedUnitPrices covers exactly the lines the forecast produced'
      ).toEqual([...renewalProducts].sort());

      for (const line of renewalLines) {
        const name = line.Product2 && line.Product2.Name;

        const expectedPrice = expectedPrices[name];
        expect(
          expectedPrice,
          `The renewal opportunity carries a "${name}" line with no expected UnitPrice in ` +
            'data/home-security.json (amendmentRenewal.renewalForecast.expectedUnitPrices). Either ' +
            'the forecast produced a product this scenario does not know about, or the product was ' +
            'renamed — an unasserted line is an untested one.'
        ).toBeDefined();

        expect(
          line.UnitPrice,
          `UnitPrice on the "${name}" renewal line. ` +
            (name === successorName
              ? `"${name}" is the SUBSTITUTED line, so it takes its own list price rather than ` +
                `"${substitution.from.name}"'s carried-forward pricing.`
              : `"${name}" is carried forward, so it keeps its subscription's pricing pro-rated ` +
                `to the ${scenario.renewalForecast.renewalTerm}-month renewal term.`)
        ).toBeCloseTo(expectedPrice, 2);

        if (name === successorName) {
          // The substituted line, against the successor's own catalogue price.
          expect(
            line.UnitPrice,
            `UnitPrice on the substituted "${name}" renewal line does not match its own ` +
              `PricebookEntry (${successorPbe.UnitPrice}) in price book ` +
              `${data.opportunity.pricebookId}. A substituted successor has no predecessor price ` +
              'to carry, so this is where CPQ is supposed to get it.'
          ).toBeCloseTo(successorPbe.UnitPrice, 2);

          // The discriminator itself, and the one assertion the old
          // single-line version could not make. On 2026-07-28 the successor
          // read 10.00 and was recorded as carried-forward pricing — a
          // reading that was unfalsifiable, because nothing checked it
          // against what carrying forward would ACTUALLY have produced.
          // Warranty nets 20 over 24 months, so carrying forward gives 10 and
          // substituting gives 15; the two models are only distinguishable
          // while those numbers differ.
          const carriedForward = subscriptionNet.get(substitution.from.name) * prorationFactor;
          expect(
            Math.abs(carriedForward - successorPbe.UnitPrice),
            `"${substitution.from.name}" carried forward would price at ${carriedForward} and ` +
              `"${name}"'s own list price is ${successorPbe.UnitPrice}. They are the same number, ` +
              'so this scenario can no longer tell the two pricing models apart and the assertion ' +
              'below proves nothing. Reprice one of the two products, or move the substitution ' +
              `scenario to a pair that differs. ${substitution._setupPath}`
          ).toBeGreaterThan(0.01);
          expect(
            line.UnitPrice,
            `UnitPrice on the substituted "${name}" renewal line is ${line.UnitPrice}, which is ` +
              `what "${substitution.from.name}" would have cost carried forward ` +
              `(${subscriptionNet.get(substitution.from.name)} x ${prorationFactor}). A substituted ` +
              'product must be priced from its own entry, not from the product it replaced.'
          ).not.toBeCloseTo(carriedForward, 2);
        } else {
          // A carried-forward line, against its own predecessor subscription.
          const predecessorNet = subscriptionNet.get(name);
          expect(
            predecessorNet,
            `The renewal opportunity carries "${name}" but contract ${contract.ContractNumber} has ` +
              'no subscription for it, so there is no predecessor price for it to have carried ' +
              'forward. A renewal line with no subscription behind it is the substitution rule ' +
              'firing where it was not expected.'
          ).toBeDefined();
          expect(
            line.UnitPrice,
            `UnitPrice on the carried-forward "${name}" renewal line. Its subscription nets ` +
              `${predecessorNet} per unit over ${contract.ContractTerm} months, so a ` +
              `${scenario.renewalForecast.renewalTerm}-month renewal is ${predecessorNet} x ` +
              `${prorationFactor}. A mismatch here means the pro-ration changed, not the ` +
              'substitution.'
          ).toBeCloseTo(predecessorNet * prorationFactor, 2);
        }
      }

      // -----------------------------------------------------------------------
      // Rename the renewal opportunity through the UI.
      //
      // The runId suffix is required: a fixed name collides across runs, and
      // every downstream reference in stages 6 and 7 resolves by Id anyway, so
      // this is purely so a human opening the org can tell the runs apart.
      // -----------------------------------------------------------------------
      const renewalName = `${scenario.renewalForecast.opportunityBaseName} [${ctx.runId}]`;
      await opportunityPage.open(session.instanceUrl, renewalOppId);
      await opportunityPage.openEdit();
      await opportunityPage.setName(renewalName);
      await opportunityPage.saveEdit();

      await sf.pollForFieldValue('Opportunity', renewalOppId, 'Name', renewalName, {
        label: `renewal Opportunity ${renewalOppId} renamed`,
      });

      // Snapshot for stage 6, which asserts how the amendments move these
      // quantities. Kept in state rather than re-queried, so a later stage
      // compares against what THIS stage saw.
      ctx.renewalOppProducts = renewalLines.map((line) => ({
        name: line.Product2 && line.Product2.Name,
        quantity: line.Quantity,
        unitPrice: line.UnitPrice,
      }));
      saveState(STATE_KEY, ctx);
      console.log(`Renewal opportunity products:\n${JSON.stringify(ctx.renewalOppProducts, null, 2)}`);

      // Thin UI spot-check. Non-empty rather than an exact count: the API
      // already proved the count above, and this only has to catch a rendering
      // regression. Read last, because the helper navigates away.
      expect(
        await opportunityPage.productsRelatedListRowCount(session.instanceUrl, renewalOppId),
        'Products related list rows on the renewal opportunity'
      ).toBeGreaterThan(0);

      completeStage('renewal-forecast');
    });

  // ===========================================================================
  // Stage 6 — two amendments
  //
  // Two test.step sections in ONE test, not two tests. The second amendment
  // depends on the first having been contracted: it amends the same contract
  // from a later start date, and CPQ computes it against the subscriptions the
  // first amendment left behind. Splitting them would let the report claim
  // part 2 ran independently, which it cannot.
  // ===========================================================================
  test('stage 6 — two amendments pro-rate and roll into the existing contract',
    { tag: ['@stage:amendment', '@domain:amend'] },
    async ({ cpqData, sf, contractPage, contractAmendment, quoteLineEditor,
             productSelection, quotePage, orderPage }) => {
      test.skip(resumeGuard('amendment', STAGES), `resuming from "${process.env.RESUME_FROM}"`);

      // Drives the Quote Line Editor twice and contracts two Orders, each with
      // its own activation and settling window. At least as expensive as stage
      // 1, which budgets fifteen minutes.
      test.setTimeout(25 * 60_000);

      cpqData.setStage('amendment');
      cpqData.retainForJourney('stage 7 quotes the renewal of this amended contract');

      requireCtx('contractId', 'startDate', 'renewalOppId');

      const increase = scenario.amendments.quantityIncrease;
      const replacementAmendment = scenario.amendments.productReplacement;

      // The contract this stage started against. Captured in a local so the
      // "rolled into the EXISTING contract" claim has something to compare to:
      // ctx is module-scoped and every stage mutates it, so asserting against
      // ctx.contractId alone would compare a value to itself.
      const contractIdAtStart = ctx.contractId;

      ctx.amendmentQuoteIds = ctx.amendmentQuoteIds || [];
      ctx.amendmentOrderIds = ctx.amendmentOrderIds || [];

      // =======================================================================
      // Part 1 — quantity increase
      // =======================================================================
      await test.step('amendment 1: increase Offsite Video Storage to 5', async () => {
        // Derived from the contract's own start date, never from new Date().
        const amendmentStart = plusMonths(ctx.startDate, increase.startDateOffsetMonths);
        console.log(`Amendment 1 start date: ${amendmentStart} (contract starts ${ctx.startDate})`);

        const { quoteId } = await amendContract(
          { cpqData, sf, contractPage, contractAmendment, quotePage, quoteLineEditor },
          {
            instanceUrl: session.instanceUrl,
            contractId: ctx.contractId,
            amendmentStartDate: amendmentStart,
            knownQuoteIds: ctx.amendmentQuoteIds,
          }
        );
        ctx.amendmentQuoteIds.push(quoteId);
        saveState(STATE_KEY, ctx);

        // The editor is flat by the time the flow hands it over.
        //
        // CPQ DOES propagate SBQQ__LineItemsGrouped__c to an amendment quote —
        // measured, not assumed — while leaving every amendment line's
        // SBQQ__Group__c null, which hangs the grouped editor indefinitely.
        // amendContract unchecks Group Line Items for exactly that reason, so
        // this asserts the state the null-scoped line methods below depend on
        // rather than a claim about what CPQ does.
        const amendmentQuote = await sf.record('SBQQ__Quote__c', quoteId, [
          'Id', 'SBQQ__Type__c', 'SBQQ__LineItemsGrouped__c', 'SBQQ__StartDate__c',
        ]);
        expect(amendmentQuote.SBQQ__Type__c, 'SBQQ__Type__c on the amendment quote')
          .toBe('Amendment');
        expect(
          amendmentQuote.SBQQ__LineItemsGrouped__c,
          `Amendment quote ${quoteId} is still GROUPED after amendContract, which is supposed to ` +
            'have unchecked Group Line Items. Every line method below is called with a null ' +
            'group — correct for a flat quote and wrong for a grouped one.'
        ).toBe(false);

        // Act: set the quantity, calculate, save. Addressed by product code —
        // the line table is matched on SBQQ__ProductCode__c, which is unique,
        // unlike the product name.
        await quoteLineEditor.setQuantity(null, increase.product.productCode, increase.quantity);
        await quoteLineEditor.calculate();
        await quoteLineEditor.save();

        // Assert on the amendment quote line.
        //
        // THE QUANTITY IS PART OF THE FILTER, and that is the whole point. An
        // amendment quote is born carrying a line for every subscription on
        // the contract, so a poll that only matches on product code finds a
        // row instantly — the PRE-EDIT row, with the old quantity on it —
        // and reports a save that has not landed yet as a wrong value. Save
        // navigates away and commits asynchronously, so the poll has to wait
        // for the new quantity, not for a line that was there all along.
        const [amendmentLine] = await sf.pollForRecords(
          'SELECT Id, SBQQ__Quantity__c, SBQQ__PriorQuantity__c, SBQQ__EffectiveQuantity__c, ' +
            'SBQQ__NetTotal__c, SBQQ__ProductCode__c, SBQQ__Product__r.Name ' +
            `FROM SBQQ__QuoteLine__c WHERE SBQQ__Quote__c = '${escapeSoql(quoteId)}' ` +
            `AND SBQQ__ProductCode__c = '${escapeSoql(increase.product.productCode)}' ` +
            `AND SBQQ__Quantity__c = ${increase.quantity}`,
          {
            expect: 1,
            label: `amendment quote line for ${increase.product.name} at quantity ` +
              `${increase.quantity}`,
            timeout: 300_000,
          }
        );

        // How CPQ splits an amendment quantity across three fields, READ FROM
        // A REAL RUN (see the data file for the date and org):
        //
        //   SBQQ__Quantity__c           the NEW TOTAL      (5)
        //   SBQQ__PriorQuantity__c      what was contracted (2)
        //   SBQQ__EffectiveQuantity__c  the DELTA           (3)
        //
        // All three are asserted, because the interesting failure is not "the
        // number is wrong" but "CPQ moved the delta to a different field",
        // and only checking the total would sail straight past that.
        expect(
          amendmentLine.SBQQ__PriorQuantity__c,
          `SBQQ__PriorQuantity__c on the "${increase.product.name}" amendment line — what the ` +
            'contract already carried'
        ).toBe(increase.priorQuantity);
        expect(
          amendmentLine.SBQQ__EffectiveQuantity__c,
          `SBQQ__EffectiveQuantity__c on the "${increase.product.name}" amendment line — the ` +
            'delta CPQ will actually bill for'
        ).toBe(increase.deltaQuantity);

        // toBeCloseTo, not toBe: both sides are currency doubles that have
        // been through CPQ's rounding, and an exact float comparison would
        // fail on a sub-cent difference that means nothing.
        expect(
          amendmentLine.SBQQ__NetTotal__c,
          `SBQQ__NetTotal__c on the pro-rated "${increase.product.name}" amendment line. This is ` +
            'the pro-ration itself: ' + increase._netTotalDerivation
        ).toBeCloseTo(increase.quoteLineNetTotal, 2);

        // Order, activate, contract.
        const { orderIds } = await orderAndContract(
          { cpqData, sf, quotePage, orderPage },
          {
            instanceUrl: session.instanceUrl,
            quoteId,
            parentId: ctx.contractId,
          }
        );
        ctx.amendmentOrderIds.push(...orderIds);
        saveState(STATE_KEY, ctx);

        // ---------------------------------------------------------------------
        // The headline claim, with its own assertion.
        //
        // "It rolled into the existing contract" is not something to infer
        // from a subscription count — a new contract carrying the same rows
        // would satisfy that just as well.
        // ---------------------------------------------------------------------
        await assertSingleContract(sf, expect, {
          contractId: ctx.contractId,
          quoteIds: [ctx.quoteId, ...ctx.amendmentQuoteIds],
          orderIds: [...Object.values(ctx.orderIds || {}), ...ctx.amendmentOrderIds],
          label: 'after amendment 1',
        });

        // The contract gains a subscription row for the DELTA, not the new
        // total — CPQ records an increase as an additional row for the
        // increment rather than by editing the original.
        const deltaRows = await sf.pollForRecords(
          'SELECT Id, SBQQ__Quantity__c, SBQQ__StartDate__c, SBQQ__Product__r.Name ' +
            `FROM SBQQ__Subscription__c WHERE SBQQ__Contract__c = '${escapeSoql(ctx.contractId)}' ` +
            `AND SBQQ__Product__r.ProductCode = '${escapeSoql(increase.product.productCode)}' ` +
            `AND SBQQ__Quantity__c = ${increase.deltaQuantity}`,
          {
            expect: 1,
            label: `contract subscription for the +${increase.deltaQuantity} ` +
              `"${increase.product.name}" increment`,
            timeout: 300_000,
          }
        );
        for (const row of deltaRows) {
          cpqData.track('SBQQ__Subscription__c', row.Id, {
            name: row.SBQQ__Product__r && row.SBQQ__Product__r.Name,
            parentId: ctx.contractId,
          });
        }
        expect(
          deltaRows[0].SBQQ__Quantity__c,
          `SBQQ__Quantity__c on the new "${increase.product.name}" subscription — the delta, not ` +
            'the new total'
        ).toBe(increase.deltaQuantity);

        // And the journey is still pointed at the same contract: the delta row
        // above was found under contractIdAtStart, and nothing repointed the
        // state to a contract this stage happened to create.
        expect(
          sameId(ctx.contractId, contractIdAtStart),
          `Journey state now points at contract ${ctx.contractId}, but this stage started against ` +
            `${contractIdAtStart}. An amendment must not repoint the journey at a new contract.`
        ).toBe(true);

        // The renewal opportunity follows the amendment.
        const [renewalLine] = await sf.pollForRecords(
          'SELECT Id, Quantity, Product2.Name FROM OpportunityLineItem ' +
            `WHERE OpportunityId = '${escapeSoql(ctx.renewalOppId)}' ` +
            `AND Product2.ProductCode = '${escapeSoql(increase.product.productCode)}' ` +
            `AND Quantity = ${increase.quantity}`,
          {
            expect: 1,
            label: `renewal opportunity line for "${increase.product.name}" at quantity ` +
              `${increase.quantity}`,
            timeout: 300_000,
          }
        );
        expect(
          renewalLine.Quantity,
          `Quantity on the renewal opportunity's "${increase.product.name}" line after amendment 1`
        ).toBe(increase.quantity);
      });

      // =======================================================================
      // Part 2 — product replacement
      // =======================================================================
      await test.step('amendment 2: replace Mobile Monitoring App with Mobile Control Center App', async () => {
        const amendmentStart = plusMonths(
          ctx.startDate,
          replacementAmendment.startDateOffsetMonths
        );
        console.log(`Amendment 2 start date: ${amendmentStart} (contract starts ${ctx.startDate})`);

        const { quoteId } = await amendContract(
          { cpqData, sf, contractPage, contractAmendment, quotePage, quoteLineEditor },
          {
            instanceUrl: session.instanceUrl,
            contractId: ctx.contractId,
            amendmentStartDate: amendmentStart,
            knownQuoteIds: ctx.amendmentQuoteIds,
          }
        );
        ctx.amendmentQuoteIds.push(quoteId);
        saveState(STATE_KEY, ctx);

        // Terminate by setting the quantity to 0, then add the successor.
        // Quantity first: adding a product is a round trip through the
        // selection screen and back, and doing it first would mean re-entering
        // the line table afterwards.
        await quoteLineEditor.setQuantity(null, replacementAmendment.terminate.productCode, 0);

        await quoteLineEditor.openAddProducts(null);
        await productSelection.addProducts([replacementAmendment.add]);

        await quoteLineEditor.save();

        const { orderIds } = await orderAndContract(
          { cpqData, sf, quotePage, orderPage },
          {
            instanceUrl: session.instanceUrl,
            quoteId,
            parentId: ctx.contractId,
          }
        );
        ctx.amendmentOrderIds.push(...orderIds);
        saveState(STATE_KEY, ctx);

        // Same integrity claim as amendment 1, asserted again rather than
        // assumed to still hold.
        await assertSingleContract(sf, expect, {
          contractId: ctx.contractId,
          quoteIds: [ctx.quoteId, ...ctx.amendmentQuoteIds],
          orderIds: [...Object.values(ctx.orderIds || {}), ...ctx.amendmentOrderIds],
          label: 'after amendment 2',
        });

        // The termination: a subscription row with a NEGATIVE quantity.
        const [terminated] = await sf.pollForRecords(
          'SELECT Id, SBQQ__Quantity__c, SBQQ__StartDate__c, SBQQ__Product__r.Name ' +
            `FROM SBQQ__Subscription__c WHERE SBQQ__Contract__c = '${escapeSoql(ctx.contractId)}' ` +
            `AND SBQQ__Product__r.ProductCode = '${escapeSoql(replacementAmendment.terminate.productCode)}' ` +
            'AND SBQQ__Quantity__c < 0',
          {
            expect: 1,
            label: `terminating (negative-quantity) subscription for ` +
              `"${replacementAmendment.terminate.name}"`,
            timeout: 300_000,
          }
        );
        expect(
          terminated.SBQQ__Quantity__c,
          `SBQQ__Quantity__c on the terminating "${replacementAmendment.terminate.name}" ` +
            'subscription — a termination is recorded as a negative row'
        ).toBeLessThan(0);
        cpqData.track('SBQQ__Subscription__c', terminated.Id, {
          name: terminated.SBQQ__Product__r && terminated.SBQQ__Product__r.Name,
          parentId: ctx.contractId,
        });

        // The replacement, and the date the two share.
        const [added] = await sf.pollForRecords(
          'SELECT Id, SBQQ__Quantity__c, SBQQ__StartDate__c, SBQQ__Product__r.Name ' +
            `FROM SBQQ__Subscription__c WHERE SBQQ__Contract__c = '${escapeSoql(ctx.contractId)}' ` +
            `AND SBQQ__Product__r.ProductCode = '${escapeSoql(replacementAmendment.add.productCode)}'`,
          {
            expect: 1,
            label: `new subscription for "${replacementAmendment.add.name}"`,
            timeout: 300_000,
          }
        );
        cpqData.track('SBQQ__Subscription__c', added.Id, {
          name: added.SBQQ__Product__r && added.SBQQ__Product__r.Name,
          parentId: ctx.contractId,
        });

        // The two halves of a replacement have to meet: the old line stops on
        // the day the new one starts, or the customer is billed for both or
        // for neither across the gap.
        expect(
          terminated.SBQQ__StartDate__c,
          `The terminating "${replacementAmendment.terminate.name}" row is effective ` +
            `${terminated.SBQQ__StartDate__c} but the replacement ` +
            `"${replacementAmendment.add.name}" starts ${added.SBQQ__StartDate__c}. A replacement ` +
            'has to be continuous — a gap or an overlap is a billing error.'
        ).toBe(added.SBQQ__StartDate__c);

        // The renewal opportunity follows the replacement, both ways.
        const renewalLines = await sf.pollForRecords(
          'SELECT Id, Quantity, Product2.Name FROM OpportunityLineItem ' +
            `WHERE OpportunityId = '${escapeSoql(ctx.renewalOppId)}' ` +
            `AND Product2.ProductCode = '${escapeSoql(replacementAmendment.add.productCode)}'`,
          {
            expect: 1,
            label: `renewal opportunity line for "${replacementAmendment.add.name}"`,
            timeout: 300_000,
          }
        );
        expect(renewalLines, `renewal opportunity carries "${replacementAmendment.add.name}"`)
          .toHaveLength(1);

        const stillThere = await sf.query(
          'SELECT Id, Quantity, Product2.Name FROM OpportunityLineItem ' +
            `WHERE OpportunityId = '${escapeSoql(ctx.renewalOppId)}' ` +
            `AND Product2.ProductCode = '${escapeSoql(replacementAmendment.terminate.productCode)}'`
        );
        expect(
          stillThere,
          `"${replacementAmendment.terminate.name}" is still on the renewal opportunity after ` +
            'being terminated by amendment 2. A terminated subscription must not be renewed.'
        ).toHaveLength(0);
      });

      // -----------------------------------------------------------------------
      // Snapshot both contract-subscription states for stage 7, and spot-check
      // the UI once. Read last, because the related-list helper navigates away.
      // -----------------------------------------------------------------------
      const finalSubscriptions = await sf.query(
        'SELECT Id, SBQQ__Quantity__c, SBQQ__StartDate__c, SBQQ__Product__r.Name, ' +
          'SBQQ__Product__r.ProductCode FROM SBQQ__Subscription__c ' +
          `WHERE SBQQ__Contract__c = '${escapeSoql(ctx.contractId)}' ORDER BY CreatedDate`
      );
      ctx.contractSubscriptions = finalSubscriptions.map((s) => ({
        product: s.SBQQ__Product__r && s.SBQQ__Product__r.Name,
        productCode: s.SBQQ__Product__r && s.SBQQ__Product__r.ProductCode,
        quantity: s.SBQQ__Quantity__c,
        startDate: s.SBQQ__StartDate__c,
      }));
      saveState(STATE_KEY, ctx);
      console.log(
        `Contract subscriptions after both amendments (${finalSubscriptions.length}):\n` +
          JSON.stringify(ctx.contractSubscriptions, null, 2)
      );

      // CPQ never edits an existing subscription row — it appends one per
      // change, so the contract reads as a ledger. Asserted on the record
      // first, then spot-checked in the UI.
      const expectedTotal = scenario.amendments.expectedSubscriptionCount;
      expect(
        finalSubscriptions,
        'SBQQ__Subscription__c rows on the contract after both amendments'
      ).toHaveLength(expectedTotal);

      expect(
        await contractPage.subscriptionsRelatedListRowCount(session.instanceUrl, ctx.contractId),
        'Subscriptions related list rows on the contract after both amendments'
      ).toBe(expectedTotal);

      completeStage('amendment');
    });

  // ===========================================================================
  // Stage 7 — Renewal Quoted
  // ===========================================================================
  test('stage 7 — checking Renewal Quoted generates a renewal quote of only the subscription products',
    { tag: ['@stage:renewal-quote', '@domain:renewal'] },
    async ({ cpqData, sf, contractPage, quotePage, quoteLineEditor }) => {
      test.skip(resumeGuard('renewal-quote', STAGES), `resuming from "${process.env.RESUME_FROM}"`);

      // A contract edit, CPQ generating a quote and its lines, then one cold
      // load of the Quote Line Editor — which alone takes over a minute.
      test.setTimeout(15 * 60_000);

      cpqData.setStage('renewal-quote');
      cpqData.retainForJourney('the renewal quote is this journey`s final artefact');

      requireCtx('contractId', 'renewalOppId');

      // -----------------------------------------------------------------------
      // Act in the UI.
      // -----------------------------------------------------------------------
      await contractPage.open(session.instanceUrl, ctx.contractId);
      await contractPage.openEdit();
      await contractPage.setRenewalQuoted(true);
      await contractPage.saveEdit();

      const saved = await sf.record('Contract', ctx.contractId, ['Id', 'SBQQ__RenewalQuoted__c']);
      expect(saved.SBQQ__RenewalQuoted__c, 'Contract.SBQQ__RenewalQuoted__c').toBe(true);

      // -----------------------------------------------------------------------
      // Assert in the API.
      // -----------------------------------------------------------------------
      // Exactly one. pollForRecord throws on more than one row, so "exactly 1"
      // is enforced rather than assumed — a second renewal quote against the
      // same opportunity would mean CPQ ran the generation twice.
      const renewalQuote = await sf.pollForRecord(
        'SELECT Id, Name, SBQQ__Type__c, SBQQ__LineItemsGrouped__c, SBQQ__NetAmount__c ' +
          `FROM SBQQ__Quote__c WHERE SBQQ__Opportunity2__c = '${escapeSoql(ctx.renewalOppId)}'`,
        {
          label: 'renewal quote against the renewal opportunity',
          timeout: 300_000,
        }
      );

      // No Description field on SBQQ__Quote__c, so this gets a ledger row and
      // a parentId of the renewal Opportunity — the sweeper reaches it by
      // ancestry rather than by its own marker (Section 3.17).
      cpqData.track('SBQQ__Quote__c', renewalQuote.Id, {
        name: renewalQuote.Name,
        parentId: ctx.renewalOppId,
      });

      ctx.renewalQuoteId = renewalQuote.Id;
      saveState(STATE_KEY, ctx);

      const expectedProducts = scenario.renewalQuote.productsPresent;
      const lines = await sf.pollForRecords(
        'SELECT Id, SBQQ__Quantity__c, SBQQ__NetTotal__c, SBQQ__ProductCode__c, ' +
          `SBQQ__Product__r.Name FROM SBQQ__QuoteLine__c ` +
          `WHERE SBQQ__Quote__c = '${escapeSoql(renewalQuote.Id)}'`,
        {
          expect: expectedProducts.length,
          label: 'renewal quote lines',
          timeout: 300_000,
        }
      );

      for (const line of lines) {
        cpqData.track('SBQQ__QuoteLine__c', line.Id, {
          name: line.SBQQ__Product__r && line.SBQQ__Product__r.Name,
          parentId: renewalQuote.Id,
        });
      }

      // The line set, by NAME and in both directions. Asserting the hardware
      // is absent by name rather than by count is the point: a total of four
      // arrived at with a camera on it instead of the warranty extension is a
      // passing count and a broken renewal.
      const onQuote = productNames(lines, 'SBQQ__Product__r.Name');
      for (const name of expectedProducts) {
        expect(
          onQuote.has(name),
          `"${name}" is missing from the renewal quote. Lines present: ` +
            `${[...onQuote].join(', ') || '(none)'}`
        ).toBe(true);
      }
      for (const name of scenario.renewalQuote.productsAbsent) {
        expect(
          onQuote.has(name),
          `"${name}" is on the renewal quote. A renewal carries subscriptions only — the one-time ` +
            'hardware went to a different order and became Assets, and a terminated or ' +
            `substituted product must not be renewed. Lines present: ${[...onQuote].join(', ')}`
        ).toBe(false);
      }

      // Quantities and substitutions carry through from both amendments.
      for (const [productName, quantity] of Object.entries(scenario.renewalQuote.quantities)) {
        const line = lines.find(
          (l) => l.SBQQ__Product__r && l.SBQQ__Product__r.Name === productName
        );
        expect(line, `"${productName}" is missing from the renewal quote`).toBeTruthy();
        expect(
          line.SBQQ__Quantity__c,
          `SBQQ__Quantity__c for "${productName}" on the renewal quote — amendment 1 took it to ` +
            `${quantity}, and a renewal that quotes the original amount would under-bill`
        ).toBe(quantity);
      }

      // -----------------------------------------------------------------------
      // Thin UI spot-check, in the editor, then back out without saving.
      //
      // Opening the QLE on the renewal quote is also the only way to confirm
      // it renders at all — a quote whose lines exist but whose editor throws
      // is not a usable renewal.
      // -----------------------------------------------------------------------
      // Opened through the flow, because a renewal quote arrives in the same
      // unrenderable state an amendment quote does — grouped, with every line
      // in no group — and its editor hangs indefinitely until Group Line Items
      // is unchecked. See openFlatQuoteEditor.
      await openFlatQuoteEditor({ sf, quotePage, quoteLineEditor }, {
        instanceUrl: session.instanceUrl,
        quoteId: renewalQuote.Id,
        label: 'renewal quote',
      });

      // Read BEFORE cancelling — the count is gone once the editor is.
      expect(
        await quoteLineEditor.lineCount(null),
        'line count rendered in the renewal quote editor'
      ).toBe(expectedProducts.length);

      // Cancel back to the quote. Nothing was edited, so there is nothing to
      // commit — and Save would recalculate a quote this stage is only
      // supposed to read, which would make the stage a writer rather than an
      // observer.
      await quoteLineEditor.cancel(session.instanceUrl, renewalQuote.Id);

      completeStage('renewal-quote');
    });
});
