/**
 * A scannable summary at the end of an eval file's run - vitest's own
 * pass/fail dots tell you THAT something failed, not which fixture or why.
 * Call once per eval file, after every fixture has run (e.g. in an
 * `afterAll`), with one entry per fixture.
 */

export type EvalOutcome = {
  id: string;
  passed: boolean;
  /** Why - a score breakdown, a judge's reasoning, a mismatch detail. */
  notes: string;
};

export function report(agentName: string, results: EvalOutcome[]): void {
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const rate = total ? Math.round((passed / total) * 100) : 0;

  console.log(`\n=== ${agentName} eval: ${passed}/${total} (${rate}%) ===`);
  for (const r of results) {
    console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.id}${r.notes ? ` — ${r.notes}` : ""}`);
  }
  console.log("");
}
