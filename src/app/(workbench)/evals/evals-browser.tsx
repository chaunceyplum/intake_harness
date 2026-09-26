"use client";

import { useCallback, useEffect, useState } from "react";
import { PIPELINE } from "@/lib/pipeline/registry";
import type { EvalRunRow, EvalResultRow } from "@/lib/evals";

type EvalRunDetail = { run: EvalRunRow; results: EvalResultRow[] };

/** "intake" -> "Agent 1 — Intake", same lookup runs-browser.tsx uses for task_id. */
function suiteLabel(suite: string): string {
  return PIPELINE.find((a) => a.name === suite)?.label ?? suite;
}

function PassFailBadge({ passed }: { passed: boolean }) {
  const color = passed
    ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-400"
    : "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-400";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>{passed ? "PASS" : "FAIL"}</span>;
}

/**
 * offline (curated fixtures) vs online (sampled real task_runs). The
 * distinction matters: an online run's "pass" is "ran on the LLM path", a
 * health signal, not a correctness claim against a golden answer - see
 * scripts/online-eval.mjs.
 */
function SourceBadge({ source }: { source: string }) {
  if (source === "online") {
    return (
      <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-800 dark:bg-sky-950 dark:text-sky-400">
        online
      </span>
    );
  }
  return (
    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
      offline
    </span>
  );
}

/**
 * The "see eval results from the database" page. Lists every row in
 * `eval_runs` (GET /api/evals) and, on selection, every eval_results row
 * for it (GET /api/evals/[evalRunId]) - the history evals/lib/report.ts
 * writes on every `npm run eval:*`, browsable here instead of only in the
 * terminal that ran it. See evals/README.md for what these suites check.
 */
export function EvalsBrowser({ initialEvalRunId }: { initialEvalRunId?: string }) {
  const [evalRuns, setEvalRuns] = useState<EvalRunRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialEvalRunId ?? null);
  const [detail, setDetail] = useState<EvalRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);

  const loadDetail = useCallback(async (evalRunId: string) => {
    setSelectedId(evalRunId);
    const res = await fetch(`/api/evals/${evalRunId}`);
    if (!res.ok) {
      setError(`Failed to load eval run ${evalRunId} (HTTP ${res.status}).`);
      return;
    }
    setDetail((await res.json()) as EvalRunDetail);
  }, []);

  // Fetch-on-mount via the fetch's own callback, not by calling a
  // setState-holding function directly in the effect body, so a stale
  // response can't overwrite state after unmount - same pattern
  // runs-browser.tsx uses for the identical race.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/evals")
      .then(async (res) => {
        if (!res.ok) {
          if (!cancelled) setError(`Failed to load eval runs (HTTP ${res.status}). Is DATABASE_URL set in .env.local?`);
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          setEvalRuns(data.evalRuns ?? []);
          if (!initialEvalRunId && data.evalRuns?.length) {
            loadDetail(data.evalRuns[0].eval_run_id);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadDetail is a stable useCallback; initialEvalRunId doesn't change after mount.
  }, []);

  // Deep-link support for /evals/[evalRunId].
  useEffect(() => {
    if (!initialEvalRunId) return;
    let cancelled = false;
    fetch(`/api/evals/${initialEvalRunId}`)
      .then(async (res) => {
        if (!res.ok) {
          if (!cancelled) setError(`Failed to load eval run ${initialEvalRunId} (HTTP ${res.status}).`);
          return;
        }
        if (!cancelled) setDetail((await res.json()) as EvalRunDetail);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [initialEvalRunId]);

  async function refresh() {
    setError(null);
    const res = await fetch("/api/evals");
    if (!res.ok) {
      setError(`Failed to load eval runs (HTTP ${res.status}).`);
      return;
    }
    const data = await res.json();
    setEvalRuns(data.evalRuns ?? []);
  }

  return (
    <div className="flex max-w-7xl flex-col gap-6 px-4 py-6 sm:px-8 sm:py-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Evals</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Every <code className="text-xs">npm run eval:*</code> invocation recorded in the{" "}
            <code className="text-xs">eval_runs</code> table, most recent first. These grade the real LLM path
            (extraction, triage, PQL synthesis) against hand-reviewed fixtures — see{" "}
            <code className="text-xs">evals/README.md</code>. Not part of <code className="text-xs">npm test</code>/CI.
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

      <div className="grid gap-6 sm:grid-cols-[280px_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-black dark:text-zinc-50">
            {loadingList ? "Loading…" : `${evalRuns.length} eval run${evalRuns.length === 1 ? "" : "s"}`}
          </h2>
          <ol className="flex flex-col gap-1">
            {evalRuns.map((run) => (
              <li key={run.eval_run_id}>
                <button
                  onClick={() => loadDetail(run.eval_run_id)}
                  className={`flex w-full flex-col gap-0.5 rounded-lg border px-3 py-2 text-left text-xs ${
                    selectedId === run.eval_run_id
                      ? "border-zinc-900 dark:border-zinc-100"
                      : "border-zinc-200 dark:border-zinc-800"
                  } bg-white dark:bg-zinc-950`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-black dark:text-zinc-50">{suiteLabel(run.suite)}</span>
                    <SourceBadge source={run.source} />
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={
                        run.passed_count === run.total_count
                          ? "font-mono text-green-700 dark:text-green-400"
                          : "font-mono text-amber-700 dark:text-amber-400"
                      }
                    >
                      {run.passed_count}/{run.total_count}
                    </span>
                    {run.repeat_count > 1 && <span className="text-zinc-400">pass^{run.repeat_count}</span>}
                    {run.provider && <span className="text-zinc-400">{run.provider}</span>}
                  </div>
                  <span className="text-zinc-400">{new Date(run.started_at).toLocaleString()}</span>
                </button>
              </li>
            ))}
            {!loadingList && evalRuns.length === 0 && (
              <p className="text-xs text-zinc-400">
                No eval runs yet — run <code>npm run eval:all</code> against a configured LLM_PROVIDER.
              </p>
            )}
          </ol>
        </div>

        <div>
          {detail ? (
            <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-950">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold text-black dark:text-zinc-50">
                  {suiteLabel(detail.run.suite)}
                </span>
                <SourceBadge source={detail.run.source} />
                <span className="font-mono text-xs text-zinc-500">eval_run_id: {detail.run.eval_run_id}</span>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
                <span>
                  {detail.run.passed_count}/{detail.run.total_count}{" "}
                  {detail.run.source === "online" ? "on the LLM path" : "passed"} (
                  {detail.run.total_count
                    ? Math.round((detail.run.passed_count / detail.run.total_count) * 100)
                    : 0}
                  %)
                </span>
                {detail.run.repeat_count > 1 && (
                  <span>
                    pass^{detail.run.repeat_count} ({detail.run.passk_count ?? detail.run.passed_count}/
                    {detail.run.total_count} passed every attempt)
                  </span>
                )}
                {detail.run.provider && <span>provider: {detail.run.provider}</span>}
                <span>started: {new Date(detail.run.started_at).toLocaleString()}</span>
                <span>finished: {new Date(detail.run.finished_at).toLocaleString()}</span>
              </div>
              {detail.run.source === "online" && (
                <p className="text-xs text-sky-700 dark:text-sky-400">
                  Sampled from real <code className="text-[11px]">task_runs</code> — &quot;passed&quot; here means the
                  run completed on the real LLM path (did not fall back to the deterministic parser), a health signal,
                  not a correctness grade. See <code className="text-[11px]">scripts/online-eval.mjs</code>.
                </p>
              )}

              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                    <th className="py-1.5 pr-3 font-medium">Fixture</th>
                    <th className="py-1.5 pr-3 font-medium">Result</th>
                    <th className="py-1.5 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.results.map((r) => (
                    <tr key={r.eval_result_id} className="border-b border-zinc-100 align-top dark:border-zinc-900">
                      <td className="py-1.5 pr-3 font-mono">{r.fixture_id}</td>
                      <td className="py-1.5 pr-3">
                        <PassFailBadge passed={r.passed} />
                      </td>
                      <td className="py-1.5 text-zinc-600 dark:text-zinc-400">{r.notes || "—"}</td>
                    </tr>
                  ))}
                  {detail.results.length === 0 && (
                    <tr>
                      <td colSpan={3} className="py-2 text-zinc-400">
                        No fixture results recorded for this run.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-zinc-400">Select an eval run to see its fixture-level results.</p>
          )}
        </div>
      </div>
    </div>
  );
}
