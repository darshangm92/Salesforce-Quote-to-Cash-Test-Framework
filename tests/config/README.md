# `tests/config/` — the product configurator

**What this folder proves:** that the configurator stops a rep building
something that cannot be delivered, and that the choices they legitimately make
survive onto the quote and then onto the order that gets fulfilled.

Two bundles, two very different questions. The solar hub is about
**constraints** — what the screen refuses. The smartwatch is about
**attributes** — what the screen captures and where those values end up.

## Read first

**[`smartwatch-attributes.spec.js`](smartwatch-attributes.spec.js)**, because
following a value from a dropdown onto a saved record is the easier story to
hold.

**Read [`solar-bundle-configuration.spec.js`](solar-bundle-configuration.spec.js)
LAST** — of this folder and of the whole suite. It is the most sophisticated
spec here and it is the one documented exception to the house rule about
asserting against records, so it is the file most likely to be misread as
precedent by someone who meets it early.

## The exception, stated plainly

Everywhere else: act in the UI, assert against the record. Here, many assertions
are on the screen — and the reason is narrow rather than convenient. **A
constraint test asserts that nothing was saved.** A rejected Save writes no
record; a refused deselect changes no field; a read-only quantity cell has no
field to change. There is nothing to read, so the screen is where the outcome
exists.

The moment a step DOES commit something, it goes straight back to asserting on
the record through `sf`. This is not a licence to assert on the DOM elsewhere.

## Why these specs are slow, and what decides that

Only a SUCCESSFUL Save exits the configurator; a rejected one leaves you where
you are. So the cost is not one session per scenario, it is **one re-entry per
accepted Save**, at roughly a minute of application cold start each. That is why
the solar spec's 31 steps run in three sessions rather than 31, and why five
rejection scenarios cost one session between them.

## Backed by

`data/solar-bundle.json` and `data/smartwatch-bundle.json`. Both carry `_`-prefixed
notes recording what was measured against the org — including three source-scenario
steps that are **not performable** here, and say so rather than being faked.

## Tags

Both are single-test specs, and both carry `@type:regression`, `@domain:config`,
`@risk:high`, `@speed:slow` and **`@quota:heavy`**. The smartwatch spec adds
`@domain:orders`, because it follows its attributes all the way onto an Order.

`@quota:heavy` is the one to notice: it means **neither of these runs on the
merge gate**. `npm run test:pr` grep-inverts it, so a configurator regression is
caught on the nightly schedule or by an explicit lane run — not on the PR that
caused it.

## Lanes

Two — **`smartwatch`** and **`solar`**, one spec each. This is one of only two
`LANE_OVERRIDES` entries in `scripts/run-parallel.js`: the folder is SPLIT
because its two specs are genuinely independent scenarios, and running them as
one lane would serialise about sixteen minutes of work for no reason.
