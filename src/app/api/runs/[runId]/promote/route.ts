import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { isAdmin, isPromoteAdmin } from "@/lib/admins";
import type { RunRow } from "@/lib/pipeline/types";
import { apiError } from "@/lib/api-error";

/**
 * POST: an admin promotes an already-approved run into the cross-run
 * curated set — tier 2 of the two-tier curation model (see db/schema.sql).
 * Body: { "adminName": string }.
 *
 * Promotion requires prior approval - enforced HERE, not as a CHECK
 * constraint, per db/schema.sql's own comment on why: "worth keeping"
 * (approved) and "worth surfacing more broadly" (promoted) are two
 * different judgment calls, and a run that skipped the first was never
 * looked at closely enough to deserve the second.
 *
 * Gated by isPromoteAdmin, not just isAdmin: settings.promote_admins (the
 * "Hero Agents" roster, D64) can narrow WHO among the admins may promote,
 * separately from who may merely approve - see admins.ts.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const body = await req.json().catch(() => null);
  const adminName = typeof body?.adminName === "string" ? body.adminName.trim() : "";
  if (!adminName) {
    return apiError('Body must include "adminName".', "VALIDATION_ERROR", 400);
  }
  if (!isAdmin(adminName)) {
    return apiError(`"${adminName}" is not in ADMIN_NAMES.`, "FORBIDDEN", 403);
  }
  if (!(await isPromoteAdmin(adminName))) {
    return apiError(`"${adminName}" is not on the promote_admins roster.`, "FORBIDDEN", 403);
  }

  const [run] = await query<RunRow>(`SELECT * FROM runs WHERE run_id = $1`, [runId]);
  if (!run) {
    return apiError(`No run found for run_id ${runId}.`, "NOT_FOUND", 404);
  }
  if (!run.approved) {
    return apiError(
      `Run ${runId} has not been approved yet — approve it before promoting.`,
      "VALIDATION_ERROR",
      400,
    );
  }

  const [updated] = await query<RunRow>(
    `UPDATE runs SET promoted = true, promoted_by = $2, promoted_at = NOW()
     WHERE run_id = $1 RETURNING *`,
    [runId, adminName],
  );
  return NextResponse.json({ run: updated });
}
