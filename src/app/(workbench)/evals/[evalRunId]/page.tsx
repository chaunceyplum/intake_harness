import { EvalsBrowser } from "../evals-browser";

export default async function EvalRunDetailPage({ params }: { params: Promise<{ evalRunId: string }> }) {
  const { evalRunId } = await params;
  return <EvalsBrowser initialEvalRunId={evalRunId} />;
}
