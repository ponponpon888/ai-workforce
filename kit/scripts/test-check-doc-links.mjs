import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linksIn, checkLinks } from './check-doc-links.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// What counts as a link at all.
for (const [name, text, expected] of [
  ['inline link', '[x](a.md)', ['a.md']],
  ['image', '![alt](img.png)', ['img.png']],
  ['link with a title', '[x](a.md "title")', ['a.md']],
  ['angle-bracketed target', '[x](<a b.md>)', ['a b.md']],
  ['reference definition', '[x]: a.md', ['a.md']],
  ['two on one line', '[a](a.md) and [b](b.md)', ['a.md', 'b.md']],
  ['anchor only', '[x](#heading)', ['#heading']],
  ['path with anchor', '[x](a.md#heading)', ['a.md#heading']],
  ['brackets inside the text', '[a [b] c](a.md)', ['a.md']],
  ['fenced example is not a link', '```md\n[x](nope.md)\n```', []],
  ['tilde fence', '~~~\n[x](nope.md)\n~~~', []],
  ['fence then a real link', '```\n[x](nope.md)\n```\n[y](yes.md)', ['yes.md']],
  ['CRLF', '[x](a.md)\r\n[y](b.md)\r\n', ['a.md', 'b.md']],
  ['plain prose', 'no links here', []],
  ['inline code is an example, not a link', '`[x](nope.md)`', []],
  ['inline code beside a real link', '`[x](nope.md)` and [y](yes.md)', ['yes.md']],
  ['double-backtick span', '``[x](nope.md)``', []],
  ['reference definition inside code', '`[x]: nope.md`', []],
]) test(name, () => assert.deepEqual(linksIn(text).map(l => l.target), expected));

const build = (files) => {
  const root = mkdtempSync(join(tmpdir(), 'doc-links-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '');
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

test('a link that resolves is not reported', () => {
  run({ 'docs/a.md': '[x](b.md)', 'docs/b.md': '' }, root =>
    assert.deepEqual(checkLinks(root), []));
});

// The bug this exists for: docs/02-guardrails.en.md carried
// "](data/pitfalls/hook-010.json)" where the Japanese original has "../data/...".
// From inside docs/ it resolves to nothing, and it shipped.
test('a path missing its ../ is reported', () => {
  run({ 'docs/a.md': '[x](data/pitfalls/hook-010.json)' }, root => {
    const found = checkLinks(root);
    assert.equal(found.length, 1);
    assert.equal(found[0].why, 'no such file');
    assert.equal(found[0].target, 'data/pitfalls/hook-010.json');
    assert.equal(found[0].line, 1);
  });
});

test('the same path with ../ resolves', () => {
  run({ 'docs/a.md': '[x](../data/x.json)', 'data/x.json': '{}' }, root =>
    assert.deepEqual(checkLinks(root), []));
});

test('external targets are left alone', () => {
  run({ 'docs/a.md': '[a](https://example.com/x)\n[b](http://x)\n[c](mailto:x@y.z)\n[d](//cdn/x)' }, root =>
    assert.deepEqual(checkLinks(root), []));
});

test('an anchor that exists in the target is accepted', () => {
  run({ 'docs/a.md': '[x](b.md#the-heading)', 'docs/b.md': '## The Heading' }, root =>
    assert.deepEqual(checkLinks(root), []));
});

test('an anchor that does not exist is reported', () => {
  run({ 'docs/a.md': '[x](b.md#missing)', 'docs/b.md': '## The Heading' }, root => {
    const found = checkLinks(root);
    assert.equal(found.length, 1);
    assert.equal(found[0].why, 'no such heading in the target');
  });
});

// Same anchor rules as a pitfall record's origin, because both come from
// markdown-anchors.mjs. A heading full of Japanese punctuation is the case
// that made those rules necessary in the first place.
test('Japanese headings use the same anchor rules as pitfall origins', () => {
  run({
    'docs/a.md': '[x](b.md#3-つ目は賢くしたせいで空きました)',
    'docs/b.md': '### 3 つ目は、賢くしたせいで空きました',
  }, root => assert.deepEqual(checkLinks(root), []));
});

test('a bare #anchor points inside its own file', () => {
  run({ 'docs/a.md': '## Here\n[x](#here)\n[y](#elsewhere)' }, root => {
    const found = checkLinks(root);
    assert.equal(found.length, 1);
    assert.equal(found[0].target, '#elsewhere');
  });
});

// A fragment on something that is not Markdown has no headings to check. It is
// not evidence of a broken link, so it is not reported as one.
test('a fragment on a non-Markdown file is not judged', () => {
  run({ 'docs/a.md': '[x](../data/x.json#whatever)', 'data/x.json': '{}' }, root =>
    assert.deepEqual(checkLinks(root), []));
});

test('a percent-encoded path is decoded before it is looked up', () => {
  run({ 'docs/a.md': '[x](b%20c.md)', 'docs/b c.md': '' }, root =>
    assert.deepEqual(checkLinks(root), []));
});

test('links in a fenced example are not checked', () => {
  run({ 'docs/a.md': '```sh\nsee [x](nope.md)\n```' }, root =>
    assert.deepEqual(checkLinks(root), []));
});

test('nested docs and both READMEs are all read', () => {
  const root = build({ 'docs/nested/guide.md': '[x](nope.md)' });
  try {
    writeFileSync(join(root, 'README.en.md'), '[y](nope.md)');
    writeFileSync(join(root, 'README.md'), '[z](nope.md)');
    assert.deepEqual(checkLinks(root).map(f => f.path).sort(),
      ['README.en.md', 'README.md', 'docs/nested/guide.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
