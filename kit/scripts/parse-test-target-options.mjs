// Shared CLI validation for suites that can execute Node, PowerShell or POSIX
// shell tools. The allow-list is per suite, so --target sh is only accepted by
// a suite that actually has a shell twin to run.
export function parseTestTargetOptions(args, allowed = ['node', 'ps']) {
  const options = { target: 'node', pwsh: 'pwsh' };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--target', '--pwsh'].includes(flag) || seen.has(flag)) throw new Error('Invalid option');
    seen.add(flag);
    const value = args[++i];
    if (!value?.trim() || value.startsWith('--')) throw new Error('Missing option value');
    options[flag.slice(2)] = value;
  }
  if (!allowed.includes(options.target)) throw new Error('Unknown test target');
  if (seen.has('--pwsh') && options.target !== 'ps') throw new Error('--pwsh requires --target ps');
  return options;
}

export function readTestTargetOptions(args = process.argv.slice(2), allowed = ['node', 'ps']) {
  try { return parseTestTargetOptions(args, allowed); }
  catch {
    console.error(`Usage: node <test-suite.mjs> [--target ${allowed.join('|')}] [--pwsh <executable> (requires --target ps)]`);
    process.exit(2);
  }
}
