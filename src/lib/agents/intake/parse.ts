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

import { findNamedPlace } from "@/lib/agents/shared/places";
import { findStates } from "@/lib/agents/shared/us-states";
import { CAMPAIGN_BRIEF_FIELDS, requiredFields, type FieldSpec } from "@/lib/agents/shared/campaign-brief";

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

/**
 * The brief said one thing, and then said a different thing.
 *
 * Either because the marketer amended it mid-sentence - "scrap that, pull the
 * date forward to the 6th" - or because two statements genuinely disagree, like
 * an acquisition campaign aimed at existing subscribers.
 */
export type Conflict = {
  /** The brief field in dispute, or a pair of fields for a contradiction. */
  key: string;
  label: string;
  /** Every distinct value the brief offered, in the order it offered them. */
  values: string[];
  /** Put to the marketer verbatim. */
  ask: string;
};

export type ParsedIntake = {
  fields: Record<string, string>;
  extracted: ExtractedField[];
  /** Required fields the brief does not answer. These drive needs_input. */
  missing: FieldSpec[];
  /** Fields the agent guessed. Correct in most cases; must still be confirmed. */
  inferred: ExtractedField[];
  /**
   * Where the brief disagrees with itself. Never resolved by guessing: a
   * disagreement is the marketer's to settle, and it outranks every other
   * question because the alternative is filing a plan they cancelled.
   */
  conflicts: Conflict[];
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

/**
 * The brief with its ROW LABELS removed.
 *
 * Briefs from this BU arrive as labelled rows - "Business objective:",
 * "Audience definition:", "Requestor / BU:". A label names the question; the
 * text after it is the answer. Matching option values against the label is
 * matching against the form, not against what the marketer said.
 *
 * It produced a confidently wrong value on a real brief. `matchOption` strips
 * the qualifier off "Business (SMB)", leaving the bare word "business" as the
 * needle, and the brief's own label "Business objective:" matched it. A
 * residential Xfinity campaign was filed as Business (SMB) with no SMB signal
 * anywhere in it - and any brief using the ordinary word "business" in a label
 * would do the same.
 *
 * Only a LABEL is removed: short, at the start of a line, ending in a colon.
 * A colon mid-sentence is punctuation and is left alone.
 */
function withoutLabels(text: string): string {
  return String(text || "").replace(/^[ \t]*[A-Za-z][A-Za-z0-9 /&()'-]{0,44}:[ \t]*/gm, "");
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
  /*
   * "Attach rate" is how Comcast writes upsell, and the first demo brief -
   * "grow video attach rate among single-product internet subscribers" - had
   * to be asked what its objective was. It says so in its opening line.
   */
  { key: "business_objective", value: "Growth/Upsell", from: "inferred", cues: /\bupsell\b|\bup-sell\b|\battach rate\b|\bvideo attach\b|\bsingle[- ]product\b|\bupgrade path\b|\bgrow(th)? revenue\b|\bcross-?sell\b|\b(do not|don't|dont) (yet )?have\b[^.]{0,30}\b(line|service|product)\b|\badd (a )?(mobile|line)\b/i },
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
/**
 * EVERY date the brief names, in the order it names them.
 *
 * This used to return only the first. That was invisible until someone amended
 * a brief - "launch 20 October ... actually, pull the in-market date forward to
 * 6 October" - and the second date was never even looked at, so the correction
 * could not be noticed, let alone honoured. The preview then showed 20 October
 * back to the marketer with no sign that anything had been dropped.
 *
 * The first is still the one that fills the field; the rest exist so a
 * disagreement can be SEEN. Picking the last would just be a different guess,
 * and prose does not reliably put the truest date last.
 */
function findLaunchDates(brief: string): ExtractedField[] {
  const text = String(brief || "");
  const out: ExtractedField[] = [];
  const seenValue = new Set<string>();

  const add = (day: string, month: string, evidence: string) => {
    const full = MONTHS.find((m) => m.startsWith(month.slice(0, 3).toLowerCase())) || month;
    const value = `${day} ${titleCase(full)}`;
    if (seenValue.has(value)) return;
    seenValue.add(value);
    out.push({
      key: "launch_date",
      label: "Launch date",
      value,
      // A day and a month is a date. The marketer said it; we did not infer it.
      from: "stated",
      evidence,
    });
  };

  // "1 November", "1st Nov" - and "November 1", "Nov 1st".
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})\\b`, "gi");
  const monthFirst = new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "gi");

  /*
   * Ordered by where each appears, not by which pattern matched, so "launch 20
   * October ... forward to 6 October" reports 20 before 6 whichever shape each
   * was written in. The order is what makes the question readable: "you said
   * the 20th and then the 6th".
   */
  const hits: Array<{ at: number; day: string; month: string; evidence: string }> = [];
  for (const m of text.matchAll(dayFirst)) {
    hits.push({ at: m.index ?? 0, day: m[1], month: m[2], evidence: m[0] });
  }
  for (const m of text.matchAll(monthFirst)) {
    hits.push({ at: m.index ?? 0, day: m[2], month: m[1], evidence: m[0] });
  }
  hits.sort((a, b) => a.at - b.at);

  /*
   * NOT EVERY DATE IS A LAUNCH DATE, AND COLLECTING THEM ALL MADE THAT WORSE.
   *
   * Finding every date fixed the amendment case and immediately broke a real
   * brief: "legal sign-off by 1 October ... in market 20 November" came back
   * as a launch-date DISAGREEMENT between the two, the wrong one was used,
   * and the legal deadline - the hardest constraint in that brief - appeared
   * nowhere at all.
   *
   * A date introduced as a sign-off, a due date or a deadline is a different
   * fact about the campaign. Treating it as a rival launch date invents a
   * contradiction where the marketer was being precise, and an invented
   * question is worse than no question: it teaches them the flags are noise.
   *
   * Only the words immediately before the date are considered. A mention
   * further away is usually about something else.
   */
  const OTHER_KIND_OF_DATE =
    /\b(?:legal|compliance|sign[- ]?off|approval|due|deadline|cut[- ]?off|copy|creative|asset|artwork|brief(?:ing)?|kick[- ]?off|review|qa|proof|deliver(?:y|ed|able)?|submit(?:ted|ssion)?)\b/i;

  for (const h of hits) {
    /*
     * The qualifier has to belong to THIS date's clause.
     *
     * A fixed lookback window read across the comma: in "Legal sign-off by
     * 1 October, in market 20 November" the window for 20 November reached
     * back far enough to find "sign-off", so BOTH dates were discarded and a
     * bare-month fallback produced "October" - the sign-off month, presented
     * as the launch date. Worse than the bug it replaced.
     *
     * Clauses are what separate the two facts in that sentence, so the search
     * stops at the punctuation that ends the previous one.
     */
    /*
     * A clause ends at a conjunction as well as at punctuation.
     *
     * Splitting only on commas meant "sign-off due 6 October and in market 20
     * October" - no comma anywhere - was one clause containing "due", so BOTH
     * dates were discarded and the launch date vanished along with the
     * deadline. The qualifier belongs to its own clause, and "and" starts a
     * new one just as firmly as a comma does.
     */
    const before = text.slice(0, h.at);
    const boundary = Math.max(
      before.lastIndexOf(","),
      before.lastIndexOf(";"),
      before.lastIndexOf(":"),
      (() => {
        const m = before.match(/\b(?:and|then|with|plus)\b(?!.*\b(?:and|then|with|plus)\b)/i);
        return m && m.index != null ? m.index + m[0].length : -1;
      })(),
    );
    const clause = before.slice(boundary + 1);
    if (OTHER_KIND_OF_DATE.test(clause)) continue;
    add(h.day, h.month, h.evidence);
  }

  if (out.length) return out;

  const single = findBareMonth(text);
  return single ? [single] : [];
}

function findBareMonth(brief: string): ExtractedField | null {
  const text = String(brief || "");

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
  /*
   * FIRST: a label the marketer wrote out, "Campaign name: Detroit NBA Drop".
   *
   * This is the strongest signal there is and it was not being read at all, so
   * the fallback below took the whole first sentence - LABEL INCLUDED - and the
   * Workfront project was created called
   * `Campaign name: Detroit NBA Benefit Drop - Retention`, which then had to be
   * renamed by hand.
   *
   * It is also self-inflicted in a particular way worth noting: a marketer does
   * not usually write "Campaign name:" in prose. An assistant does, after the
   * parser has rejected two less explicit phrasings - so the label appears
   * precisely because the extraction was struggling, and then the label itself
   * became the name. Reading it explicitly fixes both halves.
   */
  const labelled = text.match(
    /\bcampaign\s*(?:name|title)\s*[:\-]\s*"?(.{3,60}?)"?\s*(?:[.;\n]|$)/i,
  );
  if (labelled) {
    const name = labelled[1].trim().replace(/[.,;:\s]+$/, "");
    if (name) {
      return { key: "campaign_name", label: "Campaign name", value: name, from: "stated", evidence: labelled[0] };
    }
  }

  /*
   * `[^.:;
]`, not `.` - a campaign name does not contain a full stop.
   *
   * With a permissive dot this matched from the first "for" straight across a
   * sentence boundary: "Growth/Upsell for existing residential subscribers.
   * Request type: Audience + Campaign Execution" captured everything up to the
   * word "Campaign", and the Workfront issue was created titled
   * "existing residential subscribers. Request type: Audience +".
   *
   * The lazy quantifier is no defence - it still crosses punctuation if it is
   * allowed to, and the sentence after a name is exactly where the next one
   * begins. A garbled title is not cosmetic: the issue name is what the review
   * queue reads, and what a marketer searches for to find their own request.
   */
  const framed = text.match(
    /\bfor (?:the )?([^.:;\n]{3,60}?)\s+(?:push|campaign|launch|programme|program|initiative|activation)\b/i,
  ) || text.match(/\b(?:campaign|push|programme|program)\s+(?:called|named)\s+"?([^.:;\n]{3,60}?)"?(?:[.,]|$)/i);

  if (framed) {
    const name = framed[1].trim().replace(/^(our|the|a)\s+/i, "").replace(/[,+&\/]+$/, "").trim();
    // Six words, not eight. A campaign has a name; a clause describing the
    // audience does not, and the longer a capture runs the more likely it is
    // the latter - "existing residential subscribers, Audience +" is seven.
    if (name && name.split(/\s+/).length <= 6) {
      return { key: "campaign_name", label: "Campaign name", value: name, from: "derived", evidence: framed[0] };
    }
  }

  // A leading "Something:" is a LABEL, not part of the name. Belt and braces
  // for the case above: any label this catches should have been read there, but
  // a label that reaches the title is the bug that renames a real project.
  const first = text.split(/[.!?\n]/)[0]?.trim().replace(/^[A-Za-z][A-Za-z ]{2,24}:\s*/, "");
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
 */
/*
 * Channel names that are also ordinary English words.
 *
 * "Push" is a noun ("the Q4 push"), a verb ("push the launch"), and a channel.
 * On a plain word boundary, a brief reading "PA Internet Attach Q4 push ...
 * Email only" produced channels "Email, Push" - a notification nobody asked
 * for, in a plan the marketer had explicitly limited to email.
 *
 * So an ambiguous name has to read like a channel: named as the medium, or
 * listed alongside other channels. An unambiguous one ("SMS", "Direct Mail")
 * needs no such test - nobody writes those by accident.
 */
/*
 * "PUSH" IS A VERB FAR MORE OFTEN THAN IT IS A CHANNEL.
 *
 * This guard already existed and was still too generous: it accepted
 * "and push" / "push and", which match the ordinary verb. A marketer writing
 * "scrap that - and push it to paid social" got Push added as a channel she
 * had never asked for, in the same breath as changing her mind about the
 * channel she HAD asked for.
 *
 * An invented channel is the worst class of error here. A missing one gets
 * noticed and added; a fabricated one is approved, briefed and built, because
 * everything downstream treats it as something the marketer said.
 *
 * So Push must look like a medium: named as a notification, reached "via"
 * or "on", or sitting in a list beside another channel. The verb no longer
 * qualifies.
 */
const CHANNEL_WORDS = /(email|sms|text|direct mail|dm|paid media|paid social|display|in-?app|outbound call|call)/i;

const AMBIGUOUS_CHANNELS: Record<string, (brief: string) => boolean> = {
  Push: (brief) => {
    // Named as the medium - "push notification", "via push".
    if (/\bpush\s+(notification|message|alert|channel)s?\b|\b(via|through|on|by)\s+push\b/i.test(brief)) return true;

    /*
     * Or listed as one of several channels. Requires a real channel name
     * beside it, because "we push, then follow up" is a sentence and not a
     * channel list.
     */
    const listed = /(?:^|[,/&]|\band\b)\s*push\s*(?=[,/&]|\band\b|$)/gi;
    for (const m of brief.matchAll(listed)) {
      const at = m.index ?? 0;
      const around = brief.slice(Math.max(0, at - 60), at + m[0].length + 60);
      if (CHANNEL_WORDS.test(around)) return true;
    }
    return false;
  },
};

/** Does this channel word actually refer to the channel here? */
function channelSense(brief: string, option: string): boolean {
  const test = AMBIGUOUS_CHANNELS[option];
  return test ? test(brief) : true;
}

export function parseBrief(brief: string, known: Record<string, unknown> = {}): ParsedIntake {
  /*
   * Values are matched against the ANSWERS, not against the row labels.
   * See withoutLabels: a residential campaign was filed as Business (SMB)
   * because the label "Business objective:" matched the option value.
   */
  const answers = withoutLabels(brief);

  const extracted: ExtractedField[] = [];
  const seen = new Set<string>();

  /*
   * A SECOND, DIFFERENT ANSWER IS NOT NOISE - IT IS THE MARKETER CHANGING
   * THEIR MIND, AND IT WAS BEING THROWN AWAY.
   *
   * push kept the FIRST value for a key and discarded everything after it. In
   * an amendment the original always appears first, so the correction lost.
   * Observed live, on "add direct mail, pull the in-market date forward to
   * 6 October, and the offer moves to $20/mo":
   *
   *     Channels    = Email, Direct Mail   <- the amendment was applied
   *     Launch date = 20 October           <- the amendment was ignored
   *     Offer                              <- never captured at all
   *
   * That is worse than ignoring the correction outright: it produced a plan
   * that was neither the original nor the correction, and previewed it back
   * confidently. The marketer would have approved a date they had cancelled.
   *
   * The first value still wins the FIELD - reordering by recency guesses that
   * later means truer, which is not reliably so in prose. What changes is that
   * the disagreement is now recorded instead of dropped, and a disagreement
   * becomes a question. Deciding between two things the marketer said is the
   * marketer's job, and it is a cheap question to answer.
   */
  const candidates = new Map<string, ExtractedField[]>();

  const push = (f: ExtractedField) => {
    const prior = candidates.get(f.key);
    if (prior) prior.push(f);
    else candidates.set(f.key, [f]);

    if (seen.has(f.key)) return;
    seen.add(f.key);
    extracted.push(f);
  };

  // 1. Anything already structured wins outright - it was stated, not guessed.
  for (const spec of CAMPAIGN_BRIEF_FIELDS) {
    const existing = known[spec.key];
    if (existing != null && String(existing).trim() !== "") {
      push({ key: spec.key, label: spec.label, value: String(existing), from: "stated" });
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
      /*
       * "EMAIL ONLY" MEANS EMAIL ALONE.
       *
       * The marketer is ruling the others out, and that is a stronger
       * statement than any channel word appearing elsewhere in the brief.
       */
      const only = spec.options.find((opt) =>
        new RegExp(`\\b${opt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[- ]only\\b`, "i").test(brief) ||
        new RegExp(`\\bonly\\b[^.]{0,12}\\b${opt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(brief),
      );
      if (only) {
        push({
          key: spec.key, label: spec.label, value: only, from: "stated",
          evidence: `${only} only`,
        });
        continue;
      }

      const all = spec.options.filter(
        (opt) =>
          new RegExp(`\\b${opt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(brief) &&
          // "explicitly no direct mail" must not add Direct Mail.
          !isNegated(brief, opt) &&
          channelSense(brief, opt),
      );
      if (all.length) {
        push({
          key: spec.key, label: spec.label, value: all.join(", "), from: "stated",
          evidence: all.join(" and "),
        });
        continue;
      }
    }

    const hit = matchOption(answers, spec.options);
    if (hit) {
      push({
        key: spec.key, label: spec.label, value: hit, from: "stated",
        evidence: brief.match(new RegExp(`[^.]*${hit.split(" ")[0]}[^.]*`, "i"))?.[0]?.trim(),
      });
    }
  }

  /*
   * A NAMED PLACE IS A REGION - AND A COUNTRY IS A PLACE.
   *
   * This looked for US states and nothing else, so the commonest way to write
   * a brief did not work. Tested four ways against the live tenant:
   *
   *     "Region: us"        -> not captured, asked "Region: which of these - uk, de, us?"
   *     "Region: US"        -> not captured, asked the same
   *     "the United States" -> not captured, asked the same
   *     "in Pennsylvania"   -> captured, DE:Region = "us", asked nothing
   *
   * The system asked the marketer to choose `us` from a list containing `us`,
   * on a brief whose first line said `us`. Exactly inverted from how people
   * brief: you name the country for a national push and the state only when
   * you actually mean the state.
   *
   * findNamedPlace still prefers a state when one is named, because it is the
   * more precise answer and the field mapper can always climb to the country
   * afterwards. The table is shared with that mapper, so the two cannot
   * disagree about what counts as a place - the same reason the state list is
   * shared with the audience agent.
   *
   * Stated, not inferred: the marketer wrote the place's name.
   */
  if (!seen.has("region")) {
    const spec = CAMPAIGN_BRIEF_FIELDS.find((f: FieldSpec) => f.key === "region");

    /*
     * EVERY STATE, NOT THE FIRST.
     *
     * "Xfinity Internet customers in New York and New Jersey" captured New
     * Jersey alone. Half the requested audience was dropped with nothing
     * reported - and the audience agent builds its filter from this value, so
     * the campaign would have gone to one state of the two.
     *
     * The first still fills the field; the rest are recorded, so the loss
     * becomes a question instead of a silent halving. Same rule as the dates
     * and the offers.
     */
    const states = findStates(brief);
    if (states.length > 1 && /\b(?:both|and|&|plus|as well as)\b/i.test(brief)) {
      /*
       * "BOTH NEW YORK AND NEW JERSEY" IS ONE ANSWER, NOT TWO RIVALS.
       *
       * Recording every state as a separate candidate fixed the silent
       * halving and immediately created a worse bug: the conflict check saw
       * two values for one field and asked
       *
       *   "The brief gives region / market twice: 'New York' and 'New
       *    Jersey'. Which one is right?"
       *
       * on a brief that says, in as many words, that it wants both. That is
       * confidently wrong in a polite voice, which is harder to catch than a
       * gap - the marketer has to argue with it.
       *
       * Conjoined states are one multi-state market. The field still receives
       * a single value, the widening maps it to the country the form can
       * hold, and both states stay visible in the value itself.
       */
      push({
        key: "region",
        label: spec?.label ?? "Region / market",
        value: states.map((s) => s.name).join(", "),
        from: "stated",
        evidence: states.map((s) => s.name).join(" and "),
      });
    } else if (states.length) {
      for (const s of states) {
        push({
          key: "region",
          label: spec?.label ?? "Region / market",
          value: s.name,
          from: "stated",
          evidence: s.name,
        });
      }
    } else {
      const place = findNamedPlace(brief);
      if (place) {
        push({
          key: "region",
          label: spec?.label ?? "Region / market",
          value: place.name,
          from: "stated",
          evidence: place.name,
        });
      }
    }
  }

  // 3. Cue phrases. These are inferences and are marked as such.
  for (const cue of CUES) {
    if (seen.has(cue.key)) continue;
    const m = answers.match(cue.cues);
    if (m) {
      const spec = CAMPAIGN_BRIEF_FIELDS.find((f: FieldSpec) => f.key === cue.key);
      push({
        key: cue.key, label: spec?.label ?? cue.key, value: cue.value,
        from: cue.from, evidence: m[0],
      });
    }
  }

  // 4. A date written in prose.
  /*
   * NOT GUARDED ON `seen`, AND THAT IS THE POINT.
   *
   * push() already keeps the first value for a field, so a value supplied in
   * `known` still wins. What the guard used to do was stop the brief from
   * being READ at all once `known` had an answer - which silently disabled
   * the amendment check in exactly the case it matters most.
   *
   * An LLM extractor now runs in front of this and passes its output back as
   * `known`. So `known.launch_date` is normally set, the scan never ran, no
   * candidates were recorded, and "pull the date forward to the 6th" stopped
   * being noticed. The deterministic parser is the safety net under that
   * extractor, and a safety net that switches itself off when the thing above
   * it is working is not a safety net.
   *
   * Reading the brief is cheap. Reading it and finding the same answer costs
   * nothing; reading it and finding a different one is the whole point.
   */
  for (const d of findLaunchDates(brief)) push(d);

  // 5. The campaign name, from the opening line.
  if (!seen.has("campaign_name")) {
    /*
     * The ANSWERS, not the labels. On a labelled brief with no campaign-name
     * row, the opening line is the requestor - so the Workfront request was
     * titled "Requestor / BU: Video & Entertainment Marketing", which is a
     * team, not a campaign. Stripping labels first means the derivation sees
     * what the marketer wrote rather than the form's own headings.
     */
    const n = findCampaignName(answers);
    if (n) push(n);
  }

  /*
   * 5b. THE AGENCY, WHICH WAS NAMED IN EVERY BRIEF AND READ IN NONE.
   *
   * A marketer reviewing six of her own briefs found she had named the agency
   * in all six - Argon Digital, Bluestem Creative, Meridian Point - and it
   * appeared nowhere: not in what was captured, not in the questions, not in
   * what the form could not hold. It was simply not looked for.
   *
   * That is the quietest way to lose something. A field we ask about is
   * visible; a field we never mention leaves the marketer assuming it was
   * understood, because they said it plainly and nothing objected.
   *
   * Who produces the work is not decoration on a creative request - it decides
   * who gets briefed and which review path the job takes.
   */
  if (!seen.has("agency")) {
    /*
     * The keyword is case-insensitive; the NAME is not.
     *
     * A whole-pattern /i flag would defeat the capture, which relies on the
     * agency being written as a proper noun to know where the name starts and
     * ends. The first version was lowercase-only and missed every brief,
     * because people write "Agency is Bluestem Creative" at the start of a
     * sentence.
     *
     * A full stop is NOT part of a name. Allowing it let the match run past
     * the end of the sentence - "Bluestem Creative. Campaign" - which is the
     * same class of error as truncating: the value looks plausible and is
     * wrong.
     */
    const a = brief.match(
      /\b(?:[Aa]gency(?:\s+partner)?|[Cc]reative\s+[Aa]gency|[Pp]roduced\s+by|[Hh]andled\s+by)\b\s*(?:is|will be|:|=)?\s*([A-Z][A-Za-z0-9&'-]*(?:\s+[A-Z][A-Za-z0-9&'-]*){0,3})/,
    );
    if (a && a[1]) {
      push({
        key: "agency",
        label: "Agency",
        value: a[1].trim(),
        from: "stated",
        evidence: a[0].trim(),
      });
    }
  }

  /*
   * 6. The offer - "$350 prepaid card", "600 dollar prepaid card".
   *
   * A MONEY AMOUNT IS NOT AUTOMATICALLY AN OFFER.
   *
   * This matched any sum of money and filed it as the consumer offer, so
   * "Budget is $1.8M working media" came back as
   *
   *     Offer = "$1.8M working media"   [stated]
   *
   * The value and the "stated" label are both honest - those words are in the
   * brief - which is exactly what makes it dangerous. It reads as though the
   * marketer told us the offer, and nothing about it looks wrong until a
   * creative team builds against a $1.8M consumer incentive.
   *
   * A budget and an offer are different facts about a campaign. When the sum
   * is introduced as money the business is SPENDING, it is not something the
   * customer is being given.
   */
  /*
   * Every sum, and again NOT guarded on `seen`. An LLM extractor supplying
   * `known.offer` used to stop the brief being read for money at all, so a
   * changed offer went unnoticed - and the budget-versus-offer distinction
   * was never applied to what the brief actually said.
   */
  {
    /*
     * THE WHOLE OFFER, NOT THE FIRST NUMBER IN IT.
     *
     * The old pattern stopped after the sum and an optional word or two, so
     * "$39.99/mo plus a $100 gift card" was captured as "$39.99" - the price,
     * without the incentive that is the actual offer. A marketer reading that
     * back sees a number she recognises and no reason to look closer, which is
     * precisely when a truncation survives review.
     *
     * An offer runs to the end of its clause. That is where the marketer
     * stopped describing it.
     */
    /*
     * EVERY SUM, FOR THE SAME REASON AS EVERY DATE.
     *
     * Only the first money match was examined, so when a marketer wrote
     * "the offer moves to $20/mo" after naming a different one, the change
     * disappeared entirely - no new value, and no question either, because
     * there was nothing for the conflict check to compare. The date amendment
     * was caught and the offer amendment silently was not, in the same brief.
     *
     * push() keeps the first for the field and records the rest, so a changed
     * offer now asks rather than vanishing.
     */
    const MONEY = /(?:\$\s?\d[\d,]*(?:\.\d+)?\s*[mk]?|\b\d[\d,]*\s*(?:dollar|usd|pound|gbp)s?)/gi;
    const WHOLE = new RegExp(MONEY.source + /(?:[^.,;\n]{0,70}?)?(?=[.,;\n]|$)/.source, "gi");

    for (const o of brief.matchAll(WHOLE)) {
      const at = o.index ?? 0;
      // The words immediately around the sum, which is where a brief says what
      // kind of money it is talking about.
      const around = brief.slice(Math.max(0, at - 40), at + o[0].length + 40);
      const isSpend =
        /\b(budget|working media|media spend|spend|investment|funding|allocation|capex|opex)\b/i.test(around);

      push({
        key: isSpend ? "budget" : "offer",
        label: isSpend ? "Budget" : "Offer",
        value: o[0].trim().replace(/\s+/g, " "),
        from: "stated",
        evidence: o[0].trim(),
      });
    }
  }

  /*
   * 5c. THE AUDIENCE, AS THE REQUESTER DEFINED IT.
   *
   * THE MOST IMPORTANT LINE IN THE BRIEF, AND IT WAS READ BY NOTHING.
   *
   * A real brief said, on its own labelled row:
   *
   *     Audience definition: xfinityInternet = true AND xfinityTV = false
   *
   * Nothing captured it. The audience agent inferred a different audience from
   * the surrounding prose, built the inverse - Internet = FALSE, TV condition
   * dropped entirely - reported success, and attached a predicted count of 22
   * to a population nobody had asked for.
   *
   * When a CDP-literate requester writes the rule themselves, that is the most
   * reliable input this pipeline will ever receive. Capturing it verbatim lets
   * the audience agent use it instead of guessing, and lets a reviewer see the
   * requester's own words next to what was built.
   *
   * Captured as STATED, because it is: they wrote it, we did not derive it.
   */
  if (!seen.has("audience_description")) {
    const ad = brief.match(
      /\b(?:audience(?:\s+definition)?|segment(?:\s+definition)?|targeting)\b\s*[:\-]\s*([^\n]{5,200})/i,
    );
    if (ad && ad[1]) {
      const spec = CAMPAIGN_BRIEF_FIELDS.find((f: FieldSpec) => f.key === "audience_description");
      push({
        key: "audience_description",
        label: spec?.label ?? "Audience",
        value: ad[1].trim().replace(/\s+/g, " ").replace(/[.;]+$/, ""),
        from: "stated",
        evidence: ad[0].trim().slice(0, 120),
      });
    }
  }

  /*
   * 6b. THE SUCCESS METRICS.
   *
   * All three demo briefs state them - "video add-on conversion rate and
   * incremental ARPU", "referral submissions per thousand sent", "churn rate
   * delta versus a matched control" - and none were captured. The tenant's
   * form has a field called "Key Objectives & Success Metrics", and we were
   * filling it with the business objective alone, dropping the half the
   * marketer actually took the trouble to write.
   *
   * How a campaign will be judged is not decoration. It decides what the
   * creative has to achieve and what gets reported afterwards.
   */
  if (!seen.has("success_metrics")) {
    const sm = brief.match(
      /\b(?:success (?:is )?measured on|success metrics?|measured on|kpis?|measured by)\b\s*[:-]?\s*([^.\n\r]{5,160})/i,
    );
    if (sm && sm[1]) {
      push({
        key: "success_metrics",
        label: "Success metrics",
        value: sm[1].trim().replace(/\s+/g, " "),
        from: "stated",
        evidence: sm[0].trim(),
      });
    }
  }

  // 7. The exclusion - usually the single most important clause in the brief,
  //    and previously left in free text only.
  if (!seen.has("exclusion")) {
    const x = brief.match(
      /\b(?:suppress|suppression(?:s)?(?:\s*[:\-])?|exclud(?:e|ing)|omit|leave out|remove)\s+([^.,;\n\r]{3,70})/i,
    );

    /*
     * A SUPPRESSION AND AN AUDIENCE DEFINITION ARE OPPOSITES, AND THIS READ
     * ONE AS THE OTHER.
     *
     * The pattern used to accept "who do not have X" and "without X" as
     * exclusions. On the first of the three demo briefs:
     *
     *   "Audience is existing Xfinity Internet customers who do not have
     *    Xfinity TV ... Suppress existing TV subscribers."
     *
     * it produced Exclusion = "Customers without Xfinity TV" - the audience's
     * own defining clause, filed as the thing to leave out. Acted on, that
     * excludes precisely the people being targeted. And the real suppression,
     * stated plainly one sentence later, was never captured at all.
     *
     * "Who do not have X" says who the audience IS. It belongs to the audience
     * definition, where the segmentation agent already uses it to build
     * xfinityTV = false. Only language that explicitly removes people -
     * suppress, exclude, omit, leave out - is a suppression.
     *
     * Getting this backwards is not a near-miss. It builds a campaign for the
     * complement of the requested audience, with a plausible count attached.
     */
    if (x) {
      /*
       * Cut at a WORD, not at a character count.
       *
       * The 70-character limit landed mid-word and the fragment was written
       * to Workfront: "...no point defending someone we". A truncation that
       * reads as a sentence is worse than an obvious one - nobody queries it.
       */
      const cutAtWord = (t: string, max: number) => {
        if (t.length <= max) return t;
        const cut = t.slice(0, max);
        const lastSpace = cut.lastIndexOf(" ");
        return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;-]+$/, "") + "...";
      };
      const what = cutAtWord((x[1] || "").trim(), 70)
        .replace(/\s+with us\s*(yet)?$/i, "")
        .replace(/^(?:anyone|anybody|any|all|those|people|customers)\s+(?:who\s+)?/i, "");
      if (what) {
        push({
          key: "exclusion",
          label: "Exclusion",
          value: what.charAt(0).toUpperCase() + what.slice(1),
          from: "stated",
          evidence: x[0].trim(),
        });
      }
    }
  }

  const fields: Record<string, string> = {};
  for (const f of extracted) fields[f.key] = f.value;

  const missing = requiredFields().filter((f: FieldSpec) => !fields[f.key]);
  const inferred = extracted.filter((f) => f.from !== "stated");
  const conflicts = findConflicts(candidates, fields, brief);

  return { fields, extracted, missing, inferred, conflicts };
}

/*
 * Months are proper nouns and are not places. Without this, "in January" reads
 * as a named market and every dated brief grows a spurious geography question.
 */
const NOT_A_PLACE =
  /^(January|February|March|April|May|June|July|August|September|October|November|December|Q[1-4]|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Xfinity|Comcast|Workfront|Email|SMS)$/i;

/**
 * The brief named a specific market AND a broad one.
 *
 * A marketer asked for Boise and the Treasure Valley with a national digital
 * layer over the top, and the request was filed as "National" - her actual
 * primary ask silently gone, with nothing asked and nothing flagged. The broad
 * option wins because the option list is matched before any place is looked
 * for, and "National" is one of the options.
 *
 * We cannot map a city to this tenant's region field, and should not pretend
 * to. But losing the marketer's own words without a word is the failure; being
 * unable to file them is not. So it asks.
 */
function findBroadAndSpecificPlace(brief: string, region: string): Conflict | null {
  const BROAD = /^(National|Northeast|Southeast|Midwest|Southwest|West)$/i;
  if (!region || !BROAD.test(region.trim())) return null;

  /*
   * A place name is usually more than one word, and cutting it at the first
   * produced nonsense: "in New York" was reported as the market "New", so the
   * question read 'The brief names "New" and also reads as national'.
   *
   * Up to two further capitalised words are taken, which covers New York,
   * Treasure Valley, Salt Lake City and the Bay Area without running off into
   * the rest of the sentence.
   */
  const locative = /\b(?:in|around|across|within|near|throughout|serving|covering)\s+(?:the\s+)?([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})/g;
  for (const m of brief.matchAll(locative)) {
    const name = (m[1] || "").trim();
    if (!name || NOT_A_PLACE.test(name)) continue;
    if (name.toLowerCase() === region.toLowerCase()) continue;
    return {
      key: "region",
      label: "Region / market",
      values: [name, region],
      ask:
        `The brief names "${name}" and also reads as ${region.toLowerCase()}. ` +
        `Which is the primary market? I have used "${region}", and this form has no field for a ` +
        `market as specific as "${name}", so if that is the real target it needs saying explicitly.`,
    };
  }
  return null;
}

/**
 * Where the brief disagrees with itself.
 *
 * Two kinds, and both used to pass silently:
 *
 * THE SAME FIELD, TWICE. An amendment - "scrap that, pull the date forward to
 * the 6th". The first value won the field and the correction was discarded, so
 * a plan the marketer had cancelled was previewed back to them confidently.
 *
 * TWO FIELDS THAT CANNOT BOTH BE TRUE. An acquisition campaign aimed at
 * existing subscribers. Observed live, unflagged:
 *
 *     Business objective = Acquisition                      [stated]
 *     Customer type      = Subscriber - Existing Customers  [inferred]
 *
 * Prospects and existing customers come from different places - prospects are
 * not in the profile store at all - so this is not a wording quibble. It
 * decides which build path runs, and getting it wrong is discovered after the
 * audience is built.
 *
 * Nothing here guesses a winner. A brief that contradicts itself is the one
 * case where asking is unambiguously right: the marketer knows which they
 * meant, it takes them a second, and no amount of cleverness here can recover
 * the intent.
 */
function findConflicts(
  candidates: Map<string, ExtractedField[]>,
  fields: Record<string, string>,
  brief: string,
): Conflict[] {
  const out: Conflict[] = [];
  const norm = (s: string) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

  // 1. The same field, answered twice differently.
  for (const [key, list] of candidates) {
    const distinct: ExtractedField[] = [];
    for (const f of list) {
      if (!distinct.some((d) => norm(d.value) === norm(f.value))) distinct.push(f);
    }
    if (distinct.length < 2) continue;
    const label = distinct[0].label || key;
    const values = distinct.map((d) => d.value);
    out.push({
      key,
      label,
      values,
      ask:
        `The brief gives ${label.toLowerCase()} twice: "${values[0]}" and "${values[1]}". ` +
        `Which one is right? I have used "${values[0]}" so far, and I would rather ask than file the wrong one.`,
    });
  }

  /*
   * 2. Prospects and existing customers at the same time.
   *
   * Checked on the resolved fields rather than the candidates, because either
   * side can arrive stated or inferred and the contradiction is just as real
   * when half of it was a guess - arguably more so.
   */
  const objective = norm(fields.business_objective);
  const customer = norm(fields.customer_type);
  const wantsProspects = /acquisition|prospect|net.new|new customer/.test(objective + " " + customer);
  const wantsExisting = /existing|current (customer|subscriber)|winback|retention|upsell|upgrade/.test(
    objective + " " + customer,
  );
  if (wantsProspects && wantsExisting) {
    out.push({
      key: "customer_type",
      label: "Who this is for",
      values: [fields.business_objective || "", fields.customer_type || ""].filter(Boolean),
      ask:
        "This brief reads as both acquisition and existing-customer work " +
        `(objective "${fields.business_objective || "-"}", audience "${fields.customer_type || "-"}"). ` +
        "Which is it? Prospects and existing customers are built from different places, so it changes the whole build.",
    });
  }

  const place = findBroadAndSpecificPlace(brief, fields.region || "");
  if (place) out.push(place);

  return out;
}

/**
 * The two things actually missing — not the whole form.
 *
 * B1 again: *"the agent asks for the two things actually missing rather than
 * re-asking the whole brief."* Asking for eleven fields is how a loop count
 * passes two, and past two the agent has failed, not the marketer.
 */
export function nextQuestions(parsed: ParsedIntake, limit = 2): FieldSpec[] {
  /*
   * A CONTRADICTION OUTRANKS A GAP.
   *
   * A missing field is a thing the marketer has not said yet. A contradiction
   * is a thing they have said twice, differently - which means the brief as
   * filed is wrong right now, and filing it emails a queue. Given only two
   * questions, spend them on the disagreements first.
   *
   * It is also the better question to be asked. "What is the in-market date?"
   * makes the marketer do the work; "you said the 20th and then the 6th, which
   * is it?" shows we read the brief.
   */
  const fromConflicts: FieldSpec[] = (parsed.conflicts || []).map((c) => ({
    key: c.key,
    label: c.label,
    ask: c.ask,
  } as FieldSpec));

  const seen = new Set(fromConflicts.map((f) => f.key));
  const gaps = parsed.missing.filter((f) => !seen.has(f.key));

  return [...fromConflicts, ...gaps].slice(0, limit);
}
