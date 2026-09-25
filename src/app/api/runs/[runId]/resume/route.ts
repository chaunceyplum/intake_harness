import { NextRequest, NextResponse } from "next/server";
import { resumeRun } from "@/lib/pipeline/orchestrator";
import { query } from "@/lib/db";
import type { TaskRunRow } from "@/lib/pipeline/types";
import { apiError } from "@/lib/api-error";
import { extractFromAnswer } from "@/lib/agents/intake/llm-extract";

/**
 * POST: answers a paused ("needs_input") run and re-runs the pipeline from
 * the step that paused. Body is { "answers": { <fieldKey>: <value>, ... } },
 * keyed by the `key` on each question the paused step asked for.
 *
 * Only Intake pauses today (see registry.ts / local/README.md), so this
 * merges the answers into intake's own { brief, loopCount, fields } output
 * shape rather than being a fully generic merge — widen this if a second
 * agent starts returning "needs_input".
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || typeof body.answers !== "object" || body.answers === null) {
    return apiError('Body must be { "answers": <object> }', "VALIDATION_ERROR", 400);
  }

  const [pausedTaskRun] = await query<TaskRunRow>(
    `SELECT * FROM task_runs WHERE run_id = $1 AND status = 'needs_input'
     ORDER BY step_index DESC, task_run_id DESC LIMIT 1`,
    [runId],
  );
  if (!pausedTaskRun) {
    return apiError(`Run ${runId} has no paused step to answer.`, "VALIDATION_ERROR", 400);
  }

  const pausedOutput = (pausedTaskRun.output ?? {}) as {
    brief?: string;
    loopCount?: number;
    fields?: Record<string, unknown>;
    questions?: { key: string; label: string }[];
    mode?: string;
  };
  const typedAnswers = body.answers as Record<string, unknown>;

  // LLM enrichment: read the marketer's free-text answer(s) for OTHER fields
  // they happened to state in the same breath, so one reply can satisfy
  // several pending questions instead of only the one asked (closing the B1
  // loop - see llm-extract.ts's extractFromAnswer). This is best-effort and
  // LAYERS UNDER the typed answers: the human's explicit answer always wins,
  // the model only fills gaps. No LLM / any failure -> empty, so the merge
  // below is exactly today's literal merge. Only the free-text answer values
  // are mined, not the field keys.
  const answerText = Object.values(typedAnswers)
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .join(". ");
  const enrichment = await extractFromAnswer(answerText, pausedOutput.questions ?? []);

  // Precedence: existing confirmed fields < LLM enrichment < this round's typed
  // answers. The typed answers are the human speaking directly and win outright.
  const mergedFields = {
    ...(pausedOutput.fields ?? {}),
    ...enrichment.known,
    ...typedAnswers,
  };

  // An empty answer merges in as an empty string, which still counts as
  // missing next round — the round just gets spent for nothing, and enough
  // of those trip the loop-count escalation for no real reason. Reject it
  // here rather than relying on every caller's own client-side validation.
  const stillBlank = (pausedOutput.questions ?? []).filter(
    (q) => String(mergedFields[q.key] ?? "").trim() === "",
  );
  if (stillBlank.length) {
    return apiError(
      `Still blank: ${stillBlank.map((q) => q.label).join(", ")}. Answer every asked question before resuming.`,
      "VALIDATION_ERROR",
      400,
    );
  }

  // mode must survive the pause: Intake defaults a missing mode to
  // "governed", so dropping it here would resume a Demo run as Governed and
  // file the real Workfront request Demo mode promises never to file.
  const resumedInput = {
    brief: pausedOutput.brief,
    loopCount: pausedOutput.loopCount,
    fields: mergedFields,
    ...(pausedOutput.mode === "demo" ? { mode: "demo" } : {}),
  };

  const baseUrl = req.nextUrl.origin;
  try {
    const run = await resumeRun(runId, resumedInput, baseUrl);
    return NextResponse.json({ run });
  } catch (err) {
    return apiError((err as Error).message, "INTERNAL_ERROR", 500);
  }
}
