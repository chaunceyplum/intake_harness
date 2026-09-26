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
  estimateSegmentSize,
  findSegmentWithRule,
  profileCatalog,
  type SegmentSizeEstimate,
} from "@/lib/agents/audience/aep";
import { resolveActivationIntent, activateAudience, type ActivationOutcome } from "@/lib/agents/audience/activation";
import { groundPqlGuidance, type PqlGuidance } from "@/lib/agents/review/pql-context";
import {
  synthesizePql,
  createSegmentFromPql,
  segmentCreationEnabled,
  isMissingWriteTool,
  type PqlSynthesis,
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
 * MOSTLY READ-ONLY, with activation as the deliberate exception. The
 * build/probe side is still all reads: it will report that it cannot
 * predict a count rather than create a segment definition to produce one
 * (lib/agents/audience/aep.ts). Activation, however, does now WRITE when a
 * destination is explicitly named (lib/agents/audience/activation.ts): it
 * adds the audience to an existing destination dataflow in place via
 * destination_update_dataflow_audiences (add-only, so nothing else already
 * activated there is disturbed), or creates a first dataflow when the
 * destination has none. It still only ever ADDS its own segment and never
 * removes another, and it still declines rather than guess when it cannot
 * ground the destination - an activation obtained by silently clobbering a
 * client's other wiring is not worth having.
 *
 * ACTIVATION IS OFF BY DEFAULT. Nothing below changes unless intake's own
 * `destination` field (or, for older runs, the brief's free text) names a
 * real destination - see activation.ts's resolveActivationIntent - build
 * path and attribute checks behave exactly as they always have otherwise.
 *
 * DEMO VS. GOVERNED MODE (`input.mode`, carried forward from Intake via
 * Review's `...input` spread - defaulting to "governed" when absent, so
 * every existing caller keeps today's behavior unchanged): Demo mode probes
 * AEP, searches for an existing segment, and creates a segment (when
 * enabled) against the "tapdemo" sandbox explicitly, NEVER reuses Review's
 * prior probe/segment-match (Review wasn't told about Demo mode, so its
 * reads are against whatever sandbox it defaulted to - not safe to reuse
 * here), and activation is skipped entirely regardless of what the brief
 * asks for - no destination writes, no spend. Governed mode is unchanged.
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
  /** Threaded from Intake via Review's `...input` spread. "governed" when absent (every existing caller). */
  mode: "demo" | "governed";
  /** Marketer-facing label for the audience card - null in Governed mode. */
  label: string | null;
  /**
   * B3's predicted count, or an honest "not available" - never an error,
   * never a fabricated zero. See aep.ts's estimateSegmentSize.
   */
  sizeEstimate: SegmentSizeEstimate;
  /**
   * The audience that now exists in AEP for this request - created this run,
   * or an existing segment with the IDENTICAL rule - with the rule and what
   * it means in plain English. Null when none exists (no rule could be
   * written, creation is off, or AEP refused it).
   */
  audience: {
    segmentId: string;
    name: string;
    source: "created" | "existing_same_rule";
    pql: string;
    interpretation: string | null;
    sandbox: string | null;
  } | null;
}

/** "Demo: SEP-eligible profiles with email · 4f2a91c0" - readable in AEP, unique per run so a re-run never collides on name. */
function audienceName(synthesis: PqlSynthesis, fields: Record<string, string>, runId: string, mode: "demo" | "governed"): string {
  const base =
    synthesis.suggestedName ||
    [fields.campaign_name, fields.audience_description].filter(Boolean).map(String).join(" — ") ||
    "Audience";
  return `${mode === "demo" ? "Demo: " : ""}${base.slice(0, 80)} · ${String(runId || "").slice(0, 8)}`;
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
    case "no_segment_to_activate":
      return `Cannot activate yet: ${activation.reason}`;
    case "created":
      return `Created a new dataflow to "${activation.destinationName}" (${activation.dataflowId}) and activated this audience to it.`;
    case "create_failed":
      return `Could not create a dataflow to "${activation.destinationName}": ${activation.reason}`;
    case "activated_existing":
      return `Activated this audience to the existing dataflow for "${activation.destinationName}" (${activation.dataflowId}).`;
    case "activate_existing_failed":
      return `Could not add this audience to the existing dataflow for "${activation.destinationName}" (${activation.dataflowId}): ${activation.reason}`;
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

  // "demo" only when explicitly carried forward (from Intake, via Review's
  // `...input` spread) - every other value, including absent, is "governed",
  // today's unchanged default. See this file's docstring.
  const mode: "demo" | "governed" = input.mode === "demo" ? "demo" : "governed";
  const sandbox = mode === "demo" ? "tapdemo" : undefined;

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
    const criteria = [brief, fields.audience_description].filter(Boolean).join(" ") || fields.campaign_name || "";

    // Reuse Review's probe only when it is conclusive AND covers exactly the
    // attributes this audience needs (Review derives `needed` from the same
    // neededAttributes(), so the sets normally match - but if they diverge,
    // re-probe rather than answer from a probe that checked different fields).
    // NEVER reused in Demo mode: Review wasn't told about Demo mode, so its
    // probe ran against whatever sandbox it defaulted to, not "tapdemo" -
    // reusing it here would silently answer for the wrong sandbox.
    const priorProbe = priorReview?.schemaProbe;
    const priorCoversNeeded =
      mode !== "demo" &&
      !!priorProbe &&
      priorProbe.conclusive &&
      needed.every((k) => k in (priorProbe.found ?? {}));
    const reusedProbe = priorCoversNeeded;
    const probe: SchemaProbe = priorCoversNeeded ? priorProbe! : await probeSchemas("audience_creation", needed, sandbox, criteria);

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

    // Write the rule. The model reads the sandbox's WHOLE field catalog -
    // path, title, description, allowed values - because a plain-English
    // request names fields the way people do ("customers who have CBM" ->
    // `_taplondonptrsd.isCBMmember`, titled "Is CBM member"), not by path.
    // Every field it uses is still verified against that catalog before the
    // rule is trusted (pql-synth.ts). The probe's name matches ride along
    // as hints. No catalog (unreadable) -> the probe's evidence, as before.
    const catalog =
      path.buildPath === "aep_rule_builder" && pqlGuidance && probe.conclusive
        ? await profileCatalog("audience_creation", sandbox)
        : [];
    let pqlSynthesis: PqlSynthesis | null =
      path.buildPath === "aep_rule_builder" && pqlGuidance
        ? await synthesizePql(criteria, probe, pqlGuidance, undefined, { catalog })
        : null;

    // "Already exists" means an existing segment with the IDENTICAL rule -
    // never one whose name merely shares a word (see findSegmentWithRule).
    const sameRule =
      pqlSynthesis?.synthesized && pqlSynthesis.pql
        ? await findSegmentWithRule("audience_creation", pqlSynthesis.pql, sandbox)
        : null;

    // Create it. Demo mode always does (that is what Demo is for, in the
    // tapdemo sandbox); Governed mode only with AUDIENCE_CREATE_SEGMENT=true.
    // If AEP rejects the rule itself, the model gets AEP's own error and one
    // chance to correct the rule - a wrong operator or array syntax is the
    // usual cause, and AEP's message names it.
    const creationOn = segmentCreationEnabled(mode);
    let segmentCreation: SegmentCreation | null = null;
    let repairedAfterRejection = false;
    if (pqlSynthesis?.synthesized && !sameRule && creationOn) {
      segmentCreation = await createSegmentFromPql(
        body.runId, "audience_creation", pqlSynthesis, audienceName(pqlSynthesis, fields, body.runId, mode), sandbox,
      );
      if (segmentCreation.attempted && !segmentCreation.created && !isMissingWriteTool(segmentCreation.reason) && pqlGuidance) {
        const retry = await synthesizePql(criteria, probe, pqlGuidance, undefined, {
          catalog,
          feedback: `${segmentCreation.reason} (rejected rule: ${pqlSynthesis.pql})`,
        });
        if (retry.synthesized && retry.pql && retry.pql !== pqlSynthesis.pql) {
          repairedAfterRejection = true;
          pqlSynthesis = retry;
          segmentCreation = await createSegmentFromPql(
            body.runId, "audience_creation", retry, audienceName(retry, fields, body.runId, mode), sandbox,
          );
        }
      }
    }

    const created = segmentCreation?.attempted && segmentCreation.created ? segmentCreation : null;
    const audience: AudienceCreationOutput["audience"] =
      created && pqlSynthesis
        ? {
            segmentId: created.segmentId, name: created.name, source: "created", pql: created.pql,
            interpretation: pqlSynthesis.interpretation ?? null, sandbox: sandbox ?? probe.sandbox,
          }
        : sameRule && pqlSynthesis?.pql
          ? {
              segmentId: sameRule.id, name: sameRule.name, source: "existing_same_rule", pql: pqlSynthesis.pql,
              interpretation: pqlSynthesis.interpretation ?? null, sandbox: sandbox ?? probe.sandbox,
            }
          : null;

    // A similarly NAMED audience, shown for context only - never reused,
    // never activated, never sized in place of this request's own audience.
    //
    // (Terms: intake's categorization fields plus keywords from the brief -
    // see criteriaKeywords.)
    const terms = [
      fields.campaign_name, fields.lifecycle_journey, fields.line_of_business, fields.customer_type,
      ...criteriaKeywords([brief, fields.audience_description].filter(Boolean).join(" ")),
    ]
      .filter(Boolean)
      .map(String);
    // Reuse Review's name search when it read successfully (identical terms,
    // see aep-context.ts). Never in Demo mode: Review's search may not have
    // been scoped to "tapdemo".
    const priorSegment: SegmentMatch | undefined = priorReview?.segmentMatch;
    const reusedSegment = mode !== "demo" && !!priorSegment?.read;
    const existing = reusedSegment ? priorSegment! : await findExistingSegment("audience_creation", terms, sandbox);
    const similar = existing.id && existing.id !== audience?.segmentId ? existing : null;

    // Off by default - see this file's docstring and activation.ts. Only
    // runs the destination check/write when intake's own `destination`
    // field (or, for older runs, the brief's free text) names a real one -
    // and only when that field was actually STATED, not guessed. An
    // inferred destination is treated as absent here, which falls back to
    // detectActivationIntent's stricter explicit-verb brief parsing rather
    // than trusting a value nobody confirmed as an activation command.
    //
    // NEVER runs in Demo mode, regardless of what the brief asks for - "no
    // activation to destinations, no spend" is the whole point of Demo mode
    // (see this file's docstring). activationIntent is still resolved (for
    // the statusMessage note below), just never acted on.
    const destinationField = inferredFieldKeys.has("destination") ? undefined : fields.destination;
    const activationIntent = resolveActivationIntent(brief, destinationField);
    const activation =
      mode !== "demo" && activationIntent.requested
        ? await activateAudience("audience_creation", {
            // Only this request's own audience is ever activated - never a
            // similarly named one (see `similar` above).
            segmentId: audience?.segmentId ?? null,
            segmentName: audience?.name ?? null,
            destinationName: activationIntent.destinationName,
          })
        : undefined;

    // Only a CONCLUSIVE "no" opens an attribute request. "undetermined" must not:
    // opening the 2.7a branch because we failed to look is the quarter-long tail
    // started by our own blind spot.
    const attrState = await attributeRequestState(body.runId, attributesAvailable !== false, missing);

    // B3: the audience's real size, from an evaluation job on this request's
    // own segment (created, or the identical-rule match). A job usually takes
    // a few minutes, so this often comes back `pending` with the job id and
    // the audience card polls /api/audience-size until the count lands.
    const sizeEstimate: SegmentSizeEstimate = audience
      ? await estimateSegmentSize("audience_creation", audience.segmentId, sandbox)
      : { available: false, reason: "no audience was created, so there is nothing to count yet" };

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
      audience
        ? audience.source === "created"
          ? `Created the audience "${audience.name}" (${audience.segmentId}) in AEP${audience.sandbox ? ` sandbox "${audience.sandbox}"` : ""}` +
            `${repairedAfterRejection ? " (the first rule was rejected by AEP and corrected)" : ""}. ` +
            `${audience.interpretation ? `${audience.interpretation} ` : ""}Rule: ${audience.pql}`
          : `An audience with this exact rule already exists: "${audience.name}" (${audience.segmentId}) - using it rather than creating a duplicate. Rule: ${audience.pql}`
        : pqlSynthesis?.synthesized
          ? segmentCreation?.attempted
            ? `Wrote the rule ${pqlSynthesis.pql}, but AEP did not create the audience: ${segmentCreation.created ? "" : segmentCreation.reason}`
            : `Wrote the rule ${pqlSynthesis.pql} (fields verified present: ${pqlSynthesis.fieldsUsed.join(", ")}). Not created - ` +
              "audience creation is off in Governed mode (set AUDIENCE_CREATE_SEGMENT=true, or use Demo mode)."
          : pqlSynthesis
            ? `Could not write a rule for this audience: ${pqlSynthesis.reason}.`
            : "",
      similar
        ? `A similarly named audience exists - "${similar.name}" (${similar.id}) - but its rule differs, so it was not reused.`
        : !existing.read
          ? `Could not list existing audiences: ${existing.error}.`
          : "",
      gap.hasGap ? "Identity gap flagged: see identityGap." : "",
      activation
        ? formatActivationMessage(activation)
        : mode === "demo" && activationIntent.requested
          ? `Demo mode: activation to "${activationIntent.destinationName ?? "the requested destination"}" was skipped - no activation to destinations, no spend.`
          : "",
      audience
        ? sizeEstimate.available
          ? `Audience size: ${sizeEstimate.count.toLocaleString()} profiles.`
          : `Size: ${sizeEstimate.reason}.`
        : "",
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
      mode,
      label: mode === "demo" ? "Demo – not approved" : null,
      sizeEstimate,
      audience,
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
        // A similarly NAMED segment, context only - never reused (see `similar`).
        similarSegment: similar ? { id: similar.id, name: similar.name } : null,
        sameRuleSegment: sameRule,
        catalogFieldCount: catalog.length,
        repairedAfterRejection,
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
        segmentCreationEnabled: creationOn,
        nightlyCutoff: cutoff,
        activationRequested: activationIntent.requested,
        activationDestination: activationIntent.destinationName,
        // True only when Demo mode actually suppressed an activation the
        // brief asked for - distinct from "activation wasn't requested at
        // all" (activationRequested: false above).
        activationSkippedForDemo: mode === "demo" && activationIntent.requested,
        mode,
        sandboxOverride: sandbox ?? null,
        sizeEstimate,
      },
    };
  });

  return NextResponse.json<AgentResponse<AudienceCreationOutput>>({
    ...result,
    metadata: { ...result.metadata, toolCalls },
  });
}
