'use strict';

/**
 * Storage layer for VaultMind for Jira.
 *
 * On Forge this is backed by the Forge Key-Value Store (@forge/kvs,
 * `storage:app` scope). For local development and unit tests an
 * in-memory implementation with the exact same interface is exported —
 * handlers always receive a store object, they never touch KVS directly.
 *
 * Key layout (all values JSON-serialisable):
 *   policy                     -> the single per-install policy object
 *   spend:<YYYY-MM-DD>         -> integer cents counted against that
 *                                 (UTC) day's cap by PASSing requests
 *   eval:<ISSUE-KEY>           -> latest evaluation record for an issue,
 *                                 including its budget reservation
 *   audit:<YYYY-MM-DD>         -> array of audit entries for the day
 *                                 (admin report)
 *   audit-issue:<ISSUE-KEY>    -> array of audit entries for one issue,
 *                                 newest last, capped (issue panel)
 */

const POLICY_KEY = 'policy';
const MAX_AUDIT_PER_ISSUE = 50;

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10); // UTC day window
}

/** Default (unconfigured) policy: fail-closed until an admin saves one. */
function emptyPolicy() {
  return {
    configured: false,
    frozen: false,
    currency: 'USD',
    perTxCapCents: 0,
    dailyCapCents: 0,
    allowedVendors: [],
    allowedRequesters: [],
    projectKey: '',
  };
}

function wrapBackend(backend) {
  return {
    async getPolicy() {
      return (await backend.get(POLICY_KEY)) || emptyPolicy();
    },
    async setPolicy(policy) {
      await backend.set(POLICY_KEY, policy);
      return policy;
    },
    async getSpent(day) {
      return (await backend.get(`spend:${day}`)) || 0;
    },
    async setSpent(day, cents) {
      await backend.set(`spend:${day}`, cents);
    },
    async getEvalRecord(issueKey) {
      return (await backend.get(`eval:${issueKey}`)) || null;
    },
    async setEvalRecord(issueKey, record) {
      await backend.set(`eval:${issueKey}`, record);
    },
    async appendAudit(entry) {
      const dayList = (await backend.get(`audit:${entry.day}`)) || [];
      dayList.push(entry);
      await backend.set(`audit:${entry.day}`, dayList);

      const issueList = (await backend.get(`audit-issue:${entry.issueKey}`)) || [];
      issueList.push(entry);
      await backend.set(
        `audit-issue:${entry.issueKey}`,
        issueList.slice(-MAX_AUDIT_PER_ISSUE),
      );
    },
    async getAuditForIssue(issueKey) {
      return (await backend.get(`audit-issue:${issueKey}`)) || [];
    },
    async getAuditForDay(day) {
      return (await backend.get(`audit:${day}`)) || [];
    },
  };
}

/** In-memory store for local runs and tests. */
function createMemoryStore() {
  const map = new Map();
  return wrapBackend({
    get: async (key) => (map.has(key) ? structuredClone(map.get(key)) : undefined),
    set: async (key, value) => { map.set(key, structuredClone(value)); },
  });
}

/**
 * Forge KVS-backed store. @forge/kvs is required lazily so this module
 * (and everything importing it) still loads under plain Node for tests.
 */
function createForgeStore() {
  let kvs;
  try {
    kvs = require('@forge/kvs').kvs;
  } catch (err) {
    throw new Error('@forge/kvs is not available — run `npm install` inside the Forge environment.');
  }
  return wrapBackend({
    get: (key) => kvs.get(key),
    set: (key, value) => kvs.set(key, value),
  });
}

module.exports = { createMemoryStore, createForgeStore, dayKey, emptyPolicy };
