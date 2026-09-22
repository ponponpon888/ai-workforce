import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandsIn, runSuite, checkCommands } from './check-doc-commands.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fence = (body) => '```bash\n' + body + '\n```';
const shapes = (text) => commandsIn(text).map(c => `${c.script} ${c.pass}/${c.fail}`);

// What counts as a documented result at all.
for (const [name, text, expected] of [
  ['the convention as the READMEs write it',
    fence('node kit/scripts/test-guard-sql.mjs    # pass: 91   fail: 0'), ['test-guard-sql.mjs 91/0']],
  ['single spaces', fence('node kit/scripts/test-a.mjs # pass: 1 fail: 2'), ['test-a.mjs 1/2']],
  ['indented inside the fence', fence('  node kit/scripts/test-a.mjs   # pass: 3   fail: 0'), ['test-a.mjs 3/0']],
  ['two commands in one block',
    fence('node kit/scripts/test-a.mjs   # pass: 1   fail: 0\nnode kit/scripts/test-b.mjs   # pass: 2   fail: 0'),
    ['test-a.mjs 1/0', 'test-b.mjs 2/0']],
  ['CRLF', '```bash\r\nnode kit/scripts/test-a.mjs   # pass: 1   fail: 0\r\n```\r\n', ['test-a.mjs 1/0']],
  ['a tilde fence', '~~~\nnode kit/scripts/test-a.mjs   # pass: 1   fail: 0\n~~~', ['test-a.mjs 1/0']],
  ['other lines in the block are left alone',
    fence('cd /tmp\nnode kit/scripts/test-a.mjs   # pass: 1   fail: 0\necho done'), ['test-a.mjs 1/0']],

  // Prose is not a promise about what a command prints, and a command with no
  // expected output beside it is not claiming anything to check.
  ['outside a fence', 'node kit/scripts/test-a.mjs   # pass: 1   fail: 0', []],
  ['no expected output', fence('node kit/scripts/test-a.mjs'), []],
  ['a different comment', fence('node kit/scripts/test-a.mjs   # Windows / macOS / Linux'), []],
  ['only the pass half', fence('node kit/scripts/test-a.mjs   # pass: 1'), []],

  // NOTHING else is ever run. These must not even be recognised, because
  // recognising them is what would make an edited page able to run anything.
  ['a script that is not a test suite', fence('node kit/scripts/install.mjs   # pass: 1   fail: 0'), []],
  ['a path outside kit/scripts', fence('node ../evil.mjs   # pass: 1   fail: 0'), []],
  ['a traversal dressed as a suite', fence('node kit/scripts/../../evil.mjs   # pass: 1   fail: 0'), []],
  ['arguments taken from the page', fence('node kit/scripts/test-a.mjs --root /   # pass: 1   fail: 0'), []],
  ['a shell chain after the command', fence('node kit/scripts/test-a.mjs; rm -rf /   # pass: 1   fail: 0'), []],
  ['an interpreter that is not node', fence('bash kit/scripts/test-a.mjs   # pass: 1   fail: 0'), []],
  ['a PowerShell twin', fence('pwsh kit/scripts/test-a.ps1   # pass: 1   fail: 0'), []],
  ['an uppercase or dotted script name', fence('node kit/scripts/test-A.b.mjs   # pass: 1   fail: 0'), []],
]) test(name, () => assert.deepEqual(shapes(text), expected));

test('the line number is the line the command is on', () => {
  assert.equal(commandsIn('a\n\n' + fence('node kit/scripts/test-a.mjs   # pass: 1   fail: 0'))[0].line, 4);
});

const build = (files, scripts = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'doc-commands-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'kit', 'scripts'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '');
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(root, 'kit', 'scripts', name), body);
    chmodSync(join(root, 'kit', 'scripts', name), 0o644);
  }
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
};
const run = (files, scripts, fn) => {
  const root = build(files, scripts);
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

const suite = (pass, fail, extra = '') =>
  `${extra}console.log("  PASS  something");\nconsole.log("pass: ${pass}   fail: ${fail}");\n`;

test('a suite that prints what the page says is not reported', () => {
  run({ 'docs/a.md': fence('node kit/scripts/test-a.mjs   # pass: 7   fail: 0') },
    { 'test-a.mjs': suite(7, 0) },
    root => assert.deepEqual(checkCommands(root).findings, []));
});

test('a suite that prints something else is reported with both numbers', () => {
  run({ 'docs/a.md': fence('node kit/scripts/test-a.mjs   # pass: 7   fail: 0') },
    { 'test-a.mjs': suite(9, 0) },
    root => {
      const [f] = checkCommands(root).findings;
      assert.equal(f.path, 'docs/a.md');
      assert.equal(f.script, 'test-a.mjs');
      assert.match(f.why, /says pass: 7 {2}fail: 0, the suite prints pass: 9 {2}fail: 0/);
    });
});

test('a failing suite is reported as its real numbers, not as a mismatch it is not', () => {
  run({ 'docs/a.md': fence('node kit/scripts/test-a.mjs   # pass: 2   fail: 1') },
    { 'test-a.mjs': suite(2, 1, 'process.exitCode = 1;\n') },
    root => assert.deepEqual(checkCommands(root).findings, []));
});

test('a suite that prints no result line is reported, not treated as passing', () => {
  run({ 'docs/a.md': fence('node kit/scripts/test-a.mjs   # pass: 1   fail: 0') },
    { 'test-a.mjs': 'console.log("nothing useful");\n' },
    root => assert.match(checkCommands(root).findings[0].why, /printed no result line/));
});

// The guard suites use this repository's own runner; everything else is a
// node:test file and prints TAP. Reading only one shape would quietly stop
// checking half the suites.
const tap = (pass, fail) => `console.log("# tests ${pass + fail}");\nconsole.log("# pass ${pass}");\nconsole.log("# fail ${fail}");\n`;

test('a node:test suite is read from its TAP summary', () => {
  run({}, { 'test-a.mjs': tap(30, 0) },
    root => assert.deepEqual(runSuite(root, 'test-a.mjs'), { pass: 30, fail: 0 }));
});

test('a TAP suite whose count disagrees with the page is reported', () => {
  run({ 'docs/a.md': fence('node kit/scripts/test-a.mjs   # pass: 26   fail: 0') },
    { 'test-a.mjs': tap(30, 0) },
    root => assert.match(checkCommands(root).findings[0].why, /says pass: 26.*prints pass: 30/));
});

test('TAP with failures is read as failures, not as unreadable', () => {
  run({}, { 'test-a.mjs': tap(37, 1) + 'process.exitCode = 1;\n' },
    root => assert.deepEqual(runSuite(root, 'test-a.mjs'), { pass: 37, fail: 1 }));
});

test('half a TAP summary is not guessed at', () => {
  run({}, { 'test-a.mjs': 'console.log("# pass 3");\n' },
    root => assert.match(runSuite(root, 'test-a.mjs').why, /printed no result line/));
});

test('a documented script that does not exist is reported', () => {
  run({ 'docs/a.md': fence('node kit/scripts/test-gone.mjs   # pass: 1   fail: 0') }, {},
    root => assert.match(checkCommands(root).findings[0].why, /no such script/));
});

test('a suite named on several pages is run once', () => {
  const calls = [];
  run({ 'docs/a.md': fence('node kit/scripts/test-a.mjs   # pass: 1   fail: 0'),
        'docs/b.md': fence('node kit/scripts/test-a.mjs   # pass: 1   fail: 0') }, {},
    root => {
      const out = checkCommands(root, (_r, s) => { calls.push(s); return { pass: 1, fail: 0 }; });
      assert.deepEqual(calls, ['test-a.mjs']);
      assert.equal(out.checked, 2);
      assert.equal(out.suites, 1);
    });
});

test('runSuite reads the last result line the suite prints', () => {
  run({}, { 'test-a.mjs': suite(4, 0) },
    root => assert.deepEqual(runSuite(root, 'test-a.mjs'), { pass: 4, fail: 0 }));
});

test('every Markdown file check-doc-links reads is read here too', () => {
  const root = build({ 'docs/nested/guide.md': fence('node kit/scripts/test-a.mjs   # pass: 1   fail: 0') },
    { 'test-a.mjs': suite(2, 0) });
  try {
    writeFileSync(join(root, 'README.md'), fence('node kit/scripts/test-a.mjs   # pass: 1   fail: 0'));
    assert.deepEqual(checkCommands(root).findings.map(f => f.path).sort(),
      ['README.md', 'docs/nested/guide.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
