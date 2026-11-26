'use strict';

/**
 * Workflow validator handler (manifest: `jira:workflowValidator`) —
 * dossier feature 6, the enforcement point of the app.
 *
 * Attached to the "Approve" transition. The issue is re-evaluated
 * against the CURRENT issue fields at transition time, and the
 * transition is blocked while the verdict is REJECT. The error
 * message names the rule that fired so the approver sees exactly why
 * approval cannot proceed.
 *
 * Transition payloads are thin: Forge delivers little more than the
 * issue id/key, the transition, and context — the amount/vendor live
 * in issue fields the payload does not carry. The validator therefore
 * re-fetches the issue with `fields=*all` (by key, then by id) and
 * merges every field source the payload does carry (issue.fields,
 * customFields, context issue). When the app user cannot browse the
 * project and the fetch comes back starved, the panel has usually
 * already evaluated the same issue as the viewing user: if the
 * extracted inputs are missing but do not contradict the stored
 * evaluation, the stored inputs are re-evaluated against the CURRENT
 * policy instead of blocking on a phantom missing amount. A stored
 * memo-injection block is never washed away by a starved fetch.
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

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

/**
 * Resolve the issue reference from every shape Forge uses for
 * workflow-validator invocations: top-level `issue`, the UI context
 * (`context.extension.issue`), platform-context `issueKey`/`issueId`
 * pairs, and explicit payload fields.
 */
function validatorIssueRef(event) {
  const ctx = (event && event.context) || {};
  const ext = ctx.extension || {};
  const extCtx = ctx.extensionContext || {};
  const platform = ctx.platformContext || {};
  const payload = (event && event.payload) || {};
  const issues = [
    event && event.issue,
    payload.issue,
    ext.issue,
    extCtx.issue,
    ctx.issue,
  ].filter((i) => i && typeof i === 'object');
  return {
    key: firstString(
      ...issues.map((i) => i.key),
      event && event.issueKey, payload.issueKey,
      ext.issueKey, extCtx.issueKey, platform.issueKey, ctx.issueKey,
    ),
    id: firstString(
      ...issues.map((i) => i.id),
      event && event.issueId, payload.issueId,
      ext.issueId, extCtx.issueId, platform.issueId, ctx.issueId,
    ),
  };
}

/**
 * Build an issue object from whatever fields the transition payload
 * carries. Forge delivers custom fields separately from issue.fields
 * on some event shapes, so merge them in (the trigger does the same).
 */
function eventIssue(event, ref) {
  const ctx = (event && event.context) || {};
  const ext = ctx.extension || {};
  const candidates = [
    event && event.issue,
    (event && event.payload && event.payload.issue),
    ext.issue,
    ctx.extensionContext && ctx.extensionContext.issue,
    ctx.issue,
  ].filter((i) => i && typeof i === 'object');
  const fields = {};
  for (const candidate of candidates) {
    Object.assign(fields, candidate.fields || {});
    Object.assign(fields, candidate.customFields || {});
  }
  Object.assign(fields, (event && event.customFields) || {});
  return { key: ref.key, id: ref.id, fields };
}

function mergeIssues(primary, fallback) {
  if (!primary) return fallback;
  if (!fallback) return primary;
  const fields = { ...(primary.fields || {}) };
  for (const [name, value] of Object.entries(fallback.fields || {})) {
    if (fields[name] === undefined || fields[name] === null || fields[name] === '') {
      fields[name] = value;
    }
  }
  return {
    ...primary,
    key: primary.key || fallback.key,
    id: primary.id || fallback.id,
    fields,
  };
}

/** Fetch the full issue (fields=*all) by key, then by id. */
async function fetchValidatorIssue(ref, fallbackIssue) {
  let fetched = null;
  const attempts = [ref.key, ref.id].filter(
    (v, i, arr) => v && arr.indexOf(v) === i,
  );
  for (const attempt of attempts) {
    try {
      fetched = await getIssue(attempt);
      break;
    } catch (err) {
      console.warn(
        `VaultMind validator: REST fetch failed for ${attempt}. ${err.message}`,
      );
    }
  }
  return mergeIssues(fetched, fallbackIssue);
}

function sameText(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

/**
 * When the fetched/transition issue is starved of the payment inputs
 * (no amount and/or no vendor extracted) but a stored evaluation
 * exists whose inputs the extracted fields do not contradict, fill
 * the missing inputs from that stored evaluation. Extracted values
 * that ARE present and differ always win — an edited issue is
 * re-evaluated on its new inputs, never on the stored ones.
 */
function fillFromStored(request, stored) {
  if (!stored || !Number.isFinite(stored.amountCents)) return request;
  const amountMissing = !Number.isFinite(request.amountCents);
  const vendorMissing = !request.vendor;
  if (!amountMissing && !vendorMissing) return request;
  const amountMatches = amountMissing || request.amountCents === stored.amountCents;
  const vendorMatches = vendorMissing || sameText(request.vendor, stored.vendor);
  const requesterMatches = !request.requester
    || request.requester === 'unknown'
    || sameText(request.requester, stored.requester);
  if (!amountMatches || !vendorMatches || !requesterMatches) return request;
  return {
    ...request,
    amountCents: amountMissing ? stored.amountCents : request.amountCents,
    vendor: vendorMissing ? (stored.vendor || '') : request.vendor,
    requester: request.requester && request.requester !== 'unknown'
      ? request.requester
      : (stored.requester || request.requester),
    currency: stored.currency || request.currency,
    sources: {
      ...(request.sources || {}),
      amount: amountMissing ? 'stored-evaluation' : (request.sources || {}).amount,
      vendor: vendorMissing ? 'stored-evaluation' : (request.sources || {}).vendor,
    },
  };
}

function storedMemoBlocked(stored) {
  return !!stored && Array.isArray(stored.rulesFired)
    && stored.rulesFired.includes('MEMO_INJECTION_BLOCKED');
}

async function handleValidator(event, store) {
  const ref = validatorIssueRef(event);
  if (!ref.key && !ref.id) return { result: true };

  try {
    const policy = await store.getPolicy();
    const issue = await fetchValidatorIssue(ref, eventIssue(event, ref));
    const issueKey = (issue && issue.key) || ref.key || ref.id;
    // Out-of-scope projects are not governed by this policy.
    if (!inScope(issue, policy)) return { result: true };

    let request = extractRequest(issue, policy);
    const stored = await store.getEvalRecord(issueKey);
    const filled = fillFromStored(request, stored);
    const usedStored = filled !== request;
    request = filled;

    // A starved fetch must not wash away a stored memo-injection
    // block: the memo that fired it is not visible to this fetch.
    if (usedStored && storedMemoBlocked(stored)) {
      return {
        result: false,
        errorMessage:
          'VaultMind: approval blocked — the request memo contains ' +
          'high-severity prompt-injection patterns (rule: ' +
          'MEMO_INJECTION_BLOCKED). See the VaultMind panel on this issue.',
      };
    }

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
    console.error(`VaultMind validator: evaluation failed for ${ref.key || ref.id}: ${err.message}`);
    return {
      result: false,
      errorMessage:
        'VaultMind: approval blocked — the policy check could not be ' +
        'completed. Try again, or ask an admin to check the VaultMind configuration.',
    };
  }
}

module.exports = { handleValidator, validatorIssueRef, eventIssue, fillFromStored };
