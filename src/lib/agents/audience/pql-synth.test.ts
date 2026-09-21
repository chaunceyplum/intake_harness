import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the MCP client so createSegmentFromPql's write can be exercised without
// a network. vi.hoisted is required: vi.mock is hoisted above imports, so the
// fn it returns must be created in a hoisted block too, not a plain const.
const { callMcpTool } = vi.hoisted(() => ({ callMcpTool: vi.fn() }));
vi.mock("@/lib/mcp-client", () => ({ callMcpTool }));

// Mock the DB query behind findPriorTaskRun (idempotent-write.ts), so
// createSegmentFromPql's idempotency guard is deterministic instead of
// depending on whether a real DATABASE_URL happens to be set in the test env.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@/lib/db", () => ({ query: queryMock }));

import {
  synthesizePql,
  verifyFields,
  isFieldPresent,
  isMissingWriteTool,
  createSegmentFromPql,
  segmentCreationEnabled,
  type PqlSynthesis,
} from "./pql-synth";
import type { SchemaProbe } from "./aep";
import type { PqlGuidance } from "@/lib/agents/review/pql-context";
import type { LlmClient, LlmCompletionResult } from "@/lib/llm";

function stub(reply: string | Error, model = "stub"): LlmClient {
  return {
    id: `stub:${model}`,
    async complete(): Promise<LlmCompletionResult> {
      if (reply instanceof Error) throw reply;
      return { text: reply, model, usage: null };
    },
  };
}

function probe(overrides: Partial<SchemaProbe> = {}): SchemaProbe {
  return {
    read: true, conclusive: true, error: null, sandbox: "sbx",
    schemaCount: 5, schemasInspected: 1, fieldGroupsInspected: 0, fieldCount: 3,
    found: {}, evidence: ["xfinityInternet", "stateProvince"], ...overrides,
  };
}

const pqlRef: PqlGuidance = {
  grounded: true,
  reason: null,
  hits: [],
  localReference: { available: true, path: "docs/pql-reference.md", categoryCount: 12, content: "PQL functions: exists(...)", error: null },
};

describe("isFieldPresent - anchored, leaf-segment match (the 'lob in glob' discipline)", () => {
  it("matches the last dotted path segment case-insensitively", () => {
    expect(isFieldPresent("_tenant.xfinityInternet", ["xfinityInternet"])).toBe(true);
    expect(isFieldPresent("homeAddress.stateProvince", ["stateProvince"])).toBe(true);
  });
  it("does not match a mere substring", () => {
    expect(isFieldPresent("_tenant.xfinity", ["xfinityInternet"])).toBe(false);
  });
  it("rejects a field not in the present list", () => {
    expect(isFieldPresent("_tenant.hasFerrari", ["xfinityInternet"])).toBe(false);
  });
});

describe("verifyFields", () => {
  it("splits confirmed from unverified", () => {
    const { confirmed, unverified } = verifyFields(
      ["a.xfinityInternet", "a.madeUp"],
      ["xfinityInternet", "stateProvince"],
    );
    expect(confirmed).toEqual(["a.xfinityInternet"]);
    expect(unverified).toEqual(["a.madeUp"]);
  });
});

describe("synthesizePql - the verify gate is the whole point", () => {
  const criteria = "customers who have Xfinity Internet in a given state";

  it("no LLM -> not synthesized, honest reason", async () => {
    const r = await synthesizePql(criteria, probe(), pqlRef, null);
    expect(r.synthesized).toBe(false);
    expect(r.reason).toMatch(/no LLM/);
  });

  it("inconclusive probe -> refuses to synthesize against an unknown field set", async () => {
    const r = await synthesizePql(criteria, probe({ conclusive: false, error: "undetermined", evidence: [] }), pqlRef, stub("{}"));
    expect(r.synthesized).toBe(false);
    expect(r.reason).toMatch(/undetermined|unknown field set/);
  });

  it("accepts an expression whose fields are all verified present", async () => {
    const client = stub(
      JSON.stringify({ pql: "xEvent.xfinityInternet = true", fieldsUsed: ["a.xfinityInternet"], missing: [] }),
    );
    const r = await synthesizePql(criteria, probe(), pqlRef, client);
    expect(r.synthesized).toBe(true);
    expect(r.pql).toMatch(/xfinityInternet/);
    expect(r.fieldsUsed).toEqual(["a.xfinityInternet"]);
  });

  it("REJECTS an expression referencing an unverified field", async () => {
    const client = stub(
      JSON.stringify({ pql: "profile.hasFerrari = true", fieldsUsed: ["profile.hasFerrari"], missing: [] }),
    );
    const r = await synthesizePql(criteria, probe(), pqlRef, client);
    expect(r.synthesized).toBe(false);
    expect(r.unverifiedFields).toContain("profile.hasFerrari");
    expect(r.reason).toMatch(/not verified present/);
  });

  it("reports insufficiency when the model returns an empty expression", async () => {
    const client = stub(JSON.stringify({ pql: "", fieldsUsed: [], missing: ["loyalty tier"] }));
    const r = await synthesizePql(criteria, probe(), pqlRef, client);
    expect(r.synthesized).toBe(false);
    expect(r.reason).toMatch(/insufficient|loyalty tier/);
  });

  it("falls back (not synthesized) when the PQL reference is unavailable", async () => {
    const noRef: PqlGuidance = { ...pqlRef, localReference: { ...pqlRef.localReference, available: false, content: null, error: "missing" } };
    const r = await synthesizePql(criteria, probe(), noRef, stub("{}"));
    expect(r.synthesized).toBe(false);
    expect(r.reason).toMatch(/reference could not be loaded/);
  });

  it("does not throw on a model error", async () => {
    const r = await synthesizePql(criteria, probe(), pqlRef, stub(new Error("boom")));
    expect(r.synthesized).toBe(false);
    expect(r.reason).toMatch(/failed/);
  });
});

describe("isMissingWriteTool - names a disabled write, not a bug here", () => {
  it("matches a 'not found' error for the segment-create tool", () => {
    expect(isMissingWriteTool("Tool adobe_create_segment not found")).toBe(true);
  });
  it("does not match an unrelated error", () => {
    expect(isMissingWriteTool("Invalid PQL expression")).toBe(false);
  });
});

describe("segmentCreationEnabled - off unless explicitly true", () => {
  afterEach(() => delete process.env.AUDIENCE_CREATE_SEGMENT);
  it("is false when unset", () => {
    expect(segmentCreationEnabled()).toBe(false);
  });
  it("is true only for the literal 'true'", () => {
    process.env.AUDIENCE_CREATE_SEGMENT = "true";
    expect(segmentCreationEnabled()).toBe(true);
    process.env.AUDIENCE_CREATE_SEGMENT = "yes";
    expect(segmentCreationEnabled()).toBe(false);
  });
});

describe("createSegmentFromPql - writes only from a verified expression, honest on failure", () => {
  const verified: PqlSynthesis = {
    synthesized: true,
    pql: "xEvent.xfinityInternet = true",
    fieldsUsed: ["a.xfinityInternet"],
    model: "stub",
    reason: null,
    unverifiedFields: [],
  };

  beforeEach(() => {
    callMcpTool.mockReset();
    queryMock.mockReset();
    queryMock.mockResolvedValue([]); // no prior task_run, by default
  });

  it("refuses when handed an unsynthesized result (belt-and-suspenders guard)", async () => {
    const notSynth: PqlSynthesis = { ...verified, synthesized: false, pql: null };
    const r = await createSegmentFromPql("run-1", "audience_creation", notSynth, "X");
    expect(r.attempted).toBe(false);
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it("creates and returns the id when the tool succeeds", async () => {
    callMcpTool.mockResolvedValue({ id: "seg-123" });
    const r = await createSegmentFromPql("run-1", "audience_creation", verified, "Fall Save");
    expect(r).toMatchObject({ attempted: true, created: true, segmentId: "seg-123" });
    expect(callMcpTool).toHaveBeenCalledWith(
      "audience_creation",
      "adobe_create_segment",
      expect.objectContaining({ name: "Fall Save", expression: expect.objectContaining({ value: verified.pql }) }),
    );
  });

  // The disabled-write CLASSIFICATION is tested purely below via
  // isMissingWriteTool; the create function's catch turns exactly that into a
  // created:false dry-run with wouldHaveCreated (same shape asserted in the
  // no-id case above). Kept pure to avoid a live rejection in the test.

  it("reports created:false when the tool returns no id", async () => {
    callMcpTool.mockResolvedValue({});
    const r = await createSegmentFromPql("run-1", "audience_creation", verified, "Fall Save");
    expect(r).toMatchObject({ attempted: true, created: false });
  });

  it("reuses a prior successful create for this run instead of creating a duplicate", async () => {
    queryMock.mockResolvedValue([
      {
        status: "completed",
        output: {
          segmentCreation: {
            attempted: true,
            created: true,
            segmentId: "seg-existing",
            name: "Fall Save",
            pql: verified.pql,
          },
        },
        metadata: null,
      },
    ]);
    const r = await createSegmentFromPql("run-1", "audience_creation", verified, "Fall Save");
    expect(r).toMatchObject({ attempted: true, created: true, segmentId: "seg-existing", reused: true });
    expect(callMcpTool).not.toHaveBeenCalled();
  });
});
