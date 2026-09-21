-- Agentic harness observability schema. Applied against the SAME Postgres
-- instance the Python MCP server (chaunceyplum/mcp) uses for pgvector, but
-- deliberately separate tables — this harness's 3-agent pipeline is a
-- different concern from that repo's Python orchestrator (`executions` /
-- `execution_resources`), and the two must never collide on names or
-- semantics.
--
-- Three levels, matching how the pipeline actually runs:
--   runs       — one row per pipeline invocation (a marketer's request).
--   tasks      — a catalog of the task/agent *types* that can run (intake,
--                review, audience_creation, and escalation — the last one
--                invoked only when a run fails, not part of the sequential
--                pipeline). Static reference data, seeded below from the
--                pipeline registry.
--   task_runs  — one row per actual execution of a task within a run: which
--                task, in which run, at which step, with what status, and
--                exactly when it started/finished. This is the traceability
--                table — "what ran, per run, and when."
--
-- Idempotent — safe to re-run. CREATE-only except for the tasks catalog
-- upsert at the bottom, which only ever reflects the current registry.
--
-- Apply with: psql "$DATABASE_URL" -f db/schema.sql

CREATE TABLE IF NOT EXISTS runs (
    run_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status        TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'completed', 'failed', 'needs_input')),
    current_step  INTEGER NOT NULL DEFAULT 0,
    input         JSONB NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
    task_id     TEXT PRIMARY KEY,     -- matches AgentName in src/lib/pipeline/types.ts
    label       TEXT NOT NULL,
    owner       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The audit trail the requirements doc keeps asking for (B1's loop count,
-- B7's request age, B9's failure classification all read off this table).
CREATE TABLE IF NOT EXISTS task_runs (
    task_run_id  BIGSERIAL PRIMARY KEY,
    run_id       UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    task_id      TEXT NOT NULL REFERENCES tasks(task_id),
    step_index   INTEGER NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('completed', 'needs_input', 'failed')),
    input        JSONB NOT NULL,
    output       JSONB,
    message      TEXT,
    metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at   TIMESTAMPTZ NOT NULL,
    finished_at  TIMESTAMPTZ NOT NULL,
    duration_ms  INTEGER NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_task_runs_run ON task_runs(run_id, step_index);
CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, started_at);

-- Two-tier human curation, added on top of the CREATE TABLE above via ALTER
-- so this stays safe to re-run against an already-populated `runs` table
-- (CREATE TABLE IF NOT EXISTS is a no-op on an existing table's columns).
--
-- Tier 1, "approved": a named admin marks a completed run worth keeping as
-- an example. Tier 2, "promoted": that same run is additionally admitted
-- into the cross-run Shared Graph (see GET /api/graph). Both always carry
-- who and when — an approval or promotion with no admin behind it isn't a
-- record of anything. Promotion requires prior approval, enforced in
-- src/app/api/runs/[runId]/promote/route.ts rather than a CHECK constraint,
-- to keep this file plain ALTERs.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE runs ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS approval_note TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS promoted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS promoted_by TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_runs_promoted ON runs(promoted) WHERE promoted;

-- Per-agent human approval gate, mirroring how a tool call waits for
-- permission before it runs. A run now stops after EVERY successfully
-- completed step (not just a "needs_input"/"failed" one) and sits in
-- "awaiting_approval" until POST /api/runs/[runId]/continue advances it to
-- the next agent. Widens the CHECK constraint the original CREATE TABLE
-- shipped with — DROP + re-ADD is the only idempotent way to change a CHECK
-- in place, so this stays safe to re-run.
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check
    CHECK (status IN ('running', 'completed', 'failed', 'needs_input', 'awaiting_approval'));

-- Model usage, when an agent genuinely reports it. NULL on every agent
-- today — none of the four call a model, they're deterministic parsers and
-- MCP/tool calls — so this stays empty rather than holding a fabricated 0.
-- It exists for the day an agent does call one, via AgentResponse.usage.
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS tokens_used INTEGER;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS model TEXT;

-- Programmes: a named grouping a run can belong to (ported from Agent
-- Manager's Project, minus its lifecycle machinery — just enough to group
-- runs). upsert-by-name in src/lib/pipeline/programmes.ts, so submitting
-- the same programme name twice reuses the row rather than duplicating it.
CREATE TABLE IF NOT EXISTS programmes (
    programme_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL UNIQUE,
    note          TEXT,
    owner         TEXT,
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS programme_id UUID REFERENCES programmes(programme_id);
CREATE INDEX IF NOT EXISTS idx_runs_programme ON runs(programme_id);

-- Resources: the generic knowledge-base entries ported from Agent Manager's
-- resource-policy catalog (playbooks, decisions, architecture docs/diagrams,
-- meeting notes, code snippets, configs, handoff-prompts) — content worth
-- keeping that ISN'T a pipeline run. Single content blob per resource, not
-- an ordered step log: Agent Manager needed steps because the same object
-- doubled as both a run record and a doc; here `task_runs` already owns run
-- history, so a resource only needs to be a doc. Same two-tier curation as
-- `runs` (approved -> promoted into the Shared Graph), same admin model.
CREATE TABLE IF NOT EXISTS resources (
    resource_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type           TEXT NOT NULL CHECK (type IN (
                       'playbook', 'decision', 'architecture-doc', 'architecture-diagram',
                       'meeting-notes', 'code-snippet', 'configuration', 'handoff-prompt'
                   )),
    title          TEXT NOT NULL,
    content        TEXT NOT NULL,
    format         TEXT,
    tags           TEXT[] NOT NULL DEFAULT '{}',
    owner          TEXT,
    programme_id   UUID REFERENCES programmes(programme_id),
    approved       BOOLEAN NOT NULL DEFAULT false,
    approved_by    TEXT,
    approved_at    TIMESTAMPTZ,
    approval_note  TEXT,
    promoted       BOOLEAN NOT NULL DEFAULT false,
    promoted_by    TEXT,
    promoted_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type);
CREATE INDEX IF NOT EXISTS idx_resources_promoted ON resources(promoted) WHERE promoted;

-- Settings: a single editable row (id is always 1 — the CHECK enforces
-- that, so there's exactly one config, never a second competing row).
-- Ported from Agent Manager's settings override (D48): a retention window
-- for unapproved Resources, plus manual purge rather than a cron this app
-- has no scheduler to run. Deliberately does NOT cover Runs — those are
-- this harness's own audit trail (B7's request age, B9's failure
-- classification both read off them), not disposable draft content the
-- way an unapproved Resource is.
CREATE TABLE IF NOT EXISTS settings (
    id              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    retention_days  INTEGER NOT NULL DEFAULT 30 CHECK (retention_days > 0),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by      TEXT
);
INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Parity with Agent Manager's settings override (D48) beyond retention:
-- segmentation_labels/kind_labels rename what things are CALLED (internal
-- keys — "programme", each resources.type value — never change, only their
-- display label, so relabeling never breaks stored data or filters, same
-- principle as that D48 override). promote_admins is the "Hero Agents"
-- roster (D64): the subset of ADMIN_NAMES allowed to promote into the
-- Shared Graph. NULL/empty means "any admin may promote" — today's
-- behavior — so this is purely additive until an admin actually sets one.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS segmentation_labels JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS kind_labels JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS promote_admins TEXT[];

-- Seed/refresh the task catalog from src/lib/pipeline/registry.ts (PIPELINE
-- + ESCALATION, i.e. ALL_TASKS). Keep this block in sync with that file —
-- it's the one place both agree on task_id.
-- The names the client sees. Kept in sync with src/lib/pipeline/registry.ts,
-- which is where the behaviour lives - this table is what /api/tasks serves,
-- so renaming the registry alone changes nothing a reviewer looks at.
--
-- owner is NULL deliberately. These rows carried 'Dev 1', 'Dev 2',
-- 'Dev 3 (you)' and 'Unassigned' from when this was a build plan, and the
-- Agents screen showed our sprint allocation beside the agent that files a
-- Comcast request.
INSERT INTO tasks (task_id, label, owner) VALUES
    ('intake',            'Morpheus — Brief Agent',              NULL),
    ('review',            'The Architect — Validation Agent',    NULL),
    ('audience_creation', 'Tank — Segmentation Agent',           NULL),
    ('escalation',        'The Keymaker — Reconciliation Agent', NULL)
ON CONFLICT (task_id) DO UPDATE SET label = EXCLUDED.label, owner = EXCLUDED.owner;

-- ---------------------------------------------------------------------------
-- GATES: the approval at 1.5, and every other point the process waits at.
--
-- WHY THIS TABLE EXISTS
--
-- The pipeline used to run intake -> review -> audience_creation in one pass,
-- which meant Agents 2 and 3 ran on a brief nobody had approved. Both reported
-- `completed`. Agent 2's "completed" covered a comment read that had errored;
-- Agent 3's covered building nothing at all. Three green stages, one real one.
--
-- The map does not work that way. 1.5 is a decision - "Approved?" - and phase 2
-- begins at connector A, on the Yes branch only. So the run now STOPS after
-- intake and waits. A gated agent is not called, and writes no task_runs row:
-- it does not appear as pending, or completed, or anything. Nothing can report
-- a status for work it was never handed.
--
-- WHY A TABLE AND NOT A COLUMN
--
-- "Who owns the review queue decision at 1.5, and is the rejection reason
-- captured anywhere structured today?" is an open question in the blockers doc,
-- and B2 depends entirely on the answer. A decision row per gate, with who
-- decided and their reason, is that structure. It also makes the rejection
-- reason a first-class input to Agent 2's triage instead of something the agent
-- has to go fishing for in a comment stream it may not be able to read.
CREATE TABLE IF NOT EXISTS run_gates (
    gate_run_id  BIGSERIAL PRIMARY KEY,
    run_id       UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    -- Which gate, e.g. 'approval_1_5'. Matches a gate id in pipeline/gates.ts.
    gate_id      TEXT NOT NULL,
    -- The pipeline step this gate stands in front of.
    step_index   INTEGER NOT NULL,
    decision     TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
    -- A named human. B4/B7 are both about things sitting unowned; an approval
    -- with nobody's name on it is the same failure in miniature.
    decided_by   TEXT NOT NULL,
    -- On a rejection this IS the rework reason, and it is what Agent 2 triages.
    reason       TEXT,
    -- Where the decision came from: the Workfront approval, the dashboard, MCP.
    evidence     JSONB NOT NULL DEFAULT '{}'::jsonb,
    decided_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_run_gates_run ON run_gates(run_id, decided_at);

-- A run waiting at a gate. Null when it is not waiting.
-- Carries { gate_id, label, step_index, agent, awaiting } so the dashboard can
-- say what is being waited FOR, which B4 insists on: "give the marketer a
-- visible status instead of silence."
ALTER TABLE runs ADD COLUMN IF NOT EXISTS blocked_on JSONB;

-- 'awaiting_approval' is a fourth run state, and it is not 'needs_input'.
--   needs_input       - the agent ran and wants something from the marketer.
--   awaiting_approval - the agent has NOT run, and will not until a gate opens.
-- Collapsing them would lose exactly the distinction this whole change is for.
DO $$
BEGIN
    ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_status_check;
    ALTER TABLE runs ADD CONSTRAINT runs_status_check
        CHECK (status IN ('running', 'completed', 'failed', 'needs_input', 'awaiting_approval'));
END $$;
