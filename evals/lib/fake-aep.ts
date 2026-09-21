/**
 * Fake AEP context for the PQL-synthesis eval, so it grades synthesizePql's
 * OUTPUT QUALITY against a known field set, without depending on (or
 * paying for) a live AEP schema probe - that's a separate concern, already
 * covered by aep.test.ts against real probe shapes.
 *
 * The PQL reference IS real (loaded from the actual docs/pql-reference.md
 * via the same loader pql-context.ts uses internally), not faked - grounding
 * against fake syntax would make the eval measure something no real run
 * ever does.
 */

import type { SchemaProbe } from "@/lib/agents/audience/aep";
import type { PqlGuidance } from "@/lib/agents/review/pql-context";
import { loadPqlReference } from "@/lib/agents/review/pql-context";

/** A conclusive probe reporting exactly `fields` as present - nothing more. */
export function fakeSchemaProbe(fields: string[]): SchemaProbe {
  const found: Record<string, boolean> = {};
  for (const f of fields) found[f] = true;
  return {
    read: true,
    conclusive: true,
    error: null,
    sandbox: "eval-fixture",
    schemaCount: 1,
    schemasInspected: 1,
    fieldGroupsInspected: 0,
    fieldCount: fields.length,
    found,
    evidence: fields,
  };
}

export function fakePqlGuidance(): PqlGuidance {
  return {
    grounded: true,
    reason: null,
    hits: [],
    localReference: loadPqlReference(),
  };
}
