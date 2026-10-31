#!/usr/bin/env node
/** Test the saved-report comparator without invoking a guard or payload. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'aiwf-compare-probe-reports-'));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const digest = character => character.repeat(64);

function probe(id, result = 'pass', classification = result === 'pass' ? 'expected' : 'execution-anomaly') {
  return { id, result, classification, expect: id.includes('allow') ? 0 : 2, status: result === 'pass' ? (id.includes('allow') ? 0 : 2) : 1 };
}
function report(probes, options = {}) {
  const result = probes.some(p => p.result === 'fail') ? 'fail'
    : probes.some(p => p.result === 'unverified') ? 'unverified' : 'pass';
  return {
    schemaVersion: options.schemaVersion ?? 1,
    probeDefinitionVersion: options.probeDefinitionVersion ?? 1,
    generatedAt: options.generatedAt ?? '2026-10-31T00:00:00.000Z',
    status: options.status ?? (result === 'fail' ? 'error' : result === 'unverified' ? 'incomplete' : 'probe-pass'),
    runtime: options.runtime ?? { os: { platform: 'win32', type: 'Windows_NT', release: '10.0' }, node: 'v24.0.0', powerShell: { used: true, executable: 'powershell.exe', version: '5.1.0' } },
    integrity: options.integrity ?? { state: 'stable', before: { settings: { state: 'ok', sha256: digest('a') }, guards: { 'guard-sql': { state: 'ok', sha256: digest('b') }, 'guard-secrets': { state: 'ok', sha256: digest('c') }, 'guard-config': { state: 'ok', sha256: digest('d') }, 'guard-destructive': { state: 'ok', sha256: digest('e') } }, sharedLexers: { 'shell-lex.mjs': { state: 'ok', sha256: digest('f') } } }, after: { settings: { state: 'ok', sha256: digest('a') }, guards: { 'guard-sql': { state: 'ok', sha256: digest('b') }, 'guard-secrets': { state: 'ok', sha256: digest('c') }, 'guard-config': { state: 'ok', sha256: digest('d') }, 'guard-destructive': { state: 'ok', sha256: digest('e') } }, sharedLexers: { 'shell-lex.mjs': { state: 'ok', sha256: digest('f') } } } },
    guards: [{ guard: 'guard-sql', result, probes }],
  };
}
function save(name, value) { const path = join(root, name); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); return path; }
function run(previous, current, json = true) {
  const args = [join(scripts, 'compare-probe-reports.mjs'), '--previous', previous, '--current', current];
  if (json) args.push('--json');
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
  return { ...result, json: json && result.stdout.trim() ? JSON.parse(result.stdout) : null };
}

try {
  test('pass becomes unexpected allow or false positive', () => {
    const before = save('pass-before.json', report([probe('block'), probe('allow')]));
    const unexpected = save('unexpected.json', report([probe('block', 'fail', 'unexpected-allow'), probe('allow')]));
    const falsePositive = save('false-positive.json', report([probe('block'), probe('allow', 'fail', 'false-positive')]));
    for (const current of [unexpected, falsePositive]) {
      const result = run(before, current);
      assert.equal(result.status, 1);
      assert.ok(result.json.resultChanges.some(c => ['unexpected-allow', 'false-positive'].includes(c.type)));
    }
  });

  test('fail becomes pass, while pass becoming unverified or missing is visible', () => {
    const failed = save('failed.json', report([probe('block', 'fail', 'execution-anomaly')]));
    const passed = save('passed.json', report([probe('block')]));
    assert.ok(run(failed, passed).json.resultChanges.some(c => c.type === 'improvement'));
    const previous = save('unverified-before.json', report([probe('block'), probe('allow')]));
    const unverified = save('unverified.json', report([probe('block', 'unverified', 'unverified'), probe('allow')]));
    const missing = save('missing.json', report([probe('allow')]));
    assert.ok(run(previous, unverified).json.resultChanges.some(c => c.type === 'became-unverified'));
    assert.ok(run(previous, missing).json.resultChanges.some(c => c.type === 'missing'));
  });

  test('unchanged failures are not reported as normal', () => {
    const before = save('same-failure-before.json', report([probe('block', 'fail', 'execution-anomaly')]));
    const current = save('same-failure-current.json', report([probe('block', 'fail', 'execution-anomaly')]));
    const human = run(before, current, false);
    assert.equal(human.status, 1);
    assert.match(human.stdout, /UNCHANGED FAILURE/);
  });

  test('probe order and timestamps alone do not create a result difference', () => {
    const before = save('order-before.json', report([probe('block'), probe('allow')], { generatedAt: '2026-10-31T00:00:00.000Z' }));
    const current = save('order-current.json', report([probe('allow'), probe('block')], { generatedAt: '2026-10-31T23:59:59.000Z' }));
    const result = run(before, current);
    assert.equal(result.status, 0);
    assert.deepEqual(result.json.resultChanges, []);
  });

  test('invalid, duplicate, unsupported, and old reports are rejected', () => {
    const valid = save('valid.json', report([probe('block')]));
    const invalid = save('invalid.json', '{not json');
    const duplicate = save('duplicate.json', report([probe('block'), probe('block')]));
    const unsupported = save('unsupported.json', report([probe('block')], { schemaVersion: 99 }));
    const old = save('old.json', { guards: [{ guard: 'guard-sql', probes: [{ result: 'pass' }] }] });
    for (const broken of [invalid, duplicate, unsupported, old]) assert.equal(run(broken, valid).status, 2);
  });

  test('empty or inconsistent reports cannot be treated as passing', () => {
    const valid = save('valid-for-shape.json', report([probe('block')]));
    const emptyGuards = save('empty-guards.json', { ...report([probe('block')]), guards: [] });
    const emptyProbes = report([probe('block')]);
    emptyProbes.guards[0].probes = [];
    const inconsistentProbe = report([probe('block', 'fail', 'execution-anomaly')]);
    inconsistentProbe.guards[0].result = 'pass';
    const inconsistentStatus = report([probe('block', 'fail', 'execution-anomaly')], { status: 'probe-pass' });
    const unknownRuntime = report([probe('block')]);
    unknownRuntime.runtime.powerShell.version = 'unknown';
    const unavailableHash = report([probe('block')]);
    unavailableHash.integrity.before.settings = { state: 'unavailable' };
    unavailableHash.integrity.after.settings = { state: 'unavailable' };
    for (const broken of [emptyGuards, save('empty-probes.json', emptyProbes), save('inconsistent-probe.json', inconsistentProbe), save('inconsistent-status.json', inconsistentStatus), save('unknown-runtime.json', unknownRuntime), save('unavailable-hash.json', unavailableHash)]) {
      assert.equal(run(broken, valid).status, 2);
    }
  });

  test('settings, guard, lexer and runtime changes are separate conditions', () => {
    const before = save('condition-before.json', report([probe('block')]));
    const changed = report([probe('block')]);
    changed.runtime.node = 'v25.0.0';
    changed.integrity.before.settings.sha256 = digest('1');
    changed.integrity.after.settings.sha256 = digest('1');
    changed.integrity.before.guards['guard-sql'].sha256 = digest('2');
    changed.integrity.after.guards['guard-sql'].sha256 = digest('2');
    changed.integrity.before.sharedLexers['shell-lex.mjs'].sha256 = digest('3');
    changed.integrity.after.sharedLexers['shell-lex.mjs'].sha256 = digest('3');
    const current = save('condition-current.json', changed);
    const result = run(before, current);
    assert.equal(result.status, 1);
    assert.deepEqual(result.json.resultChanges, []);
    assert.ok(result.json.conditionChanges.some(c => c.field === 'settings'));
    assert.ok(result.json.conditionChanges.some(c => c.field === 'guards.guard-sql'));
    assert.ok(result.json.conditionChanges.some(c => c.field === 'sharedLexers.shell-lex.mjs'));
  });

  test('comparison does not execute JSON content or change either input file', () => {
    const marker = join(root, 'must-not-exist');
    const before = report([probe('block')]);
    before.guards[0].command = `node -e \"require('fs').writeFileSync('${marker}', 'ran')\"`;
    before.guards[0].probes[0].input = { command: `rm -rf ${marker}` };
    const previous = save('read-only-before.json', before);
    const current = save('read-only-current.json', report([probe('block')]));
    const beforeHashes = [hash(previous), hash(current)];
    const beforeMtimes = [statSync(previous).mtimeMs, statSync(current).mtimeMs];
    assert.equal(run(previous, current).status, 0);
    assert.deepEqual([hash(previous), hash(current)], beforeHashes);
    assert.deepEqual([statSync(previous).mtimeMs, statSync(current).mtimeMs], beforeMtimes);
    assert.throws(() => readFileSync(marker));
  });
} finally {
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
}
