'use strict';

/**
 * VaultMind policy engine — deterministic JavaScript port of the Python
 * original (~/workspace/vaultmind/src/policy.py), which itself mirrors the
 * on-chain AgentVault `agentSpend` require() chain:
 *
 *     require(!frozen)                          -> vault not frozen
 *     require(amount > 0)                       -> amount positive
 *     require(to != address(0))                 -> recipient present
 *     require(allowedRecipient[to])             -> recipient allowlisted
 *     require(policy.configured)                -> a policy exists
 *     require(amount <= perTxCap)               -> per-transaction cap
 *     require(spentToday + amount <= dailyCap)  -> daily cap
 *
 * Jira adaptation (dossier §3.4, feature 3):
 *   - "recipient" becomes the issue's Vendor/Payee field, and a second
 *     allowlist dimension (the Requester) is checked the same way.
 *   - The on-chain balance check has no Jira analogue (there is no vault
 *     balance behind a Jira issue) and is intentionally dropped.
 *   - A request that declares a different currency than the policy fails
 *     closed: there is no conversion, so its amount cannot be checked
 *     against the caps.
 *   - A configured policy whose caps are missing or invalid fails closed
 *     instead of silently skipping the cap checks.
 *   - The guardrail memo scan (guardrail.py) is kept: a high-severity
 *     prompt-injection flag in the request's free-text memo forces a
 *     REJECT at this deterministic layer. No model verdict — including
 *     the Rovo agent's — can override anything computed here.
 *
 * Money is handled in integer minor units (cents) end to end so verdicts
 * never depend on floating-point rounding. All functions in this file
 * are pure: same inputs, same verdict, every time.
 */

const { scanUntrustedText } = require('./guardrail');

/** Rule identifiers, in the order the checks run. */
const RULES = Object.freeze({
  POLICY_NOT_CONFIGURED: 'POLICY_NOT_CONFIGURED',
  POLICY_INVALID: 'POLICY_INVALID',
  VAULT_FROZEN: 'VAULT_FROZEN',
  AMOUNT_NOT_POSITIVE: 'AMOUNT_NOT_POSITIVE',
  VENDOR_MISSING: 'VENDOR_MISSING',
  VENDOR_NOT_ALLOWLISTED: 'VENDOR_NOT_ALLOWLISTED',
  REQUESTER_NOT_ALLOWLISTED: 'REQUESTER_NOT_ALLOWLISTED',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  PER_TX_CAP_EXCEEDED: 'PER_TX_CAP_EXCEEDED',
  DAILY_CAP_EXCEEDED: 'DAILY_CAP_EXCEEDED',
  MEMO_INJECTION_BLOCKED: 'MEMO_INJECTION_BLOCKED',
});

/**
 * Convert a major-unit amount (e.g. 123.45) to integer cents.
 *
 * Strict on purpose: only numbers and strings that are exactly one
 * number (optional sign, optional thousands commas, optional decimal
 * part, optional leading or trailing currency code/symbol such as
 * "USD ", "$", or "250 USD") are accepted. Anything else — "abc",
 * "10 dollars and 20 cents", "12abc34", booleans, objects — returns
 * NaN instead of silently inventing an amount from the digits it
 * happens to contain.
 * String amounts convert with exact decimal arithmetic (no binary
 * float error: "2.675" -> 268 cents, half-up); number inputs use
 * Math.round on the double they already are.
 */
function toCents(amount) {
  if (amount === null || amount === undefined) return NaN;
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount)) return NaN;
    const cents = Math.round(amount * 100);
    return Number.isFinite(cents) ? cents : NaN;
  }
  if (typeof amount !== 'string') return NaN;
  let s = amount.trim();
  if (!s) return NaN;
  s = s.replace(/^(USD|EUR|GBP|AUD|CAD|CHF|JPY|IDR|SGD)\s*/i, '');
  s = s.replace(/^[$€£¥₹]/, '').trim();
  s = s.replace(/\s*(USD|EUR|GBP|AUD|CAD|CHF|JPY|IDR|SGD)$/i, '');
  s = s.replace(/[$€£¥₹]$/, '').trim();
  s = s.replace(/,/g, '');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) return NaN;
  const negative = s.startsWith('-');
  const unsigned = s.replace(/^[+-]/, '');
  const [intPart, fracPart = ''] = unsigned.split('.');
  const frac2 = (fracPart + '00').slice(0, 2);
  const rest = fracPart.slice(2);
  let cents = Number(intPart || '0') * 100 + Number(frac2);
  if (rest && Number(`0.${rest}`) >= 0.5) cents += 1; // round half-up
  if (negative) cents = -cents;
  return Number.isFinite(cents) ? cents : NaN;
}

/** Format integer cents as a human amount, e.g. 12345 -> "123.45". */
function formatCents(cents) {
  if (!Number.isFinite(cents)) return 'n/a';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Format cents with a currency code, e.g. (50000, 'USD') -> "USD 500.00". */
function formatMoney(cents, currency) {
  return `${currency || ''} ${formatCents(cents)}`.trim();
}

/** Case-insensitive allowlist membership; non-strings never match. A
 *  malformed (non-array) allowlist matches nothing instead of throwing. */
function isAllowlisted(list, value) {
  if (!value || !Array.isArray(list)) return false;
  const needle = String(value).trim().toLowerCase();
  return list.some((entry) => String(entry).trim().toLowerCase() === needle);
}

/**
 * Evaluate one payment request against the policy.
 *
 * @param {object} args
 * @param {object} args.policy  Stored policy:
 *   { configured, frozen, currency, perTxCapCents, dailyCapCents,
 *     allowedVendors: string[], allowedRequesters: string[] }
 * @param {number} args.spentTodayCents  Amount already counted against
 *   today's daily cap EXCLUDING this request (the caller subtracts any
 *   earlier reservation for the same issue — see evaluate.js).
 * @param {object} args.request  { amountCents, vendor, requester, memo, currency? }
 * @returns {{ verdict: 'PASS'|'REJECT', passed: boolean,
 *             reasons: string[], rulesFired: string[],
 *             primaryRule: string|null, facts: object }}
 *   `reasons[i]` is the human explanation for `rulesFired[i]`.
 */
function evaluatePolicy({ policy, spentTodayCents, request }) {
  const reasons = [];
  const rulesFired = [];
  const fail = (rule, message) => { rulesFired.push(rule); reasons.push(message); };

  const p = policy || {};
  const spent = Number.isFinite(spentTodayCents) && spentTodayCents > 0 ? spentTodayCents : 0;
  const amount = request ? request.amountCents : NaN;

  // --- checks that run even when no policy is configured ---------------
  if (!p.configured) {
    fail(RULES.POLICY_NOT_CONFIGURED,
      'No VaultMind policy is configured for this site yet — the request ' +
      'is treated as not allowed until an admin sets the caps and allowlists.');
  }
  // A configured policy with missing/invalid caps must fail closed:
  // comparing an amount against undefined/NaN would silently skip both
  // cap checks and let any amount PASS.
  const capsValid = !p.configured || (
    Number.isFinite(p.perTxCapCents) && p.perTxCapCents >= 0 &&
    Number.isFinite(p.dailyCapCents) && p.dailyCapCents >= 0
  );
  if (p.configured && !capsValid) {
    fail(RULES.POLICY_INVALID,
      'The configured VaultMind policy has invalid spending caps — the ' +
      'request is treated as not allowed until an admin saves valid caps.');
  }
  if (p.frozen) {
    fail(RULES.VAULT_FROZEN,
      'Spending is FROZEN by the policy admin — all payment requests are halted.');
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    fail(RULES.AMOUNT_NOT_POSITIVE,
      'Amount is missing or not greater than zero.');
  }
  if (!request || !request.vendor || !String(request.vendor).trim()) {
    fail(RULES.VENDOR_MISSING,
      'No vendor/payee is set on the request — a payee is required.');
  } else if (p.configured && !isAllowlisted(p.allowedVendors, request.vendor)) {
    fail(RULES.VENDOR_NOT_ALLOWLISTED,
      `Vendor "${request.vendor}" is NOT on the policy allowlist.`);
  }
  // Requester allowlist is only enforced when the admin maintains one;
  // the vendor allowlist is the mandatory dimension (fail-closed when the
  // policy is configured, matching the on-chain recipient allowlist).
  if (p.configured && Array.isArray(p.allowedRequesters) &&
      p.allowedRequesters.length > 0 &&
      !isAllowlisted(p.allowedRequesters, request && request.requester)) {
    fail(RULES.REQUESTER_NOT_ALLOWLISTED,
      `Requester "${request && request.requester}" is NOT on the policy allowlist.`);
  }

  // Currency: an amount declared in a different currency than the
  // policy cannot be checked against the caps (no conversion exists),
  // so a mismatch fails closed. Requests with no currency at all
  // (direct engine callers) are checked as policy-currency amounts.
  if (p.configured && request && typeof request.currency === 'string' &&
      request.currency.trim() && typeof p.currency === 'string' && p.currency.trim() &&
      request.currency.trim().toLowerCase() !== p.currency.trim().toLowerCase()) {
    fail(RULES.CURRENCY_MISMATCH,
      `Request currency "${request.currency.trim().toUpperCase()}" does not match ` +
      `the policy currency "${p.currency.trim().toUpperCase()}" — the amount cannot ` +
      'be checked against the caps without conversion, so the request is rejected.');
  }

  // --- cap checks (meaningful only once a valid policy exists) ---------
  if (p.configured && capsValid && Number.isFinite(amount) && amount > 0) {
    if (amount > p.perTxCapCents) {
      fail(RULES.PER_TX_CAP_EXCEEDED,
        `Amount ${formatMoney(amount, p.currency)} exceeds the ` +
        `per-transaction cap of ${formatMoney(p.perTxCapCents, p.currency)}.`);
    }
    if (spent + amount > p.dailyCapCents) {
      fail(RULES.DAILY_CAP_EXCEEDED,
        `Daily cap exceeded: ${formatMoney(spent, p.currency)} already ` +
        `counted today + ${formatMoney(amount, p.currency)} requested > ` +
        `daily cap ${formatMoney(p.dailyCapCents, p.currency)}.`);
    }
  }

  // --- guardrail: untrusted memo text can force a REJECT ---------------
  const guardrail = scanUntrustedText(request && request.memo);
  if (guardrail.blocked) {
    fail(RULES.MEMO_INJECTION_BLOCKED,
      'The request memo contains high-severity prompt-injection patterns ' +
      `(${guardrail.flags.filter((f) => f.severity === 'high').map((f) => f.pattern).join(', ')}). ` +
      'The memo is treated as data, never as instructions, and the request is rejected.');
  }

  const passed = rulesFired.length === 0;
  const headroom = p.configured && capsValid
    ? Math.max(p.dailyCapCents - spent, 0)
    : 0;

  return {
    verdict: passed ? 'PASS' : 'REJECT',
    passed,
    reasons: passed ? ['All VaultMind policy checks pass.'] : reasons,
    rulesFired,
    primaryRule: rulesFired[0] || null,
    facts: {
      currency: p.currency || null,
      perTxCapCents: p.configured ? p.perTxCapCents : null,
      dailyCapCents: p.configured ? p.dailyCapCents : null,
      spentTodayCents: spent,
      dailyHeadroomCents: headroom,
      remainingAfterCents: passed ? Math.max(headroom - amount, 0) : headroom,
      amountCents: Number.isFinite(amount) ? amount : null,
      frozen: !!p.frozen,
      policyConfigured: !!p.configured,
      vendorAllowed: request && request.vendor
        ? isAllowlisted(p.allowedVendors, request.vendor) : false,
      guardrailFlags: guardrail.flags,
    },
  };
}

module.exports = { evaluatePolicy, toCents, formatCents, formatMoney, isAllowlisted, RULES };
