import { createHash, randomUUID } from "node:crypto";
import {
  entityAliasSchema, entitySchema, idSchema, memoryEdgeSchema, memoryEdgeTypeSchema,
  memoryEntitySchema, memorySchema, memorySourceSchema, memoryStatusSchema,
  memoryTypeSchema, sourceSchema, sourceVersionSchema, tenantSchema, timestampSchema,
} from "@tunnelvision/core";
import type {
  CreateMemoryInput, Entity, EntityAliasLookup, EntityMemoriesQuery, Memory,
  MemoryListQuery, MemoryLookup, MemoryRepository, MemorySearchQuery,
  OpenIssuesQuery, Pagination, RelatedMemoriesQuery, Source, SourceLookup,
  SourceVersion, SourceVersionLookup, Tenant, TimelineQuery, UpdateMemoryInput,
  UpsertEntityInput, UpsertSourceInput, UpsertSourceVersionInput, UpsertTenantInput,
  MemoryEntity, MemorySource, MemoryEdge,
  MemoryPage, RelatedMemoryPage, SourceSystem,
} from "@tunnelvision/core";
import {
  and, asc, desc, eq, exists, ilike, inArray, or, sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  entities, entityAliases, memories, memoryEdges, memoryEntities, memorySources,
  sources, sourceVersions, tenants,
} from "./schema.js";
import { canonicalJson, isoTimestamp, literalLike, page, pagination } from "./utils.js";

const tenantInput = tenantSchema.omit({ createdAt: true, updatedAt: true });
const sourceInput = sourceSchema.omit({ id: true, createdAt: true, updatedAt: true });
const sourceIdentityInput = sourceInput.pick({ tenantId: true, system: true, externalId: true });
const versionInput = sourceVersionSchema.omit({ id: true, ingestedAt: true });
const entityInput = entitySchema.omit({ createdAt: true, updatedAt: true });
const memoryInput = memorySchema.omit({ id: true, createdAt: true, updatedAt: true });
const memoryUpdateInput = memoryInput.partial().extend({ id: idSchema, tenantId: idSchema });

function tenantRow(row: typeof tenants.$inferSelect): Tenant {
  return { ...row, createdAt: isoTimestamp(row.createdAt), updatedAt: isoTimestamp(row.updatedAt) };
}

function entityRow(row: typeof entities.$inferSelect): Entity {
  return { ...row, createdAt: isoTimestamp(row.createdAt), updatedAt: isoTimestamp(row.updatedAt) };
}

function sourceRow(row: typeof sources.$inferSelect): Source {
  return sourceSchema.parse({ ...row, createdAt: isoTimestamp(row.createdAt), updatedAt: isoTimestamp(row.updatedAt) });
}

function versionRow(row: typeof sourceVersions.$inferSelect): SourceVersion {
  return { ...row, ingestedAt: isoTimestamp(row.ingestedAt) };
}

function memoryRow(row: typeof memories.$inferSelect): Memory {
  return memorySchema.parse({ ...row, occurredAt: row.occurredAt === null ? null : isoTimestamp(row.occurredAt), createdAt: isoTimestamp(row.createdAt), updatedAt: isoTimestamp(row.updatedAt) });
}

function snapshot(input: UpsertSourceVersionInput): string {
  return canonicalJson(input);
}

export interface EntitySearchQuery extends Pagination {
  tenantId: string;
  query?: string;
}

export interface EntityPage { items: Entity[]; nextOffset: number | null }
export interface TenantPage { items: Tenant[]; nextOffset: number | null }
export interface RepositoryOptions { connectionString: string }
export interface SourceIdentityLookup { tenantId: string; system: SourceSystem; externalId: string }

/** Every join and lookup includes the tenant, including globally unique-looking IDs. */
export class PostgresMemoryRepository implements MemoryRepository {
  private readonly pool: Pool;
  private readonly db;

  constructor(options: RepositoryOptions) {
    if (!options.connectionString) throw new Error("connectionString is required");
    this.pool = new Pool({ connectionString: options.connectionString });
    this.db = drizzle(this.pool);
  }

  async close(): Promise<void> { await this.pool.end(); }

  async upsertTenant(input: UpsertTenantInput): Promise<Tenant> {
    const value = tenantInput.parse(input);
    const [row] = await this.db.insert(tenants).values(value).onConflictDoUpdate({
      target: tenants.id, set: { name: value.name, updatedAt: sql`now()` },
    }).returning();
    return tenantRow(row!);
  }

  async getTenant(query: { tenantId: string }): Promise<Tenant | null> {
    idSchema.parse(query.tenantId);
    const [row] = await this.db.select().from(tenants).where(eq(tenants.id, query.tenantId));
    return row ? tenantRow(row) : null;
  }

  async listTenants(query: Pagination = {}): Promise<TenantPage> {
    const { limit, offset } = pagination(query);
    const rows = await this.db.select().from(tenants).orderBy(desc(tenants.createdAt), asc(tenants.id)).limit(limit + 1).offset(offset);
    return page(rows.map(tenantRow), limit, offset);
  }

  async upsertSource(input: UpsertSourceInput): Promise<Source> {
    const value = sourceInput.parse(input);
    const [row] = await this.db.insert(sources).values({ ...value, id: randomUUID() }).onConflictDoUpdate({
      target: [sources.tenantId, sources.system, sources.externalId],
      set: { uri: value.uri, title: value.title, metadata: value.metadata, updatedAt: sql`now()` },
    }).returning();
    return sourceRow(row!);
  }

  async upsertSourceVersion(input: UpsertSourceVersionInput): Promise<SourceVersion> {
    const value = versionInput.parse(input);
    const [inserted] = await this.db.insert(sourceVersions).values({
      ...value, id: randomUUID(),
    }).onConflictDoNothing({ target: [sourceVersions.tenantId, sourceVersions.sourceId, sourceVersions.version] }).returning();
    if (inserted) return versionRow(inserted);
    // A separate SELECT after conflict sees the winning concurrent commit.
    const [existing] = await this.db.select().from(sourceVersions).where(and(
      eq(sourceVersions.tenantId, value.tenantId), eq(sourceVersions.sourceId, value.sourceId), eq(sourceVersions.version, value.version),
    ));
    if (!existing) throw new Error("Source version disappeared during retry");
    const { id: _id, ingestedAt: _ingestedAt, ...existingSnapshot } = versionRow(existing);
    if (snapshot(existingSnapshot) !== snapshot(value)) {
      throw new Error("Source version is immutable: a changed snapshot requires a new version");
    }
    return versionRow(existing);
  }

  async getSource(query: SourceLookup): Promise<Source | null> {
    idSchema.parse(query.tenantId); idSchema.parse(query.sourceId);
    const [row] = await this.db.select().from(sources).where(and(eq(sources.tenantId, query.tenantId), eq(sources.id, query.sourceId)));
    return row ? sourceRow(row) : null;
  }

  /** Read persisted source state before an upsert, including across CLI lifetimes. */
  async getSourceByIdentity(query: SourceIdentityLookup): Promise<Source | null> {
    const value = sourceIdentityInput.parse(query);
    const [row] = await this.db.select().from(sources).where(and(
      eq(sources.tenantId, value.tenantId), eq(sources.system, value.system), eq(sources.externalId, value.externalId),
    ));
    return row ? sourceRow(row) : null;
  }

  async getSourceVersion(query: SourceVersionLookup): Promise<SourceVersion | null> {
    idSchema.parse(query.tenantId); idSchema.parse(query.sourceVersionId);
    const [row] = await this.db.select().from(sourceVersions).where(and(eq(sourceVersions.tenantId, query.tenantId), eq(sourceVersions.id, query.sourceVersionId)));
    return row ? versionRow(row) : null;
  }

  /** Optional ingestion helper; hashes are scoped to the tenant and source. */
  async findSourceVersionByHash(query: SourceLookup & { contentHash: string }): Promise<SourceVersion | null> {
    idSchema.parse(query.tenantId); idSchema.parse(query.sourceId); idSchema.parse(query.contentHash);
    const [row] = await this.db.select().from(sourceVersions).where(and(
      eq(sourceVersions.tenantId, query.tenantId), eq(sourceVersions.sourceId, query.sourceId), eq(sourceVersions.contentHash, query.contentHash),
    )).orderBy(desc(sourceVersions.ingestedAt), asc(sourceVersions.id)).limit(1);
    return row ? versionRow(row) : null;
  }

  async getLatestSourceVersion(query: SourceLookup): Promise<SourceVersion | null> {
    idSchema.parse(query.tenantId); idSchema.parse(query.sourceId);
    const [row] = await this.db.select().from(sourceVersions).where(and(
      eq(sourceVersions.tenantId, query.tenantId), eq(sourceVersions.sourceId, query.sourceId),
    )).orderBy(desc(sourceVersions.ingestedAt), asc(sourceVersions.id)).limit(1);
    return row ? versionRow(row) : null;
  }

  async upsertEntity(input: UpsertEntityInput): Promise<Entity> {
    const { aliases: suppliedAliases, ...entity } = input;
    const value = entityInput.parse(entity);
    const aliases = suppliedAliases?.map((alias) => entityAliasSchema.parse({ ...alias, tenantId: value.tenantId, entityId: value.id })) ?? [];
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(entities).values(value).onConflictDoUpdate({
        target: [entities.tenantId, entities.id],
        set: { type: value.type, name: value.name, metadata: value.metadata, updatedAt: sql`now()` },
      }).returning();
      if (aliases.length) await tx.insert(entityAliases).values(aliases).onConflictDoNothing();
      return entityRow(row!);
    });
  }

  async resolveEntityByAlias(query: EntityAliasLookup): Promise<Entity[]> {
    idSchema.parse(query.tenantId); idSchema.parse(query.kind); idSchema.parse(query.value);
    const rows = await this.db.select({ entity: entities }).from(entityAliases).innerJoin(entities, and(
      eq(entityAliases.tenantId, entities.tenantId), eq(entityAliases.entityId, entities.id),
    )).where(and(eq(entityAliases.tenantId, query.tenantId), eq(entityAliases.kind, query.kind), eq(entityAliases.value, query.value))).orderBy(asc(entities.id));
    return rows.map(({ entity }) => entityRow(entity));
  }

  async getEntity(query: { tenantId: string; entityId: string }): Promise<Entity | null> {
    idSchema.parse(query.tenantId); idSchema.parse(query.entityId);
    const [row] = await this.db.select().from(entities).where(and(eq(entities.tenantId, query.tenantId), eq(entities.id, query.entityId)));
    return row ? entityRow(row) : null;
  }

  async searchEntities(query: EntitySearchQuery): Promise<EntityPage> {
    idSchema.parse(query.tenantId);
    const { limit, offset } = pagination(query);
    const conditions: SQL[] = [eq(entities.tenantId, query.tenantId)];
    if (query.query !== undefined && query.query !== "") {
      const pattern = literalLike(query.query);
      conditions.push(or(ilike(entities.name, pattern), ilike(entities.id, pattern), ilike(sql`${entities.metadata}::text`, pattern), exists(
        this.db.select({ id: entityAliases.entityId }).from(entityAliases).where(and(
          eq(entityAliases.tenantId, entities.tenantId), eq(entityAliases.entityId, entities.id), ilike(entityAliases.value, pattern),
        )),
      ))!);
    }
    const rows = await this.db.select().from(entities).where(and(...conditions)).orderBy(desc(entities.createdAt), asc(entities.id)).limit(limit + 1).offset(offset);
    return page(rows.map(entityRow), limit, offset);
  }

  async createMemory(input: CreateMemoryInput): Promise<Memory> {
    const value = memoryInput.parse(input);
    const [row] = await this.db.insert(memories).values({
      ...value, id: randomUUID(), content: sql`${JSON.stringify(value.content)}::jsonb`,
    }).returning();
    return memoryRow(row!);
  }

  async updateMemory(input: UpdateMemoryInput): Promise<Memory> {
    const { id, tenantId, ...changes } = memoryUpdateInput.parse(input);
    const [row] = await this.db.update(memories).set({
      ...changes, ...(changes.content !== undefined ? { content: sql`${JSON.stringify(changes.content)}::jsonb` } : {}), updatedAt: sql`now()`,
    }).where(and(eq(memories.tenantId, tenantId), eq(memories.id, id))).returning();
    if (!row) throw new Error("Memory not found in tenant");
    return memoryRow(row);
  }

  async getMemory(query: MemoryLookup): Promise<Memory | null> {
    const condition = this.memoryLookup(query);
    const [row] = await this.db.select().from(memories).where(condition);
    return row ? memoryRow(row) : null;
  }

  async getMemoryEntities(query: MemoryLookup): Promise<MemoryEntity[]> {
    idSchema.parse(query.tenantId); idSchema.parse(query.memoryId);
    const rows = await this.db.select().from(memoryEntities).where(and(eq(memoryEntities.tenantId, query.tenantId), eq(memoryEntities.memoryId, query.memoryId))).orderBy(asc(memoryEntities.entityId), asc(memoryEntities.role));
    return rows.map((row) => memoryEntitySchema.parse(row));
  }

  async getMemorySources(query: MemoryLookup): Promise<MemorySource[]> {
    idSchema.parse(query.tenantId); idSchema.parse(query.memoryId);
    const rows = await this.db.select().from(memorySources).where(and(eq(memorySources.tenantId, query.tenantId), eq(memorySources.memoryId, query.memoryId))).orderBy(asc(memorySources.sourceId), asc(memorySources.sourceVersionId), asc(memorySources.evidenceKey));
    return rows.map((row) => ({ tenantId: row.tenantId, memoryId: row.memoryId, evidence: {
      sourceId: row.sourceId, sourceVersionId: row.sourceVersionId,
      ...(row.locator !== null ? { locator: row.locator } : {}), ...(row.quote !== null ? { quote: row.quote } : {}),
    } }));
  }

  async linkMemoryEntity(input: MemoryEntity): Promise<MemoryEntity> {
    const value = memoryEntitySchema.parse(input);
    await this.db.insert(memoryEntities).values(value).onConflictDoNothing();
    return value;
  }

  async linkEvidence(input: MemorySource): Promise<MemorySource> {
    const value = memorySourceSchema.parse(input);
    const evidenceKey = createHash("sha256").update(canonicalJson({
      sourceId: value.evidence.sourceId, sourceVersionId: value.evidence.sourceVersionId,
      ...(value.evidence.locator !== undefined ? { locator: value.evidence.locator } : {}),
      ...(value.evidence.quote !== undefined ? { quote: value.evidence.quote } : {}),
    })).digest("hex");
    await this.db.insert(memorySources).values({
      tenantId: value.tenantId, memoryId: value.memoryId, evidenceKey,
      sourceId: value.evidence.sourceId, sourceVersionId: value.evidence.sourceVersionId,
      locator: value.evidence.locator ?? null, quote: value.evidence.quote ?? null,
    }).onConflictDoNothing();
    return value;
  }

  async createMemoryEdge(input: MemoryEdge): Promise<MemoryEdge> {
    const value = memoryEdgeSchema.parse(input);
    await this.db.insert(memoryEdges).values(value).onConflictDoNothing();
    return value;
  }

  async searchMemories(query: MemorySearchQuery): Promise<MemoryPage> {
    const conditions = this.listConditions(query);
    if (query.query !== undefined && query.query !== "") {
      const pattern = literalLike(query.query);
      conditions.push(or(ilike(memories.summary, pattern), ilike(sql`${memories.content}::text`, pattern))!);
    }
    if (query.entityIds !== undefined) {
      const ids = idSchema.array().parse(query.entityIds);
      conditions.push(ids.length ? this.linkedEntities(ids) : sql`false`);
    }
    return this.memoryPage(query, conditions);
  }

  async getEntityMemories(query: EntityMemoriesQuery): Promise<MemoryPage> {
    idSchema.parse(query.entityId);
    return this.memoryPage(query, [...this.listConditions(query), this.linkedEntities([query.entityId])]);
  }

  async getTimeline(query: TimelineQuery): Promise<MemoryPage> {
    const conditions = this.listConditions(query);
    const eventTime = sql`coalesce(${memories.occurredAt}, ${memories.createdAt})`;
    if (query.entityId !== undefined) { idSchema.parse(query.entityId); conditions.push(this.linkedEntities([query.entityId])); }
    if (query.from !== undefined) { timestampSchema.parse(query.from); conditions.push(sql`${eventTime} >= ${query.from}::timestamptz`); }
    if (query.to !== undefined) { timestampSchema.parse(query.to); conditions.push(sql`${eventTime} <= ${query.to}::timestamptz`); }
    return this.memoryPage(query, conditions, true);
  }

  async getRelatedMemories(query: RelatedMemoriesQuery): Promise<RelatedMemoryPage> {
    idSchema.parse(query.tenantId); idSchema.parse(query.memoryId);
    const { limit, offset } = pagination(query);
    const direction = query.direction ?? "both";
    if (!["incoming", "outgoing", "both"].includes(direction)) throw new Error("Invalid edge direction");
    const outgoing = eq(memoryEdges.fromMemoryId, query.memoryId);
    const incoming = eq(memoryEdges.toMemoryId, query.memoryId);
    const conditions: SQL[] = [eq(memoryEdges.tenantId, query.tenantId), direction === "outgoing" ? outgoing : direction === "incoming" ? incoming : or(outgoing, incoming)!];
    if (query.edgeTypes !== undefined) {
      const types = memoryEdgeTypeSchema.array().parse(query.edgeTypes);
      conditions.push(types.length ? inArray(memoryEdges.type, types) : sql`false`);
    }
    const neighbourId = sql`case when ${memoryEdges.fromMemoryId} = ${query.memoryId} then ${memoryEdges.toMemoryId} else ${memoryEdges.fromMemoryId} end`;
    const rows = await this.db.select({ memory: memories, edge: memoryEdges }).from(memoryEdges).innerJoin(memories, and(eq(memoryEdges.tenantId, memories.tenantId), eq(memories.id, neighbourId))).where(and(...conditions))
      .orderBy(desc(memories.createdAt), asc(memories.id), asc(memoryEdges.fromMemoryId), asc(memoryEdges.toMemoryId), asc(memoryEdges.type)).limit(limit + 1).offset(offset);
    return page(rows.map((row) => ({ memory: memoryRow(row.memory), edge: memoryEdgeSchema.parse(row.edge) })), limit, offset);
  }

  async getOpenIssues(query: OpenIssuesQuery): Promise<MemoryPage> {
    const conditions = this.listConditions({ tenantId: query.tenantId, types: ["issue"], statuses: ["active", "uncertain", "conflicting"] });
    if (query.entityId !== undefined) { idSchema.parse(query.entityId); conditions.push(this.linkedEntities([query.entityId])); }
    return this.memoryPage(query, conditions);
  }

  private memoryLookup(query: MemoryLookup): SQL {
    idSchema.parse(query.tenantId); idSchema.parse(query.memoryId);
    return and(eq(memories.tenantId, query.tenantId), eq(memories.id, query.memoryId))!;
  }

  private listConditions(query: MemoryListQuery): SQL[] {
    idSchema.parse(query.tenantId);
    const conditions: SQL[] = [eq(memories.tenantId, query.tenantId)];
    if (query.types !== undefined) {
      const types = memoryTypeSchema.array().parse(query.types);
      conditions.push(types.length ? inArray(memories.type, types) : sql`false`);
    }
    if (query.statuses !== undefined) {
      const statuses = memoryStatusSchema.array().parse(query.statuses);
      conditions.push(statuses.length ? inArray(memories.status, statuses) : sql`false`);
    }
    return conditions;
  }

  private linkedEntities(ids: string[]): SQL {
    return exists(this.db.select({ id: memoryEntities.memoryId }).from(memoryEntities).where(and(
      eq(memoryEntities.tenantId, memories.tenantId), eq(memoryEntities.memoryId, memories.id), inArray(memoryEntities.entityId, ids),
    )));
  }

  private async memoryPage(query: Pagination, conditions: SQL[], timeline = false): Promise<MemoryPage> {
    const { limit, offset } = pagination(query);
    const rows = await this.db.select().from(memories).where(and(...conditions)).orderBy(
      timeline ? asc(sql`coalesce(${memories.occurredAt}, ${memories.createdAt})`) : desc(memories.createdAt), asc(memories.id),
    ).limit(limit + 1).offset(offset);
    return page(rows.map(memoryRow), limit, offset);
  }
}

export function createMemoryRepository(options: RepositoryOptions): PostgresMemoryRepository {
  return new PostgresMemoryRepository(options);
}
