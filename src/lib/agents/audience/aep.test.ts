import { describe, it, expect } from "vitest";
import { ATTRIBUTE_CUES, criteriaKeywords, neededAttributes, identityGap, decideBuildPath, nightlyCutoff, type SchemaProbe } from "./aep";

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

  it("channels cue reads \"email address\" in prose and this tenant's customerEmail/personalEmail fields", () => {
    expect(neededAttributes({}, "profiles with an email address and are SEP eligible")).toContain("channels");
    expect(ATTRIBUTE_CUES.channels.test("customerEmail")).toBe(true);
    expect(ATTRIBUTE_CUES.channels.test("personalEmail")).toBe(true);
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
