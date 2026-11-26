'use strict';

/**
 * Handler tests — trigger, workflow validator, and Rovo actions, with
 * the Jira REST layer stubbed (require-cache injection) so the tests
 * run under plain Node. The stub is installed BEFORE the handlers are
 * required; nothing here touches a live Jira site.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// --- stub the Jira module before any handler requires it ---------------
const jiraPath = require.resolve('../src/jira');
const realJira = require('../src/jira'); // safe: @forge/api is lazy
const stub = { issue: null, getIssueError: null, comments: [], getIssueCalls: [] };
require.cache[jiraPath] = {
  id: jiraPath,
  filename: jiraPath,
  loaded: true,
  exports: {
    getIssue: async (key) => {
      stub.getIssueCalls.push(key);
      if (stub.getIssueError) throw stub.getIssueError;
      return stub.issue;
    },
    addComment: async (key, body) => { stub.comments.push({ key, body }); return {}; },
    textToAdf: realJira.textToAdf,
  },
};

const { handleIssueTrigger } = require('../src/handlers/trigger');
const { handleValidator } = require('../src/handlers/validator');
const { getPanelData } = require('../src/handlers/resolver');
const actions = require('../src/handlers/actions');
const { evaluateIssue } = require('../src/evaluate');
const { createMemoryStore, dayKey } = require('../src/store');
const { toCents } = require('../src/policy');

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

const paymentIssue = (overrides = {}) => ({
  key: 'PAY-1',
  fields: {
    summary: 'Office supplies',
    description: 'Quarterly restock',
    reporter: { displayName: 'Alice' },
    labels: [],
    customfield_10050: 50,
    customfield_10051: 'Acme Corp',
    ...overrides,
  },
});

beforeEach(() => {
  stub.issue = null;
  stub.getIssueError = null;
  stub.comments = [];
  stub.getIssueCalls = [];
});

async function freshStore(policy = POLICY) {
  const store = createMemoryStore();
  await store.setPolicy(policy);
  return store;
}

// ------------------------------------------------------------ trigger

test('trigger posts a verdict comment for a payment request', async () => {
  const store = await freshStore();
  stub.issue = paymentIssue();
  await handleIssueTrigger({ issue: { key: 'PAY-1' }, associatedUsers: ['alice'] }, store);
  assert.equal(stub.comments.length, 1);
  assert.equal(stub.comments[0].key, 'PAY-1');
  assert.equal((await store.getEvalRecord('PAY-1')).verdict, 'PASS');
});

test('trigger skips issues with no payment-request signal', async () => {
  const store = await freshStore();
  stub.issue = { key: 'PAY-7', fields: { summary: 'Fix the login bug', description: 'Steps to reproduce', labels: [], reporter: { displayName: 'Bob' } } };
  await handleIssueTrigger({ issue: { key: 'PAY-7' } }, store);
  assert.equal(stub.comments.length, 0);
  assert.equal(await store.getEvalRecord('PAY-7'), null);
  assert.deepEqual(await store.getAuditForIssue('PAY-7'), []);
});

test('trigger still re-evaluates a known issue whose fields were cleared', async () => {
  const store = await freshStore();
  stub.issue = paymentIssue();
  await handleIssueTrigger({ issue: { key: 'PAY-1' } }, store);
  assert.equal(stub.comments.length, 1);
  stub.issue = { key: 'PAY-1', fields: { summary: 'Office supplies', description: '', labels: [], reporter: { displayName: 'Alice' } } };
  await handleIssueTrigger({ issue: { key: 'PAY-1' } }, store);
  assert.equal(stub.comments.length, 2); // flipped to REJECT: comment posted
  assert.equal((await store.getEvalRecord('PAY-1')).verdict, 'REJECT');
});

test('trigger does not re-post an identical verdict comment', async () => {
  const store = await freshStore();
  stub.issue = paymentIssue();
  const event = { issue: { key: 'PAY-1' } };
  await handleIssueTrigger(event, store);
  await handleIssueTrigger(event, store); // duplicate delivery / unrelated edit
  assert.equal(stub.comments.length, 1);
  // Re-evaluations are still audited; only the comment is deduped.
  assert.equal((await store.getAuditForIssue('PAY-1')).length, 2);
});

test('trigger posts again when the verdict inputs change', async () => {
  const store = await freshStore();
  stub.issue = paymentIssue();
  await handleIssueTrigger({ issue: { key: 'PAY-1' } }, store);
  stub.issue = paymentIssue({ customfield_10050: 60 });
  await handleIssueTrigger({ issue: { key: 'PAY-1' } }, store);
  assert.equal(stub.comments.length, 2);
});

test('trigger ignores out-of-scope projects', async () => {
  const store = await freshStore();
  stub.issue = paymentIssue();
  stub.issue.key = 'OPS-1';
  await handleIssueTrigger({ issue: { key: 'OPS-1' } }, store);
  assert.equal(stub.comments.length, 0);
});

test('trigger survives an evaluation failure without crashing', async () => {
  const store = await freshStore();
  stub.issue = paymentIssue();
  await handleIssueTrigger({ issue: { key: 'PAY-1' } }, store);
  assert.equal(stub.comments.length, 1);

  // A fresh issue forces a spend write, which fails: the trigger must
  // log and return, posting no verdict it never computed.
  const failing = { ...store, setSpent: async () => { throw new Error('KVS down'); } };
  stub.issue = paymentIssue();
  stub.issue.key = 'PAY-2';
  await assert.doesNotReject(handleIssueTrigger({ issue: { key: 'PAY-2' } }, failing));
  assert.equal(stub.comments.length, 1);
  assert.equal(await store.getEvalRecord('PAY-2'), null);
});

test('trigger falls back to summary signals and customFields when REST fails', async () => {
  const store = await freshStore({ ...POLICY, allowedVendors: ['Acme Supplies'], projectKey: 'KAN' });
  stub.getIssueError = new Error('Jira issue fetch failed for KAN-1: HTTP 403');
  await handleIssueTrigger({
    issue: {
      key: 'KAN-1',
      fields: {
        summary: 'Payment request amount: 150 vendor: Acme Supplies',
        reporter: { displayName: 'Alice' },
        labels: [],
      },
    },
    customFields: {},
    associatedUsers: { users: [{ accountId: 'alice-id' }] },
  }, store);
  const record = await store.getEvalRecord('KAN-1');
  assert.equal(record.verdict, 'REJECT');
  assert.equal(record.primaryRule, 'PER_TX_CAP_EXCEEDED');
  assert.equal(record.amountCents, toCents(150));
  assert.equal(record.vendor, 'Acme Supplies');
  assert.equal(record.actor, 'alice-id');
  assert.equal(stub.comments.length, 1);
});

// ------------------------------------------------------------- panel

test('panel evaluates and persists the first evaluation when none is stored', async () => {
  const store = await freshStore({ ...POLICY, allowedVendors: ['Acme Supplies'], projectKey: 'KAN' });
  stub.issue = {
    key: 'KAN-1',
    fields: {
      summary: 'Payment request amount: 150 vendor: Acme Supplies',
      description: '',
      reporter: { displayName: 'Alice' },
      labels: [],
    },
  };
  const data = await getPanelData(store, 'KAN-1');
  assert.equal(data.verdict.verdict, 'REJECT');
  assert.equal(data.verdict.primaryRule, 'PER_TX_CAP_EXCEEDED');
  assert.equal(data.verdict.source, 'panel');
  assert.equal((await store.getEvalRecord('KAN-1')).verdict, 'REJECT');
  assert.equal(data.auditTrail.length, 1);

  const again = await getPanelData(store, 'KAN-1');
  assert.equal(again.verdict.verdict, 'REJECT');
  assert.equal(again.auditTrail.length, 1); // repeat views do not spam audit
});

// ---------------------------------------------------------- validator

test('validator allows a within-policy approval', async () => {
  const store = await freshStore();
  stub.issue = paymentIssue();
  const res = await handleValidator({ issue: { key: 'PAY-1' } }, store);
  assert.deepEqual(res, { result: true });
});

test('validator blocks an over-cap approval and names the rule', async () => {
  const store = await freshStore();
  stub.issue = paymentIssue({ customfield_10050: 500 });
  const res = await handleValidator({ issue: { key: 'PAY-1' } }, store);
  assert.equal(res.result, false);
  assert.match(res.errorMessage, /PER_TX_CAP_EXCEEDED/);
});

test('validator blocks when the policy is frozen, using current fields', async () => {
  const store = await freshStore({ ...POLICY, frozen: true });
  stub.issue = paymentIssue();
  const res = await handleValidator({ issue: { key: 'PAY-1' } }, store);
  assert.equal(res.result, false);
  assert.match(res.errorMessage, /VAULT_FROZEN/);
});

test('validator allows out-of-scope projects and blocks on evaluation failure', async () => {
  const store = await freshStore();
  stub.issue = paymentIssue();
  stub.issue.key = 'OPS-1';
  assert.deepEqual(await handleValidator({ issue: { key: 'OPS-1' } }, store), { result: true });

  // Fail-closed: a storage failure must block, never allow on unknown.
  const failing = { ...store, getPolicy: async () => { throw new Error('KVS down'); } };
  stub.issue = paymentIssue();
  const blocked = await handleValidator({ issue: { key: 'PAY-1' } }, failing);
  assert.equal(blocked.result, false);
  assert.match(blocked.errorMessage, /could not be completed/);

  const failingWrite = { ...store, setSpent: async () => { throw new Error('KVS down'); } };
  const blocked2 = await handleValidator({ issue: { key: 'PAY-1' } }, failingWrite);
  assert.equal(blocked2.result, false);
});

// ------------------------------------------------------------ actions

test('evaluateAction rejects malformed issue keys without calling Jira', async () => {
  const store = await freshStore();
  for (const bad of ['', 'PAY', 'PAY-', 'PAY-abc', 'PAY--1', 'PAY-1; DROP', 123, null, undefined]) {
    const res = await actions.evaluateAction(store, { issueKey: bad });
    assert.ok(res.error, `key ${JSON.stringify(bad)} must return an error`);
  }
  assert.deepEqual(stub.getIssueCalls, []);
});

test('evaluateAction trims the key and returns load errors instead of throwing', async () => {
  const store = await freshStore();
  stub.issue = paymentIssue();
  const ok = await actions.evaluateAction(store, { issueKey: '  PAY-1 ' });
  assert.equal(ok.verdict, 'PASS');
  assert.deepEqual(stub.getIssueCalls, ['PAY-1']);

  stub.getIssueError = new Error('Jira issue fetch failed for PAY-1: HTTP 404');
  const err = await actions.evaluateAction(store, { issueKey: 'PAY-1' });
  assert.match(err.error, /Could not load issue PAY-1/);
});

test('evaluateAction uses the canonical key and writes nothing', async () => {
  const store = await freshStore();
  stub.issue = paymentIssue(); // canonical key PAY-1
  const res = await actions.evaluateAction(store, { issueKey: 'pay-1' });
  assert.equal(res.issueKey, 'PAY-1');
  assert.equal(res.verdict, 'PASS');
  assert.equal(res.dailyBudgetRemaining, 'USD 200.00'); // 250 cap minus this 50
  assert.equal(await store.getSpent(dayKey()), 0);
  assert.equal(await store.getEvalRecord('PAY-1'), null);
  assert.equal(await store.getEvalRecord('pay-1'), null);
  assert.deepEqual(await store.getAuditForIssue('PAY-1'), []);
});

test('evaluateAction reports out-of-scope issues as NOT_EVALUATED', async () => {
  const store = await freshStore();
  stub.issue = paymentIssue();
  stub.issue.key = 'OPS-1';
  const res = await actions.evaluateAction(store, { issueKey: 'OPS-1' });
  assert.equal(res.verdict, 'NOT_EVALUATED');
  assert.match(res.note, /outside the VaultMind project scope/);
});

test('asking the agent never consumes another issue\'s budget', async () => {
  const store = await freshStore();
  const today = dayKey();
  await evaluateIssue(store, {
    issueKey: 'PAY-1', request: { amountCents: toCents(100), vendor: 'Acme Corp', requester: 'alice', memo: '' },
    actor: 'test', source: 'trigger',
  });
  stub.issue = paymentIssue({ customfield_10050: 100 });
  stub.issue.key = 'PAY-2';
  assert.equal((await actions.evaluateAction(store, { issueKey: 'PAY-2' })).verdict, 'PASS');
  assert.equal(await store.getSpent(today), toCents(100)); // question reserved nothing
  // A third $100 request still fits: 100 + 100 <= 250.
  stub.issue.key = 'PAY-3';
  assert.equal((await actions.evaluateAction(store, { issueKey: 'PAY-3' })).verdict, 'PASS');
});

test('dailySpendAction and policyAction report stored state read-only', async () => {
  const store = await freshStore();
  await store.setSpent(dayKey(), toCents(60));
  const spend = await actions.dailySpendAction(store);
  assert.equal(spend.spentToday, 'USD 60.00');
  assert.equal(spend.remaining, 'USD 190.00');
  assert.equal(spend.frozen, false);
  const policy = await actions.policyAction(store);
  assert.equal(policy.perTransactionCap, 'USD 100.00');
  assert.deepEqual(policy.allowedVendors, ['Acme Corp', 'Globex']);
});
