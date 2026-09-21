import { describe, it, expect, vi } from "vitest";
import {
  ATTRIBUTE_CUES,
  criteriaKeywords,
  neededAttributes,
  identityGap,
  decideBuildPath,
  nightlyCutoff,
  scoreSegmentName,
  findExistingSegment,
  MIN_SEGMENT_MATCH_RATIO,
  IDENTIFIER_FIELD_SUFFIX,
  type SchemaProbe,
} from "./aep";

/**
 * A plain closure-controlled stub, NOT vi.fn()/mockResolvedValue/
 * mockRejectedValue - a spy whose behavior is switched between resolving
 * and rejecting across sibling tests in this file reliably reproduces a
 * false "unhandled rejection" test failure under this repo's Vitest/Node
 * combination (verified: an isolated single test passes; TWO tests
 * exercising the same real, correctly try/catch-wrapped async function -
 * one resolving, one rejecting - fails even though the function's own
 * error handling is provably correct). This sidesteps that tooling
 * quirk entirely rather than working around a bug that isn't in the code
 * under test.
 */
const mcpBehavior: { mode: "resolve" | "reject"; value: unknown } = { mode: "resolve", value: [] };
vi.mock("@/lib/mcp-client", () => ({
  callMcpTool: async () => {
    if (mcpBehavior.mode === "reject") throw mcpBehavior.value as Error;
    return mcpBehavior.value;
  },
}));

function emptyProbe(overrides: Partial<SchemaProbe> = {}): SchemaProbe {
  return {
    read: true,
    conclusive: true,
    error: null,
    sandbox: "taplondonptrsd",
    schemaCount: 10,
    schemasInspected: 6,
    fieldGroupsInspected: 0,
    fieldCount: 50,
    found: {},
    evidence: [],
    ...overrides,
  };
}

describe("ATTRIBUTE_CUES word-boundary anchoring", () => {
  // The regression this guards: an unanchored "lob" cue once matched "glob"
  // inside "https://.../global/schemas?limit=50" and reported
  // line-of-business as AVAILABLE on the strength of a substring in a URL.
  it("does not match 'lob' inside 'global'", () => {
    expect(ATTRIBUTE_CUES.line_of_business.test("https://ns.adobe.com/global/schemas?limit=50")).toBe(false);
  });

  it("does match real line-of-business field spellings", () => {
    expect(ATTRIBUTE_CUES.line_of_business.test("lineOfBusiness")).toBe(true);
    expect(ATTRIBUTE_CUES.line_of_business.test("line_of_business")).toBe(true);
    expect(ATTRIBUTE_CUES.line_of_business.test("the LOB for this account")).toBe(true);
  });

  it("identity cue matches ECID/MCID but not unrelated words containing similar letters", () => {
    expect(ATTRIBUTE_CUES.identity.test("audience where ECID exists")).toBe(true);
    expect(ATTRIBUTE_CUES.identity.test("Experience Cloud ID must be present")).toBe(true);
    expect(ATTRIBUTE_CUES.identity.test("this is a decidedly unrelated sentence")).toBe(false);
  });

  it("product_ownership cue matches real tenant field names verified live against the gateway", () => {
    // xfinityTV/xfinityInternet/customerEmail were confirmed as literal PQL
    // field references in real segments ("Maryland Internet Attach Q4 push",
    // "Michigan TV-Only Internet Upsell") - see aep.ts's docstring.
    expect(ATTRIBUTE_CUES.product_ownership.test("xfinityTV = true and xfinityInternet = false")).toBe(true);
    expect(ATTRIBUTE_CUES.product_ownership.test("households with Internet service")).toBe(true);
    expect(ATTRIBUTE_CUES.product_ownership.test("TV-only households")).toBe(true);
  });

  it("channels cue stays narrow - a bare 'email' does not trip it (avoids re-triggering the GTO over-ask bug in a new form)", () => {
    expect(ATTRIBUTE_CUES.channels.test("send this via email")).toBe(false);
    expect(ATTRIBUTE_CUES.channels.test("emailAddress != null")).toBe(true);
  });

  // THE BUG: a real brief asked for "an audience where personId exists" and
  // this cue never fired - neededAttributes came back empty, probeSchemas
  // short-circuited with a vacuous "conclusive, 0 checked", and the run
  // silently reused an unrelated existing segment. See this cue's own
  // docstring for why personid/person_id map onto the SAME already-grounded
  // identity evidence, not an invented field name.
  it("identity cue also matches personId/person_id (the personId regression)", () => {
    expect(ATTRIBUTE_CUES.identity.test("an audience where personId exists")).toBe(true);
    expect(ATTRIBUTE_CUES.identity.test("people who have a person_id")).toBe(true);
    expect(ATTRIBUTE_CUES.identity.test("_tenant.personId")).toBe(true);
  });

  // GENERALIZATION: any "id"/"guid"/"uuid" mention, as its own word or a
  // snake_case suffix, should read as an identity ask - not just personId.
  it("identity cue matches standalone id/guid/uuid mentions in brief text", () => {
    expect(ATTRIBUTE_CUES.identity.test("an audience where the device ID exists")).toBe(true);
    expect(ATTRIBUTE_CUES.identity.test("customers with a loyalty id on file")).toBe(true);
    expect(ATTRIBUTE_CUES.identity.test("people who have an account GUID")).toBe(true);
    expect(ATTRIBUTE_CUES.identity.test("a session UUID must be present")).toBe(true);
    expect(ATTRIBUTE_CUES.identity.test("filter on device_id")).toBe(true);
    expect(ATTRIBUTE_CUES.identity.test("filter on account_guid")).toBe(true);
  });

  it("identity cue matches compound email/phone identity forms, but stays off bare 'email'/'phone' (avoids the channel-selection over-ask bug)", () => {
    expect(ATTRIBUTE_CUES.identity.test("customers where emailAddress exists")).toBe(true);
    expect(ATTRIBUTE_CUES.identity.test("target by phone_number")).toBe(true);
    expect(ATTRIBUTE_CUES.identity.test("send this via email")).toBe(false);
    expect(ATTRIBUTE_CUES.identity.test("reach them by phone")).toBe(false);
  });

  // THE TRAP: plenty of ordinary English words END in "-id" (avoid, valid,
  // solid, rapid, hybrid, ...) or contain "id" mid-word (guide, video,
  // consider, provide, identity). None of these are a standalone "id"
  // token, so none should trip the cue - this is the exact "lob in glob"
  // discipline this file exists to enforce, generalized to the new
  // id/guid/uuid alternatives.
  it("does NOT match ordinary English words that merely end in or contain 'id'", () => {
    for (const word of [
      "avoid", "valid", "solid", "rapid", "hybrid", "acid", "fluid", "grid",
      "guide", "guidance", "guided", "video", "consider", "provide", "identity", "decidedly",
    ]) {
      expect(ATTRIBUTE_CUES.identity.test(`please ${word} this for the campaign`)).toBe(false);
    }
  });
});

describe("IDENTIFIER_FIELD_SUFFIX - camelCase identity evidence in real schema field names", () => {
  it("matches real camelCase id/guid/uuid suffixes", () => {
    expect(IDENTIFIER_FIELD_SUFFIX.test("deviceId")).toBe(true);
    expect(IDENTIFIER_FIELD_SUFFIX.test("loyaltyId")).toBe(true);
    expect(IDENTIFIER_FIELD_SUFFIX.test("accountGuid")).toBe(true);
    expect(IDENTIFIER_FIELD_SUFFIX.test("sessionUuid")).toBe(true);
    expect(IDENTIFIER_FIELD_SUFFIX.test("_tenant.orderId")).toBe(true);
  });

  // THE TRAP, case-sensitive version: "identityMap" has "id" at the very
  // START with no lowercase letter before it (not a suffix), and
  // "userGuideline"/"userGuidance" have more letters immediately after
  // "Guid" (not a clean suffix) - both must NOT match.
  it("does not match identityMap, or a Guid-prefixed-but-longer word", () => {
    expect(IDENTIFIER_FIELD_SUFFIX.test("identityMap")).toBe(false);
    expect(IDENTIFIER_FIELD_SUFFIX.test("userGuideline")).toBe(false);
    expect(IDENTIFIER_FIELD_SUFFIX.test("userGuidance")).toBe(false);
  });

  it("does not match all-lowercase English words (case sensitivity is the whole point)", () => {
    expect(IDENTIFIER_FIELD_SUFFIX.test("avoid")).toBe(false);
    expect(IDENTIFIER_FIELD_SUFFIX.test("valid")).toBe(false);
  });
});

describe("criteriaKeywords", () => {
  it("excludes generic audience-request vocabulary", () => {
    // "exists" is itself a deliberate stopword (see REQUEST_STOPWORDS) - the
    // distinctive word a real segment name would share is "ecid", not the
    // generic request phrasing around it.
    const words = criteriaKeywords("Please create an audience for this campaign where ECID exists");
    expect(words).not.toContain("please");
    expect(words).not.toContain("create");
    expect(words).not.toContain("audience");
    expect(words).not.toContain("campaign");
    expect(words).not.toContain("exists");
    expect(words).toContain("ecid");
  });

  it("drops words of length <= 3", () => {
    const words = criteriaKeywords("a an the TV internet ECID");
    expect(words).not.toContain("tv");
    expect(words).toContain("internet");
    expect(words).toContain("ecid");
  });

  // THE BUG THIS GUARDS: "upsell" (business_objective vocabulary, shared by
  // countless unrelated audiences) used to survive as a "distinctive" keyword
  // and matched an unrelated real segment, "Michigan TV-Only Internet
  // Upsell", on that word alone.
  it("excludes campaign-motion vocabulary (business_objective/lifecycle_journey options)", () => {
    const words = criteriaKeywords("this is for a upsell use case, a winback play, and it's evergreen");
    expect(words).not.toContain("upsell");
    expect(words).not.toContain("winback");
    expect(words).not.toContain("evergreen");
  });

  it("still keeps genuinely distinctive words like personid", () => {
    const words = criteriaKeywords("create me an audience of people who have a personId, for an upsell use case");
    expect(words).toContain("personid");
    expect(words).not.toContain("upsell");
  });

  it("does not strip audience-defining vocabulary (region/line_of_business options)", () => {
    // Unlike business_objective/lifecycle_journey, region/line_of_business
    // genuinely describe WHO the audience is, so they stay real signal.
    const words = criteriaKeywords("Northeast Residential customers");
    expect(words).toContain("northeast");
    expect(words).toContain("residential");
  });
});

describe("scoreSegmentName", () => {
  it("scores 0 when nothing overlaps", () => {
    expect(scoreSegmentName(["personid", "website"], "Michigan TV-Only Internet Upsell")).toMatchObject({ score: 0, matched: [] });
  });

  it("a single shared generic word scores low ratio against several meaningful terms", () => {
    const { score, ratio } = scoreSegmentName(
      ["personid", "personids", "website", "chaunceys", "upsell"],
      "Michigan TV-Only Internet Upsell",
    );
    expect(score).toBe(1);
    expect(ratio).toBeLessThan(MIN_SEGMENT_MATCH_RATIO);
  });

  it("a single distinctive term matching is a confident (ratio 1) hit", () => {
    const { score, ratio, matched } = scoreSegmentName(["ecid"], "Has ECID");
    expect(score).toBe(1);
    expect(ratio).toBe(1);
    expect(matched).toEqual(["ecid"]);
  });

  it("terms below length 4 never count", () => {
    expect(scoreSegmentName(["tv"], "TV-Only Households").score).toBe(0);
  });
});

describe("findExistingSegment - the reuse confidence gate", () => {
  // THE REGRESSION: reproduces the exact real-run failure - a personId brief
  // must NOT reuse "Michigan TV-Only Internet Upsell" just because both
  // happen to be "Upsell" motion.
  it("does not reuse an unrelated segment on a single generic-word overlap", async () => {
    mcpBehavior.mode = "resolve";
    mcpBehavior.value = [{ id: "1b84f87c-afe3-4ccd-9fb6-82c74919e9b9", name: "Michigan TV-Only Internet Upsell" }];
    const terms = ["people with personids", "personid", "personids", "website", "chaunceys", "upsell"];
    const match = await findExistingSegment("audience_creation", terms);
    expect(match.id).toBeNull();
    expect(match.name).toBeNull();
    expect(match.considered).toBe(1);
  });

  it("still reuses a genuinely matching segment (high-ratio overlap)", async () => {
    mcpBehavior.mode = "resolve";
    mcpBehavior.value = [{ id: "seg-1", name: "Has PersonId" }];
    const match = await findExistingSegment("audience_creation", ["personid"]);
    expect(match.id).toBe("seg-1");
    expect(match.score).toBe(1);
    expect(match.matchedTerms).toEqual(["personid"]);
  });

  it("reports read failures honestly, with the new fields still present", async () => {
    mcpBehavior.mode = "reject";
    mcpBehavior.value = new Error("boom");
    const match = await findExistingSegment("audience_creation", ["personid"]);
    expect(match.read).toBe(false);
    expect(match.score).toBe(0);
    expect(match.matchedTerms).toEqual([]);
  });
});

describe("neededAttributes - the GTO over-triggering regression", () => {
  // THE BUG: customer_type/line_of_business used to be checked for EVERY
  // request regardless of what the brief actually asked for, because they
  // were hardcoded as an always-required baseline. A brief asking only for
  // ECID would get customer_type/line_of_business checked anyway, both
  // would come back "missing" (they're intake-form concepts, not schema
  // field names), and a GTO attribute request opened for fields nothing
  // about the ask required. Verified live this session on a real run: this
  // exact "ECID only" brief opened requests for line_of_business and
  // customer_type before the fix.
  it("an ECID-only ask does not pull in customer_type or line_of_business", () => {
    const fields = {
      campaign_name: "Q4 ECID Push",
      customer_type: "Residential",
      line_of_business: "Xfinity",
      audience_description: "Audience where ECID exists",
    };
    const needed = neededAttributes(fields, undefined);
    expect(needed).toEqual(["identity"]);
    expect(needed).not.toContain("customer_type");
    expect(needed).not.toContain("line_of_business");
  });

  it("an empty brief/description needs nothing, even with intake categorisation fields populated", () => {
    const fields = {
      campaign_name: "Some Campaign",
      customer_type: "Residential",
      line_of_business: "Xfinity",
    };
    expect(neededAttributes(fields, undefined)).toEqual([]);
  });

  it("picks up multiple cues actually present in the brief", () => {
    const needed = neededAttributes(
      {},
      "Households where xfinityTV is true and xfinityInternet is false, in the Northeast region",
    );
    expect(needed.sort()).toEqual(["product_ownership", "region"].sort());
  });

  it("reads from audience_description and exclusion, not just the brief", () => {
    // channels requires the compound "emailAddress"/"email_address" form,
    // deliberately - see ATTRIBUTE_CUES's docstring on why a bare "email"
    // does not trigger it.
    expect(neededAttributes({ audience_description: "customers where emailAddress exists" })).toContain("channels");
    expect(neededAttributes({ exclusion: "exclude anyone missing a region" })).toContain("region");
  });
});

describe("identityGap", () => {
  it("flags account-language briefs", () => {
    const gap = identityGap({ audience_description: "all subscriber households" });
    expect(gap.hasGap).toBe(true);
    expect(gap.details).toMatch(/resolved profiles/);
  });

  it("does not flag a brief with no account language", () => {
    const gap = identityGap({ audience_description: "profiles where xfinityTV is true" });
    expect(gap.hasGap).toBe(false);
    expect(gap.details).toBeNull();
  });
});

describe("decideBuildPath", () => {
  it("routes explicit FAC/federated asks to fac", () => {
    const result = decideBuildPath({ audience_description: "pull this from our data warehouse" }, emptyProbe());
    expect(result.buildPath).toBe("fac");
  });

  it("routes prospects (not in the profile store) to fac", () => {
    const result = decideBuildPath({ audience_description: "target prospects who never subscribed" }, emptyProbe());
    expect(result.buildPath).toBe("fac");
  });

  it("defaults to the rule builder, never fac, when the probe is inconclusive", () => {
    const probe = emptyProbe({ conclusive: false, error: "no profile-like schemas found" });
    const result = decideBuildPath({ audience_description: "audience where ECID exists" }, probe);
    expect(result.buildPath).toBe("aep_rule_builder");
    expect(result.reason).toMatch(/could not be determined/);
  });

  it("stays on the rule builder even when attributes are missing (a GTO request, not a path change)", () => {
    const probe = emptyProbe({ conclusive: true, found: { identity: false } });
    const result = decideBuildPath({ audience_description: "audience where ECID exists" }, probe);
    expect(result.buildPath).toBe("aep_rule_builder");
    expect(result.reason).toMatch(/identity/);
  });

  it("takes the rule builder when everything needed is present", () => {
    const probe = emptyProbe({ conclusive: true, found: { product_ownership: true } });
    const result = decideBuildPath({ audience_description: "households with Internet service" }, probe);
    expect(result.buildPath).toBe("aep_rule_builder");
  });
});

describe("nightlyCutoff", () => {
  it("reports minutes remaining before 21:45", () => {
    const now = new Date();
    now.setHours(20, 0, 0, 0);
    const result = nightlyCutoff(now);
    expect(result.madeIt).toBe(true);
    expect(result.minutesRemaining).toBe(105);
  });

  it("reports the run has already passed after 21:45", () => {
    const now = new Date();
    now.setHours(22, 0, 0, 0);
    const result = nightlyCutoff(now);
    expect(result.madeIt).toBe(false);
    expect(result.minutesRemaining).toBeLessThan(0);
  });
});

describe("segment-estimate removal stays removed", () => {
  it("does not export estimateCount any more (verified broken upstream - see this module's docstring)", async () => {
    const mod = await import("./aep");
    expect((mod as Record<string, unknown>).estimateCount).toBeUndefined();
  });
});
