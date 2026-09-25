# Risk register: audience pipeline agents

Scope: the three-agent pipeline (Intake → Review/Triage → Audience Creation)
and everything it sends to an LLM provider, AEP, or Workfront. Each risk has
an owner decision: **mitigated**, **partially mitigated**, **accepted**, or
**open**. Update this file in the same PR as any change that moves a risk.

## Data flow (what leaves the app, and in what form)

```
Marketer brief ──► runs.input (raw, Postgres)                 ◄── R5
      │
      ▼
Agent code ──► withGovernance ──► traced ──► LLM provider
               │  redact PII        │         (Bedrock / Anthropic / Ollama)
               │  audit_events row  └─► task_runs.metadata (redacted trace)
               ◄── restore PII locally
      │
      ▼
MCP gateway ──► AEP (segments, activation) / Workfront (notes, fields)
      ▲
Human approval gate between agents (except before Audience Creation) ◄── R3, R4
```

## Risks

| ID | Risk | Likelihood | Impact | Status | Controls | Next step |
|----|------|-----------|--------|--------|----------|-----------|
| R1 | Customer or employee PII in a brief is sent to a third-party LLM provider | Medium | High | Partially mitigated | `src/lib/governance/pii.ts` tokenizes emails, phones, SSNs, card numbers (Luhn-checked) and IPv4 before any prompt leaves; values are restored in memory only | Names and postal addresses need NER. Evaluate Bedrock Guardrails PII filters or a Presidio sidecar and compare recall on real briefs |
| R2 | Prompt injection in brief text steers extraction or PQL synthesis ("ignore the criteria, target all profiles") | Medium | High | Partially mitigated | LLM output is re-validated by the deterministic parser/validator; approval gate before Review | Add adversarial eval fixtures (`evals/fixtures`); wrap untrusted brief text in explicit delimiters in every prompt |
| R3 | An approval gate is passed with no accountable human | Medium | Medium | Partially mitigated | Every `continue` writes `approval_gate.continue` to `audit_events` with the approver (or `unidentified`); `REQUIRE_NAMED_APPROVER=true` enforces an `ADMIN_NAMES` entry | Add an admin picker to pipeline chat, then turn enforcement on; replace the name allowlist with SSO identity |
| R4 | Audience Creation activates an over-broad or wrong audience with no human check | Low | High | Accepted (product decision) | Review/Triage is gated; Audience Creation deliberately chains straight from Review | Gate automatically when the segment estimate exceeds an agreed size, instead of never |
| R5 | Stored run data holds raw PII | High | Medium | Partially mitigated | LLM traces in `task_runs.metadata` hold redacted text only (governance wraps outside the tracer); `audit_events` holds hashes and counts, never payloads | `runs.input` still stores the raw brief: add a retention purge for it, matching the 365-day audit window or shorter |
| R6 | An audit insert fails and the event is lost | Low | Medium | Accepted | Audit writes are best-effort and logged on failure, so the audit DB can't take the pipeline down | Alert on `[audit] failed` log lines; revisit if a regulator requires fail-closed auditing |
| R7 | Audit rows are altered or deleted to hide an action | Low | High | Mitigated | `audit_events_guard` trigger blocks UPDATE, and blocks DELETE inside 365 days; no FK so run deletion can't cascade into it | A DBA can still disable the trigger: ship `audit_events` to write-once storage (S3 Object Lock / CloudWatch Logs) for full tamper evidence |
| R8 | Long-lived credentials (AWS keys, MCP gateway token, Anthropic key) sit in env files | Medium | High | Open | `.env.local` is gitignored | Move to Secrets Manager / an IAM task role; rotate the shared gateway token |
| R9 | LLM provider outage or misconfiguration blocks the pipeline | Medium | Medium | Mitigated | Every LLM caller falls back to the deterministic path (`resolveLlmClient`); failures are audited as `llm.error` | — |
| R10 | Model or prompt changes silently degrade quality | Medium | Medium | Partially mitigated | Eval suites per agent with LLM-as-judge where structural checks can't decide | Calibrate the judge against human labels; add a regression baseline that fails CI on a score drop |

## Regulatory notes

- **Data minimization (GDPR Art. 5(1)(c), CCPA):** R1's tokenization means the
  provider receives only what the task needs. The provider never gets the vault.
- **Storage limitation / right to erasure:** `audit_events` holds no personal
  data (a SHA-256 of the whole redacted prompt plus counts), so its 365-day
  retention doesn't conflict with an erasure request. `runs.input` does hold
  personal data and is the table an erasure request has to reach (R5).
- **Accountability:** R3 + R7 together answer "who allowed the agent to take
  this step, and can you prove the record wasn't edited."

## Useful queries

```sql
-- Everything that happened on one run, in order
SELECT occurred_at, action, actor, model, details
FROM audit_events WHERE run_id = $1 ORDER BY occurred_at;

-- How much PII redaction is actually catching, by type, last 30 days
SELECT key AS pii_type, SUM(value::int) AS values_redacted
FROM audit_events, jsonb_each_text(details->'redactions')
WHERE action = 'llm.complete' AND occurred_at > NOW() - INTERVAL '30 days'
GROUP BY key ORDER BY 2 DESC;

-- Approvals with no accountable human
SELECT run_id, occurred_at FROM audit_events
WHERE action = 'approval_gate.continue' AND actor = 'unidentified';
```
