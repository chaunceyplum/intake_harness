/**
 * The governance boundary for every LLM call: redact PII on the way out,
 * restore it on the way back, and write an audit event either way.
 *
 * WRAPPING ORDER MATTERS (see getLlmClient): this wraps OUTSIDE traced(), so
 * the tool-call trace persisted to task_runs.metadata records the redacted
 * prompt and the model's placeholder-bearing answer - never the raw values.
 * Only the caller, in memory, sees the restored text.
 *
 *   LLM_PII_REDACTION = off   disables redaction (audit still records the call)
 */

import type { LlmClient } from "@/lib/llm/types";
import { currentTraceContext } from "@/lib/mcp-client";
import { mergeCounts, redactPii, restorePii, type PiiVault } from "./pii";
import { recordAuditEvent, sha256, type AuditSink } from "./audit";

export type GovernanceOptions = {
  redact?: boolean;
  audit?: AuditSink;
};

export function redactionEnabled(): boolean {
  return (process.env.LLM_PII_REDACTION ?? "").trim().toLowerCase() !== "off";
}

export function withGovernance(client: LlmClient, opts: GovernanceOptions = {}): LlmClient {
  const redact = opts.redact ?? redactionEnabled();
  const audit = opts.audit ?? recordAuditEvent;

  return {
    id: client.id,
    async complete(req) {
      const vault: PiiVault = new Map();
      let system = req.system;
      let prompt = req.prompt;
      let redactions = {};
      if (redact) {
        const s = system ? redactPii(system, vault) : { text: undefined, counts: {} };
        const p = redactPii(prompt, vault);
        system = s.text;
        prompt = p.text;
        redactions = mergeCounts(s.counts, p.counts);
      }

      const ctx = currentTraceContext();
      const base = {
        actor: "system",
        runId: ctx?.runId ?? null,
        taskId: ctx?.taskId ?? null,
        inputSha256: sha256(`${system ?? ""}\n---\n${prompt}`),
      };

      try {
        const result = await client.complete({ ...req, system, prompt });
        await audit({
          ...base,
          action: "llm.complete",
          model: result.model,
          details: { provider: client.id, redactionEnabled: redact, redactions, usage: result.usage },
        });
        return { ...result, text: restorePii(result.text, vault) };
      } catch (err) {
        await audit({
          ...base,
          action: "llm.error",
          model: null,
          details: { provider: client.id, redactionEnabled: redact, redactions, error: (err as Error).message.slice(0, 300) },
        });
        throw err;
      }
    },
  };
}
