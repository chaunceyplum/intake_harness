import { describe, it, expect } from "vitest";
import { pqlToSql, profileTable } from "./count";

describe("pqlToSql - the rule as a WHERE clause, exactly or not at all", () => {
  it("translates the studio's rules", () => {
    expect(pqlToSql('_t.SEPeligible = "Y" and _t.hasSEP = "N"')).toBe("_t.SEPeligible = 'Y' and _t.hasSEP = 'N'");
    expect(pqlToSql('_t.emailAddress.isNotNull() and _t.doNotContact != "Y"')).toBe("_t.emailAddress is not null and _t.doNotContact != 'Y'");
    expect(pqlToSql("_t.companySize >= 20 and _t.companySize <= 200")).toBe("_t.companySize >= 20 and _t.companySize <= 200");
    expect(pqlToSql('not (_t.a = "Y") or (_t.b = "N")')).toBe("not (_t.a = 'Y') or (_t.b = 'N')");
  });

  it("escapes quotes inside values", () => {
    expect(pqlToSql('_t.name = "O\'Brien"')).toBe("_t.name = 'O''Brien'");
  });

  it("refuses what it can't translate exactly, and anything that could be a second statement", () => {
    expect(pqlToSql('_t.tags.contains("x")')).toBeNull();
    expect(pqlToSql('_t.a in ["x", "y"]')).toBeNull();
    expect(pqlToSql('_t.a = "Y"; drop table t')).toBeNull();
    expect(pqlToSql('_t.a = "Y" -- x')).toBeNull();
    expect(pqlToSql("")).toBeNull();
  });
});

describe("profileTable", () => {
  it("knows tapdemo's CB dataset and nothing it wasn't told", () => {
    expect(profileTable("tapdemo")).toBe("cb_product_profile_dataset_uks");
    expect(profileTable("prod")).toBeNull();
  });
});
