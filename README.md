# intake_harness

A Next.js orchestration layer for the Comcast audience-pipeline agents. It
calls MCP servers over HTTP for everything Adobe/Workfront/Postgres-related
— it does not duplicate AEP auth, Workfront auth, or Postgres access. Every
agent reaches those through `src/lib/mcp-client.ts`.

> **This file describes the current architecture.** It has drifted badly
> from the code before (an earlier version described a 4th agent,
> Escalation, that was later removed, and tool names that no longer exist)
> — if you're reading this to prep a demo or onboard, also skim
> `src/lib/pipeline/registry.ts` and `db/schema.sql`, which are kept
> current with inline comments explaining every non-obvious decision.

## Why this shape

Three agents run in a fixed sequential order — **Intake → Review/Triage →
Audience Creation** — each one's output becoming the next one's input.
There is no 4th "Escalation" agent; a run that fails just ends at
`status = "failed"` (see `registry.ts` for why Escalation was removed).

The requirements doc behind this (blockers B1–B9) found that the process
itself mostly works — the actual failure mode is **silent waiting**:
unbounded marketer round-trips (B1), a nightly job that turns every rework
cycle into a full day (B6), an open cross-team request nobody is tracking
(B4). So instead of each agent calling the next one directly, a single
orchestrator (`src/lib/pipeline/orchestrator.ts`) calls each agent's
endpoint in turn and persists a row to Postgres after every step. That
gives:

- A visible, queryable status for any in-flight run (`GET
  /api/runs/[runId]`) instead of a black box.
- Two distinct pause states, not just "failed": `needs_input` (the
  marketer needs to answer something — B1's round-trip) and
  `awaiting_approval` (a human clicks "Approve" before the next agent
  runs, the per-agent equivalent of a tool-use permission prompt — see
  `requiresApproval` in `registry.ts`). Audience Creation is the one agent
  that opts out of the approval gate today and chains straight from
  Review, on explicit product direction.
- Each agent stays an independent, independently testable endpoint — you
  can `curl localhost:3000/api/agents/audience-creation` on its own
  without running the rest of the pipeline.

## What each agent actually does today

None of these are stubs anymore. All three read a marketer's brief and
take real, observable actions against live systems when configured to.

- **Intake** (`/api/agents/intake`): reads the brief into the ~35
  Campaign Brief fields (`src/lib/agents/shared/campaign-brief.ts`), each
  one tagged `stated` / `derived` / `inferred` so a guess is never
  silently treated as a fact (`src/lib/agents/intake/parse.ts`). Asks for
  at most two missing fields per round rather than the whole form. Once
  buildable, it creates the real Workfront intake issue
  (`src/lib/agents/intake/workfront.ts`), idempotently — a crash-then-retry
  reuses the prior create instead of duplicating it.
- **Review** (`/api/agents/review`): pre-flights a fresh intake against
  what the review queue would reject it for, and — on an actual rejection
  — translates the reviewer's rejection text into the specific field(s) to
  fix (`src/lib/agents/review/triage.ts`), including resolving the
  expensive "is this FAC or the AEP profile store" question directly
  against AEP schemas instead of always asking a human
  (`src/lib/agents/review/data-source.ts`).
- **Audience Creation** (`/api/agents/audience-creation`): checks whether
  the audience's needed attributes conclusively exist in AEP before
  opening a cross-team attribute request (durable, wall-clock-aged, not a
  pass-counter — `src/lib/agents/audience/attribute-requests.ts`), decides
  FAC vs. the AEP rule builder, and — when a destination is *explicitly*
  named — checks whether the audience is already activated there or
  creates a new dataflow (`src/lib/agents/audience/activation.ts`; there is
  still no safe way to add a segment to an *existing* dataflow's selectors,
  so that case is reported for a human to wire up manually, never guessed).

**LLM-assisted reading is opt-in, not required.** Set `LLM_PROVIDER`
(`bedrock` | `anthropic` | `ollama` — see `.env.local.example`) to let
Intake's brief extraction, Review's rejection triage, and Audience
Creation's PQL-expression drafting use a model instead of hand-written
regex. Every LLM path validates its own output against the same real field
list / schema evidence the deterministic path uses, and falls back to the
deterministic path on any failure, timeout, or bad output — turning the LLM
on can only add extraction quality, never change the response contract or
block a run. `GET /api/capabilities` reports live whether a configured
provider is actually reachable.

**Two further opt-in writes, both off by default:**
`AUDIENCE_CREATE_SEGMENT=true` lets Agent 3 actually create an AEP segment
from a PQL expression it verified field-by-field against real schema
evidence (otherwise it only drafts the expression for a human to build
from). Explicit activation (a real `destination` field, or explicit
"activate this to X" language in the brief) lets it create a real AEP
dataflow. `WORKFRONT_WRITES_DISABLED=true` is the opposite kind of switch —
it turns off every Workfront write cleanly (reported as a skipped dry-run,
not a failure) so the pipeline can be exercised without touching Workfront
at all.

## Architecture

```
POST /api/runs  { input }
        │
        ▼
  src/lib/pipeline/orchestrator.ts
        │  for each agent in src/lib/pipeline/registry.ts's PIPELINE:
        │    POST <agent.path>  { runId, input, priorOutputs }
        │    persist a task_runs row (run_id, task_id, step_index, started_at, finished_at)
        ▼
  /api/agents/intake            (Agent 1)
  /api/agents/review            (Agent 2)
  /api/agents/audience-creation (Agent 3 — chains automatically after Review)
        │  each agent, as needed:
        ▼
  src/lib/mcp-client.ts  →  routes by tool-name prefix to the right MCP endpoint
        │
        ▼
  MCP_ENDPOINT_URL (the AEC server: adobe_*/destination_*/query_*/... tools)
  MCP_GATEWAY_URL   (the Cookbook gateway: official Workfront tools —
                     workflow_*/comment-stream_*/insights_*/planning_*/... —
                     namespaced per MCP_GATEWAY_ROUTES)

  ── on any step's status === "failed" ──▶  the run just ends there.
     There is no Agent 4 / Escalation any more (removed on explicit
     product direction — see registry.ts).
```

`GET /api/runs/[runId]` returns the run plus every task run recorded so
far — poll this for status instead of guessing whether a run is still going.

## Observability: runs, tasks, task runs

Three tables (`db/schema.sql`), matching how the pipeline actually executes:

| Table | Row = | Primary key | What it's for |
|---|---|---|---|
| `runs` | one pipeline invocation | `run_id` | "Did this marketer's request finish? What's its current status?" |
| `tasks` | one task/agent *type* (intake, review, audience_creation) | `task_id` | A static catalog — human label + owner per agent, kept in sync with `src/lib/pipeline/registry.ts`'s `PIPELINE`. Still carries a historical `escalation` row for old `task_runs` predating its removal. |
| `task_runs` | one actual execution of a task, inside one run | `task_run_id` | The traceability record: which task, in which run, at which step, with what input/output, and exactly when it started and finished. |

API surface:

- `POST /api/runs` — start a new run.
- `GET /api/runs` — list recent runs.
- `GET /api/runs/[runId]` — one run plus its task_runs, in step order.
- `POST /api/runs/[runId]/resume` — answer a `needs_input` pause and re-run that step.
- `POST /api/runs/[runId]/continue` — approve an `awaiting_approval` run and run the next agent.
- `POST /api/runs/[runId]/retry` — recover a run stuck at `running` (the process died mid-step).
- `POST /api/runs/[runId]/approve` / `POST /api/runs/[runId]/promote` — two-tier human curation: mark a completed run worth keeping, then optionally mark it worth surfacing more broadly (`promote` requires `approve` first, and can be further restricted to a `promote_admins` roster in `settings` — see `src/lib/admins.ts`).
- `GET /api/tasks` — the task catalog. `GET /api/tasks/[taskId]/runs` — every execution of one task, across all runs.
- `GET /api/capabilities` — live check of Workfront-write-enablement and LLM reachability.

Two concurrent requests trying to advance the *same* run (a double-clicked
Resume/Approve/Retry button, or a retried client call) are serialized by a
Postgres advisory lock per `run_id` (see `db.ts`'s `withAdvisoryLock`) — the
loser gets a clear "already being processed" error instead of the same
agent step running twice.

## The agent contract (`src/lib/pipeline/types.ts`)

Every agent route receives:

```ts
{ runId: string, input: <previous agent's output>, priorOutputs: { intake?, review?, audience_creation? } }
```

and must **always** return, as ordinary JSON (never an HTTP error status —
each route's `POST` catches anything unexpected and translates it into this
same shape, so a bug in one agent shows up as a readable `failed` message
instead of an opaque transport error):

```ts
{ status: "completed" | "needs_input" | "failed", output?, message?, metadata? }
```

- `completed` → `output` becomes the next agent's `input`.
- `needs_input` → the run pauses (e.g. the marketer needs to confirm
  something); `message` should say what's needed.
- `failed` → the run stops; `message` should say why.
- `metadata` is recorded on the step but never forwarded downstream — use
  it for health signals (loop counts, extraction source, tool-call traces)
  without polluting the next agent's input.

To add another **sequential** agent: add one entry to `PIPELINE` in
`src/lib/pipeline/registry.ts` and create its route under
`src/app/api/agents/<name>/route.ts`. Nothing else changes.

## Least privilege: scoping tools and context per agent

`src/lib/pipeline/registry.ts` is where each agent's permissions are
declared, and both are enforced, not just documented:

- **`allowedTools`** — the MCP tool names a task may call. `callMcpTool`
  checks the caller's `taskId` against this list before the request leaves
  the process — a denied call surfaces as a normal `failed` task_run, not
  a silent hole.
- **`contextAccess`** — which prior agents' outputs a task may see via
  `priorOutputs`, beyond its own immediate `input`. `orchestrator.ts`
  filters the full accumulated `priorOutputs` down to exactly this list
  before every HTTP call.

Today: Intake and Review are granted the full Workfront toolset
(`allWorkfrontToolNames()` in `src/lib/workfront-tools.ts` — the official
Adobe Workfront MCP's tools, reached via the Cookbook gateway) plus
`search_adobe_knowledge`. Audience Creation additionally gets AEP schema/
segment/destination-dataflow read tools, `destination_create_dataflow` for
the one write it can do (explicit activation), and — like every agent —
the comment-post tool the orchestrator needs to post its own "what this
agent did" update to Workfront centrally after every step
(`src/lib/pipeline/workfront-updates.ts`).

## Setup

```bash
cp .env.local.example .env.local   # fill in MCP_ENDPOINT_URL / MCP_GATEWAY_* and DATABASE_URL
psql "$DATABASE_URL" -f db/schema.sql
npm install
npm run dev
```

Open `http://localhost:3000` — a form that POSTs to `/api/runs`, a list of
recent runs (`/runs`), a settings page for the MCP server registry and
admin allowlist (`/settings`), and a live view of tool calls as an agent
runs.

`.env.local.example` is the single source of truth for every environment
variable this app reads (MCP endpoints, LLM provider config, the two
opt-in writes, `ADMIN_NAMES`) — read it before wiring up a new deployment
rather than relying on this file to enumerate them, since it's the file
most likely to go stale again.

## Schema ahead of code

`db/schema.sql` also provisions `programmes` and `resources` tables, and
`settings` columns (`segmentation_labels`, `kind_labels`) beyond
`retention_days` — all ported from a sibling product's data model (see
`services/agent-manager`, a separate CX Agent Manager product vendored
alongside this app for reference, excluded from this app's own build/lint).
**None of that is wired up to any route or UI in this app yet** — it's
schema written ahead of the code that would use it. The two-tier curation
model on `runs` (`approved` → `promote`) *is* fully wired up, including the
`promote_admins` roster; `programme_id` on `runs` and the `resources` table
are not. Build the corresponding routes before relying on them.

## Migrating from the pre-observability schema

If you already applied an ancient copy of `db/schema.sql` (tables named
`pipeline_runs` / `pipeline_steps`), those are superseded by `runs` /
`tasks` / `task_runs` above and are safe to drop:

```sql
DROP TABLE IF EXISTS pipeline_steps;
DROP TABLE IF EXISTS pipeline_runs;
```
