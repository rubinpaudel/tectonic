import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { InMemoryTestRepository } from "../../../packages/memory/tests/repository.js";
import { parseArguments, runIngestCli } from "../src/index.js";

it("requires explicit tenant and path and rejects unknown options", () => {
  expect(parseArguments(["--tenant", "nike", "--path", "./mock-data/nike"]).tenantId).toBe("nike");
  expect(() => parseArguments(["--tenant", "nike"])).toThrow("Usage");
  expect(() => parseArguments(["--tenant", "nike", "--path", "x", "--unknown", "x"])).toThrow("Usage");
});
it("requires DATABASE_URL and closes the injected adapter", async () => {
  await expect(runIngestCli(["--tenant", "nike", "--path", "."], { env: {} })).rejects.toThrow("DATABASE_URL");
  const path = await mkdtemp(join(tmpdir(), "tunnelvision-cli-test-"));
  const repository = new InMemoryTestRepository();
  let closed = false;
  const output: string[] = [];
  try {
    await runIngestCli(["--tenant", "nike", "--path", path], { env: { DATABASE_URL: "postgres://test" }, output: text => output.push(text), database: { createMemoryRepository: () => Object.assign(repository, { close: async () => { closed = true; } }), migrateDatabase: async () => {} } });
    expect(closed).toBe(true);
    expect(JSON.parse(output[0]!)).toMatchObject({ sourcesScanned: 0, sourcesSkipped: 0 });
  } finally { await rm(path, { recursive: true, force: true }); }
});
