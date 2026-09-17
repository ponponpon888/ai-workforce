#!/usr/bin/env node
/**
 * test-guard-destructive.mjs — Test suite for the guard-destructive hook.
 *
 * Feeds crafted PreToolUse payloads to the hook and asserts the exit code.
 * Exit 2 means blocked, exit 0 means allowed.
 *
 *   node kit/scripts/test-guard-destructive.mjs
 *   node kit/scripts/test-guard-destructive.mjs --target ps [--pwsh powershell.exe]
 *
 * --target ps runs the same cases against guard-destructive.ps1. That port
 * does not exist yet; the option is here so the two cannot drift once it
 * does, the same arrangement as test-guard-secrets.mjs.
 *
 * Three groups:
 *   - "deny already covers": forms Anthropic's permissions reference says
 *     Claude Code itself stops. The hook blocks them too; the point of the
 *     group is to keep the hook consistent with the deny list, not to claim
 *     it is the only thing stopping them.
 *   - "deny does not cover": the reason the hook exists.
 *   - "must allow": the half that decides whether anyone keeps the hook
 *     switched on. Commit messages, docs, and greps that merely mention a
 *     dangerous command are the common case, not the edge case.
 */

import { readTestTargetOptions } from './parse-test-target-options.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { target: targetArg, pwsh: pwshExe } = readTestTargetOptions();

const HOOK_MJS = resolve(here, '..', 'claude', 'hooks', 'guard-destructive.mjs');
const HOOK_PS1 = resolve(here, '..', 'claude', 'hooks', 'guard-destructive.ps1');

if (targetArg === 'ps' && !existsSync(HOOK_PS1)) {
  console.log('guard-destructive.ps1 does not exist yet; nothing to test with --target ps.');
  process.exit(1);
}

const BLOCK = 2;
const ALLOW = 0;
let pass = 0;
let fail = 0;

function callHook(toolName, command) {
  const [exe, args] = targetArg === 'ps'
    ? [pwshExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HOOK_PS1]]
    : [process.execPath, [HOOK_MJS]];
  const r = spawnSync(exe, args, {
    input: JSON.stringify({
      session_id: 'test',
      hook_event_name: 'PreToolUse',
      cwd: process.cwd(),
      tool_name: toolName,
      tool_input: { command },
    }),
    encoding: 'utf8',
  });
  return { code: r.status, out: (r.stderr || '') + (r.stdout || '') };
}

function check(expected, toolName, command, name = command) {
  const r = callHook(toolName, command);
  const label = `${toolName === 'PowerShell' ? '[ps] ' : ''}${name.replace(/\n/g, '\\n')}`;
  if (r.code === expected) {
    console.log(`  PASS  ${label}`);
    pass++;
  } else {
    console.log(`  FAIL  ${label} (expected ${expected}, got ${r.code})`);
    console.log(`        ${r.out.replace(/\r?\n/g, ' ').slice(0, 240)}`);
    fail++;
  }
}

const bashBlocks = (cmd, name) => check(BLOCK, 'Bash', cmd, name);
const bashAllows = (cmd, name) => check(ALLOW, 'Bash', cmd, name);
const psBlocks = (cmd, name) => check(BLOCK, 'PowerShell', cmd, name);
const psAllows = (cmd, name) => check(ALLOW, 'PowerShell', cmd, name);

const encoded = (script) => Buffer.from(script, 'utf16le').toString('base64');

console.log(`\nguard-destructive test suite (${targetArg === 'ps' ? 'powershell' : 'node'})\n`);

console.log('deny already covers these (the hook agrees with it):');
bashBlocks('rm -rf build');
bashBlocks('rm -r build');
bashBlocks('cd /tmp && rm -rf x');
bashBlocks('timeout 30 rm -rf x');
bashBlocks('FOO=bar rm -rf tmp/');
bashBlocks('echo hi | xargs rm -rf');
bashBlocks('(cd sub; rm -rf x)');
bashBlocks('for d in a b; do rm -rf "$d"; done');
bashBlocks('echo "$(git clean -fd)"');
bashBlocks('git push --force origin main');
bashBlocks('git reset --hard HEAD~1');
bashBlocks('git branch -D old');
bashBlocks('supabase db reset');
psBlocks('Remove-Item -Recurse -Force build');
psBlocks('Get-ChildItem x | Remove-Item');
psBlocks('git push --force');

console.log('\ndeny does not cover these — program by path or with quotes:');
bashBlocks('/bin/rm -rf build');
bashBlocks('/usr/bin/env rm -rf build');
bashBlocks('\\rm -rf build');
bashBlocks("'rm' -rf build");
bashBlocks('r""m -rf build');
bashBlocks("$'\\x72m' -rf build", "$'\\x72m' -rf build (ANSI-C quoting)");
bashBlocks("git 'push' --force origin main");
bashBlocks('/usr/bin/git push --force');
bashBlocks('"C:/Program Files/Git/cmd/git.exe" push --force');

console.log('\ndeny does not cover these — flag spellings:');
bashBlocks('rm -rfv build');
bashBlocks('rm -fr build');
bashBlocks('rm -Rf build');
bashBlocks('rm -r -f build');
bashBlocks('rm --recursive --force build');
bashBlocks('rm --rec build');
bashBlocks('rm build -rf');
bashBlocks('git push origin main --force');
bashBlocks('git push -uf origin main');
bashBlocks('git push origin +main');
bashBlocks('git push --force-with-lease');
bashBlocks('git push --force-with-lease=main:abc123 origin main');
bashBlocks('git push --mirror backup');
bashBlocks('git reset -q --hard origin/main');
bashBlocks('git clean -xdf');
bashBlocks('git clean -f');
bashBlocks('git clean --force -d');
bashBlocks('git branch --delete --force old');
bashBlocks('git branch -df old');

console.log('\ndeny does not cover these — git global options:');
bashBlocks('git -C . push --force');
bashBlocks('git -C ../other reset --hard');
bashBlocks('git -c push.default=current push -f');
bashBlocks('git --git-dir=.git --work-tree=. clean -fdx');
bashBlocks('git --no-pager branch -D old');
bashBlocks("git -c alias.x='!rm -rf .' x", 'git -c alias.x=... x (inline alias)');
bashBlocks('git -c clean.requireForce=false clean -d');

console.log('\ndeny does not cover these — through a shell or evaluator:');
bashBlocks("bash -c 'rm -rf build'");
bashBlocks('sh -c "rm -r build"');
bashBlocks("bash -lc 'git push --force'");
bashBlocks("bash -o pipefail -c 'git reset --hard'");
bashBlocks("zsh -c 'git clean -fdx'");
bashBlocks("fish --command 'rm -rf build'");
bashBlocks('eval "rm -rf build"');
bashBlocks("echo 'rm -rf build' | bash");
bashBlocks("printf 'git push --force\\n' | sh");
bashBlocks("bash <<'EOF'\nrm -rf build\nEOF", 'bash <<EOF (heredoc to a shell)');
bashBlocks("bash <<< 'rm -rf build'");
bashBlocks("bash -s <<'EOF'\ngit push -f\nEOF", 'bash -s <<EOF');
bashBlocks("echo \"$(bash -c 'rm -rf build')\"");
bashBlocks("echo `sh -c 'rm -rf build'`");
bashBlocks("diff <(bash -c 'rm -rf build') b");
bashBlocks("bash -c \"bash -c 'rm -rf build'\"");
bashBlocks("powershell.exe -NoProfile -Command \"Remove-Item -Recurse -Force build\"");
bashBlocks("pwsh -c 'Remove-Item build'");
bashBlocks(`powershell -EncodedCommand ${encoded('Remove-Item -Recurse build')}`, 'powershell -EncodedCommand <base64 Remove-Item>');
bashBlocks('cmd /c "rd /s /q build"');
bashBlocks('cmd.exe /C del /s /q *.tmp');
bashBlocks("wsl rm -rf build");
bashBlocks("wsl -e rm -rf build");

console.log('\ndeny does not cover these — wrappers and runners:');
bashBlocks('sudo rm -rf /var/tmp/x');
bashBlocks('sudo -u deploy git reset --hard');
bashBlocks('env -i PATH=/bin rm -rf build');
bashBlocks("env -S 'rm -rf build'");
bashBlocks('nice -n 10 rm -rf build');
bashBlocks('nohup git push --force &');
bashBlocks('xargs -n1 rm -rf < dirs.txt');
bashBlocks('find . -name node_modules -exec rm -rf {} +');
bashBlocks('find . -type d -execdir rm -r {} \\;');
bashBlocks('npx rimraf dist');
bashBlocks('npx --yes rimraf dist');
bashBlocks('npx supabase db reset');
bashBlocks('pnpm dlx supabase db reset --linked');
bashBlocks('bunx rimraf dist');
bashBlocks('npm exec -- rimraf dist');
bashBlocks("npx -c 'rm -rf dist'");
bashBlocks('devbox run rm -rf .');
bashBlocks('direnv exec . rm -rf build');
bashBlocks('mise exec node@20 -- rm -rf build');
bashBlocks('uv run --with x rm -rf build');
bashBlocks('busybox rm -rf build');
bashBlocks('watch -n 5 git clean -fdx');
bashBlocks("flock /tmp/lock -c 'rm -rf build'");
bashBlocks('supabase --workdir ./app db reset');
bashBlocks('X=rm; $X -rf build', 'X=rm; $X -rf build (variable as command)');
bashBlocks('FLAGS=-rf; rm $FLAGS build');
bashBlocks('export G=git; $G push --force');
bashBlocks('$(which rm) -rf build');
bashBlocks('`command -v rm` -rf build');

console.log('\ndeny does not cover these — interpreter one-liners:');
bashBlocks(`node -e "require('fs').rmSync('dist', { recursive: true, force: true })"`);
bashBlocks(`node --eval "fs.promises.rm('dist', {recursive:true})"`);
bashBlocks(`python3 -c "import shutil; shutil.rmtree('dist')"`);
bashBlocks(`python -c "from shutil import rmtree; rmtree('dist')"`);
bashBlocks(`python3 -c "import os; os.system('rm -rf dist')"`);
bashBlocks(`python3 -c "import subprocess; subprocess.run(['git', 'push', '--force'])"`);
bashBlocks(`node -e "require('child_process').execSync('git reset --hard')"`);
bashBlocks(`perl -MFile::Path=remove_tree -e 'remove_tree("dist")'`);
bashBlocks(`ruby -e 'require "fileutils"; FileUtils.rm_rf("dist")'`);
bashBlocks(`deno eval "await Deno.remove('dist', { recursive: true })"`);

console.log('\ndeny does not cover these — PowerShell tool:');
psBlocks('Microsoft.PowerShell.Management\\Remove-Item -Recurse build');
psBlocks("& 'Remove-Item' build -Recurse");
psBlocks("Invoke-Expression 'Remove-Item -Recurse build'");
psBlocks('iex "git push --force"');
psBlocks('$x = "Remove-Item"; & $x build');
psBlocks("$c='git reset --hard'; iex $c");
psBlocks("powershell -NoProfile -Command \"Remove-Item build -Recurse\"");
psBlocks(`pwsh -EncodedCommand ${encoded('git push --force')}`, 'pwsh -EncodedCommand <base64 git push --force>');
psBlocks('cmd /c rd /s /q build');
psBlocks('cmd.exe /c "rmdir /S /Q build"');
psBlocks('cmd /c rd/s/q build');
psBlocks("bash -c 'rm -rf build'");
psBlocks('wsl rm -rf build');
psBlocks("[System.IO.Directory]::Delete('build', $true)");
psBlocks("(Get-Item build).Delete($true)");
psBlocks('git -C . push --force');
psBlocks('git push origin main -f');
psBlocks("& 'C:\\Program Files\\Git\\cmd\\git.exe' push --force");
psBlocks('Get-ChildItem -Directory | ForEach-Object { Remove-Item $_ -Recurse }');
psBlocks('if ($true) { git reset --hard }');
psBlocks('npx rimraf dist');
psBlocks('Write-Output "$(Remove-Item build -Recurse)"');

console.log('\nmust allow — ordinary work:');
bashAllows('rm file.txt');
bashAllows('rm -f dist/app.js');
bashAllows('rm -i notes.md');
bashAllows('rm -- -r', 'rm -- -r (a file named -r)');
bashAllows('rmdir empty-dir');
bashAllows('git push');
bashAllows('git push -u origin feature/x');
bashAllows('git push origin feature-fix');
bashAllows('git push --follow-tags');
bashAllows('git push --force-if-includes', 'git push --force-if-includes (a no-op without --force-with-lease)');
bashAllows('git reset --soft HEAD~1');
bashAllows('git reset HEAD file.txt');
bashAllows('git reset -- --hard', 'git reset -- --hard (a path)');
bashAllows('git clean -n');
bashAllows('git clean -fdn');
bashAllows('git clean --dry-run -fd');
bashAllows('git branch -d merged');
bashAllows('git branch --delete merged');
bashAllows('git branch -f main origin/main');
bashAllows('git -C ../other status');
bashAllows('git -c user.name=x commit -m y');
bashAllows('git rm --cached secrets.txt');
bashAllows('supabase db push');
bashAllows('npx supabase db diff');
bashAllows('npx tsc --noEmit');
bashAllows('npm run build');
bashAllows('npm rm left-pad');
bashAllows('timeout 30 npm test');
bashAllows('sudo apt-get install -y jq');
bashAllows('find . -name "*.log" -print');
bashAllows('find . -type f -exec grep -l TODO {} +');
bashAllows('xargs -n1 echo < list.txt');
bashAllows("bash -c 'npm test'");
bashAllows('bash scripts/build.sh');
bashAllows('sh -c "ls -la"');
bashAllows('node -e "console.log(1)"');
bashAllows(`python3 -c "import shutil; print(shutil.which('git'))"`);
bashAllows('node scripts/clean.mjs --recursive');
bashAllows('command -v rm');
bashAllows('echo $((1 + 2))');
bashAllows('ls -la 2>/dev/null');
bashAllows('ls -la # rm -rf build', 'a comment that mentions rm -rf');
bashAllows('');

console.log('\nmust allow — text that only mentions a dangerous command:');
bashAllows('echo "rm -rf /"');
bashAllows("echo 'git push --force is blocked'");
bashAllows('grep -rn "rm -rf" docs/');
bashAllows('git commit -m "block git push --force and rm -rf"');
bashAllows("git commit -m \"$(cat <<'EOF'\nfeat: block rm -rf variants (and git push --force)\n\nDon't let bash -c 'rm -rf x' through.\nEOF\n)\"", 'commit message via $(cat <<EOF) with apostrophes and parentheses');
bashAllows("gh pr create --title x --body \"$(cat <<'EOF'\n- git reset --hard\n- rm -rfv build\nEOF\n)\"", 'PR body via heredoc listing blocked commands');
bashAllows("cat <<'EOF' > notes.md\nrm -rf build\ngit push --force\nEOF", 'heredoc into a file');
bashAllows("cat <<EOF | tee notes.md\nrm -rf build\nEOF", 'heredoc piped to tee');
bashAllows("echo 'rm -rf build' > cleanup.sh", 'writing a script is not running it');
bashAllows('printf "%s\\n" "git reset --hard"');
bashAllows(`node -e "console.log('rm -rf is dangerous')"`);
bashAllows(`python3 -c "print('shutil.rmtree is dangerous')"`, 'python print mentioning rmtree without calling it');
bashAllows('git log --grep="reset --hard"');
psAllows('Get-ChildItem -Recurse');
psAllows('git status; git log --oneline -5');
psAllows('Write-Output "Remove-Item -Recurse build"');
psAllows("Write-Host 'git push --force is blocked'");
psAllows("git commit -m @'\nfeat: block Remove-Item -Recurse and git push --force\n\nDon't (ever) do this.\n'@", 'here-string commit message');
psAllows('Select-String -Path docs\\*.md -Pattern "rm -rf"');
psAllows('npm run build 2>&1 | Out-File build.log');
psAllows('git push -u origin feature/x');
psAllows('Test-Path build');
psAllows('# Remove-Item -Recurse build', 'a comment');
psAllows('<# Remove-Item -Recurse build #> Get-Date', 'a block comment');
psAllows('cmd /c dir /s');
psAllows('cmd /c del build\\app.js', 'cmd del without /s');

console.log('\nmust allow — not this hook\'s business:');
check(ALLOW, 'Read', 'rm -rf build', 'Read tool with a command-looking field');
check(ALLOW, 'mcp__GitHub__search_code', 'git push --force', 'unrelated MCP tool');

console.log(`\npass: ${pass}   fail: ${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
