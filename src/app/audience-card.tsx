"use client";

import { useEffect, useState } from "react";
import type { SegmentSizeEstimate } from "@/lib/agents/audience/aep";

/**
 * What the audience card shows, derived from an Audience Creation task_run's
 * output + metadata. Pure so the rules live in one tested place:
 * - the Demo label is shown exactly as the agent set it (null in Governed);
 * - the segment is the audience that actually exists for THIS request -
 *   output.audience (created, or an existing one with the identical rule).
 *   Runs from before output.audience fall back to the old metadata, where
 *   existingSegment meant a name match;
 * - a size is only ever a real count from AEP, otherwise the agent's own
 *   reason. Never a fabricated zero. A `pending` size carries the evaluation
 *   job the card polls until the count lands.
 */
export type AudienceCardView = {
  label: string | null;
  segment: { id: string; name: string; source: "created" | "existing" } | null;
  interpretation: string | null;
  rule: string | null;
  size: { kind: "count"; text: string } | { kind: "unavailable"; text: string };
  pending: { jobId: string; segmentId: string; sandbox: string | null } | null;
};

type AudienceLike = {
  segmentId?: string;
  name?: string;
  source?: string;
  pql?: string;
  interpretation?: string | null;
};
type AudienceOutputLike = { label?: unknown; sizeEstimate?: unknown; audience?: AudienceLike | null };
type AudienceMetadataLike = {
  segmentCreation?: { created?: boolean; segmentId?: string; name?: string } | null;
  existingSegment?: { id?: string | null; name?: string | null } | null;
  pqlSynthesis?: { pql?: string | null; interpretation?: string | null } | null;
};

export function sizeView(estimate: SegmentSizeEstimate): AudienceCardView["size"] {
  return estimate.available
    ? { kind: "count", text: `${estimate.count.toLocaleString()} profiles` }
    : { kind: "unavailable", text: estimate.pending ? `Counting… ${estimate.reason}` : `Size not available: ${estimate.reason}` };
}

export function describeAudience(output: unknown, metadata: unknown): AudienceCardView | null {
  const out = (output ?? {}) as AudienceOutputLike;
  const estimate = out.sizeEstimate as SegmentSizeEstimate | undefined;
  // Older runs predate sizeEstimate - render nothing rather than a half card.
  if (!estimate || typeof estimate !== "object" || !("available" in estimate)) return null;

  const meta = (metadata ?? {}) as AudienceMetadataLike;
  let segment: AudienceCardView["segment"] = null;
  if ("audience" in out) {
    const a = out.audience;
    segment = a?.segmentId
      ? { id: a.segmentId, name: a.name || a.segmentId, source: a.source === "created" ? "created" : "existing" }
      : null;
  } else {
    const created = meta.segmentCreation?.created && meta.segmentCreation.segmentId ? meta.segmentCreation : null;
    const existing = meta.existingSegment?.id ? meta.existingSegment : null;
    segment = created
      ? { id: created.segmentId!, name: created.name ?? created.segmentId!, source: "created" }
      : existing
        ? { id: existing.id!, name: existing.name ?? existing.id!, source: "existing" }
        : null;
  }

  return {
    label: typeof out.label === "string" && out.label ? out.label : null,
    segment,
    interpretation: out.audience?.interpretation ?? meta.pqlSynthesis?.interpretation ?? null,
    rule: out.audience?.pql ?? meta.pqlSynthesis?.pql ?? null,
    size: sizeView(estimate),
    pending: !estimate.available && estimate.pending ? estimate.pending : null,
  };
}

const POLL_MS = 15_000;

/** Poll /api/audience-size while AEP is still counting; stops on a count or a failure. */
function useLiveSize(initial: AudienceCardView["size"], pending: AudienceCardView["pending"]) {
  const [size, setSize] = useState(initial);
  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    const qs = new URLSearchParams({ jobId: pending.jobId, segmentId: pending.segmentId, ...(pending.sandbox ? { sandbox: pending.sandbox } : {}) });
    const tick = async () => {
      try {
        const res = await fetch(`/api/audience-size?${qs}`);
        const estimate = (await res.json()) as SegmentSizeEstimate;
        if (stopped || !res.ok) return;
        setSize(sizeView(estimate));
        if (estimate.available || !estimate.pending) stopped = true;
      } catch {
        // transient - try again next tick
      }
    };
    const timer = setInterval(() => { if (stopped) clearInterval(timer); else void tick(); }, POLL_MS);
    void tick();
    return () => { stopped = true; clearInterval(timer); };
  }, [pending]);
  return size;
}

export function AudienceCard({ output, metadata }: { output: unknown; metadata: unknown }) {
  const view = describeAudience(output, metadata);
  const size = useLiveSize(view?.size ?? { kind: "unavailable", text: "" }, view?.pending ?? null);
  if (!view) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2">
        <span className="font-medium text-black dark:text-zinc-50">Audience</span>
        {view.label && <DemoPill text={view.label} />}
      </div>
      <p className="text-zinc-600 dark:text-zinc-400">
        {view.segment ? (
          <>
            <span className="text-black dark:text-zinc-50">{view.segment.name}</span>{" "}
            <span className="font-mono text-zinc-400">{view.segment.id.slice(0, 8)}</span>{" "}
            · {view.segment.source === "created" ? "created in AEP this run" : "existing audience with the same rule"}
          </>
        ) : (
          "No audience created."
        )}
      </p>
      {view.interpretation && <p className="text-black dark:text-zinc-50">{view.interpretation}</p>}
      {view.rule && (
        <p className="break-all font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{view.rule}</p>
      )}
      <p className={size.kind === "count" ? "font-medium text-black dark:text-zinc-50" : "text-zinc-500 dark:text-zinc-400"}>
        {size.text}
      </p>
    </div>
  );
}

export function DemoPill({ text }: { text: string }) {
  return (
    <span className="rounded-full border border-amber-400 bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
      {text}
    </span>
  );
}
