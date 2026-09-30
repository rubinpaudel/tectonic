import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { memorySchema, sourceVersionSchema, tenantSchema } from "@tunnelvision/core";
import type { CreateMemoryInput, Memory, MemoryStatus, UpsertSourceVersionInput } from "@tunnelvision/core";
import { createMemoryRepository, migrateDatabase, resetDatabase, seedDatabase } from "../src/index.js";
import type { PostgresMemoryRepository } from "../src/index.js";

const connectionString = process.env.TUNNELVISION_TEST_DATABASE_URL ?? "";

// Explicitly opt in with a dedicated test DB: beforeEach truncates the target.
describe.skipIf(!connectionString)("Postgres MemoryRepository", () => {
  let repository: PostgresMemoryRepository;
  let pool: Pool;

  beforeAll(async () => {
    await Promise.all([migrateDatabase(connectionString), migrateDatabase(connectionString)]);
    repository = createMemoryRepository({ connectionString });
    pool = new Pool({ connectionString });
  });

  beforeEach(async () => {
    await resetDatabase(connectionString, { confirm: true });
    await seedDatabase(connectionString, {
      tenants: [{ id: "nike", name: "Nike Belgium (synthetic)" }, { id: "other", name: "Other client" }],
      entities: [
        { tenantId: "nike", id: "abel", type: "person", name: "Abel", metadata: {}, aliases: [{ kind: "email", value: "abel@nike.example" }, { kind: "name", value: "Abel" }] },
        { tenantId: "nike", id: "alex", type: "person", name: "Alex", metadata: {}, aliases: [{ kind: "name", value: "Abel" }] },
        { tenantId: "other", id: "other-only", type: "person", name: "Other", metadata: {}, aliases: [{ kind: "email", value: "abel@nike.example" }] },
      ],
    });
  });

  afterAll(async () => { await repository?.close(); await pool?.end(); });

  async function memory(patch: Partial<CreateMemoryInput> = {}): Promise<Memory> {
    return repository.createMemory({ tenantId: "nike", type: "fact", status: "active", summary: "Example memory", content: { arbitrary: true }, confidence: 0.9, occurredAt: null, ...patch });
  }

  async function source(tenantId = "nike", externalId = "message-1") {
    return repository.upsertSource({ tenantId, system: "gmail", externalId, uri: `file:///${externalId}.txt`, title: externalId, metadata: {} });
  }

  async function version(sourceId: string, patch: Partial<UpsertSourceVersionInput> = {}) {
    const input: UpsertSourceVersionInput = { tenantId: "nike", sourceId, version: "v1", contentHash: "hash-v1", contentType: "text/plain", content: "Immutable evidence", metadata: { nested: { a: 1, b: 2 } }, sourceModifiedAt: "2026-09-21T12:00:00+02:00", ...patch };
    return { input, stored: await repository.upsertSourceVersion(input) };
  }

  it("has reusable migrations, ISO model output, stable tenant/source identity, and discovery paging", async () => {
    const tenant = await repository.upsertTenant({ id: "nike", name: "Nike renamed" });
    expect(tenantSchema.parse(tenant)).toEqual(tenant);
    expect((await repository.listTenants({ limit: 1 })).nextOffset).toBe(1);
    expect((await repository.listTenants({ offset: 1 })).items).toHaveLength(1);
    expect((await repository.getTenant({ tenantId: "missing" }))).toBeNull();
    const first = await source();
    const changed = await repository.upsertSource({ tenantId: "nike", system: "gmail", externalId: "message-1", uri: "file:///renamed.txt", title: "New title", metadata: { moved: true } });
    expect(changed.id).toBe(first.id);
    expect(changed.createdAt).toBe(first.createdAt);
    expect(changed.title).toBe("New title");
    expect((await repository.getSource({ tenantId: "other", sourceId: first.id }))).toBeNull();
    expect((await source("other")).id).not.toBe(first.id);
    const migrations = await pool.query("SELECT id FROM tunnelvision_migrations");
    expect(migrations.rows).toEqual([{ id: "0001_initial" }]);
  });

  it("returns every exact alias match, adds aliases idempotently, and scopes entity discovery", async () => {
    const input = { tenantId: "nike", id: "abel", type: "person", name: "Abel", metadata: { team: "Operations" }, aliases: [{ kind: "email", value: "abel@nike.example" }] };
    await repository.upsertEntity(input); await repository.upsertEntity(input);
    expect((await repository.resolveEntityByAlias({ tenantId: "nike", kind: "name", value: "Abel" })).map((e) => e.id)).toEqual(["abel", "alex"]);
    expect((await repository.resolveEntityByAlias({ tenantId: "nike", kind: "email", value: "ABEL@nike.example" }))).toEqual([]);
    expect((await repository.resolveEntityByAlias({ tenantId: "nike", kind: "email", value: "abel@nike.example" })).map((e) => e.id)).toEqual(["abel"]);
    expect((await repository.searchEntities({ tenantId: "nike", query: "OPERATIONS" })).items.map((e) => e.id)).toEqual(["abel"]);
    expect((await repository.searchEntities({ tenantId: "nike", query: "abel@nike.example" })).items.map((e) => e.id)).toEqual(["abel"]);
    expect((await repository.searchEntities({ tenantId: "nike", limit: 1 })).nextOffset).toBe(1);
    expect(await repository.getEntity({ tenantId: "nike", entityId: "other-only" })).toBeNull();
  });

  it("reads persisted source identity/metadata across repository lifetimes without overwriting it", async () => {
    const original = await repository.upsertSource({
      tenantId: "nike", system: "gmail", externalId: "stable-external-id", uri: "file:///message.txt", title: "Persistent source",
      metadata: { completedHashes: ["hash-v1", "hash-v2"] },
    });
    const foreign = await source("other", "stable-external-id");
    const fresh = createMemoryRepository({ connectionString });
    try {
      expect(await fresh.getSourceByIdentity({ tenantId: "nike", system: "gmail", externalId: "stable-external-id" })).toEqual(original);
      expect((await fresh.getSourceByIdentity({ tenantId: "other", system: "gmail", externalId: "stable-external-id" }))?.id).toBe(foreign.id);
      expect(await fresh.getSourceByIdentity({ tenantId: "nike", system: "teams", externalId: "stable-external-id" })).toBeNull();
      expect(await fresh.getSourceByIdentity({ tenantId: "nike", system: "gmail", externalId: "missing" })).toBeNull();
      expect((await fresh.getSource({ tenantId: "nike", sourceId: original.id }))?.metadata).toEqual({ completedHashes: ["hash-v1", "hash-v2"] });
    } finally { await fresh.close(); }
  });

  it("creates immutable versions, accepts identical and concurrent retries, and detects hash changes", async () => {
    const s = await source();
    const { input, stored } = await version(s.id);
    expect(sourceVersionSchema.parse(stored)).toEqual(stored);
    expect(stored.sourceModifiedAt).toBe(input.sourceModifiedAt);
    const retries = await Promise.all(Array.from({ length: 5 }, () => repository.upsertSourceVersion({ ...input, metadata: { nested: { b: 2, a: 1 } } })));
    expect(retries.every((v) => v.id === stored.id && v.ingestedAt === stored.ingestedAt)).toBe(true);
    const concurrentInput = { ...input, version: "new", contentHash: "new-hash" };
    const concurrent = await Promise.all(Array.from({ length: 5 }, () => repository.upsertSourceVersion(concurrentInput)));
    expect(new Set(concurrent.map((v) => v.id)).size).toBe(1);
    for (const patch of [ { content: "changed" }, { contentHash: "changed" }, { metadata: { changed: true } }, { contentType: "application/json" }, { sourceModifiedAt: null } ]) {
      await expect(repository.upsertSourceVersion({ ...input, ...patch })).rejects.toThrow("immutable");
    }
    const changed = await repository.upsertSourceVersion({ ...input, version: "v2", contentHash: "hash-v2", content: "Changed evidence" });
    expect(changed.id).not.toBe(stored.id);
    expect((await repository.getSourceVersion({ tenantId: "nike", sourceVersionId: stored.id }))?.content).toBe(input.content);
    expect((await repository.findSourceVersionByHash({ tenantId: "nike", sourceId: s.id, contentHash: "hash-v2" }))?.id).toBe(changed.id);
    expect((await repository.findSourceVersionByHash({ tenantId: "other", sourceId: s.id, contentHash: "hash-v2" }))).toBeNull();
    expect((await repository.getLatestSourceVersion({ tenantId: "nike", sourceId: s.id }))?.id).toBe(changed.id);
    expect((await repository.getSourceVersion({ tenantId: "other", sourceVersionId: stored.id }))).toBeNull();
    const precise = await version(s.id, { version: "precise", sourceModifiedAt: "2026-09-21T12:00:00.123456789+02:00" });
    expect(precise.stored.sourceModifiedAt).toBe(precise.input.sourceModifiedAt);
    await expect(repository.upsertSourceVersion({ ...precise.input, sourceModifiedAt: "2026-09-21T12:00:00.123456788+02:00" })).rejects.toThrow("immutable");
  });

  it("blocks direct SQL mutation of evidence snapshots", async () => {
    const s = await source(); const { stored } = await version(s.id);
    await expect(pool.query("UPDATE source_versions SET content = $1 WHERE tenant_id = $2 AND id = $3", ["tampered", "nike", stored.id])).rejects.toMatchObject({ code: "55000" });
    await expect(pool.query("DELETE FROM source_versions WHERE tenant_id = $1 AND id = $2", ["nike", stored.id])).rejects.toMatchObject({ code: "55000" });
    expect((await repository.getSourceVersion({ tenantId: "nike", sourceVersionId: stored.id }))?.content).toBe("Immutable evidence");
  });

  it("rejects cross-tenant and wrong-source links at database boundaries", async () => {
    const own = await memory(); const foreign = await memory({ tenantId: "other" });
    const ownSource = await source(); const otherOwnSource = await source("nike", "message-2");
    const foreignSource = await source("other");
    const { stored: ownVersion } = await version(ownSource.id);
    const { stored: foreignVersion } = await version(foreignSource.id, { tenantId: "other" });
    await expect(repository.linkMemoryEntity({ tenantId: "nike", memoryId: own.id, entityId: "other-only", role: "subject" })).rejects.toThrow();
    await expect(repository.linkMemoryEntity({ tenantId: "nike", memoryId: foreign.id, entityId: "abel", role: "subject" })).rejects.toThrow();
    await expect(repository.createMemoryEdge({ tenantId: "nike", fromMemoryId: own.id, toMemoryId: foreign.id, type: "relates_to" })).rejects.toThrow();
    await expect(repository.createMemoryEdge({ tenantId: "nike", fromMemoryId: foreign.id, toMemoryId: own.id, type: "relates_to" })).rejects.toThrow();
    await expect(repository.linkEvidence({ tenantId: "nike", memoryId: own.id, evidence: { sourceId: foreignSource.id, sourceVersionId: foreignVersion.id } })).rejects.toThrow();
    await expect(repository.linkEvidence({ tenantId: "nike", memoryId: own.id, evidence: { sourceId: otherOwnSource.id, sourceVersionId: ownVersion.id } })).rejects.toThrow();
    await expect(version(foreignSource.id)).rejects.toThrow();
    await expect(pool.query("INSERT INTO entity_aliases VALUES ($1, $2, $3, $4)", ["nike", "other-only", "name", "unsafe"])).rejects.toMatchObject({ code: "23503" });
  });

  it("keeps links idempotent while retaining distinct evidence locations and roles", async () => {
    const m = await memory(); const s = await source(); const { stored } = await version(s.id);
    const entityLink = { tenantId: "nike", memoryId: m.id, entityId: "abel", role: "subject" as const };
    await repository.linkMemoryEntity(entityLink); await repository.linkMemoryEntity(entityLink);
    await repository.linkMemoryEntity({ ...entityLink, role: "actor" });
    const evidence = { tenantId: "nike", memoryId: m.id, evidence: { sourceId: s.id, sourceVersionId: stored.id, locator: { line: 4, message: "msg" }, quote: "Immutable evidence" } };
    await repository.linkEvidence(evidence);
    await repository.linkEvidence({ ...evidence, evidence: { ...evidence.evidence, locator: { message: "msg", line: 4 } } });
    await repository.linkEvidence({ ...evidence, evidence: { ...evidence.evidence, locator: { line: 5 } } });
    await repository.linkEvidence({ tenantId: "nike", memoryId: m.id, evidence: { sourceId: s.id, sourceVersionId: stored.id } });
    expect(await repository.getMemoryEntities({ tenantId: "nike", memoryId: m.id })).toHaveLength(2);
    expect(await repository.getMemorySources({ tenantId: "nike", memoryId: m.id })).toHaveLength(3);
    expect(await repository.getMemorySources({ tenantId: "other", memoryId: m.id })).toEqual([]);
    expect(await repository.getMemoryEntities({ tenantId: "other", memoryId: m.id })).toEqual([]);
  });

  it("updates only supplied fields, clears event time, and supports all JSON values", async () => {
    const m = await memory({ occurredAt: "2026-09-20T10:00:00Z", content: null });
    expect(memorySchema.parse(m).content).toBeNull();
    const updated = await repository.updateMemory({ tenantId: "nike", id: m.id, status: "superseded", occurredAt: null });
    expect(updated).toMatchObject({ summary: m.summary, content: null, confidence: 0.9, status: "superseded", occurredAt: null, createdAt: m.createdAt });
    for (const content of [["value", null, 3], "string", 42, false, { validFrom: "2026-09-20", canonicalKey: "anything" }]) {
      expect((await repository.updateMemory({ tenantId: "nike", id: m.id, content })).content).toEqual(content);
    }
    expect((await repository.updateMemory({ tenantId: "nike", id: m.id, content: null })).content).toBeNull();
    expect(await repository.getMemory({ tenantId: "other", memoryId: m.id })).toBeNull();
    await expect(repository.updateMemory({ tenantId: "other", id: m.id, summary: "unsafe" })).rejects.toThrow("not found");
    await expect(repository.updateMemory({ tenantId: "nike", id: "missing" })).rejects.toThrow("not found");
  });

  it("applies search/filter/paging semantics without duplicate entity joins or wildcard injection", async () => {
    const a = await memory({ summary: "Abel moved", type: "event", content: { destination: "Leuven", literal: "100%_done" } });
    const b = await memory({ summary: "HR commitment", type: "commitment", status: "uncertain" });
    const c = await memory({ summary: "Example memory", type: "fact", status: "superseded" });
    await memory({ tenantId: "other", summary: "Abel moved to Leuven" });
    for (const m of [a, b]) {
      await repository.linkMemoryEntity({ tenantId: "nike", memoryId: m.id, entityId: "abel", role: "subject" });
      await repository.linkMemoryEntity({ tenantId: "nike", memoryId: m.id, entityId: "abel", role: "actor" });
    }
    // Deliberate equal timestamps exercise the required ID tie-breaker.
    await pool.query("UPDATE memories SET created_at = $1 WHERE tenant_id = $2", ["2026-09-20T00:00:00Z", "nike"]);
    const ordered = [a.id, b.id, c.id].sort();
    const first = await repository.searchMemories({ tenantId: "nike", limit: 2 });
    expect(first.items.map((m) => m.id)).toEqual(ordered.slice(0, 2)); expect(first.nextOffset).toBe(2);
    const last = await repository.searchMemories({ tenantId: "nike", limit: 2, offset: first.nextOffset! });
    expect(last.items.map((m) => m.id)).toEqual(ordered.slice(2)); expect(last.nextOffset).toBeNull();
    expect((await repository.searchMemories({ tenantId: "nike", query: "LEUVEN" })).items.map((m) => m.id)).toEqual([a.id]);
    expect((await repository.searchMemories({ tenantId: "nike", query: "%_" })).items.map((m) => m.id)).toEqual([a.id]);
    expect((await repository.searchMemories({ tenantId: "nike", query: "' OR 1=1 --" })).items).toEqual([]);
    expect((await repository.searchMemories({ tenantId: "nike", types: ["commitment"], statuses: ["uncertain"], entityIds: ["abel"] })).items.map((m) => m.id)).toEqual([b.id]);
    for (const filter of [{ types: [] }, { statuses: [] }, { entityIds: [] }]) expect((await repository.searchMemories({ tenantId: "nike", ...filter })).items).toEqual([]);
    expect((await repository.getEntityMemories({ tenantId: "nike", entityId: "abel" })).items).toHaveLength(2);
    expect((await repository.searchMemories({ tenantId: "nike", entityIds: ["abel", "alex"] })).items).toHaveLength(2);
    expect((await repository.getEntityMemories({ tenantId: "other", entityId: "abel" })).items).toEqual([]);
  });

  it("orders timelines chronologically with inclusive bounds and creation-time fallback", async () => {
    const early = await memory({ occurredAt: "2026-09-20T00:00:00Z" });
    const unknown = await memory();
    const late = await memory({ occurredAt: "2026-09-22T00:00:00Z", status: "uncertain" });
    await pool.query("UPDATE memories SET created_at = $1 WHERE tenant_id = $2 AND id = $3", ["2026-09-21T00:00:00Z", "nike", unknown.id]);
    for (const m of [early, unknown, late]) await repository.linkMemoryEntity({ tenantId: "nike", memoryId: m.id, entityId: "abel", role: "subject" });
    expect((await repository.getTimeline({ tenantId: "nike", entityId: "abel" })).items.map((m) => m.id)).toEqual([early.id, unknown.id, late.id]);
    expect((await repository.getTimeline({ tenantId: "nike", from: "2026-09-20T00:00:00Z", to: "2026-09-21T00:00:00Z" })).items.map((m) => m.id)).toEqual([early.id, unknown.id]);
    expect((await repository.getTimeline({ tenantId: "nike", statuses: ["uncertain"] })).items.map((m) => m.id)).toEqual([late.id]);
    expect((await repository.getTimeline({ tenantId: "nike", entityId: "missing" })).items).toEqual([]);
    expect((await repository.getTimeline({ tenantId: "nike", limit: 1 })).nextOffset).toBe(1);
  });

  it("returns direct related memories once per edge with direction, type filters, and paging", async () => {
    const current = await memory(); const prior = await memory({ status: "superseded" }); const issue = await memory({ type: "issue" });
    const supersedes = { tenantId: "nike", fromMemoryId: current.id, toMemoryId: prior.id, type: "supersedes" as const };
    await repository.createMemoryEdge(supersedes); await repository.createMemoryEdge(supersedes);
    await repository.createMemoryEdge({ ...supersedes, type: "relates_to" });
    await repository.createMemoryEdge({ tenantId: "nike", fromMemoryId: issue.id, toMemoryId: current.id, type: "relates_to" });
    await repository.createMemoryEdge({ tenantId: "nike", fromMemoryId: current.id, toMemoryId: current.id, type: "supports" });
    expect((await repository.getRelatedMemories({ tenantId: "nike", memoryId: current.id })).items).toHaveLength(4);
    expect((await repository.getRelatedMemories({ tenantId: "nike", memoryId: current.id, direction: "outgoing" })).items).toHaveLength(3);
    expect((await repository.getRelatedMemories({ tenantId: "nike", memoryId: current.id, direction: "incoming" })).items).toHaveLength(2);
    const filtered = await repository.getRelatedMemories({ tenantId: "nike", memoryId: current.id, edgeTypes: ["supersedes"] });
    expect(filtered.items).toHaveLength(1); expect(filtered.items[0]?.memory.id).toBe(prior.id); expect(filtered.items[0]?.edge).toEqual(supersedes);
    expect((await repository.getRelatedMemories({ tenantId: "nike", memoryId: current.id, edgeTypes: [] })).items).toEqual([]);
    const first = await repository.getRelatedMemories({ tenantId: "nike", memoryId: current.id, limit: 2 });
    const second = await repository.getRelatedMemories({ tenantId: "nike", memoryId: current.id, limit: 2, offset: first.nextOffset! });
    expect(first.nextOffset).toBe(2); expect(second.items).toHaveLength(2); expect(second.nextOffset).toBeNull();
    expect((await repository.getRelatedMemories({ tenantId: "other", memoryId: current.id })).items).toEqual([]);
  });

  it("keeps historical provenance after supersession and returns only unresolved issues", async () => {
    const historical = await memory({ summary: "Previous state" }); const current = await memory({ summary: "Current state" });
    const s = await source(); const { stored } = await version(s.id);
    await repository.linkEvidence({ tenantId: "nike", memoryId: historical.id, evidence: { sourceId: s.id, sourceVersionId: stored.id, quote: "Immutable evidence" } });
    await repository.updateMemory({ tenantId: "nike", id: historical.id, status: "superseded" });
    await repository.createMemoryEdge({ tenantId: "nike", fromMemoryId: current.id, toMemoryId: historical.id, type: "supersedes" });
    expect(await repository.getMemorySources({ tenantId: "nike", memoryId: historical.id })).toHaveLength(1);
    const statuses: MemoryStatus[] = ["active", "uncertain", "conflicting", "resolved", "superseded"];
    for (const status of statuses) {
      const issue = await memory({ type: "issue", status });
      await repository.linkMemoryEntity({ tenantId: "nike", memoryId: issue.id, entityId: "abel", role: "affected" });
    }
    await memory({ type: "issue", tenantId: "other" });
    expect((await repository.getOpenIssues({ tenantId: "nike", entityId: "abel" })).items.map((m) => m.status).sort()).toEqual(["active", "conflicting", "uncertain"]);
    expect((await repository.getOpenIssues({ tenantId: "nike", entityId: "missing" })).items).toEqual([]);
    expect((await repository.getOpenIssues({ tenantId: "nike", limit: 2 })).nextOffset).toBe(2);
  });
});
