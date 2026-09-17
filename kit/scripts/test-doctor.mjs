#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inspectSettings } from './doctor.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const source = JSON.parse(readFileSync(resolve(here, '../claude/settings.json'), 'utf8'));
const clone = () => structuredClone(source);
const temp = mkdtempSync(join(tmpdir(), 'aiwf doctor-'));
let count = 0;
function test(name, fn) { fn(); count++; console.log(`PASS ${name}`); }
function finding(edit, id) { const s = clone(); edit(s); const r = inspectSettings(s, { template: true }); assert(r.findings.some(f => f.id === id), JSON.stringify(r)); assert.notEqual(r.status, 'static-pass'); }
// Hooks are located by their placeholder, not by position: one entry can hold several hooks.
const TOKENS = { '{{GUARD_SQL_COMMAND}}': 'guard-sql', '{{GUARD_SECRETS_COMMAND}}': 'guard-secrets', '{{GUARD_CONFIG_COMMAND}}': 'guard-config', '{{GUARD_DESTRUCTIVE_COMMAND}}': 'guard-destructive' };
const POS = {};
source.hooks.PreToolUse.forEach((e, i) => e.hooks.forEach((h, j) => { if (TOKENS[h.command]) POS[TOKENS[h.command]] = [i, j]; }));
const hookOf = (s, name) => s.hooks.PreToolUse[POS[name][0]].hooks[POS[name][1]];
function cli(args) { return spawnSync(process.execPath, [join(here, 'doctor.mjs'), ...args], { encoding: 'utf8' }); }
try {
  test('valid kit passes scoped checks and host remains unverified', () => { const r = inspectSettings(clone(), { template: true }); assert.equal(r.status, 'static-pass'); assert.equal(r.hostVerification, 'not-performed'); });
  test('legacy ask mode rejected', () => finding(s => s.permissions.defaultMode = 'ask', 'mode.value'));
  test('top-level auto disable rejected', () => finding(s => s.disableAutoMode = true, 'mode.location'));
  test('boolean bypass disable rejected', () => finding(s => s.permissions.disableBypassPermissionsMode = true, 'mode.disableBypassPermissionsMode'));
  test('missing auto disable rejected', () => finding(s => delete s.permissions.disableAutoMode, 'mode.disableAutoMode'));
  test('valid alternative mode is distinguished from kit profile', () => finding(s => s.permissions.defaultMode = 'acceptEdits', 'mode.profile'));
  test('unconsulted Write path rule rejected', () => finding(s => s.permissions.deny.push('Write(.env)'), 'permissions.write-path'));
  test('invalid rule list rejected without throwing', () => finding(s => s.permissions.allow = [null], 'permissions.allow'));
  test('disabled hooks rejected', () => finding(s => s.disableAllHooks = true, 'hooks.disabled'));
  test('missing PreToolUse rejected', () => finding(s => delete s.hooks.PreToolUse, 'hooks.missing'));
  test('invalid matcher rejected', () => finding(s => s.hooks.PreToolUse[0].matcher = '[', 'hooks.matcher'));
  test('SQL matcher missing PowerShell is caught', () => finding(s => s.hooks.PreToolUse[0].matcher = '^Bash$', 'guard-sql.coverage'));
  test('every guard placeholder is present in the template', () => assert.deepEqual(Object.keys(POS).sort(), Object.values(TOKENS).sort()));
  test('destructive matcher missing PowerShell is caught', () => finding(s => s.hooks.PreToolUse[POS['guard-destructive'][0]].matcher = '^Bash$', 'guard-destructive.coverage'));
  test('missing destructive guard is not silently passed', () => finding(s => s.hooks.PreToolUse[POS['guard-destructive'][0]].hooks.splice(POS['guard-destructive'][1], 1), 'guard-destructive.registration'));
  test('duplicate PreToolUse matcher rejected', () => finding(s => s.hooks.PreToolUse.push({ matcher: s.hooks.PreToolUse[POS['guard-destructive'][0]].matcher, hooks: [] }), 'hooks.duplicate-matcher'));
  test('template has one entry per matcher', () => { const m = source.hooks.PreToolUse.map(e => e.matcher); assert.equal(new Set(m).size, m.length); });
  test('async guard cannot count as a verified gate', () => finding(s => s.hooks.PreToolUse[0].hooks[0].async = true, 'guard-sql.execution'));
  test('zero timeout rejected', () => finding(s => s.hooks.PreToolUse[0].hooks[0].timeout = 0, 'guard-sql.timeout'));
  test('custom command is incomplete, never falsely passed', () => { const s = clone(); s.hooks.PreToolUse[0].hooks[0].command = 'custom-check'; assert.equal(inspectSettings(s, { template: true }).status, 'incomplete'); });
  test('null document rejected', () => assert.equal(inspectSettings(null).status, 'error'));
  mkdirSync(join(temp, 'hooks'));
  for (const n of ['guard-sql', 'guard-secrets', 'guard-config', 'guard-destructive']) writeFileSync(join(temp, 'hooks', n + '.mjs'), '// intentionally not executed\n');
  const installed = clone();
  for (const n of ['guard-sql', 'guard-secrets', 'guard-config', 'guard-destructive']) hookOf(installed, n).command = `node "${join(temp, 'hooks', n + '.mjs')}"`;
  installed.hooks.ConfigChange.find(e => e.matcher === 'user_settings').hooks[0].command = `node "${join(temp, 'hooks', 'guard-config.mjs')}"`;
  test('standard installed commands with spaces recognized', () => assert.equal(inspectSettings(installed, { claudeHome: temp }).status, 'static-pass'));
  test('installed placeholders rejected', () => assert(inspectSettings(clone(), { claudeHome: temp }).findings.some(f => f.id === 'hooks.placeholder')));
  test('missing registered file rejected', () => { rmSync(join(temp, 'hooks', 'guard-sql.mjs')); assert(inspectSettings(installed, { claudeHome: temp }).findings.some(f => f.id === 'guard-sql.file')); writeFileSync(join(temp, 'hooks', 'guard-sql.mjs'), '// stub'); });
  test('PowerShell installer command format recognized', () => { const s = clone(); for (const n of ['guard-sql','guard-secrets','guard-config']) { writeFileSync(join(temp,'hooks',n+'.ps1'), '# not executed'); hookOf(s, n).command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${join(temp,'hooks',n+'.ps1').replaceAll('\\','/')}"`; }
    // guard-destructive has no .ps1 port yet, so the PowerShell installer registers it with node.
    hookOf(s, 'guard-destructive').command = hookOf(installed, 'guard-destructive').command;
    s.hooks.ConfigChange.find(e => e.matcher === 'user_settings').hooks[0].command = hookOf(s, 'guard-config').command;
    assert.equal(inspectSettings(s,{claudeHome:temp}).status,'static-pass'); });
  test('PowerShell 7 installer command format recognized', () => { const s = clone(); for (const n of ['guard-sql','guard-secrets','guard-config']) { writeFileSync(join(temp,'hooks',n+'.ps1'), '# not executed'); hookOf(s, n).command = `pwsh -NoProfile -ExecutionPolicy Bypass -File "${join(temp,'hooks',n+'.ps1').replaceAll('\\','/')}"`; }
    // guard-destructive has no .ps1 port yet, so the PowerShell installer registers it with node.
    hookOf(s, 'guard-destructive').command = hookOf(installed, 'guard-destructive').command;
    s.hooks.ConfigChange.find(e => e.matcher === 'user_settings').hooks[0].command = hookOf(s, 'guard-config').command;
    assert.equal(inspectSettings(s,{claudeHome:temp}).status,'static-pass'); });
  test('CLI never executes malicious configured command or changes settings', () => {
    const s = clone(); const sentinel = join(temp, 'executed');
    hookOf(s, 'guard-sql').command = `node -e "require('fs').writeFileSync('${sentinel.replaceAll('\\','/')}','bad')"`;
    for (const n of ['guard-secrets', 'guard-config', 'guard-destructive']) hookOf(s, n).command = hookOf(installed, n).command;
    s.hooks.ConfigChange.find(e => e.matcher === 'user_settings').hooks[0].command = installed.hooks.ConfigChange.find(e => e.matcher === 'user_settings').hooks[0].command;
    const bytes = JSON.stringify(s); writeFileSync(join(temp, 'settings.json'), bytes);
    const r = cli(['--claude-home', temp, '--json']); assert.equal(r.status, 2); assert.equal(JSON.parse(r.stdout).hostVerification, 'not-performed'); assert(!existsSync(sentinel)); assert.equal(readFileSync(join(temp,'settings.json'),'utf8'),bytes);
  });
  test('malformed input is redacted', () => { writeFileSync(join(temp,'settings.json'), '{"secret": "SENTINEL_PRIVATE_VALUE",'); const r=cli(['--claude-home',temp,'--json']); assert.equal(r.status,1); assert(!r.stdout.includes('SENTINEL_PRIVATE_VALUE')); assert(!r.stderr.includes('SENTINEL_PRIVATE_VALUE')); });
  test('missing settings returns failure', () => { rmSync(join(temp,'settings.json')); assert.equal(cli(['--claude-home',temp]).status,1); });
  test('unknown options return failure', () => assert.equal(cli(['--wat']).status,1));
  test('missing option value returns failure', () => assert.equal(cli(['--claude-home','--json']).status,1));
  test('conflicting modes return failure', () => assert.equal(cli(['--template','--claude-home',temp]).status,1));
  test('template CLI can gate CI', () => assert.equal(cli(['--template','--json']).status,0));
  console.log(`\npass: ${count} fail: 0`);
} finally { rmSync(temp, { recursive: true, force: true }); }
