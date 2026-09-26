"use client";

import { useState } from "react";
import Link from "next/link";
import { PIPELINE } from "@/lib/pipeline/registry";
import { ToolCallTrace, type ToolCallOutput } from "../tool-call-trace";
import { ToolCallLog, type ToolCallLogEntry } from "../tool-call-log";
import { LiveToolCallLog, type LiveToolCall } from "../live-tool-call-log";
import type { RunDetail } from "./outcome";

function agentLabel(taskId: string): string {
  return PIPELINE.find((a) => a.name === taskId)?.label ?? taskId;
}

/**
 * Developer mode's view of a run: every agent's message, tool-call trace and
 * raw output - what the workbench's run page shows, under the result instead
 * of a click away. Never rendered unless Developer mode is on.
 */
export function DeveloperPanel({
  detail,
  liveCalls,
  liveTaskId,
  active,
  error,
}: {
  detail: RunDetail | null;
  liveCalls: LiveToolCall[];
  liveTaskId: string | null;
  active: boolean;
  error: string | null;
}) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  if (!detail && !error) return null;

  return (
    <section className="glass rise mt-6 rounded-[22px] p-5 text-sm" aria-label="Developer details">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-label-secondary">Behind the scenes</h2>
        {detail && (
          <>
            <span className="font-mono text-xs text-label-tertiary">{detail.run.run_id}</span>
            <span className="text-xs text-label-tertiary">{detail.run.status}</span>
            <Link href={`/runs/${detail.run.run_id}`} className="ml-auto text-xs font-medium text-accent hover:underline">
              Open full trace
            </Link>
          </>
        )}
      </div>

      {error && <p className="mt-3 whitespace-pre-wrap font-mono text-xs text-danger">{error}</p>}

      <div className="mt-4 flex flex-col gap-3">
        {detail?.taskRuns.map((tr) => {
          const isOpen = open[tr.task_run_id] ?? false;
          return (
            <div key={tr.task_run_id} className="rounded-2xl border border-separator bg-background/40 p-3">
              <div className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-full ${
                    tr.status === "completed" ? "bg-success" : tr.status === "failed" ? "bg-danger" : "bg-warning"
                  }`}
                />
                <span className="font-medium text-label">{agentLabel(tr.task_id)}</span>
                <span className="text-xs text-label-tertiary">
                  {tr.status} · {(tr.duration_ms / 1000).toFixed(1)}s
                  {tr.tokens_used != null ? ` · ${tr.tokens_used.toLocaleString()} tokens` : ""}
                  {tr.model ? ` · ${tr.model}` : ""}
                </span>
                <button
                  onClick={() => setOpen((o) => ({ ...o, [tr.task_run_id]: !isOpen }))}
                  className="ml-auto text-xs font-medium text-accent hover:underline"
                >
                  {isOpen ? "Hide" : "Details"}
                </button>
              </div>
              {tr.message && <p className="mt-2 whitespace-pre-wrap text-xs text-label-secondary">{tr.message}</p>}
              <div className="mt-2">
                <ToolCallTrace output={(tr.output ?? {}) as ToolCallOutput} metadata={tr.metadata} />
              </div>
              {isOpen && (
                <div className="mt-2 flex flex-col gap-2">
                  <ToolCallLog calls={(tr.metadata?.toolCalls as ToolCallLogEntry[] | undefined) ?? []} />
                  <pre className="max-h-96 overflow-auto rounded-xl bg-background/60 p-3 font-mono text-[11px] text-label-secondary">
                    {JSON.stringify({ output: tr.output, metadata: tr.metadata }, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
        {active && <LiveToolCallLog calls={liveCalls} currentTaskId={liveTaskId} agentLabel={agentLabel} />}
      </div>
    </section>
  );
}
