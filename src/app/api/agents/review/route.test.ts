import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/mcp-client", () => ({
  callMcpTool: vi.fn(async () => {
    throw new Error("no MCP in tests");
  }),
  withToolCallLog: vi.fn(async (_runId: string, _task: string, fn: () => Promise<unknown>) => ({
    result: await fn(),
    toolCalls: [],
  })),
}));
vi.mock("@/lib/agents/review/aep-context", () => ({
  gatherAepContext: vi.fn(async () => ({
    neededAttributes: [],
    schemaProbe: { read: false, conclusive: false, error: null, schemaCount: 0, found: {}, evidence: [] },
    segmentMatch: { id: null, name: null },
    datasetProbe: { profileEnabled: [] },
    pqlGuidance: { grounded: false, hits: [] },
  })),
  formatAepContextNote: vi.fn(() => "AEP note."),
}));

const { POST } = await import("./route");

async function review(input: Record<string, unknown>) {
  const req = new NextRequest("http://localhost/api/agents/review", {
    method: "POST",
    body: JSON.stringify({ runId: "run-1", input }),
  });
  return (await POST(req)).json();
}

describe("Review never overwrites the run's mode", () => {
  it("a clean Demo brief reaches Audience Creation still in Demo mode", async () => {
    const body = await review({
      brief: "b",
      mode: "demo",
      fields: { audience_description: "profiles with an email address" },
    });
    expect(body.status).toBe("completed");
    expect(body.output.mode).toBe("demo");
    expect(body.output.reviewMode).toBe("preflight");
  });
});
