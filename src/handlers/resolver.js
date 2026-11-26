'use strict';

/**
 * UI resolver — one Forge function serving both frontends:
 *   - Issue panel (`jira:issuePanel`): getPanelData
 *   - Admin page (`jira:adminPage`):   getPolicy, savePolicy,
 *                                      getAuditLog, exportAuditCsv
 *
 * The panel never freelances a verdict: it shows the stored evaluation,
 * re-evaluating only when the issue's current fields differ from what
 * was last evaluated (amount/vendor changed since the trigger ran).
 * That re-evaluation is a dry run (persist: false): viewing an issue
 * never reserves budget or writes an audit entry.
 */

const { evaluateIssue } = require('../evaluate');
const { extractRequest, inScope } = require('../issueFields');
const { getIssue } = require('../jira');
const { toCents, formatMoney } = require('../policy');
const { dayKey } = require('../store');

function inputsDiffer(record, request) {
  if (!record) return true;
  return record.amountCents !== (Number.isFinite(request.amountCents) ? request.amountCents : null)
    || record.vendor !== (request.vendor || '')
    || record.requester !== (request.requester || '');
}

function csvEscape(value) {
  let s = value === null || value === undefined ? '' : String(value);
  // CSV formula injection: vendor/requester text is attacker-controlled
  // issue content. A cell starting with =, +, -, @ (or tab/CR) would be
  // executed as a formula when the export is opened in a spreadsheet,
  // so force such cells to plain text with a leading single quote.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildResolver(store) {
  const Resolver = require('@forge/resolver').default;
  const resolver = new Resolver();

  // ----- issue panel ---------------------------------------------------
  resolver.define('getPanelData', async (req) => {
    const issueKey = req.context.extension.issue.key;
    const policy = await store.getPolicy();
    const today = dayKey();

    let issue = null;
    try {
      issue = await getIssue(issueKey);
    } catch (err) {
      console.warn(`VaultMind panel: issue fetch failed for ${issueKey}: ${err.message}`);
    }

    let record = await store.getEvalRecord(issueKey);
    if (issue && inScope(issue, policy)) {
      const request = extractRequest(issue, policy);
      if (inputsDiffer(record, request)) {
        ({ record } = await evaluateIssue(store, {
          issueKey, request, actor: 'panel', source: 'panel', persist: false,
        }));
      }
    }

    const audit = await store.getAuditForIssue(issueKey);
    const spentTodayCents = await store.getSpent(today);
    return {
      issueKey,
      inScope: issue ? inScope(issue, policy) : true,
      policy: {
        configured: policy.configured,
        frozen: policy.frozen,
        currency: policy.currency,
        perTxCap: formatMoney(policy.perTxCapCents, policy.currency),
        dailyCap: formatMoney(policy.dailyCapCents, policy.currency),
        perTxCapCents: policy.perTxCapCents,
        dailyCapCents: policy.dailyCapCents,
        allowedVendors: policy.allowedVendors,
      },
      verdict: record,
      spentToday: formatMoney(spentTodayCents, policy.currency),
      spentTodayCents,
      auditTrail: audit.slice(-10).reverse(),
    };
  });

  // ----- admin: policy config ------------------------------------------
  resolver.define('getPolicy', async () => {
    const policy = await store.getPolicy();
    return {
      ...policy,
      perTxCap: policy.perTxCapCents / 100,
      dailyCap: policy.dailyCapCents / 100,
    };
  });

  resolver.define('savePolicy', async (req) => {
    const p = req.payload || {};
    const perTxCapCents = toCents(p.perTxCap);
    const dailyCapCents = toCents(p.dailyCap);
    if (!Number.isFinite(perTxCapCents) || perTxCapCents < 0 ||
        !Number.isFinite(dailyCapCents) || dailyCapCents < 0) {
      throw new Error('Caps must be valid non-negative amounts.');
    }
    const lines = (v) => (Array.isArray(v) ? v : String(v || '').split('\n'))
      .map((s) => String(s).trim()).filter(Boolean);
    const policy = {
      configured: true,
      frozen: !!p.frozen,
      currency: String(p.currency || 'USD').toUpperCase().slice(0, 8),
      perTxCapCents,
      dailyCapCents,
      allowedVendors: lines(p.allowedVendors),
      allowedRequesters: lines(p.allowedRequesters),
      projectKey: String(p.projectKey || '').toUpperCase().trim(),
    };
    await store.setPolicy(policy);
    return { ok: true, policy };
  });

  // ----- admin: audit report -------------------------------------------
  resolver.define('getAuditLog', async (req) => {
    const day = (req.payload && req.payload.day) || dayKey();
    return { day, entries: await store.getAuditForDay(day) };
  });

  resolver.define('exportAuditCsv', async (req) => {
    const day = (req.payload && req.payload.day) || dayKey();
    const entries = await store.getAuditForDay(day);
    const header = 'timestamp,issue,verdict,rule,amount,currency,vendor,requester,actor,source';
    const rows = entries.map((e) => [
      e.evaluatedAt, e.issueKey, e.verdict, e.primaryRule || '',
      e.amountCents === null ? '' : (e.amountCents / 100).toFixed(2),
      e.currency, e.vendor, e.requester, e.actor, e.source,
    ].map(csvEscape).join(','));
    return { day, csv: [header, ...rows].join('\n') };
  });

  return resolver.getDefinitions();
}

module.exports = { buildResolver, csvEscape };
