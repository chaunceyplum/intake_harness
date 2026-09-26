import { NextRequest, NextResponse } from "next/server";
import { readSegmentSize } from "@/lib/agents/audience/aep";
import { apiError } from "@/lib/api-error";

/**
 * The audience card's follow-up read for a size Audience Creation handed
 * back as `pending`: evaluation jobs take a few minutes, longer than the
 * step waits, so the card polls here with the job the step started until
 * the count (or a failure) comes back. Read-only - it only reads the job.
 *
 * Runs under Audience Creation's own tool allowlist, since it finishes that
 * agent's read.
 */
const ID = /^[A-Za-z0-9-]{6,64}$/;
const SANDBOX = /^[a-z0-9_-]{1,64}$/;

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const jobId = q.get("jobId") ?? "";
  const segmentId = q.get("segmentId") ?? "";
  const sandbox = q.get("sandbox") || undefined;
  if (!ID.test(jobId) || !ID.test(segmentId) || (sandbox && !SANDBOX.test(sandbox))) {
    return apiError("jobId and segmentId are required", "VALIDATION_ERROR", 400);
  }
  return NextResponse.json(await readSegmentSize("audience_creation", jobId, segmentId, sandbox));
}
