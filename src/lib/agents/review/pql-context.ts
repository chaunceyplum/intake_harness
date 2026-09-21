/**
 * Grounding "can this audience actually be expressed as a segment"
 * reasoning in real PQL (Profile Query Language) documentation - never
 * assumed or invented syntax. Used by BOTH Review (Agent 2, one step
 * before the handoff) and Audience Creation (Agent 3, where the rule
 * builder path actually needs this) - same question, same answer, asked
 * independently by each rather than trusted secondhand from the other
 * (same pattern as aep.ts's probeSchemas/findExistingSegment).
 *
 * WHAT THE KNOWLEDGE BASE ACTUALLY HAS - checked two ways, 19 Sep 2026:
 *
 * 1. Eight different semantic-search phrasings against search_adobe_knowledge
 *    (including operator/function names like "existsMulti", and a dedicated
 *    "pql" topic filter) all surfaced the same one or two documents -
 *    Segmentation Service and Query Service OVERVIEWS.
 * 2. That could still have been a search-quality problem rather than a
 *    content problem, so it was checked exhaustively instead of guessed at
 *    again: a direct SQL query against the RAG corpus itself (query_rag_db,
 *    an admin/diagnostic tool - not something this app calls, or should)
 *    for "PQL", "profile query language", "existsMulti", "segment
 *    expression", "pql/text", and every source_url containing "pql" or
 *    "query-service", across ALL FOUR indexed domains (adobe: 335 chunks,
 *    aws_sa: 5676, data_eng: 5949, martech: 4146 - 16,106 chunks total).
 *    Five documents matched, total, all under the "adobe" domain - the same
 *    two Segmentation/Query Service overview pages, one incidental
 *    authentication-guide hit, and the Query Service API reference (REST
 *    endpoints, not PQL syntax). Nothing under data_eng - the domain most
 *    likely to carry query-language reference material - mentions PQL at
 *    all.
 *
 * So the knowledge base is NOT the primary source here, on purpose - it has
 * no PQL syntax under any phrasing or domain, confirmed exhaustively, and
 * no amount of query rephrasing will change that (it needs real ingestion,
 * outside this repo). It's still queried below and reported honestly
 * (never silently dropped), because it occasionally surfaces something
 * relevant to the broader segmentation question even without PQL syntax -
 * but the PRIMARY source, the thing actually worth trusting for syntax, is
 * docs/pql-reference.md: a direct mirror of Adobe's own PQL function
 * reference (all 12 categories, captured from experienceleague.adobe.com
 * 19 Sep 2026), loaded fresh from disk below and attached to every run
 * that reaches this code, not just linked to from a note nobody opens.
 *
 * WHY IT'S READ FROM DISK, NOT INLINED AS A CONSTANT: keeping it as its own
 * markdown file means it stays human-editable and diffable (`git diff
 * docs/pql-reference.md` shows exactly what changed if Adobe's own docs
 * do). The cost of that is a real filesystem dependency at runtime, which
 * matters in this app's Docker deployment: `output: "standalone"` traces
 * which files actually need to ship, and a plain `fs.readFileSync` at a
 * repo-relative path isn't a guaranteed inclusion the way an `import` is -
 * confirmed empirically that Next's tracer DOES currently pick this
 * specific path up into .next/standalone/docs/ (it's a static string
 * literal, resolvable at build time), but the Dockerfile also COPYs docs/
 * into the runner stage explicitly rather than leaning on that as a
 * guarantee - it's tracer behavior, not a documented contract, and would
 * silently stop working the day this path is built dynamically instead of
 * being a literal. If that COPY line and the tracer both ever miss it,
 * loadPqlReference below fails closed (available: false, reason logged),
 * not silently.
 */

import fs from "node:fs";
import path from "node:path";
import { callMcpTool } from "@/lib/mcp-client";
import type { TaskId } from "@/lib/pipeline/types";

export type PqlHit = { title: string; url: string; excerpt: string };

export type PqlLocalReference = {
  available: boolean;
  /** Repo-relative, for a human reading metadata - never the absolute host path. */
  path: string;
  /** How many `##` function categories the file has - a cheap "is this the whole thing" sanity number, not a promise of exact function count. */
  categoryCount: number;
  /** The full file content, so it travels WITH the run rather than requiring someone to go find it separately. Null when unavailable. */
  content: string | null;
  /** Set only when `available` is false - what went wrong reading it. */
  error: string | null;
};

export type PqlGuidance = {
  grounded: boolean;
  reason: string | null;
  hits: PqlHit[];
  /** The primary source - see this file's docstring for why this outranks `hits`. */
  localReference: PqlLocalReference;
};

const PQL_REFERENCE_RELATIVE_PATH = "docs/pql-reference.md";

let cachedReference: PqlLocalReference | undefined;

/**
 * Read docs/pql-reference.md once per process and cache it - it's static
 * (checked into the repo, not per-request data), so re-reading it on every
 * call would be pure overhead. Fails closed: a missing file is reported as
 * `available: false` with the real error, never thrown past this function
 * and never silently treated as "no PQL guidance needed."
 *
 * Exported for evals/lib/fake-aep.ts: the PQL-synthesis eval needs a real
 * `PqlGuidance` grounded against the actual reference file, without paying
 * for (or depending on) a live `search_adobe_knowledge` MCP call just to
 * get `hits` - `hits` isn't the trusted source anyway (see this file's
 * module docstring for why the local reference outranks it).
 */
export function loadPqlReference(): PqlLocalReference {
  if (cachedReference) return cachedReference;
  const filePath = path.join(process.cwd(), PQL_REFERENCE_RELATIVE_PATH);
  try {
    const content = fs.readFileSync(filePath, "utf8");
    // Every "## " heading is a section; "Concepts" is general syntax, not a
    // function category, so it's excluded from the count this reports.
    const headings = [...content.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
    const categoryCount = headings.filter((h) => h !== "Concepts").length;
    cachedReference = { available: true, path: PQL_REFERENCE_RELATIVE_PATH, categoryCount, content, error: null };
  } catch (err) {
    console.error(
      `pql-context: could not read ${filePath} - PQL guidance will fall back to the (known-empty) knowledge base only. ` +
        "If this is a deployed container, check the Dockerfile still COPYs docs/ into the runner stage.",
      err,
    );
    cachedReference = {
      available: false,
      path: PQL_REFERENCE_RELATIVE_PATH,
      categoryCount: 0,
      content: null,
      error: (err as Error).message,
    };
  }
  return cachedReference;
}

/**
 * Ground THIS audience's criteria in real PQL material: the local
 * reference first (see docstring - it's the trustworthy one), the
 * knowledge base second (reported honestly, even though it's known to
 * carry no PQL syntax - see docstring).
 *
 * `taskId`: whichever pipeline task is actually calling this - "review" or
 * "audience_creation" today. Passed through to callMcpTool so the
 * allowlist check in mcp-client.ts, and the tool-call log, attribute this
 * call to the REAL caller - same reasoning as aep.ts's probeSchemas.
 */
export async function groundPqlGuidance(taskId: TaskId, criteria: string): Promise<PqlGuidance> {
  const localReference = loadPqlReference();
  const trimmed = criteria.trim();
  if (!trimmed) {
    return { grounded: false, reason: "no audience criteria to ground", hits: [], localReference };
  }
  try {
    const result = await callMcpTool<{ results?: Array<{ title: string; url: string; content: string }> }>(
      taskId,
      "search_adobe_knowledge",
      { query: `Profile Query Language PQL segment definition for ${trimmed}`, topic: "aep" },
    );
    const hits: PqlHit[] = (result?.results ?? []).slice(0, 3).map((r) => ({
      title: r.title,
      url: r.url,
      excerpt: r.content.slice(0, 400),
    }));
    return {
      grounded: hits.length > 0 || localReference.available,
      reason: hits.length ? null : "search_adobe_knowledge returned nothing for this audience's criteria",
      hits,
      localReference,
    };
  } catch (err) {
    return { grounded: localReference.available, reason: (err as Error).message, hits: [], localReference };
  }
}

/** The Workfront-comment/note line for whatever PQL grounding was found. */
export function formatPqlGuidanceNote(guidance: PqlGuidance): string {
  const lines: string[] = [];

  lines.push(
    guidance.localReference.available
      ? `- PQL function reference: ${guidance.localReference.path} (${guidance.localReference.categoryCount} categories, ` +
        "loaded at runtime, mirrors Adobe's own PQL docs). This is the material to build the segment expression " +
        "against - the knowledge base below has no PQL syntax indexed (verified exhaustively)."
      : `- Could not load the local PQL reference (${guidance.localReference.error}). Falling back to the knowledge base ` +
        "below only, which is known not to carry PQL syntax - confirm exact PQL expressions against Adobe's own docs " +
        "before building.",
  );

  lines.push(
    guidance.hits.length
      ? `- Knowledge base also surfaced: ${guidance.hits.map((h) => `"${h.title}" (${h.url})`).join(", ")} - overview-level, ` +
        "not operators/syntax."
      : `- Knowledge base: ${guidance.reason || "nothing surfaced for this audience's criteria"}.`,
  );

  return lines.join("\n");
}
