// scripts/cleanup-e2e-data.js
//
// Standalone sweeper for E2E-created org data. Run on a schedule — never
// from afterAll(), never from globalTeardown.
//
// The reason is the whole point of this script: per-test cleanup and global
// teardown get skipped exactly when a run crashes, and a crashed run is
// exactly when data gets left behind. A sweeper that only runs when the suite
// exits cleanly cleans up only the data that was already cleaned up.
//
// Safety model, in order of strength:
//   1. Allowlist  — an exhaustive list of deletable sObjects. Anything absent
//                   is untouchable, including by mistake.
//   2. Denylist   — org configuration and catalog data, asserted disjoint
//                   from the allowlist at startup so the two can never drift
//                   into overlapping.
//   3. sweepEligible — false for every record the suite merely looked up, so
//                   nothing the suite did not create can ever be selected.
//   4. Marker verification — a ledger row is not enough on its own; the
//                   record must still be confirmed in the org, by its own
//                   Description marker or by a marked ancestor.
//   5. Dry-run by default — deleting requires --confirm, explicitly.
//
// Candidates come from three independent sources, all subject to (4):
//   ledger   — the run ledger, when one is on disk.
//   SOQL net — marked records of a stampable type, for runs that crashed
//              before merging their shards.
//   ancestry — allowlisted children of a marked record, for the objects the
//              platform gives us nowhere to stamp. This is the only source
//              that works with no ledger at all, which is the normal case for
//              the scheduled CI sweep. See CHILD_LOOKUP.
//
// Usage:
//   node scripts/cleanup-e2e-data.js                  # dry run (the default)
//   node scripts/cleanup-e2e-data.js --dry-run
//   node scripts/cleanup-e2e-data.js --confirm
//   node scripts/cleanup-e2e-data.js --confirm --retention-days=3
const fs = require('fs');
const { request } = require('@playwright/test');
const XLSX = require('xlsx');
const env = require('../src/config/env');
const { authenticate } = require('../src/api/SalesforceAuth');
const { readShards, workbookPath, DATA_SHEET } = require('../src/utils/ledger');
const { escapeSoql, soqlDateTime } = require('../src/utils/waitForAsync');

// How long created data is allowed to survive before the sweeper reclaims it.
// Override with --retention-days=N or RETENTION_DAYS.
const DEFAULT_RETENTION_DAYS = 3;

// Deletion order: children strictly before parents, mirroring the reverse
// order CpqDataFactory.cleanup() uses. This list is also the allowlist —
// an sObject not named here is never deleted by this script.
const DELETE_ORDER = [
  'OpportunityLineItem',
  'Asset',
  'SBQQ__Subscription__c',
  'Contract',
  'OrderItem',
  'Order',
  'SBQQ__QuoteLine__c',
  'SBQQ__QuoteLineGroup__c',
  'SBQQ__Quote__c',
  'Opportunity',
];
const ALLOWLIST = new Set(DELETE_ORDER);

// Master-detail children, and the parent whose deletion cascades to them.
//
// Deleting the parent removes these automatically, so when both are in the
// same plan the child does not need its own DELETE call. Skipping it saves API
// calls and — more importantly — removes a whole class of spurious errors: any
// child whose parent went first (a partially-completed earlier run, a manual
// delete, another process) comes back ENTITY_IS_DELETED.
//
// Deletion order still puts children first, which is what keeps this safe for
// children whose parent is NOT in the plan.
const CASCADE_PARENT = {
  OpportunityLineItem: 'Opportunity',
  OrderItem: 'Order',
  SBQQ__QuoteLine__c: 'SBQQ__Quote__c',
  SBQQ__QuoteLineGroup__c: 'SBQQ__Quote__c',
};

// Org configuration, catalog and pricing setup. Deleting any of these breaks
// the org for every future run and, in a shared sandbox, for everyone else.
// Account is here because this suite quotes against pre-existing sample
// accounts it did not create and must not remove.
const DENYLIST = new Set([
  'Account',
  'Product2',
  'PricebookEntry',
  'Pricebook2',
  'SBQQ__PriceRule__c',
  'SBQQ__PriceAction__c',
  'SBQQ__PriceCondition__c',
  'SBQQ__ProductRule__c',
  'SBQQ__ErrorCondition__c',
  'SBQQ__ProductAction__c',
  'SBQQ__ConfigurationAttribute__c',
  'SBQQ__ProductOption__c',
  'SBQQ__DiscountSchedule__c',
  'Flow',
  'FlowDefinition',
]);

// sObjects whose Description we stamp (must match DESCRIPTION_FIELD in
// src/api/CpqDataFactory.js). Only these can be found by the SOQL safety net
// or verified by their own marker; everything else is verified by ancestry.
const DESCRIPTION_FIELD = {
  Account: 'Description',
  Opportunity: 'Description',
  Order: 'Description',
  Asset: 'Description',
  Contract: 'Description',
};

// Human-readable label per object. Two of these are NOT `Name` and asking for
// the wrong one fails the whole query rather than returning a blank label:
// Contract's is ContractNumber, and OrderItem's is OrderItemNumber (OrderItem
// has no Name field at all). Every entry below was read from the org's
// describe on 2026-08-03, not assumed.
const NAME_FIELD = {
  Opportunity: 'Name',
  Order: 'Name',
  Asset: 'Name',
  Contract: 'ContractNumber',
  SBQQ__Quote__c: 'Name',
  SBQQ__QuoteLine__c: 'Name',
  SBQQ__QuoteLineGroup__c: 'Name',
  SBQQ__Subscription__c: 'Name',
  OrderItem: 'OrderItemNumber',
  OpportunityLineItem: 'Name',
};

// Descent map for ancestry discovery: parent sObject -> its allowlisted
// children and the lookup field that points back up.
//
// This is what makes the sweeper work with no ledger at all. The SOQL safety
// net can only find the five stampable objects, because a marker lives in a
// Description field and nothing else has one. SBQQ__Quote__c and
// SBQQ__Subscription__c have no Description and are not master-detail children
// of anything stampable, so before this map existed they could ONLY be reached
// through a ledger row — and a scheduled CI sweep never has one: the workbook
// is gitignored, and the job that writes it is a different job on a different
// checkout from the job that sweeps.
//
// Walking DOWN from a marked ancestor closes that gap without coupling the two
// jobs together or depending on artifact retention. Provenance is unchanged in
// strength: a descendant is only ever a candidate because a marked ancestor
// led to it, and it still has to clear the same verification as everything
// else (see verifyCandidates) before it can be deleted.
//
// Lookup fields and their targets were read from the org's describe on
// 2026-08-03. A wrong field name here returns INVALID_FIELD naming the field,
// which is why they are spelled out rather than derived.
const CHILD_LOOKUP = {
  Opportunity: [
    { sobject: 'SBQQ__Quote__c', field: 'SBQQ__Opportunity2__c' },
    { sobject: 'OpportunityLineItem', field: 'OpportunityId' },
  ],
  Contract: [{ sobject: 'SBQQ__Subscription__c', field: 'SBQQ__Contract__c' }],
  Order: [{ sobject: 'OrderItem', field: 'OrderId' }],
  SBQQ__Quote__c: [
    { sobject: 'SBQQ__QuoteLine__c', field: 'SBQQ__Quote__c' },
    { sobject: 'SBQQ__QuoteLineGroup__c', field: 'SBQQ__Quote__c' },
  ],
};

// Opportunity -> Quote -> QuoteLine is two hops, so one level of descent is
// not enough. The bound exists to stop a lookup cycle turning into an
// unbounded crawl, not because any real chain here is deep.
const MAX_DESCENT_DEPTH = 3;

// The literal prefix runContext.stamp() writes. Changing the stamp shape
// means changing this too.
const MARKER_PREFIX = 'E2E | run=E2E-';

const CHUNK = 200;

// ---------------------------------------------------------------------------
// Minimal admin client
//
// SalesforceRestClient is deliberately not reused here. It reads a session
// from .auth/ that a scheduled sweeper has no reason to have, its remove()
// does not surface the HTTP status, and it has no update() — and this script
// must PATCH records (clearing sync flags, reverting Status) and must report
// truthfully which deletes actually succeeded.
// ---------------------------------------------------------------------------
class OrgAdmin {
  constructor(ctx) {
    this.ctx = ctx;
  }

  static async connect() {
    const session = await authenticate();
    const ctx = await request.newContext({
      baseURL: session.instanceUrl,
      extraHTTPHeaders: {
        Authorization: `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    const admin = new OrgAdmin(ctx);
    admin.instanceUrl = session.instanceUrl;

    // The integration user's Id. The SOQL safety net narrows to records this
    // user created — both to keep the scan small and because a record the
    // suite created was, by definition, created by this user.
    const info = await ctx.get('/services/oauth2/userinfo');
    admin.userId = info.ok() ? (await info.json()).user_id : undefined;
    if (!admin.userId) {
      console.warn('Could not resolve the running user Id; the SOQL safety net will be skipped.');
    }
    return admin;
  }

  async query(soql) {
    const res = await this.ctx.get(`/services/data/${env.apiVersion}/query`, {
      params: { q: soql },
    });
    if (!res.ok()) throw new Error(`Query failed (${res.status()}): ${await res.text()}`);
    return (await res.json()).records || [];
  }

  async patch(sobject, id, payload) {
    const res = await this.ctx.patch(
      `/services/data/${env.apiVersion}/sobjects/${sobject}/${id}`,
      { data: payload }
    );
    if (!res.ok()) throw new Error(`Update ${sobject} ${id} failed (${res.status()}): ${await res.text()}`);
  }

  /**
   * Deletes a record. Returns 'deleted' or 'already-gone'; throws on a real
   * failure.
   *
   * A 404 / ENTITY_IS_DELETED is NOT a failure. Deletion is idempotent here:
   * the goal is that the record is absent, and it is. Records disappear
   * between the plan and the delete for ordinary reasons — most often a
   * master-detail cascade from a parent that was removed by an earlier run,
   * another process, or a manual cleanup. Reporting those as errors buries the
   * genuine failures in noise.
   */
  async remove(sobject, id) {
    const res = await this.ctx.delete(
      `/services/data/${env.apiVersion}/sobjects/${sobject}/${id}`
    );
    if (res.ok()) return 'deleted';

    const body = await res.text();
    if (res.status() === 404 || /ENTITY_IS_DELETED|NOT_FOUND/.test(body)) return 'already-gone';

    throw new Error(`Delete ${sobject} ${id} failed (${res.status()}): ${body}`);
  }

  async dispose() {
    await this.ctx.dispose();
  }
}

// ---------------------------------------------------------------------------
// Ledger input
// ---------------------------------------------------------------------------

function isTruthy(value) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return false;
  return !/^(false|0|no)$/i.test(String(value).trim());
}

// Reads the merged workbook plus any shards a crashed run left unmerged.
// Shards are read, never consumed — merging is merge-ledger.js's job alone.
function readLedgerRows() {
  const rows = [];

  const file = workbookPath();
  if (fs.existsSync(file)) {
    try {
      const workbook = XLSX.readFile(file);
      const sheet = workbook.Sheets[DATA_SHEET] || workbook.Sheets[workbook.SheetNames[0]];
      if (sheet) rows.push(...XLSX.utils.sheet_to_json(sheet, { defval: '' }));
    } catch (e) {
      console.warn(`Could not read ledger workbook ${file}: ${e.message}`);
    }
  }

  rows.push(...readShards().rows);
  return rows;
}

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

function chunk(list, size = CHUNK) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function idList(ids) {
  return ids.map((id) => `'${escapeSoql(id)}'`).join(', ');
}

/**
 * Ledger-sourced candidates: sweepEligible, older than the cutoff, and in the
 * allowlist. This is the primary source.
 */
function ledgerCandidates(rows, cutoff) {
  const byId = new Map();
  const index = new Map(); // recordId -> ledger row, for ancestor traversal

  for (const row of rows) {
    const sobject = String(row.sobject || '').trim();
    const recordId = String(row.recordId || '').trim();
    if (!sobject || !recordId) continue;
    index.set(recordId, row);

    if (!ALLOWLIST.has(sobject)) continue;
    if (!isTruthy(row.sweepEligible)) continue;

    const createdAt = Date.parse(row.createdAt);
    if (!Number.isFinite(createdAt) || createdAt >= cutoff.getTime()) continue;

    byId.set(recordId, {
      sobject,
      id: recordId,
      name: row.recordName || '',
      parentId: String(row.parentId || '').trim(),
      createdAt: row.createdAt,
      source: 'ledger',
    });
  }

  return { candidates: [...byId.values()], index };
}

/**
 * SOQL safety net: marked records of a stampable type, older than the cutoff,
 * that the ledger never learned about because the run died before merging.
 * Objects with no Description field cannot be found this way — they are
 * reached through the ledger and, failing that, by descending from the
 * records found here (see descendantCandidates).
 *
 * Note the marker is matched in JavaScript, not in the WHERE clause.
 * Description is a text-area field on Opportunity, Order and Asset, and
 * Salesforce rejects any filter on it outright:
 *
 *   field 'Description' can not be filtered in a query call  [INVALID_FIELD]
 *
 * So the query narrows on two fields that *are* filterable — age and creator
 * — and the marker check happens on the results.
 */
async function soqlNetCandidates(admin, cutoff) {
  if (!admin.userId) return [];

  const found = [];
  for (const sobject of DELETE_ORDER) {
    const field = DESCRIPTION_FIELD[sobject];
    if (!field) continue;
    const nameField = NAME_FIELD[sobject];

    const soql =
      `SELECT Id, ${nameField}, ${field}, CreatedDate FROM ${sobject} ` +
      `WHERE CreatedDate < ${soqlDateTime(cutoff)} ` +
      `AND CreatedById = '${escapeSoql(admin.userId)}' ` +
      'ORDER BY CreatedDate DESC LIMIT 2000';
    try {
      for (const record of await admin.query(soql)) {
        if (!String(record[field] || '').startsWith(MARKER_PREFIX)) continue;
        found.push({
          sobject,
          id: record.Id,
          name: record[nameField] || '',
          parentId: '',
          createdAt: record.CreatedDate,
          source: 'soql-net',
        });
      }
    } catch (e) {
      console.warn(`SOQL net skipped ${sobject}: ${e.message}`);
    }
  }
  return found;
}

/**
 * Ancestry discovery: walks DOWN from records that carry a marker to the
 * allowlisted children that cannot carry one.
 *
 * This is the third and last candidate source, and the only one that works
 * with no ledger — see the CHILD_LOOKUP comment for why that case is the
 * normal one in CI rather than an edge case.
 *
 * Two things it returns, both needed by the caller:
 *
 *  - candidates: the discovered records, each carrying the parentId that led
 *    to it. That parentId is load-bearing twice over — splitCascadedChildren
 *    uses it to drop children a parent's cascade will remove anyway, and
 *    verifyCandidates uses it to walk back up to the marker.
 *  - indexRows: ledger-row-shaped entries for every record seen, roots
 *    included, so ancestorIsMarked can traverse a chain that no ledger ever
 *    recorded. Without these the walk up would stop at the first record with
 *    no index entry and return null, which verifyCandidates reads as "no chain
 *    to follow, trust the ledger row" — and there is no ledger row here. That
 *    would admit a record on provenance alone, which is exactly what the
 *    safety model refuses to do.
 *
 * The retention cutoff is applied to the children as well as the roots. In
 * practice a child is created within seconds of its parent so this changes
 * nothing, but the retention contract is about record age and applying it
 * unevenly would make the plan hard to reason about.
 */
async function descendantCandidates(admin, roots, cutoff) {
  const found = new Map(); // 15-char Id -> candidate
  const indexRows = new Map(); // full Id -> ledger-shaped row

  let frontier = [];
  for (const root of roots) {
    if (!CHILD_LOOKUP[root.sobject]) continue;
    indexRows.set(root.id, {
      sobject: root.sobject,
      recordId: root.id,
      parentId: root.parentId || '',
    });
    frontier.push({ sobject: root.sobject, id: root.id });
  }

  const seen = new Set(frontier.map((r) => r.id.slice(0, 15)));

  for (let depth = 0; depth < MAX_DESCENT_DEPTH && frontier.length; depth += 1) {
    const next = [];

    const byParent = new Map();
    for (const parent of frontier) {
      if (!byParent.has(parent.sobject)) byParent.set(parent.sobject, []);
      byParent.get(parent.sobject).push(parent.id);
    }

    for (const [parentSobject, parentIds] of byParent) {
      for (const child of CHILD_LOOKUP[parentSobject] || []) {
        const nameField = NAME_FIELD[child.sobject];

        for (const ids of chunk(parentIds)) {
          const soql =
            `SELECT Id, ${nameField}, ${child.field}, CreatedDate FROM ${child.sobject} ` +
            `WHERE ${child.field} IN (${idList(ids)}) ` +
            `AND CreatedDate < ${soqlDateTime(cutoff)} ` +
            'ORDER BY CreatedDate DESC LIMIT 2000';

          try {
            for (const record of await admin.query(soql)) {
              const short = record.Id.slice(0, 15);
              indexRows.set(record.Id, {
                sobject: child.sobject,
                recordId: record.Id,
                parentId: record[child.field] || '',
              });
              if (seen.has(short)) continue;
              seen.add(short);

              found.set(short, {
                sobject: child.sobject,
                id: record.Id,
                name: record[nameField] || '',
                parentId: record[child.field] || '',
                createdAt: record.CreatedDate,
                source: 'ancestry',
              });
              next.push({ sobject: child.sobject, id: record.Id });
            }
          } catch (e) {
            // One unreadable child type must not cost the whole descent —
            // the same reasoning the SOQL net uses.
            console.warn(
              `Ancestry descent skipped ${child.sobject} under ${parentSobject}: ${e.message}`
            );
          }
        }
      }
    }

    frontier = next;
  }

  return { candidates: [...found.values()], indexRows };
}

/**
 * Confirms each candidate against the org before it can be deleted. A ledger
 * row alone is a claim; this is the check.
 *
 *  - stampable object     -> its own Description must still carry the marker
 *  - non-stampable object -> it must still exist, and where the ledger gives
 *                            it an ancestor chain, that chain must terminate
 *                            in a marked record
 *
 * Anything that fails is dropped with a reason, not deleted "just in case".
 */
async function verifyCandidates(admin, candidates, index) {
  const verified = [];
  const rejected = [];

  const bySobject = new Map();
  for (const candidate of candidates) {
    if (!bySobject.has(candidate.sobject)) bySobject.set(candidate.sobject, []);
    bySobject.get(candidate.sobject).push(candidate);
  }

  const markerCache = new Map(); // recordId -> boolean, memoises ancestor lookups

  for (const [sobject, list] of bySobject) {
    const field = DESCRIPTION_FIELD[sobject];
    const select = field ? `Id, ${field}` : 'Id';
    const live = new Map();

    for (const ids of chunk(list.map((c) => c.id))) {
      const soql = `SELECT ${select} FROM ${sobject} WHERE Id IN (${idList(ids)})`;
      try {
        for (const record of await admin.query(soql)) live.set(record.Id, record);
      } catch (e) {
        console.warn(`Verification query failed for ${sobject}: ${e.message}`);
      }
    }

    for (const candidate of list) {
      // Salesforce returns 18-char Ids; the ledger may hold either form.
      const record = live.get(candidate.id) || findByPrefix(live, candidate.id);
      if (!record) {
        rejected.push({ ...candidate, reason: 'already gone from the org' });
        continue;
      }
      candidate.id = record.Id;

      if (field) {
        const marked = String(record[field] || '').startsWith(MARKER_PREFIX);
        markerCache.set(record.Id, marked);
        if (!marked) {
          rejected.push({ ...candidate, reason: `no E2E marker in ${sobject}.${field}` });
          continue;
        }
        verified.push(candidate);
        continue;
      }

      // No Description to check — walk up to something that does have one.
      const ancestry = await ancestorIsMarked(admin, candidate, index, markerCache);
      if (ancestry === false) {
        rejected.push({ ...candidate, reason: 'ancestor record carries no E2E marker' });
        continue;
      }
      // null means the chain ran out before reaching anything stampable, or a
      // lookup along it failed. What that is allowed to imply depends entirely
      // on where the candidate came from:
      //
      //   ledger   — the sweepEligible row is itself the evidence, which is
      //              what the ledger is for on objects the platform gives us
      //              nowhere to stamp. Admit it.
      //   ancestry — there is no ledger row. The ONLY reason this record is a
      //              candidate is that a walk down from a marker reached it,
      //              so a walk back up that cannot confirm the marker leaves
      //              nothing behind it. Admitting it here would let a failed
      //              query widen the sweep, which is the one direction a
      //              failure must never move it.
      if (ancestry === null && candidate.source === 'ancestry') {
        rejected.push({ ...candidate, reason: 'could not confirm a marked ancestor' });
        continue;
      }
      verified.push(candidate);
    }
  }

  return { verified, rejected };
}

function findByPrefix(live, id) {
  const short = id.slice(0, 15);
  for (const [key, record] of live) {
    if (key.slice(0, 15) === short) return record;
  }
  return undefined;
}

// Returns true (marked ancestor found), false (ancestor exists but unmarked),
// or null (no ancestor chain to follow).
async function ancestorIsMarked(admin, candidate, index, cache, depth = 0) {
  if (depth > 5 || !candidate.parentId) return null;
  if (cache.has(candidate.parentId)) return cache.get(candidate.parentId);

  const parentRow = index.get(candidate.parentId);
  if (!parentRow) return null;

  const parentSobject = String(parentRow.sobject || '');
  const field = DESCRIPTION_FIELD[parentSobject];
  if (!field) {
    return ancestorIsMarked(
      admin,
      { parentId: String(parentRow.parentId || '') },
      index,
      cache,
      depth + 1
    );
  }

  try {
    const records = await admin.query(
      `SELECT Id, ${field} FROM ${parentSobject} WHERE Id = '${escapeSoql(candidate.parentId)}'`
    );
    const marked = !!records.length && String(records[0][field] || '').startsWith(MARKER_PREFIX);
    cache.set(candidate.parentId, marked);
    return marked;
  } catch (e) {
    console.warn(`Ancestor check failed for ${parentSobject} ${candidate.parentId}: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pre-delete unblocking
//
// Three platform behaviours that turn a clean sweep into a pile of
// unactionable DELETE_FAILED responses if you don't handle them first.
// ---------------------------------------------------------------------------
async function unblock(admin, plan, execute) {
  const quotes = plan.filter((c) => c.sobject === 'SBQQ__Quote__c').map((c) => c.id);
  const orders = plan.filter((c) => c.sobject === 'Order').map((c) => c.id);
  const contracts = plan.filter((c) => c.sobject === 'Contract').map((c) => c.id);

  const actions = [];

  // 1. A quote that is primary and synced to its Opportunity cannot be
  //    deleted. Clear the flag on the quote, then clear the Opportunity's
  //    SyncedQuoteId pointer.
  //    [VERIFY] The exact error text and whether both steps are required
  //    varies by CPQ package version — confirm against your org's version and
  //    trim this if one step suffices.
  for (const id of quotes) {
    actions.push({ label: `SBQQ__Quote__c ${id}: SBQQ__Primary__c -> false`, run: () => admin.patch('SBQQ__Quote__c', id, { SBQQ__Primary__c: false }) });
  }
  if (quotes.length) {
    for (const ids of chunk(quotes)) {
      try {
        const opps = await admin.query(
          `SELECT Id, SyncedQuoteId FROM Opportunity WHERE SyncedQuoteId IN (${idList(ids)})`
        );
        for (const opp of opps) {
          actions.push({
            label: `Opportunity ${opp.Id}: SyncedQuoteId -> null`,
            run: () => admin.patch('Opportunity', opp.Id, { SyncedQuoteId: null }),
          });
        }
      } catch (e) {
        // Opportunity.SyncedQuoteId only exists once CPQ's opportunity sync
        // is configured in the org; without it there is no sync pointer to
        // clear and nothing to do. Confirmed absent on this Developer org.
        if (/No such column 'SyncedQuoteId'|INVALID_FIELD/.test(e.message)) {
          console.log('  Opportunity.SyncedQuoteId not present in this org — no sync pointers to clear.');
        } else {
          console.warn(`Could not look up synced opportunities: ${e.message}`);
        }
      }
    }
  }

  // 2. Activated Orders and Contracts cannot be deleted, and an activated
  //    Order's OrderItems cannot be touched either — so this runs before any
  //    delete, not just before the Order delete.
  for (const id of orders) {
    actions.push({ label: `Order ${id}: Status -> Draft`, run: () => admin.patch('Order', id, { Status: 'Draft' }) });
  }
  for (const id of contracts) {
    actions.push({ label: `Contract ${id}: Status -> Draft`, run: () => admin.patch('Contract', id, { Status: 'Draft' }) });
  }

  if (!execute) return actions;

  for (const action of actions) {
    try {
      await action.run();
    } catch (e) {
      // A record that was never activated rejects the revert, and that's
      // fine — the delete will succeed anyway. Log and move on.
      console.warn(`  unblock skipped — ${action.label}: ${e.message}`);
    }
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Reporting and main
// ---------------------------------------------------------------------------

function printPlan(plan, rejected, unblockActions, { retentionDays, cutoff, dryRun, cascaded = [] }) {
  console.log('');
  console.log('='.repeat(72));
  console.log(`E2E sweep plan — env=${env.target}, retention=${retentionDays}d, cutoff=${cutoff.toISOString()}`);
  console.log('='.repeat(72));

  if (!plan.length) {
    console.log('Nothing to delete. (No verified candidates older than the cutoff.)');
  } else {
    for (const sobject of DELETE_ORDER) {
      const forObject = plan.filter((c) => c.sobject === sobject);
      if (!forObject.length) continue;
      console.log(`\n${sobject} — ${forObject.length} record(s)`);
      for (const candidate of forObject.slice(0, 20)) {
        console.log(`  ${candidate.id}  ${candidate.name || '(no name)'}  [${candidate.source}]  created ${candidate.createdAt}`);
      }
      if (forObject.length > 20) console.log(`  ... and ${forObject.length - 20} more`);
    }
  }

  if (cascaded.length) {
    const byObject = new Map();
    for (const c of cascaded) byObject.set(c.sobject, (byObject.get(c.sobject) || 0) + 1);
    console.log(`\nCovered by cascade — ${cascaded.length} record(s), no DELETE call needed`);
    for (const [sobject, count] of byObject) {
      console.log(`  ${count} x ${sobject} (removed with its ${CASCADE_PARENT[sobject]})`);
    }
  }

  if (unblockActions.length) {
    console.log(`\nPre-delete updates — ${unblockActions.length}`);
    for (const action of unblockActions.slice(0, 20)) console.log(`  ${action.label}`);
    if (unblockActions.length > 20) console.log(`  ... and ${unblockActions.length - 20} more`);
  }

  if (rejected.length) {
    console.log(`\nSkipped — ${rejected.length} candidate(s) failed verification`);
    const reasons = new Map();
    for (const r of rejected) reasons.set(r.reason, (reasons.get(r.reason) || 0) + 1);
    for (const [reason, count] of reasons) console.log(`  ${count} x ${reason}`);
  }

  console.log('');
  if (dryRun) {
    console.log('DRY RUN — nothing was deleted. Re-run with --confirm to execute.');
  }
}

function parseArgs(argv) {
  const args = new Set(argv);
  const retentionArg = argv.find((a) => a.startsWith('--retention-days='));
  const retentionDays = Number(
    (retentionArg && retentionArg.split('=')[1]) || process.env.RETENTION_DAYS || DEFAULT_RETENTION_DAYS
  );
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new Error(`Invalid retention days: ${retentionArg || process.env.RETENTION_DAYS}`);
  }
  // Deleting is opt-in. Anything other than an explicit --confirm is a dry run.
  return { confirm: args.has('--confirm'), retentionDays };
}

/**
 * Splits an ordered plan into records that need their own DELETE and records
 * a parent's master-detail cascade will remove anyway.
 *
 * A child is only skipped when its parent is present in the SAME plan. A child
 * whose parent is absent (or whose ledger row has no parentId, as SOQL-net
 * candidates do) is kept and deleted explicitly.
 *
 * @param {Array<{sobject: string, id: string, parentId?: string}>} ordered
 * @returns {{ plan: Array, cascaded: Array }}
 */
function splitCascadedChildren(ordered) {
  const idsBySobject = new Map();
  for (const candidate of ordered) {
    if (!idsBySobject.has(candidate.sobject)) idsBySobject.set(candidate.sobject, new Set());
    idsBySobject.get(candidate.sobject).add(String(candidate.id).slice(0, 15));
  }

  const cascaded = [];
  const plan = ordered.filter((candidate) => {
    const parentSobject = CASCADE_PARENT[candidate.sobject];
    if (!parentSobject || !candidate.parentId) return true;

    const parents = idsBySobject.get(parentSobject);
    if (parents && parents.has(String(candidate.parentId).slice(0, 15))) {
      cascaded.push(candidate);
      return false;
    }
    return true;
  });

  return { plan, cascaded };
}

function assertListsDisjoint() {
  const overlap = [...ALLOWLIST].filter((s) => DENYLIST.has(s));
  if (overlap.length) {
    throw new Error(
      `Refusing to run: ${overlap.join(', ')} appears in both the deletable allowlist and the ` +
        'protected denylist. One of the two lists is wrong — fix it before sweeping anything.'
    );
  }
}

/**
 * The descent map is a way of REACHING records, so a mistake in it widens what
 * the sweeper can delete without touching either list. Checked at startup for
 * the same reason the lists are: a typo here would otherwise surface as a
 * deletion, and only once.
 *
 * Every descent target must be on the allowlist and must have a name field, so
 * the plan can print what it is about to remove.
 */
function assertDescentIsAllowlisted() {
  const problems = [];

  for (const [parent, children] of Object.entries(CHILD_LOOKUP)) {
    for (const child of children) {
      if (DENYLIST.has(child.sobject)) {
        problems.push(`${parent} -> ${child.sobject} is on the protected denylist`);
      } else if (!ALLOWLIST.has(child.sobject)) {
        problems.push(`${parent} -> ${child.sobject} is not on the deletable allowlist`);
      }
      if (!NAME_FIELD[child.sobject]) {
        problems.push(`${child.sobject} has no NAME_FIELD entry`);
      }
    }
  }

  if (problems.length) {
    throw new Error(
      `Refusing to run: the ancestry descent map would reach records the sweeper must not ` +
        `delete or cannot name —\n  ${problems.join('\n  ')}`
    );
  }
}

async function main() {
  const { confirm, retentionDays } = parseArgs(process.argv.slice(2));
  assertListsDisjoint();
  assertDescentIsAllowlisted();

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const ledgerRows = readLedgerRows();
  console.log(`Read ${ledgerRows.length} ledger row(s).`);

  const admin = await OrgAdmin.connect();
  try {
    const { candidates: fromLedger, index } = ledgerCandidates(ledgerRows, cutoff);
    const fromSoql = await soqlNetCandidates(admin, cutoff);

    // Ancestry descent runs third because it needs somewhere to start: every
    // stampable candidate the first two sources produced is a potential
    // marked root. Seeding from candidates rather than from verified records
    // is deliberate — verification has not run yet, and an unmarked root is
    // harmless here, since its descendants are verified by walking back up to
    // that same root and get rejected when the marker is missing. Filtering
    // first would only save queries, at the cost of a second marker check
    // living somewhere other than verifyCandidates.
    const roots = [...fromLedger, ...fromSoql].filter((c) => DESCRIPTION_FIELD[c.sobject]);
    const { candidates: fromAncestry, indexRows } = await descendantCandidates(
      admin,
      roots,
      cutoff
    );
    for (const [recordId, row] of indexRows) {
      if (!index.has(recordId)) index.set(recordId, row);
    }

    // Union of three independently-verified sources, de-duplicated by Id. The
    // SOQL net exists precisely for records the ledger lost, and ancestry for
    // records neither can name, so intersecting them would defeat both;
    // instead every candidate from any source has to clear the same
    // verification below before it can be deleted. Nothing gets in on
    // provenance alone.
    const merged = new Map();
    for (const candidate of [...fromLedger, ...fromSoql, ...fromAncestry]) {
      const key = `${candidate.sobject}|${candidate.id.slice(0, 15)}`;
      if (!merged.has(key)) merged.set(key, candidate);
    }
    console.log(
      `Candidates: ${fromLedger.length} from ledger, ${fromSoql.length} from SOQL net, ` +
        `${fromAncestry.length} from ancestry, ${merged.size} unique.`
    );

    const { verified, rejected } = await verifyCandidates(admin, [...merged.values()], index);

    const ordered = [];
    for (const sobject of DELETE_ORDER) {
      ordered.push(...verified.filter((c) => c.sobject === sobject));
    }

    const { plan, cascaded } = splitCascadedChildren(ordered);

    const unblockActions = await unblock(admin, plan, confirm);
    printPlan(plan, rejected, unblockActions, {
      retentionDays,
      cutoff,
      dryRun: !confirm,
      cascaded,
    });

    if (!confirm) return;

    let deleted = 0;
    let alreadyGone = 0;
    let failed = 0;
    for (const candidate of plan) {
      try {
        const outcome = await admin.remove(candidate.sobject, candidate.id);
        if (outcome === 'already-gone') alreadyGone += 1;
        else deleted += 1;
      } catch (e) {
        failed += 1;
        console.warn(`  ${e.message}`);
      }
    }

    console.log(
      `\nDeleted ${deleted} record(s)` +
        (alreadyGone ? `, ${alreadyGone} already gone (cascade or an earlier run)` : '') +
        (cascaded.length ? `, ${cascaded.length} left to their parent's cascade` : '') +
        `, ${failed} failure(s).`
    );
  } finally {
    await admin.dispose();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`\nSweep aborted: ${e.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  ALLOWLIST,
  DENYLIST,
  DELETE_ORDER,
  CASCADE_PARENT,
  MARKER_PREFIX,
  DEFAULT_RETENTION_DAYS,
  splitCascadedChildren,
  OrgAdmin,
};
