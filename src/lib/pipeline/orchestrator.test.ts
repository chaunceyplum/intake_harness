import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RunRow } from "./types";

/**
 * advanceOneStep talks to two outside systems: Postgres (via "@/lib/db"'s
 * `query`) and each agent's own route (via `fetch`). Both are faked here so
 * this exercises the orchestrator's own control flow - specifically the
 * approval-gate chaining added this session (registry.ts's
 * `requiresApproval: false` on Audience Creation) - without a real database
 * or a running Next.js server. No real MCP/DB credentials are used or
 * needed for this file.
 */

const queryMock = vi.fn();
const callMcpToolMock = vi.fn();
// withAdvisoryLock is a real passthrough here - these tests run sequentially,
// single-connection, so there's no concurrent caller for it to serialize
// against. See db.ts for what it actually does against a real Postgres pool.
vi.mock("@/lib/db", () => ({
  query: (...args: unknown[]) => queryMock(...args),
  withAdvisoryLock: async <T>(_key: string, fn: () => Promise<T>) => fn(),
}));
vi.mock("@/lib/mcp-client", () => ({ callMcpTool: (...args: unknown[]) => callMcpToolMock(...args) }));

const { runPipeline, continueRun } = await import("./orchestrator");

function baseRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    run_id: "test-run-1",
    status: "running",
    current_step: 0,
    input: { brief: "test brief" },
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
    programme_id: null,
    tags: [],
    approved: false,
    approved_by: null,
    approved_at: null,
    approval_note: null,
    promoted: false,
    promoted_by: null,
    promoted_at: null,
    ...overrides,
  };
}

/** Routes every `query()` call by matching on SQL text, the way the real driver would by executing it. */
function installDbMock(run: RunRow) {
  queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("INSERT INTO runs")) {
      return [{ ...run, status: "running", current_step: 0 }];
    }
    if (sql.includes("SELECT * FROM runs WHERE run_id")) {
      return [run];
    }
    if (sql.includes("SELECT * FROM task_runs WHERE run_id")) {
      return []; // no prior completed task_runs needed for these tests
    }
    if (sql.includes("SELECT status, output, metadata FROM task_runs")) {
      return []; // advanceOneStep's own-step idempotency check (idempotent-write.ts) - no prior attempt
    }
    if (sql.includes("INSERT INTO task_runs")) {
      return [];
    }
    if (sql.includes("UPDATE runs SET status = 'running'")) {
      return [{ ...run, status: "running" }];
    }
    if (sql.includes("UPDATE runs SET status = $2")) {
      return [{ ...run, status: params[1], current_step: params[2] }];
    }
    throw new Error(`orchestrator.test.ts: unexpected SQL: ${sql}`);
  });
}

function installFetchMock(responses: Record<string, unknown>) {
  const fetchMock = vi.fn(async (url: URL | string) => {
    const path = url.toString();
    for (const [match, body] of Object.entries(responses)) {
      if (path.includes(match)) {
        return { ok: true, json: async () => body, text: async () => JSON.stringify(body) } as Response;
      }
    }
    throw new Error(`orchestrator.test.ts: unexpected fetch to ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  queryMock.mockReset();
  callMcpToolMock.mockReset();
  vi.unstubAllGlobals();
});

describe("the per-step Workfront-comment idempotency guard (idempotent-write.ts)", () => {
  it("does not post a second comment when a prior attempt at this exact step already posted one", async () => {
    const run = baseRun({ status: "running", current_step: 0 });
    installDbMock(run);
    // Override the guard's own query: a prior task_run at this (run_id,
    // task_id, step_index) already exists with the SAME status and a
    // recorded, successfully-posted comment.
    queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("SELECT status, output, metadata FROM task_runs")) {
        return [
          {
            status: "completed",
            output: null,
            metadata: {
              workfrontUpdate: {
                attempted: true,
                posted: true,
                objId: "obj-1",
                objCode: "OPTASK",
                text: "Intake — completed\n\nDone.",
              },
            },
          },
        ];
      }
      if (sql.includes("INSERT INTO runs")) return [{ ...run, status: "running", current_step: 0 }];
      if (sql.includes("SELECT * FROM runs WHERE run_id")) return [run];
      if (sql.includes("SELECT * FROM task_runs WHERE run_id")) return [];
      if (sql.includes("INSERT INTO task_runs")) return [];
      if (sql.includes("UPDATE runs SET status = 'running'")) return [{ ...run, status: "running" }];
      if (sql.includes("UPDATE runs SET status = $2")) return [{ ...run, status: params[1], current_step: params[2] }];
      throw new Error(`unexpected SQL: ${sql}`);
    });
    installFetchMock({
      // A real workfront target on the output, so postAgentUpdate would
      // otherwise have something to post to - this is what makes the guard's
      // skip observable rather than vacuous (no target -> never posts either way).
      "/api/agents/intake": { status: "completed", output: { workfront: { objId: "obj-1", objCode: "OPTASK" } } },
    });

    await runPipeline({ brief: "test" }, "http://localhost:3100");

    // The whole point: no MCP call was made - not even a read - because the
    // prior row's already-posted comment short-circuits before any of that runs.
    expect(callMcpToolMock).not.toHaveBeenCalled();
  });
});

describe("the approval gate - Review to Audience Creation", () => {
  it("chains straight into Audience Creation when Review completes (no gate - requiresApproval: false)", async () => {
    const run = baseRun({ status: "awaiting_approval", current_step: 1 });
    installDbMock(run);
    installFetchMock({
      "/api/agents/review": { status: "completed", output: { reviewed: true } },
      "/api/agents/audience-creation": { status: "completed", output: { audience: true } },
    });

    const result = await continueRun(run.run_id, "http://localhost:3100");

    // Landed past BOTH review and audience_creation in one call - no
    // "awaiting_approval" stop in between, and current_step is 3 (past the
    // last pipeline index), not 2 (which would mean it stopped before
    // Audience Creation ran).
    expect(result.status).toBe("completed");
    expect(result.current_step).toBe(3);
  });

  it("still surfaces Audience Creation's own needs_input (its GTO gate is untouched by the approval-gate removal)", async () => {
    const run = baseRun({ status: "awaiting_approval", current_step: 1 });
    installDbMock(run);
    installFetchMock({
      "/api/agents/review": { status: "completed", output: { reviewed: true } },
      "/api/agents/audience-creation": { status: "needs_input", message: "Opened attribute request" },
    });

    const result = await continueRun(run.run_id, "http://localhost:3100");

    expect(result.status).toBe("needs_input");
    expect(result.current_step).toBe(2); // stayed AT audience_creation's own step, did not advance past it
  });
});

describe("the approval gate - Intake to Review (unchanged)", () => {
  it("stops at awaiting_approval before Review runs - review still requires approval", async () => {
    const run = baseRun({ status: "running", current_step: 0 });
    installDbMock(run);
    const fetchMock = installFetchMock({
      "/api/agents/intake": { status: "completed", output: { intake: true } },
    });

    const result = await runPipeline({ brief: "test" }, "http://localhost:3100");

    expect(result.status).toBe("awaiting_approval");
    expect(result.current_step).toBe(1);
    // Only intake's route was ever called - review never ran without a click.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
