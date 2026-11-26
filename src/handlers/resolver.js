'use strict';

/**
 * UI resolver — one Forge function serving both frontends:
 *   - Issue panel (`jira:issuePanel`): getPanelData
 *   - Admin page (`jira:adminPage`):   getPolicy, savePolicy,
 *                                      getAuditLog, exportAuditCsv
 *
 * The panel never freelances a verdict: it shows the stored evaluation.
 * If the trigger has not recorded one yet (missed event, REST hiccup,
 * issue created before install), the first panel read evaluates and
 * persists the verdict so the panel and audit trail cannot stay blank
 * for a payment request. Later reads re-evaluate only as a dry run
 * when the issue's current fields differ from what was last evaluated,
 * so repeated viewing never reserves budget twice or spams the audit.
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

function issueRefFromContext(req) {
  const ctx = (req && req.context) || {};
  const ext = ctx.extension || ctx.extensionContext || {};
  const issue = ext.issue || {};
  return {
    key: issue.key || ext.issueKey || (req && req.payload && req.payload.issueKey) || '',
    id: issue.id || ext.issueId || '',
  };
}

async function fetchPanelIssue(issueKey, issueId) {
  try {
    return await getIssue(issueKey);
  } catch (err) {
    console.warn(`VaultMind panel: issue fetch failed for ${issueKey}: ${err.message}`);
    if (!issueId || String(issueId) === String(issueKey)) return null;
    try {
      return await getIssue(issueId);
    } catch (retryErr) {
      console.warn(`VaultMind panel: issue fetch by id failed for ${issueKey}: ${retryErr.message}`);
      return null;
    }
  }
}

async function getPanelData(store, issueKey, issueId) {
  const policy = await store.getPolicy();
  const today = dayKey();
  const issue = await fetchPanelIssue(issueKey, issueId);
  const canonicalKey = (issue && issue.key) || issueKey;

  let record = await store.getEvalRecord(canonicalKey);
  if (issue && inScope(issue, policy)) {
    const request = extractRequest(issue, policy);
    if (!record) {
      ({ record } = await evaluateIssue(store, {
        issueKey: canonicalKey, request, actor: 'panel', source: 'panel',
      }));
    } else if (inputsDiffer(record, request)) {
      ({ record } = await evaluateIssue(store, {
        issueKey: canonicalKey, request, actor: 'panel', source: 'panel', persist: false,
      }));
    }
  }

  const audit = await store.getAuditForIssue(canonicalKey);
  const spentTodayCents = await store.getSpent(today);
  return {
    issueKey: canonicalKey,
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
}

function buildResolver(store) {
  const Resolver = require('@forge/resolver').default;
  const resolver = new Resolver();

  // ----- issue panel ---------------------------------------------------
  resolver.define('getPanelData', async (req) => {
    const { key, id } = issueRefFromContext(req);
    return getPanelData(store, key, id);
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

module.exports = { buildResolver, csvEscape, getPanelData, issueRefFromContext };
