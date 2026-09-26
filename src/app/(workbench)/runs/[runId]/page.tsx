import { RunsBrowser } from "../runs-browser";

export default async function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return <RunsBrowser initialRunId={runId} />;
}
