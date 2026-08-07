// tests/journeys/subscription-stages.js
//
// The subscription journey's stage list and state key, shared by the two spec
// files that make up the chain:
//
//   subscription-lifecycle.spec.js   stages 1-4  (quote, order, contract, asset)
//   subscription-renewal.spec.js     stages 5-7  (renewal forecast, amendment,
//                                                 renewal quote)
//
// One list, in one place, because resumeGuard() compares a stage name against
// its POSITION in this array. Two files each declaring their own copy would
// mean RESUME_FROM=amendment resolving to index 4 in one file and index 5 in
// the other, and the disagreement would show up as stages silently running or
// silently skipping rather than as an error.
//
// STATE_KEY is deliberately the same for both files. They share one state
// document by design: stages 5-7 consume the contract, opportunity and account
// that stages 1-4 left behind, and a second key would mean a second copy of
// the same Ids drifting apart.
//
// This file exports these two bindings and nothing else. It is not a place for
// helpers — anything that grows here becomes a dependency of both specs.
const STAGES = ['quote', 'order', 'contract', 'asset',
                'renewal-forecast', 'amendment', 'renewal-quote'];
const STATE_KEY = 'subscription-lifecycle';

module.exports = { STAGES, STATE_KEY };
