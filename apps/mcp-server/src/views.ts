import type { Entity, JsonObject, JsonValue, Memory, MemoryPage, MemorySource } from "@tunnelvision/core";
import type { MemoryReadRepository } from "./repository.js";

export class ReadError extends Error {}

export function assertTenant(value: { tenantId: string }, tenantId: string): void {
  if (value.tenantId !== tenantId) throw new ReadError("Invalid tenant-scoped repository result.");
}

/** Keep semantic content useful without turning a memory read into a document dump. */
export function compactJson(value: JsonValue): { value: JsonValue; truncated: boolean } {
  let truncated = false;
  let remaining = 6_000;
  function visit(item: JsonValue, depth: number): JsonValue {
    if (remaining <= 0 || depth > 6) { truncated = true; return "[truncated]"; }
    remaining -= 8;
    if (typeof item === "string") {
      const max = Math.max(0, Math.min(1_000, remaining));
      remaining -= Math.min(item.length, max);
      if (item.length > max) { truncated = true; return item.slice(0, max) + "…"; }
      return item;
    }
    if (Array.isArray(item)) {
      if (item.length > 20) truncated = true;
      return item.slice(0, 20).map((entry) => visit(entry, depth + 1));
    }
    if (item && typeof item === "object") {
      const entries = Object.entries(item);
      if (entries.length > 30) truncated = true;
      return Object.fromEntries(entries.slice(0, 30).map(([key, entry]) => {
        remaining -= key.length;
        return [key.slice(0, 100), visit(entry, depth + 1)];
      }));
    }
    return item;
  }
  const result = visit(value, 0);
  return { value: result, truncated };
}

function objectContent(memory: Memory): JsonObject {
  return memory.content && typeof memory.content === "object" && !Array.isArray(memory.content)
    ? memory.content : {};
}

function validity(memory: Memory, key: "validFrom" | "validUntil"): string | null {
  const value = objectContent(memory)[key];
  return typeof value === "string" ? value.slice(0, 64) : null;
}

/** Only a documented validity interval can make a superseded fact current in the past. */
export function temporalState(memory: Memory, asOf: string): string {
  if (memory.status !== "active" && memory.status !== "superseded") return memory.status;
  const from = validity(memory, "validFrom");
  const until = validity(memory, "validUntil");
  if (memory.status === "superseded" && (memory.type !== "fact" || !from || !until)) return "historical";
  if ((from && Number.isNaN(Date.parse(from))) || (until && Number.isNaN(Date.parse(until)))) return "unknown_validity";
  if (from && until && Date.parse(from) >= Date.parse(until)) return "unknown_validity";
  if (from && Date.parse(from) > Date.parse(asOf)) return "scheduled";
  if (until && Date.parse(until) <= Date.parse(asOf)) return "historical";
  return memory.type === "fact" ? "current" : "recorded";
}

export function entityView(entity: Entity) {
  const metadata = compactJson(entity.metadata);
  return { id: entity.id, type: entity.type, name: entity.name.slice(0, 300), metadata: metadata.value,
    metadata_truncated: metadata.truncated };
}

export class MemoryViews {
  constructor(private readonly repository: MemoryReadRepository, readonly tenantId: string, readonly asOf: string) {}

  async entity(entityId: string): Promise<Entity> {
    const entity = await this.repository.getEntity({ tenantId: this.tenantId, entityId });
    if (!entity) throw new ReadError("Entity not found in this tenant.");
    assertTenant(entity, this.tenantId);
    if (entity.id !== entityId) throw new ReadError("Invalid entity reference.");
    return entity;
  }

  async memory(memoryId: string): Promise<Memory> {
    const memory = await this.repository.getMemory({ tenantId: this.tenantId, memoryId });
    if (!memory) throw new ReadError("Memory not found in this tenant.");
    assertTenant(memory, this.tenantId);
    if (memory.id !== memoryId) throw new ReadError("Invalid memory reference.");
    return memory;
  }

  async evidence(link: MemorySource, memoryId: string) {
    assertTenant(link, this.tenantId);
    if (link.memoryId !== memoryId) throw new ReadError("Invalid evidence reference.");
    const ref = link.evidence;
    const [source, version] = await Promise.all([
      this.repository.getSource({ tenantId: this.tenantId, sourceId: ref.sourceId }),
      this.repository.getSourceVersion({ tenantId: this.tenantId, sourceVersionId: ref.sourceVersionId }),
    ]);
    if (!source || !version) throw new ReadError("Evidence reference unavailable.");
    assertTenant(source, this.tenantId);
    assertTenant(version, this.tenantId);
    if (source.id !== ref.sourceId || version.id !== ref.sourceVersionId || version.sourceId !== source.id) {
      throw new ReadError("Invalid evidence source/version relationship.");
    }
    return {
      source_id: source.id, system: source.system, title: source.title.slice(0, 300),
      uri: source.uri.slice(0, 1_000), external_id: source.externalId.slice(0, 300),
      source_version_id: version.id, version: version.version.slice(0, 300),
      content_hash: version.contentHash.slice(0, 300), source_modified_at: version.sourceModifiedAt,
      ingested_at: version.ingestedAt, locator: compactJson(ref.locator ?? {}).value,
      excerpt: ref.quote?.slice(0, 500) ?? null,
      excerpt_truncated: (ref.quote?.length ?? 0) > 500,
    };
  }

  async evidencePage(memoryId: string, limit: number, offset: number) {
    await this.memory(memoryId);
    const links = await this.repository.getMemorySources({ tenantId: this.tenantId, memoryId });
    const items = await Promise.all(links.slice(offset, offset + limit).map((link) => this.evidence(link, memoryId)));
    return { items, next_offset: offset + limit < links.length ? offset + limit : null };
  }

  async view(memory: Memory) {
    assertTenant(memory, this.tenantId);
    const lookup = { tenantId: this.tenantId, memoryId: memory.id };
    const [links, evidence, related] = await Promise.all([
      this.repository.getMemoryEntities(lookup), this.evidencePage(memory.id, 5, 0),
      this.repository.getRelatedMemories({ ...lookup, limit: 10 }),
    ]);
    const entities = await Promise.all(links.slice(0, 20).map(async (link) => {
      assertTenant(link, this.tenantId);
      if (link.memoryId !== memory.id) throw new ReadError("Invalid memory/entity relationship.");
      const entity = await this.entity(link.entityId);
      return { id: entity.id, name: entity.name.slice(0, 300), type: entity.type, role: link.role };
    }));
    const content = compactJson(memory.content);
    return {
      id: memory.id, type: memory.type, summary: memory.summary.slice(0, 800),
      content: content.value, content_truncated: content.truncated,
      status: memory.status, confidence: memory.confidence,
      occurred_at: memory.occurredAt, created_at: memory.createdAt, updated_at: memory.updatedAt,
      valid_from: validity(memory, "validFrom"), valid_until: validity(memory, "validUntil"),
      temporal_state: temporalState(memory, this.asOf), entities,
      entities_truncated: links.length > 20, evidence: evidence.items,
      evidence_next_offset: evidence.next_offset,
      relations: related.items.map(({ memory: neighbour, edge }) => {
        assertTenant(neighbour, this.tenantId);
        assertTenant(edge, this.tenantId);
        const outgoing = edge.fromMemoryId === memory.id && edge.toMemoryId === neighbour.id;
        const incoming = edge.toMemoryId === memory.id && edge.fromMemoryId === neighbour.id;
        if (!outgoing && !incoming) throw new ReadError("Invalid related-memory reference.");
        return { memory_id: neighbour.id, relationship: edge.type, direction: outgoing ? "outgoing" : "incoming",
          summary: neighbour.summary.slice(0, 300), status: neighbour.status };
      }),
      relations_next_offset: related.nextOffset,
    };
  }

  async page(page: MemoryPage) {
    return { tenant: this.tenantId, as_of: this.asOf,
      items: await Promise.all(page.items.map((memory) => this.view(memory))), next_offset: page.nextOffset };
  }
}
