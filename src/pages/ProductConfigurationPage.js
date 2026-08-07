// src/pages/ProductConfigurationPage.js
//
// The CPQ bundle configurator — the "Configure Products" screen that opens
// instead of returning to the selection screen when the product you tick in
// Add Products is a bundle (Product2.SBQQ__ConfigurationType__c is set).
//
// Kept as its own class rather than folded into QuoteLineEditorPage for the
// same reason ProductSelectionPage is separate: it is a different screen with
// a different DOM, reached through the same iframe. The QLE knows about lines;
// this knows about options, features and attributes.
//
// SAME IFRAME AS THE QLE
// ----------------------
// CONFIRMED against this org: the configurator renders behind the identical
// Visualforce iframe as the Quote Line Editor, so EDITOR_FRAME_SELECTOR is
// imported from QuoteLineEditorPage rather than redefined. The two-iframe
// scrolling="yes" discriminator was earned once; duplicating the string
// guarantees the copies drift.
//
// THE SCREEN IS THE SAME POLYMER SHADOW-DOM APP
// ---------------------------------------------
// Everything in the header note of QuoteLineEditorPage applies here too, and
// two of its consequences bit during discovery:
//
//   * Playwright's CSS engine pierces open shadow roots for SIMPLE selectors,
//     which is why `sb-table-row[name="..."]` and `paper-tab[label="..."]`
//     work directly off the frame.
//   * A DESCENDANT CHAIN inside one CSS selector does NOT cross a shadow
//     boundary, but CHAINED .locator() calls DO. That distinction is what
//     makes attributeItem({ within }) work — see the CONFIRMED note there.
//   * `row.locator('sb-option-drawer')` returns zero matches, and the reason
//     is NOT a shadow boundary: the drawer is not inside the row at all. It is
//     a SIBLING appended after the row in the option table's body. See
//     DRAWER_ROW_SELECTOR, which is how each row's own drawer is reached.
//   * The app renders desktop and mobile copies and hides one with CSS, and
//     the INACTIVE TAB's feature list stays in the DOM while hidden. So every
//     locator here filters on visibility. `.first()` is not a substitute: the
//     hidden copy comes first in document order, so it burns the full timeout
//     and then reports "element is not visible".
const { BasePage } = require('./BasePage');
const { EDITOR_FRAME_SELECTOR } = require('./QuoteLineEditorPage');

// ---------------------------------------------------------------------------
// Org-specific constants.
//
// Everything marked CONFIRMED was read off this org's live DOM on 2026-07-30
// by driving a real quote to the Solar Controller Hub configurator and dumping
// the shadow-piercing DOM. Nothing here is a guess.
// ---------------------------------------------------------------------------

// The mobile/desktop duplicate-render filter (see the header note).
const VISIBLE = { visible: true };

// CONFIRMED. The whole configurator is <sb-product-config> inside the editor
// iframe's <sb-page-container>. Its presence plus a visible Save button is
// what distinguishes "in the configurator" from "back in the QLE" — the Save
// button alone is not enough, because the QLE has one too.
const APP_SELECTOR = 'sb-product-config';

// CONFIRMED. <h1 id="headerTitle">Configure Products</h1>, with the quote
// number in the <h2> beside it.
const HEADER_TITLE_SELECTOR = 'h1#headerTitle';

// CONFIRMED. The action bar renders three buttons:
//
//   <paper-button id="firstItem" label="Apply Rules">Apply Rules</paper-button>
//   <paper-button id="pcCancel"><sb-i18n>Cancel</sb-i18n></paper-button>
//   <paper-button id="pcSave" class="primary"><sb-i18n>Save</sb-i18n></paper-button>
//
// Addressed by id rather than by role+name deliberately. The label text sits
// inside an <sb-i18n> custom element, so the accessible name depends on how
// the browser flattens that subtree — whereas pcSave/pcCancel are CPQ's own
// stable ids and are single simple selectors, which pierce shadow roots
// cleanly. They are also unambiguous in a way the names are not: the QLE
// behind this screen has its own Save.
const SAVE_BUTTON_SELECTOR = 'paper-button#pcSave';
const CANCEL_BUTTON_SELECTOR = 'paper-button#pcCancel';

// CONFIRMED. Validation failures render as SLDS toasts inside
// <div id="messages"> / <sb-toast type="error">, one <div id="error_N"> per
// message, whose innerText is exactly the message and nothing else.
//
// Matched on the id PREFIX rather than the toast container so each message is
// its own element: steps that assert exact text need the messages separated,
// not one blob to regex. Nothing here normalises or truncates.
const ERROR_MESSAGE_SELECTOR = 'div[id^="error_"]';

// CONFIRMED, and it is the reason save() clears the region before clicking.
// A rejected Save's toasts STAY ON SCREEN indefinitely — editing the
// configuration to fix the problem does not remove them, and only the next
// Save replaces them. So a saveErrors() read taken at any later point returns
// the PREVIOUS failure and reads as though the fix never worked.
//
// Each toast carries its own dismiss button.
const ERROR_DISMISS_SELECTOR = 'button.slds-notify__close';

// CONFIRMED. Bundle-level (global) configuration attributes render above the
// tab strip as <sb-attribute-item label="System Voltage"> wrapping a real
// <select id="myselect">, so selectOption() applies — this is one of the very
// few genuine form controls in the app.
const ATTRIBUTE_ITEM = (label) => `sb-attribute-item[label="${label}"]`;
const ATTRIBUTE_ITEM_SELECTOR = 'sb-attribute-item';
const SELECT_SELECTOR = 'select#myselect';

// CONFIRMED on 2026-07-31 against the Smartwatch bundle: an attribute whose
// target field is TEXT rather than a picklist wraps an <sb-input> holding
// <input id="myinput" type="text"> instead of <sb-select>/<select#myselect>.
//
// Note the id COLLIDES with the floating quantity cell editor
// (CELL_INPUT_SELECTOR). That is why this is never used unscoped: every read
// and write goes through textAttributeInput(), which anchors it beneath its
// own sb-attribute-item. A frame-level `input#myinput` would match whichever
// of the two happens to be on screen.
const TEXT_INPUT_SELECTOR = 'input#myinput';

// CONFIRMED. The empty choice is <option value="">--None--</option>.
//
// It is NOT always offered. CPQ omits it for a REQUIRED attribute that already
// carries a saved value, so a required attribute cannot be cleared through the
// configurator once set — see globalAttributeOptions() for the measurement.
const ATTRIBUTE_NONE_VALUE = '';
const ATTRIBUTE_NONE_LABEL = '--None--';

// CONFIRMED. Feature tabs are <paper-tab role="tab" label="Solar Essentials">
// with aria-selected, and each tab's panel is
// <sb-product-feature-list label="Solar Essentials">.
//
// The panel matters as much as the tab: <iron-pages> renders the selected page
// ONLY, so the Upsells features do not exist in the DOM at all until its tab
// is clicked — while the previously selected panel stays in the DOM, hidden.
const TAB_SELECTOR = 'paper-tab[role="tab"]';
const TAB = (label) => `paper-tab[label="${label}"]`;
const TAB_PANEL = (label) => `sb-product-feature-list[label="${label}"]`;

// CONFIRMED. One section per product feature: <sb-product-feature name="Panels">
// holding <h2 id="feature-name">Panels</h2> and, when the feature declares a
// min/max option count, <p id="instructions-text">Choose at least 2 of the
// following:</p>.
const FEATURE_SELECTOR = 'sb-product-feature';
const FEATURE = (name) => `sb-product-feature[name="${name}"]`;
const FEATURE_NAME_SELECTOR = 'h2#feature-name';

// CONFIRMED. An option row is <sb-table-row id="row" name="<Product Name>">.
// The name attribute is the product NAME, not its code.
//
// Rows are still scoped beneath their feature rather than looked up from the
// frame, for the reason the group-scoping note in QuoteLineEditorPage gives:
// the moment two features offer the same product, a frame-level match hits
// both, and the failure is either a strict-mode throw or a silent edit to the
// wrong feature's row.
const OPTION_ROW = (productName) => `sb-table-row[name="${productName}"]`;

// CONFIRMED. The selection control is NOT always a checkbox. A feature whose
// SBQQ__MaxOptionCount__c is 1 renders radios instead:
//
//   checkbox features:  <paper-checkbox id="checkbox" role="checkbox" …>
//   single-select:      <paper-radio-button id="radio" role="radio" …>
//
// Both carry aria-checked and aria-disabled, so one read serves both. Matching
// only role=checkbox would silently find nothing in the Inverters feature.
const SELECTION_CONTROL_SELECTOR = 'paper-checkbox#checkbox, paper-radio-button#radio';

// CONFIRMED. Each visible column is an <sb-option-cell>, and QUANTITY is the
// first one. Its value is the text of <span id="me"> inside <div id="formatted">.
//
// The cell's own innerText() comes back EMPTY — the text lives in a nested
// shadow root that innerText does not reach — so reads go through span#me.
const OPTION_CELL_SELECTOR = 'sb-option-cell';
const CELL_VALUE_SELECTOR = 'span#me';

// CONFIRMED. Quantity cells are click-to-edit. The input is a FLOATING overlay
// positioned over the grid, not a child of the cell, so `cell.locator('input')`
// finds nothing — it is addressed by focus, exactly like the QLE's own cell
// editor.
const CELL_INPUT_SELECTOR = 'input#myinput';

// CONFIRMED. A row that carries option-level configuration attributes renders
// <div id="drawerIcon"> in its actions column; a row that does not renders
// <div id="drawerPlaceHolder"> instead. So the icon's presence is itself the
// signal that there is a drawer to open, and clicking it toggles the drawer.
const DRAWER_TOGGLE_SELECTOR = '#drawerIcon';

// CONFIRMED. The expanded drawer is <sb-option-drawer name="<Product Name>">,
// holding one <sb-option-cell class="drawerCell"> per attribute, each with its
// label in <div id="fieldLabel"> and its control in <select id="myselect">.
const OPTION_DRAWER_SELECTOR = 'sb-option-drawer';
const DRAWER_FIELD_LABEL_SELECTOR = 'div#fieldLabel';

// THE DRAWER IS REACHED FROM ITS ROW, NOT BY NAME, AND THAT IS LOAD-BEARING.
//
// The obvious anchor — sb-option-drawer[name="<Product Name>"] at the frame —
// is AMBIGUOUS, because a bundle may offer the same product twice. MEASURED on
// 2026-07-31: the Smartwatch bundle's "Watch Bands" feature holds two
// SBQQ__ProductOption__c records that both point at Product2 "Smartwatch Band"
// (PO-000076, Required; PO-000077, optional). They render as two
// <sb-table-row name="Smartwatch Band"> and, once expanded, two
// <sb-option-drawer name="Smartwatch Band">. A name lookup with .first()
// silently returns whichever came first and reads the WRONG band's attributes
// — a false pass, since both drawers carry the same three field labels and
// differ only in their values.
//
// The drawer also carries no index/id of its own to disambiguate with:
// MEASURED, its complete attribute list is id="drawerRow", name, class.
//
// What IS unambiguous is position. The drawer is not inside the row (which is
// why row.locator('sb-option-drawer') finds nothing) — it is appended to the
// option table's body as the row's IMMEDIATE NEXT SIBLING, wrapped in a plain
// <div>. Verified per row on 2026-07-31 by opening both drawers and reading
// each one back through its own row: row 0 -> Material "Silicone", row 1 ->
// Material "Leather", matching PO-000076 and PO-000077 respectively.
//
// Relative XPath is used rather than a CSS sibling combinator because the two
// elements share a shadow root that a frame-level CSS selector cannot enter.
// Note `following-sibling::sb-option-drawer` matches ZERO — XPath does not
// resolve the custom-element name here — so the step is taken to the wrapper
// element and the drawer is then matched by CSS, which also makes a structural
// change fail loudly instead of resolving to the wrong element.
const DRAWER_ROW_SELECTOR = 'xpath=./following-sibling::*[1]';

// CONFIRMED. The same busy indicator the QLE and the selection screen use.
//
// MATCHED BY VISIBILITY, NEVER BY PRESENCE — this cost a 45-minute run to
// establish. show="true" is effectively STICKY on this element: it is set on
// <sf-loading-spinner id="spinner"> even when the configurator is fully
// painted, idle and interactive, confirmed in DOM dumps taken at rest on
// 2026-07-30. So an existence test against the attribute selector reports
// "busy" forever, every wait burns its entire budget, and the run dies of
// timeouts rather than of anything real.
//
// What actually toggles is whether the overlay is RENDERED. The id qualifier
// matters just as much: the app nests a spinner inside almost every component
// (sb-describe, sb-service, sb-job-checker …), and an unqualified selector
// picks those up too.
//
// div.sbLoadingMask is the mask that dims the page underneath the spinner. It
// is included because it is a real boxed element covering the screen, so it
// catches the case where the overlay is up but the host measures as hidden.
const BUSY_SELECTOR = 'sf-loading-spinner#spinner[show="true"], div.sbLoadingMask';

// The configurator is the heaviest screen in the app: this org shows
// "Large bundle configuration enabled. It may take a minute to process your
// request." while it loads, and a cold entry genuinely takes over a minute.
const READY_TIMEOUT_MS = 300_000;
const SAVE_TIMEOUT_MS = 300_000;

// A Save that CPQ rejects re-renders the screen and posts its toasts
// asynchronously, a little after the spinner clears. Reading the error region
// the instant the spinner goes gives an empty list and looks like success.
const MESSAGE_SETTLE_MS = 4_000;

// Probe budget for readConfiguration()'s BULK read of the untouched defaults.
//
// WHY IT IS SHORTER, AND WHY THAT IS SAFE
// ----------------------------------------
// Deciding a quantity is read-only requires EXHAUSTING the retries — an
// editable cell answers on the first attempt that lands, a read-only one can
// only be identified by every attempt failing. This bundle has nine read-only
// quantities at rest, so the default budget spends ~19s each proving a
// negative, and the default-configuration read alone accounted for a large
// share of the suite's runtime.
//
// What defeats the swallowed-click problem is the NUMBER OF CLICKS, not the
// wait between them: measured, an editable cell materialises its input in well
// under a second, so a 5s per-attempt budget is almost entirely dead time on
// the read-only path. The attempt count is therefore unchanged and only the
// waiting is trimmed.
//
// Used ONLY by readConfiguration(), which reads the untouched defaults with no
// mutation in between. Every probe that follows a state change — a selection,
// a quantity edit, a Save — keeps the full budget, because that is where a
// re-render can actually swallow the first click and where reporting an
// editable cell as read-only would be a false pass.
const BULK_PROBE = { attempts: 3, perAttempt: 1_500, settle: 800 };

class ProductConfigurationPage extends BasePage {
  constructor(page) {
    super(page);
    // Same iframe as the QLE — see EDITOR_FRAME_SELECTOR, imported rather than
    // redefined.
    this.editor = page.frameLocator(EDITOR_FRAME_SELECTOR);
  }

  // -------------------------------------------------------------------------
  // Readiness
  // -------------------------------------------------------------------------

  /**
   * Waits for the busy overlay to clear AND stay clear.
   *
   * A one-shot waitFor({ state: 'hidden' }) is not enough: the app flicks
   * show="true" off and straight back on between async steps, so a single
   * check frequently passes in a gap and the very next click is rejected with
   * "<sf-loading-spinner> intercepts pointer events".
   */
  /** Whether a loading overlay is currently RENDERED — see BUSY_SELECTOR. */
  async isBusy() {
    return (await this.editor.locator(BUSY_SELECTOR).filter(VISIBLE).count().catch(() => 0)) > 0;
  }

  /**
   * @param {object} [options]
   * @param {number} [options.timeout=60000] Default is deliberately short.
   *        This is called after every small action (toggle, quantity, tab), so
   *        a long default lets one stuck reading stall the whole run in
   *        increments — which is exactly how a sticky busy signal turned a
   *        25-minute spec into a 45-minute timeout. The configurator-load path
   *        passes the long budget explicitly.
   */
  async waitForNotBusy({ timeout = 60_000, stableFor = 2_000, interval = 250 } = {}) {
    const deadline = Date.now() + timeout;
    let clearSince = null;

    while (Date.now() < deadline) {
      const isBusy = await this.isBusy();
      if (isBusy) {
        clearSince = null;
      } else {
        if (clearSince === null) clearSince = Date.now();
        if (Date.now() - clearSince >= stableFor) return;
      }
      await this.page.waitForTimeout(interval);
    }

    // Never throws — a slow screen is not by itself a failure, and the caller's
    // own wait is what decides. But it says so, because a busy signal that is
    // stuck ON is otherwise invisible: every wait quietly costs its full
    // budget and the run dies somewhere unrelated with no clue why.
    console.warn(
      `[configurator] still busy after ${timeout}ms — continuing anyway. If this repeats on ` +
        'every action, the busy selector is matching something permanent rather than the ' +
        'loading overlay (see BUSY_SELECTOR).'
    );
  }

  /**
   * Waits until the configurator has painted its tab strip and feature
   * sections and is no longer busy.
   *
   * Waits on a FEATURE rather than on <sb-product-config>: the app element is
   * in the DOM from the moment the screen is requested, so waiting on it
   * returns while the page is still an empty shell and every subsequent
   * locator times out somewhere less obvious.
   */
  async waitForReady({ timeout = READY_TIMEOUT_MS } = {}) {
    await this.editor
      .locator(FEATURE_SELECTOR)
      .filter(VISIBLE)
      .first()
      .waitFor({ state: 'visible', timeout });
    await this.waitForNotBusy({ timeout });
  }

  /**
   * Whether the configurator is currently on screen.
   *
   * Both halves are required. <sb-product-config> lingers in the DOM after a
   * successful Save has already returned to the Quote Line Editor, so the app
   * element alone reports a configurator that is no longer there; the Save
   * button alone is worse, because the QLE behind it has one too.
   */
  async isOpen() {
    const app = await this.editor.locator(APP_SELECTOR).count().catch(() => 0);
    if (!app) return false;
    return (await this.editor.locator(SAVE_BUTTON_SELECTOR).filter(VISIBLE).count().catch(() => 0)) > 0;
  }

  /** The screen's own title, e.g. "Configure Products" — a light spot-check. */
  async headerTitle() {
    return (await this.editor.locator(HEADER_TITLE_SELECTOR).first().innerText()).trim();
  }

  // -------------------------------------------------------------------------
  // Tabs — the outermost anchor
  // -------------------------------------------------------------------------

  tab(label) {
    return this.editor.locator(TAB(label)).filter(VISIBLE).first();
  }

  /** Every tab label, in document order — for asserting the tab strip. */
  async tabLabels() {
    const tabs = this.editor.locator(TAB_SELECTOR).filter(VISIBLE);
    const labels = [];
    for (let i = 0; i < (await tabs.count()); i += 1) {
      const label = await tabs.nth(i).getAttribute('label');
      // The overflow tab carries no label; it is chrome, not a feature tab.
      if (label) labels.push(label.trim());
    }
    return labels;
  }

  async activeTabLabel() {
    const active = this.editor
      .locator(`${TAB_SELECTOR}[aria-selected="true"]`)
      .filter(VISIBLE)
      .first();
    return (await active.getAttribute('label')) || '';
  }

  /**
   * Brings one tab's features on screen.
   *
   * Not optional bookkeeping: <iron-pages> renders only the selected panel, so
   * a feature on an unselected tab is not in the DOM at all and every lookup
   * against it fails with a timeout that names the feature rather than the tab.
   *
   * A no-op when the tab is already active, so callers can state which tab
   * they need without tracking where they are.
   */
  async openTab(label) {
    if ((await this.activeTabLabel()) === label) return;
    await this.tab(label).click();
    await this.waitForNotBusy();
    await this.editor
      .locator(TAB_PANEL(label))
      .filter(VISIBLE)
      .first()
      .waitFor({ state: 'visible', timeout: READY_TIMEOUT_MS });
    await this.waitForNotBusy();
  }

  // -------------------------------------------------------------------------
  // Features and options — every locator anchored beneath its feature
  // -------------------------------------------------------------------------

  /**
   * One feature's section. Every per-option locator below hangs off this.
   *
   * The visibility filter is load-bearing rather than defensive: switching
   * tabs leaves the previous panel's features in the DOM, hidden, so an
   * unfiltered match resolves to a feature on a tab that is no longer shown.
   */
  featureSection(featureName) {
    return this.editor.locator(FEATURE(featureName)).filter(VISIBLE).first();
  }

  /** Feature names on the active tab, in document order. */
  async featureNames() {
    const names = this.editor
      .locator(FEATURE_SELECTOR)
      .filter(VISIBLE)
      .locator(FEATURE_NAME_SELECTOR);
    return (await names.allInnerTexts()).map((t) => t.trim()).filter(Boolean);
  }

  /**
   * One option's row, scoped to its feature.
   *
   * Scoped rather than looked up from the frame because a product may appear
   * under more than one feature. See OPTION_ROW.
   *
   * `occurrence` picks between rows that share a product NAME within one
   * feature. It defaults to 0, so every existing caller is unaffected, but it
   * is not decoration: a bundle can offer the same product twice through two
   * SBQQ__ProductOption__c records, and the Smartwatch bundle does. Callers
   * addressing such a feature should first assert optionRowCount(), so the
   * ordinal is anchored to a checked fact rather than to an assumption.
   */
  optionRow(featureName, optionName, { occurrence = 0 } = {}) {
    return this.featureSection(featureName)
      .locator(OPTION_ROW(optionName))
      .filter(VISIBLE)
      .nth(occurrence);
  }

  /**
   * How many rows in one feature carry the same product name.
   *
   * Exists so a spec can PROVE the bundle still offers the product the number
   * of times it expects before addressing one of them by ordinal. Without it,
   * an admin deleting one of a pair turns every `occurrence: 1` lookup into a
   * timeout that names the product rather than the missing option.
   */
  async optionRowCount(featureName, optionName) {
    return this.featureSection(featureName).locator(OPTION_ROW(optionName)).filter(VISIBLE).count();
  }

  /** The checkbox or radio that selects one option (see SELECTION_CONTROL_SELECTOR). */
  selectionControl(featureName, optionName, opts = {}) {
    return this.optionRow(featureName, optionName, opts)
      .locator(SELECTION_CONTROL_SELECTOR)
      .filter(VISIBLE)
      .first();
  }

  /**
   * Whether an option is currently selected.
   *
   * Read from aria-checked, which both paper-checkbox and paper-radio-button
   * publish. isChecked() is deliberately not used: these are Polymer custom
   * elements, not <input type=checkbox>, so Playwright's checkbox model does
   * not apply to them and isChecked() throws "Not a checkbox or radio button".
   */
  async isSelected(featureName, optionName, opts = {}) {
    return (await this.selectionControl(featureName, optionName, opts).getAttribute('aria-checked')) === 'true';
  }

  /**
   * Whether the SELECTION control is locked — a Required option, which CPQ
   * auto-selects and refuses to let a user clear.
   *
   * Distinct from isQuantityEditable(): an option can be permanently selected
   * and still have a fixed quantity, or be freely selectable with an editable
   * one. Conflating the two hides which constraint actually fired.
   */
  async isSelectionLocked(featureName, optionName, opts = {}) {
    return (await this.selectionControl(featureName, optionName, opts).getAttribute('aria-disabled')) === 'true';
  }

  /**
   * Attempts to click an option's selection control, whatever kind of control
   * it is.
   *
   * .click() rather than .check()/.uncheck() for the reason above — there is
   * no real input to check. This is a raw ATTEMPT: it does NOT assert that the
   * click changed anything, because "the click was refused" is exactly what
   * several steps are there to prove.
   *
   * WHY IT FORCES BY DEFAULT
   * ------------------------
   * A Required option renders aria-disabled="true", and Playwright's
   * actionability model treats aria-disabled as disabled even on a custom
   * element — verified against this Playwright version with a standalone page:
   * a plain click on <paper-checkbox aria-disabled="true"> waits for "enabled"
   * and times out, while a forced click lands and increments the handler.
   *
   * So without force, the steps that attempt to deselect a locked option would
   * fail on a 30s actionability timeout and never reach the behavior under
   * test — asserting on Playwright's model rather than on CPQ's refusal. The
   * point of those steps is that a real click reaches the app and the APP
   * declines to act on it.
   *
   * setOptionSelected() opts out, because there the control is genuinely
   * expected to be operable and a broken one should fail loudly.
   */
  async toggleOption(featureName, optionName, { force = true, occurrence = 0 } = {}) {
    await this.selectionControl(featureName, optionName, { occurrence }).click({ force });
    await this.waitForNotBusy();
  }

  /** Toggles, then waits for the selection to reach `selected`. */
  async setOptionSelected(featureName, optionName, selected = true, { occurrence = 0 } = {}) {
    if ((await this.isSelected(featureName, optionName, { occurrence })) === selected) return;
    await this.toggleOption(featureName, optionName, { force: false, occurrence });
    await this.waitForSelected(featureName, optionName, selected, { occurrence });
  }

  /**
   * Waits for an option's selection state to settle.
   *
   * Required because selecting an option in a single-select feature makes CPQ
   * deselect its sibling asynchronously — reading both halves immediately
   * after the click catches the old value on the sibling.
   */
  async waitForSelected(
    featureName,
    optionName,
    selected,
    { timeout = 60_000, interval = 250, occurrence = 0 } = {}
  ) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if ((await this.isSelected(featureName, optionName, { occurrence }).catch(() => !selected)) === selected) {
        return true;
      }
      await this.page.waitForTimeout(interval);
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Quantity
  // -------------------------------------------------------------------------

  /** The QUANTITY cell — the first <sb-option-cell> in the row. */
  quantityCell(featureName, optionName, opts = {}) {
    return this.optionRow(featureName, optionName, opts)
      .locator(OPTION_CELL_SELECTOR)
      .filter(VISIBLE)
      .first();
  }

  /**
   * The quantity as the configurator renders it, e.g. "5.00".
   *
   * Read from span#me, not from the cell: the cell's innerText() comes back
   * empty because the value sits in a nested shadow root (see CELL_VALUE_SELECTOR).
   * Returned as text — the app formats to two decimals, so callers compare
   * numerically.
   */
  async quantityValue(featureName, optionName, opts = {}) {
    return (
      await this.quantityCell(featureName, optionName, opts).locator(CELL_VALUE_SELECTOR).first().innerText()
    ).trim();
  }

  /**
   * Activates the click-to-edit quantity cell and returns its input, or
   * undefined when the cell is read-only.
   *
   * Retried, and that is not belt-and-braces. Measured against this org: the
   * first click after a re-render is swallowed often enough to matter — the
   * cell repaints between the hit test and the handler — and a single attempt
   * reports an editable quantity as read-only. Which is a FALSE PASS for the
   * steps that assert a locked quantity, and the worst possible failure mode
   * here.
   *
   * The input is a floating overlay rather than a child of the cell, so it is
   * addressed by focus (see CELL_INPUT_SELECTOR).
   *
   * The per-attempt budget is deliberately short. An editable cell opens its
   * input in well under a second, so the waiting is paid almost entirely by
   * READ-ONLY cells, which have to exhaust every attempt to be sure — and this
   * bundle has nine of them, probed once each for the default-configuration
   * read. A generous per-attempt timeout there costs minutes of wall clock and
   * buys nothing.
   */
  async openQuantityEditor(
    featureName,
    optionName,
    { attempts = 3, perAttempt = 5_000, settle = 1_200, occurrence = 0 } = {}
  ) {
    const input = this.editor.locator(`${CELL_INPUT_SELECTOR}:focus`);

    for (let i = 0; i < attempts; i += 1) {
      await this.quantityCell(featureName, optionName, { occurrence })
        .click({ timeout: 20_000 })
        .catch(() => {});
      try {
        await input.waitFor({ state: 'visible', timeout: perAttempt });
        return input;
      } catch {
        // Either the cell is genuinely read-only or the click was swallowed.
        // Only exhausting the attempts distinguishes the two.
        await this.page.waitForTimeout(settle);
      }
    }
    return undefined;
  }

  /** Closes an open cell editor without committing a change. */
  async closeQuantityEditor() {
    await this.page.keyboard.press('Escape').catch(() => {});
    await this.waitForNotBusy();
  }

  /**
   * Whether an option's quantity can be edited.
   *
   * ONE method handling both shapes, because in this app "locked" and
   * "disabled" are not the same rendering and the spec must not have to know
   * which it got. A read-only quantity renders as static text with NO <input>
   * at all — there is nothing to ask isEditable() about — while an editable
   * one materialises an input on click. So: activate the cell; false when no
   * input appears, false when one appears but is not editable, true otherwise.
   *
   * Never assert editability from a spec by reaching for an input directly.
   * The absence of an input is the common case here, and a spec that looks for
   * one is asserting on a thing that does not exist.
   */
  async isQuantityEditable(featureName, optionName, probe = {}) {
    const input = await this.openQuantityEditor(featureName, optionName, probe);
    if (!input) return false;
    const editable = await input.isEditable().catch(() => false);
    await this.closeQuantityEditor();
    return editable;
  }

  /**
   * Types a quantity the way a person would.
   *
   * fill() is not usable. It sets the DOM value in one shot and Polymer binds
   * its model to the keystroke events a real edit produces, so fill() leaves
   * the box looking correct while the app never registers the change — and the
   * subsequent Save commits an unchanged option. Silent in the UI, and only
   * visible later as the wrong number on the saved line.
   *
   * Select-all, type, then Tab to blur and commit.
   */
  async setQuantity(featureName, optionName, quantity, opts = {}) {
    const input = await this.openQuantityEditor(featureName, optionName, opts);
    if (!input) {
      throw new Error(
        `The quantity cell for "${optionName}" in the "${featureName}" feature never opened an ` +
          'editor. Either the option is not selected (an unselected option\'s quantity is always ' +
          'read-only), or its Product Option carries a fixed SBQQ__Quantity__c, which makes the ' +
          'quantity read-only by design.'
      );
    }
    await input.press('ControlOrMeta+a');
    await input.pressSequentially(String(quantity), { delay: 20 });
    await input.press('Tab');
    await this.waitForNotBusy();
  }

  // -------------------------------------------------------------------------
  // Configuration attributes
  // -------------------------------------------------------------------------

  /**
   * One configuration attribute's <sb-attribute-item>, optionally scoped to
   * the feature it belongs to.
   *
   * WHY `within` EXISTS. A Configuration Attribute carrying
   * SBQQ__Feature__c renders INSIDE that feature's section rather than in the
   * bundle-level block above the feature list. Every other accessor here
   * anchors at the frame, which finds the element either way — so a test using
   * one would pass whether CPQ honoured the feature scoping or not, which is
   * exactly the claim such a test exists to make.
   *
   * CONFIRMED on 2026-07-31 against the Smartwatch bundle: the CHAINED
   * locator resolves it, so no containment probe is needed.
   *
   *   featureSection('Charging Options').locator(item('Outlet Standard'))  -> 1
   *   featureSection('Watch Bands').locator(item('Outlet Standard'))       -> 0
   *   featureSection('Charging Options').locator(item('Size'))             -> 0
   *   editor.locator(item('Outlet Standard'))                              -> 1
   *
   * That is the shadow-piercing rule in the header note: a chained .locator()
   * step re-enters piercing mode even though the attribute sits inside
   * <sb-product-feature>'s shadow root. A single descendant CSS selector would
   * not, and `closest('sb-product-feature')` returns null from inside the
   * shadow root — both were tried and both fail, so neither is used.
   */
  attributeItem(label, { within } = {}) {
    const scope = within ? this.featureSection(within) : this.editor;
    return scope.locator(ATTRIBUTE_ITEM(label)).filter(VISIBLE).first();
  }

  /**
   * Every attribute label in document order — the whole screen by default, or
   * one feature's when `within` is given.
   *
   * The frame-level list includes feature-scoped attributes too, because they
   * are on the screen. A caller wanting only the bundle-level ones subtracts
   * each feature's list, which is what makes "this attribute is NOT
   * bundle-level" an assertion about placement rather than about existence.
   */
  async attributeLabels({ within } = {}) {
    const scope = within ? this.featureSection(within) : this.editor;
    const items = scope.locator(ATTRIBUTE_ITEM_SELECTOR).filter(VISIBLE);
    const labels = [];
    for (let i = 0; i < (await items.count()); i += 1) {
      const label = await items.nth(i).getAttribute('label');
      if (label) labels.push(label.trim());
    }
    return labels;
  }

  /** Whether one attribute renders inside a given feature's section. */
  async isAttributeWithinFeature(featureName, label) {
    return (
      (await this.featureSection(featureName).locator(ATTRIBUTE_ITEM(label)).filter(VISIBLE).count()) > 0
    );
  }

  /**
   * A configuration attribute's <select>.
   *
   * A real <select>, so selectOption() applies — see ATTRIBUTE_ITEM. Named
   * "global" for the bundle-level case it was written for; `within` scopes it
   * to a feature for a feature-scoped attribute.
   */
  globalAttributeSelect(label, opts = {}) {
    return this.attributeItem(label, opts).locator(SELECT_SELECTOR).filter(VISIBLE).first();
  }

  async globalAttributeValue(label, opts = {}) {
    return this.globalAttributeSelect(label, opts).inputValue();
  }

  /**
   * The choices a global attribute's picklist currently offers, as labels.
   *
   * Worth reading rather than assuming, because CPQ CHANGES THE OPTION LIST
   * for a required attribute depending on whether it already has a value.
   * Measured on 2026-07-31: on first entry the list is
   * ["--None--", "120V", "240V"]; after the value is saved and the
   * configurator re-entered it is ["120V", "240V"] — the empty choice is gone,
   * so a required attribute cannot be cleared through the UI once set.
   */
  async globalAttributeOptions(label, opts = {}) {
    return this.globalAttributeSelect(label, opts)
      .locator('option')
      .evaluateAll((options) => options.map((option) => option.textContent.trim()));
  }

  /** Whether the picklist still offers the empty choice (see the note above). */
  async canClearGlobalAttribute(label, opts = {}) {
    return (await this.globalAttributeOptions(label, opts)).includes(ATTRIBUTE_NONE_LABEL);
  }

  /**
   * Selects by the picklist's DISPLAYED LABEL, which is not always its stored
   * value. MEASURED on 2026-07-31: Outlet Standard offers
   * "Type C (Europe)" and stores "TypeC", so a caller passing the stored value
   * here fails with an opaque "did not find some options" timeout. Data files
   * therefore record both, and globalAttributeValue() returns the stored one.
   */
  async setGlobalAttribute(label, value, opts = {}) {
    await this.globalAttributeSelect(label, opts).selectOption({ label: value });
    await this.waitForNotBusy();
  }

  /**
   * Selects the "--None--" choice.
   *
   * Guarded, because the choice is not always on offer: CPQ withholds it from
   * a required attribute that already carries a saved value. Without the guard
   * this surfaces as an opaque 30s selectOption timeout whose call log says
   * only "did not find some options" and names nothing.
   */
  async clearGlobalAttribute(label, opts = {}) {
    if (!(await this.canClearGlobalAttribute(label, opts))) {
      throw new Error(
        `The "${label}" attribute cannot be cleared: its picklist does not offer ` +
          `"${ATTRIBUTE_NONE_LABEL}". CPQ withholds the empty choice from a REQUIRED attribute ` +
          'that already carries a value. Options offered: ' +
          `${(await this.globalAttributeOptions(label, opts)).join(', ')}`
      );
    }
    await this.globalAttributeSelect(label, opts).selectOption(ATTRIBUTE_NONE_VALUE);
    await this.waitForNotBusy();
  }

  // -------------------------------------------------------------------------
  // Text configuration attributes
  //
  // A separate accessor from globalAttributeSelect() ON PURPOSE. A text
  // attribute wraps an <input>, a picklist wraps a <select>, and one accessor
  // quietly handling either would report a MISSING attribute as an empty
  // value — which is the failure mode a configuration-attribute test exists to
  // catch.
  // -------------------------------------------------------------------------

  textAttributeInput(label, opts = {}) {
    return this.attributeItem(label, opts).locator(TEXT_INPUT_SELECTOR).filter(VISIBLE).first();
  }

  async textAttributeValue(label, opts = {}) {
    return this.textAttributeInput(label, opts).inputValue();
  }

  /**
   * Types into a text attribute the way a person would.
   *
   * fill() IS NOT USABLE HERE, for the reason setQuantity() documents: Polymer
   * binds its model to keystroke events, so fill() sets the DOM value in one
   * shot and leaves the box looking correct while the app never registers the
   * change. The subsequent Save then commits the OLD value, with no error
   * anywhere — silent in the UI and visible only later as the wrong string on
   * the saved line.
   *
   * Select-all, type, then Tab to blur and commit.
   */
  async setTextAttribute(label, value, opts = {}) {
    const input = this.textAttributeInput(label, opts);
    await input.click();
    await input.press('ControlOrMeta+a');
    await input.pressSequentially(String(value), { delay: 20 });
    await input.press('Tab');
    await this.waitForNotBusy();
  }

  /**
   * Empties a text attribute.
   *
   * Deliberately a real select-all-and-delete rather than setTextAttribute(''),
   * because pressSequentially('') types nothing at all: the model would never
   * see an edit and the old value would survive the blur.
   */
  async clearTextAttribute(label, opts = {}) {
    const input = this.textAttributeInput(label, opts);
    await input.click();
    await input.press('ControlOrMeta+a');
    await input.press('Delete');
    await input.press('Tab');
    await this.waitForNotBusy();
  }

  // -------------------------------------------------------------------------
  // Option attribute drawers
  // -------------------------------------------------------------------------

  /**
   * The expanded attribute drawer belonging to ONE option row.
   *
   * ANCHORED AT ITS ROW, NOT BY NAME — see DRAWER_ROW_SELECTOR for the
   * measurement and for why a name lookup is a false-pass risk whenever a
   * bundle offers the same product twice.
   */
  optionDrawer(featureName, optionName, opts = {}) {
    return this.optionRow(featureName, optionName, opts)
      .locator(DRAWER_ROW_SELECTOR)
      .locator(OPTION_DRAWER_SELECTOR)
      .filter(VISIBLE)
      .first();
  }

  /** The control that expands/collapses one option's drawer. */
  drawerToggle(featureName, optionName, opts = {}) {
    return this.optionRow(featureName, optionName, opts)
      .locator(DRAWER_TOGGLE_SELECTOR)
      .filter(VISIBLE)
      .first();
  }

  /**
   * Whether an option has a drawer at all.
   *
   * CPQ renders <div id="drawerIcon"> only on options that carry
   * configuration attributes, and <div id="drawerPlaceHolder"> on the rest, so
   * the icon's presence answers the question directly.
   */
  async hasDrawer(featureName, optionName, opts = {}) {
    return (await this.drawerToggle(featureName, optionName, opts).count()) > 0;
  }

  /** Expands one option's drawer. A no-op when it is already open. */
  async openDrawer(featureName, optionName, opts = {}) {
    if (await this.optionDrawer(featureName, optionName, opts).count()) return;

    if (!(await this.hasDrawer(featureName, optionName, opts))) {
      throw new Error(
        `"${optionName}" in the "${featureName}" feature has no attribute drawer — CPQ renders ` +
          'the drawer icon only on options that carry configuration attributes. Check that the ' +
          'org still has the Configuration Attributes this scenario depends on.'
      );
    }

    await this.drawerToggle(featureName, optionName, opts).click();
    await this.waitForNotBusy();
    await this.optionDrawer(featureName, optionName, opts)
      .waitFor({ state: 'visible', timeout: READY_TIMEOUT_MS });
  }

  /** Every attribute label in one option's open drawer, in document order. */
  async drawerFieldLabels(featureName, optionName, opts = {}) {
    const cells = this.optionDrawer(featureName, optionName, opts).locator(OPTION_CELL_SELECTOR);
    const labels = [];
    for (let i = 0; i < (await cells.count()); i += 1) {
      labels.push(
        (await cells.nth(i).locator(DRAWER_FIELD_LABEL_SELECTOR).first().innerText().catch(() => '')).trim()
      );
    }
    return labels;
  }

  /**
   * Sets one attribute inside an option's drawer.
   *
   * The drawer cells are positional in the DOM and their own innerText() is
   * empty (the label lives a shadow root deeper), so the label has to be read
   * out of each cell to find the right index. That read IS the guard the
   * positional lookup needs — the same pairing rationale as
   * ProductSelectionPage.rowIndexOf(). "Hardware Color is always first" holds
   * only until an admin adds a third attribute or changes the column order,
   * and the failure would be a silently mis-set field rather than an error.
   */
  async setDrawerAttribute(featureName, optionName, label, value, opts = {}) {
    const cell = await this.drawerAttributeCell(featureName, optionName, label, opts);
    await cell.locator(SELECT_SELECTOR).first().selectOption({ label: value });
    await this.waitForNotBusy();
  }

  /**
   * The drawer cell carrying one named attribute, opening the drawer first.
   *
   * The single place the label-to-index lookup lives, so the reads below and
   * setDrawerAttribute() cannot drift into disagreeing about which cell a label
   * refers to. The drawer cells are positional in the DOM and their own
   * innerText() is empty (the label lives a shadow root deeper), so the label
   * has to be read out of each cell to find the right index. That read IS the
   * guard the positional lookup needs — the same pairing rationale as
   * ProductSelectionPage.rowIndexOf(). "Material is always first" holds only
   * until an admin adds a fourth attribute or changes the column order, and the
   * failure would be a silently mis-set field rather than an error.
   */
  async drawerAttributeCell(featureName, optionName, label, opts = {}) {
    await this.openDrawer(featureName, optionName, opts);

    const labels = await this.drawerFieldLabels(featureName, optionName, opts);
    const index = labels.indexOf(label);
    if (index === -1) {
      throw new Error(
        `No "${label}" field in the attribute drawer for "${optionName}". ` +
          `Fields present: ${labels.filter(Boolean).join(', ') || '(none)'}`
      );
    }

    return this.optionDrawer(featureName, optionName, opts).locator(OPTION_CELL_SELECTOR).nth(index);
  }

  /** One drawer attribute's stored value (the picklist VALUE, not its label). */
  async drawerAttributeValue(featureName, optionName, label, opts = {}) {
    const cell = await this.drawerAttributeCell(featureName, optionName, label, opts);
    return cell.locator(SELECT_SELECTOR).first().inputValue();
  }

  /**
   * The choices one drawer attribute currently offers, as labels.
   *
   * Worth reading rather than assuming: these are DEPENDENT picklists.
   * MEASURED on 2026-07-31, the Smartwatch Band's Color offers eleven values
   * when Material is "Silicone" and only three when it is "Leather", so a test
   * that picks a replacement Color has to pick one the org is currently
   * offering for that band.
   */
  async drawerAttributeOptions(featureName, optionName, label, opts = {}) {
    const cell = await this.drawerAttributeCell(featureName, optionName, label, opts);
    return cell
      .locator(SELECT_SELECTOR)
      .first()
      .locator('option')
      .evaluateAll((options) => options.map((option) => option.textContent.trim()));
  }

  // -------------------------------------------------------------------------
  // Save / Cancel and the message region
  // -------------------------------------------------------------------------

  /**
   * Every message currently in the configurator's error region, trimmed.
   *
   * Deliberately NOT normalised or truncated: two steps in the solar scenario
   * assert exact CPQ text, and a helper that collapsed whitespace or cut the
   * string would quietly turn those into weaker assertions. Deliberately not a
   * whole-page scrape either — a regex over the page would match the same
   * words rendered anywhere else, including in an option's own name.
   */
  async saveErrors() {
    const messages = this.editor.locator(ERROR_MESSAGE_SELECTOR).filter(VISIBLE);
    const errors = [];
    for (let i = 0; i < (await messages.count()); i += 1) {
      errors.push((await messages.nth(i).innerText()).trim());
    }
    return errors;
  }

  /**
   * Dismisses every message currently in the error region.
   *
   * Needed because CPQ does not clear a rejected Save's toasts when the
   * configuration is fixed — see ERROR_DISMISS_SELECTOR. Without this, a
   * saveErrors() read taken later returns the previous failure and a step that
   * fixed the problem looks like it did not.
   */
  async dismissErrors() {
    const buttons = this.editor.locator(ERROR_DISMISS_SELECTOR).filter(VISIBLE);
    // Dismissing removes elements, so the collection shrinks underneath a
    // loop over nth(). Always take the first one still standing, and stop the
    // moment a click fails to shorten the list — otherwise a close button that
    // does not respond would burn the full budget on every Save.
    for (let guard = 0; guard < 10; guard += 1) {
      const before = await buttons.count().catch(() => 0);
      if (!before) return;
      await buttons.first().click({ timeout: 5_000 }).catch(() => {});
      if ((await buttons.count().catch(() => 0)) >= before) return;
    }
  }

  /**
   * Clicks Save and waits for CPQ to either reject the configuration or exit.
   *
   * CONFIRMED on this org: a rejected Save leaves you in the configurator with
   * the toasts posted; an accepted one returns to the Quote Line Editor. The
   * caller should not assume which happened — read saveErrors(), or isOpen().
   *
   * IMPORTANT: an accepted Save commits the configuration to the EDITOR, not
   * to the database. The quote lines do not exist until the Quote Line Editor
   * itself is saved. Measured: after a successful configurator Save the quote
   * had zero SBQQ__QuoteLine__c rows; after the QLE's Quick Save it had eleven.
   */
  async save() {
    // Clear the region FIRST, so whatever saveErrors() reports afterwards
    // belongs to this Save and not to an earlier one. CPQ leaves a rejected
    // Save's toasts up until the next Save replaces them, so without this a
    // Save that succeeds could still be read as having raised the previous
    // failure's message.
    await this.dismissErrors();
    await this.editor.locator(SAVE_BUTTON_SELECTOR).filter(VISIBLE).first().click();
    return this.waitForSaveOutcome();
  }

  /**
   * Waits until a Save has actually resolved, one way or the other.
   *
   * WAITS ON THE OUTCOME, NOT ON THE SPINNER, AND THAT IS THE WHOLE POINT.
   * A Save has exactly two possible endings — CPQ posts validation messages
   * and keeps you here, or it accepts the configuration and returns to the
   * Quote Line Editor — and this waits for one of them to be true. Waiting on
   * the busy indicator instead is a proxy, and a leaky one: it returned while
   * the overlay was still up and the toasts had not been posted, so a rejected
   * Save read as an empty error region and a constraint that CPQ had correctly
   * enforced looked like a configurator defect. Measured on 2026-07-31.
   *
   * @returns {Promise<'rejected'|'exited'>}
   */
  async waitForSaveOutcome({ timeout = SAVE_TIMEOUT_MS, interval = 500 } = {}) {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      if (!(await this.isOpen())) {
        // Confirmed twice, a beat apart. The screen tears down in stages, so a
        // single negative read can land in a gap where the Save button has
        // gone but the configurator has not — which would report an accepted
        // Save while CPQ was still deciding.
        await this.page.waitForTimeout(1_500);
        if (!(await this.isOpen())) return 'exited';
      }
      if ((await this.saveErrors()).length) {
        // Rejected. Settle briefly before returning: CPQ can post several
        // messages a beat apart, and returning on the first would let a caller
        // assert against a partial set.
        await this.page.waitForTimeout(MESSAGE_SETTLE_MS);
        // Bounded tightly on purpose. The outcome is already known at this
        // point, so this only lets the screen settle before the next action —
        // it must never be able to dominate the run the way an unbounded busy
        // wait can.
        await this.waitForNotBusy({ timeout: 30_000 });
        return 'rejected';
      }
      await this.page.waitForTimeout(interval);
    }

    throw new Error(
      `The configurator's Save never resolved within ${timeout}ms: it neither posted a ` +
        'validation message nor returned to the Quote Line Editor. The screen is most likely ' +
        'still processing — check the trace for the loading overlay.'
    );
  }

  /** Leaves the configurator without committing anything. */
  async cancel() {
    await this.editor.locator(CANCEL_BUTTON_SELECTOR).filter(VISIBLE).first().click();
    await this.waitForNotBusy();
  }

  /**
   * Every option's state on the active tab's features, for the default-config
   * read.
   *
   * Returned as data rather than asserted here: a page class reports what the
   * screen says, and the spec compares it against the data file.
   *
   * Uses the BULK_PROBE budget for the editability check — see that constant
   * for why a shorter budget is safe HERE and nowhere else. Callers that need
   * the careful budget can override it, but should not: this method exists to
   * read an UNTOUCHED configuration, and a caller reading a mutated one should
   * be calling isQuantityEditable() per option instead.
   *
   * @param {Array<{feature: string, option: string}>} options
   * @param {object} [opts]
   * @param {object} [opts.probe] overrides for the editability probe budget
   */
  async readConfiguration(options, { probe = BULK_PROBE } = {}) {
    const state = {};
    for (const { feature, option, occurrence = 0, key } of options) {
      // Keyed by `key` when given, because the option NAME is not always
      // unique: a bundle can offer the same product twice in one feature, and
      // keying both on the product name would make the second read silently
      // overwrite the first — reporting one row's state as though it were
      // both. Callers passing an occurrence must pass a key with it.
      const stateKey = key || option;
      if (Object.prototype.hasOwnProperty.call(state, stateKey)) {
        throw new Error(
          `readConfiguration() was asked to read "${stateKey}" twice. Two rows share a product ` +
            'name, so pass a distinct `key` (and the matching `occurrence`) for each of them.'
        );
      }
      state[stateKey] = {
        selected: await this.isSelected(feature, option, { occurrence }),
        selectionLocked: await this.isSelectionLocked(feature, option, { occurrence }),
        quantity: await this.quantityValue(feature, option, { occurrence }),
        quantityEditable: await this.isQuantityEditable(feature, option, { ...probe, occurrence }),
      };
    }
    return state;
  }
}

module.exports = { ProductConfigurationPage };
