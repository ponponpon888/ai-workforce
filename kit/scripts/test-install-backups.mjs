import { readTestTargetOptions } from './parse-test-target-options.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, statSync, utimesSync, cpSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const { target, pwsh: shell } = readTestTargetOptions();
const ps = target === 'ps';
const installer = fileURLToPath(new URL(ps ? './install.ps1' : './install.mjs', import.meta.url));
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'install-backups-'));
  const preload = join(root, 'clock.mjs');
  writeFileSync(preload, "const OriginalDate = Date; globalThis.Date = class extends OriginalDate { toISOString() { return '2026-09-09T00:00:00.000Z'; } };\n");
  // `node --import` takes a specifier, not a path. A POSIX absolute path happens to
  // resolve as one; a Windows path does not -- the ESM loader reads `C:\...` as the
  // scheme `c:` and refuses it with ERR_UNSUPPORTED_ESM_URL_SCHEME before the installer
  // is reached, which is why this file passed on Linux and failed 14 of 23 here.
  const preloadUrl = pathToFileURL(preload).href;
  const wrapper = join(root, 'run.ps1');
  // -Confirm:$false, not the ambient default. install.ps1 declares ConfirmImpact
  // 'Medium', so a shell whose $ConfirmPreference is still 'High' never prompts and
  // these runs pass by coincidence. Lower that preference -- or raise ConfirmImpact --
  // and every call here reaches the prompt instead: with a console attached it blocks
  // on the operator, and with none it dies inside the prompt as a NullReferenceException
  // from install.ps1's ShouldProcess line, which names nothing useful. Say non-interactive
  // rather than depend on a preference this fixture does not own. -WhatIf still wins over
  // it, so the dry-run cases below are unaffected.
  writeFileSync(wrapper, 'param([string]$Installer, [string]$Dest, [switch]$Dry, [switch]$Skip)\nfunction Get-Date { param($Format) return "20260909_000000" }\n& $Installer -ClaudeHome $Dest -WhatIf:$Dry -SkipSettings:$Skip -SkipClaudeMd:$Skip -Confirm:$false\nexit $LASTEXITCODE\n');
  const run = (home, { dry = false, skip = false } = {}) => {
    const args = ps ? ['-NoProfile', '-File', wrapper, '-Installer', installer, '-Dest', home, ...(dry ? ['-Dry'] : []), ...(skip ? ['-Skip'] : [])] : ['--import', preloadUrl, installer, '--claude-home', home, ...(dry ? ['--dry-run'] : []), ...(skip ? ['--skip-settings', '--skip-claude-md'] : [])];
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
      // No -Confirm:$false here, and none is needed: the preflight rejects this kit
      // before Write-InstalledFile is reached, so no ShouldProcess call happens. It
      // could not be passed anyway -- powershell.exe -File hands arguments to the
      // script as literal strings, so -Confirm:$false arrives as the text "$false"
      // and fails to bind to a SwitchParameter. Where a run does need it, go through
      // a wrapper .ps1 as fixture() does, because there $false is script text.
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
  // The only test here that prompts on purpose. Every installer call that reaches
  // Write-InstalledFile goes through the wrapper's -Confirm:$false, so this is the one
  // place a hung prompt can come from -- name it, because the bare assertion reported
  // the timeout without saying what was waiting.
  const r = spawnSync(shell, ['-NoProfile', '-File', installer, '-ClaudeHome', home, '-Confirm'], {
    input: 'n\na\n', encoding: 'utf8', timeout: 15000,
  });
  assert.equal(r.error?.code, undefined,
    `install.ps1 -Confirm did not consume its answers from stdin (${r.error?.code}): ` +
    'the ShouldProcess prompts went somewhere this fixture cannot drive.');
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
    assert.equal(commands.length, 4);
    for (const command of commands) {
      const r = spawnSync(command, { shell: true, cwd: root, encoding: 'utf8', timeout: 10000,
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'pwd' }, cwd: root }) });
      assert.equal(r.error, undefined); assert.equal(r.status, 0, r.stderr);
    }
  }));
}

test('identical reinstall preserves timestamps and creates no backups', () => fixture(({ root, run }) => {
  const home = join(root, 'home'); run(home);
  const files = ['CLAUDE.md', 'settings.json', 'hooks/guard-sql.mjs', 'hooks/guard-secrets.mjs', 'hooks/guard-config.mjs', 'hooks/guard-destructive.mjs', 'scripts/approve-ddl.mjs', 'scripts/record-settings-baseline.mjs', 'known-good/settings.json'];
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
  for (const dir of ['', 'hooks', 'scripts', 'known-good']) assert.equal(readdirSync(join(home, dir)).some(n => n.includes('.bak.')), false);
}));
test('install records a known-good baseline matching the installed settings.json', () => fixture(({ root, run }) => {
  const home = join(root, 'home'); run(home);
  assert.deepEqual(readFileSync(join(home, 'known-good', 'settings.json')), readFileSync(join(home, 'settings.json')));
}));
test('re-recording the baseline after a hand-edit clears a SessionStart mismatch', () => fixture(({ root, run }) => {
  const home = join(root, 'home'); run(home);
  const settingsPath = join(home, 'settings.json');
  const edited = JSON.parse(readFileSync(settingsPath, 'utf8'));
  edited.permissions.allow.push('Bash(echo hand-edited:*)');
  writeFileSync(settingsPath, JSON.stringify(edited));
  const guardConfig = join(home, 'hooks', 'guard-config.mjs');
  const sessionStart = () => spawnSync(process.execPath, [guardConfig], {
    input: JSON.stringify({ session_id: 'test', hook_event_name: 'SessionStart', startup_type: 'startup' }),
    encoding: 'utf8', env: { ...process.env, AIWF_CLAUDE_HOME: home },
  });
  const before = sessionStart();
  assert.ok(/WARNING/.test(before.stdout), before.stdout);
  const recorder = join(home, 'scripts', 'record-settings-baseline.mjs');
  const r = spawnSync(process.execPath, [recorder, '--claude-home', home, '--force'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const after = sessionStart();
  assert.equal(after.stdout.trim(), '');
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
      // Rejected by the preflight as well, so no prompt is reachable. See the note above.
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
// Expected exit code per hook, by hook name: entries can hold more than one hook,
// so position in the settings file says nothing about which guard it is.
for (const [name, command, blockedBy] of [
  ['destructive SQL', 'psql -c "drop table aiwf_test"', 'guard-sql'],
  ['secret read', 'cat .env', 'guard-secrets'],
  ['destructive shell', "bash -c 'rm -rfv aiwf_test'", 'guard-destructive'],
  ['read-only SQL', 'psql -c "select 1"', null],
  ['ordinary file read', 'cat README.md', null],
]) test(`installed settings wire ${name} correctly`, () => fixture(({ root, run }) => {
  const home = join(root, 'home with spaces'); run(home);
  const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
  const hooks = settings.hooks.PreToolUse
    .filter(rule => new RegExp(`^(?:${rule.matcher})$`).test('Bash'))
    .flatMap(rule => rule.hooks);
  assert.equal(hooks.length, 4);
  const payload = JSON.stringify({ session_id: 'installation-test', hook_event_name: 'PreToolUse', cwd: root, tool_name: 'Bash', tool_input: { command } });
  const guards = hooks.map(h => /guard-(?:sql|secrets|config|destructive)/.exec(h.command)?.[0]);
  assert.deepEqual([...guards].sort(), ['guard-config', 'guard-destructive', 'guard-secrets', 'guard-sql']);
  for (let i = 0; i < hooks.length; i++) {
    assert.equal(hooks[i].type, 'command');
    const r = spawnSync(hooks[i].command, {
      shell: true, cwd: root, input: payload, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, AIWF_APPROVAL_DIR: join(root, 'isolated-approvals') },
    });
    assert.equal(r.error, undefined);
    const expected = guards[i] === blockedBy ? 2 : 0;
    assert.equal(r.status, expected, `${guards[i]}: ${r.stderr}`);
    if (expected === 2) assert.ok(r.stderr.includes(`[${guards[i]}]`), r.stderr);
  }
}));

if (!ps && process.platform !== 'win32') {
  for (const name of ['home-$AIWF_TEST_PATH', 'home-`printf changed`', 'home-"quoted"', "home-'single'"]) {
    test(`POSIX installed hook treats path literally: ${name}`, () => fixture(({ root, run }) => {
      const home = join(root, name); run(home);
      const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
      const commands = settings.hooks.PreToolUse.flatMap(rule => rule.hooks.map(h => h.command));
      assert.equal(commands.length, 4);
      for (const command of commands) {
        const r = spawnSync(command, {
          shell: true, cwd: root, encoding: 'utf8', timeout: 10000,
          env: { ...process.env, AIWF_TEST_PATH: 'expanded-not-literal' },
          input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'pwd' }, cwd: root }),
        });
        assert.equal(r.error, undefined); assert.equal(r.status, 0, r.stderr);
      }
    }));
  }
}
