#!/usr/bin/env node
/**
 * install.mjs — Install the AI Workforce kit into your Claude Code home.
 *
 * The macOS / Linux installer. Windows has install.ps1, which does the same
 * thing and additionally offers the PowerShell hook.
 *
 * Copies the shared CLAUDE.md, settings.json and the guard-sql hook into
 * ~/.claude, backing up anything already there. Nothing is deleted.
 *
 *   node kit/scripts/install.mjs --dry-run     # show what would happen
 *   node kit/scripts/install.mjs
 *   node kit/scripts/install.mjs --lang en --skip-settings
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};

const dryRun = has('--dry-run');
const lang = val('--lang', 'ja');
const skipSettings = has('--skip-settings');
const claudeHome = resolve(val('--claude-home', join(homedir(), '.claude')));

if (!['ja', 'en'].includes(lang)) {
  process.stderr.write(`install: --lang must be ja or en\n`);
  process.exit(1);
}

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcClaude = join(kitRoot, 'claude');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);

console.log('');
console.log('AI Workforce - install');
console.log(`  kit         : ${kitRoot}`);
console.log(`  claude home : ${claudeHome}`);
console.log(`  language    : ${lang}`);
if (dryRun) console.log('  mode        : dry run, nothing will be written');
console.log('');

function install(content, destination) {
  const dir = dirname(destination);
  if (!existsSync(dir)) {
    if (dryRun) console.log(`  would create -> ${dir}`);
    else mkdirSync(dir, { recursive: true });
  }

  if (existsSync(destination)) {
    const backup = `${destination}.bak.${stamp}`;
    if (dryRun) console.log(`  would back up-> ${backup}`);
    else {
      copyFileSync(destination, backup);
      console.log(`  backed up    -> ${backup}`);
    }
  }

  if (dryRun) {
    console.log(`  would write  -> ${destination}`);
  } else {
    writeFileSync(destination, content, 'utf8');
    console.log(`  wrote        -> ${destination}`);
  }
}

// --- 1. shared CLAUDE.md ----------------------------------------------------

console.log('1. shared CLAUDE.md');
if (process.platform !== 'win32') {
  console.log('  note: section 5 of CLAUDE.md describes a Windows PowerShell environment.');
  console.log('        Rewrite it for your machine after installing.');
}
const claudeMd = readFileSync(join(srcClaude, lang === 'en' ? 'CLAUDE.en.md' : 'CLAUDE.md'), 'utf8');
install(claudeMd, join(claudeHome, 'CLAUDE.md'));

// --- 2. guard-sql hook ------------------------------------------------------

console.log('2. guard-sql hook (node)');
const hookDest = join(claudeHome, 'hooks', 'guard-sql.mjs');
install(readFileSync(join(srcClaude, 'hooks', 'guard-sql.mjs'), 'utf8'), hookDest);

const hookCommand = `node "${hookDest}"`;

// --- 3. settings.json -------------------------------------------------------

console.log('3. settings.json');
if (skipSettings) {
  console.log('  skipped (--skip-settings). Add this PreToolUse hook to your own settings.json:');
  console.log(`    ${hookCommand}`);
} else {
  const settings = readFileSync(join(srcClaude, 'settings.json'), 'utf8')
    .replaceAll('{{CLAUDE_HOME}}', claudeHome.replaceAll('\\', '/'))
    // JSON string value: escape backslashes and quotes.
    .replaceAll('{{GUARD_SQL_COMMAND}}', hookCommand.replaceAll('\\', '\\\\').replaceAll('"', '\\"'));

  // The shipped deny list contains a few Windows-only entries. Harmless, but
  // say so rather than let someone wonder why Remove-Item is in their config.
  install(settings, join(claudeHome, 'settings.json'));
  console.log('  note: one deny rule is Windows-specific (Remove-Item -Recurse).');
  console.log('        It is inert here. Trim it if you like.');
}

// --- 4. what is left to do by hand -----------------------------------------

console.log('');
console.log('Done. Two things are deliberately left to you:');
console.log('');
console.log('  a) Verify the hook fires. In Claude Code, ask it to run:');
console.log('       select 1; drop table nothing;');
console.log('     It must be blocked with a [guard-sql] message. If it is not, the hook');
console.log('     is not wired up and you are unprotected.');
console.log('');
console.log('     The test suite covers behaviour, not wiring:');
console.log(`       node ${join(kitRoot, 'scripts', 'test-guard-sql.mjs')}`);
console.log('');
console.log('  b) Register pull-all if you want it. It brings every repo under a root');
console.log('     up to date at login without ever touching work in progress.');
console.log(`       node ${join(kitRoot, 'scripts', 'pull-all.mjs')} --root ~/Dev --quiet`);
console.log('     Read it first, then add a cron line:');
console.log('       @reboot sleep 60 && ' + `node ${join(kitRoot, 'scripts', 'pull-all.mjs')} --root ~/Dev --quiet`);
console.log('');
