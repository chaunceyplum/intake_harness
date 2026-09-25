import { describe, it, expect } from "vitest";
import { redactPii, restorePii, type PiiVault } from "./pii";

describe("redactPii", () => {
  it("tokenizes each PII type and counts distinct values", () => {
    const vault: PiiVault = new Map();
    const { text, counts } = redactPii(
      "Contact jane.doe@example.com or (212) 555-0142. SSN 123-45-6789, card 4111 1111 1111 1111, from 10.2.3.4.",
      vault,
    );
    expect(text).toBe("Contact [EMAIL_1] or [PHONE_1]. SSN [SSN_1], card [CARD_1], from [IPV4_1].");
    expect(counts).toEqual({ EMAIL: 1, PHONE: 1, SSN: 1, CARD: 1, IPV4: 1 });
  });

  it("reuses the same placeholder for a repeated value, across calls sharing a vault", () => {
    const vault: PiiVault = new Map();
    const a = redactPii("a@x.io and b@x.io", vault);
    const b = redactPii("again a@x.io", vault);
    expect(a.text).toBe("[EMAIL_1] and [EMAIL_2]");
    expect(b.text).toBe("again [EMAIL_1]");
    expect(b.counts).toEqual({});
  });

  it("leaves domain-shaped numbers alone (IDs, timestamps, dates, versions, PQL)", () => {
    const vault: PiiVault = new Map();
    const input = [
      "segment 5f3a9c1e8b2d4e6f7a8b9c0d",
      "ts 1727000000000", // 13 digits, would pass Luhn about 1 time in 10 without the prefix rule
      "created 2026-09-25",
      "ecid 12345678901234567890123456789012345678",
      "workfront id 2125550142", // bare 10 digits: no separators, not a phone
      'profile.homeAddress.postalCode = "10001" and person.age > 21',
      "version 1.2.3",
      "card-shaped but fails Luhn 4111 1111 1111 1112",
    ].join("\n");
    const { text, counts } = redactPii(input, vault);
    expect(text).toBe(input);
    expect(counts).toEqual({});
  });

  it("rejects out-of-range IPv4 octets", () => {
    expect(redactPii("999.1.1.1", new Map()).text).toBe("999.1.1.1");
  });
});

describe("restorePii", () => {
  it("round-trips placeholders in model output back to the original values", () => {
    const vault: PiiVault = new Map();
    redactPii("owner: jane@corp.com", vault);
    expect(restorePii('{"contactEmail":"[EMAIL_1]"}', vault)).toBe('{"contactEmail":"jane@corp.com"}');
  });

  it("leaves unknown placeholders as-is rather than guessing", () => {
    expect(restorePii("[EMAIL_9]", new Map())).toBe("[EMAIL_9]");
  });
});
