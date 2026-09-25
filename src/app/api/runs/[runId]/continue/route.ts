import { NextRequest, NextResponse } from "next/server";
import { continueRun } from "@/lib/pipeline/orchestrator";
import { apiError } from "@/lib/api-error";
import { isAdmin } from "@/lib/admins";
import { recordAuditEvent } from "@/lib/governance/audit";

/**
 * POST: the "approve" action for a run sitting in "awaiting_approval" —
 * runs exactly the next agent and stops again (or finishes, if that was
 * the last one). Body (optional): { "adminName"?: string }.
 *
 * Every attempt is written to audit_events with the approver's name, or
 * "unidentified" when none was sent. REQUIRE_NAMED_APPROVER=true makes a
 * name from ADMIN_NAMES mandatory - off by default because the pipeline
 * chat view doesn't have an admin picker yet (risk R3 in
 * docs/governance/risk-register.md).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const baseUrl = req.nextUrl.origin;
  const body = await req.json().catch(() => null);
  const adminName = typeof body?.adminName === "string" ? body.adminName.trim() : "";
  const requireNamed = process.env.REQUIRE_NAMED_APPROVER?.trim().toLowerCase() === "true";

  if (adminName && !isAdmin(adminName)) {
    return apiError(`"${adminName}" is not in ADMIN_NAMES.`, "FORBIDDEN", 403);
  }
  if (requireNamed && !adminName) {
    return apiError('REQUIRE_NAMED_APPROVER is on: body must include "adminName".', "FORBIDDEN", 403);
  }

  const actor = adminName || "unidentified";
  try {
    const run = await continueRun(runId, baseUrl);
    await recordAuditEvent({
      action: "approval_gate.continue",
      actor,
      runId,
      details: { outcome: "approved", resultingStatus: run.status, step: run.current_step },
    });
    return NextResponse.json({ run });
  } catch (err) {
    await recordAuditEvent({
      action: "approval_gate.continue",
      actor,
      runId,
      details: { outcome: "error", error: (err as Error).message.slice(0, 300) },
    });
    return apiError((err as Error).message, "INTERNAL_ERROR", 500);
  }
}
