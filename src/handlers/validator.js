'use strict';

/**
 * Workflow validator handler (manifest: `jira:workflowValidator`) —
 * dossier feature 6, the enforcement point of the app.
 *
 * Attached to the "Approve" transition. The issue is re-evaluated
 * against the CURRENT issue fields at transition time (never a stale
 * stored verdict), and the transition is blocked while the verdict is
 * REJECT. The error message names the rule that fired so the approver
 * sees exactly why approval cannot proceed.
 *
 * Fail-closed: if the policy check itself cannot be completed (a
 * storage error, a malformed stored policy, any evaluation failure),
 * the transition is BLOCKED rather than allowed on an unknown verdict.
 *
 * Forge contract: return { result: true } to allow the transition, or
 * { result: false, errorMessage } to block it.
 */

const { evaluateIssue } = require('../evaluate');
const { extractRequest, inScope } = require('../issueFields');
const { getIssue } = require('../jira');

async function handleValidator(event, store) {
  const issueKey = event && event.issue && event.issue.key;
  if (!issueKey) return { result: true };

  try {
    const policy = await store.getPolicy();
    let issue = event.issue;
    try {
      issue = await getIssue(issueKey);
    } catch (err) {
      console.warn(`VaultMind validator: REST fetch failed for ${issueKey}, using event payload. ${err.message}`);
    }
    // Out-of-scope projects are not governed by this policy.
    if (!inScope(issue, policy)) return { result: true };

    const request = extractRequest(issue, policy);
    const { evaluation } = await evaluateIssue(store, {
      issueKey,
      request,
      actor: 'validator',
      source: 'validator',
    });

    if (evaluation.passed) return { result: true };
    return {
      result: false,
      errorMessage:
        `VaultMind: approval blocked — ${evaluation.reasons[0]} ` +
        `(rule: ${evaluation.primaryRule}). See the VaultMind panel on this issue.`,
    };
  } catch (err) {
    console.error(`VaultMind validator: evaluation failed for ${issueKey}: ${err.message}`);
    return {
      result: false,
      errorMessage:
        'VaultMind: approval blocked — the policy check could not be ' +
        'completed. Try again, or ask an admin to check the VaultMind configuration.',
    };
  }
}

module.exports = { handleValidator };
