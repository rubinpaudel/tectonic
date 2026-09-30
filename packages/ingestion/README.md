# Deterministic POC ingestion

`ingestDirectory` (also exported as `ingestFilesystem`) accepts
`{tenantId, directory, repository, consolidator, extractor?, identityStore?}`.
The repository implements frozen `MemoryRepository`; the consolidator implements
frozen `MemoryConsolidator`. Use `DeterministicMemoryConsolidator` from
`@tunnelvision/memory` and, optionally, `DeterministicPocMemoryExtractor` from
this package. Ingestion returns source/entity/memory/conflict/issue statistics.

Only `gmail/{*.txt,*.eml}`, `sharepoint/{*.pdf,*.txt}`, and `teams/{*.json}` are
scanned recursively. Symlinks, hidden paths, README/manifest/expected-memory and
generator metadata are excluded. Stable source identity is tenant + system +
relative path; SHA-256 hashes the original bytes. PDF bytes are converted using
installed `pdftotext`, and normalized text is persisted as the immutable snapshot.
There are no extra npm dependencies. `pdftotext` must be available on PATH.

Dossiers use human-readable key:value labels: Employee ID, Entity ID, Name,
Email, Teams user ID, Employer, Address, Base salary, Bicycle compensation,
Bicycle commute one-way, Snapshot date. Emails have From/To/Date/Message-ID,
Employee-ID, address-change prose with ISO effective date and commute distances.
Teams exports contain `messages` with `id`, `createdDateTime`, `from`,
`employeeId`, and `body.content`. Policy text has Effective date and kilometre /
EUR band rows. Evidence preserves line/page ranges or JSON pointer/message ID
and an excerpt. Gmail locators also preserve Message-ID.

The synthetic extractor isolates all payroll-specific extraction and contextual
inference. Consolidation uses generic content fields: `kind`, `canonicalKey`,
`entityId`, `value`, `validFrom`/`validUntil`, `temporal`, `eventKey`,
`relatedCanonicalKeys`, `supportCanonicalKeys`, and `conflictFields`. Directed
`supersedes` edges point from new facts to historical facts. Ambiguous identities
remain uncertain with `needsReview` and unresolved alias details.

Completion is recorded in mutable Source metadata at
`tunnelvisionIngestion.completedHashes` only after all memories, links and
contextual inference succeed. Immutable snapshots are never processing receipts.
Partial failures are reprocessed and reconciled idempotently. Optional adapter
helpers `getSourceByIdentity({tenantId,system,externalId})` and
`findSourceVersionByHash({tenantId,sourceId,contentHash})` allow restart-safe
source discovery and reuse of exact snapshots. Without the identity helper,
provide a durable `FileSourceIdentityStore`; its file only caches source IDs.
Without either helper or durable identity cache, a new repository object safely
reprocesses existing sources rather than silently skipping unverified processing.
Do not run simultaneous ingestion for the same tenant in this local POC.

The CLI is `node apps/ingest-cli/dist/index.js --tenant nike --path ./mock-data/nike`
with `DATABASE_URL`. It dynamically composes the agreed DB factory and closes
the repository. It stores an identity cache under `apps/ingest-cli/.state/`,
scoped to a hash of DB connection and input directory. Run migrations separately.
No root dependency or lockfile additions are required.

Tests use deterministic in-memory repositories. To also verify the generated
fixture oracle, set `TUNNELVISION_FIXTURE_PATH` to a Nike mock-data directory
before `pnpm test`; the default is `mock-data/nike` when present. The oracle is
read solely by tests, never by ingestion/extraction.
