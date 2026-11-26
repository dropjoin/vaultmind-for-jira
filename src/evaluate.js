'use strict';

/**
 * Evaluation orchestration shared by every entry point (issue trigger,
 * workflow validator, issue panel, Rovo actions). One code path means
 * one verdict: the panel, the validator and the agent can never disagree.
 *
 * Daily-budget bookkeeping uses a RESERVATION model, mirroring how the
 * on-chain vault counts a spend the moment it happens:
 *   - When a request PASSes, its amount is reserved against today's cap
 *     and the reservation is stored on the issue's eval record.
 *   - Re-evaluating the same issue first RELEASES its previous
 *     reservation for today, then evaluates against the remaining spend.
 *     Editing an issue up and re-checking can therefore never
 *     double-count it, and an edited-down request frees its budget.
 *   - A REJECT reserves nothing.
 *   - Yesterday's reservations never leak into today: spend totals are
 *     stored per UTC day and reservations only offset the same day.
 *
 * Every persisted evaluation is appended to the audit log (inputs,
 * verdict, rule fired, actor, source) — including REJECTs and
 * re-evaluations.
 *
 * READ PATHS MUST NOT RESERVE BUDGET. The trigger (on create/update)
 * and the workflow validator (at approval time) are the write paths:
 * they persist the evaluation, the reservation and the audit entry.
 * The Rovo agent action is a read: it calls evaluateIssue with
 * `persist: false`, which computes the exact same verdict without
 * touching the spend total, the eval record, or the audit log. The
 * issue panel is also a read once an evaluation exists; its only
 * write is the first evaluation for an issue with no stored record,
 * so a missed trigger cannot leave the panel and audit blank.
 */

const { evaluatePolicy } = require('./policy');
const { dayKey } = require('./store');

/**
 * @param {object} store  Store from store.js (Forge KVS or in-memory).
 * @param {object} args
 * @param {string} args.issueKey
 * @param {object} args.request  Output of issueFields.extractRequest().
 * @param {string} args.actor    accountId / 'trigger' / 'agent' / 'validator'
 * @param {string} args.source   'trigger' | 'validator' | 'panel' | 'agent-action'
 * @param {Date}   [args.now]    Injectable clock for tests.
 * @param {boolean} [args.persist=true]  When false, compute the verdict
 *   without writing anything (read path — see the header note). The
 *   returned record is transient: same shape, never stored.
 * @returns {Promise<{verdict, evaluation, record}>}
 */
async function evaluateIssue(store, { issueKey, request, actor, source, now = new Date(), persist = true }) {
  const policy = await store.getPolicy();
  const today = dayKey(now);

  const prev = await store.getEvalRecord(issueKey);
  const spentTotal = await store.getSpent(today);
  // Release this issue's own earlier reservation for today before
  // evaluating, so the daily-cap check sees spend from OTHER requests.
  const ownReservation = prev && prev.counted && prev.day === today
    ? prev.amountCents : 0;
  const spentByOthers = Math.max(spentTotal - ownReservation, 0);

  const evaluation = evaluatePolicy({
    policy,
    spentTodayCents: spentByOthers,
    request,
  });

  const counted = evaluation.passed;
  const newSpent = counted ? spentByOthers + request.amountCents : spentByOthers;

  const record = {
    issueKey,
    day: today,
    evaluatedAt: now.toISOString(),
    verdict: evaluation.verdict,
    rulesFired: evaluation.rulesFired,
    primaryRule: evaluation.primaryRule,
    reasons: evaluation.reasons,
    amountCents: Number.isFinite(request.amountCents) ? request.amountCents : null,
    vendor: request.vendor || '',
    requester: request.requester || '',
    currency: request.currency || policy.currency,
    counted,
    spentTodayCents: newSpent,
    dailyHeadroomCents: evaluation.facts.dailyHeadroomCents,
    // Budget left AFTER this request's reservation (for a REJECT, the
    // same as the headroom — a rejection reserves nothing). Callers
    // that report "remaining" must use this, not dailyHeadroomCents,
    // which is the headroom BEFORE this request.
    remainingAfterCents: evaluation.facts.remainingAfterCents,
    actor,
    source,
  };
  if (persist) {
    if (newSpent !== spentTotal) {
      await store.setSpent(today, newSpent);
    }
    await store.setEvalRecord(issueKey, record);
    await store.appendAudit({ ...record, kind: 'evaluation' });
  }

  return { verdict: evaluation.verdict, evaluation, record };
}

module.exports = { evaluateIssue };
