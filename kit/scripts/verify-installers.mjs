#!/usr/bin/env node
// Runs fixture-based verification suites, never commands against user repositories.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const suites = {
  installers: { file: './test-install-backups.mjs', scope: 'installer-tests-on-this-machine' },
  'pull-all': { file: './test-pull-all.mjs', scope: 'pull-all-tests-on-this-machine' },
  'guard-secrets': { file: './test-guard-secrets.mjs', scope: 'guard-secrets-tests-on-this-machine' },
  'guard-sql': { file: './test-guard-sql.mjs', psFile: './test-guard-sql.ps1', scope: 'guard-sql-tests-on-this-machine' },
  'sql-boundaries': { file: './test-sql-boundaries.mjs', scope: 'sql-boundaries-tests-on-this-machine' },
};
const args = process.argv.slice(2);
let suiteName = 'installers';
let selectedTarget = 'all';
const targetNames = ['node', 'powershell-7', 'windows-powershell-5.1'];
const seen = new Set();
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (!['--json', '--suite', '--target'].includes(arg) || seen.has(arg)) usage();
  seen.add(arg);
  if (arg === '--suite') {
    suiteName = args[++i];
    if (suiteName !== 'core' && !Object.hasOwn(suites, suiteName)) usage();
  }
  if (arg === '--target') {
    selectedTarget = args[++i];
    if (!['all', ...targetNames].includes(selectedTarget)) usage();
  }
}
function usage() {
  console.error('Usage: node kit/scripts/verify-installers.mjs [--suite core|installers|pull-all|guard-secrets|guard-sql|sql-boundaries] [--target all|node|powershell-7|windows-powershell-5.1] [--json]');
  process.exit(2);
}
const selectedSuites = suiteName === 'core' ? Object.keys(suites) : [suiteName];
function runSuite(name, target) {
  const definition = suites[name];
  const nativePS = target.name !== 'node' && definition.psFile;
  const path = fileURLToPath(new URL(nativePS || definition.file, import.meta.url));
  const executable = nativePS ? target.executable : process.execPath;
  const args = nativePS ? ['-NoProfile', '-File', path] : [path, ...target.args];
  const run = spawnSync(executable, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
  return { suite: name, status: !run.error && run.status === 0 ? 'passed' : 'failed',
    exit_code: run.status, reason: run.error?.code ?? null,
    ...(run.error || run.status !== 0 ? { output: ((run.stdout || '') + (run.stderr || '')).slice(-16000) } : {}) };
}
const targets = [
  { name: 'node', executable: process.execPath, probe: ['--version'], args: [] },
  { name: 'powershell-7', executable: 'pwsh', probe: ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], args: ['--target', 'ps', '--pwsh', 'pwsh'] },
  { name: 'windows-powershell-5.1', executable: 'powershell.exe', probe: ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], args: ['--target', 'ps', '--pwsh', 'powershell.exe'] },
];
const selected = targets.filter(target => selectedTarget === 'all' || target.name === selectedTarget);
const results = selected.map(target => {
  if (target.name === 'windows-powershell-5.1' && process.platform !== 'win32') {
    return { target: target.name, status: 'unverified', reason: 'requires-windows' };
  }
  const probe = spawnSync(target.executable, target.probe, { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  if (probe.error || probe.status !== 0) {
    return { target: target.name, status: 'unverified', reason: probe.error?.code === 'ENOENT' ? 'runtime-not-found' : 'runtime-probe-failed' };
  }
  const version = probe.stdout.trim();
  if ((target.name === 'powershell-7' && !/^7\./.test(version)) ||
      (target.name === 'windows-powershell-5.1' && !/^5\.1\./.test(version))) {
    return { target: target.name, status: 'unverified', reason: 'unexpected-runtime-version', version };
  }
  const checks = selectedSuites.map(name => runSuite(name, target));
  if (suiteName !== 'core') return { target: target.name, version, ...checks[0] };
  const failed = checks.some(check => check.status === 'failed');
  return { target: target.name, version, status: failed ? 'failed' : 'passed',
    exit_code: failed ? 1 : 0, checks };
});
const exitCode = results.some(r => r.status === 'failed') ? 1 : results.some(r => r.status === 'unverified') ? 2 : 0;
const report = { schema_version: 1, platform: process.platform, requested_target: selectedTarget, selected_targets: selected.map(t => t.name), selected_suites: selectedSuites, scope: suiteName === 'core' ? 'core-tests-on-this-machine' : suites[suiteName].scope, results, exit_code: exitCode };
if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`Suite: ${suiteName}; selected targets: ${selected.map(t => t.name).join(', ')}`);
  for (const r of results) {
    console.log(`${r.target}: ${r.status}${r.version ? ` (${r.version})` : ''}${r.reason ? ` - ${r.reason}` : ''}`);
    if (r.output) console.log(r.output);
    for (const check of r.checks || []) {
      console.log(`  ${check.suite}: ${check.status}`);
      if (check.output) console.log(check.output);
    }
  }
  console.log('Exit 0: selected targets passed; 1: test failed; 2: some selected targets unverified.');
}
process.exitCode = exitCode;
