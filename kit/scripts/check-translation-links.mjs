#!/usr/bin/env node
/**
 * check-translation-links.mjs -- A page that has an English twin says so
 * everywhere the repository lists its pages.
 *
 * Translating a page is three edits, not one: the `.en.md` file, the "English:"
 * line at the top of the Japanese original, and the row in each README's
 * documentation table. Doing the first and forgetting a later one leaves the
 * repository telling readers an English version does not exist while the file
 * sits right there.
 *
 * That is not hypothetical. docs/04 and docs/08 were translated in #48, and
 * measured when this was written: README.en.md linked both, README.md -- the
 * canonical one -- linked neither, and CONTRIBUTING's Japanese half still
 * asked for volunteers to translate them. The English half of CONTRIBUTING had
 * been updated. The canonical half had not.
 *
 * check-doc-links catches the opposite direction: a link to a translation that
 * does not exist. Nothing caught a translation that exists and is not linked,
 * because nothing is broken -- the claim is merely incomplete, and incomplete
 * is invisible.
 *
 * What is checked, for every docs/<base>.md whose docs/<base>.en.md exists:
 *   - the Japanese page links its own twin (the "English:" line near the top)
 *   - README.md links docs/<base>.en.md
 *   - README.en.md links docs/<base>.en.md
 *
 * What is not, and why:
 *   - pages with no twin. Linking the Japanese page from README.en.md is the
 *     correct thing to do there, not a defect.
 *   - prose that enumerates which pages are translated. There is no way to
 *     bind a sentence to the filesystem without inventing syntax for it, so
 *     this change removes those enumerations instead: the tables carry the
 *     fact, and the tables are checked here.
 *   - the reverse direction (a link to a translation that is not there).
 *     check-doc-links already fails on it.
 *
 *   node kit/scripts/check-translation-links.mjs
 *
 * Exit 0 -> every twin is announced everywhere.  Exit 1 -> at least one is
 * not, listed on stdout.  Exit 2 -> called wrongly, or the docs could not be
 * read.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { linksIn } from './check-doc-links.mjs';

// How far into a Japanese page the "English:" line is expected. It sits in the
// header, above the first section; a link buried in the body is not the
// announcement a reader scanning the top is looking for.
const HEADER_LINES = 10;

/** Every docs page that has an English twin, as its base name. */
export function translatedPages(root) {
  const dir = join(root, 'docs');
  return readdirSync(dir)
    .filter(n => n.endsWith('.md') && !n.endsWith('.en.md'))
    .map(n => n.replace(/\.md$/, ''))
    .filter(base => existsSync(join(dir, `${base}.en.md`)))
    .sort();
}

/** The repo-relative targets a Markdown file links to, resolved from its own directory. */
function targetsOf(root, path, within = Infinity) {
  const from = dirname(join(root, path));
  const found = new Set();
  for (const { line, target } of linksIn(readFileSync(join(root, path), 'utf8'))) {
    if (line > within) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//') || target.startsWith('#')) continue;
    found.add(resolve(from, decodeURIComponent(target.split('#')[0])));
  }
  return found;
}

export function checkTranslationLinks(root) {
  const findings = [];
  let checked = 0;
  const readme = targetsOf(root, 'README.md');
  const readmeEn = targetsOf(root, 'README.en.md');
  for (const base of translatedPages(root)) {
    const twin = resolve(join(root, 'docs', `${base}.en.md`));
    const sites = [
      ['docs/' + base + '.md', targetsOf(root, `docs/${base}.md`, HEADER_LINES),
        `the "English:" line near the top does not link ${base}.en.md`],
      ['README.md', readme, `the documentation table does not link docs/${base}.en.md`],
      ['README.en.md', readmeEn, `the documentation table does not link docs/${base}.en.md`],
    ];
    for (const [path, targets, why] of sites) {
      checked++;
      if (!targets.has(twin)) findings.push({ path, page: base, why });
    }
  }
  return { findings, checked, pages: translatedPages(root).length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw Error('This command takes no arguments.');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const { findings, checked, pages } = checkTranslationLinks(root);
    for (const f of findings) console.log(`${JSON.stringify(f.path)}: ${f.page} -- ${f.why}`);
    console.log(`${findings.length} unannounced translation(s); ${checked} checks across ${pages} translated page(s).`);
    process.exitCode = findings.length ? 1 : 0;
  } catch {
    console.error('Cannot check translation links: invalid arguments, or the docs could not be read.');
    process.exitCode = 2;
  }
}
