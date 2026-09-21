import type { TaskId } from "@/lib/pipeline/types";
import { readFormFields, mapValue, fieldByLabel, type MappedValue } from "./tenant-vocabulary";

/**
 * Fill everything the form can actually hold, and say what it could not.
 *
 * WHAT WAS HAPPENING
 *
 * Intake wrote four values and dropped the rest, and the run reported the
 * dropped ones as having "no matching field on this form". That was true of
 * some and wrong about others: the request form on this tenant holds Audience,
 * Primary Channel, Region, Type, Product Name and Priority, and we were
 * offering none of them - because our field map was built from OUR field names
 * rather than from what the form exposes.
 *
 * So this works the other way round. It reads the form, then asks of each
 * field: does the brief say anything this field could hold? That is what a
 * Workfront administrator does when they set up an intake, and it is the
 * difference between a request a reviewer can act on and a title with a
 * paragraph under it.
 *
 * WHAT IT WILL NOT DO
 *
 * Guess. A brief that says "New York" against a Region field offering uk, de
 * and us is a mismatch between the campaign and the form, and the honest
 * outcome is to say so - to the marketer, who can answer, and in the record,
 * where an administrator can see that this tenant's Region field cannot
 * express a US state. Writing `us` would hide a real modelling gap behind a
 * plausible value.
 */

export type FieldPlan = {
  /** name -> value, ready to send to Workfront. */
  writes: Record<string, string>;
  /** What each write means, for the artifact. */
  explains: string[];
  /**
   * The brief said something and it did not get written. TWO different
   * reasons, and the difference decides whether the marketer is asked:
   *
   *   "value"    - the field exists and will not take this value. They can
   *                answer that, so it becomes a question.
   *   "no-field" - nothing on this form can hold it at all. They can do
   *                nothing about it, so it is disclosed and NOT asked.
   *
   * Asking "this form has no Budget field, which should it be?" wastes one
   * of only two questions on something the marketer cannot fix.
   */
  mismatched: { label: string; given: string; why: string; kind: "value" | "no-field" }[];
  /** The form holds this and the brief is silent - worth asking about. */
  unanswered: { label: string; allowed: string[] }[];
  /** What was read, so a reader can see the basis. */
  formFieldCount: number;
};

/** Which brief keys could answer which form field, by the field's own label. */
const CONCEPTS: { labels: string[]; from: string[]; ask: boolean }[] = [
  { labels: ["Name of the Campaign", "Campaign Name"], from: ["campaign_name"], ask: true },
  /*
   * The tenant calls this field "Key Objectives & Success Metrics" - both
   * halves. We were filling it with the business objective alone and dropping
   * the metrics the marketer actually took the trouble to write, so the
   * metrics are offered when the objective is silent.
   */
  {
    labels: ["Objective of the campaign", "Objective", "Key Objectives & Success Metrics"],
    from: ["business_objective", "success_metrics"],
    ask: true,
  },
  { labels: ["Audience to be Targeted"], from: ["customer_type", "audience_description"], ask: true },
  { labels: ["Audience"], from: ["customer_type"], ask: true },
  { labels: ["Primary Channel", "Channel"], from: ["channels"], ask: true },
  { labels: ["Region"], from: ["region"], ask: true },
  /*
   * THE LAUNCH DATE NEVER REACHED WORKFRONT, AND THE LABELS ARE WHY.
   *
   * This looked for "Requested Launch Date" or "Launch Date". Read live, this
   * tenant's request form calls them "Planned Start Date", "Target Due Date"
   * and "Due Date" - so the label never matched, the concept was skipped, and
   * a date the marketer stated plainly was dropped in silence.
   *
   * In-market date is when the campaign goes live, so Planned Start Date is
   * tried first and the due dates only after it. A form that really does say
   * "Requested Launch Date" still matches, because the old labels are kept.
   */
  {
    labels: ["Requested Launch Date", "Launch Date", "Planned Start Date", "Target Due Date", "Due Date"],
    from: ["launch_date"],
    ask: true,
  },
  /*
   * The form has a Budget field. We were capturing the budget out of the
   * brief and then not writing it anywhere - which is the same silent drop,
   * one field along.
   */
  { labels: ["Budget"], from: ["budget"], ask: false },
  /*
   * Named so they are DISCLOSED rather than dropped. If this tenant's form has
   * no Agency or Exclusion field, that is now said out loud instead of the
   * value vanishing - and it is said without asking the marketer a question
   * they cannot answer.
   *
   * The exclusion is usually the most important clause in a brief: "everyone
   * in the Northeast except customers already on a promo rate" is two facts,
   * and losing the second one builds the wrong audience.
   */
  { labels: ["Agency", "Agency Partner", "Creative Agency"], from: ["agency"], ask: false },
  { labels: ["Exclusion", "Exclusions", "Suppression"], from: ["exclusion"], ask: false },
  { labels: ["Product Name"], from: ["product", "line_of_business"], ask: false },
  /*
   * Type is New | Revision / Edit to existing - whether this request is new
   * work or a change to existing work. It was being fed request_type
   * ("Audience + Campaign Execution"), which answers a different question
   * entirely: what the campaign needs done.
   *
   * A fresh intake is New. A brief that came back through triage as rework
   * says so, and `revision_of` is where that lands.
   */
  { labels: ["Type"], from: ["revision_of"], ask: false },
];

/**
 * @param fields the brief as intake extracted it
 * @param entity which form - the request or the project it becomes
 */
export async function planFormWrites(
  taskId: TaskId,
  entity: "issue" | "project",
  fields: Record<string, unknown>,
): Promise<FieldPlan> {
  const form = await readFormFields(taskId, entity);

  const writes: Record<string, string> = {};
  const explains: string[] = [];
  const mismatched: FieldPlan["mismatched"] = [];
  const unanswered: FieldPlan["unanswered"] = [];
  const claimed = new Set<string>();

  for (const concept of CONCEPTS) {
    const field = fieldByLabel(form, ...concept.labels);

    /*
     * THE BRIEF SAID IT AND NO FIELD ON THIS FORM CAN CARRY IT.
     *
     * `continue` here was silent, and it is the reason cannotHold kept
     * reporting [] while real facts were dropped. Read live against the
     * tenant, a brief naming a launch date, a budget, an agency and a request
     * type wrote seven fields and lost four - and said nothing had been
     * withheld.
     *
     * mismatched only ever fired when a field WAS found and its value would
     * not map. A concept whose field does not exist never reached that
     * branch, so "I could not find anywhere to put this" and "I had nothing
     * to put" were indistinguishable from the outside.
     *
     * They are different facts and the marketer needs the difference: one is
     * theirs to answer, the other is ours to fix or theirs to accept.
     */
    if (!field) {
      const given = concept.from.map((k) => fields[k]).find((v) => v != null && String(v).trim() !== "");
      if (given != null) {
        mismatched.push({
          label: concept.labels[0],
          given: String(given),
          why: `this form has no ${concept.labels[0]} field, so it cannot be filed here - it stays in the brief text`,
          kind: "no-field",
        });
      }
      continue;
    }

    if (claimed.has(field.name)) continue;

    let source = concept.from.map((k) => fields[k]).find((v) => v != null && String(v).trim() !== "");

    // A request that is not a revision of anything is new work, and the form
    // has a value for exactly that. Left blank it tells a reviewer nothing.
    if (source == null && concept.labels[0] === "Type" && field.allowed.some((a) => /^new$/i.test(a))) {
      source = field.allowed.find((a) => /^new$/i.test(a)) as string;
    }

    if (source == null) {
      /*
       * The form asks and the brief is silent. For an enumeration that is a
       * good question to put to the marketer - the answers are a short list -
       * and for free text it usually is not, so only closed fields are raised.
       */
      if (concept.ask && field.allowed.length) {
        unanswered.push({ label: field.label, allowed: field.allowed });
      }
      continue;
    }

    /*
     * A DATE FIELD WANTS A DATE, AND THE BRIEF SAYS "14 FEBRUARY".
     *
     * Workfront's date fields take ISO; the marketer writes a day and a month
     * and almost never a year. Sent verbatim the write is refused, which
     * would have turned a dropped date into a rejected one - visible, but
     * still not filed.
     *
     * The missing year is inferred as the NEXT occurrence, because a launch
     * date is a thing in the future. That is a guess, so it is said out loud
     * in the explanation rather than filed silently.
     */
    if (/^date/i.test(field.dataType) && !field.allowed.length) {
      const iso = toIsoDate(String(source));
      if (iso) {
        writes[field.name] = iso.value;
        claimed.add(field.name);
        explains.push(
          `${field.label} = ${iso.value}` +
          (iso.inferredYear ? ` (the brief says "${source}" without a year, read as the next one)` : ""),
        );
        continue;
      }
      mismatched.push({
        label: field.label,
        given: String(source),
        why: `${field.label} needs a date and "${source}" could not be read as one`,
        kind: "value",
      });
      claimed.add(field.name);
      continue;
    }

    const mapped: MappedValue = mapValue(field, source);
    claimed.add(field.name);

    if (mapped.ok) {
      writes[field.name] = mapped.value;
      explains.push(
        `${field.label} = ${mapped.value}` + (mapped.note ? ` (${mapped.note})` : ""),
      );
    } else {
      mismatched.push({ label: field.label, given: mapped.given, why: mapped.why, kind: "value" });
    }
  }

  return { writes, explains, mismatched, unanswered, formFieldCount: form.length };
}

/**
 * The questions worth putting to a marketer, in their words rather than the
 * form's.
 *
 * A closed list is a kind question to ask - it is three options, not an essay -
 * and asking it here is cheaper than a reviewer asking it two days later,
 * which is B2 on the blockers map. A field the brief already answers is never
 * asked about.
 */
export function questionsFromPlan(plan: FieldPlan): string[] {
  const out: string[] = [];

  for (const m of plan.mismatched) {
    // A missing field is not a question. See FieldPlan.mismatched.
    if (m.kind === "no-field") continue;

    /*
     * A REASON THAT IS ALREADY A SENTENCE IS NOT AN ENUM LIST.
     *
     * The template below assumes `why` reads "X is not one of the values this
     * field accepts (a, b, c)" and splices the tail into "...only accepts
     * ___". A date failure does not fit that shape, so the question came out
     * as
     *
     *   "...this Workfront form only accepts Planned Start Date needs a date
     *    and 'October' could not be read as one."
     *
     * which would have been on screen during the demo.
     */
    if (!/is not one of the values this field accepts/i.test(m.why)) {
      out.push(`${m.label}: ${m.why}. What should it be?`);
      continue;
    }

    out.push(
      `${m.label}: the brief says "${m.given}", and this Workfront form only accepts ${m.why.replace(/^"[^"]*" is not one of the values this field accepts \(/, "").replace(/\)$/, "")}. Which should it be - or should the request record the detail somewhere else?`,
    );
  }

  for (const u of plan.unanswered) {
    out.push(`${u.label}: which of these - ${u.allowed.join(", ")}?`);
  }

  return out;
}

/**
 * "14 February" as an ISO date, with the year inferred when the brief omits it.
 *
 * Marketers write a day and a month. Workfront's date fields want ISO, and
 * sending the words gets the write refused - which converts a silently dropped
 * date into a visibly rejected one, no better for the person waiting on it.
 *
 * A launch date is in the future, so a bare day-and-month is read as the next
 * occurrence. That is a guess and the caller says so; the alternative is
 * assuming this year and filing a date that has already passed.
 */
export function toIsoDate(text: string, today = new Date()): { value: string; inferredYear: boolean } | null {
  const raw = String(text || "").trim();
  if (!raw) return null;

  // Already a date the platform will take.
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return { value: `${iso[1]}-${iso[2]}-${iso[3]}`, inferredYear: false };

  const MONTHS = ["january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december"];
  const m = raw.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\b(?:\s+(\d{4}))?/)
    || raw.match(/\b([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/);
  if (!m) return null;

  const first = /^\d/.test(m[1]);
  const day = Number(first ? m[1] : m[2]);
  const monthWord = String(first ? m[2] : m[1]).toLowerCase();
  const month = MONTHS.findIndex((x) => x.startsWith(monthWord.slice(0, 3)));
  if (month < 0 || !day || day > 31) return null;

  const statedYear = m[3] ? Number(m[3]) : null;
  let year = statedYear ?? today.getUTCFullYear();
  if (statedYear == null) {
    const thisYear = Date.UTC(year, month, day);
    // Already gone this year, so they mean next year.
    if (thisYear < Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) year += 1;
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  return { value: `${year}-${pad(month + 1)}-${pad(day)}`, inferredYear: statedYear == null };
}
