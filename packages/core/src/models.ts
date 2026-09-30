import { z } from "zod";

export const idSchema = z.string().min(1);
export const timestampSchema = z.iso.datetime({ offset: true });
export const jsonValueSchema = z.json();
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
export type JsonValue = z.infer<typeof jsonValueSchema>;
export type JsonObject = z.infer<typeof jsonObjectSchema>;

export const sourceSystemSchema = z.enum(["gmail", "sharepoint", "teams"]);
export type SourceSystem = z.infer<typeof sourceSystemSchema>;

export const memoryTypeSchema = z.enum([
  "fact",
  "event",
  "decision",
  "commitment",
  "exception",
  "issue",
  "resolution",
  "context",
]);
export type MemoryType = z.infer<typeof memoryTypeSchema>;

export const memoryStatusSchema = z.enum([
  "active",
  "uncertain",
  "conflicting",
  "superseded",
  "resolved",
]);
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;

export const memoryEntityRoleSchema = z.enum([
  "subject",
  "actor",
  "recipient",
  "organisation",
  "affected",
]);
export type MemoryEntityRole = z.infer<typeof memoryEntityRoleSchema>;

export const memoryEdgeTypeSchema = z.enum([
  "relates_to",
  "caused_by",
  "resolves",
  "supersedes",
  "contradicts",
  "follows",
  "supports",
]);
export type MemoryEdgeType = z.infer<typeof memoryEdgeTypeSchema>;

export const tenantSchema = z.strictObject({
  id: idSchema,
  name: z.string().min(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Tenant = z.infer<typeof tenantSchema>;

export const entitySchema = z.strictObject({
  id: idSchema,
  tenantId: idSchema,
  type: z.string().min(1),
  name: z.string().min(1),
  metadata: jsonObjectSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Entity = z.infer<typeof entitySchema>;

// Alias kinds are open strings, e.g. "name", "email", or "external_id".
export const entityAliasSchema = z.strictObject({
  tenantId: idSchema,
  entityId: idSchema,
  kind: z.string().min(1),
  value: z.string().min(1),
});
export type EntityAlias = z.infer<typeof entityAliasSchema>;

export const sourceSchema = z.strictObject({
  id: idSchema,
  tenantId: idSchema,
  system: sourceSystemSchema,
  externalId: z.string().min(1),
  uri: z.string().min(1),
  title: z.string().min(1),
  metadata: jsonObjectSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Source = z.infer<typeof sourceSchema>;

// An immutable text snapshot; version is a provider version or content hash.
export const sourceVersionSchema = z.strictObject({
  id: idSchema,
  tenantId: idSchema,
  sourceId: idSchema,
  version: z.string().min(1),
  contentHash: z.string().min(1),
  contentType: z.string().min(1),
  content: z.string(),
  metadata: jsonObjectSchema,
  sourceModifiedAt: timestampSchema.nullable(),
  ingestedAt: timestampSchema,
});
export type SourceVersion = z.infer<typeof sourceVersionSchema>;

// Locator is parser-defined JSON, e.g. line numbers or a message/paragraph ID.
export const evidenceRefSchema = z.strictObject({
  sourceId: idSchema,
  sourceVersionId: idSchema,
  locator: jsonObjectSchema.optional(),
  quote: z.string().min(1).optional(),
});
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

export const observationSchema = z.strictObject({
  id: idSchema,
  tenantId: idSchema,
  text: z.string().min(1),
  evidence: z.array(evidenceRefSchema).min(1),
  metadata: jsonObjectSchema,
});
export type Observation = z.infer<typeof observationSchema>;

// Extracted aliases are mentions, not resolved entity identities.
export const entityMentionSchema = z.strictObject({
  value: z.string().min(1),
  kind: z.string().min(1),
  entityType: z.string().min(1).optional(),
  role: memoryEntityRoleSchema,
});
export type EntityMention = z.infer<typeof entityMentionSchema>;

const memoryFields = {
  tenantId: idSchema,
  type: memoryTypeSchema,
  status: memoryStatusSchema,
  summary: z.string().min(1),
  content: jsonValueSchema,
  confidence: z.number().min(0).max(1),
  // Domain event time; null means unknown. Repository timestamps are separate.
  occurredAt: timestampSchema.nullable(),
};

export const candidateMemorySchema = z.strictObject({
  ...memoryFields,
  id: idSchema,
  entityMentions: z.array(entityMentionSchema),
  evidence: z.array(evidenceRefSchema).min(1),
  extractedAt: timestampSchema,
});
export type CandidateMemory = z.infer<typeof candidateMemorySchema>;

export const memorySchema = z.strictObject({
  ...memoryFields,
  id: idSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Memory = z.infer<typeof memorySchema>;

export const memoryEntitySchema = z.strictObject({
  tenantId: idSchema,
  memoryId: idSchema,
  entityId: idSchema,
  role: memoryEntityRoleSchema,
});
export type MemoryEntity = z.infer<typeof memoryEntitySchema>;

export const memorySourceSchema = z.strictObject({
  tenantId: idSchema,
  memoryId: idSchema,
  evidence: evidenceRefSchema,
});
export type MemorySource = z.infer<typeof memorySourceSchema>;

export const memoryEdgeSchema = z.strictObject({
  tenantId: idSchema,
  fromMemoryId: idSchema,
  toMemoryId: idSchema,
  type: memoryEdgeTypeSchema,
});
export type MemoryEdge = z.infer<typeof memoryEdgeSchema>;
