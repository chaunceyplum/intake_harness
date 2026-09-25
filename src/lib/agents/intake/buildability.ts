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
  /** The ATTRIBUTE_CUES key this filter maps to (aep.ts). */
  key: string;
  /** Plain-English name for the filter, for the question and the UI. */
  label: string;
  /** The one specific question to ask - and nothing else. */
  ask: string;
};

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
 */
export async function findUnmappableFilter(
  fields: Record<string, string>,
  brief: string | undefined,
  taskId: TaskId,
  sandbox?: string,
): Promise<UnmappableFilter | null> {
  const needed = neededAttributes(fields, brief);
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
    key: missingKey,
    label,
    ask:
      `The brief asks for ${label}, but that doesn't match a field we can check in customer data today. ` +
      "Which real field should we use instead - or should this condition be dropped?",
  };
}
