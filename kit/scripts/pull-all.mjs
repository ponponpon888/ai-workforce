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
 *   - On a feature branch: `git fetch origin main:main` advances the local
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

// --- arguments --------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};

const root = resolve(opt('--root', join(homedir(), 'Dev')).replace(/^~(?=$|[/\\])/, homedir()));
const only = opt('--repos', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const logDir = resolve(opt('--log-dir', join(root, '_logs')));
const retentionDays = Number(opt('--retention-days', '30'));
const dryRun = flag('--dry-run');
const quiet = flag('--quiet');

// --- logging ----------------------------------------------------------------

mkdirSync(logDir, { recursive: true });
const logFile = join(
  logDir,
  `pull-all_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)}.log`
);

function log(message) {
  const line = `${new Date().toTimeString().slice(0, 8)}  ${message}`;
  if (!quiet) console.log(line);
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
if (!existsSync(root)) {
  log(`Root not found: ${root}`);
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

  // On a feature branch: advance the local default branch in place. This cannot
  // touch the checkout, and git refuses if it is not a fast-forward.
  const r = git(repo, ['fetch', 'origin', `${def}:${def}`]);
  if (r.code === 0) {
    log(`${name} : ok (on '${branch}', ${def} advanced)`);
    record('ok/branch');
  } else {
    log(`${name} : ${def} not fast-forwardable, left alone -- ${r.out}`);
    record('skip/diverged');
  }
}

// --- wrap up ----------------------------------------------------------------

log('--- summary ---');
for (const s of summary) log(`${s.name.padEnd(28)} ${s.result}`);

try {
  const cutoff = Date.now() - retentionDays * 86400000;
  for (const f of readdirSync(logDir)) {
    if (!/^pull-all_.*\.log$/.test(f)) continue;
    const p = join(logDir, f);
    if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
  }
} catch {
  /* pruning old logs is not worth failing the run over */
}

log(`done. log: ${logFile}`);

// Non-zero only when something actually failed. Skips are the normal, safe path.
process.exit(summary.some((s) => s.result.startsWith('fail')) ? 1 : 0);
