# TunnelVision

Persistent organisational memory over unstructured enterprise data. TunnelVision
ingests source systems and exposes consolidated, evidence-backed memory to agents
through MCP. Gmail, SharePoint, and Teams remain the systems of record.

This repository currently contains only the workspace scaffold and shared
contracts. Database access, ingestion, extraction, consolidation, and MCP tools
are not implemented.

## Development

Use Node 22 (see `.nvmrc`) and pnpm 11.5.2.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`typecheck` builds the referenced TypeScript projects and checks the contract
tests. Generated output lives in each package's ignored `dist/` directory.

Shared contracts are exported from `@tunnelvision/core`. See [ARCHITECTURE.md](ARCHITECTURE.md)
for package responsibilities and contract conventions.

POC fixtures belong in `mock-data/nike/{gmail,sharepoint,teams}/`. These directories
are empty placeholders; `/mock-data/...` in the POC refers to this repository's
`mock-data/` directory.
