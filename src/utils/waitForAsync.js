// src/utils/waitForAsync.js
//
// Polling helpers for CPQ's asynchronous side effects (record-triggered
// Flows, Apex queueables, CPQ's own async jobs).
//
// Poll the API, never the UI. A spinner disappearing tells you Lightning
// finished rendering; it tells you nothing about whether the Flow that
// creates Quote Line Groups has committed. The data model is the source of
// truth: act in the UI, assert in the API.
//
// Every iteration logs elapsed milliseconds, so a degrading org shows up as a
// visible climb in the run output instead of surfacing weeks later as an
// "intermittent" timeout nobody can reproduce.

// Escapes a value for safe interpolation into a SOQL string literal.
// Account names with apostrophes ("O'Brien Security") otherwise produce a
// MALFORMED_QUERY that reads like a framework bug.
function escapeSoql(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// SOQL datetime literals are unquoted ISO-8601 with a timezone offset.
function soqlDateTime(date) {
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Looks for Apex work that died during the polling window. A failed
// queueable with an ExtendedStatus of "System.DmlException: INSERT failed
// ... REQUIRED_FIELD_MISSING" is an actionable answer; "timed out after
// 120000ms" is not.
//
// Deliberately best-effort: if the running user can't read AsyncApexJob, or
// the query itself fails, we swallow it rather than masking the real timeout.
async function collectAsyncApexFailures(client, since) {
  const soql =
    'SELECT Id, JobType, Status, ExtendedStatus, NumberOfErrors, ApexClass.Name, CreatedDate ' +
    "FROM AsyncApexJob WHERE Status IN ('Failed','Aborted') " +
    `AND CreatedDate >= ${soqlDateTime(since)} ORDER BY CreatedDate DESC LIMIT 10`;
  try {
    const records = await client.query(soql);
    return Array.isArray(records) ? records : [];
  } catch (e) {
    return [{ ExtendedStatus: `(could not read AsyncApexJob: ${e.message})` }];
  }
}

function describeFailures(failures) {
  if (!failures.length) return 'No failed or aborted AsyncApexJob rows found in the run window.';
  const lines = failures.map((job) => {
    const name = (job.ApexClass && job.ApexClass.Name) || job.JobType || 'unknown job';
    return `  - ${name} [${job.Status || '?'}] errors=${job.NumberOfErrors ?? '?'}: ${job.ExtendedStatus || '(no ExtendedStatus)'}`;
  });
  return `Failed/aborted Apex jobs in the run window:\n${lines.join('\n')}`;
}

/**
 * Polls a SOQL query until it returns at least `expect` records.
 *
 * @param {object} client   SalesforceRestClient (anything with .query(soql))
 * @param {string} soql
 * @param {object} [opts]
 * @param {number} [opts.expect=1]        minimum row count to accept
 * @param {number} [opts.timeout=120000]  total budget in ms
 * @param {number} [opts.interval=5000]   delay between attempts in ms
 * @param {number} [opts.lookbackMs=600000] how far back to search AsyncApexJob on failure
 * @param {string} [opts.label]           what we're waiting for, for log lines
 * @returns {Promise<object[]>} the records from the first satisfying attempt
 */
async function pollForRecords(client, soql, opts = {}) {
  const {
    expect = 1,
    timeout = 120_000,
    interval = 5_000,
    lookbackMs = 600_000,
    label = 'records',
  } = opts;

  const startedAt = Date.now();
  let attempt = 0;
  let lastCount = 0;
  let lastError;

  while (Date.now() - startedAt < timeout) {
    attempt += 1;
    const elapsed = Date.now() - startedAt;
    try {
      const records = (await client.query(soql)) || [];
      lastCount = records.length;
      console.log(
        `[poll] ${label}: attempt ${attempt}, ${elapsed}ms elapsed, ${lastCount}/${expect} found`
      );
      if (lastCount >= expect) return records;
    } catch (e) {
      // A transient 500 from the org shouldn't end the poll; a genuine
      // MALFORMED_QUERY will simply repeat until the budget runs out and
      // then be reported with the SOQL, which is what makes it diagnosable.
      lastError = e;
      console.log(`[poll] ${label}: attempt ${attempt}, ${elapsed}ms elapsed, query error: ${e.message}`);
    }
    await sleep(interval);
  }

  const failures = await collectAsyncApexFailures(client, startedAt - lookbackMs);
  const totalElapsed = Date.now() - startedAt;
  throw new Error(
    [
      `Timed out after ${totalElapsed}ms waiting for ${expect} ${label} (last count: ${lastCount}).`,
      `SOQL: ${soql}`,
      lastError ? `Last query error: ${lastError.message}` : null,
      describeFailures(failures),
      'Zero rows can also mean a mistyped field or a filter that never matches — check the SOQL above before assuming the org is slow.',
    ]
      .filter(Boolean)
      .join('\n')
  );
}

/** Polls until the query returns exactly one record, and returns that record. */
async function pollForRecord(client, soql, opts = {}) {
  const records = await pollForRecords(client, soql, { ...opts, expect: 1 });
  if (records.length > 1) {
    throw new Error(
      `Expected exactly 1 record but found ${records.length}.\nSOQL: ${soql}\n` +
        'Tighten the filter — a journey that picks an arbitrary row here will fail unpredictably later.'
    );
  }
  return records[0];
}

/**
 * Polls a single record until one of its fields reaches the expected value.
 * Built for flag flips that a Flow or Apex trigger performs asynchronously,
 * e.g. SBQQ__Primary__c going true after the UI marks a quote primary.
 *
 * Comparison is loose-by-string so `true` matches the API's `true` and a
 * numeric field compares cleanly against a number written as text in a data
 * file.
 *
 * NOT USABLE ON Date OR DateTime FIELDS. The expected value goes through
 * formatSoqlValue(), which quotes strings — and SOQL rejects a quoted date
 * outright: "value of filter criterion for field '<field>' must be of type
 * date and should not be enclosed in quotes [INVALID_FIELD]". A date literal
 * is bare yyyy-mm-dd. Poll with pollForRecords() and interpolate the date
 * unquoted instead; src/flows/amendContract.js does exactly that.
 */
async function pollForFieldValue(client, sobject, id, field, expected, opts = {}) {
  const soql =
    `SELECT Id, ${field} FROM ${sobject} WHERE Id = '${escapeSoql(id)}' ` +
    `AND ${field} = ${formatSoqlValue(expected)}`;
  const record = await pollForRecord(client, soql, {
    label: `${sobject}.${field} === ${String(expected)}`,
    ...opts,
  });
  return record;
}

// Renders a JS value as a SOQL literal for the right-hand side of a filter.
//
// Strings are quoted, which makes this WRONG for Date and DateTime fields —
// see the note on pollForFieldValue(). Detecting a yyyy-mm-dd-shaped string
// and emitting it unquoted is deliberately NOT done here: it would silently
// change how a genuine text field containing "2027-07-01" is compared.
function formatSoqlValue(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return `'${escapeSoql(value)}'`;
}

module.exports = {
  pollForRecords,
  pollForRecord,
  pollForFieldValue,
  escapeSoql,
  soqlDateTime,
  formatSoqlValue,
};
