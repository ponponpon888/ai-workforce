#!/usr/bin/env node
/**
 * test-record-settings-baseline.mjs — Test suite for record-settings-baseline.mjs.
 *
 *   node kit/scripts/test-record-settings-baseline.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, 'record-settings-baseline.mjs');

let pass = 0;
let fail = 0;

function assert(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); fail++; }
}

function fixture(fn) {
  const home = mkdtempSync(join(tmpdir(), 'aiwf-record-baseline-'));
  try { fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

function run(args, { input } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8' });
}

console.log('\nrecord-settings-baseline test suite (node)\n');

fixture((home) => {
  const r = run(['--claude-home', home]);
  assert('no settings.json fails with a clear message', r.status === 1 && /no settings\.json/.test(r.stderr), r.stderr);
  assert('nothing is created on that failure', !existsSync(join(home, 'known-good')));
});

fixture((home) => {
  writeFileSync(join(home, 'settings.json'), '{broken');
  const r = run(['--claude-home', home]);
  assert('invalid JSON fails with a clear message', r.status === 1 && /not valid JSON/.test(r.stderr), r.stderr);
  assert('nothing is created on that failure', !existsSync(join(home, 'known-good')));
});

fixture((home) => {
  writeFileSync(join(home, 'settings.json'), '{"a":1}');
  const r = run(['--claude-home', home, '--force']);
  assert('first record with --force succeeds without a prompt', r.status === 0, r.stderr);
  assert('records a baseline identical to settings.json', existsSync(join(home, 'known-good', 'settings.json')) &&
    readFileSync(join(home, 'known-good', 'settings.json'), 'utf8') === '{"a":1}');
});

fixture((home) => {
  writeFileSync(join(home, 'settings.json'), '{"a":1}');
  run(['--claude-home', home, '--force']);
  const r = run(['--claude-home', home, '--force']);
  assert('re-running with no change is a no-op, exit 0', r.status === 0, r.stderr);
  assert('says nothing to do', /nothing to do/i.test(r.stdout), r.stdout);
});

fixture((home) => {
  writeFileSync(join(home, 'settings.json'), '{"a":1}');
  run(['--claude-home', home, '--force']);
  writeFileSync(join(home, 'settings.json'), '{"a":2}');
  const r = run(['--claude-home', home], { input: 'n\n' });
  assert('declining the prompt exits nonzero', r.status !== 0, r.stderr);
  assert('declining leaves the recorded baseline untouched', readFileSync(join(home, 'known-good', 'settings.json'), 'utf8') === '{"a":1}');
  assert('shows a diff against the previous baseline', r.stdout.includes('-{"a":1}') && r.stdout.includes('+{"a":2}'), r.stdout);
});

fixture((home) => {
  writeFileSync(join(home, 'settings.json'), '{"a":1}');
  run(['--claude-home', home, '--force']);
  writeFileSync(join(home, 'settings.json'), '{"a":2}');
  const r = run(['--claude-home', home], { input: 'y\n' });
  assert('accepting the prompt exits 0', r.status === 0, r.stderr);
  assert('accepting updates the recorded baseline', readFileSync(join(home, 'known-good', 'settings.json'), 'utf8') === '{"a":2}');
});

{
  const r = run(['--wat']);
  assert('unknown option is rejected', r.status === 1 && /unknown option/.test(r.stderr), r.stderr);
}

{
  const r = run(['--claude-home']);
  assert('--claude-home with no value is rejected', r.status === 1 && /needs a path/.test(r.stderr), r.stderr);
}

console.log(`\npass: ${pass}   fail: ${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
