/**
 * LLM synthesis of a PQL segment expression for Agent 3 - turning Review's AEP
 * context, the resolved data source, and the real PQL reference into an actual
 * candidate expression, instead of Agent 3 only deciding a build-path string
 * and stopping (which is all it does today - it never composes PQL and never
 * creates the segment).
 *
 * THE SAFETY PROPERTY, WHICH IS THE WHOLE POINT: an LLM writing a segment
 * definition that references a field AEP doesn't have is the classic
 * "reported success while failing" bug this pipeline exists to prevent - it
 * would build (or hand a human) a broken audience that looks right. So:
 *
 *   1. The model is given ONLY the field names the schema probe CONCLUSIVELY
 *      found present, plus the PQL function reference as the only syntax
 *      source. It is told to use nothing else.
 *   2. Every field path in the returned expression is VERIFIED against that
 *      same real field-name list (anchored match - the "lob" in "glob"
 *      lesson from aep.ts). If the model referenced any field not provably
 *      present, the expression is REJECTED - not built, not handed over as
 *      trustworthy - and Agent 3 falls back to its normal decide-and-report
 *      behaviour, flagging why.
 *   3. Even a clean expression is, by default, a DRAFT attached for a human to
 *      build from - never auto-created. See audience-creation/route.ts.
 *
 * FALLS BACK, ALWAYS. No LLM / inconclusive probe / transport error / bad JSON
 * / verification failure -> no synthesized expression, source recorded, run
 * unchanged. Pure except for the LLM call itself; verification is deterministic.
 */

import type { SchemaProbe } from "./aep";
import type { PqlGuidance } from "@/lib/agents/review/pql-context";
import { resolveLlmClient, type LlmClient } from "@/lib/llm";
import { callMcpTool } from "@/lib/mcp-client";
import type { TaskId } from "@/lib/pipeline/types";
import { findPriorTaskRun } from "@/lib/pipeline/idempotent-write";

export type PqlSynthesis = {
  /** Did we produce a verified candidate expression? */
  synthesized: boolean;
  /** The PQL expression, when synthesized and verified; null otherwise. */
  pql: string | null;
  /** The field paths the expression uses (post-verification, all confirmed present). */
  fieldsUsed: string[];
  /** The model id, when the LLM ran. */
  model: string | null;
  /** Why we have no expression, when synthesized is false - never silent. */
  reason: string | null;
  /**
   * Field paths the model referenced that could NOT be verified present. When
   * this is non-empty, the expression was rejected on their account - surfaced
   * so the failure is legible, not a mystery "no PQL".
   */
  unverifiedFields: string[];
};

const NOT_SYNTHESIZED = (reason: string, extra: Partial<PqlSynthesis> = {}): PqlSynthesis => ({
  synthesized: false,
  pql: null,
  fieldsUsed: [],
  model: null,
  reason,
  unverifiedFields: [],
  ...extra,
});

/**
 * The outcome of trying to CREATE the segment from a verified expression.
 *
 * Mirrors intake/workfront.ts's createIntakeRequest honesty contract exactly:
 * on a tenant where the write tool is disabled it reports what it WOULD have
 * created rather than pretending success, so a run reads as an honest dry-run
 * instead of a silent no-op.
 */
export type SegmentCreation =
  | { attempted: false; reason: string }
  | {
      attempted: true;
      created: true;
      /**
       * True when this is a PRIOR successful create for this exact run,
       * found and reused rather than created again - see
       * findPriorSegmentCreation's idempotency check.
       */
      reused?: boolean;
      segmentId: string;
      name: string;
      pql: string;
    }
  | {
      attempted: true;
      created: false;
      reason: string;
      /** What we would have sent, for a reviewer to see the exact payload. */
      wouldHaveCreated: { name: string; pql: string };
    };

const SYSTEM = [
  "You write a single Adobe Experience Platform PQL (Profile Query Language)",
  "segment expression from a marketer's audience criteria.",
  "HARD RULES:",
  "- Use ONLY the profile field names provided as available. Never reference a",
  "  field that is not in that list, even if it seems obvious it should exist.",
  "- Use ONLY PQL syntax from the reference provided.",
  "- The expression MUST capture EVERY condition in the criteria - not just the",
  "  ones you happen to have a field for. If even ONE condition (a region, a",
  "  tenure/recency threshold, an exclusion, a channel-eligibility flag, ...)",
  "  has no available field to express it, the available fields are",
  "  INSUFFICIENT for the whole audience. Do NOT silently narrow the audience",
  "  by writing an expression for only the conditions you could match and",
  "  dropping the rest - a segment for the wrong (broader) audience is a wrong",
  "  answer, not a partial one, and it will be created for real without anyone",
  "  noticing the missing condition.",
  "- When insufficient (per the rule above), return an empty pql (\"\") and list",
  "  EVERY condition you could not express in `missing` - not just the first",
  "  one you notice.",
  "Return ONLY JSON.",
].join("\n");

type RawSynth = { pql?: unknown; fieldsUsed?: unknown; missing?: unknown };

/** Pull the first JSON object out of a fenced or prose-wrapped response. */
function extractJson(text: string): RawSynth {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("empty LLM response");
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
  if (!candidate || candidate.indexOf("{") === -1) throw new Error("no JSON object in LLM response");
  return JSON.parse(candidate) as RawSynth;
}

/**
 * Is `field` provably one of the real, present field names?
 *
 * Matches the LAST path segment (PQL references fields as dotted paths like
 * `_tenant.xfinityInternet` or `homeAddress.stateProvince`) against the probe's
 * evidence list, anchored so a partial can't spuriously pass - the exact
 * discipline aep.ts uses. A field the probe didn't list is NOT verified.
 */
export function isFieldPresent(field: string, presentNames: string[]): boolean {
  const leaf = String(field || "")
    .trim()
    .split(/[.[\]]/)
    .filter(Boolean)
    .pop();
  if (!leaf) return false;
  const target = leaf.toLowerCase();
  return presentNames.some((n) => n.toLowerCase() === target);
}

/**
 * Verify a synthesized expression's fields against the real present-field list.
 * Returns the confirmed fields and any that couldn't be verified. Deterministic.
 */
export function verifyFields(
  fieldsUsed: string[],
  presentNames: string[],
): { confirmed: string[]; unverified: string[] } {
  const confirmed: string[] = [];
  const unverified: string[] = [];
  for (const f of fieldsUsed) {
    (isFieldPresent(f, presentNames) ? confirmed : unverified).push(f);
  }
  return { confirmed, unverified };
}

/**
 * Synthesize a verified PQL expression, or return an honest "not synthesized"
 * with the reason.
 *
 * @param criteria       the audience in plain words (brief + description + exclusion)
 * @param probe          the schema probe - its `evidence` is the real present-field list
 * @param pqlGuidance    the PQL reference (only trusted syntax source)
 * @param client         injectable for tests; defaults to the env-configured client
 */
export async function synthesizePql(
  criteria: string,
  probe: SchemaProbe,
  pqlGuidance: PqlGuidance,
  client?: LlmClient | null,
): Promise<PqlSynthesis> {
  const { client: resolvedClient, configError } = resolveLlmClient(client);
  if (!resolvedClient) {
    return NOT_SYNTHESIZED(
      configError
        ? `LLM misconfigured (${configError}); Agent 3 reports the build path without a drafted expression`
        : "no LLM configured; Agent 3 reports the build path without a drafted expression",
    );
  }
  if (!criteria.trim()) return NOT_SYNTHESIZED("no audience criteria to express");

  // An inconclusive probe means we don't know what fields exist - synthesizing
  // against an unknown field set is exactly the guess we refuse to make.
  if (!probe.conclusive) {
    return NOT_SYNTHESIZED(
      `attribute availability is undetermined (${probe.error}); not synthesizing PQL against an unknown field set`,
    );
  }
  const presentNames = probe.evidence ?? [];
  if (presentNames.length === 0) {
    return NOT_SYNTHESIZED("the probe confirmed no concrete field names to build against");
  }

  const reference = pqlGuidance.localReference.available ? pqlGuidance.localReference.content ?? "" : "";
  if (!reference) {
    return NOT_SYNTHESIZED("the PQL reference could not be loaded; refusing to synthesize against unverified syntax");
  }

  try {
    const completion = await resolvedClient.complete({
      system: SYSTEM,
      prompt: [
        `Audience criteria: ${criteria.trim()}`,
        "",
        `Available profile field names (use ONLY these): ${presentNames.join(", ")}`,
        "",
        "PQL function reference (use ONLY this syntax):",
        // Bound the reference so a huge doc can't blow the context; the
        // function categories are near the top.
        reference.slice(0, 12_000),
        "",
        'Respond with JSON: { "pql": "the expression, or empty string if not expressible", "fieldsUsed": ["field", ...], "missing": ["what you would need but was not available", ...] }',
      ].join("\n"),
      temperature: 0,
      maxTokens: 1024,
    });

    const raw = extractJson(completion.text);
    const pql = typeof raw.pql === "string" ? raw.pql.trim() : "";
    const fieldsUsed = Array.isArray(raw.fieldsUsed)
      ? raw.fieldsUsed.map((f) => String(f)).filter(Boolean)
      : [];

    if (!pql) {
      const missing = Array.isArray(raw.missing) ? raw.missing.map((m) => String(m)) : [];
      return NOT_SYNTHESIZED(
        "the model reported the available fields are insufficient to express this audience" +
          (missing.length ? ` (would need: ${missing.join(", ")})` : ""),
        { model: completion.model },
      );
    }

    // THE GATE: every referenced field must be provably present.
    const { confirmed, unverified } = verifyFields(fieldsUsed, presentNames);
    if (unverified.length) {
      return NOT_SYNTHESIZED(
        `rejected the synthesized expression: it referenced field(s) not verified present in AEP (${unverified.join(", ")})`,
        { model: completion.model, unverifiedFields: unverified },
      );
    }

    return {
      synthesized: true,
      pql,
      fieldsUsed: confirmed,
      model: completion.model,
      reason: null,
      unverifiedFields: [],
    };
  } catch (err) {
    return NOT_SYNTHESIZED(`PQL synthesis failed (${(err as Error).message}); reporting the build path without an expression`);
  }
}

/**
 * Is actually creating the segment turned on?
 *
 * OFF BY DEFAULT, deliberately - the same stance activation.ts takes for the
 * one other place this agent could write. Everything else about Agent 3 is a
 * read; creating a segment is the single write it can do, so it must be an
 * explicit, opt-in decision (AUDIENCE_CREATE_SEGMENT=true), never a default.
 * When off, a synthesized expression is still drafted and attached for a human
 * to build from - the read-only behaviour is unchanged.
 */
export function segmentCreationEnabled(): boolean {
  return String(process.env.AUDIENCE_CREATE_SEGMENT || "").trim().toLowerCase() === "true";
}

/** A write tool that 404s because writes are off, not because of a bug here - same detection intake/workfront.ts uses. Exported for unit testing the classification without a live rejection. */
export function isMissingWriteTool(raw: string): boolean {
  return /not found/i.test(raw) && /create_segment/i.test(raw);
}

/**
 * Has THIS RUN already created a segment from a verified PQL expression?
 *
 * THE SAME RACE createIntakeRequest's findPriorSuccess closes, one write
 * over: adobe_create_segment can succeed and then the process can crash
 * before the step's own task_runs row commits, leaving the run at "running"
 * with no memory the create happened. retryRun then re-invokes this exact
 * step from scratch, and without this check that re-invocation creates a
 * SECOND, real, duplicate segment in AEP - the write this function's own
 * "HONESTY CONTRACT, identical to createIntakeRequest" docstring claims but,
 * until this guard, did not actually share.
 *
 * FAILS OPEN: built on findPriorTaskRun, which returns null (never throws)
 * on a query error, so a broken check can only fail to skip a redundant
 * create, never block a legitimate one.
 */
async function findPriorSegmentCreation(runId: string): Promise<Extract<SegmentCreation, { created: true }> | null> {
  const prior = await findPriorTaskRun<{ segmentCreation?: SegmentCreation }>(runId, "audience_creation", ["completed"]);
  const sc = prior?.output?.segmentCreation;
  if (sc && sc.attempted && sc.created === true && sc.segmentId) return sc;
  return null;
}

/**
 * Create the AEP segment from a VERIFIED synthesized expression.
 *
 * PRECONDITIONS THE CALLER MUST HAVE MET (this function does not re-derive
 * them, but they are the whole safety story):
 *   - segmentCreationEnabled() is true (explicit opt-in);
 *   - `synthesis.synthesized` is true, i.e. the expression passed the verify
 *     gate in synthesizePql and references only fields confirmed present.
 * It refuses outright if handed an unsynthesized result, so a caller that
 * forgets the guard cannot create a segment from an unverified expression.
 *
 * HONESTY CONTRACT, identical to createIntakeRequest: when the write tool is
 * absent (writes disabled on the tenant), this reports `created: false` with
 * `wouldHaveCreated` and names the cause, rather than reporting a success that
 * wrote nothing. Never throws - the caller records the outcome and the run is
 * never failed by an attempt to create.
 */
export async function createSegmentFromPql(
  runId: string,
  taskId: TaskId,
  synthesis: PqlSynthesis,
  name: string,
): Promise<SegmentCreation> {
  if (!synthesis.synthesized || !synthesis.pql) {
    return { attempted: false, reason: "no verified PQL expression to create a segment from" };
  }

  const prior = await findPriorSegmentCreation(runId);
  if (prior) return { ...prior, reused: true };

  const segmentName = name.trim() || "Untitled audience";

  try {
    const result = await callMcpTool<{ id?: string; segmentId?: string; data?: { id?: string } }>(
      taskId,
      "adobe_create_segment",
      {
        name: segmentName,
        // AEP segment definitions carry the PQL under an expression object of
        // type "PQL", format "pql/text". The gateway tool accepts the fields
        // below; a shape mismatch surfaces as a normal tool error and is
        // reported (created:false), not thrown.
        expression: { type: "PQL", format: "pql/text", value: synthesis.pql },
        description: `Drafted by Agent 3 from verified fields: ${synthesis.fieldsUsed.join(", ")}`,
      },
    );
    const segmentId = String(result?.id || result?.segmentId || result?.data?.id || "");
    if (!segmentId) {
      return {
        attempted: true,
        created: false,
        reason: "AEP accepted the create but returned no segment id",
        wouldHaveCreated: { name: segmentName, pql: synthesis.pql },
      };
    }
    return { attempted: true, created: true, segmentId, name: segmentName, pql: synthesis.pql };
  } catch (err) {
    const raw = (err as Error).message;
    return {
      attempted: true,
      created: false,
      reason: isMissingWriteTool(raw)
        ? `${raw} — this tool is absent because segment-write is not enabled on this AEP gateway. ` +
          "The verified expression below is what would have been created."
        : raw,
      wouldHaveCreated: { name: segmentName, pql: synthesis.pql },
    };
  }
}
