/**
 * PII tokenization for text that leaves this app for an LLM provider.
 *
 * WHY TOKENIZE, NOT JUST MASK: a campaign brief can carry a marketer's email,
 * a phone number, or (worst case) a pasted customer record. The model never
 * needs the real value to do its job - it needs to know "there is an email
 * here, and it's the same one mentioned twice." So each distinct value is
 * swapped for a stable placeholder ([EMAIL_1], [PHONE_2], ...) before the
 * prompt is sent, and the vault that maps placeholders back to values never
 * leaves this process. `restorePii` puts the originals back into the model's
 * answer locally, so an extracted "contact email" field still works.
 *
 * DELIBERATELY CONSERVATIVE PATTERNS: this text is full of numeric IDs,
 * dates, segment IDs, and PQL. A false positive corrupts a brief the agent
 * then misreads, so every pattern here requires structure a random ID won't
 * have (separators for phones and SSNs, a Luhn check for card numbers, valid
 * octets for IPs). Names and street addresses are NOT detected - that needs
 * an NER model, and is listed as an open risk in docs/governance/risk-register.md.
 */

export type PiiType = "EMAIL" | "SSN" | "CARD" | "PHONE" | "IPV4";

/** Placeholder -> original value. Lives only in memory for one LLM call. */
export type PiiVault = Map<string, string>;

export type RedactionResult = {
  text: string;
  /** How many distinct values of each type were replaced. Safe to log - no values. */
  counts: Partial<Record<PiiType, number>>;
};

type Detector = { type: PiiType; pattern: RegExp; accept?: (match: string) => boolean };

function luhnValid(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// Order matters: more specific shapes run first so e.g. an SSN is never
// half-consumed by the phone pattern.
const DETECTORS: Detector[] = [
  { type: "EMAIL", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { type: "SSN", pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Leading 3-6 = the card networks (Amex/Visa/MC/Discover). Without it, epoch
  // millisecond timestamps (13 digits, leading 1) pass Luhn about 10% of the time.
  { type: "CARD", pattern: /\b[3-6](?:[ -]?\d){12,18}\b/g, accept: luhnValid },
  {
    type: "PHONE",
    // Requires separators (or a +1 prefix) between groups - a bare 10-digit
    // run is far more likely to be an ID in this domain than a phone number.
    pattern: /(?:\+1[\s.-]?)?(?:\(\d{3}\)\s?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g,
  },
  {
    type: "IPV4",
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    accept: (m) => m.split(".").every((o) => Number(o) <= 255),
  },
];

/**
 * Replace PII in `text` with placeholders, recording each mapping in `vault`.
 * Pass the same vault for every string in one request (system + prompt) so
 * the same value gets the same placeholder everywhere.
 */
export function redactPii(text: string, vault: PiiVault): RedactionResult {
  const counts: Partial<Record<PiiType, number>> = {};
  const byValue = new Map<string, string>();
  for (const [token, value] of vault) byValue.set(value, token);

  let out = text;
  for (const { type, pattern, accept } of DETECTORS) {
    out = out.replace(pattern, (match) => {
      if (accept && !accept(match)) return match;
      const existing = byValue.get(match);
      if (existing) return existing;
      const n = [...vault.keys()].filter((k) => k.startsWith(`[${type}_`)).length + 1;
      const token = `[${type}_${n}]`;
      vault.set(token, match);
      byValue.set(match, token);
      counts[type] = (counts[type] ?? 0) + 1;
      return token;
    });
  }
  return { text: out, counts };
}

/** Put original values back into model output. Unknown placeholders are left as-is. */
export function restorePii(text: string, vault: PiiVault): string {
  if (vault.size === 0) return text;
  return text.replace(/\[(?:EMAIL|SSN|CARD|PHONE|IPV4)_\d+\]/g, (token) => vault.get(token) ?? token);
}

/** Sum two count maps - system and prompt are redacted separately but reported together. */
export function mergeCounts(
  a: Partial<Record<PiiType, number>>,
  b: Partial<Record<PiiType, number>>,
): Partial<Record<PiiType, number>> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b) as [PiiType, number][]) out[k] = (out[k] ?? 0) + v;
  return out;
}
