#!/usr/bin/env node
/**
 * check-doc-links.mjs -- Every relative link in the Markdown resolves.
 *
 * Added after two dead links shipped in docs/02-guardrails.en.md: the English
 * twin dropped the `../` its Japanese original has, so `](data/pitfalls/...)`
 * pointed at nothing from inside docs/. Nobody noticed, because nothing looked
 * at links. Translations multiply this -- every new .en.md is another chance to
 * copy a path that was written relative to a different directory.
 *
 * What is checked:
 *   - the target of every inline link and image, and of every reference
 *     definition, when it is a relative path
 *   - the `#anchor` on such a link, when the target is a Markdown file in this
 *     repo, using the same anchor rules as a pitfall record's `origin`
 *     (kit/scripts/markdown-anchors.mjs)
 *
 * What is not:
 *   - http(s) and mailto targets. Reaching the network would make this check
 *     fail for reasons that have nothing to do with the commit under test.
 *   - links inside fenced code blocks. Those are examples, not links.
 *
 *   node kit/scripts/check-doc-links.mjs
 *
 * Exit 0 -> every link resolves.  Exit 1 -> at least one does not, listed on
 * stdout.  Exit 2 -> called wrongly, or the docs could not be read.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anchorsOf } from './markdown-anchors.mjs';

// Link text may itself contain a bracketed span ("[a [b] c](x.md)"), and a
// target may be wrapped in <> so that it can contain spaces. Both appear in
// these docs, and a pattern that misses them silently checks fewer links --
// the failure mode this script exists to prevent.
const TEXT = '\\[(?:[^\\[\\]\\\\]|\\\\.|\\[(?:[^\\[\\]\\\\]|\\\\.)*\\])*\\]';
const TARGET = '\\(\\s*(?:<([^>]*)>|([^()\\s]+))(?:\\s+(?:"[^"]*"|\'[^\']*\'|\\([^)]*\\)))?\\s*\\)';
const INLINE = new RegExp('!?' + TEXT + TARGET, 'g');
const DEFINITION = /^ {0,3}\[(?:[^\]\\]|\\.)+\]:\s*(?:<([^>]*)>|(\S+))/;

/** Link targets in a Markdown source, with the line each was found on. */
export function linksIn(text) {
  const found = [];
  let fence = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Fenced examples are not links. Match check-doc-todos' fence handling so
    // the two agree on what counts as prose.
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) { fence = open[1]; continue; }

    // An inline code span is an example of a link, not a link. This script's
    // own page in docs/13 demonstrates the syntax that way, and without this
    // the checker reported its own examples as broken.
    const prose = line.replace(/(`+)[\s\S]*?\1/g, ' ');

    const definition = DEFINITION.exec(prose);
    if (definition) { found.push({ line: i + 1, target: definition[1] ?? definition[2] }); continue; }
    for (const m of prose.matchAll(INLINE)) found.push({ line: i + 1, target: m[1] ?? m[2] });
  }
  return found;
}

const isExternal = (target) =>
  /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//');

/** Every Markdown file this repo publishes, relative to the root. */
export function docFiles(root) {
  const files = readdirSync(root, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.md'))
    .map(e => e.name);
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
    }
  };
  walk('docs');
  return files.sort();
}

export function checkLinks(root) {
  const findings = [];
  for (const path of docFiles(root)) {
    const from = dirname(join(root, path));
    for (const { line, target } of linksIn(readFileSync(join(root, path), 'utf8'))) {
      if (isExternal(target)) continue;
      const hash = target.indexOf('#');
      const filePart = hash === -1 ? target : target.slice(0, hash);
      const anchor = hash === -1 ? '' : decodeURIComponent(target.slice(hash + 1));
      const at = { path: path.split('\\').join('/'), line, target };

      // A bare "#anchor" points inside the file it is written in.
      const absolute = filePart === ''
        ? join(root, path)
        : resolve(from, decodeURIComponent(filePart));

      if (!existsSync(absolute)) { findings.push({ ...at, why: 'no such file' }); continue; }
      if (!anchor) continue;
      // Only a Markdown file has headings to point at. A directory or a .json
      // with a fragment is not something this can check, so it is left alone
      // rather than reported as broken.
      if (!absolute.endsWith('.md') || !statSync(absolute).isFile()) continue;
      if (!anchorsOf(absolute).has(anchor.toLowerCase())) {
        findings.push({ ...at, why: 'no such heading in the target' });
      }
    }
  }
  return findings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw Error('This command takes no arguments.');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const findings = checkLinks(root);
    for (const f of findings) {
      console.log(`${JSON.stringify(f.path)}:${f.line}: ${JSON.stringify(f.target)} -- ${f.why}`);
    }
    console.log(`${findings.length} unresolved link(s).`);
    process.exitCode = findings.length ? 1 : 0;
  } catch {
    console.error('Cannot check links: invalid arguments or unreadable input.');
    process.exitCode = 2;
  }
}
