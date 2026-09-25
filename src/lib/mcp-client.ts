/**
 * Thin JSON-RPC 2.0 client for the MCP Lambdas deployed from chaunceyplum/mcp.
 * Every agent route here should go through this instead of talking to
 * Postgres, Adobe, Workfront, Databricks, or Snowflake directly — those
 * Lambdas already own auth (Adobe IMS, Workfront IMS, SSM-resolved
 * credentials) and the RAG/pgvector layer.
 *
 * That repo is actually MULTIPLE Lambdas behind one API Gateway
 * (template.yaml — they all share one implicit HttpApi, just different
 * routes):
 *   /mcp                       — the original AEC server: 238 Adobe/AWS/
 *                                 Databricks/Snowflake/GitHub tools, no
 *                                 shared name prefix.
 *   /mcp/workfront/core        — wf_core_*        (portfolios, programs,
 *                                 templates, projects, tasks, issues)
 *   /mcp/workfront/users       — wf_users_*        (companies, roles, users,
 *                                 teams, resource pools, allocations)
 *   /mcp/workfront/documents   — wf_docs_*         (folders, documents,
 *                                 versions, approvals, webhooks)
 *   /mcp/workfront/time-approval — wf_time_*       (approval paths,
 *                                 timesheets, hour entries, approvals)
 *   /mcp/workfront/metadata    — wf_metadata_*     (custom fields/forms)
 *   /mcp/workfront/search      — wf_search_*       (object/generic search,
 *                                 named queries, saved reports)
 *   /mcp/workfront/comments    — wf_comments_*     (comments, replies,
 *                                 reactions)
 *   /mcp/workfront/planning    — wf_planning_*     (Planning workspaces,
 *                                 record types, fields, views, records)
 *   /mcp/workfront/misc        — wf_misc_*         (notes, messages, report
 *                                 defs, calendars, prefs, config, journal)
 *   /mcp/fusion/org            — fusion_org_*      (organizations, teams,
 *                                 Fusion users)
 *   /mcp/fusion/connections    — fusion_conn_*     (app connections)
 *   /mcp/fusion/hooks          — fusion_hook_*     (webhooks/triggers)
 *   /mcp/fusion/scenarios      — fusion_scenario_* (scenario CRUD/execute)
 *   /mcp/fusion/executions     — fusion_exec_*     (execution history/logs)
 *
 * resolveMcpPath() below picks the right route from the tool name's prefix,
 * so callers just pass a tool name — they never need to know or care which
 * of the 15 Lambdas actually serves it.
 *
 * Endpoint contract (same for all 15):
 *   POST {route}   body: { jsonrpc: "2.0", method, params, id }
 *   methods: "initialize" | "tools/list" | "tools/call"
 *   tools/call params: { name: <tool name>, arguments: <object> }
 *
 * All tool arguments are sent as JSON-serializable values; the Lambda side
 * auto-parses JSON-encoded strings back into dict/list for legacy MCP
 * clients, but plain objects/arrays work directly.
 *
 * Least privilege: callMcpTool requires the caller's taskId and checks it
 * against that task's `allowedTools` in src/lib/pipeline/registry.ts before
 * the request ever leaves this process. None of these Lambdas has any
 * concept of "which agent is calling" — this is the only enforcement point,
 * so every agent route MUST call through here rather than hitting an MCP
 * route directly.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { PIPELINE } from "./pipeline/registry";
import type { TaskId } from "./pipeline/types";
import * as liveProgress from "./live-progress";

/**
 * One MCP call, request and response together — the raw ground truth
 * behind whatever an agent's `message`/`output` says it concluded.
 *
 * Captured transparently: nothing that calls callMcpTool (aep.ts,
 * workfront.ts, workfront-notes.ts, ...) had to change to produce this — see
 * withToolCallLog below.
 */
export type ToolCallRecord = {
  name: string;
  args: Record<string, unknown>;
  startedAt: string;
  durationMs: number;
  /** Present on success. Truncated (see TRUNCATE_AT) so one huge list_schemas can't bloat a task_run row. */
  result?: unknown;
  resultTruncated?: boolean;
  /** Present on failure, instead of `result`. */
  error?: string;
};

const TRUNCATE_AT = 20_000;

/** JSON-serialize `value`, truncating the STRING (not the structure) past TRUNCATE_AT chars. */
function truncatedJson(value: unknown): { json: unknown; truncated: boolean } {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return { json: String(value), truncated: false };
  }
  if (text.length <= TRUNCATE_AT) return { json: value, truncated: false };
  return { json: `${text.slice(0, TRUNCATE_AT)}… (truncated, ${text.length} chars total)`, truncated: true };
}

type ToolCallContext = { log: ToolCallRecord[]; runId: string; taskId: TaskId };
const toolCallLogStorage = new AsyncLocalStorage<ToolCallContext>();

/**
 * Run `fn`, collecting every callMcpTool call made anywhere inside it —
 * including calls several functions deep, in a different module entirely —
 * into the returned `toolCalls` list, in call order.
 *
 * An agent route wraps its whole handler body in this and puts the result
 * in `AgentResponse.metadata.toolCalls`, which the orchestrator already
 * persists verbatim to task_runs.metadata (see orchestrator.ts) - no schema
 * change, no per-call-site plumbing.
 *
 * `runId`/`taskId` are new alongside `fn` (every call site updated) - not
 * for this function's own return value, but so callMcpTool below can also
 * publish each call to live-progress.ts AS IT HAPPENS, not just collect it
 * for the final return. Same AsyncLocalStorage context serves both jobs;
 * see live-progress.ts for why a live, mid-request view needed adding at
 * all.
 */
export async function withToolCallLog<T>(
  runId: string,
  taskId: TaskId,
  fn: () => Promise<T>,
): Promise<{ result: T; toolCalls: ToolCallRecord[] }> {
  const log: ToolCallRecord[] = [];
  liveProgress.setCurrentAgent(runId, taskId);
  const result = await toolCallLogStorage.run({ log, runId, taskId }, fn);
  return { result, toolCalls: log };
}

/** The run/agent the current async call chain belongs to, or null outside a traced run (e.g. preview). */
export function currentTraceContext(): { runId: string; taskId: TaskId } | null {
  const ctx = toolCallLogStorage.getStore();
  return ctx ? { runId: ctx.runId, taskId: ctx.taskId } : null;
}

/**
 * Trace a NON-MCP external call (today: an LLM completion) into the exact same
 * tool-call log and live view MCP calls use, so the UI renders it with zero new
 * plumbing. Records `name` (e.g. "llm:anthropic:claude-…"), the args summary,
 * duration, and result/error - and publishes start/finish to live-progress so a
 * mid-request poller sees "calling the model right now" the same way it sees an
 * MCP call in flight.
 *
 * A no-op passthrough when no withToolCallLog wrapper is active (e.g. the
 * preview endpoint calls the LLM outside a run) - it simply runs `fn`. This is
 * the one place external-call tracing lives, so LLM providers don't each
 * reimplement it and can't drift from how MCP calls are recorded.
 */
export async function traceExternalCall<T>(
  name: string,
  args: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx = toolCallLogStorage.getStore();
  if (!ctx) return fn(); // untraced context (e.g. preview) - just run it
  const startedAt = new Date();
  const liveId = liveProgress.startCall(ctx.runId, ctx.taskId, name, args);
  try {
    const value = await fn();
    const { json, truncated } = truncatedJson(value);
    ctx.log.push({ name, args, startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(), result: json, resultTruncated: truncated });
    liveProgress.finishCall(ctx.runId, liveId, { status: "success", durationMs: Date.now() - startedAt.getTime(), result: json, resultTruncated: truncated });
    return value;
  } catch (err) {
    ctx.log.push({ name, args, startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(), error: (err as Error).message });
    liveProgress.finishCall(ctx.runId, liveId, { status: "error", durationMs: Date.now() - startedAt.getTime(), error: (err as Error).message });
    throw err;
  }
}

const MCP_SERVER_ROUTES: Array<{ prefix: string; path: string }> = [
  { prefix: "wf_core_", path: "/mcp/workfront/core" },
  { prefix: "wf_users_", path: "/mcp/workfront/users" },
  { prefix: "wf_docs_", path: "/mcp/workfront/documents" },
  { prefix: "wf_time_", path: "/mcp/workfront/time-approval" },
  { prefix: "wf_metadata_", path: "/mcp/workfront/metadata" },
  { prefix: "wf_search_", path: "/mcp/workfront/search" },
  { prefix: "wf_comments_", path: "/mcp/workfront/comments" },
  { prefix: "wf_planning_", path: "/mcp/workfront/planning" },
  { prefix: "wf_misc_", path: "/mcp/workfront/misc" },
  { prefix: "fusion_org_", path: "/mcp/fusion/org" },
  { prefix: "fusion_conn_", path: "/mcp/fusion/connections" },
  { prefix: "fusion_hook_", path: "/mcp/fusion/hooks" },
  { prefix: "fusion_scenario_", path: "/mcp/fusion/scenarios" },
  { prefix: "fusion_exec_", path: "/mcp/fusion/executions" },
];

/** Everything without a wf_ or fusion_ prefix is one of the original 238 AEC tools. */
function resolveMcpPath(toolName: string): string {
  return MCP_SERVER_ROUTES.find((r) => toolName.startsWith(r.prefix))?.path ?? "/mcp";
}

export class McpError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpError";
  }
}

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * All 15 Lambdas share one API Gateway (template.yaml's implicit
 * ServerlessHttpApi), so the base domain is derived from MCP_ENDPOINT_URL
 * (the original .../mcp AEC endpoint) by stripping its trailing /mcp —
 * no separate env var needed per Workfront/Fusion server.
 */
/**
 * A gateway, if one is configured.
 *
 * MCP_GATEWAY_URL points at something that fronts an estate of MCP servers -
 * CX Agent Manager's /mcp, in our deployment. It resolves a bare tool name to
 * whichever registered server actually exposes it, so this client needs no
 * route map and no per-server URL, and the choice of backing server becomes
 * configuration in one place instead of an env var in this app.
 *
 * MCP_GATEWAY_TOKEN is sent as a bearer token when present. It is the gateway's
 * credential, NOT the upstream's: the gateway holds the Adobe tokens, and this
 * app never sees them.
 */
function getGatewayUrl(): string | null {
  const url = process.env.MCP_GATEWAY_URL;
  return url && url.trim() ? url.trim().replace(/\/+$/, "") : null;
}

/**
 * Which gateway-registered server a tool lives on.
 *
 * The gateway namespaces every tool it re-exposes by its source server -
 * `adobe-aec__search_adobe_knowledge` - so two upstreams shipping the same tool
 * name cannot shadow each other, and nothing upstream can shadow one of the
 * gateway's own tools.
 *
 * THIS WAS A SINGLE GLOBAL PREFIX AND THAT WAS WRONG. One prefix assumes the
 * whole estate is one server. It is not: knowledge search is on the Adobe
 * Experience Cloud server and Workfront objects are on the Workfront connector,
 * so prefixing everything with `adobe-aec` produced
 * `adobe-aec__workflow_create_any_object`, which does not exist - and Agent 1's
 * Workfront create failed on it while the run still read as completed.
 *
 * MCP_GATEWAY_ROUTES maps server id to the tool-name prefixes it serves:
 *
 *   adobe-aec:adobe_,search_,cja_,dataprep_,destination_,flow_,msb_,query_,reactor_,source_,execute_sql,knowledge_base_health;workfront-adobe:workflow_,comment-stream_,approvals_,insights_,planning_
 *
 * This list is a statement about what THIS APP actually calls, not the
 * gateway's full catalog - it has grown twice already for exactly this
 * reason. First `insights_` was missing, so every insights_* call
 * (including resolveIntakeQueue's insights_find_id_by_name) went out
 * unprefixed and failed with "Tool ... not found". Then `destination_` was
 * missing the same way when activation.ts started calling
 * destination_list_dataflows. Same class of silent-prefix bug the paragraph
 * above already describes, just for a prefix nobody had added yet rather
 * than one applied globally and wrong - and the fix is the same each time:
 * add the missing prefix, don't rename the tool.
 *
 * MCP_GATEWAY_PREFIX remains the fallback for anything unmatched. Both unset,
 * names go through untouched - which is right for a gateway that resolves bare
 * names itself.
 *
 * Note what is NOT here: any endpoint, credential, or decision about which real
 * MCP backs a server id. That is the gateway's business, which is the point of
 * pointing at one.
 */
function gatewayRoutes(): Array<{ server: string; prefixes: string[] }> {
  const raw = String(process.env.MCP_GATEWAY_ROUTES || "").trim();
  if (!raw) return [];
  return raw
    .split(";")
    .map((group) => group.trim())
    .filter(Boolean)
    .map((group) => {
      const [server, list] = group.split(":");
      return {
        server: (server || "").trim(),
        prefixes: String(list || "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      };
    })
    .filter((r) => r.server && r.prefixes.length);
}

function applyGatewayPrefix(toolName: string): string {
  if (!getGatewayUrl()) return toolName;
  if (toolName.includes("__")) return toolName; // already namespaced

  // Longest prefix wins, so a specific rule beats a general one.
  const matches = gatewayRoutes()
    .flatMap((r) => r.prefixes.map((prefix) => ({ server: r.server, prefix })))
    .filter((m) => toolName.startsWith(m.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length);

  if (matches.length) return `${matches[0].server}__${toolName}`;

  const fallback = String(process.env.MCP_GATEWAY_PREFIX || "").trim();
  return fallback ? `${fallback}__${toolName}` : toolName;
}

function getApiBase(): string {
  const url = process.env.MCP_ENDPOINT_URL;
  if (!url) {
    throw new McpError(
      "MCP_ENDPOINT_URL is not set. Copy .env.local.example to .env.local " +
        "and paste in the McpEndpointUrl SAM output from the chaunceyplum/mcp deployment.",
    );
  }
  return url.replace(/\/mcp\/?$/, "");
}

function getEndpointForTool(toolName: string): string {
  // One endpoint for everything when a gateway is configured. The prefix-to-path
  // map below describes ONE deployment's topology; a gateway's whole job is that
  // its callers do not need to know any topology.
  const gateway = getGatewayUrl();
  if (gateway) return gateway;
  return `${getApiBase()}${resolveMcpPath(toolName)}`;
}

/**
 * Headers for an MCP call. A bare estate needs none; a gateway usually does.
 *
 * MCP_GATEWAY_HEADER names the header, because gateways genuinely differ:
 * Authorization/Bearer is the common case, but a service-to-service key is
 * often its own header - CX Agent Manager takes `x-api-key`. Defaulting to
 * Authorization and offering no way to change it meant the only credential the
 * gateway accepted could not be sent, and every call came back 401.
 */
function mcpHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = process.env.MCP_GATEWAY_TOKEN;
  if (!getGatewayUrl() || !token || !token.trim()) return headers;

  const name = (process.env.MCP_GATEWAY_HEADER || "Authorization").trim();
  headers[name] = name.toLowerCase() === "authorization" && !token.startsWith("Bearer ")
    ? `Bearer ${token}`
    : token;
  return headers;
}

/**
 * A bare "HTTP 403" with nothing else is nearly useless for debugging a
 * gateway/API Gateway misconfiguration — the body usually says exactly why
 * (missing API key, an authorizer's rejection reason, a proxy's own error
 * page). Truncated to 300 chars so a stray HTML error page doesn't flood
 * the thrown error.
 */
async function describeError(res: Response): Promise<string> {
  const bodyText = await res.text().catch(() => "");
  const preview = bodyText ? ` — ${bodyText.slice(0, 300)}` : "";
  return `HTTP ${res.status} (${res.statusText})${preview}`;
}

let requestCounter = 0;

function assertToolAllowed(taskId: TaskId, name: string): void {
  const agent = PIPELINE.find((a) => a.name === taskId);
  if (!agent) {
    throw new McpError(`callMcpTool: unknown taskId "${taskId}" — not in the pipeline registry.`);
  }
  if (!agent.allowedTools.includes(name)) {
    throw new McpError(
      `Task "${taskId}" is not allowed to call MCP tool "${name}". ` +
        `If this is intentional, add "${name}" to allowedTools for "${taskId}" ` +
        `in src/lib/pipeline/registry.ts.`,
    );
  }
}

/**
 * Call a single MCP tool by name and return its parsed result, scoped to
 * the calling task's allowlist (see assertToolAllowed above).
 *
 * Throws McpError on a scoping violation, transport failure, JSON-RPC
 * error, or a tool-level error (isError: true in the MCP content envelope).
 */
export async function callMcpTool<T = unknown>(
  taskId: TaskId,
  name: string,
  args: Record<string, unknown> = {},
  { timeoutMs = 30_000 }: { timeoutMs?: number } = {},
): Promise<T> {
  assertToolAllowed(taskId, name);

  const startedAt = new Date();
  const ctx = toolCallLogStorage.getStore();
  const record = (partial: Pick<ToolCallRecord, "result" | "resultTruncated"> | Pick<ToolCallRecord, "error">) => {
    if (!ctx) return; // no withToolCallLog wrapper active - fine, this call just isn't traced
    ctx.log.push({
      name,
      args,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      ...partial,
    });
  };
  // Published the moment the call STARTS, not just when it finishes - this
  // is the whole point (see live-progress.ts's docstring): a poller mid-
  // request needs to see "calling X right now", not just the finished list
  // withToolCallLog returns once the whole step is done.
  const liveId = ctx ? liveProgress.startCall(ctx.runId, taskId, name, args) : -1;

  try {
    const value = await callMcpToolInner<T>(name, args, timeoutMs);
    const { json, truncated } = truncatedJson(value);
    record({ result: json, resultTruncated: truncated });
    if (ctx) {
      liveProgress.finishCall(ctx.runId, liveId, {
        status: "success",
        durationMs: Date.now() - startedAt.getTime(),
        result: json,
        resultTruncated: truncated,
      });
    }
    return value;
  } catch (err) {
    record({ error: (err as Error).message });
    if (ctx) {
      liveProgress.finishCall(ctx.runId, liveId, {
        status: "error",
        durationMs: Date.now() - startedAt.getTime(),
        error: (err as Error).message,
      });
    }
    throw err;
  }
}

/** The actual wire call - separated from callMcpTool so the try/record/throw above stays a single, simple wrapper around every return/throw path below. */
async function callMcpToolInner<T>(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(getEndpointForTool(name), {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++requestCounter,
        method: "tools/call",
        // The prefixed name goes on the wire. assertToolAllowed above has
        // already run against the BARE name: the allowlist is a statement about
        // what this agent is permitted to do, and must not change meaning
        // because of how the call happens to be routed.
        params: { name: applyGatewayPrefix(name), arguments: args },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new McpError(
      `MCP request to tool "${name}" failed: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new McpError(
      `MCP endpoint returned an error for tool "${name}": ${await describeError(res)}`,
      res.status,
    );
  }

  const body = (await res.json()) as JsonRpcResponse<ToolCallResult>;

  if (body.error) {
    throw new McpError(
      `MCP tool "${name}" failed: ${body.error.message}`,
      body.error.code,
      body.error.data,
    );
  }

  const result = body.result;
  if (result?.isError) {
    const text = result.content?.map((c) => c.text).join("\n") ?? "unknown error";
    throw new McpError(`MCP tool "${name}" returned an error: ${text}`);
  }

  // Tool results come back as MCP content blocks; unwrap the common case of a
  // single JSON text block so callers get native objects, not strings.
  const firstText = result?.content?.[0]?.text;
  if (firstText !== undefined) {
    try {
      return JSON.parse(firstText) as T;
    } catch {
      return firstText as unknown as T;
    }
  }
  return result as unknown as T;
}
