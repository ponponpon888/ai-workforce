#!/usr/bin/env node
/**
 * test-guard-config.mjs — Test suite for guard-config.mjs. Run after any change.
 *
 * Feeds crafted PreToolUse and ConfigChange payloads to the hook and asserts
 * the exit code. Exit 2 means blocked, exit 0 means allowed. AIWF_CLAUDE_HOME
 * points the hook at a throwaway directory so the test never touches a real
 * ~/.claude.
 *
 *   node kit/scripts/test-guard-config.mjs
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(here, '..', 'claude', 'hooks', 'guard-config.mjs');

// A real directory, so path handling is exercised the same way it would be
// against a real claude home, even though this hook only pattern-matches
// text and never touches the filesystem itself.
const CLAUDE_HOME = mkdtempSync(join(tmpdir(), 'aiwf-cfg-test-'));

const BLOCK = 2;
const ALLOW = 0;

let pass = 0;
let fail = 0;

function runHook(payload) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, AIWF_CLAUDE_HOME: CLAUDE_HOME },
  });
  return { code: r.status, out: (r.stderr || '') + (r.stdout || '') };
}

function callHook(toolName, toolInput) {
  return runHook({
    session_id: 'test',
    hook_event_name: 'PreToolUse',
    cwd: process.cwd(),
    tool_name: toolName,
    tool_input: toolInput,
  });
}

function callConfigChange(source) {
  const payload = { session_id: 'test', hook_event_name: 'ConfigChange' };
  if (source !== undefined) payload.config_source = source;
  return runHook(payload);
}

function callSessionStart(startupType, { home = CLAUDE_HOME } = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      session_id: 'test',
      hook_event_name: 'SessionStart',
      ...(startupType !== undefined ? { startup_type: startupType } : {}),
    }),
    encoding: 'utf8',
    env: { ...process.env, AIWF_CLAUDE_HOME: home },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function assert(name, expected, result) {
  if (result.code === expected) {
    console.log(`  PASS  ${name}`);
    pass++;
  } else {
    console.log(`  FAIL  ${name} (expected ${expected}, got ${result.code})`);
    console.log(`        ${result.out.replace(/\r?\n/g, ' ').slice(0, 200)}`);
    fail++;
  }
}

const settingsPath = join(CLAUDE_HOME, 'settings.json');
const claudeMdPath = join(CLAUDE_HOME, 'CLAUDE.md');
const hookPath = join(CLAUDE_HOME, 'hooks', 'guard-sql.mjs');
const approvalPath = join(CLAUDE_HOME, 'approvals', 'deadbeef.approval');
const scriptPath = join(CLAUDE_HOME, 'scripts', 'approve-ddl.mjs');

console.log('\nguard-config test suite (node)\n');

console.log('must block — Edit/Write tools:');
assert('Write settings.json', BLOCK, callHook('Write', { file_path: settingsPath, content: '{}' }));
assert('Edit CLAUDE.md', BLOCK, callHook('Edit', { file_path: claudeMdPath, old_string: 'x', new_string: 'y' }));
assert('Edit a hook file', BLOCK, callHook('Edit', { file_path: hookPath, old_string: 'x', new_string: 'y' }));
assert('Write an approval token directly', BLOCK, callHook('Write', { file_path: approvalPath, content: 'select 1' }));
assert('Edit approve-ddl.mjs itself', BLOCK, callHook('Edit', { file_path: scriptPath, old_string: 'x', new_string: 'y' }));
assert('Write the known-good SessionStart baseline directly', BLOCK, callHook('Write', { file_path: join(CLAUDE_HOME, 'known-good', 'settings.json'), content: '{}' }));

console.log('\nmust block — shell commands:');
assert('rm on a hook file', BLOCK, callHook('Bash', { command: `rm ${hookPath}` }));
assert('output redirection into settings.json', BLOCK, callHook('Bash', { command: `echo bad > ${settingsPath}` }));
assert('append redirection into CLAUDE.md', BLOCK, callHook('Bash', { command: `echo bad >> ${claudeMdPath}` }));
assert('cp writing an approval file', BLOCK, callHook('Bash', { command: `cp /tmp/x ${approvalPath}` }));
assert('sed -i editing CLAUDE.md', BLOCK, callHook('Bash', { command: `sed -i 's/x/y/' ${claudeMdPath}` }));
assert('PowerShell Set-Content on CLAUDE.md', BLOCK, callHook('PowerShell', { command: `Set-Content ${claudeMdPath} -Value 'x'` }));
assert('PowerShell Remove-Item on an approval', BLOCK, callHook('PowerShell', { command: `Remove-Item ${approvalPath}` }));
assert('a wrapper in front does not hide it', BLOCK, callHook('Bash', { command: `cd /tmp && rm ${hookPath}` }));
assert('a subshell-style chain does not hide it', BLOCK, callHook('Bash', { command: `echo hi; rm ${settingsPath}` }));

console.log('\nmust allow — Edit/Write tools and shell commands:');
assert('Edit an unrelated project file', ALLOW, callHook('Edit', { file_path: '/home/user/project/src/index.ts', old_string: 'x', new_string: 'y' }));
assert('Write to a project scripts/ dir with the same name', ALLOW, callHook('Write', { file_path: '/home/user/project/scripts/build.mjs', content: 'x' }));
assert('reading settings.json is fine', ALLOW, callHook('Bash', { command: `cat ${settingsPath}` }));
assert('rm on an unrelated scripts dir', ALLOW, callHook('Bash', { command: 'rm ./scripts/build.sh' }));
assert('cp between two unrelated files', ALLOW, callHook('Bash', { command: 'cp foo.txt bar.txt' }));
assert('redirection to an unrelated file', ALLOW, callHook('Bash', { command: 'echo hello > /tmp/output.txt' }));
assert('non-write Bash command', ALLOW, callHook('Bash', { command: 'npm run build' }));
assert('unrelated MCP tool', ALLOW, callHook('mcp__GitHub__search_code', { query: 'settings.json' }));
assert('empty command', ALLOW, callHook('Bash', { command: '' }));
assert('empty input', ALLOW, callHook('Bash', {}));

console.log('\nConfigChange:');
assert('user_settings change is blocked', BLOCK, callConfigChange('user_settings'));
assert('user_settings change is blocked even with no config_source field', BLOCK, callConfigChange(undefined));
assert('project_settings change is not this hook\'s concern', ALLOW, callConfigChange('project_settings'));
assert('local_settings change is not this hook\'s concern', ALLOW, callConfigChange('local_settings'));
assert('skills change is not this hook\'s concern', ALLOW, callConfigChange('skills'));

console.log('\nSessionStart:');
{
  // Its own throwaway home per case, distinct from CLAUDE_HOME above: these
  // tests read and write settings.json / known-good/settings.json on disk,
  // which the PreToolUse/ConfigChange cases above never touch.
  function freshHome() {
    const home = mkdtempSync(join(tmpdir(), 'aiwf-cfg-session-'));
    writeFileSync(join(home, 'settings.json'), '{"hooks":{}}');
    return home;
  }

  {
    const home = freshHome();
    const r = callSessionStart('startup', { home });
    assert('exits 0 (SessionStart can never block, even on first run)', ALLOW, r);
    if (r.code === 0) {
      const baseline = join(home, 'known-good', 'settings.json');
      if (!existsSync(baseline)) { console.log('  FAIL  first run records a baseline'); fail++; }
      else if (!readFileSync(baseline).equals(readFileSync(join(home, 'settings.json')))) { console.log('  FAIL  recorded baseline matches current settings.json'); fail++; }
      else { console.log('  PASS  first run records a baseline matching current settings.json'); pass++; }
      if (!r.out.includes('"additionalContext"') || !/baseline recorded for the first time/.test(r.out)) { console.log('  FAIL  first run surfaces an informational (not alarming) context note'); fail++; }
      else { console.log('  PASS  first run surfaces an informational (not alarming) context note'); pass++; }
    }
    rmSync(home, { recursive: true, force: true });
  }

  {
    const home = freshHome();
    callSessionStart('startup', { home }); // establishes the baseline
    const r = callSessionStart('startup', { home });
    assert('second run against an unchanged file exits 0', ALLOW, r);
    if (r.out.trim()) { console.log('  FAIL  second run against an unchanged file says nothing'); fail++; }
    else { console.log('  PASS  second run against an unchanged file says nothing'); pass++; }
    rmSync(home, { recursive: true, force: true });
  }

  {
    const home = freshHome();
    callSessionStart('startup', { home }); // establishes the baseline
    writeFileSync(join(home, 'settings.json'), '{"hooks":{},"tampered":true}');
    const r = callSessionStart('resume', { home });
    assert('a settings.json that no longer matches the baseline still exits 0', ALLOW, r);
    if (!r.out.includes('"additionalContext"') || !/WARNING/.test(r.out)) { console.log('  FAIL  mismatch surfaces a WARNING in additionalContext'); fail++; }
    else { console.log('  PASS  mismatch surfaces a WARNING in additionalContext'); pass++; }
    if (!/hook-007/.test(r.out)) { console.log('  FAIL  warning points at hook-007.json for the background'); fail++; }
    else { console.log('  PASS  warning points at hook-007.json for the background'); pass++; }
    // The baseline itself is left untouched by a mere check -- only
    // record-settings-baseline (run by a human) is allowed to update it.
    const baselineAfter = readFileSync(join(home, 'known-good', 'settings.json'), 'utf8');
    if (baselineAfter.includes('tampered')) { console.log('  FAIL  a mismatch does not silently adopt the new file as the baseline'); fail++; }
    else { console.log('  PASS  a mismatch does not silently adopt the new file as the baseline'); pass++; }
    rmSync(home, { recursive: true, force: true });
  }

  {
    const home = mkdtempSync(join(tmpdir(), 'aiwf-cfg-session-'));
    // No settings.json at all in this home.
    assert('no installed settings.json is not this hook\'s problem', ALLOW, callSessionStart('startup', { home }));
    if (existsSync(join(home, 'known-good'))) { console.log('  FAIL  no baseline directory is created when there is nothing to record'); fail++; }
    else { console.log('  PASS  no baseline directory is created when there is nothing to record'); pass++; }
    rmSync(home, { recursive: true, force: true });
  }

  {
    const home = freshHome();
    assert('clear is not startup or resume; skipped without recording a baseline', ALLOW, callSessionStart('clear', { home }));
    if (existsSync(join(home, 'known-good'))) { console.log('  FAIL  clear does not trigger baseline bootstrap'); fail++; }
    else { console.log('  PASS  clear does not trigger baseline bootstrap'); pass++; }
    rmSync(home, { recursive: true, force: true });
  }

  {
    // A broader/custom registration with no startup_type field at all still
    // runs the check, the same defensive default as ConfigChange's missing
    // config_source above.
    const home = freshHome();
    assert('missing startup_type field still runs the check', ALLOW, callSessionStart(undefined, { home }));
    if (!existsSync(join(home, 'known-good', 'settings.json'))) { console.log('  FAIL  missing startup_type still records a baseline'); fail++; }
    else { console.log('  PASS  missing startup_type still records a baseline'); pass++; }
    rmSync(home, { recursive: true, force: true });
  }
}

// The hook decides what to protect from where it is installed, not from
// ~/.claude alone (hook-013). Every case above sets AIWF_CLAUDE_HOME, which is
// the explicit override, so the derived path needs its own section: a copy of
// the hook placed in a throwaway home, invoked with no override at all.
console.log('\ninstalled elsewhere (no AIWF_CLAUDE_HOME):');
{
  const installedHome = mkdtempSync(join(tmpdir(), 'aiwf-cfg-installed-'));
  mkdirSync(join(installedHome, 'hooks'), { recursive: true });
  const installedHook = join(installedHome, 'hooks', 'guard-config.mjs');
  cpSync(HOOK, installedHook);

  const callInstalled = (filePath) => {
    const env = { ...process.env };
    delete env.AIWF_CLAUDE_HOME;
    const r = spawnSync(process.execPath, [installedHook], {
      input: JSON.stringify({
        session_id: 'test',
        hook_event_name: 'PreToolUse',
        cwd: process.cwd(),
        tool_name: 'Edit',
        tool_input: { file_path: filePath },
      }),
      encoding: 'utf8',
      env,
    });
    return { code: r.status, out: (r.stderr || '') + (r.stdout || '') };
  };

  // Before this was fixed, both of these were allowed: the hook sat in this
  // home, was registered by this home's settings.json, and protected a
  // different directory entirely.
  assert('the settings.json of the home it was installed into', BLOCK,
    callInstalled(join(installedHome, 'settings.json')));
  assert('a hook inside the home it was installed into', BLOCK,
    callInstalled(join(installedHome, 'hooks', 'guard-sql.mjs')));
  // Widening what is refused is safe; narrowing it silently is not. The
  // default home stays protected, which is what the hook did before.
  assert('the default home stays protected as well', BLOCK,
    callInstalled(join(homedir(), '.claude', 'settings.json')));
  assert('an ordinary file is still allowed', ALLOW,
    callInstalled(join(tmpdir(), 'aiwf-cfg-ordinary-notes.txt')));
  // The block message has to name the home that matched, or a person reading
  // it cannot tell which of the two directories they are being stopped from.
  const named = callInstalled(join(installedHome, 'settings.json'));
  if (named.out.includes(installedHome)) { console.log('  PASS  the block message names the matched home'); pass++; }
  else { console.log('  FAIL  the block message names the matched home'); fail++; }

  rmSync(installedHome, { recursive: true, force: true });
}

// The macOS CI failure, in a form every platform can run. tmpdir() there is
// /var/folders/... , a symlink to /private/var/folders/... . Node's ESM loader
// resolves symlinks, so the hook saw only the canonical spelling while the
// settings.json that registered it -- and anything a person would type --
// named the other one. Registering through a symlinked home reproduces it
// without needing that platform.
console.log('\ninstalled behind a symlink:');
{
  const realHome = mkdtempSync(join(tmpdir(), 'aiwf-cfg-real-'));
  mkdirSync(join(realHome, 'hooks'), { recursive: true });
  cpSync(HOOK, join(realHome, 'hooks', 'guard-config.mjs'));
  const linkHome = `${realHome}-link`;
  let linked = true;
  try { symlinkSync(realHome, linkHome, 'dir'); } catch { linked = false; }

  if (!linked) {
    // Windows without developer mode refuses symlinks to unprivileged users.
    // Skipping is honest; claiming a pass we never ran is not.
    console.log('  SKIP  symlinks are not available to this user');
  } else {
    const callVia = (hookPath, filePath) => {
      const env = { ...process.env };
      delete env.AIWF_CLAUDE_HOME;
      const r = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify({
          session_id: 'test',
          hook_event_name: 'PreToolUse',
          cwd: process.cwd(),
          tool_name: 'Edit',
          tool_input: { file_path: filePath },
        }),
        encoding: 'utf8',
        env,
      });
      return { code: r.status, out: (r.stderr || '') + (r.stdout || '') };
    };
    const viaLink = join(linkHome, 'hooks', 'guard-config.mjs');
    // Registered by the spelling with the symlink in it: that spelling is the
    // one an agent is handed, so it is the one that has to be refused.
    assert('the spelling this hook was invoked by', BLOCK,
      callVia(viaLink, join(linkHome, 'settings.json')));
    // And the path it resolves to, which names the same file.
    assert('the spelling it resolves to', BLOCK,
      callVia(viaLink, join(realHome, 'settings.json')));
    assert('an ordinary file behind the symlink is still allowed', ALLOW,
      callVia(viaLink, join(linkHome, 'notes.txt')));
    rmSync(linkHome, { recursive: true, force: true });
  }
  rmSync(realHome, { recursive: true, force: true });
}

rmSync(CLAUDE_HOME, { recursive: true, force: true });

console.log(`\npass: ${pass}   fail: ${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
