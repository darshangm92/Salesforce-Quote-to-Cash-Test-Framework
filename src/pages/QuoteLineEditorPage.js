// src/pages/QuoteLineEditorPage.js
//
// The core CPQ surface: the classic Quote Line Editor (QLE). This is a
// Visualforce page (SBQQ__sb), not a native Lightning component, so it's
// reached via a direct navigation rather than BasePage.openRecord(), and
// every locator below goes through the iframe frameLocator instead of `page` directly.
//
// GROUP SCOPING
// -------------
// On a grouped quote (SBQQ__LineItemsGrouped__c = true) the editor renders one
// section per SBQQ__QuoteLineGroup__c, each with its own header, its own Add
// Products button, and its own line table. A page-level `locator('tr', {
// hasText: productName })` matches in *every* group at once, so the moment a
// product appears in two groups every per-line action becomes ambiguous and
// Playwright throws on strict-mode violation — or worse, silently edits the
// wrong group's line.
//
// So: `groupSection(groupName)` is the anchor, and every per-line method takes
// the group name as its first argument. Nothing here reaches across groups.
//
// GROUP SCOPING IS OPTIONAL, BECAUSE NOT EVERY QUOTE HAS GROUPS
// -------------------------------------------------------------
// An amendment quote (SBQQ__LineItemsGrouped__c = false) renders one flat line
// table with no <div class="group"> anywhere on the page. Passing a group name
// there would resolve to nothing and every per-line lookup would time out.
//
// So the anchor is `scope(groupName)`: a group section when a name is given,
// and the editor frame itself when the name is null or undefined. Every
// per-line method routes through it, so callers on a flat quote pass null and
// callers on a grouped quote pass the group name — one class, both shapes, and
// the grouped path is byte-for-byte the behaviour it always had.
//
// THE EDITOR IS A SHADOW-DOM APP — READ THIS BEFORE ADDING A SELECTOR
// -------------------------------------------------------------------
// Inside the iframe the whole editor is a single Polymer custom element,
// <sb-page-container>, and everything below it lives in nested shadow roots.
// Consequences, all confirmed against this org:
//
//   * Playwright's CSS engine pierces open shadow roots for simple selectors,
//     which is why `div.group`, getByRole and getByPlaceholder all work.
//   * `element.innerHTML` and `evaluateAll('*')` do NOT traverse shadow roots.
//     Any DevTools-style dump of this page comes back as an empty shell — that
//     is expected, not a broken probe.
//   * Descendant chains that cross a shadow boundary are unreliable. A locator
//     can resolve a row and then fail to find a control *inside* that row when
//     the control sits in a deeper shadow root. Prefer one flat selector, or
//     getByRole scoped to the nearest shadow host, over long parent > child
//     chains.
//   * The app renders desktop and mobile copies of the same UI and hides one
//     with CSS, so many selectors match twice. Filter on visibility, not
//     .first() — the hidden copy usually comes first in document order.
const { BasePage } = require('./BasePage');

// ---------------------------------------------------------------------------
// Org-specific constants. These are the only things that should need changing
// when the managed-package markup or the automation user's settings differ.
//
// Everything marked CONFIRMED was read off this org's live DOM. Everything
// marked PLACEHOLDER still needs a discovery pass — see README Section 5.
// ---------------------------------------------------------------------------

// CONFIRMED. Reaching the QLE through Lightning ("Edit Lines") renders TWO
// Visualforce iframes, both named vfFrameId_<timestamp> and both titled
// "accessibility title" — so neither name nor title distinguishes them:
//
//   height="22px"  scrolling="no"   /apex/QuoteSave  <- the "Recalculating..." strip
//   height="100%"  scrolling="yes"  /apex/sb         <- the editor itself
//
// The old `iframe[title*="Quote"], iframe[name^="vfFrameId"]` matched both and
// failed strict mode on every action. Selecting by src is not an option: the
// iframes carry no src attribute, because Lightning navigates them in script.
// scrolling="yes" is the discriminator — the status strip never scrolls.
const EDITOR_FRAME_SELECTOR = 'iframe[name^="vfFrameId"][scrolling="yes"]';

// CONFIRMED. Each quote line group renders as <div class="group --desktop">
// holding the group header and that group's line table.
const GROUP_SECTION_SELECTOR = 'div.group';

// CONFIRMED. A quote line renders as <sf-le-table-row class="row">, inside
// <sf-standard-table> with an <sf-le-table-header> above it. Its shadow text
// reads like:
//
//   "1 DOORSENSOR Door Sensor 1.00 $40.00 $40.00 $40.00"
//    ^  ^          ^           ^     ^
//    #  code       name        qty   list price ...
const LINE_ROW_SELECTOR = 'sf-le-table-row';
const LINE_TABLE_HEADER_SELECTOR = 'sf-le-table-header';
// The container holding the header and every line row. Used only to scope a
// screenshot: a full-page shot of the QLE is mostly Lightning chrome and the
// price columns come out unreadable. Nothing asserts on it, and
// src/utils/evidence.js falls back to a page shot if it resolves to nothing,
// so a wrong guess here costs image framing rather than a test.
const LINE_TABLE_SELECTOR = 'sf-standard-table';

// Evidence the editor has finished painting, for either shape of quote.
//
// A grouped quote paints div.group; an ungrouped one — which is what CPQ
// generates for an amendment — paints the line table with no group section at
// all, so waiting on div.group there would burn the full readiness timeout on
// an element that is never coming.
//
// The grouped path is unchanged by this: a parent precedes its children in
// document order and the header sits INSIDE the group, so on a grouped quote
// .first() still resolves to div.group exactly as it did before.
const EDITOR_PAINTED_SELECTOR = `${GROUP_SECTION_SELECTOR}, ${LINE_TABLE_HEADER_SELECTOR}`;

// CONFIRMED. Per-line action buttons render inside <sf-line-actions> as
// <button name="Add To Favorites" | "Reconfigure Line" | "Clone Line" |
// "Delete Line" | "View Rate Card">.
//
// "Reconfigure Line" reopens the bundle configurator, and CPQ renders it only
// on a BUNDLE PARENT line — the option lines beneath it get a shorter action
// set without it. So its presence identifies the parent as reliably as
// SBQQ__RequiredBy__c being null does on the record.
//
// Addressed by the name attribute, not by role+name: these buttons carry no
// text and no aria-label, so their accessible name is empty and
// getByRole('button', { name: 'Reconfigure Line' }) matches nothing.
const LINE_ACTIONS_SELECTOR = 'sf-line-actions';
const RECONFIGURE_LINE_ACTION = 'Reconfigure Line';

// CONFIRMED. Each cell in a line row carries a `field` attribute holding the
// real SBQQ API name, e.g.
//
//   <div class="container td sf-le-table-cell …" field="SBQQ__ProductCode__c">DOORSENSOR</div>
//
// That is far better than counting columns: column order is configurable per
// org, but the API name is not. Cells are marked `focusable` and are
// click-to-edit — the row shows static text ("1.00") and an <input> only
// exists once the cell has been activated.
//
// Note the two `input#myinput.numberInput` elements present in a group belong
// to the GROUP header (Additional Disc. % and Subscription Term), not to any
// line. Editing one of those never changes a line's quantity.
// Body cell for one field. The .sf-le-table-cell class is what excludes the
// column header, which carries the SAME field attribute — the Quantity header
// is also div[field="SBQQ__Quantity__c"], holding the text "QUANTITY".
const LINE_CELL = (apiName) => `div.sf-le-table-cell[field="${apiName}"]`;
const LINE_PRODUCT_CODE_FIELD = 'SBQQ__ProductCode__c';
const LINE_PRODUCT_NAME_FIELD = 'SBQQ__ProductName__c';
const LINE_QUANTITY_FIELD = 'SBQQ__Quantity__c';
const LINE_ADDITIONAL_DISCOUNT_FIELD = 'SBQQ__AdditionalDiscount__c';
const LINE_LIST_PRICE_FIELD = 'SBQQ__ListPrice__c';
const LINE_NET_PRICE_FIELD = 'SBQQ__NetPrice__c';
const LINE_NET_TOTAL_FIELD = 'SBQQ__NetTotal__c';

// CONFIRMED. Start Date and Subscription Term each appear THREE times in the
// editor: once in the quote-level "Quote Information" panel at the top, and
// once inside each quote line group's header block. They are different fields
// with different meanings — the quote-level values are the ones that apply
// across all groups, which is what this journey sets.
//
// The cells are laid out as nested CSS-table divs, and that nesting is a trap:
// an outer div.td wraps the whole field block and therefore contains the text
// of *every* label in it. So `locator('div.td').filter({ hasText: 'Subscription
// Term' }).first()` matches that wrapper, not the Subscription Term cell, and
// `.locator('input').first()` inside it returns the Start Date box. Both
// setters silently resolved to the same input.
//
// The fix is to exclude the wrapper by requiring the cell to contain its own
// label and NOT its siblings' — see quoteFieldInput() below.
const START_DATE_LABEL = 'Start Date';
const SUBSCRIPTION_TERM_LABEL = 'Subscription Term';
const HEADER_CELL_SELECTOR = 'div.td';

// CONFIRMED by walking the ancestor chain of all three "Start Date" labels.
// The quote-level and group-level copies are identical from the label up
// through <div class="td"> / <sb-field-set-table-item> / <sb-group> — they
// diverge at exactly one container:
//
//   group-level:  ... div.groupFieldsContainer.datatable  <  header
//   quote-level:  ... div.quoteFieldsContainer            <  sb-le-group-layout
//
// That single class is the only reliable discriminator. Document order is NOT
// one: the quote-level panel renders visually above the groups but its cells
// did not match a plain div.td filter at all, so `.first()` silently selected
// One-time Purchases' Start Date and the values saved onto the group record
// instead of the quote.
const QUOTE_FIELDS_CONTAINER_SELECTOR = 'div.quoteFieldsContainer';
const GROUP_FIELDS_CONTAINER_SELECTOR = 'div.groupFieldsContainer';

// Every label that shares a field block, used to disambiguate the nesting
// above. Order does not matter; completeness does — a label missing from this
// list leaves the wrapper matchable again.
const HEADER_FIELD_LABELS = [
  'Start Date',
  'End Date',
  'Subscription Term',
  'Additional Disc. (%)',
  'Optional',
];

// ---------------------------------------------------------------------------
// The quote line drawer
// ---------------------------------------------------------------------------
//
// THE TOGGLE IS THE CHEVRON AT THE ROW'S TRAILING EDGE.
// ------------------------------------------------------
// CONFIRMED from the org's UI on 2026-08-02. Every line row ends, AFTER the
// Net Total column, with a chevron control: `>` while the drawer is collapsed
// and `v` while it is expanded. Clicking it toggles the drawer, which then
// renders full width BELOW the row.
//
// The first version of this block guessed `#drawerIcon`, carried over from the
// bundle configurator's option drawer on the assumption that CPQ renders the
// two the same way. IT DOES NOT — a Quote Line Editor row has no such icon,
// and every drawer method failed at the first step with
//
//   Error: The line for "FIREWALL" ... has no drawer toggle (#drawerIcon).
//
// Only the TOGGLE was wrong. The drawer's POSITION — a following sibling of
// the row rather than a child of it — is the same as the configurator's, so
// DRAWER_WRAPPER_SELECTOR below is unchanged and is now corroborated by the
// full-width block the screenshot shows beneath the expanded row.
//
// Matched by SHAPE rather than by one selector, because the chevron's markup
// is not yet dumped: an icon-ish element at the trailing edge of the row.
// Ordered from most to least specific, and the LAST visible match is taken —
// the control sits after every data column, so trailing position is the one
// property that is certain.
const DRAWER_TOGGLE_SELECTOR = [
  'iron-icon[icon*="chevron" i]',
  'paper-icon-button[icon*="chevron" i]',
  '[class*="chevron" i]',
  '[class*="expand" i]',
  '[class*="drawer" i]',
  'iron-icon',
  'paper-icon-button',
].join(', ');

// WHY THE DRAWER IS REACHED FROM ITS ROW AND NEVER BY NAME
// --------------------------------------------------------
// MEASURED on the configurator 2026-07-31, and the reasoning carries over:
//
//   * The drawer is NOT a child of its row. It is rendered as the row's next
//     SIBLING, which is why row.locator(<drawer>) returns zero matches. That
//     is a DOM-shape fact, not a shadow-boundary one.
//   * A frame-level lookup goes ambiguous the moment two rows carry the same
//     product, and .first() then reads the wrong drawer while passing.
//     Row-derived reaching gives each row its own drawer with no ordinal
//     alignment to maintain.
//   * `following-sibling::<custom-element-name>` matches ZERO — XPath does not
//     resolve the custom element name here — so the step is deliberately
//     UNTYPED and the drawer is identified by its CONTENT from there.
const DRAWER_WRAPPER_SELECTOR = 'xpath=./following-sibling::*[1]';

// HOW A DRAWER IS TOLD APART FROM THE NEXT ROW.
// ---------------------------------------------
// When the drawer is collapsed, the row's next sibling IS the next line row,
// so "the sibling exists" proves nothing and "the sibling is visible" is true
// either way. The drawer is therefore identified by a label only it carries.
// Playwright's hasText is a case-insensitive substring match, which matters
// here because the app renders these labels uppercase through CSS while the
// DOM holds them in title case.
const DRAWER_SIGNATURE_LABEL = 'Pricing Method';

// One field inside the drawer, addressed by its visible LABEL — matching
// QuotePage.setField, because the drawer renders labels rather than API names.
// The cell element is not yet dumped, so this matches by shape and the label
// filtering does the real work.
const DRAWER_CELL_SELECTOR = 'sb-option-cell, .drawerCell, sb-line-cell, div.td, td';

// Label -> API name, for traceability only. NOT used to build selectors: the
// drawer is addressed by label because that is what it renders. This map is
// what lets a reader connect a drawer reading to the field an assertion names,
// and it is why a spec can assert on the record while capturing the drawer.
//
// CONFIRMED from this org's drawer on 2026-08-02, read off an expanded row.
// Thirteen fields in three columns:
//
//   Pricing Method   Original Price   Special Price
//   Optional         Unit Cost        Regular Unit Price
//   Package Prod...  Markup           Customer Unit Price
//   Start Date       End Date         Partner Discount
//   Subscription Term
//
// TWO CORRECTIONS TO WHAT THIS FILE PREVIOUSLY CLAIMED. Partner Discount IS on
// the drawer — it was recorded as absent — and Start Date, End Date and
// Subscription Term are on it too. What genuinely is NOT on the drawer is Net
// Unit Price, which lives in the line TABLE.
//
// That last point is why the waterfall assertions belong in the API and this
// capture is the human-readable companion rather than the check: a UI-driven
// waterfall check would skip Net Unit Price silently and report a clean pass
// having never looked at it. The record carries every field regardless.
const DRAWER_FIELD_LABELS = {
  'Pricing Method': 'SBQQ__PricingMethod__c',
  'Original Price': 'SBQQ__OriginalPrice__c',
  'Special Price': 'SBQQ__SpecialPrice__c',
  'Optional': 'SBQQ__Optional__c',
  'Unit Cost': 'SBQQ__UnitCost__c',
  'Regular Unit Price': 'SBQQ__RegularPrice__c',
  'Package Product Code': 'SBQQ__PackageProductCode__c',
  'Markup': 'SBQQ__Markup__c',
  'Customer Unit Price': 'SBQQ__CustomerPrice__c',
  'Start Date': 'SBQQ__StartDate__c',
  'End Date': 'SBQQ__EndDate__c',
  'Partner Discount': 'SBQQ__PartnerDiscount__c',
  'Subscription Term': 'SBQQ__SubscriptionTerm__c',
};

// The Markup control is COMPOUND: an amount plus a type selector offering %
// and USD, and the type decides WHICH quote line field receives the value.
//
// MEASURED in this org: a unit cost of 2100 with a markup of 100 USD produced
// a special price of 2200. 100 PERCENT would have produced 4200. So the type
// is not a display preference — it selects between SBQQ__MarkupAmount__c and
// SBQQ__MarkupRate__c, and leaving it to the control's default is leaving the
// assertion to chance.
const MARKUP_LABEL = 'Markup';
const MARKUP_TYPE_USD = 'USD';
const MARKUP_TYPE_PERCENT = '%';
const MARKUP_TYPES = [MARKUP_TYPE_USD, MARKUP_TYPE_PERCENT];

// CONFIRMED from the org's UI on 2026-08-02. An editable drawer cell carries a
// class containing "Editable", which is what distinguishes it from the
// read-only cells beside it — Unit Cost and Original Price render as plain
// text in the same grid.
//
// AND THE CELL IS CLICK-TO-EDIT, WHICH IS THE WHOLE TRAP HERE. At rest the
// cell shows only its label; the input box and the % / USD type selector DO
// NOT EXIST in the DOM until the empty area BELOW the label is clicked. The
// first version of setMarkup() looked for the <select> straight away, found
// nothing, and reported that the type control "rendered as neither a <select>
// nor a button" — which was true, and the reason was that nothing had opened
// the editor yet.
const DRAWER_EDITABLE_CLASS_SELECTOR = '[class*="Editable" i]';

// TWO KINDS OF CHECKBOX LIVE IN THIS APP, AND THEY ARE READ DIFFERENTLY.
//
// The CONFIGURATOR's selection controls are Polymer custom elements —
// <paper-checkbox> and <paper-radio-button> — where Locator.isChecked() THROWS,
// because these are custom elements rather than real inputs, and state comes
// from aria-checked instead.
//
// The QUOTE LINE DRAWER's Optional control is NOT one of those. MEASURED on
// 2026-08-02: a lookup for paper-checkbox/paper-radio-button under the drawer's
// "Optional" field found nothing, while the field is plainly a checkbox on
// screen. So the selector covers both shapes and the state read falls back
// from aria-checked to the input's own checked property.
const CHECKBOX_SELECTOR = [
  'paper-checkbox',
  'paper-radio-button',
  'input[type="checkbox"]',
  '[role="checkbox"]',
].join(', ');

// A THIRD KIND OF CHECKBOX, AND THE ONE THE GROUP HEADER USES.
//
// CONFIRMED from the org's markup on 2026-08-02. It is built entirely out of
// divs — no <input>, no role, no aria-checked, and not a Polymer element
// either, which is why every one of the four selectors above missed it:
//
//   <div id="item" class="label sf-tooltip" tooltip="Optional">Optional</div>
//   <div id="checkboxContainer">
//     <div id="checkbox" class="">
//       <div id="checkmark" class="hidden"></div>
//     </div>
//   </div>
//
// TWO CONSEQUENCES, both load-bearing:
//
//   1. The LABEL is found by its `tooltip` attribute rather than by text.
//      The visible text is the same string, but the attribute is exact and
//      unaffected by the CSS that uppercases labels elsewhere in this app.
//   2. STATE IS THE `hidden` CLASS ON #checkmark — checked means the checkmark
//      is NOT hidden. There is no attribute to read and isChecked() does not
//      apply, so a caller that treats "the element exists" as "it is ticked"
//      gets it wrong every time.
//
// The group header renders one of these PER GROUP, so every lookup is scoped
// to a group section. An editor-wide lookup finds two and would flag whichever
// Playwright resolved first.
const TOOLTIP_LABEL = (label) => `[tooltip="${label}"]`;
const CUSTOM_CHECKBOX_SELECTOR = '#checkboxContainer';
const CUSTOM_CHECKMARK_SELECTOR = '#checkmark';
const CUSTOM_CHECKMARK_HIDDEN_CLASS = 'hidden';

// CONFIRMED. Rendered as <paper-button role="button">, so getByRole finds it.
const ADD_PRODUCTS_LABEL = 'Add Products';
const CALCULATE_LABEL = 'Calculate';
const SAVE_LABEL = 'Save';
// [VERIFY] The editor's Cancel button, used to leave without committing.
// Unconfirmed against this org — cancel() falls back to navigating to the
// quote record page when it is absent, so a wrong label here degrades to a
// slower exit rather than a failure.
const CANCEL_LABEL = 'Cancel';
// Commits header edits without leaving the editor. Save navigates away, which
// is why the header steps use Quick Save and only the final commit uses Save.
const QUICK_SAVE_LABEL = 'Quick Save';

// [VERIFY] The QLE's Start Date field is a Visualforce input whose accepted
// format follows the *running user's Locale* in Setup — not ISO-8601. Typing
// an ISO date into an en-US input either fails validation or, worse, silently
// parses to the wrong day. Confirm the automation user's Locale and set this
// to match; 'M/D/YYYY' is en-US (English/United States).
// Supported values: 'M/D/YYYY' | 'D/M/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD'.
const START_DATE_INPUT_FORMAT = 'M/D/YYYY';

// CONFIRMED. The editor's busy state is <sf-loading-spinner id="spinner"
// show="true">, and while show is true it covers the page and intercepts
// pointer events — every click during that window fails with
// "<sf-loading-spinner> intercepts pointer events" rather than anything that
// names the real cause. Waiting on the attribute (not on visibility) is what
// makes clicks reliable.
const BUSY_SELECTOR = 'sf-loading-spinner#spinner[show="true"], .calculating, [data-calculating="true"]';
const CALCULATION_TIMEOUT_MS = 120_000;

// The QLE is a heavyweight Polymer app behind a Visualforce iframe; on this
// org it takes well over a minute to become interactive on a cold load. That
// is a property of the product, not of the network, so the readiness wait has
// to be generous.
const EDITOR_READY_TIMEOUT_MS = 180_000;

/** Renders a Date in the format the QLE's date input expects (see the constant above). */
function formatDateForInput(date, format = START_DATE_INPUT_FORMAT) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const pad = (n) => String(n).padStart(2, '0');

  switch (format) {
    case 'M/D/YYYY': return `${m}/${d}/${y}`;
    case 'D/M/YYYY': return `${d}/${m}/${y}`;
    case 'DD/MM/YYYY': return `${pad(d)}/${pad(m)}/${y}`;
    case 'YYYY-MM-DD': return `${y}-${pad(m)}-${pad(d)}`;
    default:
      throw new Error(
        `Unsupported START_DATE_INPUT_FORMAT "${format}" in QuoteLineEditorPage. ` +
          "Add it to formatDateForInput() rather than formatting the date at the call site."
      );
  }
}

class QuoteLineEditorPage extends BasePage {
  constructor(page) {
    super(page);
    // See EDITOR_FRAME_SELECTOR — two vfFrameId iframes exist and only one is
    // the editor.
    this.editor = page.frameLocator(EDITOR_FRAME_SELECTOR);
  }

  /**
   * Waits until the editor has painted its groups and is no longer busy.
   *
   * Call this after any navigation into the QLE. Without it the first action
   * races the loading spinner and fails with a pointer-interception error that
   * names the spinner rather than the thing you were trying to click.
   *
   * @param {object}  [options]
   * @param {boolean} [options.allowEmpty=false] wait on the toolbar instead of
   *        on rendered lines, for a quote that has none yet.
   *
   * WHY allowEmpty EXISTS, AND WHY IT IS OPT-IN
   * -------------------------------------------
   * An EMPTY UNGROUPED quote paints NEITHER div.group (no groups) NOR
   * sf-le-table-header (no line table yet), so the default signal never
   * resolves and this burns its full 180s on an element that is never coming.
   * Measured against this org on 2026-07-30, on a freshly seeded quote with
   * SBQQ__LineItemsGrouped__c = false.
   *
   * It is not folded into the default because the toolbar paints well before
   * the groups do — accepting it unconditionally would let a grouped quote
   * report ready mid-render, the exact race this wait exists to prevent.
   *
   * The toolbar is waited on through addProductsButton() rather than through a
   * selector of its own, so readiness means "the control the caller is about
   * to click is ready" instead of a proxy for it. The <sb-custom-action>
   * wrapper is NOT usable here: it is a zero-box shadow host, so Playwright
   * reports it hidden forever even while its button is plainly on screen.
   */
  async waitForEditorReady({ allowEmpty = false } = {}) {
    if (allowEmpty) {
      await this.addProductsButton(null)
        .waitFor({ state: 'visible', timeout: EDITOR_READY_TIMEOUT_MS });
    } else {
      await this.editor
        .locator(EDITOR_PAINTED_SELECTOR)
        .first()
        .waitFor({ state: 'visible', timeout: EDITOR_READY_TIMEOUT_MS });
    }
    await this.waitForCalculation();
  }

  // Navigates directly to the VF page (not a Lightning record URL) since
  // the QLE isn't a Lightning component. Journeys usually arrive here via
  // QuotePage.openLineEditor() instead, which is the path a user takes.
  async open(instanceUrl, quoteId) {
    await this.page.goto(`${instanceUrl}/apex/SBQQ__sb?id=${quoteId}`);
    await this.waitForLightningReady();
  }

  // -------------------------------------------------------------------------
  // Quote header
  // -------------------------------------------------------------------------

  /**
   * The cell holding exactly one header field, anywhere in the editor.
   *
   * `hasText` alone is not enough: the field block's outer div.td contains
   * every sibling label too, so it matches whichever label you ask for. Adding
   * `hasNotText` for the siblings excludes that wrapper and leaves only the
   * cell that owns the label.
   *
   * @param {string} label
   * @param {import('@playwright/test').Locator} [scope] group section, or the
   *        whole editor when omitted
   */
  headerFieldCell(label, scope) {
    let cells = (scope || this.editor).locator(HEADER_CELL_SELECTOR).filter({ hasText: label });
    for (const other of HEADER_FIELD_LABELS) {
      // Skip labels that overlap this one as substrings — excluding them would
      // exclude the cell we want.
      if (other === label || other.includes(label) || label.includes(other)) continue;
      cells = cells.filter({ hasNotText: other });
    }
    return cells;
  }

  /**
   * A field in the top "Quote Information" panel — the quote-level value that
   * applies across every group, and the one this journey sets.
   *
   * Scoped to div.quoteFieldsContainer, which is the only thing that separates
   * it from the per-group copies of the same field. Do not replace this with
   * an ordering assumption: `.first()` over unscoped cells resolves to a
   * group's field and writes to SBQQ__QuoteLineGroup__c instead of the quote —
   * a failure that looks completely correct in the UI.
   */
  quoteFieldInput(label) {
    return this.headerFieldCell(label, this.editor.locator(QUOTE_FIELDS_CONTAINER_SELECTOR))
      .first()
      .locator('input')
      .first();
  }

  /** The same field as it appears on one group's header block. */
  groupFieldInput(groupName, label) {
    return this.headerFieldCell(
      label,
      this.groupSection(groupName).locator(GROUP_FIELDS_CONTAINER_SELECTOR)
    )
      .first()
      .locator('input')
      .first();
  }

  startDateInput() {
    return this.quoteFieldInput(START_DATE_LABEL);
  }

  /**
   * Types a value into a Polymer-bound input the way a person would.
   *
   * fill() is not usable here. It sets the DOM value in one shot, and Polymer
   * binds its model to the keystroke events that a real edit produces — so
   * fill() leaves the field *looking* correct while the app's internal model
   * stays empty, and the subsequent save commits an unchanged record. That
   * failure is silent in the UI and only shows up as an empty field on the
   * saved object.
   *
   * Select-all then type, then Tab to blur and commit.
   */
  async typeInto(input, value) {
    await input.click();
    await input.press('ControlOrMeta+a');
    await input.pressSequentially(String(value), { delay: 20 });
    await input.press('Tab');
  }

  /** @param {Date} date — formatted per the automation user's locale, see the constant. */
  async setStartDate(date) {
    await this.typeInto(this.startDateInput(), formatDateForInput(date));
    await this.waitForCalculation();
  }

  subscriptionTermInput() {
    return this.quoteFieldInput(SUBSCRIPTION_TERM_LABEL);
  }

  /** Quote-level Start Date as the editor currently displays it. */
  async startDateValue() {
    return this.startDateInput().inputValue();
  }

  /** Quote-level Subscription Term as the editor currently displays it. */
  async subscriptionTermValue() {
    return this.subscriptionTermInput().inputValue();
  }

  /** The value formatDateForInput() would produce — for comparing against the UI. */
  static displayDate(date) {
    return formatDateForInput(date);
  }

  async setSubscriptionTerm(term) {
    await this.typeInto(this.subscriptionTermInput(), term);
    await this.waitForCalculation();
  }

  // -------------------------------------------------------------------------
  // Group scoping — the anchor for everything per-line
  // -------------------------------------------------------------------------

  /**
   * The container for one quote line group. Every per-line locator below is
   * built beneath this, which is what keeps a product that appears in two
   * groups from matching twice.
   */
  groupSection(groupName) {
    return this.editor
      .locator(GROUP_SECTION_SELECTOR)
      .filter({ hasText: groupName })
      .first();
  }

  /**
   * The container every per-line locator below is built beneath.
   *
   * With a group name: that group's section, which is what keeps a product
   * appearing in two groups from matching twice.
   *
   * Without one (null/undefined): the editor frame itself. An ungrouped quote
   * has no group sections at all, so there is nothing narrower to scope to —
   * and nothing to disambiguate either, since a flat quote renders exactly one
   * line table.
   *
   * Returning the frameLocator rather than some wrapper element is deliberate.
   * Every method that routes through here uses only .locator() and
   * .getByRole(), both of which a FrameLocator exposes, so the ungrouped path
   * cannot fail on a container selector that turns out not to wrap the line
   * table — a real risk in a shadow-DOM app where descendant chains across
   * shadow boundaries are unreliable (see the header note).
   */
  scope(groupName) {
    return groupName ? this.groupSection(groupName) : this.editor;
  }

  /** How to name the scope in an error message, for either shape of quote. */
  static describeScope(groupName) {
    return groupName ? `group "${groupName}"` : 'the (ungrouped) editor';
  }

  /**
   * Add Products renders per group header on a grouped quote, so this must be
   * relative to the group section — a page-level getByRole() would match every
   * group's button and add products to whichever one Playwright resolved
   * first. On a flat quote there is one button and the editor is the scope.
   */
  addProductsButton(groupName) {
    // .filter({ visible: true }).first() is required by the ungrouped path and
    // harmless to the grouped one. The app renders desktop and mobile copies
    // of the same UI and hides one with CSS (see the header note), so an
    // editor-wide getByRole matches twice and .click() dies on strict mode.
    // Scoping to a group section already narrowed that to one; scoping to the
    // whole editor does not.
    return this.scope(groupName)
      .getByRole('button', { name: ADD_PRODUCTS_LABEL })
      .filter({ visible: true })
      .first();
  }

  /** Opens the product selection screen for one group (see ProductSelectionPage). */
  async openAddProducts(groupName) {
    await this.addProductsButton(groupName).click();
    await this.waitForLightningReady();
  }

  /** All line rows in one group, or in the whole editor when groupName is null. */
  lineRows(groupName) {
    return this.scope(groupName).locator(LINE_ROW_SELECTOR).filter({ visible: true });
  }

  /**
   * How many lines one group currently holds.
   *
   * Counts product-code cells rather than sf-le-table-row elements: one cell
   * per line, and the column header is excluded by the .sf-le-table-cell class.
   */
  async lineCount(groupName) {
    await this.waitForLines(groupName);
    return this.lineFieldCells(groupName, LINE_PRODUCT_CODE_FIELD).count();
  }

  /**
   * All body cells for one field, in line order.
   *
   * The `.sf-le-table-cell` class is what separates body cells from the column
   * headers, which carry the SAME field attribute — the header for Quantity is
   * also `div[field="SBQQ__Quantity__c"]`, holding the text "QUANTITY".
   *
   * The visibility filter matters for the ungrouped scope and is a no-op for
   * the grouped one. Scoping to a group section implicitly picked the desktop
   * copy of the UI (div.group.--desktop); scoping to the whole editor picks up
   * the CSS-hidden mobile copy too, which would double every count and, worse,
   * break the positional pairing between the product-code cells and the
   * quantity cells that lineCell() depends on.
   *
   * Playwright treats an element scrolled out of the viewport as visible, so
   * this filters the hidden copy without dropping rows below the fold.
   */
  lineFieldCells(groupName, apiName) {
    return this.scope(groupName).locator(LINE_CELL(apiName)).filter({ visible: true });
  }

  /**
   * Position of a line within its group, matched on product code.
   *
   * Positional rather than `sf-le-table-row:has(...)`, because :has() cannot
   * cross a shadow boundary: Playwright's chained locators pierce open shadow
   * roots, but a single CSS selector containing :has() is evaluated within one
   * tree scope, and the cells live inside the row element's shadow root. The
   * :has() form therefore matched nothing at all.
   *
   * Cells for a given field come back in line order, so the nth product-code
   * cell and the nth quantity cell belong to the same line — the same pairing
   * the product selection grid uses.
   */
  /**
   * Waits until at least one line is rendered in the group.
   *
   * Required before any allInnerTexts()/count() read: those resolve against
   * whatever matches at that instant and do NOT auto-wait, so reading straight
   * after a Quick Save — while the editor is still rebuilding its line table —
   * comes back empty and looks like the lines were never added.
   */
  async waitForLines(groupName, timeout = 60_000) {
    const cells = this.lineFieldCells(groupName, LINE_PRODUCT_CODE_FIELD);
    await cells.first().waitFor({ state: 'visible', timeout });

    // Visible is not the same as populated. The cells appear before their
    // text is bound, so allInnerTexts() can come back as a list of empty
    // strings — which reads as "no lines" while the grid is plainly on screen.
    //
    // Waits for EVERY cell to have content and returns the list unfiltered.
    // Dropping the empty ones would renumber the list, and these indices are
    // used to address the matching quantity cell — so a filtered list would
    // quietly edit the wrong line.
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const codes = (await cells.allInnerTexts()).map((t) => t.trim());
      if (codes.length && codes.every(Boolean)) return codes;
      await this.page.waitForTimeout(250);
    }

    throw new Error(
      `Quote lines in ${QuoteLineEditorPage.describeScope(groupName)} never rendered their ` +
        `product codes: ${await cells.count()} cell(s) present, all empty, after ${timeout}ms.`
    );
  }

  async lineIndexOf(groupName, productCode) {
    const codes = await this.waitForLines(groupName);

    const index = codes.indexOf(productCode);
    if (index === -1) {
      throw new Error(
        `No quote line with product code "${productCode}" in ` +
          `${QuoteLineEditorPage.describeScope(groupName)}. ` +
          `Lines present: ${codes.join(', ') || '(none)'}`
      );
    }
    return index;
  }

  /** A single field's cell on one line, addressed by product code. */
  async lineCell(groupName, productCode, apiName) {
    const index = await this.lineIndexOf(groupName, productCode);
    const cells = this.lineFieldCells(groupName, apiName);

    const cellCount = await cells.count();
    const codeCount = await this.lineFieldCells(groupName, LINE_PRODUCT_CODE_FIELD).count();
    if (cellCount !== codeCount) {
      throw new Error(
        `Cannot address "${apiName}" by line position in ` +
          `${QuoteLineEditorPage.describeScope(groupName)}: ${codeCount} product-code cell(s) ` +
          `but ${cellCount} ${apiName} cell(s). The column may be hidden in this org's ` +
          'Quote Line Editor field set.'
      );
    }
    return cells.nth(index);
  }

  /**
   * Activates a click-to-edit cell and types into the input it reveals.
   *
   * Two steps, not one: the cell holds static text until it is clicked, so
   * there is nothing to type into beforehand. Tab commits and moves focus off,
   * which is what makes the app read the value back.
   */
  /**
   * Opens a click-to-edit cell and returns the editor input.
   *
   * The click has to land ON THE VALUE, not just anywhere in the cell.
   * Numeric columns are right-aligned, so a default click goes to the cell's
   * centre — empty space — and nothing opens. So: click the element holding
   * the text if there is one, and otherwise aim at the right-hand side where
   * a right-aligned value actually sits.
   *
   * The editor itself is a FLOATING overlay, not a child of the cell — it is
   * positioned over the grid and visibly spans neighbouring rows, so
   * `cell.locator('input')` finds nothing. It is addressed by focus, which is
   * unambiguous even with the group header's own inputs on screen.
   */
  async openCellEditor(cell) {
    const input = this.editor.locator('input:focus');

    const valueElement = cell.locator('span, div').filter({ visible: true }).last();
    const attempts = [
      async () => {
        if (await valueElement.count()) await valueElement.click();
        else await cell.click();
      },
      async () => {
        const box = await cell.boundingBox();
        if (!box) throw new Error('Cell has no bounding box.');
        await this.page.mouse.click(box.x + box.width - 12, box.y + box.height / 2);
      },
      async () => cell.click({ force: true }),
    ];

    for (const attempt of attempts) {
      await attempt().catch(() => {});
      try {
        await input.waitFor({ state: 'visible', timeout: 8_000 });
        return input;
      } catch {
        /* try the next way of hitting the value */
      }
    }

    throw new Error(
      'Clicking the cell did not open its editor. These cells are click-to-edit and the click ' +
        'must land on the value itself — numeric columns are right-aligned, so the cell centre ' +
        'is empty space.'
    );
  }

  async setLineFieldValue(groupName, productCode, apiName, value) {
    const cell = await this.lineCell(groupName, productCode, apiName);
    await cell.scrollIntoViewIfNeeded().catch(() => {});

    const input = await this.openCellEditor(cell);
    await input.press('ControlOrMeta+a');
    await input.pressSequentially(String(value), { delay: 20 });
    await this.commitCellEdit(groupName, productCode);
  }

  /**
   * Closes an open cell editor and lets the re-price settle.
   *
   * Tab first; if the overlay is still open, click a read-only cell on the
   * same line, which is the "click somewhere else" the editor expects. Not a
   * click on a column header — those sort the grid.
   */
  async commitCellEdit(groupName, productCode) {
    const focused = this.editor.locator('input:focus');
    await focused.press('Tab').catch(() => {});

    if (await focused.count().catch(() => 0)) {
      const readOnlyCell = await this.lineCell(groupName, productCode, LINE_PRODUCT_NAME_FIELD);
      await readOnlyCell.click({ position: { x: 4, y: 4 } }).catch(() => {});
    }
    await this.waitForCalculation();
  }

  /**
   * Prices per line as the editor shows them, keyed by product code.
   *
   * Captured before saving, as a record of what the editor priced. Assertions
   * on monetary correctness still belong on the records — this is a snapshot
   * for the journey's later stages, not a substitute for reading
   * SBQQ__NetTotal__c.
   */
  async capturePrices(groupName) {
    await this.waitForLines(groupName);
    const read = async (apiName) =>
      (await this.lineFieldCells(groupName, apiName).allInnerTexts()).map((t) => t.trim());

    const [codes, listPrices, netPrices, netTotals] = await Promise.all([
      read(LINE_PRODUCT_CODE_FIELD),
      read(LINE_LIST_PRICE_FIELD),
      read(LINE_NET_PRICE_FIELD),
      read(LINE_NET_TOTAL_FIELD),
    ]);

    const prices = {};
    codes.forEach((code, i) => {
      prices[code] = {
        listPrice: listPrices[i],
        netPrice: netPrices[i],
        netTotal: netTotals[i],
      };
    });
    return prices;
  }

  /** A line field as currently shown, whether the cell is in edit mode or not. */
  async lineFieldValue(groupName, productCode, apiName) {
    const cell = await this.lineCell(groupName, productCode, apiName);
    const input = cell.locator('input').first();
    if ((await input.count()) && (await input.isVisible().catch(() => false))) {
      return (await input.inputValue()).trim();
    }
    return (await cell.innerText()).trim();
  }

  /** The line-table header row for one group — used to find a column's position. */
  lineTableHeader(groupName) {
    return this.scope(groupName).locator(LINE_TABLE_HEADER_SELECTOR).first();
  }

  /**
   * The whole line table, as a screenshot target.
   *
   * Exposed here rather than built in a spec because selectors belong in page
   * classes — an evidence screenshot is still a locator. See
   * LINE_TABLE_SELECTOR for why a wrong guess is cheap.
   */
  lineTable(groupName) {
    return this.scope(groupName).locator(LINE_TABLE_SELECTOR).filter({ visible: true }).first();
  }

  // -------------------------------------------------------------------------
  // The quote line drawer
  //
  // Every step below is its own .locator() call. A single CSS descendant
  // selector does NOT cross a shadow boundary, while chained .locator() calls
  // do (see the header note) — so `row.locator('a b c')` and
  // `row.locator('a').locator('b').locator('c')` are not interchangeable here,
  // and only the second one works.
  // -------------------------------------------------------------------------

  /**
   * The expanded drawer belonging to ONE line, anchored at its row.
   *
   * Never anchored at the frame by product name — see DRAWER_WRAPPER_SELECTOR
   * for why that goes ambiguous and reads the wrong drawer while passing.
   *
   * Also the evidence target: an evidence screenshot is still a locator and
   * therefore belongs in a page class, never in a spec.
   */
  async lineDrawer(groupName, productCode) {
    const index = await this.lineIndexOf(groupName, productCode);
    // Identified by a label only a drawer carries — see
    // DRAWER_SIGNATURE_LABEL. When the drawer is collapsed this resolves to
    // nothing, which is what makes it a usable open/closed test; a bare
    // following-sibling would resolve to the NEXT LINE ROW and report a
    // collapsed drawer as an open one.
    return this.lineRows(groupName)
      .nth(index)
      .locator(DRAWER_WRAPPER_SELECTOR)
      .filter({ hasText: DRAWER_SIGNATURE_LABEL })
      .filter({ visible: true })
      .first();
  }

  /**
   * The drawer as a SCREENSHOT target.
   *
   * Separate from lineDrawer() because the two want different elements. The
   * drawer wrapper is a zero-box shadow host: MEASURED on 2026-08-02, every
   * drawer evidence capture failed with `locator.boundingBox: Timeout 30000ms
   * exceeded` and fell back to a full-page shot — the same trap
   * waitForEditorReady() documents for <sb-custom-action>, where Playwright
   * reports a zero-box host hidden forever while its contents are plainly on
   * screen.
   *
   * So the shot is scoped to the ROW plus its drawer instead. That frames the
   * line and its expanded detail together, which is what a human reviewing
   * evidence actually wants, and it has a real bounding box.
   *
   * A wrong guess here costs image framing rather than a test:
   * src/utils/evidence.js falls back to a page shot and never fails a run.
   */
  async lineDrawerShot(groupName, productCode) {
    const index = await this.lineIndexOf(groupName, productCode);
    const row = this.lineRows(groupName).nth(index);
    if (await row.boundingBox().catch(() => null)) return row;
    // No box on the row either — hand back the line table, which is the
    // coarsest target that is always renderable.
    return this.lineTable(groupName);
  }

  /**
   * The chevron at the trailing edge of one line's row.
   *
   * LAST visible match, not first. The control sits after every data column,
   * and trailing position is the one property that is certain about it — the
   * markup itself is matched by shape (see DRAWER_TOGGLE_SELECTOR), so an
   * earlier match could be any icon in the row's action cluster.
   */
  async drawerToggle(groupName, productCode) {
    const index = await this.lineIndexOf(groupName, productCode);
    const candidates = this.lineRows(groupName)
      .nth(index)
      .locator(DRAWER_TOGGLE_SELECTOR)
      .filter({ visible: true });

    const count = await candidates.count();
    if (!count) {
      throw new Error(
        `No drawer toggle on the line for "${productCode}" in ` +
          `${QuoteLineEditorPage.describeScope(groupName)}. Looked for ${DRAWER_TOGGLE_SELECTOR} ` +
          'at the trailing edge of the row. The control is the chevron after the Net Total ' +
          'column — ">" collapsed, "v" expanded — so if this found nothing, the chevron is built ' +
          'from markup none of those selectors match and it needs a DOM dump.'
      );
    }
    return candidates.nth(count - 1);
  }

  /**
   * Expands one line's drawer, if it is not already open.
   *
   * DOES NOT WAIT FOR CALCULATION. Opening a drawer is a pure UI disclosure —
   * it reads fields the line already holds and writes nothing, so there is no
   * re-price to wait out. Calling waitForCalculation here would add its full
   * stable-for window to every read for no reason. Every drawer WRITE below
   * does wait.
   */
  /** Whether one line's drawer is currently expanded. */
  async isLineDrawerOpen(groupName, productCode) {
    const drawer = await this.lineDrawer(groupName, productCode);
    return (await drawer.count()) > 0;
  }

  async openLineDrawer(groupName, productCode) {
    if (await this.isLineDrawerOpen(groupName, productCode)) {
      return this.lineDrawer(groupName, productCode);
    }

    const toggle = await this.drawerToggle(groupName, productCode);
    await toggle.scrollIntoViewIfNeeded().catch(() => {});
    await toggle.click();

    // Waits on the drawer's CONTENT appearing, not on the chevron's state.
    // The chevron flips the instant it is clicked; the drawer is what the
    // caller is about to read.
    const drawer = await this.lineDrawer(groupName, productCode);
    try {
      await drawer.waitFor({ state: 'visible', timeout: 30_000 });
    } catch {
      throw new Error(
        `Clicking the trailing chevron on the line for "${productCode}" did not open a drawer ` +
          `containing "${DRAWER_SIGNATURE_LABEL}" within 30s. Either the click landed on a ` +
          'different icon in the row (the toggle is matched by shape and trailing position — see ' +
          'DRAWER_TOGGLE_SELECTOR), or the expanded drawer is not the row\'s next sibling as ' +
          'DRAWER_WRAPPER_SELECTOR assumes.'
      );
    }
    return drawer;
  }

  /**
   * Collapses the drawer again.
   *
   * Worth doing rather than leaving open: the expanded drawer sits between two
   * line rows, and leaving several open makes the row list longer to scroll
   * without changing what lineIndexOf() computes — a mismatch that is easy to
   * trip over when a later step clicks by position.
   */
  async closeLineDrawer(groupName, productCode) {
    if (!(await this.isLineDrawerOpen(groupName, productCode))) return;
    const toggle = await this.drawerToggle(groupName, productCode);
    await toggle.click().catch(() => {});
    await this.lineRows(groupName)
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => {});
  }

  /**
   * One drawer cell, addressed by the label it renders.
   *
   * ANCHORED ON THE LABEL'S OWN ELEMENT, then stepped up to its container —
   * not matched by a cell selector. MEASURED on 2026-08-02: the drawer element
   * resolves correctly (it is found by its "Pricing Method" text) but NONE of
   * sb-option-cell / .drawerCell / sb-line-cell / div.td / td matched anything
   * inside it, so captureDrawerValues() came back empty and setMarkup() could
   * not find its type control.
   *
   * Going through the label sidesteps the question entirely: whatever element
   * holds the text, its parent is the cell, and that holds the value and any
   * control. The label is matched anchored and case-insensitively because the
   * app renders these uppercase through CSS while the DOM holds title case.
   */
  async drawerCell(groupName, productCode, label) {
    const drawer = await this.openLineDrawer(groupName, productCode);
    const labelElement = drawer
      .getByText(new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'))
      .filter({ visible: true })
      .first();

    if (!(await labelElement.count())) {
      // Deliberately does NOT list the drawer's other labels here. The obvious
      // way to do that is to call captureDrawerValues(), which now resolves
      // every label THROUGH THIS METHOD — so a miss would recurse until the
      // stack gave out, and the real cause would be buried under it.
      throw new Error(
        `The drawer for "${productCode}" has no field labelled "${label}". Known drawer labels ` +
          `are: ${Object.keys(DRAWER_FIELD_LABELS).join(', ')}. If the field is plainly on screen ` +
          'under a different wording, correct DRAWER_FIELD_LABELS rather than loosening the match ' +
          '— the label list is also what maps a drawer reading back to its API name.'
      );
    }
    // The cell is the label's parent — the label and the value sit together.
    return labelElement.locator('xpath=..');
  }

  /** One drawer field as currently displayed, whether or not it is in edit mode. */
  async lineDrawerFieldValue(groupName, productCode, label) {
    const cell = await this.drawerCell(groupName, productCode, label);
    const input = cell.locator('input').first();
    if ((await input.count()) && (await input.isVisible().catch(() => false))) {
      return (await input.inputValue()).trim();
    }
    // The label is part of the cell's text, so it is stripped rather than
    // returned as if it were the value.
    const text = (await cell.innerText()).trim();
    return text.startsWith(label) ? text.slice(label.length).trim() : text;
  }

  /**
   * Every visible drawer label mapped to its displayed text, in ONE pass.
   *
   * The mirror of capturePrices(), and for the same reason: a displayed-only
   * step reads one structured snapshot instead of issuing N round trips
   * through the shadow DOM. This is the primary read for the displayed-value
   * cadence, with lineDrawer() as the evidence shot beside it.
   */
  async captureDrawerValues(groupName, productCode) {
    await this.openLineDrawer(groupName, productCode);

    // READ PER LABEL, NEVER FROM THE DRAWER'S OWN innerText.
    //
    // MEASURED on 2026-08-02: `drawer.innerText()` came back EMPTY while the
    // drawer was plainly on screen and populated, so a parse of it returned {}
    // on three consecutive runs. The reason is the one documented at the top of
    // this file — the drawer is a shadow HOST and innerText walks the light DOM
    // only. Reading an element that resolved INSIDE the shadow root works
    // fine, which is exactly how setMarkup() reaches its input and its select.
    //
    // So each label is located through Playwright's text engine (which does
    // pierce open shadow roots), stepped up to its cell, and that cell is read.
    // Thirteen round trips instead of one, which is the right trade for a
    // capture whose only job is to be a readable snapshot beside a record
    // assertion.
    const values = {};
    for (const label of Object.keys(DRAWER_FIELD_LABELS)) {
      try {
        const cell = await this.drawerCell(groupName, productCode, label);
        const text = (await cell.innerText()).replace(/\s+/g, ' ').trim();
        // The cell holds "<Label> <value>"; strip the label off the front.
        // Case-insensitive, because the app renders these uppercase through
        // CSS while the DOM holds title case.
        values[label] = text.toUpperCase().startsWith(label.toUpperCase())
          ? text.slice(label.length).trim()
          : text;
      } catch {
        // A label this org's drawer does not render, or one whose cell could
        // not be resolved. SKIPPED rather than recorded as empty, so a caller
        // can tell "not on this drawer" from "on it and blank" — Markup and
        // Partner Discount are legitimately blank on an untouched line.
      }
    }
    return values;
  }

  /**
   * Writes one drawer field.
   *
   * NOT usable for Markup — that control is compound and has its own method.
   * Guarded rather than left to discipline: writing the amount through here
   * would leave the type selector at whatever it happened to be, and a markup
   * of 100 means 100 USD or 100 PERCENT depending on it.
   */
  async setLineDrawerFieldValue(groupName, productCode, label, value) {
    if (label === MARKUP_LABEL) {
      throw new Error(
        `Use setMarkup() for "${MARKUP_LABEL}", not setLineDrawerFieldValue(). The control is ` +
          'compound — an amount plus a type selector offering % and USD — and the type decides ' +
          'which quote line field receives the value. Measured in this org: a unit cost of 2100 ' +
          'with a markup of 100 USD gives a special price of 2200, where 100 PERCENT would give ' +
          '4200. Writing the amount alone leaves that to chance.'
      );
    }

    const cell = await this.drawerCell(groupName, productCode, label);
    const input = await this.openCellEditor(cell);
    await input.press('ControlOrMeta+a');
    await input.pressSequentially(String(value), { delay: 20 });
    await input.press('Tab');
    await this.waitForCalculation();
  }

  /**
   * Sets the Markup amount AND its type explicitly.
   *
   * @param {'USD'|'%'} type  never defaulted — see MARKUP_LABEL's note.
   */
  /**
   * The Markup cell: the editable drawer cell whose text carries the label.
   *
   * Both filters are needed. The label alone matches the read-only cells'
   * container in this grid; the Editable class alone matches every editable
   * cell in the drawer.
   */
  async markupCell(groupName, productCode) {
    const drawer = await this.openLineDrawer(groupName, productCode);

    // SEVERAL STRATEGIES, IN ORDER, BECAUSE THE DRAWER IS A SHADOW-DOM APP.
    //
    // MEASURED on 2026-08-02: the drawer element itself resolves (it is found
    // by its "Pricing Method" text) but `drawer.innerText()` comes back EMPTY
    // and a class-filtered descendant lookup finds nothing. That is the
    // behaviour this file documents at the top — innerText and other DOM
    // property reads do NOT traverse shadow roots, while Playwright's own text
    // engine and chained .locator() calls DO.
    //
    // So the class filter is tried first (it is what the UI shows), and the
    // text-anchored routes follow, which go through Playwright's matcher
    // rather than through a DOM property.
    const strategies = [
      {
        name: 'editable class + label text',
        build: () => drawer.locator(DRAWER_EDITABLE_CLASS_SELECTOR)
          .filter({ hasText: MARKUP_LABEL }).filter({ visible: true }),
      },
      {
        name: 'label text, stepped up to its container',
        build: () => drawer.getByText(new RegExp(`^\\s*${MARKUP_LABEL}\\s*$`, 'i'))
          .filter({ visible: true }).locator('xpath=..'),
      },
      {
        name: 'editable class, any',
        build: () => drawer.locator(DRAWER_EDITABLE_CLASS_SELECTOR).filter({ visible: true }),
      },
    ];

    const tried = [];
    for (const strategy of strategies) {
      const located = strategy.build();
      const count = await located.count().catch(() => 0);
      tried.push(`${strategy.name}: ${count}`);
      if (count) {
        console.log(`[drawer] "${MARKUP_LABEL}" cell resolved by ${strategy.name} (${count} match(es)).`);
        return located.first();
      }
    }

    throw new Error(
      `No "${MARKUP_LABEL}" cell in the drawer for "${productCode}". Tried — ${tried.join('; ')}.\n` +
        'The drawer itself DID open (it was matched by its "Pricing Method" text), so this is ' +
        'about how its cells are built, not about the drawer. Note that innerText and other DOM ' +
        'property reads do not traverse shadow roots in this app, while chained .locator() calls ' +
        'and getByText do — a dump of the drawer\'s shadow tree is what settles it.'
    );
  }

  /**
   * Sets the Markup amount AND its type.
   *
   * THREE STEPS, IN THIS ORDER, AND THE ORDER IS THE POINT:
   *
   *   1. Click the empty area BELOW the label to open the editor. Nothing
   *      exists before this — not the input, not the type selector. Clicking
   *      the label itself does not open it, so the click is aimed at the lower
   *      part of the cell where the input box appears.
   *   2. Set the type. It defaults to "%" in this org, but it is still set
   *      explicitly: the type chooses between SBQQ__MarkupRate__c and
   *      SBQQ__MarkupAmount__c, and relying on a default means the test is
   *      asserting on whichever field the UI happened to pick.
   *   3. Type the amount, then Tab to commit.
   *
   * @param {'USD'|'%'} type  never defaulted — see above.
   */
  async setMarkup(groupName, productCode, amount, type) {
    if (!MARKUP_TYPES.includes(type)) {
      throw new Error(
        `setMarkup needs an explicit type, one of ${MARKUP_TYPES.map((t) => `"${t}"`).join(' or ')} ` +
          `— got ${JSON.stringify(type)}. It is deliberately not defaulted: the type selects ` +
          'between SBQQ__MarkupAmount__c and SBQQ__MarkupRate__c, so a default would decide which ' +
          'field the test is actually asserting on.'
      );
    }

    const cell = await this.markupCell(groupName, productCode);
    await cell.scrollIntoViewIfNeeded().catch(() => {});

    // ---- 1. open the editor -------------------------------------------------
    const input = cell.locator('input').filter({ visible: true }).first();
    const selector = cell.locator('select').filter({ visible: true }).first();

    // ALWAYS CLICK, even when an input appears to be present already.
    //
    // MEASURED on 2026-08-02: after a Quick Save the drawer re-renders, and a
    // count() on the old input can still report 1 against a node that is about
    // to be replaced. Skipping the open-click on that basis left the third
    // markup write clicking a detached element, which surfaced as a bare
    // `locator.click: Timeout 30000ms exceeded` two steps away from the cause.
    // Clicking an already-open editor is harmless; assuming one is open is not.
    const box = await cell.boundingBox();
    if (!box) throw new Error(`The Markup cell for ${productCode} has no bounding box.`);
    // Below the label, which sits at the top of the cell, and towards the left
    // where the input box renders.
    await this.page.mouse.click(box.x + Math.min(60, box.width * 0.35), box.y + box.height * 0.7);

    try {
      await input.waitFor({ state: 'visible', timeout: 15_000 });
    } catch {
      throw new Error(
        `Clicking below the "${MARKUP_LABEL}" label on the line for ${productCode} did not open ` +
          'its editor. The cell is click-to-edit and the input box appears BELOW the label — a ' +
          'click on the label itself is absorbed. Nothing was written.'
      );
    }

    // ---- 2. the type, before the amount ------------------------------------
    //
    // Amount first would re-price under whatever type was showing and then
    // re-price again, briefly committing the value under the wrong field.
    if (await selector.count()) {
      await selector.selectOption({ label: type }).catch(async () => {
        await selector.selectOption(type);
      });
    } else {
      throw new Error(
        `The Markup editor for ${productCode} opened but exposed no type <select>. The amount was ` +
          'NOT written — writing it under an unknown type is the one outcome worth avoiding, ' +
          `since ${amount} means ${amount} USD or ${amount}% depending on it.`
      );
    }

    // ---- 3. the amount ------------------------------------------------------
    await input.click();
    await input.press('ControlOrMeta+a');
    await input.pressSequentially(String(amount), { delay: 20 });
    await input.press('Tab');
    await this.waitForCalculation();
  }

  /** The Markup as displayed: { amount, type }. */
  async markupValue(groupName, productCode) {
    const cell = await this.drawerCell(groupName, productCode, MARKUP_LABEL);

    const input = cell.locator('input').first();
    const amount = (await input.count()) && (await input.isVisible().catch(() => false))
      ? (await input.inputValue()).trim()
      : (await cell.innerText()).replace(MARKUP_LABEL, '').trim();

    const selector = cell.locator('select').filter({ visible: true }).first();
    let type = null;
    if (await selector.count()) {
      type = await selector.inputValue().catch(() => null);
    }
    return { amount, type };
  }

  // -------------------------------------------------------------------------
  // Checkboxes — line level (in the drawer) and group level
  // -------------------------------------------------------------------------

  /**
   * A Polymer checkbox inside one line's drawer, addressed by label.
   *
   * CONFIRMED for this org: Optional renders in the line DRAWER, not as a line
   * table column — which is what removes any dependence on it being in the
   * editor's field set.
   */
  async lineCheckbox(groupName, productCode, label) {
    const cell = await this.drawerCell(groupName, productCode, label);
    const control = cell.locator(CHECKBOX_SELECTOR).filter({ visible: true }).first();
    if (!(await control.count())) {
      throw new Error(
        `No checkbox control under the drawer field "${label}" on the line for ${productCode}. ` +
          `Looked for ${CHECKBOX_SELECTOR}. These are Polymer custom elements rather than real ` +
          'inputs, so a plain input[type=checkbox] lookup will not find them either.'
      );
    }
    return control;
  }

  /**
   * Reads a Polymer checkbox's state.
   *
   * From aria-checked, NEVER Locator.isChecked() — that throws on a
   * paper-checkbox, because it is a custom element and not an input.
   *
   * @returns {Promise<{checked: boolean, disabled: boolean}>}
   */
  async lineCheckboxState(groupName, productCode, label) {
    const control = await this.lineCheckbox(groupName, productCode, label);
    return QuoteLineEditorPage.readCheckbox(control);
  }

  /**
   * Reads either shape of checkbox in this app.
   *
   * aria-checked FIRST, because a Polymer <paper-checkbox> is a custom element
   * and Locator.isChecked() throws on it. Falls back to isChecked() for a real
   * <input type="checkbox">, which the quote line drawer's Optional control
   * turned out to be — the two shapes coexist and neither read works on both.
   */
  static async readCheckbox(control) {
    const [aria, disabled] = await Promise.all([
      control.getAttribute('aria-checked').catch(() => null),
      control.getAttribute('aria-disabled').catch(() => null),
    ]);
    if (aria !== null) {
      return { checked: aria === 'true', disabled: disabled === 'true' };
    }
    const checked = await control.isChecked().catch(() => false);
    const enabled = await control.isEnabled().catch(() => true);
    return { checked, disabled: !enabled };
  }

  /**
   * Sets a line-level checkbox and VERIFIES the state took.
   *
   * The read-back is not belt and braces. A click that lands on the cell
   * rather than on the control leaves the flag unchanged, and every downstream
   * assertion then fails on a number — a quote total that did not move — with
   * nothing pointing at the click as the cause.
   */
  async setLineCheckbox(groupName, productCode, label, checked) {
    const before = await this.lineCheckboxState(groupName, productCode, label);
    if (before.disabled) {
      throw new Error(
        `The "${label}" checkbox on the line for ${productCode} is aria-disabled, so it cannot be ` +
          `set to ${checked}. That is a state of the quote, not a locator problem.`
      );
    }
    if (before.checked === checked) return;

    const control = await this.lineCheckbox(groupName, productCode, label);
    await control.click();
    await this.waitForCalculation();

    const after = await this.lineCheckboxState(groupName, productCode, label);
    if (after.checked !== checked) {
      throw new Error(
        `Clicking "${label}" on the line for ${productCode} did not change it: still ` +
          `aria-checked=${after.checked}, wanted ${checked}. These controls are Polymer custom ` +
          'elements and a click that lands on the surrounding cell is silently absorbed.'
      );
    }
  }

  // -------------------------------------------------------------------------
  // Group-level fields
  // -------------------------------------------------------------------------

  /**
   * Both group setters REFUSE a null group name rather than falling through to
   * the editor scope. scope(null) returns the whole frame, so a null here
   * would resolve to the quote-level copy of the same field and write to
   * SBQQ__Quote__c instead of SBQQ__QuoteLineGroup__c — a failure that looks
   * completely correct in the UI, which is the same trap quoteFieldInput()
   * documents from the other direction.
   */
  static requireGroup(groupName, method) {
    if (!groupName) {
      throw new Error(
        `${method} needs a group name. Passing null would scope to the whole editor and write the ` +
          'quote-level copy of the field instead of the group\'s — which succeeds, and is wrong.'
      );
    }
    return groupName;
  }

  async setGroupField(groupName, apiName, value) {
    QuoteLineEditorPage.requireGroup(groupName, 'setGroupField');
    const cell = this.groupSection(groupName)
      .locator(GROUP_FIELDS_CONTAINER_SELECTOR)
      .locator(LINE_CELL(apiName))
      .filter({ visible: true })
      .first();

    const input = await this.openCellEditor(cell);
    await input.press('ControlOrMeta+a');
    await input.pressSequentially(String(value), { delay: 20 });
    await input.press('Tab');
    await this.waitForCalculation();
  }

  /**
   * A checkbox in one GROUP'S HEADER, addressed by its visible label.
   *
   * CONFIRMED from the org's UI on 2026-08-02: each quote line group's header
   * block carries Optional, Additional Disc. (%), Start Date, End Date and
   * Subscription Term — the same block, and the same `div.td` cells, that
   * groupFieldInput() already drives for Start Date and Subscription Term. So
   * this goes through headerFieldCell(), which is the lookup that has been
   * proven against this markup, rather than through the LINE_CELL(apiName)
   * selector an earlier version used: the group header is not a line table and
   * carries no `field` attributes, so that lookup found nothing.
   *
   * BY LABEL, not by API name, for the same reason the drawer is: the header
   * renders labels. Two groups means two of every one of these controls, which
   * is exactly why the scope is the group section and never the editor.
   *
   * @param {string} label  e.g. 'Optional' — must be in HEADER_FIELD_LABELS,
   *        which is what disambiguates it from its siblings in the block.
   */
  /**
   * The custom div checkbox in one group's header, found via its label's
   * `tooltip` attribute.
   *
   * SCOPED TO THE GROUP, always. The header renders one of these per group, so
   * an editor-wide lookup resolves two and would flag whichever came first.
   *
   * The container is reached from the label by walking UP, because the two are
   * siblings rather than nested. Two levels are tried: some field blocks wrap
   * the label in an extra div, and a single fixed step would work on one shape
   * and silently find nothing on the other.
   */
  async groupCheckboxControl(groupName, label) {
    QuoteLineEditorPage.requireGroup(groupName, 'groupCheckboxControl');
    const labelElement = this.groupSection(groupName)
      .locator(TOOLTIP_LABEL(label))
      .filter({ visible: true })
      .first();

    if (!(await labelElement.count())) {
      throw new Error(
        `No element with tooltip="${label}" in the header of group "${groupName}". The group-level ` +
          'controls render in the header block alongside Start Date and Subscription Term, and ' +
          'their labels carry the field name in a `tooltip` attribute rather than only as text.'
      );
    }

    for (const step of ['xpath=..', 'xpath=../..']) {
      const control = labelElement
        .locator(step)
        .locator(CUSTOM_CHECKBOX_SELECTOR)
        .filter({ visible: true })
        .first();
      if (await control.count()) return control;
    }

    throw new Error(
      `Found the "${label}" label in group "${groupName}" but no ${CUSTOM_CHECKBOX_SELECTOR} ` +
        'beside it, within two levels up. The control is a div-built checkbox — ' +
        '<div id="checkboxContainer"><div id="checkbox"><div id="checkmark" class="hidden">> — ' +
        'not an <input>, so it carries no role or aria state to fall back on.'
    );
  }

  /**
   * Reads the div checkbox's state from the `hidden` class on its checkmark.
   *
   * There is no attribute and no property to read. "The checkmark element
   * exists" is TRUE in both states — it is the class that differs — so a
   * presence check would report every checkbox as ticked.
   */
  static async readCustomCheckbox(control) {
    const mark = control.locator(CUSTOM_CHECKMARK_SELECTOR).first();
    const className = (await mark.getAttribute('class').catch(() => '')) || '';
    return !new RegExp(`\\b${CUSTOM_CHECKMARK_HIDDEN_CLASS}\\b`).test(className);
  }

  async setGroupCheckbox(groupName, label, checked) {
    QuoteLineEditorPage.requireGroup(groupName, 'setGroupCheckbox');
    const control = await this.groupCheckboxControl(groupName, label);

    // The DIV reader, not readCheckbox(). This control has no aria-checked and
    // is not an input — its state is the `hidden` class on #checkmark, and
    // readCheckbox() would fall through to isChecked() and report false for
    // both states.
    const state = () => QuoteLineEditorPage.readCustomCheckbox(control);
    if ((await state()) === checked) return;

    await control.click();
    await this.waitForCalculation();

    // Verified rather than assumed. A click absorbed by the surrounding cell
    // leaves the flag untouched, and every downstream assertion then fails on
    // a quote total that did not move — with nothing pointing at the click.
    if ((await state()) !== checked) {
      throw new Error(
        `Clicking "${label}" on group "${groupName}" did not change it: the #checkmark is still ` +
          `${checked ? 'hidden' : 'visible'}, wanted ${checked ? 'checked' : 'unchecked'}. These ` +
          'are div-built controls, so a click that lands beside the checkbox is silently absorbed.'
      );
    }
  }

  // -------------------------------------------------------------------------
  // Bundle lines
  // -------------------------------------------------------------------------

  /**
   * The per-line "Reconfigure Line" button, which reopens the bundle
   * configurator for a bundle that is already on the quote.
   *
   * Two lookups, in order, because the button sits two shadow roots deep:
   *
   *   1. Scoped to the line's own row, via CHAINED .locator() calls. Each
   *      chained step re-enters shadow-piercing mode, so this crosses both
   *      boundaries where a single CSS descendant selector would not (see the
   *      shadow-DOM note at the top of this file).
   *   2. Failing that, editor-wide — but ONLY when exactly one such button
   *      exists. CPQ renders the action on bundle PARENT lines alone, so on a
   *      quote holding one bundle that is unambiguous; on a quote holding two
   *      it is not, and the guard refuses rather than reconfiguring whichever
   *      bundle Playwright resolved first.
   *
   * @param {string|null} groupName
   * @param {string} productCode  the bundle parent's SBQQ__ProductCode__c
   */
  async reconfigureLineButton(groupName, productCode) {
    const index = await this.lineIndexOf(groupName, productCode);
    const rows = this.lineRows(groupName);
    const scoped = rows
      .nth(index)
      .locator(LINE_ACTIONS_SELECTOR)
      .locator(`button[name="${RECONFIGURE_LINE_ACTION}"]`)
      .filter({ visible: true });

    if (await scoped.count()) return scoped.first();

    const editorWide = this.editor
      .locator(`button[name="${RECONFIGURE_LINE_ACTION}"]`)
      .filter({ visible: true });
    const count = await editorWide.count();

    if (count === 1) return editorWide.first();
    if (count === 0) {
      throw new Error(
        `No "${RECONFIGURE_LINE_ACTION}" action on the line for "${productCode}" in ` +
          `${QuoteLineEditorPage.describeScope(groupName)}. CPQ renders it only on a bundle ` +
          'PARENT line, so either this product code addresses an option line rather than the ' +
          'bundle, or the product is not configurable in this org.'
      );
    }
    throw new Error(
      `Cannot identify the "${RECONFIGURE_LINE_ACTION}" action for "${productCode}": the ` +
        `row-scoped lookup found none and the editor holds ${count} of them, so this quote has ` +
        'more than one bundle. Reaching across rows here would reconfigure the wrong one.'
    );
  }

  /**
   * Reopens the configurator for a bundle already on the quote.
   *
   * Leaves the browser on the configurator — wait for it through
   * ProductConfigurationPage.waitForReady(), which is that screen's own
   * readiness signal and takes a minute on a cold entry.
   */
  async reconfigureLine(groupName, productCode) {
    const button = await this.reconfigureLineButton(groupName, productCode);
    await button.click();
    await this.waitForCalculation();
  }

  /** @param {string} productCode — the line's SBQQ__ProductCode__c, not its name. */
  async setQuantity(groupName, productCode, quantity) {
    await this.setLineFieldValue(groupName, productCode, LINE_QUANTITY_FIELD, quantity);
    // Every quantity change re-prices the quote. Wait for that to settle
    // before touching the next line, or the next click races the rerender and
    // lands on a stale node. Wait for CPQ's state explicitly, never on a delay.
    await this.waitForCalculation();
  }

  /**
   * The quantity as the editor displays it, e.g. "2.00".
   *
   * Returned as text rather than a number: the editor formats to two decimal
   * places, so callers should compare numerically rather than by string.
   */
  async quantityValue(groupName, productCode) {
    return this.lineFieldValue(groupName, productCode, LINE_QUANTITY_FIELD);
  }

  async applyAdditionalDiscount(groupName, productCode, percent) {
    await this.setLineFieldValue(groupName, productCode, LINE_ADDITIONAL_DISCOUNT_FIELD, percent);
    await this.waitForCalculation();
  }

  // -------------------------------------------------------------------------
  // Calculate / Save
  // -------------------------------------------------------------------------

  /**
   * Waits for CPQ's "Calculating" state to clear. Extracted so every mutating
   * method uses the same wait — never a fixed waitForTimeout.
   *
   * The .catch() swallows a timeout on the *appearance* of the indicator: a
   * fast recalculation can finish before Playwright ever sees it, and waiting
   * for "hidden" on something already gone is fine to skip.
   */
  async waitForCalculation({ stableFor = 1500, interval = 250 } = {}) {
    // Requires the indicator to clear AND stay clear. A single waitFor({
    // state: 'hidden' }) passes in the gap between two async steps — the app
    // flicks show="true" off and straight back on — and the next click then
    // dies on "<sf-loading-spinner> intercepts pointer events".
    const busy = this.editor.locator(BUSY_SELECTOR).first();
    const deadline = Date.now() + CALCULATION_TIMEOUT_MS;
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

  async calculate() {
    await this.editor.getByRole('button', { name: CALCULATE_LABEL }).click();
    await this.waitForCalculation();
  }

  /**
   * Commits pending edits and stays in the editor.
   *
   * This is what the header steps use. Save navigates back to the Quote record
   * page, so using it to commit the Start Date and Subscription Term would
   * mean re-entering the editor — and re-entering costs another 60-120s of
   * app startup — before any product could be added.
   */
  async quickSave() {
    await this.editor
      .getByRole('button', { name: QUICK_SAVE_LABEL, exact: true })
      .first()
      .click();
    await this.waitForCalculation();
    // Quick Save re-renders the header from the saved record, so let the
    // groups (or, on a flat quote, the line table) settle again before the
    // next interaction.
    await this.editor
      .locator(EDITOR_PAINTED_SELECTOR)
      .first()
      .waitFor({ state: 'visible', timeout: EDITOR_READY_TIMEOUT_MS });
  }

  /**
   * Saves the editor. CPQ recalculates on save, then navigates back to the
   * Quote's Lightning record page, so both waits belong here rather than at
   * every call site.
   */
  async save() {
    // `exact: true` is required. getByRole matches the accessible name as a
    // case-insensitive SUBSTRING by default, so { name: 'Save' } also matches
    // "Quick Save" — two elements, strict-mode violation, and the click never
    // lands.
    await this.editor
      .getByRole('button', { name: SAVE_LABEL, exact: true })
      .first()
      .click();
    await this.waitForCalculation();
    await this.waitForLightningReady();
  }

  /**
   * Leaves the editor WITHOUT committing anything.
   *
   * For a stage that only opened the editor to look at it. Save would
   * recalculate and re-write a quote that stage is supposed to read, so
   * cancelling is not a stylistic preference — it is the difference between
   * observing the quote and modifying it.
   *
   * Falls back to navigating to the quote's record page when no Cancel button
   * is found. The outcome that matters is "back on the quote, nothing saved",
   * and a direct navigation delivers that just as well; the button is
   * preferred only because it is the path a user takes. See CANCEL_LABEL.
   *
   * @param {string} instanceUrl
   * @param {string} quoteId  where to land if the button is not there
   */
  async cancel(instanceUrl, quoteId) {
    const button = this.editor
      .getByRole('button', { name: CANCEL_LABEL, exact: true })
      .filter({ visible: true })
      .first();

    if (await button.isVisible().catch(() => false)) {
      await button.click();
      await this.waitForLightningReady();
      return;
    }

    console.log(
      `No "${CANCEL_LABEL}" button in the Quote Line Editor — navigating back to quote ` +
        `${quoteId} instead. Nothing was saved either way; update CANCEL_LABEL in ` +
        'QuoteLineEditorPage if this org labels it differently.'
    );
    await this.page.goto(`${instanceUrl}/lightning/r/${quoteId}/view`);
    await this.waitForLightningReady();
  }

  // netTotal() was DELETED on 2026-08-03. It had carried a note saying it was
  // unused and built on `data-field`, whereas this app's cells use `field`
  // (see LINE_CELL) — so it was known-wrong for as long as it existed, and
  // every spec already reads displayed totals through
  // capturePrices(null) precisely to avoid it. Deleted rather than fixed:
  // capturePrices() already returns every displayed price for every line, so a
  // repaired netTotal() would be a second, narrower way to do the same thing.
  //
  // Worth keeping from that note, because it is a genuine CPQ trap:
  // SBQQ__NetTotal__c is a QUOTE LINE field. The QUOTE's own total is
  // SBQQ__NetAmount__c.
}

// EDITOR_FRAME_SELECTOR is exported because ProductConfigurationPage renders
// behind the SAME iframe and must not redefine the string — the two-iframe
// scrolling="yes" discriminator was earned against this org once, and a second
// copy would drift from this one.
module.exports = {
  QuoteLineEditorPage,
  formatDateForInput,
  START_DATE_INPUT_FORMAT,
  EDITOR_FRAME_SELECTOR,
  // Exported for traceability, so a spec asserting on SBQQ__SpecialPrice__c
  // can name the drawer label it captured beside it without hardcoding either.
  DRAWER_FIELD_LABELS,
  MARKUP_TYPE_USD,
  MARKUP_TYPE_PERCENT,
};
