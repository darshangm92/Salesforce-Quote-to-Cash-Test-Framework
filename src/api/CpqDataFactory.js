// src/api/CpqDataFactory.js
//
// CPQ-specific setup/teardown built on SalesforceRestClient. One instance
// per test (see the `cpqData` fixture in cpqFixtures.js) — it tracks every
// record it creates so cleanup() can remove exactly what that test made,
// keeping parallel workers from stepping on each other's data. Every test
// owns its data and never relies on records another test created.
//
// Every create also stamps the record's Description with the run marker and
// appends a ledger row, so the standalone sweeper
// (scripts/cleanup-e2e-data.js) can find and remove anything a crashed run
// left behind — the case where in-test cleanup never gets to run at all.
const { SalesforceRestClient } = require('./SalesforceRestClient');
const ledger = require('../utils/ledger');
const { stamp } = require('../utils/runContext');

// Which sObjects have a Description field we can stamp.
//
// Only objects verified to carry a standard Description belong here. An
// unknown field name does not degrade gracefully: Salesforce rejects the
// whole create with INVALID_FIELD, so a guess here breaks every test that
// touches the object.
//
// [VERIFY] SBQQ__Quote__c, SBQQ__QuoteLine__c, SBQQ__QuoteLineGroup__c and
// SBQQ__Subscription__c have no standard Description field. If your org has
// added a custom one, add it here (e.g. SBQQ__Quote__c: 'E2E_Marker__c') to
// widen the sweeper's SOQL safety net. Until then those objects are found
// through the ledger and through parent-record traversal.
const DESCRIPTION_FIELD = {
  Account: 'Description',
  Opportunity: 'Description',
  Order: 'Description',
  Asset: 'Description',
  Contract: 'Description',
};

class CpqDataFactory {
  /**
   * @param {object} [context]
   * @param {string} [context.specFile]  spec path, for the stamp and ledger
   * @param {string} [context.testTitle] test title, for the stamp and ledger
   * @param {string} [context.stage]     journey stage, if any
   */
  constructor(context = {}) {
    this.client = new SalesforceRestClient();
    this.created = []; // { sobject, id } for everything this instance has created, in creation order
    this.specFile = context.specFile || '';
    this.testTitle = context.testTitle || '';
    this.stage = context.stage || '';
    this._retain = null; // set to a reason string by retainForJourney()
  }

  /**
   * Opts this factory's records out of teardown.
   *
   * Journey stages need this. Each `test()` gets its own `cpqData` instance,
   * so stage 1's teardown would delete the very quote stage 2 opens. Retention
   * is declared on the instance rather than through CPQ_SKIP_CLEANUP so it
   * applies to exactly the stage that needs it, and can't be forgotten in CI
   * or leak into unrelated tests sharing the worker.
   *
   * The records still carry ledger rows with sweepEligible = true, so the
   * scheduled sweeper reclaims them once they age past RETENTION_DAYS. Nothing
   * is retained forever.
   */
  retainForJourney(reason = 'consumed by a later journey stage') {
    this._retain = reason;
    return this;
  }

  // Journeys move through stages within one test file; setting the stage
  // tags subsequent ledger rows so the sheet shows where a record came from.
  setStage(stage) {
    this.stage = stage || '';
    return this;
  }

  // Adds the run marker to the payload when — and only when — the sObject is
  // known to have a description field, without clobbering an explicit value
  // the caller supplied.
  _withStamp(sobject, payload) {
    const field = DESCRIPTION_FIELD[sobject];
    if (!field || payload[field] !== undefined) return payload;
    return { ...payload, [field]: stamp(this.specFile, this.testTitle) };
  }

  // Single funnel for every ledger row this factory writes, so a create, a
  // track, a stamp and a lookup can never drift into recording different
  // shapes for the same run.
  _appendLedger(sobject, id, { name, parentId, sweepEligible }) {
    ledger.append({
      sobject,
      recordId: id,
      recordName: name || '',
      parentId: parentId || '',
      specFile: this.specFile,
      testTitle: this.testTitle,
      stage: this.stage,
      sweepEligible,
    });
  }

  // Single funnel for every create: stamp, create, track for cleanup, ledger.
  async _create(sobject, payload, { name, parentId } = {}) {
    const id = await this.client.create(sobject, this._withStamp(sobject, payload));
    this.created.push({ sobject, id });
    this._appendLedger(sobject, id, {
      name: name || payload.Name || '',
      parentId,
      sweepEligible: true,
    });
    console.log(`Created ${sobject} ${name || ''} (${id})`.replace(/\s+/g, ' '));
    return id;
  }

  // Creates an Account and records it for cleanup. `fields` lets a test
  // override/add Salesforce field API names (e.g. Industry, BillingCountry)
  // beyond the required Name.
  //
  // UNCALLED as of 2026-08-03, and that is the architecture rather than an
  // oversight: this suite quotes against the org's pre-existing sample
  // accounts and resolves them through cpqData.registerExisting(), which
  // records them at sweepEligible = false. Accounts are looked up, never
  // created or deleted.
  //
  // KNOW THIS BEFORE CALLING IT. An Account created here is stamped
  // sweepEligible = TRUE by _create(), but `Account` is on the SWEEPER'S
  // DENYLIST — every Account, unconditionally, and the sweeper throws at
  // startup if the allowlist and denylist ever overlap. So the two disagree by
  // design, and the consequence is one-directional: per-test cleanup() deletes
  // the account normally, but if a run CRASHES before teardown, the scheduled
  // sweep can never reclaim it. It leaks permanently and has to be deleted by
  // hand. That is precisely the residue Section 3.17 exists to prevent, so
  // prefer registerExisting() against a looked-up account unless a scenario
  // genuinely needs an account that does not exist yet.
  async account(name, fields = {}) {
    return this._create('Account', { Name: name, ...fields }, { name });
  }

  // Creates an Opportunity under the given Account. CloseDate is required by
  // Salesforce and has no sensible default, so it's not defaulted here —
  // callers must supply one.
  async opportunity(accountId, { name, stage = 'Prospecting', closeDate, ...fields }) {
    return this._create(
      'Opportunity',
      { Name: name, AccountId: accountId, StageName: stage, CloseDate: closeDate, ...fields },
      { name, parentId: accountId }
    );
  }

  // Creates a Quote (SBQQ__Quote__c) linked to the Opportunity and Account.
  //
  // SBQQ__Primary__c defaults to FALSE deliberately. Seeding it true would
  // pre-set the exact state a test that exercises "mark this quote primary"
  // in the UI is supposed to prove, turning a real assertion into a tautology.
  // Callers that genuinely need a primary quote as a precondition pass
  // { SBQQ__Primary__c: true } explicitly.
  //
  // This seeds only the Quote header — line items are added through the UI in
  // tests, since adding products is itself CPQ behavior under test.
  async quote(opportunityId, accountId, fields = {}) {
    return this._create(
      'SBQQ__Quote__c',
      {
        SBQQ__Opportunity2__c: opportunityId,
        SBQQ__Account__c: accountId,
        SBQQ__Primary__c: false,
        ...fields,
      },
      { parentId: opportunityId }
    );
  }

  /**
   * Registers a record the org created on the suite's behalf — Quote Line
   * Groups spun up by a record-triggered Flow, Order Products generated by
   * Order creation — so it is both torn down with the test and visible to the
   * sweeper. The suite caused it to exist, so sweepEligible stays true.
   */
  track(sobject, id, { name, parentId } = {}) {
    this.created.push({ sobject, id });
    this._appendLedger(sobject, id, { name, parentId, sweepEligible: true });
    return id;
  }

  /**
   * Stamps and ledgers a record CPQ created in response to a UI action — the
   * Orders that appear when a quote is marked Ordered, the Contract that
   * appears when an Order is marked Contracted.
   *
   * This exists because those records are the framework's one real leak. They
   * are created by the platform, so nothing in _create() ever touches them,
   * and the journey retains them past teardown by design — which leaves the
   * scheduled sweeper as the only thing that will ever reclaim them. An
   * unstamped Order is therefore not "missing a nice-to-have field", it is a
   * record nothing can clean up.
   *
   * Deliberately NOT pushed onto `this.created`. These records belong to CPQ,
   * every stage that makes them hands them to the next one, and an activated
   * Order cannot be deleted at all — so a per-test teardown that tried would
   * only produce noise. The ledger row (sweepEligible = true) is what routes
   * them to the sweeper instead.
   *
   * @param {string} sobject
   * @param {string} id
   * @param {object} [meta]
   * @param {string} [meta.name]      label for the ledger sheet
   * @param {string} [meta.parentId]  what this record hangs off, for ancestry
   */
  async stampExisting(sobject, id, { name, parentId } = {}) {
    const field = DESCRIPTION_FIELD[sobject];

    if (field) {
      // No try/catch here, on purpose. The sweeper verifies a stampable
      // object by its OWN Description marker and rejects it outright when the
      // marker is absent — it never falls back to an ancestry check for these.
      // So swallowing a failed PATCH would trade a red test for a record that
      // is permanently unreclaimable, which is the exact failure this method
      // exists to prevent. Fail loudly instead.
      await this.client.patch(sobject, id, { [field]: stamp(this.specFile, this.testTitle) });
      console.log(`Stamped ${sobject} ${name || ''} (${id})`.replace(/\s+/g, ' '));
    } else {
      console.log(
        `${sobject} ${id} has no stampable Description field — recording a ledger row only; ` +
          'the sweeper verifies it by traversing to a marked ancestor.'
      );
    }

    this._appendLedger(sobject, id, { name, parentId, sweepEligible: true });
    return id;
  }

  /**
   * Records a pre-existing record the test merely resolved by lookup (a
   * sample Account, a catalog Product2). Ledger-only: it is never added to
   * `created`, and sweepEligible is false, so neither cleanup() nor the
   * sweeper can ever delete something the suite did not make.
   */
  registerExisting(sobject, id, { name, parentId } = {}) {
    this._appendLedger(sobject, id, { name, parentId, sweepEligible: false });
    return id;
  }

  // Delete in reverse order so child records go before parents (deleting an
  // Account while its Opportunity/Quote still reference it would fail).
  //
  // CPQ_SKIP_CLEANUP=1 turns this into a report of what *would* have been
  // deleted. That is the failure-investigation escape hatch: when a quote
  // prices wrong, the records that produced it need to survive long enough
  // to be opened in the org. The scheduled sweeper reclaims them later.
  async cleanup() {
    const retainReason = this._retain
      || (process.env.CPQ_SKIP_CLEANUP === '1' ? 'CPQ_SKIP_CLEANUP=1' : null);

    if (retainReason) {
      console.log(
        `Retaining ${this.created.length} record(s) in the org (${retainReason}):`
      );
      for (const rec of [...this.created].reverse()) {
        console.log(`  would delete ${rec.sobject} ${rec.id}`);
      }
      console.log('  Reclaim them with: npm run cleanup:e2e -- --confirm');
      this.created = [];
      await this.client.dispose();
      return;
    }

    for (const rec of [...this.created].reverse()) {
      try {
        await this.client.remove(rec.sobject, rec.id);
      } catch (e) {
        // Don't let one failed delete abort the rest of cleanup — log and
        // keep going so later (parent) records still get a chance to be removed.
        console.warn(`Cleanup failed for ${rec.sobject} ${rec.id}: ${e.message}`);
      }
    }
    this.created = [];
    await this.client.dispose();
  }
}

module.exports = { CpqDataFactory, DESCRIPTION_FIELD };
