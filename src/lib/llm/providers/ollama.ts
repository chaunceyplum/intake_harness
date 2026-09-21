/**
 * A self-hosted Ollama server (default port 11434), over plain fetch.
 *
 * THE HOST CHANGES OFTEN, BY DESIGN. Ollama here runs on infrastructure whose
 * hostname/IP moves frequently, so the host is REQUIRED config the user
 * supplies each time - there is no sensible default to bake in. See
 * src/lib/llm/index.ts, which reads OLLAMA_HOST and refuses to build this
 * client without it rather than silently defaulting to localhost (which would
 * "work" in dev and fail confusingly everywhere else).
 *
 * Config:
 *   OLLAMA_HOST   - required, e.g. http://10.0.0.5:11434 or just 10.0.0.5
 *                   (scheme defaults to http, port to 11434 if omitted)
 *   OLLAMA_MODEL  - required, e.g. "llama3.1" - Ollama has no default model
 *
 * Uses the /api/chat endpoint with stream:false so one request returns one
 * complete JSON object, matching this app's non-streaming LlmClient contract.
 */

import type { LlmClient, LlmCompletionRequest, LlmCompletionResult } from "../types";

export interface OllamaConfig {
  /** Host as the user gave it - normalized by normalizeOllamaHost below. */
  host: string;
  model: string;
  timeoutMs?: number;
}

/**
 * Turn whatever the user typed into a usable base URL. Accepts "10.0.0.5",
 * "10.0.0.5:11434", "http://host", "https://host:11434/", etc. - adds the
 * http scheme and the default 11434 port when missing, strips trailing slash.
 * Exported so the factory and tests can validate a host without a live call.
 */
export function normalizeOllamaHost(raw: string): string {
  let h = String(raw || "").trim();
  if (!h) throw new Error("OLLAMA_HOST is empty");
  if (!/^https?:\/\//i.test(h)) h = `http://${h}`;
  const url = new URL(h);
  if (!url.port) url.port = "11434";
  return url.toString().replace(/\/+$/, "");
}

export function createOllamaClient(cfg: OllamaConfig): LlmClient {
  const base = normalizeOllamaHost(cfg.host);
  const model = cfg.model;
  // Every caller of this client runs inside an agent route the orchestrator
  // itself wraps in AGENT_CALL_TIMEOUT_MS (60s - see pipeline/orchestrator.ts).
  // A local model slower than that would otherwise get its own graceful
  // "fall back to the deterministic path" try/catch (llm-extract.ts et al.)
  // preempted by the orchestrator's own fetch aborting first, turning a slow
  // model into a failed run instead of a fallback. Defaulting under that
  // ceiling means THIS timeout fires first and the intended fallback runs.
  const timeoutMs = cfg.timeoutMs ?? 45_000;

  return {
    id: `ollama:${model}@${base}`,
    async complete(req: LlmCompletionRequest): Promise<LlmCompletionResult> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(`${base}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            stream: false,
            // num_predict is Ollama's max-output-tokens knob - forwarded so this
            // provider clamps generation the same way anthropic.ts/bedrock.ts do
            // (both send max_tokens), instead of letting a local model generate
            // unboundedly and risk a shape the caller's JSON extraction doesn't
            // expect (see types.ts's LlmCompletionRequest.maxTokens).
            options: { temperature: req.temperature ?? 0, ...(req.maxTokens ? { num_predict: req.maxTokens } : {}) },
            messages: [
              ...(req.system ? [{ role: "system", content: req.system }] : []),
              { role: "user", content: req.prompt },
            ],
          }),
          signal: controller.signal,
        });
      } catch (err) {
        throw new Error(`Ollama request to ${base} failed: ${(err as Error).message}`);
      } finally {
        clearTimeout(timeout);
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Ollama at ${base} returned HTTP ${res.status}: ${body.slice(0, 300)}`);
      }

      const data = (await res.json()) as {
        message?: { content?: string };
        model?: string;
        prompt_eval_count?: number;
        eval_count?: number;
      };

      return {
        text: data.message?.content ?? "",
        model: data.model || model,
        // Ollama reports token counts as prompt_eval_count/eval_count when available.
        usage:
          data.prompt_eval_count != null || data.eval_count != null
            ? { inputTokens: data.prompt_eval_count ?? null, outputTokens: data.eval_count ?? null }
            : null,
      };
    },
  };
}
