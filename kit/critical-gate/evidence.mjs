/** Evaluate only our flat Node TAP suites. Unknown/incomplete output is not a pass. */
export const REQUIRED_TESTS = [
  'six concurrent claimers have exactly one winner, repeated 40 rounds',
  'unexpected worker failures cannot count as expected denials',
  ...['before-create', 'after-create', 'after-flush'].map(stage => `external kill at ${stage} preserves the correct claim state`),
];
export const WINDOWS_SKIP = 'symlinked record cannot authorize a claim';
export function evaluateRun(run, platform) {
  const text = String(run.stdout || '').replaceAll('\r\n', '\n');
  const reasons = [], counts = {};
  for (const key of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const found = [...text.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))];
    if (found.length !== 1) reasons.push(`missing-or-duplicate-${key}`);
    else counts[key] = Number(found[0][1]);
  }
  const plans = [...text.matchAll(/^1\.\.(\d+)$/gm)];
  const rows = [...text.matchAll(/^(ok|not ok) (\d+) - (.+)$/gm)].map(m => {
    const split = m[3].split(/ # SKIP(?: |$)/i);
    return { ok: m[1] === 'ok', index: Number(m[2]), name: split[0], skipped: split.length > 1 };
  });
  if ((text.match(/^TAP version 13$/gm) || []).length !== 1) reasons.push('missing-or-duplicate-header');
  if (plans.length !== 1 || Number(plans[0][1]) !== counts.tests) reasons.push('invalid-plan');
  if (!Number.isSafeInteger(counts.tests) || counts.tests < 73 || counts.suites !== 0) reasons.push('incomplete-suite');
  if (rows.length !== counts.tests || rows.some((r, i) => r.index !== i + 1)) reasons.push('invalid-test-sequence');
  if (counts.tests !== counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo) reasons.push('inconsistent-counts');
  const skips = rows.filter(r => r.skipped).map(r => r.name);
  if (skips.length !== counts.skipped || skips.some(name => platform !== 'win32' || name !== WINDOWS_SKIP) || skips.length > 1) reasons.push('unexpected-skip');
  if (counts.pass !== rows.filter(r => r.ok && !r.skipped).length) reasons.push('inconsistent-pass-count');
  if (rows.some(r => !r.ok) || counts.fail || counts.cancelled || counts.todo) reasons.push('test-not-passed');
  for (const name of REQUIRED_TESTS) {
    if (rows.filter(r => r.name === name && r.ok && !r.skipped).length !== 1) reasons.push('missing-required-test:' + name);
  }
  if (run.status !== 0 || run.signal || run.error) reasons.push('process-not-successful');
  const state = reasons.length ? 'failed' : skips.length ? 'passed-with-skips' : 'passed';
  return { state, counts, unverifiedTests: skips, reasons };
}
