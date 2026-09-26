import { Sidebar } from "../sidebar";

/**
 * The operator workbench - Runs, Evals, Agents, Settings - keeps its sidebar
 * and dense tooling. A route group, so the URLs are unchanged (/runs, not
 * /workbench/runs), and the executive-facing home page is not wrapped in it.
 */
export default function WorkbenchLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="workbench flex min-h-full flex-col md:flex-row">
      <Sidebar />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
