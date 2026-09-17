#!/usr/bin/env node
/**
 * test-guard-config.mjs — Test suite for guard-config.mjs. Run after any change.
 *
 * Feeds crafted PreToolUse payloads to the hook and asserts the exit code.
 * Exit 2 means blocked, exit 0 means allowed. AIWF_CLAUDE_HOME points the
 * hook at a throwaway directory so the test never touches a real ~/.claude.
 *
 *   node kit/scripts/test-guard-config.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

function callHook(toolName, toolInput) {
  const payload = JSON.stringify({
    session_id: 'test',
    hook_event_name: 'PreToolUse',
    cwd: process.cwd(),
    tool_name: toolName,
    tool_input: toolInput,
  });

  const r = spawnSync(process.execPath, [HOOK], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, AIWF_CLAUDE_HOME: CLAUDE_HOME },
  });
  return { code: r.status, out: (r.stderr || '') + (r.stdout || '') };
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

console.log('\nmust allow:');
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

rmSync(CLAUDE_HOME, { recursive: true, force: true });

console.log(`\npass: ${pass}   fail: ${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
