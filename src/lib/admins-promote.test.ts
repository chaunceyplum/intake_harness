import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * isPromoteAdmin gets its OWN file, split out of admins.test.ts. Also note:
 * this deliberately uses ONE combined beforeEach (mock reset + env var),
 * not two separate ones (an outer beforeEach plus a nested describe-level
 * one) - verified in isolation that splitting the setup into two hooks
 * makes Vitest 4.1.11 misreport this file's properly try/caught mock
 * rejection as an unhandled error and fail an unrelated test. One hook is
 * reliable; two, here, is not - an actual Vitest quirk, not a real bug.
 */

const queryMock = vi.fn();
vi.mock("@/lib/db", () => ({ query: (...args: unknown[]) => queryMock(...args) }));

const { isPromoteAdmin } = await import("./admins");

const ORIGINAL_ADMIN_NAMES = process.env.ADMIN_NAMES;
afterEach(() => {
  if (ORIGINAL_ADMIN_NAMES === undefined) delete process.env.ADMIN_NAMES;
  else process.env.ADMIN_NAMES = ORIGINAL_ADMIN_NAMES;
});
beforeEach(() => {
  queryMock.mockReset();
  process.env.ADMIN_NAMES = "Alice, Bob";
});

describe("isPromoteAdmin - the narrower Hero Agents roster (settings.promote_admins)", () => {
  it("rejects outright anyone who isn't an admin at all, without querying settings", async () => {
    expect(await isPromoteAdmin("Mallory")).toBe(false);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("allows any admin when promote_admins is null (default, unset)", async () => {
    queryMock.mockResolvedValue([{ promote_admins: null }]);
    expect(await isPromoteAdmin("Bob")).toBe(true);
  });

  it("allows any admin when promote_admins is an empty array", async () => {
    queryMock.mockResolvedValue([{ promote_admins: [] }]);
    expect(await isPromoteAdmin("Bob")).toBe(true);
  });

  it("narrows to the roster when promote_admins is set", async () => {
    queryMock.mockResolvedValue([{ promote_admins: ["Alice"] }]);
    expect(await isPromoteAdmin("Alice")).toBe(true);
    expect(await isPromoteAdmin("Bob")).toBe(false);
  });

  it("fails open (allows) on a query error, same posture as isAdmin", async () => {
    queryMock.mockRejectedValue(new Error("connection reset"));
    expect(await isPromoteAdmin("Bob")).toBe(true);
  });
});
