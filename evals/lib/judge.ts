/**
 * LLM-as-judge for the eval outputs that don't reduce to a string/structural
 * comparison - "is this PQL expression the right logic," "is this rejection
 * explanation clear and correctly targeted." Structural checks (does the
 * field match, is the fieldKey right) stay structural; this is only for the
 * remainder.
 *
 * Reuses extractJsonObject (src/lib/agents/review/llm-triage.ts) for the
 * fenced/prose-tolerant JSON parse rather than writing a fourth copy of that
 * same little parser.
 */

import type { LlmClient } from "@/lib/llm";
import { extractJsonObject } from "@/lib/agents/review/llm-triage";

export type JudgeResult = {
  pass: boolean;
  reasoning: string;
};

const JUDGE_SYSTEM = [
  "You are grading one AI agent's output against a rubric, for an eval suite.",
  "Be strict but fair: pass only if the answer genuinely satisfies the rubric.",
  "Return ONLY JSON.",
].join("\n");

export async function judge(
  client: LlmClient,
  question: string,
  rubric: string,
  answer: string,
): Promise<JudgeResult> {
  const completion = await client.complete({
    system: JUDGE_SYSTEM,
    prompt: [
      `Question/task given to the agent being graded: ${question}`,
      "",
      `Rubric: ${rubric}`,
      "",
      `The agent's answer: ${answer}`,
      "",
      'Respond with JSON: { "pass": boolean, "reasoning": "one or two sentences" }',
    ].join("\n"),
    temperature: 0,
    maxTokens: 300,
  });

  const parsed = extractJsonObject(completion.text) as { pass?: unknown; reasoning?: unknown };
  if (typeof parsed.pass !== "boolean") {
    throw new Error("judge: LLM response missing a boolean `pass`");
  }
  return {
    pass: parsed.pass,
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
  };
}
