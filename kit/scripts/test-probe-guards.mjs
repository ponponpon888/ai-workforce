#!/usr/bin/env node
/**
 * test-probe-guards.mjs — Prove the probe reports the truth.
 *
 * A diagnostic that always says "pass" is worse than no diagnostic, so the
 * cases that matter here are the broken ones: a hook gutted to exit 0, a hook
 * that blocks everything, and a registration that is simply gone. Each has to
 * come back as the specific failure it is.
 *
 * The kit is installed for real into a temporary claude home. Nothing is sent
 * to a database and no payload command is executed -- see probe-guards.mjs.
 *
 *   node kit/scripts/test-probe-guards.mjs
 *   node kit/scripts/test-probe-guards.mjs --target ps   # the PowerShell hooks
 */
import { readTestTargetOptions } from './parse-test-target-options.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
const { target, pwsh } = readTestTargetOptions();
const ps = target === 'ps';
const extension = ps ? 'ps1' : 'mjs';
const root = mkdtempSync(join(tmpdir(), 'aiwf-probe-guards-'));
const installed = join(root, 'home-installed');

// One real install, then a copy per scenario. The copies rewrite the absolute
// paths inside settings.json, because the registration is what the probe
// recognizes -- a copy that still names the original home would be testing the
// wrong thing.
//
// The PowerShell installer asks for confirmation through ShouldProcess, and
// -Confirm:$false does not bind through -File (it arrives as the literal
// string "$false"). A wrapper script evaluates it, the same way
// test-installed-approval.mjs does.
let install;
if (ps) {
  const wrapper = join(root, 'install-wrapper.ps1');
  writeFileSync(wrapper, 'param([string]$Installer, [string]$Dest)\n& $Installer -ClaudeHome $Dest -Hook powershell -Confirm:$false\nexit $LASTEXITCODE\n');
  install = spawnSync(pwsh, ['-NoProfile', '-File', wrapper, join(scripts, 'install.ps1'), installed],
    { encoding: 'utf8', timeout: 120000 });
} else {
  install = spawnSync(process.execPath, [join(scripts, 'install.mjs'), '--claude-home', installed],
    { encoding: 'utf8', timeout: 60000 });
}
assert.equal(install.status, 0, (install.stderr || '') + (install.stdout || ''));

function homeCopy(name) {
  const home = join(root, name);
  cpSync(installed, home, { recursive: true });
  const settings = join(home, 'settings.json');
  // Rebuild each registered command from the new home instead of replacing the
  // old path inside it. Two Windows-only spellings broke the replace approach:
  // the path is escaped inside JSON ("D:\\a\\...\\hooks"), and tmpdir() hands
  // back the 8.3 short form (C:\Users\RUNNER~1\...) while the installer writes
  // the long one. Matching a path by string is the problem; the guard file name
  // is all this actually needs, and the home it belongs to is already known.
  const parsed = JSON.parse(readFileSync(settings, 'utf8'));
  const retarget = value => typeof value === 'string'
    ? value.replace(/"([^"]+)"\s*$/, (_, path) => `"${join(home, 'hooks', basename(path))}"`)
    : value;
  for (const event of Object.values(parsed.hooks ?? {})) {
    for (const entry of Array.isArray(event) ? event : []) {
      for (const hook of Array.isArray(entry?.hooks) ? entry.hooks : []) hook.command = retarget(hook.command);
    }
  }
  writeFileSync(settings, JSON.stringify(parsed, null, 2));
  // Fail here, loudly, rather than let every guard come back "unverified"
  // later and leave the reason to be guessed at from four assertion diffs.
  const rewritten = readFileSync(settings, 'utf8');
  assert.ok(rewritten.includes(name), `the copied settings.json does not point at ${home}`);
  assert.ok(!rewritten.includes('home-installed'), 'the copied settings.json still points at the original home');
  // The probe recognizes a registration by comparing the command against the
  // exact spelling the installers write. Prove the rebuild produced that
  // spelling here, rather than discovering it as four "unverified" guards.
  for (const guard of ['guard-sql', 'guard-secrets', 'guard-config', 'guard-destructive']) {
    assert.ok(rewritten.includes(JSON.stringify(join(home, 'hooks', `${guard}.${extension}`)).slice(1, -1)),
      `the copied settings.json does not register ${guard} under ${home}`);
  }
  return home;
}

// AIWF_CLAUDE_HOME is what guard-config reads to decide what it protects, so
// the probe of a temporary home only means something with it set. Running
// without it is its own test below.
function runProbe(home, { withClaudeHomeEnv = true, args = [] } = {}) {
  const env = { ...process.env };
  if (withClaudeHomeEnv) env.AIWF_CLAUDE_HOME = home; else delete env.AIWF_CLAUDE_HOME;
  const r = spawnSync(process.execPath, [join(scripts, 'probe-guards.mjs'), '--claude-home', home, '--json', ...args],
    { encoding: 'utf8', env, timeout: 120000 });
  return { status: r.status, report: r.stdout.trim() ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

const guardOf = (report, name) => report.guards.find(g => g.guard === name);
const snapshot = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter(e => e.isFile())
  .map(e => { const p = join(e.parentPath ?? e.path, e.name); const s = statSync(p); return `${p}:${s.size}:${s.mtimeMs}`; })
  .sort();

try {
  test('a correctly installed kit passes every probe', () => {
    const home = homeCopy('home-good');
    const { status, report } = runProbe(home);
    assert.equal(report.status, 'probe-pass', JSON.stringify(report.findings));
    assert.equal(status, 0);
    for (const guard of report.guards) assert.equal(guard.result, 'pass', guard.guard);
    // Every guard is probed on both sides. A suite that only proves the block
    // half would pass against a hook that blocks everything.
    for (const guard of report.guards) {
      assert.ok(guard.probes.some(p => p.expect === 2), `${guard.guard} has no blocking probe`);
      assert.ok(guard.probes.some(p => p.expect === 0), `${guard.guard} has no allowing probe`);
    }
  });

  test('a hook gutted to always exit 0 is reported as a failure', () => {
    const home = homeCopy('home-gutted');
    writeFileSync(join(home, 'hooks', `guard-sql.${extension}`),
      ps ? 'exit 0\n' : '#!/usr/bin/env node\nprocess.exit(0);\n');
    const { status, report } = runProbe(home);
    assert.equal(status, 1);
    assert.equal(report.status, 'error');
    assert.equal(guardOf(report, 'guard-sql').result, 'fail');
    assert.ok(report.findings.some(f => f.level === 'error' && f.id === 'guard-sql.probe'));
    // The other three are untouched and must not be dragged down with it.
    for (const name of ['guard-secrets', 'guard-config', 'guard-destructive']) {
      assert.equal(guardOf(report, name).result, 'pass', name);
    }
  });

  test('a hook that blocks everything is reported as a failure too', () => {
    const home = homeCopy('home-blocks-all');
    writeFileSync(join(home, 'hooks', `guard-destructive.${extension}`),
      ps ? 'exit 2\n' : '#!/usr/bin/env node\nprocess.exit(2);\n');
    const { status, report } = runProbe(home);
    assert.equal(status, 1);
    const guard = guardOf(report, 'guard-destructive');
    assert.equal(guard.result, 'fail');
    // Precisely the allow side failed: a guard that refuses correct work gets
    // switched off, which is the failure mode this half exists to catch.
    for (const p of guard.probes) assert.equal(p.result, p.expect === 0 ? 'fail' : 'pass', p.name);
  });

  test('a missing hook file is reported, not silently passed', () => {
    const home = homeCopy('home-missing-file');
    rmSync(join(home, 'hooks', `guard-secrets.${extension}`));
    const { status, report } = runProbe(home);
    assert.notEqual(status, 0);
    assert.notEqual(guardOf(report, 'guard-secrets').result, 'pass');
  });

  test('an unregistered guard is unverified, not a pass', () => {
    const home = homeCopy('home-unregistered');
    const settings = join(home, 'settings.json');
    const parsed = JSON.parse(readFileSync(settings, 'utf8'));
    for (const entry of parsed.hooks.PreToolUse) {
      entry.hooks = entry.hooks.filter(h => !h.command.includes('guard-destructive'));
    }
    writeFileSync(settings, JSON.stringify(parsed, null, 2));
    const { status, report } = runProbe(home);
    assert.equal(status, 2);
    assert.equal(report.status, 'incomplete');
    assert.equal(guardOf(report, 'guard-destructive').result, 'unverified');
    assert.ok(report.findings.some(f => f.id === 'guard-destructive.registration'));
  });

  test('unreadable settings fail without printing the contents', () => {
    const home = homeCopy('home-broken-json');
    writeFileSync(join(home, 'settings.json'), '{ "permissions": oops');
    const { status, report } = runProbe(home);
    assert.equal(status, 1);
    assert.equal(report.findings[0].id, 'settings.read');
    assert.ok(!JSON.stringify(report).includes('oops'));
  });

  test('probing a home guard-config does not protect is incomplete, not a pass', () => {
    const home = homeCopy('home-mismatch');
    const { status, report } = runProbe(home, { withClaudeHomeEnv: false });
    assert.equal(status, 2);
    assert.equal(report.status, 'incomplete');
    assert.ok(report.findings.some(f => f.id === 'guard-config.home'),
      'the report must name the directory guard-config actually protects');
    assert.notEqual(report.claudeHome, report.protectedHome);
  });

  test('the probe writes nothing and runs no payload command', () => {
    const home = homeCopy('home-untouched');
    const before = snapshot(home);
    const sentinel = join(tmpdir(), 'aiwf-probe-ordinary-notes.txt');
    rmSync(sentinel, { force: true });
    const { status } = runProbe(home);
    assert.equal(status, 0);
    assert.deepEqual(snapshot(home), before, 'the probe changed a file in the claude home');
    // Paths that appear inside the payloads must not come into existence: the
    // hooks read the strings, nothing runs them.
    assert.ok(!existsSync(sentinel));
    assert.ok(!existsSync('/tmp/aiwf-probe-directory-that-does-not-exist'));
    // known-good/ is written by the installer, not by this tool. The snapshot
    // above is what proves the probe left it exactly as it found it -- the
    // SessionStart path that writes a baseline is never sent a payload.
  });

  // The Windows failure this suite hit twice, in a form every platform can run:
  // the path inside settings.json is spelled differently from the string the
  // test holds (there, tmpdir()'s 8.3 short form against the installer's long
  // one). Anything that retargets by replacing the old path matches nothing and
  // leaves the copy pointing at the original home.
  test('a differently spelled path in the source settings still retargets', () => {
    const source = join(installed, 'settings.json');
    const original = readFileSync(source, 'utf8');
    try {
      // Built by hand, not with join(): join() normalizes the detour away, and
      // an unchanged fixture would quietly test nothing.
      const escape = value => JSON.stringify(value).slice(1, -1);
      const from = escape(installed) + escape(sep) + 'hooks';
      const spelled = original.replaceAll(from, escape(installed) + escape(sep) + '.' + escape(sep) + 'hooks');
      assert.notEqual(spelled, original, 'the fixture must actually change the spelling');
      writeFileSync(source, spelled);
      const home = homeCopy('home-respelled');
      const { status, report } = runProbe(home);
      assert.equal(status, 0, JSON.stringify(report?.findings));
      for (const guard of report.guards) assert.equal(guard.result, 'pass', guard.guard);
    } finally {
      writeFileSync(source, original);
    }
  });

  test('--help explains itself and exits 0 without probing', () => {
    const r = spawnSync(process.execPath, [join(scripts, 'probe-guards.mjs'), '--help'], { encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /never executed/);
  });

  test('an unknown option is refused', () => {
    const r = spawnSync(process.execPath, [join(scripts, 'probe-guards.mjs'), '--probe-everything'], { encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown option/);
  });
} finally {
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
}
