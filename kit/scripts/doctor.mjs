#!/usr/bin/env node
/** Read-only, scoped AI Workforce diagnostics. Never execute settings commands.
 * This checks the kit's documented profile, not the entire Claude settings schema.
 * Official contract reviewed 2026-09-09: https://code.claude.com/docs/en/permissions
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const modes = ['default', 'manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
const guards = [
  { name: 'guard-sql', token: '{{GUARD_SQL_COMMAND}}', tools: ['Bash', 'PowerShell', 'mcp__supabase__execute_sql', 'mcp__postgres__query', 'mcp__neon__query', 'mcp__planetscale__query'] },
  { name: 'guard-secrets', token: '{{GUARD_SECRETS_COMMAND}}', tools: ['Bash', 'PowerShell'] },
  { name: 'guard-config', token: '{{GUARD_CONFIG_COMMAND}}', tools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell'] },
  { name: 'guard-destructive', token: '{{GUARD_DESTRUCTIVE_COMMAND}}', tools: ['Bash', 'PowerShell'] },
];

/**
 * Files a hook imports at load time, relative to the hook itself.
 *
 * guard-sql and guard-destructive, in both flavours, share the shell lexer.
 * Listed here so a copy that is missing it is an error the
 * report names, rather than a guard that looks installed and quietly stops
 * blocking (an unresolved import exits 1, and Claude Code reports a non-2
 * exit rather than acting on it).
 */
const DEPENDENCIES = {
  'guard-sql.mjs': ['lib/shell-lex.mjs'],
  'guard-sql.ps1': ['lib/shell-lex.ps1'],
  'guard-destructive.mjs': ['lib/shell-lex.mjs'],
  'guard-destructive.ps1': ['lib/shell-lex.ps1'],
};

const extensionOf = (path) => path.slice(path.lastIndexOf('.') + 1);

export function inspectSettings(settings, { template = false, claudeHome = join(homedir(), '.claude') } = {}) {
  const findings = [];
  const add = (level, id, message) => findings.push({ level, id, message });
  const result = () => ({
    status: findings.some(x => x.level === 'error') ? 'error' : findings.some(x => x.level === 'unknown') ? 'incomplete' : 'static-pass',
    scope: template ? 'kit-template' : 'single-installed-settings-file',
    hostVerification: 'not-performed',
    findings,
  });
  if (!object(settings)) { add('error', 'settings.object', 'Settings must be a JSON object.'); return result(); }
  if (Object.hasOwn(settings, 'disableAutoMode')) add('error', 'mode.location', 'Move disableAutoMode under permissions; use the string "disable".');
  const p = settings.permissions;
  if (!object(p)) add('error', 'permissions.object', 'permissions must be an object.');
  else {
    if (!modes.includes(p.defaultMode)) add('error', 'mode.value', 'defaultMode is missing or not a documented mode ("ask" is not a mode).');
    else if (!['default', 'manual'].includes(p.defaultMode)) add('error', 'mode.profile', 'This kit profile expects default/manual mode.');
    for (const key of ['disableAutoMode', 'disableBypassPermissionsMode']) {
      if (p[key] !== 'disable') add('error', `mode.${key}`, `${key} must be the string "disable" for this kit profile.`);
    }
    for (const key of ['allow', 'ask', 'deny']) {
      if (!Array.isArray(p[key]) || p[key].some(x => typeof x !== 'string' || !x.trim())) {
        add('error', `permissions.${key}`, `${key} must be an array of non-empty rule strings.`);
      } else if (p[key].some(x => /^Write\(/.test(x))) {
        add('error', 'permissions.write-path', 'Path-scoped Write rules are not consulted by current Claude Code; use Edit path rules.');
      }
    }
  }
  if (settings.disableAllHooks === true) add('error', 'hooks.disabled', 'disableAllHooks disables the configured guards.');
  const entries = settings.hooks?.PreToolUse;
  if (!Array.isArray(entries)) { add('error', 'hooks.missing', 'PreToolUse must be an array containing both guards.'); return result(); }
  const validEntries = [];
  for (const entry of entries) {
    if (!object(entry) || typeof entry.matcher !== 'string' || !Array.isArray(entry.hooks)) {
      add('error', 'hooks.shape', 'Each PreToolUse entry needs a matcher string and hooks array.'); continue;
    }
    try { validEntries.push({ ...entry, regex: new RegExp(entry.matcher) }); }
    catch { add('error', 'hooks.matcher', 'A PreToolUse matcher is not a valid regular expression.'); }
    for (const hook of entry.hooks) {
      if (!object(hook)) { add('error', 'hooks.shape', 'Hook definitions must be objects.'); continue; }
      if (!template && typeof hook.command === 'string' && /\{\{[^}]+\}\}/.test(hook.command)) {
        add('error', 'hooks.placeholder', 'Installed hook command contains an unexpanded placeholder.');
      }
    }
  }
  for (const guard of guards) {
    const covered = new Set();
    let recognized = false;
    for (const entry of validEntries) for (const hook of entry.hooks) {
      if (!object(hook) || hook.type !== 'command' || typeof hook.command !== 'string') continue;
      let file;
      let matches = template && hook.command === guard.token;
      if (!template) for (const extension of ['mjs', 'ps1']) {
        const path = join(resolve(claudeHome), 'hooks', `${guard.name}.${extension}`);
        const forms = [path, path.replaceAll('\\', '/')];
        const expected = forms.flatMap(f => extension === 'mjs' ? [`node "${f}"`] :
          ['powershell.exe', 'pwsh'].map(exe => `${exe} -NoProfile -ExecutionPolicy Bypass -File "${f}"`));
        if (expected.includes(hook.command)) { matches = true; file = path; }
      }
      if (!matches) continue;
      recognized = true;
      if (hook.async === true || hook.if !== undefined || hook.args !== undefined || entry.if !== undefined) {
        add('unknown', `${guard.name}.execution`, 'Conditional, async, or alternate argument hooks require manual verification.'); continue;
      }
      if (!Number.isFinite(hook.timeout) || hook.timeout <= 0) add('error', `${guard.name}.timeout`, 'Set a positive finite guard timeout.');
      if (file) {
        try { if (!statSync(file).isFile()) throw new Error(); }
        catch { add('error', `${guard.name}.file`, 'The registered kit hook file is missing or is not a regular file.'); }
        // A hook that imports the shared lexer cannot run without it. The
        // import fails before the hook reads anything, and a non-2 exit is
        // reported rather than acted on -- so the guard would look installed
        // and stop blocking. Static check only; probe-guards is what proves
        // the hook actually starts.
        for (const dependency of DEPENDENCIES[`${guard.name}.${extensionOf(file)}`] ?? []) {
          try { if (!statSync(join(dirname(file), dependency)).isFile()) throw new Error(); }
          catch { add('error', `${guard.name}.dependency`, `The hook needs ${dependency}, which is missing or is not a regular file.`); }
        }
      }
      for (const tool of guard.tools) if (entry.regex.test(tool)) covered.add(tool);
    }
    if (!recognized) add('unknown', `${guard.name}.registration`, 'No standard kit registration found; missing or custom commands need manual verification.');
    else if (guard.tools.some(tool => !covered.has(tool))) add('error', `${guard.name}.coverage`, 'The guard matcher does not cover all representative kit tool names.');
  }

  // ConfigChange: only guard-config registers on this event, since only
  // settings.json (a "user_settings" configuration source) has a native
  // change event Claude Code can block on. Checked separately from the
  // PreToolUse guards above because the entry shape differs (matcher is a
  // configuration source, not a tool name) and only one guard uses it.
  // See data/pitfalls/hook-007.json for what this layer does and does not
  // cover; this check only confirms the registration exists, the same way
  // the PreToolUse checks above do not confirm a hook actually fires.
  const configChangeEntries = settings.hooks?.ConfigChange;
  if (configChangeEntries !== undefined && !Array.isArray(configChangeEntries)) {
    add('error', 'hooks.configchange.shape', 'ConfigChange must be an array of matcher entries.');
  } else {
    let recognized = false;
    for (const entry of configChangeEntries ?? []) {
      if (!object(entry) || typeof entry.matcher !== 'string' || !Array.isArray(entry.hooks)) {
        add('error', 'hooks.configchange.shape', 'Each ConfigChange entry needs a matcher string and hooks array.');
        continue;
      }
      if (entry.matcher !== 'user_settings') continue;
      for (const hook of entry.hooks) {
        if (!object(hook)) { add('error', 'hooks.configchange.shape', 'Hook definitions must be objects.'); continue; }
        if (!template && typeof hook.command === 'string' && /\{\{[^}]+\}\}/.test(hook.command)) {
          add('error', 'hooks.placeholder', 'Installed ConfigChange hook command contains an unexpanded placeholder.');
        }
        if (hook.type !== 'command' || typeof hook.command !== 'string') continue;
        let matches = template && hook.command === '{{GUARD_CONFIG_COMMAND}}';
        if (!template) for (const extension of ['mjs', 'ps1']) {
          const path = join(resolve(claudeHome), 'hooks', `guard-config.${extension}`);
          const forms = [path, path.replaceAll('\\', '/')];
          const expected = forms.flatMap(f => extension === 'mjs' ? [`node "${f}"`] :
            ['powershell.exe', 'pwsh'].map(exe => `${exe} -NoProfile -ExecutionPolicy Bypass -File "${f}"`));
          if (expected.includes(hook.command)) matches = true;
        }
        if (matches) recognized = true;
      }
    }
    if (!recognized) add('unknown', 'guard-config.configchange.registration', 'No standard guard-config ConfigChange registration found on user_settings; missing or custom commands need manual verification.');
  }

  // SessionStart: fills the gap ConfigChange leaves open (a settings.json
  // edit made while Claude Code was not running has no native change event
  // at all -- see data/pitfalls/hook-007.json and hook-011.json). Checked
  // the same way as ConfigChange above: only confirms the registration
  // exists on startup|resume, not that the hook actually fires or that a
  // known-good/ baseline was ever recorded (doctor never touches the
  // filesystem beyond the one settings file it was given).
  const sessionStartEntries = settings.hooks?.SessionStart;
  if (sessionStartEntries !== undefined && !Array.isArray(sessionStartEntries)) {
    add('error', 'hooks.sessionstart.shape', 'SessionStart must be an array of matcher entries.');
  } else {
    let recognized = false;
    for (const entry of sessionStartEntries ?? []) {
      if (!object(entry) || typeof entry.matcher !== 'string' || !Array.isArray(entry.hooks)) {
        add('error', 'hooks.sessionstart.shape', 'Each SessionStart entry needs a matcher string and hooks array.');
        continue;
      }
      // The matcher is a pipe-separated set of startup_type values, not a
      // regex to test values against -- SessionStart's matcher grammar is
      // simple alternation, so split rather than compile.
      if (!entry.matcher.split('|').some(v => v === 'startup' || v === 'resume')) continue;
      for (const hook of entry.hooks) {
        if (!object(hook)) { add('error', 'hooks.sessionstart.shape', 'Hook definitions must be objects.'); continue; }
        if (!template && typeof hook.command === 'string' && /\{\{[^}]+\}\}/.test(hook.command)) {
          add('error', 'hooks.placeholder', 'Installed SessionStart hook command contains an unexpanded placeholder.');
        }
        if (hook.type !== 'command' || typeof hook.command !== 'string') continue;
        let matches = template && hook.command === '{{GUARD_CONFIG_COMMAND}}';
        if (!template) for (const extension of ['mjs', 'ps1']) {
          const path = join(resolve(claudeHome), 'hooks', `guard-config.${extension}`);
          const forms = [path, path.replaceAll('\\', '/')];
          const expected = forms.flatMap(f => extension === 'mjs' ? [`node "${f}"`] :
            ['powershell.exe', 'pwsh'].map(exe => `${exe} -NoProfile -ExecutionPolicy Bypass -File "${f}"`));
          if (expected.includes(hook.command)) matches = true;
        }
        if (matches) recognized = true;
      }
    }
    if (!recognized) add('unknown', 'guard-config.sessionstart.registration', 'No standard guard-config SessionStart registration found on startup|resume; missing or custom commands need manual verification.');
  }

  add('info', 'host.unverified', 'Only one settings file was checked. Interpreter availability, file contents, host version, effective settings precedence, and actual hook execution remain unverified. No configured command was executed.');
  return result();
}

export function main(args = process.argv.slice(2)) {
  let template = false, json = false, claudeHome = join(homedir(), '.claude');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--template') template = true;
    else if (args[i] === '--json') json = true;
    else if (args[i] === '--claude-home' && args[i + 1] && !args[i + 1].startsWith('--')) claudeHome = resolve(args[++i]);
    else if (args[i] === '--help') { console.log('node kit/scripts/doctor.mjs [--template | --claude-home PATH] [--json]\nExit: 0 static checks passed, 1 invalid/missing settings, 2 incomplete verification.\nNever executes configured commands or modifies files.'); return 0; }
    else { console.error('doctor: unknown option or missing argument. Use --help.'); return 1; }
  }
  if (template && args.includes('--claude-home')) { console.error('doctor: choose --template or --claude-home, not both.'); return 1; }
  const path = template ? resolve(dirname(fileURLToPath(import.meta.url)), '../claude/settings.json') : join(claudeHome, 'settings.json');
  let report;
  try { report = inspectSettings(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')), { template, claudeHome }); }
  catch { report = { status: 'error', hostVerification: 'not-performed', findings: [{ level: 'error', id: 'settings.read', message: 'Settings could not be read as JSON. Contents are not printed.' }] }; }
  if (json) console.log(JSON.stringify(report, null, 2));
  else { console.log(`AI Workforce doctor: ${report.status}`); for (const f of report.findings) console.log(`${f.level.toUpperCase()} ${f.id}: ${f.message}`); }
  return report.status === 'error' ? 1 : report.status === 'incomplete' ? 2 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
