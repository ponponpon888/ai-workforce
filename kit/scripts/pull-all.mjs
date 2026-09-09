#!/usr/bin/env node
/**
 * pull-all.mjs — Bring every repository under a root directory up to date,
 * without ever touching work in progress.
 *
 * Cross-platform twin of pull-all.ps1. Run it at login. When you sit down,
 * the default branch is current everywhere.
 *
 * RULES, in order of importance:
 *   - Never stash. Never reset. Never checkout. Never merge.
 *   - A dirty working tree is skipped entirely.
 *   - A repo mid-rebase, mid-merge, mid-cherry-pick, mid-bisect, or on a
 *     detached HEAD is skipped.
 *   - On the default branch with a clean tree: fast-forward-only pull.
 *   - On a feature branch: a remote fetch followed by a local fast-forward advances the local
 *     default branch without leaving the branch you are on. If that would not
 *     fast-forward, git refuses and the repo is reported, not forced.
 *
 * The whole point is that this can run unattended and still never lose a line
 * of your work. If it cannot act safely, it reports and moves on.
 *
 *   node pull-all.mjs --root ~/Dev
 *   node pull-all.mjs --root ~/Dev --repos api,web,infra
 *   node pull-all.mjs --root ~/Dev --dry-run
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

// This runs unattended at login, so git has to fail rather than wait. Without
// these, a repository whose credentials have expired stops on a prompt nobody
// is there to answer, and the run hangs silently instead of reporting. The
// second one covers Windows, where Git Credential Manager pops a window of its
// own that GIT_TERMINAL_PROMPT does not reach.
process.env.GIT_TERMINAL_PROMPT = '0';
process.env.GCM_INTERACTIVE = 'never';

// --- arguments --------------------------------------------------------------

const argv = process.argv.slice(2);
const switches = new Set(['--dry-run', '--quiet']);
const values = new Set(['--root', '--repos', '--log-dir', '--retention-days']);
const options = new Map();
function usageError(message) {
  process.stderr.write(`pull-all: ${message}\n`);
  process.exit(2);
}
for (let i = 0; i < argv.length; i++) {
  const key = argv[i];
  if (!switches.has(key) && !values.has(key)) usageError('unknown option or positional argument');
  if (options.has(key)) usageError(`duplicate option: ${key}`);
  if (switches.has(key)) {
    options.set(key, true);
  } else {
    const value = argv[++i];
    if (!value || !value.trim() || value.startsWith('--')) usageError(`missing value: ${key}`);
    options.set(key, value);
  }
}
const root = resolve((options.get('--root') ?? join(homedir(), 'Dev')).replace(/^~(?=$|[/\\])/, homedir()));
const only = options.has('--repos') ? options.get('--repos').split(',').map(s => s.trim()) : [];
if (only.some(name => !name || name === '.' || name === '..' || /[/\\:]/.test(name))) {
  usageError('--repos must contain direct child directory names separated by commas');
}
const retentionText = options.get('--retention-days') ?? '30';
if (!/^\d+$/.test(retentionText) || !Number.isSafeInteger(Number(retentionText)) || Number(retentionText) < 1) {
  usageError('--retention-days must be a positive safe integer');
}
const logDir = resolve(options.get('--log-dir') ?? join(root, '_logs'));
const retentionDays = Number(retentionText);
const dryRun = options.has('--dry-run');
const quiet = options.has('--quiet');
if (dryRun) process.env.GIT_OPTIONAL_LOCKS = '0';

// Check before mkdir(logDir): the default log directory is inside root,
// so creating it first would silently create a misspelled/missing root too.
try {
  if (!statSync(root).isDirectory()) throw new Error('not a directory');
} catch {
  process.stderr.write('pull-all: Root must be an existing directory. Nothing was updated.\n');
  process.exit(1);
}

// --- logging ----------------------------------------------------------------

if (!dryRun) mkdirSync(logDir, { recursive: true });
const logFile = join(
  logDir,
  `pull-all_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)}.log`
);

function log(message) {
  const line = `${new Date().toTimeString().slice(0, 8)}  ${message}`;
  if (!quiet) console.log(line);
  if (dryRun) return;
  try {
    appendFileSync(logFile, line + '\n', 'utf8');
  } catch {
    /* logging must never be the thing that fails the run */
  }
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    code: r.status,
    out: ((r.stdout || '') + (r.stderr || '')).trim(),
  };
}

// --- discovery --------------------------------------------------------------

if (spawnSync('git', ['--version'], { encoding: 'utf8' }).status !== 0) {
  log('git not found on PATH. Nothing to do.');
  process.exit(1);
}

let targets;
if (only.length) {
  targets = only.map((n) => join(root, n)).filter((p) => existsSync(join(p, '.git')));
} else {
  targets = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, '.git')))
    .map((e) => join(root, e.name));
}

log(`pull-all start  root=${root}  repos=${targets.length}${dryRun ? '  (dry run)' : ''}`);

// --- the work ---------------------------------------------------------------

const IN_PROGRESS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'BISECT_LOG'];
const summary = [];

for (const repo of targets) {
  const name = basename(repo);
  const record = (result) => summary.push({ name, result });

  // Resolve the real git dir: `.git` can be a file (worktrees, submodules).
  const gitDirOut = git(repo, ['rev-parse', '--absolute-git-dir']);
  if (gitDirOut.code !== 0) {
    log(`${name} : SKIP (not a git repo)`);
    record('skip/not-a-repo');
    continue;
  }
  const gitDir = gitDirOut.out;

  const busy = IN_PROGRESS.filter((m) => existsSync(join(gitDir, m)));
  if (busy.length) {
    log(`${name} : SKIP (in progress: ${busy.join(', ')})`);
    record('skip/in-progress');
    continue;
  }

  if (git(repo, ['status', '--porcelain']).out) {
    log(`${name} : SKIP (dirty working tree)`);
    record('skip/dirty');
    continue;
  }

  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  if (branch === 'HEAD') {
    log(`${name} : SKIP (detached HEAD)`);
    record('skip/detached');
    continue;
  }

  const head = git(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).out;
  const m = /^origin\/(.+)$/.exec(head);
  const def = m ? m[1] : 'main';

  if (dryRun) {
    const action =
      branch === def ? `pull --ff-only on '${def}'` : `fetch origin ${def}:${def} (on '${branch}')`;
    log(`${name} : would ${action}`);
    record('dry-run');
    continue;
  }

  if (branch === def) {
    const r = git(repo, ['pull', '--ff-only']);
    if (r.code === 0) {
      log(`${name} : ok (${def} fast-forwarded)`);
      record('ok');
    } else {
      log(`${name} : FAILED ff-only pull -- ${r.out}`);
      record('fail/pull');
    }
    continue;
  }

  // Separate transport failure from a refused local fast-forward. Never
  // classify authentication/network errors as normal divergent-history skips.
  const fetched = git(repo, ['fetch', '--no-tags', 'origin', def]);
  if (fetched.code !== 0) {
    log(`${name} : FAILED fetch -- ${fetched.out}`);
    record('fail/fetch');
    continue;
  }
  const fetchedHead = git(repo, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
  if (fetchedHead.code !== 0) {
    log(`${name} : FAILED resolving fetched commit -- ${fetchedHead.out}`);
    record('fail/fetch');
    continue;
  }
  // A local fetch still enforces fast-forward and checked-out-branch safety.
  const r = git(repo, ['fetch', '--no-tags', '.', `${fetchedHead.out}:refs/heads/${def}`]);
  if (r.code === 0) {
    log(`${name} : ok (on '${branch}', ${def} advanced)`);
    record('ok/branch');
  } else {
    const ancestry = git(repo, ['merge-base', '--is-ancestor', `refs/heads/${def}`, fetchedHead.out]);
    if (ancestry.code === 1) {
      log(`${name} : ${def} not fast-forwardable, left alone -- ${r.out}`);
      record('skip/diverged');
    } else {
      log(`${name} : FAILED local branch update -- ${r.out}`);
      record('fail/update');
    }
  }
}

// --- wrap up ----------------------------------------------------------------

log('--- summary ---');
for (const s of summary) log(`${s.name.padEnd(28)} ${s.result}`);

if (!dryRun) try {
  const cutoff = Date.now() - retentionDays * 86400000;
  for (const f of readdirSync(logDir)) {
    if (!/^pull-all_.*\.log$/.test(f)) continue;
    const p = join(logDir, f);
    if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
  }
} catch {
  /* pruning old logs is not worth failing the run over */
}

log(dryRun ? 'done. dry run: no log file written.' : `done. log: ${logFile}`);

// Non-zero only when something actually failed. Skips are the normal, safe path.
process.exit(summary.some((s) => s.result.startsWith('fail')) ? 1 : 0);
