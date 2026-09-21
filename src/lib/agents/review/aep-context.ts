/**
 * What Review can tell Agent 3 - and a human reading the Workfront issue -
 * about AEP before the handoff: which attributes this audience will need
 * and whether they exist, whether an audience like this already exists,
 * which candidate profile datasets are even profile-enabled, and what the
 * knowledge base actually knows about expressing this in PQL.
 *
 * The first three are the SAME read-only questions Agent 3 asks in
 * lib/agents/audience/aep.ts, for the same reasons - asked one step
 * earlier, so the brief that reaches Agent 3 already answers them instead
 * of Agent 3 discovering the same facts from scratch. Nothing here writes
 * to AEP; see registry.ts for exactly why review's AEP allowlist stops at
 * list/get (no segment-estimate or query tools).
 */

import {
  probeSchemas,
  findExistingSegment,
  profileDatasetSummary,
  neededAttributes,
  criteriaKeywords,
  type SchemaProbe,
  type SegmentMatch,
  type DatasetProbe,
} from "@/lib/agents/audience/aep";
import { groundPqlGuidance, formatPqlGuidanceNote, type PqlGuidance } from "./pql-context";

/**
 * What to search existing segments for. IDENTICAL to
 * audience-creation/route.ts's `terms` on purpose - so Agent 3 can reuse
 * this match (via contextAccess) instead of repeating the search.
 *
 * Includes the audience's ACTUAL criteria keywords, not just the intake
 * categorization fields. This is the bug aep.ts's criteriaKeywords docstring
 * describes: a brief asking for "an audience where ECID exists" only ever
 * matches a real segment literally named "Has ECID" if "ecid" is one of the
 * words searched for - the categorization fields alone (campaign_name,
 * line_of_business, ...) never contain it. Review used to search the narrow
 * set and find nothing, so a reused match would have been uselessly empty.
 */
function segmentSearchTerms(fields: Record<string, string>, brief?: string): string[] {
  return [
    fields.campaign_name,
    fields.lifecycle_journey,
    fields.line_of_business,
    fields.customer_type,
    ...criteriaKeywords([brief, fields.audience_description].filter(Boolean).join(" ")),
  ]
    .filter(Boolean)
    .map(String);
}

export type AepContext = {
  neededAttributes: string[];
  schemaProbe: SchemaProbe;
  segmentTerms: string[];
  segmentMatch: SegmentMatch;
  datasetProbe: DatasetProbe;
  pqlGuidance: PqlGuidance;
};

/** Run all four reads for this brief, in parallel - each is independent and none writes anything. */
export async function gatherAepContext(fields: Record<string, string>, brief?: string): Promise<AepContext> {
  const neededAttrs = neededAttributes(fields, brief);
  const terms = segmentSearchTerms(fields, brief);
  // What the audience is actually FOR, in plain words - the same text
  // neededAttributes reads, since that's the criteria PQL would need to
  // express, not the intake-form categorization fields around it.
  const criteria = [brief, fields.audience_description].filter(Boolean).join(" ") || fields.campaign_name || "";
  const [schemaProbe, segmentMatch, datasetProbe, pqlGuidance] = await Promise.all([
    probeSchemas("review", neededAttrs),
    findExistingSegment("review", terms),
    profileDatasetSummary("review"),
    groundPqlGuidance("review", criteria),
  ]);
  return { neededAttributes: neededAttrs, schemaProbe, segmentTerms: terms, segmentMatch, datasetProbe, pqlGuidance };
}

/**
 * Turn gatherAepContext's result into readable text - the body of the
 * Workfront comment and the review-notes field write. Every line says
 * whether the underlying read was conclusive; an inconclusive read is
 * reported as exactly that, never silently dropped or guessed at (same
 * discipline as aep.ts's own SchemaProbe/DatasetProbe).
 */
export function formatAepContextNote(ctx: AepContext): string {
  const lines: string[] = ["Review — AEP context for Agent 3 (Audience Creation):"];

  if (!ctx.neededAttributes.length) {
    lines.push(
      "- This audience's own criteria don't reference any of the attributes we can check " +
        "(line of business, customer type, lifecycle journey, channels, region) - nothing to verify, " +
        "nothing to open a GTO request for.",
    );
  } else if (ctx.schemaProbe.conclusive) {
    const found = ctx.neededAttributes.filter((k) => ctx.schemaProbe.found[k]);
    const missing = ctx.neededAttributes.filter((k) => !ctx.schemaProbe.found[k]);
    lines.push(
      `- Attributes needed: ${ctx.neededAttributes.join(", ")}. Checked ${ctx.schemaProbe.fieldCount} field(s) ` +
        `across ${ctx.schemaProbe.schemasInspected} profile schema(s)` +
        (ctx.schemaProbe.fieldGroupsInspected
          ? ` and ${ctx.schemaProbe.fieldGroupsInspected} referenced field group(s)`
          : "") +
        (ctx.schemaProbe.sandbox ? ` in sandbox "${ctx.schemaProbe.sandbox}"` : "") +
        `. Present: ${found.join(", ") || "none"}.` +
        (missing.length ? ` Missing: ${missing.join(", ")}.` : ""),
    );
  } else {
    lines.push(
      `- BLOCKER — attribute availability could not be determined: ${ctx.schemaProbe.error} ` +
        "Not reporting anything as missing on the strength of that. Agent 3 cannot confirm a build " +
        "path from this and will default to one blindly - this is the read to fix, not a footnote.",
    );
  }

  if (ctx.segmentMatch.id) {
    lines.push(
      `- An existing audience may already cover this: "${ctx.segmentMatch.name}" (${ctx.segmentMatch.id}) - ` +
        `matched on: ${ctx.segmentMatch.matchedTerms.join(", ")}. Verify this is really the same audience.`,
    );
  } else if (ctx.segmentMatch.read) {
    lines.push(`- No existing audience matched this request (${ctx.segmentMatch.considered} checked).`);
  } else {
    lines.push(`- Could not check for an existing audience: ${ctx.segmentMatch.error}`);
  }

  if (ctx.datasetProbe.conclusive) {
    lines.push(
      ctx.datasetProbe.profileEnabled.length
        ? `- Profile-enabled dataset(s): ${ctx.datasetProbe.profileEnabled.map((d) => d.name).join(", ")}.`
        : `- No profile-enabled datasets found among ${ctx.datasetProbe.datasetCount} dataset(s) listed.`,
    );
  } else {
    lines.push(`- Could not determine which datasets are profile-enabled: ${ctx.datasetProbe.error}`);
  }

  lines.push(formatPqlGuidanceNote(ctx.pqlGuidance));

  return lines.join("\n");
}
