// src/pages/ProductSelectionPage.js
const { BasePage } = require('./BasePage');

// Represents the "Add Products" product-selection screen that appears inside
// the same Visualforce iframe as the Quote Line Editor once a group's "Add
// Products" is clicked (see QuoteLineEditorPage.openAddProducts()). It's kept
// as its own page class — rather than folded into QuoteLineEditorPage — so
// that search/select/confirm stays separate from line-level edits (quantity,
// discount, calculate, save).
//
// The screen is modal over one group: whichever group's Add Products opened
// it, that's where the confirmed products land. This class therefore knows
// nothing about groups — the caller already chose one.

// CONFIRMED — the screen offers "Select", "Select & Add More" and "Cancel".
//
//   Select           commits the ticked products and returns to the editor
//   Select & Add More commits them and stays here for another search
//
// The anchored regex on CONFIRM is deliberate: a plain substring match on
// "Select" would also hit "Select & Add More" and fail strict mode. "Add to
// Quote" is kept for package versions that use that label instead.
const CONFIRM_BUTTON_LABEL = /^(Select|Add to Quote)$/;
const SELECT_AND_ADD_MORE_LABEL = 'Select & Add More';

// CONFIRMED — the product search box on this org's selection screen is
// <input id="itemLabel" placeholder="Search Products">.
const SEARCH_PLACEHOLDER = 'Search Products';

// The app renders the whole screen twice — a desktop copy and a mobile copy —
// and hides one with CSS rather than omitting it from the DOM. So every
// locator here has to filter to the visible copy: `.first()` is not enough,
// because the hidden copy comes first in document order and every action on
// it fails with "element is not visible" after burning the full timeout.
const VISIBLE = { visible: true };

// CONFIRMED. The results grid is NOT table markup and has no row element that
// contains both a product's name and its checkbox. It is a flat sequence of
// Polymer custom elements, paired two per row:
//
//   sb-group#selection.th.hidden   <- header select-all (no "selection" class)
//   sb-group#selection.th          <- header (no "selection" class)
//   sb-group#selection...selection <- row 0 checkbox cell
//   sb-group#row                   <- row 0 content (code, name, family, ...)
//   sb-group#selection...selection <- row 1 checkbox cell
//   sb-group#row                   <- row 1 content
//   ...
//
// So a product and its checkbox are correlated by POSITION, not containment:
// the nth "selection" cell belongs to the nth row. That is why every
// row-scoped `row.locator('input[type=checkbox]')` attempt failed — there is
// no such input inside the row, and the real control lives in a sibling
// element's shadow root.
//
// The two header cells are excluded for free: only body cells carry the
// "selection" class token.
const ROW_SELECTOR = 'sb-group[id="row"]';
const SELECTION_CELL_SELECTOR = 'sb-group.selection';

// Same busy indicator the editor uses. While show="true" it covers the screen
// and swallows both clicks and keystrokes — typing into the search box during
// that window is silently discarded, which is why searches appeared to "not
// narrow" and the code then indexed into the full catalogue.
const BUSY_SELECTOR = 'sf-loading-spinner#spinner[show="true"]';
const READY_TIMEOUT_MS = 120_000;

/** Collapses whitespace and case so grid text compares predictably. */
function normalize(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

class ProductSelectionPage extends BasePage {
  constructor(page) {
    super(page);
    // Same editor iframe QuoteLineEditorPage targets. Kept in sync with
    // EDITOR_FRAME_SELECTOR there — see that file for why scrolling="yes" is
    // the discriminator between the two vfFrameId iframes.
    this.editor = page.frameLocator('iframe[name^="vfFrameId"][scrolling="yes"]');
  }

  searchInput() {
    return this.editor.getByPlaceholder(SEARCH_PLACEHOLDER).filter(VISIBLE).first();
  }

  /**
   * Waits for the busy overlay to clear AND stay clear.
   *
   * A single waitFor({ state: 'hidden' }) is not enough. The app toggles
   * show="true" off and straight back on as one async step hands to the next,
   * so a one-shot check frequently passes in a gap — and then the very next
   * click is rejected with "<sf-loading-spinner> intercepts pointer events".
   * Requiring a continuous quiet period removes that race.
   */
  async waitForNotBusy({ timeout = READY_TIMEOUT_MS, stableFor = 1500, interval = 250 } = {}) {
    const busy = this.editor.locator(BUSY_SELECTOR).first();
    const deadline = Date.now() + timeout;
    let clearSince = null;

    while (Date.now() < deadline) {
      const isBusy = await busy.isVisible().catch(() => false);
      if (isBusy) {
        clearSince = null;
      } else {
        if (clearSince === null) clearSince = Date.now();
        if (Date.now() - clearSince >= stableFor) return;
      }
      await this.page.waitForTimeout(interval);
    }
  }

  /**
   * Waits for the selection screen to be usable: search box present, overlay
   * gone, and at least one result row rendered.
   *
   * Without this the first search is typed into a screen that is still
   * loading, the keystrokes go nowhere, and the code then indexes into the
   * unfiltered catalogue — where the virtualized list makes the target row
   * unclickable. The symptom looks like a selector problem; the cause is a
   * missing wait.
   */
  async waitForReady({ after } = {}) {
    try {
      await this.searchInput().waitFor({ state: 'visible', timeout: READY_TIMEOUT_MS });
    } catch (e) {
      // Losing the search box almost always means the app navigated away from
      // the selection screen, and the usual cause is a BUNDLE: selecting one
      // opens the product configurator instead of returning here. Say so —
      // otherwise this surfaces as an unexplained two-minute timeout.
      throw new Error(
        'The product selection screen is gone — its search box never appeared' +
          `${after ? ` after selecting "${after}"` : ''}. The most likely cause is that the ` +
          'product is a BUNDLE, which opens the configurator rather than returning to the ' +
          'selection screen. Only simple products belong in data/home-security.json; bundle ' +
          `configuration needs its own spec. (Original: ${e.message.split('\n')[0]})`
      );
    }
    await this.waitForNotBusy();
    await this.selectionCells().first().waitFor({ state: 'visible', timeout: READY_TIMEOUT_MS });
  }

  /**
   * Types into the search box and submits.
   *
   * Typed rather than filled: this is a Polymer-bound input, and fill() sets
   * the DOM value without producing the keystroke events the binding listens
   * for — leaving the box looking correct while the app never runs the search.
   */
  /**
   * Narrowing the results is not cosmetic — it is what makes the click work.
   *
   * The grid is a virtualized <iron-list>: only rows near the viewport exist
   * in the DOM, and it recycles nodes as you scroll. Indexing into the full
   * 34-product catalogue therefore resolves to a node that is present but not
   * clickable ("iron-list intercepts pointer events", then "element is not
   * visible"). With the search applied there are a handful of rows, all
   * rendered, and the positional click is safe.
   *
   * So this waits for evidence the search actually ran, rather than for the
   * grid to be "settled". Settled is not the same as applied: an unchanged
   * grid is exactly what you see before the search has started, which made the
   * old wait return instantly against the pre-search catalogue.
   */
  async search(term) {
    await this.waitForNotBusy();
    const before = await this.gridSignature();

    const input = this.searchInput();
    // One retry: the overlay can reappear between the wait above and this
    // click, and re-waiting is cheaper than failing the whole journey.
    try {
      await input.click({ timeout: 15_000 });
    } catch {
      await this.waitForNotBusy();
      await input.click();
    }
    await input.press('ControlOrMeta+a');
    await input.pressSequentially(String(term), { delay: 20 });
    await input.press('Enter');

    // Enter alone does not always submit — the screen also has an explicit
    // search button next to the box. Clicking it when present makes the search
    // deterministic instead of dependent on which handler the app wired up.
    const button = this.editor
      .getByRole('button', { name: /search/i })
      .filter(VISIBLE)
      .first();
    if (await button.isVisible().catch(() => false)) {
      await button.click().catch(() => {});
    }

    await this.waitForGridChanged(before);
    await this.waitForGridSettled();
  }

  /** Cheap fingerprint of the current results, for detecting that a search ran. */
  async gridSignature() {
    const count = await this.selectionCells().count();
    const [first = ''] = await this.visibleRowTexts();
    return `${count}|${first.slice(0, 80)}`;
  }

  async waitForGridChanged(before, { attempts = 30, interval = 500 } = {}) {
    for (let i = 0; i < attempts; i += 1) {
      if ((await this.gridSignature()) !== before) return true;
      await this.page.waitForTimeout(interval);
    }
    // Not fatal on its own: a search whose results happen to match the previous
    // view is possible. rowIndexOf() reports the real row count if the
    // subsequent lookup goes wrong.
    return false;
  }

  /** Every body row currently in the results grid. */
  rows() {
    return this.editor.locator(ROW_SELECTOR).filter(VISIBLE);
  }

  /** Every body row's checkbox cell, in the same order as rows(). */
  selectionCells() {
    return this.editor.locator(SELECTION_CELL_SELECTOR).filter(VISIBLE);
  }

  /**
   * Reads the text of every visible row in ONE round trip.
   *
   * Deliberately not a `for` loop over `rows.nth(i).innerText()`. The grid
   * re-renders as results settle, so each nth() re-resolves against a DOM that
   * may have changed since count() — which showed up as a 30s timeout on a row
   * that existed a moment earlier. Reading everything in a single evaluateAll
   * takes one consistent snapshot.
   *
   * textContent, not innerText, and the shadow root as well: these are custom
   * elements whose visible text lives inside their shadow DOM, where innerText
   * does not reach.
   */
  async visibleRowTexts() {
    return this.editor.locator(ROW_SELECTOR).evaluateAll((nodes) => {
      // Walks light DOM and shadow roots together, skipping <style>/<script>.
      // A plain shadowRoot.textContent is useless here: every shadow root in
      // this app opens with a stack of <style> elements, so the "row text"
      // comes back as several kilobytes of CSS with the product name buried
      // in it — or absent entirely.
      function collect(root, out, depth) {
        if (!root || depth > 10) return;
        root.childNodes.forEach((child) => {
          if (child.nodeType === 3) {
            out.push(child.nodeValue);
            return;
          }
          if (child.nodeType !== 1) return;
          const tag = child.tagName;
          if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'TEMPLATE') return;
          if (child.shadowRoot) collect(child.shadowRoot, out, depth + 1);
          collect(child, out, depth + 1);
        });
      }

      return nodes
        .map((n) => {
          const parts = [];
          if (n.shadowRoot) collect(n.shadowRoot, parts, 0);
          collect(n, parts, 0);
          return {
            visible: n.getClientRects().length > 0,
            text: parts.join(' ').replace(/\s+/g, ' ').trim(),
          };
        })
        .filter((r) => r.visible)
        .map((r) => r.text);
    });
  }

  /**
   * Waits for the results grid to stop changing.
   *
   * The search re-renders asynchronously, so reading the grid straight after
   * pressing Enter can snapshot the pre-search catalogue — which is how a
   * search for one product came back with all 34.
   */
  async waitForGridSettled({ attempts = 20, interval = 500 } = {}) {
    let previous = -1;
    for (let i = 0; i < attempts; i += 1) {
      const current = await this.selectionCells().count();
      if (current > 0 && current === previous) return current;
      previous = current;
      await this.page.waitForTimeout(interval);
    }
    return previous;
  }

  /**
   * Position of a product among the visible rows, which is the only way to
   * reach its checkbox (see the structure note above).
   *
   * Matching is by PRODUCT CODE when one is supplied, because names are not
   * unique in the grid: searching "Warranty" returns LDWARRANTY (Loss and
   * Damage Warranty), WARRANTY and WARRANTYEXTENSION, and every one of those
   * rows contains the word "Warranty". A name-substring match takes the first
   * and silently quotes the wrong product.
   *
   * The code is matched against the row's FIRST token, not with a substring or
   * word-boundary test. Row text reads "<CODE> <NAME> <FAMILY> <PRICE>", e.g.
   * "WARRANTY Warranty Support $10.00" — and a `\bwarranty\b` test would also
   * hit "WARRANTYEXTENSION Warranty Extension …" via the word in its name.
   * First-token equality is the only unambiguous test.
   *
   * Position is deliberately not used. "WARRANTY is always the second row"
   * holds only until the catalogue gains another warranty product or the sort
   * order changes, and the failure would be a silently wrong quote rather than
   * an error.
   *
   * @param {string|{name?: string, productCode?: string}} product
   */
  async rowIndexOf(product) {
    const wantedCode = typeof product === 'object' ? product.productCode : undefined;
    const productName = typeof product === 'object' ? product.name : product;

    if (wantedCode) {
      await this.selectionCells().first().waitFor({ state: 'visible' });
      const texts = await this.visibleRowTexts();
      await this.assertGridConsistent(texts.length);

      const code = normalize(wantedCode);
      const index = texts.findIndex((t) => normalize(t).split(' ')[0] === code);
      if (index === -1) {
        throw new Error(
          `No row with product code "${wantedCode}" among the ${texts.length} search result(s): ` +
            `${texts.map((t) => t.slice(0, 50)).join(' | ') || '(none)'}`
        );
      }
      return index;
    }

    return this.rowIndexOfName(productName);
  }

  async assertGridConsistent(rowCount) {
    const cellCount = await this.selectionCells().count();
    if (rowCount !== cellCount) {
      // The whole approach rests on rows and checkbox cells being 1:1 and in
      // the same order. If that ever stops holding, fail here saying so rather
      // than silently ticking the wrong product.
      throw new Error(
        `Product selection grid is inconsistent: ${rowCount} visible row(s) but ${cellCount} ` +
          'checkbox cell(s). Row-to-checkbox pairing is positional, so these must match.'
      );
    }
  }

  /** Name-based fallback, for callers that have no product code. */
  async rowIndexOfName(productName) {
    // Wait on a checkbox cell rather than a row: the cells are what we index
    // into, so their presence is the signal that matters.
    await this.selectionCells().first().waitFor({ state: 'visible' });

    const texts = await this.visibleRowTexts();
    await this.assertGridConsistent(texts.length);

    const wanted = normalize(productName);
    const index = texts.findIndex((t) => normalize(t).includes(wanted));
    if (index === -1) {
      throw new Error(
        `"${productName}" is not among the ${texts.length} search result(s): ` +
          `${texts.map((t) => t.slice(0, 50)).join(' | ') || '(none)'}`
      );
    }
    return index;
  }

  /**
   * One product's row text, exactly as the grid renders it.
   *
   * For the PRE-RULE price spot-check: the selection screen shows a product's
   * price book price, before any price rule has had a chance to fire, which is
   * the only place in the flow that value is visible in the UI.
   *
   * Returns the collapsed row string and nothing more. Callers should assert
   * that it CONTAINS an expected price and must not parse a number out of it —
   * row text reads "<CODE> <NAME> <FAMILY> <PRICE>" and that layout is an
   * observation of this org's grid, not a contract. A parser built on it would
   * break on a column being added to the field set, and would break silently,
   * since a mis-parsed number still compares against something.
   *
   * @param {string|{name?: string, productCode?: string}} product
   */
  async rowText(product) {
    const index = await this.rowIndexOf(product);
    const texts = await this.visibleRowTexts();
    return texts[index] || '';
  }

  confirmButton() {
    return this.editor
      .getByRole('button', { name: CONFIRM_BUTTON_LABEL })
      .filter(VISIBLE)
      .first();
  }

  selectAndAddMoreButton() {
    return this.editor
      .getByRole('button', { name: SELECT_AND_ADD_MORE_LABEL, exact: true })
      .filter(VISIBLE)
      .first();
  }

  /**
   * Commits the current tick and stays on the selection screen for another
   * search.
   *
   * This is what makes multi-product adds work at all: a new search DISCARDS
   * whatever was ticked before it. Ticking four products across four searches
   * and confirming once leaves exactly one line on the quote — the last one —
   * which looks like a selection bug but is the screen behaving as designed.
   */
  async selectAndAddMore(justSelected) {
    await this.waitForNotBusy();
    await this.selectAndAddMoreButton().click();
    await this.waitForNotBusy();
    await this.waitForReady({ after: justSelected });
  }

  /**
   * Ticks one product by clicking its "selection" cell.
   *
   * .click() rather than .check(): there is no <input type=checkbox> to check.
   * The control is a Polymer element that renders a tick by dropping a
   * "hidden" class, so Playwright's checkbox actionability model does not
   * apply to it.
   *
   * Always searches first — the grid shows the full catalogue otherwise, and
   * narrowing to one product makes the positional lookup unambiguous.
   */
  async selectProduct(product) {
    const name = typeof product === 'object' ? product.name : product;
    // Search by NAME even when a code is supplied — the search box matches on
    // the product name, and the code then disambiguates among the results.
    await this.search(name);
    const index = await this.rowIndexOf(product);
    const cell = this.selectionCells().nth(index);
    // Virtualized list: nudge the row into view before clicking. With the
    // search applied this is a no-op, but it costs nothing and turns one class
    // of virtualization failure into a pass.
    await cell.scrollIntoViewIfNeeded().catch(() => {});
    await this.waitForNotBusy();
    await cell.click();
  }

  /**
   * Ticks several products, then confirms **once**.
   *
   * One confirm rather than one per product: each confirm closes the screen
   * and returns to the editor, so the per-product loop the old addProduct()
   * implied would mean reopening Add Products four times — four page loads,
   * four chances to land in the wrong group, and four recalculations.
   *
   * NOTE: this assumes CPQ preserves ticked checkboxes across searches within
   * one visit to the screen. It does in the versions this targets; if your org
   * clears them, the failure is loud (fewer lines than expected) rather than
   * silent, and the fix is to confirm per product instead.
   *
   * @param {string[]} productNames
   */
  async addProducts(productNames) {
    if (!Array.isArray(productNames) || !productNames.length) {
      throw new Error('addProducts() needs at least one product.');
    }
    await this.waitForReady();

    for (let i = 0; i < productNames.length; i += 1) {
      const product = productNames[i];
      const label = typeof product === 'object' ? product.name : product;
      await this.selectProduct(product);

      if (i < productNames.length - 1) {
        // Commit this product before searching for the next one. Searching
        // discards the current tick, so the ticks cannot be accumulated and
        // confirmed in one go.
        await this.selectAndAddMore(label);
      }
    }

    await this.waitForNotBusy();
    await this.confirmButton().click();
    await this.waitForLightningReady();
  }

  /** Single-product convenience, for callers that genuinely add just one. */
  async addProduct(productName) {
    await this.addProducts([productName]);
  }

  /**
   * Ticks one BUNDLE and confirms, expecting to be handed to the product
   * configurator rather than returned here.
   *
   * Separate from addProducts() because the two disagree about what success
   * looks like. addProducts() ends by waiting for this screen to still be
   * usable, and waitForReady() treats a vanished search box as a failure —
   * with an error message that names bundles as the likely cause, which is
   * exactly right for the simple-product callers it was written for and
   * exactly wrong here. For a bundle the search box vanishing IS the success
   * signal: Product2.SBQQ__ConfigurationType__c is set, so CPQ navigates to
   * "Configure Products" instead of coming back.
   *
   * That existing message is left untouched on purpose. data/home-security.json
   * relies on it to explain a mis-filed bundle in a suite that has no
   * configurator handling at all.
   *
   * This method deliberately does NOT wait for the configurator to paint —
   * that screen has its own readiness signal and its own long budget. Follow
   * this with ProductConfigurationPage.waitForReady().
   *
   * @param {string|{name?: string, productCode?: string}} product
   */
  async selectBundle(product) {
    const label = typeof product === 'object' ? product.name : product;

    await this.waitForReady();
    await this.selectProduct(product);
    await this.waitForNotBusy();
    await this.confirmButton().click();

    // The selection screen going away is the handoff. Waiting on it here —
    // rather than on the configurator — keeps this class ignorant of the
    // screen it hands off to, and turns "the bundle was treated as a simple
    // product" into an error that says so.
    try {
      await this.searchInput().waitFor({ state: 'hidden', timeout: READY_TIMEOUT_MS });
    } catch (e) {
      throw new Error(
        `Selecting "${label}" left the product selection screen open. A bundle should hand off ` +
          'to the product configurator, so this product is almost certainly NOT configurable in ' +
          'this org — check Product2.SBQQ__ConfigurationType__c is set on it. ' +
          `(Original: ${e.message.split('\n')[0]})`
      );
    }
    await this.page.waitForLoadState('domcontentloaded');
  }
}

module.exports = { ProductSelectionPage, CONFIRM_BUTTON_LABEL };
