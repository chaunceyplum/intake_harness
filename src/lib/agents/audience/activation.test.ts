import { describe, it, expect, vi, beforeEach } from "vitest";

const callMcpToolMock = vi.fn();
vi.mock("@/lib/mcp-client", () => ({ callMcpTool: (...args: unknown[]) => callMcpToolMock(...args) }));

const { detectActivationIntentFromField, resolveActivationIntent, activateAudience } = await import("./activation");

beforeEach(() => {
  callMcpToolMock.mockReset();
});

describe("detectActivationIntentFromField", () => {
  it("treats a real destination name as requested", () => {
    expect(detectActivationIntentFromField("chaunceys custom dest")).toEqual({
      requested: true,
      destinationName: "chaunceys custom dest",
      evidence: 'intake field "destination": "chaunceys custom dest"',
    });
  });

  it.each(["", "N/A", "none", "No", "not applicable", "TBD", "  "])(
    "treats %j as not requested, not a literal destination name",
    (value) => {
      expect(detectActivationIntentFromField(value)).toEqual({ requested: false, destinationName: null, evidence: null });
    },
  );
});

describe("resolveActivationIntent", () => {
  it("the structured field wins over brief text when present, in both directions", () => {
    // Field says a real destination - wins even with no brief-text match.
    expect(resolveActivationIntent("just build the audience", "Chauncey's dest").requested).toBe(true);
    // Field explicitly says none - wins even though the brief READS like an activation request.
    expect(resolveActivationIntent("activate this to Chauncey's dest", "none").requested).toBe(false);
  });

  it("falls back to brief-text parsing only when the field is genuinely absent (undefined)", () => {
    const result = resolveActivationIntent("please activate this to Chauncey's dest", undefined);
    expect(result.requested).toBe(true);
    expect(result.destinationName).toMatch(/Chauncey/i);
  });
});

describe("activateAudience - already active / needs manual wiring (unchanged read-only paths)", () => {
  it("reports already_active when the segment is already on the matched dataflow", async () => {
    callMcpToolMock.mockImplementation((_taskId: string, tool: string) => {
      if (tool === "destination_list_dataflows") {
        return Promise.resolve({ dataflows: [{ id: "flow-1", name: "chaunceys custom dest" }] });
      }
      if (tool === "destination_get_dataflow") {
        return Promise.resolve({
          segment_selectors: [{ params: { segmentSelectors: { selectors: [{ value: { id: "seg-123" } }] } } }],
        });
      }
      throw new Error(`unexpected tool ${tool}`);
    });

    const result = await activateAudience("audience_creation", {
      segmentId: "seg-123",
      segmentName: "Has ECID",
      destinationName: "chaunceys custom dest",
    });
    expect(result).toEqual({ status: "already_active", destinationName: "chaunceys custom dest", dataflowId: "flow-1" });
  });

  it("reports needs_manual_wiring when a dataflow exists but lacks this segment - never attempts a write", async () => {
    callMcpToolMock.mockImplementation((_taskId: string, tool: string) => {
      if (tool === "destination_list_dataflows") {
        return Promise.resolve({ dataflows: [{ id: "flow-1", name: "chaunceys custom dest" }] });
      }
      if (tool === "destination_get_dataflow") {
        return Promise.resolve({ segment_selectors: [{ params: { segmentSelectors: { selectors: [{ value: { id: "some-other-segment" } }] } } }] });
      }
      throw new Error(`unexpected tool ${tool}`);
    });

    const result = await activateAudience("audience_creation", {
      segmentId: "seg-123",
      segmentName: "Has ECID",
      destinationName: "chaunceys custom dest",
    });
    expect(result.status).toBe("needs_manual_wiring");
    // The write tools must never be called on this path.
    expect(callMcpToolMock).not.toHaveBeenCalledWith(expect.anything(), "destination_create_dataflow", expect.anything());
  });
});

describe("activateAudience - a failed read is not a confirmed absence", () => {
  it("reports lookup_failed, not destination_not_found, when the dataflow list read itself throws", async () => {
    callMcpToolMock.mockImplementation((_taskId: string, tool: string) => {
      if (tool === "destination_list_dataflows") return Promise.reject(new Error("AEP gateway timed out"));
      throw new Error(`unexpected tool ${tool}`);
    });

    const result = await activateAudience("audience_creation", {
      segmentId: "seg-123",
      segmentName: "Has ECID",
      destinationName: "chaunceys custom dest",
    });
    expect(result.status).toBe("lookup_failed");
    if (result.status === "lookup_failed") expect(result.reason).toMatch(/AEP gateway timed out/);
    // Must not fall through to the create path on an unconfirmed absence.
    expect(callMcpToolMock).not.toHaveBeenCalledWith(expect.anything(), "destination_create_dataflow", expect.anything());
  });
});

describe("activateAudience - creating a new dataflow (no existing dataflow for this destination)", () => {
  // Fixtures below mirror REAL shapes verified live against the gateway,
  // 20 Sep 2026 (destination_get_target_connection on a real target
  // connection, flow_list_flow_specs containing
  // "UPSToCustomPersonalizationDestinationWithAttributesBeta", and a real
  // segment-activation dataflow's own segment_selectors/source_connection_id)
  // - not invented shapes.

  it("declines (create_failed) rather than guess when no dataflow AND no target connection matches", async () => {
    callMcpToolMock.mockImplementation((_taskId: string, tool: string) => {
      if (tool === "destination_list_dataflows") return Promise.resolve({ dataflows: [] });
      if (tool === "destination_list_target_connections") return Promise.resolve({ target_connections: [] });
      throw new Error(`unexpected tool ${tool}`);
    });

    const result = await activateAudience("audience_creation", {
      segmentId: "seg-123",
      segmentName: "Has ECID",
      destinationName: "Some Destination Nobody Configured",
    });
    expect(result.status).toBe("destination_not_found");
  });

  it("declines (create_failed) when a target connection matches but no flow spec resolves for its connection type", async () => {
    callMcpToolMock.mockImplementation((_taskId: string, tool: string) => {
      if (tool === "destination_list_dataflows") return Promise.resolve({ dataflows: [] });
      if (tool === "destination_list_target_connections") return Promise.resolve({ target_connections: [{ id: "tc-1", name: "chaunceys custom dest" }] });
      if (tool === "destination_get_target_connection") return Promise.resolve({ connection_spec_id: "unknown-spec-id" });
      if (tool === "flow_list_flow_specs") return Promise.resolve({ flow_specs: [] });
      throw new Error(`unexpected tool ${tool}`);
    });

    const result = await activateAudience("audience_creation", {
      segmentId: "seg-123",
      segmentName: "Has ECID",
      destinationName: "chaunceys custom dest",
    });
    expect(result.status).toBe("create_failed");
    if (result.status === "create_failed") expect(result.reason).toMatch(/no flow spec/);
  });

  it("creates a new dataflow when a target connection, flow spec, and a proven source connection all resolve", async () => {
    let dataflowsCallCount = 0;
    callMcpToolMock.mockImplementation((_taskId: string, tool: string, args: Record<string, unknown>) => {
      if (tool === "destination_list_dataflows") {
        dataflowsCallCount += 1;
        // First call: matching-by-name search (nothing named after our destination).
        // Second call: findProvenSourceConnection's search (reuse a real existing segment-activation dataflow).
        return Promise.resolve({ dataflows: dataflowsCallCount === 1 ? [] : [{ id: "8db840b9-a2ab-40ec-80c0-79a8915a5266", name: "chaunceys custom dest" }] });
      }
      if (tool === "destination_get_dataflow") {
        return Promise.resolve({
          segment_selectors: [{ params: { segmentSelectors: { selectors: [{ value: { id: "9632dd50-b3a8-4da8-86e4-3c5c4e136d91" } }] } } }],
          source_connection_id: "139a4eb8-66d3-4504-9d83-b8d800646e29",
        });
      }
      if (tool === "destination_list_target_connections") {
        return Promise.resolve({ target_connections: [{ id: "6eb4cbe0-dc1b-4e13-921a-828004adef30", name: "chaunceys custom dest" }] });
      }
      if (tool === "destination_get_target_connection") {
        return Promise.resolve({ connection_spec_id: "f272b69b-71eb-41ba-b801-09b40d1a94e9" });
      }
      if (tool === "flow_list_flow_specs") {
        return Promise.resolve({
          flow_specs: [{ id: "07a26f27-6ac3-4a5e-a150-b67ba2ebe490", targetConnectionSpecIds: ["f272b69b-71eb-41ba-b801-09b40d1a94e9"] }],
        });
      }
      if (tool === "destination_create_dataflow") {
        expect(args.flow_spec_id).toBe("07a26f27-6ac3-4a5e-a150-b67ba2ebe490");
        expect(args.source_connection_id).toBe("139a4eb8-66d3-4504-9d83-b8d800646e29");
        expect(args.target_connection_id).toBe("6eb4cbe0-dc1b-4e13-921a-828004adef30");
        expect(typeof args.segment_selectors).toBe("string");
        expect(JSON.parse(String(args.segment_selectors))[0].params.segmentSelectors.selectors[0].value.id).toBe("new-segment-id");
        return Promise.resolve({ id: "new-flow-id" });
      }
      throw new Error(`unexpected tool ${tool}`);
    });

    const result = await activateAudience("audience_creation", {
      segmentId: "new-segment-id",
      segmentName: "Has ECID 2",
      destinationName: "chaunceys custom dest",
    });
    expect(result).toEqual({ status: "created", destinationName: "chaunceys custom dest", dataflowId: "new-flow-id" });
  });
});
