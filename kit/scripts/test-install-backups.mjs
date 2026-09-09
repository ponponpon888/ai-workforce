import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, statSync, utimesSync, cpSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const ps = process.argv.includes('--target') && process.argv[process.argv.indexOf('--target') + 1] === 'ps';
const shell = process.argv.includes('--pwsh') ? process.argv[process.argv.indexOf('--pwsh') + 1] : 'pwsh';
const installer = fileURLToPath(new URL(ps ? './install.ps1' : './install.mjs', import.meta.url));
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'install-backups-'));
  const preload = join(root, 'clock.mjs');
  writeFileSync(preload, "const OriginalDate = Date; globalThis.Date = class extends OriginalDate { toISOString() { return '2026-09-09T00:00:00.000Z'; } };\n");
  const wrapper = join(root, 'run.ps1');
  writeFileSync(wrapper, 'param([string]$Installer, [string]$Dest, [switch]$Dry, [switch]$Skip)\nfunction Get-Date { param($Format) return "20260909_000000" }\n& $Installer -ClaudeHome $Dest -WhatIf:$Dry -SkipSettings:$Skip -SkipClaudeMd:$Skip\nexit $LASTEXITCODE\n');
  const run = (home, { dry = false, skip = false } = {}) => {
    const args = ps ? ['-NoProfile', '-File', wrapper, '-Installer', installer, '-Dest', home, ...(dry ? ['-Dry'] : []), ...(skip ? ['-Skip'] : [])] : ['--import', preload, installer, '--claude-home', home, ...(dry ? ['--dry-run'] : []), ...(skip ? ['--skip-settings', '--skip-claude-md'] : [])];
    const r = spawnSync(ps ? shell : process.execPath, args, { encoding: 'utf8' });
    assert.equal(r.error, undefined); assert.equal(r.status, 0, r.stderr); return r;
  };
  try { fn({ root, run }); } finally { rmSync(root, { recursive: true, force: true }); }
}
test('same-clock reinstalls preserve every previous file byte-for-byte', () => fixture(({ root, run }) => {
  const home = join(root, 'home'); run(home);
  const target = join(home, 'settings.json');
  const snapshots = [Buffer.from([0xff, 0xfe, 65, 0]), Buffer.from('second custom settings')];
  for (const snapshot of snapshots) { writeFileSync(target, snapshot); run(home); }
  const backups = readdirSync(home).filter(n => n.startsWith('settings.json.bak.'));
  assert.equal(backups.length, 2);
  const contents = backups.map(n => readFileSync(join(home, n)));
  for (const snapshot of snapshots) assert.ok(contents.some(b => b.equals(snapshot)));
  assert.doesNotThrow(() => JSON.parse(readFileSync(target, 'utf8')));
}));
test('legacy backup survives a same-clock reinstall', () => fixture(({ root, run }) => {
  const home = join(root, 'home'); run(home);
  const legacy = join(home, `settings.json.bak.${ps ? '20260909_000000' : '20260909000000.'}`);
  writeFileSync(legacy, 'keep this backup'); run(home);
  assert.equal(readFileSync(legacy, 'utf8'), 'keep this backup');
}));
test('dry run creates neither home nor backups', () => fixture(({ root, run }) => {
  const home = join(root, 'home'); run(home, { dry: true }); assert.equal(existsSync(home), false);
  run(home); const before = readdirSync(home); run(home, { dry: true }); assert.deepEqual(readdirSync(home), before);
}));
test('skip flags preserve custom settings and instructions', () => fixture(({ root, run }) => {
  const home = join(root, 'home'); run(home);
  for (const name of ['settings.json', 'CLAUDE.md']) writeFileSync(join(home, name), 'custom');
  run(home, { skip: true });
  for (const name of ['settings.json', 'CLAUDE.md']) { assert.equal(readFileSync(join(home, name), 'utf8'), 'custom'); assert.equal(readdirSync(home).filter(n => n.startsWith(name + '.bak.')).length, 0); }
}));

if (!ps) {
  for (const [name, extra] of [
    ['unknown flag', ['--dryrun']],
    ['missing language', ['--lang']],
    ['flag used as language', ['--lang', '--dry-run']],
    ['duplicate destination', ['--claude-home']],
    ['unexpected positional', ['unexpected']],
    ['empty language', ['--lang', '']],
  ]) test(`invalid CLI rejects ${name} before any write`, () => fixture(({ root }) => {
    const home = join(root, 'home');
    const r = spawnSync(process.execPath, [installer, '--claude-home', home, ...extra], { cwd: root, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.equal(existsSync(home), false);
  }));
  test('destination cannot consume a following flag', () => fixture(({ root }) => {
    const r = spawnSync(process.execPath, [installer, '--claude-home', '--skip-settings'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.equal(existsSync(join(root, '--skip-settings')), false);
  }));
}

{
  for (const failure of ['missing-approval', 'invalid-settings']) test(`preflight ${failure} leaves existing home untouched`, () => fixture(({ root, run }) => {
    const home = join(root, 'home'); run(home);
    writeFileSync(join(home, 'CLAUDE.md'), 'existing customized instructions');
    const before = readFileSync(join(home, 'CLAUDE.md'));
    const kit = join(root, 'kit');
    cpSync(fileURLToPath(new URL('../', import.meta.url)), kit, { recursive: true });
    if (failure === 'missing-approval') rmSync(join(kit, 'scripts', 'approve-ddl.mjs'));
    else writeFileSync(join(kit, 'claude', 'settings.json'), '{broken');
    const r = ps
      ? spawnSync(shell, ['-NoProfile', '-File', join(kit, 'scripts', 'install.ps1'), '-ClaudeHome', home], { encoding: 'utf8' })
      : spawnSync(process.execPath, [join(kit, 'scripts', 'install.mjs'), '--claude-home', home], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.deepEqual(readFileSync(join(home, 'CLAUDE.md')), before);
    assert.equal(readdirSync(home).some(n => n.includes('.bak.')), false);
  }));
}

if (ps) test('declining backup prevents a later yes from overwriting that file', () => fixture(({ root, run }) => {
  const home = join(root, 'home'); run(home);
  const target = join(home, 'CLAUDE.md');
  writeFileSync(target, 'preserve my instructions');
  writeFileSync(join(home, 'settings.json'), 'custom settings');
  // No to the first backup; Yes to all later prompts. Before the fix, the
  // second prompt allowed CLAUDE.md to be overwritten without a backup.
  const r = spawnSync(shell, ['-NoProfile', '-File', installer, '-ClaudeHome', home, '-Confirm'], {
    input: 'n\na\n', encoding: 'utf8', timeout: 15000,
  });
  assert.equal(r.error, undefined);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(target, 'utf8'), 'preserve my instructions');
  assert.equal(readdirSync(home).some(n => n.startsWith('CLAUDE.md.bak.')), false);
  // Prove the confirmation driver proceeded to later files.
  assert.ok(readdirSync(home).some(n => n.startsWith('settings.json.bak.')));
}));

if (!ps) for (const name of ['home-$&', 'home-{{GUARD_SQL_COMMAND}}']) {
  test(`template preserves literal destination ${name}`, () => fixture(({ root, run }) => {
    const home = join(root, name); run(home);
    const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    const commands = settings.hooks.PreToolUse.flatMap(rule => rule.hooks.map(h => h.command));
    assert.ok(commands.includes(`node "${join(home, 'hooks', 'guard-sql.mjs')}"`));
    assert.ok(commands.includes(`node "${join(home, 'hooks', 'guard-secrets.mjs')}"`));
  }));
}

test('identical reinstall preserves timestamps and creates no backups', () => fixture(({ root, run }) => {
  const home = join(root, 'home'); run(home);
  const files = ['CLAUDE.md', 'settings.json', 'hooks/guard-sql.mjs', 'hooks/guard-secrets.mjs', 'scripts/approve-ddl.mjs'];
  const before = new Map();
  for (const file of files) {
    const path = join(home, file); utimesSync(path, 1000000000, 1000000000);
    before.set(file, { bytes: readFileSync(path), mtime: statSync(path).mtimeMs });
  }
  run(home);
  for (const file of files) {
    assert.deepEqual(readFileSync(join(home, file)), before.get(file).bytes);
    assert.equal(statSync(join(home, file)).mtimeMs, before.get(file).mtime);
  }
  for (const dir of ['', 'hooks', 'scripts']) assert.equal(readdirSync(join(home, dir)).some(n => n.includes('.bak.')), false);
}));
test('only changed file gets backed up', () => fixture(({ root, run }) => {
  const home = join(root, 'home'); run(home);
  writeFileSync(join(home, 'CLAUDE.md'), 'custom instructions'); run(home);
  const backups = readdirSync(home).filter(n => n.includes('.bak.'));
  assert.equal(backups.length, 1); assert.ok(backups[0].startsWith('CLAUDE.md.bak.'));
  assert.equal(readFileSync(join(home, backups[0]), 'utf8'), 'custom instructions');
  for (const dir of ['hooks', 'scripts']) assert.equal(readdirSync(join(home, dir)).some(n => n.includes('.bak.')), false);
}));

for (const conflict of ['parent-file', 'destination-directory']) {
  test(`preflight rejects ${conflict} before changing earlier files`, () => fixture(({ root }) => {
    const home = join(root, 'home'); mkdirSync(home);
    writeFileSync(join(home, 'CLAUDE.md'), 'keep original');
    if (conflict === 'parent-file') writeFileSync(join(home, 'hooks'), 'keep obstruction');
    else mkdirSync(join(home, 'settings.json'));
    const r = ps
      ? spawnSync(shell, ['-NoProfile', '-File', installer, '-ClaudeHome', home], { encoding: 'utf8' })
      : spawnSync(process.execPath, [installer, '--claude-home', home], { encoding: 'utf8' });
    assert.equal(r.error, undefined);
    assert.notEqual(r.status, 0);
    assert.equal(readFileSync(join(home, 'CLAUDE.md'), 'utf8'), 'keep original');
    assert.equal(readdirSync(home).some(n => n.includes('.bak.')), false);
    assert.equal(existsSync(join(home, 'scripts')), false);
  }));
}

// Execute the installed settings commands, not the checkout's hook files.
// tool_input is JSON data only; the psql/cat commands are never executed.
for (const [name, command, expected] of [
  ['destructive SQL', 'psql -c "drop table aiwf_test"', [2, 0]],
  ['secret read', 'cat .env', [0, 2]],
  ['read-only SQL', 'psql -c "select 1"', [0, 0]],
  ['ordinary file read', 'cat README.md', [0, 0]],
]) test(`installed settings wire ${name} correctly`, () => fixture(({ root, run }) => {
  const home = join(root, 'home with spaces'); run(home);
  const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
  const hooks = settings.hooks.PreToolUse
    .filter(rule => new RegExp(`^(?:${rule.matcher})$`).test('Bash'))
    .flatMap(rule => rule.hooks);
  assert.equal(hooks.length, 2);
  const payload = JSON.stringify({ session_id: 'installation-test', hook_event_name: 'PreToolUse', cwd: root, tool_name: 'Bash', tool_input: { command } });
  for (let i = 0; i < hooks.length; i++) {
    assert.equal(hooks[i].type, 'command');
    const r = spawnSync(hooks[i].command, {
      shell: true, cwd: root, input: payload, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, AIWF_APPROVAL_DIR: join(root, 'isolated-approvals') },
    });
    assert.equal(r.error, undefined);
    assert.equal(r.status, expected[i], r.stderr);
    if (expected[i] === 2) assert.match(r.stderr, i === 0 ? /\[guard-sql\]/ : /\[guard-secrets\]/);
  }
}));
