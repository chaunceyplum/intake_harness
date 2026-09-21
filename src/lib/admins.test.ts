import { describe, it, expect } from "vitest";
import { listAdmins, isAdmin } from "./admins";

/**
 * isPromoteAdmin (the settings.promote_admins-aware check, which mocks
 * "@/lib/db") lives in its own file, admins-promote.test.ts - not because
 * it belongs elsewhere, but because having it as a SECOND describe() in
 * this file, after this synchronous one, made an unrelated Vitest 4.1.11
 * quirk misattribute a properly try/caught mock rejection as an unhandled
 * error and fail the test. Verified by isolating it: same assertions, same
 * mock, passes reliably alone or in its own file. See that file's own note.
 */
describe("listAdmins / isAdmin", () => {
  const original = process.env.ADMIN_NAMES;

  it("parses a comma-separated ADMIN_NAMES, trimming blanks", () => {
    process.env.ADMIN_NAMES = "Alice, Bob ,, Carol";
    try {
      expect(listAdmins()).toEqual(["Alice", "Bob", "Carol"]);
      expect(isAdmin("Bob")).toBe(true);
      expect(isAdmin("Dave")).toBe(false);
    } finally {
      if (original === undefined) delete process.env.ADMIN_NAMES;
      else process.env.ADMIN_NAMES = original;
    }
  });
});
