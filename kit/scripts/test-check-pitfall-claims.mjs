import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimsIn, checkClaims, frozenFrom, recordsIn, CHECKED_FIELDS } from './check-pitfall-claims.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const attributed = (text, path = '') =>
  claimsIn(text, path).map(c => `${c.id ?? '-'} ${c.field}=${c.claimed}`);

// Which quotes get attributed to which record, and which are left alone.
for (const [name, text, expected] of [
  ['brackets after a link',
    '[hook-010](data/pitfalls/hook-010.json)（`status: closed`）', ['hook-010 status=closed']],
  ['brackets around the link',
    '（[hook-010](data/pitfalls/hook-010.json) / status: closed）', ['hook-010 status=closed']],
  ['ASCII brackets around the link',
    '([hook-010](../data/pitfalls/hook-010.json), status: closed)', ['hook-010 status=closed']],
  ['prose between the link and the brackets',
    '**[hook-010](data/pitfalls/hook-010.json) を塞いだ**（status: closed）', ['hook-010 status=closed']],
  ['two fields in one bracket group',
    '[hook-011](data/pitfalls/hook-011.json)（`kind: limitation`, `status: open_recorded`）',
    ['hook-011 kind=limitation', 'hook-011 status=open_recorded']],
  ['a bare id counts as a mention',
    'hook-006 はこう（confidence: inferred）', ['hook-006 confidence=inferred']],
  ['a full-width colon', '[a](data/pitfalls/hook-010.json)（status： closed）', ['hook-010 status=closed']],
  ['the quote spans a line break',
    '[hook-011](data/pitfalls/hook-011.json)（`kind: limitation`\n— なぜなら）', ['hook-011 kind=limitation']],

  // The reason this checker looks at brackets at all. docs/02 contrasts two
  // records in running prose: one quote precedes the id it describes, the
  // other follows a different one. Guessing either way reports a correct
  // sentence as wrong, so neither is attributed.
  ['a quote outside brackets is not attributed',
    '[hook-011](data/pitfalls/hook-011.json) として別記録にしています。`kind: behaviour` の\nhook-007 自体には', ['- kind=behaviour']],
  ['the last record before the quote wins',
    'A は [hook-007](data/pitfalls/hook-007.json)、B は [hook-011](data/pitfalls/hook-011.json)（`status: open_recorded`）',
    ['hook-011 status=open_recorded']],
  ['a mention after the quote does not count',
    '（status: closed）のちに hook-010 と書いても', ['- status=closed']],
  ['a mention in the previous paragraph does not count',
    '[hook-010](data/pitfalls/hook-010.json) の話。\n\n別の段落（status: closed）', ['- status=closed']],
  ['no mention at all', 'ここには（status: closed）しかない', ['- status=closed']],

  ['a fenced example is not a quote',
    '```json\n"status": "closed"\n```', []],
  ['a fenced example beside a real quote',
    '```\n(status: closed)\n```\n[hook-010](data/pitfalls/hook-010.json)（status: open_recorded）',
    ['hook-010 status=open_recorded']],
  ['an unmatched closing bracket is prose',
    'なにか）status: closed', ['- status=closed']],
  ['stale_risk is not a record field, so it is never quoted from one',
    '[hook-010](data/pitfalls/hook-010.json)（stale_risk: unknown_version）', []],
]) test(name, () => assert.deepEqual(attributed(text), expected));

test('every checked field is recognised', () => {
  const text = CHECKED_FIELDS.map(f => `[hook-010](data/pitfalls/hook-010.json)（${f}: x）`).join('\n');
  assert.deepEqual(claimsIn(text).map(c => c.field), CHECKED_FIELDS);
});

test('the line number is the line the quote is on', () => {
  const text = 'a\nb\n[hook-010](data/pitfalls/hook-010.json)（status: closed）';
  assert.equal(claimsIn(text)[0].line, 3);
});

// CHANGELOG entries under a released heading say what was true at that
// release. Rewriting them to match today's records would destroy the record.
test('a released CHANGELOG section is history, not a claim about now', () => {
  const text = '## 未リリース\n\n[a](data/pitfalls/hook-010.json)（status: closed）\n\n'
    + '## v0.1.0 — 2026-09-18\n\n[b](data/pitfalls/hook-011.json)（status: untouched）\n';
  assert.deepEqual(attributed(text, 'CHANGELOG.md'), ['hook-010 status=closed']);
});

test('only CHANGELOG.md freezes, and only at a version heading', () => {
  const released = '## v0.1.0 — 2026-09-18\n';
  assert.equal(frozenFrom('CHANGELOG.md', released), 0);
  assert.equal(frozenFrom('ROADMAP.md', released), -1);
  assert.equal(frozenFrom('CHANGELOG.md', '## 未リリース\n'), -1);
});

const record = (id, fields) => JSON.stringify({ id, ...fields });
const build = (files) => {
  const root = mkdtempSync(join(tmpdir(), 'pitfall-claims-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'data', 'pitfalls'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '');
  writeFileSync(join(root, 'data', 'pitfalls', 'hook-010.json'),
    record('hook-010', { kind: 'limitation', status: 'closed', confidence: 'measured' }));
  writeFileSync(join(root, 'data', 'pitfalls', '_template.json'),
    record('perm-000', { kind: 'trap', status: 'untouched' }));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
};
const run = (files, fn) => {
  const root = build(files);
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

test('a quote that matches the record is not reported', () => {
  run({ 'docs/a.md': '[x](../data/pitfalls/hook-010.json)（status: closed）' }, root =>
    assert.deepEqual(checkClaims(root).findings, []));
});

test('a quote that disagrees is reported with both values', () => {
  run({ 'docs/a.md': '[x](../data/pitfalls/hook-010.json)（`status: open_recorded`）' }, root =>
    assert.deepEqual(checkClaims(root).findings, [{
      path: 'docs/a.md', line: 1, id: 'hook-010',
      field: 'status', claimed: 'open_recorded', actual: 'closed',
    }]));
});

test('a field the record does not carry is reported, not ignored', () => {
  run({ 'docs/a.md': '[x](../data/pitfalls/hook-010.json)（layer: hook）' }, root =>
    assert.equal(checkClaims(root).findings[0].actual, '(the record has no such field)'));
});

test('a quote naming something that is not a record is skipped, not guessed at', () => {
  run({ 'docs/a.md': 'hook-999 のこと（status: closed）' }, root => {
    const out = checkClaims(root);
    assert.deepEqual(out.findings, []);
    assert.equal(out.checked, 0);
    assert.equal(out.skipped, 1);
  });
});

test('the underscore-prefixed template is not a record', () => {
  run({}, root => assert.deepEqual([...recordsIn(root).keys()], ['hook-010']));
});

test('unattributable quotes are counted, not silently dropped', () => {
  run({ 'docs/a.md': '`status: closed` と書いただけ' }, root => {
    const out = checkClaims(root);
    assert.equal(out.checked, 0);
    assert.equal(out.skipped, 1);
  });
});

test('every Markdown file check-doc-links reads is read here too', () => {
  const root = build({ 'docs/nested/guide.md': '[x](../../data/pitfalls/hook-010.json)（status: untouched）' });
  try {
    writeFileSync(join(root, 'ROADMAP.md'), '[y](data/pitfalls/hook-010.json)（status: untouched）');
    writeFileSync(join(root, 'README.md'), '[z](data/pitfalls/hook-010.json)（status: untouched）');
    assert.deepEqual(checkClaims(root).findings.map(f => f.path).sort(),
      ['README.md', 'ROADMAP.md', 'docs/nested/guide.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
