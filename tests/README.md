# `tests/` — what is here and how to work in it

Start here if you are new. Every spec also opens with a plain-English
**WHAT THIS PROVES / WHY IT MATTERS / HOW IT WORKS / IF THIS FAILS** block, so
you can read any single file cold without reading this one first.

---

## The folder map

| folder | what it proves | lane |
|---|---|---|
| [`config/`](config/) | The product configurator stops a rep building something that cannot be shipped, and the choices they make survive onto the order. | `smartwatch`, `solar` (one each) |
| [`pricing/`](pricing/) | The org's **price rules** fire when they should and — just as important — stay off when they should not. | `pricing` |
| [`pricing-methods/`](pricing-methods/) | Products whose price is **derived** rather than looked up: quantity bands, a percentage of other lines, cost plus margin, bundle overrides, per-customer negotiated prices. | `pricing-methods` |
| [`quote/`](quote/) | What a quote **total counts** and what carries through to the deal — not how any price was worked out. | `quote` |
| [`journeys/`](journeys/) | The whole life of a deal: quote → order → contract → asset → amendment → renewal. Multi-stage, strictly ordered. | `journeys` |

Two files in `tests/` are **not** specs and are deliberately not named `*.spec.js`:
`pricing/expectations.js` (shared assertion vocabulary) and
`journeys/subscription-stages.js` (the stage list both journey specs share).

### Why `pricing/` and `pricing-methods/` are different folders

A **price rule** overwrites a price after CPQ has already worked one out. A
**pricing method** decides how CPQ works it out in the first place. They are
different mechanisms with different failure modes, and the folders are named
along different axes to match: a file in `pricing/` is named after the rule
record an admin can open in Setup, and a file in `pricing-methods/` is named
after the method.

---

## Every spec, and what it proves

### `config/`

| spec | proves |
|---|---|
| `solar-bundle-configuration.spec.js` | The configurator enforces the solar bundle's engineering rules — mandatory parts, one-at-a-time choices, quantity floors and ceilings, and a rule tying microinverter count to panel count. |
| `smartwatch-attributes.spec.js` | A configured smartwatch's choices (size, colour, plug type, engraving, band materials) reach the quote and then the order, scoped correctly to the whole watch or to one band. |

### `pricing/`

| spec | proves |
|---|---|
| `educational-netbook-list-price.spec.js` | An education customer gets the education price on a netbook automatically, and nothing else on the quote is discounted with it. |
| `referral-list-price.spec.js` | A partner referral code prices the promoted product at the campaign rate — including when the rep capitalises the code differently. |
| `new-customer-sd-card-list-price.spec.js` | A new-customer deal takes a fixed amount off the catalogue price, **calculated** from it rather than hardcoded. |
| `repeated-laptop-list-price.spec.js` | A customer who already owns ten or more laptops gets a loyalty discount on the next one, counted from what they own rather than from the quote. |
| `lookup-netbook-price.spec.js` | Pricing held in a business-maintained table resolves the right row per product, not one row for the whole account. |
| `small-business-ssd-special-price.spec.js` | Small businesses get a negotiated price on a bundle component; larger ones buying the identical bundle do not. |
| `no-rule-fires.spec.js` | **The counterweight.** A customer qualifying for none of the rules is quoted entirely at catalogue price. |

### `pricing-methods/`

| spec | proves |
|---|---|
| `block-pricing.spec.js` | Products sold in quantity bands price from the right band, the bands meet with no gap, and the per-unit charge above the top band does not leak below it. |
| `percent-of-total.spec.js` | Shipping insurance costs a percentage of the hardware it insures — counting the right lines, following discounts, and stopping at its own cap. |
| `cost-plus-markup.spec.js` | Cost-plus products price from cost plus the rep's margin, in both directions, without touching the catalogue price. |
| `bundle-option-pricing.spec.js` | A component is cheaper inside a bundle than standalone, and components marked as included cost nothing. |
| `contracted-pricing.spec.js` | Prices negotiated with one customer reach that customer only, do not stack, and stop applying once the agreement expires. |

### `quote/`

| spec | proves |
|---|---|
| `optional-lines.spec.js` | An optional extra is fully priced but excluded from the total and from the forecast, at line level and at section level, reversibly. |

### `journeys/`

| spec | proves |
|---|---|
| `subscription-lifecycle.spec.js` | Stages 1–4: quote → orders → contract with subscriptions → installed assets. |
| `subscription-renewal.spec.js` | Stages 5–7: renewal forecast, pro-rated amendments rolling into the existing contract, and a renewal quote of only the recurring items. |

---

## Tags

Every test carries at least one `@type:` and one `@domain:` tag, set through
Playwright's `tag` option and never in the test title. Journey stages carry a
`@stage:` as well. The full taxonomy is an allowlist, and the allowlist lives in
**`scripts/lint-tags.js`** — that file is the authority, and `npm run lint:tags`
fails the build on anything outside it.

That lint matters more than it looks. A mistyped tag does not error, it just
makes `--grep` match nothing, and the run goes green having tested nothing at
all.

---

## Running them

```bash
npm run test:dev                                    # everything, one process
npm run test:parallel                               # everything, lanes in parallel
npm run test:parallel -- --lanes=smartwatch,solar   # the ~10-minute fast loop
npm run test:parallel -- --print-lanes              # show the mapping, run nothing
npm run test:parallel -- --max-concurrent=2         # gentler on the org

npx playwright test tests/pricing/no-rule-fires.spec.js   # one file
npx playwright test --grep "@domain:pricing"              # one slice
npm run test:debug                                        # step through
```

`npm run report` opens the last HTML report; `npm run trace <path>` replays a
failure action by action, which is usually the fastest way to see what the
screen was doing.

---

## The lane rule

**A spec added to an existing folder joins that folder's lane automatically —
there is nothing to register.** A spec in a NEW folder makes that folder its own
lane, also automatically; and anything the coverage guard cannot place, such as
a spec sitting directly in `tests/`, fails the run by name rather than being
silently skipped.

The two exceptions are in `LANE_OVERRIDES` in `scripts/run-parallel.js`, each
with its reason: `config/` is split into two lanes because its two specs are
independent scenarios, and `journeys/` is kept as one lane pinned to a single
worker because its two files are the *same* scenario and must run in order.

---

## Adding a test

1. **Copy the shape of
   [`pricing/educational-netbook-list-price.spec.js`](pricing/educational-netbook-list-price.spec.js).**
   It is the smallest complete example of the house style: data file in, flow to
   seed and act, assertions on the record, one control product, evidence
   captures. Read it before writing anything.

2. **Put the scenario's inputs and its expected outcome in the same object in a
   `data/*.json` file.** Expected values are record field values, never formatted
   strings. If you do not know a value yet, leave the explicit `[SPECIFY]`
   placeholder — the guards in `src/utils/pricingData.js` will fail the test by
   name rather than letting an unvalidated scenario pass green.

3. **Seed through the API, act in the UI, assert against the record.** Use the
   `cpqData` fixture for anything you create (it tears down automatically and
   lands in the run ledger) and the read-only `sf` fixture for assertions. Never
   write through `sf`.

4. **Tag it** with at least one `@type:` and one `@domain:` from the allowlist
   in `scripts/lint-tags.js`, in the `tag` option. Run `npm run lint:tags`.

5. **Wait on conditions, never on time.** Poll the API through
   `src/utils/waitForAsync.js`, and put the value you are waiting for in the
   `WHERE` clause — polling for "a row exists" is satisfied instantly by the row
   that was already there, which reports a save that has not landed as a value
   that is simply wrong.

6. **Do not put selectors in your spec.** A click belongs in a page class under
   `src/pages/`; a multi-step business transition belongs in a flow under
   `src/flows/`. See **README.md Section 8** for adding a page object and
   **Section 7.1** for adding a flow.

7. **Read [`config/solar-bundle-configuration.spec.js`](config/solar-bundle-configuration.spec.js) last.**
   It is the most sophisticated spec here and the one documented exception to
   asserting against records — legitimately, because a constraint test asserts
   that nothing was saved. Read it once you know the house rule well enough to
   see why it is an exception rather than a precedent.
