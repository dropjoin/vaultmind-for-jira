'use strict';

/**
 * Product trigger handler (manifest: `trigger` on
 * avi:jira:created:issue / avi:jira:updated:issue) — dossier feature 4.
 *
 * Every created/updated payment-request issue in the designated
 * project is evaluated by the deterministic engine and the verdict is
 * posted as an issue comment: PASS/REJECT, the reasons, the rule that
 * fired, and the remaining daily budget. This is the write path — Rovo
 * agent actions stay read-only (GET) and never post comments.
 *
 * Two guards keep the trigger from spamming issues:
 *   - Issues with no payment-request signal at all (no amount, no
 *     vendor anywhere) and no previous evaluation are skipped: a bug
 *     or task in the project must not collect a REJECT comment on
 *     every edit. An issue that HAS been evaluated is always
 *     re-evaluated, so clearing its fields still flips it to REJECT.
 *   - A verdict comment is only posted when the verdict actually
 *     changed since the previous evaluation (see shouldPostComment):
 *     unrelated edits (assignee, labels) re-evaluate silently instead
 *     of re-posting the identical verdict comment.
 */

const { evaluateIssue } = require('../evaluate');
const { extractRequest, inScope, hasPaymentSignals } = require('../issueFields');
const { getIssue, addComment, textToAdf } = require('../jira');
const { formatMoney } = require('../policy');

function verdictComment(record) {
  const icon = record.verdict === 'PASS' ? '✅' : '⛔';
  const headline =
    `${icon} VaultMind verdict: ${record.verdict} — ` +
    `${formatMoney(record.amountCents, record.currency)} to ${record.vendor || '(no vendor)'}`;
  const bullets = [...record.reasons];
  if (record.primaryRule) bullets.push(`Rule fired: ${record.primaryRule}`);
  bullets.push(
    `Daily budget remaining after this check: ${formatMoney(record.remainingAfterCents, record.currency)}`,
  );
  return textToAdf([headline, 'Checked by the deterministic VaultMind policy engine.'], bullets);
}

/**
 * True when the new evaluation differs from the previous one in any
 * way the comment shows (verdict, inputs, rule, reasons, remaining
 * budget) or belongs to a new day. Identical re-evaluations — the
 * normal case for unrelated issue edits and duplicate event
 * deliveries — post no comment.
 */
function shouldPostComment(prev, record) {
  if (!prev) return true;
  if (prev.day !== record.day) return true;
  return prev.verdict !== record.verdict
    || prev.amountCents !== record.amountCents
    || prev.vendor !== record.vendor
    || prev.requester !== record.requester
    || prev.primaryRule !== record.primaryRule
    || (prev.reasons || []).join('\n') !== (record.reasons || []).join('\n')
    || prev.remainingAfterCents !== record.remainingAfterCents;
}

function eventIssue(event) {
  const issue = (event && event.issue) || {};
  // Forge delivers custom fields separately from issue.fields on issue
  // events. Merge them so the payload fallback still carries the
  // payment signals when the REST re-fetch is unavailable.
  return {
    ...issue,
    fields: {
      ...((issue && issue.fields) || {}),
      ...((event && event.customFields) || {}),
    },
  };
}

function eventActor(event) {
  const users = event && event.associatedUsers && event.associatedUsers.users;
  const first = Array.isArray(users) ? users[0] : null;
  return (first && (first.accountId || first.id))
    || (event && event.atlassianId)
    || 'trigger';
}

async function handleIssueTrigger(event, store) {
  const issueKey = event && event.issue && event.issue.key;
  if (!issueKey) return;

  const policy = await store.getPolicy();
  // Prefer the full issue from REST — trigger payloads can be partial.
  let issue = eventIssue(event);
  try {
    issue = await getIssue(issueKey);
  } catch (err) {
    console.warn(`VaultMind trigger: REST fetch failed for ${issueKey}, using event payload. ${err.message}`);
  }
  if (!inScope(issue, policy)) return;

  const prev = await store.getEvalRecord(issueKey);
  if (!hasPaymentSignals(issue) && !prev) return;

  const request = extractRequest(issue, policy);
  let record;
  try {
    ({ record } = await evaluateIssue(store, {
      issueKey,
      request,
      actor: eventActor(event),
      source: 'trigger',
    }));
  } catch (err) {
    // A failed evaluation (e.g. a storage error) must not crash the
    // trigger: log it and post nothing rather than a verdict that was
    // never computed. The panel and validator re-evaluate on demand.
    console.error(`VaultMind trigger: evaluation failed for ${issueKey}: ${err.message}`);
    return;
  }

  if (!shouldPostComment(prev, record)) return;

  try {
    await addComment(issueKey, verdictComment(record));
  } catch (err) {
    // The verdict is already stored + audited; a failed comment must not
    // fail the trigger (the panel and validator read the stored record).
    console.error(`VaultMind trigger: comment failed for ${issueKey}: ${err.message}`);
  }
}

module.exports = { handleIssueTrigger, verdictComment, shouldPostComment, eventIssue };
