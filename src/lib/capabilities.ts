/**
 * Capability signals - the things the agents CANNOT do because of the
 * environment, surfaced as first-class, queryable facts instead of being
 * inferred by a reader from a `created: false` buried in one run's output.
 *
 * One capability gates whether this pipeline can actually finish its job,
 * and it is outside this app's control:
 *
 *   WORKFRONT WRITES. 44 of the connector's 94 tools are writes a Workfront
 *   admin enables per tenant (Setup > System > Preferences). Until then
 *   Agent 1 creates nothing - it produces an honest dry-run "wouldHaveCreated"
 *   payload. Whether that switch is on is the single biggest "can it do the
 *   job" question, and it should be answerable directly, not deduced from a
 *   run that happened to dry-run.
 *
 * This asks the gateway what tools it actually exposes (tools/list) and
 * checks for the specific names, so the answer reflects the live
 * deployment rather than a hardcoded assumption. It is a diagnostic, not an
 * agent tool call, so it does NOT go through callMcpTool's per-task
 * allowlist - it lists tools, it invokes none.
 */

import { workfrontToolset } from "@/lib/workfront-tools";

/** The write tools whose presence means "Agent 1 can actually create in Workfront". */
function workfrontWriteToolNames(): string[] {
  const set = workfrontToolset();
  return [set.create, set.update, set.createComment];
}

export type CapabilityReport = {
  checkedAt: string;
  /** False when no gateway/endpoint is configured - we then can't check anything. */
  reachable: boolean;
  endpoint: string | null;
  error: string | null;
  workfrontWrites: {
    /** Are the write tools present in the live tool list? */
    enabled: boolean | "unknown";
    tools: Array<{ name: string; present: boolean }>;
    note: string;
  };
  /**
   * The LLM backend, when one is configured (LLM_PROVIDER set). Answers the
   * first question on every enablement - "is my provider/host actually
   * reachable?" - as a first-class fact, so you learn it here instead of by
   * starting a run and watching it silently fall back to the deterministic
   * parser. Especially for Ollama, whose host changes often.
   */
  llm: {
    /** Is a provider selected at all? */
    configured: boolean;
    /** Which one, when configured. */
    provider: string | null;
    /** Reachable? "unknown" when unconfigured or not probed. */
    reachable: boolean | "unknown";
    note: string;
  };
};

/** Resolve the one endpoint to ask for a tool list - gateway if set, else the AEC base. */
function listEndpoint(): string | null {
  const gateway = process.env.MCP_GATEWAY_URL;
  if (gateway && gateway.trim()) return gateway.trim().replace(/\/+$/, "");
  const base = process.env.MCP_ENDPOINT_URL;
  if (base && base.trim()) return base.trim();
  return null;
}

/** Headers for the tools/list call - mirror the gateway auth the client uses. */
function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const gateway = process.env.MCP_GATEWAY_URL;
  const token = process.env.MCP_GATEWAY_TOKEN;
  if (gateway && gateway.trim() && token && token.trim()) {
    const name = (process.env.MCP_GATEWAY_HEADER || "Authorization").trim();
    h[name] =
      name.toLowerCase() === "authorization" && !token.startsWith("Bearer ") ? `Bearer ${token}` : token;
  }
  return h;
}

/**
 * Ask the endpoint for its tool list and return the set of tool names it
 * exposes. Names may be gateway-namespaced (server__tool), so callers match
 * on suffix. Returns null (not throw) on any failure - "couldn't check" is a
 * capability answer of its own ("unknown"), not an error to surface as 500.
 */
async function liveToolNames(endpoint: string): Promise<Set<string> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { tools?: Array<{ name?: string }> } };
    const names = body.result?.tools?.map((t) => String(t.name || "")).filter(Boolean) ?? [];
    return new Set(names);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** A tool "is present" if its bare name, or any namespaced `*__name`, is in the live set. */
function present(names: Set<string>, bare: string): boolean {
  if (names.has(bare)) return true;
  for (const n of names) {
    if (n === bare || n.endsWith(`__${bare}`)) return true;
  }
  return false;
}

/**
 * Probe LLM reachability without a full model call where possible.
 *
 * - Unconfigured -> configured:false, reachable:"unknown".
 * - Ollama -> a cheap GET to the host's /api/tags (lists local models); this
 *   is the "is the host up right now" answer that matters most, since the host
 *   changes often.
 * - Bedrock/Anthropic -> config-validity only (are the required creds present?).
 *   We deliberately do NOT spend a paid token just to health-check; a present,
 *   well-formed config is reported reachable:"unknown" with a note, since the
 *   real check is the first extraction (which falls back safely anyway).
 */
async function probeLlm(): Promise<CapabilityReport["llm"]> {
  const provider = (process.env.LLM_PROVIDER || "").trim().toLowerCase();
  if (!provider) {
    return { configured: false, provider: null, reachable: "unknown", note: "No LLM_PROVIDER set - Intake/Review use the deterministic parser, Agent 3 drafts no PQL." };
  }

  if (provider === "ollama") {
    const rawHost = (process.env.OLLAMA_HOST || "").trim();
    if (!rawHost) {
      return { configured: true, provider, reachable: false, note: "LLM_PROVIDER=ollama but OLLAMA_HOST is not set." };
    }
    // getLlmClient() (lib/llm/index.ts) requires OLLAMA_MODEL just as much as
    // OLLAMA_HOST - Ollama has no default model. Checking only the host here
    // let this report back "reachable: true" for a config that still throws
    // LlmConfigError on the very first real call, a green check contradicted
    // immediately by the first run.
    if (!(process.env.OLLAMA_MODEL || "").trim()) {
      return { configured: true, provider, reachable: false, note: "LLM_PROVIDER=ollama but OLLAMA_MODEL is not set." };
    }
    let base = rawHost;
    if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
    try {
      const url = new URL(base);
      if (!url.port) url.port = "11434";
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      try {
        const res = await fetch(`${url.toString().replace(/\/+$/, "")}/api/tags`, { signal: controller.signal });
        return res.ok
          ? { configured: true, provider, reachable: true, note: `Ollama reachable at ${url.host}.` }
          : { configured: true, provider, reachable: false, note: `Ollama at ${url.host} returned HTTP ${res.status}.` };
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      return { configured: true, provider, reachable: false, note: `Ollama host unreachable: ${(err as Error).message}. The host may have changed - update OLLAMA_HOST.` };
    }
  }

  if (provider === "bedrock") {
    const ok = !!(process.env.AWS_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
    return { configured: true, provider, reachable: "unknown", note: ok ? "Bedrock credentials present; first extraction will confirm reachability (no paid health-check made)." : "LLM_PROVIDER=bedrock but AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are incomplete." };
  }

  if (provider === "anthropic") {
    const ok = !!process.env.ANTHROPIC_API_KEY;
    return { configured: true, provider, reachable: "unknown", note: ok ? "Anthropic API key present; first extraction will confirm reachability (no paid health-check made)." : "LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set." };
  }

  return { configured: true, provider, reachable: false, note: `Unrecognised LLM_PROVIDER="${provider}" (use bedrock, anthropic, or ollama).` };
}

export async function getCapabilities(): Promise<CapabilityReport> {
  const checkedAt = new Date().toISOString();
  const endpoint = listEndpoint();
  const llm = await probeLlm();

  if (!endpoint) {
    return {
      checkedAt,
      reachable: false,
      endpoint: null,
      error: "No MCP_GATEWAY_URL or MCP_ENDPOINT_URL configured, so no capability can be checked.",
      workfrontWrites: {
        enabled: "unknown",
        tools: workfrontWriteToolNames().map((name) => ({ name, present: false })),
        note: "Endpoint not configured.",
      },
      llm,
    };
  }

  const names = await liveToolNames(endpoint);

  if (!names) {
    return {
      checkedAt,
      reachable: false,
      endpoint,
      error: "Could not read a tool list from the endpoint (unreachable, timed out, or non-2xx).",
      workfrontWrites: {
        enabled: "unknown",
        tools: workfrontWriteToolNames().map((name) => ({ name, present: false })),
        note: "Tool list could not be read; write-enablement is unknown, not disabled.",
      },
      llm,
    };
  }

  const wfTools = workfrontWriteToolNames().map((name) => ({ name, present: present(names, name) }));
  const wfEnabled = wfTools.every((t) => t.present);

  return {
    checkedAt,
    reachable: true,
    endpoint,
    error: null,
    workfrontWrites: {
      enabled: wfEnabled,
      tools: wfTools,
      note: wfEnabled
        ? "Workfront write tools are present - Agent 1 can create the intake for real, not dry-run."
        : "One or more Workfront write tools are absent - writes are NOT enabled on this tenant " +
          "(a Workfront admin turns them on in Setup > System > Preferences). Agent 1 will dry-run: " +
          "it reports the exact payload it would have created rather than writing nothing silently.",
    },
    llm,
  };
}
