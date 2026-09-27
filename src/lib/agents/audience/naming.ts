/**
 * How an audience is named in Adobe Experience Platform:
 *
 *   CB | <who the audience is> | <Mon YYYY>
 *   CB | SEP Eligible Without SEP | Sep 2026
 *
 * A fixed structure an executive can read at a glance - which business, who
 * is in it, when it was built - replacing "Demo: <name> · <run id>", whose
 * random suffix only existed to keep names unique. An audience with an
 * identical rule is reused rather than recreated (findSegmentWithRule), so
 * a clash now only happens when two different audiences get the same title
 * in the same month - and the second is then "(2)", not a random string.
 *
 * Pure, so the pipeline and the Audience Studio screen share one definition.
 */

export const NAME_PREFIX = "CB";
const SEPARATOR = " | ";
const TITLE_MAX = 48;

/** "Sep 2026" - UTC, so the name doesn't depend on the server's time zone. */
export function namePeriod(when: Date = new Date()): string {
  return when.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * The middle of the name: the model's proposed title, cleaned of anything the
 * structure already says or that doesn't belong in a name - "Demo", a leading
 * "CB", dates, run ids, separators.
 */
export function audienceTitle(suggested: string | null | undefined, fallback: string): string {
  const clean = (text: string) =>
    text
      .replace(/\|/g, " ")
      .replace(/\bdemo\b:?/gi, " ")
      .replace(/·\s*[0-9a-f]{8}\b/gi, " ")
      .replace(/\b(19|20)\d{2}\b/g, " ")
      .replace(/^\s*(CB\b|Comcast Business\b)\s*[-:–—]?\s*/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[-–—,:;\s]+|[-–—,:;\s]+$/g, "");
  const title = clean(suggested ?? "") || clean(fallback) || "Custom Audience";
  if (title.length <= TITLE_MAX) return title;
  const cut = title.slice(0, TITLE_MAX + 1);
  return (cut.includes(" ") ? cut.slice(0, cut.lastIndexOf(" ")) : cut.slice(0, TITLE_MAX)).replace(/[,;:\s]+$/, "");
}

export function structuredName(title: string, when: Date = new Date()): string {
  return [NAME_PREFIX, title, namePeriod(when)].join(SEPARATOR);
}

/**
 * The structured name, with "(2)", "(3)"... on the title when a different
 * audience already has it: "CB | SEP Upsell (2) | Sep 2026". Case-insensitive,
 * as people read it.
 */
export function uniqueStructuredName(title: string, taken: Iterable<string>, when: Date = new Date()): string {
  const used = new Set([...taken].map((n) => n.trim().toLowerCase()));
  for (let n = 1; n < 100; n++) {
    const name = structuredName(n === 1 ? title : `${title} (${n})`, when);
    if (!used.has(name.toLowerCase())) return name;
  }
  return structuredName(`${title} (${used.size + 1})`, when);
}

/** The three parts of a structured name, for display; null for older names that don't follow it. */
export function parseStructuredName(name: string): { prefix: string; title: string; period: string } | null {
  const parts = name.split(SEPARATOR);
  if (parts.length !== 3 || parts[0] !== NAME_PREFIX || !/^[A-Z][a-z]{2} \d{4}$/.test(parts[2])) return null;
  return { prefix: parts[0], title: parts[1], period: parts[2] };
}
