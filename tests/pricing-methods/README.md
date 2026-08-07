# `tests/pricing-methods/` — derived pricing

**What this folder proves:** that products whose price is DERIVED rather than
read from the catalogue derive it correctly. Quantity bands, a percentage of
other lines on the quote, cost plus the rep's margin, a bundle overriding what a
component costs inside it, and prices negotiated per customer.

The distinction from [`../pricing/`](../pricing/) is not filing tidiness. A price
rule overwrites a price CPQ already resolved; a pricing method decides how CPQ
resolves it at all. Filing these next to the rules would leave that folder's
naming convention — one file per rule record — describing only half its contents.

## Naming

The filename is the mechanism, kebab-cased. The subjects here are
`Product2.SBQQ__PricingMethod__c`, `SBQQ__BlockPrice__c`,
`SBQQ__ProductOption__c`, `SBQQ__Cost__c` and `SBQQ__ContractedPrice__c` — none
of which is a record an admin opens as "a rule".

## Read first

**[`block-pricing.spec.js`](block-pricing.spec.js)** — the clearest example of
the pattern this whole folder uses: a `beforeAll` guard that reads the org's
configuration through the read-only `sf` fixture and fails *before a browser
launches* if it has moved. That ordering is the point. Without it, an admin
moving a band boundary surfaces fifteen minutes later as a price mismatch, which
reads like a calculator defect and sends the next person to debug CPQ instead of
the data.

Then **[`percent-of-total.spec.js`](percent-of-total.spec.js)**, which is where
the relational-assertion argument is made most fully: every expectation is
computed from what the other lines actually netted, never from a literal.

## Two things that will bite you

- **The assertion cadence is mixed, on purpose.** Steps that commit assert on the
  record; intermediate steps in a sweep assert on the value the editor displays.
  A displayed value proves the editor resolved the price, not that CPQ wrote it —
  that trade is stated in each spec's header, and no step is downgraded to a
  screenshot with no assertion at all.
- **Configuration is read, never written.** Mutating shared config would force
  this folder serial and make every failure ambiguous between "the setup is
  wrong" and "CPQ priced it wrong".

## Backed by

`data/pricing-methods.json`, with provenance on every value, plus the guards in
`src/utils/pricingConfig.js`.

One dependency worth knowing: `contracted-pricing.spec.js`'s expiry test reads
**two hand-staged org records** that no automation maintains — an agreement whose
end date has passed, and a quote written before it. A test cannot create a record
in the past. See the `_staging` note in the data file.

## Tags

`@type:regression`, `@domain:pricing`, `@speed:slow` on every describe. Seven
tests carry `@risk:high` — at least the primary test of each mechanism, and both
the in-scope and expiry tests of contracted pricing. `@type:negative` appears
once, on the out-of-scope contracted-pricing test.

## Lane

**`pricing-methods`** — all five specs, one Playwright process, one worker. Joins
the `pricing-approvals` CI slice through `@domain:pricing`.
