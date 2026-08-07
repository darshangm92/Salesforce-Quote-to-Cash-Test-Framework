// scripts/extract-contract.js
//
// Dumps every field of a Contract and of its related SBQQ__Subscription__c
// records into an .xlsx, as reference material for building records through
// the API — the amendment scenarios need a contract and subscriptions that
// look like a real CPQ-generated set, and "what does a real one actually
// hold" is otherwise a lot of clicking through page layouts that hide
// exactly the fields that matter.
//
// Standalone and read-only. It authenticates on its own rather than reading
// .auth/sf-session.json, so it works without a preceding test run, and it
// never creates, updates or deletes anything.
//
//   npm run extract:contract -- 00000100
//   npm run extract:contract -- 00000100 --out=data/my-extract.xlsx
//   npm run extract:contract -- 00000100 --subscriptions-only
//
// Output defaults to data/contract-<number>-extract.xlsx.
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { request } = require('@playwright/test');
const { authenticate } = require('../src/api/SalesforceAuth');
const env = require('../src/config/env');

const CONTRACT_OBJECT = 'Contract';
const SUBSCRIPTION_OBJECT = 'SBQQ__Subscription__c';

// Compound fields (Address, Location) have no scalar SOQL representation —
// their components are separate fields and are extracted individually, so
// selecting the compound itself only earns a MALFORMED_QUERY.
const UNQUERYABLE_TYPES = new Set(['address', 'location']);

// SOQL chunk size for the field sweep. Contract has ~70 fields and
// SBQQ__Subscription__c ~90, so this is really a guard for objects that have
// grown past what fits in one GET query string.
const FIELD_CHUNK = 100;

// A lookup's Id tells a scenario author nothing about WHICH record it points
// at, so every populated reference is resolved to a name. Not every object
// has a Name field, hence the candidate list.
const NAME_FIELD_CANDIDATES = ['Name', 'Subject', 'CaseNumber'];

let ctx;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      flags[key] = value === undefined ? true : value;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function api(pathname, params) {
  const res = await ctx.get(pathname, params ? { params } : undefined);
  if (!res.ok()) {
    throw new Error(`GET ${pathname} failed (${res.status()}): ${await res.text()}`);
  }
  return res.json();
}

function describe(sobject) {
  return api(`/services/data/${env.apiVersion}/sobjects/${sobject}/describe`);
}

// Follows nextRecordsUrl, so a contract with more subscriptions than one
// batch holds still comes back whole.
async function query(soql) {
  let result = await api(`/services/data/${env.apiVersion}/query`, { q: soql });
  const records = result.records || [];
  while (result.nextRecordsUrl) {
    result = await api(result.nextRecordsUrl);
    records.push(...(result.records || []));
  }
  return records;
}

// Sweeps every field in chunks and merges the results by Id.
//
// The per-field fallback matters more than the chunking: a single field the
// running user cannot see, or that the managed package exposes in describe
// but not in SOQL, would otherwise take out the whole extraction. Falling
// back costs one field instead, and says which one on the way past.
async function queryAllFields(sobject, fieldNames, whereClause) {
  const byId = new Map();

  const absorb = (rows) => {
    for (const row of rows) {
      const existing = byId.get(row.Id) || { Id: row.Id };
      for (const [key, value] of Object.entries(row)) {
        if (key !== 'attributes') existing[key] = value;
      }
      byId.set(row.Id, existing);
    }
  };

  for (let i = 0; i < fieldNames.length; i += FIELD_CHUNK) {
    const chunk = fieldNames.slice(i, i + FIELD_CHUNK);
    const select = ['Id', ...chunk.filter((f) => f !== 'Id')].join(', ');
    try {
      absorb(await query(`SELECT ${select} FROM ${sobject} WHERE ${whereClause}`));
    } catch (e) {
      console.warn(`  chunk ${i}-${i + chunk.length} failed, retrying field by field`);
      for (const field of chunk) {
        try {
          absorb(await query(`SELECT Id, ${field} FROM ${sobject} WHERE ${whereClause}`));
        } catch (inner) {
          console.warn(`  skipped ${sobject}.${field}: ${String(inner.message).slice(0, 120)}`);
        }
      }
    }
  }

  return [...byId.values()];
}

async function resolveReferenceNames(describeResult, records) {
  // Polymorphic lookups (OwnerId on some objects, WhatId, ...) list several
  // referenceTo entries and can't be resolved from the Id alone, so only
  // single-target references are followed.
  const refFields = describeResult.fields.filter(
    (f) => f.type === 'reference' && f.referenceTo && f.referenceTo.length === 1
  );

  const wanted = new Map(); // sobject -> Set(id)
  for (const field of refFields) {
    for (const record of records) {
      const value = record[field.name];
      if (!value) continue;
      const target = field.referenceTo[0];
      if (!wanted.has(target)) wanted.set(target, new Set());
      wanted.get(target).add(value);
    }
  }

  const names = new Map(); // id -> name
  for (const [sobject, ids] of wanted) {
    const idList = [...ids].map((id) => `'${id}'`).join(', ');
    for (const nameField of NAME_FIELD_CANDIDATES) {
      try {
        const rows = await query(`SELECT Id, ${nameField} FROM ${sobject} WHERE Id IN (${idList})`);
        for (const row of rows) names.set(row.Id, row[nameField]);
        break;
      } catch (e) {
        // Try the next candidate; an object with none of them (OrderItem,
        // PricebookEntry on some orgs) simply goes unnamed, which is a
        // cosmetic loss and not worth failing the extraction over.
      }
    }
  }
  return names;
}

function formatValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

// Picklist values are here because a record only ever shows the ONE value it
// happens to hold, and a scenario author building a variant needs to know
// what else is on offer. label=value only when they differ — a picklist's
// DISPLAYED LABEL is not its STORED VALUE, and passing the stored value to a
// label-based select fails with an opaque "did not find some options" timeout.
function picklistSummary(field) {
  if (!field.picklistValues || !field.picklistValues.length) return '';
  return field.picklistValues
    .filter((p) => p.active)
    .map((p) => (p.label === p.value ? p.value : `${p.label}=${p.value}`))
    .join(' | ');
}

function fieldMeta(field) {
  return {
    'Field API Name': field.name,
    Label: field.label,
    Type: field.type,
    Length: field.length || '',
    'Custom?': field.custom ? 'Yes' : 'No',
    Createable: field.createable ? 'Yes' : 'No',
    Updateable: field.updateable ? 'Yes' : 'No',
    // Nillable=false alone over-reports: a field with a default is not
    // something the caller has to supply.
    'Required on create':
      !field.nillable && field.createable && !field.defaultedOnCreate ? 'Yes' : 'No',
    Calculated: field.calculated ? 'Yes' : 'No',
    'Reference To': (field.referenceTo || []).join(', '),
    'Relationship Name': field.relationshipName || '',
    'Picklist Values': picklistSummary(field),
  };
}

// Fields as ROWS, records as COLUMNS. With ~90 fields and a handful of
// records the transpose is unreadable — you would be scrolling sideways
// past 90 columns to compare two subscriptions. This way the metadata
// columns stay pinned on the left and each record is one column to the
// right of them.
function buildFieldSheet(describeResult, records, referenceNames, recordLabel) {
  const rows = [];
  const fields = [...describeResult.fields].sort((a, b) => {
    // Id first, then standard fields, then custom — so the CPQ managed-package
    // fields cluster together instead of interleaving alphabetically with the
    // platform ones.
    const rank = (f) => (f.name === 'Id' ? 0 : f.custom ? 2 : 1);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });

  for (const field of fields) {
    if (UNQUERYABLE_TYPES.has(field.type)) continue;
    const row = fieldMeta(field);
    records.forEach((record, i) => {
      const label = recordLabel(record, i);
      row[label] = formatValue(record[field.name]);
      if (field.type === 'reference') {
        const value = record[field.name];
        row[`${label} (name)`] = (value && referenceNames.get(value)) || '';
      }
    });
    rows.push(row);
  }
  return rows;
}

// Record per row, populated fields only — the shape you actually paste into
// an API payload, as opposed to the field-per-row view which is for reading.
function buildFlatSheet(describeResult, records) {
  const populated = records.map((record) => {
    const out = {};
    for (const field of describeResult.fields) {
      if (UNQUERYABLE_TYPES.has(field.type)) continue;
      const value = record[field.name];
      if (value !== null && value !== undefined && value !== '') {
        out[field.name] = formatValue(value);
      }
    }
    return out;
  });
  if (!populated.length) return [];
  // Union of keys, so json_to_sheet emits every column any record has rather
  // than only the ones the first record happens to populate.
  const allKeys = [...new Set(populated.flatMap((r) => Object.keys(r)))];
  return populated.map((r) => Object.fromEntries(allKeys.map((k) => [k, r[k] ?? ''])));
}

function autoWidth(rows) {
  if (!rows.length) return [];
  return Object.keys(rows[0]).map((key) => {
    const longest = rows.reduce((max, r) => Math.max(max, String(r[key] ?? '').length), key.length);
    return { wch: Math.min(Math.max(longest + 2, 10), 60) };
  });
}

function appendSheet(workbook, name, rows) {
  const sheet = XLSX.utils.json_to_sheet(rows);
  sheet['!cols'] = autoWidth(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, name);
}

/**
 * @param {object} opts
 * @param {string} opts.contractNumber Contract.ContractNumber to extract
 * @param {string} [opts.outFile] destination .xlsx
 * @param {boolean} [opts.subscriptionsOnly] skip the Contract sheet
 * @returns {Promise<{ outFile: string, contractId: string, subscriptions: number }>}
 */
async function extractContract({ contractNumber, outFile, subscriptionsOnly = false }) {
  const { accessToken, instanceUrl } = await authenticate();
  console.log(`Authenticated to ${instanceUrl} as ${env.username} (${env.target})`);

  ctx = await request.newContext({
    baseURL: instanceUrl,
    extraHTTPHeaders: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  try {
    console.log(`Describing ${CONTRACT_OBJECT}...`);
    const contractDescribe = await describe(CONTRACT_OBJECT);
    const contractFields = contractDescribe.fields
      .filter((f) => !UNQUERYABLE_TYPES.has(f.type))
      .map((f) => f.name);
    console.log(`  ${contractFields.length} queryable fields`);

    const contracts = await queryAllFields(
      CONTRACT_OBJECT,
      contractFields,
      `ContractNumber = '${contractNumber}'`
    );
    if (!contracts.length) {
      throw new Error(`No Contract found with ContractNumber = '${contractNumber}'`);
    }
    const contract = contracts[0];
    console.log(`  Contract ${contractNumber} = ${contract.Id}`);
    const contractRefNames = await resolveReferenceNames(contractDescribe, contracts);

    console.log(`Describing ${SUBSCRIPTION_OBJECT}...`);
    const subDescribe = await describe(SUBSCRIPTION_OBJECT);
    const subFields = subDescribe.fields
      .filter((f) => !UNQUERYABLE_TYPES.has(f.type))
      .map((f) => f.name);
    console.log(`  ${subFields.length} queryable fields`);

    const subscriptions = await queryAllFields(
      SUBSCRIPTION_OBJECT,
      subFields,
      `SBQQ__Contract__c = '${contract.Id}'`
    );
    console.log(`  ${subscriptions.length} subscription(s)`);
    const subRefNames = await resolveReferenceNames(subDescribe, subscriptions);

    // No ContractLineItem sheet, deliberately: that object is a child of
    // ServiceContract and has no ContractId field at all, so every query
    // against it fails. A CPQ contract's lines ARE its subscriptions.

    const workbook = XLSX.utils.book_new();

    const named = (id) => `${id || ''} ${contractRefNames.get(id) || ''}`.trim();
    appendSheet(workbook, 'Summary', [
      { Item: 'Contract Number', Value: contractNumber },
      { Item: 'Contract Id', Value: contract.Id },
      { Item: 'Org', Value: instanceUrl },
      { Item: 'SF_ENV', Value: env.target },
      { Item: 'API Version', Value: env.apiVersion },
      { Item: 'Extracted At', Value: new Date().toISOString() },
      { Item: 'Account', Value: named(contract.AccountId) },
      { Item: 'Opportunity (SBQQ__Opportunity__c)', Value: named(contract.SBQQ__Opportunity__c) },
      { Item: 'Quote (SBQQ__Quote__c)', Value: named(contract.SBQQ__Quote__c) },
      { Item: 'Order (SBQQ__Order__c)', Value: named(contract.SBQQ__Order__c) },
      { Item: 'Status', Value: contract.Status || '' },
      { Item: 'StartDate', Value: contract.StartDate || '' },
      { Item: 'EndDate', Value: contract.EndDate || '' },
      { Item: 'ContractTerm (months)', Value: contract.ContractTerm ?? '' },
      { Item: 'Contract fields extracted', Value: contractDescribe.fields.length },
      { Item: 'Subscription fields extracted', Value: subDescribe.fields.length },
      { Item: 'Subscription records', Value: subscriptions.length },
    ]);

    if (!subscriptionsOnly) {
      appendSheet(
        workbook,
        'Contract',
        buildFieldSheet(contractDescribe, contracts, contractRefNames, () => 'Value')
      );
    }

    appendSheet(
      workbook,
      'Subscriptions',
      buildFieldSheet(subDescribe, subscriptions, subRefNames, (record, i) => {
        const product = subRefNames.get(record.SBQQ__Product__c);
        return `${i + 1}. ${record.Name || record.Id}${product ? ` (${product})` : ''}`;
      })
    );

    const flat = buildFlatSheet(subDescribe, subscriptions);
    if (flat.length) appendSheet(workbook, 'Subscriptions (flat)', flat);

    // What the API will actually accept on insert, with this record's value
    // beside it — the sheet you work from when writing the seed payloads.
    const createable = [];
    for (const [label, describeResult] of [
      [CONTRACT_OBJECT, contractDescribe],
      [SUBSCRIPTION_OBJECT, subDescribe],
    ]) {
      for (const field of describeResult.fields) {
        if (!field.createable) continue;
        createable.push({
          Object: label,
          ...fieldMeta(field),
          'Value on this record':
            label === CONTRACT_OBJECT
              ? formatValue(contract[field.name])
              : subscriptions
                  .map((s) => formatValue(s[field.name]))
                  .filter((v) => v !== '')
                  .join(' ; '),
        });
      }
    }
    appendSheet(workbook, 'Createable Fields', createable);

    const destination =
      outFile || path.join(__dirname, '..', 'data', `contract-${contractNumber}-extract.xlsx`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    XLSX.writeFile(workbook, destination);

    console.log(`\nWrote ${destination}`);
    console.log(`Sheets: ${workbook.SheetNames.join(', ')}`);

    return { outFile: destination, contractId: contract.Id, subscriptions: subscriptions.length };
  } finally {
    if (ctx) {
      await ctx.dispose();
      ctx = undefined;
    }
  }
}

if (require.main === module) {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const contractNumber = positional[0] || flags.contract;

  if (!contractNumber) {
    console.error(
      'Usage: npm run extract:contract -- <contractNumber> [--out=<file.xlsx>] [--subscriptions-only]'
    );
    process.exit(1);
  }

  extractContract({
    contractNumber: String(contractNumber),
    outFile: typeof flags.out === 'string' ? flags.out : undefined,
    subscriptionsOnly: !!flags['subscriptions-only'],
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { extractContract };
