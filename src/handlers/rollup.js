'use strict';

/**
 * Scheduled trigger handler (manifest: `scheduledTrigger`, daily) —
 * dossier stretch feature 12.
 *
 * Writes a daily rollup entry into the audit log (yesterday's counted
 * spend + evaluation count) so the admin report shows the day boundary
 * explicitly. Day windows are UTC and spend totals are stored per day,
 * so the "reset" is inherent — this job only records the summary.
 *
 * Idempotent: if a rollup entry already exists for the day (a retried
 * or overlapping scheduled run), no second entry is written.
 */

const { dayKey } = require('../store');

async function handleDailyRollup(store, now = new Date()) {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const day = dayKey(yesterday);
  const spent = await store.getSpent(day);
  const entries = await store.getAuditForDay(day);
  const evaluationCount = entries.filter((e) => e.kind === 'evaluation').length;
  if (entries.some((e) => e.kind === 'daily-rollup')) {
    return { day, spentCents: spent, evaluations: evaluationCount, skipped: true };
  }
  await store.appendAudit({
    kind: 'daily-rollup',
    day,
    issueKey: '(rollup)',
    evaluatedAt: now.toISOString(),
    verdict: 'SUMMARY',
    primaryRule: null,
    amountCents: spent,
    currency: (await store.getPolicy()).currency,
    vendor: '',
    requester: '',
    actor: 'scheduled-trigger',
    source: 'rollup',
    evaluations: evaluationCount,
  });
  return { day, spentCents: spent, evaluations: evaluationCount };
}

module.exports = { handleDailyRollup };
