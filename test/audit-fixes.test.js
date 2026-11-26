'use strict';

/**
 * Audit-fix tests — every case pins a bug found in the 2026-11-12
 * local audit (see the audit report for file:line evidence). Run:
 * npm test (or: node --test test/)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { evaluatePolicy, toCents, isAllowlisted, RULES } = require('../src/policy');
const { evaluateIssue } = require('../src/evaluate');
const { createMemoryStore, dayKey } = require('../src/store');
const { extractRequest, hasPaymentSignals, adfToText } = require('../src/issueFields');
const { handleDailyRollup } = require('../src/handlers/rollup');
const { verdictComment, shouldPostComment } = require('../src/handlers/trigger');
const { csvEscape } = require('../src/handlers/resolver');

const POLICY = {
  configured: true,
  frozen: false,
  currency: 'USD',
  perTxCapCents: toCents(100),
  dailyCapCents: toCents(250),
  allowedVendors: ['Acme Corp', 'Globex'],
  allowedRequesters: [],
  projectKey: 'PAY',
};

const req = (overrides = {}) => ({
  amountCents: toCents(50),
  vendor: 'Acme Corp',
  requester: 'alice',
  memo: 'Quarterly office supplies',
  ...overrides,
});

const run = (request, spentTodayCents = 0, policy = POLICY) =>
  evaluatePolicy({ policy, spentTodayCents, request });

// ------------------------------------------------------------ toCents

test('toCents accepts plain numbers and clean numeric strings', () => {
  assert.equal(toCents(100), 10000);
  assert.equal(toCents(42.5), 4250);
  assert.equal(toCents('250'), 25000);
  assert.equal(toCents('250.00'), 25000);
  assert.equal(toCents('  75.50 '), 7550);
  assert.equal(toCents('.5'), 50);
  assert.equal(toCents('5.'), 500);
  assert.equal(toCents('-5'), -500);
  assert.equal(toCents(0), 0);
});

test('toCents accepts currency prefixes and thousands commas', () => {
  assert.equal(toCents('$250.00'), 25000);
  assert.equal(toCents('USD 250.00'), 25000);
  assert.equal(toCents('USD250'), 25000);
  assert.equal(toCents('250 USD'), 25000);
  assert.equal(toCents('250$'), 25000);
  assert.equal(toCents('1,000.00'), 100000);
});

test('toCents converts string decimals exactly (no binary float error)', () => {
  assert.equal(toCents('2.675'), 268); // half-up, not 267
  assert.equal(toCents('0.005'), 1);
  assert.equal(toCents('2.674'), 267);
});

test('toCents rejects garbage strings instead of inventing an amount', () => {
  for (const bad of ['abc', 'USD', '$', '', '   ', 'TBD',
    '10 dollars and 20 cents', '12abc34', '10.5.2', '--5', '1-2',
    '1e3', 'NaN', 'Infinity']) {
    assert.ok(Number.isNaN(toCents(bad)), `toCents(${JSON.stringify(bad)}) must be NaN`);
  }
});

test('toCents rejects non-number/non-string types and overflow', () => {
  for (const bad of [true, false, {}, [], NaN, Infinity, -Infinity, 1e308, null, undefined]) {
    assert.ok(Number.isNaN(toCents(bad)), `toCents(${String(bad)}) must be NaN`);
  }
});

// -------------------------------------------------------- allowlist

test('isAllowlisted never throws on a malformed allowlist', () => {
  assert.equal(isAllowlisted('Acme Corp', 'Acme Corp'), false);
  assert.equal(isAllowlisted(null, 'Acme Corp'), false);
  assert.equal(isAllowlisted(undefined, 'Acme Corp'), false);
  assert.equal(isAllowlisted(42, 'Acme Corp'), false);
  assert.equal(isAllowlisted(['Acme Corp'], 'acme corp'), true);
  assert.equal(isAllowlisted(['Acme Corp'], '  Acme Corp '), true);
});

test('evaluatePolicy fails closed (no throw) on a malformed allowlist', () => {
  const v = run(req(), 0, { ...POLICY, allowedVendors: 'Acme Corp' });
  assert.equal(v.verdict, 'REJECT');
  assert.ok(v.rulesFired.includes(RULES.VENDOR_NOT_ALLOWLISTED));
});

// ------------------------------------------------- caps validation

test('configured policy with missing caps fails closed', () => {
  const noCaps = { configured: true, frozen: false, currency: 'USD', allowedVendors: ['Acme Corp'], allowedRequesters: [] };
  const v = evaluatePolicy({ policy: noCaps, spentTodayCents: 0, request: req({ amountCents: 99999999 }) });
  assert.equal(v.verdict, 'REJECT');
  assert.ok(v.rulesFired.includes(RULES.POLICY_INVALID));
  assert.equal(v.facts.dailyHeadroomCents, 0);
});

test('configured policy with NaN or negative caps fails closed', () => {
  for (const caps of [
    { perTxCapCents: NaN, dailyCapCents: toCents(250) },
    { perTxCapCents: toCents(100), dailyCapCents: NaN },
    { perTxCapCents: -1, dailyCapCents: toCents(250) },
    { perTxCapCents: toCents(100), dailyCapCents: -5 },
  ]) {
    const v = run(req(), 0, { ...POLICY, ...caps });
    assert.equal(v.verdict, 'REJECT');
    assert.ok(v.rulesFired.includes(RULES.POLICY_INVALID));
  }
});

test('negative or NaN spent-today is normalised to zero, not trusted', () => {
  const v = run(req({ amountCents: toCents(100) }), -50000);
  assert.equal(v.verdict, 'PASS');
  assert.equal(v.facts.dailyHeadroomCents, toCents(250));
  assert.equal(run(req(), NaN).facts.spentTodayCents, 0);
});

// ------------------------------------------------------------- currency

test('request in a different currency than the policy rejects', () => {
  const v = run(req({ currency: 'EUR' }));
  assert.equal(v.verdict, 'REJECT');
  assert.ok(v.rulesFired.includes(RULES.CURRENCY_MISMATCH));
  assert.equal(run(req({ currency: 'eur' })).verdict, 'REJECT');
});

test('matching currency (any case) or no currency passes the currency check', () => {
  assert.equal(run(req({ currency: 'USD' })).verdict, 'PASS');
  assert.equal(run(req({ currency: 'usd' })).verdict, 'PASS');
  assert.equal(run(req()).verdict, 'PASS'); // direct callers: no currency field
  assert.equal(run(req({ currency: '' })).verdict, 'PASS');
});

test('evaluatePolicy rejects a null request without throwing', () => {
  const v = evaluatePolicy({ policy: POLICY, spentTodayCents: 0, request: null });
  assert.equal(v.verdict, 'REJECT');
  assert.ok(v.rulesFired.includes(RULES.AMOUNT_NOT_POSITIVE));
});

// ------------------------------------------------------- ADF intake

test('adfToText keeps block nodes on separate lines', () => {
  const doc = {
    type: 'doc', version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Amount: 75.00' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Vendor: Globex' }] },
    ],
  };
  const text = adfToText(doc);
  assert.match(text, /Amount: 75\.00\n\s*Vendor: Globex/);
});

test('adfToText still joins inline text within a paragraph', () => {
  const doc = {
    type: 'doc', version: 1,
    content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'world', marks: [{ type: 'strong' }] },
    ] }],
  };
  assert.equal(adfToText(doc).trim(), 'Hello world');
});

test('extractRequest reads Amount/Vendor lines from an ADF description', () => {
  const issue = {
    key: 'PAY-2',
    fields: {
      summary: 'Tickets',
      description: {
        type: 'doc', version: 1,
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Amount: 75.00' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Vendor: Globex' }] },
        ],
      },
      reporter: { displayName: 'Bob' },
      labels: [],
    },
  };
  const r = extractRequest(issue, POLICY);
  assert.equal(r.amountCents, toCents(75));
  assert.equal(r.vendor, 'Globex');
  assert.equal(r.sources.amount, 'description');
  assert.equal(r.sources.vendor, 'description');
});

test('extractRequest reads a Vendor line inside a bullet list', () => {
  const issue = {
    key: 'PAY-3',
    fields: {
      summary: 'Bits',
      description: {
        type: 'doc', version: 1,
        content: [{ type: 'bulletList', content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Amount: 10.00' }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Vendor: Acme Corp' }] }] },
        ] }],
      },
      reporter: { displayName: 'Bob' },
      labels: [],
    },
  };
  const r = extractRequest(issue, POLICY);
  assert.equal(r.amountCents, toCents(10));
  assert.equal(r.vendor, 'Acme Corp');
});

test('extractRequest reads inline amount/vendor from the summary', () => {
  const issue = {
    key: 'KAN-1',
    fields: {
      summary: 'Payment request amount: 150 vendor: Acme Supplies',
      description: '',
      reporter: { displayName: 'Bob' },
      labels: [],
    },
  };
  const r = extractRequest(issue, POLICY);
  assert.equal(r.amountCents, toCents(150));
  assert.equal(r.vendor, 'Acme Supplies');
  assert.equal(r.sources.amount, 'summary');
  assert.equal(r.sources.vendor, 'summary');
  assert.equal(hasPaymentSignals(issue), true);
});

test('extractRequest reads inline amount/vendor from one ADF paragraph', () => {
  const issue = {
    key: 'KAN-2',
    fields: {
      summary: 'Payment request',
      description: {
        type: 'doc', version: 1,
        content: [{ type: 'paragraph', content: [
          { type: 'text', text: 'amount: 150' },
          { type: 'hardBreak' },
          { type: 'text', text: 'vendor: Acme Supplies' },
        ] }],
      },
      reporter: { displayName: 'Bob' },
      labels: [],
    },
  };
  const r = extractRequest(issue, POLICY);
  assert.equal(r.amountCents, toCents(150));
  assert.equal(r.vendor, 'Acme Supplies');
  assert.equal(r.sources.amount, 'description');
  assert.equal(r.sources.vendor, 'description');
});

test('extractRequest sources report the branch actually used', () => {
  const issue = {
    key: 'PAY-4',
    fields: {
      summary: 'Labels only',
      description: 'nothing here',
      reporter: { displayName: 'Bob' },
      labels: ['amount:33.00', 'vendor:acme-corp'],
      customfield_10050: '',
      customfield_10051: '',
    },
  };
  const r = extractRequest(issue, POLICY);
  assert.equal(r.amountCents, toCents(33));
  assert.equal(r.sources.amount, 'label');
  assert.equal(r.sources.vendor, 'label');

  const empty = extractRequest({ key: 'PAY-5', fields: { summary: 'x', reporter: {} } }, POLICY);
  assert.deepEqual(empty.sources, { amount: 'none', vendor: 'none' });
  assert.ok(Number.isNaN(empty.amountCents));
});

test('hasPaymentSignals separates payment requests from ordinary issues', () => {
  const plain = { key: 'PAY-9', fields: { summary: 'Fix the login bug', description: 'Steps to reproduce', labels: [] } };
  assert.equal(hasPaymentSignals(plain), false);
  assert.equal(hasPaymentSignals({ key: 'PAY-9', fields: { summary: 'x', labels: ['amount:10'] } }), true);
  assert.equal(hasPaymentSignals({ key: 'PAY-9', fields: { summary: 'x', description: 'Vendor: Acme Corp' } }), true);
  assert.equal(hasPaymentSignals({ key: 'PAY-9', fields: { summary: 'x', customfield_10050: 0 } }), true);
  assert.equal(hasPaymentSignals({ key: 'PAY-9', fields: { summary: 'x', customfield_10051: 'Acme Corp' } }), true);
  assert.equal(hasPaymentSignals({ key: 'PAY-9', fields: { summary: 'x', description: 'Currency: USD' } }), false);
});

// ------------------------------------------------- dry-run evaluation

test('persist:false computes the verdict without writing anything', async () => {
  const store = createMemoryStore();
  await store.setPolicy(POLICY);
  const today = dayKey();
  const { verdict, record } = await evaluateIssue(store, {
    issueKey: 'PAY-30', request: req({ amountCents: toCents(100) }),
    actor: 'agent', source: 'agent-action', persist: false,
  });
  assert.equal(verdict, 'PASS');
  assert.equal(await store.getSpent(today), 0);
  assert.equal(await store.getEvalRecord('PAY-30'), null);
  assert.deepEqual(await store.getAuditForIssue('PAY-30'), []);
  assert.equal(record.remainingAfterCents, toCents(150));
});

test('dry-run verdict matches the persisted verdict for the same inputs', async () => {
  const mk = async () => { const s = createMemoryStore(); await s.setPolicy(POLICY); return s; };
  const args = { issueKey: 'PAY-31', request: req({ amountCents: toCents(100) }), actor: 't', source: 'trigger' };
  const dry = await evaluateIssue(await mk(), { ...args, persist: false });
  const wet = await evaluateIssue(await mk(), args);
  assert.equal(dry.verdict, wet.verdict);
  assert.deepEqual(dry.evaluation.rulesFired, wet.evaluation.rulesFired);
  assert.equal(dry.record.remainingAfterCents, wet.record.remainingAfterCents);
});

test('dry run never overwrites a stored evaluation or reservation', async () => {
  const store = createMemoryStore();
  await store.setPolicy(POLICY);
  const today = dayKey();
  await evaluateIssue(store, {
    issueKey: 'PAY-32', request: req({ amountCents: toCents(50) }),
    actor: 'test', source: 'trigger',
  });
  await evaluateIssue(store, {
    issueKey: 'PAY-32', request: req({ amountCents: toCents(60) }),
    actor: 'panel', source: 'panel', persist: false,
  });
  const stored = await store.getEvalRecord('PAY-32');
  assert.equal(stored.amountCents, toCents(50));
  assert.equal(await store.getSpent(today), toCents(50));
  assert.equal((await store.getAuditForIssue('PAY-32')).length, 1);
});

test('record carries remaining-after (not just headroom-before)', async () => {
  const store = createMemoryStore();
  await store.setPolicy(POLICY);
  const pass = await evaluateIssue(store, {
    issueKey: 'PAY-33', request: req({ amountCents: toCents(100) }),
    actor: 'test', source: 'trigger',
  });
  assert.equal(pass.record.dailyHeadroomCents, toCents(250)); // before
  assert.equal(pass.record.remainingAfterCents, toCents(150)); // after
  assert.equal(pass.record.spentTodayCents, toCents(100));

  const reject = await evaluateIssue(store, {
    issueKey: 'PAY-34', request: req({ amountCents: toCents(500) }),
    actor: 'test', source: 'trigger',
  });
  assert.equal(reject.verdict, 'REJECT');
  // A rejection reserves nothing: remaining-after equals headroom.
  assert.equal(reject.record.remainingAfterCents, reject.record.dailyHeadroomCents);
});

// ------------------------------------------------------- comment text

function flattenAdf(node, out = []) {
  if (!node) return out;
  if (typeof node === 'string') return out;
  if (Array.isArray(node)) { node.forEach((n) => flattenAdf(n, out)); return out; }
  if (node.type === 'text') out.push(node.text || '');
  flattenAdf(node.content, out);
  return out;
}

test('verdictComment reports the budget remaining AFTER this check', () => {
  const adf = verdictComment({
    verdict: 'PASS', amountCents: toCents(100), currency: 'USD', vendor: 'Acme Corp',
    reasons: ['All VaultMind policy checks pass.'], primaryRule: null,
    dailyHeadroomCents: toCents(250), remainingAfterCents: toCents(150),
  });
  const text = flattenAdf(adf).join('\n');
  assert.match(text, /Daily budget remaining after this check: USD 150\.00/);
  assert.doesNotMatch(text, /USD 250\.00/);
});

// -------------------------------------------------- comment dedupe

test('shouldPostComment posts only when the shown verdict changed', () => {
  const base = {
    day: '2026-11-08', verdict: 'PASS', amountCents: 5000, vendor: 'Acme Corp',
    requester: 'alice', primaryRule: null, reasons: ['All VaultMind policy checks pass.'],
    remainingAfterCents: 20000,
  };
  assert.equal(shouldPostComment(null, base), true);
  assert.equal(shouldPostComment({ ...base }, { ...base }), false);
  assert.equal(shouldPostComment({ ...base }, { ...base, amountCents: 6000 }), true);
  assert.equal(shouldPostComment({ ...base }, { ...base, verdict: 'REJECT', primaryRule: 'VAULT_FROZEN' }), true);
  assert.equal(shouldPostComment({ ...base }, { ...base, day: '2026-11-09' }), true);
  assert.equal(shouldPostComment({ ...base }, { ...base, remainingAfterCents: 19000 }), true);
  // Records written before the fix have no remainingAfterCents: post.
  const legacy = { ...base }; delete legacy.remainingAfterCents;
  assert.equal(shouldPostComment(legacy, base), true);
});

// ------------------------------------------------------------- rollup

test('daily rollup is idempotent and counts evaluations only', async () => {
  const store = createMemoryStore();
  await store.setPolicy(POLICY);
  const now = new Date('2026-11-09T06:00:00.000Z'); // rollup day 2026-11-08
  await store.appendAudit({ kind: 'evaluation', day: '2026-11-08', issueKey: 'PAY-1', evaluatedAt: now.toISOString(), verdict: 'PASS' });
  await store.appendAudit({ kind: 'evaluation', day: '2026-11-08', issueKey: 'PAY-2', evaluatedAt: now.toISOString(), verdict: 'REJECT' });

  const first = await handleDailyRollup(store, now);
  assert.deepEqual(first, { day: '2026-11-08', spentCents: 0, evaluations: 2 });
  const second = await handleDailyRollup(store, now);
  assert.equal(second.evaluations, 2);
  assert.equal(second.skipped, true);

  const entries = await store.getAuditForDay('2026-11-08');
  assert.equal(entries.filter((e) => e.kind === 'daily-rollup').length, 1);
  assert.equal(entries.find((e) => e.kind === 'daily-rollup').evaluations, 2);
});

// ----------------------------------------------------------- CSV

test('csvEscape neutralises formula-injection cells', () => {
  assert.equal(csvEscape('=2+5'), "'=2+5");
  assert.equal(csvEscape('+2+5'), "'+2+5");
  assert.equal(csvEscape('-2+5'), "'-2+5");
  assert.equal(csvEscape('@SUM(A1:A2)'), "'@SUM(A1:A2)");
  assert.equal(csvEscape('\t=2+5'), "'\t=2+5");
  assert.equal(csvEscape('\r=2+5'), "'\r=2+5");
  assert.equal(csvEscape('Acme Corp'), 'Acme Corp');
  assert.equal(csvEscape('a"b'), '"a""b"');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape(null), '');
  assert.equal(csvEscape(undefined), '');
  assert.equal(csvEscape(42), '42');
});
