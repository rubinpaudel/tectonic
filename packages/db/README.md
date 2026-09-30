# TunnelVision Postgres adapter

Generic organisational memory storage implementing the frozen
`@tunnelvision/core` `MemoryRepository` with Drizzle and node-postgres.
No client-specific fields, extraction rules, LLMs, or external services.

## Local database

From the repository root:

```sh
docker compose -p tunnelvision up -d --wait postgres
export DATABASE_URL=postgresql://tunnelvision:tunnelvision@127.0.0.1:55432/tunnelvision
pnpm --filter @tunnelvision/db build
pnpm --filter @tunnelvision/db migrate
```

The dedicated `postgres:17` service binds only `127.0.0.1:55432`, persists its
data in `tunnelvision_postgres_data`, and uses synthetic POC credentials.
It does not use the host's existing PostgreSQL service on port 5432.
Copying `.env.example` alone does not export variables to Node; apps should read
their environment or use their existing environment-file loader.

## Public API

```ts
import { createMemoryRepository, migrateDatabase } from "@tunnelvision/db";

await migrateDatabase(connectionString);
const repository = createMemoryRepository({ connectionString });
try {
  const page = await repository.searchMemories({ tenantId: "nike", limit: 50 });
  // Compose ingestion or MCP with the same repository instance.
} finally {
  await repository.close();
}
```

Exports:

- `PostgresMemoryRepository` and `createMemoryRepository({ connectionString })`:
  all frozen repository methods, plus `close(): Promise<void>`.
- `migrateDatabase(connectionString): Promise<void>`: transactional, idempotent
  migrations serialized by an advisory lock. Applied SQL hashes are checked;
  add a migration instead of editing an applied migration.
- `getTenant({ tenantId }): Promise<Tenant | null>`.
- `listTenants({ limit?, offset? } = {}): Promise<TenantPage>`.
- `getEntity({ tenantId, entityId }): Promise<Entity | null>`.
- `searchEntities({ tenantId, query?, limit?, offset? }): Promise<EntityPage>`:
  literal, case-insensitive substring search over IDs, names, metadata, aliases.
- `getSourceByIdentity({ tenantId, system, externalId }): Promise<Source | null>`:
  recover persisted metadata before upsert, including across CLI lifetimes.
- `findSourceVersionByHash({ tenantId, sourceId, contentHash })` and
  `getLatestSourceVersion({ tenantId, sourceId })`: immutable snapshot or `null`.
  Hash lookup lets ingestion skip unchanged source bytes without relying on
  source titles or paths. Ties use snapshot ID for deterministic ordering.
- `resetDatabase(connectionString, { confirm: true })`: test helper that
  truncates application tables while preserving migration history.
- `seedDatabase(connectionString, { tenants?, entities? })`: stable identity
  seeding helper. Create source versions/memories through the normal adapter.
- `schema`: Drizzle table definitions; public input/page types are also exported.

## Persistence semantics

Every entity/source/version/memory is tenant-scoped. Composite foreign keys
reject cross-tenant references even for direct SQL writes. Evidence has a
three-column foreign key to `(tenant_id, source_id, version_id)`, so a valid
version from the wrong source cannot be attached. IDs are opaque strings;
source/version/memory IDs are assigned once and preserved on retries.

Source identity is `(tenantId, system, externalId)`. Source headers may update;
source versions retain immutable content, metadata, hash, and modification time.
Identical version retries return the original snapshot. Reusing a version key
with changed snapshot data fails. A trigger also rejects direct SQL updates
and deletes of snapshots. The explicit test reset uses `TRUNCATE` to clear an
isolated test database. It must never target the demo database.

JSON object key order is ignored when comparing snapshots and deduplicating
evidence. Distinct locators/quotes are retained as separate evidence links.
Entity links are keyed by role, and edges by direction and relationship type.
Exact alias lookup returns all matches, including ambiguous aliases.

Memory content accepts any JSON value, including JSON `null`. Dates of validity,
canonical keys, and domain-specific fields stay in flexible content. Repository
timestamps are returned as UTC ISO strings with millisecond precision. The
immutable `sourceModifiedAt` preserves its supplied ISO text exactly, including
its timezone offset and fractional precision. Updating
a memory does not remove evidence or relations; supersession keeps history.

List defaults: limit 50, max 100, offset 0. Invalid values fail. Each query reads
one extra row to determine `nextOffset`; empty filters match no rows. Standard
lists use creation time descending, then ID ascending. Timeline bounds are
inclusive and order by `occurredAt ?? createdAt` ascending, then ID ascending.
Search is literal case-insensitive substring search across summary/content;
`%` and `_` in user input are not wildcard operators. Entity filters match any
linked entity without duplicating memories with multiple links/roles. Related
queries return one item per direct matching edge. Open issues have type `issue`
and status `active`, `uncertain`, or `conflicting`.

## Tests

Tests are deterministic and run against a dedicated database on the same local
server. Create it once, then opt in explicitly:

```sh
docker compose -p tunnelvision exec -T postgres \
  psql -U tunnelvision -d postgres -c 'CREATE DATABASE tunnelvision_db_test'
export TUNNELVISION_TEST_DATABASE_URL=postgresql://tunnelvision:tunnelvision@127.0.0.1:55432/tunnelvision_db_test
pnpm --filter @tunnelvision/db typecheck
pnpm --filter @tunnelvision/db test
```

Without `TUNNELVISION_TEST_DATABASE_URL`, the real Postgres suite is explicitly
skipped and the query/serialization contract unit tests still run. The real
suite covers migrations, concurrent immutable retries, direct SQL mutation
protection, cross-tenant and wrong-source references, alias ambiguity, JSON
round-trips, idempotence, paging/filter/search semantics, timeline boundaries,
direct relationship direction/paging, open issues, and historical provenance.

No root dependencies or lockfile updates are required: the bootstrap already
pins `drizzle-orm`, `pg`, `@types/pg`, TypeScript, and Vitest.
