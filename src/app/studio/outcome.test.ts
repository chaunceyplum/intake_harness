import { describe, it, expect } from "vitest";
import { currentStage, displayName, friendlySize, outcomeOf, plainReason, type RunDetail } from "./outcome";
import type { RunRow, TaskRunRow } from "@/lib/pipeline/types";

function run(status: RunRow["status"], extra: Partial<RunRow> = {}): RunRow {
  return {
    run_id: "r1", status, current_step: 2, input: { brief: "b" }, created_at: "", updated_at: "",
    programme_id: null, tags: [], approved: false, approved_by: null, approved_at: null, approval_note: null,
    promoted: false, promoted_by: null, promoted_at: null, ...extra,
  };
}

function step(task_id: TaskRunRow["task_id"], status: TaskRunRow["status"], output: unknown = {}, metadata: Record<string, unknown> = {}): TaskRunRow {
  return {
    task_run_id: Math.random(), run_id: "r1", task_id, step_index: 0, status, input: {}, output, message: null, metadata,
    tokens_used: null, model: null, started_at: "", finished_at: "2026-09-26T15:00:00Z", duration_ms: 1, created_at: "",
  };
}

const detail = (r: RunRow, taskRuns: TaskRunRow[]): RunDetail => ({ run: r, taskRuns });

describe("currentStage", () => {
  it("starts at understanding, follows the live agent, and never goes backwards", () => {
    expect(currentStage([], null)).toBe(0);
    expect(currentStage([], "review")).toBe(1);
    expect(currentStage([step("intake", "completed"), step("review", "completed")], "intake")).toBe(2);
  });
});

describe("displayName", () => {
  it("drops the Demo prefix and the run suffix AEP needs", () => {
    expect(displayName("Demo: Email + SEP Eligible · 53e13700")).toBe("Email + SEP Eligible");
    expect(displayName("CB Prospects")).toBe("CB Prospects");
  });
});

describe("friendlySize", () => {
  it("shows a real count, and never invents one", () => {
    expect(friendlySize({ available: true, count: 1234 })).toEqual({ text: "1,234 profiles", counted: true, estimated: false });
    expect(friendlySize({ available: true, count: 5, estimated: true }).estimated).toBe(true);
    expect(friendlySize({ available: false, reason: "this AEP org only counts audiences in its scheduled evaluation - size appears after that runs" }).text)
      .toBe("Counted in tonight's evaluation");
    expect(friendlySize({ available: false, reason: "x", pending: { jobId: "j", segmentId: "s", sandbox: null } }).text).toBe("Counting now…");
    expect(friendlySize(undefined).counted).toBe(false);
  });
});

describe("outcomeOf", () => {
  const created = {
    audience: { segmentId: "seg-1", name: "Demo: SEP upsell · 1234abcd", source: "created", pql: 'a = "Y"', interpretation: "SEP-eligible without SEP", sandbox: "tapdemo" },
    sizeEstimate: { available: false, reason: "scheduled evaluation" },
    label: "Demo – not approved",
  };

  it("is a success only when an audience actually exists", () => {
    const o = outcomeOf(detail(run("completed"), [step("intake", "completed"), step("audience_creation", "completed", created, { mode: "demo" })]));
    expect(o.kind).toBe("success");
    if (o.kind !== "success") return;
    expect(o.audience).toMatchObject({ displayName: "SEP upsell", id: "seg-1", reused: false, demo: true, environment: "Demo sandbox (tapdemo)" });
  });

  it("a reused audience is still a success, marked as reused", () => {
    const o = outcomeOf(detail(run("completed"), [step("audience_creation", "completed", { ...created, audience: { ...created.audience, source: "existing_same_rule" } })]));
    expect(o.kind === "success" && o.audience.reused).toBe(true);
  });

  it("a verified rule that was not created is 'defined', not success", () => {
    const o = outcomeOf(detail(run("completed"), [
      step("audience_creation", "completed", { audience: null }, { pqlSynthesis: { synthesized: true, pql: 'a = "Y"', interpretation: "i" }, mode: "governed" }),
    ]));
    expect(o).toMatchObject({ kind: "defined", rule: 'a = "Y"' });
  });

  it("no rule is 'not built', with a plain reason and no jargon", () => {
    const o = outcomeOf(detail(run("completed"), [
      step("audience_creation", "completed", { audience: null }, { pqlSynthesis: { synthesized: false, reason: "the model reported the available fields are insufficient" } }),
    ]));
    expect(o.kind).toBe("not_built");
    if (o.kind === "not_built") expect(o.reason).not.toMatch(/PQL|LLM|synthes/i);
  });

  it("maps a paused run to its question, and a running one to progress", () => {
    const q = { key: "filter:region", label: "region", ask: "Which field?", options: null };
    expect(outcomeOf(detail(run("needs_input"), [step("intake", "needs_input", { questions: [q] })]))).toEqual({ kind: "question", questions: [q] });
    expect(outcomeOf(detail(run("running"), [step("intake", "completed")]))).toEqual({ kind: "working", stage: 1 });
  });

  it("a failed run says so plainly", () => {
    expect(outcomeOf(detail(run("failed"), [])).kind).toBe("failed");
  });
});

describe("plainReason", () => {
  it("names a builder outage as temporary rather than blaming the request", () => {
    expect(plainReason({}, { pqlSynthesis: { reason: "PQL synthesis failed (Anthropic API returned HTTP 400: credit balance too low)" } }))
      .toMatch(/briefly unavailable/);
  });
  it("explains the federated path in business terms", () => {
    expect(plainReason({ buildPath: "fac" }, {})).toMatch(/outside Adobe Experience Platform/);
  });
});
