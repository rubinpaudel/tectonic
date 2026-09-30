# TunnelVision implementation coordination

All four implementation chats start from verified bootstrap commit
`8392269df94d75359520ebceb270ec60b5438955`. The bootstrap has 28 passing
contract tests and a passing strict typecheck on Node 22.

Integration branch: `rubin/tunnelvision-integration`.

| Agent | Worktree | Ownership | Status | Blockers | Verification |
| --- | --- | --- | --- | --- | --- |
| A — Mock data | `41d6/tectonic` | `mock-data/`, `scripts/mock-data/` | Running | None identified | Pending |
| B — Database | `6372/tectonic` | `packages/db/`, local Postgres configuration | Running | Docker startup resolved | Pending |
| C — Ingestion and memory | `98d8/tectonic` | `packages/ingestion/`, `packages/memory/`, `apps/ingest-cli/` | Running | None identified | Pending |
| D — MCP | `cd3a/tectonic` | `apps/mcp-server/` | Running | None identified | Pending |

Worktrees live beneath `/Users/rubinpaudel/.codex/worktrees/`. Implementation
chat IDs are A `01a0f3ef-4251-7ad0-80b0-2a8a6b08f025`,
B `01a0f3ef-5b28-7760-a421-0ce6831e4798`,
C `01a0f3ef-6f06-70d3-abe5-409ae56501ad`, and
D `01a0f3ef-84e8-7421-99fc-732addba46f2`.

## Shared decisions

Core contracts remain frozen. Flexible memory content carries semantic keys,
entity IDs, canonical keys, event keys, and temporal validity. The database and
MCP must not contain Nike-specific extraction rules.

The database adapter exports `createMemoryRepository({ connectionString })`,
`migrateDatabase(connectionString)`, and repository `close()`. Additional
concrete read methods support tenant/entity discovery without changing core:
`getTenant({tenantId})`, `listTenants({limit?,offset?})`,
`getEntity({tenantId,entityId})`, and
`searchEntities({tenantId,query?,limit?,offset?})`. Lists return
`{items,nextOffset}`.

Abel uses canonical ID `nike:employee:abel`, employee ID `EMP-001`, email
`abel@nike.example`, and Teams user ID `nike:teams:abel`. His synthetic move
is effective on 2026-09-20, reported by email on 2026-09-21, acknowledged by
HR on 2026-09-22, with an apparently unprocessed update reported on 2026-09-28.
The old address is `14 Lantern Lane, 1000 Brussels (synthetic)` and the new
address is `82 Meadow Crescent, 3000 Leuven (synthetic)`.

The old dossier contains EUR 1,800 base salary, EUR 50 monthly bicycle
compensation, and a 5 km commute. The new commute is 15 km. The separate
synthetic mobility policy supports EUR 80 for that distance, leaving a potential
EUR 30 discrepancy requiring confirmation.

Only approved files in `gmail/`, `sharepoint/`, and `teams/` are ingested.
`expected-memory.json` is exclusively an acceptance oracle.

## Integration acceptance

1. Review and merge all four branches, resolving root dependency changes centrally.
2. Run typecheck and deterministic tests before dispatching final integration.
3. Start local Postgres, migrate, and ingest the actual source fixtures.
4. Compare persisted semantic memory against the acceptance oracle.
5. Verify unchanged re-ingestion leaves source-version and memory counts stable.
6. Discover and invoke all MCP tools with the actual SDK client over HTTP.
7. Verify Abel's current address, historical address, move/HR timeline, open
   issues, related memories, and Gmail/Teams/SharePoint provenance.
8. Verify tenant isolation and confirm MCP calls do not trigger ingestion.
9. Leave the MCP server running locally and record live counts and endpoint.
10. Provide a demo under three minutes and external connection instructions.

No public tunnel or external credentials are configured automatically.
