#!/usr/bin/env node
/**
 * check-pitfall-claims.mjs -- Prose that quotes a record's field agrees with
 * the record.
 *
 * The docs quote pitfall records inline: "[hook-010](data/pitfalls/hook-010.json)
 * (`status: open_recorded`)". Nothing looked at those quotes, so they drifted
 * the moment a record changed. That sentence is the real example: hook-010 was
 * closed, both copies of docs/02 were updated to say so, and ROADMAP.md kept
 * telling readers the hole was still open.
 *
 * It is the same failure this repo keeps finding (hook-004, hook-014,
 * hook-015): a fact recorded as a note to humans drifts, and one recorded as a
 * machine check holds. The records are the source of truth; this makes the
 * prose answer to them.
 *
 * What is checked:
 *   - `kind`, `status`, `confidence`, `severity` and `layer`, when quoted
 *     inside brackets -- either ASCII "()" or Japanese "（）" -- in any
 *     Markdown file that check-doc-links reads
 *   - against the record named last before the quote, within the same
 *     paragraph
 *
 * What is not, and why:
 *   - a quote outside brackets. docs/02 has a passage contrasting hook-007
 *     with hook-011, where "`kind: behaviour`" precedes the id it describes
 *     and "`status: open_recorded`" follows a different one. Attributing those
 *     by proximity reports two correct sentences as wrong. A checker that
 *     cries wolf gets its findings "fixed" by mangling the prose, so this one
 *     stays quiet where the prose is genuinely ambiguous and says how many
 *     quotes it skipped.
 *   - anything under a released heading in CHANGELOG.md. Those entries say
 *     what was true at that release, not what is true now -- the same
 *     distinction docs/08 draws between a count and a dated measurement.
 *     Rewriting them to match today's records would destroy the record.
 *   - fenced examples. Those are syntax, not claims.
 *   - `stale_risk`. It is computed into data/pitfalls.index.json rather than
 *     stored on a record, so there is nothing here to compare it against.
 *
 *   node kit/scripts/check-pitfall-claims.mjs
 *
 * Exit 0 -> every quoted field matches its record.  Exit 1 -> at least one
 * does not, listed on stdout.  Exit 2 -> called wrongly, or the docs or the
 * records could not be read.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docFiles } from './check-doc-links.mjs';

// The five fields a record stores as a plain string. stale_risk is deliberately
// absent: it lives in the generated index, not on the record.
export const CHECKED_FIELDS = ['kind', 'status', 'confidence', 'severity', 'layer'];

const ID = '[a-z][a-z0-9]*-[0-9]{3}';
const CLAIM = new RegExp(`(${CHECKED_FIELDS.join('|')})\\s*[:：]\\s*\`?([a-z_]+)`, 'g');
const MENTION = new RegExp(`(?:data/pitfalls/(${ID})\\.json|\\b(${ID})\\b)`, 'g');
const BRACKETS = { ')': '(', '）': '（' };

/** Every record on disk, by id. Underscore-prefixed files are not records. */
export function recordsIn(root) {
  const dir = join(root, 'data', 'pitfalls');
  const records = new Map();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name.startsWith('_')) continue;
    const record = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    if (typeof record?.id !== 'string') throw Error(`record without an id: ${name}`);
    records.set(record.id, record);
  }
  if (!records.size) throw Error('no records found');
  return records;
}

/**
 * Fenced code blocks blanked out, newlines kept so line numbers still hold.
 * The fence rules match check-doc-links so the two agree on what is prose.
 * Inline code is NOT blanked here: these quotes are usually written inside it.
 */
function prose(text) {
  let fence = null;
  return text.split(/\r?\n/).map(line => {
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      return '';
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) { fence = open[1]; return ''; }
    return line;
  }).join('\n');
}

/** Spans of every balanced bracket group, innermost and outermost alike. */
function bracketSpans(text) {
  const spans = [];
  const open = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '（') open.push({ c, i });
    else if (BRACKETS[c]) {
      // An unmatched closer is prose, not a bracket. Find the most recent
      // opener of the same kind and drop anything left dangling inside it.
      const at = open.map(o => o.c).lastIndexOf(BRACKETS[c]);
      if (at === -1) continue;
      spans.push({ start: open[at].i, end: i });
      open.length = at;
    }
  }
  return spans;
}

/**
 * Where CHANGELOG.md stops being a statement about now. Everything from the
 * first released version heading onward is history; -1 when there is none.
 */
export function frozenFrom(path, text) {
  if (path !== 'CHANGELOG.md') return -1;
  const m = /^## v[0-9]/m.exec(text);
  return m ? m.index : -1;
}

/** Every field quote in a Markdown source that can be attributed to a record. */
export function claimsIn(text, path = '') {
  const body = prose(text);
  const stop = frozenFrom(path, body);
  const spans = bracketSpans(body);
  const mentions = [...body.matchAll(MENTION)].map(m => ({ at: m.index, id: m[1] ?? m[2] }));
  const lineOf = (at) => body.slice(0, at).split('\n').length;

  const found = [];
  for (const m of body.matchAll(CLAIM)) {
    const at = m.index;
    if (stop !== -1 && at >= stop) continue;
    const claim = { line: lineOf(at), field: m[1], claimed: m[2], id: null };
    if (spans.some(s => s.start < at && at < s.end)) {
      // The record named last before the quote, in the same paragraph. A blank
      // line ends the paragraph, and with it the search.
      const from = body.lastIndexOf('\n\n', at) + 1;
      const before = mentions.filter(x => x.at >= from && x.at < at);
      if (before.length) claim.id = before[before.length - 1].id;
    }
    found.push(claim);
  }
  return found;
}

export function checkClaims(root) {
  const records = recordsIn(root);
  const findings = [];
  let checked = 0;
  let skipped = 0;
  for (const path of docFiles(root)) {
    const text = readFileSync(join(root, path), 'utf8');
    for (const claim of claimsIn(text, path.split('\\').join('/'))) {
      // A quote this cannot attribute, or one naming an id that is not a
      // record, is left alone rather than guessed at.
      if (!claim.id || !records.has(claim.id)) { skipped++; continue; }
      checked++;
      const actual = records.get(claim.id)[claim.field];
      if (actual === claim.claimed) continue;
      findings.push({
        path: path.split('\\').join('/'), line: claim.line, id: claim.id,
        field: claim.field, claimed: claim.claimed,
        actual: actual === undefined ? '(the record has no such field)' : actual,
      });
    }
  }
  return { findings, checked, skipped };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw Error('This command takes no arguments.');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const { findings, checked, skipped } = checkClaims(root);
    for (const f of findings) {
      console.log(`${JSON.stringify(f.path)}:${f.line}: ${f.id} ${f.field}: says ${JSON.stringify(f.claimed)}, the record says ${JSON.stringify(f.actual)}`);
    }
    console.log(`${findings.length} quote(s) disagree with the record; ${checked} checked, ${skipped} not attributable.`);
    process.exitCode = findings.length ? 1 : 0;
  } catch {
    console.error('Cannot check claims: invalid arguments, or the docs or records could not be read.');
    process.exitCode = 2;
  }
}
