import { PIPELINE } from "@/lib/pipeline/registry";
import { getTaskCounts } from "@/lib/pipeline/orchestrator";

export const dynamic = "force-dynamic";

/** The Agents page — the registry (PIPELINE) plus real execution counts per agent, across every run. */
export default async function AgentsPage() {
  const counts = await getTaskCounts();

  return (
    <div className="flex max-w-5xl flex-col gap-6 px-4 py-6 sm:px-8 sm:py-10">
      <div>
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Agents</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          The registry in <code className="text-xs">src/lib/pipeline/registry.ts</code>, with how each has actually
          run across every pipeline invocation.
        </p>
      </div>

      <ol className="flex flex-col gap-3">
        {PIPELINE.map((agent) => {
          const c = counts[agent.name] ?? { total: 0, completed: 0, needsInput: 0, failed: 0 };
          return (
            <li
              key={agent.name}
              className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-950"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-black dark:text-zinc-50">{agent.label}</span>
                <span className="text-xs text-zinc-500">{agent.owner}</span>
                <code className="text-xs text-zinc-400">{agent.path}</code>
              </div>
              <div className="flex flex-wrap gap-3 text-xs text-zinc-500 dark:text-zinc-400">
                <span>{c.total} run{c.total === 1 ? "" : "s"}</span>
                <span className="text-green-700 dark:text-green-400">{c.completed} completed</span>
                <span className="text-amber-700 dark:text-amber-400">{c.needsInput} needed input</span>
                <span className="text-red-700 dark:text-red-400">{c.failed} failed</span>
              </div>
              <details className="text-xs text-zinc-500 dark:text-zinc-400">
                <summary className="cursor-pointer">{agent.allowedTools.length} allowed MCP tool(s)</summary>
                <ul className="mt-1 flex flex-col gap-0.5 pl-4">
                  {agent.allowedTools.map((tool) => (
                    <li key={tool} className="font-mono">
                      {tool}
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
