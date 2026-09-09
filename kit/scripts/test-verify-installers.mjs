import { parseTestTargetOptions } from './parse-test-target-options.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Isolate the runner's orchestration from the real installer suite. These
// fixtures deliberately fail or succeed; real installer tests run separately.
function fixture(body, fn) {
  const root = mkdtempSync(join(tmpdir(), 'verify-runner-'));
  const runner = join(root, 'verify-installers.mjs');
  copyFileSync(fileURLToPath(new URL('./verify-installers.mjs', import.meta.url)), runner);
  writeFileSync(join(root, 'test-install-backups.mjs'), body);
  const run = (args = ['--json']) => spawnSync(process.execPath, [runner, ...args], {
    cwd: tmpdir(), encoding: 'utf8', timeout: 45000,
  });
  try { fn({ root, run }); } finally { rmSync(root, { recursive: true, force: true }); }
}
test('failing suite remains failure alongside unavailable targets', () => fixture("console.error('fixture failure'); process.exit(7);", ({ run }) => {
  const r = run(); assert.equal(r.error, undefined); assert.equal(r.status, 1);
  const report = JSON.parse(r.stdout);
  assert.equal(report.exit_code, 1);
  const node = report.results.find(r => r.target === 'node');
  assert.equal(node.status, 'failed'); assert.equal(node.exit_code, 7);
  assert.match(node.output, /fixture failure/);
}));
test('successful suite runs relative to runner, independent of working directory', () => fixture('process.exit(0);', ({ run }) => {
  const r = run(); assert.equal(r.error, undefined);
  const report = JSON.parse(r.stdout);
  assert.equal(report.results.find(r => r.target === 'node').status, 'passed');
  assert.equal(report.platform, process.platform);
  assert.equal(report.results.length, 3);
  if (process.platform !== 'win32') {
    assert.equal(r.status, 2);
    assert.deepEqual(report.results.find(r => r.target === 'windows-powershell-5.1'), {
      target: 'windows-powershell-5.1', status: 'unverified', reason: 'requires-windows',
    });
  }
}));
test('invalid argument stops before launching tests', () => fixture("import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./ran', import.meta.url), 'ran');", ({ root, run }) => {
  const r = run(['--unknown']); assert.equal(r.status, 2);
  assert.equal(existsSync(join(root, 'ran')), false);
  assert.match(r.stderr, /Usage:/);
}));
test('text output exposes failure', () => fixture('process.exit(3);', ({ run }) => {
  const r = run([]); assert.equal(r.status, 1); assert.match(r.stdout, /node: failed/);
}));

test('pull-all selection executes the selected suite and reports its scope', () => fixture('process.exit(9);', ({ root, run }) => {
  writeFileSync(join(root, 'test-pull-all.mjs'), 'process.exit(0);');
  const r = run(['--suite', 'pull-all', '--json']);
  assert.equal(r.error, undefined);
  const report = JSON.parse(r.stdout);
  assert.equal(report.scope, 'pull-all-tests-on-this-machine');
  assert.equal(report.results.find(r => r.target === 'node').status, 'passed');
}));
test('invalid suite selections stop before tests', () => fixture("import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./ran', import.meta.url), 'ran');", ({ root, run }) => {
  for (const args of [['--suite'], ['--suite', 'unknown'], ['--suite', 'pull-all', '--suite', 'installers'], ['--json', '--json']]) {
    assert.equal(run(args).status, 2);
    assert.equal(existsSync(join(root, 'ran')), false);
  }
}));

// Exercise the actual entrypoints: bad target names must never fall back to Node.
for (const name of ['test-install-backups.mjs', 'test-pull-all.mjs']) {
  test(`${name} rejects invalid target arguments before starting its suite`, () => {
    const suite = fileURLToPath(new URL(`./${name}`, import.meta.url));
    for (const args of [
      ['--target', 'powershell'], ['--target'], ['--target', ''],
      ['--target', 'ps', '--target', 'node'], ['--unknown'], ['node'],
      ['--target', 'ps', '--pwsh'], ['--target', 'ps', '--pwsh', '--target'],
      ['--pwsh', 'pwsh'], ['--target', 'ps', '--pwsh', 'pwsh', '--pwsh', 'pwsh'],
    ]) {
      const r = spawnSync(process.execPath, [suite, ...args], { encoding: 'utf8', timeout: 10000 });
      assert.equal(r.error, undefined);
      assert.equal(r.status, 2, JSON.stringify(args));
      assert.match(r.stderr, /Usage:/);
      assert.equal(r.stdout, '', 'suite must not start');
    }
  });
}
test('test target parser preserves explicit PowerShell executable paths', () => {
  assert.deepEqual(parseTestTargetOptions([]), { target: 'node', pwsh: 'pwsh' });
  assert.deepEqual(parseTestTargetOptions(['--target', 'node']), { target: 'node', pwsh: 'pwsh' });
  const executable = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  assert.deepEqual(parseTestTargetOptions(['--pwsh', executable, '--target', 'ps']), { target: 'ps', pwsh: executable });
});

test('selecting Node runs only Node and reports the limited coverage', () => fixture('process.exit(0);', ({ run }) => {
  const r = run(['--target', 'node', '--json']);
  assert.equal(r.status, 0);
  const report = JSON.parse(r.stdout);
  assert.equal(report.requested_target, 'node');
  assert.deepEqual(report.selected_targets, ['node']);
  assert.deepEqual(report.results.map(r => r.target), ['node']);
  assert.equal(report.results[0].status, 'passed');
  const text = run(['--target', 'node']);
  assert.match(text.stdout, /selected targets: node/);
  assert.match(text.stdout, /selected targets passed/);
}));
test('runtime selection composes with pull-all suite selection', () => fixture('process.exit(9);', ({ root, run }) => {
  writeFileSync(join(root, 'test-pull-all.mjs'), 'process.exit(0);');
  const r = run(['--suite', 'pull-all', '--target', 'node', '--json']);
  assert.equal(r.status, 0);
  const report = JSON.parse(r.stdout);
  assert.equal(report.scope, 'pull-all-tests-on-this-machine');
  assert.equal(report.results.length, 1);
}));
test('invalid runtime selections stop before executing any suite', () => fixture("import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./ran', import.meta.url), 'ran');", ({ root, run }) => {
  for (const args of [['--target'], ['--target', 'ps'], ['--target', ''], ['--target', 'node', '--target', 'all']]) {
    const r = run(args);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Usage:/);
    assert.equal(existsSync(join(root, 'ran')), false);
  }
}));
test('explicit all retains every runtime in the report', () => fixture('process.exit(0);', ({ run }) => {
  const r = run(['--target', 'all', '--json']);
  const report = JSON.parse(r.stdout);
  assert.equal(report.requested_target, 'all');
  assert.equal(report.selected_targets.length, 3);
  assert.equal(report.results.length, 3);
}));
