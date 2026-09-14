#!/usr/bin/env node
/**
 * test-guard-secrets.mjs — Test suite for the guard-secrets hook.
 *
 * Feeds crafted PreToolUse payloads to the hook and asserts the exit code.
 * Exit 2 means blocked, exit 0 means allowed.
 *
 * The same cases are used against both implementations, so they cannot drift.
 *   node test-guard-secrets.mjs                        -> guard-secrets.mjs
 *   node test-guard-secrets.mjs --target ps            -> guard-secrets.ps1 via pwsh
 *   node test-guard-secrets.mjs --target ps --pwsh powershell.exe
 *
 * The "must allow" half matters more than the "must block" half. This hook sits
 * in front of every shell call there is; if it fires on `cat README.md` it gets
 * switched off within a day, and then nothing is guarded at all.
 */

import { readTestTargetOptions } from './parse-test-target-options.mjs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const { target: targetArg, pwsh: pwshExe } = readTestTargetOptions();

const HOOK_MJS = resolve(here, '..', 'claude', 'hooks', 'guard-secrets.mjs');
const HOOK_PS1 = resolve(here, '..', 'claude', 'hooks', 'guard-secrets.ps1');

function invocation() {
  if (targetArg === 'ps') {
    return [pwshExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HOOK_PS1]];
  }
  return [process.execPath, [HOOK_MJS]];
}

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

  const [exe, args] = invocation();
  const r = spawnSync(exe, args, { input: payload, encoding: 'utf8' });
  return { code: r.status, out: (r.stderr || '') + (r.stdout || '') };
}

function assert(name, expected, result) {
  if (result.code === expected) {
    console.log(`  PASS  ${name}`);
    pass++;
  } else {
    console.log(`  FAIL  ${name} (expected ${expected}, got ${result.code})`);
    console.log(`        ${(result.out || '').replace(/\r?\n/g, ' ').slice(0, 200)}`);
    fail++;
  }
}

console.log(`\nguard-secrets test suite (${targetArg === 'ps' ? 'powershell' : 'node'})\n`);

console.log('must block:');
assert('cat .env', BLOCK, callHook('Bash', { command: 'cat .env' }));
assert('head -1 .env', BLOCK, callHook('Bash', { command: 'head -1 .env' }));
assert('sed over .env', BLOCK, callHook('Bash', { command: "sed -n '1,5p' .env" }));
assert('nested path .env.local', BLOCK, callHook('Bash', { command: 'cat apps/web/.env.local' }));
assert('source .env', BLOCK, callHook('Bash', { command: 'source .env' }));
assert('dot-source .env', BLOCK, callHook('Bash', { command: '. .env' }));
assert('python -c open(.env)', BLOCK,
  callHook('Bash', { command: 'python -c "print(open(\'.env\').read())"' }));
// The reader is `cat`, so this would be caught anyway; the pair below isolates
// the redirect rule with a command that is not a reader on its own.
assert('cat < .env', BLOCK, callHook('Bash', { command: 'cat < .env' }));
assert('input redirect only', BLOCK, callHook('Bash', { command: 'node < .env' }));
assert('command substitution', BLOCK, callHook('Bash', { command: 'export KEY=$(cat .env)' }));
assert('second in a pipeline', BLOCK, callHook('Bash', { command: 'cat .env | head -5' }));
assert('grep over .env', BLOCK, callHook('Bash', { command: 'grep KEY .env' }));
assert('private key', BLOCK, callHook('Bash', { command: 'cat certs/server.pem' }));
assert('ssh key', BLOCK, callHook('Bash', { command: 'cat ~/.ssh/id_rsa' }));
assert('service account json', BLOCK,
  callHook('Bash', { command: 'cat config/service-account-prod.json' }));
assert('secrets directory', BLOCK, callHook('Bash', { command: 'cat secrets/stripe.key' }));
// git prints file contents, and this is one move rather than two.
assert('git show', BLOCK, callHook('Bash', { command: 'git show HEAD:.env' }));
assert('git diff a path', BLOCK, callHook('Bash', { command: 'git diff .env' }));
assert('git log -p', BLOCK, callHook('Bash', { command: 'git log -p .env' }));
assert('git cat-file', BLOCK, callHook('Bash', { command: 'git cat-file -p HEAD:.env' }));
assert('git blame', BLOCK, callHook('Bash', { command: 'git blame .env' }));
assert('git -C then show', BLOCK, callHook('Bash', { command: 'git -C /srv/app show HEAD:.env' }));
assert('PowerShell Get-Content', BLOCK, callHook('PowerShell', { command: 'Get-Content .env' }));
assert('PowerShell Select-String', BLOCK,
  callHook('PowerShell', { command: 'Select-String -Path .env -Pattern KEY' }));
assert('PowerShell type', BLOCK, callHook('PowerShell', { command: 'type .env' }));
assert('PowerShell .NET read', BLOCK,
  callHook('PowerShell', { command: "[System.IO.File]::ReadAllText('.env')" }));

// Public-template words in a parent directory do not exempt the actual file.
assert('template-like parent still protects dotenv', BLOCK,
  callHook('Bash', { command: 'cat .env.example.cache/.env' }));
assert('Windows template-like parent still protects dotenv', BLOCK,
  callHook('PowerShell', { command: String.raw`Get-Content C:\Dev\.env.sample.assets\.env.local` }));
assert('template inside dotenv-named parent remains public', ALLOW,
  callHook('Bash', { command: 'cat .env.private/.env.example' }));
assert('nested template suffix remains public', ALLOW,
  callHook('Bash', { command: 'cat config/.env.production.sample' }));

// Native Windows executable names must retain reader detection.
assert('git.exe show secret', BLOCK, callHook('PowerShell', { command: 'git.exe show HEAD:.env' }));
assert('absolute git.exe path', BLOCK, callHook('PowerShell', { command: String.raw`C:\Tools\git.exe diff .env` }));
assert('python.exe inline secret read', BLOCK,
  callHook('PowerShell', { command: `python.exe -c "print(open('.env').read())"` }));
assert('uppercase executable suffix', BLOCK, callHook('PowerShell', { command: 'CAT.EXE .env' }));
assert('git.exe add allowed', ALLOW, callHook('PowerShell', { command: 'git.exe add .env' }));
assert('cat.exe public template allowed', ALLOW, callHook('PowerShell', { command: 'cat.exe .env.example' }));

// Windows path separators must retain the same secret classification.
assert('Windows secrets config', BLOCK,
  callHook('PowerShell', { command: String.raw`Get-Content C:\Dev\app\secrets\prod.yaml` }));
assert('Windows ssh directory', BLOCK,
  callHook('PowerShell', { command: String.raw`Get-Content C:\Users\dev\.ssh\config` }));
assert('Windows code under secrets', ALLOW,
  callHook('PowerShell', { command: String.raw`Get-Content C:\Dev\app\secrets\masker.ts` }));
assert('Windows prose under secrets', ALLOW,
  callHook('PowerShell', { command: String.raw`Get-Content C:\Dev\app\secrets\README.md` }));

console.log('\nmust allow:');
assert('.env.example', ALLOW, callHook('Bash', { command: 'cat .env.example' }));
assert('.env.sample', ALLOW, callHook('Bash', { command: 'cat .env.sample' }));
assert('.env.template', ALLOW, callHook('Bash', { command: 'cat .env.template' }));
assert('copying the example', ALLOW, callHook('Bash', { command: 'cp .env.example .env' }));
assert('appending to .env', ALLOW, callHook('Bash', { command: 'echo "KEY=1" >> .env' }));
assert('vercel env pull', ALLOW, callHook('Bash', { command: 'vercel env pull .env.local' }));
assert('deleting a backup', ALLOW, callHook('Bash', { command: 'rm .env.bak' }));
assert('git status', ALLOW, callHook('Bash', { command: 'git status' }));
// Naming the path is not printing it, and a subcommand word inside a commit
// message is not a subcommand.
assert('git log --oneline', ALLOW, callHook('Bash', { command: 'git log --oneline -5' }));
assert('git checkout a path', ALLOW, callHook('Bash', { command: 'git checkout .env' }));
assert('git add a path', ALLOW, callHook('Bash', { command: 'git add .env' }));
assert('subcommand word in a message', ALLOW,
  callHook('Bash', { command: 'git commit -m "document the .env format"' }));
// secrets/ came from the deny list and is too wide on its own: code that
// handles secrets is not a secret.
assert('code under secrets/', ALLOW, callHook('Bash', { command: 'cat src/lib/secrets/masker.ts' }));
assert('nested code under secrets/', ALLOW,
  callHook('Bash', { command: 'cat src/lib/secrets/util/mask.ts' }));
assert('prose under secrets/', ALLOW, callHook('Bash', { command: 'cat secrets/README.md' }));
assert('ls -la', ALLOW, callHook('Bash', { command: 'ls -la' }));
assert('cat README.md', ALLOW, callHook('Bash', { command: 'cat README.md' }));
assert('grep over src', ALLOW, callHook('Bash', { command: 'grep -r createClient src/' }));
assert('npm run build', ALLOW, callHook('Bash', { command: 'npm run build' }));
// `env` is a common word. Neither of these is a dotfile, and neither may match.
assert('src/lib/env.ts', ALLOW, callHook('Bash', { command: 'cat src/lib/env.ts' }));
assert('docs/environment.md', ALLOW, callHook('Bash', { command: 'cat docs/environment.md' }));
// Writing to a secret file is not reading it.
assert('PowerShell Set-Content', ALLOW,
  callHook('PowerShell', { command: 'Set-Content .env "KEY=1"' }));
assert('PowerShell reads a doc', ALLOW,
  callHook('PowerShell', { command: 'Get-Content README.md' }));
assert('unrelated MCP tool', ALLOW,
  callHook('mcp__GitHub__search_code', { query: 'cat .env' }));
assert('empty input', ALLOW, callHook('Bash', { command: '' }));

console.log(`\npass: ${pass}   fail: ${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
