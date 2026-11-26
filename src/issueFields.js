'use strict';

/**
 * Request intake: extract { amount, vendor, requester, memo } from a Jira
 * issue (dossier §3.4, feature 2).
 *
 * Primary source: custom fields on the "Payment request" issue type.
 * The field ids below are the defaults for the demo site — a Jira admin
 * maps their real field ids here after installing (they differ per site).
 *
 *   FIELD_IDS.amount    number field, amount in major units (e.g. 250.00)
 *   FIELD_IDS.vendor    text or select field, vendor / payee name
 *   FIELD_IDS.requester user picker (falls back to the issue reporter)
 *   FIELD_IDS.currency  text or select field (falls back to policy currency)
 *
 * Documented fallbacks, used when a custom field is empty, so the app
 * still works on a plain project with no custom fields at all:
 *   - Labels: `amount:250.00`, `vendor:acme-corp`
 *   - Description lines: `Amount: 250.00`, `Vendor: Acme Corp`,
 *     `Currency: USD` (plain text or ADF paragraphs)
 *   - Inline labelled text in the summary or a single description
 *     paragraph: `amount: 150 vendor: Acme Supplies`
 * The issue summary + description are also passed through as the memo
 * that the guardrail scan inspects.
 */

const { toCents } = require('./policy');

const FIELD_IDS = Object.freeze({
  amount: 'customfield_10050',
  vendor: 'customfield_10051',
  requester: 'customfield_10052',
  currency: 'customfield_10053',
});

/** Jira select fields arrive as { value } / { name }; user fields as objects. */
function fieldText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return value.value || value.name || value.displayName || value.accountId || '';
}

/** ADF block node types: each one is its own line of text. */
const BLOCK_NODE_TYPES = new Set([
  'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem',
  'blockquote', 'codeBlock', 'table', 'tableRow', 'tableCell',
  'tableHeader', 'panel', 'expand', 'taskList', 'taskItem',
]);

/**
 * Flatten an ADF document (or plain string) to plain text. Block nodes
 * are separated by newlines so the line-based description fallbacks
 * (`Amount:` / `Vendor:` / `Currency:`) keep working on real Jira
 * descriptions, which arrive as ADF — joining every paragraph with a
 * space collapsed them onto one line and the Vendor/Currency lines
 * could never match.
 */
function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfToText).join(' ');
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  const inner = adfToText(node.content || []);
  return BLOCK_NODE_TYPES.has(node.type) ? `${inner}\n` : inner;
}

function findLine(text, label) {
  const m = String(text || '').match(new RegExp(`^\\s*${label}\\s*[:=]\\s*(.+)$`, 'im'));
  return m ? m[1].trim() : '';
}

const VALUE_LABELS = ['amount', 'vendor', 'currency'];

/**
 * Find a labelled value in free text. The line form (`Amount: 150` on
 * its own line) is tried first; the inline form used in summaries and
 * single-paragraph descriptions (`amount: 150 vendor: Acme Supplies`)
 * is the fallback. Inline captures stop at the next known label so a
 * vendor value never swallows a following amount/currency label.
 */
function findValue(text, label) {
  const line = findLine(text, label);
  if (line) return line;
  const stop = VALUE_LABELS.filter((l) => l !== label.toLowerCase())
    .map((l) => `${l}\\s*[:=]`).join('|');
  const re = new RegExp(
    `(?:^|[\\s;|])${label}\\s*[:=]\\s*(.+?)(?=(?:\\s+(?:${stop}))|[\\n;|]|$)`,
    'i',
  );
  const m = String(text || '').match(re);
  if (m) return m[1].trim();
  // Loose form: ADF text often splits a label and its value across
  // text nodes or table cells ("Amount" in one cell, "150" in the
  // next), so no colon survives flattening. Accept `amount 150` /
  // `vendor Acme Supplies` as a last resort; the amount form still
  // requires a number immediately after the label.
  const source = String(text || '');
  if (label.toLowerCase() === 'amount') {
    const loose = source.match(/\bamount\s*[:=]?\s*([+-]?(?:\d[\d,]*(?:\.\d*)?|\.\d+))/i);
    return loose ? loose[1].trim() : '';
  }
  const loose = source.match(new RegExp(`\\b${label}\\s*[:=]?\\s+([^\\n;|]+)`, 'i'));
  if (!loose) return '';
  return loose[1].split(/\s+(?:amount|vendor|currency)\s*[:=]/i)[0].trim();
}

/** Pull the numeric token out of a labelled amount value. */
function amountToken(value) {
  const m = String(value || '').match(/[+-]?(?:\d[\d,]*(?:\.\d*)?|\.\d+)/);
  return m ? m[0] : value;
}

function labelValue(labels, prefix) {
  const hit = (labels || []).find((l) => String(l).toLowerCase().startsWith(prefix));
  return hit ? String(hit).slice(prefix.length).trim() : '';
}

/**
 * @param {object} issue  Jira issue JSON ({ key, fields: {...} }).
 * @param {object} policy Stored policy (currency fallback).
 * @returns {{ amountCents: number, vendor: string, requester: string,
 *             currency: string, memo: string, sources: object }}
 */
function extractRequest(issue, policy) {
  const fields = (issue && issue.fields) || {};
  const descriptionText = adfToText(fields.description);
  const summaryText = String(fields.summary || '');
  const labels = fields.labels || [];

  const amountField = fields[FIELD_IDS.amount];
  const amountLabel = labelValue(labels, 'amount:');
  const amountDesc = findValue(descriptionText, 'Amount');
  const amountSummary = findValue(summaryText, 'Amount');
  let amountRaw;
  let amountSource;
  if (amountField !== null && amountField !== undefined && amountField !== '') {
    amountRaw = amountField; amountSource = 'custom-field';
  } else if (amountLabel) {
    amountRaw = amountLabel; amountSource = 'label';
  } else if (amountDesc) {
    amountRaw = amountToken(amountDesc); amountSource = 'description';
  } else if (amountSummary) {
    amountRaw = amountToken(amountSummary); amountSource = 'summary';
  } else {
    amountRaw = undefined; amountSource = 'none';
  }

  const vendorField = fieldText(fields[FIELD_IDS.vendor]);
  const vendorLabel = labelValue(labels, 'vendor:');
  const vendorDesc = findValue(descriptionText, 'Vendor');
  const vendorSummary = findValue(summaryText, 'Vendor');
  let vendor;
  let vendorSource;
  if (vendorField) {
    vendor = vendorField; vendorSource = 'custom-field';
  } else if (vendorLabel) {
    vendor = vendorLabel; vendorSource = 'label';
  } else if (vendorDesc) {
    vendor = vendorDesc; vendorSource = 'description';
  } else if (vendorSummary) {
    vendor = vendorSummary; vendorSource = 'summary';
  } else {
    vendor = ''; vendorSource = 'none';
  }

  let requester = fieldText(fields[FIELD_IDS.requester]);
  if (!requester) requester = fieldText(fields.reporter) || 'unknown';

  let currency = fieldText(fields[FIELD_IDS.currency]);
  if (!currency) currency = findValue(descriptionText, 'Currency');
  if (!currency) currency = findValue(summaryText, 'Currency');
  if (!currency) currency = (policy && policy.currency) || 'USD';

  return {
    amountCents: toCents(amountRaw),
    vendor,
    requester,
    currency: String(currency).toUpperCase(),
    // The memo is untrusted free text: summary + description. It is only
    // ever scanned as data (guardrail), never followed as instructions.
    memo: [fields.summary || '', descriptionText].join('\n'),
    sources: { amount: amountSource, vendor: vendorSource },
  };
}

/**
 * True when the issue carries any payment-request signal at all: an
 * amount or a vendor in a custom field, a label, or a description
 * line. The trigger uses this to leave ordinary issues (bugs, tasks)
 * in the designated project alone instead of posting a REJECT comment
 * on every one of them; the workflow validator does NOT use it — an
 * approval attempt is always evaluated, signals or not.
 */
function hasPaymentSignals(issue) {
  const fields = (issue && issue.fields) || {};
  const labels = fields.labels || [];
  const descriptionText = adfToText(fields.description);
  const summaryText = String(fields.summary || '');
  const amountField = fields[FIELD_IDS.amount];
  return (amountField !== null && amountField !== undefined && amountField !== '')
    || !!fieldText(fields[FIELD_IDS.vendor])
    || !!labelValue(labels, 'amount:')
    || !!labelValue(labels, 'vendor:')
    || !!findValue(descriptionText, 'Amount')
    || !!findValue(descriptionText, 'Vendor')
    || !!findValue(summaryText, 'Amount')
    || !!findValue(summaryText, 'Vendor');
}

/** True when the issue belongs to the policy's designated project (if set). */
function inScope(issue, policy) {
  if (!policy || !policy.projectKey) return true;
  const fields = (issue && issue.fields) || {};
  const projectKey = (fields.project && fields.project.key)
    || String((issue && issue.key) || '').split('-')[0];
  return String(projectKey || '').toUpperCase()
    === String(policy.projectKey).toUpperCase().trim();
}

module.exports = { extractRequest, inScope, hasPaymentSignals, FIELD_IDS, adfToText };
