# TunnelVision

Persistent organisational memory over fragmented Gmail, SharePoint, and Teams evidence. Deterministic ingestion resolves entities and consolidates facts, events, commitments, issues, history, and provenance in Postgres. Ten read-only MCP tools expose retained memory to downstream agents. No LLM provider or application API key is required.

## Run the local demo

Requirements: Node 22, pnpm 11.5.2, Docker, and `pdftotext` (Poppler).

```sh
pnpm install --frozen-lockfile
pnpm demo:up
```

The demo starts the dedicated Postgres 17 container, builds, migrates, ingests `mock-data/nike`, and leaves MCP running at `http://127.0.0.1:3001/mcp`. Keep this terminal open. Stop MCP with Ctrl-C; Postgres and persistent memory remain available. `MCP_PORT` selects another local port. `DATABASE_URL` overrides the synthetic default: `postgresql://tunnelvision:tunnelvision@127.0.0.1:55432/tunnelvision`.

For individual steps, build first, then use `pnpm db:up`, `pnpm db:migrate`, `pnpm ingest:nike`, and `pnpm mcp`. General ingestion: `pnpm ingest --tenant nike --path ./mock-data/nike`.

Only source files under `gmail/`, `sharepoint/`, and `teams/` are ingested. `expected-memory.json` is an acceptance oracle and must never be ingested. The fictional dataset has 50 employees and 80 source files. Source versions are immutable, tenant boundaries enforced, and unchanged ingestion skipped.

## Verify

```sh
pnpm typecheck
pnpm test
pnpm test:acceptance
pnpm test:acceptance --reingest
```

Acceptance requires the live HTTP server and ingested database. It checks the semantic oracle through all ten actual MCP tools, address history, relationships, immutable provenance, tenant boundaries, and read-only behavior. `--reingest` additionally retries unchanged ingestion twice with fresh repository instances and checks stable counts.

The database integration suite is opt-in and uses a separate test database:

```sh
export TUNNELVISION_TEST_DATABASE_URL=postgresql://tunnelvision:tunnelvision@127.0.0.1:55432/tunnelvision_db_test
pnpm test
```

See [database instructions](packages/db/README.md) to create that database. Its reset tests must never target the demo database.

See [DEMO.md](DEMO.md) for the three-minute presentation, [external client setup](docs/CHATGPT_MCP.md), [MCP schemas and stdio](apps/mcp-server/README.md), and [architecture](ARCHITECTURE.md).
