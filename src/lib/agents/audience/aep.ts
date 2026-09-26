/**
 * What AEP can actually answer about an audience, before anyone builds it.
 *
 * Agent 3's blockers are all versions of one question - "what will this
 * audience be, and can this platform even express it?" - asked BEFORE the
 * nightly job at 21:45, because after that every mistake costs a day (B6).
 *
 * Every function here is a READ. Nothing creates a segment.
 *
 * COUNT ESTIMATION IS BACK, RE-ADDED ON EXPLICIT PRODUCT DIRECTION (see
 * estimateSegmentSize below), after having been removed entirely: verified
 * live against 4 different real, valid segment IDs (confirmed valid via
 * adobe_get_segment), the estimate tool 404s identically on every one,
 * because it hits the wrong upstream URL (a .../estimate suffix the
 * gateway's adobe_get_segment path does not use) - a bug in the gateway's
 * tool, not this app, and not fixable from here. Rather than leave the call
 * site removed forever, it is tried again: any failure - the known 404
 * included - is caught and reported as "not available", never a run-failing
 * error and never a fabricated count. The day the gateway bug is fixed, this
 * starts reporting a real number with nothing else to change.
 *
 * Tool names and argument shapes below are verified against the live server -
 * 238 tools, tools/list read 16 Sep 2026. Every one of these takes an optional
 * `sandbox`, and none of them have required arguments.
 *
 * PROBING PREFERS THE UNION VIEW. probeSchemas now asks
 * adobe_get_union_schema for the profile class's merged field set FIRST -
 * one call that returns every profile field the sandbox actually holds,
 * flattened - and only falls back to listing and sampling individual
 * schemas when that view is empty or unavailable. That replaces "sample 6
 * schemas and hope the field is in one of them" with "ask for the whole
 * union once", which is both cheaper and structurally unable to miss a
 * field by sampling wrong (the failure mode SCHEMA_SAMPLE was bumped 3->6
 * to mitigate). See PROFILE_UNION_CLASS.
 */

import { callMcpTool } from "@/lib/mcp-client";
import type { TaskId } from "@/lib/pipeline/types";

/**
 * Attributes we can recognise, matched against SCHEMA FIELD NAMES.
 *
 * Word-anchored on purpose. The first version used `lob` unanchored, and it
 * matched "glob" inside "https://.../global/schemas?limit=50" - so it reported
 * line-of-business as AVAILABLE on the strength of a substring in a URL. A
 * false positive here is worse than a false negative: it claims an audience can
 * be built when it cannot.
 *
 * `identity` and `product_ownership` were added after a real run asked for
 * "an audience where ECID exists" and this agent opened GTO requests for
 * line_of_business/customer_type instead - fields nothing about that ask
 * needed, because the only cues that existed were the intake-form baseline
 * categories, not what the brief actually said. Both are grounded in real
 * field names seen live this session, not guessed: `xfinityTV`/
 * `xfinityInternet` appeared as the literal trailing segment of a real
 * segment's PQL field path (`_taplondonptrsd.xfinityTV`), and `customerEmail`
 * as a real schema property, in this tenant's own sandbox. Adding a cue for
 * a concept never verified against a real field name would repeat the exact
 * mistake this file exists to prevent - a category that matches the brief but
 * can never be confirmed present.
 */
export const ATTRIBUTE_CUES: Record<string, RegExp> = {
  line_of_business: /(^|[^a-z])(lineofbusiness|line_of_business|lob|businessunit|business_unit)([^a-z]|$)/i,
  customer_type: /(^|[^a-z])(customertype|customer_type|subscriberstatus|subscriber_status|accountstatus|account_status)([^a-z]|$)/i,
  lifecycle_journey: /(^|[^a-z])(lifecycle|lifecyclestage|lifecycle_stage|journeystage|journey_stage)([^a-z]|$)/i,
  // "email address" in prose, and customerEmail/personalEmail as the leaf
  // field names this tenant actually uses - a bare "email" still does not trip it.
  channels: /(^|[^a-z])(channel|emailaddress|email_address|email\s+address|customeremail|personalemail|phonenumber|phone_number|mobilephone)([^a-z]|$)/i,
  region: /(^|[^a-z])(region|state|market|geo|postalcode|postal_code)([^a-z]|$)/i,
  // ECID/identity presence - distinct from "channels", which is about WHICH
  // channel to send on, not whether an identity attribute exists on the
  // profile to target against.
  identity: /(^|[^a-z])(ecid|mcid|experience\s?cloud\s?id|identitymap|identity_map)([^a-z]|$)/i,
  // Product/service ownership - xfinitytv/xfinityinternet/xfinitymobile are
  // real field names in this tenant (see docstring above); internet/tv/
  // broadband/television cover briefs that describe the same thing by the
  // product's common name rather than the schema's field name.
  product_ownership: /(^|[^a-z])(xfinitytv|xfinityinternet|xfinitymobile|broadband|television|\btv\b|\binternet\b)([^a-z]|$)/i,
};

/**
 * Which AEP profile attributes THIS audience's own criteria actually
 * reference - never assumed just because an intake field happens to be
 * populated. Intake requires campaign_name/business_objective/customer_type/
 * line_of_business/launch_date for every request (Workfront/reporting
 * needs), not because every audience is built on them - "an audience where
 * ECID exists" needs none of that, and used to get customer_type and
 * line_of_business checked anyway because they were hardcoded as an
 * always-required baseline.
 *
 * THE BUG THIS FIXES: that hardcoded baseline meant EVERY request checked
 * customer_type/line_of_business whether the ask needed them or not. When
 * they came back missing (they're intake-form concepts, not necessarily
 * literal AEP schema field names), a GTO attribute request opened for
 * fields nothing about the actual ask required - the quarter-long tail B4
 * exists to avoid, spent on nothing. See this function's test coverage in
 * aep.test.ts for the exact regression this guards against.
 *
 * Single implementation, used by BOTH audience-creation/route.ts (Agent 3)
 * and review/aep-context.ts (Agent 2) - it used to be two byte-identical
 * private copies, one per file, which is exactly the kind of duplication
 * that drifts silently: a fix applied to one and not the other would have
 * reintroduced this same bug in whichever file got missed.
 */
export function neededAttributes(fields: Record<string, string>, brief?: string): string[] {
  const text = [brief, fields.audience_description, fields.exclusion].filter(Boolean).join(" ");
  const needed = new Set<string>();
  for (const [key, cue] of Object.entries(ATTRIBUTE_CUES)) {
    if (cue.test(text)) needed.add(key);
  }
  return [...needed];
}

/**
 * Generic request/audience-request vocabulary, excluded from
 * criteriaKeywords below so it can't spuriously match an unrelated
 * segment's name. Deliberately NOT exhaustive - just the words common
 * enough across audience requests that a false-positive collision with a
 * real segment name is plausible (a segment literally named "Audience
 * Composition Test" would otherwise "match" every brief that says
 * "audience").
 */
const REQUEST_STOPWORDS = new Set([
  "the", "and", "for", "that", "with", "this", "from", "into", "where", "audience", "audiences",
  "create", "created", "activate", "activated", "activation", "custom", "destination", "campaign",
  "exist", "exists", "existing", "need", "needs", "want", "wants", "build", "please",
]);

/** Words that never name a field on their own - a brief phrase may not start or end on one. */
const CRITERIA_STOPWORDS = new Set([
  ...REQUEST_STOPWORDS,
  "a", "an", "of", "or", "is", "are", "be", "in", "on", "to", "by", "who", "have", "has", "not", "all", "any",
  "their", "them", "they", "profile", "profiles", "customer", "customers", "people", "users",
]);

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/s$/, "");

/**
 * Fields the brief names by what they're called, beyond the fixed cues above.
 *
 * ATTRIBUTE_CUES only knows the categories someone thought to write down, so
 * "SEP eligible" matched nothing and the tenant's real `SEPeligible` field was
 * never looked for. This reads the brief the way a person scanning the
 * schema would: every 1-3 word phrase, run together, compared to each field's
 * leaf name with case and punctuation ignored ("SEP eligible" ->
 * "sepeligible" == `SEPeligible`; "email address" == `emailAddress`).
 * Exact-match only - no substring or fuzzy match - so a field only turns up
 * when the brief really does name it. Single words need 4+ letters, and no
 * phrase starts or ends on a stopword, so "are" or "profiles" never match.
 */
export function matchCriteriaFields(criteria: string, fields: ProfileField[]): ProfileField[] {
  const words = String(criteria || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const phrases = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 3 && i + n <= words.length; n++) {
      const run = words.slice(i, i + n);
      if (CRITERIA_STOPWORDS.has(run[0]) || CRITERIA_STOPWORDS.has(run[n - 1])) continue;
      if (n === 1 && run[0].length < 4) continue;
      phrases.add(normalize(run.join("")));
    }
  }
  // A field whose TITLE's words all appear in the brief is the strongest
  // match: "email address is not valid" names no path, but every word of
  // "Valid email address flag" is in it. Without this, 12 loosely matching
  // `email` leaves filled every hint slot and the model missed validEmailFlag
  // (plain-English eval, 26 Sep 2026). Two title words minimum, so a bare
  // "Email" title stays a leaf-level match.
  const briefWords = new Set(words);
  const titleWords = (f: ProfileField) =>
    String(f.title ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !TITLE_FILLER.has(w));
  const titleHit = (f: ProfileField) => {
    const t = titleWords(f);
    return t.length >= 2 && t.every((w) => briefWords.has(w));
  };
  const hits = fields.filter((f) => titleHit(f) || phrases.has(normalize(leafOf(f.path))));
  return [...hits.filter(titleHit), ...hits.filter((f) => !titleHit(f))].slice(0, 12);
}

/** Title words that carry no meaning of their own ("Is CBM member", "Valid email address flag"). */
const TITLE_FILLER = new Set(["is", "has", "flag", "the", "a", "an", "of", "y", "n"]);

/**
 * Meaningful, distinctive words from a brief/audience description - the
 * vocabulary an existing, already-built segment's own NAME is likely to
 * share if it really is the same audience. See findExistingSegment's
 * callers for why this matters: a brief asking for "an audience where ECID
 * exists" only ever finds a real segment literally named "Has ECID" if
 * "ecid" is one of the words being searched for.
 */
export function criteriaKeywords(text: string): string[] {
  const words = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !REQUEST_STOPWORDS.has(w));
  return [...new Set(words)];
}

/** Schema titles worth opening: the ones that would carry profile attributes. */
const PROFILE_SCHEMA_HINT = /profile|individual|customer|account|subscriber|person|demographic/i;

/**
 * The XDM Profile class every profile-enabled schema in a sandbox extends.
 *
 * adobe_get_union_schema resolves the MERGED view of every schema composed
 * on this class - i.e. every profile field the whole sandbox actually holds,
 * already flattened, field groups and all. That is a far more complete and
 * far cheaper answer to "does attribute X exist" than sampling a handful of
 * individual schemas and hoping the field lives in one of them: it is ONE
 * call that cannot miss a field by sampling the wrong schema. The per-schema
 * walk below stays as a fallback for the case where the union view is empty
 * or the tool is unavailable, so this only ever makes the probe MORE
 * conclusive, never less.
 */
const PROFILE_UNION_CLASS = "https://ns.adobe.com/xdm/context/profile";

/**
 * How many schemas to open. Each is a network call, and this is THE tool
 * call this whole probe lives or dies on - miss every field on a small
 * sample and the result is "inconclusive", which Agent 3 then has no choice
 * but to build around blindly (see decideBuildPath's default-to-rule-builder
 * branch). Raised from 3 to 6 after exactly that happened on a real run: the
 * 3 sampled schemas were real XDM class schemas that compose their fields
 * via `allOf`/`$ref` field groups rather than inline `properties` (see
 * fieldGroupRefs/fieldNames below), so a bigger sample alone would not have
 * saved that run - field-group resolution is the actual fix, this is the
 * cheap second line of defense.
 */
const SCHEMA_SAMPLE = 6;

/**
 * How many referenced field groups to open per schema. XDM class schemas
 * (Profile, ExperienceEvent) rarely carry attributes inline - they compose
 * them from field groups via `allOf: [{ $ref: "..." }, ...]`, and a class
 * schema's OWN document has no `properties` at all for those. Capped so one
 * schema with many field groups cannot turn this into an unbounded fan-out.
 */
const FIELD_GROUP_SAMPLE = 6;

export type SchemaProbe = {
  /** Did the schema LIST read succeed? */
  read: boolean;
  /**
   * Did we actually obtain field-level data?
   *
   * This is the field that matters, and here is why it exists: the first version
   * matched attribute names against schema TITLES, which do not contain field
   * names at all, so it reported every attribute as missing - and on the
   * strength of that it opened a GTO attribute request, the quarter-long tail,
   * for a question it had never actually asked. Inconclusive has to be its own
   * state, distinct from both available and missing.
   */
  conclusive: boolean;
  error: string | null;
  /** The AEP sandbox these schemas came from, read off the schema ids. */
  sandbox: string | null;
  schemaCount: number;
  /** How many schemas we opened and walked. */
  schemasInspected: number;
  /** How many referenced field groups we additionally opened - see fieldGroupRefs. */
  fieldGroupsInspected: number;
  /** How many distinct field names we saw. */
  fieldCount: number;
  found: Record<string, boolean>;
  /** Full dotted paths of the fields that answered - cue hits, then fields the brief names (matchCriteriaFields). */
  evidence: string[];
  /** XDM type of each evidence path, so PQL compares a boolean to true rather than "true". */
  fieldTypes?: Record<string, string | null>;
  /**
   * The schema's own description of each evidence path, when it has one. A
   * string flag's values live only here - tapdemo's SEPeligible is a string
   * described "Y/N flag", and without that PQL can only guess "true".
   */
  fieldDescriptions?: Record<string, string>;
};

/** Titles and ids from the schema list. */
function schemaRecords(result: unknown): Array<{ title: string; id: string }> {
  const out: Array<{ title: string; id: string }> = [];
  const walk = (v: unknown, depth = 0) => {
    if (depth > 5 || v == null) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      const id = String(o.$id || o["meta:altId"] || "");
      const title = String(o.title || "");
      if (id && title) out.push({ title, id });
      for (const val of Object.values(o)) walk(val, depth + 1);
    }
  };
  walk(result);
  return out;
}

/** Every property name in a schema (or field group) document, however deeply nested. */
/** A profile field as PQL addresses it: full dotted path, XDM type, and the schema's own description of it. */
export type ProfileField = {
  path: string;
  type: string | null;
  description?: string | null;
  /** The schema's display title ("Is CBM member") - how a person, and the brief, names the field. */
  title?: string | null;
  /** Allowed values when the schema enumerates them (`meta:enum` labels, else `enum`). */
  values?: string[] | null;
  /** The schema marks it `meta:status: deprecated` - left out of PQL synthesis's field list. */
  deprecated?: boolean;
};

/**
 * Every field under a schema/field-group document, with its full dotted path
 * (`_taplondonptrsd.SEPeligible`, not just `SEPeligible`) - PQL needs the
 * path, and only the path tells two same-named leaves apart. Path segments
 * come from `properties` keys only, so wrappers like `definitions.customFields`
 * and `allOf` never leak into it.
 */
export function fieldEntries(schema: unknown, prefix = ""): ProfileField[] {
  return walkFields(schema, prefix).fields;
}

/**
 * fieldEntries plus the data-type links it could not expand itself.
 *
 * Adobe's standard field groups describe most fields by reference -
 * `personalEmail` is `{ $ref: ".../xdm/context/email" }` and `homeAddress`
 * is `{ $ref: ".../xdm/common/address" }` - so walking the group alone
 * yields `personalEmail` but never `personalEmail.address`. `refs` names
 * each such link with the path it hangs under, for probeSchemas'
 * catalog build to resolve and graft.
 */
function walkFields(schema: unknown, prefix = ""): { fields: ProfileField[]; refs: Array<{ path: string; ref: string }> } {
  const out = new Map<string, ProfileField>();
  const refs: Array<{ path: string; ref: string }> = [];
  const walk = (v: unknown, at: string, depth: number) => {
    if (depth > 16 || v == null || typeof v !== "object") return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, at, depth + 1)); return; }
    const o = v as Record<string, unknown>;
    const props = o.properties;
    if (props && typeof props === "object") {
      for (const [key, child] of Object.entries(props as Record<string, unknown>)) {
        const path = at ? `${at}.${key}` : key;
        const c = (child && typeof child === "object" ? child : {}) as Record<string, unknown>;
        if (!out.has(path)) {
          const labels = c["meta:enum"] && typeof c["meta:enum"] === "object"
            ? Object.keys(c["meta:enum"] as Record<string, unknown>)
            : Array.isArray(c.enum) ? (c.enum as unknown[]).map(String) : [];
          out.set(path, {
            path,
            type: String(c["meta:xdmType"] ?? c.type ?? "") || null,
            description: String(c.description ?? "").trim() || null,
            title: String(c.title ?? "").trim() || null,
            values: labels.length ? labels : null,
            ...(c["meta:status"] === "deprecated" ? { deprecated: true } : {}),
          });
        }
        const items = c.items && typeof c.items === "object" ? (c.items as Record<string, unknown>) : null;
        const ref = typeof c.$ref === "string" ? c.$ref : typeof items?.$ref === "string" ? String(items.$ref) : "";
        if (ref && !c.properties && !items?.properties) refs.push({ path, ref });
        walk(child, path, depth + 1);
      }
    }
    for (const [key, val] of Object.entries(o)) {
      if (key !== "properties" && val && typeof val === "object") walk(val, at, depth + 1);
    }
  };
  walk(schema, prefix, 0);
  return { fields: [...out.values()], refs };
}

function leafOf(path: string): string {
  return path.split(".").pop() || path;
}

/**
 * The field-group `$ref`s a CLASS-based schema composes via `allOf`.
 *
 * A real XDM Profile/ExperienceEvent schema's own document usually has no
 * inline `properties` at all - it lists `allOf: [{ $ref: ".../xdm/context/
 * profile" }, { $ref: ".../mixins/profile/loyalty" }, ...]` and the actual
 * attributes live in each referenced field group's OWN document. Reading
 * only the class schema and finding zero properties is not "this tenant has
 * no fields" - it's "we asked the wrong document." Excludes Adobe's own
 * base class refs (ns.adobe.com/xdm/context/...), which are never a
 * tenant's custom attributes and are not fetchable the same way a
 * tenant-registered field group is.
 */
function fieldGroupRefs(schema: unknown, includeStandard = false): string[] {
  const refs = new Set<string>();
  // The union also lists Adobe's standard profile field groups
  // (xdm/context/profile-personal-details: personalEmail, homeAddress, ...).
  // Those are fetchable as field groups; only the Profile class itself and
  // xdm/data/* are not.
  const skip = includeStandard
    ? (ref: string) => /ns\.adobe\.com\/xdm\/data\//.test(ref) || /ns\.adobe\.com\/xdm\/context\/profile$/.test(ref)
    : (ref: string) => /ns\.adobe\.com\/xdm\/(context|data)\//.test(ref);
  const walk = (v: unknown, depth = 0) => {
    if (depth > 12 || v == null) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const ref = o.$ref;
    if (typeof ref === "string" && ref && !ref.startsWith("#") && !skip(ref)) {
      refs.add(ref);
    }
    for (const val of Object.values(o)) walk(val, depth + 1);
  };
  walk(schema);
  return [...refs];
}

/** "https://ns.adobe.com/taplondonptrsd/schemas/..." -> "taplondonptrsd" */
function sandboxFrom(records: Array<{ id: string }>): string | null {
  for (const r of records) {
    const m = r.id.match(/ns\.adobe\.com\/([^/]+)\//);
    if (m && m[1] !== "xdm") return m[1];
  }
  return null;
}

/**
 * B4: are the attributes this audience needs present in AEP today?
 *
 * Asked of schema FIELDS, by opening the schemas most likely to carry profile
 * attributes and walking their properties. Asked of schema titles - which is
 * what this did first - the question cannot be answered either way.
 *
 * When no profile-like schema can be opened the answer is INCONCLUSIVE, not
 * "missing", and the caller must not open an attribute request off it.
 *
 * `taskId` is whichever pipeline task is calling this - originally always
 * "audience_creation", now also "review" (see agents/review/aep-context.ts)
 * and "intake" (agents/intake/buildability.ts), which ask the identical
 * question earlier so the brief handed downstream already answers it.
 * Passed through verbatim to callMcpTool so the allowlist check in
 * mcp-client.ts is enforced against the REAL caller, not a hardcoded one.
 *
 * `sandboxOverride`, when given, is passed through to every call below as
 * the `sandbox` argument - used by Demo mode to probe the "tapdemo" sandbox
 * explicitly rather than whatever the connected org defaults to (see
 * audience-creation/route.ts and buildability.ts). Omitted, the call
 * behaves exactly as before. Named distinctly from the `sandbox` local
 * variable below (which reads back WHICH sandbox actually answered, for
 * the returned SchemaProbe) - the two are different things that happen to
 * share a name in every other tool in this file.
 */
export async function probeSchemas(
  taskId: TaskId,
  needed: string[],
  sandboxOverride?: string,
  criteria?: string,
): Promise<SchemaProbe> {
  // Nothing to check means nothing to open a GTO request for - and no
  // reason to spend a dozen-plus MCP calls opening schemas to confirm that.
  // Criteria text is its own reason to look: the brief may name a field no
  // cue covers (see matchCriteriaFields).
  if (!needed.length && !criteria?.trim()) {
    return {
      read: true, conclusive: true, error: null, sandbox: null,
      schemaCount: 0, schemasInspected: 0, fieldGroupsInspected: 0, fieldCount: 0, found: {}, evidence: [],
    };
  }

  const fields = new Set<string>();
  const profileFields = new Map<string, ProfileField>();
  const collect = (doc: unknown) => {
    for (const f of fieldEntries(doc)) {
      fields.add(leafOf(f.path));
      if (!profileFields.has(f.path)) profileFields.set(f.path, f);
    }
  };
  let inspected = 0;
  let fieldGroupsInspected = 0;
  let unionResolved = false;
  let lastError: string | null = null;
  let sandbox: string | null = null;

  /*
   * FIRST, ASK THE UNION. adobe_get_union_schema returns the whole sandbox's
   * merged profile view - every field of every profile-enabled schema, field
   * groups already flattened in. One call, and it structurally cannot miss a
   * field by sampling the wrong schema (the exact failure mode SCHEMA_SAMPLE
   * was raised 3->6 to paper over). When it answers with fields, the probe is
   * conclusive and the per-schema sampling below is skipped entirely.
   *
   * It is tried inside its own try/catch and treated as strictly additive: if
   * the tool is unavailable, errors, or comes back empty, we fall through to
   * the list-and-sample path exactly as before. So this can only make the
   * probe more conclusive, never break a tenant where the union view isn't
   * reachable.
   */
  try {
    const union = await callMcpTool<unknown>(taskId, "adobe_get_union_schema", {
      class_id: PROFILE_UNION_CLASS,
      ...(sandboxOverride ? { sandbox: sandboxOverride } : {}),
    });
    collect(union);
    // This tenant's union view comes back as `allOf` $refs to ~90 field
    // groups with no inline properties, so reading it alone found nothing
    // and the probe fell back to sampling 6 schemas - which missed fields
    // like `SEPeligible`. Build the whole catalog from what the union lists
    // instead: that IS the sandbox's profile, not a sample of it.
    if (fields.size === 0) {
      const built = await buildCatalog(taskId, union, sandboxOverride);
      for (const f of built.fields) {
        fields.add(leafOf(f.path));
        if (!profileFields.has(f.path)) profileFields.set(f.path, f);
      }
      fieldGroupsInspected += built.groupsOpened;
      if (built.error) lastError = built.error;
    }
    if (fields.size > 0) {
      unionResolved = true;
      inspected = 1;
      const unionRecords = schemaRecords(union);
      sandbox = sandboxOverride ?? sandboxFrom(unionRecords);
    }
  } catch (err) {
    lastError = (err as Error).message;
  }

  let records: Array<{ title: string; id: string }> = [];
  // Hoisted out of the sampling block so the final error message below can
  // still describe the sampling path (how many schemas looked like profile
  // schemas, how many field-group refs went unopened) when that path ran.
  let candidateCount = 0;
  let pendingRefCount = 0;
  if (!unionResolved) {
    try {
      const list = await callMcpTool<unknown>(taskId, "adobe_list_schemas", {
        limit: "50",
        ...(sandboxOverride ? { sandbox: sandboxOverride } : {}),
      });
      records = schemaRecords(list);
    } catch (err) {
      return {
        read: false, conclusive: false, error: (err as Error).message, sandbox: null,
        schemaCount: 0, schemasInspected: 0, fieldGroupsInspected: 0, fieldCount: 0, found: {}, evidence: [],
      };
    }

    sandbox = sandboxOverride ?? sandboxFrom(records);
    const candidates = records.filter((r) => PROFILE_SCHEMA_HINT.test(r.title)).slice(0, SCHEMA_SAMPLE);
    candidateCount = candidates.length;

    // Up to SCHEMA_SAMPLE independent schema reads, fanned out together
    // instead of one at a time — none depends on another's result.
    const schemaResults = await Promise.allSettled(
      candidates.map((c) =>
        callMcpTool<unknown>(taskId, "adobe_get_schema", {
          schema_id: c.id,
          ...(sandboxOverride ? { sandbox: sandboxOverride } : {}),
        }),
      ),
    );
    const pendingRefs = new Set<string>();
    for (const result of schemaResults) {
      if (result.status === "fulfilled") {
        collect(result.value);
        // A class-based schema's own document rarely has inline properties -
        // it composes field groups via allOf/$ref (see fieldGroupRefs). Queue
        // those regardless of whether this schema's own walk found anything,
        // since a schema can mix a few inline fields with several field-group
        // refs.
        for (const ref of fieldGroupRefs(result.value)) pendingRefs.add(ref);
        inspected += 1;
      } else {
        lastError = (result.reason as Error).message;
      }
    }

    // Resolve field groups only if the class schemas alone were inconclusive -
    // fields.size === 0 after inspecting at least one schema is exactly the
    // "properties live in a $ref, not inline" case this exists for. Bounded to
    // FIELD_GROUP_SAMPLE total, not per schema, so several profile-hinted
    // schemas each listing a handful of refs cannot fan out unboundedly.
    if (inspected > 0 && fields.size === 0 && pendingRefs.size > 0) {
      // Same reasoning as the schema fetches above: each referenced field
      // group is independent of the others, so they fan out together.
      const refResults = await Promise.allSettled(
        [...pendingRefs].slice(0, FIELD_GROUP_SAMPLE).map((ref) =>
          callMcpTool<unknown>(taskId, "adobe_get_field_group", {
            field_group_id: ref,
            ...(sandboxOverride ? { sandbox: sandboxOverride } : {}),
          }),
        ),
      );
      for (const result of refResults) {
        if (result.status === "fulfilled") {
          collect(result.value);
          fieldGroupsInspected += 1;
        } else {
          lastError = (result.reason as Error).message;
        }
      }
    }
    pendingRefCount = pendingRefs.size;
  }

  const conclusive = inspected > 0 && fields.size > 0;
  const found: Record<string, boolean> = {};
  const evidence: string[] = [];
  const fieldTypes: Record<string, string | null> = {};
  const fieldDescriptions: Record<string, string> = {};
  if (conclusive) {
    const all = [...profileFields.values()];
    const cite = (f: ProfileField) => {
      if (!(f.path in fieldTypes)) evidence.push(f.path);
      fieldTypes[f.path] = f.type;
      if (f.description) fieldDescriptions[f.path] = f.description;
    };
    for (const key of needed) {
      const cue = ATTRIBUTE_CUES[key];
      if (!cue) { found[key] = false; continue; }
      const hit = all.find((f) => cue.test(leafOf(f.path)));
      found[key] = !!hit;
      if (hit) cite(hit);
    }
    if (criteria) matchCriteriaFields(criteria, all).forEach(cite);
  }

  return {
    read: true,
    conclusive,
    error: conclusive
      ? null
      : candidateCount === 0
        ? // The union view returned nothing AND either the schema list was empty
          // or none of its schemas looked like profile schemas. Distinguish the
          // union having been tried at all so the message points at the right
          // thing to fix.
          `${records.length === 0 ? "the profile union view returned no fields and no schemas could be listed" : `none of the ${records.length} schemas in this sandbox look like profile schemas`}, so attribute availability could not be determined` +
          (lastError ? ` (${lastError})` : "")
        : pendingRefCount > 0 && fieldGroupsInspected === 0
          ? `${candidateCount} class schema(s) composed their fields via ${pendingRefCount} field-group ` +
            `reference(s) none of which could be opened (${lastError})`
          : lastError || "opened the candidate schemas and their field groups but found no field definitions in them",
    sandbox,
    schemaCount: records.length,
    schemasInspected: inspected,
    fieldGroupsInspected,
    fieldCount: fields.size,
    found,
    evidence: evidence.slice(0, 20),
    fieldTypes,
    fieldDescriptions,
  };
}

/** Field groups / data types opened at once - enough to finish ~100 quickly without flooding the gateway. */
const UNION_FETCH_CONCURRENCY = 8;
/** Upper bound on field groups opened from one union view. */
const UNION_FIELD_GROUP_CAP = 250;
/** Data-type links are followed this many levels deep (address -> geo is 2). */
const DATA_TYPE_DEPTH = 2;
/** A built catalog per sandbox, reused across agents and runs for a few minutes. */
const CATALOG_CACHE_MS = 5 * 60_000;
const catalogCache = new Map<string, { at: number; fields: ProfileField[]; groupsOpened: number }>();
type BuiltCatalog = { fields: ProfileField[]; groupsOpened: number; error: string | null };
/**
 * Builds in progress, so concurrent runs share one. Without this, N runs
 * arriving on a cold cache each opened ~100 field groups at once; four did
 * that on 26 Sep 2026 and the gateway answered with 503s and then dropped
 * its AEP tools entirely.
 */
const catalogInflight = new Map<string, Promise<BuiltCatalog>>();

async function fetchAll(
  taskId: TaskId,
  tool: "adobe_get_field_group" | "adobe_get_data_type",
  ids: string[],
  sandboxOverride?: string,
): Promise<{ docs: Array<{ id: string; doc: unknown }>; error: string | null }> {
  const docs: Array<{ id: string; doc: unknown }> = [];
  let error: string | null = null;
  for (let i = 0; i < ids.length; i += UNION_FETCH_CONCURRENCY) {
    const slice = ids.slice(i, i + UNION_FETCH_CONCURRENCY);
    const batch = await Promise.allSettled(
      slice.map((id) =>
        callMcpTool<unknown>(taskId, tool, {
          ...(tool === "adobe_get_field_group" ? { field_group_id: id } : { data_type_id: id }),
          ...(sandboxOverride ? { sandbox: sandboxOverride } : {}),
        }),
      ),
    );
    batch.forEach((r, j) => {
      if (r.status === "fulfilled") docs.push({ id: slice[j], doc: r.value });
      else error = (r.reason as Error).message;
    });
  }
  return { docs, error };
}

/**
 * Every profile field in the sandbox, as PQL paths with titles, types,
 * descriptions and allowed values - built from the field groups the union
 * view lists, with data-type links (`homeAddress` -> xdm/common/address)
 * resolved into real nested paths (`homeAddress.stateProvince`).
 *
 * This is what lets a plain-English brief find its fields: "customers who
 * have CBM" names no field literally, but the catalog carries
 * `_taplondonptrsd.isCBMmember` titled "Is CBM member", and PQL synthesis
 * reads the whole catalog (see pql-synth.ts).
 */
async function buildCatalog(
  taskId: TaskId,
  union: unknown,
  sandboxOverride?: string,
): Promise<BuiltCatalog> {
  const groupIds = fieldGroupRefs(union, true).slice(0, UNION_FIELD_GROUP_CAP);
  if (!groupIds.length) return { fields: [], groupsOpened: 0, error: null };

  const cacheKey = `${sandboxOverride ?? ""}|${groupIds.join(",")}`;
  const cached = catalogCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CATALOG_CACHE_MS) {
    return { fields: cached.fields, groupsOpened: cached.groupsOpened, error: null };
  }

  const inflight = catalogInflight.get(cacheKey);
  if (inflight) return inflight;
  const build = buildCatalogUncached(taskId, groupIds, cacheKey, sandboxOverride).finally(() =>
    catalogInflight.delete(cacheKey),
  );
  catalogInflight.set(cacheKey, build);
  return build;
}

async function buildCatalogUncached(
  taskId: TaskId,
  groupIds: string[],
  cacheKey: string,
  sandboxOverride?: string,
): Promise<BuiltCatalog> {
  const groups = await fetchAll(taskId, "adobe_get_field_group", groupIds, sandboxOverride);
  const out = new Map<string, ProfileField>();
  let pending: Array<{ path: string; ref: string }> = [];
  for (const { doc } of groups.docs) {
    const walked = walkFields(doc);
    walked.fields.forEach((f) => { if (!out.has(f.path)) out.set(f.path, f); });
    pending.push(...walked.refs);
  }

  let error = groups.error;
  const typeDocs = new Map<string, unknown>();
  for (let depth = 0; depth < DATA_TYPE_DEPTH && pending.length; depth++) {
    const unseen = [...new Set(pending.map((p) => p.ref))].filter((r) => !typeDocs.has(r));
    const fetched = await fetchAll(taskId, "adobe_get_data_type", unseen, sandboxOverride);
    fetched.docs.forEach(({ id, doc }) => typeDocs.set(id, doc));
    if (fetched.error) error = error ?? fetched.error;
    const next: Array<{ path: string; ref: string }> = [];
    for (const { path, ref } of pending) {
      const doc = typeDocs.get(ref);
      if (!doc) continue;
      const walked = walkFields(doc, path);
      walked.fields.forEach((f) => { if (!out.has(f.path)) out.set(f.path, f); });
      next.push(...walked.refs);
    }
    pending = next;
  }

  const fields = [...out.values()];
  // Only a complete read of the field groups is cached - a partial one would keep hiding a field.
  if (!groups.error) catalogCache.set(cacheKey, { at: Date.now(), fields, groupsOpened: groups.docs.length });
  return { fields, groupsOpened: groups.docs.length, error };
}

/**
 * The sandbox's profile field catalog for PQL synthesis - the same build
 * probeSchemas runs, normally answered from its cache. Leaf-level fields
 * only: containers (`object`) are not something a rule compares against.
 * Empty when the union view or the field groups cannot be read.
 */
export async function profileCatalog(taskId: TaskId, sandboxOverride?: string): Promise<ProfileField[]> {
  try {
    const union = await callMcpTool<unknown>(taskId, "adobe_get_union_schema", {
      class_id: PROFILE_UNION_CLASS,
      ...(sandboxOverride ? { sandbox: sandboxOverride } : {}),
    });
    const inline = fieldEntries(union);
    const all = inline.length ? inline : (await buildCatalog(taskId, union, sandboxOverride)).fields;
    return all.filter((f) => f.type !== "object");
  } catch {
    return [];
  }
}

export type SegmentMatch = {
  read: boolean;
  error: string | null;
  /** An existing segment that looks like what was asked for. */
  id: string | null;
  name: string | null;
  considered: number;
};

/**
 * Is there already a segment for this? B6's cheapest possible outcome.
 *
 * Reusing an existing audience skips the build, the nightly job and the whole
 * rework window. It is also the only way to get a real count without writing
 * anything, so it is tried first.
 *
 * `taskId`: see probeSchemas above - same reasoning, same requirement.
 * `sandbox`: see probeSchemas above - same pass-through, same default (unset).
 */
export async function findExistingSegment(taskId: TaskId, terms: string[], sandbox?: string): Promise<SegmentMatch> {
  try {
    const result = await callMcpTool<unknown>(taskId, "adobe_list_segments", {
      limit: "50",
      ...(sandbox ? { sandbox } : {}),
    });
    const rows = (Array.isArray(result) ? result : ((result as { segments?: unknown[]; data?: unknown[] })?.segments
      || (result as { data?: unknown[] })?.data || [])) as Array<Record<string, unknown>>;

    const meaningful = terms.map((t) => String(t).toLowerCase()).filter((t) => t.length > 3);
    let best: { id: string; name: string; score: number } | null = null;
    for (const row of rows) {
      const name = String(row.name || row.title || "");
      const id = String(row.id || row.segmentId || row["meta:altId"] || "");
      if (!name || !id) continue;
      const hay = name.toLowerCase();
      const score = meaningful.filter((t) => hay.includes(t)).length;
      if (score > 0 && (!best || score > best.score)) best = { id, name, score };
    }
    return { read: true, error: null, id: best?.id ?? null, name: best?.name ?? null, considered: rows.length };
  } catch (err) {
    return { read: false, error: (err as Error).message, id: null, name: null, considered: 0 };
  }
}

/** Whitespace-insensitive form of a PQL expression, for comparing rules. Values stay case-sensitive ("Y" is not "y"). */
export function normalizePql(pql: string): string {
  let t = String(pql || "").replace(/\s+/g, " ").trim();
  while (t.startsWith("(") && t.endsWith(")")) t = t.slice(1, -1).trim();
  return t;
}

/**
 * An existing segment whose rule is IDENTICAL to `pql` - the only safe
 * meaning of "this audience already exists". findExistingSegment above
 * matches on shared name words, which once reused "CB SEP-Eligible Business
 * Prospects UKS" for "profiles with an email that are SEP eligible": a
 * different audience that happened to share the word "SEP". A name match
 * is shown as a similar audience; only this one skips creating.
 */
export async function findSegmentWithRule(
  taskId: TaskId,
  pql: string,
  sandbox?: string,
): Promise<{ id: string; name: string } | null> {
  const target = normalizePql(pql);
  if (!target) return null;
  try {
    const result = await callMcpTool<unknown>(taskId, "adobe_list_segments", {
      limit: "200",
      ...(sandbox ? { sandbox } : {}),
    });
    const rows = (Array.isArray(result) ? result : ((result as { segments?: unknown[] })?.segments || [])) as Array<
      Record<string, unknown>
    >;
    for (const row of rows) {
      const raw = row.expression;
      const expr = typeof raw === "string" ? raw : String((raw as { value?: unknown } | null)?.value ?? "");
      if (expr && normalizePql(expr) === target && row.id) {
        return { id: String(row.id), name: String(row.name || row.id) };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** A dataset's name/id, and whether Catalog metadata marks it profile-enabled. */
function datasetRecords(result: unknown): Array<{ id: string; name: string; profileEnabled: boolean }> {
  const out: Array<{ id: string; name: string; profileEnabled: boolean }> = [];
  const walk = (v: unknown, depth = 0) => {
    if (depth > 5 || v == null) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      const name = String(o.name || o.title || "");
      const id = String(o.$id || o.id || o["meta:altId"] || "");
      if (name && id) {
        // Real-Time Customer Profile enablement is a literal tag Catalog
        // attaches to the dataset - `tags.unifiedProfile` - never guessed
        // from the dataset's own NAME containing the word "profile". Schema
        // titles already taught this lesson once (see probeSchemas above);
        // the same trap exists here.
        const tagKeys = o.tags && typeof o.tags === "object" ? Object.keys(o.tags as Record<string, unknown>) : [];
        out.push({ id, name, profileEnabled: tagKeys.some((k) => /unifiedprofile/i.test(k)) });
        return; // a dataset record is a leaf - don't also walk into its own fields looking for more.
      }
      for (const val of Object.values(o)) walk(val, depth + 1);
    }
  };
  walk(result);
  return out;
}

export type DatasetProbe = {
  read: boolean;
  /** Did we get back anything we could recognise as dataset records at all? */
  conclusive: boolean;
  error: string | null;
  datasetCount: number;
  profileEnabled: Array<{ id: string; name: string }>;
};

/**
 * Which datasets Catalog marks profile-enabled - context for a brief, not a
 * row count. Catalog metadata (this call) does not carry record counts;
 * getting one requires Query Service, which review/registry.ts deliberately
 * does NOT allowlist for this task (a much bigger permission - arbitrary
 * SQL - than triage needs). This stops at "which datasets", on purpose.
 */
export async function profileDatasetSummary(taskId: TaskId): Promise<DatasetProbe> {
  try {
    const list = await callMcpTool<unknown>(taskId, "adobe_list_datasets", { limit: "50" });
    const records = datasetRecords(list);
    return {
      read: true,
      conclusive: records.length > 0,
      error: records.length ? null : "the dataset list returned nothing recognisable as a dataset",
      datasetCount: records.length,
      profileEnabled: records.filter((r) => r.profileEnabled).map((r) => ({ id: r.id, name: r.name })),
    };
  } catch (err) {
    return { read: false, conclusive: false, error: (err as Error).message, datasetCount: 0, profileEnabled: [] };
  }
}

/**
 * B3/B8: the account-versus-profile identity gap.
 *
 * "Flag the account-versus-profile identity gap explicitly rather than letting
 * the marketer discover a number they do not recognise." The gap is real
 * whenever the brief counts one thing and AEP counts another: a marketer asking
 * for "subscribers" is thinking in accounts, and the profile store resolves to
 * people, so one household with three profiles is 1 or 3 depending on who is
 * counting. Saying so up front is the entire fix - the doc keeps the human
 * decision at 2.5 and asks only that the surprise be removed.
 */
export function identityGap(fields: Record<string, string>): { hasGap: boolean; details: string | null } {
  const text = Object.values(fields || {}).join(" ").toLowerCase();
  const accountWords = /\b(subscriber|account|household|customer|line|premise)\b/.test(text);
  if (!accountWords) return { hasGap: false, details: null };
  return {
    hasGap: true,
    details:
      "This brief is written in account terms (subscribers/accounts/households) and AEP counts " +
      "resolved profiles. One household can resolve to several profiles, so the audience count " +
      "will not equal the subscriber count and the difference is identity resolution, not an error. " +
      "Agree which number is the target before the count is reviewed.",
  };
}

/**
 * B5: rule builder, or the federated path?
 *
 * "Establish whether a request genuinely needs FAC or can be satisfied in the
 * AEP rule builder at 3.1a, so the undefined path is taken only when
 * unavoidable." 3.1b is undefined and unscoped, so the default has to be the
 * rule builder and FAC has to be argued for - not the other way round.
 */
export function decideBuildPath(
  fields: Record<string, string>,
  probe: SchemaProbe,
): { buildPath: "aep_rule_builder" | "fac"; reason: string } {
  const text = Object.values(fields || {}).join(" ").toLowerCase();

  if (/\bfac\b|federated|data warehouse|snowflake|offline only/.test(text)) {
    return {
      buildPath: "fac",
      reason: "The brief names federated/FAC data explicitly, so the federated path is being asked for.",
    };
  }

  // Prospects are not in the profile store, which is the honest FAC case.
  if (/prospect|non-?customer/.test(text)) {
    return {
      buildPath: "fac",
      reason:
        "The audience is prospects, who do not exist in the AEP profile store, so this cannot be " +
        "satisfied in the rule builder.",
    };
  }

  if (!probe.conclusive) {
    return {
      buildPath: "aep_rule_builder",
      reason:
        `Attribute availability could not be determined (${probe.error}), so the path is unconfirmed. ` +
        "Defaulting to the rule builder because 3.1b is an undefined, unscoped workflow and must be " +
        "entered only when it is known to be necessary - not because a probe came back inconclusive.",
    };
  }

  const absent = Object.entries(probe.found).filter(([, ok]) => !ok).map(([k]) => k);
  if (absent.length) {
    return {
      buildPath: "aep_rule_builder",
      reason:
        `The rule builder can express this once ${absent.join(", ")} ${absent.length === 1 ? "is" : "are"} ` +
        "available. Missing attributes are a B4 attribute request, not a reason to take the federated path.",
    };
  }

  return {
    buildPath: "aep_rule_builder",
    reason: "Every attribute this audience needs is present in AEP, so the rule builder covers it.",
  };
}

/**
 * B6: the nightly segmentation job.
 *
 * "The segmentation job runs once a night at 9:45 pm. Every rework cycle after
 * this point costs a minimum of one full day." The agent cannot move the job,
 * so the only useful thing it can do is say how much of today is left.
 */
export function nightlyCutoff(now = new Date()): {
  cutoff: string;
  minutesRemaining: number;
  madeIt: boolean;
  note: string;
} {
  const cutoff = new Date(now);
  cutoff.setHours(21, 45, 0, 0);
  const minutes = Math.round((cutoff.getTime() - now.getTime()) / 60000);
  const madeIt = minutes > 0;
  return {
    cutoff: "21:45",
    minutesRemaining: minutes,
    madeIt,
    note: madeIt
      ? `${minutes} minute(s) until the 21:45 segmentation run. A fix landing before it costs no extra day.`
      : `The 21:45 run has passed (${Math.abs(minutes)} minute(s) ago). Anything from here lands tomorrow night, ` +
        "so batch the outstanding fixes rather than spending a night on each.",
  };
}

export type SegmentSizeEstimate =
  | { available: true; count: number }
  | {
      available: false;
      reason: string;
      /**
       * Set while AEP is still counting: the evaluation job to read back.
       * The audience card polls /api/audience-size with these until a count
       * (or a failure) comes back - see readSegmentSize.
       */
      pending?: { jobId: string; segmentId: string; sandbox: string | null };
    };

/** How long the step itself waits for a count before handing the job to the card. Evaluation jobs usually take minutes. */
const SIZE_WAIT_MS = 20_000;
const SIZE_POLL_MS = 5_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * B3: the audience's real size, from an on-demand evaluation job.
 *
 * adobe_create_segment_estimate posts to /segment/definitions/{id}/estimate,
 * which AEP answers 404 for every segment (verified again 26 Sep 2026) - it
 * never returned a count. An evaluation job does: adobe_create_segment_job
 * evaluates just this segment and the job's metrics carry
 * segmentedProfileCounter[segmentId]. Jobs take a few minutes, so this waits
 * briefly and otherwise returns `pending` with the job id for the card to
 * poll. Never throws, never a fabricated zero: a count is only reported
 * when the job itself reports one for this segment.
 */
export async function estimateSegmentSize(
  taskId: TaskId,
  segmentId: string,
  sandbox?: string,
): Promise<SegmentSizeEstimate> {
  if (!segmentId) return { available: false, reason: "no segment id to estimate yet" };
  let jobId = "";
  try {
    const job = await callMcpTool<{ id?: unknown; jobId?: unknown; data?: { id?: unknown } }>(
      taskId,
      "adobe_create_segment_job",
      { segment_ids: JSON.stringify([segmentId]), ...(sandbox ? { sandbox } : {}) },
    );
    jobId = String(job?.id ?? job?.jobId ?? job?.data?.id ?? "");
  } catch (err) {
    const message = (err as Error).message;
    // Orgs on AEP's "B2B simplification" (tapdemo's org, verified 26 Sep
    // 2026) refuse on-demand jobs outright: only the scheduled evaluation
    // counts a segment. Say that plainly rather than surfacing AEP's 400.
    if (/Non-scheduled segment jobs are not allowed/i.test(message)) {
      return {
        available: false,
        reason: "this AEP org only counts audiences in its scheduled evaluation - size appears after that runs",
      };
    }
    return { available: false, reason: `could not start an evaluation job: ${message}` };
  }
  if (!jobId) return { available: false, reason: "AEP started no evaluation job for this segment" };

  const deadline = Date.now() + SIZE_WAIT_MS;
  let last: SegmentSizeEstimate = pendingSize(jobId, segmentId, sandbox);
  while (Date.now() < deadline) {
    await sleep(SIZE_POLL_MS);
    last = await readSegmentSize(taskId, jobId, segmentId, sandbox);
    if (last.available || !last.pending) return last;
  }
  return last;
}

function pendingSize(jobId: string, segmentId: string, sandbox?: string): SegmentSizeEstimate {
  return {
    available: false,
    reason: "AEP is counting this audience now - usually a few minutes",
    pending: { jobId, segmentId, sandbox: sandbox ?? null },
  };
}

/** Read an evaluation job back: a count once it has one for this segment, `pending` while it runs, a reason if it failed. */
export async function readSegmentSize(
  taskId: TaskId,
  jobId: string,
  segmentId: string,
  sandbox?: string,
): Promise<SegmentSizeEstimate> {
  try {
    const job = await callMcpTool<{
      status?: unknown;
      errors?: unknown;
      metrics?: { segmentedProfileCounter?: Record<string, unknown> };
    }>(taskId, "adobe_get_segment_job", { job_id: jobId, ...(sandbox ? { sandbox } : {}) });
    const status = String(job?.status ?? "").toUpperCase();
    if (status === "SUCCEEDED") {
      const raw = job?.metrics?.segmentedProfileCounter?.[segmentId];
      const count = Number(raw);
      if (raw === undefined || !Number.isFinite(count) || count < 0) {
        return { available: false, reason: "the evaluation finished but reported no count for this segment" };
      }
      return { available: true, count };
    }
    if (status === "FAILED" || status === "CANCELLED" || status === "CANCELED") {
      const errors = Array.isArray(job?.errors) ? JSON.stringify(job.errors).slice(0, 200) : "";
      return { available: false, reason: `the evaluation job ${status.toLowerCase()}${errors ? `: ${errors}` : ""}` };
    }
    return pendingSize(jobId, segmentId, sandbox);
  } catch (err) {
    return { available: false, reason: `could not read the evaluation job: ${(err as Error).message}` };
  }
}
