#!/usr/bin/env node
/**
 * guard-destructive.mjs — Claude Code PreToolUse hook. Stops the destructive
 * commands this kit already puts in permissions.deny when they arrive in a
 * shape that deny does not match.
 *
 * WHY THIS EXISTS
 * permissions.deny is still the first layer, and it is better than it used
 * to be. Per Anthropic's permissions reference (code.claude.com/docs/en/
 * permissions, "Compound commands" / "Wrappers", read 2026-09-17), Claude
 * Code already:
 *   - splits `&&` `||` `;` `|` `|&` `&` and newlines, and applies deny to
 *     every subcommand, including ones inside a subshell, `$(...)`, or a
 *     `for` body — so `cd /tmp && rm -rf x` IS blocked by `Bash(rm -rf:*)`;
 *   - strips `timeout` `time` `nice` `nohup` `stdbuf` `command` `builtin`
 *     `noglob`, bare `xargs`, and leading `VAR=value` assignments;
 *   - parses the PowerShell AST and resolves aliases (`rm` -> Remove-Item).
 * This hook does not re-implement any of that for its own sake.
 *
 * The same page is equally explicit about what deny does NOT match ("What a
 * Bash rule doesn't match": "isn't a security boundary around the
 * program"). Those are the shapes handled here:
 *   - the program by path or with quotes: `/bin/rm -rf x`, `\rm -rf x`,
 *     `git 'push' --force`;
 *   - through a shell or evaluator: `bash -c '...'`, `sh -c`, `eval`,
 *     `echo '...' | sh`, `bash <<EOF`, `powershell -Command`,
 *     `pwsh -EncodedCommand`, `cmd /c`, `Invoke-Expression`, `wsl`;
 *   - through a runner or wrapper not on Claude Code's list: `sudo`, `env`,
 *     `xargs -n1`, `find -exec`, `npx`, `pnpm dlx`, `bunx`, `devbox run`,
 *     `direnv exec`, `mise exec`, `uv run`, `busybox`, `watch`, `flock`;
 *   - git global options before the subcommand: `git -C . push --force`,
 *     `git -c k=v push -f`;
 *   - flag spellings a prefix rule cannot enumerate: `rm -rfv`, `rm -fr`,
 *     `rm -r -f`, `rm --recursive`, `git push origin main --force`,
 *     `git push -uf`, `git push origin +main`, `git clean -xdf`,
 *     `git branch --delete --force` (data/pitfalls/perm-005.json);
 *   - interpreter one-liners that do the same thing: `node -e` with
 *     `rmSync(..., {recursive: true})`, `python -c` with `shutil.rmtree`,
 *     and shell strings handed to `os.system` / `execSync`.
 * See data/pitfalls/perm-006.json.
 *
 * WHAT IT BLOCKS — the kit's own deny list, generalized, not a new policy:
 *   rm with a recursive flag            (deny: Bash(rm -rf:*), Bash(rm -r:*))
 *   rimraf, rd /s, rmdir /s, del /s     (the same operation, other programs)
 *   Remove-Item in PowerShell syntax    (deny: PowerShell(Remove-Item:*) —
 *                                        mirrored as is: every Remove-Item,
 *                                        recursive or not, like the rule)
 *   git push --force / -f / --force-with-lease / --mirror / +refspec
 *                                       (deny: git push --force, git push -f)
 *   git reset --hard                    (deny: git reset --hard)
 *   git clean with -f, unless -n        (deny: git clean -fd, git clean -fdx)
 *   git branch -D, or --delete --force  (deny: git branch -D)
 *   supabase db reset                   (deny: supabase db reset)
 * Two additions with no deny counterpart, because they exist only to hide
 * one of the above: `git -c alias.X=...` (an inline alias can be any
 * command) and `git -c clean.requireForce=false` (git clean without -f).
 *
 * WHY THIS IS STILL NOT A BOUNDARY
 * It reads command text, like deny does, only more of it. It cannot see
 * into a script file, an npm script, a git alias defined earlier, a
 * Makefile, `ssh host ...`, `docker exec ...`, a glob in the command name,
 * or a variable it did not see assigned. The page above points to sandboxing
 * for enforcement that does not depend on the command text; that remains the
 * answer when the restriction must hold.
 *
 * GRAMMARS
 * The Bash tool is read with POSIX shell rules, the PowerShell tool with
 * PowerShell rules, and `cmd /c` with cmd rules. A single grammar for all
 * three is what made guard-sql's string neutralization create a hole
 * (backticks and backslashes mean different things in each).
 *
 * Exit 0 -> allow.  Exit 2 -> block, reason on stderr.
 * Any internal failure exits 0 with a note on stderr: permissions.deny is
 * still in front of this hook, so a broken guard must not brick the
 * toolchain. The same choice guard-secrets and guard-config make.
 */

const MAX_DEPTH = 8;
const SHELL_TOOL_RE = /^(Bash|PowerShell)$/;

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
class Word {
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

const newCommand = () => ({ words: [], heredocs: [], herestrings: [], pipedFrom: null });

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

function lexPosix(src) {
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

function lexPs(src) {
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

function lexCmd(src) {
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

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

const hitOf = (what, via) => ({ what, via });

function cmdName(raw) {
  const base = raw.split(/[\\/]/).pop() ?? raw;
  return base.toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, '');
}

const joinWords = (words, ctx) => words.map((w) => wordText(w, ctx)).join(' ');

function wordText(w, ctx) {
  if (w.dyn && w.varRef && ctx.vars.has(w.varRef)) return ctx.vars.get(w.varRef);
  return w.v;
}

function resolveDyn(w, ctx) {
  if (w.varRef && ctx.vars.has(w.varRef)) return ctx.vars.get(w.varRef);
  if (w.subst) {
    const m = /^\s*(?:which|command\s+-v|type\s+-[pP]|whence\s+-p)\s+([^\s;|&]+)\s*$/.exec(w.subst);
    if (m) return m[1];
  }
  return null;
}

const splitWords = (text) => text.split(/\s+/).filter(Boolean).map((t) => new Word(t));
const isAssignment = (w) => /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(w.v);

/** Remember `X=value` so a later `$X` in command position can be resolved. */
function recordAssignment(command, g, ctx) {
  const ws = command.words;
  if (!ws.length) return false;
  if (g === 'ps') {
    const w0 = ws[0];
    if (!w0.varRef || ws.length < 2) return false;
    let value = null;
    if (ws[1].v === '=' && ws.length >= 3) value = ws.slice(2);
    else if (ws[1].v.startsWith('=') && !ws[1].v.startsWith('==')) value = [new Word(ws[1].v.slice(1)), ...ws.slice(2)];
    if (!value) return false;
    ctx.vars.set(w0.varRef, joinWords(value, ctx).trim());
    return true;
  }
  let start = 0;
  if (['export', 'declare', 'typeset', 'local', 'readonly'].includes(ws[0].v)) start = 1;
  const rest = ws.slice(start).filter((w) => !w.v.startsWith('-'));
  if (!rest.length || !rest.every(isAssignment)) return false;
  for (const w of rest) {
    const eq = w.v.indexOf('=');
    const name = w.v.slice(0, eq).replace(/\+$/, '');
    if (w.dyn) ctx.vars.delete(name);
    else ctx.vars.set(name, w.v.slice(eq + 1));
  }
  return true;
}

/**
 * Words after the options of a wrapper. `valued` options consume the next
 * word unless written as `--opt=value`. `--` ends the options.
 */
function afterOptions(args, valued = []) {
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

const valueAfter = (args, names) => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i].v;
    if (names.includes(a)) return i + 1 < args.length ? args[i + 1] : new Word('');
    for (const name of names) if (name.startsWith('--') && a.startsWith(name + '=')) return new Word(a.slice(name.length + 1));
  }
  return null;
};

/**
 * Wrappers and runners. Each returns { rest } — the words starting at the
 * command it will run — or { source } — a string it hands to a shell — or
 * null when there is no command to look at.
 */
const RUNNERS = {
  sudo: (a) => ({ rest: afterOptions(a, ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '--user', '--group', '--host', '--prompt', '--close-from', '--chdir', '--role', '--type', '--other-user', '--command-timeout']) }),
  doas: (a) => ({ rest: afterOptions(a, ['-u', '-C']) }),
  nice: (a) => ({ rest: afterOptions(a, ['-n', '--adjustment']) }),
  ionice: (a) => ({ rest: afterOptions(a, ['-c', '-n', '--class', '--classdata']) }),
  timeout: (a) => ({ rest: afterOptions(a, ['-s', '-k', '--signal', '--kill-after']).slice(1) }),
  time: (a) => ({ rest: afterOptions(a, ['-o', '-f', '--output', '--format']) }),
  nohup: (a) => ({ rest: afterOptions(a) }),
  command: (a) => (a[0] && /^-[a-zA-Z]*[vV]/.test(a[0].v) ? null : { rest: afterOptions(a) }),
  builtin: (a) => ({ rest: a }),
  noglob: (a) => ({ rest: a }),
  nocorrect: (a) => ({ rest: a }),
  exec: (a) => ({ rest: afterOptions(a, ['-a']) }),
  stdbuf: (a) => ({ rest: afterOptions(a, ['-i', '-o', '-e']) }),
  setsid: (a) => ({ rest: afterOptions(a) }),
  chronic: (a) => ({ rest: afterOptions(a) }),
  unbuffer: (a) => ({ rest: afterOptions(a) }),
  caffeinate: (a) => ({ rest: afterOptions(a, ['-t', '-w']) }),
  busybox: (a) => ({ rest: a }),
  'cross-env': (a) => ({ rest: a }),
  xargs: (a) => ({ rest: afterOptions(a, ['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s', '--arg-file', '--delimiter', '--max-lines', '--max-args', '--max-procs', '--max-chars', '--process-slot-var', '--eof', '--replace']) }),
  watch: (a) => ({ source: afterOptions(a, ['-n', '--interval']) }),
  env(a) {
    for (let i = 0; i < a.length; i++) {
      const v = a[i].v;
      if (v === '-S' || v === '--split-string') return { source: a.slice(i + 1) };
      if (v.startsWith('--split-string=')) return { source: [new Word(v.slice(15)), ...a.slice(i + 1)] };
      if (/^-S./.test(v)) return { source: [new Word(v.slice(2)), ...a.slice(i + 1)] };
      if (['-u', '-C', '--unset', '--chdir'].includes(v)) { i++; continue; }
      if (v === '--') return { rest: a.slice(i + 1) };
      if (v.startsWith('-') || isAssignment(a[i])) continue;
      return { rest: a.slice(i) };
    }
    return null;
  },
  flock(a) {
    const r = afterOptions(a, ['-w', '--wait', '--timeout', '-E', '--conflict-exit-code']);
    if (r[1] && (r[1].v === '-c' || r[1].v === '--command')) return { source: r.slice(2, 3) };
    return { rest: r.slice(1) };
  },
  wsl(a) {
    for (let i = 0; i < a.length; i++) {
      const v = a[i].v;
      if (v === '-e' || v === '--exec' || v === '--') return { rest: a.slice(i + 1) };
      if (['-d', '--distribution', '-u', '--user', '--cd', '--shell-type'].includes(v)) { i++; continue; }
      if (v.startsWith('-')) continue;
      return { source: a.slice(i) };
    }
    return null;
  },
  npx(a) {
    const call = valueAfter(a, ['-c', '--call']);
    if (call) return { source: [call] };
    return { rest: afterOptions(a, ['-p', '--package']) };
  },
  pnpx: (a) => RUNNERS.npx(a),
  bunx: (a) => ({ rest: afterOptions(a, ['-p', '--package']) }),
  npm: (a) => (a[0] && ['exec', 'x'].includes(a[0].v) ? RUNNERS.npx(a.slice(1)) : null),
  pnpm(a) {
    if (!a[0] || !['dlx', 'exec'].includes(a[0].v)) return null;
    const r = a.slice(1);
    const shell = r.findIndex((w) => w.v === '-c' || w.v === '--shell-mode');
    if (shell >= 0) return { source: r.slice(shell + 1) };
    return { rest: afterOptions(r, ['-p', '--package', '--filter', '-F', '-C', '--dir', '--workspace-concurrency']) };
  },
  yarn: (a) => (a[0] && ['dlx', 'exec'].includes(a[0].v) ? { rest: afterOptions(a.slice(1), ['-p', '--package']) } : null),
  bun(a) {
    if (!a[0]) return null;
    if (a[0].v === 'x') return RUNNERS.bunx(a.slice(1));
    if (a[0].v === 'exec') return { source: a.slice(1) };
    return null;
  },
  direnv: (a) => (a[0] && a[0].v === 'exec' ? { rest: a.slice(2) } : null),
  devbox: (a) => (a[0] && a[0].v === 'run' ? { rest: afterOptions(a.slice(1), ['-c', '--config', '-e', '--env', '--env-file', '--environment']) } : null),
  mise(a) {
    if (!a[0] || !['exec', 'x'].includes(a[0].v)) return null;
    const r = a.slice(1);
    const command = valueAfter(r, ['-c', '--command']);
    if (command) return { source: [command] };
    const dd = r.findIndex((w) => w.v === '--');
    if (dd >= 0) return { rest: r.slice(dd + 1) };
    let rest = afterOptions(r, ['-C', '--cd', '-j', '--jobs', '-E', '--env']);
    while (rest.length && rest[0].v.includes('@')) rest = rest.slice(1);
    return { rest };
  },
  rtx: (a) => RUNNERS.mise(a),
  uv: (a) => (a[0] && a[0].v === 'run' ? { rest: afterOptions(a.slice(1), ['--with', '--python', '-p', '--directory', '--project', '--env-file', '--extra', '--group', '--package', '--index', '--index-url', '--with-requirements', '--with-editable']) } : null),
  poetry: (a) => (a[0] && a[0].v === 'run' ? { rest: afterOptions(a.slice(1)) } : null),
  pipenv: (a) => (a[0] && a[0].v === 'run' ? { rest: afterOptions(a.slice(1)) } : null),
  pdm: (a) => (a[0] && a[0].v === 'run' ? { rest: afterOptions(a.slice(1)) } : null),
  bundle: (a) => (a[0] && a[0].v === 'exec' ? { rest: a.slice(1) } : null),
  dotenv(a) {
    const dd = a.findIndex((w) => w.v === '--');
    return { rest: dd >= 0 ? a.slice(dd + 1) : afterOptions(a, ['-e', '-v', '-c', '-p']) };
  },
  'nix-shell': (a) => {
    const run = valueAfter(a, ['--run', '--command']);
    return run ? { source: [run] } : null;
  },
  nix(a) {
    if (!a[0] || !['develop', 'shell'].includes(a[0].v)) return null;
    const i = a.findIndex((w) => w.v === '-c' || w.v === '--command');
    return i >= 0 ? { rest: a.slice(i + 1) } : null;
  },
};

const POSIX_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'case', 'esac', 'in', 'select', 'function', 'coproc', '!', '{', '}']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'yash', 'git-bash']);
const PS_REMOVE_ITEM = new Set(['remove-item', 'rm', 'del', 'erase', 'rd', 'rmdir', 'ri']);
const INTERPRETERS = {
  node: { short: ['e', 'p'], long: ['--eval', '--print'] },
  nodejs: { short: ['e', 'p'], long: ['--eval', '--print'] },
  bun: { short: ['e', 'p'], long: ['--eval', '--print'] },
  deno: { sub: 'eval' },
  python: { short: ['c'], long: [] },
  python3: { short: ['c'], long: [] },
  py: { short: ['c'], long: [] },
  pypy3: { short: ['c'], long: [] },
  perl: { short: ['e', 'E'], long: [] },
  ruby: { short: ['e'], long: [] },
  php: { short: ['r'], long: [] },
};
for (const minor of ['3.8', '3.9', '3.10', '3.11', '3.12', '3.13', '3.14']) INTERPRETERS[`python${minor}`] = INTERPRETERS.python;

const DESTRUCTIVE_CODE = [
  /\b(?:rmSync|rmdirSync|rm|rmdir)\s*\([^)]*\brecursive\s*:\s*(?:true|!0)/,
  /\bDeno\s*\.\s*remove(?:Sync)?\s*\([^)]*\brecursive\s*:\s*true/,
  /\bshutil\s*\.\s*rmtree\b/,
  /(?:^|[^\w.])rmtree\s*\(/,
  /\bremove_tree\s*\(/,
  /\bFileUtils\s*\.\s*(?:rm_r|rm_rf|rmtree|remove_dir|remove_entry(?:_secure)?)\b/,
];
const EXEC_HINT = /\b(?:system|exec|execSync|execFileSync|spawn|spawnSync|popen|Popen|run|call|check_call|check_output|getoutput|getstatusoutput|shell_exec|passthru|proc_open|qx)\b|`/;

const DOTNET_DELETE = [
  /\[\s*(?:System\s*\.\s*)?IO\s*\.\s*Directory\s*\]\s*::\s*Delete\s*\([^)]*,\s*\$true\s*\)/i,
  /\.\s*Delete\s*\(\s*\$true\s*\)/i,
  /\[\s*Microsoft\s*\.\s*VisualBasic\s*\.\s*FileIO\s*\.\s*FileSystem\s*\]\s*::\s*DeleteDirectory\s*\(/i,
];

const isShortCluster = (a, letter) => /^-[A-Za-z0-9]+$/.test(a) && a.slice(1).includes(letter);
const isLong = (a, full, min) => {
  const key = a.split('=')[0];
  return key.length >= min && key.startsWith('--') && full.startsWith(key);
};

/** Options before `--`; after it everything is a path or refspec. */
function optionsOf(args) {
  const dd = args.indexOf('--');
  return dd >= 0 ? args.slice(0, dd) : args;
}

function posixRecursive(args) {
  for (const a of optionsOf(args)) {
    if (isLong(a, '--recursive', 3)) return true;
    if (/^-[A-Za-z]+$/.test(a) && /[rR]/.test(a)) return true;
  }
  return false;
}

const GIT_GLOBAL_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env', '--attr-source']);

function inspectGit(args, via) {
  let i = 0;
  let cleanWithoutForce = false;
  for (; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-') || a === '-') break;
    const key = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    if (!GIT_GLOBAL_VALUED.has(key)) continue;
    let value;
    if (a.includes('=') && key !== '-c') value = a.slice(a.indexOf('=') + 1);
    else value = args[++i] ?? '';
    if (key === '-c' || key === '--config-env') {
      if (/^alias\./i.test(value)) return hitOf('an inline git alias (git -c alias.*), which can stand for any command', via);
      if (/^clean\.requireforce=(?:false|no|off|0)$/i.test(value)) cleanWithoutForce = true;
    }
  }
  const sub = (args[i] ?? '').toLowerCase();
  const rest = args.slice(i + 1);
  const opts = optionsOf(rest);
  const via2 = [...via, 'git'];
  switch (sub) {
    case 'push': {
      let afterDashes = false;
      for (const a of rest) {
        if (!afterDashes && a === '--') { afterDashes = true; continue; }
        if (!afterDashes && a.startsWith('--')) {
          if (isLong(a, '--force', 4) || isLong(a, '--force-with-lease', 9) || isLong(a, '--mirror', 4)) {
            return hitOf(`a force push (git push ${a})`, via2);
          }
          continue;
        }
        if (!afterDashes && a.length > 1 && a.startsWith('-')) {
          if (a.slice(1).includes('f')) return hitOf(`a force push (git push ${a})`, via2);
          continue;
        }
        if (a.startsWith('+')) return hitOf(`a force push (refspec ${a})`, via2);
      }
      return null;
    }
    case 'reset':
      return opts.some((a) => isLong(a, '--hard', 4)) ? hitOf('git reset --hard', via2) : null;
    case 'clean': {
      const dry = opts.some((a) => isShortCluster(a, 'n') || isLong(a, '--dry-run', 4));
      const force = cleanWithoutForce || opts.some((a) => isShortCluster(a, 'f') || isLong(a, '--force', 4));
      return force && !dry ? hitOf('git clean that deletes files', via2) : null;
    }
    case 'branch': {
      const forceDelete = opts.some((a) => isShortCluster(a, 'D'));
      const del = opts.some((a) => isShortCluster(a, 'd') || isLong(a, '--delete', 5));
      const force = opts.some((a) => isShortCluster(a, 'f') || isLong(a, '--force', 4));
      return forceDelete || (del && force) ? hitOf('a forced branch delete (git branch -D)', via2) : null;
    }
    default:
      return null;
  }
}

function inspectSupabase(args, via) {
  const valued = new Set(['--workdir', '--profile', '--network-id', '--dns-resolver', '-o', '--output', '--project-ref', '--db-url', '--version']);
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') continue;
    if (a.startsWith('-')) {
      if (!a.includes('=') && valued.has(a)) i++;
      continue;
    }
    positional.push(a.toLowerCase());
  }
  return positional[0] === 'db' && positional[1] === 'reset' ? hitOf('supabase db reset', via) : null;
}

function interpreterCode(spec, args) {
  if (spec.sub) {
    if (args[0] !== spec.sub) return null;
    return afterOptions(args.slice(1).map((v) => new Word(v)))[0]?.v ?? null;
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    for (const long of spec.long) {
      if (a === long) return args[i + 1] ?? '';
      if (a.startsWith(long + '=')) return a.slice(long.length + 1);
    }
    if (!/^-[A-Za-z]/.test(a) || a.startsWith('--')) {
      if (!a.startsWith('-')) return null;
      continue;
    }
    if (spec.short.includes(a[1]) && a.length > 2 && !/^[A-Za-z]+$/.test(a.slice(2))) return a.slice(2);
    if (spec.short.includes(a[a.length - 1]) && /^-[A-Za-z]+$/.test(a)) return args[i + 1] ?? '';
  }
  return null;
}

function quotedLiterals(code) {
  const out = [];
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  let m;
  while ((m = re.exec(code)) !== null && out.length < 50) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function inspectCode(code, depth, ctx, via) {
  // Match calls, not mentions: `print('shutil.rmtree ...')` is text. The
  // path argument of a real call is a literal too, and blanking it keeps the
  // call's shape (`rmtree('')`) intact.
  const bare = code.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, (m) => m[0] + m[0]);
  for (const re of DESTRUCTIVE_CODE) {
    if (re.test(bare)) return hitOf('a recursive delete in interpreter code', via);
  }
  if (!EXEC_HINT.test(code)) return null;
  const literals = quotedLiterals(code);
  for (let i = 0; i < literals.length; i++) {
    const hit = scan(literals.slice(i).join(' '), 'posix', depth + 1, ctx, via);
    if (hit) return hit;
  }
  return null;
}

function inspectShell(name, args, command, depth, ctx, via) {
  const valued = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
  let sawC = false;
  let stdin = false;
  let operand = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i].v;
    if (a === '--command') return scan(wordText(args[i + 1] ?? new Word(), ctx), 'posix', depth + 1, ctx, [...via, `${name} -c`]);
    if (a.startsWith('--command=')) return scan(a.slice(10), 'posix', depth + 1, ctx, [...via, `${name} -c`]);
    if (a === '-') { stdin = true; continue; }
    if (a === '--') { operand = args[i + 1] ?? null; break; }
    if (/^[-+][A-Za-z]+$/.test(a)) {
      if (valued.has(a)) { i++; continue; }
      if (a[0] === '-' && a.includes('c')) sawC = true;
      if (a[0] === '-' && a.includes('s')) stdin = true;
      continue;
    }
    if (a.startsWith('--')) {
      if (valued.has(a)) i++;
      continue;
    }
    operand = args[i];
    break;
  }
  const label = `${name} -c`;
  if (sawC) return operand ? scan(wordText(operand, ctx), 'posix', depth + 1, ctx, [...via, label]) : null;
  if (operand && !stdin) return null;
  const fed = [...command.heredocs, ...command.herestrings];
  const from = command.pipedFrom;
  if (from && from.words.length && ['echo', 'printf'].includes(cmdName(from.words[0].v))) {
    fed.push(joinWords(from.words.slice(1).filter((w) => !/^-[neE]+$/.test(w.v)), ctx).replace(/\\n/g, '\n'));
  }
  for (const body of fed) {
    const hit = scan(body, 'posix', depth + 1, ctx, [...via, `${name} (stdin)`]);
    if (hit) return hit;
  }
  return null;
}

function inspectPowerShellExe(name, args, depth, ctx, via) {
  const valued = ['executionpolicy', 'ex', 'ep', 'windowstyle', 'w', 'win', 'outputformat', 'o', 'of', 'inputformat', 'if', 'inp', 'version', 'v', 'configurationname', 'config', 'workingdirectory', 'wd', 'settingsfile', 'psconsolefile', 'custompipename'];
  for (let i = 0; i < args.length; i++) {
    const a = args[i].v;
    if (a.length > 1 && (a.startsWith('-') || a.startsWith('/'))) {
      const key = a.replace(/^[-/]+/, '').split(':')[0].toLowerCase();
      if (['e', 'ec', 'en', 'enc'].includes(key) || (key.length >= 3 && 'encodedcommand'.startsWith(key))) {
        let decoded = '';
        try { decoded = Buffer.from(wordText(args[i + 1] ?? new Word(), ctx), 'base64').toString('utf16le'); } catch { decoded = ''; }
        return scan(decoded, 'ps', depth + 1, ctx, [...via, `${name} -EncodedCommand`]);
      }
      if (key === 'c' || (key.length >= 3 && 'command'.startsWith(key))) {
        return scan(joinWords(args.slice(i + 1), ctx), 'ps', depth + 1, ctx, [...via, `${name} -Command`]);
      }
      if (key === 'f' || key === 'file') return null;
      if (valued.includes(key)) i++;
      continue;
    }
    // powershell.exe treats a bare argument as -Command; pwsh treats it as -File.
    if (name === 'pwsh') return null;
    return scan(joinWords(args.slice(i), ctx), 'ps', depth + 1, ctx, [...via, `${name} -Command`]);
  }
  return null;
}

function inspectCmdExe(args, depth, ctx, via) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i].v;
    const m = /^\/([ckCK])(.*)$/.exec(a);
    if (m) {
      const text = [m[2], ...args.slice(i + 1).map((w) => wordText(w, ctx))].filter(Boolean).join(' ');
      return scan(text, 'cmd', depth + 1, ctx, [...via, 'cmd /c']);
    }
    if (!a.startsWith('/')) return null;
  }
  return null;
}

const cmdSwitches = (args) => args.flatMap((a) => (a.startsWith('/') ? a.split('/').filter(Boolean).map((s) => s.toLowerCase()) : []));

/**
 * The verdict for one simple command. `words` still include the command
 * word; wrappers are peeled off in a loop until a real command is reached.
 */
function inspectCommand(words, g, depth, ctx, command, via) {
  let ws = words;
  via = [...via];
  for (let guard = 0; guard < 64 && ws.length; guard++) {
    if (g !== 'ps') {
      while (ws.length && isAssignment(ws[0])) ws = ws.slice(1);
      if (!ws.length) return null;
    }
    let w0 = ws[0];
    if (w0.dyn) {
      const resolved = resolveDyn(w0, ctx);
      if (resolved == null) return null;
      ws = [...splitWords(resolved), ...ws.slice(1)];
      continue;
    }
    if (g === 'cmd') {
      const m = /^(rd|rmdir|del|erase)(\/.*)$/i.exec(w0.v);
      if (m) {
        ws = [new Word(m[1]), new Word(m[2]), ...ws.slice(1)];
        w0 = ws[0];
      }
    }
    const name = cmdName(w0.v);
    if (!name) return null;
    if (/\s/.test(name)) return scan(w0.v, g, depth + 1, ctx, via);
    const args = ws.slice(1);
    const argv = args.map((w) => wordText(w, ctx));

    if (g === 'posix' && POSIX_KEYWORDS.has(name)) { ws = args; continue; }
    if (g === 'ps' && name === '.') { ws = args; continue; }

    const runner = RUNNERS[name];
    if (runner) {
      const r = runner(args);
      if (!r) return null;
      via.push(name);
      if (r.source) return r.source.length ? scan(joinWords(r.source, ctx), 'posix', depth + 1, ctx, via) : null;
      ws = r.rest;
      continue;
    }

    if (SHELLS.has(name)) return inspectShell(name, args, command, depth, ctx, via);
    if (name === 'powershell' || name === 'pwsh') return inspectPowerShellExe(name, args, depth, ctx, via);
    if (name === 'cmd') return inspectCmdExe(args, depth, ctx, via);
    if (name === 'eval') return scan(argv.join(' '), 'posix', depth + 1, ctx, [...via, 'eval']);
    if (name === 'invoke-expression' || name === 'iex') {
      const text = argv.filter((a) => !/^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i.test(a)).join(' ');
      return scan(text, 'ps', depth + 1, ctx, [...via, 'Invoke-Expression']);
    }
    if (name === 'find') {
      for (let i = 0; i < args.length; i++) {
        if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[i].v)) continue;
        let j = i + 1;
        while (j < args.length && args[j].v !== ';' && args[j].v !== '+') j++;
        const hit = inspectCommand(args.slice(i + 1, j), 'posix', depth + 1, ctx, newCommand(), [...via, 'find -exec']);
        if (hit) return hit;
        i = j;
      }
      return null;
    }
    if (name === 'git') return inspectGit(argv, via);
    if (name === 'supabase') return inspectSupabase(argv, via);
    if (name === 'rimraf') return hitOf('a recursive delete (rimraf)', via);

    if (g === 'ps' && PS_REMOVE_ITEM.has(name)) {
      return hitOf(`Remove-Item (${w0.v}), which this kit denies outright for the PowerShell tool`, via);
    }
    if (g === 'cmd' && ['rd', 'rmdir', 'del', 'erase'].includes(name)) {
      return cmdSwitches(argv).includes('s') ? hitOf(`a recursive delete (${name} /s)`, via) : null;
    }
    if (name === 'rm') return posixRecursive(argv) ? hitOf(`a recursive delete (rm ${argv.filter((a) => a.startsWith('-')).join(' ')})`, via) : null;

    const spec = INTERPRETERS[name];
    if (spec) {
      const code = interpreterCode(spec, argv);
      return code ? inspectCode(code, depth, ctx, [...via, `${name} (inline code)`]) : null;
    }
    return null;
  }
  return null;
}

/** First destructive command anywhere in `src`, read with grammar `g`. */
function scan(src, g, depth, ctx, via) {
  if (typeof src !== 'string' || !src.trim()) return null;
  if (depth > MAX_DEPTH) return hitOf('commands nested too deeply to inspect', via);
  if (g === 'ps') {
    for (const re of DOTNET_DELETE) if (re.test(src)) return hitOf('a recursive .NET directory delete', via);
  }
  const lexed = g === 'ps' ? lexPs(src) : g === 'cmd' ? lexCmd(src) : lexPosix(src);
  for (const inner of lexed.nested) {
    const hit = scan(inner.src, inner.g, depth + 1, ctx, [...via, inner.label]);
    if (hit) return hit;
  }
  for (const command of lexed.commands) {
    if (recordAssignment(command, g, ctx)) continue;
    const hit = inspectCommand(command.words, g, depth, ctx, command, via);
    if (hit) return hit;
  }
  return null;
}

function inspect(toolName, command) {
  if (!SHELL_TOOL_RE.test(toolName) || typeof command !== 'string' || !command.trim()) return null;
  return scan(command, toolName === 'PowerShell' ? 'ps' : 'posix', 0, { vars: new Map() }, []);
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

function deny(hit, command) {
  const shown = command.length > 300 ? `${command.slice(0, 300)}...` : command;
  process.stderr.write(
    `[guard-destructive] BLOCKED: ${hit.what}.\n\n` +
      `Reached through : ${hit.via.length ? hit.via.join(' > ') : '(direct)'}\n` +
      `Command         : ${shown}\n\n` +
      `permissions.deny matches the command text as written, after splitting\n` +
      `compound commands and removing a few wrappers. This form gets past it,\n` +
      `so this hook stops it instead.\n\n` +
      `What to do:\n` +
      `  1. If this really needs to happen, ask the human to run it in their own\n` +
      `     terminal.\n` +
      `  2. Do not rewrite it into another form (a different shell, a script,\n` +
      `     an interpreter one-liner). That is the pattern this hook exists for.\n`
  );
  process.exit(2);
}

function readStdin() {
  return new Promise((res) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (raw += c));
    process.stdin.on('end', () => res(raw));
    process.stdin.on('error', () => res(''));
  });
}

// Always runs. An earlier version ran only when process.argv[1] matched
// import.meta.url, to allow importing this file. Node resolves symlinks for
// the entry module, so launched through a linked directory (macOS's
// /var -> /private/var, a junction on Windows) the two spellings differed
// and the hook exited 0 without looking at anything. A guard that can be
// switched off by the path it was installed under is not a guard.
try {
  const raw = await readStdin();
  if (!raw.trim()) process.exit(0);
  const payload = JSON.parse(raw);
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  const command = payload.tool_input && typeof payload.tool_input.command === 'string' ? payload.tool_input.command : '';
  const hit = inspect(toolName, command);
  if (hit) deny(hit, command);
  process.exit(0);
} catch (error) {
  process.stderr.write(`[guard-destructive] internal error, allowing: ${error && error.message ? error.message : error}\n`);
  process.exit(0);
}
