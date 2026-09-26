import { describe, it, expect } from "vitest";
import { parseBrief, nextQuestions } from "./parse";
import { requiredFields, audienceFields } from "@/lib/agents/shared/campaign-brief";

const OLD_BASELINE_KEYS = [
  "campaign_name",
  "business_objective",
  "customer_type",
  "line_of_business",
  "request_type",
  "launch_date",
];

describe("nextQuestions - no required-field tier any more (explicit product direction: brief-only intake)", () => {
  it("requiredFields() is empty - nothing blocks a brief from proceeding", () => {
    expect(requiredFields()).toEqual([]);
  });

  it("a brief with nothing structured never asks about the old baseline fields (campaign name, objective, customer type, line of business, request type, launch date)", () => {
    const parsed = parseBrief("We need something built.");
    expect(parsed.missing).toEqual([]); // requiredFields() is empty, so nothing is ever "missing" here
    const questions = nextQuestions(parsed, 2);
    for (const q of questions) {
      expect(OLD_BASELINE_KEYS).not.toContain(q.key);
    }
  });

  it("falls straight through to askForAudience fields when nothing is stated - never stops on the old baseline", () => {
    const parsed = parseBrief("We need something built.");
    const questions = nextQuestions(parsed, 2);
    expect(questions.length).toBe(2);
    for (const q of questions) {
      expect(audienceFields().map((f) => f.key)).toContain(q.key);
    }
  });

  it("stops asking (empty) once every askForAudience field is answered", () => {
    const known: Record<string, string> = {};
    for (const f of audienceFields()) known[f.key] = "x";
    const parsed = parseBrief("", known);
    expect(nextQuestions(parsed, 2)).toEqual([]);
  });

  it("respects the 2-per-round cap for audience questions", () => {
    const parsed = parseBrief("");
    expect(parsed.missing).toEqual([]);
    expect(parsed.missingAudience.length).toBeGreaterThan(2); // there are more than 2 askForAudience fields
    expect(nextQuestions(parsed, 2).length).toBe(2);
  });
});

describe("the audience-completeness field set - a regression guard on what's actually asked", () => {
  // Explicit product direction (a real LCE Workfront form's "Audience
  // Specifications & Model Integration" section, ticket 1475050/"9Box", 19
  // Sep 2026): these specific fields are the ones Agent 1 now asks for.
  // Guards against silently dropping one in a future refactor.
  it("includes every field identified from the LCE audience section", () => {
    const keys = audienceFields().map((f) => f.key);
    for (const expected of [
      "audience_description",
      "audience_build_method",
      "expected_audience_size",
      "audience_refresh_cadence",
      "exclusion",
      "data_availability",
      "data_location",
      "requires_predictive_model",
      "activation_pattern",
      "trigger_already_active",
      "campaign_duration",
      "lifecycle_journey",
      "audience_support_type",
      "lifecycle_journey_subcategory",
      "product_mix",
      "audience_performance_history",
    ]) {
      expect(keys).toContain(expected);
    }
  });

  it("does not include fields unrelated to the audience (creative/priority/campaign-series)", () => {
    const keys = audienceFields().map((f) => f.key);
    expect(keys).not.toContain("creative_status");
    expect(keys).not.toContain("priority");
    expect(keys).not.toContain("campaign_series");
    expect(keys).not.toContain("email_count");
  });
});

describe("launch_date - an acronym is not a month", () => {
  it("does not read \"SEP eligible\" as September", () => {
    const parsed = parseBrief("Create an audience of profiles with an email address and are SEP eligible");
    expect(parsed.fields.launch_date).toBeUndefined();
  });

  it("does not read the verb \"may\" as May", () => {
    const parsed = parseBrief("Customers who may churn, launching end of October");
    expect(parsed.fields.launch_date).toBe("End of October");
  });

  it("still reads a bare month and an abbreviated date", () => {
    expect(parseBrief("launch in September").fields.launch_date).toBe("September");
    expect(parseBrief("in market Sep 5").fields.launch_date).toBe("5 September");
  });
});
