import type { CreateMemoryInput, Entity, EntityAlias, EntityAliasLookup, EntityMemoriesQuery, Memory, MemoryEdge, MemoryEntity, MemoryListQuery, MemoryLookup, MemoryPage, MemoryRepository, MemorySearchQuery, MemorySource, OpenIssuesQuery, Pagination, RelatedMemoriesQuery, RelatedMemoryPage, Source, SourceLookup, SourceVersion, SourceVersionLookup, Tenant, TimelineQuery, UpdateMemoryInput, UpsertEntityInput, UpsertSourceInput, UpsertSourceVersionInput, UpsertTenantInput } from "@tunnelvision/core";
import { entitySchema, memorySchema, sourceSchema, sourceVersionSchema, tenantSchema } from "@tunnelvision/core";

const timestamp = "2026-09-30T10:00:00.000Z";
const copy = <T>(value: T): T => structuredClone(value);
function page<T>(items: T[], query: Pagination): { items: T[]; nextOffset: number | null } {
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 50;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid pagination");
  return copy({ items: items.slice(offset, offset + limit), nextOffset: offset + limit < items.length ? offset + limit : null });
}
export class InMemoryTestRepository implements MemoryRepository {
  tenants: Tenant[] = [];
  entities: Entity[] = [];
  aliases: EntityAlias[] = [];
  sources: Source[] = [];
  versions: SourceVersion[] = [];
  memories: Memory[] = [];
  memoryEntities: MemoryEntity[] = [];
  evidence: MemorySource[] = [];
  edges: MemoryEdge[] = [];
  private id = 0;
  private requireTenant(id: string): void { if (!this.tenants.some(tenant => tenant.id === id)) throw new Error("Missing tenant"); }
  async upsertTenant(input: UpsertTenantInput): Promise<Tenant> {
    const found = this.tenants.find(tenant => tenant.id === input.id);
    const tenant = tenantSchema.parse({ ...found, ...input, createdAt: found?.createdAt ?? timestamp, updatedAt: timestamp });
    this.tenants = [...this.tenants.filter(item => item.id !== tenant.id), tenant];
    return copy(tenant);
  }
  async upsertSource(input: UpsertSourceInput): Promise<Source> {
    this.requireTenant(input.tenantId);
    const found = this.sources.find(source => source.tenantId === input.tenantId && source.system === input.system && source.externalId === input.externalId);
    const source = sourceSchema.parse({ ...input, id: found?.id ?? `source:${++this.id}`, createdAt: found?.createdAt ?? timestamp, updatedAt: timestamp });
    this.sources = [...this.sources.filter(item => item.id !== source.id), source];
    return copy(source);
  }
  async upsertSourceVersion(input: UpsertSourceVersionInput): Promise<SourceVersion> {
    if (!await this.getSource({ tenantId: input.tenantId, sourceId: input.sourceId })) throw new Error("Cross-tenant or missing source");
    const found = this.versions.find(version => version.tenantId === input.tenantId && version.sourceId === input.sourceId && version.version === input.version);
    if (found) {
      const { id: _id, ingestedAt: _time, ...snapshot } = found;
      if (JSON.stringify(snapshot) !== JSON.stringify(input)) throw new Error("Immutable snapshot changed");
      return copy(found);
    }
    const version = sourceVersionSchema.parse({ ...input, id: `version:${++this.id}`, ingestedAt: timestamp });
    this.versions.push(version);
    return copy(version);
  }
  async getSource(query: SourceLookup): Promise<Source | null> { return copy(this.sources.find(source => source.id === query.sourceId && source.tenantId === query.tenantId) ?? null); }
  async getSourceVersion(query: SourceVersionLookup): Promise<SourceVersion | null> { return copy(this.versions.find(version => version.id === query.sourceVersionId && version.tenantId === query.tenantId) ?? null); }
  async findSourceVersionByHash(query: { tenantId: string; sourceId: string; contentHash: string }): Promise<SourceVersion | null> { return copy(this.versions.find(version => version.sourceId === query.sourceId && version.tenantId === query.tenantId && version.contentHash === query.contentHash) ?? null); }
  async getSourceByIdentity(query: { tenantId: string; system: string; externalId: string }): Promise<Source | null> { return copy(this.sources.find(source => source.tenantId === query.tenantId && source.system === query.system && source.externalId === query.externalId) ?? null); }
  async upsertEntity(input: UpsertEntityInput): Promise<Entity> {
    this.requireTenant(input.tenantId);
    const found = this.entities.find(entity => entity.id === input.id && entity.tenantId === input.tenantId);
    const { aliases = [], ...fields } = input;
    const entity = entitySchema.parse({ ...fields, createdAt: found?.createdAt ?? timestamp, updatedAt: timestamp });
    this.entities = [...this.entities.filter(item => item.id !== entity.id || item.tenantId !== entity.tenantId), entity];
    for (const alias of aliases) {
      const entry = { ...alias, entityId: entity.id, tenantId: entity.tenantId };
      if (!this.aliases.some(item => JSON.stringify(item) === JSON.stringify(entry))) this.aliases.push(entry);
    }
    return copy(entity);
  }
  async resolveEntityByAlias(query: EntityAliasLookup): Promise<Entity[]> {
    const ids = this.aliases.filter(alias => alias.tenantId === query.tenantId && alias.kind === query.kind && alias.value === query.value).map(alias => alias.entityId);
    return copy(this.entities.filter(entity => entity.tenantId === query.tenantId && ids.includes(entity.id)));
  }
  async createMemory(input: CreateMemoryInput): Promise<Memory> {
    this.requireTenant(input.tenantId);
    const memory = memorySchema.parse({ ...input, id: `memory:${++this.id}`, createdAt: timestamp, updatedAt: timestamp });
    this.memories.push(memory);
    return copy(memory);
  }
  async updateMemory(input: UpdateMemoryInput): Promise<Memory> {
    const found = this.memories.find(memory => memory.tenantId === input.tenantId && memory.id === input.id);
    if (!found) throw new Error("Missing memory");
    const memory = memorySchema.parse({ ...found, ...input, updatedAt: timestamp });
    this.memories = [...this.memories.filter(item => item.id !== memory.id), memory];
    return copy(memory);
  }
  async getMemory(query: MemoryLookup): Promise<Memory | null> { return copy(this.memories.find(memory => memory.id === query.memoryId && memory.tenantId === query.tenantId) ?? null); }
  async getMemoryEntities(query: MemoryLookup): Promise<MemoryEntity[]> { return copy(this.memoryEntities.filter(link => link.memoryId === query.memoryId && link.tenantId === query.tenantId)); }
  async getMemorySources(query: MemoryLookup): Promise<MemorySource[]> { return copy(this.evidence.filter(link => link.memoryId === query.memoryId && link.tenantId === query.tenantId)); }
  async linkMemoryEntity(input: MemoryEntity): Promise<MemoryEntity> {
    if (!await this.getMemory({ tenantId: input.tenantId, memoryId: input.memoryId }) || !this.entities.some(entity => entity.tenantId === input.tenantId && entity.id === input.entityId)) throw new Error("Invalid entity link");
    if (!this.memoryEntities.some(item => JSON.stringify(item) === JSON.stringify(input))) this.memoryEntities.push(copy(input));
    return copy(input);
  }
  async linkEvidence(input: MemorySource): Promise<MemorySource> {
    const version = await this.getSourceVersion({ tenantId: input.tenantId, sourceVersionId: input.evidence.sourceVersionId });
    if (!await this.getMemory({ tenantId: input.tenantId, memoryId: input.memoryId }) || !version || version.sourceId !== input.evidence.sourceId) throw new Error("Invalid evidence link");
    if (!this.evidence.some(item => JSON.stringify(item) === JSON.stringify(input))) this.evidence.push(copy(input));
    return copy(input);
  }
  async createMemoryEdge(input: MemoryEdge): Promise<MemoryEdge> {
    if (!await this.getMemory({ tenantId: input.tenantId, memoryId: input.fromMemoryId }) || !await this.getMemory({ tenantId: input.tenantId, memoryId: input.toMemoryId })) throw new Error("Invalid edge");
    if (!this.edges.some(item => JSON.stringify(item) === JSON.stringify(input))) this.edges.push(copy(input));
    return copy(input);
  }
  private filter(query: MemoryListQuery): Memory[] { return this.memories.filter(memory => memory.tenantId === query.tenantId && (!query.types || query.types.includes(memory.type)) && (!query.statuses || query.statuses.includes(memory.status))); }
  async searchMemories(query: MemorySearchQuery): Promise<MemoryPage> {
    const items = this.filter(query).filter(memory => (!query.query || `${memory.summary} ${JSON.stringify(memory.content)}`.toLowerCase().includes(query.query.toLowerCase())) && (!query.entityIds || this.memoryEntities.some(link => link.memoryId === memory.id && link.tenantId === query.tenantId && query.entityIds?.includes(link.entityId))));
    return page(items, query);
  }
  async getEntityMemories(query: EntityMemoriesQuery): Promise<MemoryPage> { return this.searchMemories({ ...query, entityIds: [query.entityId] }); }
  async getTimeline(query: TimelineQuery): Promise<MemoryPage> {
    const items = this.filter(query).filter(memory => (!query.entityId || this.memoryEntities.some(link => link.memoryId === memory.id && link.tenantId === query.tenantId && link.entityId === query.entityId)) && (!query.from || (memory.occurredAt ?? memory.createdAt) >= query.from) && (!query.to || (memory.occurredAt ?? memory.createdAt) <= query.to)).sort((a, b) => (a.occurredAt ?? a.createdAt).localeCompare(b.occurredAt ?? b.createdAt));
    return page(items, query);
  }
  async getRelatedMemories(query: RelatedMemoriesQuery): Promise<RelatedMemoryPage> {
    const items = this.edges.filter(edge => edge.tenantId === query.tenantId && (!query.edgeTypes || query.edgeTypes.includes(edge.type)) && ((query.direction !== "incoming" && edge.fromMemoryId === query.memoryId) || (query.direction !== "outgoing" && edge.toMemoryId === query.memoryId))).map(edge => ({ edge, memory: this.memories.find(memory => memory.id === (edge.fromMemoryId === query.memoryId ? edge.toMemoryId : edge.fromMemoryId) && memory.tenantId === query.tenantId)! }));
    return page(items, query);
  }
  async getOpenIssues(query: OpenIssuesQuery): Promise<MemoryPage> { return this.searchMemories({ ...query, types: ["issue"], statuses: ["active", "uncertain", "conflicting"], ...(query.entityId ? { entityIds: [query.entityId] } : {}) }); }
}
