import { describe, it, expect, vi, beforeEach } from "vitest";

const { callMcpToolMock } = vi.hoisted(() => ({ callMcpToolMock: vi.fn() }));
vi.mock("@/lib/mcp-client", () => ({ callMcpTool: callMcpToolMock }));

const { fieldEntries, matchCriteriaFields, neededAttributes, probeSchemas } = await import("./aep");

// The shape tapdemo actually returns: a union of bare $refs, no inline properties.
const UNION = {
  allOf: [
    { $ref: "https://ns.adobe.com/taplondonptrsd/mixins/eligibility" },
    { $ref: "https://ns.adobe.com/taplondonptrsd/mixins/holdings" },
    { $ref: "https://ns.adobe.com/xdm/context/profile" },
  ],
};
const GROUPS: Record<string, unknown> = {
  "https://ns.adobe.com/taplondonptrsd/mixins/eligibility": {
    definitions: { customFields: { properties: { _taplondonptrsd: { type: "object", properties: {
      SEPeligible: { type: "string", "meta:xdmType": "string", title: "SEP eligible", description: "Y/N flag" },
    } } } } },
  },
  "https://ns.adobe.com/taplondonptrsd/mixins/holdings": {
    definitions: { customFields: { properties: { _taplondonptrsd: { type: "object", properties: {
      customerEmail: { type: "string", "meta:xdmType": "string" },
      xfinityTV: { type: "boolean", "meta:xdmType": "boolean" },
    } } } } },
  },
};

beforeEach(() => {
  callMcpToolMock.mockReset();
  callMcpToolMock.mockImplementation(async (_task: string, tool: string, args: Record<string, string>) => {
    if (tool === "adobe_get_union_schema") return UNION;
    if (tool === "adobe_get_field_group") {
      if (args.field_group_id in GROUPS) return GROUPS[args.field_group_id];
      throw new Error("not found");
    }
    throw new Error(`unexpected tool ${tool}`);
  });
});

describe("fieldEntries", () => {
  it("returns full PQL paths and types, without definitions/customFields wrappers", () => {
    expect(fieldEntries(GROUPS["https://ns.adobe.com/taplondonptrsd/mixins/eligibility"])).toEqual([
      { path: "_taplondonptrsd", type: "object", description: null },
      { path: "_taplondonptrsd.SEPeligible", type: "string", description: "Y/N flag" },
    ]);
  });
});

describe("matchCriteriaFields - fields the brief names that no cue covers", () => {
  const fields = [
    { path: "_taplondonptrsd.SEPeligible", type: "boolean" },
    { path: "_taplondonptrsd.customerEmail", type: "string" },
    { path: "_taplondonptrsd.profileStatus", type: "string" },
  ];

  it("finds SEPeligible from \"SEP eligible\" and \"SEP-eligible\"", () => {
    expect(matchCriteriaFields("profiles with an email address and are SEP eligible", fields).map((f) => f.path))
      .toEqual(["_taplondonptrsd.SEPeligible"]);
    expect(matchCriteriaFields("SEP-eligible customers", fields).map((f) => f.path))
      .toEqual(["_taplondonptrsd.SEPeligible"]);
  });

  it("never matches on stopwords or partial words", () => {
    expect(matchCriteriaFields("profiles that are eligible", fields)).toEqual([]);
  });
});

describe("probeSchemas against a $ref-only union view", () => {
  const brief = "Create an audience of profiles with an email address and are SEP eligible";

  it("opens every field group the union lists and cites SEPeligible and customerEmail with paths and types", async () => {
    const probe = await probeSchemas("audience_creation", neededAttributes({}, brief), "tapdemo", brief);
    expect(probe.conclusive).toBe(true);
    expect(probe.found.channels).toBe(true);
    expect(probe.evidence).toEqual(["_taplondonptrsd.customerEmail", "_taplondonptrsd.SEPeligible"]);
    expect(probe.fieldTypes?.["_taplondonptrsd.SEPeligible"]).toBe("string");
    expect(probe.fieldDescriptions?.["_taplondonptrsd.SEPeligible"]).toBe("Y/N flag");
    const groupCalls = callMcpToolMock.mock.calls.filter((c) => c[1] === "adobe_get_field_group");
    expect(groupCalls.every((c) => c[2].sandbox === "tapdemo")).toBe(true);
  });
});
