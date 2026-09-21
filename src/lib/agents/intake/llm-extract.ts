/**
 * LLM-assisted brief extraction for Agent 1 - the probabilistic front half of
 * a deterministic pipeline.
 *
 * WHY THIS EXISTS: reading a marketer's freeform paragraph is the one part of
 * Intake that is inherently a natural-language task, and parse.ts does it with
 * hand-written regexes/cues that need a new pattern for every way a human might
 * phrase something ("March" read out of "in market", "lob" matching "glob",
 * negated channels, ...). An LLM reads intent far better. But the REST of the
 * pipeline - schema probes, GTO gating, build-path decisions - must stay
 * deterministic and verifiable, so the LLM is confined to exactly this step and
 * its output is never trusted raw.
 *
 * THE CONTRACT IS PRESERVED, NOT BYPASSED. The LLM's job is only to produce the
 * same {key, value, provenance, evidence} extractions parse.ts produces. That
 * list is then fed straight back through parseBrief() as its `known` fields, so
 * every downstream invariant still holds:
 *   - provenance is kept ("stated" vs "inferred") - an inferred value still
 *     gets surfaced for human confirmation, never silently trusted (the whole
 *     point of parse.ts's docstring);
 *   - only real FieldSpec keys survive (anything the model invents is dropped);
 *   - missing/required/audience computation, nextQuestions, the loop cap - all
 *     run unchanged on the merged result.
 *
 * FALLS BACK, ALWAYS. No provider configured, a transport error, a timeout,
 * malformed JSON, an empty extraction - any of these returns the pure
 * parseBrief(brief, known) result instead. Turning the LLM on can only ADD
 * extraction quality; it can never break a run or change the response shape.
 * The caller learns which path ran via the returned `source`.
 */

import { CAMPAIGN_BRIEF_FIELDS, fieldByKey } from "@/lib/agents/shared/campaign-brief";
import { parseBrief, type ParsedIntake, type Provenance } from "./parse";
import { resolveLlmClient, type LlmClient } from "@/lib/llm";

export type ExtractionSource = "llm" | "deterministic";

export type LlmExtractionResult = {
  parsed: ParsedIntake;
  /** Which path produced `parsed` - surfaced in the agent's metadata. */
  source: ExtractionSource;
  /** The model id when source === "llm", else null. */
  model: string | null;
  /** Token usage when the provider reported it. */
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  /** Set when an LLM was configured but we fell back - so the reason is visible, not silent. */
  fallbackReason: string | null;
};

/** One extraction the model is asked to return. */
type RawExtraction = { key?: unknown; value?: unknown; provenance?: unknown; evidence?: unknown };

const VALID_PROVENANCE = new Set<Provenance>(["stated", "derived", "inferred"]);

/**
 * The field catalog, rendered for the prompt: key, label, and allowed options
 * where the form constrains them. Built from the SAME source of truth the
 * deterministic parser and the Workfront writer use, so the model is asked
 * about exactly the fields the rest of the system understands.
 */
function fieldGuide(): string {
  return CAMPAIGN_BRIEF_FIELDS.map((f) => {
    const opts = f.options?.length ? ` | allowed values: ${f.options.join(" / ")}` : "";
    const req = f.required ? " (required)" : "";
    return `- ${f.key}: ${f.label}${req}${opts}`;
  }).join("\n");
}

const SYSTEM = [
  "You extract structured campaign-brief fields from a marketer's freeform brief.",
  "You never invent facts. If the brief does not state or clearly imply a field, omit it entirely.",
  "For each field you DO return, label its provenance honestly - evaluators check this field specifically, so be strict:",
  '  "stated"   = the exact allowed value, or unmistakably the same words, appears in the brief. Test: can you point to the words in the brief that ARE the value, not words that merely imply or map onto it?',
  '  "derived"  = a direct, low-risk transformation of literal text (e.g. a bare month parsed out of a date phrase).',
  '  "inferred" = you had to map, categorize, or infer the value from a description or a paraphrase rather than from the option text itself.',
  "COMMON MISTAKE, DO NOT MAKE IT: mapping a description onto an allowed option is NOT \"stated\", even when the mapping is obviously correct. \"existing Xfinity Internet customers\" never uses the words \"Subscriber - Existing Customers\" - so customer_type from that phrase is \"inferred\", not \"stated\", no matter how confident you are. Likewise \"Xfinity Residential\" never uses the words \"Residential (RES)\" - line_of_business from that phrase is also \"inferred\". Reserve \"stated\" for when the brief's own wording already matches the option, not when you correctly guessed which option it means.",
  "When a field has allowed values, map to the closest allowed value verbatim, or omit if none fits.",
  "Respect negations: 'no direct mail' means Direct Mail is NOT a channel.",
  "Return ONLY a JSON object, no prose.",
].join("\n");

function buildPrompt(brief: string): string {
  return [
    "Extract campaign-brief fields from the brief below.",
    "",
    "Fields you may return (use these exact keys):",
    fieldGuide(),
    "",
    'Respond with JSON of the form: { "extractions": [ { "key": "...", "value": "...", "provenance": "stated|derived|inferred", "evidence": "the exact phrase from the brief" } ] }',
    "Omit any field the brief does not support. Do not include keys not listed above.",
    "",
    "BRIEF:",
    brief,
  ].join("\n");
}

/**
 * Pull the JSON object out of a model response that may be wrapped in prose or
 * a ```json fence. Returns the parsed extractions array, or throws if nothing
 * usable is found (the caller turns a throw into a fallback).
 */
export function parseExtractionResponse(text: string): RawExtraction[] {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("empty LLM response");

  // Prefer a fenced block if present, else the first {...} span.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
  if (!candidate || candidate.indexOf("{") === -1) throw new Error("no JSON object in LLM response");

  const obj = JSON.parse(candidate) as { extractions?: unknown };
  if (!Array.isArray(obj.extractions)) throw new Error("LLM JSON had no `extractions` array");
  return obj.extractions as RawExtraction[];
}

/**
 * Turn raw model extractions into a clean `known` map for parseBrief: keep only
 * real FieldSpec keys, coerce values to trimmed strings, drop empties. This is
 * the "never trust the model raw" gate - an invented key or a non-string value
 * simply doesn't survive.
 */
export function toKnownFields(raw: RawExtraction[]): {
  known: Record<string, string>;
  provenance: Record<string, Provenance>;
} {
  const known: Record<string, string> = {};
  const provenance: Record<string, Provenance> = {};
  for (const r of raw) {
    const key = typeof r.key === "string" ? r.key.trim() : "";
    if (!key || !fieldByKey(key)) continue; // invented/unknown key -> dropped
    const value = r.value == null ? "" : String(r.value).trim();
    if (!value) continue;
    known[key] = value;
    const p = typeof r.provenance === "string" ? (r.provenance as Provenance) : "inferred";
    provenance[key] = VALID_PROVENANCE.has(p) ? p : "inferred";
  }
  return { known, provenance };
}

/**
 * Extract a brief into a ParsedIntake, preferring a configured LLM and always
 * falling back to the deterministic parser.
 *
 * @param brief   the marketer's words
 * @param known   fields already confirmed (a rework loop carries these) - passed
 *                straight through to parseBrief in every path, and they win over
 *                any LLM extraction of the same key (parseBrief treats `known`
 *                as stated fact).
 * @param client  injectable for tests; defaults to the env-configured client.
 */
/**
 * Read a marketer's free-text ANSWER (on a rework loop) into as many fields as
 * it supports at once, biased toward the questions that were actually pending.
 *
 * THE GAP THIS CLOSES: resume today does a literal key-merge - an answer only
 * fills the exact field asked, so "yeah, existing Xfinity internet customers in
 * the Northeast, no direct mail" - given only when customer_type was asked -
 * throws away the region, product, and channel-exclusion signals in the same
 * sentence, and re-asks them next round. That IS the B1 loop, just slower.
 *
 * Returns a `known`-style map (real keys only, trimmed, non-empty) to LAYER
 * UNDER the marketer's explicitly typed answers - the model enriches, it never
 * overrides what the human directly said. Empty on no-LLM/error/empty-result,
 * so the caller simply proceeds with the literal merge exactly as today.
 */
export async function extractFromAnswer(
  answerText: string,
  pendingQuestions: Array<{ key: string; label: string }>,
  client?: LlmClient | null,
): Promise<{ known: Record<string, string>; source: ExtractionSource; model: string | null }> {
  const text = String(answerText || "").trim();
  const { client: resolvedClient } = resolveLlmClient(client);
  // A misconfigured provider falls back exactly like an absent one here -
  // this enrichment is best-effort by contract, so there is no fallbackReason
  // to surface it through; see resolveLlmClient's docstring for why it can't
  // simply throw.
  if (!resolvedClient || !text) return { known: {}, source: "deterministic", model: null };
  try {
    const pending = pendingQuestions.length
      ? `The marketer was asked about: ${pendingQuestions.map((q) => `${q.key} (${q.label})`).join(", ")}. ` +
        "Map their reply to those first, but ALSO capture any other listed field the reply happens to state or imply."
      : "Capture any listed field the reply states or implies.";
    const completion = await resolvedClient.complete({
      system: SYSTEM,
      prompt: [
        "The marketer replied to a follow-up question. Extract every campaign-brief field their reply supports.",
        pending,
        "",
        "Fields you may return (use these exact keys):",
        fieldGuide(),
        "",
        'Respond with JSON: { "extractions": [ { "key": "...", "value": "...", "provenance": "stated|derived|inferred", "evidence": "..." } ] }',
        "",
        "REPLY:",
        text,
      ].join("\n"),
      temperature: 0,
      maxTokens: 1024,
    });
    const { known } = toKnownFields(parseExtractionResponse(completion.text));
    return { known, source: "llm", model: completion.model };
  } catch {
    // Enrichment is best-effort - a failure just means the literal merge stands.
    return { known: {}, source: "deterministic", model: null };
  }
}

export async function extractIntake(
  brief: string,
  known: Record<string, unknown> = {},
  client?: LlmClient | null,
): Promise<LlmExtractionResult> {
  const { client: resolvedClient, configError } = resolveLlmClient(client);

  // No LLM configured, or configured but misconfigured (bad/missing
  // credentials): the app's original behaviour, unchanged either way - this
  // function's whole contract is "the LLM can only ADD, never block a run".
  // See resolveLlmClient's docstring for why a misconfigured provider must
  // land here rather than throwing past this function's own try/catch.
  if (!resolvedClient) {
    return {
      parsed: parseBrief(brief, known),
      source: "deterministic",
      model: null,
      usage: null,
      fallbackReason: configError ? `LLM misconfigured (${configError}); used the deterministic parser.` : null,
    };
  }

  try {
    const completion = await resolvedClient.complete({
      system: SYSTEM,
      prompt: buildPrompt(brief),
      temperature: 0,
      maxTokens: 1536,
    });
    const raw = parseExtractionResponse(completion.text);
    const { known: llmKnown, provenance: llmProvenance } = toKnownFields(raw);

    // Caller-supplied `known` (confirmed rework answers) must not be overridden
    // by the model - layer them on top. parseBrief then re-derives everything
    // (missing/inferred/questions) from the merged, validated field set, so all
    // downstream invariants hold exactly as in the pure path.
    const merged = { ...llmKnown, ...(known as Record<string, string>) };

    // The model's own provenance label travels with its extraction - an
    // "inferred" field must still read as inferred downstream, never silently
    // promoted to "stated" just because it passed through `known`. A
    // caller-supplied field (a rework answer the marketer actually typed)
    // always wins as "stated", since it is confirmed fact, not a guess.
    const provenance: Record<string, Provenance> = { ...llmProvenance };
    for (const key of Object.keys(known)) provenance[key] = "stated";

    // Nothing usable came back: fall back rather than proceed on an empty read.
    if (Object.keys(llmKnown).length === 0) {
      return {
        parsed: parseBrief(brief, known),
        source: "deterministic",
        model: null,
        usage: null,
        fallbackReason: "LLM returned no usable field extractions; used the deterministic parser.",
      };
    }

    return {
      parsed: parseBrief(brief, merged, provenance),
      source: "llm",
      model: completion.model,
      usage: completion.usage,
      fallbackReason: null,
    };
  } catch (err) {
    // Any failure - transport, timeout, malformed JSON - falls back. The run
    // is never blocked on the LLM being reachable.
    return {
      parsed: parseBrief(brief, known),
      source: "deterministic",
      model: null,
      usage: null,
      fallbackReason: `LLM extraction failed (${(err as Error).message}); used the deterministic parser.`,
    };
  }
}
