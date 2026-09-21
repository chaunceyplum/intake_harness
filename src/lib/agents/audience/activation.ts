/**
 * Explicit, on-command audience activation - Agent 3's one WRITE capability,
 * and the one place in this agent that isn't "everything here is a READ"
 * (see aep.ts's own docstring). OFF BY DEFAULT: nothing in this file
 * attempts anything unless intake's own `destination` field (or, for older
 * runs that predate it, the brief's free text) names a real destination -
 * see resolveActivationIntent. Every other decision this agent makes -
 * build path, attribute checks - behaves exactly as it always has, with or
 * without this module ever firing.
 *
 * WHAT THIS ACTUALLY DOES, AND WHAT IT DELIBERATELY STILL DOES NOT DO
 *
 * Grounded against a live sandbox, 19-21 Sep 2026 - not guessed. Destinations
 * here are DATAFLOWS (destination_list_dataflows / destination_get_dataflow),
 * each carrying its own `segment_selectors`: the actual list of segments
 * activated to it. Re-verified 21 Sep 2026, schemas unchanged:
 *
 * 1. UPDATED 21 Sep 2026: there IS now a tool that adds a segment to an
 *    EXISTING dataflow - destination_update_dataflow_audiences, taking
 *    add_audience_ids / remove_audience_ids (JSON-array strings of segment
 *    IDs) against a flow_id. This supersedes the earlier note here, which
 *    said no such tool existed and that the only option was a duplicate
 *    dataflow. When a dataflow already exists for the destination but does
 *    not carry this segment, activateIntoExistingDataflow now ADDS the
 *    segment to that dataflow in place (add_audience_ids only - it never
 *    removes, so every other audience already activated on that dataflow is
 *    left exactly as it was, which was the whole reason the merge used to be
 *    considered unsafe). Plain destination_update_dataflow (rename/reschedule
 *    only, no audience field) still can't do this and is still unused.
 *
 * 2. What that means in practice, as of 21 Sep 2026 (explicit product
 *    direction): whenever this segment isn't already active at the named
 *    destination there are now TWO distinct paths, not one -
 *      - the destination already has a dataflow that just doesn't carry this
 *        segment -> add the segment to THAT dataflow in place
 *        (destination_update_dataflow_audiences); nothing new is created.
 *      - the destination has NO dataflow yet -> create an additional, NEW
 *        dataflow for it. This still needs a real chain, verified live
 *        against "chaunceys custom dest" (a real, working dataflow on this
 *        tenant):
 *      target connection (by name) --connection_spec_id-->
 *      flow spec (flow_list_flow_specs, matched by targetConnectionSpecIds)
 *      --flow_spec_id + sourceConnectionSpecIds-->
 *      a PROVEN source_connection_id, borrowed from an existing
 *      segment-activation dataflow (findProvenSourceConnection) rather than
 *      resolved generically - source_list_connections' own listing doesn't
 *      expose connection_spec_id, and checking every candidate would mean
 *      an unbounded number of detail calls. Reusing a connection a real
 *      dataflow already uses successfully is grounded, not guessed; if
 *      nothing suitable has ever been wired on this tenant, this declines
 *      rather than invent an untested source_connection_id.
 *    `destination_create_dataflow` has NO dry_run option (unlike
 *    comment-stream_create_comment) - there is no preview step available
 *    for this write. The segment_selectors payload shape is INFERRED from
 *    one real dataflow's structure (destination_get_dataflow on "chaunceys
 *    custom dest"), not exhaustively confirmed against a schema the tool
 *    itself doesn't publish beyond "JSON array of segment activation
 *    transformation dicts" - flagged here, not hidden, because a reader
 *    relying on this working perfectly for every destination TYPE should
 *    know it was built from one working example, not a spec.
 *
 * 3. What was ALREADY safe, and still is: a real segment named "Has ECID"
 *    already existed, activated to "chaunceys custom dest" - findDestination
 *    Dataflow/selectorsIncludeSegment below confirm and report that rather
 *    than attempting any write when the answer is already "yes, wired".
 */

import { callMcpTool } from "@/lib/mcp-client";
import type { TaskId } from "@/lib/pipeline/types";
import { criteriaKeywords } from "./aep";

export type ActivationIntent = {
  requested: boolean;
  destinationName: string | null;
  evidence: string | null;
};

/** Answers intake's own field is treated as meaning "no destination, build-only" - not a literal destination named "none". */
const NOT_REQUESTED_ANSWERS = new Set([
  "", "n/a", "na", "none", "no", "not applicable", "no destination",
  "build-only", "build only", "audience only", "not yet", "tbd",
]);

/** The field-based signal - see resolveActivationIntent for why this outranks brief-text parsing when it's present. */
export function detectActivationIntentFromField(destination: string | undefined): ActivationIntent {
  const trimmed = String(destination ?? "").trim();
  if (!trimmed || NOT_REQUESTED_ANSWERS.has(trimmed.toLowerCase())) {
    return { requested: false, destinationName: null, evidence: null };
  }
  return { requested: true, destinationName: trimmed, evidence: `intake field "destination": "${trimmed}"` };
}

/**
 * Does the brief explicitly ask to activate the audience somewhere?
 *
 * Looked for as an actual verb - activate/send/push/sync "to" a named
 * destination - never inferred from request_type's "Audience + Campaign
 * Execution", which is a Workfront-form category for routing the intake
 * issue, not a statement that a real AEP activation should happen right
 * now. FALLBACK ONLY now - see resolveActivationIntent - kept for runs from
 * before campaign-brief.ts had a `destination` field, or a rework loop that
 * carried an old `fields` object forward without it.
 */
export function detectActivationIntent(brief: string | undefined): ActivationIntent {
  const text = String(brief || "");
  const m = text.match(
    /\b(?:activate|send|push|sync)\b(?:\s+\w+){0,4}?\s+(?:it|this|the audience|them)?\s*(?:to|into)\s+([^.,;]{3,80})/i,
  );
  if (!m) return { requested: false, destinationName: null, evidence: null };
  const destinationName = m[1].trim().replace(/^(the|a|an)\s+/i, "").trim();
  return { requested: true, destinationName: destinationName || null, evidence: m[0] };
}

/**
 * The real signal to use: intake's own `destination` field when it exists
 * (an explicit answer to "what destination does this audience go to?"
 * outranks a regex match against free text in both directions - a real
 * name in the field wins even if the brief's wording is ambiguous, and an
 * explicit "none" wins even if the brief happens to contain an
 * activation-shaped phrase). Only falls back to brief-text parsing when the
 * field is genuinely absent (undefined) - not merely blank/"none", which is
 * itself the answer, not a missing one.
 */
export function resolveActivationIntent(brief: string | undefined, destinationField: string | undefined): ActivationIntent {
  if (destinationField != null) return detectActivationIntentFromField(destinationField);
  return detectActivationIntent(brief);
}

type DataflowRecord = {
  id: string;
  name: string;
  segmentSelectors: unknown;
};

type DestinationMatch = {
  read: boolean;
  error: string | null;
  dataflow: DataflowRecord | null;
  considered: number;
};

/** Longest-overlap name match against a list of {id, name} rows - shared shape for dataflows and target connections. */
function bestNameMatch(rows: Array<{ id: string; name: string }>, destinationName: string): { id: string; name: string; score: number } | null {
  const meaningful = criteriaKeywords(destinationName);
  let best: { id: string; name: string; score: number } | null = null;
  for (const row of rows) {
    if (!row.name || !row.id) continue;
    const hay = row.name.toLowerCase();
    const score = meaningful.filter((t) => hay.includes(t)).length;
    if (score > 0 && (!best || score > best.score)) best = { id: row.id, name: row.name, score };
  }
  return best;
}

/**
 * Fuzzy-match a destination name against real, existing DATAFLOWS - the
 * same word-overlap scoring aep.ts's findExistingSegment uses for segments,
 * reusing its criteriaKeywords so "Chauncey's custom destination" and a
 * real dataflow named "chaunceys custom dest" can find each other despite
 * neither being an exact string.
 */
async function findDestinationDataflow(taskId: TaskId, destinationName: string): Promise<DestinationMatch> {
  try {
    const result = await callMcpTool<{ dataflows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(
      taskId,
      "destination_list_dataflows",
      { limit: "50" },
    );
    const rows = (Array.isArray(result) ? result : (result as { dataflows?: unknown[] })?.dataflows || []) as Array<
      Record<string, unknown>
    >;

    const best = bestNameMatch(
      rows.map((r) => ({ id: String(r.id || ""), name: String(r.name || "") })),
      destinationName,
    );

    if (!best) {
      return { read: true, error: null, dataflow: null, considered: rows.length };
    }

    const detail = await callMcpTool<Record<string, unknown>>(taskId, "destination_get_dataflow", {
      flow_id: best.id,
    });
    return {
      read: true,
      error: null,
      dataflow: { id: best.id, name: best.name, segmentSelectors: detail?.segment_selectors ?? null },
      considered: rows.length,
    };
  } catch (err) {
    return { read: false, error: (err as Error).message, dataflow: null, considered: 0 };
  }
}

type TargetConnectionMatch = {
  id: string;
  name: string;
  connectionSpecId: string | null;
};

/**
 * Fuzzy-match a destination name against TARGET CONNECTIONS (the
 * destination account/platform configuration itself, distinct from a
 * dataflow - a target connection can exist with no dataflow using it yet).
 * Finding one here, when findDestinationDataflow found no dataflow, is
 * what makes "create a new dataflow" possible instead of just "not found".
 */
async function findTargetConnection(
  taskId: TaskId,
  destinationName: string,
): Promise<{ read: boolean; error: string | null; match: TargetConnectionMatch | null; considered: number }> {
  try {
    const result = await callMcpTool<{ target_connections?: Array<Record<string, unknown>> }>(
      taskId,
      "destination_list_target_connections",
      { limit: "50" },
    );
    const rows = (result?.target_connections || []) as Array<Record<string, unknown>>;
    const best = bestNameMatch(
      rows.map((r) => ({ id: String(r.id || ""), name: String(r.name || "") })),
      destinationName,
    );
    if (!best) return { read: true, error: null, match: null, considered: rows.length };

    const detail = await callMcpTool<Record<string, unknown>>(taskId, "destination_get_target_connection", {
      target_connection_id: best.id,
    });
    return {
      read: true,
      error: null,
      match: {
        id: best.id,
        name: best.name,
        connectionSpecId: detail?.connection_spec_id ? String(detail.connection_spec_id) : null,
      },
      considered: rows.length,
    };
  } catch (err) {
    return { read: false, error: (err as Error).message, match: null, considered: 0 };
  }
}

/**
 * Which flow spec a target connection's type uses - flow_list_flow_specs is
 * a large catalog (2000+ lines on this tenant), so this is only ever called
 * once we already have a specific connectionSpecId to search FOR, never to
 * browse it.
 */
async function resolveFlowSpecId(taskId: TaskId, connectionSpecId: string): Promise<{ flowSpecId: string | null; error: string | null }> {
  try {
    const result = await callMcpTool<{ flow_specs?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(
      taskId,
      "flow_list_flow_specs",
      {},
    );
    const rows = (Array.isArray(result) ? result : (result as { flow_specs?: unknown[] })?.flow_specs || []) as Array<
      Record<string, unknown>
    >;
    for (const row of rows) {
      const targetIds = Array.isArray(row.targetConnectionSpecIds) ? (row.targetConnectionSpecIds as unknown[]) : [];
      if (targetIds.map(String).includes(connectionSpecId)) {
        return { flowSpecId: row.id ? String(row.id) : null, error: null };
      }
    }
    return { flowSpecId: null, error: `no flow spec on this tenant lists connection spec ${connectionSpecId} as a target` };
  } catch (err) {
    return { flowSpecId: null, error: (err as Error).message };
  }
}

/**
 * A source_connection_id PROVEN to work for segment activation on this
 * tenant, borrowed from an existing dataflow that already has non-empty
 * segment_selectors - rather than resolved generically (source connections'
 * own listing doesn't expose connection_spec_id, so matching one to a
 * specific flow spec would mean an unbounded number of detail calls).
 * Bounded to the first 10 dataflows listed; if none of those is a
 * segment-activation dataflow, this declines rather than guess further.
 */
async function findProvenSourceConnection(taskId: TaskId): Promise<{ sourceConnectionId: string | null; error: string | null }> {
  try {
    const list = await callMcpTool<{ dataflows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(
      taskId,
      "destination_list_dataflows",
      { limit: "50" },
    );
    const rows = (Array.isArray(list) ? list : (list as { dataflows?: unknown[] })?.dataflows || []) as Array<
      Record<string, unknown>
    >;
    for (const row of rows.slice(0, 10)) {
      const flowId = row.id ? String(row.id) : "";
      if (!flowId) continue;
      const detail = await callMcpTool<Record<string, unknown>>(taskId, "destination_get_dataflow", { flow_id: flowId });
      const hasSegments = Array.isArray(detail?.segment_selectors) && (detail.segment_selectors as unknown[]).length > 0;
      const sourceId = detail?.source_connection_id ? String(detail.source_connection_id) : "";
      if (hasSegments && sourceId) return { sourceConnectionId: sourceId, error: null };
    }
    return {
      sourceConnectionId: null,
      error: "no existing segment-activation dataflow found among the first 10 listed, so a proven-compatible source connection could not be inferred",
    };
  } catch (err) {
    return { sourceConnectionId: null, error: (err as Error).message };
  }
}

/**
 * Does a dataflow's segment_selectors already include this segment id?
 * Walks defensively rather than assuming the exact nesting - the real
 * shape (verified live) is
 * segment_selectors[].params.segmentSelectors.selectors[].value.id, but
 * this reads any {id|systemSegmentId} it finds anywhere in the structure
 * so a shape variation degrades to "checked more than necessary" rather
 * than "missed a real match."
 */
function selectorsIncludeSegment(segmentSelectors: unknown, segmentId: string): boolean {
  let hit = false;
  const walk = (v: unknown, depth = 0) => {
    if (hit || depth > 8 || v == null) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (o.id === segmentId || o.systemSegmentId === segmentId) {
      hit = true;
      return;
    }
    for (const val of Object.values(o)) walk(val, depth + 1);
  };
  walk(segmentSelectors);
  return hit;
}

/**
 * segment_selectors as destination_create_dataflow wants it - a JSON
 * STRING (its own schema: "JSON array of segment activation transformation
 * dicts"), shaped from the one real example this was verified against
 * (destination_get_dataflow on "chaunceys custom dest"). The real example's
 * selector values also carried namespace/originName/name/description/
 * createTime/updateTime - included where knowable (namespace is always
 * "AEPSegments" for a platform segment; the rest is AEP's own metadata,
 * populated server-side, not something this agent can state truthfully in
 * advance) rather than fabricated.
 */
function buildSegmentSelectorsPayload(segmentId: string): string {
  return JSON.stringify([
    {
      name: "GeneralTransform",
      params: {
        segmentSelectors: {
          selectors: [
            {
              type: "PLATFORM_SEGMENT",
              value: { id: segmentId, systemSegmentId: segmentId, namespace: "AEPSegments" },
            },
          ],
        },
      },
    },
  ]);
}

export type ActivationOutcome =
  | { status: "already_active"; destinationName: string; dataflowId: string }
  | { status: "no_destination_named"; reason: string }
  | { status: "destination_not_found"; requestedName: string; reason: string | null; considered: number }
  | { status: "no_segment_to_activate"; reason: string }
  | { status: "created"; destinationName: string; dataflowId: string }
  | { status: "create_failed"; destinationName: string; reason: string }
  /**
   * The segment was ADDED to a dataflow that already existed for this
   * destination (destination_update_dataflow_audiences, add_audience_ids) -
   * an in-place activation, distinct from "created" (a brand-new dataflow).
   * This is the path that used to be impossible; see this file's docstring
   * point 1/2.
   */
  | { status: "activated_existing"; destinationName: string; dataflowId: string }
  /** The in-place add to an existing dataflow was attempted but failed. */
  | { status: "activate_existing_failed"; destinationName: string; dataflowId: string; reason: string }
  /**
   * The dataflow read itself failed (network/MCP error) - distinct from a
   * CONFIRMED absence (destination_not_found, where the read succeeded and
   * genuinely found nothing). Reported honestly rather than treated as "no
   * dataflow exists", which would let a transient read failure fall through
   * to destination_create_dataflow and mint a duplicate dataflow for a
   * destination that may already have one.
   */
  | { status: "lookup_failed"; destinationName: string; reason: string };

/**
 * Add a segment to an EXISTING dataflow's activated audiences in place, via
 * destination_update_dataflow_audiences. add_audience_ids is a JSON-array
 * STRING of segment IDs (the tool's own schema) - and we only ever pass
 * add_audience_ids, never remove_audience_ids, so nothing already activated
 * on this dataflow is disturbed. This is the correct in-place activation
 * that superseded the old duplicate-dataflow workaround (see this file's
 * docstring point 1).
 */
async function activateIntoExistingDataflow(
  taskId: TaskId,
  dataflow: DataflowRecord,
  segmentId: string,
): Promise<ActivationOutcome> {
  try {
    await callMcpTool<Record<string, unknown>>(taskId, "destination_update_dataflow_audiences", {
      flow_id: dataflow.id,
      add_audience_ids: JSON.stringify([segmentId]),
    });
    return { status: "activated_existing", destinationName: dataflow.name, dataflowId: dataflow.id };
  } catch (err) {
    return {
      status: "activate_existing_failed",
      destinationName: dataflow.name,
      dataflowId: dataflow.id,
      reason: (err as Error).message,
    };
  }
}

/**
 * The activation decision, given a segment findExistingSegment already
 * found (or didn't) and an explicitly requested destination name.
 */
export async function activateAudience(
  taskId: TaskId,
  args: { segmentId: string | null; segmentName: string | null; destinationName: string | null },
): Promise<ActivationOutcome> {
  if (!args.destinationName) {
    return {
      status: "no_destination_named",
      reason: "Activation was requested but no destination was named in the brief - nothing to wire this to.",
    };
  }

  if (!args.segmentId) {
    return {
      status: "no_segment_to_activate",
      reason:
        "No existing segment matched this audience, and creating a brand-new one requires a real PQL expression - " +
        "which this agent will not author from scratch. The knowledge base does not have PQL's actual operators/" +
        "syntax indexed (see review's PQL grounding), so a guessed expression risks silently selecting the wrong " +
        "audience rather than failing visibly. Supply the exact PQL expression to build and activate a new segment.",
    };
  }

  const match = await findDestinationDataflow(taskId, args.destinationName);
  // A failed READ is not a confirmed absence. Bail here, honestly, rather
  // than let a transient dataflow-list error fall through to "no dataflow
  // found" and risk minting a duplicate dataflow for a destination that may
  // already have one (see this file's docstring point 1/2 and
  // findDestinationDataflow's catch).
  if (!match.read) {
    return {
      status: "lookup_failed",
      destinationName: args.destinationName,
      reason: `could not check whether "${args.destinationName}" already has a dataflow: ${match.error}`,
    };
  }
  if (match.dataflow && selectorsIncludeSegment(match.dataflow.segmentSelectors, args.segmentId)) {
    return { status: "already_active", destinationName: match.dataflow.name, dataflowId: match.dataflow.id };
  }
  // A dataflow already exists for this destination but doesn't carry this
  // segment: ADD the segment to it in place, rather than minting a second
  // dataflow (what this used to do, before the tool below existed - see this
  // file's docstring point 1/2). add_audience_ids only, so every other
  // audience already activated on this dataflow is left untouched.
  if (match.dataflow) {
    return activateIntoExistingDataflow(taskId, match.dataflow, args.segmentId);
  }
  // No dataflow matched this destination by name at all. The destination
  // might still exist as a target connection, which is what makes creating a
  // (new, first) dataflow possible.
  const targetMatch = await findTargetConnection(taskId, args.destinationName);
  if (!targetMatch.match) {
    return {
      status: "destination_not_found",
      requestedName: args.destinationName,
      reason:
        targetMatch.error ??
        `no destination matching "${args.destinationName}" was found among ${match.considered} dataflow(s) or ` +
          `${targetMatch.considered} target connection(s) on this tenant.`,
      considered: match.considered,
    };
  }

  if (!targetMatch.match.connectionSpecId) {
    return {
      status: "create_failed",
      destinationName: targetMatch.match.name,
      reason: "found the destination's target connection, but it has no readable connection type to build a dataflow against.",
    };
  }

  const flowSpec = await resolveFlowSpecId(taskId, targetMatch.match.connectionSpecId);
  if (!flowSpec.flowSpecId) {
    return {
      status: "create_failed",
      destinationName: targetMatch.match.name,
      reason: flowSpec.error ?? "could not resolve a flow spec for this destination's connection type.",
    };
  }

  const sourceMatch = await findProvenSourceConnection(taskId);
  if (!sourceMatch.sourceConnectionId) {
    return {
      status: "create_failed",
      destinationName: targetMatch.match.name,
      reason: sourceMatch.error ?? "could not determine a proven-compatible source connection.",
    };
  }

  try {
    const created = await callMcpTool<Record<string, unknown>>(taskId, "destination_create_dataflow", {
      name: `${args.segmentName ?? args.segmentId} -> ${targetMatch.match.name}`,
      description: "Created by Agent 3 (Audience Creation) on explicit activation request from intake.",
      flow_spec_id: flowSpec.flowSpecId,
      source_connection_id: sourceMatch.sourceConnectionId,
      target_connection_id: targetMatch.match.id,
      segment_selectors: buildSegmentSelectorsPayload(args.segmentId),
    });
    const dataflowId = created?.id ? String(created.id) : "";
    return { status: "created", destinationName: targetMatch.match.name, dataflowId };
  } catch (err) {
    return { status: "create_failed", destinationName: targetMatch.match.name, reason: (err as Error).message };
  }
}
