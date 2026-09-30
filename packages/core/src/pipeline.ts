import type {
  CandidateMemory,
  Memory,
  Observation,
  Source,
  SourceSystem,
  SourceVersion,
} from "./models.js";
import type { MemoryRepository } from "./repository.js";

export interface SourceParseInput {
  source: Source;
  version: SourceVersion;
}

export interface MemoryExtractionInput {
  tenantId: string;
  observations: Observation[];
}

export interface MemoryConsolidationInput {
  tenantId: string;
  candidates: CandidateMemory[];
  repository: MemoryRepository;
}

export interface SourceParser {
  readonly system: SourceSystem;
  /**
   * Parse an already-persisted text snapshot into evidence-backed observations.
   * Source and version must belong to the same tenant/source and parser system.
   */
  parse(input: SourceParseInput): Promise<Observation[]>;
}

export interface MemoryExtractor {
  /**
   * Produce candidates without persistence or entity resolution. Every input
   * and output belongs to tenantId; evidence refers to the input observations.
   */
  extract(input: MemoryExtractionInput): Promise<CandidateMemory[]>;
}

export interface MemoryConsolidator {
  /**
   * Resolve aliases and reconcile candidates with existing memory through the
   * repository. Persist memories, entity/evidence links, and semantic edges;
   * return the memories created or updated. All candidates belong to tenantId.
   */
  consolidate(input: MemoryConsolidationInput): Promise<Memory[]>;
}
