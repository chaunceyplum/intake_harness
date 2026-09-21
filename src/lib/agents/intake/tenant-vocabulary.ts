import { callMcpTool } from "@/lib/mcp-client";
import type { TaskId } from "@/lib/pipeline/types";
import { widerPlaces } from "@/lib/agents/shared/places";

/**
 * The tenant's own vocabulary, and how a marketer's words map onto it.
 *
 * WHY THIS EXISTS
 *
 * Read off the live tenant (taplondonptrsd, 19 Sep 2026), the request and
 * project forms are mostly ENUMERATIONS with closed value lists:
 *
 *   Region            uk | de | us
 *   Primary Channel   paid_media | email | web
 *   Audience          existing_customer | new_customer | high_value_customer
 *   Audience to be Targeted   Prospects | Customers
 *   Type              New | Revision / Edit to existing
 *
 * We were writing prose into them - "New York" into Region, "Email" into
 * Primary Channel, "Subscriber - Existing Customers" into Audience - and
 * Workfront dropped every one. Previous investigations found the wrong NAME
 * (label versus parameter name) and fixed that; this is the layer underneath:
 * the right field, the wrong VALUE.
 *
 * Adobe's own guidance is explicit about the shape of this mistake, for
 * statuses: "NEVER use the display name as the condition value... The query
 * service only accepts status codes." The same is true of every enumeration on
 * a custom form.
 *
 * WHAT IT REFUSES TO DO
 *
 * It does not guess. A value that cannot be mapped with confidence is returned
 * as unmapped, with the allowed values named, so the run can say "Region only
 * accepts uk, de or us on this form, and the brief says New York" - which is a
 * fact a marketer or an administrator can act on. Writing `us` because New York
 * is in America is a judgement about the client's data model, not a
 * translation, and it belongs to them.
 */

export type FormField = {
  /** What Workfront is addressed by: `DE:Name of the Campaign`, or `status`. */
  name: string;
  label: string;
  dataType: string;
  /** Closed list, when the field is an enumeration. */
  allowed: string[];
};

export type MappedValue =
  | { ok: true; field: FormField; value: string; note: string | null }
  | { ok: false; field: FormField; given: string; why: string };

const norm = (s: unknown) =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Concepts a marketer writes, and the tenant values they mean.
 *
 * Deliberately narrow. Each entry is a phrase whose meaning is not in doubt
 * for THIS tenant's value list - "email only" means the email channel - and
 * nothing here decides a question that is really the client's, like whether a
 * US state belongs under a `us` region or needs a state-level field adding.
 */
const SYNONYMS: Record<string, string[]> = {
  // Primary Channel
  email: ["email", "e mail", "eml", "email only", "email campaign"],
  paid_media: ["paid media", "paid", "display", "programmatic", "social", "paid social", "ooh"],
  web: ["web", "website", "site", "onsite", "on site", "web only"],

  // Audience (who they are to the business)
  /*
   * No bare "customer"/"customers" here. On a list whose other value is
   * new_customer, that word distinguishes nothing - and it is contained in
   * "Prospect - Non-Customers", which is how this matcher first read a
   * prospects audience as existing customers.
   */
  existing_customer: [
    "existing customer", "existing customers", "existing subscriber", "existing subscribers",
    "subscriber existing customers", "current customer", "current customers",
    "existing residential subscribers", "existing base", "already a customer",
  ],
  new_customer: ["new customer", "new customers", "prospect", "prospects", "non customer", "non customers", "acquisition"],
  high_value_customer: ["high value", "high value customer", "high value customers", "premium", "vip"],

  // Audience to be Targeted (the other form's coarser pair)
  Customers: ["existing customer", "existing customers", "existing subscribers", "subscriber existing customers", "current customers"],
  Prospects: ["prospect", "prospects", "non customer", "non customers", "new customer", "new customers", "acquisition"],

  // Type
  New: ["new", "new request", "first time"],
  "Revision / Edit  to existing": ["revision", "edit", "amend", "change to existing", "update existing"],
};

/*
 * THE PLACE TABLE MOVED TO shared/places.ts, AND THE MOVE IS THE POINT.
 *
 * It lived here while the PARSER kept a different one that only knew US
 * states. So the parser never captured "US" out of a brief, and this mapper -
 * which would have mapped it happily - was never handed a value to map. The
 * bug was not in either table; it was in there being two of them.
 *
 * Shared now, for the same reason the state list is shared with the audience
 * agent: the two cannot disagree about what counts as a place.
 *
 * The shared table also gained the entry this one was missing - the United
 * States. It had the UK, Germany, France, Canada, India and Australia, on a
 * project for a US cable company.
 */

/** Every field the form exposes for this entity, with its allowed values. */
export async function readFormFields(taskId: TaskId, entity: "issue" | "project"): Promise<FormField[]> {
  /*
   * A FIELD NOT SEARCHED FOR IS A FIELD THAT DOES NOT EXIST.
   *
   * insights_search_fields only returns fields matching its query, so this
   * list decides what the form is understood to contain. "budget" was absent,
   * so the tenant's real Budget field was never read - and the brief's budget
   * was then reported as "this form has no Budget field", which was confidently
   * wrong rather than merely unhelpful.
   *
   * They run in parallel because they are independent; adding one costs a
   * round trip that happens concurrently, and missing one produces a false
   * statement about the client's own form.
   */
  const queries = [
    "campaign", "audience", "objective", "launch", "channel", "region",
    "product", "type", "status", "priority", "name", "date",
    "budget", "cost", "agency", "vendor", "market", "offer", "exclusion",
  ];

  const chunks = await Promise.all(
    queries.map((query) =>
      callMcpTool<unknown>(taskId, "insights_search_fields", { entity_ids: [entity], query })
        .catch(() => null),
    ),
  );

  const byName = new Map<string, FormField>();
  for (const chunk of chunks) {
    if (!chunk) continue;
    const text = typeof chunk === "string" ? chunk : JSON.stringify(chunk);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    for (const raw of Array.isArray(parsed) ? parsed : []) {
      const f = raw as {
        id?: string; name?: string; label?: string; dataType?: string;
        possibleValues?: { name?: string }[] | null;
      };
      /*
       * `name` is what Workfront is addressed by - but this tenant returns it
       * as null for most custom fields, giving only a label and an internal
       * id. Skipping those dropped Audience, Primary Channel, Region and Type:
       * precisely the fields worth filling.
       *
       * A custom field is addressed as `DE:<parameter name>`, and on this
       * tenant the parameter name is the label. Verified against the live
       * request: `DE:Audience = existing_customer` writes cleanly.
       *
       * Native fields (status, priority) come back with a real name and are
       * used as given - they are not DE: fields and prefixing one would
       * invent a field that does not exist.
       */
      if (!f.label) continue;
      const native = f.name && !/^DE:/i.test(f.name) && !/^(issue|project)[._]/i.test(f.name);
      const name = f.name && /^DE:/i.test(f.name)
        ? f.name
        : native
          ? String(f.name)
          : `DE:${f.label}`;
      if (!name) continue;
      if (byName.has(name)) continue;
      byName.set(name, {
        name,
        label: String(f.label),
        dataType: String(f.dataType || "string"),
        allowed: (f.possibleValues || []).map((v) => String(v?.name ?? "")).filter(Boolean),
      });
    }
  }
  return [...byName.values()];
}

/**
 * Map one value onto what the field will accept.
 *
 * Tiers, strongest first:
 *   1. it is already an allowed value (exact, or case/punctuation-insensitive)
 *   2. a synonym whose meaning is unambiguous for this value list
 *   3. the value appears inside an allowed value, or vice versa, and only one
 *      allowed value matches - "email" inside "email_only" would qualify
 *
 * A free-text field takes the value as written. Anything else is unmapped,
 * named, with the allowed values quoted so the run can explain itself.
 */
export function mapValue(field: FormField, given: unknown): MappedValue {
  const raw = String(given ?? "").trim();
  if (!raw) return { ok: false, field, given: raw, why: "no value was given" };

  if (!field.allowed.length) {
    return { ok: true, field, value: raw, note: null };
  }

  const exact = field.allowed.find((a) => a === raw);
  if (exact) return { ok: true, field, value: exact, note: null };

  /*
   * THE PLACE IS WIDENED UNTIL THE FIELD RECOGNISES ONE.
   *
   * A Region field is whatever the client made it. This tenant offers uk, de
   * and us; the next might offer north_america | emea | apac, or a list of
   * states, or country names in full. Keying off the shape of the list fit
   * exactly one of those.
   *
   * So "New York" is widened to NY, then the US, then North America, and each
   * step is offered to the field narrowest first. A list of states matches at
   * step one, country codes at step three, continents at step four - and a
   * list with none of them refuses, which is the right answer.
   *
   * The note always says which step matched: "New York" filed under
   * "north_america" is a fact worth stating, and under "emea" would be a bug
   * worth seeing.
   */
  for (const wider of widerPlaces(raw)) {
    const hit =
      field.allowed.find((a) => norm(a) === norm(wider.as)) ||
      field.allowed.find((a) => norm(a).replace(/\s+/g, "") === norm(wider.as).replace(/\s+/g, ""));
    if (hit) {
      return {
        ok: true,
        field,
        value: hit,
        note:
          wider.level === "as written"
            ? `matched "${raw}" to "${hit}"`
            : `${raw} ${wider.because}, so this is filed under "${hit}" - this form has no ${wider.missing} field, so that detail travels in the brief`,
      };
    }
  }

  const loose = field.allowed.find((a) => norm(a) === norm(raw));
  if (loose) {
    return { ok: true, field, value: loose, note: `matched "${raw}" to "${loose}"` };
  }

  /*
   * SCORE BY SPECIFICITY, and refuse a tie.
   *
   * Taking the first allowed value that matched read "Prospect - Non-Customers"
   * as existing_customer, because that value listed "customers" and the phrase
   * contains it. The longest matching phrase is the most specific one, and
   * "non customer" beats "customer" on exactly the case that matters.
   *
   * When two values score the same the brief is genuinely ambiguous against
   * this form, and a person should say which - not us.
   */
  const scored = field.allowed
    .map((allowed) => {
      const phrases = SYNONYMS[allowed] || [];
      const best = phrases
        .filter((p) => norm(raw).includes(norm(p)) || norm(p) === norm(raw))
        .reduce((longest, p) => (norm(p).length > longest ? norm(p).length : longest), 0);
      return { allowed, score: best };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 1 || (scored.length > 1 && scored[0].score > scored[1].score)) {
    return { ok: true, field, value: scored[0].allowed, note: `read "${raw}" as "${scored[0].allowed}"` };
  }
  if (scored.length > 1) {
    return {
      ok: false,
      field,
      given: raw,
      why:
        `"${raw}" reads equally as ${scored.slice(0, 3).map((x) => `"${x.allowed}"`).join(" or ")} ` +
        "on this form, and choosing between them changes who gets targeted",
    };
  }

  const contained = field.allowed.filter(
    (a) => norm(a).includes(norm(raw)) || norm(raw).includes(norm(a)),
  );
  if (contained.length === 1) {
    return { ok: true, field, value: contained[0], note: `matched "${raw}" to "${contained[0]}"` };
  }

  return {
    ok: false,
    field,
    given: raw,
    why:
      `"${raw}" is not one of the values this field accepts (${field.allowed.slice(0, 8).join(", ")}` +
      `${field.allowed.length > 8 ? ", …" : ""})`,
  };
}

/**
 * Find the form field that holds a concept, by label.
 *
 * Label rather than name, because a label is what a Workfront administrator
 * calls it and what a human would look for on the form. The name is what gets
 * written.
 */
export function fieldByLabel(fields: FormField[], ...labels: string[]): FormField | null {
  for (const label of labels) {
    const hit = fields.find((f) => norm(f.label) === norm(label));
    if (hit) return hit;
  }
  for (const label of labels) {
    const hit = fields.find((f) => norm(f.label).includes(norm(label)));
    if (hit) return hit;
  }
  return null;
}
