import { Client } from "pg";

/**
 * Run EXPLAIN (FORMAT JSON, ANALYZE FALSE) against the configured DATABASE_URL.
 *
 * The SET LOCAL enable_seqscan = off hint MUST execute inside the same transaction
 * as the EXPLAIN query: SET LOCAL is scoped to the current transaction, and the
 * pg driver runs each client.query() in autocommit mode (an implicit single-statement
 * transaction). Without an explicit BEGIN/ROLLBACK pair around both statements, the
 * setting is committed-and-discarded before the EXPLAIN runs in its own fresh implicit
 * transaction, and the planner falls back to its default (enable_seqscan = on). On a
 * small / empty test DB the planner then prefers Seq Scan, making the GIN-pushdown
 * assertion in explain.test.ts unreliable.
 *
 * We ROLLBACK (not COMMIT) to preserve the read-only contract: EXPLAIN without
 * ANALYZE has no side effects today, but ROLLBACK keeps the helper safe if a future
 * caller passes an EXPLAIN ANALYZE on a DML statement.
 */
export async function explainPlan(query: string): Promise<unknown[]> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL enable_seqscan = off");
      const res = await client.query(`EXPLAIN (FORMAT JSON, ANALYZE FALSE) ${query}`);
      await client.query("ROLLBACK");
      return res.rows[0]["QUERY PLAN"] as unknown[];
    } catch (err) {
      // Best-effort rollback so the connection isn't returned in an aborted-tx state.
      // Original error must propagate so the test fails for the real reason.
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  } finally {
    await client.end();
  }
}

/** Recursively walk a Postgres EXPLAIN JSON plan looking for a node type. */
export function planContainsNodeType(plan: unknown, nodeType: string): boolean {
  if (!plan || typeof plan !== "object") return false;
  const obj = plan as Record<string, unknown>;
  if (obj["Node Type"] === nodeType) return true;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (Array.isArray(v)) {
      for (const child of v) if (planContainsNodeType(child, nodeType)) return true;
    } else if (typeof v === "object" && v !== null) {
      if (planContainsNodeType(v, nodeType)) return true;
    }
  }
  return false;
}

/** Recursively walk an EXPLAIN JSON plan looking for an index by name. */
export function planUsesIndex(plan: unknown, indexName: string): boolean {
  if (!plan || typeof plan !== "object") return false;
  const obj = plan as Record<string, unknown>;
  if (obj["Index Name"] === indexName) return true;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (Array.isArray(v)) {
      for (const child of v) if (planUsesIndex(child, indexName)) return true;
    } else if (typeof v === "object" && v !== null) {
      if (planUsesIndex(v, indexName)) return true;
    }
  }
  return false;
}
