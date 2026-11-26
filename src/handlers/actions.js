'use strict';

/**
 * Rovo agent actions (manifest: `action` modules) — dossier feature 7.
 *
 * Guard pattern (dossier §2.3): every action is GET-verb and read-only
 * from the agent's point of view. The verdict the agent reports is the
 * deterministic engine's verdict — the agent layer adds no judgement
 * of its own and cannot override, soften, or invent one. The evaluate
 * action runs the same shared evaluation path as the trigger, but as
 * a DRY RUN (persist: false in evaluate.js): asking about a request
 * never reserves daily budget, never overwrites the stored evaluation,
 * and never writes an audit entry, so an agent answer always matches
 * the panel and the validator without changing any state.
 */

const { evaluateIssue } = require('../evaluate');
const { extractRequest, inScope } = require('../issueFields');
const { getIssue } = require('../jira');
const { formatMoney } = require('../policy');
const { dayKey } = require('../store');

/** Jira issue keys look like PAY-123 (project key, dash, number). */
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/i;

async function evaluateAction(store, payload) {
  const rawKey = payload && payload.issueKey;
  const issueKey = typeof rawKey === 'string' ? rawKey.trim() : '';
  if (!ISSUE_KEY_RE.test(issueKey)) {
    return { error: 'A valid Jira issue key is required, e.g. PAY-123.' };
  }

  const policy = await store.getPolicy();
  let issue;
  try {
    issue = await getIssue(issueKey);
  } catch (err) {
    return { error: `Could not load issue ${issueKey}: ${err.message}` };
  }
  // Use the canonical key from Jira, not the caller's spelling: a
  // lowercase 'pay-123' must not create a second, shadow evaluation
  // record alongside the trigger's 'PAY-123' one.
  const canonicalKey = (issue && issue.key) || issueKey;
  if (!inScope(issue, policy)) {
    return {
      issueKey: canonicalKey,
      verdict: 'NOT_EVALUATED',
      note: `Issue ${canonicalKey} is outside the VaultMind project scope (${policy.projectKey}).`,
    };
  }

  const request = extractRequest(issue, policy);
  const { record } = await evaluateIssue(store, {
    issueKey: canonicalKey, request, actor: 'agent', source: 'agent-action',
    persist: false,
  });

  return {
    issueKey: canonicalKey,
    verdict: record.verdict,
    amount: formatMoney(record.amountCents, record.currency),
    vendor: record.vendor,
    requester: record.requester,
    ruleFired: record.primaryRule,
    reasons: record.reasons,
    dailyBudgetRemaining: formatMoney(record.remainingAfterCents, record.currency),
    evaluatedAt: record.evaluatedAt,
  };
}

async function dailySpendAction(store) {
  const policy = await store.getPolicy();
  const today = dayKey();
  const spent = await store.getSpent(today);
  return {
    day: today,
    currency: policy.currency,
    spentToday: formatMoney(spent, policy.currency),
    dailyCap: formatMoney(policy.dailyCapCents, policy.currency),
    remaining: formatMoney(Math.max(policy.dailyCapCents - spent, 0), policy.currency),
    frozen: policy.frozen,
  };
}

async function policyAction(store) {
  const policy = await store.getPolicy();
  return {
    configured: policy.configured,
    frozen: policy.frozen,
    currency: policy.currency,
    perTransactionCap: formatMoney(policy.perTxCapCents, policy.currency),
    dailyCap: formatMoney(policy.dailyCapCents, policy.currency),
    allowedVendors: policy.allowedVendors,
    allowedRequesters: policy.allowedRequesters,
    projectKey: policy.projectKey || '(all projects)',
  };
}

module.exports = { evaluateAction, dailySpendAction, policyAction };
