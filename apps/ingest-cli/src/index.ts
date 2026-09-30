import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { MemoryRepository } from "@tunnelvision/core";
import { FileSourceIdentityStore, hashContent, ingestDirectory } from "@tunnelvision/ingestion";
import type { IngestionStats } from "@tunnelvision/ingestion";
import { DeterministicMemoryConsolidator } from "@tunnelvision/memory";

export interface CliArguments { tenantId: string; path: string }
export function parseArguments(args: string[]): CliArguments {
  let tenantId = "";
  let path = "";
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== "--tenant" && flag !== "--path") || !value || value.startsWith("--")) throw new Error("Usage: pnpm ingest --tenant nike --path ./mock-data/nike");
    if (flag === "--tenant") tenantId = value; else path = value;
    index++;
  }
  if (!tenantId || !path) throw new Error("Usage: pnpm ingest --tenant nike --path ./mock-data/nike");
  return { tenantId, path: resolve(path) };
}
export interface CliDatabase {
  createMemoryRepository(input: { connectionString: string }): MemoryRepository & { close(): Promise<void> };
  migrateDatabase(connectionString: string): Promise<void>;
}
export async function runIngestCli(args: string[], options: { database?: CliDatabase; env?: NodeJS.ProcessEnv; output?: (text: string) => void } = {}): Promise<IngestionStats> {
  const parsed = parseArguments(args);
  const env = options.env ?? process.env;
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  // A structural runtime boundary keeps this CLI buildable before the independent
  // DB adapter branch lands, without creating a competing database implementation.
  const database = options.database ?? await import("@tunnelvision/db") as unknown as CliDatabase;
  if (typeof database.createMemoryRepository !== "function") throw new Error("DB adapter must export createMemoryRepository({connectionString})");
  const repository = database.createMemoryRepository({ connectionString });
  try {
    const scope = hashContent(JSON.stringify([connectionString, parsed.path])).slice(0, 24);
    const stats = await ingestDirectory({ tenantId: parsed.tenantId, directory: parsed.path, repository, consolidator: new DeterministicMemoryConsolidator(),
      identityStore: new FileSourceIdentityStore(resolve("apps/ingest-cli/.state", `${scope}.json`)) });
    const output = options.output ?? console.log;
    output(JSON.stringify(stats, null, 2));
    return stats;
  } finally { await repository.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runIngestCli(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
