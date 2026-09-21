/**
 * Eval for Agent 1's LLM extraction path (extractIntake / extractFromAnswer,
 * src/lib/agents/intake/llm-extract.ts) - run manually with `npm run
 * eval:intake` against whichever LLM_PROVIDER is configured in .env.local.
 *
 * Grading is entirely structural (field-value match, provenance match,
 * substring presence/absence) - no LLM judge needed here, since "does this
 * field's provenance match parse.ts's own CUES-table definition of
 * stated/derived/inferred" already reduces to a plain comparison. See
 * evals/README.md for how to add a fixture.
 */

import { describe, it, expect, afterAll } from "vitest";
import { isLlmConfigured } from "@/lib/llm";
import { extractIntake, extractFromAnswer } from "@/lib/agents/intake/llm-extract";
import { loadFixtures } from "./lib/fixtures";
import { report, type EvalOutcome } from "./lib/report";

type IntakeFixture = {
  id: string;
  brief: string;
  known?: Record<string, string>;
  expected: {
    fields?: Record<string, string>;
    stated?: string[];
    inferred?: string[];
  };
  mustContain?: Record<string, string[]>;
  mustNotContain?: Record<string, string[]>;
};

type AnswerFixture = {
  id: string;
  answerText: string;
  pendingQuestions: Array<{ key: string; label: string }>;
  expected: { fields?: Record<string, string> };
  mustContain?: Record<string, string[]>;
  mustNotContain?: Record<string, string[]>;
};

const results: EvalOutcome[] = [];
afterAll(() => report("Intake (extractIntake / extractFromAnswer)", results));

/** Loose match for free-text fields: case-insensitive, either side containing the other. */
function fieldMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const a = actual.toLowerCase().trim();
  const e = expected.toLowerCase().trim();
  return a === e || a.includes(e) || e.includes(a);
}

describe.skipIf(!isLlmConfigured())("Intake extraction eval", () => {
  const fixtures = loadFixtures<IntakeFixture>("intake");

  it.each(fixtures)("$id", async (fixture) => {
    const notes: string[] = [];
    let ok = true;

    const extraction = await extractIntake(fixture.brief, fixture.known ?? {});
    if (extraction.source !== "llm") {
      notes.push(`fell back to deterministic (${extraction.fallbackReason ?? "no reason given"})`);
      results.push({ id: fixture.id, passed: false, notes: notes.join("; ") });
      expect.soft(extraction.source, notes.join("; ")).toBe("llm");
      return;
    }

    for (const [key, expectedValue] of Object.entries(fixture.expected.fields ?? {})) {
      const actual = extraction.parsed.fields[key];
      if (!fieldMatches(actual, expectedValue)) {
        ok = false;
        notes.push(`${key}: expected ~"${expectedValue}", got "${actual ?? "(missing)"}"`);
      }
    }

    const provenanceOf = (key: string) => extraction.parsed.extracted.find((f) => f.key === key)?.from;
    for (const key of fixture.expected.stated ?? []) {
      const from = provenanceOf(key);
      if (from !== "stated") {
        ok = false;
        notes.push(`${key}: expected provenance "stated", got "${from ?? "(not extracted)"}"`);
      }
    }
    for (const key of fixture.expected.inferred ?? []) {
      const from = provenanceOf(key);
      if (from !== "derived" && from !== "inferred") {
        ok = false;
        notes.push(`${key}: expected provenance "derived"/"inferred", got "${from ?? "(not extracted)"}"`);
      }
    }

    for (const [key, mustHave] of Object.entries(fixture.mustContain ?? {})) {
      const actual = (extraction.parsed.fields[key] ?? "").toLowerCase();
      for (const needle of mustHave) {
        if (!actual.includes(needle.toLowerCase())) {
          ok = false;
          notes.push(`${key}: expected to contain "${needle}", got "${actual || "(missing)"}"`);
        }
      }
    }
    for (const [key, mustNotHave] of Object.entries(fixture.mustNotContain ?? {})) {
      const actual = (extraction.parsed.fields[key] ?? "").toLowerCase();
      for (const needle of mustNotHave) {
        if (actual.includes(needle.toLowerCase())) {
          ok = false;
          notes.push(`${key}: must not contain "${needle}", got "${actual}"`);
        }
      }
    }

    results.push({ id: fixture.id, passed: ok, notes: notes.join("; ") });
    expect.soft(ok, notes.join("; ")).toBe(true);
  });
});

describe.skipIf(!isLlmConfigured())("Intake answer-inference eval (extractFromAnswer)", () => {
  const fixtures = loadFixtures<AnswerFixture>("intake-answer");

  it.each(fixtures)("$id", async (fixture) => {
    const notes: string[] = [];
    let ok = true;

    const enrichment = await extractFromAnswer(fixture.answerText, fixture.pendingQuestions);
    if (enrichment.source !== "llm") {
      notes.push("fell back to deterministic (no LLM enrichment)");
      results.push({ id: fixture.id, passed: false, notes: notes.join("; ") });
      expect.soft(enrichment.source, notes.join("; ")).toBe("llm");
      return;
    }

    for (const [key, expectedValue] of Object.entries(fixture.expected.fields ?? {})) {
      const actual = enrichment.known[key];
      if (!fieldMatches(actual, expectedValue)) {
        ok = false;
        notes.push(`${key}: expected ~"${expectedValue}", got "${actual ?? "(missing)"}"`);
      }
    }
    for (const [key, mustHave] of Object.entries(fixture.mustContain ?? {})) {
      const actual = (enrichment.known[key] ?? "").toLowerCase();
      for (const needle of mustHave) {
        if (!actual.includes(needle.toLowerCase())) {
          ok = false;
          notes.push(`${key}: expected to contain "${needle}", got "${actual || "(missing)"}"`);
        }
      }
    }
    for (const [key, mustNotHave] of Object.entries(fixture.mustNotContain ?? {})) {
      const actual = (enrichment.known[key] ?? "").toLowerCase();
      for (const needle of mustNotHave) {
        if (actual.includes(needle.toLowerCase())) {
          ok = false;
          notes.push(`${key}: must not contain "${needle}", got "${actual}"`);
        }
      }
    }

    results.push({ id: fixture.id, passed: ok, notes: notes.join("; ") });
    expect.soft(ok, notes.join("; ")).toBe(true);
  });
});
