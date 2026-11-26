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
  const inner = adfToText(node.content || []);
  return BLOCK_NODE_TYPES.has(node.type) ? `${inner}\n` : inner;
}

function findLine(text, label) {
  const m = String(text || '').match(new RegExp(`^\\s*${label}\\s*[:=]\\s*(.+)$`, 'im'));
  return m ? m[1].trim() : '';
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
  const labels = fields.labels || [];

  const amountField = fields[FIELD_IDS.amount];
  const amountLabel = labelValue(labels, 'amount:');
  const amountLine = findLine(descriptionText, 'Amount');
  let amountRaw;
  let amountSource;
  if (amountField !== null && amountField !== undefined && amountField !== '') {
    amountRaw = amountField; amountSource = 'custom-field';
  } else if (amountLabel) {
    amountRaw = amountLabel; amountSource = 'label';
  } else if (amountLine) {
    amountRaw = amountLine; amountSource = 'description';
  } else {
    amountRaw = undefined; amountSource = 'none';
  }

  const vendorField = fieldText(fields[FIELD_IDS.vendor]);
  const vendorLabel = labelValue(labels, 'vendor:');
  const vendorLine = findLine(descriptionText, 'Vendor');
  let vendor;
  let vendorSource;
  if (vendorField) {
    vendor = vendorField; vendorSource = 'custom-field';
  } else if (vendorLabel) {
    vendor = vendorLabel; vendorSource = 'label';
  } else if (vendorLine) {
    vendor = vendorLine; vendorSource = 'description';
  } else {
    vendor = ''; vendorSource = 'none';
  }

  let requester = fieldText(fields[FIELD_IDS.requester]);
  if (!requester) requester = fieldText(fields.reporter) || 'unknown';

  let currency = fieldText(fields[FIELD_IDS.currency]);
  if (!currency) currency = findLine(descriptionText, 'Currency');
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
  const amountField = fields[FIELD_IDS.amount];
  return (amountField !== null && amountField !== undefined && amountField !== '')
    || !!fieldText(fields[FIELD_IDS.vendor])
    || !!labelValue(labels, 'amount:')
    || !!labelValue(labels, 'vendor:')
    || !!findLine(descriptionText, 'Amount')
    || !!findLine(descriptionText, 'Vendor');
}

/** True when the issue belongs to the policy's designated project (if set). */
function inScope(issue, policy) {
  if (!policy || !policy.projectKey) return true;
  const key = (issue && issue.key) || '';
  return key.split('-')[0] === policy.projectKey;
}

module.exports = { extractRequest, inScope, hasPaymentSignals, FIELD_IDS, adfToText };
