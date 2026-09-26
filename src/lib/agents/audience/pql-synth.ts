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

import { BUSINESS_GLOSSARY, glossaryPrompt } from "./glossary";
import type { ProfileField, SchemaProbe } from "./aep";
import type { PqlGuidance } from "@/lib/agents/review/pql-context";
import { resolveLlmClient, type LlmClient } from "@/lib/llm";
import { reflectLoop } from "@/lib/llm/reflect";
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
  /** How many model calls this took - 1 = no reflection round needed. 0 = no LLM call at all. */
  attempts: number;
  /** True when the FIRST attempt referenced an unverified field and a revision was tried. */
  revised: boolean;
  /** The rule in plain English, for the person who asked - "Profiles whose Is CBM member flag is Y". */
  interpretation?: string | null;
  /** A short audience name the model proposed from the request. */
  suggestedName?: string | null;
};

const NOT_SYNTHESIZED = (reason: string, extra: Partial<PqlSynthesis> = {}): PqlSynthesis => ({
  synthesized: false,
  pql: null,
  fieldsUsed: [],
  model: null,
  reason,
  unverifiedFields: [],
  attempts: 0,
  revised: false,
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
  "- The marketer writes in business language, not field names. Match their words",
  "  to fields by TITLE and DESCRIPTION as well as path: \"customers who have CBM\"",
  "  means a field titled \"Is CBM member\"; \"SEP eligible\" means one titled",
  "  \"SEP eligible\". Prefer the tenant's own fields (_tenant.*) over standard XDM",
  "  fields whenever both fit - a tenant \"Email address\" over personalEmail.address.",
  "- Use the business glossary given with the criteria: an abbreviation in a field",
  "  title and its spelled-out form in the criteria are the same thing.",
  "- Compare to the values the field actually holds: a string described as a",
  "  \"Y/N flag\" is = \"Y\", a boolean is = true, an enum uses one of its listed",
  "  values. \"Has an email\" means the email field exists (X.isNotNull()).",
  "- Fields inside an array need array syntax from the reference, never a plain",
  "  dotted comparison.",
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
  "",
  // The business's vocabulary and data rules (glossary.ts), here rather than
  // in the user prompt: there, the insufficiency rule above outweighed it and
  // the model kept hunting for a consent field the glossary says not to need.
  glossaryPrompt(),
].join("\n");

type RawSynth = { pql?: unknown; fieldsUsed?: unknown; missing?: unknown; interpretation?: unknown; name?: unknown };

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
  // With full paths on both sides (the catalog), the whole path must match:
  // across ~750 fields a leaf like "address" exists in many places, so a
  // leaf-only check would pass an invented `_tenant.foo.address`. A bare
  // leaf, or a leaf-only present list from an older probe, compares by leaf.
  const path = String(field).trim().toLowerCase();
  if (path.includes(".") && presentNames.some((n) => n.includes("."))) {
    return presentNames.some((n) => n.toLowerCase() === path);
  }
  return presentNames.some((n) => (n.split(".").pop() || n).toLowerCase() === target);
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
/** Longest a field description gets in the prompt - Adobe's standard ones run to paragraphs. */
const DESCRIPTION_CHARS = 100;
/** Prompt budget for the field list, in characters (~12k tokens). */
const FIELD_LIST_BUDGET = 45_000;
/** Words too common in field text to say anything about relevance. */
const RELEVANCE_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "who", "are", "has", "have", "not", "flag", "field",
  "customers", "customer", "profile", "profiles", "audience", "people", "anyone", "everyone", "whose", "all",
]);

/** Lower-case word stems: camelCase split, plurals folded ("companies" -> "company", "members" -> "member"). */
function stems(text: string): string[] {
  return String(text || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !RELEVANCE_STOPWORDS.has(w))
    .map((w) => (w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/** The brief's stems, plus both forms of every glossary entry it uses ("Security Edge Preferred" also brings "sep"). */
function criteriaStems(criteria: string): Set<string> {
  const out = new Set(stems(criteria));
  const lower = ` ${criteria.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  for (const g of BUSINESS_GLOSSARY) {
    const meaning = g.meaning.split(",")[0].toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (lower.includes(` ${g.term.toLowerCase()} `) || lower.includes(` ${meaning} `)) {
      [...stems(g.term), ...stems(meaning), g.term.toLowerCase()].forEach((w) => out.add(w));
    }
  }
  return out;
}

/**
 * The field catalog as prompt lines, trimmed to what a rule could plausibly
 * use. Sending the whole tapdemo catalog verbatim was ~400k characters
 * (~100k tokens, ~$0.12 on Haiku) per call, and the plain-English eval spent
 * $10 in an afternoon on it. Now: deprecated fields dropped, descriptions cut
 * to one line, a title that only repeats the path dropped, and a budget
 * filled in priority order - fields the brief matched, then fields sharing
 * words with the brief (by path, title or description, through the business
 * glossary), then the tenant's own fields, then standard XDM fields.
 * Verification still checks the model's fields against the FULL catalog.
 */
export function offeredFieldList(
  catalog: ProfileField[],
  hinted: Set<string>,
  criteria = "",
  budget = FIELD_LIST_BUDGET,
): string {
  const line = (f: ProfileField) => {
    const leaf = f.path.split(".").pop() ?? f.path;
    const title = f.title && f.title.toLowerCase() !== leaf.toLowerCase() ? f.title : "";
    const description = f.description
      ? f.description.length > DESCRIPTION_CHARS ? `${f.description.slice(0, DESCRIPTION_CHARS)}...` : f.description
      : "";
    return [f.path, f.type, title, description, f.values?.length ? `values: ${f.values.slice(0, 12).join("/")}` : ""]
      .filter(Boolean)
      .join(" | ");
  };
  const wanted = criteriaStems(criteria);
  const overlap = (f: ProfileField) =>
    new Set(stems(`${f.path.split(".").pop()} ${f.title ?? ""} ${f.description ?? ""}`).filter((w) => wanted.has(w))).size;
  const ranked = catalog
    .filter((f) => !f.deprecated || hinted.has(f.path))
    .map((f, i) => {
      const score = overlap(f);
      const tier = hinted.has(f.path) ? 0 : score > 0 ? 1 : f.path.startsWith("_") ? 2 : 3;
      return { f, i, tier, score };
    })
    .sort((a, b) => a.tier - b.tier || b.score - a.score || a.i - b.i);
  const lines: string[] = [];
  let used = 0;
  for (const { f, tier } of ranked) {
    const l = line(f);
    if (tier > 0 && used + l.length + 1 > budget) break;
    lines.push(l);
    used += l.length + 1;
  }
  return lines.join("\n");
}

export async function synthesizePql(
  criteria: string,
  probe: SchemaProbe,
  pqlGuidance: PqlGuidance,
  client?: LlmClient | null,
  opts: {
    /**
     * The sandbox's whole field catalog (aep.ts's profileCatalog). When
     * given, the model chooses from every field - by title and description,
     * not just the probe's name matches - and verification checks against
     * it. Without it, only probe.evidence is offered, as before.
     */
    catalog?: ProfileField[];
    /** Why AEP rejected the previous attempt's rule, so this one can fix it. */
    feedback?: string;
    /**
     * The marketer's answers about conditions no field matched (buildability.ts's
     * filterAnswerNotes). Given their own section that overrides the criteria:
     * appended to the criteria instead, the model sided with the brief's
     * wording and refused over the very condition the marketer dropped
     * (live run 69e0f31c, 26 Sep 2026).
     */
    decisions?: string;
  } = {},
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
  const catalog = opts.catalog?.length ? opts.catalog : null;
  const presentNames = catalog ? catalog.map((f) => f.path) : probe.evidence ?? [];
  if (presentNames.length === 0) {
    return NOT_SYNTHESIZED("the probe confirmed no concrete field names to build against");
  }
  // Hints: fields the brief named outright (probe.evidence), listed first.
  const hinted = new Set(probe.evidence ?? []);
  const fieldList = catalog
    ? offeredFieldList(catalog, hinted, [criteria, opts.decisions].filter(Boolean).join(" "))
    : presentNames
        .map((n) => {
          const about = [probe.fieldTypes?.[n], probe.fieldDescriptions?.[n]].filter(Boolean).join(" - ");
          return about ? `${n} (${about})` : n;
        })
        .join(", ");

  const reference = pqlGuidance.localReference.available ? pqlGuidance.localReference.content ?? "" : "";
  if (!reference) {
    return NOT_SYNTHESIZED("the PQL reference could not be loaded; refusing to synthesize against unverified syntax");
  }

  const buildPrompt = (extra?: string) =>
    [
      `Audience criteria: ${criteria.trim()}`,
      "",
      ...(opts.decisions?.trim()
        ? [
            "The marketer has already settled these conditions. Their answers OVERRIDE the criteria above - a " +
              "dropped condition is not part of this audience, so write the rule without it and do not list it " +
              `as missing:\n${opts.decisions.trim()}`,
            "",
          ]
        : []),
      "Available profile fields, one per line - full PQL path | XDM type | then its title, description and " +
        "allowed values where the schema gives them. The title and description are how the marketer will name " +
        `a field; the description is the only source for a string flag's values. Use ONLY these fields:\n${fieldList}`,
      "",
      "PQL function reference (use ONLY this syntax):",
      // Bound the reference so a huge doc can't blow the context; the
      // function categories are near the top.
      reference.slice(0, 12_000),
      "",
      'Respond with JSON: { "pql": "the expression, or empty string if not expressible", "fieldsUsed": ["field", ...], ' +
        '"missing": ["what you would need but was not available", ...], "interpretation": "one plain-English sentence ' +
        'saying exactly who is in the audience, naming the fields by title", "name": "a short audience name, max 60 characters" }',
      ...(opts.feedback ? ["", `AEP rejected the previous rule for this audience: ${opts.feedback}. Write a corrected rule.`] : []),
      ...(extra ? ["", extra] : []),
    ].join("\n");

  try {
    const outcome = await reflectLoop({
      client: resolvedClient,
      system: SYSTEM,
      prompt: buildPrompt(),
      maxTokens: 1024,
      parse: (text) => {
        const raw = extractJson(text);
        return {
          pql: typeof raw.pql === "string" ? raw.pql.trim() : "",
          fieldsUsed: Array.isArray(raw.fieldsUsed) ? raw.fieldsUsed.map((f) => String(f)).filter(Boolean) : [],
          missing: Array.isArray(raw.missing) ? raw.missing.map((m) => String(m)) : [],
          interpretation: typeof raw.interpretation === "string" ? raw.interpretation.trim() : "",
          name: typeof raw.name === "string" ? raw.name.trim().slice(0, 80) : "",
        };
      },
      // An empty pql is an honest "the available fields are insufficient" -
      // never a revisable failure; arguing the model into fabricating a field
      // just to satisfy the critic is exactly the failure mode this whole
      // module exists to prevent. Only a field-verification miss is revisable.
      critique: (parsed) => {
        if (!parsed.pql) return [];
        const { unverified } = verifyFields(parsed.fieldsUsed, presentNames);
        return unverified.map((f) => `field "${f}" is not in the available list`);
      },
      revise: ({ issues }) =>
        buildPrompt(
          `Your previous expression referenced field(s) not in the available list: ${issues.join("; ")}. ` +
            "Use ONLY fields from the list above. Rewrite the expression using only those " +
            "fields, or return an empty pql (\"\") if the audience truly cannot be expressed with them.",
        ),
    });

    const { pql, fieldsUsed, missing, interpretation, name } = outcome.result;
    const revised = outcome.attempts > 1;

    if (!pql) {
      return NOT_SYNTHESIZED(
        "the model reported the available fields are insufficient to express this audience" +
          (missing.length ? ` (would need: ${missing.join(", ")})` : ""),
        { model: outcome.model, attempts: outcome.attempts, revised },
      );
    }

    // THE GATE: every referenced field must be provably present - re-checked
    // here on the winning attempt so this function's own contract doesn't
    // depend on reflectLoop's internal bookkeeping.
    const { confirmed, unverified } = verifyFields(fieldsUsed, presentNames);
    if (unverified.length) {
      return NOT_SYNTHESIZED(
        `rejected the synthesized expression: it referenced field(s) not verified present in AEP (${unverified.join(", ")})`,
        { model: outcome.model, unverifiedFields: unverified, attempts: outcome.attempts, revised },
      );
    }

    return {
      synthesized: true,
      pql,
      fieldsUsed: confirmed,
      model: outcome.model,
      reason: null,
      unverifiedFields: [],
      attempts: outcome.attempts,
      revised,
      interpretation: interpretation || null,
      suggestedName: name || null,
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
export function segmentCreationEnabled(mode: "demo" | "governed" = "governed"): boolean {
  // Demo mode exists to build a real audience in the tapdemo sandbox - its
  // whole promise - so it always creates. Governed mode stays opt-in.
  if (mode === "demo") return true;
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
  sandbox?: string,
): Promise<SegmentCreation> {
  if (!synthesis.synthesized || !synthesis.pql) {
    return { attempted: false, reason: "no verified PQL expression to create a segment from" };
  }

  const prior = await findPriorSegmentCreation(runId);
  if (prior) return { ...prior, reused: true };

  const segmentName = name.trim() || "Untitled audience";

  try {
    const result = await callMcpTool<{ id?: string; segmentId?: string; data?: { id?: string }; segment?: { id?: string } }>(
      taskId,
      "adobe_create_segment",
      {
        name: segmentName,
        // The gateway tool takes the rule as a plain `pql_expression` string
        // (verified against its live inputSchema, 26 Sep 2026). This sent an
        // AEP-style `expression: {type, format, value}` object before, which
        // the tool does not read - so no create could ever have carried a rule.
        pql_expression: synthesis.pql,
        description:
          (synthesis.interpretation ? `${synthesis.interpretation} ` : "") +
          `Built by the intake agent from verified fields: ${synthesis.fieldsUsed.join(", ")}`,
        ...(sandbox ? { sandbox } : {}),
      },
    );
    const segmentId = String(result?.id || result?.segmentId || result?.data?.id || result?.segment?.id || "");
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
