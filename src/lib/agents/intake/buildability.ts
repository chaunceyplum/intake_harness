/**
 * Can this brief even be built - not "is the form complete," but "does
 * every filter it names resolve to a real field in customer data?"
 *
 * Explicit product direction for the executive demo: campaign name,
 * business objective, customer type, line of business, request type, and
 * launch date are all optional now (see campaign-brief.ts) - Intake infers
 * what it can and proceeds. The ONLY thing left that should still pause a
 * run is a filter the brief names that has no matching field at all, e.g.
 * "SEP-eligible" when nothing in AEP looks like a SEP-eligibility flag.
 * Never silently drop that condition and build a broader audience instead -
 * say which one and pause, naming exactly it.
 *
 * Reuses the SAME schema probe Review and Audience Creation already run
 * (aep.ts's neededAttributes/probeSchemas) rather than re-deriving "does
 * this filter exist" a third way - one answer, asked the same way,
 * wherever it's asked. Inherits that probe's own safety property for free:
 * an INCONCLUSIVE read (could not reach field-level data) is not a missing
 * filter. Intake pausing on its own failure to look would be exactly the
 * bug aep.ts's SchemaProbe.conclusive exists to prevent, one step earlier
 * in the pipeline than where it was first caught.
 */

import { neededAttributes, probeSchemas } from "@/lib/agents/audience/aep";
import type { TaskId } from "@/lib/pipeline/types";

export type UnmappableFilter = {
  /** The question key: FILTER_ANSWER_PREFIX + the ATTRIBUTE_CUES key this filter maps to (aep.ts). */
  key: string;
  /** Plain-English name for the filter, for the question and the UI. */
  label: string;
  /** The one specific question to ask - and nothing else. */
  ask: string;
};

/**
 * The question key Intake asks an unmappable filter under: `filter:<cue key>`.
 * Prefixed so the answer never lands in a real intake field of the same name
 * (line_of_business, customer_type...) and is recognisable next round - the
 * resume route merges answers into `fields` by question key.
 */
export const FILTER_ANSWER_PREFIX = "filter:";

/**
 * The marketer's answers to earlier "this filter doesn't map" questions,
 * keyed by cue key ({ region: "drop it" }). An answered filter is settled -
 * asking it again is what used to loop a run into the loop limit, since the
 * brief still names it every round. Blank answers don't count.
 */
export function readFilterAnswers(fields: Record<string, unknown> | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    const answer = String(v ?? "").trim();
    if (k.startsWith(FILTER_ANSWER_PREFIX) && answer) out[k.slice(FILTER_ANSWER_PREFIX.length)] = answer;
  }
  return out;
}

/**
 * The answers as instructions for PQL synthesis (its `decisions` section,
 * which overrides the brief's criteria): "drop it" leaves the condition
 * out, a named field is used for it.
 */
export function filterAnswerNotes(answers: Record<string, string>): string {
  return Object.entries(answers)
    .map(([key, answer]) => {
      const label = FILTER_LABELS[key] ?? key.replace(/_/g, " ");
      return `- ${label}: no field in customer data matches it. The marketer answered: "${answer}". ` +
        "If that means drop it, leave it out entirely; if it names a field, use that field for it.";
    })
    .join("\n");
}

/** aep.ts's ATTRIBUTE_CUES keys, in plain marketer-facing words. */
const FILTER_LABELS: Record<string, string> = {
  line_of_business: "line of business",
  customer_type: "customer type (subscriber vs. prospect)",
  lifecycle_journey: "lifecycle stage",
  channels: "a contact channel (email, phone, etc.)",
  region: "region or market",
  identity: "a stable identity attribute (e.g. a valid email or ECID)",
  product_ownership: "product ownership (TV, Internet, or Mobile)",
};

/**
 * The one filter (if any) this brief asks for that has no matching field in
 * customer data - Intake's only remaining reason to pause.
 *
 * @param fields  the intake fields extracted so far
 * @param brief   the marketer's own words
 * @param taskId  which pipeline task is calling (enforces the MCP allowlist)
 * @param sandbox Demo mode's explicit "tapdemo" override; omitted in Governed mode
 * @param answered cue keys the marketer already answered (readFilterAnswers) - never asked again
 */
export async function findUnmappableFilter(
  fields: Record<string, string>,
  brief: string | undefined,
  taskId: TaskId,
  sandbox?: string,
  answered: string[] = [],
): Promise<UnmappableFilter | null> {
  const needed = neededAttributes(fields, brief).filter((k) => !answered.includes(k));
  // Nothing in the brief maps to a checkable attribute category at all -
  // nothing to probe for, and nothing to block on. The common case, and
  // cheap: zero MCP calls.
  if (!needed.length) return null;

  const probe = await probeSchemas(taskId, needed, sandbox);
  // Could not obtain field-level data at all - unknown, not missing. Same
  // rule Agent 3 already enforces (aep.ts's docstring on SchemaProbe).
  if (!probe.conclusive) return null;

  const missingKey = needed.find((k) => !probe.found[k]);
  if (!missingKey) return null;

  const label = FILTER_LABELS[missingKey] ?? missingKey.replace(/_/g, " ");
  return {
    key: `${FILTER_ANSWER_PREFIX}${missingKey}`,
    label,
    ask:
      `The brief asks for ${label}, but that doesn't match a field we can check in customer data today. ` +
      "Which real field should we use instead - or should this condition be dropped?",
  };
}
