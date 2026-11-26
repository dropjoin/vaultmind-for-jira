'use strict';

/**
 * Forge function entry points. The manifest's `function` module keys map
 * to the exports of this file (handler: index.<name>).
 *
 * Everything below is a thin adapter: build the Forge-backed store,
 * delegate to the shared handlers in src/handlers/, return. All policy
 * decisions live in src/policy.js + src/evaluate.js.
 */

const { createForgeStore } = require('./store');
const { handleIssueTrigger } = require('./handlers/trigger');
const { handleValidator } = require('./handlers/validator');
const { handleDailyRollup } = require('./handlers/rollup');
const actions = require('./handlers/actions');

const store = createForgeStore();

// UI resolver (issue panel + admin page). @forge/resolver only exists
// inside the Forge runtime, so it is built lazily on first invocation.
let resolverDefinitions = null;
exports.resolver = async (...args) => {
  if (!resolverDefinitions) {
    resolverDefinitions = require('./handlers/resolver').buildResolver(store);
  }
  return resolverDefinitions(...args);
};

exports.triggerHandler = async (event) => {
  await handleIssueTrigger(event, store);
};

exports.validatorHandler = async (event) => handleValidator(event, store);

exports.dailyRollup = async () => handleDailyRollup(store);

// Rovo agent actions (GET-verb, guard pattern — see handlers/actions.js).
exports.evaluateAction = async (event) => actions.evaluateAction(store, event.payload || {});
exports.dailySpendAction = async () => actions.dailySpendAction(store);
exports.policyAction = async () => actions.policyAction(store);
