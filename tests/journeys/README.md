# `tests/journeys/` — the whole life of a deal

**What this folder proves:** that a deal survives every handoff from quote to
renewal. Quote → orders → contract with subscriptions → installed assets →
mid-term amendments → renewal forecast → renewal quote.

This is the path every piece of revenue in the system takes, and each step is a
different team's screen. A break in the middle is exactly the kind of thing
nobody owns until a customer complains.

## Read first

**[`subscription-lifecycle.spec.js`](subscription-lifecycle.spec.js)** — stages
1 to 4. Then **[`subscription-renewal.spec.js`](subscription-renewal.spec.js)** —
stages 5 to 7, which run against the contract the first file leaves behind.

Read them in that order. It is not optional: the second file cannot produce a
contract of its own and asserts against records the first one caused CPQ to
create.

## Four things that are different here

1. **Stages hand state to each other through a file on disk**
   (`artifacts/state/`), not through variables. Each stage is its own `test()`
   inside a serial describe, which buys a report reading "stage 2 failed, 3
   onward skipped" rather than one opaque failure inside a twenty-minute test.

2. **A freshness guard, not filename order.** `subscription-renewal.spec.js`
   loads state unconditionally and fails immediately if it belongs to a
   different run. Without it, running that file alone would happily amend last
   week's contract with every assertion still passing. Alphabetical ordering
   happens to put the files in the right sequence and is NOT what enforces it.

3. **Retries are OFF** (`retries: 0` on the describe). A retry restarts a serial
   group at stage 1, and stage 1 resumes nothing — it seeds a fresh
   Opportunity and Quote. So every mid-journey retry leaves a complete duplicate
   record tree in the org and spends another five minutes before reaching the
   stage that failed. Genuine org slowness is absorbed by the polls instead.

4. **These stages retain their records past teardown**, because the next stage
   needs them. Nothing is kept forever: the records still get ledger rows and
   the scheduled sweeper reclaims them after the retention window.

`subscription-stages.js` is not a spec. It holds the stage list and the state
key that BOTH files import — `resumeGuard()` compares a stage against its
position in that array, so two files each declaring their own copy would
disagree about what `RESUME_FROM` means and stages would silently run or
silently skip rather than erroring.

## Backed by

`data/home-security.json`.

## Tags

`@type:journey`, a `@domain:` per stage (`quote`, `orders`, `contracts`,
`amend`, `renewal`, `assets`), a `@stage:`, `@journey:subscription`, and
`@serial`. Journeys are grep-inverted out of the merge gate and run on the
nightly schedule.

## Lane

**`journeys`** — one lane for both files, pinned to `--workers=1`. This is one of
only two `LANE_OVERRIDES` entries in `scripts/run-parallel.js`, and it is the
opposite case to `config/`: the two files here are the SAME scenario, so the
folder is deliberately NOT split. One worker is what keeps stages 1–7 in order,
exactly as `npm run test:journey` pins it.

```bash
npm run test:journey                       # this folder alone, one worker
npm run test:parallel -- --lanes=journeys  # the same, as a lane
```
