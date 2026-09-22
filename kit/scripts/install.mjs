#!/usr/bin/env node
/**
 * install.mjs — Install the AI Workforce kit into your Claude Code home.
 *
 * The macOS / Linux installer. Windows has install.ps1, which does the same
 * thing and additionally offers the PowerShell hook.
 *
 * Copies the shared CLAUDE.md, settings.json and the guard hooks into
 * ~/.claude, backing up anything already there. Nothing is deleted.
 * The hooks are guard-sql, guard-secrets, guard-config (self-tamper
 * protection for these settings, CLAUDE.md and the hooks themselves, plus a
 * SessionStart check that warns if settings.json changed while Claude Code
 * was not running) and guard-destructive (the deny list's destructive
 * commands, in the shapes deny does not match). Also records the
 * known-good/ baseline guard-config's SessionStart check compares against;
 * re-record it with record-settings-baseline.mjs after any later hand-edit.
 *
 *   node kit/scripts/install.mjs --dry-run     # show what would happen
 *   node kit/scripts/install.mjs
 *   node kit/scripts/install.mjs --lang en --skip-settings
 */

import { statSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const options = new Map();
const flags = new Set(['--dry-run', '--skip-settings', '--skip-claude-md']);
const valued = new Set(['--lang', '--claude-home']);
try {
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (options.has(key)) throw Error('duplicate option');
    if (flags.has(key)) options.set(key, true);
    else if (valued.has(key)) {
      const value = argv[++i];
      if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw Error('missing option value');
      options.set(key, value);
    } else throw Error('unknown argument');
  }
  if (!['ja', 'en'].includes(options.get('--lang') ?? 'ja')) throw Error('invalid language');
} catch (error) {
  process.stderr.write(`install: ${error.message}\nUsage: node install.mjs [--claude-home <path>] [--lang ja|en] [--dry-run] [--skip-settings] [--skip-claude-md]\n`);
  process.exit(1);
}
const dryRun = options.has('--dry-run');
const lang = options.get('--lang') ?? 'ja';
const skipSettings = options.has('--skip-settings');
const skipClaudeMd = options.has('--skip-claude-md');
const claudeHome = resolve(options.get('--claude-home') ?? join(homedir(), '.claude'));

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

const pending = [];
function install(content, destination) { pending.push({ content, destination }); }

function writeInstalledFile(content, destination) {
  if (existsSync(destination) && readFileSync(destination).equals(Buffer.from(content, 'utf8'))) {
    console.log(`  unchanged    -> ${destination}`);
    return;
  }
  const dir = dirname(destination);
  if (!existsSync(dir)) {
    if (dryRun) console.log(`  would create -> ${dir}`);
    else mkdirSync(dir, { recursive: true });
  }

  if (existsSync(destination)) {
    const backup = `${destination}.bak.${stamp}.${randomUUID()}`;
    if (dryRun) console.log(`  would back up-> ${backup}`);
    else {
      // Never overwrite an earlier backup, even if the name collides.
      copyFileSync(destination, backup, constants.COPYFILE_EXCL);
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
if (skipClaudeMd) {
  console.log('  skipped (--skip-claude-md). Keeping the CLAUDE.md you already have.');
} else {
  const claudeMd = readFileSync(join(srcClaude, lang === 'en' ? 'CLAUDE.en.md' : 'CLAUDE.md'), 'utf8');
  install(claudeMd, join(claudeHome, 'CLAUDE.md'));
}

// --- 2. hooks ---------------------------------------------------------------

console.log('2. hooks (node)');
const sqlDest = join(claudeHome, 'hooks', 'guard-sql.mjs');
install(readFileSync(join(srcClaude, 'hooks', 'guard-sql.mjs'), 'utf8'), sqlDest);

const secretsDest = join(claudeHome, 'hooks', 'guard-secrets.mjs');
install(readFileSync(join(srcClaude, 'hooks', 'guard-secrets.mjs'), 'utf8'), secretsDest);

const configDest = join(claudeHome, 'hooks', 'guard-config.mjs');
install(readFileSync(join(srcClaude, 'hooks', 'guard-config.mjs'), 'utf8'), configDest);

const destructiveDest = join(claudeHome, 'hooks', 'guard-destructive.mjs');
install(readFileSync(join(srcClaude, 'hooks', 'guard-destructive.mjs'), 'utf8'), destructiveDest);

// The shell lexer guard-destructive imports. It has to land with the hook: an
// unresolved import exits 1, and Claude Code reports a non-2 exit rather than
// acting on it, so a hook missing this file would look installed and stop
// blocking. doctor checks it is there; probe-guards catches it at run time.
const lexDest = join(claudeHome, 'hooks', 'lib', 'shell-lex.mjs');
install(readFileSync(join(srcClaude, 'hooks', 'lib', 'shell-lex.mjs'), 'utf8'), lexDest);

// JSON escaping and shell quoting are separate layers. Inside POSIX double
// quotes these four characters still have shell meaning.
const quoteHookPath = (path) => '"' + (process.platform === 'win32'
  ? path
  : path.replace(/[\\"$`]/g, character => '\\' + character)) + '"';
const hookCommand = `node ${quoteHookPath(sqlDest)}`;
const secretsCommand = `node ${quoteHookPath(secretsDest)}`;
const configCommand = `node ${quoteHookPath(configDest)}`;
const destructiveCommand = `node ${quoteHookPath(destructiveDest)}`;

// --- 2b. approval script ----------------------------------------------------
//
// guard-sql refuses DDL until a human approves the exact statement, and its refusal
// message names the script that issues the approval. Without this the message points
// at a path inside a checkout of this repo, which is not where anyone reads it.

console.log('2b. approval script');
install(
  readFileSync(join(kitRoot, 'scripts', 'approve-ddl.mjs'), 'utf8'),
  join(claudeHome, 'scripts', 'approve-ddl.mjs')
);

// --- 2c. settings baseline recorder -----------------------------------------
//
// guard-config's SessionStart check warns when settings.json no longer
// matches the last recorded baseline. This is the script a human runs, by
// hand, outside Claude Code, to re-record that baseline after a deliberate
// edit. See the SessionStart notes in guard-config.mjs for why it has to be
// a separate, human-run step rather than something this hook does itself.

console.log('2c. settings baseline recorder');
install(
  readFileSync(join(kitRoot, 'scripts', 'record-settings-baseline.mjs'), 'utf8'),
  join(claudeHome, 'scripts', 'record-settings-baseline.mjs')
);

// --- 3. settings.json -------------------------------------------------------

console.log('3. settings.json');
// JSON string value: escape backslashes and quotes.
const forJson = (s) => JSON.stringify(s).slice(1, -1);

if (skipSettings) {
  console.log('  skipped (--skip-settings). Add these PreToolUse hooks to your own settings.json:');
  console.log(`    ${hookCommand}`);
  console.log(`    ${secretsCommand}`);
  console.log(`    ${configCommand}`);
  console.log(`    ${destructiveCommand}`);
  console.log('  Also add a ConfigChange hook (matcher "user_settings") and a SessionStart');
  console.log('  hook (matcher "startup|resume") both running this command:');
  console.log(`    ${configCommand}`);
  console.log('  Without the SessionStart entry, step 4 below records a baseline nobody checks.');
} else {
  const replacements = {
    CLAUDE_HOME: claudeHome.replaceAll('\\', '/'),
    GUARD_SQL_COMMAND: hookCommand,
    GUARD_SECRETS_COMMAND: secretsCommand,
    GUARD_CONFIG_COMMAND: configCommand,
    GUARD_DESTRUCTIVE_COMMAND: destructiveCommand,
  };
  // One pass; replacement values are literal data, never replacement syntax.
  const settings = readFileSync(join(srcClaude, 'settings.json'), 'utf8')
    .replace(/\{\{(CLAUDE_HOME|GUARD_SQL_COMMAND|GUARD_SECRETS_COMMAND|GUARD_CONFIG_COMMAND|GUARD_DESTRUCTIVE_COMMAND)\}\}/g,
      (_, key) => forJson(replacements[key]));

  // One deny rule is Windows-only. On Windows it is live, and wider than the
  // name suggests; anywhere else it is dead weight. Say which, rather than let
  // someone wonder why Remove-Item is in their config.
  const parsed = JSON.parse(settings);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('install: settings must be a JSON object');
  install(settings, join(claudeHome, 'settings.json'));
  console.log('  note: one deny rule is Windows-specific: PowerShell(Remove-Item:*).');
  if (process.platform === 'win32') {
    console.log('        It is live here, and it stops every Remove-Item,');
    console.log('        not just the recursive ones.');
  } else {
    console.log('        It is inert here. Trim it if you like.');
  }
}

// Check every selected destination before updating even the first file.
for (const { destination } of pending) {
  if (existsSync(destination) && !statSync(destination).isFile()) {
    throw Error(`install: destination is not a file: ${destination}`);
  }
  let parent = dirname(destination);
  while (true) {
    if (existsSync(parent)) {
      if (!statSync(parent).isDirectory()) throw Error(`install: parent is not a directory: ${parent}`);
      break;
    }
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
}
// All selected sources and destination shapes are checked before the first write.
for (const entry of pending) writeInstalledFile(entry.content, entry.destination);

// --- 4. known-good baseline --------------------------------------------------
//
// Records the settings.json now on disk (whichever one: freshly written
// above, or the pre-existing file if --skip-settings kept it) as the
// trusted baseline guard-config's SessionStart check compares against.
// Day one gets a baseline the same way every later hand-edit does --
// through record-settings-baseline, not written ad hoc here.

console.log('4. known-good baseline');
const finalSettingsPath = join(claudeHome, 'settings.json');
const knownGoodPath = join(claudeHome, 'known-good', 'settings.json');
if (dryRun) {
  console.log(`  would record -> ${knownGoodPath}`);
} else if (!existsSync(finalSettingsPath)) {
  console.log('  skipped: no settings.json on disk to record a baseline from.');
} else {
  const finalSettings = readFileSync(finalSettingsPath);
  if (existsSync(knownGoodPath) && readFileSync(knownGoodPath).equals(finalSettings)) {
    console.log(`  unchanged -> ${knownGoodPath}`);
  } else {
    mkdirSync(dirname(knownGoodPath), { recursive: true });
    writeFileSync(knownGoodPath, finalSettings);
    console.log(`  recorded  -> ${knownGoodPath}`);
  }
}

// --- 5. what is left to do by hand -----------------------------------------

console.log('');
console.log('Done. Three things are deliberately left to you:');
console.log('');
console.log('  a) Quit Claude Code (/exit) and start it again. A running session keeps the');
console.log('     hooks it started with, and guard-config refuses live changes to');
console.log('     settings.json on purpose. Then open /hooks: PreToolUse must show');
console.log('     Bash|PowerShell with 2 hooks, and SessionStart must show 1. If PreToolUse');
console.log('     shows 1, you are still testing the old settings, and every result below is');
console.log('     meaningless.');
console.log('');
console.log('     Verify all four hooks fire. In Claude Code, ask it to run:');
console.log('       select 1; drop table nothing;      -> [guard-sql] must block it');
console.log('       cat .env                           -> [guard-secrets] must block it');
console.log("       bash -c 'rm -rfv ./aiwf-nothing'   -> [guard-destructive] must block it");
console.log('     Then ask it to edit or delete your own settings.json or CLAUDE.md:');
console.log('       -> [guard-config] must block it');
console.log('     If any of these goes through, that hook is not wired up and you are');
console.log('     unprotected on that side.');
console.log('');
console.log('     The test suites cover behaviour, not wiring:');
console.log(`       node ${join(kitRoot, 'scripts', 'test-guard-sql.mjs')}`);
console.log(`       node ${join(kitRoot, 'scripts', 'test-guard-secrets.mjs')}`);
console.log(`       node ${join(kitRoot, 'scripts', 'test-guard-config.mjs')}`);
console.log(`       node ${join(kitRoot, 'scripts', 'test-guard-destructive.mjs')}`);
console.log('');
console.log('  b) After any deliberate hand-edit of settings.json, re-record its baseline');
console.log('     yourself, outside Claude Code, or every session start will warn that it');
console.log('     no longer matches what was last approved:');
console.log(`       node ${join(claudeHome, 'scripts', 'record-settings-baseline.mjs')}`);
console.log('');
console.log('  c) Register pull-all if you want it. It brings every repo under a root');
console.log('     up to date at login without ever touching work in progress.');
console.log(`       node ${join(kitRoot, 'scripts', 'pull-all.mjs')} --root ~/Dev --quiet`);
console.log('     Read it first, then add a cron line:');
console.log('       @reboot sleep 60 && ' + `node ${join(kitRoot, 'scripts', 'pull-all.mjs')} --root ~/Dev --quiet`);
console.log('     Without Node in the login path, the POSIX shell twin takes the same options:');
console.log('       @reboot sleep 60 && ' + `/bin/sh ${join(kitRoot, 'scripts', 'pull-all.sh')} --root ~/Dev --quiet`);
console.log('');
