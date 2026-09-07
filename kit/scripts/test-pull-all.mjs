#!/usr/bin/env node
/**
 * test-pull-all.mjs — Prove that pull-all never destroys work.
 *
 * This does not mock git. It builds a real bare origin and six real clones,
 * each parked in a different state, runs pull-all over them for real, and then
 * checks that nothing was lost.
 *
 * The assertions that matter are the negative ones: after a run, the dirty
 * repo still has its uncommitted change, the feature branch is still checked
 * out, and the repo mid-rebase is still mid-rebase. A script that runs
 * unattended at login has to be boring in exactly these ways.
 *
 *   node kit/scripts/test-pull-all.mjs
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// The same fixture is used to test both implementations, so they cannot drift.
//   node test-pull-all.mjs                 -> tests pull-all.mjs
//   node test-pull-all.mjs --target ps     -> tests pull-all.ps1 via pwsh
const targetArg = process.argv.includes('--target')
  ? process.argv[process.argv.indexOf('--target') + 1]
  : 'node';
const pwshExe = process.argv.includes('--pwsh')
  ? process.argv[process.argv.indexOf('--pwsh') + 1]
  : 'pwsh';

function invocation(reposDir) {
  if (targetArg === 'ps') {
    return [pwshExe, ['-NoProfile', '-File', resolve(here, 'pull-all.ps1'), '-Root', reposDir]];
  }
  return [process.execPath, [resolve(here, 'pull-all.mjs'), '--root', reposDir, '--quiet']];
}

let pass = 0;
let fail = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
    pass++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}

// Everything lives under one temp root, including an empty git config, so the
// run cannot be coloured by whatever is in the developer's ~/.gitconfig.
// (An empty file rather than /dev/null, so this also works on Windows.)
const rootDir = mkdtempSync(join(tmpdir(), 'aiwf-pullall-'));
const emptyGitConfig = join(rootDir, 'empty.gitconfig');
writeFileSync(emptyGitConfig, '');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: emptyGitConfig,
  GIT_CONFIG_SYSTEM: emptyGitConfig,
};

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

function head(repo) {
  return git(repo, 'rev-parse', 'HEAD').out;
}
function branchOf(repo) {
  return git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').out;
}
function shaOf(repo, ref) {
  return git(repo, 'rev-parse', ref).out;
}

// ---------------------------------------------------------------------------
// Build the fixture
// ---------------------------------------------------------------------------

const originDir = join(rootDir, '_origin.git');
const workDir = join(rootDir, 'work');
const reposDir = join(rootDir, 'repos');
mkdirSync(reposDir, { recursive: true });

// A bare origin with two commits on main.
git(rootDir, 'init', '--bare', '--initial-branch=main', originDir);
git(rootDir, 'clone', originDir, workDir);
writeFileSync(join(workDir, 'a.txt'), 'one\n');
git(workDir, 'add', '-A');
git(workDir, 'commit', '-m', 'first');
git(workDir, 'push', '-u', 'origin', 'main');
const FIRST = head(workDir);

function clone(name) {
  const p = join(reposDir, name);
  git(reposDir, 'clone', '--quiet', originDir, name);
  // A fresh clone has origin/HEAD; make sure of it so the script can read it.
  git(p, 'remote', 'set-head', 'origin', '--auto');
  return p;
}

// Every clone below is made at FIRST, then origin moves ahead by one commit.
const repos = {
  cleanOnMain: clone('clean-on-main'),
  dirty: clone('dirty'),
  featureBranch: clone('feature-branch'),
  detached: clone('detached'),
  midRebase: clone('mid-rebase'),
  diverged: clone('diverged'),
};

// Advance origin so there is genuinely something to pull.
writeFileSync(join(workDir, 'a.txt'), 'one\ntwo\n');
git(workDir, 'commit', '-am', 'second');
git(workDir, 'push', 'origin', 'main');
const SECOND = head(workDir);

// --- park each clone in its state -------------------------------------------

// dirty: an uncommitted edit we must still have afterwards.
writeFileSync(join(repos.dirty, 'a.txt'), 'one\nMY UNCOMMITTED WORK\n');

// featureBranch: a branch with a commit of its own.
git(repos.featureBranch, 'checkout', '-q', '-b', 'feat/x');
writeFileSync(join(repos.featureBranch, 'feature.txt'), 'wip\n');
git(repos.featureBranch, 'add', '-A');
git(repos.featureBranch, 'commit', '-m', 'feature work');
const FEATURE_HEAD = head(repos.featureBranch);

// detached
git(repos.detached, 'checkout', '-q', '--detach', FIRST);

// midRebase: a genuine conflicting rebase, stopped mid-flight.
{
  const r = repos.midRebase;
  git(r, 'checkout', '-q', '-b', 'feat/conflict');
  writeFileSync(join(r, 'a.txt'), 'one\nCONFLICTING\n');
  git(r, 'commit', '-am', 'conflicting change');
  git(r, 'fetch', 'origin');
  git(r, 'rebase', 'origin/main'); // expected to stop with a conflict
}

// diverged: local main has a commit that origin does not, so a ff-only fetch
// of main into main must be refused.
{
  const r = repos.diverged;
  git(r, 'checkout', '-q', '-b', 'feat/y');
  git(r, 'branch', '-f', 'main', FIRST);
  git(r, 'checkout', '-q', 'main');
  writeFileSync(join(r, 'local-only.txt'), 'local\n');
  git(r, 'add', '-A');
  git(r, 'commit', '-m', 'local only commit');
  git(r, 'checkout', '-q', 'feat/y');
}
const DIVERGED_MAIN = shaOf(repos.diverged, 'main');

// Snapshot everything before the run.
const before = Object.fromEntries(
  Object.entries(repos).map(([k, p]) => [
    k,
    { head: head(p), branch: branchOf(p), status: git(p, 'status', '--porcelain').out },
  ])
);

// ---------------------------------------------------------------------------
// Run it for real
// ---------------------------------------------------------------------------

console.log(`\npull-all test suite (${targetArg === 'ps' ? 'powershell' : 'node'})\n`);

const [exe, args] = invocation(reposDir);
const run = spawnSync(exe, args, { encoding: 'utf8', env: GIT_ENV });
const runOut = (run.stdout || '') + (run.stderr || '');

console.log('does the work:');
check(
  'clean repo on main is fast-forwarded',
  head(repos.cleanOnMain) === SECOND,
  `head=${head(repos.cleanOnMain).slice(0, 7)} want=${SECOND.slice(0, 7)}`
);
check(
  "feature branch: local main advanced, HEAD didn't move",
  shaOf(repos.featureBranch, 'main') === SECOND && head(repos.featureBranch) === FEATURE_HEAD,
  `main=${shaOf(repos.featureBranch, 'main').slice(0, 7)} head=${head(repos.featureBranch).slice(0, 7)}`
);
check(
  'feature branch is still checked out',
  branchOf(repos.featureBranch) === 'feat/x'
);
check(
  'feature commit still exists',
  existsSync(join(repos.featureBranch, 'feature.txt'))
);
// Unattended has to mean unattended. Asserted against the source of whichever
// target is under test, because a script that stops to ask for credentials
// blocks forever — there is no way to observe that from outside without
// hanging the suite on the very failure it is meant to catch.
const targetSource = readFileSync(
  resolve(here, targetArg === 'ps' ? 'pull-all.ps1' : 'pull-all.mjs'),
  'utf8'
);
check(
  'credential prompts are disabled',
  /GIT_TERMINAL_PROMPT\s*=\s*'0'/.test(targetSource) &&
    /GCM_INTERACTIVE\s*=\s*'never'/.test(targetSource),
  'must set GIT_TERMINAL_PROMPT=0 and GCM_INTERACTIVE=never before any git call'
);

console.log('\ndestroys nothing:');
check(
  'dirty repo: uncommitted work intact',
  readFileSync(join(repos.dirty, 'a.txt'), 'utf8').includes('MY UNCOMMITTED WORK')
);
check(
  'dirty repo: HEAD did not move',
  head(repos.dirty) === before.dirty.head
);
check(
  'dirty repo: still dirty (nothing was stashed)',
  git(repos.dirty, 'status', '--porcelain').out !== ''
);
check(
  'no stash was ever created',
  Object.values(repos).every((p) => git(p, 'stash', 'list').out === '')
);
check(
  'detached HEAD: untouched',
  head(repos.detached) === before.detached.head && branchOf(repos.detached) === 'HEAD'
);
check(
  'mid-rebase: still mid-rebase',
  existsSync(join(repos.midRebase, '.git', 'rebase-merge')) ||
    existsSync(join(repos.midRebase, '.git', 'rebase-apply'))
);
check(
  'mid-rebase: HEAD did not move',
  head(repos.midRebase) === before.midRebase.head
);
check(
  'diverged main: local commit not discarded',
  shaOf(repos.diverged, 'main') === DIVERGED_MAIN,
  `main=${shaOf(repos.diverged, 'main').slice(0, 7)} want=${DIVERGED_MAIN.slice(0, 7)}`
);
check(
  'diverged: HEAD did not move',
  head(repos.diverged) === before.diverged.head
);

console.log('\nreports honestly:');
check('exit code is 0 (skips are not failures)', run.status === 0, `status=${run.status}`);

const logDir = join(reposDir, '_logs');
const logName = readdirSync(logDir)
  .filter((f) => f.startsWith('pull-all_'))
  .sort()
  .at(-1);
const logText = logName ? readFileSync(join(logDir, logName), 'utf8') : '';
const summaryText = logText.split('--- summary ---')[1] || '';

check('a log file was written', Boolean(logName));
for (const [repo, result] of [
  ['dirty', 'skip/dirty'],
  ['detached', 'skip/detached'],
  ['mid-rebase', 'skip/in-progress'],
  ['diverged', 'skip/diverged'],
  ['clean-on-main', 'ok'],
  ['feature-branch', 'ok/branch'],
]) {
  const re = new RegExp(`^\\s*\\S+\\s+${repo}\\s+${result.replace('/', '\\/')}\\s*$`, 'm');
  check(`${repo} is reported as ${result}`, re.test(summaryText), summaryText.trim().slice(0, 400));
}

rmSync(rootDir, { recursive: true, force: true });

console.log(`\npass: ${pass}   fail: ${fail}\n`);
if (fail > 0 && runOut) console.log(runOut);
process.exit(fail > 0 ? 1 : 0);
