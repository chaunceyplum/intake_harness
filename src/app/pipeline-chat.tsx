"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PIPELINE } from "@/lib/pipeline/registry";
import type { RunRow, TaskRunRow } from "@/lib/pipeline/types";
import { StatusBadge } from "./status-badge";
import { ToolCallTrace, type ToolCallOutput } from "./tool-call-trace";
import { ToolCallLog, type ToolCallLogEntry } from "./tool-call-log";
import { LiveToolCallLog, type LiveToolCall } from "./live-tool-call-log";
import { AudienceCard, DemoPill } from "./audience-card";

type RunDetail = { run: RunRow; taskRuns: TaskRunRow[] };
type PendingQuestion = { key: string; label: string; ask: string | null; options: string[] | null };

// Falls back to the raw task_id for a historical "escalation" row — the
// registry no longer has an entry for it (Agent 4 was removed), but old
// task_runs with that task_id still need to render something. Also used as
// LiveToolCallLog's agentLabel - accepts a plain string there since the
// live poll's currentTaskId isn't narrowed to AgentName the way a real
// task_runs row's task_id is.
function agentLabel(taskId: string): string {
  return PIPELINE.find((a) => a.name === taskId)?.label ?? taskId;
}

/** A step's output, loosely — every field here is optional because each agent's shape differs. */
type StepOutput = ToolCallOutput & {
  message?: string;
  questions?: PendingQuestion[];
};

/**
 * A conversational front end for the whole pipeline, one agent per turn —
 * modeled on how Claude Code itself shows a run: the marketer's request,
 * each agent's tool calls surfaced inline rather than hidden, and an
 * explicit approval prompt before an agent that still gates runs rather
 * than the whole pipeline firing off unattended. Backed by
 * src/lib/pipeline/orchestrator.ts's per-step gate (runPipeline only ever
 * runs the next agent; POST .../continue is what approves the next one) —
 * except Audience Creation, which registry.ts opts out of the gate for, so
 * it runs immediately once Review completes rather than waiting for a
 * click.
 */
export function PipelineChat() {
  const [brief, setBrief] = useState("");
  const [workfrontProjectId, setWorkfrontProjectId] = useState("");
  // Governed by default, same as the agents - Demo has to be chosen, never fallen into.
  const [mode, setMode] = useState<"governed" | "demo">("governed");
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [liveCalls, setLiveCalls] = useState<LiveToolCall[]>([]);
  const [liveTaskId, setLiveTaskId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [runDetail, busy]);

  /*
   * Poll GET /api/runs/[runId]/live while a request that runs agents is in
   * flight, so the button lighting up isn't the only signal the user gets -
   * see live-tool-call-log.tsx / live-progress.ts for why this exists.
   *
   * Only runs once a run_id exists, which means the very first call
   * (startRun, before any run_id is known) still shows only the plain
   * "Running…" spinner - runPipeline creates the run row and executes
   * Intake in the same request, so there is no run_id to poll with until
   * that whole response comes back. Every later action (submitAnswers,
   * approveNext, retryStuck) already has runDetail's run_id, so THOSE get
   * full live visibility - which is also where chained multi-agent steps
   * (Review -> Audience Creation) make the silent wait longest.
   */
  useEffect(() => {
    // No synchronous setState here on the "not busy" branch, on purpose -
    // rendering below is already gated on `busy`, so stale liveCalls simply
    // never gets shown, and every new busy cycle's first poll() resolves
    // near-instantly (a local fetch against a server whose live-progress
    // store orchestrator.ts already resets fresh per action) - so the only
    // setState calls here are inside poll's async callback, which is
    // exactly the pattern react-hooks/set-state-in-effect wants.
    if (!busy || !runDetail) return;
    const runId = runDetail.run.run_id;
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
  }, [busy, runDetail]);

  async function loadDetail(runId: string) {
    const res = await fetch(`/api/runs/${runId}`);
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error ?? `Failed to load run (HTTP ${res.status}).`);
      return;
    }
    setRunDetail(data as RunDetail);
    setAnswers({});
  }

  async function startRun() {
    const text = brief.trim();
    if (!text || busy) return;
    setBusy(true);
    setBusyLabel(agentLabel("intake"));
    setError(null);
    try {
      const fields = workfrontProjectId.trim() ? { workfront_project_id: workfrontProjectId.trim() } : undefined;
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: { brief: text, fields, ...(mode === "demo" ? { mode } : {}) } }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      await loadDetail(data.run.run_id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  }

  async function submitAnswers() {
    if (!runDetail) return;
    setBusy(true);
    setBusyLabel(agentLabel("intake"));
    setError(null);
    try {
      const res = await fetch(`/api/runs/${runDetail.run.run_id}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // See runs-browser.tsx's submitAnswers for the full reasoning - a
        // VALIDATION_ERROR here means the run moved on since this page
        // loaded (another tab, another person, or an earlier answer), so
        // refetch and show the real current question instead of leaving
        // the form stuck on one that no longer applies.
        const staleRun = data?.code === "VALIDATION_ERROR";
        if (staleRun) await loadDetail(runDetail.run.run_id);
        throw new Error(
          (data?.error ?? `HTTP ${res.status}`) +
            (staleRun ? " This run has moved on since you loaded it - refreshed to show the current step below." : ""),
        );
      }
      await loadDetail(runDetail.run.run_id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  }

  async function approveNext() {
    if (!runDetail) return;
    const next = PIPELINE[runDetail.run.current_step];
    setBusy(true);
    setBusyLabel(next?.label ?? "next agent");
    setError(null);
    try {
      const res = await fetch(`/api/runs/${runDetail.run.run_id}/continue`, { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      await loadDetail(runDetail.run.run_id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  }

  async function retryStuck() {
    if (!runDetail) return;
    setBusy(true);
    setBusyLabel(agentLabel(PIPELINE[runDetail.run.current_step]?.name ?? "intake"));
    setError(null);
    try {
      const res = await fetch(`/api/runs/${runDetail.run.run_id}/retry`, { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      await loadDetail(runDetail.run.run_id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  }

  function reset() {
    setBrief("");
    setRunDetail(null);
    setAnswers({});
    setError(null);
    setExpanded({});
  }

  const run = runDetail?.run ?? null;
  const taskRuns = runDetail?.taskRuns ?? [];
  const lastStep = taskRuns[taskRuns.length - 1];
  const pendingQuestions =
    run?.status === "needs_input" ? ((lastStep?.output as StepOutput | null)?.questions ?? []) : [];
  const readyToSend = pendingQuestions.every((q) => (answers[q.key] ?? "").trim() !== "");
  const runIsDemo = (run?.input as { mode?: string } | undefined)?.mode === "demo";

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      {/* Viewport-relative, not a fixed 32rem - on a tall monitor a fixed
          cap left most of the screen empty below a small scrolling box. */}
      <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto p-4">
        {!run && (
          <p className="text-sm text-zinc-400">
            Describe the campaign or audience you need. Each agent runs one at a time — you&apos;ll see what it did
            and approve before the next one runs.
          </p>
        )}

        {run && (
          <div className="flex items-start justify-end gap-2">
            {runIsDemo && <DemoPill text="Demo – not approved" />}
            <p className="max-w-[85%] rounded-2xl bg-zinc-900 px-3 py-2 text-sm text-white dark:bg-zinc-100 dark:text-black">
              {(run.input as { brief?: string })?.brief ?? JSON.stringify(run.input)}
            </p>
          </div>
        )}

        {taskRuns.map((tr, i) => {
          const output = (tr.output ?? {}) as StepOutput;
          const isOpen = expanded[tr.task_run_id] ?? false;
          const icon = tr.status === "completed" ? "✓" : tr.status === "failed" ? "✕" : "?";
          const dot =
            tr.status === "completed"
              ? "bg-green-600"
              : tr.status === "failed"
                ? "bg-red-600"
                : "bg-amber-500";

          return (
            <div key={tr.task_run_id} className="flex flex-col gap-1.5 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
              <div className="flex items-center gap-2">
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white ${dot}`}>
                  {icon}
                </span>
                <span className="font-medium text-black dark:text-zinc-50">{agentLabel(tr.task_id)}</span>
                <span className="text-xs text-zinc-400">{tr.duration_ms}ms</span>
                {tr.tokens_used != null && (
                  <span className="text-xs text-zinc-400">
                    · {tr.tokens_used.toLocaleString()} tokens{tr.model ? ` (${tr.model})` : ""}
                  </span>
                )}
                <button
                  onClick={() => setExpanded((e) => ({ ...e, [tr.task_run_id]: !isOpen }))}
                  className="ml-auto text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                >
                  {isOpen ? "Hide details" : "Details"}
                </button>
              </div>

              {tr.message && (
                <p className={`whitespace-pre-wrap pl-7 text-xs ${tr.status === "failed" ? "text-red-600" : "text-zinc-600 dark:text-zinc-400"}`}>
                  {tr.message}
                </p>
              )}

              <div className="ml-7 flex flex-col gap-1.5">
                <ToolCallTrace output={output} metadata={tr.metadata} />
                {tr.task_id === "audience_creation" && <AudienceCard output={tr.output} metadata={tr.metadata} />}
              </div>

              {isOpen && (
                <div className="ml-7 flex flex-col gap-2">
                  <ToolCallLog calls={((tr.metadata?.toolCalls as ToolCallLogEntry[] | undefined) ?? [])} />
                  <pre className="overflow-x-auto rounded bg-zinc-50 p-2 text-xs dark:bg-zinc-900">
                    {JSON.stringify(tr.output, null, 2)}
                  </pre>
                </div>
              )}

              {/* The needs_input turn's questions, live, only on the current pending step. */}
              {i === taskRuns.length - 1 && run?.status === "needs_input" && pendingQuestions.length > 0 && (
                <div className="ml-7 mt-1 flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
                  {pendingQuestions.map((q) => (
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
                  ))}
                  <button
                    onClick={submitAnswers}
                    disabled={busy || !readyToSend}
                    className="self-start rounded-full bg-amber-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Send
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {run?.status === "running" && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            <p className="text-zinc-700 dark:text-zinc-300">
              That step got stuck — likely a hung request. Retrying re-attempts it; nothing already recorded is lost.
            </p>
            <button
              onClick={retryStuck}
              disabled={busy}
              className="shrink-0 rounded-full bg-zinc-900 px-4 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-black"
            >
              Retry
            </button>
          </div>
        )}

        {/* The approval gate — only shows up before an agent whose registry
            entry still requires it (see registry.ts's requiresApproval).
            Audience Creation opted out, so this never appears between
            Review finishing and Audience Creation running. */}
        {run?.status === "awaiting_approval" && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-blue-300 bg-blue-50 p-3 text-sm dark:border-blue-900 dark:bg-blue-950/40">
            <p className="text-blue-900 dark:text-blue-300">
              Ready to run <span className="font-medium">{PIPELINE[run.current_step]?.label}</span> next.
            </p>
            <button
              onClick={approveNext}
              disabled={busy}
              className="shrink-0 rounded-full bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Approve
            </button>
          </div>
        )}

        {busy && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-xs text-zinc-400">
              <span className="h-2 w-2 animate-pulse rounded-full bg-zinc-400" />
              Running {busyLabel}…
            </div>
            <LiveToolCallLog calls={liveCalls} currentTaskId={liveTaskId} agentLabel={agentLabel} />
          </div>
        )}

        {run?.status === "completed" && (
          <p className="text-sm text-green-700 dark:text-green-400">
            ✓ Pipeline complete. Full trace on the{" "}
            <Link href={`/runs/${run.run_id}`} className="underline">
              run&apos;s page
            </Link>
            .
          </p>
        )}
        {run?.status === "failed" && (
          <p className="text-sm text-red-600">
            This run failed — see the{" "}
            <Link href={`/runs/${run.run_id}`} className="underline">
              full trace
            </Link>
            .
          </p>
        )}

        <div ref={bottomRef} />
      </div>

      <div className="flex flex-col gap-2 border-t border-zinc-200 p-4 dark:border-zinc-800">
        {!run ? (
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <input
                type="text"
                className="min-w-0 flex-1 rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                placeholder="Describe the campaign / audience brief…"
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && startRun()}
                disabled={busy}
              />
              <button
                onClick={startRun}
                disabled={busy || !brief.trim()}
                className="shrink-0 rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
              >
                Send
              </button>
            </div>
            <input
              type="text"
              className="min-w-0 flex-1 rounded-full border border-zinc-200 bg-white px-4 py-1.5 text-xs text-black outline-none focus:border-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50"
              placeholder="Workfront project ID (optional — defaults to the intake queue if left blank)"
              value={workfrontProjectId}
              onChange={(e) => setWorkfrontProjectId(e.target.value)}
              disabled={busy}
            />
            <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
              {(["governed", "demo"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  disabled={busy}
                  aria-pressed={mode === m}
                  className={`rounded-full border px-3 py-1 ${
                    mode === m
                      ? m === "demo"
                        ? "border-amber-400 bg-amber-100 text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
                        : "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-black"
                      : "border-zinc-300 hover:border-zinc-400 dark:border-zinc-700"
                  }`}
                >
                  {m === "demo" ? "Demo" : "Governed"}
                </button>
              ))}
              <span>
                {mode === "demo"
                  ? "Builds in the tapdemo sandbox only - no Workfront request, no activation, no spend."
                  : "Files a Workfront request and follows the normal approval path."}
              </span>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              run_id: <span className="font-mono">{run.run_id.slice(0, 8)}</span> · <StatusBadge status={run.status} />
            </p>
            {(run.status === "completed" || run.status === "failed") && (
              <button
                onClick={reset}
                className="rounded-full border border-zinc-300 px-4 py-1.5 text-xs text-zinc-700 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-600"
              >
                Start a new request
              </button>
            )}
          </div>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
