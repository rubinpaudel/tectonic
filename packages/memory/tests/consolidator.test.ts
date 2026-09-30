import { beforeEach, describe, expect, it } from "vitest";
import type { CandidateMemory, EvidenceRef, JsonObject } from "@tunnelvision/core";
import { candidateMemorySchema } from "@tunnelvision/core";
import { contentObject, DeterministicMemoryConsolidator } from "../src/index.js";
import { InMemoryTestRepository } from "./repository.js";

const time = "2026-09-30T10:00:00.000Z";
let repository: InMemoryTestRepository;
let evidence: EvidenceRef;
let consolidator: DeterministicMemoryConsolidator;
const candidate = (fields: JsonObject, overrides: Partial<CandidateMemory> = {}): CandidateMemory => candidateMemorySchema.parse({
  id: "candidate", tenantId: "nike", type: "fact", status: "active", summary: "A fact", content: { kind: "test", canonicalKey: "one", entityName: "Abel", ...fields }, confidence: 0.95, occurredAt: null,
  entityMentions: [{ kind: "external_id", value: "nike:employee:abel", role: "subject", entityType: "person" }, { kind: "name", value: "Abel", role: "subject" }], evidence: [evidence], extractedAt: time, ...overrides,
});
async function process(candidates: CandidateMemory[]) { return consolidator.consolidate({ tenantId: "nike", candidates, repository }); }

beforeEach(async () => {
  repository = new InMemoryTestRepository();
  consolidator = new DeterministicMemoryConsolidator();
  await repository.upsertTenant({ id: "nike", name: "Nike" });
  const source = await repository.upsertSource({ tenantId: "nike", system: "gmail", externalId: "email", uri: "file:///email", title: "Email", metadata: {} });
  const version = await repository.upsertSourceVersion({ tenantId: "nike", sourceId: source.id, version: "hash", contentHash: "hash", contentType: "text/plain", content: "evidence", metadata: {}, sourceModifiedAt: null });
  evidence = { sourceId: source.id, sourceVersionId: version.id, locator: { lineStart: 1 }, quote: "evidence" };
});

describe("generic deterministic consolidation", () => {
  it("creates one event, enriches missing details, and attaches supporting evidence", async () => {
    await process([candidate({ canonicalKey: "move", kind: "residence_change" }, { type: "event" })]);
    const id = repository.memories[0]!.id;
    await process([candidate({ canonicalKey: "move", kind: "residence_change", newAddress: "Address B" }, { type: "event" })]);
    expect(consolidator.lastStats.memoriesEnriched).toBe(1);
    await process([candidate({ canonicalKey: "move", kind: "residence_change" }, { type: "event", evidence: [{ ...evidence, locator: { lineStart: 2 } }] })]);
    expect(consolidator.lastStats.memoriesSupported).toBe(1);
    expect(repository.memories).toHaveLength(1);
    expect(repository.memories[0]!.id).toBe(id);
    expect(contentObject(repository.memories[0]!.content).newAddress).toBe("Address B");
    expect(await repository.getMemorySources({ tenantId: "nike", memoryId: id })).toHaveLength(2);
    expect(repository.entities).toHaveLength(1);
  });

  it("supersedes by validity when an older dossier arrives after the new address, retaining historical evidence", async () => {
    const newer = candidate({ kind: "home_address", canonicalKey: "new", value: "Address B", temporal: true, validFrom: "2026-09-20T00:00:00.000Z" });
    const older = candidate({ kind: "home_address", canonicalKey: "old", value: "Address A", temporal: true, validFrom: "2026-09-01T00:00:00.000Z" });
    await process([newer]);
    await process([older]);
    const current = repository.memories.find(memory => contentObject(memory.content).value === "Address B")!;
    const historical = repository.memories.find(memory => contentObject(memory.content).value === "Address A")!;
    expect(current.status).toBe("active");
    expect(historical.status).toBe("superseded");
    expect(contentObject(historical.content).validUntil).toBe("2026-09-20T00:00:00.000Z");
    expect(repository.edges).toContainEqual({ tenantId: "nike", fromMemoryId: current.id, toMemoryId: historical.id, type: "supersedes" });
    expect(await repository.getMemorySources({ tenantId: "nike", memoryId: historical.id })).toHaveLength(1);
    await process([older]);
    expect(repository.memories).toHaveLength(2);
    expect(repository.memories.find(memory => memory.id === current.id)!.status).toBe("active");
  });

  it("marks incompatible values as conflicting without overwriting their evidence", async () => {
    await process([candidate({ value: 50 })]);
    await process([candidate({ value: 80 }, { evidence: [{ ...evidence, locator: { lineStart: 2 } }] })]);
    expect(repository.memories).toHaveLength(2);
    expect(repository.memories.map(memory => memory.status)).toEqual(["conflicting", "conflicting"]);
    expect(repository.edges.some(edge => edge.type === "contradicts")).toBe(true);
    expect(consolidator.lastStats.conflicts).toBe(1);
    await process([candidate({ value: 80 })]);
    expect(repository.memories).toHaveLength(2);
    expect(repository.memories.every(memory => memory.status === "conflicting")).toBe(true);
  });

  it("contradicts event identity fields as well as primitive fact values", async () => {
    await process([candidate({ kind: "move", newAddress: "A", conflictFields: ["newAddress"] }, { type: "event" })]);
    await process([candidate({ kind: "move", newAddress: "B", conflictFields: ["newAddress"] }, { type: "event" })]);
    expect(repository.memories).toHaveLength(2);
    expect(repository.memories.every(memory => memory.status === "conflicting")).toBe(true);
  });

  it("links commitments, issues, historical memories, and an explicit resolution, even with targets arriving later", async () => {
    await process([candidate({ canonicalKey: "issue", relatedCanonicalKeys: ["commitment", "historical"] }, { type: "issue", status: "uncertain" })]);
    await process([candidate({ canonicalKey: "commitment", relatedCanonicalKeys: ["move"] }, { type: "commitment" }), candidate({ canonicalKey: "historical" }), candidate({ canonicalKey: "move" }, { type: "event" })]);
    expect(repository.edges.filter(edge => edge.type === "relates_to")).toHaveLength(3);
    expect((await repository.getOpenIssues({ tenantId: "nike" })).items).toHaveLength(1);
    await process([candidate({ canonicalKey: "resolution", resolvesCanonicalKeys: ["issue"] }, { type: "resolution" })]);
    expect((await repository.getOpenIssues({ tenantId: "nike" })).items).toHaveLength(0);
    expect(repository.edges.some(edge => edge.type === "resolves")).toBe(true);
  });

  it("leaves ambiguous names uncertain and does not arbitrarily merge", async () => {
    for (const id of ["nike:employee:abel-a", "nike:employee:abel-b"]) await repository.upsertEntity({ id, tenantId: "nike", name: "Abel", type: "person", metadata: {}, aliases: [{ kind: "name", value: "Abel" }] });
    await process([candidate({}, { entityMentions: [{ kind: "name", value: "Abel", role: "subject" }] })]);
    expect(repository.entities).toHaveLength(2);
    expect(repository.memories[0]!.status).toBe("uncertain");
    expect(contentObject(repository.memories[0]!.content).needsReview).toBe(true);
    expect(repository.memoryEntities).toHaveLength(0);
  });

  it("refuses conflicting strong aliases even when a canonical ID is supplied", async () => {
    await repository.upsertEntity({ id: "nike:employee:other", tenantId: "nike", name: "Other", type: "person", metadata: {}, aliases: [{ kind: "email", value: "abel@nike.example" }] });
    await process([candidate({}, { entityMentions: [{ kind: "external_id", value: "nike:employee:abel", role: "subject" }, { kind: "email", value: "abel@nike.example", role: "subject" }] })]);
    expect(repository.entities).toHaveLength(1);
    expect(repository.memoryEntities).toHaveLength(0);
    expect(repository.memories[0]!.status).toBe("uncertain");
  });

  it("keeps tenant memories and aliases separate and rejects mismatched candidates", async () => {
    await repository.upsertTenant({ id: "other", name: "Other" });
    await repository.upsertEntity({ id: "other:abel", tenantId: "other", name: "Abel", type: "person", metadata: {}, aliases: [{ kind: "name", value: "Abel" }] });
    await process([candidate({})]);
    expect(repository.entities.filter(entity => entity.tenantId === "nike")).toHaveLength(1);
    expect((await repository.searchMemories({ tenantId: "other" })).items).toHaveLength(0);
    await expect(process([candidate({}, { tenantId: "other" })])).rejects.toThrow("Candidate tenant mismatch");
    expect(repository.memories).toHaveLength(1);
  });
});
