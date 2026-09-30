# TunnelVision MCP

Read-only access to **persistent semantic memory** in Postgres. Requests only
query the repository: they never scan files, ingest data, call an LLM, or search
Gmail, SharePoint, or Teams. Tenant IDs are mandatory on every memory/entity tool.
The implementation uses the official
[MCP TypeScript SDK v1](https://ts.sdk.modelcontextprotocol.io/) with Streamable
HTTP and optional stdio.

## Run locally

From the repository root, after the DB adapter, migrations, and ingestion have
been integrated:

```sh
pnpm --filter @tunnelvision/mcp-server build
DATABASE_URL='postgres://USER:PASSWORD@127.0.0.1:5432/tunnelvision' \
  pnpm --filter @tunnelvision/mcp-server start
```

Endpoint: `http://127.0.0.1:3001/mcp`. `MCP_PORT` changes the port. The listener
always binds to `127.0.0.1`. It accepts stateless MCP POST requests with JSON
responses; GET/DELETE return 405. The SDK handles initialize, notifications,
discovery, validation, and tool invocation. Host and Origin checks reject
non-local browser requests. No authentication, public tunnel, or external service
is configured. SIGINT/SIGTERM close transports, the listener, and the repository.

For process-spawned desktop clients, build first and configure the executable
directly so package-manager output cannot interfere with the protocol:

```json
{
  "mcpServers": {
    "tunnelvision": {
      "command": "/opt/homebrew/opt/node@22/bin/node",
      "args": ["/ABSOLUTE/REPOSITORY/apps/mcp-server/dist/main.js", "--stdio"],
      "env": {
        "DATABASE_URL": "postgres://USER:PASSWORD@127.0.0.1:5432/tunnelvision"
      }
    }
  }
}
```

Replace the repository path and local database credentials. Stdio stdout contains
only MCP protocol messages; startup/error notices use stderr. End of stdin also
closes the repository. The application starts no migrations or ingestion itself.

## Tools

Use `tenant="nike"` consistently; `tenant_id` is deliberately not an alias.
Entity/memory IDs are opaque canonical IDs, never inferred from tenant prefixes.
Lists take `limit` (default 50, maximum 100) and `offset` (default 0).
Unknown parameters, empty IDs/queries, invalid enums, and invalid paging fail.

| Tool | Parameters beyond paging | Result |
| --- | --- | --- |
| `list_clients` | none | Client IDs and names |
| `search_entities` | `tenant`, optional `query` | Separate canonical matches including aliases |
| `get_entity` | `tenant`, `entity_id` | Compact identity and metadata |
| `get_entity_memory` | `tenant`, `entity_id`, optional `types`, `statuses`, `as_of` | Semantic memories with current/historical labels |
| `search_memory` | `tenant`, optional `query`, `entity_ids`, `types`, `statuses`, `as_of` | Lexical search across stored memory summary/content |
| `get_memory` | `tenant`, `memory_id`, optional `as_of` | One memory plus entities, relations, evidence |
| `get_memory_timeline` | `tenant`, optional `entity_id`, `from`, `to`, `types`, `statuses`, `as_of` | Chronological memory, event time then creation-time fallback |
| `get_related_memories` | `tenant`, `memory_id`, optional `edge_types`, `direction`, `as_of` | Direct semantic neighbours with directed edges |
| `get_open_issues` | `tenant`, optional `entity_id`, `as_of` | Active/uncertain/conflicting issues only |
| `get_memory_evidence` | `tenant`, `memory_id` | Exact immutable version references and short stored quotes |

`get_entity` and `get_memory` do not take paging. Date bounds and `as_of` accept
timezone-qualified ISO datetimes or ISO dates. Date timeline bounds include the
whole UTC day; date-only `as_of` means UTC midnight. `validUntil` is exclusive.
`as_of` labels business validity using currently persisted history; it does not
reconstruct what the system knew at ingestion time. An active fact within its
validity interval is `current`. A superseded fact is historical unless both bounds
document a prior interval containing `as_of`. A future fact is `scheduled`.
Uncertain/conflicting memories retain that label rather than becoming current.

Suggested primary demo:

```json
{"name":"search_entities","arguments":{"tenant":"nike","query":"Abel"}}
{"name":"get_entity_memory","arguments":{"tenant":"nike","entity_id":"nike:employee:abel"}}
{"name":"get_memory_timeline","arguments":{"tenant":"nike","entity_id":"nike:employee:abel","from":"2026-09-20"}}
{"name":"get_open_issues","arguments":{"tenant":"nike","entity_id":"nike:employee:abel"}}
```

Read the active address fact with its effective date and evidence; its outgoing
`supersedes` edge retains the prior address. HR's acknowledgment event and update
commitment are distinct from an uncertain unresolved issue. The server contains
no Nike-specific extraction, compensation rules, or expected-memory oracle.

## Responses and evidence

Each successful tool returns `structuredContent` and identical JSON in a text
content block for clients without structured-content support. Lists use `items`
and `next_offset` (`null` when exhausted). Memory responses contain:

- `id`, `type`, `summary`, structured `content`, `status`, `confidence`
- `occurred_at`, timestamps, `valid_from`, `valid_until`, `temporal_state`
- involved `entities`, direct `relations`, joined immutable `evidence`

Memory lists include `tenant` and `as_of`. Entity-memory lists additionally expose
`current_fact_ids_in_page` and `historical_memory_ids_in_page`; these describe only
the returned page, so use `next_offset` to continue. Memory status stays unchanged
even when a historical `as_of` marks a superseded fact current for its old interval.

Evidence joins check tenant, source ID, and exact version ID/source relationship.
References contain system, URI, external ID, version/hash, timestamps, locator,
and a maximum 500-character evidence quote; the source snapshot's full `content`
is never returned. A missing quote yields `null`, not an arbitrary document
excerpt. Memory responses show at most five evidence links, ten direct relations,
and twenty involved entities, with continuation/truncation markers. Dedicated
evidence/relationship tools offer paging. Semantic JSON and metadata have a
bounded compact representation with `content_truncated`/`metadata_truncated`.
Invalid joins fail the whole tool call; database errors are sanitized.

## Integration API and tests

Exports from `@tunnelvision/mcp-server`:

- `createMcpServer({ repository, now?, onError? })` → SDK `McpServer`; caller attaches a transport.
- `startHttpMcpServer({ repository, port?, now?, onError?, onClose? })` → `{ server, url, close() }`.
- `startStdioMcpServer({ repository, stdin?, stdout?, now?, onError?, onClose? })` → `{ server, close() }`.
- `connectMemoryRepository(connectionString)` → agreed DB factory result.
- `MemoryReadRepository`, `ClosableMemoryReadRepository`, and option/runtime types.

Injected repositories are caller-owned. `onClose` is an optional once-only
cleanup hook; the CLI supplies `repository.close`. Port `0` is supported for
temporary integration-test listeners. `now` makes validity testing deterministic.
The DB composition expects `createMemoryRepository({ connectionString })` and
`close()`, core read methods, plus the agreed discovery reads `getTenant`,
`listTenants`, `getEntity`, and `searchEntities`.

```sh
pnpm --filter @tunnelvision/mcp-server typecheck
pnpm --filter @tunnelvision/mcp-server test
```

Tests use an injected read-only fixture repository and actual SDK clients over
in-memory and loopback HTTP transports, plus SDK newline-delimited stdio. They
cover tool discovery/invocation, temporal address history (including a past
`as_of`), uncertainty, tenant boundaries, source/version joins, compact excerpts,
input validation, pagination, error sanitization, and idempotent cleanup. The HTTP
test needs permission to bind a loopback port. There are no new dependencies
beyond the frozen bootstrap packages and no root manifest/lockfile changes.
