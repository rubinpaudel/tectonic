import { PassThrough } from "node:stream";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpServer, startHttpMcpServer, startStdioMcpServer } from "../src/index.js";
import { temporalState } from "../src/views.js";
import { abelId, FixtureRepository, newAddress, now, oldAddress } from "./fixture.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function connect(repository = new FixtureRepository()) {
  const server = createMcpServer({ repository, now: () => new Date(now) });
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => { await client.close(); await server.close(); });
  return { client, repository, server };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).not.toBe(true);
  return result.structuredContent as Record<string, unknown>;
}

type MemoryView = { id: string; type: string; status: string; temporal_state: string; summary: string;
  content: { value?: string }; valid_from: string | null; valid_until: string | null;
  evidence: Array<{ system: string; source_version_id: string; excerpt: string }>; relations: Array<{ memory_id: string; relationship: string }> };

describe("SDK discovery and semantic memory tools", () => {
  it("discovers exactly ten read-only tools through the actual MCP client", async () => {
    const { client, repository } = await connect();
    const discovery = await client.listTools();
    expect(discovery.tools.map((tool) => tool.name).sort()).toEqual([
      "get_entity", "get_entity_memory", "get_memory", "get_memory_evidence", "get_memory_timeline",
      "get_open_issues", "get_related_memories", "list_clients", "search_entities", "search_memory",
    ]);
    expect(discovery.tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false)).toBe(true);
    expect(repository.reads).toEqual([]);
    const clients = await call(client, "list_clients", { limit: 1 });
    expect(clients).toEqual({ items: [{ id: "nike", name: "Nike Belgium (synthetic)" }], next_offset: 1 });
  });

  it("resolves Abel, reports current address once, and preserves superseded history", async () => {
    const { client } = await connect();
    const entities = await call(client, "search_entities", { tenant: "nike", query: "Abel" });
    expect((entities.items as Array<{ id: string }>).map((e) => e.id)).toEqual([abelId]);
    const entity = await call(client, "get_entity", { tenant: "nike", entity_id: abelId });
    expect(entity.entity).toMatchObject({ id: abelId, name: "Abel" });
    const result = await call(client, "get_entity_memory", { tenant: "nike", entity_id: abelId });
    const memories = result.items as MemoryView[];
    const current = memories.find((item) => item.id === "new")!;
    const old = memories.find((item) => item.id === "old")!;
    expect(current).toMatchObject({ content: { value: newAddress }, temporal_state: "current", valid_from: "2026-09-20" });
    expect(old).toMatchObject({ content: { value: oldAddress }, status: "superseded", temporal_state: "historical", valid_until: "2026-09-20" });
    expect(result.current_fact_ids_in_page).toContain("new");
    expect(result.current_fact_ids_in_page).not.toContain("old");
    expect(current.relations).toContainEqual(expect.objectContaining({ memory_id: "old", relationship: "supersedes" }));
    expect(current.relations).toContainEqual(expect.objectContaining({ memory_id: "ack", relationship: "supports" }));
    expect(memories.find((m) => m.id === "commitment")?.type).toBe("commitment");
    expect(memories.find((m) => m.id === "update-issue")?.status).toBe("uncertain");
    expect(JSON.stringify(result)).not.toContain("FULL DOCUMENT MUST NEVER BE RETURNED");
  });

  it("returns chronological recent changes with Gmail/Teams provenance and distinct uncertainty", async () => {
    const { client, repository } = await connect();
    const result = await call(client, "get_memory_timeline", { tenant: "nike", entity_id: abelId, from: "2026-09-20", to: "2026-09-28" });
    const items = result.items as MemoryView[];
    expect(items.map((m) => m.id)).toEqual(["commute", "move", "new", "ack", "commitment", "discrepancy", "policy", "update-issue"]);
    expect(items.flatMap((m) => m.evidence.map((e) => e.system))).toEqual(expect.arrayContaining(["gmail", "teams", "sharepoint"]));
    const timelineRead = repository.reads.find((read) => read.method === "getTimeline");
    expect(timelineRead?.query).toMatchObject({ from: "2026-09-20T00:00:00.000Z", to: "2026-09-28T23:59:59.999Z" });
    const issues = await call(client, "get_open_issues", { tenant: "nike", entity_id: abelId });
    expect((issues.items as MemoryView[]).map((m) => m.id)).toEqual(["update-issue", "discrepancy"]);
    expect((issues.items as MemoryView[]).every((m) => m.status === "uncertain")).toBe(true);
  });

  it("resolves facts inside their historical validity intervals at a requested date", async () => {
    const { client } = await connect();
    const past = await call(client, "get_entity_memory", { tenant: "nike", entity_id: abelId, as_of: "2026-09-15" });
    const memories = past.items as MemoryView[];
    expect(memories.find((m) => m.id === "old")).toMatchObject({ status: "superseded", temporal_state: "current", content: { value: oldAddress } });
    expect(memories.find((m) => m.id === "new")).toMatchObject({ temporal_state: "scheduled" });
    expect(past.current_fact_ids_in_page).toContain("old");
    expect(past.current_fact_ids_in_page).not.toContain("new");
    const present = await call(client, "get_entity_memory", { tenant: "nike", entity_id: abelId, as_of: "2026-09-30" });
    expect(present.current_fact_ids_in_page).toContain("new");
    expect(present.current_fact_ids_in_page).not.toContain("old");
  });

  it("searches memory and traverses direct semantic relationships with paging", async () => {
    const { client } = await connect();
    const result = await call(client, "search_memory", { tenant: "nike", query: "address", entity_ids: [abelId], types: ["fact"], statuses: ["active"] });
    expect((result.items as MemoryView[]).map((m) => m.id)).toEqual(["new"]);
    const related = await call(client, "get_related_memories", { tenant: "nike", memory_id: "new", direction: "outgoing", edge_types: ["supersedes"] });
    expect(related.items).toEqual([expect.objectContaining({ relationship: "supersedes", from_memory_id: "new", to_memory_id: "old", memory: expect.objectContaining({ temporal_state: "historical" }) })]);
    const page = await call(client, "get_entity_memory", { tenant: "nike", entity_id: abelId, limit: 2 });
    expect(page.next_offset).toBe(2);
    const next = await call(client, "get_entity_memory", { tenant: "nike", entity_id: abelId, limit: 2, offset: 2 });
    expect((next.items as MemoryView[]).map((m) => m.id)).toEqual(["move", "new"]);
    const empty = await call(client, "search_memory", { tenant: "nike", types: [] });
    expect(empty.items).toEqual([]);
  });

  it("joins exact immutable source snapshots and only exposes bounded stored quotes", async () => {
    const { client, repository } = await connect();
    repository.evidence.find((link) => link.memoryId === "new")!.evidence.quote = "e".repeat(2_000);
    const result = await call(client, "get_memory_evidence", { tenant: "nike", memory_id: "new" });
    expect(result.items).toEqual([expect.objectContaining({ system: "gmail", source_id: "gmail", source_version_id: "gmail-v1",
      version: "sha256:v1", content_hash: "hash:gmail:v1", locator: { messageId: "message-new" }, excerpt: "e".repeat(500), excerpt_truncated: true })]);
    expect(JSON.stringify(result)).not.toContain("FULL DOCUMENT");
    repository.versions[0]!.id = "gmail-v2";
    expect((await client.callTool({ name: "get_memory_evidence", arguments: { tenant: "nike", memory_id: "new" } })).isError).toBe(true);
  });
});

describe("tenant and validation boundaries", () => {
  it.each(["get_memory", "get_memory_evidence", "get_related_memories"])("does not expose a foreign memory through %s", async (name) => {
    const { client } = await connect();
    const result = await client.callTool({ name, arguments: { tenant: "nike", memory_id: "private" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("keeps search scoped and rejects foreign entities", async () => {
    const { client, repository } = await connect();
    const result = await call(client, "search_memory", { tenant: "nike" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    const foreign = await client.callTool({ name: "get_entity_memory", arguments: { tenant: "nike", entity_id: "other:employee:private" } });
    expect(foreign.isError).toBe(true);
    expect(JSON.stringify(foreign)).not.toContain("PRIVATE");
    expect(repository.reads.filter((read) => read.method !== "listTenants").every((read) => (read.query as { tenantId: string }).tenantId === "nike")).toBe(true);
  });

  it("fails closed on cross-tenant results and incorrect source/version joins", async () => {
    const { client, repository } = await connect();
    vi.spyOn(repository, "searchMemories").mockResolvedValue({ items: [repository.memories.find((m) => m.id === "private")!], nextOffset: null });
    const result = await client.callTool({ name: "search_memory", arguments: { tenant: "nike" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    repository.versions[0]!.sourceId = "teams";
    const joined = await client.callTool({ name: "get_memory_evidence", arguments: { tenant: "nike", memory_id: "new" } });
    expect(joined.isError).toBe(true);
    repository.versions[0]!.sourceId = "gmail";
    repository.versions[0]!.tenantId = "other";
    vi.spyOn(repository, "getSourceVersion").mockResolvedValue(repository.versions[0]!);
    const leaked = await client.callTool({ name: "get_memory", arguments: { tenant: "nike", memory_id: "new" } });
    expect(leaked.isError).toBe(true);
    expect(JSON.stringify(leaked)).not.toContain("FULL DOCUMENT");
  });

  it.each([
    { tenant: "" }, { tenant: "nike", limit: 101 }, { tenant: "nike", offset: -1 },
    { tenant: "nike", limit: 1.5 }, { tenant: "nike", statuses: ["invented"] },
    { tenant: "nike", query: " " }, { tenant: "nike", as_of: "yesterday" },
    { tenant: "nike", raw_source_search: true }, { tenant_id: "nike" },
  ])("rejects invalid inputs before querying the repository: %j", async (args) => {
    const { client, repository } = await connect();
    const result = await client.callTool({ name: "search_memory", arguments: args });
    expect(result.isError).toBe(true);
    expect(repository.reads).toEqual([]);
  });

  it("rejects reversed timeline bounds and sanitizes backend errors", async () => {
    const { client, repository } = await connect();
    const reversed = await client.callTool({ name: "get_memory_timeline", arguments: { tenant: "nike", from: "2026-09-30", to: "2026-09-20" } });
    expect(reversed.isError).toBe(true);
    expect(repository.reads.some((read) => read.method === "getTimeline")).toBe(false);
    vi.spyOn(repository, "getMemory").mockRejectedValue(new Error("postgres://secret:password@localhost PRIVATE SQL"));
    const result = await client.callTool({ name: "get_memory", arguments: { tenant: "nike", memory_id: "new" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/secret|password|PRIVATE/);
  });

  it("labels future, expired, unknown and conflicting facts without asserting current state", async () => {
    const { repository } = await connect();
    const memory = repository.memories.find((m) => m.id === "new")!;
    expect(temporalState(memory, "2026-09-19T00:00:00Z")).toBe("scheduled");
    expect(temporalState({ ...memory, content: { validUntil: "2026-09-30" } }, now)).toBe("historical");
    expect(temporalState({ ...memory, content: { validFrom: "bad-date" } }, now)).toBe("unknown_validity");
    expect(temporalState({ ...memory, content: { validFrom: "2026-09-30", validUntil: "2026-09-20" } }, now)).toBe("unknown_validity");
    expect(temporalState({ ...memory, status: "conflicting" }, now)).toBe("conflicting");
    expect(temporalState({ ...memory, status: "uncertain" }, now)).toBe("uncertain");
  });
});

describe("local transports and lifecycle", () => {
  it("serves actual SDK HTTP initialization, discovery and memory reads, and closes once", async () => {
    const repository = new FixtureRepository(), onClose = vi.fn(async () => {});
    const running = await startHttpMcpServer({ repository, port: 0, now: () => new Date(now), onClose });
    cleanup.push(() => running.close());
    const client = new Client({ name: "http-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(running.url));
    // SDK v1's HTTP transport's sessionId accessor conflicts with exact optional types.
    await client.connect(transport as Transport);
    cleanup.push(() => client.close());
    expect((await client.listTools()).tools).toHaveLength(10);
    expect((await call(client, "get_memory", { tenant: "nike", memory_id: "new" })).memory).toMatchObject({ temporal_state: "current", content: { value: newAddress } });
    expect((await fetch(running.url)).status).toBe(405);
    expect((await fetch(running.url, { method: "POST", headers: { origin: "https://evil.example" } })).status).toBe(403);
    // Node's fetch controls Host itself; send the actual invalid header over HTTP.
    const invalidHostStatus = await new Promise<number>((resolve, reject) => {
      const req = request(running.url, { method: "POST", headers: { host: "evil.example" } }, (res) => {
        res.resume(); resolve(res.statusCode!);
      });
      req.once("error", reject); req.end();
    });
    expect(invalidHostStatus).toBe(403);
    expect((await fetch(running.url.replace("/mcp", "/gmail"))).status).toBe(404);
    await client.close();
    await Promise.all([running.close(), running.close()]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(running.server.listening).toBe(false);
  });

  it("uses newline-delimited SDK stdio without putting runtime logs on stdout", async () => {
    const stdin = new PassThrough(), stdout = new PassThrough(), onClose = vi.fn(async () => {});
    let output = "";
    stdout.on("data", (data: Buffer) => { output += data.toString(); });
    const running = await startStdioMcpServer({ repository: new FixtureRepository(), stdin, stdout, onClose });
    cleanup.push(() => running.close());
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "stdio-test", version: "1" } } }) + "\n");
    await vi.waitFor(() => expect(output).toContain('"id":1'));
    stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_memory", arguments: { tenant: "nike", memory_id: "new" } } }) + "\n");
    await vi.waitFor(() => expect(output).toContain(newAddress));
    const messages = output.trim().split("\n").map((line) => JSON.parse(line) as { jsonrpc: string });
    expect(messages).toHaveLength(2);
    expect(messages.every((message) => message.jsonrpc === "2.0")).toBe(true);
    await Promise.all([running.close(), running.close()]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
