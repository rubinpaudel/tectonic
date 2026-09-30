import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CandidateMemory, EvidenceRef, JsonObject, Memory, MemoryConsolidator, MemoryExtractor, MemoryRepository, Source, SourceSystem, SourceVersion } from "@tunnelvision/core";
import { DeterministicPocMemoryExtractor } from "./extractor.js";
import type { ContextExtractionInput } from "./extractor.js";
import { extractPdfText, JsonSourceParser, normalizeText, PdfSourceParser, TxtSourceParser } from "./parsers.js";

export interface FilesystemSource { path: string; relativePath: string; system: SourceSystem; externalId: string; extension: string }
export const hashContent = (content: Uint8Array | string): string => createHash("sha256").update(content).digest("hex");
export const sourceIdentity = (tenantId: string, source: Pick<FilesystemSource, "system" | "externalId">): string => JSON.stringify([tenantId, source.system, source.externalId]);
const extensions: Record<SourceSystem, Set<string>> = { gmail: new Set([".txt", ".eml"]), sharepoint: new Set([".pdf", ".txt"]), teams: new Set([".json"]) };
const excluded = /^(?:readme|expected-memory|generator|generation[-_.]metadata|manifest)(?:[._-]|$)/i;

/** Only approved source subdirectories, formats, and regular files are traversed. */
export async function scanFilesystemSources(directory: string): Promise<FilesystemSource[]> {
  const root = resolve(directory);
  const results: FilesystemSource[] = [];
  async function walk(path: string, system: SourceSystem): Promise<void> {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || excluded.test(entry.name) || entry.isSymbolicLink()) continue;
      const fullPath = join(path, entry.name);
      if (entry.isDirectory()) await walk(fullPath, system);
      else if (entry.isFile() && extensions[system].has(extname(entry.name).toLowerCase())) {
        const relativePath = relative(root, fullPath).split("\\").join("/");
        results.push({ path: fullPath, relativePath, system, externalId: relativePath, extension: extname(entry.name).toLowerCase() });
      }
    }
  }
  // Historical dossier and policy first is useful for inspection; reconciliation
  // also handles older evidence arriving after newer evidence on later runs.
  for (const system of ["sharepoint", "gmail", "teams"] as const) await walk(join(root, system), system);
  return results;
}

/** Only source IDs are cached here. Completion lives in mutable source metadata. */
export interface SourceIdentityStore {
  get(identity: string): Promise<string | undefined>;
  set(identity: string, sourceId: string): Promise<void>;
}
export class InMemorySourceIdentityStore implements SourceIdentityStore {
  private readonly ids = new Map<string, string>();
  async get(identity: string): Promise<string | undefined> { return this.ids.get(identity); }
  async set(identity: string, sourceId: string): Promise<void> { this.ids.set(identity, sourceId); }
}
export class FileSourceIdentityStore implements SourceIdentityStore {
  private ids: Record<string, string> | undefined;
  constructor(readonly path: string) {}
  private async read(): Promise<Record<string, string>> {
    if (!this.ids) {
      try {
        const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some(value => typeof value !== "string")) throw new Error("Invalid source identity journal");
        this.ids = parsed as Record<string, string>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.ids = {};
      }
    }
    return this.ids;
  }
  async get(identity: string): Promise<string | undefined> { return (await this.read())[identity]; }
  async set(identity: string, sourceId: string): Promise<void> {
    const ids = await this.read();
    ids[identity] = sourceId;
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(ids, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
const defaultStores = new WeakMap<MemoryRepository, SourceIdentityStore>();

export interface IngestionStats {
  sourcesScanned: number; sourcesChanged: number; sourcesSkipped: number; sourcesRetried: number;
  entitiesCreated: number; memoriesCreated: number; memoriesEnriched: number; memoriesSupported: number;
  memoriesSuperseded: number; conflicts: number; links: number; issues: number; unresolvedEntities: number;
}
interface InstrumentedConsolidator extends MemoryConsolidator { lastStats?: Partial<IngestionStats> }
interface ContextExtractor extends MemoryExtractor { extractContext?(input: ContextExtractionInput): Promise<CandidateMemory[]> }
interface SourceLookupHelpers {
  findSourceVersionByHash?(input: { tenantId: string; sourceId: string; contentHash: string }): Promise<SourceVersion | null>;
  getSourceByIdentity?(input: { tenantId: string; system: SourceSystem; externalId: string }): Promise<Source | null>;
}
export interface IngestDirectoryOptions {
  tenantId: string;
  directory?: string;
  /** Alias convenient for CLI/integration callers. */
  path?: string;
  tenantName?: string;
  repository: MemoryRepository;
  consolidator: InstrumentedConsolidator;
  extractor?: ContextExtractor;
  identityStore?: SourceIdentityStore;
  pdfTextExtractor?: (bytes: Uint8Array) => Promise<string>;
  onProgress?: (progress: { source: FilesystemSource; outcome: "processed" | "skipped" | "retried"; stats: IngestionStats }) => void;
}

const object = (value: unknown): JsonObject => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const completedHashes = (source: Source | null): string[] => {
  const hashes = object(source?.metadata.tunnelvisionIngestion).completedHashes;
  return Array.isArray(hashes) ? hashes.filter((hash): hash is string => typeof hash === "string") : [];
};
async function memoriesWithEvidence(repository: MemoryRepository, tenantId: string): Promise<ContextExtractionInput> {
  const memories: Memory[] = [];
  let offset = 0;
  while (true) {
    const page = await repository.searchMemories({ tenantId, limit: 100, offset });
    if (page.items.some(memory => memory.tenantId !== tenantId)) throw new Error("Repository leaked memory across tenants");
    memories.push(...page.items);
    if (page.nextOffset === null) break;
    if (page.nextOffset <= offset) throw new Error("Invalid repository pagination");
    offset = page.nextOffset;
  }
  const evidence = new Map<string, EvidenceRef[]>();
  for (const memory of memories) evidence.set(memory.id, (await repository.getMemorySources({ tenantId, memoryId: memory.id })).map(item => item.evidence));
  return { tenantId, memories, evidence };
}

/** Sequential source processing is intentional. Concurrent runs for one tenant
 * require adapter transaction/locking support and are outside this local POC. */
export async function ingestDirectory(options: IngestDirectoryOptions): Promise<IngestionStats> {
  const directory = options.directory ?? options.path;
  if (!directory) throw new Error("An ingestion directory is required");
  const { tenantId, repository, consolidator } = options;
  const helpers = repository as MemoryRepository & SourceLookupHelpers;
  const extractor = options.extractor ?? new DeterministicPocMemoryExtractor();
  let identityStore = options.identityStore ?? defaultStores.get(repository);
  if (!identityStore) { identityStore = new InMemorySourceIdentityStore(); defaultStores.set(repository, identityStore); }
  await repository.upsertTenant({ id: tenantId, name: options.tenantName ?? tenantId });
  const files = await scanFilesystemSources(directory);
  const stats: IngestionStats = { sourcesScanned: files.length, sourcesChanged: 0, sourcesSkipped: 0, sourcesRetried: 0, entitiesCreated: 0, memoriesCreated: 0, memoriesEnriched: 0, memoriesSupported: 0, memoriesSuperseded: 0, conflicts: 0, links: 0, issues: 0, unresolvedEntities: 0 };
  async function consolidate(candidates: CandidateMemory[]): Promise<void> {
    if (!candidates.length) return;
    const changed = await consolidator.consolidate({ tenantId, candidates, repository });
    if (consolidator.lastStats) {
      for (const key of ["entitiesCreated", "memoriesCreated", "memoriesEnriched", "memoriesSupported", "memoriesSuperseded", "conflicts", "links", "issues", "unresolvedEntities"] as const) stats[key] += consolidator.lastStats[key] ?? 0;
    } else stats.memoriesSupported += changed.length;
  }
  for (const file of files) {
    const bytes = await readFile(file.path);
    const hash = hashContent(bytes);
    const identity = sourceIdentity(tenantId, file);
    const cachedId = await identityStore.get(identity);
    let existing = cachedId ? await repository.getSource({ tenantId, sourceId: cachedId }) : null;
    if (!existing && helpers.getSourceByIdentity) existing = await helpers.getSourceByIdentity({ tenantId, system: file.system, externalId: file.externalId });
    if (existing && (existing.tenantId !== tenantId || existing.system !== file.system || existing.externalId !== file.externalId)) throw new Error("Source identity journal mismatch");
    const source = await repository.upsertSource({ tenantId, system: file.system, externalId: file.externalId, uri: pathToFileURL(file.path).href, title: file.relativePath, metadata: { ...existing?.metadata, relativePath: file.relativePath } });
    await identityStore.set(identity, source.id);
    const priorSnapshot = helpers.findSourceVersionByHash ? await helpers.findSourceVersionByHash({ tenantId, sourceId: source.id, contentHash: hash }) : null;
    if (completedHashes(existing).includes(hash) && (!helpers.findSourceVersionByHash || priorSnapshot)) {
      stats.sourcesSkipped++;
      options.onProgress?.({ source: file, outcome: "skipped", stats: { ...stats } });
      continue;
    }
    const text = priorSnapshot?.content ?? (file.extension === ".pdf" ? await (options.pdfTextExtractor ?? extractPdfText)(bytes) : normalizeText(bytes.toString("utf8")));
    const version = priorSnapshot ?? await repository.upsertSourceVersion({ tenantId, sourceId: source.id, version: hash, contentHash: hash,
      contentType: file.extension === ".pdf" ? "application/pdf" : file.extension === ".json" ? "application/json" : "text/plain", content: text,
      metadata: { relativePath: file.relativePath, snapshotFormat: file.extension === ".pdf" ? "normalized-pdf-text" : "normalized-text" }, sourceModifiedAt: null });
    stats.sourcesChanged++;
    if (priorSnapshot) stats.sourcesRetried++;
    const parser = file.extension === ".pdf" ? new PdfSourceParser(file.system) : file.extension === ".json" ? new JsonSourceParser(file.system) : new TxtSourceParser(file.system);
    const observations = await parser.parse({ source, version });
    observations.sort((a, b) => String(a.metadata.createdDateTime ?? a.metadata.date ?? "").localeCompare(String(b.metadata.createdDateTime ?? b.metadata.date ?? "")) || a.id.localeCompare(b.id));
    const candidates = await extractor.extract({ tenantId, observations });
    await consolidate(candidates);
    if (extractor.extractContext) await consolidate(await extractor.extractContext(await memoriesWithEvidence(repository, tenantId)));
    // Do not mutate immutable snapshots. A completion marker is written only
    // after every memory, evidence link, temporal relation, and inference succeeds.
    await repository.upsertSource({ tenantId, system: source.system, externalId: source.externalId, uri: source.uri, title: source.title,
      metadata: { ...source.metadata, tunnelvisionIngestion: { completedHashes: [...new Set([...completedHashes(existing), hash])] } } });
    options.onProgress?.({ source: file, outcome: priorSnapshot ? "retried" : "processed", stats: { ...stats } });
  }
  return stats;
}
export const ingestFilesystem = ingestDirectory;
