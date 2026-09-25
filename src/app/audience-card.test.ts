import { describe, it, expect } from "vitest";
import { describeAudience } from "./audience-card";

describe("describeAudience", () => {
  it("renders nothing for an older run with no sizeEstimate", () => {
    expect(describeAudience({ statusMessage: "x" }, {})).toBeNull();
  });

  it("Demo run with a fresh segment and a real count", () => {
    const view = describeAudience(
      { label: "Demo – not approved", sizeEstimate: { available: true, count: 12345 } },
      { segmentCreation: { attempted: true, created: true, segmentId: "abcdef1234", name: "Fall Video Attach" } },
    );
    expect(view).toEqual({
      label: "Demo – not approved",
      segment: { id: "abcdef1234", name: "Fall Video Attach", source: "created" },
      size: { kind: "count", text: `${(12345).toLocaleString()} profiles (estimated)` },
    });
  });

  it("Governed run reusing an existing segment, estimate unavailable - never a fabricated zero", () => {
    const view = describeAudience(
      { label: null, sizeEstimate: { available: false, reason: "estimate tool returned 404" } },
      { segmentCreation: null, existingSegment: { id: "seg-1", name: "Existing" } },
    );
    expect(view?.label).toBeNull();
    expect(view?.segment).toEqual({ id: "seg-1", name: "Existing", source: "existing" });
    expect(view?.size).toEqual({
      kind: "unavailable",
      text: "Size available after next evaluation (estimate tool returned 404)",
    });
  });

  it("a dry-run create is not shown as a segment", () => {
    const view = describeAudience(
      { sizeEstimate: { available: false, reason: "no segment id to estimate yet" } },
      { segmentCreation: { attempted: true, created: false }, existingSegment: null },
    );
    expect(view?.segment).toBeNull();
  });
});
