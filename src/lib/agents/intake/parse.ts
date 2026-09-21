/**
 * Agent 1 — turning a marketer's paragraph into a structured intake.
 *
 * B1: *"The agent cannot build the intake from the prompt, so it bounces back
 * to the marketer. The loop can run many times, and each round trip is
 * unbounded."* The fix is not to ask better questions — it is to ask **fewer**.
 * Extract everything the brief already contains, and come back only for what is
 * genuinely missing.
 *
 * The rule this module exists to enforce:
 *
 *   **Every value records where it came from.** Stated, derived, or inferred.
 *
 * A brief that looks complete because the agent guessed is worse than one with
 * visible gaps: it clears intake, and then fails at creative review a week
 * later, by which point the rework is a full creative round. So an inferred
 * value is marked as inferred and surfaced for confirmation, never silently
 * filled.
 *
 * Pure functions. No I/O, no framework — testable on its own.
 */

import { CAMPAIGN_BRIEF_FIELDS, requiredFields, audienceFields, type FieldSpec } from "@/lib/agents/shared/campaign-brief";

export type Provenance = "stated" | "derived" | "inferred";

export type ExtractedField = {
  key: string;
  label: string;
  value: string;
  /** Where the value came from. Anything but "stated" needs a human to confirm. */
  from: Provenance;
  /** The phrase in the brief this came from, so a reviewer can check it. */
  evidence?: string;
};

export type ParsedIntake = {
  fields: Record<string, string>;
  extracted: ExtractedField[];
  /** Required fields the brief does not answer. These drive needs_input. */
  missing: FieldSpec[];
  /**
   * Audience-completeness fields (FieldSpec's `askForAudience`) the brief
   * does not answer. These ALSO drive needs_input, via nextQuestions below -
   * just only once `missing` is empty. Kept separate from `missing` so a
   * reader (and the run's own metadata) can tell "genuinely blocked" from
   * "buildable, but the audience record isn't complete yet".
   */
  missingAudience: FieldSpec[];
  /** Fields the agent guessed. Correct in most cases; must still be confirmed. */
  inferred: ExtractedField[];
};

const lower = (s: string) => String(s || "").toLowerCase();

/**
 * Is this option NEGATED where it appears?
 *
 * "outbound call and email, explicitly no direct mail" listed Direct Mail as a
 * channel. Three briefs in a row did this, because matching an option name
 * anywhere in the text cannot tell "use Direct Mail" from "no Direct Mail" -
 * and the second is a clearer instruction than the first.
 *
 * Getting this wrong is not cosmetic: a channel the marketer explicitly ruled
 * out, written into a Workfront brief as a channel to use, is the kind of error
 * that reaches a customer.
 *
 * Looks only at the words immediately before the match. A negation further away
 * than that is usually about something else.
 */
function isNegated(text: string, option: string): boolean {
  const needle = option.replace(/\s*\(.*?\)\s*/g, " ").trim();
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // "no X", "not X", "without X", "excluding X", "no need for X", "rather than X"
  const before = new RegExp(
    `\\b(?:no|not|never|without|excluding|exclude|omit|skip|rather than|instead of|other than)\\b` +
    `(?:\\s+\\w+){0,3}?\\s+${escaped}`,
    "i",
  );
  if (before.test(text)) return true;
  // "X is out", "X: no", "X - not needed"
  const after = new RegExp(`${escaped}\\s*(?:is|are)?\\s*(?:out|excluded|not needed|off the table)\\b`, "i");
  return after.test(text);
}

/** Longest option first, so "TV/Streaming" beats "TV". */
function matchOption(text: string, options: readonly string[]): string | null {
  const hay = lower(text);
  const sorted = [...options].sort((a, b) => b.length - a.length);
  for (const opt of sorted) {
    const needle = lower(opt).replace(/\s*\(.*?\)\s*/g, "").trim();
    // A ruled-out option is not a chosen one.
    if (needle && hay.includes(needle) && !isNegated(text, opt)) return opt;
  }
  return null;
}

/** Phrases that carry a field without naming it. Kept small and explicit. */
const CUES: Array<{ key: string; value: string; from: Provenance; cues: RegExp }> = [
  // "who do not have a mobile line with us yet" is an upsell, written the way a
  // marketer writes it - by describing the gap rather than naming the motion.
  { key: "business_objective", value: "Growth/Upsell", from: "inferred", cues: /\bupsell\b|\bup-sell\b|\bupgrade path\b|\bgrow(th)? revenue\b|\bcross-?sell\b|\b(do not|don't|dont) (yet )?have\b[^.]{0,30}\b(line|service|product)\b|\badd (a )?(mobile|line)\b/i },
  { key: "business_objective", value: "Retention", from: "inferred", cues: /\bretention|retain|churn|renewal\b/i },
  { key: "business_objective", value: "Acquisition", from: "inferred", cues: /\bacquisition|acquire|prospect|new customer\b/i },
  // "our existing Xfinity internet customers" - the words between "existing"
  // and "customers" are the normal case, not the exception, and requiring them
  // to be adjacent matched almost no real brief.
  { key: "customer_type", value: "Subscriber - Existing Customers", from: "inferred", cues: /\b(existing|current)\b[^.]{0,40}\b(customers|subscribers|base|households|accounts)\b|\bour base\b|\balready (have|subscribe)\b/i },
  { key: "customer_type", value: "Prospect - Non-Customers", from: "inferred", cues: /\bprospects?\b|\bnon-?customers?\b|\bpeople who (do not|don't) have\b/i },
  { key: "lifecycle_journey", value: "Upgrade", from: "inferred", cues: /\bupgrade|speed ?tier|move up\b/i },
  { key: "lifecycle_journey", value: "Winback", from: "inferred", cues: /\bwin ?back|lapsed|former\b/i },
  // Xfinity is the residential brand; Comcast Business is the SMB one. That is
  // a fact about the client, and it is how their briefs are actually written.
  { key: "line_of_business", value: "Residential (RES)", from: "inferred", cues: /\bresidential\b|\bres\b|\bhome\b|\bxfinity\b|\bresi\b/i },
  { key: "line_of_business", value: "Business (SMB)", from: "inferred", cues: /\bsmb|small business|business customers\b/i },
  /*
   * EXECUTION FIRST. Order matters here, because the first matching cue wins.
   *
   * "audience built and the campaign executed" contains "audience built", so
   * with build-only tested first it came back as Audience Build-Only - the
   * opposite of what was asked, and a request for half the work.
   *
   * Asking for execution always implies the audience, so the execution cue can
   * safely be the stronger signal; the reverse is not true.
   */
  { key: "request_type", value: "Audience + Campaign Execution", from: "inferred", cues: /\b(and|plus|then)\b[^.]{0,30}\b(run|execute|executed|send|launch|activate)\b|\bend[- ]to[- ]end\b|\baudience \+ campaign\b|\bcampaign execut\w+\b/i },
  // Build-only, and only when nothing above claimed execution.
  { key: "request_type", value: "Audience Build-Only", from: "inferred", cues: /\baudience (build|built|only)\b|\bjust (the|need the) audience\b|\bnot the campaign\b|\bbuild-?only\b|\baudience only\b/i },
  { key: "campaign_duration", value: "Evergreen (ongoing)", from: "inferred", cues: /\bevergreen|ongoing|always[- ]on\b/i },
  { key: "cadence", value: "Recurring Campaign", from: "inferred", cues: /\brecurring|repeat(ing)?|every (month|quarter|week)\b/i },
  { key: "activation_pattern", value: "Near-real time trigger", from: "inferred", cues: /\breal[- ]?time|triggered?\b/i },
];

/** Months, for a date the marketer wrote in prose. */
const MONTHS = ["january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december"];

/** "nov" / "november", but never inside another word. */
const MONTH_PATTERN = MONTHS.map((m) => `${m.slice(0, 3)}(?:${m.slice(3)})?`).join("|");

function titleCase(m: string): string {
  return m[0].toUpperCase() + m.slice(1);
}

/**
 * A launch date written in prose.
 *
 * THIS READ "March" OUT OF "in market for 1 November".
 *
 * The first version tested `brief.includes("mar")` for March, and "in market"
 * contains "mar". So it returned a confident, wrong month - three weeks after
 * the real one - and flagged it merely as "derived", which a marketer skims
 * past. A wrong date is worse than no date: the nightly segmentation job at
 * 21:45 means the launch date is what decides how many rework cycles fit, and
 * B6 says every cycle past it costs a full day.
 *
 * So: month names are matched on word boundaries, and a day number beside the
 * month is kept when the marketer gave one. An exact date is "stated"; a bare
 * month is "derived", because a month is not a date and the day still has to
 * be confirmed.
 */
function findLaunchDate(brief: string): ExtractedField | null {
  const text = String(brief || "");

  // "1 November", "1st Nov", "November 1", "Nov 1st" - a real date.
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})\\b`, "i");
  const monthFirst = new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i");

  const dm = text.match(dayFirst);
  const md = text.match(monthFirst);
  const exact = dm
    ? { day: dm[1], month: dm[2], evidence: dm[0] }
    : md
      ? { day: md[2], month: md[1], evidence: md[0] }
      : null;

  if (exact) {
    const full = MONTHS.find((m) => m.startsWith(exact.month.slice(0, 3).toLowerCase())) || exact.month;
    return {
      key: "launch_date",
      label: "Launch date",
      value: `${exact.day} ${titleCase(full)}`,
      // A day and a month is a date. The marketer said it; we did not infer it.
      from: "stated",
      evidence: exact.evidence,
    };
  }

  // A bare month, on a word boundary. "end of October" / "by November".
  const bare = text.match(new RegExp(`\\b(?:(end|late|early|mid)\\s+(?:of\\s+)?)?(${MONTH_PATTERN})\\b`, "i"));
  if (!bare) return null;
  const full = MONTHS.find((m) => m.startsWith(bare[2].slice(0, 3).toLowerCase()));
  if (!full) return null;

  return {
    key: "launch_date",
    label: "Launch date",
    value: bare[1] ? `${titleCase(bare[1].toLowerCase())} of ${titleCase(full)}` : titleCase(full),
    // A month is not a date. Derived, and the marketer confirms the day.
    from: "derived",
    evidence: bare[0],
  };
}

/**
 * The campaign name, from the opening of the brief.
 *
 * Almost every brief opens by naming the campaign - "Fall Switch and Save.
 * Growth/Upsell for..." - and without this, campaign_name was required,
 * unextractable, and therefore asked for on every single brief. An agent whose
 * first question is "what is this campaign called?" when the marketer named it
 * in the first four words is the B1 loop, just politer.
 *
 * DERIVED, never stated. The opening sentence is a strong signal and not a
 * fact, so it is marked derived and the marketer confirms it - which is cheaper
 * than asking, and honest about where the value came from. Anything that reads
 * like a sentence rather than a title is left alone.
 */
function findCampaignName(brief: string): ExtractedField | null {
  const text = String(brief || "");

  /*
   * A named campaign, however the sentence is built around it.
   *
   * Real briefs open with a greeting - "Hey - we need an audience for the Fall
   * Switch and Save push" - so taking the first sentence gave a 13-word
   * sentence starting with "Hey", which was correctly rejected as not a title,
   * and the campaign name sitting in the middle of it was missed. Marketers
   * name the campaign in a small number of recognisable frames; those are
   * cheaper and far more accurate than guessing at the sentence.
   */
  const framed = text.match(
    /\bfor (?:the )?(.{3,60}?)\s+(?:push|campaign|launch|programme|program|initiative|activation)\b/i,
  ) || text.match(/\b(?:campaign|push|programme|program)\s+(?:called|named)\s+"?(.{3,60}?)"?(?:[.,]|$)/i);

  if (framed) {
    const name = framed[1].trim().replace(/^(our|the|a)\s+/i, "");
    if (name && name.split(/\s+/).length <= 8) {
      return { key: "campaign_name", label: "Campaign name", value: name, from: "derived", evidence: framed[0] };
    }
  }

  const first = text.split(/[.!?\n]/)[0]?.trim();
  if (!first) return null;

  const words = first.split(/\s+/);
  // A title, not a sentence: short, and not starting with a verb phrase that
  // means the marketer has launched straight into the request.
  if (words.length < 2 || words.length > 9) return null;
  if (/^(we|i|this|the team|please|can|could|need|want|looking|there)\b/i.test(first)) return null;
  if (/[:;,]$/.test(first)) return null;

  return {
    key: "campaign_name",
    label: "Campaign name",
    value: first,
    from: "derived",
    evidence: first,
  };
}

/**
 * Read a brief.
 * @param brief the marketer's own words
 * @param known anything already structured (a rework loop carries this)
 * @param provenance where each `known` value actually came from, when it is
 *   NOT a plain stated fact - e.g. an LLM extraction the caller is layering
 *   in as "inferred". A key absent from this map defaults to "stated", which
 *   is correct for the ordinary case (a human-confirmed rework answer).
 */
export function parseBrief(
  brief: string,
  known: Record<string, unknown> = {},
  provenance: Record<string, Provenance> = {},
): ParsedIntake {
  const extracted: ExtractedField[] = [];
  const seen = new Set<string>();

  const push = (f: ExtractedField) => {
    if (seen.has(f.key)) return;
    seen.add(f.key);
    extracted.push(f);
  };

  // 1. Anything already structured wins outright over a cue-phrase guess -
  // but it is only "stated" when nothing says otherwise. A value the caller
  // itself labeled "inferred" (an LLM extraction, layered in via `known`)
  // must keep carrying that label, or it reaches a human as a confirmed
  // fact it never was - the exact silent-fill this module exists to prevent.
  for (const spec of CAMPAIGN_BRIEF_FIELDS) {
    const existing = known[spec.key];
    if (existing != null && String(existing).trim() !== "") {
      push({ key: spec.key, label: spec.label, value: String(existing), from: provenance[spec.key] ?? "stated" });
    }
  }

  // 2. Enum fields whose own options appear verbatim in the brief.
  for (const spec of CAMPAIGN_BRIEF_FIELDS) {
    if (seen.has(spec.key) || !spec.options?.length) continue;

    /*
     * Some fields are genuinely multi-valued. "email and SMS" is two channels,
     * and keeping only the first silently halved the activation plan - the
     * brief said two and the structured output said one.
     */
    if (spec.key === "channels") {
      const all = spec.options.filter(
        (opt) =>
          new RegExp(`\\b${opt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(brief) &&
          // "explicitly no direct mail" must not add Direct Mail.
          !isNegated(brief, opt),
      );
      if (all.length) {
        push({
          key: spec.key, label: spec.label, value: all.join(", "), from: "stated",
          evidence: all.join(" and "),
        });
        continue;
      }
    }

    const hit = matchOption(brief, spec.options);
    if (hit) {
      push({
        key: spec.key, label: spec.label, value: hit, from: "stated",
        evidence: brief.match(new RegExp(`[^.]*${hit.split(" ")[0]}[^.]*`, "i"))?.[0]?.trim(),
      });
    }
  }

  // 3. Cue phrases. These are inferences and are marked as such.
  for (const cue of CUES) {
    if (seen.has(cue.key)) continue;
    const m = brief.match(cue.cues);
    if (m) {
      const spec = CAMPAIGN_BRIEF_FIELDS.find((f: FieldSpec) => f.key === cue.key);
      push({
        key: cue.key, label: spec?.label ?? cue.key, value: cue.value,
        from: cue.from, evidence: m[0],
      });
    }
  }

  // 4. A date written in prose.
  if (!seen.has("launch_date")) {
    const d = findLaunchDate(brief);
    if (d) push(d);
  }

  // 5. The campaign name, from the opening line.
  if (!seen.has("campaign_name")) {
    const n = findCampaignName(brief);
    if (n) push(n);
  }

  // 6. The offer. "$350 prepaid card", "600 dollar prepaid card".
  if (!seen.has("offer")) {
    const o = brief.match(
      /(?:\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*\s*(?:dollar|usd|pound|gbp)s?)\s*([a-z][a-z \-]{2,30}?)?(?=[.,]|\s+(?:on it|incentive|offer)|$)/i,
    );
    if (o) {
      push({
        key: "offer",
        label: "Offer",
        value: o[0].trim().replace(/\s+/g, " "),
        from: "stated",
        evidence: o[0].trim(),
      });
    }
  }

  // 7. The exclusion - usually the single most important clause in the brief,
  //    and previously left in free text only.
  if (!seen.has("exclusion")) {
    const x = brief.match(
      /\b(?:who|that)\s+(?:do not|don't|dont|does not|doesn't)\s+(?:yet\s+)?have\s+([^.,]{3,60})|\bwithout\s+(?:a\s+)?([^.,]{3,60})|\bexclud(?:e|ing)\s+([^.,]{3,60})/i,
    );
    if (x) {
      const what = (x[1] || x[2] || x[3] || "").trim().replace(/\s+with us\s*(yet)?$/i, "");
      if (what) {
        push({
          key: "exclusion",
          label: "Exclusion",
          value: `Customers without ${what}`,
          from: "derived",
          evidence: x[0].trim(),
        });
      }
    }
  }

  // 8. How many emails, when stated as a count next to the word "email(s)".
  // Safe as a plain digit-plus-word match - unlike the Yes/No-style LCE
  // fields in campaign-brief.ts, a number immediately followed by "email(s)"
  // is not a phrase that shows up by coincidence.
  if (!seen.has("email_count")) {
    const e = brief.match(/\b(\d{1,3})\s*emails?\b/i);
    if (e) {
      push({ key: "email_count", label: "Number of emails", value: e[1], from: "stated", evidence: e[0] });
    }
  }

  const fields: Record<string, string> = {};
  for (const f of extracted) fields[f.key] = f.value;

  const missing = requiredFields().filter((f: FieldSpec) => !fields[f.key]);
  const missingAudience = audienceFields().filter((f: FieldSpec) => !fields[f.key]);
  const inferred = extracted.filter((f) => f.from !== "stated");

  return { fields, extracted, missing, missingAudience, inferred };
}

/**
 * The two things actually missing — not the whole form.
 *
 * B1 again: *"the agent asks for the two things actually missing rather than
 * re-asking the whole brief."* Asking for eleven fields is how a loop count
 * passes two, and past two the agent has failed, not the marketer.
 *
 * `missing` (buildability) always goes first and exhausts before
 * `missingAudience` (audience-completeness, explicit product direction -
 * see FieldSpec's askForAudience docstring) gets a turn - a request that
 * cannot be built yet is not the moment to ask about refresh cadence. Still
 * exactly `limit` per round either way, so this changes WHAT eventually
 * gets asked, not the pacing B1 exists to protect.
 */
export function nextQuestions(parsed: ParsedIntake, limit = 2): FieldSpec[] {
  if (parsed.missing.length) return parsed.missing.slice(0, limit);
  return parsed.missingAudience.slice(0, limit);
}
