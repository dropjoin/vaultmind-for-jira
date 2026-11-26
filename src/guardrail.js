'use strict';

/**
 * Prompt-injection guardrail — JavaScript port of
 * ~/workspace/vaultmind/src/guardrail.py.
 *
 * A payment memo / justification is attacker-controlled text: anyone can
 * file a request and lace it with instructions for the model. VaultMind
 * treats that text as DATA, never as instructions. This deterministic
 * scan flags classic injection patterns before any model sees the text;
 * high-severity flags force a REJECT in policy.js — no model verdict
 * can override them.
 *
 * The scan is deliberately simple and explainable: a tripwire with named
 * patterns, not a security guarantee.
 */

const HIGH = [
  [/ignore\s+(all\s+)?(previous|prior|above)\s+instructions/, 'ignore-previous-instructions'],
  [/disregard\s+(the\s+)?(policy|rules|instructions|checks)/, 'disregard-policy'],
  [/(override|bypass|skip)\s+(the\s+)?(policy|check|cap|allowlist|approval)/, 'bypass-policy'],
  [/you\s+are\s+now\s+(a|an|in)\b/, 'role-reassignment'],
  [/\bsystem\s*:\s*/, 'fake-system-message'],
  [/approve\s+(this|it)\s+(immediately|without|regardless)/, 'forced-approval'],
  [/send\s+(all|the\s+full|everything)\b/, 'drain-language'],
  [/do\s+not\s+(tell|inform|report|log)\b/, 'concealment'],
];

const MEDIUM = [
  [/urgent(ly)?\b.*\b(no\s+time|immediately|asap)\b/, 'pressure-urgency'],
  [/the\s+owner\s+(said|approved|told\s+me)/, 'false-authority-claim'],
  [/off\s*the\s+record/, 'off-the-record'],
  [/new\s+instructions\s*:/, 'fake-instruction-block'],
];

/**
 * @param {string} text Untrusted free text (may be empty/null).
 * @returns {{ flags: Array<{pattern: string, severity: 'high'|'medium', match: string}>,
 *             highSeverity: boolean, blocked: boolean }}
 */
function scanUntrustedText(text) {
  const flags = [];
  if (!text) return { flags, highSeverity: false, blocked: false };
  const lowered = String(text).toLowerCase();
  for (const [regex, name] of HIGH) {
    const m = lowered.match(regex);
    if (m) flags.push({ pattern: name, severity: 'high', match: m[0] });
  }
  for (const [regex, name] of MEDIUM) {
    const m = lowered.match(regex);
    if (m) flags.push({ pattern: name, severity: 'medium', match: m[0] });
  }
  const highSeverity = flags.some((f) => f.severity === 'high');
  return { flags, highSeverity, blocked: highSeverity };
}

module.exports = { scanUntrustedText };
