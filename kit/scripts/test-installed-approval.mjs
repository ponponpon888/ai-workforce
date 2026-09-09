#!/usr/bin/env node
// Integration regression: the installed approval writer and configured SQL hook
// must agree on the token format. Payloads are never sent to a database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scripts = dirname(fileURLToPath(import.meta.url));
test('installed writer and registered hook share exact, single-use approval', () => {
  const root = mkdtempSync(join(tmpdir(), 'aiwf-installed-approval-'));
  const home = join(root, 'claude home');
  const env = { ...process.env, AIWF_APPROVAL_DIR: join(root, 'approvals') };
  const run = (file, args = []) => spawnSync(process.execPath, [file, ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 15000,
  });
  try {
    const installed = run(resolve(scripts, 'install.mjs'), ['--claude-home', home]);
    assert.equal(installed.status, 0, installed.stderr);
    const diagnosed = run(resolve(scripts, 'doctor.mjs'), ['--claude-home', home]);
    assert.equal(diagnosed.status, 0, diagnosed.stdout + diagnosed.stderr);
    const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    const registration = settings.hooks.PreToolUse.find(entry =>
      entry.hooks.some(hook => hook.command.includes('guard-sql.mjs')));
    assert.ok(registration);
    assert.match('mcp__postgres__execute_sql', new RegExp(registration.matcher));
    const command = registration.hooks.find(hook => hook.command.includes('guard-sql.mjs')).command;
    const sql = "create table approval_probe (note text default 'a  b')";
    const check = query => spawnSync(command, {
      shell: true, cwd: root, env, encoding: 'utf8', timeout: 15000,
      input: JSON.stringify({ tool_name: 'mcp__postgres__execute_sql', tool_input: { query } }),
    });
    assert.equal(check(sql).status, 2, 'unapproved DDL must stop');
    const approved = run(join(home, 'scripts', 'approve-ddl.mjs'), ['--force', sql]);
    assert.equal(approved.status, 0, approved.stderr);
    assert.equal(check(sql.replace('a  b', 'a b')).status, 2, 'changed literal must stop');
    assert.equal(check(sql).status, 0, 'exact statement must pass once');
    assert.equal(check(sql).status, 2, 'consumed approval must stop');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
