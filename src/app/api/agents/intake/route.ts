import { NextRequest, NextResponse } from "next/server";
import { callMcpTool, withToolCallLog } from "@/lib/mcp-client";
import type { AgentRequest, AgentResponse } from "@/lib/pipeline/types";
import { nextQuestions, type ParsedIntake } from "@/lib/agents/intake/parse";
import { extractIntake } from "@/lib/agents/intake/llm-extract";
import { createIntakeRequest, toWorkfrontPayload } from "@/lib/agents/intake/workfront";

/**
 * Agent 1 - Intake. B1, at step 1.2a.
 *
 * "The agent cannot build the intake from the prompt, so it bounces back to the
 * marketer. The loop can run many times, and each round trip is unbounded...
 * Questions must be grounded in AEP schemas and the FAC view, so the agent asks
 * for the two things actually missing rather than re-asking the whole brief.
 * Track loop count as a health metric - more than two rounds means the agent
 * failed, not the marketer."
 *
 * Three things follow from that, and they are the whole design:
 *
 * 1. ASK FOR TWO THINGS. parse.ts computes which required fields the brief does
 *    not answer; nextQuestions takes the first two. Asking for eleven is what
 *    makes a loop unbounded, so the cap is the feature, not a limitation.
 *
 * 2. COUNT THE LOOPS, AND OWN THE FAILURE. loopCount arrives on the request and
 *    leaves in metadata. Past two rounds this agent reports its OWN failure
 *    rather than asking again: the doc is explicit that at that point the agent
 *    has failed, and an agent that blames the marketer indefinitely is the bug
 *    being fixed.
 *
 * 3. GROUND THE QUESTIONS in what AEP actually holds, and say so when the
 *    lookup failed rather than presenting an ungrounded question as grounded.
 *
 * WHAT IT WILL NOT DO: invent a value. A field the brief does not state is
 * either inferred AND FLAGGED as inferred, or asked about. Filling the form in
 * to make a run go green is precisely the failure this system exists to catch.
 *
 * A SECOND ROUND OF QUESTIONS, ONCE THE FIRST IS ANSWERED: once every
 * `required` field is in hand, nextQuestions doesn't stop there any more -
 * it moves on to campaign-brief.ts's `askForAudience` fields (audience build
 * method, size, refresh cadence, exclusions, data availability/location,
 * predictive model, activation pattern, product mix, and more - see that
 * file's FieldSpec docstring). Same 2-per-round pacing, same LOOP_LIMIT,
 * just a longer list to work through before `completed`. Explicit product
 * direction, from a real LCE Workfront form's "Audience Specifications &
 * Model Integration" section: this app is meant to eventually write a
 * Workfront custom form storing these answers, which means Agent 1 has to
 * actually collect them, not just extract them opportunistically and leave
 * the rest blank.
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

/**
 * Ground the questions in what the platform can actually segment on.
 *
 * "Questions must be grounded in AEP schemas and the FAC view." A question like
 * "which line of business?" is answerable in the abstract; the useful version
 * knows what fields exist. This attaches that context and reports honestly when
 * it could not be fetched - a question labelled grounded when the lookup failed
 * is worse than an openly ungrounded one.
 */
async function groundQuestions(missingLabels: string[]) {
  if (!missingLabels.length) {
    return { grounded: false, reason: "nothing missing to ground", hits: null as unknown };
  }
  try {
    // search_adobe_knowledge takes only { query, topic? } (see chaunceyplum/mcp
    // mcp_server/lambda_handler.py) — "agent" is hardcoded to "adobe" inside the
    // tool itself, not a caller param, and there is no top_k on this tool at all.
    // Passing either produced "<lambda>() got an unexpected keyword argument
    // 'agent'" on every call, so grounding silently failed on every run.
    const hits = await callMcpTool("intake", "search_adobe_knowledge", {
      query: `Adobe Experience Platform profile attributes and schema fields for ${missingLabels.join(", ")}`,
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
    missing: parsed.missing.map((f) => f.key),
    // Audience-completeness gaps, not buildability ones - see this file's
    // docstring and parse.ts's nextQuestions. Surfaced separately so a
    // reader can tell "this run is stuck" from "this run just hasn't been
    // asked about refresh cadence yet".
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
  }>;

  const brief = String(body.input?.brief || "").trim();
  const loopCount = readLoopCount(body);

  if (!brief) {
    return NextResponse.json<AgentResponse>({
      status: "failed",
      message: "No brief was supplied, so there is nothing to read.",
      metadata: { loopCount },
    });
  }

  // Everything below calls MCP tools somewhere in its call graph
  // (groundQuestions, createIntakeRequest -> resolveIntakeQueue/
  // resolveFieldMap/writeCustomFields) - wrapped so every one of those
  // calls, request and response, ends up in metadata.toolCalls for the UI,
  // without any of those functions needing to know they're being watched.
  const { result, toolCalls } = await withToolCallLog(body.runId, "intake", async (): Promise<AgentResponse> => {
    // A rework loop carries the fields already confirmed, so the marketer is
    // never asked twice for the same thing.
    //
    // extractIntake prefers a configured LLM to read the brief (Bedrock /
    // Anthropic / Ollama - see lib/llm) and ALWAYS falls back to the pure
    // deterministic parseBrief when no LLM is configured or the call fails.
    // Either way it returns the same ParsedIntake shape, run through
    // parseBrief's own validation, so every downstream invariant (provenance,
    // missing/required, the loop cap) is unchanged. `extraction.source` records
    // which path actually ran.
    const extraction = await extractIntake(brief, body.input?.fields || {});
    const parsed = extraction.parsed;
    const questions = nextQuestions(parsed, 2);
    const grounding = await groundQuestions(questions.map((q) => q.label));

    // Which extraction path actually ran (llm vs deterministic), the model,
    // and why we fell back if we did - folded into every response's metadata
    // so the choice is visible in the trace, never silent.
    const extractionMeta = {
      extractionSource: extraction.source,
      extractionModel: extraction.model,
      extractionFallbackReason: extraction.fallbackReason,
    };
    // Only real when the LLM answered; the AgentResponse.usage field stays
    // absent otherwise (see types.ts - never a fabricated 0).
    const usage =
      extraction.source === "llm" && extraction.model
        ? { tokens: extraction.usage?.outputTokens ?? 0, model: extraction.model }
        : undefined;

    // B1's verdict, owned by the agent instead of looped onto the marketer.
    if (loopCount >= LOOP_LIMIT && questions.length) {
      return {
        status: "failed",
        message:
          `Still missing ${questions.map((q) => q.label).join(" and ")} after ${loopCount} rounds. ` +
          `Past ${LOOP_LIMIT} rounds this is the agent failing to read the brief, not the marketer ` +
          `failing to write it, so it escalates rather than asking a third time.`,
        output: {
          brief,
          ...summarise(parsed),
          loopCount,
          grounding: { grounded: grounding.grounded, reason: grounding.reason },
        },
        metadata: { loopCount, loopLimitReached: true, ...extractionMeta },
      };
    }

    // Something required is genuinely absent. Ask for it, and only it.
    if (questions.length) {
      return {
        status: "needs_input",
        message: questions.map((q) => q.ask || `What is the ${q.label.toLowerCase()}?`).join(" "),
        output: {
          brief,
          ...summarise(parsed),
          // The next round arrives with this incremented and the fields so far,
          // so the marketer answers two questions instead of the whole form.
          loopCount: loopCount + 1,
          questions: questions.map((q) => ({
            key: q.key,
            label: q.label,
            ask: q.ask ?? null,
            options: q.options ?? null,
            optionsPartial: q.optionsPartial ?? false,
          })),
          grounding,
        },
        metadata: { loopCount: loopCount + 1, askedFor: questions.map((q) => q.key), ...extractionMeta },
      };
    }

    /*
     * Complete enough to build. Create the Workfront request.
     *
     * createIntakeRequest reports what it WOULD have created when the call fails,
     * which is the honest outcome while nobody has signed in to the official MCP:
     * Workfront writes need OAuth, and 44 of its 94 tools are writes a Workfront
     * admin must enable per tenant. A visible dry run beats a run that reads as a
     * success and wrote nothing.
     */
    const outcome = await createIntakeRequest({ runId: body.runId, intake: parsed.fields, brief });
    const stated = parsed.extracted.filter((f) => f.from === "stated").length;
    const message =
      `Extracted ${stated} stated and ${parsed.inferred.length} inferred field(s) from the brief. ` +
      (outcome.created
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
        workfront: outcome,
        grounding,
        // Named plainly so Agent 2 reads them rather than re-deriving them.
        intakeFields: parsed.fields,
        workfrontPayload: toWorkfrontPayload(parsed.fields, brief),
      },
      metadata: {
        loopCount,
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
        // see workfront.ts's findPriorSuccess.
        workfrontReused: outcome.created ? !!outcome.reused : false,
      },
    };
  });

  return NextResponse.json<AgentResponse>({
    ...result,
    metadata: { ...result.metadata, toolCalls },
  });
}
