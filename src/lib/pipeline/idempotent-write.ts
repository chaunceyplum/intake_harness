/**
 * The shared "did we already do this, for this exact run, before" check
 * behind every idempotent write in the pipeline.
 *
 * THE SHAPE, ONCE, INSTEAD OF TWICE: intake/workfront.ts's findPriorSuccess
 * (guards Agent 1 re-creating a Workfront issue on retry) and
 * orchestrator.ts's advanceOneStep (guards re-posting an agent's Workfront
 * comment on retry) both need the identical query - a prior task_runs row
 * for this run_id/task_id, read back so the caller can decide whether to
 * reuse it instead of writing again. audience/attribute-requests.ts predates
 * this and has its own find-or-open pattern against a different table
 * (attribute_requests, not task_runs) - not migrated here, since its shape
 * genuinely differs (it opens/reuses a request, it doesn't reuse a WRITE's
 * recorded outcome).
 *
 * FAILS OPEN, ALWAYS: every caller of this exists to guard a write that must
 * still happen when the guard itself is broken. A query error here returns
 * `null` - proceed as if no prior attempt existed - never a thrown error
 * that would block a legitimate write.
 */

import { query } from "@/lib/db";

export interface PriorTaskRun<TOutput = unknown> {
  status: string;
  input: unknown;
  output: TOutput | null;
  metadata: Record<string, unknown> | null;
}

/**
 * The most recent task_runs row for (runId, taskId) whose status is one of
 * `statuses`, optionally narrowed to one `stepIndex` (for a step that can
 * recur at different indices only in principle - Intake, for example, is
 * always step 0, so its own caller omits this). `null` when none matches, or
 * when the lookup itself failed.
 *
 * `input` travels with the row specifically so a caller guarding a per-step
 * write (orchestrator.ts's Workfront-comment post) can tell a genuine
 * crash-retry of THIS invocation (identical input) from a second, distinct
 * round that happens to land on the same run/task/step/status - Intake's
 * needs_input loop re-enters at the same step_index every round, and two
 * different rounds are not the same event just because both paused.
 */
export async function findPriorTaskRun<TOutput = unknown>(
  runId: string,
  taskId: string,
  statuses: string[],
  stepIndex?: number,
): Promise<PriorTaskRun<TOutput> | null> {
  try {
    const rows = await query<PriorTaskRun<TOutput>>(
      stepIndex === undefined
        ? `SELECT status, input, output, metadata FROM task_runs
           WHERE run_id = $1 AND task_id = $2 AND status = ANY($3::text[])
           ORDER BY task_run_id DESC LIMIT 1`
        : `SELECT status, input, output, metadata FROM task_runs
           WHERE run_id = $1 AND task_id = $2 AND status = ANY($3::text[]) AND step_index = $4
           ORDER BY task_run_id DESC LIMIT 1`,
      stepIndex === undefined ? [runId, taskId, statuses] : [runId, taskId, statuses, stepIndex],
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}
