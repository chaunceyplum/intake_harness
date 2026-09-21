import type { AgentName } from "./types";
import { allWorkfrontToolNames } from "@/lib/workfront-tools";

/**
 * The pipeline order AND the least-privilege boundary for every agent.
 * This is the ONE place that decides which agent runs next, which MCP
 * tools it may call, and which prior agents' outputs it may see —
 * individual agent routes never call each other directly, and never get to
 * decide their own permissions. To add a 5th sequential agent, add a row to
 * PIPELINE; nothing else in lib/pipeline changes.
 */
export interface AgentDefinition {
  name: AgentName;
  /** Path relative to the app's own origin — POSTed to by the orchestrator. */
  path: string;
  label: string;
  /** Who owns building out the real logic behind the stub, for the README/status UI. */
  /*
   * WHO IS BUILDING IT IS NOT PART OF THE PRODUCT.
   *
   * These carried "Dev 1", "Dev 2", "Dev 3 (you)" and "Unassigned" from
   * when the pipeline was a build plan, and Agent Manager surfaced them on
   * the Agents screen - so a Comcast reviewer saw our sprint allocation
   * next to the agent that files their request.
   *
   * Optional now and set by nobody. Left in the type because a deployment
   * that genuinely owns its agents may want to say so; a build assignment
   * is not that.
   */
  owner?: string;
  /**
   * MCP tool names this task may call, enforced inside
   * src/lib/mcp-client.ts — a call to any tool NOT in this list throws
   * immediately rather than silently succeeding. That throw surfaces as a
   * normal failed task_run (the orchestrator already records agent errors
   * that way), so a scoping violation is visible in observability, not a
   * silent hole.
   *
   * Workfront/Fusion tools now exist in chaunceyplum/mcp (14 servers under
   * mcp_server/workfront/servers/, each its own Lambda route — see the
   * route table atop src/lib/mcp-client.ts). The lists below are a DRAFT
   * first pass, not a confirmed final scope: they're least-privilege
   * guesses at what Intake/Review need for B1/B2 in the requirements doc
   * (create/read the work request; read/update it during triage), not a
   * sign-off on the real Workfront object model this team uses. Confirm
   * and adjust before treating these as final.
   */
  allowedTools: string[];
  /**
   * Which prior agents' outputs this task may see via `priorOutputs`,
   * beyond its own immediate `input` (always just the previous agent's
   * output). The orchestrator filters `priorOutputs` down to exactly this
   * list before calling the agent — an agent literally never receives a
   * key it isn't scoped to see, not just one it's expected to ignore.
   */
  contextAccess: AgentName[];
}

/*
 * GATES ARE NOT IN THIS FILE - see lib/pipeline/gates.ts.
 *
 * PIPELINE is the ORDER. What has to be true before a step may run is a
 * separate question, and the answers are process decisions from the map (1.5
 * "Approved?", 2.7 "Attributes available?") rather than properties of an agent.
 * An agent whose gate is shut is not called and writes no task_runs row.
 */
/*
 * THE NAMES ON THE DECK.
 *
 * Morpheus, The Architect, Tank, The Keymaker and The Oracle are how this
 * pipeline is presented to the client, so the labels the product emits match
 * the slide rather than contradicting it. A reviewer reading the Event Log and
 * a reviewer reading the deck should be looking at the same five things.
 *
 * Two mismatches are worth knowing rather than papering over:
 *
 *   THE DECK GIVES COUNTS TO THE ARCHITECT. In this pipeline the count is
 *   Tank's, because the count comes out of building the segment. The label
 *   moved; the behaviour did not, and pretending otherwise would put a number
 *   on the wrong card during the demo.
 *
 *   THE ORACLE IS NOT IN THIS LIST. It is the Codex - the record itself, which
 *   is Agent Manager, not a step in the harness. It has no entry here because
 *   it does not run.
 *
 * `name` is untouched. Those are API identifiers that runs, gates and stored
 * records are keyed on; renaming a label must never rename a contract.
 */
export const PIPELINE: AgentDefinition[] = [
  {
    name: "intake",
    path: "/api/agents/intake",
    label: "Morpheus — Brief Agent",
    // Workfront only (workfront-core), per the stated split: create the
    // work request from the marketer's brief (B1), and list/get to check
    // for an existing duplicate before creating one. No update/delete —
    // intake shouldn't be able to modify or remove existing records.
    allowedTools: [
      "search_adobe_knowledge",
      ...allWorkfrontToolNames(),
    ],
    contextAccess: [], // first in the pipeline — nothing prior to see
  },
  {
    name: "review",
    path: "/api/agents/review",
    label: "The Architect — Validation Agent",
    /*
     * Phase 2 plus the 1.5a rework path, so the scope spans both.
     *
     *   Workfront  2.1 creates the project and links it to the issue; triage
     *              reads and updates the request; comments carry the rejection
     *              reason and the conversion note.
     *   AEP        2.3 asks whether the audience already exists. It is a READ
     *              of the catalog and nothing more - adobe_list_segments only.
     *              Agent 3 keeps the estimate and schema tools; phase 2 has no
     *              business estimating or creating anything.
     *
     * This is the narrowest set that covers 2.1 to 2.7. Note what is NOT here:
     * adobe_create_segment, adobe_create_segment_estimate, adobe_get_schema.
     * 2.3 needs to know IF an audience exists, not to build or size one.
     */
    allowedTools: [
      "search_adobe_knowledge",
      ...allWorkfrontToolNames(),
      "adobe_list_segments",
    ],
    /*
     * 2.1 needs the ORIGINAL brief and the issue Agent 1 created.
     *
     * Its `input` is intake's output and carries both today, so this is belt
     * and braces rather than a new capability - but phase 2 writing the brief
     * to the project is the step that makes the brief survive, and it should
     * not depend on the brief happening to still be in the last hop's payload.
     */
    contextAccess: ["intake"],
  },
  {
    name: "audience_creation",
    path: "/api/agents/audience-creation",
    label: "Tank — Segmentation Agent",
    allowedTools: [
      "search_adobe_knowledge",
      // B5 (3.1): decide FAC vs. AEP rule builder, and predict membership
      // count before the nightly cutoff (B6) — segment estimation, not the
      // full segmentation-job tools.
      "adobe_create_segment_estimate",
      "adobe_get_segment_estimate",
      /*
       * QUERY SERVICE, because the estimate endpoint does not exist.
       *
       * adobe_create_segment_estimate posts to
       * /ups/segment/definitions/{id}/estimate and gets a 404 from nginx, so
       * the count has to come from somewhere real. Adobe serves query results
       * over its PSQL interface and hands out the connection parameters
       * through this tool; the harness already speaks Postgres.
       *
       * Without it the count path was refused by our own allow-list -
       * "Task audience_creation is not allowed to call MCP tool
       * query_get_connection_parameters" - which is the allow-list doing its
       * job on a capability I added and forgot to declare.
       */
      "query_get_connection_parameters",
      "query_run",
      "query_get",
      "query_get_results",
      "adobe_list_segments",
      "adobe_get_segment",
      "adobe_create_segment",
      // B4: check whether the attributes an audience needs already exist
      // in AEP before opening a GTO/attribute request.
      "adobe_list_schemas",
      "adobe_get_schema",
      /*
       * The fields, which are NOT in the schema document.
       *
       * A schema is allOf + $refs to field groups and the connector does not
       * expand them, so adobe_get_schema returns no field definitions and 2.7
       * was permanently "undetermined". These two return the real fields.
       */
      "adobe_list_field_groups",
      "adobe_get_field_group",
    ],
    /*
     * The original brief, and what phase 2 concluded.
     *
     * 3.1's FAC-versus-rule-builder decision and the identity gap at 3.4 both
     * read the brief's own fields, and by the time Agent 3 runs its `input` is
     * phase 2's output - which carries the project, not necessarily the brief
     * as the marketer wrote it. Naming both here is how it sees the request
     * rather than only the last transformation of it.
     */
    contextAccess: ["intake", "review"],
  },
];

/**
 * Agent 4 — Escalation. NOT part of PIPELINE: it isn't step 4 of the happy
 * path, it's the handler for when the happy path doesn't happen.
 *
 * From the requirements doc (B9 / step 4.6): "Full escalation. The process
 * terminates without an audience, and nothing is captured... Log the
 * failure and classify it. This is the input to the crawl, walk, run loop
 * in section 10 — without it, the same class of failure recurs
 * indefinitely and the agents never improve."
 *
 * The orchestrator (runPipeline in orchestrator.ts) calls this agent
 * exactly when a run's status becomes "failed" — never on "needs_input",
 * which is an expected, resumable pause (B1's marketer round-trip, B3's
 * validation step), not a terminated-without-an-audience escalation. It
 * needs visibility into every prior agent's output to classify what
 * actually went wrong, which is why contextAccess is broad here — this is
 * the one agent where that's the job, not a scoping gap.
 */
export const ESCALATION: AgentDefinition = {
  name: "escalation",
  path: "/api/agents/escalation",
  label: "The Keymaker — Reconciliation Agent",
  // NOTE: the knowledge tool is `search_adobe_knowledge`. `search_knowledge_base`
  // does NOT exist on any server in the estate - it was asked for here and in
  // all three agents above, every call failed, the failure was written into the
  // payload rather than raised, and the run still reported `completed`. That is
  // why escalation has never fired. Verified against the live endpoint, 238 tools.
  allowedTools: ["search_adobe_knowledge"], // TODO: look up prior similar failures once a real classification store exists
  contextAccess: ["intake", "review", "audience_creation"],
};

/** Every task, sequential pipeline + escalation — used to seed db/schema.sql's `tasks` catalog and for tool-allowlist lookups in lib/mcp-client.ts. */
export const ALL_TASKS: AgentDefinition[] = [...PIPELINE, ESCALATION];
