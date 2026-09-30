import type {
  Entity, EntityMemoriesQuery, JsonValue, Memory, MemoryEdge, MemoryListQuery, MemoryPage,
  MemorySearchQuery, MemorySource, OpenIssuesQuery, Pagination, RelatedMemoriesQuery,
  Source, SourceVersion, Tenant, TimelineQuery,
} from "@tunnelvision/core";
import type { MemoryReadRepository } from "../src/repository.js";

export const now = "2026-09-30T12:00:00.000Z";
export const abelId = "nike:employee:abel";
export const oldAddress = "14 Lantern Lane, 1000 Brussels (synthetic)";
export const newAddress = "82 Meadow Crescent, 3000 Leuven (synthetic)";

function memory(id: string, type: Memory["type"], summary: string, date: string, content: JsonValue,
  status: Memory["status"] = "active", tenantId = "nike"): Memory {
  return { id, tenantId, type, status, summary, content, confidence: status === "uncertain" ? 0.7 : 0.98,
    occurredAt: `${date}T12:00:00.000Z`, createdAt: now, updatedAt: now };
}

function page<T>(items: T[], query: Pagination): { items: T[]; nextOffset: number | null } {
  const offset = query.offset ?? 0, limit = query.limit ?? 50;
  return { items: items.slice(offset, offset + limit), nextOffset: items.length > offset + limit ? offset + limit : null };
}

/** A read-only mock: intentionally no mutation/ingestion methods exist. */
export class FixtureRepository implements MemoryReadRepository {
  reads: Array<{ method: string; query: unknown }> = [];
  tenants: Tenant[] = ["nike", "other"].map((id) => ({ id, name: id === "nike" ? "Nike Belgium (synthetic)" : "Other client",
    createdAt: now, updatedAt: now }));
  entities: Entity[] = [
    { id: abelId, tenantId: "nike", type: "employee", name: "Abel", metadata: { employeeId: "EMP-001", email: "abel@nike.example" }, createdAt: now, updatedAt: now },
    { id: "other:employee:private", tenantId: "other", type: "employee", name: "PRIVATE EMPLOYEE", metadata: {}, createdAt: now, updatedAt: now },
  ];
  memories: Memory[] = [
    memory("old", "fact", "Abel's prior address", "2026-09-01", { kind: "address", canonicalKey: `${abelId}:address`, value: oldAddress, validFrom: "2026-09-01", validUntil: "2026-09-20" }, "superseded"),
    memory("salary", "fact", "Abel earns EUR 1800 monthly base salary", "2026-09-01", { kind: "base_salary", value: 1800, currency: "EUR" }),
    memory("move", "event", "Abel moved effective 20 September", "2026-09-20", { kind: "move", oldAddress, newAddress, eventKey: "abel-move-2026-09-20" }),
    memory("new", "fact", "Abel's current address is in Leuven", "2026-09-20", { kind: "address", canonicalKey: `${abelId}:address`, value: newAddress, validFrom: "2026-09-20" }),
    memory("commute", "event", "Abel's bicycle commute increased about 10 km", "2026-09-20", { kind: "commute_change", fromKm: 5, toKm: 15, deltaKm: 10 }),
    memory("ack", "event", "HR acknowledged Abel's move", "2026-09-22", { kind: "hr_acknowledgment" }),
    memory("commitment", "commitment", "HR will pass on and update Abel's dossier", "2026-09-22", { kind: "dossier_update_commitment" }),
    memory("update-issue", "issue", "Later evidence suggests Abel's update was not carried through", "2026-09-28", { kind: "unprocessed_update" }, "uncertain"),
    memory("policy", "context", "Synthetic mobility policy indicates EUR 80 bicycle compensation", "2026-09-28", { kind: "mobility_context", expected: 80, actual: 50, currency: "EUR" }),
    memory("discrepancy", "issue", "Potential EUR 30 bicycle compensation discrepancy for Abel", "2026-09-28", { kind: "potential_discrepancy", amount: 30, confirmed: false }, "uncertain"),
    memory("resolved", "issue", "A resolved prior administrative issue", "2026-09-10", {}, "resolved"),
    memory("private", "fact", "PRIVATE OTHER TENANT SALARY", "2026-09-01", { value: "PRIVATE OTHER TENANT CONTENT" }, "active", "other"),
  ];
  edges: MemoryEdge[] = [
    { tenantId: "nike", fromMemoryId: "new", toMemoryId: "old", type: "supersedes" },
    { tenantId: "nike", fromMemoryId: "ack", toMemoryId: "new", type: "supports" },
    { tenantId: "nike", fromMemoryId: "update-issue", toMemoryId: "commitment", type: "follows" },
    { tenantId: "nike", fromMemoryId: "discrepancy", toMemoryId: "policy", type: "caused_by" },
  ];
  sources: Source[] = ["gmail", "sharepoint", "teams"].map((system) => ({ id: system, tenantId: "nike",
    system: system as Source["system"], externalId: `${system}/abel`, uri: `mock-data/nike/${system}/abel.txt`,
    title: `Abel ${system} evidence`, metadata: {}, createdAt: now, updatedAt: now }));
  versions: SourceVersion[] = this.sources.map((source) => ({ id: `${source.id}-v1`, tenantId: "nike", sourceId: source.id,
    version: "sha256:v1", contentHash: `hash:${source.id}:v1`, contentType: "text/plain",
    content: "FULL DOCUMENT MUST NEVER BE RETURNED " + "unrelated personal information ".repeat(500),
    metadata: {}, sourceModifiedAt: "2026-09-21T10:00:00Z", ingestedAt: now }));
  evidence: MemorySource[] = this.memories.filter((item) => item.tenantId === "nike").map((item) => ({
    tenantId: "nike", memoryId: item.id,
    evidence: { sourceId: ["old", "salary", "policy"].includes(item.id) ? "sharepoint" : ["ack", "commitment", "update-issue", "discrepancy"].includes(item.id) ? "teams" : "gmail",
      sourceVersionId: (["old", "salary", "policy"].includes(item.id) ? "sharepoint" : ["ack", "commitment", "update-issue", "discrepancy"].includes(item.id) ? "teams" : "gmail") + "-v1",
      locator: { messageId: `message-${item.id}` }, quote: item.id === "new" ? `My new address is ${newAddress}.` : item.summary },
  }));

  private record(method: string, query: unknown) { this.reads.push({ method, query }); }
  private list(query: MemoryListQuery): Memory[] {
    return this.memories.filter((m) => m.tenantId === query.tenantId &&
      (query.types === undefined || query.types.includes(m.type)) &&
      (query.statuses === undefined || query.statuses.includes(m.status)));
  }
  async getTenant(query: { tenantId: string }) { this.record("getTenant", query); return this.tenants.find((t) => t.id === query.tenantId) ?? null; }
  async listTenants(query: Pagination) { this.record("listTenants", query); return page(this.tenants, query); }
  async getEntity(query: { tenantId: string; entityId: string }) { this.record("getEntity", query); return this.entities.find((e) => e.tenantId === query.tenantId && e.id === query.entityId) ?? null; }
  async searchEntities(query: Pagination & { tenantId: string; query?: string }) {
    this.record("searchEntities", query);
    return page(this.entities.filter((e) => e.tenantId === query.tenantId && (!query.query || JSON.stringify(e).toLowerCase().includes(query.query.toLowerCase()))), query);
  }
  async getMemory(query: { tenantId: string; memoryId: string }) { this.record("getMemory", query); return this.memories.find((m) => m.tenantId === query.tenantId && m.id === query.memoryId) ?? null; }
  async getMemoryEntities(query: { tenantId: string; memoryId: string }) {
    this.record("getMemoryEntities", query);
    const memory = await this.getMemory(query);
    return memory ? [{ tenantId: query.tenantId, memoryId: query.memoryId, entityId: query.tenantId === "nike" ? abelId : "other:employee:private", role: "subject" as const }] : [];
  }
  async getMemorySources(query: { tenantId: string; memoryId: string }) { this.record("getMemorySources", query); return this.evidence.filter((e) => e.tenantId === query.tenantId && e.memoryId === query.memoryId); }
  async getSource(query: { tenantId: string; sourceId: string }) { this.record("getSource", query); return this.sources.find((s) => s.tenantId === query.tenantId && s.id === query.sourceId) ?? null; }
  async getSourceVersion(query: { tenantId: string; sourceVersionId: string }) { this.record("getSourceVersion", query); return this.versions.find((v) => v.tenantId === query.tenantId && v.id === query.sourceVersionId) ?? null; }
  async searchMemories(query: MemorySearchQuery): Promise<MemoryPage> {
    this.record("searchMemories", query);
    return page(this.list(query).filter((m) => (!query.query || (m.summary + JSON.stringify(m.content)).toLowerCase().includes(query.query.toLowerCase())) &&
      (query.entityIds === undefined || query.entityIds.includes(query.tenantId === "nike" ? abelId : "other:employee:private"))), query);
  }
  async getEntityMemories(query: EntityMemoriesQuery) { this.record("getEntityMemories", query); return page(query.entityId === abelId && query.tenantId === "nike" ? this.list(query) : [], query); }
  async getTimeline(query: TimelineQuery) {
    this.record("getTimeline", query);
    const result = this.list(query).filter((m) => (query.from === undefined || Date.parse(m.occurredAt ?? m.createdAt) >= Date.parse(query.from)) &&
      (query.to === undefined || Date.parse(m.occurredAt ?? m.createdAt) <= Date.parse(query.to)))
      .sort((a, b) => Date.parse(a.occurredAt ?? a.createdAt) - Date.parse(b.occurredAt ?? b.createdAt) || a.id.localeCompare(b.id));
    return page(result, query);
  }
  async getRelatedMemories(query: RelatedMemoriesQuery) {
    this.record("getRelatedMemories", query);
    const direction = query.direction ?? "both";
    const edges = this.edges.filter((e) => e.tenantId === query.tenantId && (query.edgeTypes === undefined || query.edgeTypes.includes(e.type)) &&
      ((direction !== "incoming" && e.fromMemoryId === query.memoryId) || (direction !== "outgoing" && e.toMemoryId === query.memoryId)));
    const items = edges.map((edge) => ({ edge, memory: this.memories.find((m) => m.tenantId === query.tenantId && m.id === (edge.fromMemoryId === query.memoryId ? edge.toMemoryId : edge.fromMemoryId))! }));
    return page(items, query);
  }
  async getOpenIssues(query: OpenIssuesQuery) {
    this.record("getOpenIssues", query);
    return page(this.list({ ...query, types: ["issue"], statuses: ["active", "uncertain", "conflicting"] }), query);
  }
}
