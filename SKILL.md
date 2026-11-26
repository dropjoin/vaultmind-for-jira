# VaultMind MCP tools — SKILL.md

For third-party agents: the VaultMind Forge app exposes two read-only
tools through the Atlassian MCP server (the `rovo:mcp` module in
`manifest.yml`). Both are GET-verb and side-effect free from the caller's
point of view; verdicts are computed by a deterministic policy engine,
never by a language model.

## Tools

### `evaluate-payment-request`

Evaluate one Jira payment-request issue against the site's configured
VaultMind policy.

- Input: `issueKey` (string, required) — e.g. `PAY-123`.
- Output: `verdict` (`PASS` | `REJECT` | `NOT_EVALUATED`), `amount`,
  `vendor`, `requester`, `ruleFired` (the exact policy rule that caused
  a REJECT, or null), `reasons` (human explanations),
  `dailyBudgetRemaining`, `evaluatedAt`. `NOT_EVALUATED` means the issue
  is outside the policy's designated project (see `note`); it is not a
  PASS. On a bad key or a load failure the tool returns `{ error }`
  instead.
- Use when: a user asks whether a specific request is within policy or
  why it was rejected.
- Do NOT use the output to claim a request is "approved" — PASS means
  within policy; approval remains a human Jira workflow step.

### `get-daily-spend`

Report today's counted spend against the daily cap.

- Input: none.
- Output: `day` (UTC), `spentToday`, `dailyCap`, `remaining`, `frozen`,
  `currency`.
- Use when: a user asks how much of today's budget is left.

## Rules for agents using these tools

1. Always call the tool before stating a verdict, amount, or balance —
   never estimate or recall figures from conversation.
2. On a REJECT, cite `ruleFired` exactly as returned.
3. If a tool returns an error, report that the check could not be
   completed; do not fall back to your own judgement.
4. On `NOT_EVALUATED`, say the issue is outside the VaultMind project
   scope and was not checked; never restate it as a PASS or a REJECT.
