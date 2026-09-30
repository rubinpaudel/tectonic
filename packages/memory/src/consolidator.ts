import type { EvidenceRef, JsonObject, JsonValue, Memory, MemoryConsolidationInput, MemoryConsolidator, MemoryEdgeType, MemoryRepository } from "@tunnelvision/core";
import { EntityResolver } from "./resolver.js";

export type ConsolidationAction = "CREATE" | "ENRICH" | "SUPPORT" | "SUPERSEDE" | "CONTRADICT" | "LINK";
export interface ConsolidationStats {
  entitiesCreated: number;
  memoriesCreated: number;
  memoriesEnriched: number;
  memoriesSupported: number;
  memoriesSuperseded: number;
  conflicts: number;
  links: number;
  issues: number;
  unresolvedEntities: number;
}
export const emptyConsolidationStats = (): ConsolidationStats => ({ entitiesCreated: 0, memoriesCreated: 0, memoriesEnriched: 0, memoriesSupported: 0, memoriesSuperseded: 0, conflicts: 0, links: 0, issues: 0, unresolvedEntities: 0 });
export const contentObject = (value: JsonValue): JsonObject => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
const string = (value: JsonValue | undefined): string => typeof value === "string" ? value : "";
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const canonical = (memory: Pick<Memory, "content">): string => string(contentObject(memory.content).canonicalKey);
const validity = (memory: Memory): string => string(contentObject(memory.content).validFrom) || memory.occurredAt || "";

export async function listAllMemories(repository: MemoryRepository, tenantId: string): Promise<Memory[]> {
  const result: Memory[] = [];
  let offset = 0;
  while (true) {
    const page = await repository.searchMemories({ tenantId, limit: 100, offset });
    if (page.items.some(memory => memory.tenantId !== tenantId)) throw new Error("Repository leaked memory across tenants");
    result.push(...page.items);
    if (page.nextOffset === null) return result;
    if (page.nextOffset <= offset) throw new Error("Repository returned non-advancing pagination");
    offset = page.nextOffset;
  }
}

function merge(old: JsonObject, incoming: JsonObject): JsonObject {
  const result = { ...old };
  for (const [key, value] of Object.entries(incoming)) {
    if (Array.isArray(value) && Array.isArray(result[key])) {
      result[key] = [...new Map([...(result[key] as JsonValue[]), ...value].map(item => [JSON.stringify(item), item])).values()];
    } else if (result[key] === undefined || result[key] === null) result[key] = value;
    else if (typeof result[key] === "object" && !Array.isArray(result[key]) && typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = merge(contentObject(result[key]!), value);
    }
  }
  return result;
}

function resolvedContent(content: JsonObject, entityId: string): JsonObject {
  const identityKey = string(content.identityKey);
  const replace = (value: JsonValue): JsonValue => {
    if (typeof value === "string" && identityKey) return value.replaceAll(identityKey, entityId);
    if (Array.isArray(value)) return value.map(replace);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    return value;
  };
  return { ...contentObject(replace(content)), entityId, identityKey: entityId };
}

/** Generic reconciliation keyed by content canonical identity and validity. */
export class DeterministicMemoryConsolidator implements MemoryConsolidator {
  readonly resolver = new EntityResolver();
  lastStats = emptyConsolidationStats();
  readonly actions: Array<{ action: ConsolidationAction; memoryId: string }> = [];

  async consolidate(input: MemoryConsolidationInput): Promise<Memory[]> {
    const { tenantId, repository } = input;
    for (const candidate of input.candidates) if (candidate.tenantId !== tenantId) throw new Error("Candidate tenant mismatch");
    this.lastStats = emptyConsolidationStats();
    this.actions.length = 0;
    const memories = await listAllMemories(repository, tenantId);
    const touched = new Map<string, Memory>();
    const replace = (memory: Memory): void => {
      const index = memories.findIndex(item => item.id === memory.id);
      if (index < 0) memories.push(memory); else memories[index] = memory;
      touched.set(memory.id, memory);
    };
    for (const candidate of input.candidates) {
      let content = contentObject(candidate.content);
      const resolution = await this.resolver.resolve(tenantId, candidate.entityMentions, repository, string(content.entityName) || undefined);
      this.lastStats.entitiesCreated += resolution.created;
      this.lastStats.unresolvedEntities += resolution.unresolved.length;
      const subject = resolution.entities.find(item => item.role === "subject")?.entity;
      if (subject) content = resolvedContent(content, subject.id);
      if (resolution.unresolved.length) {
        content = { ...content, unresolvedEntityMentions: resolution.unresolved.map(item => ({ value: item.mention.value, kind: item.mention.kind, role: item.mention.role, reason: item.reason, possibleEntityIds: item.possibleEntityIds })), needsReview: true };
        // A content hint is not an entity resolution result.
        if (!subject) delete content.entityId;
      }
      const key = string(content.canonicalKey) || `candidate:${candidate.id}`;
      content.canonicalKey = key;
      const matches = memories.filter(memory => canonical(memory) === key);
      const compatible = matches.find(memory => {
        const existing = contentObject(memory.content);
        const fields = [...new Set(["value", ...(Array.isArray(content.conflictFields) ? content.conflictFields.filter((field): field is string => typeof field === "string") : []), ...(Array.isArray(existing.conflictFields) ? existing.conflictFields.filter((field): field is string => typeof field === "string") : [])])];
        return fields.every(field => content[field] === undefined || existing[field] === undefined || same(existing[field], content[field]));
      });
      let memory: Memory;
      if (compatible) {
        const merged = merge(contentObject(compatible.content), content);
        const enriched = !same(merged, compatible.content);
        const status = resolution.unresolved.length ? "uncertain" : compatible.status;
        memory = await repository.updateMemory({ id: compatible.id, tenantId, content: merged, confidence: Math.max(compatible.confidence, candidate.confidence), status,
          ...(compatible.occurredAt === null && candidate.occurredAt ? { occurredAt: candidate.occurredAt } : {}),
        });
        if (enriched) this.lastStats.memoriesEnriched++; else this.lastStats.memoriesSupported++;
        this.actions.push({ action: enriched ? "ENRICH" : "SUPPORT", memoryId: memory.id });
      } else {
        memory = await repository.createMemory({ tenantId, type: candidate.type, status: matches.length ? "conflicting" : resolution.unresolved.length ? "uncertain" : candidate.status,
          summary: candidate.summary, content, confidence: candidate.confidence, occurredAt: candidate.occurredAt });
        this.lastStats.memoriesCreated++;
        if (memory.type === "issue") this.lastStats.issues++;
        this.actions.push({ action: "CREATE", memoryId: memory.id });
        for (const conflicting of matches) {
          replace(await repository.updateMemory({ id: conflicting.id, tenantId, status: "conflicting" }));
          await this.edge(repository, tenantId, memory.id, conflicting.id, "contradicts");
          this.lastStats.conflicts++;
          this.actions.push({ action: "CONTRADICT", memoryId: memory.id });
        }
      }
      replace(memory);
      for (const item of resolution.entities) await repository.linkMemoryEntity({ tenantId, memoryId: memory.id, entityId: item.entity.id, role: item.role });
      for (const evidence of candidate.evidence) await repository.linkEvidence({ tenantId, memoryId: memory.id, evidence });
    }
    // Reconcile the whole tenant so older snapshots and missing relationship targets
    // can safely arrive later. Existing evidence links are never removed.
    await this.reconcileTemporal(tenantId, repository, memories, replace);
    await this.reconcileLinks(tenantId, repository, memories, replace);
    return [...touched.values()];
  }

  private async edge(repository: MemoryRepository, tenantId: string, fromMemoryId: string, toMemoryId: string, type: MemoryEdgeType): Promise<void> {
    if (fromMemoryId === toMemoryId) return;
    // Idempotent repository writes make crash retries safe. Count only new edges.
    let offset = 0;
    let exists = false;
    while (true) {
      const page = await repository.getRelatedMemories({ tenantId, memoryId: fromMemoryId, direction: "outgoing", limit: 100, offset, edgeTypes: [type] });
      if (page.items.some(item => item.edge.toMemoryId === toMemoryId)) { exists = true; break; }
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    if (!exists) {
      await repository.createMemoryEdge({ tenantId, fromMemoryId, toMemoryId, type });
      this.lastStats.links++;
      this.actions.push({ action: "LINK", memoryId: fromMemoryId });
    }
  }

  private async reconcileTemporal(tenantId: string, repository: MemoryRepository, memories: Memory[], replace: (memory: Memory) => void): Promise<void> {
    const groups = new Map<string, Memory[]>();
    for (const memory of memories) {
      const content = contentObject(memory.content);
      if (content.temporal !== true || !content.entityId || !content.kind) continue;
      const key = `${content.entityId}:${content.kind}`;
      groups.set(key, [...(groups.get(key) ?? []), memory]);
    }
    for (const group of groups.values()) {
      const known = group.filter(memory => validity(memory)).sort((a, b) => validity(a).localeCompare(validity(b)) || a.id.localeCompare(b.id));
      for (const memory of group.filter(item => !validity(item))) {
        if (known.length && memory.status !== "uncertain") replace(await repository.updateMemory({ tenantId, id: memory.id, status: "uncertain" }));
      }
      for (const memory of known) {
        const next = known.find(item => validity(item) > validity(memory));
        const peers = known.filter(item => validity(item) === validity(memory));
        const conflict = peers.some(item => !same(contentObject(item.content).value, contentObject(memory.content).value));
        const status = next ? "superseded" : conflict ? "conflicting" : memory.status === "superseded" ? "active" : memory.status;
        const content = { ...contentObject(memory.content), ...(next ? { validUntil: validity(next) } : {}) };
        if (!next) delete content.validUntil;
        if (memory.status !== status || !same(memory.content, content)) {
          replace(await repository.updateMemory({ tenantId, id: memory.id, status, content }));
          if (status === "superseded" && memory.status !== "superseded") {
            this.lastStats.memoriesSuperseded++;
            this.actions.push({ action: "SUPERSEDE", memoryId: memory.id });
          }
        }
        if (next) await this.edge(repository, tenantId, next.id, memory.id, "supersedes");
        if (conflict) for (const peer of peers) if (peer.id !== memory.id && !same(contentObject(peer.content).value, contentObject(memory.content).value)) {
          await this.edge(repository, tenantId, memory.id, peer.id, "contradicts");
        }
      }
    }
  }

  private async reconcileLinks(tenantId: string, repository: MemoryRepository, memories: Memory[], replace: (memory: Memory) => void): Promise<void> {
    const byKey = new Map<string, Memory[]>();
    for (const memory of memories) byKey.set(canonical(memory), [...(byKey.get(canonical(memory)) ?? []), memory]);
    for (const memory of memories) {
      const content = contentObject(memory.content);
      for (const [field, type] of [["relatedCanonicalKeys", "relates_to"], ["causedByCanonicalKeys", "caused_by"], ["resolvesCanonicalKeys", "resolves"], ["supportCanonicalKeys", "supports"], ["evidenceContextCanonicalKeys", "relates_to"]] as const) {
        const keys = content[field];
        if (!Array.isArray(keys)) continue;
        for (const key of keys) for (const target of byKey.get(string(key)) ?? []) {
          await this.edge(repository, tenantId, memory.id, target.id, type);
          if (type === "resolves" && target.status !== "resolved") replace(await repository.updateMemory({ tenantId, id: target.id, status: "resolved" }));
          if (type === "supports") {
            const sources = await repository.getMemorySources({ tenantId, memoryId: memory.id });
            for (const source of sources) await repository.linkEvidence({ tenantId, memoryId: target.id, evidence: source.evidence });
          }
          if (field === "evidenceContextCanonicalKeys") {
            const sources = await repository.getMemorySources({ tenantId, memoryId: target.id });
            for (const source of sources) await repository.linkEvidence({ tenantId, memoryId: memory.id, evidence: source.evidence });
          }
        }
      }
      for (const matcherField of ["supportMemoryMatchers", "evidenceContextMatchers"] as const) {
      const matchers = content[matcherField];
      if (Array.isArray(matchers)) for (const matcherValue of matchers) {
        const matcher = contentObject(matcherValue);
        for (const target of memories.filter(item => {
          const targetContent = contentObject(item.content);
          return targetContent.kind === matcher.kind && targetContent.entityId === content.entityId && same(targetContent.value, matcher.value);
        })) {
          await this.edge(repository, tenantId, memory.id, target.id, matcherField === "supportMemoryMatchers" ? "supports" : "relates_to");
          const fromId = matcherField === "supportMemoryMatchers" ? memory.id : target.id;
          const toId = matcherField === "supportMemoryMatchers" ? target.id : memory.id;
          for (const source of await repository.getMemorySources({ tenantId, memoryId: fromId })) await repository.linkEvidence({ tenantId, memoryId: toId, evidence: source.evidence });
        }
      }
      }
    }
  }
}

export async function consolidateCandidates(input: MemoryConsolidationInput): Promise<{ memories: Memory[]; stats: ConsolidationStats }> {
  const consolidator = new DeterministicMemoryConsolidator();
  const memories = await consolidator.consolidate(input);
  return { memories, stats: consolidator.lastStats };
}

export async function collectMemoryEvidence(repository: MemoryRepository, tenantId: string, memories: Memory[]): Promise<Map<string, EvidenceRef[]>> {
  const result = new Map<string, EvidenceRef[]>();
  for (const memory of memories) result.set(memory.id, (await repository.getMemorySources({ tenantId, memoryId: memory.id })).map(source => source.evidence));
  return result;
}
