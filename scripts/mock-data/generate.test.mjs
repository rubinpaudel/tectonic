import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ABEL, buildFixture, dossierLines, employees, generate, HR_PATH, MOVE_PATH, POLICY_PATH, POLICY_LINES, teamsExports, textPdf } from './generate.mjs';

const fixtures = buildFixture();
const oracle = JSON.parse(fixtures.get('expected-memory.json').toString());
const sourceEntries = [...fixtures].filter(([path]) => /^(gmail|sharepoint|teams)\//.test(path));
const pdfTexts = new Map(employees().map(employee => [employee.dossierPath, dossierLines(employee).map(line => typeof line === 'string' ? line : line.text).join('\n')]));
pdfTexts.set(POLICY_PATH, POLICY_LINES.map(line => typeof line === 'string' ? line : line.text).join('\n'));

test('exactly 50 employees have unique stable identities and fictional contact details', () => {
  const roster = employees();
  assert.equal(roster.length, 50);
  for (const key of ['id', 'employeeId', 'email', 'teamsUserId', 'dossierPath']) assert.equal(new Set(roster.map(employee => employee[key])).size, 50);
  assert.deepEqual(roster[0], { ...roster[0], id: ABEL.id, employeeId: ABEL.employeeId, name: ABEL.name, email: ABEL.email, teamsUserId: ABEL.teamsUserId, address: ABEL.oldAddress, baseSalary: 1800, bicycleCompensation: 50, commute: 5 });
  for (const employee of roster) {
    assert.match(employee.email, /@nike\.example$/);
    assert.match(employee.address, /\(synthetic\)$/);
    assert.match(employee.employeeId, /^EMP-\d{3}$/);
    assert.equal(employee.snapshotDate, '2026-09-01');
  }
});

test('source directories contain only approved fixture formats and 80 source files', () => {
  const actual = { gmail: 0, sharepoint: 0, teams: 0, total: 0 };
  const extensions = { gmail: '.txt', sharepoint: '.pdf', teams: '.json' };
  for (const [path] of sourceEntries) {
    const system = path.split('/')[0];
    assert.ok(path.endsWith(extensions[system]));
    actual[system]++;
    actual.total++;
  }
  assert.deepEqual(actual, { gmail: 26, sharepoint: 51, teams: 3, total: 80 });
  assert.deepEqual(actual, oracle.dataset.sourceCounts);
  for (const path of ['expected-memory.json', 'manifest.json']) assert.ok(!sourceEntries.some(([sourcePath]) => sourcePath === path));
});

test('all source and metadata bytes regenerate deterministically', () => {
  const again = buildFixture();
  assert.deepEqual([...fixtures.keys()], [...again.keys()]);
  for (const [path, bytes] of fixtures) assert.ok(bytes.equals(again.get(path)), path);
  const pdf = fixtures.get(employees()[0].dossierPath).toString('ascii');
  assert.match(pdf, /^%PDF-1\.4\n/);
  assert.ok(!/CreationDate|ModDate/.test(pdf));
});

test('PDF byte offsets and stream length are valid, including escaped parentheses', () => {
  const bytes = textPdf({ title: 'Test document', subtitle: 'Fixture test', lines: ['Address: 1 Test Lane (synthetic)', 'Reference: path\\name'], reference: 'test' });
  const pdf = bytes.toString('ascii');
  const startxref = Number(pdf.match(/startxref\n(\d+)\n/)[1]);
  assert.equal(pdf.slice(startxref, startxref + 4), 'xref');
  const offsets = pdf.slice(startxref).split('\n').slice(3, 9).map(line => Number(line.slice(0, 10)));
  offsets.forEach((offset, index) => assert.ok(pdf.slice(offset).startsWith(`${index + 1} 0 obj\n`)));
  const content = pdf.match(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)endstream/);
  assert.equal(Number(content[1]), Buffer.byteLength(content[2]));
  assert.ok(pdf.includes('Test Lane \\(synthetic\\)'));
  assert.ok(pdf.includes('path\\\\name'));
  assert.throws(() => textPdf({ title: 'Long row', subtitle: 'Test', lines: ['x'.repeat(100)], reference: 'test' }), /layout budget/);
});

test('email exports expose identity, chronology and human prose without policy or later issue', () => {
  for (const [path, bytes] of sourceEntries.filter(([path]) => path.startsWith('gmail/'))) {
    const text = bytes.toString();
    for (const label of ['From', 'To', 'Date', 'Message-ID', 'Subject', 'Employee-ID']) assert.match(text, new RegExp(`^${label}: .+`, 'm'), path);
    assert.ok(text.includes('\n\nHi '));
  }
  const move = fixtures.get(MOVE_PATH).toString();
  for (const value of [ABEL.oldAddress, ABEL.newAddress, '2026-09-20', '5 km', '15 km', '10 km']) assert.ok(move.includes(value));
  assert.ok(!/EUR 1800|EUR 50|EUR 80|EUR 30|not processed|issue remains open/i.test(move));
});

test('Teams exports are well shaped, chronologically ordered and mixed with unrelated messages', () => {
  const knownEmployees = new Set(employees().map(employee => employee.employeeId));
  const ids = new Set();
  let count = 0;
  for (const [, channel] of teamsExports()) {
    assert.equal(channel.tenantId, 'nike');
    assert.ok(channel.channel.id && channel.channel.displayName);
    const times = channel.messages.map(message => message.createdDateTime);
    assert.deepEqual(times, [...times].sort());
    for (const message of channel.messages) {
      assert.ok(!ids.has(message.id)); ids.add(message.id); count++;
      assert.ok(Number.isFinite(Date.parse(message.createdDateTime)));
      assert.ok(message.from.id && message.from.displayName && message.from.email.endsWith('.example'));
      assert.ok(knownEmployees.has(message.employeeId));
      assert.equal(message.body.contentType, 'text');
      assert.ok(message.body.content.length > 20);
    }
  }
  assert.equal(count, 64);
  const hr = teamsExports().get(HR_PATH);
  const relevant = hr.messages.filter(message => message.id.includes('abel-'));
  assert.equal(relevant.length, 4);
  assert.equal(hr.messages.length - relevant.length, 24);
  assert.ok(hr.messages.findIndex(message => message.id.includes('ack-')) > 0);
  assert.ok(hr.messages.findIndex(message => message.id.includes('followup-')) < hr.messages.length - 1);
  assert.ok(relevant.every(message => message.employeeId === ABEL.employeeId && message.mentions[0].id === ABEL.teamsUserId));
});

test('no single source contains the complete Abel narrative', () => {
  const has = {
    baseSalary: text => /Base salary: EUR 1800/.test(text),
    oldAddress: text => text.includes(ABEL.oldAddress),
    newAddress: text => text.includes(ABEL.newAddress),
    commuteChange: text => /15 km/.test(text) && /10 km longer/.test(text),
    acknowledgment: text => /I acknowledge/.test(text),
    commitment: text => /I will update Abel/.test(text),
    unresolved: text => /appears not processed|issue remains open/.test(text),
    policy: text => text.includes('EUR 80 / month') && text.includes('>=10 km'),
  };
  const combined = sourceEntries.map(([path, bytes]) => pdfTexts.get(path) ?? bytes.toString()).join('\n');
  for (const [facet, matches] of Object.entries(has)) assert.ok(matches(combined), facet);
  for (const [path, bytes] of sourceEntries) {
    const text = pdfTexts.get(path) ?? bytes.toString();
    assert.ok(!Object.values(has).every(matches => matches(text)), path);
  }
  const dossier = pdfTexts.get(employees()[0].dossierPath);
  assert.ok(!dossier.includes(ABEL.newAddress));
  assert.ok(!dossier.includes('2026-09-20'));
  assert.ok(!pdfTexts.get(POLICY_PATH).includes('Abel'));
  const hrText = fixtures.get(HR_PATH).toString();
  assert.ok(!/EUR 80|EUR 1800|EUR 30|15 km|10 km longer/.test(hrText));
});

test('acceptance oracle preserves temporal supersession, separate commitment and uncertainty', () => {
  assert.equal(oracle.acceptanceOnly, true);
  assert.equal(oracle.mustNeverBeIngested, true);
  assert.equal(oracle.entity.id, ABEL.id);
  assert.equal(oracle.employees.length, 50);
  assert.equal(oracle.expectedMemories.length, 14);
  const byKey = new Map(oracle.expectedMemories.map(memory => [memory.key, memory]));
  assert.equal(byKey.get('previous-address').status, 'superseded');
  assert.equal(byKey.get('previous-address').validUntil, ABEL.moveEffectiveDate);
  assert.equal(byKey.get('current-address').value, ABEL.newAddress);
  assert.equal(byKey.get('current-address').validFrom, ABEL.moveEffectiveDate);
  assert.equal(byKey.get('hr-commitment').type, 'commitment');
  assert.equal(byKey.get('unprocessed-update').type, 'issue');
  assert.equal(byKey.get('unprocessed-update').status, 'uncertain');
  assert.equal(byKey.get('potential-discrepancy').value.potentialDifference, 80 - 50);
  assert.equal(byKey.get('potential-discrepancy').value.confirmedUnderpayment, false);
  assert.ok(oracle.expectedRelations.some(edge => edge.from === 'current-address' && edge.type === 'supersedes' && edge.to === 'previous-address'));
  for (const relation of oracle.expectedRelations) assert.ok(byKey.has(relation.from) && byKey.has(relation.to));
});

test('every expected memory references real source evidence and real message locators', () => {
  for (const memory of oracle.expectedMemories) {
    assert.ok(memory.sources.length > 0, memory.key);
    for (const evidence of memory.sources) {
      assert.ok(fixtures.has(evidence.path), evidence.path);
      assert.equal(evidence.path.split('/')[0], evidence.system);
      if (evidence.messageId) {
        if (evidence.system === 'teams') assert.ok(JSON.parse(fixtures.get(evidence.path)).messages.some(message => message.id === evidence.messageId));
        else assert.ok(fixtures.get(evidence.path).toString().includes(`<${evidence.messageId}>`));
      }
    }
  }
});

test('manifest enumerates only source files with matching content hashes', async () => {
  const { createHash } = await import('node:crypto');
  const manifest = JSON.parse(fixtures.get('manifest.json'));
  assert.equal(manifest.sourceFiles.length, 80);
  assert.equal(manifest.teamsMessageCount, 64);
  for (const source of manifest.sourceFiles) {
    assert.equal(source.bytes, fixtures.get(source.path).length);
    assert.equal(source.sha256, createHash('sha256').update(fixtures.get(source.path)).digest('hex'));
  }
});

test('generation is repeatable on disk and check mode is read only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tunnelvision-fixtures-'));
  try {
    await generate(directory);
    const first = await readFile(join(directory, MOVE_PATH));
    await generate(directory);
    assert.ok(first.equals(await readFile(join(directory, MOVE_PATH))));
    assert.deepEqual(await generate(directory, { check: true }), { generatedFiles: 82, sourceFiles: 80, employees: 50 });
    assert.equal((await readdir(join(directory, 'sharepoint'))).length, 51);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('committed/generated dataset matches the generator byte for byte', async () => {
  const root = fileURLToPath(new URL('../../mock-data/nike/', import.meta.url));
  await generate(root, { check: true });
  for (const [system, extension] of [['gmail', '.txt'], ['sharepoint', '.pdf'], ['teams', '.json']]) {
    const onDisk = (await readdir(join(root, system))).filter(path => path.endsWith(extension)).map(path => `${system}/${path}`).sort();
    const expected = sourceEntries.map(([path]) => path).filter(path => path.startsWith(`${system}/`)).sort();
    assert.deepEqual(onDisk, expected, `${system}: approved source inventory differs`);
  }
});
