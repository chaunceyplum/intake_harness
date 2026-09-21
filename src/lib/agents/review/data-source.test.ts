import { describe, it, expect } from "vitest";
import {
  resolveDataSource,
  applyDataSourceResolution,
  DATA_SOURCE_FIELD,
} from "./data-source";
import { triageRejection } from "./triage";
import type { SchemaProbe } from "@/lib/agents/audience/aep";

/** A SchemaProbe with sensible defaults; override only what a case cares about. */
function probe(overrides: Partial<SchemaProbe> = {}): SchemaProbe {
  return {
    read: true,
    conclusive: true,
    error: null,
    sandbox: "taplondonptrsd",
    schemaCount: 12,
    schemasInspected: 1,
    fieldGroupsInspected: 0,
    fieldCount: 40,
    found: {},
    evidence: [],
    ...overrides,
  };
}

describe("resolveDataSource - decided from the brief alone, no probe needed", () => {
  it("names FAC explicitly -> federated, resolved", () => {
    const r = resolveDataSource(
      { data_location: "this lives in our Snowflake warehouse (FAC)" },
      { schemaProbe: probe({ conclusive: false }), neededAttributes: [] },
    );
    expect(r.resolved).toBe(true);
    if (r.resolved) expect(r.source).toBe("fac");
  });

  it("targets prospects -> federated, resolved (prospects aren't in the profile store)", () => {
    const r = resolveDataSource(
      { customer_type: "Prospect - Non-Customers" },
      { schemaProbe: probe({ conclusive: false }), neededAttributes: [] },
    );
    expect(r.resolved).toBe(true);
    if (r.resolved) expect(r.source).toBe("fac");
  });
});

describe("resolveDataSource - only relevant fields are scanned, never the whole form", () => {
  it("does not resolve FAC from an unrelated field's incidental word match (a campaign named 'Snowflake Days')", () => {
    const r = resolveDataSource(
      {
        campaign_name: "Snowflake Days Renewal Push",
        customer_type: "Subscriber - Existing Customers",
        line_of_business: "Residential (RES)",
      },
      {
        schemaProbe: probe({ conclusive: true, found: { line_of_business: true }, evidence: ["lineOfBusiness"] }),
        neededAttributes: ["line_of_business"],
      },
    );
    // "snowflake" only appears in campaign_name, which is not scanned - the
    // probe evidence is what should decide this, landing on profile_store.
    expect(r.resolved).toBe(true);
    if (r.resolved) expect(r.source).toBe("profile_store");
  });
});

describe("resolveDataSource - the profile-store answer requires positive proof", () => {
  it("every needed attribute present in a profile schema -> profile store, resolved", () => {
    const r = resolveDataSource(
      { customer_type: "Subscriber - Existing Customers", line_of_business: "Residential (RES)" },
      {
        schemaProbe: probe({ conclusive: true, found: { line_of_business: true }, evidence: ["lineOfBusiness"] }),
        neededAttributes: ["line_of_business"],
      },
    );
    expect(r.resolved).toBe(true);
    if (r.resolved) {
      expect(r.source).toBe("profile_store");
      expect(r.evidence).toContain("lineOfBusiness");
    }
  });

  it("an INCONCLUSIVE probe never resolves - the whole safety property", () => {
    const r = resolveDataSource(
      { customer_type: "Subscriber - Existing Customers" },
      {
        schemaProbe: probe({ conclusive: false, error: "none of the 12 schemas look like profile schemas" }),
        neededAttributes: ["line_of_business"],
      },
    );
    expect(r.resolved).toBe(false);
    expect(r.rationale).toMatch(/could not be determined/i);
  });

  it("attributes conclusively ABSENT stays a human decision (ambiguous), with evidence", () => {
    const r = resolveDataSource(
      { customer_type: "Subscriber - Existing Customers" },
      {
        schemaProbe: probe({ conclusive: true, found: { line_of_business: false } }),
        neededAttributes: ["line_of_business"],
      },
    );
    expect(r.resolved).toBe(false);
    expect(r.rationale).toMatch(/GTO attribute request|federated/i);
  });

  it("nothing checkable to anchor on -> unresolved", () => {
    const r = resolveDataSource(
      { customer_type: "Subscriber - Existing Customers" },
      { schemaProbe: probe({ conclusive: true }), neededAttributes: [] },
    );
    expect(r.resolved).toBe(false);
  });
});

describe("applyDataSourceResolution - folding the answer back into triage", () => {
  const rejection = "unclear whether this is FAC or the profile store";

  it("a resolved source fills data_location and turns the question into a confirmation", () => {
    const triage = triageRejection(rejection, { customer_type: "Subscriber - Existing Customers" });
    // Sanity: triage really did raise the source finding.
    expect(triage.findings.some((f) => f.kind === "wrong_data_source")).toBe(true);

    const applied = applyDataSourceResolution(triage, {
      resolved: true,
      source: "profile_store",
      label: "AEP profile store",
      rationale: "every attribute is present",
      evidence: ["lineOfBusiness"],
    });

    expect(applied.redraft[DATA_SOURCE_FIELD]).toBe("AEP profile store");
    expect(applied.changed).toContain(DATA_SOURCE_FIELD);
    const finding = applied.findings.find((f) => f.fieldKey === DATA_SOURCE_FIELD);
    expect(finding?.proposed).toBe("AEP profile store");
    expect(finding?.ask).toMatch(/resolved to AEP profile store/i);
  });

  it("an unresolved source stays a question but carries the AEP evidence", () => {
    const triage = triageRejection(rejection, { customer_type: "Subscriber - Existing Customers" });
    const applied = applyDataSourceResolution(triage, {
      resolved: false,
      rationale: "availability could not be determined",
      evidence: [],
    });

    expect(applied.redraft[DATA_SOURCE_FIELD]).toBeUndefined();
    const finding = applied.findings.find((f) => f.kind === "wrong_data_source");
    expect(finding?.proposed ?? null).toBeNull();
    expect(finding?.ask).toMatch(/Checked AEP:/);
  });

  it("is a no-op when the rejection raised no wrong_data_source finding", () => {
    const triage = triageRejection("missing launch date", {});
    expect(triage.findings.some((f) => f.kind === "wrong_data_source")).toBe(false);
    const applied = applyDataSourceResolution(triage, {
      resolved: true,
      source: "fac",
      label: "Federated (FAC)",
      rationale: "n/a",
      evidence: [],
    });
    expect(applied).toBe(triage);
  });
});
