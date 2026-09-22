#!/usr/bin/env node
/**
 * shell-lex.mjs -- POSIX shell, PowerShell and cmd.exe lexers, shared by the
 * guard hooks that have to read a command line.
 *
 * Lifted out of guard-destructive.mjs unchanged. It needed a real lexer to see
 * past quoting and wrappers; guard-sql needs the same thing to tell a DDL
 * keyword that is being executed from one that is merely quoted inside a
 * commit message (data/pitfalls/hook-010.json), and a second implementation of
 * shell quoting is exactly the kind of near-duplicate that drifts.
 *
 * A single grammar for all three shells is what made guard-sql's string
 * neutralization create a hole in the first place: backticks and backslashes
 * mean different things in each.
 *
 * This module only turns text into commands and words. It decides nothing
 * about whether a command is dangerous -- that stays in each hook, because
 * each hook is looking for something different.
 */

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/**
 * One shell word after quote removal. `dyn` marks a word whose value depends
 * on an expansion this hook cannot evaluate; `varRef` and `subst` are set
 * only when the whole word is a single variable or a single command
 * substitution, which is what lets `X=rm; $X -rf .` and `$(which rm) -rf .`
 * be resolved.
 */
export class Word {
  constructor(v = '') {
    this.v = v;
    this.dyn = false;
    this.empty = v === '';
    this.varRef = null;
    this.subst = null;
  }
  add(s) {
    this.v += s;
    this.empty = false;
    this.varRef = null;
    this.subst = null;
  }
  addDyn({ varRef = null, subst = null } = {}) {
    const wasEmpty = this.empty;
    this.dyn = true;
    this.empty = false;
    this.varRef = wasEmpty ? varRef : null;
    this.subst = wasEmpty ? subst : null;
  }
}

export const newCommand = () => ({ words: [], heredocs: [], herestrings: [], pipedFrom: null });

/**
 * Index just past the `)` that closes a `(` already consumed, skipping
 * quoted text. `ps` selects PowerShell quoting (backtick escapes, '' and ""
 * doubling) instead of POSIX quoting (backslash escapes).
 */
function closeParen(src, i, ps) {
  let depth = 1;
  const heredocs = [];
  while (i < src.length) {
    const c = src[i];
    // `$(cat <<'EOF' ... EOF)` is how commit messages are usually built.
    // The body is text, not code: an apostrophe or a parenthesis in it must
    // not be read as quoting or nesting.
    if (c === '\n' && heredocs.length) {
      i = skipHeredocBodies(src, i + 1, heredocs);
      heredocs.length = 0;
      continue;
    }
    const atWordStart = i === 0 || /[\s;&|(]/.test(src[i - 1]);
    if (!ps && c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      let j = i + 2;
      const strip = src[j] === '-';
      if (strip) j++;
      while (src[j] === ' ' || src[j] === '\t') j++;
      const m = /^(?:'([^']*)'|"([^"]*)"|([^\s;&|<>()]+))/.exec(src.slice(j));
      if (m) heredocs.push({ delim: m[1] ?? m[2] ?? m[3].replace(/['"\\]/g, ''), strip });
      i = j + (m ? m[0].length : 0);
      continue;
    }
    if (c === '#' && atWordStart) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ps && c === '<' && src[i + 1] === '#') {
      const end = src.indexOf('#>', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (ps && c === '@' && (src[i + 1] === "'" || src[i + 1] === '"')) {
      const lineEnd = src.indexOf('\n', i + 2);
      if (lineEnd >= 0 && src.slice(i + 2, lineEnd).trim() === '') {
        const re = src[i + 1] === "'" ? /\r?\n[ \t]*'@/g : /\r?\n[ \t]*"@/g;
        re.lastIndex = lineEnd;
        const m = re.exec(src);
        i = m ? m.index + m[0].length : src.length;
        continue;
      }
    }
    if (!ps && c === '\\') { i += 2; continue; }
    if (ps && c === '`') { i += 2; continue; }
    if (c === "'") {
      i++;
      while (i < src.length) {
        if (src[i] === "'") {
          if (ps && src[i + 1] === "'") { i += 2; continue; }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if ((!ps && src[i] === '\\') || (ps && src[i] === '`')) i++;
        else if (src[i] === '$' && src[i + 1] === '(') { i = closeParen(src, i + 2, ps); continue; }
        i++;
      }
      i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return src.length;
}

function skipHeredocBodies(src, i, heredocs) {
  for (const h of heredocs) {
    while (i < src.length) {
      let j = src.indexOf('\n', i);
      if (j < 0) j = src.length;
      let line = src.slice(i, j);
      i = Math.min(j + 1, src.length);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
    }
  }
  return i;
}

/** Index just past the matching `}` of a `${` already consumed. */
function closeBrace(src, i) {
  let depth = 1;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return i + 1;
    i++;
  }
  return src.length;
}

/** Every `$(...)` and backtick body inside text that the shell will expand. */
function substitutionsIn(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '$' && text[i + 1] === '(' && text[i + 2] !== '(') {
      const end = closeParen(text, i + 2, false);
      out.push(text.slice(i + 2, end - 1));
      i = end - 1;
    } else if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end < 0) break;
      out.push(text.slice(i + 1, end));
      i = end;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// POSIX lexer (Bash tool)
// ---------------------------------------------------------------------------

const POSIX_BOUNDARY = new Set([' ', '\t', '\r', '\n', ';', '&', '|', '(', ')', '<', '>']);
const ANSI_C = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

export function lexPosix(src) {
  const commands = [];
  const nested = [];
  let cmd = newCommand();
  let pending = [];
  const n = src.length;

  const endCommand = (sep) => {
    if (cmd.words.length || cmd.heredocs.length || cmd.herestrings.length) commands.push(cmd);
    const prev = cmd;
    cmd = newCommand();
    if (sep === '|') cmd.pipedFrom = prev;
  };

  /** A `$...` expansion starting at i. Returns the index after it. */
  function readDollar(i, word) {
    const next = src[i + 1];
    if (next === '(') {
      if (src[i + 2] === '(') {
        // Arithmetic `$((...))`: starting the match at the second `(` counts
        // both, so the returned index is already past `))`.
        word.addDyn();
        return closeParen(src, i + 2, false);
      }
      const end = closeParen(src, i + 2, false);
      const body = src.slice(i + 2, end - 1);
      nested.push({ src: body, label: '$(...)' });
      word.addDyn({ subst: body });
      return end;
    }
    if (next === '{') {
      const end = closeBrace(src, i + 2);
      const inner = src.slice(i + 2, end - 1);
      word.addDyn({ varRef: /^[A-Za-z_][A-Za-z0-9_]*$/.test(inner) ? inner : null });
      return end;
    }
    if (next === "'") {
      let j = i + 2;
      let text = '';
      while (j < n && src[j] !== "'") {
        if (src[j] === '\\' && j + 1 < n) {
          const e = src[j + 1];
          if (e === 'x' && /^[0-9a-fA-F]{1,2}/.test(src.slice(j + 2))) {
            const hex = /^[0-9a-fA-F]{1,2}/.exec(src.slice(j + 2))[0];
            text += String.fromCharCode(parseInt(hex, 16));
            j += 2 + hex.length;
            continue;
          }
          if (/[0-7]/.test(e)) {
            const oct = /^[0-7]{1,3}/.exec(src.slice(j + 1))[0];
            text += String.fromCharCode(parseInt(oct, 8));
            j += 1 + oct.length;
            continue;
          }
          text += ANSI_C[e] ?? e;
          j += 2;
          continue;
        }
        text += src[j++];
      }
      word.add(text);
      return j + 1;
    }
    if (next === '"') return readDouble(i + 1, word);
    const m = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(src.slice(i + 1));
    if (m) {
      word.addDyn({ varRef: /^[A-Za-z_]/.test(m[0]) ? m[0] : null });
      return i + 1 + m[0].length;
    }
    word.add('$');
    return i + 1;
  }

  /** A double-quoted string whose opening quote is at i. */
  function readDouble(i, word) {
    let j = i + 1;
    let text = '';
    let dyn = false;
    let soleRef = null;
    let parts = 0;
    while (j < n && src[j] !== '"') {
      const c = src[j];
      if (c === '\\' && j + 1 < n && '$`"\\\n'.includes(src[j + 1])) {
        if (src[j + 1] !== '\n') text += src[j + 1];
        parts++;
        j += 2;
        continue;
      }
      if (c === '$' && src[j + 1] === '(') {
        if (src[j + 2] === '(') {
          j = closeParen(src, j + 2, false);
        } else {
          const end = closeParen(src, j + 2, false);
          nested.push({ src: src.slice(j + 2, end - 1), label: '$(...)' });
          j = end;
        }
        dyn = true;
        parts += 2;
        continue;
      }
      if (c === '`') {
        const end = src.indexOf('`', j + 1);
        const stop = end < 0 ? n : end;
        nested.push({ src: src.slice(j + 1, stop).replace(/\\`/g, '`'), label: '`...`' });
        j = stop + 1;
        dyn = true;
        parts += 2;
        continue;
      }
      if (c === '$') {
        if (src[j + 1] === '{') {
          const end = closeBrace(src, j + 2);
          const inner = src.slice(j + 2, end - 1);
          if (parts === 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) soleRef = inner;
          else soleRef = null;
          j = end;
          dyn = true;
          parts++;
          continue;
        }
        const m = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(src.slice(j + 1));
        if (m) {
          soleRef = parts === 0 && /^[A-Za-z_]/.test(m[0]) ? m[0] : null;
          j += 1 + m[0].length;
          dyn = true;
          parts++;
          continue;
        }
      }
      text += c;
      parts += 2;
      j++;
    }
    if (dyn) {
      if (text) word.add(text);
      word.addDyn({ varRef: parts === 1 ? soleRef : null });
    } else {
      word.add(text);
    }
    return j + 1;
  }

  /** One word starting at i. Returns [word, indexAfter]. */
  function readWord(i) {
    const word = new Word();
    while (i < n) {
      const c = src[i];
      if (POSIX_BOUNDARY.has(c)) break;
      if (c === '\\') {
        if (src[i + 1] === '\n') { i += 2; continue; }
        if (i + 1 < n) word.add(src[i + 1]);
        i += 2;
        continue;
      }
      if (c === "'") {
        const end = src.indexOf("'", i + 1);
        const stop = end < 0 ? n : end;
        word.add(src.slice(i + 1, stop));
        i = stop + 1;
        continue;
      }
      if (c === '"') { i = readDouble(i, word); continue; }
      if (c === '$') { i = readDollar(i, word); continue; }
      if (c === '`') {
        const end = src.indexOf('`', i + 1);
        const stop = end < 0 ? n : end;
        const body = src.slice(i + 1, stop).replace(/\\`/g, '`');
        nested.push({ src: body, label: '`...`' });
        word.addDyn({ subst: body });
        i = stop + 1;
        continue;
      }
      word.add(c);
      i++;
    }
    return [word, i];
  }

  const skipBlanks = (i) => {
    while (i < n && (src[i] === ' ' || src[i] === '\t' || src[i] === '\r')) i++;
    return i;
  };

  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\n') {
      endCommand('\n');
      i++;
      for (const h of pending) {
        const lines = [];
        while (i < n) {
          let j = src.indexOf('\n', i);
          if (j < 0) j = n;
          let line = src.slice(i, j);
          i = Math.min(j + 1, n);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
          lines.push(line);
        }
        const body = lines.join('\n');
        h.cmd.heredocs.push(body);
        if (!h.quoted) for (const s of substitutionsIn(body)) nested.push({ src: s, label: '$(...)' });
      }
      pending = [];
      continue;
    }
    if (c === ';') {
      endCommand(';');
      i++;
      continue;
    }
    if (c === '&') {
      if (src[i + 1] === '&') { endCommand('&&'); i += 2; continue; }
      if (src[i + 1] === '>') { i = redirect(i + 1); continue; }
      endCommand('&');
      i++;
      continue;
    }
    if (c === '|') {
      if (src[i + 1] === '|') { endCommand('||'); i += 2; continue; }
      endCommand('|');
      i += src[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (c === '(' || c === ')') {
      endCommand(c);
      i++;
      continue;
    }
    if (c === '<' || c === '>') { i = redirect(i); continue; }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(?=[<>])/.exec(src.slice(i));
      if (m) { i = redirect(i + m[0].length); continue; }
    }
    if ((c === '{' || c === '}') && (i + 1 >= n || /[\s;]/.test(src[i + 1]))) {
      endCommand(c);
      i++;
      continue;
    }
    const [word, end] = readWord(i);
    cmd.words.push(word);
    i = end;
  }
  endCommand('end');

  function redirect(i) {
    // Process substitution runs a command: `<(...)`, `>(...)`.
    if ((src[i] === '<' || src[i] === '>') && src[i + 1] === '(') {
      const end = closeParen(src, i + 2, false);
      nested.push({ src: src.slice(i + 2, end - 1), label: '<(...)' });
      const w = new Word();
      w.addDyn();
      cmd.words.push(w);
      return end;
    }
    if (src.startsWith('<<<', i)) {
      const [word, end] = readWord(skipBlanks(i + 3));
      cmd.herestrings.push(word.v);
      return end;
    }
    if (src.startsWith('<<', i)) {
      let j = i + 2;
      const strip = src[j] === '-';
      if (strip) j++;
      j = skipBlanks(j);
      const raw = /^[^\s;&|<>()]*/.exec(src.slice(j))[0];
      const [word, end] = readWord(j);
      pending.push({ delim: word.v, strip, quoted: /['"\\]/.test(raw), cmd });
      return end;
    }
    let j = i;
    while (j < n && /[<>&|]/.test(src[j])) j++;
    j = skipBlanks(j);
    if (j >= n || src[j] === '\n') return j;
    const [, end] = readWord(j);
    return end;
  }

  return { commands, nested: nested.map((x) => ({ ...x, g: 'posix' })) };
}

// ---------------------------------------------------------------------------
// PowerShell lexer (PowerShell tool)
// ---------------------------------------------------------------------------

const PS_BOUNDARY = new Set([' ', '\t', '\r', '\n', ';', '|', '(', ')', '{', '}', '<', '>', '&']);

export function lexPs(src) {
  const commands = [];
  const nested = [];
  let cmd = newCommand();
  const n = src.length;

  const endCommand = (sep) => {
    if (cmd.words.length) commands.push(cmd);
    const prev = cmd;
    cmd = newCommand();
    if (sep === '|') cmd.pipedFrom = prev;
  };

  function readDouble(i, word) {
    let j = i + 1;
    let text = '';
    let dyn = false;
    while (j < n) {
      const c = src[j];
      if (c === '"') {
        if (src[j + 1] === '"') { text += '"'; j += 2; continue; }
        break;
      }
      if (c === '`') { text += src[j + 1] ?? ''; j += 2; continue; }
      if (c === '$' && src[j + 1] === '(') {
        const end = closeParen(src, j + 2, true);
        nested.push({ src: src.slice(j + 2, end - 1), label: '$(...)' });
        j = end;
        dyn = true;
        continue;
      }
      if (c === '$') {
        const m = /^(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_:]*)/.exec(src.slice(j + 1));
        if (m) {
          j += 1 + m[0].length;
          dyn = true;
          continue;
        }
      }
      text += c;
      j++;
    }
    word.add(text);
    if (dyn) word.addDyn();
    return j + 1;
  }

  function readHere(i, word) {
    const quote = src[i + 1];
    const lineEnd = src.indexOf('\n', i + 2);
    if (lineEnd < 0 || src.slice(i + 2, lineEnd).trim() !== '') return -1;
    const re = quote === "'" ? /\r?\n[ \t]*'@/g : /\r?\n[ \t]*"@/g;
    re.lastIndex = lineEnd;
    const m = re.exec(src);
    const stop = m ? m.index : n;
    const body = src.slice(lineEnd + 1, stop);
    word.add(body);
    if (quote === '"') {
      for (let k = 0; k < body.length; k++) {
        if (body[k] === '`') { k++; continue; }
        if (body[k] === '$' && body[k + 1] === '(') {
          const end = closeParen(body, k + 2, true);
          nested.push({ src: body.slice(k + 2, end - 1), label: '$(...)' });
          word.addDyn();
          k = end - 1;
        }
      }
    }
    return m ? m.index + m[0].length : n;
  }

  function readWord(i) {
    const word = new Word();
    while (i < n) {
      const c = src[i];
      if (PS_BOUNDARY.has(c)) break;
      if (c === '`') {
        if (src[i + 1] === '\n' || (src[i + 1] === '\r' && src[i + 2] === '\n')) break;
        if (i + 1 < n) word.add(src[i + 1]);
        i += 2;
        continue;
      }
      if (c === "'") {
        let j = i + 1;
        let text = '';
        while (j < n) {
          if (src[j] === "'") {
            if (src[j + 1] === "'") { text += "'"; j += 2; continue; }
            break;
          }
          text += src[j++];
        }
        word.add(text);
        i = j + 1;
        continue;
      }
      if (c === '"') { i = readDouble(i, word); continue; }
      if (c === '@' && word.empty && (src[i + 1] === "'" || src[i + 1] === '"')) {
        const end = readHere(i, word);
        if (end >= 0) { i = end; continue; }
      }
      if ((c === '$' || c === '@') && src[i + 1] === '(') {
        const end = closeParen(src, i + 2, true);
        const body = src.slice(i + 2, end - 1);
        nested.push({ src: body, label: `${c}(...)` });
        word.addDyn({ subst: c === '$' ? body : null });
        i = end;
        continue;
      }
      if (c === '$') {
        const m = /^(?:\{([^}]*)\}|([A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_]*)?))/.exec(src.slice(i + 1));
        if (m) {
          const name = (m[1] ?? m[2]).replace(/^(?:script|global|local|private):/i, '').toLowerCase();
          word.addDyn({ varRef: name });
          i += 1 + m[0].length;
          // `$x=...` without spaces: end the word at `=` so the assignment is visible.
          if (src[i] === '=' && src[i + 1] !== '=' && word.varRef) break;
          continue;
        }
      }
      word.add(c);
      i++;
    }
    return [word, i];
  }

  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '`' && (src[i + 1] === '\n' || src[i + 1] === '\r')) { i += src[i + 1] === '\r' ? 3 : 2; continue; }
    if (c === '<' && src[i + 1] === '#') {
      const end = src.indexOf('#>', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\n' || c === ';') { endCommand(c); i++; continue; }
    if (c === '|') {
      if (src[i + 1] === '|') { endCommand('||'); i += 2; continue; }
      endCommand('|');
      i++;
      continue;
    }
    if (c === '&') {
      if (src[i + 1] === '&') { endCommand('&&'); i += 2; continue; }
      // The call operator. `& 'Remove-Item' x` runs Remove-Item.
      i++;
      continue;
    }
    if (c === '(' || c === ')' || c === '{' || c === '}') { endCommand(c); i++; continue; }
    if (c === '@' && src[i + 1] === '{') { endCommand('{'); i += 2; continue; }
    if (c === '<' || c === '>' || ((c === '*' || /[0-9]/.test(c)) && (src[i + 1] === '>' || src[i + 1] === '<'))) {
      let j = c === '<' || c === '>' ? i : i + 1;
      while (j < n && (src[j] === '<' || src[j] === '>')) j++;
      if (src[j] === '&' && /[0-9]/.test(src[j + 1] ?? '')) { i = j + 2; continue; }
      while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
      if (j >= n || src[j] === '\n') { i = j; continue; }
      i = readWord(j)[1];
      continue;
    }
    const [word, end] = readWord(i);
    if (end === i) { i++; continue; }
    cmd.words.push(word);
    i = end;
  }
  endCommand('end');
  return { commands, nested: nested.map((x) => ({ ...x, g: 'ps' })) };
}

// ---------------------------------------------------------------------------
// cmd.exe lexer (`cmd /c ...`)
// ---------------------------------------------------------------------------

export function lexCmd(src) {
  const commands = [];
  let cmd = newCommand();
  let word = null;
  let inQuote = false;
  const n = src.length;
  const endWord = () => { if (word) { cmd.words.push(word); word = null; } };
  const endCommand = () => { endWord(); if (cmd.words.length) commands.push(cmd); cmd = newCommand(); };
  for (let i = 0; i < n; i++) {
    const c = src[i];
    if (inQuote) {
      if (c === '"') inQuote = false;
      else word.add(c);
      continue;
    }
    if (c === '"') { word ??= new Word(); word.add(''); inQuote = true; continue; }
    if (c === '^') { word ??= new Word(); word.add(src[i + 1] ?? ''); i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); continue; }
    if (c === '\n' || c === '&' || c === '|' || c === '(' || c === ')') {
      endCommand();
      if ((c === '&' || c === '|') && src[i + 1] === c) i++;
      continue;
    }
    if (c === '<' || c === '>') {
      if (word && /^[0-9]$/.test(word.v)) word = null;
      endWord();
      let j = i;
      while (j < n && /[<>]/.test(src[j])) j++;
      if (src[j] === '&') { i = j + 1; continue; }
      while (j < n && src[j] === ' ') j++;
      while (j < n && !/[\s&|<>()]/.test(src[j])) j++;
      i = j - 1;
      continue;
    }
    word ??= new Word();
    word.add(c);
  }
  endCommand();
  return { commands, nested: [] };
}

/**
 * Words after the options of a wrapper. `valued` options consume the next
 * word unless written as `--opt=value`. `--` ends the options.
 */
export function afterOptions(args, valued = []) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i].v;
    if (a === '--') return args.slice(i + 1);
    if (a.length > 1 && a.startsWith('-')) {
      if (valued.includes(a)) i++;
      continue;
    }
    return args.slice(i);
  }
  return [];
}

export const valueAfter = (args, names) => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i].v;
    if (names.includes(a)) return i + 1 < args.length ? args[i + 1] : new Word('');
    for (const name of names) if (name.startsWith('--') && a.startsWith(name + '=')) return new Word(a.slice(name.length + 1));
  }
  return null;
};
