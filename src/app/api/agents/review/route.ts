import { NextRequest, NextResponse } from "next/server";
import type { AgentRequest, AgentResponse } from "@/lib/pipeline/types";
import { callMcpTool, withToolCallLog } from "@/lib/mcp-client";
import { triageRejection, type TriageResult } from "@/lib/agents/review/triage";
import { detectRejectionLlm, triageRejectionLlm, type Agent2Source } from "@/lib/agents/review/llm-triage";
import {
  resolveDataSource,
  applyDataSourceResolution,
  type DataSourceResolution,
} from "@/lib/agents/review/data-source";
import { probeSchemas, neededAttributes } from "@/lib/agents/audience/aep";
import { workfrontWritesDisabled } from "@/lib/agents/shared/workfront-writes";
import { type CommentLike } from "@/lib/agents/review/rejection";
import { gatherAepContext, formatAepContextNote } from "@/lib/agents/review/aep-context";
import { requiredFields } from "@/lib/agents/shared/campaign-brief";
import {
  updateReviewNotesField,
  type FieldUpdateOutcome,
} from "@/lib/agents/review/workfront-notes";

/**
 * Agent 2 - Review / Triage. B2, at step 1.5a.
 *
 * "The review queue rejects the issue and it goes back to the marketer as
 * rework. Nothing reads the rejection reason, and the loop resumes at 1.3 with
 * the marketer guessing. The largest unclaimed gap in the map. A review-triage
 * agent should parse the rejection, translate it into the specific missing field
 * or wrong data source, and redraft 1.3 automatically for the marketer to
 * confirm."
 *
 * TWO JOBS, AND THE SECOND IS THE ONE NOBODY DOES
 *
 * 1. When there is no rejection, this is a pre-flight: check the intake against
 *    the form before the review queue sees it, so an avoidable rejection never
 *    costs a queue cycle. A rejection prevented is worth more than one
 *    translated, because the queue's turnaround is the thing we cannot shorten.
 *
 * 2. When there IS a rejection, translate it: which field, what value, or which
 *    data source - and hand back a redraft the marketer confirms rather than
 *    composes. That is the gap.
 *
 * WHERE THE REJECTION COMES FROM
 *
 * Workfront carries it as a comment or an update on the issue, so this reads it
 * with the comment tools when it has an object id and a signed-in connector.
 * That call is expected to fail today - Workfront needs OAuth and nobody has
 * signed in - and a failure is REPORTED, not swallowed. Reporting it is the
 * whole point: an agent that treats "I could not read the rejection" as "there
 * was no rejection" reproduces the bug it was built to fix.
 *
 * WHICH text is the rejection is decided by lib/agents/review/rejection.ts's
 * detectRejection, not a keyword grep: it reads structured status/decision
 * fields when the connector attaches them, scores rejection prose far more
 * broadly than the old five stems (a "needs the LOB before we proceed" now
 * registers), and picks the most-recent authoritative record rather than the
 * last one by array order. See that module for why each of those mattered.
 *
 * DOCUMENTING THE HANDOFF TO AGENT 3 (lib/agents/review/aep-context.ts)
 *
 * Once a brief is clean enough to move on (the preflight path below, status
 * "completed"), Review asks AEP the same three questions Agent 3 would ask
 * next - are the needed attributes present, does an audience like this
 * already exist, which candidate datasets are profile-enabled - and:
 *
 *   1. folds the answer into `output` so the brief Agent 3 receives already
 *      has it, instead of Agent 3 discovering the same facts from scratch;
 *   2. best-effort writes it into a custom field on the issue (a human
 *      reading the record sees it there), so it survives on the record
 *      itself, not only in a comment thread.
 *
 * The COMMENT that used to be posted here is now posted CENTRALLY by the
 * orchestrator for every agent after each step (lib/pipeline/
 * workfront-updates.ts), from this step's `message` - which already appends
 * the same AEP note - so this route no longer posts its own to avoid a
 * duplicate. Both the central comment and the custom-field write follow
 * createIntakeRequest's contract in intake/workfront.ts exactly: writes are
 * disabled on this tenant today, so both report what they WOULD have done
 * rather than pretending success - see `workfrontDoc` (field write) on the
 * completed response and `metadata.workfrontUpdate` (comment) on the task_run.
 *
 * NOT DONE HERE: triage.ts's "wrong_data_source" (FAC vs. profile store)
 * classification itself still never consults AEP - it is PURE ON PURPOSE
 * (see triage.ts) and still always asks the marketer rather than answering
 * for them. The AEP context above is handed to Agent 3 and to a human
 * either way; teaching triage.ts to resolve that specific question from it
 * is a separate, bigger change to triage.ts's classification logic, not
 * this one. Whoever does that: a field counts as "in the profile store"
 * ONLY when it is literally present in adobe_get_schema's field list for a
 * profile-enabled schema - never inferred from the schema's title, the
 * field's plausible name, or the marketer's own wording (aep.ts's
 * SchemaProbe already enforces this; reuse it rather than re-deriving it -
 * an unanchored match once produced a false positive, "lob" inside "glob").
 */

type ReviewInput = {
  brief?: string;
  intakeFields?: Record<string, string>;
  fields?: Record<string, string>;
  /** A rejection passed in directly, e.g. on a rework loop. */
  rejectionReason?: string;
  /** The Workfront issue, when Agent 1 managed to create one. */
  workfront?: { created?: boolean; objId?: string; objCode?: string };
  loopCount?: number;
};

/**
 * Fetch the rejection from Workfront, if we can.
 *
 * @returns the reason, plus why we do or do not have one. The `error` is
 *   surfaced to the caller rather than collapsed into "no rejection" - those
 *   are different facts and conflating them is the failure mode this pipeline
 *   already has too much of.
 */
async function fetchRejection(objId: string | null) {
  if (!objId) {
    return { reason: null as string | null, source: "none", error: null as string | null };
  }
  try {
    const result = await callMcpTool<unknown>("review", "comment-stream_query_comments", {
      objID: objId,
      objCode: "OPTASK",
    });
    // Shapes differ between connectors, so read defensively and say when the
    // response was not something we recognise.
    const rows = (result as { comments?: unknown[]; data?: unknown[] } | null);
    const list = (rows?.comments || rows?.data || (Array.isArray(result) ? result : [])) as CommentLike[];

    // An LLM reads the stream when one is configured (a reviewer's freeform
    // "let's hold this until the LOB is sorted" is a rejection no keyword stem
    // catches), and ALWAYS falls back to the deterministic detectRejection -
    // which itself reads structured status/decision fields, scores prose far
    // more broadly than the old five stems, and picks the most-recent
    // authoritative record. See lib/agents/review/{llm-triage,rejection}.ts.
    const detected = await detectRejectionLlm(list);
    const signal = detected.signal;
    return {
      reason: signal.reason,
      source: "workfront_comments",
      detectedVia: signal.source,
      detectionEngine: detected.source as Agent2Source,
      detectionFallbackReason: detected.fallbackReason,
      considered: signal.considered,
      // "Read the stream, found no rejection" and "the stream returned
      // nothing recognisable" are different facts - keep them distinct, same
      // as before.
      error: list.length ? null : "the comment stream returned nothing we recognised as comments",
    };
  } catch (err) {
    return { reason: null as string | null, source: "workfront_comments", error: (err as Error).message };
  }
}

/** Pre-flight: what the review queue would reject this for. */
function preflight(fields: Record<string, string>): TriageResult {
  // Reuse the same translator, fed a synthetic reason built from what is
  // actually absent. One code path means the pre-flight and the post-rejection
  // paths cannot drift apart in what they consider a problem.
  const absent = requiredFields().filter((f) => !String(fields[f.key] || "").trim());
  if (!absent.length) {
    return { findings: [], redraft: { ...fields }, changed: [], needsHuman: false, summary: "Nothing the review queue should reject this for." };
  }
  const reason = absent.map((f) => `missing ${f.label}`).join("; ");
  return triageRejection(reason, fields);
}

/**
 * The route contract (README.md / types.ts) is "always return {status,
 * output?, message?, metadata?}" - never an HTTP error - so a failure is
 * something the orchestrator can record and a human can read, not an opaque
 * transport error. Everything this agent does lives in handlePost; this
 * just guarantees that contract holds even when handlePost throws something
 * unanticipated - without it, orchestrator.ts's callAgent can only record
 * "HTTP 500: " with no message, no output, no metadata anywhere.
 */
export async function POST(req: NextRequest) {
  try {
    return await handlePost(req);
  } catch (err) {
    return NextResponse.json<AgentResponse>({
      status: "failed",
      message: `Review crashed unexpectedly: ${(err as Error).message}`,
    });
  }
}

async function handlePost(req: NextRequest) {
  const body = (await req.json()) as AgentRequest<ReviewInput>;
  const input = body.input || {};
  const fields = input.intakeFields || input.fields || {};
  const loopCount = Number(input.loopCount) || 0;

  // Everything below calls MCP tools somewhere (fetchRejection,
  // gatherAepContext's three AEP reads, updateReviewNotesField) - wrapped so
  // every call, request and response, ends up in metadata.toolCalls for the
  // UI. (The update comment is posted by the orchestrator after this returns,
  // so it is traced separately under metadata.workfrontUpdate.)
  const { result, toolCalls } = await withToolCallLog(body.runId, "review", async (): Promise<AgentResponse> => {
    const objId = input.workfront?.created ? String(input.workfront.objId || "") : "";
    const fetched = await fetchRejection(objId || null);
    const reason = String(input.rejectionReason || fetched.reason || "").trim();

    // --- No rejection to read: act as the pre-flight -----------------------
    if (!reason) {
      const pre = preflight(fields);
      const clean = pre.findings.length === 0;

      if (!clean) {
        return {
          status: "needs_input",
          message: `Before this reaches the review queue: ${pre.findings.map((f) => f.ask).join(" ")}`,
          output: {
            ...input,
            reviewed: true,
            mode: "preflight",
            rejection: { present: false, checked: fetched.source, couldNotRead: fetched.error },
            triage: pre,
            intakeFields: pre.redraft,
            loopCount,
          },
          metadata: {
            mode: "preflight",
            findings: pre.findings.length,
            rejectionReadable: fetched.error === null,
            loopCount,
          },
        };
      }

      // Clean: this is the handoff to Agent 3. Ask AEP what it can already
      // answer about this audience (see the docstring above) and document it -
      // in the brief Agent 3 gets, and on the Workfront issue for a human.
      const aepContext = await gatherAepContext(fields, input.brief);
      const aepNote = formatAepContextNote(aepContext);

      // The AEP context is documented on the issue two ways. The COMMENT is
      // now posted centrally by the orchestrator for every agent (see
      // lib/pipeline/workfront-updates.ts), using this step's `message` -
      // which already carries the same AEP note appended below - so posting a
      // second comment here would only duplicate it. The custom-FIELD write
      // stays: it survives on the record itself, not in a comment thread that
      // scrolls away, and the central comment hook does not touch fields.
      // Kill switch: skip the Workfront custom-field write while writes are
      // disabled for testing (agents/shared/workfront-writes.ts).
      let workfrontDoc: { fieldUpdate: FieldUpdateOutcome } | null = null;
      if (objId && !workfrontWritesDisabled()) {
        const objCode = input.workfront?.objCode || "OPTASK";
        const fieldUpdate = await updateReviewNotesField(objId, objCode, aepNote);
        workfrontDoc = { fieldUpdate };
      }

      return {
        status: "completed",
        message: `${pre.summary} ${aepNote}`,
        output: {
          ...input,
          reviewed: true,
          mode: "preflight",
          rejection: { present: false, checked: fetched.source, couldNotRead: fetched.error },
          triage: pre,
          intakeFields: pre.redraft,
          aepContext,
          workfrontDoc,
          loopCount,
        },
        metadata: {
          mode: "preflight",
          findings: 0,
          rejectionReadable: fetched.error === null,
          loopCount,
          // Same field names Agent 3 reports for the identical read (see
          // audience-creation/route.ts) - one shared trace component
          // (tool-call-trace.tsx) renders this block for both agents, and it
          // is the single most consequential read in this whole pipeline:
          // if it comes back inconclusive, Agent 3 cannot confirm anything
          // and defaults to a build path blindly.
          schemasRead: aepContext.schemaProbe.read,
          schemaProbeConclusive: aepContext.schemaProbe.conclusive,
          schemasReadError: aepContext.schemaProbe.error,
          schemaCount: aepContext.schemaProbe.schemaCount,
          schemasInspected: aepContext.schemaProbe.schemasInspected,
          fieldGroupsInspected: aepContext.schemaProbe.fieldGroupsInspected,
          fieldCount: aepContext.schemaProbe.fieldCount,
          sandbox: aepContext.schemaProbe.sandbox,
          attributesNeeded: aepContext.neededAttributes,
          attributesMissing: aepContext.schemaProbe.conclusive
            ? aepContext.neededAttributes.filter((k) => !aepContext.schemaProbe.found[k])
            : [],
          schemaEvidence: aepContext.schemaProbe.evidence,
          existingSegment: aepContext.segmentMatch.id
            ? { id: aepContext.segmentMatch.id, name: aepContext.segmentMatch.name }
            : null,
          profileEnabledDatasets: aepContext.datasetProbe.profileEnabled,
          pqlGrounded: aepContext.pqlGuidance.grounded,
          pqlGuidance: aepContext.pqlGuidance.hits,
          // The update comment is posted centrally now (recorded under
          // metadata.workfrontUpdate by the orchestrator); this agent still
          // owns the custom-field write, so only that outcome is reported here.
          workfrontFieldUpdated: workfrontDoc?.fieldUpdate.updated ?? null,
        },
      };
    }

    // --- There is a rejection: translate it ---------------------------------
    // An LLM does the translation when configured (freeform reviewer prose ->
    // specific field + validated proposed value), always falling back to the
    // deterministic triageRejection. Every proposed value is validated against
    // real FieldSpec options inside triageRejectionLlm, so a hallucinated value
    // can never reach the redraft - see lib/agents/review/llm-triage.ts.
    const triaged = await triageRejectionLlm(reason, fields);
    const rawTriage = triaged.triage;
    const triageEngine = triaged.source;
    const triageFallbackReason = triaged.fallbackReason;
    // Populate AgentResponse.usage.model when the LLM did the translation, so
    // the run's model column / UI token line reflect Agent 2's LLM use (token
    // COUNTS are captured in the tool-call trace via the traced wrapper).
    const triageUsage = triaged.model ? { tokens: 0, model: triaged.model } : undefined;

    /*
     * Resolve the FAC-vs-profile-store question from AEP where the schema data
     * can answer it, instead of always handing it back as an open question
     * (see agents/review/data-source.ts). The translation above only
     * CLASSIFIES; the read that could ANSWER it lives here, in the route. The
     * extra read-only probe runs ONLY when triage actually raised a
     * wrong_data_source finding — the common rejection paths pay nothing.
     */
    let dataSourceResolution: DataSourceResolution | null = null;
    let triage = rawTriage;
    if (rawTriage.findings.some((f) => f.kind === "wrong_data_source")) {
      const needed = neededAttributes(fields, input.brief);
      const schemaProbe = await probeSchemas("review", needed);
      dataSourceResolution = resolveDataSource(fields, { schemaProbe, neededAttributes: needed });
      triage = applyDataSourceResolution(rawTriage, dataSourceResolution);
    }

    if (triage.needsHuman) {
      return {
        status: "needs_input",
        message: triage.findings[0].ask,
        ...(triageUsage ? { usage: triageUsage } : {}),
        output: {
          ...input,
          reviewed: true,
          mode: "triage",
          rejection: { present: true, reason, checked: fetched.source, couldNotRead: fetched.error },
          triage,
          intakeFields: triage.redraft,
          loopCount: loopCount + 1,
        },
        metadata: {
          mode: "triage",
          needsHuman: true,
          loopCount: loopCount + 1,
          rejectionDetectedVia: "detectedVia" in fetched ? fetched.detectedVia : input.rejectionReason ? "passed_in" : "none",
          rejectionsConsidered: "considered" in fetched ? fetched.considered : undefined,
          triageEngine,
          triageFallbackReason,
          detectionEngine: "detectionEngine" in fetched ? fetched.detectionEngine : undefined,
        },
      };
    }

    /*
     * A redraft goes back for confirmation, never straight through.
     *
     * The doc keeps 2.5 as a human step deliberately - "keep the human decision;
     * remove the surprise". Auto-resubmitting a redraft the marketer never saw
     * would remove the decision instead of the surprise, and the first time a
     * proposed value was wrong it would be wrong in Workfront.
     */
    return {
      status: "needs_input",
      message:
        `${triage.summary}. ` +
        triage.findings.map((f) => f.ask).join(" ") +
        " Confirm and it will be resubmitted.",
      ...(triageUsage ? { usage: triageUsage } : {}),
      output: {
        ...input,
        reviewed: true,
        mode: "triage",
        rejection: { present: true, reason, checked: fetched.source, couldNotRead: fetched.error },
        triage,
        intakeFields: triage.redraft,
        loopCount: loopCount + 1,
      },
      metadata: {
        mode: "triage",
        corrected: triage.changed,
        questions: triage.findings.filter((f) => !f.proposed).length,
        loopCount: loopCount + 1,
        rejectionDetectedVia: "detectedVia" in fetched ? fetched.detectedVia : input.rejectionReason ? "passed_in" : "none",
        rejectionsConsidered: "considered" in fetched ? fetched.considered : undefined,
        triageEngine,
        triageFallbackReason,
        detectionEngine: "detectionEngine" in fetched ? fetched.detectionEngine : undefined,
        // The AEP-grounded data-source decision (null when the rejection
        // raised no wrong_data_source finding, so no probe was run).
        dataSourceResolved: dataSourceResolution ? dataSourceResolution.resolved : null,
        dataSourceDecision:
          dataSourceResolution && dataSourceResolution.resolved ? dataSourceResolution.source : null,
        dataSourceRationale: dataSourceResolution ? dataSourceResolution.rationale : null,
      },
    };
  });

  return NextResponse.json<AgentResponse>({
    ...result,
    metadata: { ...result.metadata, toolCalls },
  });
}
