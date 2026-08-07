// src/utils/pricingData.js
//
// Reading data/pricing-rules.json safely: account resolution, placeholder
// guards, product lookup, and money comparison.
//
// One module rather than four, because all of it answers the same question —
// "is this data-file value usable, and if not, what exactly is missing?" The
// specs in tests/pricing/ are otherwise eight copies of the same twenty lines.
//
// WHY PLACEHOLDERS ARE ENFORCED RATHER THAN TOLERATED
// ---------------------------------------------------
// README Section 10 says an unknown value ships as an explicit placeholder,
// never a plausible-looking number. That is only worth anything if reading one
// FAILS. A helper that silently skipped an unresolved expectation would turn
// "nobody has confirmed this price yet" into a green test — which is the exact
// thing the placeholder convention exists to make impossible.
const { escapeSoql } = require('./waitForAsync');

// What an unresolved value looks like in data/*.json.
const PLACEHOLDER_PREFIX = /^\s*(\[SPECIFY\]|PLACEHOLDER)/i;

/** True when a data-file value is still an unfilled placeholder. */
function isPlaceholder(value) {
  if (typeof value === 'number') return false;
  if (typeof value !== 'string') return true;
  return !value.trim() || PLACEHOLDER_PREFIX.test(value);
}

// The data file these guards report against when a caller does not say.
//
// A DEFAULT RATHER THAN A REQUIRED ARGUMENT, DELIBERATELY. Every existing call
// site reads data/pricing-rules.json, so making the file an argument everywhere
// would be eleven mechanical edits for no behaviour change — and each one a
// chance to name the wrong file in an error message, which is precisely the
// thing these guards exist to get right. Callers reading any OTHER data file
// pass their own; tests/pricing-methods/ reads data/pricing-methods.json.
const DEFAULT_SOURCE = 'data/pricing-rules.json';

/**
 * Returns a data-file number, or throws naming the exact path that is unfilled.
 *
 * @param {*} value  the data-file value
 * @param {string} path  dotted path into the data file, for the error
 * @param {string} [source]  which data file `path` is a path into
 */
function requireNumber(value, path, source = DEFAULT_SOURCE) {
  if (isPlaceholder(value)) {
    throw new Error(
      `${source} ${path} is still an unresolved placeholder:\n` +
        `  ${typeof value === 'string' ? value : JSON.stringify(value)}\n` +
        'Confirm the value against the org and fill it in. It is deliberately not defaulted — ' +
        'a guessed number that looks plausible hides that the scenario was never validated ' +
        '(README Section 10).'
    );
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${source} ${path} is not a number: ${JSON.stringify(value)}`);
  }
  return number;
}

/** Returns a data-file string, or throws naming the exact path that is unfilled. */
function requireString(value, path, source = DEFAULT_SOURCE) {
  if (isPlaceholder(value)) {
    throw new Error(
      `${source} ${path} is still an unresolved placeholder:\n` +
        `  ${typeof value === 'string' ? value : JSON.stringify(value)}\n` +
        'Fill it in from the org before running this scenario.'
    );
  }
  return String(value);
}

/**
 * One product entry, with its code and name checked.
 *
 * Both are required and for different reasons: the selection screen SEARCHES
 * by name, and every quote line is ADDRESSED by SBQQ__ProductCode__c. Names
 * are not unique — searching "Warranty" returns three products whose names all
 * contain the word — so a name-addressed line is a line that can silently be
 * the wrong one.
 *
 * @param {object} data  the loaded data file
 * @param {string} key   a key under `products`
 * @param {string} [source]  which data file `data` was loaded from
 */
function product(data, key, source = DEFAULT_SOURCE) {
  const entry = data.products && data.products[key];
  if (!entry) {
    throw new Error(
      `${source} has no product named "${key}". ` +
        `Products present: ${Object.keys(data.products || {}).join(', ') || '(none)'}`
    );
  }
  return {
    key,
    name: requireString(entry.name, `products.${key}.name`, source),
    productCode: requireString(entry.productCode, `products.${key}.productCode`, source),
    // Left raw: the pre-rule price feeds a light selection-screen spot-check,
    // not a record assertion, so an unresolved one degrades that one check
    // rather than failing the scenario. Callers gate on isPlaceholder().
    pricebookPrice: entry.pricebookPrice,
  };
}

/**
 * Money comparison, numeric and tolerant.
 *
 * Currency fields come back from the REST API as JSON numbers, and two decimal
 * places of currency are not exactly representable in binary floating point —
 * so `expect(listPrice).toBe(60)` can fail on a value that is 60 to every
 * decimal place anyone cares about. A cent of tolerance removes that without
 * being loose enough to hide a real pricing difference: no price rule in these
 * scenarios moves a price by less than a dollar.
 *
 * Never compares formatted strings. "$1,200.00" tells you the DOM rendered;
 * the field value tells you the quote is right.
 */
const MONEY_TOLERANCE = 0.01;

/** Absolute difference within a cent. */
function moneyEquals(actual, expected) {
  return Math.abs(Number(actual) - Number(expected)) <= MONEY_TOLERANCE;
}

/**
 * Resolves one data-file account entry to a concrete Account name.
 *
 * TWO RESOLUTION RULES, AND THE DISTINCTION IS NOT COSMETIC.
 * Where a scenario NAMES an Account, the rule under test is keyed to that
 * specific record and the name is a literal. Where a scenario only DESCRIBES
 * one ("an account with fewer than 50 employees"), hardcoding a name records
 * an org's sample data as if it were a requirement — and the next admin edit
 * breaks it silently: the test still runs, the rule no longer matches, and the
 * failure reads as a pricing defect rather than as stale data.
 *
 * NEVER FALLS BACK. A predicate matching nothing throws, naming the predicate
 * and what the scenario needed. Quoting against an arbitrary Account instead
 * would produce a run that proved nothing.
 *
 * @param {object} sf  the read-only `sf` fixture
 * @param {object} entry  an `accounts` entry from data/pricing-rules.json
 * @param {string} [label]  the entry's key, for log lines and errors
 */
async function resolveAccount(sf, entry, label = 'account') {
  if (!entry) throw new Error(`No account entry named "${label}" in data/pricing-rules.json.`);

  const describe = (account, how) => {
    console.log(
      `[account] ${label}: "${account.Name}" (${account.Id}), Industry=${account.Industry}, ` +
        `NumberOfEmployees=${account.NumberOfEmployees} — resolved by ${how}.`
    );
    return {
      id: account.Id,
      name: account.Name,
      industry: account.Industry,
      employees: account.NumberOfEmployees,
      resolvedBy: how,
    };
  };

  // A filled name wins outright. That is what lets someone pin a scenario to a
  // known record after a run has logged which one the predicate chose.
  if (!isPlaceholder(entry.name)) {
    const [account] = await sf.query(
      'SELECT Id, Name, Industry, NumberOfEmployees FROM Account ' +
        `WHERE Name = '${escapeSoql(entry.name)}' LIMIT 1`
    );
    if (!account) {
      throw new Error(
        `Account "${entry.name}" (data/pricing-rules.json accounts.${label}) was not found in ` +
          'this org. This suite looks accounts up and never creates them — create it by ' +
          'hand, or point the entry at one that exists.'
      );
    }
    return describe(account, 'name');
  }

  if (isPlaceholder(entry.predicate)) {
    throw new Error(
      `data/pricing-rules.json accounts.${label} has neither a filled name nor a predicate.\n` +
        `  The scenario needs: ${entry.needs || '(not recorded)'}\n` +
        'Fill one of the two. Letting the suite pick an arbitrary Account would make the ' +
        'scenario pass while testing something else.'
    );
  }

  const soql =
    'SELECT Id, Name, Industry, NumberOfEmployees FROM Account ' +
    `WHERE ${entry.predicate} ORDER BY Name LIMIT 1`;
  const [account] = await sf.query(soql);

  if (!account) {
    throw new Error(
      `No Account satisfies the predicate for accounts.${label}.\n` +
        `  Predicate: ${entry.predicate}\n` +
        `  The scenario needs: ${entry.needs || '(not recorded)'}\n` +
        'Create or edit an Account so one matches, then re-run.'
    );
  }
  return describe(account, 'predicate');
}

// CONFIRMED on 2026-08-01: these ARE formula fields on SBQQ__Quote__c.
// --------------------------------------------------------------------
//   AccountIndustry__c = TEXT(SBQQ__Account__r.Industry)
//   AccountSLA__c      = TEXT(SBQQ__Account__r.SLA__c)
//
// So they populate themselves on a quote seeded over REST and cannot be
// written — which is what the original [VERIFY] was worried about, and it is
// resolved. The check below survives because the OTHER half of the worry is
// real: a formula over an empty Account field is still empty, and an empty
// Industry makes an industry-conditioned rule silently fail to match. A
// failure that names the field beats one that names a number.
//
// CALLERS MUST PASS THE FIELDS THEIR SCENARIO ACTUALLY NEEDS.
// The default is Industry alone, deliberately. Requiring SLA everywhere was
// measured to be wrong: Kevco Inc. has Account.SLA__c EMPTY, and that emptiness
// is load-bearing for Scenario 1 rather than a problem with it — it is
// precisely why the Lookup Netbook Price rule cannot collide with the Education
// rule on that account (no IndustryPrice__c row can match an empty SLA). A
// blanket check therefore failed the one scenario whose correctness depends on
// the field being blank.
const QUOTE_CONTEXT_FIELDS = ['AccountIndustry__c'];

/** Everything the Industry + SLA lookup needs. For Scenario 6. */
const QUOTE_LOOKUP_FIELDS = ['AccountIndustry__c', 'AccountSLA__c'];

/**
 * Reads the quote's Account-context fields and throws if any is blank.
 *
 * @param {object} sf  the read-only `sf` fixture
 * @param {string} quoteId
 * @param {string[]} [fields]  the fields THIS scenario's rule reads
 * @returns {Promise<object>} the field values, for logging
 */
async function assertQuoteContextPopulated(sf, quoteId, fields = QUOTE_CONTEXT_FIELDS) {
  let quote;
  try {
    quote = await sf.record('SBQQ__Quote__c', quoteId, ['Id', ...fields]);
  } catch (e) {
    throw new Error(
      `Could not read ${fields.join(', ')} from SBQQ__Quote__c ${quoteId}: ${e.message}\n` +
        'If the error names an invalid field, this org spells these differently — find the real ' +
        'API names of the quote fields the Industry/SLA price rules read, and update ' +
        'QUOTE_CONTEXT_FIELDS in src/utils/pricingData.js. Do not drop the check: without it an ' +
        'empty Industry looks exactly like a rule that stopped firing.'
    );
  }

  const blank = fields.filter((f) => quote[f] === null || quote[f] === undefined || quote[f] === '');
  if (blank.length) {
    throw new Error(
      `SBQQ__Quote__c ${quoteId} has ${blank.join(' and ')} empty after seeding. The ` +
        'Industry-conditioned price rules read these, so nothing downstream of here can fire and ' +
        'a price assertion would report the wrong cause. If these are formula fields this should ' +
        'be impossible and the Account itself is missing the value; if they are writable fields, ' +
        'they have to be seeded on the quote.\n' +
        `  Read back: ${JSON.stringify(quote)}`
    );
  }

  console.log(`[quote context] ${quoteId}: ${fields.map((f) => `${f}=${quote[f]}`).join(', ')}`);
  return quote;
}

/**
 * A product's price book price, read from the org rather than written down.
 *
 * This is the base a price rule computes FROM, so comparing
 * SBQQ__OriginalPrice__c against it is the relationship half of an assertion —
 * the half that catches a rule working off the wrong base, which a literal
 * expected price alone will miss the moment the price book changes.
 *
 * Read live rather than stored in the data file on purpose: a hardcoded copy
 * of the price book is a second source of truth that drifts silently.
 */
async function pricebookUnitPrice(sf, pricebookId, productCode) {
  const [entry] = await sf.query(
    'SELECT UnitPrice, Product2.Name FROM PricebookEntry ' +
      `WHERE Pricebook2Id = '${escapeSoql(pricebookId)}' ` +
      `AND Product2.ProductCode = '${escapeSoql(productCode)}' AND IsActive = true LIMIT 1`
  );
  if (!entry) {
    throw new Error(
      `No active PricebookEntry for product code "${productCode}" in price book ${pricebookId}. ` +
        'The product cannot be quoted from this book at all, so the scenario could never have ' +
        'added it — check the code in data/pricing-rules.json against the org.'
    );
  }
  return Number(entry.UnitPrice);
}

/** yyyy-mm-dd, the format Salesforce Date fields use over REST. */
function isoDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A Date `days` from now, for Opportunity close dates that must not be in the past. */
function plusDays(days, from = new Date()) {
  const date = new Date(from);
  date.setDate(date.getDate() + days);
  return date;
}

module.exports = {
  isPlaceholder,
  requireNumber,
  requireString,
  product,
  moneyEquals,
  MONEY_TOLERANCE,
  resolveAccount,
  assertQuoteContextPopulated,
  pricebookUnitPrice,
  QUOTE_CONTEXT_FIELDS,
  QUOTE_LOOKUP_FIELDS,
  isoDate,
  plusDays,
};
