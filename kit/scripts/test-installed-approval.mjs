#!/usr/bin/env node
// Integration regression: the installed approval writer and configured SQL hook
// must agree on the token format. Payloads are never sent to a database.
import { readTestTargetOptions } from './parse-test-target-options.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scripts = dirname(fileURLToPath(import.meta.url));
const { target, pwsh } = readTestTargetOptions();
const ps = target === 'ps';
const extension = ps ? 'ps1' : 'mjs';
test('installed writer and registered hook share exact, single-use approval', () => {
  const root = mkdtempSync(join(tmpdir(), 'aiwf-installed-approval-'));
  const home = join(root, 'claude home');
  const env = { ...process.env, AIWF_APPROVAL_DIR: join(root, 'approvals') };
  // This installs for real, so it reaches install.ps1's ShouldProcess calls. Say
  // non-interactive rather than lean on $ConfirmPreference still being 'High' --
  // lower it and the same call blocks on a prompt with a console attached, or dies
  // as a NullReferenceException without one. It has to go through a wrapper: with
  // powershell.exe -File the argument -Confirm:$false arrives as the literal string
  // "$false" and will not bind to a SwitchParameter. Inside a script it is evaluated.
  const installWrapper = join(root, 'install-wrapper.ps1');
  writeFileSync(installWrapper, "param([string]$Installer, [string]$Dest)\n& $Installer -ClaudeHome $Dest -Hook powershell -Confirm:$false\nexit $LASTEXITCODE\n");
  const run = (file, args = []) => spawnSync(process.execPath, [file, ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 15000,
  });
  try {
    const installed = ps
      ? spawnSync(pwsh, ['-NoProfile', '-File', installWrapper, '-Installer', resolve(scripts, 'install.ps1'), '-Dest', home], { cwd: root, env, encoding: 'utf8', timeout: 15000 })
      : run(resolve(scripts, 'install.mjs'), ['--claude-home', home]);
    assert.equal(installed.status, 0, installed.stderr);
    const diagnosed = run(resolve(scripts, 'doctor.mjs'), ['--claude-home', home]);
    assert.equal(diagnosed.status, 0, diagnosed.stdout + diagnosed.stderr);
    const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    const registration = settings.hooks.PreToolUse.find(entry =>
      entry.hooks.some(hook => hook.command.includes(`guard-sql.${extension}`)));
    assert.ok(registration);
    assert.match('mcp__postgres__execute_sql', new RegExp(registration.matcher));
    const command = registration.hooks.find(hook => hook.command.includes(`guard-sql.${extension}`)).command;
    const sql = "create table approval_probe (note text default 'a  b')";
    const check = query => spawnSync(command, {
      shell: true, cwd: root, env, encoding: 'utf8', timeout: 15000,
      input: JSON.stringify({ tool_name: 'mcp__postgres__execute_sql', tool_input: { query } }),
    });
    assert.equal(check(sql).status, 2, 'unapproved DDL must stop');
    const sqlFile = join(root, 'reviewed.sql');
    writeFileSync(sqlFile, sql);
    const approved = ps
      ? spawnSync(pwsh, ['-NoProfile', '-File', join(home, 'scripts', 'approve-ddl.ps1'), '-Path', sqlFile, '-Force'], { cwd: root, env, encoding: 'utf8', timeout: 15000 })
      : run(join(home, 'scripts', 'approve-ddl.mjs'), ['--force', sql]);
    assert.equal(approved.status, 0, approved.stderr);
    assert.equal(check(sql.replace('a  b', 'a b')).status, 2, 'changed literal must stop');
    assert.equal(check(sql).status, 0, 'exact statement must pass once');
    assert.equal(check(sql).status, 2, 'consumed approval must stop');
    const secretRegistration = settings.hooks.PreToolUse.find(entry =>
      entry.hooks.some(hook => hook.command.includes(`guard-secrets.${extension}`)));
    assert.ok(secretRegistration, 'installed secret guard must be registered');
    const secretCommand = secretRegistration.hooks.find(hook => hook.command.includes(`guard-secrets.${extension}`)).command;
    for (const tool of ['Bash', 'PowerShell']) {
      assert.match(tool, new RegExp(secretRegistration.matcher));
      for (const [file, expected] of [['.env', 2], ['.env.example', 0], ['README.md', 0]]) {
        const checked = spawnSync(secretCommand, {
          shell: true, cwd: root, env, encoding: 'utf8', timeout: 15000,
          input: JSON.stringify({ tool_name: tool, tool_input: { command: `${tool === 'Bash' ? 'cat' : 'Get-Content'} ${file}` } }),
        });
        assert.equal(checked.status, expected, `${tool} ${file}: ${checked.stderr}`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
