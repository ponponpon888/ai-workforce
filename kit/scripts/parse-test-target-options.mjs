// Shared CLI validation for suites that can execute Node or PowerShell tools.
export function parseTestTargetOptions(args) {
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
  if (!['node', 'ps'].includes(options.target)) throw new Error('Unknown test target');
  if (seen.has('--pwsh') && options.target !== 'ps') throw new Error('--pwsh requires --target ps');
  return options;
}

export function readTestTargetOptions(args = process.argv.slice(2)) {
  try { return parseTestTargetOptions(args); }
  catch {
    console.error('Usage: node <test-suite.mjs> [--target node|ps] [--pwsh <executable> (requires --target ps)]');
    process.exit(2);
  }
}
