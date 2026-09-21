/**
 * Resolving Review's most expensive finding — "wrong data source" — from AEP,
 * instead of always handing it back to the marketer as an open question.
 *
 * triage.ts classifies a rejection and, when it decides the problem is FAC
 * vs. the profile store (`wrong_data_source`), it can only ASK: it is pure by
 * design and has never seen AEP. But Review already reads AEP one step later
 * (aep-context.ts / aep.ts's probeSchemas), and that same read can often
 * ANSWER the question triage could only pose:
 *
 *   - The brief names FAC/federated data, or targets prospects (who are not in
 *     the profile store at all) -> the answer is the federated path, decided
 *     from the brief alone, no probe needed.
 *   - Every attribute this audience needs is CONCLUSIVELY present in a
 *     profile-enabled schema -> the data is in the profile store and this
 *     builds in the rule builder. This is the only positive proof we accept.
 *   - Anything else — an inconclusive probe, or attributes conclusively
 *     ABSENT (which is genuinely ambiguous: build them in the profile store
 *     via a GTO request, or source them federated?) — stays a human decision,
 *     but now an evidence-backed one rather than a blank question.
 *
 * FAIL CLOSED, exactly like the rest of this agent's AEP handling: we only
 * ever auto-resolve to the profile store on direct evidence the fields exist
 * there. A wrongly-resolved data source is written into a Workfront redraft a
 * busy human confirms — silently wrong, which is worse than asking. This
 * module is PURE (no MCP, no I/O); the route feeds it the probe result.
 */

import type { SchemaProbe } from "@/lib/agents/audience/aep";
import type { TriageResult, TriageFinding } from "./triage";

/**
 * The intake field that records where the targeting data lives (see
 * campaign-brief.ts's `data_location`). A resolved source fills THIS field in
 * the redraft, so the answer flows through the same confirm-the-redraft
 * mechanism every other triage correction uses rather than a bespoke path.
 */
export const DATA_SOURCE_FIELD = "data_location";
const DATA_SOURCE_LABEL = "Where the targeting data lives";

/** Signals that settle the source from the brief alone, no schema read required. */
const FAC_SIGNAL = /\bfac\b|federated|data warehouse|snowflake|offline only/i;
const PROSPECT_SIGNAL = /prospect|non-?customer/i;

/**
 * Only the fields that actually SAY something about where the data lives or
 * who the audience is - never every field on the form.
 *
 * THE BUG THIS AVOIDS: this used to join every field's value indiscriminately
 * (Object.values(fields).join(" ")), so FAC_SIGNAL's bare `snowflake` matched
 * a campaign literally named "Snowflake Days Renewal Push" and auto-resolved
 * the source to FAC with zero real evidence - for an audience that had
 * nothing to do with a data warehouse. `campaign_name`, `offer`, `channels`,
 * and the rest of the form have no bearing on this question; scanning them
 * only manufactures false positives this module's own "FAIL CLOSED" docstring
 * exists to prevent.
 */
const DATA_SOURCE_RELEVANT_FIELDS = ["data_location", "data_availability", "audience_description", "customer_type", "exclusion"];

function relevantText(fields: Record<string, string>): string {
  return DATA_SOURCE_RELEVANT_FIELDS.map((k) => fields?.[k] || "").join(" ").toLowerCase();
}

export type DataSourceResolution =
  | {
      resolved: true;
      source: "profile_store" | "fac";
      /** The value written into the redraft's data_location field. */
      label: string;
      rationale: string;
      evidence: string[];
    }
  | {
      resolved: false;
      rationale: string;
      evidence: string[];
    };

/**
 * Decide the FAC-vs-profile-store question, or report honestly that it can't
 * be decided. `probe` is exactly what the route already computes for this
 * brief — the schema probe and the attributes the audience actually needs.
 */
export function resolveDataSource(
  fields: Record<string, string>,
  probe: { schemaProbe: SchemaProbe; neededAttributes: string[] },
): DataSourceResolution {
  const text = relevantText(fields || {});

  // Decided from the brief itself — the probe can't override an explicit ask.
  if (FAC_SIGNAL.test(text)) {
    return {
      resolved: true,
      source: "fac",
      label: "Federated (FAC)",
      rationale:
        "The brief names federated/FAC data explicitly, so the federated path is the answer, not a question.",
      evidence: [],
    };
  }
  if (PROSPECT_SIGNAL.test(text)) {
    return {
      resolved: true,
      source: "fac",
      label: "Federated (FAC)",
      rationale:
        "The audience is prospects/non-customers, who do not exist in the AEP profile store, so this is the " +
        "federated (FAC) path — the same reasoning decideBuildPath uses in aep.ts.",
      evidence: [],
    };
  }

  const { schemaProbe, neededAttributes } = probe;

  // Nothing checkable to anchor on: don't guess a source, ask a person.
  if (!neededAttributes.length) {
    return {
      resolved: false,
      rationale:
        "The audience's own criteria don't reference any attribute we can check against AEP schemas, so the " +
        "source can't be determined from schema data — a person has to decide.",
      evidence: [],
    };
  }

  // The whole safety property: an inconclusive probe never resolves anything.
  if (!schemaProbe.conclusive) {
    return {
      resolved: false,
      rationale:
        `Attribute availability could not be determined (${schemaProbe.error}), so the source is unconfirmed — ` +
        "resolving it either way would be guessing off our own failure to read AEP.",
      evidence: [],
    };
  }

  const present = neededAttributes.filter((k) => schemaProbe.found[k]);
  const missing = neededAttributes.filter((k) => !schemaProbe.found[k]);

  // The only positive proof we accept: the fields literally exist in a
  // profile-enabled schema, so the data is in the profile store.
  if (missing.length === 0) {
    return {
      resolved: true,
      source: "profile_store",
      label: "AEP profile store",
      rationale:
        `Every attribute this audience needs (${present.join(", ")}) is present in a profile-enabled schema` +
        (schemaProbe.sandbox ? ` in sandbox "${schemaProbe.sandbox}"` : "") +
        ", so the data is in the profile store and this builds in the AEP rule builder — no federated path needed.",
      evidence: schemaProbe.evidence,
    };
  }

  // Attributes conclusively ABSENT is ambiguous for the SOURCE question — they
  // might be built into the profile store (a B4 GTO request) or sourced
  // federated — so it stays a human decision, now with the evidence attached.
  return {
    resolved: false,
    rationale:
      (present.length ? `${present.join(", ")} present, but ` : "") +
      `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not in the profile store today. Whether to ` +
      `build ${missing.length === 1 ? "it" : "them"} there (a GTO attribute request) or source via the federated ` +
      "path is the decision to make.",
    evidence: schemaProbe.evidence,
  };
}

/** Summary line, in the exact shape triage.ts builds — kept in sync deliberately. */
function rebuildSummary(findings: TriageFinding[], changed: string[]): string {
  const asks = findings.filter((f) => !f.proposed).length;
  return (
    [
      changed.length ? `${changed.length} field(s) corrected and ready to confirm` : "",
      asks ? `${asks} question(s) for the marketer` : "",
    ]
      .filter(Boolean)
      .join("; ") || "No change needed."
  );
}

/**
 * Fold a resolution into a triage result.
 *
 * When resolved, the `wrong_data_source` finding stops being an open question:
 * it gains a `proposed` value, the redraft's data_location field is filled, and
 * the marketer confirms rather than answers. When unresolved, the finding stays
 * a question but carries the AEP evidence so the human isn't deciding blind.
 *
 * A no-op when there is no `wrong_data_source` finding to act on.
 */
export function applyDataSourceResolution(
  triage: TriageResult,
  resolution: DataSourceResolution,
): TriageResult {
  const idx = triage.findings.findIndex((f) => f.kind === "wrong_data_source");
  if (idx === -1) return triage;

  const finding = triage.findings[idx];
  const findings = [...triage.findings];

  if (resolution.resolved) {
    findings[idx] = {
      ...finding,
      fieldKey: DATA_SOURCE_FIELD,
      fieldLabel: DATA_SOURCE_LABEL,
      proposed: resolution.label,
      ask:
        `Data source resolved to ${resolution.label}: ${resolution.rationale} ` +
        "Confirm and it will be resubmitted on that path.",
    };
    const redraft = { ...triage.redraft, [DATA_SOURCE_FIELD]: resolution.label };
    const changed = triage.changed.includes(DATA_SOURCE_FIELD)
      ? triage.changed
      : [...triage.changed, DATA_SOURCE_FIELD];
    return {
      ...triage,
      findings,
      redraft,
      changed,
      needsHuman: false,
      summary: rebuildSummary(findings, changed),
    };
  }

  // Unresolved: keep it a question, but stop making the human decide blind.
  findings[idx] = {
    ...finding,
    ask: `${finding.ask} (Checked AEP: ${resolution.rationale})`,
  };
  return { ...triage, findings, summary: rebuildSummary(findings, triage.changed) };
}
