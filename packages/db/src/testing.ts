import type { UpsertEntityInput, UpsertTenantInput } from "@tunnelvision/core";
import { Pool } from "pg";
import { createMemoryRepository } from "./repository.js";

/** Test-only reset. The explicit flag acknowledges all memory/evidence is removed. */
export async function resetDatabase(connectionString: string, options: { confirm: true }): Promise<void> {
  if (options?.confirm !== true) throw new Error("Database reset requires confirm: true");
  const pool = new Pool({ connectionString });
  try {
    await pool.query(`TRUNCATE TABLE memory_edges, memory_sources, memory_entities,
      memories, source_versions, sources, entity_aliases, entities, tenants`);
  } finally { await pool.end(); }
}

/** Seed stable tenants/entities; source and memory fixtures use the normal adapter. */
export async function seedDatabase(connectionString: string, input: {
  tenants?: UpsertTenantInput[];
  entities?: UpsertEntityInput[];
}): Promise<void> {
  const repository = createMemoryRepository({ connectionString });
  try {
    for (const tenant of input.tenants ?? []) await repository.upsertTenant(tenant);
    for (const entity of input.entities ?? []) await repository.upsertEntity(entity);
  } finally { await repository.close(); }
}
