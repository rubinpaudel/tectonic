import type { JsonObject, JsonValue } from "@tunnelvision/core";
import { sql } from "drizzle-orm";
import {
  check, doublePrecision, foreignKey, index, jsonb, pgTable, primaryKey,
  text, timestamp, unique,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "string", precision: 3 }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true, mode: "string", precision: 3 }).notNull().defaultNow();

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const entities = pgTable("entities", {
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  id: text("id").notNull(),
  type: text("type").notNull(),
  name: text("name").notNull(),
  metadata: jsonb("metadata").$type<JsonObject>().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.id] }),
  index("entities_tenant_name_idx").on(t.tenantId, t.name),
  check("entities_metadata_object", sql`jsonb_typeof(${t.metadata}) = 'object'`),
]);

export const entityAliases = pgTable("entity_aliases", {
  tenantId: text("tenant_id").notNull(),
  entityId: text("entity_id").notNull(),
  kind: text("kind").notNull(),
  value: text("value").notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.entityId, t.kind, t.value] }),
  foreignKey({ columns: [t.tenantId, t.entityId], foreignColumns: [entities.tenantId, entities.id] }),
  index("entity_aliases_lookup_idx").on(t.tenantId, t.kind, t.value),
]);

export const sources = pgTable("sources", {
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  id: text("id").notNull(),
  system: text("system").notNull(),
  externalId: text("external_id").notNull(),
  uri: text("uri").notNull(),
  title: text("title").notNull(),
  metadata: jsonb("metadata").$type<JsonObject>().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.id] }),
  unique("sources_identity_unique").on(t.tenantId, t.system, t.externalId),
  check("sources_system_check", sql`${t.system} in ('gmail', 'sharepoint', 'teams')`),
  check("sources_metadata_object", sql`jsonb_typeof(${t.metadata}) = 'object'`),
]);

export const sourceVersions = pgTable("source_versions", {
  tenantId: text("tenant_id").notNull(),
  id: text("id").notNull(),
  sourceId: text("source_id").notNull(),
  version: text("version").notNull(),
  contentHash: text("content_hash").notNull(),
  contentType: text("content_type").notNull(),
  content: text("content").notNull(),
  metadata: jsonb("metadata").$type<JsonObject>().notNull(),
  // Preserve the provider's exact ISO snapshot string, including fractional digits.
  sourceModifiedAt: text("source_modified_at"),
  ingestedAt: timestamp("ingested_at", { withTimezone: true, mode: "string", precision: 3 }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.id] }),
  foreignKey({ columns: [t.tenantId, t.sourceId], foreignColumns: [sources.tenantId, sources.id] }),
  unique("source_versions_identity_unique").on(t.tenantId, t.sourceId, t.version),
  unique("source_versions_evidence_unique").on(t.tenantId, t.sourceId, t.id),
  index("source_versions_hash_idx").on(t.tenantId, t.sourceId, t.contentHash),
  index("source_versions_latest_idx").on(t.tenantId, t.sourceId, t.ingestedAt),
  check("source_versions_metadata_object", sql`jsonb_typeof(${t.metadata}) = 'object'`),
  check("source_versions_modified_at_check", sql`${t.sourceModifiedAt} is null or ${t.sourceModifiedAt}::timestamptz is not null`),
]);

export const memories = pgTable("memories", {
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  id: text("id").notNull(),
  type: text("type").notNull(),
  status: text("status").notNull(),
  summary: text("summary").notNull(),
  content: jsonb("content").$type<JsonValue>().notNull(),
  confidence: doublePrecision("confidence").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string", precision: 3 }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.id] }),
  check("memories_type_check", sql`${t.type} in ('fact', 'event', 'decision', 'commitment', 'exception', 'issue', 'resolution', 'context')`),
  check("memories_status_check", sql`${t.status} in ('active', 'uncertain', 'conflicting', 'superseded', 'resolved')`),
  check("memories_confidence_check", sql`${t.confidence} >= 0 and ${t.confidence} <= 1`),
  index("memories_list_idx").on(t.tenantId, t.createdAt.desc(), t.id),
  index("memories_filter_idx").on(t.tenantId, t.type, t.status),
  index("memories_timeline_idx").on(t.tenantId, sql`coalesce(${t.occurredAt}, ${t.createdAt})`, t.id),
]);

export const memoryEntities = pgTable("memory_entities", {
  tenantId: text("tenant_id").notNull(),
  memoryId: text("memory_id").notNull(),
  entityId: text("entity_id").notNull(),
  role: text("role").notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.memoryId, t.entityId, t.role] }),
  foreignKey({ columns: [t.tenantId, t.memoryId], foreignColumns: [memories.tenantId, memories.id] }),
  foreignKey({ columns: [t.tenantId, t.entityId], foreignColumns: [entities.tenantId, entities.id] }),
  check("memory_entities_role_check", sql`${t.role} in ('subject', 'actor', 'recipient', 'organisation', 'affected')`),
  index("memory_entities_entity_idx").on(t.tenantId, t.entityId, t.memoryId),
]);

export const memorySources = pgTable("memory_sources", {
  tenantId: text("tenant_id").notNull(),
  memoryId: text("memory_id").notNull(),
  evidenceKey: text("evidence_key").notNull(),
  sourceId: text("source_id").notNull(),
  sourceVersionId: text("source_version_id").notNull(),
  locator: jsonb("locator").$type<JsonObject>(),
  quote: text("quote"),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.memoryId, t.evidenceKey] }),
  foreignKey({ columns: [t.tenantId, t.memoryId], foreignColumns: [memories.tenantId, memories.id] }),
  foreignKey({ columns: [t.tenantId, t.sourceId, t.sourceVersionId], foreignColumns: [sourceVersions.tenantId, sourceVersions.sourceId, sourceVersions.id] }),
  index("memory_sources_version_idx").on(t.tenantId, t.sourceVersionId),
  check("memory_sources_locator_object", sql`${t.locator} is null or jsonb_typeof(${t.locator}) = 'object'`),
]);

export const memoryEdges = pgTable("memory_edges", {
  tenantId: text("tenant_id").notNull(),
  fromMemoryId: text("from_memory_id").notNull(),
  toMemoryId: text("to_memory_id").notNull(),
  type: text("type").notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.fromMemoryId, t.toMemoryId, t.type] }),
  foreignKey({ columns: [t.tenantId, t.fromMemoryId], foreignColumns: [memories.tenantId, memories.id] }),
  foreignKey({ columns: [t.tenantId, t.toMemoryId], foreignColumns: [memories.tenantId, memories.id] }),
  check("memory_edges_type_check", sql`${t.type} in ('relates_to', 'caused_by', 'resolves', 'supersedes', 'contradicts', 'follows', 'supports')`),
  index("memory_edges_incoming_idx").on(t.tenantId, t.toMemoryId, t.type),
]);
