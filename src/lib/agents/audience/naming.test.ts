import { describe, it, expect } from "vitest";
import { audienceTitle, parseStructuredName, structuredName, uniqueStructuredName } from "./naming";

const SEP_2026 = new Date("2026-09-27T12:00:00Z");

describe("audience naming - CB | <who> | <Mon YYYY>", () => {
  it("builds the structured name with no random suffix", () => {
    expect(structuredName("SEP Eligible Without SEP", SEP_2026)).toBe("CB | SEP Eligible Without SEP | Sep 2026");
  });

  it("cleans the model's title of what the structure already says", () => {
    expect(audienceTitle("Demo: CB - SEP Upsell 2026 · 53e13700", "x")).toBe("SEP Upsell");
    expect(audienceTitle("", "Businesses eligible for SEP")).toBe("Businesses eligible for SEP");
    expect(audienceTitle(null, "")).toBe("Custom Audience");
  });

  it("keeps a long title to whole words", () => {
    const t = audienceTitle("SEP Eligible CB Internet Customers Not On Mobile With Valid Email Not DNC", "x");
    expect(t.length).toBeLessThanOrEqual(48);
    expect(t.endsWith(" ")).toBe(false);
  });

  it("numbers the title, not the date, when a different audience has the name", () => {
    const taken = ["CB | SEP Upsell | Sep 2026", "cb | sep upsell (2) | sep 2026"];
    expect(uniqueStructuredName("SEP Upsell", taken, SEP_2026)).toBe("CB | SEP Upsell (3) | Sep 2026");
    expect(uniqueStructuredName("New One", taken, SEP_2026)).toBe("CB | New One | Sep 2026");
  });

  it("parses a structured name for display, and ignores older names", () => {
    expect(parseStructuredName("CB | SEP Upsell (2) | Sep 2026")).toEqual({ prefix: "CB", title: "SEP Upsell (2)", period: "Sep 2026" });
    expect(parseStructuredName("Demo: Email + SEP Eligible · 53e13700")).toBeNull();
  });
});
