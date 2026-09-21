/**
 * LLM-assisted rejection reading and triage for Agent 2 - the two
 * natural-language jobs this agent does, and the ones the README calls "the
 * largest unclaimed gap in the map" (B2).
 *
 * WHY: rejection.ts and triage.ts do these with ~470 lines of hand-tuned
 * regex - textRejectionScore literally assigns numeric weights to keyword
 * buckets to approximate intent classification, which is exactly what a
 * language model does natively and a regex never will. Every phrasing a
 * reviewer invents that the stems miss is a real rejection read as "no
 * rejection" - the exact bug this agent exists to fix, one layer down.
 *
 * SAME CONTRACT AS THE DETERMINISTIC PATH, NEVER TRUSTED RAW. These functions
 * return the identical RejectionSignal / TriageResult shapes the pure
 * functions do, and then:
 *   - a proposed field value is ONLY kept if it validates against the real
 *     FieldSpec options via closestOption (the same gate triageRejection uses)
 *     - an invented value is dropped, and the finding degrades to a question;
 *   - only real FieldSpec keys survive;
 *   - a redraft still goes back to the human to CONFIRM (2.5 stays human) - the
 *     LLM proposes, it does not resubmit.
 *
 * FALLS BACK, ALWAYS. No provider / transport error / bad JSON / empty result
 * -> the deterministic detectRejection / triageRejection, unchanged. Turning
 * the LLM on can only sharpen the reading; it can never block a run or change
 * the response shape. The caller learns which path ran via `source`.
 */

import {
  CAMPAIGN_BRIEF_FIELDS,
  fieldByKey,
  type FieldSpec,
} from "@/lib/agents/shared/campaign-brief";
import {
  triageRejection,
  closestOption,
  type TriageResult,
  type TriageFinding,
  type RejectionKind,
} from "./triage";
import { detectRejection, type CommentLike, type RejectionSignal } from "./rejection";
import { resolveLlmClient, type LlmClient } from "@/lib/llm";

export type Agent2Source = "llm" | "deterministic";

const VALID_KINDS = new Set<RejectionKind>([
  "missing_field",
  "invalid_value",
  "wrong_data_source",
  "unclassified",
]);

// ── Rejection detection ────────────────────────────────────────────────────

export type LlmRejectionResult = {
  signal: RejectionSignal;
  source: Agent2Source;
  fallbackReason: string | null;
};

const REJECTION_SYSTEM = [
  "You read a Workfront issue's comment/update history and decide whether the",
  "issue was REJECTED or sent back for rework (as opposed to approved, or just",
  "discussed). Sending work back for ANY reason - a missing field, an unclear",
  "audience, 'let's hold this until X' - counts as a rejection. An",
  "acknowledgement like 'resubmitted, thanks' or 'approved, looks good' does",
  "NOT. Pick the single most recent comment that carries the operative",
  "rejection decision. Return ONLY JSON.",
].join("\n");

/** The comment body under whatever field name a connector used. */
function bodyOf(row: CommentLike): string {
  return String(row.message ?? row.text ?? row.note ?? row.body ?? row.content ?? "").trim();
}

function buildRejectionPrompt(rows: CommentLike[]): string {
  const lines = rows.map((r, i) => {
    const when = r.entryDate ?? r.createdAt ?? r.timestamp ?? r.date ?? "";
    const status = r.status ?? r.decision ?? r.approvalStatus ?? "";
    return `#${i} ${when ? `[${when}] ` : ""}${status ? `(status: ${status}) ` : ""}${bodyOf(r) || "(no text)"}`;
  });
  return [
    "Comment/update history (most relevant is usually the latest substantive one):",
    ...lines,
    "",
    'Respond with JSON: { "rejected": boolean, "reason": string|null, "evidence": string|null }',
    "reason = the operative rejection text (or a short synthesis if the signal was a status field with no prose); null if not rejected.",
  ].join("\n");
}

/**
 * Decide whether a comment stream carries a rejection, preferring the LLM and
 * always falling back to the deterministic detectRejection.
 */
export async function detectRejectionLlm(
  rows: CommentLike[],
  client?: LlmClient | null,
): Promise<LlmRejectionResult> {
  const { client: resolvedClient, configError } = resolveLlmClient(client);
  if (!resolvedClient || !Array.isArray(rows) || rows.length === 0) {
    return {
      signal: detectRejection(rows),
      source: "deterministic",
      fallbackReason: configError ? `LLM misconfigured (${configError}); used the deterministic reader.` : null,
    };
  }
  try {
    const completion = await resolvedClient.complete({
      system: REJECTION_SYSTEM,
      prompt: buildRejectionPrompt(rows),
      temperature: 0,
      maxTokens: 512,
    });
    const parsed = extractJsonObject(completion.text) as {
      rejected?: unknown;
      reason?: unknown;
      evidence?: unknown;
    };
    if (typeof parsed.rejected !== "boolean") {
      throw new Error("LLM rejection JSON missing a boolean `rejected`");
    }
    const reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : null;
    // A "rejected: true" with no reason text is not actionable for triage -
    // treat the read as inconclusive and fall back rather than inventing one.
    if (parsed.rejected && !reason) {
      return {
        signal: detectRejection(rows),
        source: "deterministic",
        fallbackReason: "LLM flagged a rejection but returned no reason text; used the deterministic reader.",
      };
    }
    return {
      signal: {
        rejected: parsed.rejected,
        reason: parsed.rejected ? reason : null,
        source: parsed.rejected ? "text_signal" : "none",
        evidence: typeof parsed.evidence === "string" ? parsed.evidence : reason,
        considered: rows.length,
      },
      source: "llm",
      fallbackReason: null,
    };
  } catch (err) {
    return {
      signal: detectRejection(rows),
      source: "deterministic",
      fallbackReason: `LLM rejection read failed (${(err as Error).message}); used the deterministic reader.`,
    };
  }
}

// ── Triage (rejection text -> field findings) ───────────────────────────────

export type LlmTriageResult = {
  triage: TriageResult;
  source: Agent2Source;
  /** The model id when source === "llm", for AgentResponse.usage / the DB model column. */
  model: string | null;
  fallbackReason: string | null;
};

type RawFinding = { kind?: unknown; fieldKey?: unknown; proposed?: unknown; ask?: unknown; evidence?: unknown };

function fieldGuide(): string {
  return CAMPAIGN_BRIEF_FIELDS.map((f) => {
    const opts = f.options?.length ? ` | allowed: ${f.options.join(" / ")}` : "";
    return `- ${f.key}: ${f.label}${opts}`;
  }).join("\n");
}

const TRIAGE_SYSTEM = [
  "You translate a review-queue rejection into the specific brief field(s) to",
  "change, so a marketer confirms a fix instead of guessing at an 11-field form.",
  "For each distinct complaint, classify it:",
  '  "missing_field"     - a field is absent; the marketer must supply it;',
  '  "invalid_value"     - a field has a value the form does not allow; propose the closest allowed value;',
  '  "wrong_data_source" - the data is being read from the wrong place (FAC vs the AEP profile store);',
  '  "unclassified"      - real, but not reducible to a field; a human must read it.',
  "Only use the exact field keys given. Never invent a field or an allowed value.",
  "`ask` MUST explain WHY, not just state the fix - a marketer confirming this",
  "needs to understand the reasoning to trust it, not just see a new value",
  "appear. A bad ask: \"Change line_of_business to Residential (RES).\" A good",
  "ask: \"line_of_business was submitted as 'Resi', which isn't a valid option -",
  "changed to Residential (RES), the closest match.\" When the rejection gives a",
  "REASON (e.g. the audience is prospects, not existing customers), the ask",
  "must carry that reason forward, not just the resulting field change.",
  "Return ONLY JSON.",
].join("\n");

function buildTriagePrompt(reason: string, current: Record<string, string>): string {
  return [
    "Fields (use these exact keys; map values to an allowed option verbatim where listed):",
    fieldGuide(),
    "",
    `Current intake values: ${JSON.stringify(current)}`,
    "",
    `Rejection text: ${JSON.stringify(reason)}`,
    "",
    'Respond with JSON: { "findings": [ { "kind": "...", "fieldKey": "...|null", "proposed": "...|null", "ask": "one clear question or instruction", "evidence": "the words that led here" } ] }',
  ].join("\n");
}

/**
 * Turn raw model findings into validated TriageFindings. This is the "never
 * trust the model raw" gate:
 *   - an unknown `kind` is dropped;
 *   - a fieldKey that isn't a real FieldSpec is nulled;
 *   - a `proposed` value is kept ONLY if it validates via closestOption against
 *     that field's real options (an invented value degrades the finding to a
 *     plain question, exactly as the deterministic path would).
 */
export function validateFindings(raw: RawFinding[]): TriageFinding[] {
  const out: TriageFinding[] = [];
  for (const r of raw) {
    const kind = typeof r.kind === "string" ? (r.kind as RejectionKind) : "unclassified";
    if (!VALID_KINDS.has(kind)) continue;

    const keyRaw = typeof r.fieldKey === "string" ? r.fieldKey.trim() : "";
    const spec: FieldSpec | undefined = keyRaw ? fieldByKey(keyRaw) : undefined;
    const evidence = typeof r.evidence === "string" ? r.evidence : "";
    const askRaw = typeof r.ask === "string" && r.ask.trim() ? r.ask.trim() : null;

    // Validate a proposed value against the field's real options.
    let proposed: string | null = null;
    if (spec && typeof r.proposed === "string" && r.proposed.trim()) {
      proposed = spec.options?.length ? closestOption(spec, r.proposed.trim()) : r.proposed.trim();
    }

    out.push({
      kind,
      fieldKey: spec?.key ?? null,
      fieldLabel: spec?.label ?? null,
      proposed,
      ask: askRaw ?? spec?.ask ?? "A reviewer flagged this - please confirm the correction.",
      evidence,
    });
  }
  return out;
}

/** Rebuild redraft/changed/summary from validated findings, matching triageRejection's own assembly. */
function assemble(current: Record<string, string>, findings: TriageFinding[]): TriageResult {
  if (!findings.length) {
    // Nothing usable classified: same honest "a human must read it" outcome
    // triageRejection produces, so the shapes stay identical.
    return {
      findings: [
        {
          kind: "unclassified",
          fieldKey: null,
          fieldLabel: null,
          ask: "The rejection could not be mapped to a specific field, so it needs a person to read it.",
          evidence: "",
        },
      ],
      redraft: { ...current },
      changed: [],
      needsHuman: true,
      summary: "Could not translate this rejection into a field change.",
    };
  }

  const redraft: Record<string, string> = { ...current };
  const changed: string[] = [];
  for (const f of findings) {
    if (f.fieldKey && f.proposed) {
      redraft[f.fieldKey] = f.proposed;
      changed.push(f.fieldKey);
    }
  }
  const asks = findings.filter((f) => !f.proposed).length;
  const summary =
    [
      changed.length ? `${changed.length} field(s) corrected and ready to confirm` : "",
      asks ? `${asks} question(s) for the marketer` : "",
    ]
      .filter(Boolean)
      .join("; ") || "No change needed.";
  // needsHuman only when NOTHING could be corrected or asked concretely - i.e.
  // the sole finding is unclassified with no field. Otherwise it's actionable.
  const needsHuman = findings.every((f) => f.kind === "unclassified" && !f.fieldKey);
  return { findings, redraft, changed, needsHuman, summary };
}

/**
 * Translate a rejection into field findings, preferring the LLM and always
 * falling back to the deterministic triageRejection.
 */
export async function triageRejectionLlm(
  reason: string,
  current: Record<string, string> = {},
  client?: LlmClient | null,
): Promise<LlmTriageResult> {
  const text = String(reason || "").trim();
  const { client: resolvedClient, configError } = resolveLlmClient(client);
  if (!resolvedClient || !text) {
    return {
      triage: triageRejection(text, current),
      source: "deterministic",
      model: null,
      fallbackReason: configError ? `LLM misconfigured (${configError}); used the deterministic translator.` : null,
    };
  }
  try {
    const completion = await resolvedClient.complete({
      system: TRIAGE_SYSTEM,
      prompt: buildTriagePrompt(text, current),
      temperature: 0,
      maxTokens: 1024,
    });
    const parsed = extractJsonObject(completion.text) as { findings?: unknown };
    if (!Array.isArray(parsed.findings)) throw new Error("LLM triage JSON had no `findings` array");
    const findings = validateFindings(parsed.findings as RawFinding[]);
    if (!findings.length) {
      // Model produced nothing that survived validation - defer to the
      // deterministic translator rather than a bare "human must read it".
      return {
        triage: triageRejection(text, current),
        source: "deterministic",
        model: null,
        fallbackReason: "LLM triage produced no valid findings; used the deterministic translator.",
      };
    }
    return { triage: assemble(current, findings), source: "llm", model: completion.model, fallbackReason: null };
  } catch (err) {
    return {
      triage: triageRejection(text, current),
      source: "deterministic",
      model: null,
      fallbackReason: `LLM triage failed (${(err as Error).message}); used the deterministic translator.`,
    };
  }
}

// ── shared JSON extraction ──────────────────────────────────────────────────

/** Pull the first JSON object out of a response that may be fenced or prose-wrapped. */
export function extractJsonObject(text: string): Record<string, unknown> {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("empty LLM response");
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
  if (!candidate || candidate.indexOf("{") === -1) throw new Error("no JSON object in LLM response");
  return JSON.parse(candidate) as Record<string, unknown>;
}
