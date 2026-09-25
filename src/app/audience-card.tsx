import type { SegmentSizeEstimate } from "@/lib/agents/audience/aep";

/**
 * What the audience card shows, derived from an Audience Creation task_run's
 * output + metadata. Pure so the rules live in one tested place:
 * - the Demo label is shown exactly as the agent set it (null in Governed);
 * - the segment is whichever one actually exists - one Agent 3 created, else
 *   the existing match it found - and null when neither does;
 * - a size is only ever a real count from the tool, otherwise the agent's own
 *   "not available" reason. Never a fabricated zero.
 */
export type AudienceCardView = {
  label: string | null;
  segment: { id: string; name: string; source: "created" | "existing" } | null;
  size: { kind: "count"; text: string } | { kind: "unavailable"; text: string };
};

type AudienceOutputLike = { label?: unknown; sizeEstimate?: unknown };
type AudienceMetadataLike = {
  segmentCreation?: { created?: boolean; segmentId?: string; name?: string } | null;
  existingSegment?: { id?: string | null; name?: string | null } | null;
};

export function describeAudience(output: unknown, metadata: unknown): AudienceCardView | null {
  const out = (output ?? {}) as AudienceOutputLike;
  const estimate = out.sizeEstimate as SegmentSizeEstimate | undefined;
  // Older runs predate sizeEstimate - render nothing rather than a half card.
  if (!estimate || typeof estimate !== "object" || !("available" in estimate)) return null;

  const meta = (metadata ?? {}) as AudienceMetadataLike;
  const created = meta.segmentCreation?.created && meta.segmentCreation.segmentId ? meta.segmentCreation : null;
  const existing = meta.existingSegment?.id ? meta.existingSegment : null;
  const segment = created
    ? { id: created.segmentId!, name: created.name ?? created.segmentId!, source: "created" as const }
    : existing
      ? { id: existing.id!, name: existing.name ?? existing.id!, source: "existing" as const }
      : null;

  return {
    label: typeof out.label === "string" && out.label ? out.label : null,
    segment,
    size: estimate.available
      ? { kind: "count", text: `${estimate.count.toLocaleString()} profiles (estimated)` }
      : { kind: "unavailable", text: `Size available after next evaluation (${estimate.reason})` },
  };
}

export function AudienceCard({ output, metadata }: { output: unknown; metadata: unknown }) {
  const view = describeAudience(output, metadata);
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
            · {view.segment.source === "created" ? "created this run" : "existing segment reused"}
          </>
        ) : (
          "No segment built yet."
        )}
      </p>
      <p className={view.size.kind === "count" ? "text-black dark:text-zinc-50" : "text-zinc-500 dark:text-zinc-400"}>
        {view.size.text}
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
