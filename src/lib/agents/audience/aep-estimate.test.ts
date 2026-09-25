import { describe, it, expect, vi, beforeEach } from "vitest";

// Separate file from aep.test.ts on purpose: everything else there tests pure
// functions with no mocking at all, and estimateSegmentSize is the one
// function in aep.ts that calls out over MCP.
const { callMcpTool } = vi.hoisted(() => ({ callMcpTool: vi.fn() }));
vi.mock("@/lib/mcp-client", () => ({ callMcpTool }));

const { estimateSegmentSize } = await import("./aep");

beforeEach(() => {
  callMcpTool.mockReset();
});

describe("estimateSegmentSize - re-added on explicit product direction, every failure caught", () => {
  it("returns unavailable without calling anything when there's no segment id yet", async () => {
    const result = await estimateSegmentSize("audience_creation", "");
    expect(result).toEqual({ available: false, reason: "no segment id to estimate yet" });
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it("catches the known 404 (or any failure) and reports unavailable, never an error and never a zero", async () => {
    callMcpTool.mockRejectedValueOnce(new Error("HTTP 404 (Not Found)"));
    const result = await estimateSegmentSize("audience_creation", "seg-123");
    expect(result).toEqual({ available: false, reason: "HTTP 404 (Not Found)" });
  });

  it("reports a real count when the tool succeeds - ready the moment the gateway bug is fixed", async () => {
    callMcpTool.mockResolvedValueOnce({}); // create call
    callMcpTool.mockResolvedValueOnce({ count: 48213 }); // get call
    const result = await estimateSegmentSize("audience_creation", "seg-123");
    expect(result).toEqual({ available: true, count: 48213 });
  });

  it("treats a response with no usable count as unavailable, not zero", async () => {
    callMcpTool.mockResolvedValueOnce({});
    callMcpTool.mockResolvedValueOnce({});
    const result = await estimateSegmentSize("audience_creation", "seg-123");
    expect(result.available).toBe(false);
  });

  it("passes the sandbox override through to both calls when given", async () => {
    callMcpTool.mockResolvedValueOnce({});
    callMcpTool.mockResolvedValueOnce({ count: 100 });
    await estimateSegmentSize("audience_creation", "seg-123", "tapdemo");
    expect(callMcpTool).toHaveBeenNthCalledWith(
      1,
      "audience_creation",
      "adobe_create_segment_estimate",
      expect.objectContaining({ segment_id: "seg-123", sandbox: "tapdemo" }),
    );
    expect(callMcpTool).toHaveBeenNthCalledWith(
      2,
      "audience_creation",
      "adobe_get_segment_estimate",
      expect.objectContaining({ segment_id: "seg-123", sandbox: "tapdemo" }),
    );
  });
});
