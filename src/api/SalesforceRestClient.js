// src/api/SalesforceRestClient.js
//
// Thin wrapper around the Salesforce REST API (create/query/delete a
// single sObject). CpqDataFactory builds on top of this for CPQ-specific
// setup/teardown; nothing here knows about Account/Opportunity/Quote
// specifically.
const { request } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const env = require('../config/env');

// Reads the token global-setup.js wrote after authenticating, so every test
// (and every worker) reuses the same session instead of re-authenticating.
function loadSession() {
  const file = path.join(__dirname, '..', '..', '.auth', 'sf-session.json');
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

class SalesforceRestClient {
  constructor(session) {
    // Accepts an explicit session for testability, but in practice every
    // caller relies on the default (loadSession() from disk).
    this.session = session || loadSession();
  }

  // Lazily creates and caches the underlying Playwright request context, so
  // a client that's constructed but never used doesn't open a connection.
  async ctx() {
    if (!this._ctx) {
      this._ctx = await request.newContext({
        baseURL: this.session.instanceUrl,
        extraHTTPHeaders: {
          Authorization: `Bearer ${this.session.accessToken}`,
          'Content-Type': 'application/json',
        },
      });
    }
    return this._ctx;
  }

  // POST /sobjects/<sobject> — returns the new record's Id.
  async create(sobject, payload) {
    const res = await (await this.ctx()).post(
      `/services/data/${env.apiVersion}/sobjects/${sobject}`,
      { data: payload }
    );
    if (!res.ok()) throw new Error(`Create ${sobject} failed: ${await res.text()}`);
    return (await res.json()).id;
  }

  // PATCH /sobjects/<sobject>/<id> — updates fields on an existing record.
  //
  // Returns nothing: a successful Salesforce update replies 204 No Content,
  // so there is no body to parse and no Id to hand back.
  //
  // The status is in the thrown message because the two failures that actually
  // happen here are told apart by it and not by the body: a 400 is a bad field
  // or a validation rule, a 403/404 is the record being locked or invisible to
  // the running user (an activated Order rejects field edits this way).
  async patch(sobject, id, payload) {
    const res = await (await this.ctx()).patch(
      `/services/data/${env.apiVersion}/sobjects/${sobject}/${id}`,
      { data: payload }
    );
    if (!res.ok()) {
      throw new Error(`Update ${sobject} ${id} failed (${res.status()}): ${await res.text()}`);
    }
  }

  // GET /query — runs a raw SOQL string and returns the record array.
  //
  // The res.ok() check is not optional. Without it a rejected query (a
  // mistyped field, say) returns an error array whose `.records` is undefined,
  // so the caller silently receives `undefined` instead of an error — which
  // reads as "no rows" and makes a broken query look like a passing check.
  // That is exactly how SBQQ__NetTotal__c, which does not exist on
  // SBQQ__Quote__c, was reported as a valid field.
  async query(soql) {
    const res = await (await this.ctx()).get(
      `/services/data/${env.apiVersion}/query`,
      { params: { q: soql } }
    );
    if (!res.ok()) {
      throw new Error(`Query failed (${res.status()}): ${await res.text()}\nSOQL: ${soql}`);
    }
    return (await res.json()).records || [];
  }

  // DELETE /sobjects/<sobject>/<id> — used by CpqDataFactory.cleanup() to
  // tear down everything a test created.
  async remove(sobject, id) {
    console.log(`Deleting ${sobject} ${id}`);
    await (await this.ctx()).delete(
      `/services/data/${env.apiVersion}/sobjects/${sobject}/${id}`
    );
  }

  // Releases the underlying request context. Call once the client is no
  // longer needed (CpqDataFactory does this at the end of cleanup()).
  async dispose() {
    if (this._ctx) await this._ctx.dispose();
  }
}

module.exports = { SalesforceRestClient };
