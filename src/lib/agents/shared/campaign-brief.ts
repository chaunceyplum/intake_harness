/**
 * The Campaign Brief, as data.
 *
 * WHY THIS IS A TABLE AND NOT PROSE IN A PROMPT
 *
 * B1 is about a loop: "the agent cannot build the intake from the prompt, so it
 * bounces back to the marketer... each round trip is unbounded." An agent that
 * keeps the form in its prompt cannot tell you which field is missing, only
 * that something is. It therefore re-asks the whole brief, and re-asking the
 * whole brief IS the loop.
 *
 * Keeping the form as a list of fields makes "what is actually missing" a
 * computable question - see parse.ts, which answers it and then asks for two
 * things rather than eleven.
 *
 * WHERE THESE FIELDS COME FROM, AND WHAT IS NOT VERIFIED
 *
 * The keys and option values are the Comcast intake form's own vocabulary as
 * captured from the tenant's "CSC Intake - Issue" form (categoryID
 * 69cad7690002898fbf9d684642dc25bc, see intake/workfront.ts). Several option
 * lists here are PARTIAL - they contain the values we have actually seen, and
 * are marked where that is true. That is deliberate: a made-up option would be
 * matched against a real brief and written into a real Workfront record.
 *
 * The authoritative list lives on the Workfront custom form, and can be read
 * once someone has signed in to the official MCP:
 *   insights_search_fields / workflow_resolve_field_names_any_object
 * Until then, an unmatched value falls through to "missing" and gets asked,
 * which is the safe direction to be wrong in.
 */

export type FieldSpec = {
  /** Stable key. Also the custom-field name sent to Workfront. */
  key: string;
  /** What the marketer sees. */
  label: string;
  /** Required for an audience to be buildable at all. Drives needs_input. */
  required?: boolean;
  /**
   * Ask for this as part of Agent 1's AUDIENCE-completeness pass - distinct
   * from `required` on purpose. `required` means "no audience can be built
   * or targeted without this" (see requiredFields' own docstring below);
   * these fields are the opposite case - the audience CAN be built without
   * an answer, but the answer is one of the things a real Workfront custom
   * form for audience-only requests needs captured (LCE | Campaign
   * Deployment Request, "Audience Specifications & Model Integration"
   * section - read live, 19 Sep 2026, ticket 1475050/"9Box"). Explicit
   * product direction: ask for these too, not just extract them
   * opportunistically and leave them blank when the brief doesn't happen to
   * state them. Sequenced AFTER `required` fields in nextQuestions - never
   * asked before the hard baseline is satisfied - and still capped at 2 per
   * round, so this doesn't change B1's pacing, only what eventually gets
   * asked once the baseline clears. See parse.ts's nextQuestions.
   */
  askForAudience?: boolean;
  /**
   * Allowed values, where the form constrains them. Matched against the brief
   * verbatim by parse.ts, longest-first.
   */
  options?: readonly string[];
  /** True when `options` is known to be incomplete. */
  optionsPartial?: boolean;
  /** Other names the same thing goes by in a brief. */
  aliases?: readonly string[];
  /**
   * The question to put to the marketer when this is the thing that is missing.
   * Written as one specific question, because "please complete the brief" is
   * what produces another round trip.
   */
  ask?: string;
};

/**
 * REQUIRED means: without this, no audience can be built or targeted.
 *
 * NONE of the fields below are `required` any more - explicit product
 * direction for the executive demo: the only required input is the brief
 * itself. Intake infers what it can and proceeds; it never blocks on a
 * campaign name, business objective, customer type, line of business,
 * request type, or launch date being absent. The only thing that still
 * blocks Intake is a filter the brief names that has no matching field in
 * customer data at all (see src/lib/agents/intake/buildability.ts) - a
 * buildability question, not a form-completeness one. `required` stays on
 * FieldSpec (unused today) rather than being deleted, so a future field
 * that genuinely blocks building anything has somewhere to say so.
 */
export const CAMPAIGN_BRIEF_FIELDS: readonly FieldSpec[] = [
  {
    key: "campaign_name",
    label: "Campaign name",
    aliases: ["campaign", "name of campaign", "initiative", "Name of the Campaign"],
    ask: "What should this campaign be called? A short name is enough - it becomes the Workfront request title.",
  },
  {
    key: "business_objective",
    label: "Business objective",
    options: ["Growth/Upsell", "Retention", "Acquisition"],
    optionsPartial: true,
    aliases: ["objective", "goal", "business goal", "Objective of the campaign"],
    ask: "Is this Growth/Upsell, Retention, or Acquisition? It decides which base we build from.",
  },
  {
    key: "customer_type",
    label: "Customer type",
    options: ["Subscriber - Existing Customers", "Prospect - Non-Customers"],
    optionsPartial: true,
    aliases: ["audience type", "who are we targeting"],
    ask: "Existing subscribers or prospects? Existing customers come from the profile store; prospects do not, and that changes the whole build path.",
  },
  {
    key: "line_of_business",
    label: "Line of business",
    options: ["Residential (RES)", "Business (SMB)"],
    optionsPartial: true,
    aliases: ["lob", "segment", "division"],
    ask: "Residential or Business? They are separate data sets, so we cannot infer one from the other.",
  },
  {
    key: "request_type",
    label: "Request type",
    options: ["Audience Build-Only", "Audience + Campaign Execution"],
    optionsPartial: true,
    aliases: ["what do you need", "scope"],
    ask: "Do you need the audience only, or the audience and the campaign executed?",
  },
  {
    key: "launch_date",
    label: "Launch date",
    aliases: ["in market", "go live", "live date", "launch", "Requested_Launch_Date", "Requested Launch Date"],
    // The nightly segmentation job at 21:45 (B6) means a date is not a
    // formality - every rework cycle after it costs a full day.
    ask: "What is the in-market date? The segmentation job runs once a night, so the date sets how many rework cycles we can absorb.",
  },
  {
    key: "lifecycle_journey",
    label: "Lifecycle journey",
    askForAudience: true,
    options: ["Upgrade", "Winback", "Onboarding", "Cross-sell"],
    optionsPartial: true,
    aliases: ["journey", "lifecycle stage"],
    ask: "Which lifecycle journey does this sit in - upgrade, winback, onboarding, cross-sell?",
  },
  {
    key: "campaign_duration",
    label: "Campaign duration",
    // "Evergreen (ongoing)" is the exact string the LCE form's own "Is this
    // a one-time or evergreen campaign?" question uses too - strong evidence
    // this is the same field under two forms, so "One-time" was added here
    // rather than opening a second, near-duplicate field for it. That LCE
    // question lives in the form's AUDIENCE section, not the campaign
    // section - it's asking whether the AUDIENCE persists past one send.
    askForAudience: true,
    options: ["Evergreen (ongoing)", "Fixed window", "One-time"],
    optionsPartial: true,
    aliases: ["duration", "how long", "one-time or evergreen"],
    ask: "Is this a one-time campaign, a fixed window, or evergreen?",
  },
  {
    key: "cadence",
    label: "Cadence",
    options: ["One-time Campaign", "Recurring Campaign"],
    optionsPartial: true,
    aliases: ["frequency", "how often"],
    ask: "One-time or recurring?",
  },
  {
    key: "activation_pattern",
    label: "Activation pattern",
    // "Triggered" is the LCE form's own "Deployment Type" wording for the
    // same concept as "Near-real time trigger" - added as its own accepted
    // value (not force-mapped onto our wording) so it still matches if a
    // real form's field literally uses that word, same reasoning as
    // campaign_duration above. Lives in the LCE form's Audience
    // Specifications section, not a campaign-mechanics section.
    askForAudience: true,
    options: ["Batch", "Near-real time trigger", "Triggered"],
    optionsPartial: true,
    aliases: ["activation", "trigger", "deployment type"],
    ask: "Batch send, or a near-real-time/triggered send?",
  },
  {
    key: "channels",
    label: "Channels",
    // Outbound call appeared in two consecutive real briefs and was captured
    // as nothing, because the list did not have it.
    options: ["Email", "SMS", "Direct Mail", "Paid Media", "In-app", "Outbound Call", "Push"],
    optionsPartial: true,
    aliases: ["channel", "how are we reaching them"],
    ask: "Which channels - email, SMS, direct mail, paid media, in-app?",
  },
  {
    key: "offer",
    label: "Offer",
    aliases: ["incentive", "promo", "promotion", "discount"],
    ask: "What is the offer or incentive?",
  },
  {
    // "Northeast", "in the Northeast". It was in every brief we tested and in
    // none of the structured output, which meant the audience definition was
    // missing the geography it was supposed to be built on.
    key: "region",
    label: "Region / market",
    options: ["Northeast", "Southeast", "Midwest", "West", "Southwest", "National"],
    optionsPartial: true,
    aliases: ["market", "geography", "geo", "footprint", "territory"],
    ask: "Which region or market - Northeast, Southeast, Midwest, West?",
  },
  {
    // "who do not have a mobile line with us yet" is the exclusion that defines
    // the audience. Carrying it only in free text means the person building the
    // segment has to re-read the brief to find the most important clause in it.
    key: "exclusion",
    label: "Exclusion",
    askForAudience: true,
    aliases: ["exclude", "without", "who do not have", "not already"],
    ask: "Who should be excluded - for example, customers who already have the product?",
  },
  /*
   * FROM "LCE | Campaign Deployment Request" - a real, live Workfront form
   * (ticket ACQ_WFP_PriceUpdate_092126, read 18 Sep 2026) that is far richer
   * than the CSC-form model above: ~35 fields across request overview,
   * audience specification, channel, and email-specific sections. None of
   * the fields below are `required` - B1's fix is asking FEWER things, not
   * more, and these enrich the brief when present rather than opening new
   * required-field round trips. A field with no match on whatever form is
   * actually live gets DROPPED at write time (workfront-fields.ts), same as
   * every field above - adding these here is safe even before anyone
   * confirms LCE is the real target form/queue for Agent 1's create.
   *
   * A few of these deliberately have NO `options`: parse.ts's matchOption
   * has no word-boundary check, just `hay.includes(needle)`, so a short,
   * common option string ("Yes", "No", "Internal") would match as a
   * substring of unrelated text ("Notes", "known", "international") - the
   * exact class of bug this file's other comments warn about repeatedly
   * ("lob" inside "glob", "mar" inside "in market"). Those fields are left
   * for the marketer to answer explicitly, or for a rejection to name via
   * resolveFieldRef, never opportunistically guessed from prose.
   */
  {
    key: "data_availability",
    label: "Targeting data available today",
    askForAudience: true,
    aliases: ["targeting data available", "is the data available"],
    ask: "Is all the targeting data this audience needs already available today, or does something still need to be built?",
  },
  {
    // The single highest-stakes field in this whole block: this is the
    // FAC-vs-profile-store question aep.ts's identityGap/decideBuildPath and
    // triage.ts's SOURCE_CUES already spend real effort trying to infer from
    // free text. An authoritative answer here is worth far more than a
    // guessed one - see lib/agents/audience/aep.ts.
    key: "data_location",
    label: "Where the targeting data lives",
    askForAudience: true,
    aliases: ["where does this data live", "data source", "fac or profile"],
    ask: "Where does this targeting data live today - the AEP profile store, or an external/federated (FAC) source? They resolve to different identities and different build paths.",
  },
  {
    key: "audience_build_method",
    label: "Audience build method",
    askForAudience: true,
    options: ["Simple Workflow Audience"],
    optionsPartial: true,
    aliases: ["how should the audience be built", "build method"],
    ask: "How should this audience be built - a simple workflow audience, or something more complex?",
  },
  {
    // The gap this closes: "no refresh cadence, so the build gets treated
    // as a one-time snapshot and goes stale by send day."
    key: "audience_refresh_cadence",
    label: "Audience refresh cadence",
    askForAudience: true,
    options: ["Static Campaign Audience"],
    optionsPartial: true,
    aliases: ["refresh cadence", "how often should this audience refresh"],
    ask: "Should this audience refresh on a schedule, or is it a static, one-time snapshot?",
  },
  {
    // The gap this closes: "'~40K?' is the requester asking the technical
    // team to do feasibility work that then becomes the committed number."
    // Capturing the marketer's OWN expectation, separate from Agent 3's
    // predicted count, makes a mismatch visible instead of silent.
    //
    // Only "Medium (50K-250K)" is confirmed from a real ticket - the other
    // bucket boundaries are a reasonable guess at the same scheme, NOT
    // verified against the live form. Treat as a starting point.
    key: "expected_audience_size",
    label: "Expected audience size",
    askForAudience: true,
    options: ["Small (<50K)", "Medium (50K–250K)", "Large (250K–1M)", "Very Large (1M+)"],
    optionsPartial: true,
    aliases: ["expected audience size", "audience size", "how big"],
    ask: "Roughly what audience size do you expect? A ballpark bucket is fine - Agent 3 predicts the real count separately, and a mismatch between the two is worth surfacing rather than silently picking one.",
  },
  {
    key: "requires_predictive_model",
    label: "Requires a predictive model",
    askForAudience: true,
    aliases: ["predictive model", "model not yet live"],
    ask: "Does this audience need a predictive model that isn't live yet, or can it be built from data that already exists?",
  },
  {
    // The gap this closes: "no holdout, so the campaign can't be measured
    // and the +3.5pp claim in the next QBR is unfalsifiable."
    key: "requires_test_holdout",
    label: "Test / holdout required",
    aliases: ["a/b test", "holdout", "control group", "implementing any tests"],
    ask: "Is a holdout or control group needed to measure this campaign, or is it going out unmeasured?",
  },
  {
    key: "request_category",
    label: "Request category",
    options: ["Promotional (Marketing)"],
    optionsPartial: true,
    aliases: ["what type of request is this", "request type category"],
    ask: "What type of request is this - promotional/marketing, or something else?",
  },
  {
    key: "promo_channel_type",
    label: "Single- or multi-channel",
    options: ["Single-Channel", "Multi-Channel"],
    optionsPartial: true,
    aliases: ["single-channel", "multi-channel", "coordinated communication"],
    ask: "Is this a single-channel send, or a coordinated multi-channel communication?",
  },
  {
    key: "email_delivery_type",
    label: "Email delivery type",
    options: ["Email Series / Journey"],
    optionsPartial: true,
    aliases: ["how is this email being delivered"],
    ask: "Is this a single email, or a series/journey of emails?",
  },
  {
    // The gap this closes: "no personalization fields, which means the
    // export schema gets designed twice."
    key: "personalization_level",
    label: "Email personalization level",
    options: ["No Personalization"],
    optionsPartial: true,
    aliases: ["personalization", "how personalized"],
    ask: "How personalized does this email need to be - none, basic merge fields, or full 1:1 personalization?",
  },
  {
    key: "email_count",
    label: "Number of emails",
    aliases: ["how many emails", "email count"],
    ask: "How many emails are in this campaign/journey?",
  },
  {
    key: "spanish_version",
    label: "Spanish version",
    aliases: ["spanish version", "en espanol"],
    ask: "Is a Spanish version of this needed?",
  },
  {
    key: "trigger_already_active",
    label: "Trigger already active",
    askForAudience: true,
    aliases: ["is this trigger already active", "already live in the platform"],
    ask: "Is this trigger already active in the platform, or does it need to be newly activated?",
  },
  {
    key: "expected_business_impact",
    label: "Expected business impact",
    options: ["Medium Impact ($50K–$250K)"],
    optionsPartial: true,
    aliases: ["expected revenue", "business impact"],
    ask: "What's the expected revenue or business impact of this campaign?",
  },
  {
    key: "campaign_series",
    label: "Part of a larger initiative",
    options: ["Campaign Series Part"],
    optionsPartial: true,
    aliases: ["larger marketing initiative", "campaign series"],
    ask: "Is this campaign part of a larger series or initiative?",
  },
  {
    key: "creative_status",
    label: "Creative status",
    options: ["Creative is already in production/approved"],
    optionsPartial: true,
    aliases: ["creative needs", "creative status"],
    ask: "What's the state of the creative - already approved, in progress, or not started?",
  },
  {
    key: "priority",
    label: "Request priority",
    options: ["Standard Priority"],
    optionsPartial: true,
    aliases: ["priority of this request"],
    ask: "What priority is this request - standard, or expedited?",
  },
  {
    // Routing metadata, like workfront_project_id below - never asked for,
    // only carried through when the intake form itself supplies it.
    key: "linked_creative_project",
    label: "Linked creative project",
    aliases: ["creative project", "linked creative project"],
  },
  {
    /*
     * The audience, in one sentence, because that is what the form asks for.
     *
     * Read off the live tenant (taplondonptrsd, 16 Sep 2026), the intake form
     * has FOUR meaningful fields, not the fourteen modelled above:
     *
     *   DE:Name of the Campaign      DE:Objective of the campaign
     *   DE:Audience_to_be_Targeted   DE:Requested_Launch_Date
     *
     * There is no Line of Business field, no Region field, no Channels field.
     * So the fields we extract that the form has nowhere to put are COMPOSED
     * into this one, rather than dropped or written to names that do not exist.
     * The richer breakdown still travels in the run record, where the audience
     * builder can read it - it just is not pretended into Workfront.
     */
    key: "audience_description",
    label: "Audience to be targeted",
    askForAudience: true,
    aliases: ["Audience_to_be_Targeted", "audience to be targeted", "target audience"],
    ask: "Who is the audience, in a sentence?",
  },
  /*
   * FOUR MORE FIELDS FROM THE LCE FORM'S "Audience Specifications & Model
   * Integration" SECTION - genuinely new, not modelled anywhere above.
   * Captured off a real, live ticket (1475050, "9Box" - nine audiences
   * segmented on Customer Quality Score x Customer Lifetime Value, read 19
   * Sep 2026). Deliberately NO `options` on lifecycle_journey_subcategory
   * and product_mix - the one real value seen for each ("XM", "Xfinity
   * Mobile (W)") is a short, tenant-specific code, and this file's own
   * established rule (see the block comment above data_availability et al.)
   * is that a short option string gets left for the marketer to answer
   * explicitly rather than opportunistically substring-matched against
   * unrelated prose.
   */
  {
    // Distinct from `request_type` ("Audience Build-Only" vs. "Audience +
    // Campaign Execution") - this is a step more specific, about the
    // audience WORK ITSELF: is it a brand-new build, or an update/refresh
    // to something that already exists. Only "Audience Build (New)" is
    // confirmed from the real ticket.
    key: "audience_support_type",
    label: "Type of audience support needed",
    askForAudience: true,
    options: ["Audience Build (New)"],
    optionsPartial: true,
    aliases: ["type of audience support", "audience support"],
    ask: "What type of audience support do you need - a new audience build, or an update/refresh to an existing one?",
  },
  {
    key: "lifecycle_journey_subcategory",
    label: "Lifecycle journey subcategory",
    askForAudience: true,
    aliases: ["journey subcategory", "upgrade journey subcategory"],
    ask: "Is there a more specific sub-category within that lifecycle journey - for example, which product line or motion within an Upgrade journey?",
  },
  {
    key: "product_mix",
    label: "Product mix",
    askForAudience: true,
    aliases: ["product mix"],
    ask: "Which product or product mix is this audience built around - for example Xfinity Mobile, Internet, or TV?",
  },
  {
    // The gap this closes: an audience request that reads as low-risk
    // ("just like the one we did in Q2") versus one that is genuinely new
    // and unproven get built and reviewed the same way today, when the
    // second one deserves more scrutiny before the nightly cutoff (B6).
    key: "audience_performance_history",
    label: "Audience performance history",
    askForAudience: true,
    options: ["New Audience"],
    optionsPartial: true,
    aliases: ["historical performance", "performance history", "track record"],
    ask: "Is this a brand-new audience, or does it have a track record you can point to - for example, a similar audience that's performed before?",
  },
  {
    // No `options` on purpose - a destination is whatever real AEP
    // dataflow/target-connection name exists on this tenant (e.g. "Facebook
    // Ads", "chaunceys custom dest"), which this file cannot enumerate in
    // advance. "N/A"/"none" are handled explicitly at the point this field
    // is READ (activation.ts's detectActivationIntentFromField), not here -
    // this field only captures what the marketer said, verbatim.
    key: "destination",
    label: "Activation destination",
    askForAudience: true,
    aliases: ["destination", "where does this go", "activate to", "send to", "what destination"],
    ask: "What destination does this audience go to? Name the platform or destination - or say \"none\" if this is audience build-only with no activation.",
  },
  {
    /*
     * Routing metadata, not a campaign fact — which Workfront project the
     * intake issue should land in. Deliberately NOT required and has no
     * `ask`: a marketer doesn't state a Workfront project GUID in a brief,
     * so this must never trigger a needs_input round asking for one. Set
     * explicitly (the intake form's own project-id input) or left absent,
     * in which case intake/workfront.ts falls back to
     * WORKFRONT_INTAKE_PROJECT_ID / WORKFRONT_INTAKE_QUEUE as before.
     */
    key: "workfront_project_id",
    label: "Workfront project",
    aliases: ["project id", "destination project", "workfront project"],
  },
] as const;

/**
 * The fields without which nothing can be built - none, today (see this
 * file's docstring above CAMPAIGN_BRIEF_FIELDS). Kept as a function rather
 * than deleted: review/route.ts's preflight and triage.ts's rejection
 * summary both still call it, and an always-empty result is the correct
 * answer for both now, not a special case they need to know about.
 */
export function requiredFields(): FieldSpec[] {
  return CAMPAIGN_BRIEF_FIELDS.filter((f) => f.required);
}

/**
 * The fields Agent 1 asks for so the AUDIENCE side of the request is
 * complete - see FieldSpec's `askForAudience` docstring for exactly how
 * this differs from requiredFields (buildability) and how parse.ts's
 * nextQuestions sequences the two.
 */
export function audienceFields(): FieldSpec[] {
  return CAMPAIGN_BRIEF_FIELDS.filter((f) => f.askForAudience);
}

/** One field by key. */
export function fieldByKey(key: string): FieldSpec | undefined {
  return CAMPAIGN_BRIEF_FIELDS.find((f) => f.key === key);
}

/**
 * Resolve a field from whatever a rejection or a reviewer called it.
 *
 * Agent 2 reads rejection text written by a human in a hurry - "no LOB", "which
 * segment?", "missing launch" - and has to land on a field key. Matching the
 * label, the key, or a declared alias covers the realistic cases without
 * pretending to understand arbitrary prose.
 */
export function resolveFieldRef(text: string): FieldSpec | undefined {
  const hay = String(text || "").toLowerCase();
  if (!hay.trim()) return undefined;

  const candidates = CAMPAIGN_BRIEF_FIELDS.flatMap((f) => [
    { f, needle: f.label.toLowerCase() },
    { f, needle: f.key.replace(/_/g, " ") },
    { f, needle: f.key },
    ...(f.aliases || []).map((a) => ({ f, needle: a.toLowerCase() })),
  ]);

  // Longest needle first: "customer type" must beat "type".
  candidates.sort((a, b) => b.needle.length - a.needle.length);
  return candidates.find((c) => c.needle.length > 2 && hay.includes(c.needle))?.f;
}
