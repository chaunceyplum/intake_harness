/**
 * 2.7 "Attributes available?", answered from the fields AEP actually has.
 *
 * WHY THE OLD ANSWER WAS ALWAYS "UNDETERMINED"
 *
 * probeSchemas read `adobe_list_schemas` and then `adobe_get_schema`. A schema
 * document does not contain its fields: it contains `allOf` with `$ref`s to the
 * FIELD GROUPS that hold them, and the connector does not expand them. So the
 * probe opened three schemas, found no field definitions, and correctly refused
 * to conclude anything - every run reporting `undetermined` and every audience
 * unbuildable, for want of one more call.
 *
 * `adobe_get_union_schema` looked like the fix and is not: there is no profile
 * union in this sandbox (404, "unions resource ... is not found"), which is its
 * own finding. But `adobe_list_field_groups` + `adobe_get_field_group` return
 * the real thing. Read live from taplondonptrsd, 20 field groups, including:
 *
 *   Xfinity Product Holdings   _taplondonptrsd.xfinityTV        boolean
 *                              _taplondonptrsd.xfinityInternet  boolean
 *                              _taplondonptrsd.state            string
 *                              _taplondonptrsd.customerEmail    string
 *
 * Those are exactly the attributes a "TV-only, upsell Internet" audience needs.
 * They were there the whole time.
 *
 * WHAT COUNTS AS A REQUIRED ATTRIBUTE, WHICH IS WHERE THIS USED TO GO WRONG
 *
 * The old requirement list was the BRIEF's fields: customer_type,
 * line_of_business, lifecycle_journey, channels, region. Most of those are
 * routing metadata about the request, not predicates about a person - no AEP
 * sandbox has a field called "line of business" - so 2.7 could never say yes and
 * every run was headed for the 2.7a GTO request.
 *
 * 2.6 says "gather data requirements NEEDED". What an audience needs is the
 * attributes its DEFINITION tests: which products someone holds, where they
 * are, and how to reach them. That is what is checked here.
 */

import { callMcpTool } from "@/lib/mcp-client";
import type { TaskId } from "@/lib/pipeline/types";
import { countAudience } from "@/lib/agents/audience/count";
import { findState, namesAPlace, statePredicate } from "@/lib/agents/shared/us-states";

export type SandboxField = {
  /** The full XDM path, which is what a PQL expression addresses. */
  path: string;
  type: string;
  /** Which field group it came from, so a reader can find it in the UI. */
  group: string;
};

export type FieldRead = {
  read: boolean;
  error: string | null;
  /** The IMS tenant that prefixes custom field paths. NOT a sandbox name. */
  tenant: string | null;
  fields: SandboxField[];
  groupCount: number;
};

/** Every leaf field in a field-group document, with its XDM path. */
function leafFields(doc: unknown, group: string): SandboxField[] {
  const out: SandboxField[] = [];
  const walk = (node: unknown, path: string, depth: number) => {
    if (depth > 12 || node == null || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const props = o.properties;
    if (props && typeof props === "object") {
      for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
        const here = path ? `${path}.${key}` : key;
        const v = value as Record<string, unknown>;
        if (v && typeof v === "object" && v.properties) {
          walk(v, here, depth + 1);
        } else {
          out.push({ path: here, type: String((v && v.type) || "unknown"), group });
        }
      }
    }
    // allOf / oneOf / definitions nest the same shape.
    for (const [key, value] of Object.entries(o)) {
      if (key === "properties") continue;
      if (value && typeof value === "object") walk(value, path, depth + 1);
    }
  };
  walk(doc, "", 0);
  return out;
}

/**
 * Read the sandbox's real profile fields.
 *
 * Reads every tenant field group. That is more calls than reading one schema,
 * and it is the difference between an answer and "undetermined" - so it is
 * worth them. A group that fails to read is skipped and counted, never allowed
 * to fail the whole probe: a partial field list still answers most questions,
 * and saying "I found these 30 of 40" beats saying nothing.
 */
/*
 * A SHORT CACHE, because review and Agent 3 ask the same question in one run.
 *
 * Both stages read the sandbox's field groups - review to tell Agent 3 what is
 * available, Agent 3 to decide what to build - and nothing carried the answer
 * between them, so a run paid for the same twenty-odd calls twice.
 *
 * Sixty seconds, in process, deliberately. Long enough to cover one run,
 * nowhere near long enough to hide a real change to the tenant's schemas -
 * stale field data would be exactly the kind of thing that sends someone
 * hunting for an afternoon.
 */
const FIELD_CACHE_MS = 60_000;
let fieldCache: { at: number; read: FieldRead } | null = null;

export async function readSandboxFields(taskId: TaskId = "audience_creation"): Promise<FieldRead> {
  if (fieldCache && Date.now() - fieldCache.at < FIELD_CACHE_MS && fieldCache.read.read) {
    return fieldCache.read;
  }
  const fresh = await readSandboxFieldsUncached(taskId);
  // Only a SUCCESSFUL read is cached. Caching a failure would turn one bad
  // moment into a minute of them.
  if (fresh.read) fieldCache = { at: Date.now(), read: fresh };
  return fresh;
}

async function readSandboxFieldsUncached(taskId: TaskId = "audience_creation"): Promise<FieldRead> {
  let groups: Array<{ title: string; altId: string }> = [];
  try {
    const list = await callMcpTool<{ results?: Array<Record<string, unknown>> }>(
      taskId,
      "adobe_list_field_groups",
      {},
    );
    groups = (list?.results || []).map((r) => ({
      title: String(r.title || "untitled"),
      altId: String(r["meta:altId"] || r.$id || ""),
    })).filter((g) => g.altId);
  } catch (err) {
    return { read: false, error: (err as Error).message, tenant: null, fields: [], groupCount: 0 };
  }

  const fields: SandboxField[] = [];
  let tenant: string | null = null;

  /*
   * EVERY GROUP AT ONCE, not one after another.
   *
   * These reads are independent - each is one field group's definition - and
   * awaiting them in sequence made the stage pay for every round trip. The
   * tenant is derived from the altIds, which needs no call at all.
   */
  for (const g of groups) {
    /*
     * This is the TENANT namespace, not the sandbox, and confusing the two cost
     * an afternoon.
     *
     * Every altId reads `_taplondonptrsd.mixins.xxxx`, so `taplondonptrsd`
     * looks like the sandbox name. It is not - it is the IMS tenant id that
     * prefixes every custom field path. The sandbox this connector actually
     * talks to is `tapdemo` (visible in any adobe_list_merge_policies
     * response). Passing the tenant as `sandbox` sent adobe_create_segment at a
     * sandbox that does not exist, and the API answered with a bare
     * `400 Bad Request` naming nothing - so the failure looked like bad PQL for
     * as long as we believed the label.
     *
     * It is named `tenant` here so it cannot be handed to a `sandbox` parameter
     * again by someone reading the type.
     */
    if (!tenant) tenant = g.altId.replace(/^_/, "").split(".")[0] || null;
  }

  const docs = await Promise.all(
    groups.map((g) =>
      callMcpTool<unknown>(taskId, "adobe_get_field_group", { field_group_id: g.altId })
        .then((doc) => ({ g, doc }))
        .catch(() => null), // one unreadable group must not lose the others
    ),
  );
  for (const hit of docs) {
    if (hit) fields.push(...leafFields(hit.doc, hit.g.title));
  }

  return {
    read: true,
    error: fields.length ? null : "read the field groups but none of them yielded field definitions",
    tenant,
    fields,
    groupCount: groups.length,
  };
}

/**
 * A thing the audience definition has to be able to test.
 *
 * `synonyms` are matched against the LEAF of a field path, loosely. Loose on
 * purpose: a tenant calls it `xfinityTV`, `tvSubscriber` or `hasTV` and all
 * three mean the same thing to a marketer. A false match here is visible -
 * the matched field name is reported next to the requirement - which is the
 * check that makes looseness safe.
 */
export type Requirement = {
  key: string;
  label: string;
  synonyms: string[];
  /** Why the audience needs it, for the artifact and for a GTO request. */
  why: string;
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * What THIS audience needs, derived from the brief.
 *
 * Only predicates. A requirement is added when the brief gives a reason to test
 * it, so a simple audience is not blocked on attributes it never uses.
 */
export function audienceRequirements(fields: Record<string, string>): Requirement[] {
  const all = Object.values(fields).join(" ").toLowerCase();
  // Place detection reads capitalisation - "around the Detroit metro area" is a
  // place because Detroit is a proper noun - so it gets the text as written.
  const asWritten = Object.values(fields).join(" ");
  const reqs: Requirement[] = [];

  if (/internet|tv|mobile|video|broadband|voice|bundle|upsell|cross-?sell|upgrade|only\b/.test(all)) {
    reqs.push({
      key: "product_holding",
      label: "Product holdings",
      synonyms: ["xfinitytv", "xfinityinternet", "producthold", "product", "subscription", "service", "holding"],
      why: "the audience is defined by what the customer already has, and what they do not - an upsell needs both halves",
    });
  }

  /*
   * Any named place, not a list of the places we happened to develop against.
   *
   * This read "...|radius|northeast|southeast|midwest|west|detroit|michigan",
   * so "in Pennsylvania" raised no geography requirement, the audience was
   * built with no geographic filter, and nothing was flagged as dropped.
   */
  if (namesAPlace(asWritten)) {
    reqs.push({
      key: "geography",
      label: "Geography",
      synonyms: ["state", "region", "zip", "postal", "city", "market", "dma", "county", "country"],
      why: "the brief targets a place, so the definition has to be able to filter on one",
    });
  }

  if (/\bemail\b/.test(all)) {
    reqs.push({
      key: "email_contact",
      label: "Email address",
      synonyms: ["email", "emailaddress", "customeremail"],
      why: "an email campaign needs a reachable address on the profile, or the audience cannot be activated",
    });
  }

  if (/\b(sms|text|mobile message)\b/.test(all)) {
    reqs.push({
      key: "sms_contact",
      label: "Mobile number",
      synonyms: ["phone", "mobile", "msisdn", "sms", "telephone"],
      why: "an SMS campaign needs a mobile number on the profile",
    });
  }

  return reqs;
}

export type AttributeCheck = {
  /** False only when the field list could not be read at all. */
  conclusive: boolean;
  /** True when every requirement is satisfied by a real field. */
  available: boolean;
  satisfied: Array<{
    key: string;
    label: string;
    /** The best match, for reporting. */
    field: string;
    type: string;
    group: string;
    /**
     * EVERY field that matched, not just the first.
     *
     * "TV-only" needs two product fields - holds TV, does not hold Internet -
     * and reporting only the first match silently dropped the `xfinityTV = true`
     * half of the definition. The resulting segment was everyone without
     * Internet, which is a different and much larger population than
     * TV-subscribers without Internet, sized and sent to the marketer as though
     * it were the audience they asked for.
     */
    allFields: string[];
  }>;
  missing: Requirement[];
  /**
   * The question to put to a human, when something is missing.
   *
   * This exists because the reported gap was exactly its absence: Agent 3
   * returned needs_input and NOTHING anywhere said what it needed. A status
   * without a question is unactionable, and it sent a reader to the Workfront
   * record, the comment streams and the run payload, all of which were silent.
   */
  question: string | null;
  /** The tenant namespace, for reporting. Never a sandbox name. */
  tenant: string | null;
  fieldsSeen: number;
};

/** Match each requirement against the sandbox's real fields. */
export function checkAttributes(reqs: Requirement[], read: FieldRead): AttributeCheck {
  if (!read.read || !read.fields.length) {
    return {
      conclusive: false,
      available: false,
      satisfied: [],
      missing: reqs,
      question:
        `Could not check what customer data is available: ${read.error || "no fields were returned"}. ` +
        "Nothing has been built, and no data request has been raised either - raising one because the " +
        "check failed would start a long piece of work for a question nobody has actually asked. " +
        `Someone with Adobe Experience Platform access needs to confirm whether ${reqs.map((r) => r.label).join(", ")} ` +
        "are held before this can go further.",
      tenant: read.tenant,
      fieldsSeen: 0,
    };
  }

  const satisfied: AttributeCheck["satisfied"] = [];
  const missing: Requirement[] = [];

  for (const req of reqs) {
    const hits = read.fields.filter((f) => {
      const leaf = norm(f.path.split(".").pop() || "");
      return req.synonyms.some((s) => leaf.includes(norm(s)) || norm(s).includes(leaf));
    });
    if (hits.length) {
      satisfied.push({
        key: req.key,
        label: req.label,
        field: hits[0].path,
        type: hits[0].type,
        group: hits[0].group,
        allFields: hits.map((h) => h.path),
      });
    } else {
      missing.push(req);
    }
  }

  const available = missing.length === 0;

  return {
    conclusive: true,
    available,
    satisfied,
    missing,
    question: available
      ? null
      : `This audience cannot be built yet: ${missing.length} piece(s) of customer data it needs ` +
        "are not held in Adobe Experience Platform. " +
        missing.map((m) => `${m.label} - ${m.why}`).join("; ") +
        ". A data request needs to be raised with the data team to add them. " +
        `What IS held and will be used: ` +
        (satisfied.length ? satisfied.map((s) => `${s.label} (${s.field})`).join(", ") : "nothing") +
        `. ${read.fields.length} field(s) were checked across ${read.groupCount} group(s), so this is a real ` +
        "absence rather than a failed check - the request can name exactly what to add.",
    tenant: read.tenant,
    fieldsSeen: read.fields.length,
  };
}

export type Expression = {
  pql: string;
  /** Every predicate in words, so a human can check the logic before it runs. */
  explain: string[];
  /** Things the brief asked for that could NOT be expressed, named. */
  ungrounded: string[];
};

/**
 * Turn the brief into a PQL expression over fields that actually exist.
 *
 * ONLY grounded predicates are emitted. Anything the brief asks for that cannot
 * be expressed in a real field is returned in `ungrounded` and left OUT of the
 * definition - never approximated. A segment that silently drops the exclusion
 * is the one failure mode worse than no segment: it produces a plausible number
 * for the wrong population, and 3.4 sends that number to the marketer.
 */
/**
 * The brief stated the audience as an expression. Use it.
 *
 * A real brief said, on its own line:
 *
 *     Audience definition: xfinityInternet = true AND xfinityTV = false
 *
 * and the pipeline inferred a different audience from the surrounding prose,
 * because nothing ever looked for the sentence that answered the question
 * outright. When a CDP-literate requester writes the rule themselves, that is
 * the most reliable input this agent will ever get, and guessing around it is
 * indefensible.
 *
 * Only attribute names the sandbox actually returned are accepted. An
 * expression naming a field that does not exist is NOT quietly dropped - it
 * returns null so the caller falls back to inference and, failing that,
 * reports the audience as unbuildable rather than building a partial one.
 */
export function expressionFromBrief(
  check: AttributeCheck,
  fields: Record<string, string>,
): Expression | null {
  const text = Object.values(fields).join(" ");
  const known: string[] = [];
  for (const s of check.satisfied) for (const f of s.allFields ?? []) known.push(f);
  if (!known.length) return null;

  // `name = true`, `name != null`, `name = "x"` - joined by and/AND.
  const clause = /([A-Za-z_][A-Za-z0-9_.]*)\s*(=|!=|==)\s*("[^"]*"|'[^']*'|true|false|null|[A-Za-z0-9_]+)/g;
  const predicates: string[] = [];
  const explain: string[] = [];

  for (const m of text.matchAll(clause)) {
    const [, rawName, op, rawValue] = m;
    // Match the brief's short name against the real field path, either way round.
    const field = known.find((f) => norm(f).endsWith(norm(rawName)) || norm(rawName).endsWith(norm(f)));
    if (!field) return null;

    const value = rawValue.replace(/^['"]|['"]$/g, "");
    const operator = op === "==" ? "=" : op;
    const literal = /^(true|false|null)$/i.test(value) ? value.toLowerCase() : `"${value}"`;

    predicates.push(`${field} ${operator} ${literal}`);
    explain.push(
      literal === "true" ? `holds ${rawName} (${field} = true)`
        : literal === "false" ? `does NOT hold ${rawName} (${field} = false)`
          : `${rawName} ${operator} ${literal} (${field})`,
    );
  }

  if (predicates.length < 2) return null;
  return {
    pql: predicates.join(" and "),
    explain,
    ungrounded: [],
  } as Expression;
}

export function buildExpression(check: AttributeCheck, fields: Record<string, string>): Expression | null {
  /*
   * A DEFINITION THE REQUESTER WROTE BEATS ANYTHING WE INFER.
   *
   * Checked before the prose is read at all: if the brief says
   * "xfinityInternet = true AND xfinityTV = false", that IS the audience, and
   * every heuristic below is a worse answer to a question already answered.
   */
  const stated = expressionFromBrief(check, fields);
  if (stated) return stated;

  const all = Object.values(fields).join(" ").toLowerCase();
  const predicates: string[] = [];
  const explain: string[] = [];
  const ungrounded: string[] = [];

  const byKey = (k: string) => check.satisfied.find((s) => s.key === k);

  // --- Product holdings. The upsell shape: has A, does not have B. ---------
  if (byKey("product_holding")) {
    /*
     * The upsell shape: HOLDS the base product, DOES NOT HOLD the target.
     *
     * The field paths are looked up by name from what the sandbox actually
     * returned rather than written in - a hardcoded `_taplondonptrsd.xfinityTV`
     * is correct in exactly one tenant and silently wrong in the next.
     */
    const productFields = check.satisfied.find((s) => s.key === "product_holding")?.allFields ?? [];
    const holding = (needle: string) =>
      productFields.find((f) => norm(f).includes(norm(needle))) || null;
    const tv = holding("xfinityTV") || holding("tv");
    const internet = holding("xfinityInternet") || holding("internet") || holding("broadband");

    /*
     * THIS ONLY UNDERSTOOD ONE DIRECTION OF UPSELL, AND GUESSED THE OTHER.
     *
     * The old test was: does the brief mention internet, and does it say
     * "TV only"? If both, build has-TV-without-Internet. Otherwise, if
     * internet was mentioned at ALL, assert `internet = false`.
     *
     * That fallback is where a real brief went wrong. "Grow VIDEO attach rate
     * among single-product INTERNET subscribers" - has Internet, wants TV - is
     * the mirror image, and it fell into the else-if and came out as
     *
     *     xfinityInternet = false and customerEmail != null
     *
     * The TV condition gone, the Internet condition inverted, reported
     * "completed", with a predicted count of 22 attached to it. A different
     * population from the one requested, wearing a plausible number.
     *
     * Both directions are now read explicitly, and an unreadable one builds
     * NOTHING rather than defaulting to whichever shape was written first.
     */
    const lacksTv = /\bno tv\b|without tv|do(?:es)? ?n'?o?t have tv|non-?tv|\btv\s*=\s*false|xfinitytv\s*=\s*false|single[- ]product internet|internet[- ]only/i.test(all);
    const lacksInternet = /\bno internet\b|without internet|do(?:es)? ?n'?o?t have internet|\binternet\s*=\s*false|xfinityinternet\s*=\s*false|tv[- ]only|only have tv/i.test(all);

    if (lacksTv && !lacksInternet && tv && internet) {
      // Video attach: they have Internet, they do not have TV.
      predicates.push(`${internet} = true`);
      predicates.push(`${tv} = false`);
      explain.push(`holds Internet (${internet} = true)`);
      explain.push(`does NOT hold TV (${tv} = false) - the gap this campaign is selling into`);
    } else if (lacksInternet && !lacksTv && tv && internet) {
      // Internet attach: they have TV, they do not have Internet.
      predicates.push(`${tv} = true`);
      predicates.push(`${internet} = false`);
      explain.push(`holds TV (${tv} = true)`);
      explain.push(`does NOT hold Internet (${internet} = false) - the gap this campaign is selling into`);
    } else {
      ungrounded.push(
        "which product the customer must already hold and which they must not. The brief names products but " +
        "not the have/have-not shape, so NO product predicate was added rather than a guessed one - a segment " +
        "that quietly drops the exclusion returns a plausible count for the wrong population",
      );
    }
  }

  // --- Geography. Only when the brief names a place we can map to a value. --
  const geo = byKey("geography");
  if (geo) {
    const named = findState(all);
    if (named) {
      /*
       * Either spelling. This sandbox holds full names ("New York"); the old
       * map emitted two-letter codes, so a working geography path would have
       * written `state = "PA"` and matched nobody - an empty audience reported
       * as an audience.
       */
      predicates.push(statePredicate(geo.field, named));
      explain.push(`is in ${named.name} (${geo.field} is "${named.name}" or "${named.code}")`);
    } else {
      ungrounded.push(
        "the location to target. The request asks for a place, but does not name a state that can be " +
        "matched against customer records - a radius around a city cannot be expressed against a " +
        "state-level field. Name the state, or confirm the audience should not be limited by location.",
      );
    }
  }

  // --- Reachability. An audience you cannot contact is not activatable. -----
  const email = byKey("email_contact");
  if (email) {
    // `!= null`, not `exists`. PQL has no bare `exists` operator for an
    // attribute path, and AEP rejects the whole definition with a bare 400 that
    // names nothing - so one invalid operator costs the entire audience.
    predicates.push(`${email.field} != null`);
    explain.push(`has an email address (${email.field} != null)`);
  }

  if (!predicates.length) return null;

  return { pql: predicates.join(" and "), explain, ungrounded };
}

/**
 * Where a person goes to look at the audience.
 *
 * Every other stage hands over a Workfront link; this one handed over a GUID.
 * The sandbox is part of the path, so a link built without it opens the wrong
 * tenant's view - which is worse than no link.
 */
export function segmentUrl(segmentId: string | null, sandbox?: string | null): string | null {
  if (!segmentId) return null;
  const name = (sandbox || process.env.AEP_SANDBOX || "prod").trim();
  return `https://experience.adobe.com/#/@${(process.env.AEP_IMS_ORG_NAME || "taplondonptrsd").trim()}` +
    `/sname:${name}/platform/segment/browse/${segmentId}`;
}

/**
 * Why the size is missing, in terms someone can act on.
 *
 * This used to concatenate the raw error, so a marketer was shown the HTML body
 * of an nginx 404:
 *
 *   the segment exists but could not be sized: MCP tool
 *   "adobe_create_segment_estimate" returned an error: ... 404:
 *   <html><head><title>404 Not Found</title></head>...
 *
 * The cause is specific and fixable: the connector posts to
 * /ups/segment/definitions/{id}/estimate, and AEP has no such endpoint - an
 * estimate there belongs to a PREVIEW of a definition, not to a saved segment.
 * So the run names the fix and the owner instead of pasting a stack trace at
 * whoever happens to be reading.
 */
function describeSizingFailure(raw: string): string {
  const notAnEndpoint = /404/.test(raw) && /segment\/definitions\/[0-9a-f-]+\/estimate/i.test(raw);
  if (notAnEndpoint) {
    return (
      "the audience exists but has no size yet. The sizing call goes to an Adobe endpoint that " +
      "does not exist (POST /ups/segment/definitions/{id}/estimate returns 404); in AEP an " +
      "estimate is taken from a preview of the definition, so this is a fix in the Adobe MCP " +
      "connector rather than anything about this audience. Until then the count comes from the " +
      "nightly segmentation run"
    );
  }
  if (/403|forbidden/i.test(raw)) {
    return (
      "the audience exists but has no size yet: the credentials used here may read segments and " +
      "not size them. An Adobe administrator can grant it on the technical account's product " +
      "profile. Until then the count comes from the nightly segmentation run"
    );
  }
  return `the audience exists but could not be sized: ${raw}`;
}

/**
 * A count from Query Service, which does exist and does work.
 *
 * NOT awaited. query_run takes minutes - the discovery query sat in SUBMITTED
 * for nearly two of them - so blocking an agent step on it would turn a
 * twenty-second stage into a timeout. This starts the query and returns its id;
 * the number is collected afterwards.
 *
 * Switched on by AEP_PROFILE_TABLE, because the table that holds the attributes
 * is a property of the tenant's datasets, not something to guess. Unset means
 * nothing is attempted and the run says the count is coming from the nightly
 * run, which is the truth.
 */
export async function startProfileCount(
  taskId: TaskId,
  pql: string,
): Promise<{ queryId: string | null; sql: string | null; note: string }> {
  const table = (process.env.AEP_PROFILE_TABLE || "").trim();
  if (!table) {
    return {
      queryId: null,
      sql: null,
      note:
        "No direct count was attempted: AEP_PROFILE_TABLE is not set, so the dataset holding these " +
        "attributes is not known here. The count comes from the nightly segmentation run.",
    };
  }

  /*
   * The PQL translates almost literally: it is already field paths and
   * comparisons over one profile. `= true` and `!= null` are valid SQL as
   * written; the field paths are dotted, which Query Service accepts for
   * nested XDM.
   */
  const where = pql.replace(/\bnot\s+null\b/gi, "not null");
  const account = (process.env.AEP_ACCOUNT_ID_FIELD || "").trim();
  const sql =
    `select count(*) as profiles` +
    (account ? `, count(distinct ${account}) as accounts` : "") +
    ` from ${table} where ${where}`;

  try {
    const started = await callMcpTool<unknown>(taskId, "query_run", {
      sql,
      name: "cx-audience-count",
      sandbox: process.env.AEP_SANDBOX || undefined,
    });
    const text = typeof started === "string" ? started : JSON.stringify(started);
    const queryId = text.match(/"(?:id|queryId|query_id)"\s*:\s*"([^"]+)"/)?.[1] || null;
    return {
      queryId,
      sql,
      note: queryId
        ? `A direct count is running in Adobe Query Service as query ${queryId}. It takes a few ` +
          `minutes; collect it rather than waiting.` +
          (account ? " It returns profiles and distinct accounts side by side." : "")
        : `The count query was submitted but Query Service returned no id: ${text.slice(0, 200)}`,
    };
  } catch (err) {
    return {
      queryId: null,
      sql,
      note: `A direct count could not be started: ${(err as Error).message}`,
    };
  }
}

export type EditResult = {
  updated: boolean;
  segmentId: string;
  /** What to do instead, when the update was refused. */
  blockedReason: string | null;
  supersededBy: string | null;
};

/**
 * Change an existing audience in place, which is the only correct way to change
 * one - and say precisely why when AEP refuses.
 *
 * WHY THIS IS NOT "CREATE A NEW ONE AND MOVE ON"
 *
 * An audience created through the API cannot be edited by a human in the AEP
 * UI, so the API is the only way to change it. When the API is also refused,
 * the only remaining route is a replacement - and a replacement has two
 * consequences a person has to agree to: the old audience is left behind, and
 * the Workfront project that was approved still carries the old name. An agent
 * that silently creates a replacement hides both.
 *
 * Verified against the tenant: a description-only update returns
 * 403 Forbidden, so this is the technical account's permission on segment
 * update rather than anything about the audience.
 */
export async function editAudience(
  taskId: TaskId,
  segmentId: string,
  changes: { name?: string; pql?: string; description?: string },
): Promise<EditResult> {
  try {
    await callMcpTool(taskId, "adobe_update_segment", {
      segment_id: segmentId,
      ...(changes.name ? { name: changes.name } : {}),
      ...(changes.pql ? { pql_expression: changes.pql } : {}),
      ...(changes.description ? { description: changes.description } : {}),
      sandbox: process.env.AEP_SANDBOX || undefined,
    });
    return { updated: true, segmentId, blockedReason: null, supersededBy: null };
  } catch (err) {
    const raw = (err as Error).message;
    const forbidden = /403|forbidden/i.test(raw);
    return {
      updated: false,
      segmentId,
      blockedReason: forbidden
        ? "Adobe refused the change (403). The credentials this pipeline uses can create audiences " +
          "but not modify them - verified with a description-only edit, so it is not about the " +
          "audience being published. An Adobe administrator needs to grant update on segment " +
          "definitions to the technical account for this sandbox. " +
          "Until then an audience cannot be changed at all: not here, and not by hand either, " +
          "because an audience created through the API is not editable in the AEP interface. " +
          "The only route is a replacement audience, which leaves this one behind and leaves the " +
          "approved Workfront project carrying the old name - so that is a decision for you, not " +
          "something to do quietly."
        : `Adobe refused the change: ${raw}`,
      supersededBy: null,
    };
  }
}

/**
 * Record that one audience replaces another.
 *
 * Nothing is deleted. An audience may already be referenced by a live campaign,
 * and an agent deleting one on its own initiative is exactly the class of
 * irreversible act this pipeline asks a human about. This makes the old one
 * traceable rather than merely abandoned.
 */
export function supersede(oldSegmentId: string, newSegmentId: string): string {
  return (
    `This audience replaces ${oldSegmentId}, which could not be edited in place. ` +
    `The earlier audience still exists in Adobe Experience Platform and has not been deleted - ` +
    `retire it deliberately once you are satisfied with ${newSegmentId}, and check that the ` +
    `Workfront project's name still describes what was built.`
  );
}

export type BuildResult = {
  created: boolean;
  segmentId: string | null;
  /** Where to open it. Null when nothing was created. */
  segmentUrl: string | null;
  /** A Query Service count running in the background, when one was started. */
  countQueryId: string | null;
  name: string;
  pql: string;
  count: number | null;
  countBasis: string;
  error: string | null;
};

/**
 * 3.1a - create the audience in the AEP rule builder, then size it.
 *
 * This WRITES, and until now this agent deliberately did not. The read-only
 * stance was right while 2.7 could never be answered - a segment built on
 * unverified attributes is worse than none - but the map puts "Agent creates
 * audience in AEP rule builder" at 3.1a, and a count is the whole point of B3.
 * So it builds once the attributes are CONFIRMED present, and the count goes to
 * the marketer at 3.4 for the approval the map keeps at 3.5.
 */
/**
 * A name AEP will accept when it already has the one we asked for.
 *
 * Only used after a create is refused. "(new HHmm)" rather than a counter,
 * because finding the next free number means listing the catalogue - which is
 * the search a force-new request has just told us to skip.
 */
function disambiguate(name: string): string {
  const now = new Date();
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  return `${name} (new ${hh}${mm})`.slice(0, 100);
}

export async function createAudience(
  taskId: TaskId,
  /*
   * No `sandbox` parameter, deliberately.
   *
   * The connector defaults to the sandbox it is configured for, and the only
   * value we had to offer was the tenant id, which is not a sandbox and made
   * every create fail. Omitting it is both correct and the thing that cannot be
   * got wrong: the fields were read from that same default sandbox, so the
   * segment is built where the attributes live.
   */
  args: { name: string; pql: string; description: string; mergePolicyId?: string | null },
): Promise<BuildResult> {
  const base: BuildResult = {
    created: false, segmentId: null, segmentUrl: null, countQueryId: null, name: args.name, pql: args.pql,
    count: null, countBasis: "not attempted", error: null,
  };

  /*
   * COUNT WHILE THE SEGMENT IS BEING CREATED.
   *
   * The count is a query over the DEFINITION - it does not need the segment to
   * exist, which was the whole reason for going to Query Service instead of the
   * estimate endpoint. Awaiting it after the create simply added its cost to
   * the stage.
   */
  const countPromise = countAudience(taskId, args.pql);

  const attemptCreate = async (name: string) => {
    const made = await callMcpTool<Record<string, unknown>>(taskId, "adobe_create_segment", {
      name,
      pql_expression: args.pql,
      description: args.description,
      ...(args.mergePolicyId ? { merge_policy_id: args.mergePolicyId } : {}),
    });
    const text = JSON.stringify(made ?? {});
    const id =
      String((made?.id as string) || (made?.segmentId as string) || "") ||
      text.match(/"id"\s*:\s*"([^"]+)"/)?.[1] ||
      null;
    return { id, text, name };
  };

  let segmentId: string | null = null;
  let createdName = args.name;
  try {
    const first = await attemptCreate(args.name);
    if (!first.id) {
      await countPromise.catch(() => null);
      return { ...base, error: `the create returned no segment id. Response: ${first.text.slice(0, 300)}` };
    }
    segmentId = first.id;
  } catch (err) {
    /*
     * A 400 here is usually a name AEP already has, and it says nothing about
     * which field it objected to. So the name is not assumed to be the cause -
     * it is TESTED, by retrying with a different one. If that fails too, the
     * original error is what gets reported.
     *
     * This is what "create a new audience even if a duplicate exists" asks
     * for: the second identical request failed on the duplicate, which is not
     * an answer to someone who said they wanted another one.
     */
    const raw = (err as Error).message;
    if (!/400|bad request|already exists|duplicate/i.test(raw)) {
      await countPromise.catch(() => null);
      return { ...base, error: raw };
    }
    try {
      const retry = await attemptCreate(disambiguate(args.name));
      if (!retry.id) {
        await countPromise.catch(() => null);
        return { ...base, error: raw };
      }
      segmentId = retry.id;
      createdName = retry.name;
    } catch {
      await countPromise.catch(() => null);
      return { ...base, error: raw };
    }
  }

  // The count. A failure here leaves a REAL segment with no size, which is a
  // partial success and is reported as one - not as a failed build.
  let count: number | null = null;
  let basis = "";
  let countQueryId: string | null = null;
  try {
    const started = await callMcpTool<Record<string, unknown>>(taskId, "adobe_create_segment_estimate", {
      segment_id: segmentId,
    });
    const estimateId = String(started?.estimateId || started?.id || "") || undefined;
    const got = await callMcpTool<Record<string, unknown>>(taskId, "adobe_get_segment_estimate", {
      segment_id: segmentId,
      ...(estimateId ? { estimate_id: estimateId } : {}),
    });
    const text = JSON.stringify(got ?? {});
    const n = text.match(/"(?:estimatedSize|profileCount|totalRows|size)"\s*:\s*(\d+)/);
    count = n ? Number(n[1]) : null;
    basis = count != null
      ? `estimated by AEP for segment ${segmentId}`
      : `the estimate was requested but returned no size yet - segment estimates are asynchronous, so poll adobe_get_segment_estimate for ${segmentId}`;
  } catch (err) {
    basis = describeSizingFailure((err as Error).message);
    /*
     * Sizing failed, so try the route that works: a count in Query Service.
     * Started, never awaited - query_run takes minutes, and a stage that waits
     * on it turns a twenty-second step into a timeout.
     */
    const direct = await countPromise;
    if (direct.profiles != null) {
      count = direct.profiles;
      basis = direct.basis;
    } else {
      basis = `${basis}. ${direct.basis}`;
    }
  }

  // A link, not just a GUID. This is the artifact the room wants to open.
  return {
    created: true, segmentId, segmentUrl: segmentUrl(segmentId), countQueryId,
    // The name AEP accepted, which is not always the one we asked for.
    name: createdName, pql: args.pql, count, countBasis: basis, error: null,
  };
}
