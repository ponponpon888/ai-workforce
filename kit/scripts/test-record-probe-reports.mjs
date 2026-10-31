#!/usr/bin/env node
/** Test before/after recording with disposable hooks only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAfter, runBefore } from './record-probe-reports.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
const command = join(scripts, 'record-probe-reports.mjs');
const root = join(tmpdir(), `aiwf-record-probe-reports-${process.pid}`);
mkdirSync(root, { recursive: true });

function write(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
function fixture(name, mode = 'pass') {
  const home = join(root, name, '.claude');
  const hooks = join(home, 'hooks');
  const modePath = join(home, 'mode.txt');
  write(modePath, mode);
  const script = `import { readFileSync } from 'node:fs'; let body = ''; process.stdin.on('data', c => body += c); process.stdin.on('end', () => { const value = JSON.parse(body); const input = value.tool_input; const allow = input.query === 'select 1' || input.command === 'npm run build' || input.command === 'git status --porcelain' || input.command === 'cat .env.example' || input.file_path?.endsWith('aiwf-probe-ordinary-notes.txt'); const mode = readFileSync(${JSON.stringify(modePath)}, 'utf8').trim(); if (mode === 'unexpected-allow') process.exit(0); if (mode === 'false-positive') process.exit(2); process.exit(allow ? 0 : 2); });`;
  const names = ['guard-sql', 'guard-secrets', 'guard-config', 'guard-destructive'];
  for (const name of names) write(join(hooks, `${name}.mjs`), script);
  write(join(hooks, 'lib', 'shell-lex.mjs'), '// disposable fixture lexer\n');
  write(join(home, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: names.map(name => ({ type: 'command', command: `node "${join(hooks, `${name}.mjs`)}"` })) }] } }, null, 2));
  return { home, hooks, modePath };
}

function run(args) {
  const result = spawnSync(process.execPath, [command, ...args, '--json'], { encoding: 'utf8', timeout: 15000 });
  return { ...result, json: result.stdout.trim() ? JSON.parse(result.stdout) : null };
}

function before(home, output) { return run(['before', '--claude-home', home, '--output', output]); }
function after(home, previous, output) { return run(['after', '--claude-home', home, '--previous', previous, '--output', output]); }

try {
  test('records a passing baseline and compares a passing current probe', () => {
    const { home } = fixture('normal');
    const previous = join(root, 'normal-before.json');
    const current = join(root, 'normal-after.json');
    const baseline = before(home, previous);
    assert.equal(baseline.status, 0, JSON.stringify(baseline.json));
    const result = after(home, previous, current);
    assert.equal(result.status, 0);
    assert.equal(result.json.comparison.exitCode, 0);
    assert.ok(existsSync(previous));
    assert.ok(existsSync(current));
  });

  test('shows unexpected allow, false positive, and unchanged failure separately', () => {
    for (const [name, mode, expected] of [['unexpected', 'unexpected-allow', 'unexpected-allow'], ['false-positive', 'false-positive', 'false-positive']]) {
      const { home, modePath } = fixture(name);
      const previous = join(root, `${name}-before.json`);
      const current = join(root, `${name}-after.json`);
      const baseline = before(home, previous);
      assert.equal(baseline.status, 0, JSON.stringify(baseline.json));
      writeFileSync(modePath, mode);
      const result = after(home, previous, current);
      assert.equal(result.status, 1);
      assert.ok(result.json.comparison.resultChanges.some(change => change.type === expected));
    }
    const { home } = fixture('unchanged-failure', 'unexpected-allow');
    const previous = join(root, 'failed-before.json');
    const current = join(root, 'failed-after.json');
    const baseline = before(home, previous);
    assert.equal(baseline.status, 1);
    assert.equal(baseline.json.reportStatus, 'error');
    const result = after(home, previous, current);
    assert.equal(result.status, 1);
    assert.ok(result.json.comparison.resultChanges.some(change => change.type === 'unchanged-failure'));
  });

  test('reports hash-only changes as conditions, not result regressions', () => {
    const { home, hooks } = fixture('conditions');
    const previous = join(root, 'conditions-before.json');
    const current = join(root, 'conditions-after.json');
    const baseline = before(home, previous);
    assert.equal(baseline.status, 0, JSON.stringify(baseline.json));
    writeFileSync(join(hooks, 'guard-sql.mjs'), `${readFileSync(join(hooks, 'guard-sql.mjs'), 'utf8')}\n// changed without changing behavior\n`);
    const result = after(home, previous, current);
    assert.equal(result.status, 1);
    assert.deepEqual(result.json.comparison.resultChanges, []);
    assert.ok(result.json.comparison.conditionChanges.some(change => change.field === 'guards.guard-sql'));
  });

  test('does not save incomplete, malformed, startup-failed, or unwritable reports', () => {
    const { home } = fixture('incomplete');
    const incomplete = join(root, 'incomplete.json');
    const result = runBefore({ claudeHome: home, output: incomplete, probeRunner: () => ({ status: 'incomplete' }) });
    assert.equal(result.exitCode, 2);
    assert.equal(existsSync(incomplete), false);
    const timeout = join(root, 'timeout.json');
    // probe-guards maps hook timeouts to incomplete. The recorder must reject
    // that state without leaving an output file.
    const timedOut = runBefore({ claudeHome: home, output: timeout, probeRunner: () => ({ status: 'incomplete' }) });
    assert.equal(timedOut.exitCode, 2);
    assert.equal(existsSync(timeout), false);

    const malformedHome = join(root, 'malformed', '.claude');
    write(join(malformedHome, 'settings.json'), '{not json');
    const malformed = join(root, 'malformed.json');
    assert.equal(before(malformedHome, malformed).status, 2);
    assert.equal(existsSync(malformed), false);

    const startupHome = join(root, 'startup', '.claude');
    const startupHooks = join(startupHome, 'hooks');
    const names = ['guard-sql', 'guard-secrets', 'guard-config', 'guard-destructive'];
    write(join(startupHome, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: names.map(name => ({ type: 'command', command: `node "${join(startupHooks, `${name}.mjs`)}"` })) }] } }));
    const startup = join(root, 'startup.json');
    assert.equal(before(startupHome, startup).status, 2);
    assert.equal(existsSync(startup), false);

    const unwritable = join(root, 'missing-directory', 'report.json');
    assert.equal(before(home, unwritable).status, 2);
    assert.equal(existsSync(unwritable), false);
  });

  test('never overwrites an existing report or uses one file for both roles', () => {
    const { home } = fixture('overwrite');
    const existing = join(root, 'existing.json');
    write(existing, 'keep this exact content');
    assert.equal(before(home, existing).status, 2);
    assert.equal(readFileSync(existing, 'utf8'), 'keep this exact content');
    const previous = join(root, 'overwrite-before.json');
    const baseline = before(home, previous);
    assert.equal(baseline.status, 0, JSON.stringify(baseline.json));
    assert.equal(after(home, previous, previous).status, 2);
    assert.ok(existsSync(previous));
  });

  test('does not compare reports when the protected target changed', () => {
    const { home } = fixture('target');
    const previous = join(root, 'target-before.json');
    const current = join(root, 'target-after.json');
    assert.equal(before(home, previous).status, 0);
    const changedTarget = { ...JSON.parse(readFileSync(previous, 'utf8')), protectedHome: join(home, 'different-protected-home') };
    const result = runAfter({ claudeHome: home, previous, output: current, probeRunner: () => changedTarget });
    assert.equal(result.exitCode, 2);
    assert.match(result.error, /different target/);
    assert.ok(existsSync(current));
  });
} finally {
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
}
