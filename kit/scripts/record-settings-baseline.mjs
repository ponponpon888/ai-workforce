#!/usr/bin/env node
/**
 * record-settings-baseline.mjs — Record (or re-record) the "known good"
 * copy of settings.json that guard-config's SessionStart check compares
 * against on every launch.
 *
 * Run this yourself, after reading the diff below, whenever you have
 * deliberately hand-edited settings.json. install.mjs already records the
 * first baseline for you at install time; this script is only for the edits
 * you make afterward.
 *
 * Why this has to run outside Claude Code: known-good/ is one of
 * guard-config's protected paths, so a Claude-Code-mediated Edit/Write or an
 * obviously write-shaped shell command against it is refused. Running this
 * script from an interactive Bash/PowerShell call is not blocked the same
 * way — nothing in guard-config's PreToolUse matching recognizes `node
 * record-settings-baseline.mjs` itself as a write, the same accepted gap
 * approve-ddl.mjs has always had (see its own comments and
 * data/pitfalls/hook-006.json). The confirmation prompt below, plus Claude
 * Code's own permission prompt for the Bash/PowerShell call in the first
 * place, are the actual backstops, not a guarantee this script cannot be
 * invoked from inside a session. See data/pitfalls/hook-011.json.
 *
 * Usage:
 *   node record-settings-baseline.mjs
 *   node record-settings-baseline.mjs --claude-home ~/.claude
 *   node record-settings-baseline.mjs --force     # skip the prompt (install.mjs only)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

function fail(msg) {
  process.stderr.write(`record-settings-baseline: ${msg}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
let force = false;
let claudeHome = join(homedir(), '.claude');
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--force') force = true;
  else if (arg === '--claude-home') {
    const value = argv[++i];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) fail('--claude-home needs a path.');
    claudeHome = value;
  } else fail(`unknown option: ${arg}`);
}
claudeHome = resolve(claudeHome);

const settingsPath = join(claudeHome, 'settings.json');
const knownGoodDir = join(claudeHome, 'known-good');
const knownGoodPath = join(knownGoodDir, 'settings.json');

if (!existsSync(settingsPath)) fail(`no settings.json at ${settingsPath}.`);
const current = readFileSync(settingsPath);

try {
  JSON.parse(current.toString('utf8'));
} catch {
  fail(`${settingsPath} is not valid JSON. Fix it before recording a baseline.`);
}

console.log('');
console.log(`settings.json : ${settingsPath}`);
console.log(`baseline      : ${knownGoodPath}`);
console.log('');

if (!existsSync(knownGoodPath)) {
  console.log('No baseline recorded yet — this will be the first one.');
} else {
  const previous = readFileSync(knownGoodPath);
  if (Buffer.compare(current, previous) === 0) {
    console.log('settings.json already matches the recorded baseline. Nothing to do.');
    process.exit(0);
  }
  console.log('--- diff: recorded baseline -> current settings.json --------');
  console.log(diffOf(previous, current));
  console.log('---------------------------------------------------------------');
}

console.log('');

if (!force) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Record this as the new trusted baseline? (y/N) ');
  rl.close();
  if (answer.trim().toLowerCase() !== 'y') {
    console.log('Cancelled. Nothing written.');
    process.exit(1);
  }
}

mkdirSync(knownGoodDir, { recursive: true });
writeFileSync(knownGoodPath, current);

console.log('Recorded. guard-config will stop warning about this settings.json at the next session start.');

/**
 * A readable diff between two settings.json byte buffers. Prefers `git diff
 * --no-index`, present wherever this kit is — a plain line diff is more
 * useful to a human than "the files differ". Falls back to that plain
 * statement if git is missing or the environment cannot spawn it; a broken
 * diff view must not stop the recording itself.
 */
function diffOf(before, after) {
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'aiwf-baseline-diff-'));
    const a = join(dir, 'baseline.json');
    const b = join(dir, 'current.json');
    writeFileSync(a, before);
    writeFileSync(b, after);
    const r = spawnSync('git', ['diff', '--no-index', '--no-color', '--', a, b], { encoding: 'utf8' });
    if (r.error || typeof r.stdout !== 'string' || !r.stdout.trim()) {
      return '(diff unavailable; the file content differs — review both copies by hand.)';
    }
    // git diff --no-index names the two temp files on the --- / +++ lines;
    // relabel them so the output reads as "baseline" / "current" instead of
    // a throwaway path nobody asked about.
    return r.stdout
      .replace(new RegExp(`^--- .*${escapeRegExp('baseline.json')}$`, 'm'), '--- recorded baseline')
      .replace(new RegExp(`^\\+\\+\\+ .*${escapeRegExp('current.json')}$`, 'm'), '+++ current settings.json');
  } catch {
    return '(diff unavailable; the file content differs — review both copies by hand.)';
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
