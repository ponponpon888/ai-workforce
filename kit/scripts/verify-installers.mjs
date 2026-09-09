#!/usr/bin/env node
// Runs tests only in temporary homes. Never installs into the user's home.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--json') || args.length > 1) {
  console.error('Usage: node kit/scripts/verify-installers.mjs [--json]');
  process.exit(2);
}
const suite = fileURLToPath(new URL('./test-install-backups.mjs', import.meta.url));
const targets = [
  { name: 'node', executable: process.execPath, probe: ['--version'], args: [] },
  { name: 'powershell-7', executable: 'pwsh', probe: ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], args: ['--target', 'ps', '--pwsh', 'pwsh'] },
  { name: 'windows-powershell-5.1', executable: 'powershell.exe', probe: ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], args: ['--target', 'ps', '--pwsh', 'powershell.exe'] },
];
const results = targets.map(target => {
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
  const run = spawnSync(process.execPath, [suite, ...target.args], {
    encoding: 'utf8', timeout: 180000, maxBuffer: 2 * 1024 * 1024,
  });
  return { target: target.name, version, status: !run.error && run.status === 0 ? 'passed' : 'failed',
    exit_code: run.status, reason: run.error?.code ?? null,
    ...(run.error || run.status !== 0 ? { output: (run.stdout + run.stderr).slice(-16000) } : {}) };
});
const exitCode = results.some(r => r.status === 'failed') ? 1 : results.some(r => r.status === 'unverified') ? 2 : 0;
const report = { schema_version: 1, platform: process.platform, scope: 'installer-tests-on-this-machine', results, exit_code: exitCode };
if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  for (const r of results) {
    console.log(`${r.target}: ${r.status}${r.version ? ` (${r.version})` : ''}${r.reason ? ` - ${r.reason}` : ''}`);
    if (r.output) console.log(r.output);
  }
  console.log('Exit 0: all targets passed; 1: test failed; 2: some targets unverified.');
}
process.exitCode = exitCode;
