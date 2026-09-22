#!/usr/bin/env node
/**
 * markdown-anchors.mjs -- GitHub-style heading anchors for this repo's Markdown.
 *
 * Extracted so that validate-pitfalls (which resolves a record's `origin`) and
 * check-doc-links (which resolves every `](path#anchor)` in the docs) decide
 * what an anchor is with the same code. Two implementations of this would
 * disagree the first time a heading gained a bracket, and the docs and the
 * pitfall records would then be checked against different rules.
 */

import { readFileSync } from 'node:fs';

/**
 * GitHub-style heading anchor. Punctuation is dropped and whitespace becomes a hyphen, so
 * "### 3 つ目は、賢くしたせいで空きました" becomes "3-つ目は賢くしたせいで空きました".
 */
const PUNCTUATION = new RegExp(
  '[`~!@#$%^&*()+=<>?,.;:\'"\\\\|/\\[\\]{}。、，．・？！「」『』（）［］｛｝〈〉《》…—–]',
  'g'
);

export const slugify = (text) => text.trim().toLowerCase().replace(PUNCTUATION, '').replace(/\s+/g, '-');

/** Every heading anchor in a markdown file. Fenced code blocks are not headings. */
const anchorCache = new Map();
export function anchorsOf(absPath) {
  if (anchorCache.has(absPath)) return anchorCache.get(absPath);
  const anchors = new Set();
  let inFence = false;
  for (const line of readFileSync(absPath, 'utf8').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) anchors.add(slugify(m[2]));
  }
  anchorCache.set(absPath, anchors);
  return anchors;
}
