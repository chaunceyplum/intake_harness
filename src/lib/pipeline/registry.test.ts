import { describe, it, expect } from "vitest";
import { PIPELINE } from "./registry";

describe("Agent 4 - Escalation stays removed", () => {
  it("PIPELINE has exactly the 3 sequential agents, no escalation entry", () => {
    expect(PIPELINE.map((a) => a.name)).toEqual(["intake", "review", "audience_creation"]);
  });

  it("registry.ts exports no ESCALATION/ALL_TASKS any more", async () => {
    const mod = (await import("./registry")) as Record<string, unknown>;
    expect(mod.ESCALATION).toBeUndefined();
    expect(mod.ALL_TASKS).toBeUndefined();
  });
});

describe("Audience Creation's approval-gate opt-out", () => {
  it("audience_creation sets requiresApproval: false", () => {
    const agent = PIPELINE.find((a) => a.name === "audience_creation");
    expect(agent?.requiresApproval).toBe(false);
  });

  it("intake and review still default to requiring approval (undefined === required)", () => {
    const intake = PIPELINE.find((a) => a.name === "intake");
    const review = PIPELINE.find((a) => a.name === "review");
    expect(intake?.requiresApproval).not.toBe(false);
    expect(review?.requiresApproval).not.toBe(false);
  });
});

describe("segment-estimate tools re-granted to Agent 3 (explicit product direction, executive demo)", () => {
  // Reverses the prior decision (these were dropped once already, for the
  // same verified-404 reason cited in aep.ts's docstring) - re-granted so
  // estimateSegmentSize can try the call and catch that failure honestly
  // per-run, rather than the allowlist itself keeping the app from ever
  // trying again once the gateway bug is fixed.
  it("audience_creation can call adobe_create_segment_estimate/adobe_get_segment_estimate", () => {
    const agent = PIPELINE.find((a) => a.name === "audience_creation");
    expect(agent?.allowedTools).toContain("adobe_create_segment_estimate");
    expect(agent?.allowedTools).toContain("adobe_get_segment_estimate");
  });
});

describe("intake gets read-only AEP schema access (executive demo: buildability check replaces required-field gating)", () => {
  it("intake can probe schemas (adobe_list_schemas/adobe_get_schema/adobe_get_union_schema/adobe_get_field_group)", () => {
    const agent = PIPELINE.find((a) => a.name === "intake");
    for (const tool of ["adobe_list_schemas", "adobe_get_schema", "adobe_get_union_schema", "adobe_get_field_group"]) {
      expect(agent?.allowedTools).toContain(tool);
    }
  });
});

describe("least-privilege: Workfront grants match actual usage, not the full toolset", () => {
  it("intake cannot search/read/list-comments an arbitrary Workfront object - only what workfront.ts actually calls", () => {
    const agent = PIPELINE.find((a) => a.name === "intake");
    for (const denied of [
      "insights_find_workfront_data", "wf_core_issue_list", // search
      "insights_summarize_object", "wf_core_issue_get", // getOne
      "comment-stream_query_comments", "wf_comments_list", // listComments
    ]) {
      expect(agent?.allowedTools).not.toContain(denied);
    }
  });

  it("review cannot create a Workfront object, look up by name, or resolve field names - it only ever touches the issue in its input", () => {
    const agent = PIPELINE.find((a) => a.name === "review");
    for (const denied of [
      "workflow_create_any_object", "wf_core_issue_create", // create
      "insights_find_workfront_data", "wf_core_issue_list", // search
      "insights_summarize_object", "wf_core_issue_get", // getOne
      "insights_search_fields", // resolveFields
      "insights_find_id_by_name",
    ]) {
      expect(agent?.allowedTools).not.toContain(denied);
    }
  });

  it("no agent is granted adobe_get_segment - grep-verified unused by any agent's code", () => {
    for (const agent of PIPELINE) {
      expect(agent.allowedTools).not.toContain("adobe_get_segment");
    }
  });
});

describe("least-privilege: destination writes stay narrow", () => {
  // destination_update_dataflow (rename/reschedule) has NO audience field at
  // all - it cannot activate anything, so no agent has any reason to hold it.
  // The tool that DOES activate into an existing dataflow is
  // destination_update_dataflow_audiences (asserted separately below); this
  // guard keeps the useless-but-write-shaped rename tool out for everyone.
  it("no agent, ever, is granted destination_update_dataflow", () => {
    for (const agent of PIPELINE) {
      expect(agent.allowedTools).not.toContain("destination_update_dataflow");
    }
  });

  // destination_create_dataflow IS now granted - explicit product
  // direction, 20 Sep 2026 - but ONLY to audience_creation, and only for
  // the case where the destination has no dataflow yet (see activation.ts).
  it("destination_create_dataflow is granted to audience_creation only", () => {
    for (const agent of PIPELINE) {
      const expectGranted = agent.name === "audience_creation";
      expect(agent.allowedTools.includes("destination_create_dataflow")).toBe(expectGranted);
    }
  });

  // destination_update_dataflow_audiences (add/remove activated audiences on
  // an existing dataflow) is granted to audience_creation only - it is how
  // Agent 3 activates into a dataflow that already exists, add-only, without
  // disturbing anything else wired there (21 Sep 2026, explicit product
  // direction - see activation.ts's activateIntoExistingDataflow).
  it("destination_update_dataflow_audiences is granted to audience_creation only", () => {
    for (const agent of PIPELINE) {
      const expectGranted = agent.name === "audience_creation";
      expect(agent.allowedTools.includes("destination_update_dataflow_audiences")).toBe(expectGranted);
    }
  });
});
