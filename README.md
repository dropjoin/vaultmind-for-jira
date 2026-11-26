# VaultMind for Jira

A Forge app + Rovo agent that applies **deterministic spending-policy
checks** to Jira payment/purchase requests — per-transaction cap, daily
cap, vendor/requester allowlist, and a frozen switch — and **blocks the
Approve workflow transition** while a request is over policy.

The rules are a JavaScript port of the VaultMind policy engine that
already runs against live on-chain vaults (Sepolia + BOT Chain). The
design principle, in one line: **the agent explains, the code decides.**
The Rovo agent can only quote verdicts produced by the deterministic
engine; it cannot create, override, or soften one.

Built for **Codegeist 2026** (category: Apps for Business Teams; bonus
targets: Best Agents, Atlassian MCP, Marketplace, Teamwork Graph
stretch). Solo entry by M Aziz Yahya (`dropjoin`).

- **Source:** https://github.com/dropjoin/vaultmind-for-jira
- **Status (26 Nov 2026):** Forge app deployed and installed in the
  development environment on `vaultmind-dev.atlassian.net`.
  App ID `9b3559bf-3f3a-4378-a5ad-5604633fa295` (also in
  `manifest.yml`). Local test suite: 66/66 passing (`npm test`).
- **Still to verify live before submission:** Rovo chat on the site
  plan, custom-field mapping or fallback intake on demo data, the
  workflow validator attached to an Approve transition, judges'
  installation link, screenshots, and demo video. See
  "Deployment status" below.

## How it works

1. A finance admin sets the policy once on the **VaultMind Policy** admin
   page: per-transaction cap, daily cap, currency, allowed vendors,
   allowed requesters, frozen toggle, designated project.
2. A payment request is a Jira issue carrying an amount, a vendor, and a
   requester (custom fields, with label/description fallbacks).
3. On issue create/update, a trigger evaluates the request with the
   policy engine and posts the verdict as a comment: **PASS** or
   **REJECT**, the exact rule that fired, and the remaining daily budget
   after this request. A new comment is posted only when the verdict
   changed since the last check, and issues with no amount/vendor at
   all are left alone.
4. The issue panel shows the verdict, the caps, a daily-spend gauge, and
   the issue's audit trail.
5. The **Approve transition is blocked** by a workflow validator while
   the verdict is REJECT — and while the policy check itself cannot be
   completed, so an unknown verdict never lets an approval through.
6. The **VaultMind Rovo agent** answers questions ("Is PAY-123 within
   policy?", "How much of today's budget is left?", "Why was PAY-124
   rejected?") by calling the same engine through GET-verb actions.
7. Every evaluation is written to an **audit log** (admin report + CSV
   export): timestamp, actor, inputs, verdict, rule fired.

Daily budget uses a reservation model: a PASS reserves its amount
against today's (UTC) cap; re-evaluating an edited issue releases its
old reservation first, so edits never double-count and a rejected edit
frees its budget. Only the trigger and the workflow validator persist
evaluations: agent questions and panel views are dry runs that compute
the same verdict without reserving budget or writing audit entries, so
merely asking about or viewing a request can never consume budget. A
request memo is treated as untrusted data: a deterministic guardrail
scan rejects requests whose memo contains high-severity
prompt-injection patterns. A request that declares a different
currency than the policy is rejected (no conversion exists), and a
configured policy with missing or invalid caps fails closed.

## Architecture

```
manifest.yml                  Forge manifest: all modules, scopes, runtime
resources/agent-prompt/       Rovo agent prompt (public by design)
  prompt.md                   Strict "guide" prompt: always call the
                              evaluate action, cite the rule, never invent
src/
  policy.js                   Deterministic policy engine (pure, no I/O)
  guardrail.js                Prompt-injection scan for untrusted memos
  evaluate.js                 Shared evaluation path: policy + reservation
                              bookkeeping + audit write (one code path for
                              trigger, validator, panel, and agent)
  store.js                    Storage interface; Forge KVS in production,
                              in-memory twin for local tests
  issueFields.js              Request intake: custom fields + fallbacks
  jira.js                     Jira REST helpers (issue fetch, comments)
  index.js                    Forge function entry points (manifest wiring)
  handlers/
    trigger.js                avi:jira:created/updated:issue -> verdict comment
    validator.js              jira:workflowValidator -> blocks Approve on REJECT
    resolver.js               UI resolver: panel data, policy get/save,
                              audit log, CSV export
    actions.js                Rovo actions: evaluate / daily spend / policy
    rollup.js                 Daily scheduled rollup summary
  frontend/
    issue-panel.jsx           UI Kit panel (verdict, gauge, audit trail)
    admin-page.jsx            UI Kit admin page (policy form, audit, CSV)
test/
  policy.test.js              Node test-runner suite: engine + evaluation
                              flows (22 tests, the original suite)
  audit-fixes.test.js         Audit-fix tests: strict amount parsing,
                              fail-closed caps/currency, ADF intake,
                              dry-run reads, rollup, CSV escaping
  handlers.test.js            Trigger / validator / action tests with a
                              stubbed Jira layer (66 tests total)
SKILL.md                      How third-party agents use the MCP tools
```

## Dossier feature map (v1 scope, frozen)

| # | Feature | Where |
|---|---------|-------|
| 1 | Policy admin page (caps, currency, allowlists, frozen) | `jira:adminPage` + `admin-page.jsx` + resolver `savePolicy` |
| 2 | Request intake (amount/vendor/requester fields + fallbacks) | `issueFields.js` (field ids at the top of the file) |
| 3 | Deterministic policy engine | `policy.js` (+ `guardrail.js`), tests in `test/policy.test.js` |
| 4 | Auto-evaluation trigger + verdict comment | `trigger` module + `handlers/trigger.js` |
| 5 | Issue panel (verdict, gauge, policy, audit) | `jira:issuePanel` + `issue-panel.jsx` + resolver `getPanelData` |
| 6 | Workflow validator blocks Approve on REJECT | `jira:workflowValidator` + `handlers/validator.js` |
| 7 | Rovo agent + GET actions | `rovo:agent` + `action` modules + `prompt.md` + `handlers/actions.js` |
| 8 | Audit log + admin report + CSV export | `store.js` audit keys + resolver `getAuditLog` / `exportAuditCsv` |
| 9 | Install link, public repo, SKILL.md | Public repo (link above) + `SKILL.md`; judges' install link still to generate (see Deployment status) |
| 11 (stretch) | `rovo:mcp` exposing the GET actions | `rovo:mcp` in `manifest.yml` + `SKILL.md` |
| 12 (stretch) | Daily rollup scheduled trigger | `scheduledTrigger` + `handlers/rollup.js` |
| 10 (stretch, not in v1) | Teamwork Graph read | Scopes commented out in `manifest.yml`; org-admin consent is a judge-install risk until the read ships |

Deviations from the on-chain original, by design: there is no vault
balance in Jira, so the balance check is dropped; the recipient
allowlist becomes vendor + requester allowlists; a memo guardrail rule
is added (the Python `guardrail.py` behaviour).

## Local development

Requires Node 24.x (Forge runtime `nodejs24.x`).

```bash
npm test          # engine + evaluation-flow + handler tests (no deps needed)
```

The engine, guardrail, intake, and evaluation service are
dependency-free and fully testable under plain Node. The Forge packages
in `package.json` (`@forge/api`, `@forge/kvs`, `@forge/resolver`,
`@forge/react`, `@forge/bridge`) are used only inside the Forge runtime;
versions are pinned by `package-lock.json`.

Issue field mapping lives at the top of `src/issueFields.js`
(`customfield_10050` amount, `…51` vendor, `…52` requester, `…53`
currency). After installing on a real site, set those ids to the site's
actual "Payment request" fields — or rely on the documented fallbacks
(labels `amount:250.00` / `vendor:acme-corp`, or `Amount:` / `Vendor:`
lines in the description).

## Deployment status

Done (26 Nov 2026):

- App registered; `manifest.yml` carries the real app ID
  `9b3559bf-3f3a-4378-a5ad-5604633fa295`.
- Deployed and installed in the development environment on
  `vaultmind-dev.atlassian.net`.
- Manifest includes `rovo:agent` and `rovo:mcp`; `npm test` passes
  66/66 locally.

Still to do before the Devpost submission (deadline
23 Dec 2026 03:00 WIB):

1. Verify Rovo is present and answering on the site plan (Rovo is a
   paid-plan feature — Standard/Premium trial if the dev site lacks it).
2. Configure the policy on the admin page; map the real custom field
   ids in `src/issueFields.js`, or confirm the label/description
   fallbacks on the demo data.
3. Attach the workflow validator to the Approve transition of the
   payment-request workflow and confirm an over-cap request is blocked.
4. Capture screenshots from live Jira (admin page, issue panel REJECT,
   blocked Approve transition, audit CSV) and record the demo video.
5. Judges' access: generate the installation link from the developer
   console BEFORE submitting any Marketplace listing (a listed app can
   no longer be distributed via console links).
6. Marketplace (only if pursuing that bonus): complete partner
   verification + payment profile first, then create the free listing
   (privacy policy URL, support contact, scope justifications — the app
   makes zero external calls, which keeps approval simple) and submit;
   the review ticket link qualifies for the Marketplace bonus even if
   approval lands after the deadline.

## License

MIT
