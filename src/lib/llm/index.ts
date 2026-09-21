/**
 * Resolve the one configured LLM client from environment variables.
 *
 * This is the single place that knows which provider is in play. Everything
 * else depends only on the LlmClient interface, so switching between Bedrock,
 * Anthropic, and a self-hosted Ollama is purely a matter of env config - no
 * code change, no rebuild logic branching through the app.
 *
 * OPT-IN BY DEFAULT: getLlmClient() returns null when LLM_PROVIDER is unset.
 * Callers (see agents/intake/llm-extract.ts) treat null as "no LLM configured,
 * use the deterministic path" - so the app runs exactly as before until someone
 * deliberately turns an LLM on. A provider that IS named but is misconfigured
 * (missing key/host) throws LlmConfigError rather than silently returning null,
 * because "you asked for Bedrock but gave no credentials" is a mistake worth
 * surfacing, not one to paper over by quietly falling back.
 *
 *   LLM_PROVIDER = bedrock | anthropic | ollama   (unset = LLM disabled)
 *
 * Per-provider vars - see each provider file for the full list:
 *   bedrock:   AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
 *              [AWS_SESSION_TOKEN], [BEDROCK_MODEL_ID]
 *   anthropic: ANTHROPIC_API_KEY, [ANTHROPIC_MODEL], [ANTHROPIC_BASE_URL]
 *   ollama:    OLLAMA_HOST (required, changes often), OLLAMA_MODEL (required)
 */

import { LlmConfigError, type LlmClient, type LlmProvider } from "./types";
import { createBedrockClient } from "./providers/bedrock";
import { createAnthropicClient } from "./providers/anthropic";
import { createOllamaClient } from "./providers/ollama";
import { traceExternalCall } from "@/lib/mcp-client";

export type { LlmClient, LlmCompletionRequest, LlmCompletionResult } from "./types";
export { LlmConfigError } from "./types";

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new LlmConfigError(`${name} is required for the selected LLM_PROVIDER but is not set.`);
  }
  return v.trim();
}

function opt(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * The configured client, or null when no provider is selected.
 *
 * Not memoized: env can differ between requests in some deploys, and building
 * a client is cheap (it just captures config; no connection is opened until
 * `complete` is called). Callers that want to reuse one within a request can
 * hold the returned value.
 */
export function getLlmClient(): LlmClient | null {
  const provider = opt("LLM_PROVIDER")?.toLowerCase() as LlmProvider | undefined;
  if (!provider) return null;

  switch (provider) {
    case "bedrock":
      return traced(createBedrockClient({
        region: req("AWS_REGION"),
        accessKeyId: req("AWS_ACCESS_KEY_ID"),
        secretAccessKey: req("AWS_SECRET_ACCESS_KEY"),
        sessionToken: opt("AWS_SESSION_TOKEN"),
        modelId: opt("BEDROCK_MODEL_ID"),
      }));
    case "anthropic":
      return traced(createAnthropicClient({
        apiKey: req("ANTHROPIC_API_KEY"),
        model: opt("ANTHROPIC_MODEL"),
        baseUrl: opt("ANTHROPIC_BASE_URL"),
      }));
    case "ollama":
      return traced(createOllamaClient({
        // Host is required and intentionally has no default - it changes often,
        // so the user supplies it every time (see ollama.ts).
        host: req("OLLAMA_HOST"),
        model: req("OLLAMA_MODEL"),
      }));
    default:
      throw new LlmConfigError(
        `LLM_PROVIDER="${provider}" is not recognised. Use one of: bedrock, anthropic, ollama.`,
      );
  }
}

/** True when a provider is selected. Lets callers log/branch without building a client. */
export function isLlmConfigured(): boolean {
  return !!opt("LLM_PROVIDER");
}

/**
 * Resolve an optionally-injected client for a "prefer the LLM, always fall
 * back" caller (llm-extract.ts, llm-triage.ts, pql-synth.ts).
 *
 * WHY THIS EXISTS, NOT JUST `client = getLlmClient()`: a default parameter
 * is evaluated eagerly, at the call site, BEFORE the function body - and
 * therefore before that function's own try/catch can see it. getLlmClient()
 * deliberately THROWS (not null) for a provider that is set but misconfigured
 * (missing key/host - see its own docstring). Every one of those callers
 * documents "no LLM / a transport error / bad JSON -> deterministic fallback,
 * never blocks the run" - but a thrown LlmConfigError from a default param
 * bypasses that fallback entirely and fails the run outright. Resolving here,
 * inside the caller's own async body, brings the same throw inside its
 * try/catch instead.
 */
export function resolveLlmClient(
  client?: LlmClient | null,
): { client: LlmClient | null; configError: string | null } {
  if (client !== undefined) return { client, configError: null };
  try {
    return { client: getLlmClient(), configError: null };
  } catch (err) {
    return { client: null, configError: (err as Error).message };
  }
}

/**
 * Wrap a client so every completion is TRACED into the same tool-call log/live
 * view MCP calls use (see traceExternalCall) - duration, prompt size, model,
 * token usage, and any error, all visible in the run trace with no per-call-site
 * plumbing. Applied once in build() below, so all three providers and every
 * caller get it for free. A no-op outside a traced context (e.g. the preview
 * endpoint), where it just runs the call.
 */
function traced(client: LlmClient): LlmClient {
  return {
    id: client.id,
    complete: (reqArg) =>
      traceExternalCall(
        `llm:${client.id}`,
        {
          promptChars: reqArg.prompt.length,
          maxTokens: reqArg.maxTokens ?? null,
          temperature: reqArg.temperature ?? 0,
        },
        async () => client.complete(reqArg),
      ),
  };
}
