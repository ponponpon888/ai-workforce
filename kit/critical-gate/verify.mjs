#!/usr/bin/env node
/** Offline verification only; never installs hooks, connects a DB or executes SQL. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { evaluateRun } from './evidence.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sourceFiles = ['protocol.mjs', 'local-store.mjs', 'cli.mjs', 'example.sandbox.json',
  'test.mjs', 'evidence.mjs', 'test-evidence.mjs', 'verify.mjs', 'verify.ps1'];
const snapshot = () => Object.fromEntries(sourceFiles.map(name => [name,
  createHash('sha256').update(readFileSync(join(here, name))).digest('hex')]));
let output;
try {
  const options = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; const value = args[i + 1];
    if (!['--output', '--expected-platform', '--expected-node', '--launcher'].includes(key) ||
      Object.hasOwn(options, key) || !value || value.startsWith('--')) throw new Error('INVALID_ARGUMENTS');
    options[key] = value;
  }
  output = options['--output'] ? resolve(options['--output']) : mkdtempSync(join(tmpdir(), 'aiwf-critical-evidence-'));
  if (options['--output']) mkdirSync(output); // Existing output is an error, never overwrite evidence.
  const report = {
    schemaVersion: 1, startedAt: new Date().toISOString(), scope: 'offline-prototype-only', state: 'unverified',
    runtime: { platform: process.platform, osRelease: release(), arch: process.arch, node: process.version,
      launcherReported: options['--launcher'] || null },
    expected: { platform: options['--expected-platform'] || null, node: options['--expected-node'] || null },
    gitCommit: null, sourceSha256: snapshot(), counts: null, reasons: [],
    unverifiedTests: [], productionAuthorization: false, legacyWindowsRaceResolved: false,
  };
  const git = spawnSync('git', ['-C', here, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 });
  if (git.status === 0 && /^[a-f0-9]{40}$/.test(git.stdout.trim())) report.gitCommit = git.stdout.trim();
  if (report.expected.platform && report.expected.platform !== process.platform) report.reasons.push('PLATFORM_MISMATCH');
  if (report.expected.node && report.expected.node.replace(/^v/, '') !== process.versions.node) report.reasons.push('NODE_VERSION_MISMATCH');
  if (!report.reasons.length) {
    const env = { ...process.env };
    delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
    console.error('Running offline critical-gate tests; no production operations.');
    const run = spawnSync(process.execPath,
      ['--test', '--test-reporter=tap', '--test-concurrency=1', join(here, 'test.mjs'), join(here, 'test-evidence.mjs')],
      { cwd: here, env, encoding: 'utf8', timeout: 180000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(join(output, 'tests.tap'), run.stdout || '', { flag: 'wx' });
    writeFileSync(join(output, 'stderr.log'), run.stderr || '', { flag: 'wx' });
    Object.assign(report, evaluateRun(run, process.platform));
    report.process = { exitCode: run.status, signal: run.signal, errorCode: run.error?.code || null };
    if (JSON.stringify(snapshot()) !== JSON.stringify(report.sourceSha256)) {
      report.state = 'failed'; report.reasons.push('SOURCE_CHANGED_DURING_TEST');
    }
  }
  report.completedAt = new Date().toISOString();
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ state: report.state, counts: report.counts, unverifiedTests: report.unverifiedTests,
    reportFile: join(output, 'report.json'), reasons: report.reasons }, null, 2));
  process.exitCode = report.state.startsWith('passed') ? 0 : report.state === 'unverified' ? 2 : 1;
} catch (err) {
  // A missing or incomplete report is unverified, never implicit success.
  console.error('[critical-gate verify] ' + (err.code || err.message || 'VERIFICATION_ERROR'));
  process.exitCode = 2;
}
