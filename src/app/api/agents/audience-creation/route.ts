import { NextRequest, NextResponse } from "next/server";
import type { AgentRequest, AgentResponse } from "@/lib/pipeline/types";
import { withToolCallLog } from "@/lib/mcp-client";
import {
  probeSchemas,
  findExistingSegment,
  identityGap,
  decideBuildPath,
  nightlyCutoff,
  neededAttributes,
  criteriaKeywords,
} from "@/lib/agents/audience/aep";
import { resolveActivationIntent, activateAudience, type ActivationOutcome } from "@/lib/agents/audience/activation";
import { groundPqlGuidance, type PqlGuidance } from "@/lib/agents/review/pql-context";
import {
  synthesizePql,
  createSegmentFromPql,
  segmentCreationEnabled,
  type SegmentCreation,
} from "@/lib/agents/audience/pql-synth";
import type { AepContext } from "@/lib/agents/review/aep-context";
import type { SchemaProbe, SegmentMatch } from "@/lib/agents/audience/aep";
import {
  findOpenRequest,
  openOrGetRequest,
  resolveOpenRequest,
  ageSecondsOf,
} from "@/lib/agents/audience/attribute-requests";

/**
 * Agent 3 - Audience Creation.
 *
 * The output INTERFACE below is unchanged from the scaffold: it was derived
 * field by field from the blockers this agent owns, and it was derived
 * correctly, so it is reused rather than redesigned. What was missing was the
 * logic behind it - every field returned a placeholder and statusMessage said
 * so honestly.
 *
 *   B3 (2.5)  flag the account-vs-profile identity gap rather than letting the
 *             marketer discover a number they do not recognise. (Predicting a
 *             count itself is NOT done here - see aep.ts's docstring: the
 *             estimate tool is verified broken upstream, and the effort that
 *             would have gone into working around it instead went into
 *             checking whether the audience's needed attributes are real.)
 *   B4 (2.7a) when attributes are missing, keep state on the open GTO request,
 *             re-evaluate on completion rather than waiting for someone to
 *             check, and give the marketer a visible status instead of silence.
 *   B5 (3.1)  decide whether this genuinely needs FAC or can be satisfied in
 *             the rule builder, so the undefined 3.1b path is entered only when
 *             unavoidable.
 *   B6 (3.3)  the nightly job runs at 21:45 and every cycle after it costs a
 *             full day, so validate and predict BEFORE the cutoff.
 *
 * STILL READ-ONLY, DELIBERATELY - even with activation added. Everything
 * here is an AEP read, including activation: it will report that it cannot
 * predict a count rather than create a segment definition to produce one
 * (lib/agents/audience/aep.ts), and it will report whether an audience is
 * already wired to a named destination rather than write that wiring itself
 * (lib/agents/audience/activation.ts) - the tools available genuinely have
 * no safe way to add a segment to an existing destination's dataflow
 * without risking every other segment already activated there, so this
 * reports that rather than guessing. A number, or an activation, obtained
 * by silently writing to a client's sandbox is not worth having.
 *
 * ACTIVATION IS OFF BY DEFAULT. Nothing below changes unless intake's own
 * `destination` field (or, for older runs, the brief's free text) names a
 * real destination - see activation.ts's resolveActivationIntent - build
 * path and attribute checks behave exactly as they always have otherwise.
 */

export interface AudienceCreationInput {
  [key: string]: unknown;
}

export interface AudienceCreationOutput {
  /** B5: which build path this request takes. */
  buildPath: "aep_rule_builder" | "fac";
  /**
   * B4: do the attributes this audience needs exist in AEP today?
   *
   * THREE states, not two. This was a boolean, and when the probe could not
   * reach field-level data it was set to `true` - chosen so an inconclusive
   * check could not open a GTO attribute request. The result was an artifact
   * reading `attributesAvailable: true` directly above a status message saying
   * availability "could not be determined", which is a contradiction a reader
   * has to resolve for themselves, and most will read the boolean.
   *
   * "undetermined" behaves like true for gating - it opens nothing - and reads
   * like what it is.
   */
  attributesAvailable: boolean | "undetermined";
  /** B4: set when attributesAvailable is false and a GTO request is open. */
  openAttributeRequest: {
    status: "not_opened" | "open" | "resolved";
    requestId: string | null;
    ageSeconds: number | null;
  };
  /** B3/B8: account-vs-profile identity gap the marketer should see, not discover. */
  identityGap: { hasGap: boolean; details: string | null };
  /** Marketer-visible status string - the thing B4 says must never be silence. */
  statusMessage: string;
  /**
   * Set ONLY when the brief explicitly asked to activate the audience
   * somewhere (see activation.ts) - absent otherwise, so a reader can tell
   * "activation wasn't asked for" from "activation was asked for and this
   * is what happened" without inspecting a status string.
   */
  activation?: ActivationOutcome;
}

/** The one statusMessage line for whatever activateAudience decided - only ever called when activation was actually requested. */
function formatActivationMessage(activation: ActivationOutcome): string {
  switch (activation.status) {
    case "already_active":
      return `Already activated to "${activation.destinationName}" - nothing to do.`;
    case "no_destination_named":
      return `Activation requested, but no destination was named. ${activation.reason}`;
    case "destination_not_found":
      return (
        `Could not find a destination matching "${activation.requestedName}" ` +
        `(${activation.considered} dataflow(s) checked)` +
        (activation.reason ? ` - ${activation.reason}` : ".")
      );
    case "needs_manual_wiring":
      return `Activation needs manual wiring: ${activation.reason}`;
    case "no_segment_to_activate":
      return `Cannot activate yet: ${activation.reason}`;
    case "created":
      return `Created a new dataflow to "${activation.destinationName}" (${activation.dataflowId}) and activated this audience to it.`;
    case "create_failed":
      return `Could not create a dataflow to "${activation.destinationName}": ${activation.reason}`;
    case "lookup_failed":
      return `Could not verify activation status for "${activation.destinationName}": ${activation.reason}`;
  }
}

/**
 * B4's state, now DURABLE and WALL-CLOCK.
 *
 * "Keep state on the open request, re-evaluate 2.7 automatically on
 * completion rather than waiting for someone to check." This used to carry
 * the request on the run's own output with an `ageSeconds` counter bumped by
 * 1 each pass - which measured passes, not time, and evaporated when the run
 * ended. It now lives in Postgres (lib/agents/audience/attribute-requests.ts,
 * db/schema.sql's attribute_requests), keyed by (run_id, missing-attribute
 * signature), with age computed as NOW() - opened_at. So a request that sits
 * open for a quarter reads as a quarter old - B7's whole point - and the
 * record outlives the run.
 *
 * - attributes present + a prior open request  -> resolve it (automatic 2.7).
 * - attributes present + nothing open          -> not_opened.
 * - attributes missing                         -> open-or-reuse; reusing
 *   preserves opened_at so the clock keeps running.
 */
async function attributeRequestState(
  runId: string,
  attributesAvailable: boolean,
  missing: string[],
): Promise<AudienceCreationOutput["openAttributeRequest"] & { note: string }> {
  if (attributesAvailable) {
    const resolved = await resolveOpenRequest(runId);
    if (resolved) {
      return {
        status: "resolved",
        requestId: resolved.request_id,
        ageSeconds: ageSecondsOf(resolved),
        note:
          `Attribute request ${resolved.request_id} is now satisfied after ${ageSecondsOf(resolved)}s - the ` +
          "attributes are present in AEP, so 2.7 was re-evaluated automatically rather than waiting for " +
          "someone to check.",
      };
    }
    return { status: "not_opened", requestId: null, ageSeconds: null, note: "No attribute request needed." };
  }

  const existing = await findOpenRequest(runId);
  const request = existing ?? (await openOrGetRequest(runId, missing));
  const age = ageSecondsOf(request);
  return {
    status: "open",
    requestId: request.request_id,
    ageSeconds: age,
    // B7's lesson applied here with a real clock: an open request whose age
    // is visible cannot sit unowned as a hidden quarter-long tail.
    note: existing
      ? `Attribute request ${request.request_id} is still open after ${age}s, waiting on ${missing.join(", ")}.`
      : `Opened attribute request ${request.request_id} for ${missing.join(", ")}. This is the 2.7a branch: it ` +
        "leaves this process into the GTO workflow and returns here on completion, and its age is tracked " +
        "in wall-clock time so it cannot sit unanswered with nobody owning it.",
  };
}

/**
 * The route contract (README.md / types.ts) is "always return {status,
 * output?, message?, metadata?}" - never an HTTP error - so a failure is
 * something the orchestrator can record and a human can read, not an opaque
 * transport error. Everything this agent does lives in handlePost; this
 * just guarantees that contract holds even when handlePost throws something
 * unanticipated - without it, orchestrator.ts's callAgent can only record
 * "HTTP 500: " with no message, no output, no metadata anywhere. This is
 * not hypothetical: a live run (see task_run for audience_creation, run
 * 19fefa88…) hit exactly this - a raw 500 with an empty body and nothing
 * recorded anywhere about why.
 */
export async function POST(req: NextRequest) {
  try {
    return await handlePost(req);
  } catch (err) {
    return NextResponse.json<AgentResponse>({
      status: "failed",
      message: `Audience Creation crashed unexpectedly: ${(err as Error).message}`,
    });
  }
}

async function handlePost(req: NextRequest) {
  const body = (await req.json()) as AgentRequest<AudienceCreationInput>;
  const input = body.input || {};
  const fields = ((input.intakeFields || input.fields || {}) as Record<string, string>) || {};
  const brief = typeof input.brief === "string" ? input.brief : undefined;
  // Intake's own `inferred` list (parse.ts's ExtractedField[], carried
  // forward untouched through Review's `...input` spread - see
  // review/route.ts) - which of the chained fields were a GUESS rather than
  // something the marketer actually said. Used below so an LLM-inferred
  // `destination` (never confirmed by a human) cannot pass for the explicit
  // activation command resolveActivationIntent otherwise treats any
  // non-empty field value as.
  const inferredFieldKeys = new Set(
    (Array.isArray(input.inferred) ? (input.inferred as Array<{ key?: unknown }>) : [])
      .map((f) => (typeof f?.key === "string" ? f.key : ""))
      .filter(Boolean),
  );

  // Every read below (probeSchemas, findExistingSegment) calls MCP tools -
  // wrapped so every call, request and response, ends up in
  // metadata.toolCalls for the UI.
  // Review (Agent 2) runs the identical read-only AEP context probe one step
  // earlier and, as of registry.ts granting audience_creation
  // contextAccess: ["review"], hands it forward here. Reuse a CONCLUSIVE
  // prior probe rather than repeating every schema/segment/PQL MCP read -
  // the single biggest source of duplicated work in this pipeline. An
  // inconclusive or absent prior probe is not trusted: we re-probe from
  // scratch below, so this can only save calls, never skip a real check.
  const priorReview = (body.priorOutputs?.review as { aepContext?: AepContext } | undefined)?.aepContext;

  const { result, toolCalls } = await withToolCallLog(body.runId, "audience_creation", async (): Promise<AgentResponse<AudienceCreationOutput>> => {
    const needed = neededAttributes(fields, brief);

    // Reuse Review's probe only when it is conclusive AND covers exactly the
    // attributes this audience needs (Review derives `needed` from the same
    // neededAttributes(), so the sets normally match - but if they diverge,
    // re-probe rather than answer from a probe that checked different fields).
    const priorProbe = priorReview?.schemaProbe;
    const priorCoversNeeded =
      !!priorProbe &&
      priorProbe.conclusive &&
      needed.every((k) => k in (priorProbe.found ?? {}));
    const reusedProbe = priorCoversNeeded;
    const probe: SchemaProbe = priorCoversNeeded ? priorProbe! : await probeSchemas("audience_creation", needed);

    /*
     * AN INCONCLUSIVE PROBE IS NOT A MISSING ATTRIBUTE.
     *
     * This distinction is the whole safety property of this agent. If we could
     * not obtain field-level data we do not know what AEP holds, and claiming the
     * attributes are absent would open a GTO attribute request - the
     * quarter-long tail in B4 - on the strength of our own failure to look.
     *
     * It has already happened once: the probe matched attribute names against
     * schema TITLES, which never contain field names, concluded that all three
     * were missing, and opened a request. Unknown is now reported as unknown, and
     * only a conclusive probe can open anything.
     */
    const missing = probe.conclusive
      ? Object.entries(probe.found).filter(([, ok]) => !ok).map(([k]) => k)
      : [];
    const attributesAvailable: boolean | "undetermined" = probe.conclusive
      ? missing.length === 0
      : "undetermined";

    const path = decideBuildPath(fields, probe);
    const gap = identityGap(fields);
    const cutoff = nightlyCutoff();

    // PQL is the rule builder's language - FAC doesn't use it, so there's
    // nothing to ground when this request took the federated path. See
    // pql-context.ts's docstring for why the local reference (docs/
    // pql-reference.md), not the knowledge base, is the trustworthy source
    // here - re-grounded independently from Review's own pass at this
    // (audience_creation gets no priorOutputs from review today - see this
    // file's docstring - so it can't just trust review's answer secondhand).
    const criteria = [brief, fields.audience_description].filter(Boolean).join(" ") || fields.campaign_name || "";
    // Reuse Review's PQL grounding when it actually grounded something -
    // same criteria, same local reference. Re-ground only on the rule-builder
    // path (FAC doesn't use PQL) and only when Review didn't already do it.
    const reusedPql = !!priorReview?.pqlGuidance?.grounded;
    const pqlGuidance: PqlGuidance | null =
      path.buildPath === "aep_rule_builder"
        ? reusedPql
          ? priorReview!.pqlGuidance
          : await groundPqlGuidance("audience_creation", criteria)
        : null;

    // Synthesize a candidate PQL expression from the criteria, the CONCLUSIVELY
    // present schema fields, and the PQL reference - but only on the rule-builder
    // path, and only when a conclusive probe gives a real field set to verify
    // against. Every field the model uses is checked present before the
    // expression is trusted (see pql-synth.ts); an unverifiable reference gets
    // the whole expression rejected. This is DRAFT-ONLY: the expression is
    // attached for a human to build from, never auto-created (same read-only
    // stance as the rest of this agent). No LLM / inconclusive probe / failure
    // -> no expression, and Agent 3 behaves exactly as before.
    const pqlSynthesis =
      path.buildPath === "aep_rule_builder" && pqlGuidance
        ? await synthesizePql(criteria, probe, pqlGuidance)
        : null;

    // Actually create the segment - ONLY when explicitly enabled
    // (AUDIENCE_CREATE_SEGMENT=true, off by default like activation) AND the
    // expression passed the verify gate. Otherwise the expression stays a
    // draft. createSegmentFromPql follows the same honesty contract as Agent
    // 1's Workfront create: it reports what it WOULD have created when the
    // write tool is disabled, rather than a silent no-op. Never throws.
    const segmentCreation: SegmentCreation | null =
      pqlSynthesis?.synthesized && segmentCreationEnabled()
        ? await createSegmentFromPql(
            body.runId,
            "audience_creation",
            pqlSynthesis,
            [fields.campaign_name, fields.audience_description].filter(Boolean).map(String).join(" — ") ||
              "Audience (drafted by Agent 3)",
          )
        : null;

    // Cheapest good outcome first: an audience that already exists needs no build
    // and is the only way to get a real count without writing anything.
    //
    // THE BUG THIS FIXES: these terms used to be ONLY intake's own
    // categorization fields (campaign_name/lifecycle_journey/line_of_business/
    // customer_type) - never the audience's actual criteria. A brief asking
    // for "an audience where ECID exists" would never match a real, already-
    // built segment literally named "Has ECID", because "ecid" was never one
    // of the words being searched for. Adding keywords from the brief/
    // audience_description is what makes that match findable.
    const terms = [
      fields.campaign_name, fields.lifecycle_journey, fields.line_of_business, fields.customer_type,
      ...criteriaKeywords([brief, fields.audience_description].filter(Boolean).join(" ")),
    ]
      .filter(Boolean)
      .map(String);
    // Reuse Review's segment search when it read successfully. Review now
    // searches the IDENTICAL terms (aep-context.ts's segmentSearchTerms was
    // aligned to this exact derivation), so a successful "no match" from
    // Review is as authoritative as one we'd compute here - reusing it
    // saves the adobe_list_segments read. A failed read (read: false) is not
    // reused; we search ourselves.
    const priorSegment: SegmentMatch | undefined = priorReview?.segmentMatch;
    const reusedSegment = !!priorSegment?.read;
    const existing = reusedSegment ? priorSegment! : await findExistingSegment("audience_creation", terms);

    // Off by default - see this file's docstring and activation.ts. Only
    // runs the destination check/write when intake's own `destination`
    // field (or, for older runs, the brief's free text) names a real one -
    // and only when that field was actually STATED, not guessed. An
    // inferred destination is treated as absent here, which falls back to
    // detectActivationIntent's stricter explicit-verb brief parsing rather
    // than trusting a value nobody confirmed as an activation command.
    const destinationField = inferredFieldKeys.has("destination") ? undefined : fields.destination;
    const activationIntent = resolveActivationIntent(brief, destinationField);
    const activation = activationIntent.requested
      ? await activateAudience("audience_creation", {
          segmentId: existing.id,
          segmentName: existing.name,
          destinationName: activationIntent.destinationName,
        })
      : undefined;

    // Only a CONCLUSIVE "no" opens an attribute request. "undetermined" must not:
    // opening the 2.7a branch because we failed to look is the quarter-long tail
    // started by our own blind spot.
    const attrState = await attributeRequestState(body.runId, attributesAvailable !== false, missing);

    const statusMessage = [
      path.buildPath === "fac"
        ? "Federated (FAC) path: " + path.reason
        : "AEP rule builder: " + path.reason,
      probe.conclusive
        ? `Checked ${probe.fieldCount} field(s) across ${probe.schemasInspected} profile schema(s)` +
          (probe.sandbox ? ` in sandbox "${probe.sandbox}"` : "") + "."
        : `Attribute availability is UNDETERMINED: ${probe.error}` +
          (probe.sandbox ? ` (sandbox "${probe.sandbox}")` : "") +
          ". No attribute request has been opened on the strength of that.",
      existing.id
        ? `Reusing existing audience "${existing.name}".`
        : existing.read
          ? `No existing audience matched (${existing.considered} checked).`
          : `Could not list existing audiences: ${existing.error}.`,
      gap.hasGap ? "Identity gap flagged: see identityGap." : "",
      pqlGuidance
        ? pqlGuidance.localReference.available
          ? `PQL reference: ${pqlGuidance.localReference.path} (${pqlGuidance.localReference.categoryCount} categories) - build the segment expression against this, not the knowledge base.`
          : `PQL reference unavailable: ${pqlGuidance.localReference.error}.`
        : "",
      pqlSynthesis
        ? pqlSynthesis.synthesized
          ? segmentCreation
            ? segmentCreation.attempted && segmentCreation.created
              ? `Created the audience segment "${segmentCreation.name}" (${segmentCreation.segmentId}) from a verified PQL expression (fields: ${pqlSynthesis.fieldsUsed.join(", ")}).`
              : `Verified PQL expression drafted, but the segment was not created: ${segmentCreation.attempted ? segmentCreation.reason : "creation not attempted"}. See pqlSynthesis/segmentCreation in metadata.`
            : `Drafted a candidate PQL expression (fields verified present: ${pqlSynthesis.fieldsUsed.join(", ")}) - see pqlSynthesis in metadata. Draft for a human to build from; segment creation is off (set AUDIENCE_CREATE_SEGMENT=true to enable).`
          : `No PQL expression drafted: ${pqlSynthesis.reason}.`
        : "",
      activation ? formatActivationMessage(activation) : "",
      attrState.note,
      cutoff.note,
    ]
      .filter(Boolean)
      .join(" ");

    const output: AudienceCreationOutput = {
      buildPath: path.buildPath,
      attributesAvailable,
      openAttributeRequest: {
        status: attrState.status,
        requestId: attrState.requestId,
        ageSeconds: attrState.ageSeconds,
      },
      identityGap: gap,
      statusMessage,
      ...(activation ? { activation } : {}),
    };

    /*
     * An open attribute request is needs_input, not completed.
     *
     * 2.7a leaves this process and comes back. Reporting `completed` while an
     * audience does not exist and cannot yet be built is exactly the
     * reported-success-while-failing pattern the whole review layer exists to
     * catch.
     */
    const status = attrState.status === "open" ? "needs_input" : "completed";

    return {
      status,
      output,
      message: status === "needs_input" ? attrState.note : statusMessage,
      // AgentResponse.usage.model when the LLM synthesized a PQL expression, so
      // Agent 3's LLM use shows in the run's model column / UI (token counts are
      // in the tool-call trace via the traced wrapper).
      ...(pqlSynthesis?.model ? { usage: { tokens: 0, model: pqlSynthesis.model } } : {}),
      metadata: {
        buildPathReason: path.reason,
        // What was reused from Review's earlier probe vs. re-read here - so
        // the saved MCP calls are visible in observability, not invisible.
        reusedFromReview: { schemaProbe: reusedProbe, segmentMatch: reusedSegment, pqlGuidance: reusedPql },
        schemasRead: probe.read,
        schemaProbeConclusive: probe.conclusive,
        schemasReadError: probe.error,
        schemaCount: probe.schemaCount,
        schemasInspected: probe.schemasInspected,
        fieldGroupsInspected: probe.fieldGroupsInspected,
        fieldCount: probe.fieldCount,
        // Which AEP sandbox answered. Assessing Comcast's attributes against a
        // sandbox that is not Comcast's is a meaningless check, and the reader
        // needs to be able to see that for themselves.
        sandbox: probe.sandbox,
        attributesNeeded: needed,
        attributesMissing: missing,
        schemaEvidence: probe.evidence,
        existingSegment: existing.id ? { id: existing.id, name: existing.name } : null,
        // B7's request-age metric, now real wall-clock seconds off the
        // durable attribute_requests row (null when nothing is open).
        requestAgeSeconds: attrState.ageSeconds,
        attributeRequestId: attrState.requestId,
        attributeRequestStatus: attrState.status,
        // Full PQL guidance (including the local reference's content - see
        // pql-context.ts) travels with the run, not just a pointer to a
        // file someone has to go find separately. Null when the FAC path
        // was taken - PQL doesn't apply there.
        pqlGuidance,
        // The synthesized PQL expression and its verification outcome (null on
        // the FAC path or when no LLM/conclusive probe was available). The
        // draft, the fields it was verified against, and - on rejection - the
        // fields that couldn't be verified, all travel with the run.
        pqlSynthesis,
        // Segment creation outcome: null when not attempted (FAC path, no
        // verified expression, or AUDIENCE_CREATE_SEGMENT off), else the
        // created id or an honest dry-run with the payload it would have sent.
        segmentCreation,
        segmentCreationEnabled: segmentCreationEnabled(),
        nightlyCutoff: cutoff,
        activationRequested: activationIntent.requested,
        activationDestination: activationIntent.destinationName,
      },
    };
  });

  return NextResponse.json<AgentResponse<AudienceCreationOutput>>({
    ...result,
    metadata: { ...result.metadata, toolCalls },
  });
}
