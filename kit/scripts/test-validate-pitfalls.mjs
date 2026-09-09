#!/usr/bin/env node
/**
 * test-validate-pitfalls.mjs — Test suite for validate-pitfalls.mjs.
 *
 * Every negative case breaks exactly one rule and asserts that the validator names that rule.
 * Asserting the rule id, not just the exit code, is the point: a validator that rejects
 * everything for the wrong reason would otherwise pass this whole file.
 *
 * The "must pass" half matters as much as the "must fail" half. A validator that fires on a
 * correct record gets deleted from CI within a week, and then nothing is checked at all.
 *
 * NOTE ON ORDER
 * The negative cases were run against a stub validator that accepted everything, and all of
 * them were observed failing, before any rule was written. The positive cases cannot be made
 * to fail first -- an empty validator accepts a valid record by doing nothing. That asymmetry
 * is the same one recorded in docs/02-guardrails.md: only the blocking side of a guard can be
 * made red before the fix.
 *
 *   node kit/scripts/test-validate-pitfalls.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const VALIDATOR = resolve(here, 'validate-pitfalls.mjs');
const repoRoot = resolve(here, '..', '..');

let pass = 0;
let fail = 0;

function runValidator(args) {
  const r = spawnSync(process.execPath, [VALIDATOR, ...args], { encoding: 'utf8', cwd: repoRoot });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/**
 * Write each record to its own file in a throwaway directory and validate it. Pass an array
 * of file maps to lay the records out over several directories, which is the only way to
 * reach the checks that span record sets.
 */
function validateFixture(files) {
  const maps = Array.isArray(files) ? files : [files];
  const dirs = maps.map(() => mkdtempSync(join(tmpdir(), 'aiwf-pitfall-')));
  try {
    maps.forEach((map, i) => {
      for (const [name, body] of Object.entries(map)) {
        const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
        writeFileSync(join(dirs[i], name), text, 'utf8');
      }
    });
    return runValidator(dirs.flatMap((d) => ['--dir', d]));
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
}

function accepts(name, files) {
  const r = validateFixture(files);
  if (r.code === 0) {
    console.log(`  PASS  ${name}`);
    pass++;
  } else {
    console.log(`  FAIL  ${name} (expected exit 0, got ${r.code})`);
    console.log(`        ${r.out.replace(/\r?\n/g, ' ').slice(0, 300)}`);
    fail++;
  }
}

function rejects(name, rule, files) {
  const r = validateFixture(files);
  const named = r.out.includes(`[${rule}]`);
  if (r.code === 1 && named) {
    console.log(`  PASS  ${name}  (${rule})`);
    pass++;
  } else {
    const why = r.code !== 1 ? `expected exit 1, got ${r.code}` : `did not name ${rule}`;
    console.log(`  FAIL  ${name} (${why})`);
    console.log(`        ${r.out.replace(/\r?\n/g, ' ').slice(0, 300)}`);
    fail++;
  }
}

// ---------------------------------------------------------------------------
// Fixtures. Every negative case starts from one of these and breaks one thing.
// ---------------------------------------------------------------------------

// Real headings in real files, so R13 and R14 pass unless a case breaks them on purpose.
const ORIGIN_TRAP = 'docs/02-guardrails.md#ただし両方に同じ穴があります';
const ORIGIN_BEHAVIOUR = 'docs/02-guardrails.md#powershell-のエイリアスは心配しなくてよかった';
const ORIGIN_ROADMAP = 'ROADMAP.md#v01-までに終わらせること';

const UNRECORDED_ENV = {
  os: 'unrecorded',
  shell: 'unrecorded',
  shell_version: 'unrecorded',
  claude_code_version: 'unrecorded',
  node_version: 'unrecorded',
};

const measuredOpen = () => ({
  id: 'perm-001',
  title: 'a trap that is being left open',
  summary: 'a pattern does not stop what it looks like it stops.',
  layer: 'permissions',
  kind: 'trap',
  severity: 'high',
  confidence: 'measured',
  origin: ORIGIN_TRAP,
  measured_on: '2026-09-08',
  environment: { ...UNRECORDED_ENV },
  repro: ['put three deny lines in a throwaway config', 'run echo, see which calls come back'],
  status: 'open_recorded',
  why_not_closed: 'closing it would stop everyday commands too.',
});

const measuredClosed = () => ({
  id: 'hook-001',
  title: 'a trap that was closed',
  summary: 'one grammar was applied to a string written in another grammar.',
  layer: 'hook',
  kind: 'trap',
  severity: 'high',
  confidence: 'measured',
  origin: 'docs/02-guardrails.md#3-つ目は賢くしたせいで空きました',
  measured_on: '2026-09-08',
  environment: { ...UNRECORDED_ENV, node_version: '20' },
  repro: ['node kit/scripts/test-guard-sql.mjs'],
  status: 'closed',
  fix: 'the grammar is chosen from the tool name and the field name together.',
  detection: {
    checkable: true,
    kind: 'file-content',
    target: 'kit/claude/hooks/guard-sql.mjs',
    pattern: "grammar === 'shell'",
    expect: 'present',
    message: 'the shell-grammar bypass must stay',
  },
});

const behaviour = () => ({
  id: 'perm-002',
  title: 'deny wins over allow',
  summary: 'a call listed in allow is still refused when a deny pattern matches it.',
  layer: 'permissions',
  kind: 'behaviour',
  severity: 'low',
  confidence: 'measured',
  origin: ORIGIN_BEHAVIOUR,
  measured_on: '2026-09-08',
  environment: { ...UNRECORDED_ENV },
  repro: ['put the same command in allow and in deny', 'call it'],
});

const documented = () => ({
  id: 'mcp-001',
  title: 'role separation does not constrain the MCP server',
  summary: 'the server runs with the developer account, above any grant.',
  layer: 'external',
  kind: 'limitation',
  severity: 'high',
  confidence: 'documented',
  origin: 'docs/06-supabase-mcp.md#最初に考えた対策は効きません',
  sources: ['https://supabase.com/docs/guides/ai-tools/mcp'],
  status: 'closed',
  fix: 'constrain the connection URL instead.',
});

const inferred = () => ({
  id: 'perm-004',
  title: 'an alias that collides with an executable',
  summary: 'a prefix match on a short alias reaches an unrelated program.',
  layer: 'permissions',
  kind: 'trap',
  severity: 'medium',
  confidence: 'inferred',
  origin: ORIGIN_ROADMAP,
  inferred_from: ['perm-001'],
  status: 'untouched',
});

const unverified = () => ({
  id: 'perm-003',
  title: 'path-side glob spellings are unknown',
  summary: 'four spellings are in use and none of them has been tried.',
  layer: 'permissions',
  kind: 'limitation',
  severity: 'medium',
  confidence: 'unverified',
  origin: ORIGIN_ROADMAP,
  status: 'untouched',
});

const f = (record, overrides = {}, drop = []) => {
  const out = { ...record, ...overrides };
  for (const key of drop) delete out[key];
  return { [`${out.id}.json`]: out };
};

// ---------------------------------------------------------------------------

console.log('\nvalidate-pitfalls test suite\n');

console.log('must accept:');
accepts('measured, open_recorded', f(measuredOpen()));
accepts('measured, closed, with a checkable detection', f(measuredClosed()));
accepts('behaviour, no status', f(behaviour()));
accepts('documented, closed', f(documented()));
accepts('inferred, untouched', f(inferred()));
accepts('unverified, untouched', f(unverified()));
accepts('an empty directory', {});
accepts('a record that points at another record in the same set', {
  'perm-001.json': { ...measuredOpen(), related: ['perm-003'] },
  'perm-003.json': unverified(),
});
accepts('a record that points at a record in another set',
  [f(measuredOpen(), { related: ['perm-003'] }), f(unverified())]);
accepts('_ files are not records', {
  '_notes.json': { this: 'is not a record' },
  'perm-003.json': unverified(),
});
// The control for the claim gate below. Without it the gate could be a blanket ban on the
// word and every rejection would still pass.
accepts('claim gate allows 実測 on a measured record',
  f(measuredOpen(), { summary: '実測した。前方一致は単語の途中では切れない。' }));

console.log('\nmust reject:');
rejects('file name does not match id', 'R01', {
  'perm-999.json': measuredOpen(),
});
rejects('a required field is missing', 'R02', f(measuredOpen(), {}, ['summary']));
rejects('an unknown field is present', 'R02', f(measuredOpen(), { notes: 'stray' }));
rejects('an enum value is not in the list', 'R03', f(measuredOpen(), { confidence: 'probably' }));
rejects('a field has the wrong type', 'R03', f(measuredOpen(), { repro: 'one string' }));
rejects('id does not match the pattern', 'R04', {
  'Perm-1.json': { ...measuredOpen(), id: 'Perm-1' },
});
rejects('measured without repro', 'R05', f(measuredOpen(), {}, ['repro']));
rejects('measured without environment', 'R05', f(measuredOpen(), {}, ['environment']));
rejects('measured without measured_on', 'R05', f(measuredOpen(), {}, ['measured_on']));
rejects('not measured but carries an environment', 'R05',
  f(unverified(), { environment: { ...UNRECORDED_ENV } }));
rejects('environment is missing one of the five', 'R06',
  f(measuredOpen(), { environment: { os: 'unrecorded', shell: 'unrecorded', shell_version: 'unrecorded', node_version: 'unrecorded' } }));
rejects('environment carries an extra field', 'R06',
  f(measuredOpen(), { environment: { ...UNRECORDED_ENV, editor: 'vim' } }));
rejects('documented without sources', 'R07', f(documented(), {}, ['sources']));
rejects('documented with an empty sources list', 'R07', f(documented(), { sources: [] }));
rejects('inferred without inferred_from', 'R08', f(inferred(), {}, ['inferred_from']));
rejects('behaviour carries a status', 'R09', f(behaviour(), { status: 'untouched' }));
rejects('trap without a status', 'R09', f(measuredOpen(), {}, ['status', 'why_not_closed']));
rejects('closed without a fix', 'R10', f(measuredClosed(), {}, ['fix']));
rejects('open_recorded without why_not_closed', 'R10', f(measuredOpen(), {}, ['why_not_closed']));
rejects('claim gate: 実測 in the summary of an inferred record', 'R11',
  f(inferred(), { summary: '実測したところ、短い別名が別の実行ファイルに届く。' }));
rejects('claim gate: measured in the fix of a documented record', 'R11',
  f(documented(), { fix: 'measured it and switched to the connection URL.' }));
rejects('claim gate: 確認済み in the summary of an unverified record', 'R11',
  f(unverified(), { summary: '確認済みだが、まだ何も試していない。' }));
rejects('related points at an id that does not exist', 'R12',
  f(measuredOpen(), { related: ['perm-777'] }));
rejects('origin file does not exist', 'R13',
  f(measuredOpen(), { origin: 'docs/99-does-not-exist.md#anything' }));
rejects('origin uses a line number', 'R13',
  f(measuredOpen(), { origin: 'docs/02-guardrails.md#L78' }));
rejects('origin uses a colon line number', 'R13',
  f(measuredOpen(), { origin: 'docs/02-guardrails.md:78' }));
rejects('origin anchor is not a heading in that file', 'R14',
  f(measuredOpen(), { origin: 'docs/02-guardrails.md#no-such-heading-here' }));
rejects('checkable detection without a pattern', 'R15',
  f(measuredClosed(), { detection: { checkable: true, kind: 'file-content', target: 'kit/claude/hooks/guard-sql.mjs', expect: 'present' } }));
rejects('checkable detection without an expect polarity', 'R15',
  f(measuredClosed(), { detection: { checkable: true, kind: 'file-content', target: 'kit/claude/hooks/guard-sql.mjs', pattern: 'x' } }));
rejects('detection expect is not present or absent', 'R15',
  f(measuredClosed(), { detection: { checkable: true, kind: 'file-content', target: 'x', pattern: 'y', expect: 'maybe' } }));
rejects('measured_on is not a date', 'R16',
  f(measuredOpen(), { measured_on: 'last tuesday' }));
// "unrecorded" is fine for an environment field and not for this one. A measurement without
// a date cannot be aged, and a record that cannot be aged cannot be re-checked when the thing
// it measured changes underneath it.
rejects('measured_on is "unrecorded"', 'R16',
  f(measuredOpen(), { measured_on: 'unrecorded' }));
rejects('the file does not parse as JSON', 'R17', { 'perm-001.json': '{ not json' });
rejects('the same id in two record sets', 'R18', [f(measuredOpen()), f(measuredOpen())]);

console.log('\nthe records in this repository:');
{
  const r = runValidator([]);
  if (r.code === 0) {
    console.log('  PASS  data/pitfalls and data/app-pitfalls validate');
    pass++;
  } else {
    console.log(`  FAIL  data/pitfalls and data/app-pitfalls validate (exit ${r.code})`);
    console.log(r.out);
    fail++;
  }
}

console.log(`\npass: ${pass}   fail: ${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
