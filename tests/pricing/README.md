# `tests/pricing/` — price rules

**What this folder proves:** that the org's `SBQQ__PriceRule__c` records fire on
the quotes they are meant to fire on, write the price they are configured to
write, and stay switched off everywhere else.

A price rule OVERWRITES a price after CPQ has already resolved one. That is what
separates this folder from [`../pricing-methods/`](../pricing-methods/), where
the subject is how CPQ resolves a price in the first place.

## Naming

One file per rule, named after the rule record an admin would open in Setup, and
the `describe` title is that record's name verbatim. So a red build names the
record to go and look at. No test title carries a scenario number — source-document
traceability lives in the `_scenario` keys in the data file, where it is more
accurate than a title could stay.

## Read first

**[`educational-netbook-list-price.spec.js`](educational-netbook-list-price.spec.js)** —
the smallest complete example of the house style, and the template the
`tests/README.md` recipe points at.

Then **[`no-rule-fires.spec.js`](no-rule-fires.spec.js)**, which is the
counterweight to the whole folder: one quote for a customer who qualifies for
nothing, proving every rule stays off. A rule that fires on everything looks
exactly like a rule that works, from inside a test that only quotes qualifying
customers.

## Backed by

`data/pricing-rules.json`. Its `_rulesAsConfigured` block records how every rule
was configured when these tests were written — that is the first thing to diff
against the org when one of them fails. Its `accounts` block resolves customers
two ways: a literal name where the rule is keyed to that specific record, and a
SOQL predicate where the scenario only DESCRIBES one ("fewer than 50
employees"). A predicate that matches nothing throws; it never falls back.

## Tags

`@type:regression`, `@domain:pricing`, `@speed:slow` on every describe. Three
tests add `@risk:high`. Two specs carry `@type:negative` — `no-rule-fires` on its
describe, and `small-business-ssd-special-price` on the second of its two tests,
the one proving a large employer gets nothing.

## Lane

**`pricing`** — all seven specs, one Playwright process, one worker. Joins the
`pricing-approvals` CI slice through `@domain:pricing`.
