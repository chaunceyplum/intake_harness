import type { RunRow, TaskRunRow } from "@/lib/pipeline/types";
import type { SegmentSizeEstimate } from "@/lib/agents/audience/aep";
import { parseStructuredName } from "@/lib/agents/audience/naming";

/**
 * What the executive-facing Audience Studio shows for a run, derived from the
 * same run rows the workbench reads - pure, so every rule lives in one tested
 * place and the screen stays a thin view over it.
 *
 * The studio deliberately says less than the workbench: no agent names, no
 * tool calls, no PQL. It answers "is it working, did it work, what did I
 * get" - and a failure is said plainly, never dressed up as success. The full
 * trace stays one click away in Developer mode.
 */

export type RunDetail = { run: RunRow; taskRuns: TaskRunRow[] };

/** The three things the pipeline visibly does, in the words an executive would use. */
export const STAGES = ["Understanding your request", "Checking customer data", "Building your audience"] as const;

const STAGE_OF_TASK: Record<string, number> = { intake: 0, review: 1, audience_creation: 2 };

/**
 * Which stage is in progress: the agent the live feed says is running, or
 * else the one after the last finished step. Never goes backwards.
 */
export function currentStage(taskRuns: TaskRunRow[], liveTaskId: string | null): number {
  const done = taskRuns.filter((t) => t.status === "completed").map((t) => STAGE_OF_TASK[t.task_id] ?? 0);
  const fromDone = done.length ? Math.min(Math.max(...done) + 1, STAGES.length - 1) : 0;
  const fromLive = liveTaskId != null && liveTaskId in STAGE_OF_TASK ? STAGE_OF_TASK[liveTaskId] : 0;
  return Math.max(fromDone, fromLive);
}

export type PendingQuestion = { key: string; label: string; ask: string | null; options: string[] | null };

export type AudienceSummary = {
  /** Who the audience is - the middle of "CB | <title> | Sep 2026", or an older name cleaned up. */
  displayName: string;
  /** When the name says it was built ("Sep 2026"); null for names from before the structure. */
  period: string | null;
  /** The exact name in Adobe Experience Platform. */
  aepName: string;
  id: string;
  /** An existing audience with the identical rule was reused rather than duplicated. */
  reused: boolean;
  interpretation: string | null;
  rule: string | null;
  environment: string;
  demo: boolean;
  size: SizeView;
  /** Evaluation job to poll while AEP is still counting. */
  pending: { jobId: string; segmentId: string; sandbox: string | null } | null;
  builtAt: string;
};

export type Outcome =
  | { kind: "working"; stage: number }
  | { kind: "question"; questions: PendingQuestion[] }
  | { kind: "approval"; next: string }
  | { kind: "success"; audience: AudienceSummary }
  /** A verified rule exists but nothing was created (Governed mode, or a draft-only run). */
  | { kind: "defined"; interpretation: string | null; rule: string | null; note: string; size: SizeView | null }
  | { kind: "not_built"; reason: string }
  | { kind: "failed"; reason: string };

type AudienceOut = {
  audience?: {
    segmentId?: string;
    name?: string;
    source?: string;
    pql?: string;
    interpretation?: string | null;
    sandbox?: string | null;
  } | null;
  sizeEstimate?: SegmentSizeEstimate;
  label?: string | null;
  buildPath?: string;
};
type AudienceMeta = {
  pqlSynthesis?: { synthesized?: boolean; pql?: string | null; interpretation?: string | null; reason?: string | null } | null;
  segmentCreation?: { attempted?: boolean; created?: boolean; reason?: string | null } | null;
  mode?: string;
};

/**
 * "CB | SEP Eligible Without SEP | Sep 2026" -> "SEP Eligible Without SEP";
 * an older "Demo: Email + SEP Eligible · 53e13700" -> "Email + SEP Eligible".
 */
export function displayName(aepName: string): string {
  const structured = parseStructuredName(aepName);
  if (structured) return structured.title;
  return aepName.replace(/^Demo:\s*/i, "").replace(/\s*·\s*[0-9a-f]{8}$/i, "").trim() || aepName;
}

export type SizeView = { text: string; counted: boolean; estimated: boolean };

/** A size an executive can read: a real count (estimated or AEP's own), or plainly when it will be known. Never a made-up number. */
export function friendlySize(estimate: SegmentSizeEstimate | undefined): SizeView {
  if (!estimate) return { text: "Not yet available", counted: false, estimated: false };
  if (estimate.available) {
    return { text: `${estimate.count.toLocaleString()} profiles`, counted: true, estimated: !!estimate.estimated };
  }
  if (estimate.pending) return { text: "Counting now…", counted: false, estimated: false };
  if (/scheduled evaluation/i.test(estimate.reason)) return { text: "Counted in tonight's evaluation", counted: false, estimated: false };
  return { text: "Not yet available", counted: false, estimated: false };
}

/** Why no audience was built, in plain words. The raw reason stays in Developer mode. */
export function plainReason(out: AudienceOut, meta: AudienceMeta): string {
  if (out.buildPath === "fac") {
    return "This audience needs data held outside Adobe Experience Platform, so it goes to the federated data team instead.";
  }
  const why = `${meta.pqlSynthesis?.reason ?? ""} ${meta.segmentCreation?.reason ?? ""}`;
  if (/credit balance|LLM|synthesis failed|misconfigured|HTTP 5\d\d|timed? ?out/i.test(why)) {
    return "The audience builder is briefly unavailable. Please try again in a moment.";
  }
  if (/insufficient|not in the available|could not be verified|no concrete field/i.test(why)) {
    return "Part of this request doesn't match the customer data we hold. Try rephrasing it, or leave that condition out.";
  }
  if (meta.segmentCreation?.attempted && !meta.segmentCreation.created) {
    return "Adobe Experience Platform didn't accept this audience. Please try again, or rephrase the request.";
  }
  return "We couldn't build this audience. Try rephrasing the request.";
}

export function outcomeOf(detail: RunDetail, liveTaskId: string | null = null): Outcome {
  const { run, taskRuns } = detail;
  const last = taskRuns[taskRuns.length - 1];

  if (run.status === "running") return { kind: "working", stage: currentStage(taskRuns, liveTaskId) };

  if (run.status === "needs_input") {
    const questions = ((last?.output as { questions?: PendingQuestion[] } | null)?.questions ?? []).filter(Boolean);
    if (questions.length) return { kind: "question", questions };
    return { kind: "failed", reason: "This request needs a person to look at it. Please try again, or rephrase it." };
  }

  if (run.status === "awaiting_approval") {
    return { kind: "approval", next: STAGES[Math.min(run.current_step, STAGES.length - 1)] };
  }

  if (run.status === "failed") {
    return { kind: "failed", reason: "Something went wrong on our side. Please try again." };
  }

  const step = taskRuns.find((t) => t.task_id === "audience_creation");
  if (!step) return { kind: "failed", reason: "The audience step didn't run. Please try again." };
  const out = (step.output ?? {}) as AudienceOut;
  const meta = (step.metadata ?? {}) as AudienceMeta;

  const a = out.audience;
  if (a?.segmentId) {
    const aepName = a.name || a.segmentId;
    const sandbox = a.sandbox ?? null;
    const demo = meta.mode === "demo" || !!out.label;
    const estimate = out.sizeEstimate;
    return {
      kind: "success",
      audience: {
        displayName: displayName(aepName),
        period: parseStructuredName(aepName)?.period ?? null,
        aepName,
        id: a.segmentId,
        reused: a.source !== "created",
        interpretation: a.interpretation ?? meta.pqlSynthesis?.interpretation ?? null,
        rule: a.pql ?? null,
        environment: demo ? `Demo sandbox${sandbox ? ` (${sandbox})` : ""}` : sandbox ? `Sandbox ${sandbox}` : "Production",
        demo,
        size: friendlySize(estimate),
        pending: estimate && !estimate.available && estimate.pending ? estimate.pending : null,
        builtAt: step.finished_at || step.created_at,
      },
    };
  }

  if (meta.pqlSynthesis?.synthesized && meta.pqlSynthesis.pql) {
    return {
      kind: "defined",
      interpretation: meta.pqlSynthesis.interpretation ?? null,
      rule: meta.pqlSynthesis.pql,
      note:
        meta.mode === "demo"
          ? "Defined and verified - not created, as this was a preview."
          : "Defined and verified. It will be created once the request is approved.",
      size: out.sizeEstimate?.available ? friendlySize(out.sizeEstimate) : null,
    };
  }

  return { kind: "not_built", reason: plainReason(out, meta) };
}
