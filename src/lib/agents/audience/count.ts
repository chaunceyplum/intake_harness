import { Client } from "pg";
import { callMcpTool } from "@/lib/mcp-client";
import type { TaskId } from "@/lib/pipeline/types";
import type { SegmentSizeEstimate } from "./aep";

/**
 * An estimated audience size in seconds, from Adobe Query Service's
 * Postgres interface - the way ~/am's count.ts found works on this estate.
 *
 * Why not the other routes (all verified on tapdemo, Sep 2026):
 * - adobe_create_segment_estimate posts to /segment/definitions/{id}/estimate,
 *   which AEP does not have (404) - an estimate belongs to a PREVIEW.
 * - adobe_create_segment_job: this org only allows scheduled evaluation
 *   ("Non-scheduled segment jobs are not allowed ... B2B simplification").
 * - query_run: the async API sat in SUBMITTED for minutes, even `SELECT 1`.
 *
 * query_get_connection_parameters hands out host, database, user and a
 * short-lived token for the PSQL endpoint; connecting directly answers in
 * seconds. The token is fetched with `secretResult`, so it never lands in the
 * run's tool-call log that Developer mode shows.
 *
 * WHAT IT COUNTS: records in the dataset that holds the audience's fields,
 * matching the rule - an estimate, labelled as one. AEP's own count merges
 * identities across datasets and can differ. A rule this can't translate
 * exactly, or whose fields live elsewhere, gets no number rather than a
 * wrong one.
 */

/**
 * The dataset table to count in, per sandbox. tapdemo's CB fields live in
 * "CB Product Profile Dataset UKS"; AEP_PROFILE_TABLE overrides it.
 */
const DEFAULT_TABLES: Record<string, string> = { tapdemo: "cb_product_profile_dataset_uks" };

export function profileTable(sandbox?: string): string | null {
  const configured = (process.env.AEP_PROFILE_TABLE || "").trim();
  if (configured) return configured;
  return sandbox ? DEFAULT_TABLES[sandbox] ?? null : null;
}

/**
 * The PQL rule as a SQL WHERE clause, or null when it uses anything this
 * doesn't translate exactly. Handles what the studio's rules use:
 * comparisons, and/or/not, parentheses, and the existence checks.
 *   "Y"            -> 'Y'        (in SQL, double quotes name a column)
 *   x.isNotNull()  -> x is not null      x.isNull() -> x is null
 *   x != null      -> x is not null      x = null   -> x is null
 * Never lets through a statement separator or comment, so the count query
 * can only ever be the one SELECT.
 */
export function pqlToSql(pql: string): string | null {
  let sql = String(pql || "").trim();
  if (!sql || /;|--|\/\*/.test(sql)) return null;
  sql = sql
    .replace(/\.(isNotNull|exists)\(\)/g, " is not null")
    .replace(/\.isNull\(\)/g, " is null")
    .replace(/!=\s*null\b/gi, " is not null")
    .replace(/=\s*null\b/gi, " is null")
    .replace(/"([^"]*)"/g, (_m, inner: string) => `'${inner.replace(/'/g, "''")}'`);
  // Anything still shaped like a call (x.contains(...), count(...)) or an
  // array literal is PQL this doesn't translate - no number beats a wrong one.
  if (/[A-Za-z_]\s*\(|\[|\]/.test(sql.replace(/\b(and|or|not)\s*\(/gi, ""))) return null;
  return sql;
}

type ConnectionParams = { host: string; port: number; database: string; username: string; token: string };

async function connectionParams(taskId: TaskId, sandbox?: string): Promise<ConnectionParams> {
  const raw = await callMcpTool<unknown>(
    taskId,
    "query_get_connection_parameters",
    sandbox ? { sandbox } : {},
    { secretResult: true },
  );
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Record<string, unknown>;
  const host = String(parsed.host || "");
  const token = String(parsed.token || parsed.password || "");
  if (!host || !token) throw new Error("Query Service returned no connection details");
  return {
    host,
    port: Number(parsed.port || 80),
    database: String(parsed.database || parsed.dbName || `${sandbox ?? "prod"}:all`),
    username: String(parsed.username || parsed.user || ""),
    token,
  };
}

/**
 * Estimate how many profiles match `pql`. Never throws and never invents a
 * count: when no number can be taken, `available: false` says why, and the
 * caller falls back to AEP's own sizing.
 */
export async function estimateAudienceCount(taskId: TaskId, pql: string, sandbox?: string): Promise<SegmentSizeEstimate> {
  const table = profileTable(sandbox);
  if (!table) return { available: false, reason: "no dataset is configured to estimate against in this sandbox" };
  if (!/^[A-Za-z0-9_]+$/.test(table)) return { available: false, reason: "the configured dataset table name is invalid" };
  const where = pqlToSql(pql);
  if (!where) return { available: false, reason: "this rule can't be translated exactly for an estimate" };

  let client: Client | null = null;
  try {
    const p = await connectionParams(taskId, sandbox);
    client = new Client({
      host: p.host,
      port: p.port,
      database: p.database,
      user: p.username,
      password: p.token,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15_000,
      query_timeout: 30_000,
      statement_timeout: 30_000,
    });
    await client.connect();
    const res = await client.query(`select count(*) as profiles from ${table} where ${where}`);
    const count = Number((res.rows?.[0] as { profiles?: unknown } | undefined)?.profiles);
    if (!Number.isFinite(count) || count < 0) return { available: false, reason: "Query Service returned no usable count" };
    return { available: true, count, estimated: true };
  } catch (err) {
    return { available: false, reason: `an estimate could not be taken: ${(err as Error).message}` };
  } finally {
    if (client) await client.end().catch(() => {});
  }
}
