import { NextRequest, NextResponse } from "next/server";
import { callMcpTool, withToolCallLog } from "@/lib/mcp-client";
import type { AgentRequest, AgentResponse } from "@/lib/pipeline/types";
import type { ParsedIntake } from "@/lib/agents/intake/parse";
import { extractIntake } from "@/lib/agents/intake/llm-extract";
import { createIntakeRequest, demoIntakeOutcome, toWorkfrontPayload } from "@/lib/agents/intake/workfront";
import {
  FILTER_ANSWER_PREFIX,
  findUnmappableFilter,
  readFilterAnswers,
  type UnmappableFilter,
} from "@/lib/agents/intake/buildability";

/**
 * Agent 1 - Intake. B1, at step 1.2a.
 *
 * ORIGINAL DESIGN, PRESERVED: "The agent cannot build the intake from the
 * prompt, so it bounces back to the marketer... Track loop count as a
 * health metric - more than two rounds means the agent failed, not the
 * marketer." That loop-count discipline (LOOP_LIMIT below), the never-
 * invent-a-value rule, and grounding every question in what AEP actually
 * holds are all unchanged.
 *
 * WHAT CHANGED, ON EXPLICIT PRODUCT DIRECTION FOR THE EXECUTIVE DEMO: the
 * only required input is the brief. Campaign name, business objective,
 * customer type, line of business, request type, and launch date are all
 * optional now (campaign-brief.ts) - this agent infers what it can from the
 * brief and proceeds when one is absent, rather than asking. It does NOT
 * fall back to asking about the askForAudience tier either (lifecycle
 * journey, refresh cadence, etc.) - those stay informational (see
 * `summarise`'s missing/missingAudience) but never block a run.
 *
 * THE ONE THING THAT STILL PAUSES THIS AGENT: a filter the brief names that
 * has no matching field in customer data at all - e.g. "SEP-eligible" when
 * nothing in AEP looks like a SEP-eligibility flag. That is answered by
 * buildability.ts's findUnmappableFilter, which reuses the same schema
 * probe Review/Audience Creation already run. It asks ONE specific
 * question about that ONE filter - never a batch, never a vague "please
 * complete the brief." Never silently drops the condition and builds a
 * broader audience instead.
 *
 * WHAT IT STILL WILL NOT DO: invent a value. A campaign name the brief
 * doesn't state stays absent here (see parse.ts) - the UI defaults its
 * DISPLAY to "Untitled audience · <date>", never this agent.
 *
 * DEMO VS. GOVERNED MODE (`input.mode`, defaulting to "governed" when
 * absent - so every existing caller that doesn't know about modes yet keeps
 * today's behavior unchanged): Demo mode never files a Workfront intake
 * request (demoIntakeOutcome - a pure, zero-call dry run) and probes AEP
 * against the "tapdemo" sandbox explicitly. Governed mode is untouched -
 * the real Workfront create (createIntakeRequest), subject to the same
 * WORKFRONT_WRITES_DISABLED kill switch as always.
 */

/**
 * Past this, escalate rather than ask again. The requirements doc's own
 * number here was 2 ("more than two rounds means the agent failed, not the
 * marketer") — raised to 15 on explicit product direction, trading that
 * strict verdict for more room per run. If runs are still escalating for
 * "still missing X" at this limit, check the caller is actually submitting
 * non-empty answers before treating this number as the problem again.
 */
const LOOP_LIMIT = 15;

function readLoopCount(body: AgentRequest<{ loopCount?: number }>): number {
  const n = Number(body.input?.loopCount);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** "demo" only when the caller explicitly asks for it; every other value (including absent) is Governed - today's unchanged default. */
function readMode(body: AgentRequest<{ mode?: string }>): "demo" | "governed" {
  return body.input?.mode === "demo" ? "demo" : "governed";
}

/**
 * Ground the question in what the platform can actually segment on.
 *
 * "Questions must be grounded in AEP schemas and the FAC view." This attaches
 * that context and reports honestly when it could not be fetched - a
 * question labelled grounded when the lookup failed is worse than an openly
 * ungrounded one.
 */
async function groundQuestion(label: string | null) {
  if (!label) {
    return { grounded: false, reason: "nothing unmapped to ground", hits: null as unknown };
  }
  try {
    // search_adobe_knowledge takes only { query, topic? } (see chaunceyplum/mcp
    // mcp_server/lambda_handler.py) — "agent" is hardcoded to "adobe" inside the
    // tool itself, not a caller param, and there is no top_k on this tool at all.
    const hits = await callMcpTool("intake", "search_adobe_knowledge", {
      query: `Adobe Experience Platform profile attributes and schema fields for ${label}`,
      topic: "aep",
    });
    return { grounded: true, reason: null, hits };
  } catch (err) {
    return { grounded: false, reason: (err as Error).message, hits: null as unknown };
  }
}

/** What a reviewer needs, without the raw hit payload drowning it. */
function summarise(parsed: ParsedIntake) {
  return {
    fields: parsed.fields,
    stated: parsed.extracted.filter((f) => f.from === "stated").map((f) => f.key),
    inferred: parsed.inferred.map((f) => ({
      key: f.key,
      value: f.value,
      from: f.from,
      evidence: f.evidence ?? null,
    })),
    // Neither of these blocks a run any more (see this file's docstring) -
    // purely informational, so a reader can see what the brief left
    // unstated without mistaking it for why the run paused.
    missing: parsed.missing.map((f) => f.key),
    missingAudience: parsed.missingAudience.map((f) => f.key),
  };
}

/**
 * The route contract (README.md / types.ts) is "always return {status,
 * output?, message?, metadata?}" - never an HTTP error - so the orchestrator
 * can record a real, readable failure instead of an opaque transport error.
 * Everything this agent does lives in handlePost; this just guarantees that
 * contract holds even when handlePost throws something nobody anticipated
 * (a bad MCP response shape, a null-deref) - without this, an uncaught
 * exception here becomes Next's default empty-body 500, which
 * orchestrator.ts's callAgent can only record as "HTTP 500: " with no
 * message, no output, no metadata anywhere - the exact "black box" this
 * whole harness exists to avoid.
 */
export async function POST(req: NextRequest) {
  try {
    return await handlePost(req);
  } catch (err) {
    return NextResponse.json<AgentResponse>({
      status: "failed",
      message: `Intake crashed unexpectedly: ${(err as Error).message}`,
    });
  }
}

async function handlePost(req: NextRequest) {
  const body = (await req.json()) as AgentRequest<{
    brief?: string;
    loopCount?: number;
    fields?: Record<string, unknown>;
    mode?: string;
    draftOnly?: boolean;
  }>;

  const brief = String(body.input?.brief || "").trim();
  const loopCount = readLoopCount(body);
  const mode = readMode(body);

  if (!brief) {
    return NextResponse.json<AgentResponse>({
      status: "failed",
      message: "No brief was supplied, so there is nothing to read.",
      metadata: { loopCount, mode },
    });
  }

  // Everything below calls MCP tools somewhere in its call graph
  // (groundQuestion, findUnmappableFilter, createIntakeRequest ->
  // resolveIntakeQueue/resolveFieldMap/writeCustomFields) - wrapped so every
  // one of those calls, request and response, ends up in metadata.toolCalls
  // for the UI, without any of those functions needing to know they're
  // being watched. Demo mode's own path (demoIntakeOutcome) makes none of
  // these calls at all - see this file's docstring.
  const { result, toolCalls } = await withToolCallLog(body.runId, "intake", async (): Promise<AgentResponse> => {
    // A rework loop carries the fields already confirmed, so the marketer is
    // never asked twice for the same thing.
    //
    // extractIntake prefers a configured LLM to read the brief (Bedrock /
    // Anthropic / Ollama - see lib/llm) and ALWAYS falls back to the pure
    // deterministic parseBrief when no LLM is configured or the call fails.
    // Either way it returns the same ParsedIntake shape. `extraction.source`
    // records which path actually ran.
    const extraction = await extractIntake(brief, body.input?.fields || {});
    const parsed = extraction.parsed;

    // Demo mode probes the "tapdemo" sandbox explicitly; Governed mode
    // leaves the sandbox unset, same as every other AEP call in this app
    // today. See buildability.ts / aep.ts's probeSchemas.
    const sandbox = mode === "demo" ? "tapdemo" : undefined;
    // Filters the marketer already answered ("drop it", or a field to use)
    // are settled: not asked again, and handed on as `filterAnswers` for
    // Agent 3 to apply. The brief still names them every round, so without
    // this the same question came back until the loop limit.
    const filterAnswers = readFilterAnswers(body.input?.fields);
    const unmappable: UnmappableFilter | null = await findUnmappableFilter(
      parsed.fields, brief, "intake", sandbox, Object.keys(filterAnswers),
    );
    const grounding = await groundQuestion(unmappable?.label ?? null);

    // Which extraction path actually ran (llm vs deterministic), the model,
    // and why we fell back if we did - folded into every response's metadata
    // so the choice is visible in the trace, never silent.
    const extractionMeta = {
      extractionSource: extraction.source,
      extractionModel: extraction.model,
      extractionFallbackReason: extraction.fallbackReason,
      extractionAttempts: extraction.attempts,
      extractionRevised: extraction.revised,
    };
    // Only real when the LLM answered; the AgentResponse.usage field stays
    // absent otherwise (see types.ts - never a fabricated 0).
    const usage =
      extraction.source === "llm" && extraction.model
        ? { tokens: extraction.usage?.outputTokens ?? 0, model: extraction.model }
        : undefined;

    // B1's verdict, owned by the agent instead of looped onto the marketer.
    if (loopCount >= LOOP_LIMIT && unmappable) {
      return {
        status: "failed",
        message:
          `Still can't confirm ${unmappable.label} maps to a real field in customer data after ${loopCount} rounds. ` +
          `Past ${LOOP_LIMIT} rounds this is the agent failing to resolve it, not the marketer failing to answer, ` +
          "so it escalates rather than asking again.",
        output: {
          brief,
          ...summarise(parsed),
          loopCount,
          mode,
          filterAnswers,
          grounding: { grounded: grounding.grounded, reason: grounding.reason },
        },
        metadata: { loopCount, loopLimitReached: true, mode, ...extractionMeta },
      };
    }

    // A filter in the brief genuinely doesn't map to anything in customer
    // data. Ask about exactly that one, and nothing else - never silently
    // drop the condition and build a broader audience.
    if (unmappable) {
      return {
        status: "needs_input",
        message: unmappable.ask,
        output: {
          brief,
          ...summarise(parsed),
          // Earlier filter answers ride along in `fields` (the resume route
          // merges this round's answer into it), so a second unmappable
          // filter never costs the first one's answer.
          fields: {
            ...parsed.fields,
            ...Object.fromEntries(Object.entries(filterAnswers).map(([k, v]) => [`${FILTER_ANSWER_PREFIX}${k}`, v])),
          },
          // The next round arrives with this incremented and the fields so
          // far, so the marketer answers one specific question, not the
          // whole form.
          loopCount: loopCount + 1,
          mode,
          ...(body.input?.draftOnly === true ? { draftOnly: true } : {}),
          questions: [{ key: unmappable.key, label: unmappable.label, ask: unmappable.ask, options: null, optionsPartial: false }],
          grounding,
        },
        metadata: { loopCount: loopCount + 1, askedFor: [unmappable.key], mode, ...extractionMeta },
      };
    }

    /*
     * Complete enough to build.
     *
     * Governed mode: create the Workfront request. createIntakeRequest
     * reports what it WOULD have created when the call fails, which is the
     * honest outcome while nobody has signed in to the official MCP:
     * Workfront writes need OAuth, and 44 of its 94 tools are writes a
     * Workfront admin must enable per tenant. A visible dry run beats a run
     * that reads as a success and wrote nothing.
     *
     * Demo mode: never files a Workfront request at all - demoIntakeOutcome
     * is a pure, zero-call function returning the identical CreateOutcome
     * shape, so every downstream reader (the UI, Review, this route's own
     * message below) handles both modes through one code path.
     */
    const outcome = mode === "demo"
      ? demoIntakeOutcome(parsed.fields, brief)
      : await createIntakeRequest({ runId: body.runId, intake: parsed.fields, brief });
    const stated = parsed.extracted.filter((f) => f.from === "stated").length;
    const message =
      `Extracted ${stated} stated and ${parsed.inferred.length} inferred field(s) from the brief. ` +
      (mode === "demo"
        ? "Demo mode — building the audience definition only; no Workfront request filed."
        : outcome.created
          ? outcome.reused
            ? `Reusing the Workfront intake request already created for this run (${outcome.objCode} ${outcome.objId}) - not creating a second one.`
            : `Created the Workfront intake request (${outcome.objCode} ${outcome.objId}).`
          : `Dry run — did not create the Workfront request: ${outcome.reason}`);

    return {
      status: "completed",
      message,
      ...(usage ? { usage } : {}),
      output: {
        brief,
        ...summarise(parsed),
        loopCount,
        mode,
        // Draft-only runs: Agent 3 writes the rule but creates no segment.
        ...(body.input?.draftOnly === true ? { draftOnly: true } : {}),
        // Carried through Review's `...input` spread to Agent 3, which drops
        // or remaps these conditions when it writes the rule.
        filterAnswers,
        // Marketer-facing label for the audience card - null in Governed
        // mode, where the existing Awaiting approval / Approved language
        // already applies.
        label: mode === "demo" ? "Demo – not approved" : null,
        workfront: outcome,
        grounding,
        // Named plainly so Agent 2 reads them rather than re-deriving them.
        intakeFields: parsed.fields,
        workfrontPayload: toWorkfrontPayload(parsed.fields, brief),
      },
      metadata: {
        loopCount,
        mode,
        ...extractionMeta,
        inferredCount: parsed.inferred.length,
        // A run where the agent guessed four fields is not the same as one where
        // the marketer stated them. The human at 2.5 has to know which they are
        // looking at, and that is the only reason 2.5 stays a human step.
        needsConfirmation: parsed.inferred.length > 0,
        workfrontCreated: outcome.created,
        // True only when this run's Workfront issue was found already
        // created (a retry after the original create succeeded but its own
        // result never got recorded) rather than written fresh this time -
        // see workfront.ts's findPriorSuccess. Always false in Demo mode,
        // which never creates anything to find.
        workfrontReused: outcome.created ? !!outcome.reused : false,
      },
    };
  });

  return NextResponse.json<AgentResponse>({
    ...result,
    metadata: { ...result.metadata, toolCalls },
  });
}
