import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const migrations = ["0001_initial"] as const;

/** Applies checked-in SQL atomically; serializes concurrent runners with a DB lock. */
export async function migrateDatabase(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(748216309)");
      await client.query(`CREATE TABLE IF NOT EXISTS tunnelvision_migrations (
        id text PRIMARY KEY, content_hash text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      for (const id of migrations) {
        const migration = await readFile(new URL(`../migrations/${id}.sql`, import.meta.url), "utf8");
        const hash = createHash("sha256").update(migration).digest("hex");
        const existing = await client.query<{ content_hash: string }>("SELECT content_hash FROM tunnelvision_migrations WHERE id = $1", [id]);
        if (existing.rows[0]) {
          if (existing.rows[0].content_hash !== hash) throw new Error(`Applied migration ${id} has changed`);
          continue;
        }
        await client.query(migration);
        await client.query("INSERT INTO tunnelvision_migrations (id, content_hash) VALUES ($1, $2)", [id, hash]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  } finally { await pool.end(); }
}
