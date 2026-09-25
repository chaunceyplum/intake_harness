/**
 * Append-only audit trail for actions that matter to a reviewer or regulator:
 * every LLM call (what left the building, how much PII was stripped from it)
 * and every human decision at the approval gate (who let the next agent run).
 *
 * WHY NOT task_runs: task_runs is operational history - it is cascaded away
 * when a run is deleted and holds full inputs/outputs. The audit log is the
 * opposite on both counts: it outlives the runs it describes, and it never
 * holds payloads, only a SHA-256 of what was sent, so it can be retained for a
 * year without itself becoming a store of customer data. db/schema.sql blocks
 * UPDATE and early DELETE on the table with a trigger.
 *
 * BEST-EFFORT BY DESIGN: a failed audit insert is logged and swallowed. The
 * alternative - failing the run because the audit DB hiccupped - would make
 * the audit log an availability risk for the pipeline. This is listed as an
 * accepted risk (R6) in docs/governance/risk-register.md.
 */

import { createHash } from "node:crypto";
import { query } from "@/lib/db";

export type AuditAction =
  | "llm.complete"
  | "llm.error"
  | "approval_gate.continue";

export type AuditEvent = {
  action: AuditAction;
  /** Named human, or "system" for automated actions. */
  actor: string;
  runId?: string | null;
  taskId?: string | null;
  model?: string | null;
  /** SHA-256 of the exact (already-redacted) payload sent. Never the payload itself. */
  inputSha256?: string | null;
  /** Counts, outcomes, ids - never raw text. */
  details?: Record<string, unknown>;
};

export type AuditSink = (event: AuditEvent) => Promise<void>;

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export const recordAuditEvent: AuditSink = async (event) => {
  try {
    await query(
      `INSERT INTO audit_events (action, actor, run_id, task_id, model, input_sha256, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        event.action,
        event.actor,
        event.runId ?? null,
        event.taskId ?? null,
        event.model ?? null,
        event.inputSha256 ?? null,
        JSON.stringify(event.details ?? {}),
      ],
    );
  } catch (err) {
    console.warn(`[audit] failed to record ${event.action}: ${(err as Error).message}`);
  }
};
