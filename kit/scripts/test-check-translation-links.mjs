import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translatedPages, checkTranslationLinks } from './check-translation-links.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const JA = (base, english = `English: [${base}.en.md](${base}.en.md)`) =>
  `# page\n\n${english}\n\nbody\n`;

/**
 * A repository with one page per entry. `twin` gives the page an English
 * version; the three link sites default to announcing it correctly, and a test
 * breaks exactly the one it is about.
 */
const build = (pages) => {
  const root = mkdtempSync(join(tmpdir(), 'translation-links-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  const ja = [], en = [];
  for (const [base, o] of Object.entries(pages)) {
    writeFileSync(join(root, 'docs', `${base}.md`), o.jaBody ?? JA(base, o.english));
    if (o.twin !== false) writeFileSync(join(root, 'docs', `${base}.en.md`), '# english\n');
    if (o.inReadme !== false) ja.push(`| [x](docs/${base}.md) | ([EN](docs/${base}.en.md)) |`);
    if (o.inReadmeEn !== false) en.push(`| [x](docs/${base}.en.md) | |`);
  }
  writeFileSync(join(root, 'README.md'), `# ja\n\n${ja.join('\n')}\n`);
  writeFileSync(join(root, 'README.en.md'), `# en\n\n${en.join('\n')}\n`);
  return root;
};
const run = (pages, fn) => {
  const root = build(pages);
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};
const why = (root) => checkTranslationLinks(root).findings.map(f => `${f.path}:${f.page}`);

test('a page whose twin is announced everywhere is not reported', () => {
  run({ '00-a': {} }, root => assert.deepEqual(why(root), []));
});

test('a page with no twin is required nowhere', () => {
  run({ '17-a': { twin: false, inReadme: false, inReadmeEn: false } }, root => {
    const out = checkTranslationLinks(root);
    assert.deepEqual(out.findings, []);
    assert.equal(out.pages, 0);
  });
});

test('only the pages that have a twin are counted', () => {
  run({ '00-a': {}, '17-b': { twin: false, inReadme: false, inReadmeEn: false } }, root =>
    assert.deepEqual(translatedPages(root), ['00-a']));
});

// The exact shape that shipped: the translation exists, the English README
// links it, the canonical one does not.
test('the canonical README missing the link is reported', () => {
  run({ '04-a': { inReadme: false } }, root =>
    assert.deepEqual(why(root), ['README.md:04-a']));
});

test('the English README missing the link is reported', () => {
  run({ '04-a': { inReadmeEn: false } }, root =>
    assert.deepEqual(why(root), ['README.en.md:04-a']));
});

test('the Japanese page not announcing its own twin is reported', () => {
  run({ '04-a': { english: 'no announcement here' } }, root =>
    assert.deepEqual(why(root), ['docs/04-a.md:04-a']));
});

test('all three missing at once are reported separately', () => {
  run({ '04-a': { english: 'none', inReadme: false, inReadmeEn: false } }, root =>
    assert.deepEqual(why(root).sort(),
      ['README.en.md:04-a', 'README.md:04-a', 'docs/04-a.md:04-a']));
});

// The announcement is for a reader scanning the top of the page. A link that
// only appears far down the body is not that.
test('an announcement below the header is not an announcement', () => {
  run({ '04-a': { jaBody: '# page\n' + '\nfiller'.repeat(20) + '\n[EN](04-a.en.md)\n' } }, root =>
    assert.deepEqual(why(root), ['docs/04-a.md:04-a']));
});

test('a link inside a fenced example does not count', () => {
  run({ '04-a': { jaBody: '# page\n\n```md\n[EN](04-a.en.md)\n```\n' } }, root =>
    assert.deepEqual(why(root), ['docs/04-a.md:04-a']));
});

test('an anchor on the link still counts', () => {
  run({ '04-a': { english: 'English: [x](04-a.en.md#top)' } }, root =>
    assert.deepEqual(why(root), []));
});

test('the count covers three sites per translated page', () => {
  run({ '00-a': {}, '01-b': {} }, root => {
    const out = checkTranslationLinks(root);
    assert.equal(out.pages, 2);
    assert.equal(out.checked, 6);
  });
});
