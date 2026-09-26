import { describe, it, expect } from "vitest";
import { describeAudience } from "./audience-card";

describe("describeAudience", () => {
  it("renders nothing for an older run with no sizeEstimate", () => {
    expect(describeAudience({ statusMessage: "x" }, {})).toBeNull();
  });

  it("Demo run that created its audience: name, meaning, rule and a real count", () => {
    const view = describeAudience(
      {
        label: "Demo – not approved",
        sizeEstimate: { available: true, count: 12345 },
        audience: {
          segmentId: "abcdef1234",
          name: "Demo: CBM members · 4f2a91c0",
          source: "created",
          pql: '_taplondonptrsd.isCBMmember = "Y"',
          interpretation: "Profiles whose Is CBM member flag is Y.",
        },
      },
      {},
    );
    expect(view).toEqual({
      label: "Demo – not approved",
      segment: { id: "abcdef1234", name: "Demo: CBM members · 4f2a91c0", source: "created" },
      interpretation: "Profiles whose Is CBM member flag is Y.",
      rule: '_taplondonptrsd.isCBMmember = "Y"',
      size: { kind: "count", text: `${(12345).toLocaleString()} profiles` },
      pending: null,
    });
  });

  it("a size still being counted carries the job for the card to poll - never a zero", () => {
    const pending = { jobId: "job-1", segmentId: "abcdef1234", sandbox: "tapdemo" };
    const view = describeAudience(
      {
        sizeEstimate: { available: false, reason: "AEP is counting this audience now", pending },
        audience: { segmentId: "abcdef1234", name: "A", source: "created", pql: "x" },
      },
      {},
    );
    expect(view?.pending).toEqual(pending);
    expect(view?.size.kind).toBe("unavailable");
  });

  it("a new run with no audience shows none, even if metadata names a similar segment", () => {
    const view = describeAudience(
      { sizeEstimate: { available: false, reason: "no audience was created" }, audience: null },
      { similarSegment: { id: "seg-9", name: "CB SEP-Eligible Business Prospects UKS" } },
    );
    expect(view?.segment).toBeNull();
  });

  it("an older run (no output.audience) still reads its created segment from metadata", () => {
    const view = describeAudience(
      { label: null, sizeEstimate: { available: false, reason: "estimate tool returned 404" } },
      { segmentCreation: { attempted: true, created: true, segmentId: "seg-1", name: "Old" } },
    );
    expect(view?.segment).toEqual({ id: "seg-1", name: "Old", source: "created" });
  });
});
