#!/usr/bin/env node
/**
 * check-idem-002.mjs -- Read another repository and report the idem-002 shape:
 * an idempotency key that picks a freshly inserted log row's id BEFORE the
 * identifier the provider sends with the delivery.
 *
 * The record is data/app-pitfalls/idem-002.json. The original case
 * (docs/case-studies/musubu.md, "the idempotency key looks present but does
 * nothing") is this, inside one handler:
 *
 *     const { data: incomingLog } = await supabase.from('chat_logs')
 *       .insert({ ... }).select('id').maybeSingle();
 *
 *     const conversationSourceKey = incomingLog?.id || event.message.id || `line:${Date.now()}`;
 *
 *     await supabase.from('conversation_events')
 *       .insert({ idempotency_key: conversationSourceKey, ... });
 *
 * The column and the unique constraint are both there. What is wrong is the
 * ORDER: `incomingLog.id` is a new row per delivery, so the key changes every
 * time and the constraint never collides. The stable `event.message.id` sits
 * in the fallback.
 *
 * WHAT THIS READS, AND WHAT IT NEVER DOES
 *   - it reads files under the --root you name, and nothing else. A call is
 *     followed only into a file already read from that root;
 *   - it never imports, requires, evaluates or spawns anything from that root,
 *     and never reads a config file to decide what to do. A checker that ran
 *     the code it inspects would be a way to run anything by pointing it at a
 *     directory.
 *   - symbolic links are skipped, so a link cannot walk it out of the root.
 *
 * WHY IT IS NOT A NAME MATCH
 * A variable called `idempotencyKey` proves nothing, and the original defect
 * is invisible at the name level: both the broken and the fixed version have
 * the key, the column and the constraint. So a finding needs all three of
 * these. Points 1 and 2 must sit in ONE function body:
 *   1. a row id bound from `.insert(...).select('id')` with no id in the
 *      payload (so the id is new on every delivery);
 *   2. a `||` / `??` chain that selects that row id FIRST and an
 *      identifier that arrived with the delivery LATER;
 *   3. the value of that chain actually reaching an `idempotency_key` field,
 *      in that function, or in an exported function of another file it calls
 *      with the value as an object property. The original case does the
 *      second: `beginConversationTurn({ sourceKey: conversationSourceKey })`,
 *      and the receiver writes `idempotency_key: \`message:${sourceKey}\``.
 * Miss any one of them and nothing is reported.
 *
 * FOLLOWING A CALL WITHOUT READING CONFIG
 * `@/x` is looked up as src/x and x under the root, because reading a config
 * file from the target is exactly what this checker promises not to do. If both
 * exist the answer is unknown, and a call that cannot be followed makes the run
 * incomplete (exit 3) rather than clean.
 *
 * Exit 0 -> at least one file was read and nothing matched.
 * Exit 1 -> at least one finding.
 * Exit 2 -> called wrongly, or the root is unusable.
 * Exit 3 -> incomplete: no candidate file was found, or a candidate could not
 *           be read, or a matching key went into a call that could not be
 *           followed. "Nothing to look at" is not the same answer as "looked
 *           and found nothing", so it does not share exit 0.
 */

import { readdirSync, readFileSync, lstatSync, statSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PITFALL = 'idem-002';
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', 'vendor']);
const MAX_BYTES = 1024 * 1024;
const MAX_STATEMENT = 2000;

// The delivery-supplied side is matched by shape and by this small set of
// roots, because that is what the original case used (`event.message.id`, and
// `webhookEventId` as its documented alternative). It only decides which
// operand counts as "the stable one"; the defect itself is established by the
// data flow in points 1-3 above, never by a name alone.
const DELIVERY_ROOTS = new Set(['event', 'events', 'message', 'body', 'req', 'request', 'payload', 'delivery', 'notification']);
const DELIVERY_NAMES = /^(?:[a-z_$][\w$]*)?(?:webhookeventid|eventid|messageid|deliveryid)$/i;

const CODE = 0;
const STRING = 1;
const COMMENT = 2;

// A `/` starts a regex literal only where a value may start. After an
// identifier, a `)` or a `]` it is division. Without this, the braces and
// quotes inside a regex are read as structure: an unbalanced `}` inside
// /\{[^}]*\}/ ended a function body early and the real finding after it was
// lost (reviewed 2026-11-01).
const VALUE_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'instanceof', 'new', 'do', 'else', 'yield', 'await']);

export function usage() {
  return [
    'node kit/scripts/check-idem-002.mjs --root PATH [--json]',
    '',
    'Reads .js/.mjs/.cjs files under PATH and reports the idem-002 shape: an',
    'idempotency key that selects a freshly inserted log row id before the id',
    'that came with the delivery. Nothing under PATH is ever executed.',
    '',
    'Exit: 0 read something, found nothing; 1 found something; 2 called wrongly;',
    '      3 incomplete (no candidate file, a candidate could not be read, or a',
    '      matching key went into a call that could not be followed).',
  ].join('\n');
}

/**
 * Split the source into code, string and comment regions. `structural` keeps
 * the code characters and blanks everything else, so brace matching and
 * operator splitting cannot be fooled by a brace or a `||` inside a string or
 * a comment. Offsets and line breaks are preserved, so an index into
 * `structural` is the same index into the original text.
 */
export function classifySource(text) {
  const length = text.length;
  const kind = new Uint8Array(length);
  const structural = new Array(length);
  let i = 0;
  while (i < length) {
    const char = text[i];
    const next = i + 1 < length ? text[i + 1] : '';
    if (char === '/' && next === '/') {
      while (i < length && text[i] !== '\n') { kind[i] = COMMENT; structural[i] = ' '; i += 1; }
      continue;
    }
    if (char === '/' && next === '*') {
      kind[i] = COMMENT; structural[i] = ' ';
      kind[i + 1] = COMMENT; structural[i + 1] = text[i + 1] === '\n' ? '\n' : ' ';
      i += 2;
      while (i < length) {
        const closing = text[i] === '*' && text[i + 1] === '/';
        kind[i] = COMMENT; structural[i] = text[i] === '\n' ? '\n' : ' ';
        i += 1;
        if (closing) { kind[i] = COMMENT; structural[i] = ' '; i += 1; break; }
      }
      continue;
    }
    if (char === '/' && regexCanStartAt(structural, i)) {
      const regexEnd = findRegexEnd(text, i);
      if (regexEnd > 0) {
        for (let k = i; k < regexEnd; k += 1) { kind[k] = STRING; structural[k] = ' '; }
        i = regexEnd;
        continue;
      }
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      kind[i] = STRING; structural[i] = ' '; i += 1;
      while (i < length) {
        const current = text[i];
        if (current === '\\') {
          kind[i] = STRING; structural[i] = ' ';
          if (i + 1 < length) { kind[i + 1] = STRING; structural[i + 1] = text[i + 1] === '\n' ? '\n' : ' '; }
          i += 2;
          continue;
        }
        kind[i] = STRING; structural[i] = current === '\n' ? '\n' : ' ';
        i += 1;
        if (current === quote) break;
        // An unterminated single- or double-quoted string ends at the line
        // break rather than swallowing the rest of the file.
        if (current === '\n' && quote !== '`') break;
      }
      continue;
    }
    structural[i] = char;
    i += 1;
  }
  for (let index = 0; index < length; index += 1) {
    if (structural[index] === undefined) structural[index] = ' ';
  }
  return { kind, structural: structural.join('') };
}

/** True where a value may start, so a `/` there is a regex and not division. */
function regexCanStartAt(structural, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(structural[i] ?? ' ')) i -= 1;
  if (i < 0) return true;
  const char = structural[i];
  if (char === ')' || char === ']') return false;
  if (!/[\w$]/.test(char)) return true;
  let word = '';
  let j = i;
  while (j >= 0 && /[\w$]/.test(structural[j] ?? ' ')) { word = structural[j] + word; j -= 1; }
  return VALUE_KEYWORDS.has(word);
}

/**
 * Index just past a regex literal's closing `/` and its flags, or -1 if the
 * text does not close on the same line -- in which case the `/` was division
 * after all and is left as code.
 */
function findRegexEnd(text, start) {
  let i = start + 1;
  let inClass = false;
  while (i < text.length) {
    const char = text[i];
    if (char === '\\') { i += 2; continue; }
    if (char === '\n') return -1;
    if (inClass) { if (char === ']') inClass = false; }
    else if (char === '[') inClass = true;
    else if (char === '/') {
      i += 1;
      while (i < text.length && /[a-z]/i.test(text[i])) i += 1;
      return i;
    }
    i += 1;
  }
  return -1;
}

export function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

/** 1-based line number, the way an editor and a diagnostic both count. */
export function lineOf(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= index) low = mid; else high = mid - 1;
  }
  return low + 1;
}

const CONTROL_HEADS = new Set(['if', 'for', 'while', 'switch', 'catch', 'do']);

/**
 * Brace blocks that are function bodies, innermost last. A block counts as a
 * function body when its header ends in `=>`, or ends in `)` whose matching
 * `(` is not preceded by a control keyword -- which covers `function f(...)`,
 * `async f(...)`, a method shorthand and an arrow with parentheses, while
 * leaving `if (...) {`, `for (...) {` and an object literal out.
 */
export function findFunctionBodies(structural) {
  const open = [];
  const bodies = [];
  for (let i = 0; i < structural.length; i += 1) {
    const char = structural[i];
    if (char === '{') open.push(i);
    else if (char === '}') {
      const start = open.pop();
      if (start === undefined) continue;
      if (isFunctionHeader(structural, start)) bodies.push({ start, end: i });
    }
  }
  return bodies.sort((a, b) => a.start - b.start);
}

function isFunctionHeader(structural, braceIndex) {
  let i = braceIndex - 1;
  while (i >= 0 && /\s/.test(structural[i])) i -= 1;
  if (i < 1) return false;
  if (structural[i] === '>' && structural[i - 1] === '=') return true;
  if (structural[i] !== ')') return false;
  let depth = 0;
  for (; i >= 0; i -= 1) {
    if (structural[i] === ')') depth += 1;
    else if (structural[i] === '(') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (i < 0) return false;
  let j = i - 1;
  while (j >= 0 && /\s/.test(structural[j])) j -= 1;
  let word = '';
  while (j >= 0 && /[\w$]/.test(structural[j])) { word = structural[j] + word; j -= 1; }
  return !CONTROL_HEADS.has(word);
}

export function enclosingFunction(bodies, index) {
  let found = null;
  for (const body of bodies) {
    if (body.start < index && index < body.end) {
      if (!found || body.start > found.start) found = body;
    }
  }
  return found;
}

function matchingBracket(structural, openIndex) {
  const open = structural[openIndex];
  const close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let depth = 0;
  for (let i = openIndex; i < structural.length; i += 1) {
    const char = structural[i];
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** End of the statement that starts at `from`: the first `;` at depth zero. */
function statementEnd(structural, from) {
  let depth = 0;
  const limit = Math.min(structural.length, from + MAX_STATEMENT);
  for (let i = from; i < limit; i += 1) {
    const char = structural[i];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth < 0) return -1;
    } else if (char === ';' && depth === 0) return i;
  }
  return -1;
}

/** Top-level `||` / `??` operands of one expression, as index ranges. */
export function splitChain(structural, start, end) {
  const parts = [];
  let depth = 0;
  let from = start;
  for (let i = start; i < end; i += 1) {
    const char = structural[i];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (depth === 0) {
      const pair = char + (structural[i + 1] ?? '');
      if (pair === '||' || pair === '??') {
        parts.push({ start: from, end: i });
        i += 1;
        from = i + 1;
      }
    }
  }
  parts.push({ start: from, end });
  return parts;
}

function spanIsFreeOfComments(kind, start, end) {
  for (let i = start; i < end; i += 1) if (kind[i] === COMMENT) return false;
  return true;
}

/**
 * Whether the object literal at `objOpen` can be read as "definitely has no
 * id". `id:` written there is the obvious no; a top-level spread is also a no,
 * because what it carries is decided in another expression. Saying "with no id
 * in the payload" about `insert({ ...payload })` would be a claim this file
 * cannot support (reviewed 2026-11-01).
 */
function payloadMayCarryId(text, structural, objOpen) {
  const objClose = matchingBracket(structural, objOpen);
  if (objClose < 0) return true;
  let depth = 0;
  for (let i = objOpen; i < objClose; i += 1) {
    const char = structural[i];
    if (char === '{' || char === '[' || char === '(') depth += 1;
    else if (char === '}' || char === ']' || char === ')') depth -= 1;
    else if (depth === 1 && char === '.' && structural.slice(i, i + 3) === '...') return true;
    else if (depth === 1 && /[\w$'"]/.test(char)) {
      const slice = text.slice(i, Math.min(objClose, i + 24));
      const key = /^(?:id|['"]id['"])\s*:/.exec(slice);
      const previous = structural[i - 1] ?? '';
      if (key && (previous === '{' || previous === ',' || /\s/.test(previous))) return true;
    }
  }
  return false;
}

/** Declarations of `name` as code inside [from, to), to catch shadowing. */
function declarationCount(text, kind, name, from, to) {
  const pattern = new RegExp(`(?:const|let|var)\\s+${name.replace(/[$]/g, '\\$&')}\\b`, 'g');
  let count = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index < from || match.index >= to) continue;
    if (kind[match.index] !== CODE) continue;
    count += 1;
  }
  return count;
}

const DESTRUCTURE = /(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*/g;
const DATA_MEMBER = /(?:^|,)\s*data\s*:\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/;
const ASSIGNMENT = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;

/**
 * Rows whose id is new on every delivery: bound from an `.insert(...)` that
 * asks for the id back, with no id in the payload. `.upsert(...)` is not one
 * of them -- it can hand back the id of a row that was already there.
 */
function freshRowIds(text, structural, kind) {
  const found = new Map();
  DESTRUCTURE.lastIndex = 0;
  let match;
  while ((match = DESTRUCTURE.exec(text)) !== null) {
    const start = match.index;
    if (kind[start] !== CODE) continue;
    const name = DATA_MEMBER.exec(match[1].trim())?.[1];
    if (!name) continue;
    const rhsStart = start + match[0].length;
    const end = statementEnd(structural, rhsStart);
    if (end < 0) continue;
    const rhs = structural.slice(rhsStart, end);
    if (!/\.select\s*\(\s*['"]id['"]\s*\)/.test(text.slice(rhsStart, end))) continue;
    if (/\.upsert\s*\(/.test(rhs)) continue;
    const insert = rhs.indexOf('.insert');
    if (insert < 0) continue;
    const insertParen = structural.indexOf('(', rhsStart + insert);
    if (insertParen < 0 || insertParen > end) continue;
    const argClose = matchingBracket(structural, insertParen);
    if (argClose < 0) continue;
    // The payload must be an object literal this file can read end to end. An
    // identifier, an array of rows or a call result is not one, and nothing is
    // claimed about it.
    let objOpen = insertParen + 1;
    while (objOpen < argClose && /\s/.test(structural[objOpen])) objOpen += 1;
    if (structural[objOpen] !== '{') continue;
    if (payloadMayCarryId(text, structural, objOpen)) continue;
    if (!spanIsFreeOfComments(kind, start, rhsStart)) continue;
    found.set(name, { name, index: start, insertIndex: rhsStart + insert });
  }
  return found;
}

function operandText(text, part) {
  return text.slice(part.start, part.end).trim();
}

function referencesRowId(operand, name) {
  const escaped = name.replace(/[$]/g, '\\$&');
  return new RegExp(`^${escaped}\\s*(?:\\?\\.|\\.)?\\s*(?:id)?$`).test(operand);
}

function deliveryIdentifier(operand) {
  const cleaned = operand.replace(/\s+/g, '');
  if (/^[A-Za-z_$][\w$]*$/.test(cleaned)) return DELIVERY_NAMES.test(cleaned);
  if (!/(?:\?\.|\.)id$/.test(cleaned)) return false;
  const root = /^([A-Za-z_$][\w$]*)/.exec(cleaned);
  return Boolean(root) && DELIVERY_ROOTS.has(root[1].toLowerCase());
}

const SINK_FIELD = /['"]?idempotency[_-]?key['"]?\s*:\s*/gi;

/** Whether the value at `valueStart` is `name`, or a template that embeds it. */
function valueReads(text, kind, valueStart, name) {
  const escaped = name.replace(/[$]/g, '\\$&');
  if (text[valueStart] === '`') {
    let end = valueStart + 1;
    while (end < text.length && text[end] !== '`') end += text[end] === '\\' ? 2 : 1;
    return new RegExp(`\\$\\{\\s*${escaped}\\s*\\}`).test(text.slice(valueStart, end));
  }
  return kind[valueStart] === CODE
    && new RegExp(`^${escaped}(?![\\w$])`).test(text.slice(valueStart, valueStart + name.length + 1));
}

/** Every `idempotency_key` field in [from, to] whose value reads `name`. */
function idempotencySinks(text, kind, name, from, to) {
  const found = [];
  SINK_FIELD.lastIndex = from;
  let match;
  while ((match = SINK_FIELD.exec(text)) !== null && match.index <= to) {
    const valueStart = match.index + match[0].length;
    // The property name may legitimately be quoted (`'idempotency_key': key`),
    // and a template value is a string too. The colon between them is what must
    // be real code: it tells a field apart from a whole statement that only
    // exists inside a string literal.
    const colon = text.lastIndexOf(':', valueStart - 1);
    if (kind[colon] !== CODE) continue;
    if (!spanIsFreeOfComments(kind, match.index, valueStart)) continue;
    if (valueReads(text, kind, valueStart, name)) found.push(match.index);
  }
  return found;
}

function snippetAt(text, index) {
  const lineEnd = text.indexOf('\n', index);
  return text.slice(index, lineEnd < 0 ? text.length : lineEnd).trim().replace(/,$/, '');
}

/** Top-level members of the object at `open`, with comments and strings blanked. */
function objectMembers(structural, open) {
  const close = matchingBracket(structural, open);
  if (close < 0) return [];
  const members = [];
  const push = (from, to) => {
    const raw = structural.slice(from, to);
    const trimmed = raw.trim();
    if (trimmed) members.push({ text: trimmed, index: from + raw.indexOf(trimmed) });
  };
  let depth = 0;
  let from = open + 1;
  for (let i = open + 1; i < close; i += 1) {
    const char = structural[i];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 0) { push(from, i); from = i + 1; }
  }
  push(from, close);
  return members;
}

const NAMED_IMPORT = /import\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^{}]*)\}\s*from\s*['"]([^'"]+)['"]/g;

/** Local name -> what it imports. Default and namespace imports are not followed. */
function namedImports(text, kind) {
  const imports = new Map();
  NAMED_IMPORT.lastIndex = 0;
  let match;
  while ((match = NAMED_IMPORT.exec(text)) !== null) {
    if (kind[match.index] !== CODE) continue;
    for (const entry of match[1].split(',')) {
      const parts = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(entry.trim());
      if (parts) imports.set(parts[2] ?? parts[1], { exported: parts[1], specifier: match[2], index: match.index });
    }
  }
  return imports;
}

const MODULE_SUFFIXES = ['', '.js', '.mjs', '.cjs', '/index.js', '/index.mjs', '/index.cjs'];

/**
 * The file a specifier names, among the files already read from the root, so
 * nothing outside the root, behind a link or in a skipped directory can be
 * reached. null means a package, which is not the application's own code.
 */
function resolveModule(sources, importer, specifier) {
  let bases;
  if (/^\.{1,2}\//.test(specifier)) bases = [posix.join(posix.dirname(importer), specifier)];
  else if (specifier.startsWith('@/')) bases = [`src/${specifier.slice(2)}`, specifier.slice(2)];
  else if (/^[~#]/.test(specifier)) return { reason: `alias ${specifier} is not followed` };
  else return null;
  const hits = bases
    .map(base => MODULE_SUFFIXES.map(suffix => base + suffix).find(path => sources.has(path)))
    .filter(Boolean);
  if (hits.length > 1) return { reason: `${specifier} could be ${hits.join(' or ')}` };
  if (!hits.length) return { reason: `no .js/.mjs/.cjs file read for ${specifier}` };
  return { file: hits[0] };
}

/** An exported function whose first parameter is destructured, or null. */
function findExportedFunction(text, structural, kind, name) {
  const escaped = name.replace(/[$]/g, '\\$&');
  const pattern = new RegExp(`export\\s+(?:async\\s+function\\s+|function\\s+|const\\s+)${escaped}\\s*(?:=\\s*(?:async\\s*)?)?\\(`, 'g');
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (kind[match.index] !== CODE) continue;
    const paren = match.index + match[0].length - 1;
    const parenClose = matchingBracket(structural, paren);
    if (parenClose < 0) return null;
    let parameter = paren + 1;
    while (/\s/.test(structural[parameter] ?? '')) parameter += 1;
    if (structural[parameter] !== '{') return null;
    let body = parenClose + 1;
    while (/\s/.test(structural[body] ?? '')) body += 1;
    if (structural.slice(body, body + 2) === '=>') {
      body += 2;
      while (/\s/.test(structural[body] ?? '')) body += 1;
    }
    if (structural[body] !== '{') return null;
    const bodyEnd = matchingBracket(structural, body);
    return bodyEnd < 0 ? null : { parameter, bodyStart: body, bodyEnd };
  }
  return null;
}

/** Sinks inside the function a value was passed to, or why it cannot be told. */
function sinksInCallee(project, file, exported, property) {
  const text = project.sources.get(file);
  const { kind, structural } = classifySource(text);
  const callee = findExportedFunction(text, structural, kind, exported);
  if (!callee) return { reason: `no exported function ${exported} with a destructured parameter in ${file}` };
  let local = null;
  for (const member of objectMembers(structural, callee.parameter)) {
    const parts = /^([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?\s*(?:=[\s\S]*)?$/.exec(member.text);
    if (parts?.[1] === property) local = parts[2] ?? parts[1];
  }
  if (!local) return { reason: `${exported} in ${file} does not name ${property} in its parameter` };
  if (declarationCount(text, kind, local, callee.bodyStart, callee.bodyEnd) > 0) {
    return { reason: `${exported} in ${file} redeclares ${local}` };
  }
  const starts = lineStarts(text);
  return {
    sinks: idempotencySinks(text, kind, local, callee.bodyStart, callee.bodyEnd)
      .map(index => ({ file, line: lineOf(starts, index), expression: snippetAt(text, index) })),
  };
}

const OBJECT_CALL = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(\s*\{/g;

/**
 * Sinks reached by passing `keyName` as an object property to an imported
 * function, one level deep. Member calls such as `logger.info({ key })` are not
 * imports and are left out. A call that cannot be followed is recorded, because
 * an unknown receiver is not the same as a receiver that only logs.
 */
function sinksThroughCalls(file, text, structural, kind, starts, scope, keyName, after, project) {
  const sinks = [];
  if (!project) return sinks;
  const imports = namedImports(text, kind);
  OBJECT_CALL.lastIndex = after;
  let match;
  while ((match = OBJECT_CALL.exec(text)) !== null && match.index < scope.end) {
    if (kind[match.index] !== CODE) continue;
    const target = imports.get(match[1]);
    if (!target) continue;
    const members = objectMembers(structural, match.index + match[0].length - 1);
    for (const member of members) {
      const parts = /^([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?$/.exec(member.text);
      if (!parts || (parts[2] ?? parts[1]) !== keyName) continue;
      const property = parts[1];
      const via = {
        file,
        callLine: lineOf(starts, match.index),
        argumentLine: lineOf(starts, member.index),
        callee: target.exported,
        property,
        importedFrom: target.specifier,
        importLine: lineOf(starts, target.index),
      };
      const module = resolveModule(project.sources, file, target.specifier);
      if (!module) continue;
      const answer = module.reason ? module : sinksInCallee(project, module.file, target.exported, property);
      if (answer.reason) project.unresolved.push({ ...via, reason: answer.reason });
      else sinks.push(...answer.sinks.map(sink => ({ ...sink, via })));
    }
  }
  return sinks;
}

/** Findings for one file. `file` is only carried through to the diagnostic. */
export function analyzeSource(file, text, project = null) {
  const { kind, structural } = classifySource(text);
  const starts = lineStarts(text);
  const bodies = findFunctionBodies(structural);
  const rows = freshRowIds(text, structural, kind);
  if (!rows.size) return [];
  const findings = [];
  ASSIGNMENT.lastIndex = 0;
  let match;
  while ((match = ASSIGNMENT.exec(text)) !== null) {
    const start = match.index;
    if (kind[start] !== CODE) continue;
    const keyName = match[1];
    const rhsStart = start + match[0].length;
    const end = statementEnd(structural, rhsStart);
    if (end < 0) continue;
    const parts = splitChain(structural, rhsStart, end);
    if (parts.length < 2) continue;
    const first = operandText(text, parts[0]);
    const row = [...rows.values()].find(candidate => referencesRowId(first, candidate.name));
    if (!row) continue;
    const later = parts.slice(1).map(part => operandText(text, part)).find(deliveryIdentifier);
    if (!later) continue;

    // Same function for all three sites, or it is not a finding. The row may
    // be inserted in a helper and the key built in the handler; this version
    // does not follow that and says so rather than guessing.
    const scope = enclosingFunction(bodies, start);
    if (!scope || enclosingFunction(bodies, row.index)?.start !== scope.start) continue;
    // An inner block may declare the same name for a different value, and the
    // `idempotency_key` further down may be reading that one. Which binding
    // reaches the field is not settled by reading text in order, so a shadowed
    // name is left alone (reviewed 2026-11-01).
    if (declarationCount(text, kind, keyName, scope.start, scope.end) > 1) continue;
    const sinks = [
      ...idempotencySinks(text, kind, keyName, scope.start, scope.end)
        .filter(index => enclosingFunction(bodies, index)?.start === scope.start)
        .map(index => ({ file, line: lineOf(starts, index), expression: snippetAt(text, index), via: null })),
      ...sinksThroughCalls(file, text, structural, kind, starts, scope, keyName, end, project),
    ];
    if (!sinks.length) continue;

    findings.push({
      pitfall: PITFALL,
      file,
      line: lineOf(starts, start),
      key: keyName,
      selectsFirst: first,
      selectsLater: later,
      rowIdFrom: row.name,
      insertLine: lineOf(starts, row.index),
      sinkFile: sinks[0].file,
      sinkLine: sinks[0].line,
      sinks,
      functionLine: lineOf(starts, scope.start),
    });
  }
  return findings;
}

function collectFiles(root) {
  const files = [];
  const unread = [];
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) { unread.push({ path: directory, reason: `directory not readable (${error.code ?? 'unknown'})` }); continue; }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const dot = entry.name.lastIndexOf('.');
      if (dot < 0 || !EXTENSIONS.has(entry.name.slice(dot))) continue;
      let size;
      try { size = lstatSync(full).size; }
      catch (error) { unread.push({ path: full, reason: `not stattable (${error.code ?? 'unknown'})` }); continue; }
      if (size > MAX_BYTES) { unread.push({ path: full, reason: `larger than ${MAX_BYTES} bytes` }); continue; }
      files.push(full);
    }
  }
  return { files: files.sort(), unread };
}

export function scanRoot(root) {
  const { files, unread } = collectFiles(root);
  const sources = new Map();
  for (const file of files) {
    let text;
    try { text = readFileSync(file, 'utf8'); }
    catch (error) { unread.push({ path: file, reason: `not readable (${error.code ?? 'unknown'})` }); continue; }
    sources.set(relative(root, file).split('\\').join('/'), text);
  }
  // Everything is read first, because a call is followed into another file.
  const project = { sources, unresolved: [] };
  const findings = [];
  for (const [relativePath, text] of sources) findings.push(...analyzeSource(relativePath, text, project));
  const normalise = entry => ({ path: relative(root, entry.path).split('\\').join('/') || '.', reason: entry.reason });
  return { scanned: sources.size, candidates: files.length, unread: unread.map(normalise), unresolved: project.unresolved, findings };
}

function describe(finding) {
  const lines = [
    `${finding.pitfall}  ${finding.file}:${finding.line}`,
    `  selects first: ${finding.selectsFirst}   <- id of the row inserted at line ${finding.insertLine}`,
    `  selects later: ${finding.selectsLater}   <- identifier that arrived with the delivery`,
    ...finding.sinks.map(sink => `  reaches:       idempotency_key at ${sink.file}:${sink.line}${sink.via ? ` (through ${sink.via.callee})` : ''}`),
    '',
    `  Confirmed by reading the file(s) (key built in one function, from line ${finding.functionLine}):`,
    `    - line ${finding.insertLine} binds ${finding.rowIdFrom} from .insert(...).select('id'), with no id in the payload`,
    `    - line ${finding.line} puts that row id ahead of ${finding.selectsLater} in the chain`,
    ...finding.sinks.flatMap(sink => (sink.via
      ? [`    - ${sink.via.file}:${sink.via.argumentLine} passes ${finding.key} to ${sink.via.callee} as ${sink.via.property} (imported at line ${sink.via.importLine} from ${sink.via.importedFrom})`,
        `    - ${sink.file}:${sink.line} uses it: ${sink.expression}`]
      : [`    - line ${sink.line} passes ${finding.key} to an idempotency_key field`])),
    '  Not established here. A duplicate on redelivery also needs all of:',
    '    - the provider to redeliver the same event carrying the same identifier',
    `    - every delivery to reach line ${finding.insertLine} and insert a new row, so the id differs each time`,
    '    - the de-duplication to rest on a unique constraint over this key',
    `    - the effects meant to be suppressed to happen at or after ${finding.sinkFile}:${finding.sinkLine}`,
  ];
  return lines.join('\n');
}

function parseArguments(argv) {
  const options = { root: null, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--root') {
      i += 1;
      if (i >= argv.length) throw new Error('--root needs a path');
      options.root = argv[i];
    } else if (argument.startsWith('--root=')) options.root = argument.slice('--root='.length);
    else throw new Error(`unknown argument ${argument}`);
  }
  if (!options.help && !options.root) throw new Error('--root is required');
  return options;
}

function main(argv) {
  let options;
  try { options = parseArguments(argv); }
  catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const root = resolve(options.root);
  try {
    if (!statSync(root).isDirectory()) throw new Error('not a directory');
  } catch {
    process.stderr.write(`--root is not a readable directory: ${root}\n`);
    return 2;
  }

  const result = scanRoot(root);
  const status = result.findings.length ? 'findings'
    : result.candidates === 0 || result.unread.length || result.unresolved.length ? 'incomplete' : 'no-findings';
  const code = status === 'findings' ? 1 : status === 'incomplete' ? 3 : 0;

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ pitfall: PITFALL, root, status, ...result }, null, 2)}\n`);
    return code;
  }

  const out = [];
  for (const finding of result.findings) out.push(describe(finding), '');
  if (status === 'incomplete') {
    out.push(result.candidates === 0
      ? `INCOMPLETE: no .js/.mjs/.cjs file to read under ${root}. Nothing was checked, which is not the same as nothing being wrong.`
      : `INCOMPLETE: ${result.unread.length} candidate file(s) could not be read and ${result.unresolved.length} call(s) could not be followed, so the answer is partial.`);
    for (const entry of result.unread) out.push(`  unread: ${entry.path} -- ${entry.reason}`);
    for (const entry of result.unresolved) out.push(`  unresolved: ${entry.file}:${entry.callLine} ${entry.callee} -- ${entry.reason}`);
  } else if (status === 'no-findings') {
    out.push(`no ${PITFALL} finding in ${result.scanned} file(s) under ${root}`);
  } else {
    out.push(`${result.findings.length} ${PITFALL} finding(s) in ${result.scanned} file(s) read, ${result.unread.length} unread`);
    for (const entry of result.unread) out.push(`  unread: ${entry.path} -- ${entry.reason}`);
    for (const entry of result.unresolved) out.push(`  unresolved: ${entry.file}:${entry.callLine} ${entry.callee} -- ${entry.reason}`);
  }
  process.stdout.write(`${out.join('\n')}\n`);
  return code;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
