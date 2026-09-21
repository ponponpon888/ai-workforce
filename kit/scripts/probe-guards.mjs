#!/usr/bin/env node
/**
 * probe-guards.mjs — Hand each installed guard the input it exists to refuse,
 * and check that it refuses.
 *
 * WHY THIS EXISTS
 * doctor.mjs reads settings.json and never runs anything, on purpose: a
 * diagnostic that executes configured commands is a new way to get hurt. That
 * leaves a gap it says out loud ("static-pass does not mean a hook ran"), and
 * docs/09 currently closes it by asking a human to try a harmless input by
 * hand. This does that part, the same way every time.
 *
 * It answers one question: **is the guard that is registered in settings.json
 * actually reachable, and does it still block?** A wrong path, a hook file
 * that was never copied, the Node/PowerShell flavours crossed, a matcher that
 * no longer covers the tool, an edit that broke the parser -- all of them look
 * fine to a static check and are visible here.
 *
 * WHAT IT DOES NOT DO
 *   - It never runs the commands inside the payloads. `rm -rf` and `cat .env`
 *     are strings handed to a hook that only reads them. Nothing is executed,
 *     no database is contacted, no file is read for its contents.
 *   - It only sends PreToolUse payloads. SessionStart is deliberately not
 *     probed: that path writes a known-good baseline (see guard-config.mjs),
 *     and a diagnostic must not change the state it is diagnosing.
 *   - It does not prove Claude Code itself invokes the hook. Only Claude Code
 *     can show that. This proves the hook works when it is invoked exactly as
 *     settings.json spells it.
 *
 *   node kit/scripts/probe-guards.mjs
 *   node kit/scripts/probe-guards.mjs --claude-home /path/to/.claude --json
 *
 * Exit: 0 every probe behaved, 1 a registered guard did not, 2 something could
 * not be verified (guard not registered, command would not start).
 */

import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const BLOCK = 2;
const ALLOW = 0;
const TIMEOUT_MS = 15000;

/**
 * The home guard-config actually protects at run time. It reads
 * AIWF_CLAUDE_HOME or falls back to ~/.claude -- it does not look at where it
 * was installed. So probing a different home would ask it about a directory it
 * was never guarding, and a pass would mean nothing. Probe the real one and
 * report the mismatch instead (data/pitfalls/hook-013.json).
 */
const protectedHome = resolve(process.env.AIWF_CLAUDE_HOME || join(homedir(), '.claude'));

/**
 * One probe is a tool call the guard should refuse, or one it must let
 * through. Both halves matter: a guard that blocks everything is as broken as
 * one that blocks nothing, and only the allow side catches it.
 */
function probesFor(guard) {
  switch (guard) {
    case 'guard-sql':
      return [
        { name: 'DROP over an MCP database tool', expect: BLOCK, tool: 'mcp__supabase__execute_sql', input: { query: 'drop table aiwf_probe_table_that_does_not_exist' } },
        { name: 'DELETE with no WHERE through psql', expect: BLOCK, tool: 'Bash', input: { command: 'psql $DB -c "delete from aiwf_probe_table_that_does_not_exist"' } },
        { name: 'a plain SELECT', expect: ALLOW, tool: 'mcp__supabase__execute_sql', input: { query: 'select 1' } },
        { name: 'a shell command that is not SQL', expect: ALLOW, tool: 'Bash', input: { command: 'npm run build' } },
      ];
    case 'guard-secrets':
      return [
        { name: 'reading .env through a shell', expect: BLOCK, tool: 'Bash', input: { command: 'cat .env' } },
        { name: 'reading .env.example', expect: ALLOW, tool: 'Bash', input: { command: 'cat .env.example' } },
        { name: 'a shell command that reads no secret', expect: ALLOW, tool: 'Bash', input: { command: 'npm run build' } },
      ];
    case 'guard-config':
      return [
        { name: 'editing the installed settings.json', expect: BLOCK, tool: 'Edit', input: { file_path: join(protectedHome, 'settings.json') } },
        { name: 'editing an installed hook', expect: BLOCK, tool: 'Edit', input: { file_path: join(protectedHome, 'hooks', 'guard-sql.mjs') } },
        { name: 'editing an ordinary file', expect: ALLOW, tool: 'Edit', input: { file_path: join(tmpdir(), 'aiwf-probe-ordinary-notes.txt') } },
      ];
    case 'guard-destructive':
      return [
        { name: 'rm -rf wrapped in bash -c', expect: BLOCK, tool: 'Bash', input: { command: "bash -c 'rm -rf /tmp/aiwf-probe-directory-that-does-not-exist'" } },
        { name: 'gh repo delete', expect: BLOCK, tool: 'Bash', input: { command: 'gh repo delete aiwf-probe/repo-that-does-not-exist --yes' } },
        { name: 'an ordinary build command', expect: ALLOW, tool: 'Bash', input: { command: 'npm run build' } },
        { name: 'reading git status', expect: ALLOW, tool: 'Bash', input: { command: 'git status --porcelain' } },
      ];
    default:
      return [];
  }
}

const GUARDS = ['guard-sql', 'guard-secrets', 'guard-config', 'guard-destructive'];

/**
 * The command settings.json registers for a guard, recognized the same way
 * doctor.mjs recognizes it: the exact spellings the installers write, for both
 * hook flavours and both path separators. Anything else is a custom wrapper,
 * which this tool reports rather than guesses at.
 */
function registeredCommand(settings, guard, claudeHome) {
  const entries = Array.isArray(settings?.hooks?.PreToolUse) ? settings.hooks.PreToolUse : [];
  for (const entry of entries) {
    for (const hook of Array.isArray(entry?.hooks) ? entry.hooks : []) {
      if (hook?.type !== 'command' || typeof hook.command !== 'string') continue;
      for (const extension of ['mjs', 'ps1']) {
        const path = join(resolve(claudeHome), 'hooks', `${guard}.${extension}`);
        const forms = [path, path.replaceAll('\\', '/')];
        const expected = forms.flatMap(f => extension === 'mjs' ? [`node "${f}"`] :
          ['powershell.exe', 'pwsh'].map(exe => `${exe} -NoProfile -ExecutionPolicy Bypass -File "${f}"`));
        if (expected.includes(hook.command)) return hook.command;
      }
    }
  }
  return null;
}

function runProbe(command, probe, cwd) {
  const payload = JSON.stringify({
    session_id: 'aiwf-probe',
    hook_event_name: 'PreToolUse',
    cwd,
    tool_name: probe.tool,
    tool_input: probe.input,
  });
  // shell: true runs the command exactly as settings.json spells it, which is
  // the point: a quoting or interpreter mistake in the registration shows up
  // here rather than the first time a guard was supposed to stop something.
  const r = spawnSync(command, { shell: true, input: payload, encoding: 'utf8', timeout: TIMEOUT_MS });
  if (r.error || r.status === null) {
    return { ...probe, result: 'unverified', detail: r.error ? r.error.message : 'the hook did not exit normally' };
  }
  if (r.status === probe.expect) return { ...probe, result: 'pass', status: r.status };
  return {
    ...probe,
    result: 'fail',
    status: r.status,
    detail: probe.expect === BLOCK
      ? `expected the guard to block (exit 2), it exited ${r.status}`
      : `expected the guard to allow (exit 0), it exited ${r.status}`,
  };
}

export function probe({ claudeHome = join(homedir(), '.claude'), cwd = process.cwd() } = {}) {
  const home = resolve(claudeHome);
  const findings = [];
  const guards = [];
  let settings;
  try {
    settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8').replace(/^﻿/, ''));
  } catch {
    return {
      status: 'error',
      claudeHome: home,
      protectedHome,
      executed: 'none',
      guards: [],
      findings: [{ level: 'error', id: 'settings.read', message: 'Settings could not be read as JSON. Contents are not printed.' }],
    };
  }

  // guard-config reads its own home from the environment, not from where it
  // was installed, so a non-default home means the registered hook is
  // guarding some other directory. Say which one; a pass against the wrong
  // directory would be worse than no answer.
  if (home !== protectedHome) {
    findings.push({
      level: 'unknown',
      id: 'guard-config.home',
      message: `guard-config protects ${protectedHome}, not the home being probed (${home}). Its probes below are about ${protectedHome}. Set AIWF_CLAUDE_HOME=${home} to probe this home instead.`,
    });
  }

  for (const name of GUARDS) {
    const command = registeredCommand(settings, name, home);
    if (!command) {
      guards.push({ guard: name, result: 'unverified', probes: [] });
      findings.push({ level: 'unknown', id: `${name}.registration`, message: 'No standard kit registration found; a custom command is not probed.' });
      continue;
    }
    const probes = probesFor(name).map(p => runProbe(command, p, cwd));
    const result = probes.some(p => p.result === 'fail') ? 'fail'
      : probes.some(p => p.result === 'unverified') ? 'unverified' : 'pass';
    guards.push({ guard: name, command, result, probes });
    for (const p of probes) {
      if (p.result === 'fail') findings.push({ level: 'error', id: `${name}.probe`, message: `${p.name}: ${p.detail}` });
      if (p.result === 'unverified') findings.push({ level: 'unknown', id: `${name}.probe`, message: `${p.name}: ${p.detail}` });
    }
  }

  return {
    status: findings.some(f => f.level === 'error') ? 'error'
      : findings.some(f => f.level === 'unknown') ? 'incomplete' : 'probe-pass',
    claudeHome: home,
    protectedHome,
    // Stated in the report as well as the docs: the payloads are inspected,
    // never executed, and no configured command other than the guards runs.
    executed: 'registered guard hooks only; payload commands were never run',
    guards,
    findings,
  };
}

export function main(args = process.argv.slice(2)) {
  let json = false;
  let claudeHome = join(homedir(), '.claude');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--claude-home' && args[i + 1] && !args[i + 1].startsWith('--')) claudeHome = resolve(args[++i]);
    else if (args[i] === '--help') {
      console.log('node kit/scripts/probe-guards.mjs [--claude-home PATH] [--json]\n' +
        'Feeds each registered guard the input it should refuse and checks that it refuses.\n' +
        'Exit: 0 every probe behaved, 1 a guard did not, 2 something could not be verified.\n' +
        'Payload commands are never executed and no file is written.');
      return 0;
    } else { console.error('probe-guards: unknown option or missing argument. Use --help.'); return 1; }
  }

  const report = probe({ claudeHome });
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`AI Workforce guard probe: ${report.status}`);
    console.log(`claude home: ${report.claudeHome}`);
    for (const guard of report.guards) {
      console.log(`\n${guard.guard}: ${guard.result}`);
      for (const p of guard.probes) {
        const mark = p.result === 'pass' ? 'PASS' : p.result === 'fail' ? 'FAIL' : 'UNVERIFIED';
        const expected = p.expect === BLOCK ? 'blocks' : 'allows';
        console.log(`  ${mark}  ${expected}: ${p.name}${p.detail ? ` -- ${p.detail}` : ''}`);
      }
    }
    if (report.findings.length) console.log('');
    for (const f of report.findings) console.log(`${f.level.toUpperCase()} ${f.id}: ${f.message}`);
    console.log('\nNo payload command was executed. This does not prove Claude Code invokes the hooks.');
  }
  return report.status === 'error' ? 1 : report.status === 'incomplete' ? 2 : 0;
}

// fileURLToPath, not new URL(...).pathname: on Windows the latter is
// "/C:/path", which never equals the resolved argv[1] and would leave this
// script exiting 0 without probing anything.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
