"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { RunRow, TaskRunRow } from "@/lib/pipeline/types";
import { PIPELINE } from "@/lib/pipeline/registry";
import { StatusBadge } from "../status-badge";
import { ToolCallTrace, type ToolCallOutput } from "../tool-call-trace";
import { ToolCallLog, type ToolCallLogEntry } from "../tool-call-log";
import { LiveToolCallLog, type LiveToolCall } from "../live-tool-call-log";

type RunDetail = { run: RunRow; taskRuns: TaskRunRow[] };

/** Falls back to the raw task_id for a historical "escalation" row or the live poll's currentTaskId. */
function agentLabel(taskId: string): string {
  return PIPELINE.find((a) => a.name === taskId)?.label ?? taskId;
}

/** The shape intake's "needs_input" output puts under `questions` (see src/app/api/agents/intake/route.ts). */
type PendingQuestion = {
  key: string;
  label: string;
  ask: string | null;
  options: string[] | null;
  optionsPartial: boolean;
};

/**
 * The "see runs from the database" page. Lists every row in `runs`
 * (GET /api/runs) and, on selection, every task_runs row for it
 * (GET /api/runs/[runId]) — the same observability API the harness's
 * pipeline writes to, just browsable on its own rather than only
 * appearing right after you submit something.
 */
export function RunsBrowser({ initialRunId }: { initialRunId?: string }) {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialRunId ?? null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [resuming, setResuming] = useState(false);
  const [admins, setAdmins] = useState<string[]>([]);
  const [selectedAdmin, setSelectedAdmin] = useState("");
  const [approvalNote, setApprovalNote] = useState("");
  const [curating, setCurating] = useState(false);
  const [runningAgain, setRunningAgain] = useState(false);

  useEffect(() => {
    fetch("/api/admins")
      .then((res) => res.json())
      .then((data) => setAdmins(data.admins ?? []))
      .catch(() => {});
  }, []);

  const loadDetail = useCallback(async (runId: string) => {
    setSelectedRunId(runId);
    const res = await fetch(`/api/runs/${runId}`);
    if (!res.ok) {
      setError(`Failed to load run ${runId} (HTTP ${res.status}).`);
      return;
    }
    const data = (await res.json()) as RunDetail;
    setDetail(data);
    setAnswers({});
    setApprovalNote(data.run.approval_note ?? "");
  }, []);

  async function approveRun() {
    if (!selectedRunId || !selectedAdmin) return;
    setCurating(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${selectedRunId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminName: selectedAdmin, note: approvalNote }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Failed to approve run (HTTP ${res.status}).`);
        return;
      }
      await loadDetail(selectedRunId);
      await refresh();
    } finally {
      setCurating(false);
    }
  }

  /** Tier 2 of curation - see /api/runs/[runId]/promote/route.ts. Requires the run to already be approved. */
  async function promoteRun() {
    if (!selectedRunId || !selectedAdmin) return;
    setCurating(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${selectedRunId}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminName: selectedAdmin }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Failed to promote run (HTTP ${res.status}).`);
        return;
      }
      await loadDetail(selectedRunId);
      await refresh();
    } finally {
      setCurating(false);
    }
  }

  /**
   * Starts a brand-new run from this run's original input — the exact
   * submission, not a resume/retry of THIS run_id. Useful for checking
   * whether agent behavior changed since, without retyping the brief.
   */
  async function runAgain() {
    if (!detail) return;
    setRunningAgain(true);
    setError(null);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: detail.run.input }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Failed to start a new run (HTTP ${res.status}).`);
        return;
      }
      await loadDetail(data.run.run_id);
      await refresh();
    } finally {
      setRunningAgain(false);
    }
  }

  // The most recent task_run still waiting on a human, if the run is
  // currently paused — there's at most one, since the pipeline stops at the
  // first non-"completed" step.
  const pendingTaskRun = useMemo(() => {
    if (!detail || detail.run.status !== "needs_input") return null;
    const paused = detail.taskRuns.filter((tr) => tr.status === "needs_input");
    return paused[paused.length - 1] ?? null;
  }, [detail]);

  const pendingQuestions = useMemo(() => {
    const output = pendingTaskRun?.output as { questions?: PendingQuestion[] } | null | undefined;
    return output?.questions ?? [];
  }, [pendingTaskRun]);

  // An empty answer merges in as an empty string, which still counts as
  // missing on the next round — so this has to gate the button, not just
  // "some questions exist." Without it, submitting blank fields silently
  // re-asks the same questions until the loop limit escalates.
  const readyToSubmitAnswers = pendingQuestions.every((q) => (answers[q.key] ?? "").trim() !== "");

  const [advancing, setAdvancing] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const [liveCalls, setLiveCalls] = useState<LiveToolCall[]>([]);
  const [liveTaskId, setLiveTaskId] = useState<string | null>(null);
  const anyActionInFlight = resuming || advancing || retrying;

  /*
   * Poll GET /api/runs/[runId]/live while resuming/approving/retrying THIS
   * run is in flight - see pipeline-chat.tsx's identical effect and
   * live-tool-call-log.tsx / live-progress.ts for why. `runningAgain`
   * (Run again) is deliberately NOT included: it starts a brand-new run
   * with its own run_id, which this page doesn't learn until that whole
   * request returns - same limitation pipeline-chat.tsx's startRun has, for
   * the same reason.
   */
  useEffect(() => {
    // No synchronous setState on the "nothing in flight" branch, on
    // purpose - see pipeline-chat.tsx's identical effect for why (rendering
    // below is already gated on anyActionInFlight, and the first poll() of
    // a new action resolves near-instantly against a store orchestrator.ts
    // already reset fresh).
    if (!anyActionInFlight || !selectedRunId) return;
    const runId = selectedRunId;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/runs/${runId}/live`);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { calls: LiveToolCall[]; currentTaskId: string | null };
        if (cancelled) return;
        setLiveCalls(data.calls ?? []);
        setLiveTaskId(data.currentTaskId ?? null);
      } catch {
        // Best-effort - a failed poll just tries again next tick.
      }
    };
    poll();
    const interval = setInterval(poll, 500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [anyActionInFlight, selectedRunId]);

  async function retryStuck() {
    if (!selectedRunId) return;
    setRetrying(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${selectedRunId}/retry`, { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Failed to retry run (HTTP ${res.status}).`);
        return;
      }
      await loadDetail(selectedRunId);
      await refresh();
    } finally {
      setRetrying(false);
    }
  }

  async function approveNext() {
    if (!selectedRunId) return;
    setAdvancing(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${selectedRunId}/continue`, { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Failed to continue run (HTTP ${res.status}).`);
        return;
      }
      await loadDetail(selectedRunId);
      await refresh();
    } finally {
      setAdvancing(false);
    }
  }

  async function submitAnswers() {
    if (!selectedRunId) return;
    setResuming(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${selectedRunId}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        /*
         * A VALIDATION_ERROR here ("Still blank: ..." or "has no paused
         * step to answer") means the run moved on since THIS page loaded -
         * another tab, another person, or an earlier answer already
         * advanced it past whatever question is on screen, so the server
         * validated the submitted answers against a DIFFERENT, later
         * question than the one this form is showing. `readyToSubmitAnswers`
         * already keeps the button disabled until every question CURRENTLY
         * ON SCREEN is filled, so a VALIDATION_ERROR reaching here is
         * overwhelmingly this staleness case, not a genuinely-blank field.
         * Refetching shows what's actually current instead of leaving the
         * form stuck on a question that no longer applies - the exact bug
         * a real run hit (task_run 195's form, task_run 196 already the
         * real pending step).
         */
        const staleRun = data?.code === "VALIDATION_ERROR";
        if (staleRun) await loadDetail(selectedRunId);
        setError(
          (data?.error ?? `Failed to resume run (HTTP ${res.status}).`) +
            (staleRun
              ? " This run has moved on since you loaded it - refreshed to show the current step below."
              : ""),
        );
        return;
      }
      await loadDetail(selectedRunId);
      await refresh();
    } finally {
      setResuming(false);
    }
  }

  // Fetch-on-mount via the fetch's own callback, not by calling a
  // setState-holding function directly in the effect body, so a stale
  // response can't overwrite state after unmount.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/runs")
      .then(async (res) => {
        if (!res.ok) {
          if (!cancelled) {
            setError(`Failed to load runs (HTTP ${res.status}). Is DATABASE_URL set in .env.local?`);
          }
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          setRuns(data.runs ?? []);
          // Nothing to show in the detail panel otherwise - on a page this
          // wide, an empty "Select a run" message reads as broken rather
          // than idle. Only when there's no deep-linked run already taking
          // that slot.
          if (!initialRunId && data.runs?.length) {
            loadDetail(data.runs[0].run_id);
          }
        }
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadDetail is a stable useCallback; initialRunId doesn't change after mount.
  }, []);

  // Deep-link support for /runs/[runId]: load that run's detail on mount,
  // same inline-callback pattern as above rather than calling loadDetail
  // (a setState-holding function) directly from the effect.
  useEffect(() => {
    if (!initialRunId) return;
    let cancelled = false;
    fetch(`/api/runs/${initialRunId}`)
      .then(async (res) => {
        if (!res.ok) {
          if (!cancelled) setError(`Failed to load run ${initialRunId} (HTTP ${res.status}).`);
          return;
        }
        const data = (await res.json()) as RunDetail;
        if (!cancelled) {
          setDetail(data);
          setApprovalNote(data.run.approval_note ?? "");
        }
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [initialRunId]);

  async function refresh() {
    setError(null);
    const res = await fetch("/api/runs");
    if (!res.ok) {
      setError(`Failed to load runs (HTTP ${res.status}).`);
      return;
    }
    const data = await res.json();
    setRuns(data.runs ?? []);
  }

  return (
    <div className="flex max-w-7xl flex-col gap-6 px-4 py-6 sm:px-8 sm:py-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Runs</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Every pipeline invocation recorded in the <code className="text-xs">runs</code> table, most recent first.
          </p>
        </div>
        <button
          onClick={refresh}
          className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm text-zinc-700 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-600"
        >
          Refresh
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* A fixed-width run list plus a flexible detail panel, rather than a
          proportional 1:2 split - on a wide screen a fr-based ratio would
          stretch the run list (just short ids and badges) far wider than
          its content needs, at the expense of the detail panel. */}
      <div className="grid gap-6 sm:grid-cols-[280px_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-black dark:text-zinc-50">
            {loadingList ? "Loading…" : `${runs.length} run${runs.length === 1 ? "" : "s"}`}
          </h2>
          <ol className="flex flex-col gap-1">
            {runs.map((run) => (
              <li key={run.run_id}>
                <button
                  onClick={() => loadDetail(run.run_id)}
                  className={`flex w-full flex-col gap-0.5 rounded-lg border px-3 py-2 text-left text-xs ${
                    selectedRunId === run.run_id
                      ? "border-zinc-900 dark:border-zinc-100"
                      : "border-zinc-200 dark:border-zinc-800"
                  } bg-white dark:bg-zinc-950`}
                >
                  <span className="font-mono text-zinc-500">{run.run_id.slice(0, 8)}</span>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={run.status} />
                    {run.approved && <span title="Approved">✓</span>}
                    <span className="text-zinc-400">{new Date(run.created_at).toLocaleString()}</span>
                  </div>
                </button>
              </li>
            ))}
            {!loadingList && runs.length === 0 && <p className="text-xs text-zinc-400">No runs yet.</p>}
          </ol>
        </div>

        <div>
          {detail ? (
            <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-950">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-zinc-500">run_id: {detail.run.run_id}</span>
                <StatusBadge status={detail.run.status} />
                {detail.run.approved && (
                  <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-400">
                    Approved by {detail.run.approved_by}
                  </span>
                )}
                {detail.run.promoted && (
                  <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800 dark:bg-purple-950 dark:text-purple-400">
                    Promoted by {detail.run.promoted_by}
                  </span>
                )}
                <button
                  onClick={runAgain}
                  disabled={runningAgain}
                  title="Start a brand-new run with this run's original input"
                  className="ml-auto rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 hover:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-600"
                >
                  {runningAgain ? "Starting…" : "Run again"}
                </button>
              </div>

              {detail.run.status === "completed" && (
                <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
                  <p className="font-medium text-zinc-600 dark:text-zinc-400">
                    Curation — mark this run worth keeping.
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      className="rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                      value={selectedAdmin}
                      onChange={(e) => setSelectedAdmin(e.target.value)}
                    >
                      <option value="">Sign as…</option>
                      {admins.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      className="min-w-40 flex-1 rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                      placeholder="Approval note (optional)"
                      value={approvalNote}
                      onChange={(e) => setApprovalNote(e.target.value)}
                    />
                    <button
                      onClick={approveRun}
                      disabled={curating || !selectedAdmin || detail.run.approved}
                      className="rounded-full border border-zinc-300 px-3 py-1 font-medium text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300"
                    >
                      {detail.run.approved ? "Approved" : "Approve"}
                    </button>
                    <button
                      onClick={promoteRun}
                      disabled={curating || !selectedAdmin || !detail.run.approved || detail.run.promoted}
                      title={!detail.run.approved ? "Approve this run first" : undefined}
                      className="rounded-full border border-zinc-300 px-3 py-1 font-medium text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300"
                    >
                      {detail.run.promoted ? "Promoted" : "Promote"}
                    </button>
                  </div>
                </div>
              )}

              {detail.run.status === "running" && (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-sm dark:border-zinc-700 dark:bg-zinc-900">
                  <p className="text-zinc-700 dark:text-zinc-300">
                    Stuck at &quot;running&quot; — a previous attempt likely died before recording a result. Retrying
                    re-attempts the same step; nothing already recorded is lost.
                  </p>
                  <button
                    onClick={retryStuck}
                    disabled={retrying}
                    className="shrink-0 rounded-full bg-zinc-900 px-4 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-black"
                  >
                    {retrying ? "Retrying…" : "Retry"}
                  </button>
                </div>
              )}

              {detail.run.status === "awaiting_approval" && (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-blue-300 bg-blue-50 p-3 text-sm dark:border-blue-900 dark:bg-blue-950/40">
                  <p className="text-blue-900 dark:text-blue-300">
                    Ready to run <span className="font-medium">{PIPELINE[detail.run.current_step]?.label}</span> next.
                  </p>
                  <button
                    onClick={approveNext}
                    disabled={advancing}
                    className="shrink-0 rounded-full bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {advancing ? "Running…" : "Approve"}
                  </button>
                </div>
              )}

              {pendingTaskRun && (
                <div className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
                  <p className="text-sm text-amber-900 dark:text-amber-300">
                    {pendingTaskRun.message ?? "This run is waiting on more information."}
                  </p>
                  {pendingQuestions.length > 0 ? (
                    pendingQuestions.map((q) => (
                      <label key={q.key} className="flex flex-col gap-1 text-xs text-amber-900 dark:text-amber-300">
                        {q.ask ?? q.label}
                        {q.options && q.options.length > 0 ? (
                          <select
                            className="rounded border border-amber-300 bg-white px-2 py-1 text-sm text-black dark:border-amber-800 dark:bg-zinc-950 dark:text-zinc-50"
                            value={answers[q.key] ?? ""}
                            onChange={(e) => setAnswers((a) => ({ ...a, [q.key]: e.target.value }))}
                          >
                            <option value="" disabled>
                              Select {q.label.toLowerCase()}…
                            </option>
                            {q.options.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type="text"
                            className="rounded border border-amber-300 bg-white px-2 py-1 text-sm text-black dark:border-amber-800 dark:bg-zinc-950 dark:text-zinc-50"
                            value={answers[q.key] ?? ""}
                            onChange={(e) => setAnswers((a) => ({ ...a, [q.key]: e.target.value }))}
                            placeholder={q.label}
                          />
                        )}
                      </label>
                    ))
                  ) : (
                    <p className="text-xs text-amber-800 dark:text-amber-400">
                      No structured questions were recorded for this pause — check the output below for what&apos;s
                      missing.
                    </p>
                  )}
                  <button
                    onClick={submitAnswers}
                    disabled={resuming || pendingQuestions.length === 0 || !readyToSubmitAnswers}
                    className="self-start rounded-full bg-amber-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {resuming ? "Submitting…" : "Submit and resume"}
                  </button>
                </div>
              )}

              {anyActionInFlight && (
                <LiveToolCallLog calls={liveCalls} currentTaskId={liveTaskId} agentLabel={agentLabel} />
              )}

              <pre className="overflow-x-auto rounded bg-zinc-50 p-2 text-xs dark:bg-zinc-900">
                {JSON.stringify(detail.run.input, null, 2)}
              </pre>
              <ol className="flex flex-col gap-2">
                {detail.taskRuns.map((taskRun) => (
                  <li
                    key={taskRun.task_run_id}
                    className="flex flex-col gap-1 border-t border-zinc-100 pt-2 dark:border-zinc-900"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{taskRun.task_id}</span>
                      <span className="font-mono text-xs text-zinc-400">
                        task_run_id: {taskRun.task_run_id}
                      </span>
                      <StatusBadge status={taskRun.status} />
                      {taskRun.tokens_used != null && (
                        <span className="text-xs text-zinc-400">
                          {taskRun.tokens_used.toLocaleString()} tokens{taskRun.model ? ` (${taskRun.model})` : ""}
                        </span>
                      )}
                      <span className="ml-auto text-xs text-zinc-400">
                        {new Date(taskRun.started_at).toLocaleTimeString()} · {taskRun.duration_ms}ms
                      </span>
                    </div>
                    {taskRun.message && (
                      <p className={`whitespace-pre-wrap text-xs ${taskRun.status === "failed" ? "text-red-600" : "text-zinc-600 dark:text-zinc-400"}`}>
                        {taskRun.message}
                      </p>
                    )}
                    <div className="flex flex-col gap-1.5">
                      <ToolCallTrace output={(taskRun.output ?? {}) as ToolCallOutput} metadata={taskRun.metadata} />
                    </div>
                    <ToolCallLog calls={(taskRun.metadata?.toolCalls as ToolCallLogEntry[] | undefined) ?? []} />
                    <pre className="overflow-x-auto rounded bg-zinc-50 p-2 text-xs dark:bg-zinc-900">
                      {JSON.stringify(taskRun.output, null, 2)}
                    </pre>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <p className="text-sm text-zinc-400">Select a run to see its task runs.</p>
          )}
        </div>
      </div>
    </div>
  );
}
