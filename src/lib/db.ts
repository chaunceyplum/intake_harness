import { Pool, type QueryResultRow } from "pg";

/**
 * Shared Postgres pool for this harness's own observability tables
 * (see db/schema.sql: `runs`, `tasks`, `task_runs`). This is the SAME RDS
 * instance the Python MCP server (chaunceyplum/mcp) uses for pgvector, but
 * a DIFFERENT set of tables, kept distinct from that repo's Python
 * orchestrator tables (`executions` / `execution_resources`) so the two
 * orchestration layers never collide.
 */

let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    let raw = process.env.DATABASE_URL;
    if (!raw) {
      throw new Error(
        "DATABASE_URL is not set. Copy .env.local.example to .env.local.",
      );
    }
    raw = raw.trim();
    // A DATABASE_URL copied out of a quoted shell command (e.g.
    // `export DATABASE_URL='postgresql://...sslmode=require'`) commonly
    // brings a stray leading and/or trailing quote character into the .env
    // file, since dotenv only strips a quote pair wrapping the ENTIRE
    // value, not one accidentally left on just one end. Strip a matched
    // wrapping pair here, and see the per-param cleanup below for the
    // unmatched case (a lone trailing quote stuck to the last param value).
    if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
      raw = raw.slice(1, -1);
    }

    // Parse out any ssl/sslmode query params and strip them from the string
    // before handing it to Pool. If they're left in, pg's own connection-
    // string parser (pg-connection-string) independently derives its own
    // strict ssl config from e.g. "sslmode=require" and that can win over
    // the explicit `ssl` option below, producing a hard-to-debug
    // SELF_SIGNED_CERT_IN_CHAIN error against RDS even though we asked for
    // rejectUnauthorized: false. Stripping them means our explicit `ssl`
    // object below is the only source of truth.
    const url = new URL(raw);
    // Also strip stray quote chars from the individual value: a lone
    // trailing quote (no matching leading one, so the check above doesn't
    // catch it) turns "require" into "require'", which silently fails the
    // exact-match check below, disables SSL, and produces a confusing
    // unrelated-looking "no pg_hba.conf entry ... no encryption" error
    // instead of an obvious one.
    const clean = (v: string | null) => v?.replace(/['"]/g, "") ?? null;
    const sslMode = clean(url.searchParams.get("sslmode"));
    const sslFlag = clean(url.searchParams.get("ssl"));
    const wantsSsl = sslMode === "require" || sslMode === "verify-ca" || sslMode === "verify-full" || sslFlag === "true";
    url.searchParams.delete("sslmode");
    url.searchParams.delete("ssl");

    pool = new Pool({
      connectionString: url.toString(),
      // RDS's cert chain isn't in Node's default trust store, so this
      // encrypts the connection without verifying the certificate/hostname
      // (matches sslmode=require's actual guarantee, not verify-full's).
      // For real hostname+CA verification, pass `ca: fs.readFileSync(...)`
      // here with the RDS combined CA bundle instead of rejectUnauthorized.
      ssl: wantsSsl ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const { rows } = await getPool().query<T>(text, params);
  return rows;
}

/**
 * Run `fn` while holding a Postgres session-level advisory lock keyed by
 * `key` - the mutual-exclusion primitive orchestrator.ts's resumeRun/
 * continueRun/retryRun use so two concurrent requests for the SAME run_id
 * (a double-clicked Resume/Approve/Retry button, or a retried client call)
 * can't both pass their own "is this run in the right status" check and
 * both advance the pipeline in parallel - which would run one agent step
 * twice and write two task_runs rows for it.
 *
 * WHY A DEDICATED CONNECTION, NOT THE SHARED `query()` HELPER: an advisory
 * lock is tied to the Postgres BACKEND (session) that took it, and `query()`
 * borrows a arbitrary connection from the pool per call - so a lock taken on
 * one pooled connection could never be reliably released on another. This
 * checks a client out of the pool for the lock's whole lifetime instead, and
 * always releases (both the lock and the connection) in `finally`.
 *
 * `hashtext(key)` folds the key into a 32-bit int for pg_try_advisory_lock -
 * a rare hash collision between two DIFFERENT run_ids only costs unnecessary
 * serialization between them, never a false "already locked" for the wrong
 * reason, so this is a safe tradeoff against plumbing a real bigint key.
 *
 * Throws immediately (does not queue/wait) when the lock is already held -
 * a caller that loses the race should surface a clear "already in progress"
 * error, not block and then run anyway.
 */
export async function withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
      [key],
    );
    if (!rows[0]?.locked) {
      throw new Error(`"${key}" is already being processed by another request.`);
    }
    try {
      return await fn();
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [key]);
    }
  } finally {
    client.release();
  }
}
