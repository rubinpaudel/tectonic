import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Memory, MemorySource } from "@tunnelvision/core";
import { contentObject, DeterministicMemoryConsolidator } from "../../memory/src/index.js";
import { InMemoryTestRepository } from "../../memory/tests/repository.js";
import { DeterministicPocMemoryExtractor, FileSourceIdentityStore, hashContent, ingestDirectory, InMemorySourceIdentityStore, JsonSourceParser, PdfSourceParser, scanFilesystemSources, TxtSourceParser } from "../src/index.js";

const oldAddress = "14 Lantern Lane, 1000 Brussels (synthetic)";
const newAddress = "82 Meadow Crescent, 3000 Leuven (synthetic)";
const dossier = `Employee ID: EMP-001\nEntity ID: nike:employee:abel\nName: Abel\nEmail: abel@nike.example\nTeams user ID: nike:teams:abel\nEmployer: Nike Belgium\nAddress: ${oldAddress}\nBase salary: EUR 1800 / month\nBicycle compensation: EUR 50 / month\nBicycle commute one-way: 5 km\nSnapshot date: 2026-09-01`;
const email = `From: Abel <abel@nike.example>\nTo: HR <hr@nike.example>\nDate: 2026-09-21T07:35:00Z\nMessage-ID: <move@nike.example>\nSubject: Home address change effective 2026-09-20\nEmployee-ID: EMP-001\n\nI moved on 2026-09-20. My previous address was ${oldAddress}.\nMy new address is ${newAddress}; please use it effective 2026-09-20.\nMy bicycle commute to work used to be about 5 km one-way. It is now approximately 15 km one-way, so about 10 km longer.`;
const policy = "Policy title: Nike synthetic bicycle mobility policy\nEffective date: 2026-09-01\n0-9.9 km | EUR 50 / month\n>=10 km | EUR 80 / month";
const messages = [
  { id: "ack", createdDateTime: "2026-09-22T08:40:00Z", employeeId: "EMP-001", from: { id: "nike:teams:hr", displayName: "HR", email: "hr@nike.example" }, body: { content: `Hi Abel, thanks for your email. I acknowledge your address change effective 2026-09-20. Your new address is ${newAddress}.` } },
  { id: "commitment", createdDateTime: "2026-09-22T08:43:00Z", employeeId: "EMP-001", from: { id: "nike:teams:hr", displayName: "HR", email: "hr@nike.example" }, body: { content: "I will update Abel's dossier and pass the address and bicycle-commute change to SD Worx." } },
  { id: "issue", createdDateTime: "2026-09-28T10:20:00Z", employeeId: "EMP-001", from: { id: "sdworx:teams:lea", displayName: "Lea" }, body: { content: `Abel's dossier still shows ${oldAddress} and bicycle compensation EUR 50 per month; the change appears not processed. The follow-up is open.` } },
  { id: "still-open", createdDateTime: "2026-09-28T11:05:00Z", employeeId: "EMP-001", from: { id: "nike:teams:hr", displayName: "HR" }, body: { content: "I have not yet found confirmation that Abel's update was carried through. The issue remains open." } },
  { id: "noise", createdDateTime: "2026-09-25T10:00:00Z", employeeId: "EMP-020", from: { id: "other" }, body: { content: "The scanner charging station has been moved beside the packing desk." } },
];
let directory: string;
let repository: InMemoryTestRepository;
let consolidator: DeterministicMemoryConsolidator;
async function file(path: string, text: string): Promise<void> { await mkdir(join(directory, path, ".."), { recursive: true }); await writeFile(join(directory, path), text); }
const options = () => ({ directory, tenantId: "nike", repository, consolidator, extractor: new DeterministicPocMemoryExtractor(() => "2026-09-30T10:00:00.000Z") });
const kinds = (kind: string): Memory[] => repository.memories.filter(memory => contentObject(memory.content).kind === kind);

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "tunnelvision-ingestion-test-")); repository = new InMemoryTestRepository(); consolidator = new DeterministicMemoryConsolidator(); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("filesystem ingestion", () => {
  it("scans only approved source subfolders and extensions, excluding metadata and symlinks", async () => {
    for (const [path, text] of [["gmail/mail.txt", email], ["sharepoint/dossier.txt", dossier], ["teams/export.json", JSON.stringify({ messages })], ["expected-memory.json", "{}"], ["README.md", "docs"], ["sharepoint/README.txt", "docs"], ["teams/expected-memory.json", "{}"], ["gmail/script.js", "code"], ["other/another.txt", "noise"], ["gmail/manifest.json", "{}"]]) await file(path!, text!);
    await symlink(join(directory, "expected-memory.json"), join(directory, "teams", "link.json"));
    expect((await scanFilesystemSources(directory)).map(source => source.relativePath)).toEqual(["sharepoint/dossier.txt", "gmail/mail.txt", "teams/export.json"]);
  });

  it("skips unchanged sources after a new repository wrapper and identity store", async () => {
    await file("sharepoint/dossier.txt", dossier);
    const first = await ingestDirectory(options());
    expect(first.sourcesChanged).toBe(1);
    expect(first.entitiesCreated).toBe(1);
    const freshRepository = new Proxy(repository, { get(target, property) { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; } });
    const second = await ingestDirectory({ ...options(), repository: freshRepository, identityStore: new InMemorySourceIdentityStore() });
    expect(second.sourcesSkipped).toBe(1);
    expect(second.sourcesChanged).toBe(0);
    expect(second.memoriesCreated).toBe(0);
    expect(repository.versions).toHaveLength(1);
    expect(repository.memories).toHaveLength(5);
  });

  it("keeps old snapshots immutable when file contents change", async () => {
    await file("sharepoint/dossier.txt", dossier);
    await ingestDirectory(options());
    const snapshot = structuredClone(repository.versions[0]!);
    await file("sharepoint/dossier.txt", dossier.replace("EUR 1800", "EUR 1900"));
    const changed = await ingestDirectory(options());
    expect(changed.sourcesChanged).toBe(1);
    expect(repository.versions).toHaveLength(2);
    expect(repository.versions[0]).toEqual(snapshot);
    expect(repository.versions[0]!.contentHash).toBe(hashContent(dossier));
    expect(kinds("base_salary").map(memory => memory.status)).toEqual(["conflicting", "conflicting"]);
    expect(changed.conflicts).toBe(1);
  });

  it("retries a partially persisted source instead of skipping, without duplicate memories", async () => {
    await file("sharepoint/dossier.txt", dossier);
    const link = repository.linkEvidence.bind(repository);
    let failed = false;
    repository.linkEvidence = async (input: MemorySource) => { if (!failed) { failed = true; throw new Error("simulated evidence failure"); } return link(input); };
    await expect(ingestDirectory(options())).rejects.toThrow("simulated evidence failure");
    expect(repository.versions).toHaveLength(1);
    expect(repository.memories).toHaveLength(1);
    const retry = await ingestDirectory({ ...options(), identityStore: new InMemorySourceIdentityStore() });
    expect(retry.sourcesSkipped).toBe(0);
    expect(retry.sourcesRetried).toBe(1);
    expect(repository.versions).toHaveLength(1);
    expect(repository.memories).toHaveLength(5);
    expect(repository.evidence).toHaveLength(5);
    expect((await ingestDirectory(options())).sourcesSkipped).toBe(1);
  });

  it("persists source identities atomically for adapters implementing only the frozen core", async () => {
    await file("sharepoint/dossier.txt", dossier);
    const coreOnly = new Proxy(repository, { get(target, property) { if (["getSourceByIdentity", "findSourceVersionByHash"].includes(String(property))) return undefined; const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; } });
    const journal = join(directory, "state", "identities.json");
    await ingestDirectory({ ...options(), repository: coreOnly, identityStore: new FileSourceIdentityStore(journal) });
    const next = await ingestDirectory({ ...options(), repository: coreOnly, identityStore: new FileSourceIdentityStore(journal) });
    expect(next.sourcesSkipped).toBe(1);
    expect(Object.values(JSON.parse(await readFile(journal, "utf8")) as object)).toHaveLength(1);
  });

  it("reconstructs a cross-system story and retains uncertainty and historical provenance", async () => {
    await file("sharepoint/dossier.txt", dossier);
    await file("sharepoint/policy.txt", policy);
    await file("gmail/mail.txt", email);
    await file("teams/hr.json", JSON.stringify({ tenantId: "nike", channel: "HR", messages }));
    const stats = await ingestDirectory(options());
    expect(stats.sourcesScanned).toBe(4);
    expect(stats.conflicts).toBe(0);
    expect(kinds("residence_change")).toHaveLength(1);
    const addresses = kinds("home_address");
    expect(addresses).toHaveLength(2);
    expect(addresses.find(memory => memory.status === "active")!.content).toMatchObject({ value: newAddress, validFrom: "2026-09-20T00:00:00.000Z" });
    expect(addresses.find(memory => memory.status === "superseded")!.content).toMatchObject({ value: oldAddress, validUntil: "2026-09-20T00:00:00.000Z" });
    expect(kinds("bicycle_commute").find(memory => memory.status === "active")!.content).toMatchObject({ value: 15 });
    expect(kinds("commute_increase")[0]!.content).toMatchObject({ value: 10 });
    const commitment = kinds("dossier_update_commitment")[0]!;
    const acknowledgment = kinds("hr_acknowledgment")[0]!;
    const issue = kinds("unprocessed_dossier_update")[0]!;
    const discrepancy = kinds("possible_compensation_discrepancy")[0]!;
    expect(commitment.status).toBe("active");
    expect(issue.status).toBe("uncertain");
    expect(discrepancy.status).toBe("uncertain");
    expect(contentObject(discrepancy.content)).toMatchObject({ value: 30, recordedAmount: 50, expectedAmount: 80 });
    expect(repository.edges).toContainEqual({ tenantId: "nike", fromMemoryId: issue.id, toMemoryId: commitment.id, type: "relates_to" });
    expect(repository.edges).toContainEqual({ tenantId: "nike", fromMemoryId: acknowledgment.id, toMemoryId: kinds("residence_change")[0]!.id, type: "supports" });
    expect(repository.edges).toContainEqual({ tenantId: "nike", fromMemoryId: discrepancy.id, toMemoryId: issue.id, type: "relates_to" });
    for (const [kind, value] of [["email", "abel@nike.example"], ["employee_id", "EMP-001"], ["teams_id", "nike:teams:abel"], ["name", "Abel"]]) expect((await repository.resolveEntityByAlias({ tenantId: "nike", kind: kind!, value: value! })).map(entity => entity.id)).toEqual(["nike:employee:abel"]);
    const recorded = kinds("bicycle_compensation")[0]!;
    expect((await repository.getMemorySources({ tenantId: "nike", memoryId: recorded.id })).some(source => source.evidence.locator?.messageId === "issue")).toBe(true);
    expect((await repository.getMemorySources({ tenantId: "nike", memoryId: issue.id })).filter(source => ["issue", "still-open"].includes(String(source.evidence.locator?.messageId)))).toHaveLength(2);
    expect(kinds("residence_change").every(memory => contentObject(memory.content).entityId === "nike:employee:abel")).toBe(true);
    const previous = addresses.find(memory => memory.status === "superseded")!;
    expect((await repository.getMemorySources({ tenantId: "nike", memoryId: previous.id })).some(source => source.evidence.locator?.messageId === "move@nike.example")).toBe(true);
    expect((await repository.getOpenIssues({ tenantId: "nike", entityId: "nike:employee:abel" })).items).toHaveLength(2);
    expect((await repository.getEntityMemories({ tenantId: "other", entityId: "nike:employee:abel" })).items).toHaveLength(0);
    const second = await ingestDirectory(options());
    expect(second.sourcesSkipped).toBe(4);
    expect(second.memoriesCreated).toBe(0);
  });

  it("an older dossier first arriving after the move cannot reset the current address", async () => {
    await file("gmail/mail.txt", email);
    await ingestDirectory(options());
    await file("sharepoint/dossier.txt", dossier);
    await file("sharepoint/policy.txt", policy);
    await ingestDirectory(options());
    expect(kinds("home_address").find(memory => memory.status === "active")!.content).toMatchObject({ value: newAddress });
    expect(kinds("home_address").find(memory => contentObject(memory.content).value === oldAddress)!.status).toBe("superseded");
    expect(kinds("possible_compensation_discrepancy")[0]!.content).toMatchObject({ value: 30 });
  });

  it("parsers preserve locators and quotes from persisted snapshots and enforce tenant/system relationships", async () => {
    await file("gmail/mail.txt", email);
    await ingestDirectory(options());
    const source = repository.sources[0]!;
    const version = repository.versions[0]!;
    const observations = await new TxtSourceParser().parse({ source, version });
    expect(observations[0]!.evidence[0]!.locator).toMatchObject({ lineStart: 1, messageId: "move@nike.example" });
    expect(observations[0]!.evidence[0]!.quote).toContain("My new address");
    await expect(new TxtSourceParser().parse({ source, version: { ...version, tenantId: "other" } })).rejects.toThrow("mismatch");
    await expect(new JsonSourceParser().parse({ source, version })).rejects.toThrow("mismatch");
    const pdfSource = { ...source, system: "sharepoint" as const };
    const pdf = await new PdfSourceParser().parse({ source: pdfSource, version: { ...version, content: `${dossier}\fsecond page` } });
    expect(pdf[0]!.evidence[0]!.locator).toEqual({ pageStart: 1, pageEnd: 2 });
  });
});

// The acceptance oracle is read only by this test. It never enters extraction.
const fixturePath = process.env.TUNNELVISION_FIXTURE_PATH ?? resolve("mock-data/nike");
const fixtureAvailable = await access(join(fixturePath, "expected-memory.json")).then(() => true, () => false);
it.skipIf(!fixtureAvailable)("accepts the actual generated Nike dataset and its semantic oracle", async () => {
  const oracle = JSON.parse(await readFile(join(fixturePath, "expected-memory.json"), "utf8")) as { dataset: { employeeCount: number; sourceCounts: { total: number } }; employees: Array<{ id: string }>; expectedMemories: Array<{ key: string; status: string; sources: Array<{ path: string; messageId?: string }> }> };
  const stats = await ingestDirectory({ ...options(), directory: fixturePath });
  expect(stats.sourcesScanned).toBe(oracle.dataset.sourceCounts.total);
  expect(repository.entities.filter(entity => entity.id.startsWith("nike:employee:"))).toHaveLength(oracle.dataset.employeeCount);
  for (const employee of oracle.employees) expect(repository.entities.some(entity => entity.id === employee.id)).toBe(true);
  expect(stats.conflicts).toBe(0);
  const mapping: Record<string, string> = { employer: "employment", "base-salary": "base_salary", "recorded-bicycle-compensation": "bicycle_compensation", "previous-address": "home_address", "previous-commute": "bicycle_commute", move: "residence_change", "current-address": "home_address", "commute-change": "commute_increase", "hr-acknowledgment": "hr_acknowledgment", "hr-commitment": "dossier_update_commitment", "unprocessed-update": "unprocessed_dossier_update", "mobility-policy": "mobility_policy", "supported-bicycle-compensation": "expected_bicycle_compensation", "potential-discrepancy": "possible_compensation_discrepancy" };
  for (const expected of oracle.expectedMemories) {
    const memory = repository.memories.find(item => contentObject(item.content).kind === mapping[expected.key] && (contentObject(item.content).entityId === "nike:employee:abel" || expected.key === "mobility-policy") && item.status === expected.status);
    expect(memory, expected.key).toBeDefined();
    if (!memory) continue;
    const evidence = await repository.getMemorySources({ tenantId: "nike", memoryId: memory.id });
    for (const source of expected.sources) expect(evidence.some(item => repository.sources.find(candidate => candidate.id === item.evidence.sourceId)?.externalId === source.path && (!source.messageId || item.evidence.locator?.messageId === source.messageId)), `${expected.key}: ${source.path}/${source.messageId ?? ""}`).toBe(true);
  }
  expect(kinds("residence_change")).toHaveLength(1);
  expect(kinds("home_address").find(memory => contentObject(memory.content).entityId === "nike:employee:abel" && memory.status === "active")!.content).toMatchObject({ value: newAddress });
  expect((await ingestDirectory({ ...options(), directory: fixturePath })).sourcesSkipped).toBe(80);
}, 60_000);
