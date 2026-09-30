import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { memoryEdgeTypeSchema, memoryStatusSchema, memoryTypeSchema } from "@tunnelvision/core";
import { z } from "zod";
import type { MemoryReadRepository } from "./repository.js";
import { assertTenant, entityView, MemoryViews, ReadError } from "./views.js";

const identifier = z.string().trim().min(1).max(256).regex(/^[^\u0000-\u001f]+$/);
const tenant = { tenant: identifier.describe("Client/tenant ID, for example nike. Every read is scoped to this tenant.") };
const paging = {
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).max(1_000_000).default(0),
};
const filters = {
  types: z.array(memoryTypeSchema).max(8).optional(),
  statuses: z.array(memoryStatusSchema).max(5).optional(),
};
const dateTime = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);
const asOf = { as_of: dateTime.optional().describe("Reference time for validity labels; defaults to now. A superseded fact can be current inside its documented prior validity interval.") };
const entityId = { entity_id: identifier.describe("Canonical entity ID, for example nike:employee:abel.") };
const memoryId = { memory_id: identifier };
const query = z.string().trim().min(1).max(500).optional();
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export interface McpServerOptions {
  repository: MemoryReadRepository;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

function timestamp(value: string, endOfDay = false): string {
  return value.length === 10 ? value + (endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z") : value;
}

/** Creation has no side effects: only tool invocation calls repository reads. */
export function createMcpServer(options: McpServerOptions): McpServer {
  const repository = options.repository;
  const server = new McpServer({ name: "tunnelvision", version: "0.0.0" }, {
    instructions: "TunnelVision exposes persistent, provenance-backed organisational memory. First discover an entity, then read its semantic memory or chronological timeline. Current facts are explicitly labelled; superseded facts are historical except inside a documented prior validity interval at a requested as_of. Preserve uncertain/conflicting status and confidence. Evidence excerpts are bounded snapshots. These tools never ingest or search raw source systems.",
  });
  const view = (tenantId: string, referenceTime?: string) => new MemoryViews(repository, tenantId,
    referenceTime ? timestamp(referenceTime) : (options.now?.() ?? new Date()).toISOString());
  async function guarded(read: () => Promise<object>): Promise<CallToolResult> {
    try {
      const data = await read();
      const structuredContent = data as Record<string, unknown>;
      return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent };
    } catch (error) {
      try { options.onError?.(error); } catch { /* A logging callback cannot change the response boundary. */ }
      // Do not expose SQL errors, connection strings, or other tenants in failures.
      const message = error instanceof ReadError ? error.message : "Memory query failed. Check the local server and retry.";
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  }
  async function requireTenant(tenantId: string) {
    const client = await repository.getTenant({ tenantId });
    if (!client) throw new ReadError("Client not found.");
    if (client.id !== tenantId) throw new ReadError("Invalid client reference.");
    return client;
  }

  server.registerTool("list_clients", {
    description: "List available clients/tenants for memory discovery. Returns IDs and names only.",
    annotations, inputSchema: z.strictObject(paging),
  }, (args) => guarded(async () => {
    const page = await repository.listTenants(args);
    return { items: page.items.map((client) => ({ id: client.id, name: client.name.slice(0, 300) })), next_offset: page.nextOffset };
  }));

  server.registerTool("search_entities", {
    description: "Find canonical entities by name, stable ID, or alias in one client. Ambiguous results stay separate; no source-system search.",
    annotations, inputSchema: z.strictObject({ ...tenant, ...paging, query }),
  }, (args) => guarded(async () => {
    await requireTenant(args.tenant);
    const page = await repository.searchEntities({ tenantId: args.tenant, limit: args.limit, offset: args.offset,
      ...(args.query === undefined ? {} : { query: args.query }) });
    return { tenant: args.tenant, items: page.items.map((entity) => {
      assertTenant(entity, args.tenant); return entityView(entity);
    }), next_offset: page.nextOffset };
  }));

  server.registerTool("get_entity", {
    description: "Read a canonical entity's compact identity and metadata within its tenant.",
    annotations, inputSchema: z.strictObject({ ...tenant, ...entityId }),
  }, (args) => guarded(async () => ({ tenant: args.tenant, entity: entityView(await view(args.tenant).entity(args.entity_id)) })));

  server.registerTool("get_entity_memory", {
    description: "Read semantic facts, events, acknowledgments, commitments, context, and issues for an entity. Includes current/historical validity, relations, and cross-system evidence. Use the timeline's from/to filters for recent changes; page through all memories for complete history.",
    annotations, inputSchema: z.strictObject({ ...tenant, ...entityId, ...paging, ...filters, ...asOf }),
  }, (args) => guarded(async () => {
    const views = view(args.tenant, args.as_of);
    const entity = await views.entity(args.entity_id);
    const page = await repository.getEntityMemories({ tenantId: args.tenant, entityId: args.entity_id,
      limit: args.limit, offset: args.offset,
      ...(args.types === undefined ? {} : { types: args.types }),
      ...(args.statuses === undefined ? {} : { statuses: args.statuses }) });
    const result = await views.page(page);
    return { ...result, entity: entityView(entity), current_fact_ids_in_page: result.items
      .filter((memory) => memory.type === "fact" && memory.temporal_state === "current").map((memory) => memory.id),
      historical_memory_ids_in_page: result.items.filter((memory) => memory.temporal_state === "historical").map((memory) => memory.id) };
  }));

  server.registerTool("search_memory", {
    description: "Search persistent semantic memory summaries/content with optional entity/type/status filters. This does not retrieve raw Gmail, SharePoint, or Teams search results.",
    annotations, inputSchema: z.strictObject({ ...tenant, ...paging, ...filters, ...asOf, query,
      entity_ids: z.array(identifier).min(1).max(20).optional() }),
  }, (args) => guarded(async () => {
    await requireTenant(args.tenant);
    const views = view(args.tenant, args.as_of);
    if (args.entity_ids) await Promise.all(args.entity_ids.map((id) => views.entity(id)));
    return views.page(await repository.searchMemories({ tenantId: args.tenant, limit: args.limit, offset: args.offset,
      ...(args.query === undefined ? {} : { query: args.query }),
      ...(args.entity_ids === undefined ? {} : { entityIds: args.entity_ids }),
      ...(args.types === undefined ? {} : { types: args.types }),
      ...(args.statuses === undefined ? {} : { statuses: args.statuses }) }));
  }));

  server.registerTool("get_memory", {
    description: "Read one semantic memory with confidence, status, current/historical validity, involved entities, direct relations, and compact evidence.",
    annotations, inputSchema: z.strictObject({ ...tenant, ...memoryId, ...asOf }),
  }, (args) => guarded(async () => {
    const views = view(args.tenant, args.as_of);
    return { tenant: args.tenant, as_of: views.asOf, memory: await views.view(await views.memory(args.memory_id)) };
  }));

  server.registerTool("get_memory_timeline", {
    description: "Return a chronological semantic story ordered by occurred_at (created_at when unknown), with provenance. Filter from/to for recent changes; dates include the full UTC day. Historical facts remain labelled historical and unresolved issues remain uncertain.",
    annotations, inputSchema: z.strictObject({ ...tenant, ...paging, ...filters, ...asOf,
      entity_id: identifier.optional(), from: dateTime.optional(), to: dateTime.optional() }),
  }, (args) => guarded(async () => {
    await requireTenant(args.tenant);
    const views = view(args.tenant, args.as_of);
    if (args.entity_id) await views.entity(args.entity_id);
    const from = args.from ? timestamp(args.from) : undefined;
    const to = args.to ? timestamp(args.to, true) : undefined;
    if (from && to && Date.parse(from) > Date.parse(to)) throw new ReadError("from must be earlier than or equal to to.");
    return { ...await views.page(await repository.getTimeline({ tenantId: args.tenant, limit: args.limit, offset: args.offset,
      ...(args.entity_id === undefined ? {} : { entityId: args.entity_id }),
      ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }),
      ...(args.types === undefined ? {} : { types: args.types }),
      ...(args.statuses === undefined ? {} : { statuses: args.statuses }) })), order: "chronological" };
  }));

  server.registerTool("get_related_memories", {
    description: "Read direct semantic neighbours such as supersedes, supports, follows, contradicts, or resolves. Edges retain direction and tenant scope; no transitive graph dump.",
    annotations, inputSchema: z.strictObject({ ...tenant, ...memoryId, ...paging, ...asOf,
      edge_types: z.array(memoryEdgeTypeSchema).max(7).optional(),
      direction: z.enum(["incoming", "outgoing", "both"]).default("both") }),
  }, (args) => guarded(async () => {
    const views = view(args.tenant, args.as_of);
    await views.memory(args.memory_id);
    const page = await repository.getRelatedMemories({ tenantId: args.tenant, memoryId: args.memory_id,
      limit: args.limit, offset: args.offset, direction: args.direction,
      ...(args.edge_types === undefined ? {} : { edgeTypes: args.edge_types }) });
    const items = await Promise.all(page.items.map(async ({ memory, edge }) => {
      assertTenant(edge, args.tenant);
      const outgoing = edge.fromMemoryId === args.memory_id && edge.toMemoryId === memory.id;
      const incoming = edge.toMemoryId === args.memory_id && edge.fromMemoryId === memory.id;
      if (!outgoing && !incoming) throw new ReadError("Invalid related-memory reference.");
      return { relationship: edge.type, from_memory_id: edge.fromMemoryId, to_memory_id: edge.toMemoryId,
        direction: outgoing ? "outgoing" : "incoming", memory: await views.view(memory) };
    }));
    return { tenant: args.tenant, as_of: views.asOf, items, next_offset: page.nextOffset };
  }));

  server.registerTool("get_open_issues", {
    description: "Read unresolved issues for a client or entity. Only active, uncertain, or conflicting issues; potential discrepancies remain unconfirmed until resolution evidence exists.",
    annotations, inputSchema: z.strictObject({ ...tenant, ...paging, ...asOf, entity_id: identifier.optional() }),
  }, (args) => guarded(async () => {
    await requireTenant(args.tenant);
    const views = view(args.tenant, args.as_of);
    if (args.entity_id) await views.entity(args.entity_id);
    const page = await repository.getOpenIssues({ tenantId: args.tenant, limit: args.limit, offset: args.offset,
      ...(args.entity_id === undefined ? {} : { entityId: args.entity_id }) });
    if (page.items.some((memory) => memory.type !== "issue" || !["active", "uncertain", "conflicting"].includes(memory.status))) {
      throw new ReadError("Invalid open-issue result.");
    }
    return views.page(page);
  }));

  server.registerTool("get_memory_evidence", {
    description: "Inspect the exact immutable source versions supporting one memory: system, source URI/external ID, version/hash, locator, and at most 500 characters of stored evidence quote. Never returns a complete source document.",
    annotations, inputSchema: z.strictObject({ ...tenant, ...memoryId, ...paging }),
  }, (args) => guarded(async () => ({ tenant: args.tenant, memory_id: args.memory_id,
    ...await view(args.tenant).evidencePage(args.memory_id, args.limit, args.offset) })));

  return server;
}
