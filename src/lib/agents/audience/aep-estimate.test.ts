import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Separate file from aep.test.ts on purpose: everything else there tests pure
// functions with no mocking at all, and sizing is one of the few functions in
// aep.ts that calls out over MCP.
const { callMcpTool } = vi.hoisted(() => ({ callMcpTool: vi.fn() }));
vi.mock("@/lib/mcp-client", () => ({ callMcpTool }));

const { estimateSegmentSize, readSegmentSize } = await import("./aep");

const succeeded = (counter: Record<string, number>) => ({
  status: "SUCCEEDED",
  metrics: { segmentedProfileCounter: counter },
});

beforeEach(() => {
  callMcpTool.mockReset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

async function run<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

describe("estimateSegmentSize - a real count from an evaluation job, never a fabricated zero", () => {
  it("returns unavailable without calling anything when there's no segment id yet", async () => {
    const result = await estimateSegmentSize("audience_creation", "");
    expect(result).toEqual({ available: false, reason: "no segment id to estimate yet" });
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it("starts a job for just this segment, in the given sandbox, and reports its count", async () => {
    callMcpTool.mockResolvedValueOnce({ id: "job-1" });
    callMcpTool.mockResolvedValueOnce(succeeded({ "seg-123": 48213 }));
    const result = await run(estimateSegmentSize("audience_creation", "seg-123", "tapdemo"));
    expect(result).toEqual({ available: true, count: 48213 });
    expect(callMcpTool).toHaveBeenNthCalledWith(1, "audience_creation", "adobe_create_segment_job", {
      segment_ids: JSON.stringify(["seg-123"]),
      sandbox: "tapdemo",
    });
    expect(callMcpTool).toHaveBeenNthCalledWith(2, "audience_creation", "adobe_get_segment_job", {
      job_id: "job-1",
      sandbox: "tapdemo",
    });
  });

  it("hands back a pending job for the card to poll when AEP is still counting", async () => {
    callMcpTool.mockResolvedValueOnce({ id: "job-1" });
    callMcpTool.mockResolvedValue({ status: "PROCESSING" });
    const result = await run(estimateSegmentSize("audience_creation", "seg-123", "tapdemo"));
    expect(result).toMatchObject({
      available: false,
      pending: { jobId: "job-1", segmentId: "seg-123", sandbox: "tapdemo" },
    });
  });

  it("reports a failure to start the job as unavailable, not an error", async () => {
    callMcpTool.mockRejectedValueOnce(new Error("HTTP 500"));
    const result = await estimateSegmentSize("audience_creation", "seg-123");
    expect(result).toMatchObject({ available: false });
    expect((result as { reason: string }).reason).toContain("HTTP 500");
  });

  it("explains an org that only allows scheduled evaluation, without AEP's raw 400", async () => {
    callMcpTool.mockRejectedValueOnce(
      new Error("400: Validation failed: Non-scheduled segment jobs are not allowed for orgs enabled for B2B simplification."),
    );
    const result = await estimateSegmentSize("audience_creation", "seg-123", "tapdemo");
    expect(result).toEqual({
      available: false,
      reason: expect.stringMatching(/scheduled evaluation/),
    });
    expect((result as { reason: string }).reason).not.toContain("400");
  });
});

describe("readSegmentSize", () => {
  it("a zero is reported only when the job itself counted zero", async () => {
    callMcpTool.mockResolvedValueOnce(succeeded({ "seg-123": 0 }));
    expect(await readSegmentSize("audience_creation", "job-1", "seg-123")).toEqual({ available: true, count: 0 });
  });

  it("a finished job with no count for this segment is unavailable, not zero", async () => {
    callMcpTool.mockResolvedValueOnce(succeeded({ other: 5 }));
    expect((await readSegmentSize("audience_creation", "job-1", "seg-123")).available).toBe(false);
  });

  it("a failed job says so", async () => {
    callMcpTool.mockResolvedValueOnce({ status: "FAILED", errors: [{ message: "bad" }] });
    const r = await readSegmentSize("audience_creation", "job-1", "seg-123");
    expect(r).toMatchObject({ available: false });
    expect((r as { reason: string }).reason).toContain("failed");
  });
});
