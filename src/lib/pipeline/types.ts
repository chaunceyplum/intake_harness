/**
 * The contract every agent endpoint implements. Each agent in the
 * sequential pipeline (Intake, Review/Triage, Audience Creation — see
 * src/lib/pipeline/registry.ts's PIPELINE) is a standalone Next.js route
 * handler. This is the ONLY shape the orchestrator, and every other agent,
 * needs to agree on. An agent can be rewritten entirely internally as long
 * as it keeps this request/response shape.
 */

/**
 * "escalation" is kept here even though Agent 4 — Escalation was removed
 * (see registry.ts) purely so historical `task_runs`/`tasks` rows with
 * that task_id still type-check honestly against real DB content — it is
 * not, and will never again be, an agent this app invokes.
 */
export const AGENT_NAMES = ["intake", "review", "audience_creation", "escalation"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];
/** A task_id in the `tasks` table is just an AgentName — same vocabulary, DB column name. */
export type TaskId = AgentName;

/**
 * "completed"    — normal success, output feeds the next agent.
 * "needs_input"  — the agent hit one of the doc's human-in-the-loop points
 *                  (e.g. B1's marketer round-trip, B3's marketer validation
 *                  at 2.5). The pipeline pauses here rather than failing;
 *                  a human resolves it and the run is resumed.
 * "failed"       — unrecoverable error for this run.
 */
export type AgentStatus = "completed" | "needs_input" | "failed";

export interface AgentRequest<TInput = unknown> {
  /** The runs.run_id this call belongs to. */
  runId: string;
  /** Output of the previous agent (or the original submission for the first agent). */
  input: TInput;
  /** Every prior agent's output in this run, keyed by agent name, for agents that need earlier context (e.g. Audience Creation re-checking the original intake). */
  priorOutputs: Partial<Record<AgentName, unknown>>;
}

export interface AgentResponse<TOutput = unknown> {
  status: AgentStatus;
  /** Present when status is "completed"; becomes the next agent's `input`. */
  output?: TOutput;
  /**
   * A plain-English explanation of what this step did, for a human reading
   * the run — not just for "failed"/"needs_input" anymore. Every current
   * agent already computes something like this internally (Audience
   * Creation's statusMessage); the fix was surfacing it here on success
   * too, not adding a new field.
   */
  message?: string;
  /**
   * Free-form health/observability data, persisted alongside the task run
   * but NOT passed to the next agent. Use this for the metrics the
   * requirements doc calls out explicitly, e.g. { loopCount } for B1,
   * { identityGap } for B3, { requestAgeSeconds } for B7.
   */
  metadata?: Record<string, unknown>;
  /**
   * Only set this when an agent genuinely called a model — none of the
   * four today do (they're deterministic parsers and MCP/tool calls), so
   * this is deliberately never fabricated. It exists so a future agent
   * that does call one has somewhere real to report it, and the UI shows
   * it only when present rather than a permanent fake "0 tokens".
   */
  usage?: { tokens: number; model?: string };
}

/** One row in `runs` — a single pipeline invocation. */
export interface RunRow {
  run_id: string;
  /**
   * "awaiting_approval" — a step just completed and there's a next agent to
   * run, but the orchestrator stops and waits for
   * POST /api/runs/[runId]/continue rather than calling it automatically.
   * The per-agent equivalent of a tool-use permission prompt.
   */
  status: "running" | "completed" | "failed" | "needs_input" | "awaiting_approval";
  current_step: number;
  input: unknown;
  created_at: string;
  updated_at: string;
  /**
   * Optional grouping, ported from db/schema.sql's `programmes` table.
   * NOT YET WIRED UP: no route or UI sets this today (nothing creates a
   * programme or assigns a run to one) - it is schema ahead of code, kept
   * honest here rather than pointing at a `src/lib/programmes.ts` that
   * doesn't exist. Build the programmes CRUD before relying on this field.
   */
  programme_id: string | null;
  /** Two-tier human curation — see src/app/api/runs/[runId]/{approve,promote}/route.ts. */
  tags: string[];
  approved: boolean;
  approved_by: string | null;
  approved_at: string | null;
  approval_note: string | null;
  /**
   * Tier 2: an approved run an admin has additionally marked worth
   * surfacing more broadly. Set by POST /api/runs/[runId]/promote, which
   * requires `approved` first. NOT the same "graph" as CX Agent Manager's
   * own cross-agent graph (services/agent-manager) - this harness has no
   * `/api/graph` of its own; `promoted` is currently just a queryable flag
   * on `runs`; see stats.promoted (page.tsx/settings) for where it's read.
   */
  promoted: boolean;
  promoted_by: string | null;
  promoted_at: string | null;
}

/** One row in `tasks` — the static catalog of task/agent types (seeded from registry.ts). */
export interface TaskRow {
  task_id: TaskId;
  label: string;
  owner: string | null;
  created_at: string;
}

/** One row in `task_runs` — a single execution of a task inside a run. The traceability record: what ran, in which run, at what step, and when. */
export interface TaskRunRow {
  task_run_id: number;
  run_id: string;
  task_id: TaskId;
  step_index: number;
  status: AgentStatus;
  input: unknown;
  output: unknown;
  message: string | null;
  metadata: Record<string, unknown>;
  /** Null on every agent today — see AgentResponse.usage. */
  tokens_used: number | null;
  model: string | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  created_at: string;
}
