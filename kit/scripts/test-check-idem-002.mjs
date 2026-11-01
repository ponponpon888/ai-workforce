#!/usr/bin/env node
/**
 * Test the idem-002 external checker through its normal command line, against
 * the fixtures in kit/scripts/fixtures/idem-002. No fixture is imported or
 * executed: the checker reads them as text, and so does this suite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
const cli = join(scripts, 'check-idem-002.mjs');
const fixtures = join(scripts, 'fixtures', 'idem-002');

// node:test runs the cases after this file finishes executing, so every
// temporary tree is built here and removed on exit. Building one inside a case
// would race a cleanup that has already happened.
const temporary = mkdtempSync(join(tmpdir(), 'aiwf-idem-002-'));
process.on('exit', () => rmSync(temporary, { recursive: true, force: true }));

const oversized = `// ${'x'.repeat(1024 * 1024 + 32)}\n`;
const unreadableRoot = mkdtempSync(join(temporary, 'unread-'));
writeFileSync(join(unreadableRoot, 'huge.js'), oversized);
const mixedRoot = mkdtempSync(join(temporary, 'mixed-'));
copyFileSync(join(fixtures, 'original-case', 'webhook.js'), join(mixedRoot, 'webhook.js'));
writeFileSync(join(mixedRoot, 'huge.js'), oversized);

// The caller of cross-file-case, with the import line swapped and the receiver
// placed by each test, so these trees differ only in what the import reaches.
const crossFileCaller = readFileSync(join(fixtures, 'cross-file-case', 'src', 'app', 'inbound', 'route.js'), 'utf8');
const crossFileReceiver = readFileSync(join(fixtures, 'cross-file-case', 'src', 'core', 'turns', 'events.js'), 'utf8');

function crossFileTree(specifier, receivers = {}) {
  const root = mkdtempSync(join(temporary, 'cross-'));
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write('app/src/app/inbound/route.js', crossFileCaller.replace("'@/core/turns/events'", `'${specifier}'`));
  for (const [path, text] of Object.entries(receivers)) write(path, text);
  return join(root, 'app');
}

const typescriptReceiver = crossFileTree('@/core/turns/events', { 'app/src/core/turns/events.ts': crossFileReceiver });
const outsideReceiver = crossFileTree('../../../../outside', { 'outside.js': crossFileReceiver });
const ambiguousReceiver = crossFileTree('@/core/turns/events', {
  'app/src/core/turns/events.js': crossFileReceiver,
  'app/core/turns/events.js': crossFileReceiver,
});
const packageReceiver = crossFileTree('some-package');
const unnamedParameter = crossFileTree('./receiver', {
  'app/src/app/inbound/receiver.js': 'export async function openTurn(options) { return options; }\n',
});
const renamedReceiver = crossFileTree('./receiver', {
  'app/src/app/inbound/receiver.js': [
    'export const openTurn = async ({ sourceKey: key = null }) => {',
    '  return save({ idempotency_key: key });',
    '};',
    '',
  ].join('\n'),
});

function run(root, { json = true, extra = [] } = {}) {
  const args = [cli];
  if (root !== null) args.push('--root', root);
  if (json) args.push('--json');
  args.push(...extra);
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 20000 });
  return { ...result, parsed: json && result.stdout.trim() ? JSON.parse(result.stdout) : null };
}

/** 1-based line of the first line containing `needle`, the way the CLI counts. */
function lineContaining(path, needle) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const index = lines.findIndex(line => line.includes(needle));
  assert.notEqual(index, -1, `fixture no longer contains ${needle}`);
  return index + 1;
}

test('the original case is reported, with the value it picks first', () => {
  const root = join(fixtures, 'original-case');
  const file = join(root, 'webhook.js');
  const result = run(root);
  assert.equal(result.status, 1);
  assert.equal(result.parsed.status, 'findings');
  assert.equal(result.parsed.scanned, 1);
  assert.equal(result.parsed.findings.length, 1);

  const finding = result.parsed.findings[0];
  assert.equal(finding.pitfall, 'idem-002');
  assert.equal(finding.file, 'webhook.js');
  assert.equal(finding.selectsFirst, 'incomingLog?.id');
  assert.equal(finding.selectsLater, 'event.message.id');
  assert.equal(finding.key, 'conversationSourceKey');
  assert.equal(finding.rowIdFrom, 'incomingLog');
  assert.equal(finding.line, lineContaining(file, 'const conversationSourceKey ='));
  assert.equal(finding.insertLine, lineContaining(file, 'const { data: incomingLog }'));
  assert.equal(finding.sinkLine, lineContaining(file, 'idempotency_key: conversationSourceKey'));
  assert.equal(finding.functionLine, lineContaining(file, 'export async function handleLineWebhook'));
});

test('the diagnostic separates what was read from what redelivery would need', () => {
  const root = join(fixtures, 'original-case');
  const human = run(root, { json: false });
  assert.equal(human.status, 1);
  const line = lineContaining(join(root, 'webhook.js'), 'const conversationSourceKey =');
  assert.match(human.stdout, new RegExp(`idem-002\\s+webhook\\.js:${line}`));
  assert.match(human.stdout, /selects first: incomingLog\?\.id/);
  assert.match(human.stdout, /selects later: event\.message\.id/);
  assert.match(human.stdout, /Confirmed by reading the file/);
  assert.match(human.stdout, /Not established here\. A duplicate on redelivery also needs all of:/);
  assert.match(human.stdout, /unique constraint over this key/);
});

// Each of these has the column, the chain, or both. None of them is the
// defect, and a checker that flagged them would be unusable on a real tree.
for (const [name, why] of [
  ['reversed-order', 'the delivery identifier is selected first'],
  ['explicit-id', 'the inserted row carries a caller-chosen id'],
  ['upsert', 'an upsert can return an id that already existed'],
  ['key-unused', 'the value never reaches an idempotency key'],
  ['comment-and-string', 'the statement only exists in a comment and a string'],
  ['cross-function', 'the insert and the key are in different functions'],
  ['shadowed-key', 'an inner block rebinds the key name to the delivery identifier'],
  ['spread-payload', 'the payload is spread, so "no id in it" cannot be claimed'],
]) {
  test(`no finding when ${why} (${name})`, () => {
    const result = run(join(fixtures, name));
    assert.equal(result.status, 0, `${name} should exit 0, printed: ${result.stdout}${result.stderr}`);
    assert.equal(result.parsed.status, 'no-findings');
    assert.equal(result.parsed.findings.length, 0);
    assert.equal(result.parsed.scanned, 1);
  });
}

// Reviewed 2026-11-01: the braces, slashes and quotes inside a regex literal
// were read as structure, which ended the function body early and lost the
// finding that follows. Division must still be division.
test('regex literals produce nothing of their own and do not move the finding', () => {
  const root = join(fixtures, 'regex-literal');
  const file = join(root, 'webhook.js');
  const result = run(root);
  assert.equal(result.status, 1);
  assert.equal(result.parsed.findings.length, 1);

  const finding = result.parsed.findings[0];
  assert.equal(finding.line, lineContaining(file, 'const conversationSourceKey ='));
  assert.equal(finding.insertLine, lineContaining(file, 'const { data: incomingLog }'));
  assert.equal(finding.sinkLine, lineContaining(file, 'idempotency_key: conversationSourceKey'));
  assert.equal(finding.selectsFirst, 'incomingLog?.id');
  assert.equal(finding.selectsLater, 'event.message.id');
});

// Reviewed 2026-11-02: the original case was missed three ways at once. Its
// binding also destructures `error`, its key leaves the function as `sourceKey`,
// and the receiver embeds that in a template.
test('a key that reaches idempotency_key in another file is reported with both ends', () => {
  const root = join(fixtures, 'cross-file-case');
  const caller = join(root, 'src', 'app', 'inbound', 'route.js');
  const receiver = join(root, 'src', 'core', 'turns', 'events.js');
  const result = run(root);
  assert.equal(result.status, 1);
  assert.equal(result.parsed.scanned, 2);
  assert.equal(result.parsed.unread.length, 0);
  assert.equal(result.parsed.unresolved.length, 0);
  assert.equal(result.parsed.findings.length, 1);

  const finding = result.parsed.findings[0];
  assert.equal(finding.file, 'src/app/inbound/route.js');
  assert.equal(finding.line, lineContaining(caller, 'const turnKey ='));
  assert.equal(finding.insertLine, lineContaining(caller, 'error: receivedRowError'));
  assert.equal(finding.selectsFirst, 'receivedRow?.id');
  assert.equal(finding.selectsLater, 'event.message.id');
  assert.equal(finding.sinkFile, 'src/core/turns/events.js');
  assert.equal(finding.sinkLine, lineContaining(receiver, 'idempotency_key:'));
  assert.equal(finding.sinks.length, 1);

  const { via, expression } = finding.sinks[0];
  assert.match(expression, /^idempotency_key: `received:\$\{sourceKey\}`/);
  assert.equal(via.file, 'src/app/inbound/route.js');
  assert.equal(via.callee, 'openTurn');
  assert.equal(via.property, 'sourceKey');
  assert.equal(via.importedFrom, '@/core/turns/events');
  assert.equal(via.importLine, lineContaining(caller, "from '@/core/turns/events'"));
  assert.equal(via.callLine, lineContaining(caller, 'return openTurn({'));
  assert.equal(via.argumentLine, lineContaining(caller, 'sourceKey: turnKey'));

  const human = run(root, { json: false });
  assert.match(human.stdout, /route\.js:\d+ passes turnKey to openTurn as sourceKey/);
  assert.match(human.stdout, /events\.js:\d+ uses it: idempotency_key/);
  assert.match(human.stdout, /Not established here\./);
});

for (const [name, why] of [
  ['cross-file-stable-first', 'the event key is selected before the row id on the same path'],
  ['cross-file-log-only', 'the receiver only logs the value'],
]) {
  test(`no finding across files when ${why} (${name})`, () => {
    const result = run(join(fixtures, name));
    assert.equal(result.status, 0, `${name} should exit 0, printed: ${result.stdout}${result.stderr}`);
    assert.equal(result.parsed.status, 'no-findings');
    assert.equal(result.parsed.findings.length, 0);
    assert.equal(result.parsed.scanned, 2);
    assert.equal(result.parsed.unresolved.length, 0);
  });
}

test('a renamed parameter in an exported arrow function is still followed', () => {
  const result = run(renamedReceiver);
  assert.equal(result.status, 1);
  assert.equal(result.parsed.findings[0].sinkFile, 'src/app/inbound/receiver.js');
  assert.equal(result.parsed.findings[0].sinkLine, 2);
});

for (const [why, root, reason] of [
  ['the receiver is a file type this does not read', typescriptReceiver, /no \.js\/\.mjs\/\.cjs file read/],
  ['the import leaves the root, even though the file exists', outsideReceiver, /no \.js\/\.mjs\/\.cjs file read/],
  ['the alias could mean two files, and no config is read to decide', ambiguousReceiver, /could be/],
  ['the receiver does not destructure its parameter', unnamedParameter, /destructured parameter/],
]) {
  test(`an unfollowed call is incomplete, not clean: ${why}`, () => {
    const result = run(root);
    assert.equal(result.status, 3, `printed: ${result.stdout}${result.stderr}`);
    assert.equal(result.parsed.status, 'incomplete');
    assert.equal(result.parsed.findings.length, 0);
    assert.equal(result.parsed.unresolved.length, 1);
    assert.equal(result.parsed.unresolved[0].callee, 'openTurn');
    assert.match(result.parsed.unresolved[0].reason, reason);
    const human = run(root, { json: false });
    assert.equal(human.status, 3);
    assert.match(human.stdout, /unresolved: src\/app\/inbound\/route\.js:\d+ openTurn/);
  });
}

test('a call into a package is not followed and does not make the run incomplete', () => {
  const result = run(packageReceiver);
  assert.equal(result.status, 0, `printed: ${result.stdout}${result.stderr}`);
  assert.equal(result.parsed.status, 'no-findings');
  assert.equal(result.parsed.unresolved.length, 0);
});

test('nothing to read is not the same answer as nothing found', () => {
  const result = run(join(fixtures, 'no-candidates'));
  assert.equal(result.status, 3);
  assert.equal(result.parsed.status, 'incomplete');
  assert.equal(result.parsed.candidates, 0);
  assert.equal(result.parsed.scanned, 0);
  const human = run(join(fixtures, 'no-candidates'), { json: false });
  assert.equal(human.status, 3);
  assert.match(human.stdout, /INCOMPLETE: no \.js\/\.mjs\/\.cjs file to read/);
});

test('a candidate that could not be read is reported, not silently passed', () => {
  const result = run(unreadableRoot);
  assert.equal(result.status, 3);
  assert.equal(result.parsed.status, 'incomplete');
  assert.equal(result.parsed.scanned, 0);
  assert.equal(result.parsed.unread.length, 1);
  assert.equal(result.parsed.unread[0].path, 'huge.js');
  assert.match(result.parsed.unread[0].reason, /larger than/);
});

test('a finding still reports the files that could not be read', () => {
  const result = run(mixedRoot);
  assert.equal(result.status, 1);
  assert.equal(result.parsed.status, 'findings');
  assert.equal(result.parsed.findings.length, 1);
  assert.equal(result.parsed.unread.length, 1);
  const human = run(mixedRoot, { json: false });
  assert.match(human.stdout, /unread: huge\.js/);
});

test('bad arguments are exit 2, and separate from an empty result', () => {
  assert.equal(run(null, { json: false }).status, 2);
  assert.equal(run(join(fixtures, 'original-case'), { json: false, extra: ['--what'] }).status, 2);
  assert.equal(run(join(fixtures, 'original-case', 'webhook.js'), { json: false }).status, 2);
  assert.equal(run(join(temporary, 'does-not-exist'), { json: false }).status, 2);
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--root PATH/);
});
