import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lint } from './lint-pitfalls.mjs';
const script = fileURLToPath(new URL('./lint-pitfalls.mjs', import.meta.url));
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'pitfall-lint-'));
  const c = { id: 'test-001', kind: 'file-content', target: 'target.txt', pattern: 'needle', expect: 'present' };
  const index = { schema_version: 1, checks: [c], records: [{ id: c.id, checkable: true }] };
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'target.txt'), 'needle');
  const run = () => { writeFileSync(join(root, 'data/pitfalls.index.json'), JSON.stringify(index)); return lint(root); };
  try { fn({ root, c, index, run }); } finally { rmSync(root, { recursive: true, force: true }); }
}
for (const [name, setup, code, reason] of [
  ['present matches', () => {}, 0, 'expectation-met'],
  ['missing literal', x => x.c.pattern = 'missing', 1, 'expectation-not-met'],
  ['absent violation', x => x.c.expect = 'absent', 1, 'expectation-not-met'],
  ['absent matches', x => { x.c.expect = 'absent'; x.c.pattern = 'missing'; }, 0, 'expectation-met'],
  ['missing file is unknown even for absent', x => { x.c.target = 'missing'; x.c.expect = 'absent'; }, 2, 'target-unreadable'],
  ['no command execution', x => x.c.kind = 'exit-code', 2, 'unsupported-kind'],
  ['empty pattern', x => x.c.pattern = '', 2, 'invalid-check'],
  ['invalid expectation', x => x.c.expect = 'maybe', 2, 'invalid-check'],
  ['traversal', x => x.c.target = '../outside', 2, 'invalid-target'],
  ['absolute path', x => x.c.target = '/etc/passwd', 2, 'invalid-target'],
  ['Windows path', x => x.c.target = 'C:\\outside', 2, 'invalid-target'],
  ['directory', x => x.c.target = 'data', 2, 'not-small-regular-file'],
  ['large target', x => writeFileSync(join(x.root, 'target.txt'), 'x'.repeat(2097153)), 2, 'not-small-regular-file'],
  ['unknown schema', x => x.index.schema_version = 2, 2, 'unreadable-or-invalid-index'],
  ['empty checks', x => x.index.checks = [], 2, 'unreadable-or-invalid-index'],
  ['duplicate checks', x => x.index.checks.push(x.c), 2, 'unreadable-or-invalid-index'],
  ['missing check', x => x.index.records.push({ id: 'test-002', checkable: true }), 2, 'unreadable-or-invalid-index'],
  ['orphan check', x => x.index.records = [], 2, 'unreadable-or-invalid-index'],
]) test(name, () => fixture(x => { setup(x); const r = x.run(); assert.equal(r.exit_code, code); assert.equal(r.results[0].reason, reason); }));
for (const [name, settings, code] of [
  ['permission matches', '{"permissions":{"deny":["needle"]}}', 0],
  ['escaped strings decoded', '{"permissions":{"ask":["n\\u0065edle"]}}', 0],
  ['unrelated strings ignored', '{"note":"needle","permissions":{}}', 1],
  ['broken JSON', '{', 2],
  ['missing permissions', '{}', 2],
  ['bad rule shape', '{"permissions":{"allow":"needle"}}', 2],
  ['bad rule element', '{"permissions":{"deny":[null]}}', 2],
]) test(name, () => fixture(x => { x.c.kind = 'settings-json'; writeFileSync(join(x.root, 'target.txt'), settings); assert.equal(x.run().exit_code, code); }));
test('symlink cannot escape root', () => fixture(x => {
  symlinkSync(tmpdir(), join(x.root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  x.c.target = 'outside';
  assert.equal(x.run().results[0].reason, 'outside-root');
}));
test('violation takes precedence but retains unknown', () => fixture(x => {
  x.c.pattern = 'missing';
  x.index.records.push({ id: 'test-002', checkable: true });
  x.index.checks.push({ ...x.c, id: 'test-002', kind: 'manual' });
  const r = x.run(); assert.equal(r.exit_code, 1); assert.deepEqual(r.counts, { pass: 0, violation: 1, unknown: 1 });
}));
test('CLI JSON, exit codes, and no target mutation', () => fixture(x => {
  for (const code of [0, 1, 2]) {
    x.c.pattern = code ? 'missing' : 'needle'; if (code === 2) x.c.target = 'missing'; x.run();
    const before = readFileSync(join(x.root, 'target.txt'));
    const r = spawnSync(process.execPath, [script, '--root', x.root, '--json'], { encoding: 'utf8' });
    assert.equal(r.status, code); assert.equal(JSON.parse(r.stdout).exit_code, code);
    assert.deepEqual(readFileSync(join(x.root, 'target.txt')), before);
  }
}));
test('CLI rejects missing root argument', () => assert.equal(spawnSync(process.execPath, [script, '--root']).status, 2));
test('repository checks pass with visible uncovered records', () => {
  const r = lint(); assert.equal(r.exit_code, 0); assert.equal(r.counts.pass, 11); assert.equal(r.uncheckable_records, 11);
});

for (const [name, bytes] of [
  ['malformed UTF-8', Buffer.from([0xff, 0x6e])],
  ['truncated UTF-8', Buffer.from([0xe3, 0x81])],
  ['UTF-16LE without BOM', Buffer.from('needle', 'utf16le')],
  ['UTF-16LE with BOM', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('needle', 'utf16le')])],
]) test(`${name} must not pass an absent check`, () => fixture(x => {
  x.c.expect = 'absent';
  writeFileSync(join(x.root, 'target.txt'), bytes);
  const r = x.run();
  assert.equal(r.exit_code, 2);
  assert.equal(r.results[0].reason, 'unsupported-text-encoding');
}));
test('UTF-8 BOM settings are parsed', () => fixture(x => {
  x.c.kind = 'settings-json';
  writeFileSync(join(x.root, 'target.txt'), '\ufeff{"permissions":{"deny":["needle"]}}');
  assert.equal(x.run().exit_code, 0);
}));
test('UTF-8 BOM index is parsed', () => fixture(x => {
  x.run();
  writeFileSync(join(x.root, 'data/pitfalls.index.json'), '\ufeff' + JSON.stringify(x.index));
  assert.equal(lint(x.root).exit_code, 0);
}));
test('invalid UTF-8 in otherwise valid JSON index is rejected', () => fixture(x => {
  x.c.pattern = '\ufffd'; x.c.expect = 'absent'; x.run();
  const bytes = Buffer.from(JSON.stringify(x.index).replace('\ufffd', 'PLACEHOLDER'));
  const offset = bytes.indexOf('PLACEHOLDER');
  writeFileSync(join(x.root, 'data/pitfalls.index.json'), Buffer.concat([bytes.subarray(0, offset), Buffer.from([0xff]), bytes.subarray(offset + 11)]));
  assert.equal(lint(x.root).exit_code, 2);
}));
test('valid non-ASCII literal remains checkable', () => fixture(x => {
  x.c.pattern = '落とし穴'; writeFileSync(join(x.root, 'target.txt'), '記録した落とし穴');
  assert.equal(x.run().exit_code, 0);
}));
