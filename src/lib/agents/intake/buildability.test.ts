import { describe, it, expect, vi, beforeEach } from "vitest";

const callMcpToolMock = vi.fn();
vi.mock("@/lib/mcp-client", () => ({ callMcpTool: (...args: unknown[]) => callMcpToolMock(...args) }));

const { findUnmappableFilter } = await import("./buildability");

beforeEach(() => {
  callMcpToolMock.mockReset();
});

describe("findUnmappableFilter - Intake's only remaining reason to pause", () => {
  it("returns null and calls nothing when the brief names no checkable attribute at all", async () => {
    const result = await findUnmappableFilter({}, "Build an audience of customers interested in our rewards program.", "intake");
    expect(result).toBeNull();
    expect(callMcpToolMock).not.toHaveBeenCalled();
  });

  it("returns null (buildable) when the schema probe conclusively finds the field", async () => {
    // A brief that references product ownership (aep.ts's ATTRIBUTE_CUES),
    // and a union schema that actually has a matching field name.
    callMcpToolMock.mockResolvedValueOnce({
      $id: "https://ns.adobe.com/tapdemo/schemas/union",
      title: "Union",
      properties: { xfinityInternet: { type: "boolean" } },
    });
    const result = await findUnmappableFilter(
      {},
      "Internet-only households without TV.",
      "intake",
    );
    expect(result).toBeNull();
  });

  it("names the one specific filter when the probe conclusively finds nothing for it", async () => {
    // Union schema resolves (so the probe is conclusive) but has no field
    // that matches the "identity" cue (ECID/MCID/etc).
    callMcpToolMock.mockResolvedValueOnce({
      $id: "https://ns.adobe.com/tapdemo/schemas/union",
      title: "Union",
      properties: { someUnrelatedField: { type: "string" } },
    });
    const result = await findUnmappableFilter(
      {},
      "Audience where ECID exists.",
      "intake",
    );
    expect(result).not.toBeNull();
    expect(result?.key).toBe("identity");
    expect(result?.ask).toMatch(/identity attribute/);
    // Exactly one question - never a batch of them.
    expect(result).not.toBeNull();
  });

  it("does not block on an INCONCLUSIVE probe - unknown is not missing", async () => {
    callMcpToolMock.mockRejectedValueOnce(new Error("union schema unavailable"));
    callMcpToolMock.mockRejectedValueOnce(new Error("could not list schemas either"));
    const result = await findUnmappableFilter({}, "Audience where ECID exists.", "intake");
    expect(result).toBeNull();
  });

  it("passes the sandbox override through to the probe when given (Demo mode)", async () => {
    callMcpToolMock.mockResolvedValueOnce({
      $id: "https://ns.adobe.com/tapdemo/schemas/union",
      title: "Union",
      properties: { xfinityInternet: { type: "boolean" } },
    });
    await findUnmappableFilter({}, "Internet-only households.", "intake", "tapdemo");
    expect(callMcpToolMock).toHaveBeenCalledWith(
      "intake",
      "adobe_get_union_schema",
      expect.objectContaining({ sandbox: "tapdemo" }),
    );
  });
});
