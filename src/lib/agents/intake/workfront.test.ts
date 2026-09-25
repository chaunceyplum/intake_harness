import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
const callMcpToolMock = vi.fn();
vi.mock("@/lib/db", () => ({ query: (...args: unknown[]) => queryMock(...args) }));
vi.mock("@/lib/mcp-client", () => ({ callMcpTool: (...args: unknown[]) => callMcpToolMock(...args) }));
// resolveFieldMap does its own MCP calls this test doesn't care about - fail
// it fast and predictably so createIntakeRequest reaches the point THIS
// test actually asserts on (whether it attempted a real create at all)
// without needing to mock the whole field-discovery flow.
vi.mock("@/lib/agents/intake/workfront-fields", () => ({
  resolveFieldMap: vi.fn(async () => ({ map: {}, verified: false, source: "test stub" })),
  applyFieldMap: vi.fn(() => ({ customFields: {}, dropped: [] })),
}));

const { createIntakeRequest, demoIntakeOutcome } = await import("./workfront");

beforeEach(() => {
  queryMock.mockReset();
  callMcpToolMock.mockReset();
});

describe("createIntakeRequest's idempotency check", () => {
  it("reuses a prior successful create for this run, WITHOUT calling any write tool again", async () => {
    const priorOutcome = {
      created: true,
      objCode: "OPTASK",
      objId: "6aad806f00079cbaa8101e3f69e574ea",
      customFieldsSet: true,
      customFieldsError: null,
      customFieldsWritten: ["DE:Campaign name"],
      customFieldsRejected: [],
      fieldNames: { verified: true, source: "read from the form", dropped: [] },
    };
    queryMock.mockResolvedValue([{ output: { workfront: priorOutcome } }]);

    const result = await createIntakeRequest({ runId: "run-1", intake: { campaign_name: "Test" }, brief: "Test brief" });

    expect(result).toEqual({ ...priorOutcome, reused: true });
    // The whole point: no MCP call was made at all - not even a read - because
    // the prior success short-circuits before any of that runs.
    expect(callMcpToolMock).not.toHaveBeenCalled();
  });

  it("queries for exactly this run's own prior completed intake task_run, not any other run's", async () => {
    queryMock.mockResolvedValue([]);
    await createIntakeRequest({ runId: "run-specific-id", intake: {}, brief: "x" }).catch(() => {});
    // Now routed through idempotent-write.ts's shared findPriorTaskRun -
    // parameterized rather than the run_id being inlined into the SQL text.
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("task_runs"), ["run-specific-id", "intake", ["completed"]]);
  });

  it("proceeds to a real create attempt when no prior success is found", async () => {
    queryMock.mockResolvedValue([]); // no prior row
    callMcpToolMock.mockRejectedValue(new Error("Tool insights_find_id_by_name not found")); // whatever happens next, happens for real

    const result = await createIntakeRequest({ runId: "run-2", intake: { campaign_name: "Test" }, brief: "Test brief" });

    // Did NOT short-circuit to a reused result - it genuinely attempted the
    // real path (which in this test fails, honestly, same as the live gateway
    // issue this session found - the assertion is about ATTEMPTING, not succeeding).
    expect(result.created).toBe(false);
    if (!result.created) expect(result.reason).toBeTruthy();
  });

  it("fails OPEN: a broken idempotency check itself does not block a legitimate create", async () => {
    queryMock.mockRejectedValue(new Error("connection reset"));
    callMcpToolMock.mockRejectedValue(new Error("Tool insights_find_id_by_name not found"));

    // Must not throw - the check swallows its own failure and lets the real
    // create path run exactly as if no prior attempt existed.
    const result = await createIntakeRequest({ runId: "run-3", intake: {}, brief: "x" });
    expect(result.created).toBe(false);
  });
});

describe("demoIntakeOutcome - Demo mode's dry-run, with zero Workfront calls", () => {
  it("never calls the MCP client, not even a read", () => {
    demoIntakeOutcome({ campaign_name: "Test" }, "Test brief");
    expect(callMcpToolMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("reports created:false, with the payload it would have sent, and says why", () => {
    const result = demoIntakeOutcome({ campaign_name: "Fall Save" }, "Test brief");
    expect(result.created).toBe(false);
    if (!result.created) {
      expect(result.reason).toMatch(/Demo mode/);
      expect(result.wouldHaveCreated.fields.name).toBe("Fall Save");
    }
  });
});
