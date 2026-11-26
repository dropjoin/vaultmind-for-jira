'use strict';

/**
 * UI resolver — one Forge function serving both frontends:
 *   - Issue panel (`jira:issuePanel`): getPanelData
 *   - Admin page (`jira:adminPage`):   getPolicy, savePolicy,
 *                                      getAuditLog, exportAuditCsv
 *
 * The panel never freelances a verdict: it shows the stored evaluation.
 * If the trigger has not recorded one yet (missed event, REST hiccup,
 * issue created before install), the first panel read of a payment
 * request evaluates and persists the verdict so the panel and audit
 * trail cannot stay blank. Later reads persist a fresh verdict only
 * when the issue's current fields differ from what was last
 * evaluated, so repeated viewing never reserves budget twice or
 * spams the audit, while an edited request is never shown a stale
 * verdict.
 */

const { evaluateIssue } = require('../evaluate');
const { extractRequest, inScope, hasPaymentSignals } = require('../issueFields');
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

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function issueKeyFromLocation(location) {
  const text = String(location || '');
  const browse = text.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/i);
  if (browse) return browse[1].toUpperCase();
  const selected = text.match(/[?&]selectedIssue=([A-Z][A-Z0-9]+-\d+)/i);
  return selected ? selected[1].toUpperCase() : '';
}

/**
 * Resolve the issue reference from every context/payload shape Forge
 * has used for UI Kit issue panels: the current
 * `context.extension.issue.{key,id}`, the platform-context
 * `issueKey`/`issueId` pair, the legacy `extensionContext` fields,
 * and the explicit payload the panel now sends after reading its own
 * product context. The panel payload wins when present because the
 * frontend read it from the live Jira page; the host-page URL is the
 * last resort so a context-shape change can never silently blank the
 * panel again.
 */
function issueRefFromContext(req) {
  const ctx = (req && req.context) || {};
  const ext = ctx.extension || {};
  const extCtx = ctx.extensionContext || {};
  const platform = ctx.platformContext || {};
  const payload = (req && req.payload) || {};
  const payloadIssue = payload.issue || {};
  const extIssue = ext.issue || extCtx.issue || ctx.issue || {};
  return {
    key: firstString(
      payload.issueKey, payloadIssue.key,
      extIssue.key, ext.issueKey, extCtx.issueKey, platform.issueKey, ctx.issueKey,
      issueKeyFromLocation(ext.location || ctx.location || payload.location),
    ),
    id: firstString(
      payload.issueId, payloadIssue.id,
      extIssue.id, ext.issueId, extCtx.issueId, platform.issueId, ctx.issueId,
    ),
  };
}

function snapshotIssue(payload, issueKey, issueId) {
  const snap = payload && payload.issueSnapshot;
  if (!snap || typeof snap !== 'object') return null;
  const fields = snap.fields && typeof snap.fields === 'object' ? snap.fields : {};
  const key = firstString(snap.key, issueKey);
  const id = firstString(snap.id, issueId);
  if (!key && !id) return null;
  // Only trust a snapshot that names the same issue the context named.
  if (issueKey && key && key.toUpperCase() !== String(issueKey).toUpperCase()) return null;
  if (issueId && id && String(id) !== String(issueId)) return null;
  return { key: key || issueKey, id, fields };
}

function mergeSnapshotFields(issue, snapshot) {
  if (!snapshot) return issue;
  if (!issue) return snapshot;
  const fields = { ...(issue.fields || {}) };
  for (const [name, value] of Object.entries(snapshot.fields || {})) {
    if (fields[name] === undefined || fields[name] === null || fields[name] === '') {
      fields[name] = value;
    }
  }
  return { ...issue, key: issue.key || snapshot.key, id: issue.id || snapshot.id, fields };
}

async function fetchPanelIssue(issueKey, issueId) {
  if (!issueKey && !issueId) return null;
  try {
    return await getIssue(issueKey || issueId);
  } catch (err) {
    console.warn(`VaultMind panel: issue fetch failed for ${issueKey || issueId}: ${err.message}`);
    if (!issueId || String(issueId) === String(issueKey)) return null;
    try {
      return await getIssue(issueId);
    } catch (retryErr) {
      console.warn(`VaultMind panel: issue fetch by id failed for ${issueKey}: ${retryErr.message}`);
      return null;
    }
  }
}

async function getPanelData(store, issueKey, issueId, payload = {}) {
  const policy = await store.getPolicy();
  const today = dayKey();
  const snapshot = snapshotIssue(payload, issueKey, issueId);
  // Prefer the backend REST fetch. When it fails (the app user cannot
  // always browse the project the panel is rendered on), fall back to
  // the snapshot the panel fetched as the viewing user, who can see
  // the issue by definition. A REST response with empty fields is
  // topped up from the snapshot the same way.
  const issue = mergeSnapshotFields(await fetchPanelIssue(issueKey, issueId), snapshot);
  const canonicalKey = (issue && issue.key) || issueKey;

  let record = canonicalKey ? await store.getEvalRecord(canonicalKey) : null;
  if (issue && canonicalKey && inScope(issue, policy)) {
    const request = extractRequest(issue, policy);
    if (!record && hasPaymentSignals(issue)) {
      // First read for a payment request the trigger missed: persist
      // the verdict, its budget reservation, and one audit entry.
      ({ record } = await evaluateIssue(store, {
        issueKey: canonicalKey, request, actor: 'panel', source: 'panel',
      }));
    } else if (record && inputsDiffer(record, request)) {
      // The issue changed since the stored verdict: persist the fresh
      // verdict once. Repeat views with identical inputs take neither
      // branch, so viewing never spams the audit or double-reserves.
      ({ record } = await evaluateIssue(store, {
        issueKey: canonicalKey, request, actor: 'panel', source: 'panel',
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
    return getPanelData(store, key, id, (req && req.payload) || {});
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

module.exports = { buildResolver, csvEscape, getPanelData, issueRefFromContext, snapshotIssue };
