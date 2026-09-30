import type { Entity, MemoryRepository, Pagination, Tenant } from "@tunnelvision/core";

/** Read-only projection of the frozen core, plus the agreed discovery reads. */
export interface MemoryReadRepository extends Pick<MemoryRepository,
  | "getSource" | "getSourceVersion" | "getMemory" | "getMemoryEntities"
  | "getMemorySources" | "searchMemories" | "getEntityMemories"
  | "getTimeline" | "getRelatedMemories" | "getOpenIssues"
> {
  getTenant(query: { tenantId: string }): Promise<Tenant | null>;
  listTenants(query: Pagination): Promise<{ items: Tenant[]; nextOffset: number | null }>;
  getEntity(query: { tenantId: string; entityId: string }): Promise<Entity | null>;
  searchEntities(query: Pagination & { tenantId: string; query?: string }): Promise<{
    items: Entity[];
    nextOffset: number | null;
  }>;
}

export interface ClosableMemoryReadRepository extends MemoryReadRepository {
  close(): Promise<void>;
}

/** Composition waits for the DB implementation; tool code needs only reads. */
export async function connectMemoryRepository(connectionString: string): Promise<ClosableMemoryReadRepository> {
  const adapter = await import("@tunnelvision/db");
  const factory = (adapter as unknown as {
    createMemoryRepository?: (options: { connectionString: string }) =>
      ClosableMemoryReadRepository | Promise<ClosableMemoryReadRepository>;
  }).createMemoryRepository;
  if (typeof factory !== "function") {
    throw new Error("@tunnelvision/db must export createMemoryRepository({ connectionString }).");
  }
  return factory({ connectionString });
}
