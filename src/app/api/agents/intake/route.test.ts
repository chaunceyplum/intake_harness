import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { callMcpTool } = vi.hoisted(() => ({ callMcpTool: vi.fn() }));
vi.mock("@/lib/mcp-client", () => ({
  callMcpTool,
  // withToolCallLog just runs fn and hands back an empty trace - this suite
  // doesn't assert on the trace shape, only on which tools were called.
  withToolCallLog: async <T>(_runId: string, _taskId: string, fn: () => Promise<T>) => ({
    result: await fn(),
    toolCalls: [],
  }),
}));

// findPriorTaskRun (idempotent-write.ts) reads through @/lib/db - mock it so
// createIntakeRequest's idempotency check has a deterministic "no prior row"
// answer instead of depending on a real DATABASE_URL in the test env.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@/lib/db", () => ({ query: queryMock }));

// resolveFieldMap does its own MCP reads this suite doesn't care about - same
// stub workfront.test.ts uses, so Governed-mode's create path reaches the
// point these tests actually assert on without modelling field discovery.
vi.mock("@/lib/agents/intake/workfront-fields", () => ({
  resolveFieldMap: vi.fn(async () => ({ map: {}, verified: false, source: "test stub" })),
  applyFieldMap: vi.fn(() => ({ customFields: {}, dropped: [] })),
}));

const { POST } = await import("./route");

function postRequest(input: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/agents/intake", {
    method: "POST",
    body: JSON.stringify({ runId: "run-1", input, priorOutputs: {} }),
  });
}

const WORKFRONT_TOOL_PATTERN = /^(workflow_|comment-stream_|insights_|wf_core_|wf_comments_)/i;

beforeEach(() => {
  callMcpTool.mockReset();
  queryMock.mockReset();
  queryMock.mockResolvedValue([]); // "no prior task_run" for every idempotency check
});

describe("brief-only submission - never asks about the old optional fields", () => {
  it("a brief naming none of the checkable attributes proceeds straight to completed", async () => {
    const res = await POST(
      postRequest({ brief: "Build an audience of customers interested in our new rewards program." }),
    );
    const body = await res.json();
    expect(body.status).toBe("completed");
    expect(body.output.questions).toBeUndefined();
    // None of the old baseline fields were asked about, because nothing asks
    // about them any more.
    expect(body.message).not.toMatch(/campaign name|business objective|launch date/i);
  });
});

describe("unmappable filter - pauses with exactly one specific question", () => {
  it("names the one filter with no matching AEP field, asks a single question, and nothing else", async () => {
    // Union schema resolves (conclusive) but has no field matching the
    // "identity" cue (ECID/MCID/etc) - the exact shape buildability.test.ts
    // exercises directly, here through the full route.
    callMcpTool.mockResolvedValueOnce({
      $id: "https://ns.adobe.com/tapdemo/schemas/union",
      title: "Union",
      properties: { someUnrelatedField: { type: "string" } },
    });
    callMcpTool.mockResolvedValue({}); // grounding + anything else, don't-care

    const res = await POST(postRequest({ brief: "Audience where ECID exists." }));
    const body = await res.json();

    expect(body.status).toBe("needs_input");
    expect(body.output.questions).toHaveLength(1);
    expect(body.output.questions[0].key).toBe("filter:identity");
    expect(body.message).toMatch(/identity attribute/);
  });

  it("does not ask again once the marketer answered it, and hands the answer on", async () => {
    // Same brief, same schema with no matching field - but this round
    // arrives carrying the answer to last round's question. It used to be
    // asked again every round until the loop limit.
    callMcpTool.mockResolvedValue({
      $id: "https://ns.adobe.com/tapdemo/schemas/union",
      title: "Union",
      properties: { someUnrelatedField: { type: "string" } },
    });

    const res = await POST(
      postRequest({
        brief: "Audience where ECID exists.",
        mode: "demo",
        loopCount: 1,
        fields: { "filter:identity": "drop that condition" },
      }),
    );
    const body = await res.json();

    expect(body.status).toBe("completed");
    expect(body.output.filterAnswers).toEqual({ identity: "drop that condition" });
  });
});

describe("Demo mode - zero Workfront tool calls", () => {
  it("still runs the AEP buildability probe, but never calls a Workfront tool, and never files a request", async () => {
    // A brief that DOES trigger an AEP check (product ownership), with a
    // union schema that resolves the field, so the run completes rather
    // than pausing - proving AEP calls happen while Workfront calls don't.
    callMcpTool.mockResolvedValue({
      $id: "https://ns.adobe.com/tapdemo/schemas/union",
      title: "Union",
      properties: { xfinityInternet: { type: "boolean" } },
    });

    const res = await POST(postRequest({ brief: "Internet-only households without TV.", mode: "demo" }));
    const body = await res.json();

    expect(body.status).toBe("completed");
    expect(body.output.mode).toBe("demo");
    expect(body.output.label).toBe("Demo – not approved");
    expect(body.output.workfront.created).toBe(false);
    expect(body.output.workfront.reason).toMatch(/Demo mode/);

    // AEP calls did happen...
    expect(callMcpTool).toHaveBeenCalledWith("intake", "adobe_get_union_schema", expect.anything());
    // ...but not one call targeted a Workfront tool.
    for (const call of callMcpTool.mock.calls) {
      const toolName = call[1] as string;
      expect(toolName).not.toMatch(WORKFRONT_TOOL_PATTERN);
    }
  });

  it("passes sandbox: tapdemo through to the AEP probe", async () => {
    callMcpTool.mockResolvedValue({
      $id: "https://ns.adobe.com/tapdemo/schemas/union",
      title: "Union",
      properties: { xfinityInternet: { type: "boolean" } },
    });
    await POST(postRequest({ brief: "Internet-only households.", mode: "demo" }));
    expect(callMcpTool).toHaveBeenCalledWith(
      "intake",
      "adobe_get_union_schema",
      expect.objectContaining({ sandbox: "tapdemo" }),
    );
  });
});

describe("Governed mode - still requires a real Workfront outcome, no shortcut", () => {
  it("when the Workfront create call fails, the run reports created:false honestly - never a shortcut success", async () => {
    callMcpTool.mockRejectedValue(new Error("Tool workflow_create_any_object not found"));

    const res = await POST(
      postRequest({ brief: "Build an audience of customers interested in our new rewards program." }),
    );
    const body = await res.json();

    expect(body.status).toBe("completed");
    expect(body.output.mode).toBe("governed");
    expect(body.output.label).toBeNull();
    expect(body.output.workfront.created).toBe(false);
    expect(body.metadata.workfrontCreated).toBe(false);
    // Never claims a create that didn't happen.
    expect(body.message).not.toMatch(/Created the Workfront intake request/);
  });

  it("mode defaults to governed when omitted - existing callers keep today's behavior unchanged", async () => {
    callMcpTool.mockResolvedValue({});
    const res = await POST(postRequest({ brief: "Build an audience of customers interested in rewards." }));
    const body = await res.json();
    expect(body.output.mode).toBe("governed");
  });
});
