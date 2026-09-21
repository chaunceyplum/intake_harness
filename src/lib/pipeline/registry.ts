import type { AgentName } from "./types";
import { intakeWorkfrontToolNames, reviewWorkfrontToolNames, commentToolNames } from "@/lib/workfront-tools";

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
  owner: string;
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
   * route table atop src/lib/mcp-client.ts).
   *
   * CONFIRMED, 21 Sep 2026 — every grant below was checked against that
   * agent's actual callMcpTool call sites (workfront.ts, workfront-fields.ts,
   * workfront-notes.ts, aep.ts, activation.ts, pql-synth.ts,
   * workfront-updates.ts), not guessed from the requirements doc. This used
   * to grant Intake and Review the FULL Workfront toolset
   * (allWorkfrontToolNames()) "per the stated split" — but neither agent
   * actually calls `search`/`getOne`, Intake never calls `listComments`
   * (duplicate detection is a Postgres idempotency lookup, never a live
   * Workfront read), and Review never calls `create`/`resolveFields`/
   * `insights_find_id_by_name` (it only ever touches the one issue already
   * in its input). See intakeWorkfrontToolNames()/reviewWorkfrontToolNames()
   * (workfront-tools.ts) for the exact, per-agent grant and why each tool
   * is or isn't in it. `adobe_get_segment` was dropped from both Review and
   * Audience Creation below for the same reason: grepping every AEP call
   * site turned up zero callers — it was granted but never actually used.
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
  /**
   * Does a human have to click "Approve" before THIS agent runs, once the
   * prior one has completed? Defaults to true (undefined === required) —
   * the per-agent equivalent of a tool-use permission prompt, so opting
   * OUT of it is the thing that has to be explicit and visible here, not
   * the other way round. See orchestrator.ts's advanceOneStep for exactly
   * how a `false` here chains straight into this agent instead of stopping
   * the run at "awaiting_approval".
   */
  requiresApproval?: boolean;
}

export const PIPELINE: AgentDefinition[] = [
  {
    name: "intake",
    path: "/api/agents/intake",
    label: "Agent 1 — Intake",
    owner: "Dev 1",
    // Workfront only (workfront-core): resolve the intake queue by name,
    // create the work request from the marketer's brief (B1), set its
    // custom-form values (a real `update` call — Adobe's connector needs a
    // create-then-set-custom-fields two-step, see workfront.ts's top
    // docstring — but only against the object THIS task just created, never
    // an existing one), and post its own "what I did" comment. No
    // search/getOne/listComments — duplicate detection is a Postgres
    // idempotency lookup (findPriorTaskRun), never a live Workfront read,
    // and intake never reads a comment thread. See
    // intakeWorkfrontToolNames() for the verified call-site mapping.
    allowedTools: [
      "search_adobe_knowledge",
      ...intakeWorkfrontToolNames(),
    ],
    contextAccess: [], // first in the pipeline — nothing prior to see
  },
  {
    name: "review",
    path: "/api/agents/review",
    label: "Agent 2 — Review / Triage",
    owner: "Dev 2",
    // Workfront (workfront-core + workfront-comments): read the rejection
    // comment thread and update the review-notes custom field on the SAME
    // issue already in its input (B2) — that's where a rejection reason and
    // the redraft explanation live — plus post its own "what I did" comment.
    // No create/search/getOne/insights_find_id_by_name/resolveFields: review
    // never opens a new Workfront object, never looks up a project/queue by
    // name, and never reads an object other than the one it was handed. See
    // reviewWorkfrontToolNames() for the verified call-site mapping.
    allowedTools: [
      "search_adobe_knowledge",
      ...reviewWorkfrontToolNames(),
      // triage.ts's "wrong_data_source" finding (FAC vs. the AEP profile
      // store, the most expensive classification this agent makes) is a
      // guess without being able to check AEP itself: whether the attribute
      // actually lives in a profile-enabled schema, whether an audience
      // already exists for this ask, and roughly how big the candidate
      // profile dataset is. All read-only — Review triages and asks; it
      // does not create/update anything in AEP (that's Agent 3's job).
      //
      // WHEN THIS IS WIRED UP: whatever calls adobe_get_schema must only
      // ever treat a field as present when it is literally named in that
      // response's field list — never inferred from the schema's title, a
      // field's plausible existence, or the marketer's own wording. Agent
      // 3's src/lib/agents/audience/aep.ts hit this exact failure mode
      // (word-boundary matching against real field names, because an
      // unanchored match on "lob" once matched "glob" inside a URL and
      // reported line-of-business as available on nothing) — reuse that
      // discipline here rather than re-learning it. A hallucinated field
      // answers "wrong data source" wrong, silently, which is worse than
      // not answering it at all.
      "adobe_list_schemas",
      "adobe_get_schema",
      // The merged profile view for the whole sandbox - the FIRST thing
      // aep.ts's probeSchemas asks, because it answers "does field X exist"
      // in one call that can't miss by sampling the wrong schema. Read-only.
      "adobe_get_union_schema",
      // A class-based schema (Profile, ExperienceEvent) rarely carries its
      // fields inline - it composes them from field groups via allOf/$ref,
      // so reading the class schema alone and finding nothing is "asked the
      // wrong document," not "no fields exist." See aep.ts's
      // fieldGroupRefs/FIELD_GROUP_SAMPLE for exactly how this is used and
      // why it's bounded.
      "adobe_get_field_group",
      // adobe_get_segment was here but is never called by anything review
      // does (grep-verified, 21 Sep 2026) - findExistingSegment only ever
      // calls adobe_list_segments. Dropped rather than kept "just in case".
      "adobe_list_segments",
      // Catalog metadata is how you tell a profile-enabled dataset from any
      // other (its schema's union/profile behavior). No Query Service access —
      // that's a much bigger permission (arbitrary SQL) than this stub needs
      // just to triage a rejection.
      "adobe_list_datasets",
    ],
    // Empty today: this stub doesn't read priorOutputs at all, and its
    // `input` already IS intake's output. Widen this only when a real
    // implementation needs to look back further than its immediate input.
    contextAccess: [],
  },
  {
    name: "audience_creation",
    path: "/api/agents/audience-creation",
    label: "Agent 3 — Audience Creation",
    owner: "Dev 3 (you)",
    // Runs straight after Review with no approval click in between — on
    // explicit product direction, to keep the happy path moving rather
    // than stopping to ask "run Audience Creation?" every single time.
    // Everything Agent 3 itself does is still a read (see
    // lib/agents/audience/aep.ts) and it can still pause the RUN on its
    // own via "needs_input" (an open GTO attribute request) - this only
    // removes the separate human click that used to sit between it and
    // Review finishing.
    requiresApproval: false,
    allowedTools: [
      "search_adobe_knowledge",
      // B5 (3.1): decide FAC vs. AEP rule builder.
      //
      // adobe_create_segment_estimate/adobe_get_segment_estimate (B6 count
      // prediction) are deliberately NOT granted here any more — verified
      // live against 4 real segment IDs that the estimate tool 404s on every
      // one of them (a gateway-side bug, not fixable from this app — see
      // lib/agents/audience/aep.ts's docstring). A tool this agent can no
      // longer usefully call has no reason to stay in its allowlist.
      // adobe_get_segment was here but is never called (see the identical
      // note on review's grant above) - dropped.
      "adobe_list_segments",
      "adobe_create_segment",
      // B4: check whether the attributes an audience needs already exist
      // in AEP before opening a GTO/attribute request.
      "adobe_list_schemas",
      "adobe_get_schema",
      // The merged profile view - probeSchemas' first, cheapest probe. See
      // review's identical grant above.
      "adobe_get_union_schema",
      // See registry.ts's note on review's identical grant, and aep.ts's
      // fieldGroupRefs: a class schema's fields usually live in a
      // referenced field group, not inline on the class schema itself.
      "adobe_get_field_group",
      // Explicit, on-command activation ONLY (see agents/audience/
      // activation.ts) - checking whether an audience is already wired to a
      // named destination's dataflow, and activating it when it isn't. Two
      // shapes, and as of 21 Sep 2026 they are now DIFFERENT writes:
      //   - a dataflow ALREADY EXISTS for the destination but doesn't carry
      //     this segment -> ADD the segment to that dataflow's activated
      //     audiences via destination_update_dataflow_audiences (below). This
      //     is the correct, in-place activation, and it is only possible now
      //     that the tool exists - the older note here said it didn't and
      //     that this case had to mint a duplicate dataflow instead. It does
      //     not.
      //   - NO dataflow exists yet for the destination -> create one with
      //     destination_create_dataflow (the full target-connection ->
      //     flow-spec -> proven-source chain, see activation.ts).
      // destination_update_dataflow_audiences takes add_audience_ids /
      // remove_audience_ids (JSON-array strings of segment IDs) against a
      // flow_id - verified against the live tool's own inputSchema, not
      // guessed. Agent 3 only ever ADDS (never removes) here, so an existing
      // dataflow's other activated audiences are left untouched - the exact
      // safety concern that used to force the duplicate-dataflow workaround.
      // Plain destination_update_dataflow (rename/reschedule only, no
      // audience field) is still NOT granted - it can't activate anything.
      "destination_list_dataflows",
      "destination_get_dataflow",
      "destination_list_target_connections",
      "destination_get_target_connection",
      "flow_list_flow_specs",
      "destination_create_dataflow",
      "destination_update_dataflow_audiences",
      // The orchestrator posts a "what this agent did" comment back onto the
      // Workfront issue after EVERY step completes (see
      // lib/pipeline/workfront-updates.ts), and it posts AS the completing
      // agent — so this otherwise read-only agent needs the comment-create
      // tool, and ONLY that write. Intake and Review already have it via
      // intakeWorkfrontToolNames/reviewWorkfrontToolNames above; this is the
      // minimal grant that lets Agent 3's updates reach the issue without
      // handing it create/update.
      ...commentToolNames(),
    ],
    // Review already runs the SAME read-only AEP context probe one step
    // earlier (agents/review/aep-context.ts) - schema availability, existing
    // segment, profile-enabled datasets, PQL grounding. Granting Agent 3
    // sight of review's output lets it REUSE a conclusive probe instead of
    // repeating every one of those MCP reads from scratch (see
    // audience-creation/route.ts, which falls back to its own probe only
    // when review's is absent or inconclusive). This is the scoped-context
    // mechanism finally being used, not ceremony.
    contextAccess: ["review"],
  },
];

/**
 * Agent 4 — Escalation was removed on explicit product direction: the
 * out-of-band handler the orchestrator used to call when a run's status
 * became "failed" (B9 / step 4.6 in the requirements doc - "log the
 * failure and classify it"). It never actually fired in practice (see
 * db/schema.sql's tasks-catalog comment / the historical `escalation` rows
 * that predate this removal) and product direction was to drop it rather
 * than keep carrying a handler for a case nothing exercised. A failed run
 * now just ends at status "failed" - see orchestrator.ts's advanceOneStep,
 * which no longer calls anything after recording that.
 *
 * "escalation" stays in AgentName/TaskId (types.ts) purely so historical
 * task_runs rows with that task_id still type-check honestly - it is not
 * an agent this app will ever invoke again.
 */
