import { describe, expect, it } from "vitest";
import {
  candidateMemorySchema,
  entityAliasSchema,
  evidenceRefSchema,
  memoryEdgeSchema,
  memoryEdgeTypeSchema,
  memoryEntityRoleSchema,
  memoryEntitySchema,
  memorySchema,
  memorySourceSchema,
  memoryStatusSchema,
  memoryTypeSchema,
  observationSchema,
  sourceSchema,
  sourceSystemSchema,
  sourceVersionSchema,
  tenantSchema,
  entitySchema,
  type CandidateMemory,
  type CreateMemoryInput,
  type JsonValue,
  type Memory,
  type Source,
  type SourceVersion,
  type UpdateMemoryInput,
} from "../src/index.js";

const timestamp = "2026-09-30T12:00:00Z";
const evidence = {
  sourceId: "source-1",
  sourceVersionId: "version-1",
  locator: { lines: { start: 3, end: 5 }, messageId: "message-1" },
  quote: "The rollout is approved for next week.",
};
const memory = {
  id: "memory-1",
  tenantId: "tenant-1",
  type: "decision",
  status: "active",
  summary: "The rollout is approved.",
  content: { action: "approve rollout", scope: ["project-1"], notes: null },
  confidence: 0.9,
  occurredAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
} satisfies Memory;

describe("shared vocabulary", () => {
  it("freezes the memory types, statuses, roles, and edge types", () => {
    expect(memoryTypeSchema.options).toEqual([
      "fact", "event", "decision", "commitment", "exception", "issue", "resolution", "context",
    ]);
    expect(memoryStatusSchema.options).toEqual([
      "active", "uncertain", "conflicting", "superseded", "resolved",
    ]);
    expect(memoryEntityRoleSchema.options).toEqual([
      "subject", "actor", "recipient", "organisation", "affected",
    ]);
    expect(memoryEdgeTypeSchema.options).toEqual([
      "relates_to", "caused_by", "resolves", "supersedes", "contradicts", "follows", "supports",
    ]);
    expect(sourceSystemSchema.options).toEqual(["gmail", "sharepoint", "teams"]);
  });

  it.each([
    { type: "custom_type" },
    { status: "archived" },
    { confidence: -0.1 },
    { confidence: 1.1 },
    { tenantId: "" },
  ])("rejects an invalid memory boundary: %j", (invalid) => {
    expect(memorySchema.safeParse({ ...memory, ...invalid }).success).toBe(false);
  });
});

describe("schema-flexible, JSON-compatible memory content", () => {
  const validContent: JsonValue[] = [
    null, true, 7, "context", [],
    { nested: { values: [true, null, 3.5, { customField: "anything" }] } },
  ];

  it.each(validContent.map((content) => ({ content })))(
    "accepts JSON content: %j",
    ({ content }) => {
      expect(memorySchema.parse({ ...memory, content }).content).toEqual(content);
    },
  );

  it.each([
    undefined, BigInt(1), new Date(timestamp), new Map(),
    Number.NaN, Number.POSITIVE_INFINITY, () => "value",
    { nested: undefined }, [undefined],
  ].map((content) => ({ content })))("rejects non-JSON content: %#", ({ content }) => {
    expect(memorySchema.safeParse({ ...memory, content }).success).toBe(false);
  });

  it("keeps domain fields in content and rejects unknown top-level fields", () => {
    expect(memorySchema.safeParse({ ...memory, customField: "value" }).success).toBe(false);
    expect(memorySchema.safeParse({ ...memory, content: { customField: "value" } }).success).toBe(true);
  });

  it("accepts timezone-qualified event time and rejects timezone-free time", () => {
    expect(memorySchema.safeParse({ ...memory, occurredAt: "2026-09-30T14:00:00+02:00" }).success).toBe(true);
    expect(memorySchema.safeParse({ ...memory, occurredAt: "2026-09-30T14:00:00" }).success).toBe(false);
  });

  it("supports creation without managed fields and clearing an event time on update", () => {
    const { id, createdAt, updatedAt, ...input } = memory;
    const createInput: CreateMemoryInput = input;
    const updateInput: UpdateMemoryInput = { id, tenantId: memory.tenantId, occurredAt: null };
    const result = memorySchema.parse({ ...createInput, createdAt, updatedAt, ...updateInput });
    expect(result.occurredAt).toBeNull();
  });
});

describe("source provenance and pipeline handoff", () => {
  it("represents a source identity and immutable text snapshot independently", () => {
    const source = {
      id: "source-1", tenantId: "tenant-1", system: "gmail",
      externalId: "gmail/thread-1.json", uri: "mock-data/nike/gmail/thread-1.json",
      title: "Rollout discussion", metadata: {}, createdAt: timestamp, updatedAt: timestamp,
    } satisfies Source;
    const version = {
      id: "version-1", tenantId: "tenant-1", sourceId: source.id,
      version: "revision-1", contentHash: "sha256:example", contentType: "application/json",
      content: '{"body":"The rollout is approved for next week."}',
      metadata: {}, sourceModifiedAt: null, ingestedAt: timestamp,
    } satisfies SourceVersion;
    expect(sourceSchema.parse(source).externalId).toBe("gmail/thread-1.json");
    expect(sourceVersionSchema.parse(version).content).toBe(version.content);
  });

  it("requires a source and a source version for evidence", () => {
    expect(evidenceRefSchema.safeParse({ sourceId: "source-1" }).success).toBe(false);
    expect(evidenceRefSchema.safeParse({ sourceVersionId: "version-1" }).success).toBe(false);
    expect(evidenceRefSchema.parse(evidence).locator).toEqual(evidence.locator);
  });

  it("preserves evidence and unresolved aliases from observations to candidates", () => {
    const observation = observationSchema.parse({
      id: "observation-1", tenantId: "tenant-1", text: evidence.quote,
      evidence: [evidence], metadata: {},
    });
    const candidate = {
      id: "candidate-1", tenantId: "tenant-1", type: "decision", status: "uncertain",
      summary: memory.summary, content: memory.content, confidence: 0.7, occurredAt: null,
      entityMentions: [{ value: "Project One", kind: "name", entityType: "project", role: "subject" }],
      evidence: observation.evidence, extractedAt: timestamp,
    } satisfies CandidateMemory;
    expect(candidateMemorySchema.parse(candidate).evidence).toEqual([evidence]);
    expect(candidateMemorySchema.safeParse({ ...candidate, evidence: [] }).success).toBe(false);
    expect(observationSchema.safeParse({ ...observation, evidence: [] }).success).toBe(false);
  });

  it("links consolidated memory to entities, versioned evidence, and other memories", () => {
    const entity = entitySchema.parse({
      id: "entity-1", tenantId: "tenant-1", type: "project", name: "Project One",
      metadata: {}, createdAt: timestamp, updatedAt: timestamp,
    });
    expect(tenantSchema.parse({
      id: "tenant-1", name: "Example organisation", createdAt: timestamp, updatedAt: timestamp,
    }).id).toBe(entity.tenantId);
    expect(entityAliasSchema.parse({
      tenantId: entity.tenantId, entityId: entity.id, kind: "name", value: entity.name,
    }).value).toBe("Project One");
    expect(memoryEntitySchema.parse({
      tenantId: memory.tenantId, memoryId: memory.id, entityId: entity.id, role: "subject",
    }).entityId).toBe(entity.id);
    expect(memorySourceSchema.parse({
      tenantId: memory.tenantId, memoryId: memory.id, evidence,
    }).evidence.sourceVersionId).toBe("version-1");
    expect(memoryEdgeSchema.parse({
      tenantId: memory.tenantId, fromMemoryId: "resolution-1", toMemoryId: "issue-1", type: "resolves",
    }).toMemoryId).toBe("issue-1");
  });
});
