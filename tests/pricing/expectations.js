// tests/pricing/expectations.js
//
// The assertion vocabulary every spec in this folder shares. Not a spec — a
// sibling module, the same shape as tests/journeys/subscription-stages.js.
//
// It lives here rather than in src/utils/ because it imports `expect`. A util
// under src/ is required by page classes and flows, which have no business
// depending on the test framework; an assertion helper is test-only by
// definition and belongs on the tests/ side of that line.
//
// WHY THESE AND NOTHING ELSE
// --------------------------
// Each one encodes a rule that is easy to get wrong in a way that still
// passes: comparing money as a string, treating a rendered value as proof of a
// record's state, parsing a number out of a grid whose column order is not a
// contract, or coercing an empty cell to zero. Anything that is merely
// repetitive stays in the specs, where it is readable.
//
// It is shared beyond tests/pricing/. tests/pricing-methods/ imports
// expectDisplayedMoney() from here rather than growing a second copy, which is
// why the module stays put — moving it to a neutral folder would be a rename
// touching eight passing specs to make one import read better.
const { expect } = require('../../src/fixtures/cpqFixtures');
const { moneyEquals, isPlaceholder, MONEY_TOLERANCE } = require('../../src/utils/pricingData');

/**
 * Numeric money comparison with a cent of tolerance.
 *
 * Never a string comparison and never strict float equality. Two decimal
 * places of currency are not exactly representable in binary floating point,
 * so `toBe(60)` can fail on a value that is 60 to every decimal place anyone
 * cares about — and a formatted "$60.00" tells you the DOM rendered, not that
 * the quote is right. A cent is far tighter than
 * any rule in these scenarios moves a price, so it hides nothing real.
 */
function expectMoney(actual, expected, what) {
  expect(
    moneyEquals(actual, expected),
    `${what}: expected ${expected}, got ${actual} (tolerance ${MONEY_TOLERANCE})`
  ).toBe(true);
}

/** The inverse, for negatives that must prove a price is NOT the rule's price. */
function expectMoneyNot(actual, notExpected, what) {
  expect(
    moneyEquals(actual, notExpected),
    `${what}: expected anything but ${notExpected}, got ${actual}`
  ).toBe(false);
}

/**
 * The light UI spot-check that sits beside the record assertions.
 *
 * One per test, on the List Unit Price as the editor DISPLAYED it before
 * anything was saved. It catches a rendering regression; the record assertions
 * around it are what prove the pricing. Substring rather than equality — the
 * cell carries currency formatting that is not a contract.
 *
 * @param {object} displayedPrices  QuoteLineEditorPage.capturePrices() output
 * @param {string} productCode
 * @param {number|string} [contains]  omit to assert only that the cell is populated
 */
function expectDisplayed(displayedPrices, productCode, contains) {
  const shown = displayedPrices[productCode];
  expect(shown, `the editor rendered no row for ${productCode}`).toBeTruthy();

  if (contains === undefined) {
    expect(shown.listPrice, `${productCode}: List Unit Price cell is empty`).toBeTruthy();
    return;
  }

  // Separators stripped from the CELL, not added to the expectation — the same
  // reasoning as expectSelectionRow(), and the same bug: the editor renders
  // "$1,200.00", so a bare toContain('1200') fails on every four-figure price
  // and passes on every one below it. Measured twice, on LAPTOPCART in the
  // selection grid and then on LAPTOP13 here, which is exactly how a bug that
  // only bites above 999 gets fixed in one place and left in the other.
  const withoutSeparators = String(shown.listPrice).replace(/,/g, '');
  expect(
    withoutSeparators,
    `${productCode}: the editor's List Unit Price cell should show ${contains} ` +
      `(cell reads "${shown.listPrice}")`
  ).toContain(String(contains));
}

/**
 * A DISPLAYED currency string, parsed and compared numerically.
 *
 * WHY THIS EXISTS ALONGSIDE expectDisplayed(), WHICH LOOKS SIMILAR
 * ----------------------------------------------------------------
 * expectDisplayed() is a containment spot-check: it proves the cell rendered
 * something recognisable and nothing more, which is all a UI reading needs to
 * do when a record assertion is carrying the test.
 * That is not enough for a boundary sweep. tests/pricing-methods/ walks a
 * quantity across a tier edge and asserts the price at every step, and only
 * three of those steps commit — so at the rest the displayed value IS the
 * assertion, and containment would pass "$135.00" for an expected 35.
 *
 * The departure is stated in that spec's header, which is the condition rule 3
 * attaches to it. Nothing here weakens the rule elsewhere: a spec with a record
 * to read still reads it.
 *
 * THROWS ON AN UNPARSEABLE VALUE RATHER THAN COERCING.
 * Number('') is 0 and Number('--') is NaN, and both would sail through a
 * tolerance comparison as a quiet false pass or an unreadable one — an empty
 * cell is a rendering failure that must not read as a price of zero.
 *
 * @param {string|number} displayedValue  a cell as the editor rendered it
 * @param {number} expected
 * @param {string} label  what this is, for the failure message
 */
function expectDisplayedMoney(displayedValue, expected, label) {
  const parsed = parseDisplayedMoney(displayedValue);
  expect(
    parsed !== null,
    `${label}: could not read a number out of the displayed value ` +
      `${JSON.stringify(displayedValue)}. An empty or unparseable cell is a rendering failure, ` +
      'not a price — it is reported rather than compared, because Number("") is 0 and would ' +
      'otherwise pass or fail for the wrong reason.'
  ).toBe(true);

  expect(
    moneyEquals(parsed, expected),
    `${label}: expected ${expected}, the editor displayed ${JSON.stringify(displayedValue)} ` +
      `(parsed as ${parsed}, tolerance ${MONEY_TOLERANCE})`
  ).toBe(true);
}

/**
 * "$25.00" / "1,200.00" / "(45.00)" -> a number, or null if there isn't one.
 *
 * Currency symbol and thousands separators are stripped from the VALUE rather
 * than built into an expectation, which is the same direction expectDisplayed()
 * and expectSelectionRow() take and for the same reason: it needs no assumption
 * about which locale the org renders in. Parentheses are read as the accounting
 * negative, so a credit cannot compare equal to its own positive.
 */
function parseDisplayedMoney(displayedValue) {
  if (typeof displayedValue === 'number') {
    return Number.isFinite(displayedValue) ? displayedValue : null;
  }
  if (typeof displayedValue !== 'string') return null;

  const text = displayedValue.trim();
  if (!text) return null;

  const negative = /^\(.*\)$/.test(text) || text.includes('-');
  const digits = text.replace(/[^0-9.]/g, '');
  // Two decimal points means this was never one number — "1.200.00" under a
  // European separator convention, say. Guessing which is which would be a
  // locale assumption, and a wrong guess is off by a thousand.
  if (!digits || !/^\d*\.?\d*$/.test(digits) || digits === '.') return null;

  const magnitude = Number(digits);
  if (!Number.isFinite(magnitude)) return null;
  return negative ? -magnitude : magnitude;
}

/**
 * The pre-rule price, on the product selection screen.
 *
 * That grid is the ONLY place in the flow a product's price book price is
 * visible — after it, every price has been through the calculator. Asserted by
 * CONTAINMENT and never parsed: row text reads "<CODE> <NAME> <FAMILY>
 * <PRICE>", which is an observation of this org's grid rather than a contract,
 * and a parser built on it would break silently when a column is added.
 *
 * Degrades to logging rather than failing when the expected price is still an
 * unfilled placeholder. This is a spot-check and the record assertions carry
 * the scenario; every unresolved one names itself in the run output, so it
 * cannot go unnoticed either.
 */
function expectSelectionRow(rowText, item, expectedPrice) {
  expect(rowText, `no selection-grid row text for ${item.productCode}`).toBeTruthy();

  if (isPlaceholder(expectedPrice)) {
    console.log(
      `[spot-check] ${item.productCode}: pre-rule price not confirmed in ` +
        `data/pricing-rules.json (products.${item.key}.pricebookPrice) — checked the row exists ` +
        `only. Row text: ${rowText}`
    );
    return;
  }

  // Thousands separators are stripped from the ROW, not added to the expected
  // value. Measured on 2026-08-01: the grid renders "LAPTOPCART Laptop
  // Charging Cart Miscellaneous $1,100.00", so a bare toContain('1100') fails
  // on every product priced at four figures and passes on every one below —
  // which is exactly the kind of bug that hides until the catalogue changes.
  //
  // Formatting the expectation instead would mean this helper deciding which
  // locale the org renders in. Stripping is the direction that needs no such
  // assumption: '1,100.00' and '1100.00' both reduce to a string containing
  // '1100'.
  const withoutSeparators = String(rowText).replace(/,/g, '');
  expect(
    withoutSeparators,
    `${item.productCode}: the selection screen should show its pre-rule price ${expectedPrice} ` +
      `(row text, separators stripped: "${withoutSeparators}")`
  ).toContain(String(expectedPrice));
}

module.exports = {
  expectMoney,
  expectMoneyNot,
  expectDisplayed,
  expectDisplayedMoney,
  expectSelectionRow,
  parseDisplayedMoney,
};
