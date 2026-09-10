import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRun, REQUIRED_TESTS, WINDOWS_SKIP } from './evidence.mjs';

function fixture({ skip = false, skipName = WINDOWS_SKIP } = {}) {
  const names = [...REQUIRED_TESTS, ...Array.from({ length: 72 - REQUIRED_TESTS.length }, (_, i) => 'fixture-' + i), skipName];
  return { status: 0, signal: null, stdout: 'TAP version 13\n' + names.map((name, i) =>
    `ok ${i + 1} - ${name}${skip && i === 72 ? ' # SKIP requires privilege' : ''}`).join('\n') +
    `\n1..73\n# tests 73\n# suites 0\n# pass ${skip ? 72 : 73}\n# fail 0\n# cancelled 0\n# skipped ${skip ? 1 : 0}\n# todo 0\n` };
}
test('evidence: complete successful TAP is accepted', () => {
  assert.equal(evaluateRun(fixture(), 'linux').state, 'passed');
});
test('evidence: permitted Windows skip is visible, not counted as verified', () => {
  const result = evaluateRun(fixture({ skip: true }), 'win32');
  assert.equal(result.state, 'passed-with-skips');
  assert.equal(result.counts.pass, 72); assert.deepEqual(result.unverifiedTests, [WINDOWS_SKIP]);
});
const broken = [
  ['empty output', r => { r.stdout = ''; }],
  ['nonzero exit', r => { r.status = 1; }],
  ['signal', r => { r.signal = 'SIGKILL'; }],
  ['spawn failure', r => { r.error = 'ENOENT'; }],
  ['missing plan', r => { r.stdout = r.stdout.replace('1..73\n', ''); }],
  ['duplicate summary', r => { r.stdout += '# tests 73\n'; }],
  ['missing counter', r => { r.stdout = r.stdout.replace('# cancelled 0\n', ''); }],
  ['not ok with exit zero', r => { r.stdout = r.stdout.replace('ok 1 -', 'not ok 1 -'); }],
  ['inconsistent count', r => { r.stdout = r.stdout.replace('# pass 73', '# pass 72'); }],
  ['test numbering gap', r => { r.stdout = r.stdout.replace('ok 2 -', 'ok 3 -'); }],
  ['required test absent', r => { r.stdout = r.stdout.replace(REQUIRED_TESTS[0], 'renamed'); }],
  ['cancelled test', r => { r.stdout = r.stdout.replace('# cancelled 0', '# cancelled 1'); }],
  ['unfinished test', r => { r.stdout = r.stdout.replace('# todo 0', '# todo 1'); }],
  ['duplicate header', r => { r.stdout += 'TAP version 13\n'; }],
];
for (const [name, change] of broken) test(`evidence rejects ${name}`, () => {
  const run = fixture(); change(run); assert.equal(evaluateRun(run, 'linux').state, 'failed');
});
test('evidence rejects a Windows-only skip on Linux', () => {
  assert.equal(evaluateRun(fixture({ skip: true }), 'linux').state, 'failed');
});
test('evidence rejects any other skipped Windows test', () => {
  assert.equal(evaluateRun(fixture({ skip: true, skipName: 'another-test' }), 'win32').state, 'failed');
});
