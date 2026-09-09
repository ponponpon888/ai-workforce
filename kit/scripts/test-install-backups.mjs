import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
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
