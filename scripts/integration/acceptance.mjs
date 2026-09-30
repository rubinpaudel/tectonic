import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const sdkRequire = createRequire(new URL('../../apps/mcp-server/package.json', import.meta.url));
const { Client } = await import(pathToFileURL(sdkRequire.resolve('@modelcontextprotocol/sdk/client/index.js')));
const { StreamableHTTPClientTransport } = await import(pathToFileURL(sdkRequire.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')));
const dbRequire = createRequire(new URL('../../packages/db/package.json', import.meta.url));
const { Pool } = dbRequire('pg');
const oracle = JSON.parse(await readFile(new URL('../../mock-data/nike/expected-memory.json', import.meta.url), 'utf8'));
const tenant = oracle.tenantId, entity_id = oracle.entity.id;
const connectionString = process.env.DATABASE_URL ?? 'postgresql://tunnelvision:tunnelvision@127.0.0.1:55432/tunnelvision';
const endpoint = process.env.MCP_URL ?? 'http://127.0.0.1:3001/mcp';
const client = new Client({ name: 'tunnelvision-acceptance', version: '1.0.0' });
const pool = new Pool({ connectionString });
const failures = [];
function check(condition, message) { if (!condition) failures.push(message); }
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  return result.structuredContent ?? JSON.parse(result.content.find((item) => item.type === 'text').text);
}
async function pages(name, args) {
  const items = []; let offset = 0;
  do { const page = await call(name, { ...args, limit: 100, offset }); items.push(...page.items); offset = page.next_offset; } while (offset !== null);
  return items;
}
async function counts() {
  const result = {};
  for (const table of ['sources', 'source_versions', 'entities', 'memories', 'memory_sources', 'memory_edges']) {
    result[table] = Number((await pool.query(`SELECT count(*) AS count FROM ${table} WHERE tenant_id = $1`, [tenant])).rows[0].count);
  }
  return result;
}
const kinds = { employer: 'employment', 'base-salary': 'base_salary', 'recorded-bicycle-compensation': 'bicycle_compensation', 'previous-address': 'home_address', 'previous-commute': 'bicycle_commute', move: 'residence_change', 'current-address': 'home_address', 'commute-change': 'commute_increase', 'hr-acknowledgment': 'hr_acknowledgment', 'hr-commitment': 'dossier_update_commitment', 'unprocessed-update': 'unprocessed_dossier_update', 'mobility-policy': 'mobility_policy', 'supported-bicycle-compensation': 'expected_bicycle_compensation', 'potential-discrepancy': 'possible_compensation_discrepancy' };
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
  const discovery = await client.listTools();
  const toolNames = ['list_clients', 'search_entities', 'get_entity', 'get_entity_memory', 'search_memory', 'get_memory', 'get_memory_timeline', 'get_related_memories', 'get_open_issues', 'get_memory_evidence'];
  assert.deepEqual(discovery.tools.map((tool) => tool.name).sort(), toolNames.sort());
  check(discovery.tools.every((tool) => tool.annotations?.readOnlyHint === true), 'All tools must be read-only');
  check((await pages('list_clients', {})).some((item) => item.id === tenant), 'Nike client discovery');
  const employees = await pages('search_entities', { tenant });
  check(employees.filter((item) => item.type === 'employee').length === oracle.dataset.employeeCount, 'Exactly 50 employees');
  for (const employee of oracle.employees) check(employees.some((item) => item.id === employee.id), `Employee ${employee.id}`);
  for (const alias of oracle.entity.aliases) check((await pages('search_entities', { tenant, query: alias.value })).some((item) => item.id === entity_id), `Abel alias ${alias.value}`);
  check((await call('get_entity', { tenant, entity_id })).entity.id === entity_id, 'Canonical Abel identity');
  const before = await counts();
  const memories = await pages('get_entity_memory', { tenant, entity_id, as_of: oracle.dataset.asOf });
  const found = new Map();
  for (const expected of oracle.expectedMemories) {
    const expectedValue = typeof expected.value === 'object' ? expected.value.amount ?? expected.value.distanceKm ?? expected.value.increaseKm ?? expected.value.potentialDifference : expected.value;
    const matches = memories.filter((memory) => memory.content?.kind === kinds[expected.key] && (['current-address', 'previous-address'].includes(expected.key) ? memory.content.value === expected.value : true));
    const memory = matches[0];
    check(Boolean(memory), `Semantic oracle: ${expected.key}`); if (!memory) continue;
    found.set(expected.key, memory);
    check((expected.acceptableTypes ?? [expected.type]).includes(memory.type), `Type: ${expected.key}`);
    check((expected.acceptableStatuses ?? [expected.status]).includes(memory.status), `Status: ${expected.key}`);
    if (typeof expectedValue === 'number') check(JSON.stringify(memory.content).includes(String(expectedValue)), `Value: ${expected.key}=${expectedValue}`);
    if (typeof expectedValue === 'string') check(JSON.stringify(memory.content).includes(expectedValue), `Value: ${expected.key}`);
    if (expected.validFrom) check(memory.valid_from?.slice(0, 10) === expected.validFrom, `Valid from: ${expected.key}`);
    if (expected.validUntil) check(memory.valid_until?.slice(0, 10) === expected.validUntil, `Valid until: ${expected.key}`);
    const evidence = await pages('get_memory_evidence', { tenant, memory_id: memory.id });
    check(evidence.length > 0 && evidence.every((item) => item.source_version_id && item.content_hash), `Immutable evidence: ${expected.key}`);
    for (const source of expected.sources) check(evidence.some((item) => item.system === source.system && JSON.stringify(item).includes(source.path)), `Oracle provenance: ${expected.key} ${source.path}`);
  }
  const address = found.get('current-address'), old = found.get('previous-address');
  check(address?.temporal_state === 'current' && old?.temporal_state === 'historical', 'Only new address is current; old remains historical');
  check(memories.filter((memory) => memory.content?.kind === 'home_address' && memory.temporal_state === 'current').length === 1, 'Exactly one current address');
  check(memories.filter((memory) => memory.content?.kind === 'residence_change').length === 1, 'One consolidated move event');
  const past = await pages('get_entity_memory', { tenant, entity_id, as_of: '2026-09-15' });
  check(past.find((memory) => memory.id === old?.id)?.temporal_state === 'current', 'Historical address was current before move');
  const timeline = await pages('get_memory_timeline', { tenant, entity_id, from: '2026-09-01', as_of: oracle.dataset.asOf });
  const dates = timeline.map((memory) => memory.occurred_at ?? memory.created_at);
  check(dates.every((date, index) => index === 0 || Date.parse(dates[index - 1]) <= Date.parse(date)), 'Chronological timeline');
  const issues = await pages('get_open_issues', { tenant, entity_id });
  for (const key of oracle.acceptance.openIssues) check(issues.some((item) => item.id === found.get(key)?.id), `Open issue: ${key}`);
  check(found.get('potential-discrepancy')?.status === 'uncertain', 'Compensation discrepancy remains uncertain');
  check(!JSON.stringify(found.get('potential-discrepancy')?.content).includes('"confirmedUnderpayment":true'), 'No proven underpayment');
  const systems = new Set(memories.flatMap((memory) => memory.evidence.map((item) => item.system)));
  check(['gmail', 'teams', 'sharepoint'].every((system) => systems.has(system)), 'All three source systems retain provenance');
  if (address) {
    check((await call('get_memory', { tenant, memory_id: address.id })).memory.id === address.id, 'Direct memory read');
    check((await pages('search_memory', { tenant, query: oracle.acceptance.currentAddress.value })).some((item) => item.id === address.id), 'Stored semantic memory search');
  }
  for (const relation of oracle.expectedRelations) {
    const from = found.get(relation.from), to = found.get(relation.to); if (!from || !to) continue;
    const related = await pages('get_related_memories', { tenant, memory_id: from.id, direction: 'outgoing' });
    check(related.some((item) => item.to_memory_id === to.id && item.relationship === relation.type), `Relation ${relation.from} ${relation.type} ${relation.to}`);
  }
  const foreign = await client.callTool({ name: 'get_entity_memory', arguments: { tenant: 'missing-tenant', entity_id } });
  check(foreign.isError === true, 'Foreign tenant rejected');
  assert.deepEqual(await counts(), before, 'MCP reads must not trigger ingestion or persistence writes');
  check(before.sources === oracle.dataset.sourceCounts.total, '80 actual source files persisted');
  const forbidden = await pool.query("SELECT uri FROM sources WHERE tenant_id=$1 AND (uri LIKE '%expected-memory%' OR uri LIKE '%manifest.json%' OR uri LIKE '%README%')", [tenant]);
  check(forbidden.rows.length === 0, 'Oracle, manifest and README never ingested');
  if (process.argv.includes('--reingest')) {
    const { createMemoryRepository } = await import('../../packages/db/dist/index.js');
    const { ingestDirectory } = await import('../../packages/ingestion/dist/index.js');
    const { DeterministicMemoryConsolidator } = await import('../../packages/memory/dist/index.js');
    for (let retry = 0; retry < 2; retry++) {
      const repository = createMemoryRepository({ connectionString });
      try { await ingestDirectory({ tenantId: tenant, path: `${root}mock-data/nike`, repository, consolidator: new DeterministicMemoryConsolidator() }); }
      finally { await repository.close(); }
      assert.deepEqual(await counts(), before, `Unchanged retry ${retry + 1} with fresh repository must be stable`);
    }
  }
  console.log(JSON.stringify({ endpoint, tools: discovery.tools.length, counts: before, abelMemories: memories.length, openIssues: issues.length, oracleAssertions: oracle.expectedMemories.length, idempotence: process.argv.includes('--reingest') ? 'two fresh repository retries passed' : 'not requested', failures }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally { await client.close(); await pool.end(); }
