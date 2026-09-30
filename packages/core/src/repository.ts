import type {
  Entity,
  EntityAlias,
  Memory,
  MemoryEdge,
  MemoryEdgeType,
  MemoryEntity,
  MemorySource,
  MemoryStatus,
  MemoryType,
  Source,
  SourceVersion,
  Tenant,
} from "./models.js";

export type UpsertTenantInput = Omit<Tenant, "createdAt" | "updatedAt">;
export type UpsertSourceInput = Omit<Source, "id" | "createdAt" | "updatedAt">;
export type UpsertSourceVersionInput = Omit<SourceVersion, "id" | "ingestedAt">;
export type EntityAliasInput = Pick<EntityAlias, "kind" | "value">;
export type UpsertEntityInput = Omit<Entity, "createdAt" | "updatedAt"> & {
  aliases?: EntityAliasInput[];
};
export type CreateMemoryInput = Omit<Memory, "id" | "createdAt" | "updatedAt">;
export type UpdateMemoryInput = Pick<Memory, "id" | "tenantId"> &
  Partial<Omit<Memory, "id" | "tenantId" | "createdAt" | "updatedAt">>;

export interface MemoryLookup {
  tenantId: string;
  memoryId: string;
}

export interface SourceLookup {
  tenantId: string;
  sourceId: string;
}

export interface SourceVersionLookup {
  tenantId: string;
  sourceVersionId: string;
}

export interface EntityAliasLookup {
  tenantId: string;
  kind: string;
  value: string;
}

export interface Pagination {
  /** Integer 1..100; default 50. */
  limit?: number;
  /** Non-negative integer; default 0. */
  offset?: number;
}

export interface MemoryListQuery extends Pagination {
  tenantId: string;
  types?: MemoryType[];
  statuses?: MemoryStatus[];
}

export interface MemorySearchQuery extends MemoryListQuery {
  /** Optional lexical search across summary and content; no embeddings. */
  query?: string;
  /** Match memories linked to any of these entities. */
  entityIds?: string[];
}

export interface EntityMemoriesQuery extends MemoryListQuery {
  entityId: string;
}

export interface TimelineQuery extends MemoryListQuery {
  entityId?: string;
  /** Inclusive ISO datetime bounds on occurredAt, falling back to createdAt. */
  from?: string;
  to?: string;
}

export interface RelatedMemoriesQuery extends MemoryLookup, Pagination {
  edgeTypes?: MemoryEdgeType[];
  /** Default "both"; only direct neighbours are returned. */
  direction?: "incoming" | "outgoing" | "both";
}

export interface OpenIssuesQuery extends Pagination {
  tenantId: string;
  entityId?: string;
}

export interface MemoryPage {
  items: Memory[];
  nextOffset: number | null;
}

export interface RelatedMemory {
  memory: Memory;
  edge: MemoryEdge;
}

export interface RelatedMemoryPage {
  /** One item per matching edge; a neighbour may appear more than once. */
  items: RelatedMemory[];
  nextOffset: number | null;
}

/**
 * All operations are tenant-scoped; implementations must reject cross-tenant
 * references and check that evidence versions belong to the referenced source.
 * IDs are opaque strings. The adapter assigns IDs/timestamps unless supplied.
 * Lists default to createdAt descending, then ID ascending. Empty filter arrays
 * match nothing; omitted filters impose no restriction. Invalid paging fails.
 */
export interface MemoryRepository {
  /** Upsert by tenant ID. */
  upsertTenant(input: UpsertTenantInput): Promise<Tenant>;
  /** Upsert by (tenantId, system, externalId), preserving the source ID. */
  upsertSource(input: UpsertSourceInput): Promise<Source>;
  /**
   * Upsert by (tenantId, sourceId, version). Identical retries return the existing
   * snapshot; changed snapshot data for an existing version must be rejected.
   */
  upsertSourceVersion(input: UpsertSourceVersionInput): Promise<SourceVersion>;
  getSource(query: SourceLookup): Promise<Source | null>;
  getSourceVersion(query: SourceVersionLookup): Promise<SourceVersion | null>;
  /** Upsert by (tenantId, id); supplied aliases are added idempotently. */
  upsertEntity(input: UpsertEntityInput): Promise<Entity>;
  /** Exact kind/value match; return all matches so ambiguity is never hidden. */
  resolveEntityByAlias(query: EntityAliasLookup): Promise<Entity[]>;
  createMemory(input: CreateMemoryInput): Promise<Memory>;
  /** Missing memory fails; omitted fields stay unchanged, null clears event time. */
  updateMemory(input: UpdateMemoryInput): Promise<Memory>;
  getMemory(query: MemoryLookup): Promise<Memory | null>;
  getMemoryEntities(query: MemoryLookup): Promise<MemoryEntity[]>;
  getMemorySources(query: MemoryLookup): Promise<MemorySource[]>;
  /** Link writes and edge creation are idempotent. */
  linkMemoryEntity(input: MemoryEntity): Promise<MemoryEntity>;
  linkEvidence(input: MemorySource): Promise<MemorySource>;
  /** Directed from fromMemoryId to toMemoryId. */
  createMemoryEdge(input: MemoryEdge): Promise<MemoryEdge>;
  searchMemories(query: MemorySearchQuery): Promise<MemoryPage>;
  getEntityMemories(query: EntityMemoriesQuery): Promise<MemoryPage>;
  /** Order by occurredAt ?? createdAt ascending, then ID ascending. */
  getTimeline(query: TimelineQuery): Promise<MemoryPage>;
  getRelatedMemories(query: RelatedMemoriesQuery): Promise<RelatedMemoryPage>;
  /** Only issue memories with active, uncertain, or conflicting status. */
  getOpenIssues(query: OpenIssuesQuery): Promise<MemoryPage>;
}
