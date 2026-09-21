/** The shape of a step's tool-call fields, loosely — every field here is optional because each agent's shape differs. */
export type ToolCallOutput = {
  grounding?: { grounded: boolean; reason: string | null; hits?: unknown };
  workfront?: { created?: boolean } & Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * The schema/field-group probe's shape in a task_run's `metadata` — reported
 * with the same field names by both Review and Audience Creation (see
 * aep.ts's SchemaProbe and each route's `metadata` block) so this one
 * component can render either.
 */
export type SchemaProbeMetadata = {
  schemasRead?: boolean;
  schemaProbeConclusive?: boolean;
  schemasReadError?: string | null;
  schemaCount?: number;
  schemasInspected?: number;
  fieldGroupsInspected?: number;
  fieldCount?: number;
  sandbox?: string | null;
  attributesNeeded?: string[];
  attributesMissing?: string[];
  // Which engine did the language work this step, and why it fell back if it
  // did - set by Intake (extractionSource), Review (triageEngine /
  // detectionEngine), and surfaced so "the LLM is on" is a visible fact, not a
  // belief. See each route's metadata block.
  extractionSource?: "llm" | "deterministic";
  extractionModel?: string | null;
  extractionFallbackReason?: string | null;
  triageEngine?: "llm" | "deterministic";
  detectionEngine?: "llm" | "deterministic";
  triageFallbackReason?: string | null;
  [key: string]: unknown;
};

/** A one-line "who did the language work" badge for a step, when an LLM was in play. */
function engineLine(metadata?: SchemaProbeMetadata): { engine: "llm" | "deterministic"; model: string | null; fallback: string | null } | null {
  if (!metadata) return null;
  // Intake reports extractionSource; Review reports triageEngine (and
  // detectionEngine). Take whichever this step actually set.
  const engine = metadata.extractionSource ?? metadata.triageEngine ?? metadata.detectionEngine;
  if (!engine) return null;
  return {
    engine,
    model: metadata.extractionModel ?? null,
    fallback: metadata.extractionFallbackReason ?? metadata.triageFallbackReason ?? null,
  };
}

/**
 * The tool calls one agent step made, terminal-style: the call (→) and its
 * outcome (←) on their own lines, so a scan tells call from result without
 * reading prose or opening the raw JSON dump. Shared between the live chat
 * trace (pipeline-chat.tsx, a run in progress) and the Runs page
 * (runs-browser.tsx, browsing history) so the same step reads the same way
 * whether you're watching it happen or looking at it afterward.
 */
export function ToolCallTrace({ output, metadata }: { output: ToolCallOutput; metadata?: SchemaProbeMetadata }) {
  const conclusive = metadata?.schemaProbeConclusive;
  const schemasInspected = metadata?.schemasInspected ?? 0;
  const fieldGroupsInspected = metadata?.fieldGroupsInspected ?? 0;
  const engine = engineLine(metadata);
  const pqlSynthesis = (metadata as { pqlSynthesis?: { synthesized?: boolean; reason?: string | null; fieldsUsed?: string[] } | null } | undefined)?.pqlSynthesis;
  const segmentCreation = (metadata as { segmentCreation?: { attempted?: boolean; created?: boolean } | null } | undefined)?.segmentCreation;

  return (
    <>
      {/* Who did the language work this step — visible so "the LLM is on" is a
          fact, not a belief. Green when the model ran, zinc when the
          deterministic parser did (with the reason it fell back). */}
      {engine && (
        <div className="rounded-lg bg-zinc-900 p-2 font-mono text-xs">
          <div className={engine.engine === "llm" ? "text-green-400" : "text-zinc-400"}>
            {engine.engine === "llm"
              ? `⚡ LLM${engine.model ? ` (${engine.model})` : ""}`
              : "⚙ deterministic parser"}
          </div>
          {engine.engine === "deterministic" && engine.fallback && (
            <div className="text-amber-400">← fell back: {engine.fallback}</div>
          )}
        </div>
      )}

      {output.grounding && (
        <div className="rounded-lg bg-zinc-900 p-2 font-mono text-xs">
          <div className="text-blue-300">→ search_adobe_knowledge</div>
          <div className={output.grounding.grounded ? "text-green-400" : "text-amber-400"}>
            ← {output.grounding.grounded ? "grounded" : `ungrounded — ${output.grounding.reason}`}
          </div>
        </div>
      )}
      {output.workfront && (
        <div className="rounded-lg bg-zinc-900 p-2 font-mono text-xs">
          <div className="text-blue-300">→ create_workfront_intake</div>
          <div className={output.workfront.created ? "text-green-400" : "text-amber-400"}>
            ← {output.workfront.created ? "created" : "dry run — not created"}
          </div>
        </div>
      )}

      {/* Agent 3's PQL synthesis + (opt-in) segment creation. A drafted-and-
          verified expression reads green; a rejected/undrafted one reads amber
          with the reason. */}
      {pqlSynthesis && (
        <div className="rounded-lg bg-zinc-900 p-2 font-mono text-xs">
          <div className="text-blue-300">→ synthesize_pql</div>
          <div className={pqlSynthesis.synthesized ? "text-green-400" : "text-amber-400"}>
            ← {pqlSynthesis.synthesized
              ? `drafted & verified${pqlSynthesis.fieldsUsed?.length ? ` (${pqlSynthesis.fieldsUsed.join(", ")})` : ""}`
              : `no expression — ${pqlSynthesis.reason}`}
          </div>
          {pqlSynthesis.synthesized && segmentCreation?.attempted && (
            <div className={segmentCreation.created ? "text-green-400" : "text-amber-400"}>
              ← segment {segmentCreation.created ? "created" : "not created (dry run / write disabled)"}
            </div>
          )}
        </div>
      )}

      {/*
       * The schema/field-group probe: whichever build-path or attribute
       * decision follows depends ENTIRELY on this read, so it gets its own
       * caption and a visibly different treatment when inconclusive — a
       * bordered amber block, not just another dark terminal line — rather
       * than reading as routine as the grounding/workfront calls above.
       */}
      {typeof conclusive === "boolean" && (
        <div className="flex flex-col gap-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
            Schema field check — Agent 3&apos;s build path depends on this
          </p>
          <div
            className={`rounded-lg p-2 font-mono text-xs ${
              conclusive ? "bg-zinc-900" : "border-2 border-amber-500 bg-amber-950"
            }`}
          >
            <div className="text-blue-300">
              → adobe_list_schemas → adobe_get_schema ×{schemasInspected}
              {fieldGroupsInspected > 0 ? ` → adobe_get_field_group ×${fieldGroupsInspected}` : ""}
            </div>
            {conclusive ? (
              <div className="text-green-400">
                ← {metadata?.fieldCount ?? 0} field(s) found across {schemasInspected} schema(s)
                {fieldGroupsInspected > 0 ? ` + ${fieldGroupsInspected} field group(s)` : ""}
                {metadata?.sandbox ? ` in sandbox "${metadata.sandbox}"` : ""}.
                {metadata?.attributesNeeded?.length
                  ? ` Needed: ${metadata.attributesNeeded.join(", ")}.` +
                    (metadata?.attributesMissing?.length
                      ? ` Missing: ${metadata.attributesMissing.join(", ")}.`
                      : " All present.")
                  : // Nothing was recognized as needing a check - vacuously
                    // "conclusive", but that is NOT the same as "all
                    // present". See aep.ts's probeSchemas docstring: 0
                    // checked means nothing about this brief mapped to a
                    // known attribute, not that everything was verified.
                    " Nothing recognized to check against this audience's own criteria."}
              </div>
            ) : (
              <div className="font-bold text-amber-300">
                ← BLOCKER — could not determine field availability: {metadata?.schemasReadError}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
