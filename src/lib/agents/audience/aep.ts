/**
 * What AEP can actually answer about an audience, before anyone builds it.
 *
 * Agent 3's blockers are all versions of one question - "what will this
 * audience be, and can this platform even express it?" - asked BEFORE the
 * nightly job at 21:45, because after that every mistake costs a day (B6).
 *
 * Every function here is a READ. Nothing creates a segment.
 *
 * NO COUNT ESTIMATION HERE, ON PURPOSE. This module used to also call
 * adobe_create_segment_estimate/adobe_get_segment_estimate for B3's "predict
 * the count before the marketer sees it." Verified live against 4 different
 * real, valid segment IDs (confirmed valid via adobe_get_segment) - every one
 * 404s identically, because the estimate tool hits the wrong upstream URL
 * (.../estimate suffix that the gateway's adobe_get_segment path does not
 * use). That is a bug in the gateway's tool, not this app, and not something
 * fixable from here - so rather than keep a call site that always fails (and
 * a UI line that always reads "No count yet"), it was removed. The effort
 * that would have gone into working around it instead went into
 * ATTRIBUTE_CUES/neededAttributes below: predicting a count nobody can trust
 * is worth less than being right about which fields an audience actually
 * needs.
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
import { CAMPAIGN_BRIEF_FIELDS } from "@/lib/agents/shared/campaign-brief";

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
  channels: /(^|[^a-z])(channel|emailaddress|email_address|phonenumber|phone_number|mobilephone)([^a-z]|$)/i,
  region: /(^|[^a-z])(region|state|market|geo|postalcode|postal_code)([^a-z]|$)/i,
  // ECID/identity presence - distinct from "channels", which is about WHICH
  // channel to send on, not whether an identity attribute exists on the
  // profile to target against.
  //
  // personid/person_id ADDED 21 Sep 2026 - a real brief asked for "an
  // audience where personId exists" and this cue never fired, because
  // neither "personid" nor any synonym of it was in the regex. neededAttributes
  // came back empty, probeSchemas short-circuited with a vacuous "conclusive,
  // 0 checked" (see its own docstring/early-return), and the run silently
  // reused an unrelated existing segment instead. This is not a guess at an
  // unverified field name: "personId" is added as BRIEF-TEXT vocabulary for
  // the SAME concept this cue already covers (does an identity attribute
  // exist on the profile), so it is checked against the same already-grounded
  // schema evidence (identityMap, ecid, ...) - a real XDM profile schema
  // structurally carries identityMap, so this cue firing on "personId" text
  // resolves against a field that is actually there, not an invented one.
  //
  // GENERALIZED 21 Sep 2026 - personId was one example of a broader gap:
  // ANY identifier concept ("device id", "loyalty ID", "account GUID",
  // "session UUID", ...) hit the same "never recognized, vacuous pass"
  // failure. Added, word-boundary anchored exactly like every other cue
  // here (never an unanchored substring - see this const's own docstring
  // on "lob" matching inside "glob"):
  //   - id/ids/guid/uuid as STANDALONE words ("device ID", "a GUID") - safe
  //     because (^|[^a-z])...([^a-z]|$) requires "id" to be its own token,
  //     which does NOT match inside an ordinary word that happens to END in
  //     "-id" (avoid, valid, solid, rapid, hybrid, ... all fail this, since
  //     there is no non-letter character between the rest of the word and
  //     "id" - verified in aep.test.ts).
  //   - _id/_guid/_uuid as a snake_case suffix ("device_id") - the
  //     underscore itself satisfies the [^a-z] boundary, so this needs no
  //     special casing.
  //   - emailaddress/phonenumber/etc., duplicated from the `channels` cue's
  //     literals rather than a bare "email"/"phone" - AEP's identity graph
  //     genuinely treats Email/Phone as identity namespaces, so a compound
  //     field-name mention is real identity evidence. A BARE "email"/"phone"
  //     is deliberately still excluded here, for the exact reason the
  //     `channels` cue below stays narrow: a marketer saying "send this via
  //     email" means pick a channel, not "check whether an email identifier
  //     exists" - conflating the two re-triggers the GTO over-ask bug this
  //     file's neededAttributes docstring already fixed once.
  // CAMELCASE FIELD NAMES (deviceId, loyaltyId, sessionId, accountGuid) are
  // NOT reachable by this regex - case-insensitive matching can't tell
  // "deviceId" from the ordinary English word "valid" once folded to
  // lowercase. See IDENTIFIER_FIELD_SUFFIX below, applied only to real
  // schema field names in probeSchemas, where case is trustworthy.
  identity:
    /(^|[^a-z])(ecid|mcid|experience\s?cloud\s?id|identitymap|identity_map|personid|person_id|ids?|guid|uuid|emailaddress|email_address|phonenumber|phone_number|mobilephone)([^a-z]|$)/i,
  // Product/service ownership - xfinitytv/xfinityinternet/xfinitymobile are
  // real field names in this tenant (see docstring above); internet/tv/
  // broadband/television cover briefs that describe the same thing by the
  // product's common name rather than the schema's field name.
  product_ownership: /(^|[^a-z])(xfinitytv|xfinityinternet|xfinitymobile|broadband|television|\btv\b|\binternet\b)([^a-z]|$)/i,
};

/**
 * The "identity" cue's camelCase companion, used ONLY against real schema
 * FIELD NAMES (probeSchemas), never against brief text - see ATTRIBUTE_CUES.identity's
 * docstring for why. Case-SENSITIVE on purpose: a lowercase letter directly
 * followed by "Id"/"Guid"/"Uuid", not immediately followed by another letter
 * (so "deviceId" and "accountGuid" match, but "identityMap" - "Id" at the
 * very START with nothing lowercase before it - and "userGuideline" - more
 * letters immediately after "Guid" - do not). This is exactly the "lob in
 * glob" discipline every other cue in this file already applies, just
 * case-sensitive because camelCase is itself the boundary signal here, and
 * that signal disappears the moment the match is folded to lowercase.
 */
export const IDENTIFIER_FIELD_SUFFIX = /[a-z](Id|Guid|Uuid)(?![a-zA-Z])/;

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

/**
 * Campaign-shape vocabulary that can never distinguish one audience from
 * another, so it must never by itself count as evidence that two audiences
 * are "the same": [1] any CAMPAIGN_BRIEF_FIELDS option that is the ONLY
 * allowed value for its field (every request in this pipeline carries the
 * identical word - e.g. every audience_build_method is literally "Simple
 * Workflow Audience" - so it is boilerplate, not audience-defining text),
 * and [2] the fields in MOTION_FIELD_KEYS - campaign-SHAPE categories
 * ("Upsell", "Retention", "Winback", "Evergreen", "Batch", ...) shared by
 * countless unrelated audiences, unlike region/line_of_business/
 * customer_type/channels (left out of MOTION_FIELD_KEYS on purpose -
 * those genuinely describe WHO the audience is, not how the campaign runs).
 *
 * Derived from CAMPAIGN_BRIEF_FIELDS itself, not a hand-maintained word
 * list, so it can't drift from the form's real options the way two copies
 * of the same list would.
 *
 * THE BUG THIS FIXES: a brief for "people who have a personId" was matched
 * to an unrelated, already-built "Michigan TV-Only Internet Upsell" segment
 * on the strength of ONE shared word - "upsell" - which is business_objective
 * vocabulary common to countless real audiences, not anything that
 * described the actual criteria. See findExistingSegment's confidence gate
 * for the other half of this fix.
 */
const MOTION_FIELD_KEYS = new Set([
  "business_objective", "lifecycle_journey", "campaign_duration", "cadence",
  "activation_pattern", "request_type", "request_category", "promo_channel_type",
]);
const CATEGORICAL_STOPWORDS: ReadonlySet<string> = new Set(
  CAMPAIGN_BRIEF_FIELDS.filter((f) => (f.options?.length ?? 0) === 1 || MOTION_FIELD_KEYS.has(f.key))
    .flatMap((f) => f.options ?? [])
    .flatMap((opt) =>
      opt
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3),
    ),
);

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
    .filter((w) => w.length > 3 && !REQUEST_STOPWORDS.has(w) && !CATEGORICAL_STOPWORDS.has(w));
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
  evidence: string[];
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
function fieldNames(schema: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth = 0) => {
    if (depth > 12 || v == null || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const props = o.properties;
    if (props && typeof props === "object") {
      for (const key of Object.keys(props as Record<string, unknown>)) out.add(key);
    }
    for (const val of Object.values(o)) {
      if (val && typeof val === "object") walk(val, depth + 1);
    }
  };
  walk(schema);
  return [...out];
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
function fieldGroupRefs(schema: unknown): string[] {
  const refs = new Set<string>();
  const walk = (v: unknown, depth = 0) => {
    if (depth > 12 || v == null) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const ref = o.$ref;
    if (typeof ref === "string" && ref && !/ns\.adobe\.com\/xdm\/(context|data)\//.test(ref)) {
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
    if (m) return m[1];
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
 * "audience_creation", now also "review" (see agents/review/aep-context.ts),
 * which asks the identical question one step earlier so the brief handed to
 * Agent 3 already answers it. Passed through verbatim to callMcpTool so the
 * allowlist check in mcp-client.ts is enforced against the REAL caller, not
 * a hardcoded one.
 */
export async function probeSchemas(taskId: TaskId, needed: string[]): Promise<SchemaProbe> {
  // Nothing to check means nothing to open a GTO request for - and no
  // reason to spend a dozen-plus MCP calls opening schemas to confirm that.
  if (!needed.length) {
    return {
      read: true, conclusive: true, error: null, sandbox: null,
      schemaCount: 0, schemasInspected: 0, fieldGroupsInspected: 0, fieldCount: 0, found: {}, evidence: [],
    };
  }

  const fields = new Set<string>();
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
    const union = await callMcpTool<unknown>(taskId, "adobe_get_union_schema", { class_id: PROFILE_UNION_CLASS });
    for (const f of fieldNames(union)) fields.add(f);
    if (fields.size > 0) {
      unionResolved = true;
      inspected = 1;
      const unionRecords = schemaRecords(union);
      sandbox = sandboxFrom(unionRecords);
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
      const list = await callMcpTool<unknown>(taskId, "adobe_list_schemas", { limit: "50" });
      records = schemaRecords(list);
    } catch (err) {
      return {
        read: false, conclusive: false, error: (err as Error).message, sandbox: null,
        schemaCount: 0, schemasInspected: 0, fieldGroupsInspected: 0, fieldCount: 0, found: {}, evidence: [],
      };
    }

    sandbox = sandboxFrom(records);
    const candidates = records.filter((r) => PROFILE_SCHEMA_HINT.test(r.title)).slice(0, SCHEMA_SAMPLE);
    candidateCount = candidates.length;

    // Up to SCHEMA_SAMPLE independent schema reads, fanned out together
    // instead of one at a time — none depends on another's result.
    const schemaResults = await Promise.allSettled(
      candidates.map((c) => callMcpTool<unknown>(taskId, "adobe_get_schema", { schema_id: c.id })),
    );
    const pendingRefs = new Set<string>();
    for (const result of schemaResults) {
      if (result.status === "fulfilled") {
        for (const f of fieldNames(result.value)) fields.add(f);
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
          callMcpTool<unknown>(taskId, "adobe_get_field_group", { field_group_id: ref }),
        ),
      );
      for (const result of refResults) {
        if (result.status === "fulfilled") {
          for (const f of fieldNames(result.value)) fields.add(f);
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
  if (conclusive) {
    const names = [...fields];
    for (const key of needed) {
      const cue = ATTRIBUTE_CUES[key];
      if (!cue) { found[key] = false; continue; }
      // For "identity" specifically, a real camelCase field name
      // (deviceId, accountGuid, ...) is evidence the case-insensitive cue
      // above cannot see once folded to lowercase - see
      // IDENTIFIER_FIELD_SUFFIX's own docstring. Field names only, never
      // brief text, since case there isn't trustworthy the same way.
      const hit = names.find((n) => cue.test(n) || (key === "identity" && IDENTIFIER_FIELD_SUFFIX.test(n)));
      found[key] = !!hit;
      if (hit) evidence.push(hit);
    }
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
    evidence: evidence.slice(0, 8),
  };
}

export type SegmentMatch = {
  read: boolean;
  error: string | null;
  /** An existing segment that looks like what was asked for. */
  id: string | null;
  name: string | null;
  considered: number;
  /** How many distinctive terms matched the winning segment's name - 0 when nothing matched. */
  score: number;
  /** Which terms actually matched, for a human (or the next agent) to sanity-check the reuse. */
  matchedTerms: string[];
};

/**
 * Minimum fraction of the meaningful search terms a segment's name must
 * share before a keyword overlap is trusted as "this audience already
 * exists," rather than just "shares a word with."
 *
 * THE BUG THIS FIXES: with no floor, ANY score >= 1 won - so a brief that
 * shared exactly one generic word with an unrelated segment (see
 * CATEGORICAL_STOPWORDS's docstring: "Michigan TV-Only Internet Upsell"
 * matched on "upsell" alone) was treated as definitively the same audience,
 * and Agent 3 activated that WRONG segment to a real destination on the
 * strength of it. 0.5 keeps the single-distinctive-term case that
 * criteriaKeywords exists for working (a brief that says only "ECID" still
 * matches a segment literally named "Has ECID" at ratio 1/1), while
 * requiring a brief that produces several meaningful terms to actually
 * share HALF of them, not just one, before reuse is trusted.
 */
export const MIN_SEGMENT_MATCH_RATIO = 0.5;

export type SegmentScore = { score: number; matched: string[]; ratio: number };

/** Pure scoring, split out from findExistingSegment so it's testable without a live/mocked MCP call. */
export function scoreSegmentName(terms: string[], name: string): SegmentScore {
  const meaningful = [...new Set(terms.map((t) => String(t).toLowerCase()).filter((t) => t.length > 3))];
  const hay = name.toLowerCase();
  const matched = meaningful.filter((t) => hay.includes(t));
  return { score: matched.length, matched, ratio: meaningful.length ? matched.length / meaningful.length : 0 };
}

/**
 * Is there already a segment for this? B6's cheapest possible outcome.
 *
 * Reusing an existing audience skips the build, the nightly job and the whole
 * rework window. It is also the only way to get a real count without writing
 * anything, so it is tried first.
 *
 * A match is only trusted at MIN_SEGMENT_MATCH_RATIO or better (see its own
 * docstring) - below that, this reports "no match" exactly as if nothing had
 * scored at all, rather than a low-confidence guess a caller might reuse
 * without checking.
 *
 * `taskId`: see probeSchemas above - same reasoning, same requirement.
 */
export async function findExistingSegment(taskId: TaskId, terms: string[]): Promise<SegmentMatch> {
  try {
    const result = await callMcpTool<unknown>(taskId, "adobe_list_segments", { limit: "50" });
    const rows = (Array.isArray(result) ? result : ((result as { segments?: unknown[]; data?: unknown[] })?.segments
      || (result as { data?: unknown[] })?.data || [])) as Array<Record<string, unknown>>;

    let best: { id: string; name: string; score: number; matched: string[] } | null = null;
    for (const row of rows) {
      const name = String(row.name || row.title || "");
      const id = String(row.id || row.segmentId || row["meta:altId"] || "");
      if (!name || !id) continue;
      const { score, matched, ratio } = scoreSegmentName(terms, name);
      if (score > 0 && ratio >= MIN_SEGMENT_MATCH_RATIO && (!best || score > best.score)) {
        best = { id, name, score, matched };
      }
    }
    return {
      read: true,
      error: null,
      id: best?.id ?? null,
      name: best?.name ?? null,
      considered: rows.length,
      score: best?.score ?? 0,
      matchedTerms: best?.matched ?? [],
    };
  } catch (err) {
    return { read: false, error: (err as Error).message, id: null, name: null, considered: 0, score: 0, matchedTerms: [] };
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

  // probe.found is keyed exactly by `needed` (see probeSchemas) - empty here
  // means nothing was recognized as needing a check, not that something WAS
  // checked and confirmed present. Saying "every attribute is present" on
  // zero checks is the exact vacuous-truth bug that let an unrecognized
  // concept (e.g. "personId" before its ATTRIBUTE_CUES entry existed) read
  // as a confident "all clear" instead of an honest "nothing to verify".
  if (Object.keys(probe.found).length === 0) {
    return {
      buildPath: "aep_rule_builder",
      reason:
        "This audience's own criteria don't reference any attribute this app currently recognizes, so " +
        "there was nothing to check - not a confirmation that everything needed is present.",
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
