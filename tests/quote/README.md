# `tests/quote/` — what a total counts

**What this folder proves:** behaviour that changes **which lines a quote total
counts, and which lines carry onward to the deal** — not how any price was
worked out.

That is the whole reason this is a separate folder rather than a sixth file in
[`../pricing-methods/`](../pricing-methods/). Nothing here changes how a price is
derived. Filing it under pricing would repeat exactly the mixed-axis problem that
motivated splitting the pricing folders in the first place, and it would put
these tests in the wrong CI slice — they are `@domain:quote`, not
`@domain:pricing`.

## Read first

There is one spec: **[`optional-lines.spec.js`](optional-lines.spec.js)**.

## The thing that makes it unusual

**It is the only spec in the suite that uses a GROUPED quote**, and the grouping
is a precondition rather than something the spec creates. In this org a
record-triggered Flow adds two sections to any quote for a retail customer. The
spec asserts those sections exist before doing anything else and fails naming the
account if they do not — so a change to that automation fails by name here rather
than as a stuck editor twenty steps later.

Three flows are deliberately NOT used, and each header states why. Most
importantly, `createSimpleQuote` REFUSES a retail account by default — every
other caller in the suite wants a flat quote — so this spec passes an explicit
opt-in that additionally refuses a non-retail account. Asking for sections and
silently getting none is therefore unreachable.

## The checkbox trap

This application has **three kinds of checkbox and no single way to read all of
them**: Polymer custom elements (state in `aria-checked`), real
`<input type="checkbox">` elements, and — in the section header used here —
controls built from plain `<div>`s with no input, no role and no ARIA at all.
That third kind's state lives in a CSS class, and the element exists in both
states, so a presence check reports every checkbox as ticked.

## Backed by

`data/optional-lines.json`.

## Tags

`@type:regression`, `@domain:quote`, `@speed:slow`, `@risk:high`.

## Lane

**`quote`** — derived automatically from the folder name. Joins the
`quote-config` CI slice through `@domain:quote`.
