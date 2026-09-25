import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { queryMock, resumeRunMock } = vi.hoisted(() => ({ queryMock: vi.fn(), resumeRunMock: vi.fn() }));
vi.mock("@/lib/db", () => ({ query: queryMock }));
vi.mock("@/lib/pipeline/orchestrator", () => ({ resumeRun: resumeRunMock }));
// No LLM in tests - enrichment contributes nothing, so the merge is the literal one.
vi.mock("@/lib/agents/intake/llm-extract", () => ({ extractFromAnswer: vi.fn(async () => ({ known: {} })) }));

const { POST } = await import("./route");

function pausedWith(output: Record<string, unknown>) {
  queryMock.mockResolvedValue([{ task_run_id: 1, status: "needs_input", output }]);
}

async function resume(answers: Record<string, string>) {
  const req = new NextRequest("http://localhost/api/runs/run-1/resume", {
    method: "POST",
    body: JSON.stringify({ answers }),
  });
  return POST(req, { params: Promise.resolve({ runId: "run-1" }) });
}

const question = { key: "tenure", label: "Tenure" };

beforeEach(() => {
  queryMock.mockReset();
  resumeRunMock.mockReset();
  resumeRunMock.mockResolvedValue({ run_id: "run-1", status: "running" });
});

describe("resume carries the run's mode forward", () => {
  it("a paused Demo run resumes in Demo mode, never as Governed", async () => {
    pausedWith({ brief: "b", loopCount: 1, fields: {}, mode: "demo", questions: [question] });
    const res = await resume({ tenure: "2 years" });
    expect(res.status).toBe(200);
    expect(resumeRunMock.mock.calls[0][1]).toEqual({
      brief: "b",
      loopCount: 1,
      fields: { tenure: "2 years" },
      mode: "demo",
    });
  });

  it("a paused Governed run resumes without a mode, keeping Intake's governed default", async () => {
    pausedWith({ brief: "b", loopCount: 1, fields: {}, mode: "governed", questions: [question] });
    await resume({ tenure: "2 years" });
    expect(resumeRunMock.mock.calls[0][1]).not.toHaveProperty("mode");
  });
});
