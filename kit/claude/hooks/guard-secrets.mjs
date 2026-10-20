#!/usr/bin/env node
/**
 * guard-secrets.mjs — Claude Code PreToolUse hook. Stops a shell command from
 * reading a secret file into the transcript, or from overwriting or deleting one.
 *
 * WHY THIS EXISTS
 * The `deny` list in settings.json can hold `Read(./.env)`, and that is real —
 * but it only binds the Read tool. `cat .env`, `Get-Content .env` and
 * `sed -n 1p .env` arrive through the Bash and PowerShell tools instead, and
 * walk straight past it. There is no pattern that closes this in `permissions`:
 * denying `Get-Content` denies reading every file there is.
 *
 * So it is decided here, the same way guard-sql decides SQL. Unlike the
 * permission layer, this one is our code, which means it can have tests.
 *
 * THE RULE
 * Block when a command both (a) names a secret file and (b) is a shape that
 * reads, writes or destroys a file. Either one alone is fine:
 * `grep -r createClient src/` reads without naming a secret, and
 * `Set-Content notes.txt x` writes without naming one.
 *
 * Writing counts because a secret that is overwritten or deleted is as gone as
 * one that is leaked: what is in a .env is usually the only copy of it, and
 * nothing here can put it back. `rm .env.bak` was the example this file used
 * for something deliberately let through. It no longer is — a backup of a
 * secret is still a secret, and deleting it is not undoable either.
 *
 * SCOPE
 * This stops accidents, not an adversary. Any reader or writer not on the lists
 * below gets through, and so does anything that reaches the file without naming
 * it — a script holding the path, a wildcard. The point is that
 * the common case — a model reaching for `cat .env` because it wants a
 * connection string — hits a wall instead of pasting a service-role key into a
 * transcript that then persists.
 *
 * Exit 0 -> allow.  Exit 2 -> block, reason on stderr.
 * Any internal failure exits 0: a broken guard must not brick the toolchain.
 */

import { skipHeredocBodies } from './lib/shell-lex.mjs';

// ---------------------------------------------------------------------------
// Data: what counts as a secret file.
// ---------------------------------------------------------------------------

/**
 * These are meant to be committed and read. A file called `.env.example` is
 * documentation, and blocking it is the kind of false positive that gets the
 * whole hook switched off.
 */
const PUBLIC_ENV_SUFFIXES = ['example', 'sample', 'template', 'dist'];

/**
 * `secrets/` came straight from the deny list, and on its own it is too wide:
 * `src/lib/secrets/masker.ts` is code that handles secrets, not a secret. Source
 * and prose under a secrets/ directory are not treated as secret.
 *
 * Config extensions are deliberately absent. `secrets/prod.yaml` is exactly the
 * kind of file this is for.
 */
const NON_SECRET_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs',
  '.java', '.php', '.cs', '.sql',
  '.md', '.txt', '.html', '.css', '.scss',
];

const hasNonSecretExtension = (hit) => {
  const dot = hit.lastIndexOf('.');
  return dot > 0 && NON_SECRET_EXTENSIONS.includes(hit.slice(dot).toLowerCase());
};

const SECRET_PATTERNS = [
  {
    label: 'dotenv file',
    // A leading dot is required: `src/lib/env.ts` and `docs/environment.md`
    // must not match. The optional suffix chain covers `.env.local`.
    re: /(?<![\w.\-])(?:[\w.\-/~]*\/)?\.env(?![\w])(?:\.[\w-]+)*/g,
    exempt: (hit) =>
      hit
        .split('/').pop()
        .slice('.env'.length)
        .split('.')
        .filter(Boolean)
        .some((part) => PUBLIC_ENV_SUFFIXES.includes(part.toLowerCase())),
  },
  { label: 'private key', re: /(?<![\w.\-])[\w.\-/~]*\.pem(?![\w])/g },
  { label: 'ssh private key', re: /(?<![\w.\-])[\w.\-/~]*id_(?:rsa|dsa|ecdsa|ed25519)[\w.\-]*/g },
  { label: 'service account key', re: /(?<![\w.\-])[\w.\-/~]*service-account[\w.\-]*\.json(?![\w])/g },
  {
    label: 'secrets directory',
    re: /(?<![\w.\-])[\w.\-/~]*secrets\/[\w.\-/]*/g,
    exempt: hasNonSecretExtension,
  },
  { label: 'ssh directory', re: /(?<![\w.\-])[\w.\-/~]*\.ssh\/[\w.\-]*/g },
];

// ---------------------------------------------------------------------------
// Data: what counts as reading a file. Add to these lists, do not rewrite the
// logic below.
// ---------------------------------------------------------------------------

/** Matched against the first word of a command, case-insensitively. */
const READ_COMMANDS = [
  // POSIX shell
  'cat', 'tac', 'head', 'tail', 'less', 'more', 'nl', 'od', 'xxd', 'strings', 'base64',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk', 'cut', 'sort', 'uniq', 'wc', 'jq',
  'source', '.',
  // PowerShell
  'get-content', 'gc', 'type', 'select-string', 'sls', 'import-csv', 'format-hex', 'fhx',
];

/** Interpreters only read a file when they are handed inline code to run. */
const INTERPRETERS = ['python', 'python3', 'node', 'perl', 'ruby', 'php'];
const INLINE_CODE_FLAG = /(?:^|\s)-{1,2}[cer](?:\s|$)/;

/**
 * `git` prints file contents, and `git show HEAD:.env` is one move, not two.
 * Only these subcommands do it: `checkout`, `add` and `rm` name the same path
 * without revealing anything, so `git` alone is not enough to count as a read.
 */
const GIT_CONTENT_SUBCOMMANDS = ['show', 'diff', 'cat-file', 'blame'];
const GIT_PATCH_FLAG = /(?:^|\s)(?:-p|--patch)(?:\s|$)/;
/** Global options that swallow the next word, which is therefore not the subcommand. */
const GIT_OPTIONS_WITH_VALUE = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'];

/** PowerShell can read a file without naming a cmdlet at all. */
const DOTNET_READ = /\[\s*(?:System\s*\.\s*)?IO\s*\.\s*File\s*\]\s*::\s*Read(?:AllText|AllBytes|AllLines)/i;

/** `node < .env` reads the file without any reader on the list being present. */
const INPUT_REDIRECT = /(?<![<>])<(?![<&])\s*([^\s;|&<>]+)/g;

// ---------------------------------------------------------------------------
// Data: what counts as writing to, or destroying, a file. Same shape as the
// read lists above. Add to these lists, do not rewrite the logic below.
// ---------------------------------------------------------------------------

/** Matched against the first word of a command, case-insensitively. */
const WRITE_COMMANDS = [
  // POSIX shell
  'tee', 'cp', 'mv', 'install', 'ln', 'rm', 'unlink', 'shred', 'truncate', 'dd',
  // PowerShell cmdlets and the aliases people actually type. `sc` and `ac` are
  // Set-Content and Add-Content; `ri`, `del` and `erase` are Remove-Item.
  'set-content', 'sc', 'add-content', 'ac', 'clear-content', 'out-file',
  'new-item', 'ni', 'copy-item', 'cpi', 'copy', 'move-item', 'mi', 'move',
  'rename-item', 'rni', 'ren', 'remove-item', 'ri', 'del', 'erase',
];

/**
 * `echo X=1 > .env` writes with no writer from the list present. A digit or
 * `&` in front means a file descriptor rather than a path, which is why
 * `2>&1` and `>&2` are not read as naming a file.
 */
const OUTPUT_REDIRECT = /(?<![0-9&>])>{1,2}(?![>&])\s*([^\s;|&<>]+)/g;

/** PowerShell can write or delete a file without naming a cmdlet at all. */
const DOTNET_WRITE = /\[\s*(?:System\s*\.\s*)?IO\s*\.\s*File\s*\]\s*::\s*(?:Write(?:AllText|AllBytes|AllLines)|Append(?:AllText|AllLines)|Delete|Copy|Move|Replace)/i;

/**
 * These overwrite or remove the file in the working tree. `git add .env` and
 * `git commit -m "... .env ..."` name the path without changing it, so `git`
 * alone is not enough to count as a write.
 */
const GIT_WRITE_SUBCOMMANDS = ['checkout', 'restore', 'rm', 'mv'];

// ---------------------------------------------------------------------------
// Data: which commands take a heredoc body as data rather than as code.
// ---------------------------------------------------------------------------

/**
 * A heredoc body is text until something runs it. `cat > notes.md <<'EOF'`
 * with `echo X=1 > .env` inside it writes a Markdown file, and the `.env`
 * there is a quotation. Reading every body line as its own command is what
 * stopped this project's own report from being written
 * (data/pitfalls/hook-018.json).
 *
 * So the body is skipped -- but only when it is handed to a command on this
 * list, which consumes it as data and never executes or interprets it.
 * Everything else keeps the old behaviour: `bash <<'EOF'` runs its body,
 * `python - <<'EOF'` runs its body, and a secret named in there is as real as
 * one named on the command line. `sed -f -`, `awk -f -` and `jq -f -` take the
 * body as a program, so those are absent too. An unknown command reads,
 * because reading costs a false positive and skipping costs a miss.
 *
 * The destination is judged as it always was: the body is removed, the command
 * line around it is not, so `cat > .env <<'EOF'` still blocks.
 */
const HEREDOC_DATA_COMMANDS = [
  // POSIX: stdin is a document to copy, count or search, not code.
  'cat', 'tac', 'tee', 'nl', 'head', 'tail', 'wc', 'rev', 'sort', 'uniq',
  'base64', 'fold', 'column', 'cmp', 'diff', 'grep', 'egrep', 'fgrep', 'rg',
  // The body is a message. `git commit -F -` is how a long one gets written.
  'git commit', 'git tag', 'git notes',
  // PowerShell here-strings: the body is piped to something that stores or
  // prints it. `iex`, `powershell` and `node` are deliberately absent.
  'set-content', 'sc', 'add-content', 'ac', 'out-file', 'tee-object',
  'write-output', 'write-host', 'out-null', 'out-string', 'new-item', 'ni',
  'select-string', 'sls',
];

const SHELL_TOOL_RE = /^(Bash|PowerShell)$/;

// ---------------------------------------------------------------------------

function deny(command, hit) {
  let snippet = command.trim();
  if (snippet.length > 400) snippet = snippet.slice(0, 400) + ' ...';

  process.stderr.write(
    `[guard-secrets] BLOCKED: this command reads a secret file.\n\n` +
      `Command:\n  ${snippet}\n\n` +
      `Matched:\n` +
      `  file    : ${hit.path}  (${hit.label})\n` +
      `  read by : ${hit.reader}\n\n` +
      `What to do:\n` +
      `  1. Do not read it another way. The contents would land in this\n` +
      `     transcript and stay there.\n` +
      `  2. If you need one value, ask the human for that one value and have\n` +
      `     them paste it. They can keep the rest of the file to themselves.\n` +
      `  3. If you only need to know which keys exist, ask them to run this\n` +
      `     themselves and paste the key names alone:\n` +
      `       bash        : cut -d= -f1 .env\n` +
      `       powershell  : (Get-Content .env) -replace '=.*'\n` +
      `  4. To set a value, use the tool that owns it rather than the file:\n` +
      `       vercel env add / supabase secrets set / gh secret set\n` +
      `  5. If this file is not a secret, name it as one that is not:\n` +
      `       .env.example  .env.sample  .env.template  .env.dist\n`
  );
  process.exit(2);
}

function denyWrite(command, hit) {
  let snippet = command.trim();
  if (snippet.length > 400) snippet = snippet.slice(0, 400) + ' ...';

  process.stderr.write(
    `[guard-secrets] BLOCKED: this command writes to or deletes a secret file.\n\n` +
      `Command:\n  ${snippet}\n\n` +
      `Matched:\n` +
      `  file       : ${hit.path}  (${hit.label})\n` +
      `  written by : ${hit.writer}\n\n` +
      `What to do:\n` +
      `  1. To change a value, ask the human to edit the file themselves. What\n` +
      `     is in a secret file is usually the only copy of it there is.\n` +
      `  2. To set an environment variable, use the tool that owns it rather\n` +
      `     than the file:\n` +
      `       vercel env add / supabase secrets set / gh secret set\n` +
      `  3. If a new environment needs one, ask them to copy .env.example\n` +
      `     themselves and fill it in.\n` +
      `  4. If this file is not a secret, name it as one that is not:\n` +
      `       .env.example  .env.sample  .env.template  .env.dist\n`
  );
  process.exit(2);
}

/** The first secret path named anywhere in this segment, or null. */
function secretPathIn(text) {
  // Classify Windows paths using the same patterns as slash-separated paths.
  text = text.replaceAll('\\', '/');
  for (const pattern of SECRET_PATTERNS) {
    pattern.re.lastIndex = 0;
    let m;
    while ((m = pattern.re.exec(text)) !== null) {
      if (pattern.exempt && pattern.exempt(m[0])) continue;
      return { path: m[0], label: pattern.label };
    }
  }
  return null;
}

/** `"/usr/bin/cat"` is still `cat`. */
function leafOf(token) {
  const bare = token.replace(/^['"]+|['"]+$/g, '');
  return (bare.split(/[\\/]/).pop() || bare).toLowerCase().replace(/\.exe$/, '');
}

/**
 * The command word of a segment: leading environment assignments and `sudo`
 * are prefixes, not the command.
 */
function commandWord(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (
    i < tokens.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || tokens[i] === 'sudo' || tokens[i] === 'command')
  ) {
    i++;
  }
  if (i >= tokens.length) return '';
  return leafOf(tokens[i]);
}

/**
 * The subcommand of a git call. Walking the tokens rather than searching the
 * whole segment is what keeps `git commit -m "show the .env format"` out of it:
 * the subcommand there is `commit`, and the word `show` is a message.
 */
function gitSubcommand(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let i = tokens.findIndex((t) => leafOf(t) === 'git');
  if (i < 0) return '';

  for (i += 1; i < tokens.length; i++) {
    if (GIT_OPTIONS_WITH_VALUE.includes(tokens[i])) {
      i++;
      continue;
    }
    if (tokens[i].startsWith('-')) continue;
    return tokens[i].toLowerCase();
  }
  return '';
}

/** Why this segment counts as a read, or null if it does not. */
function readerIn(segment) {
  const word = commandWord(segment);

  if (READ_COMMANDS.includes(word)) return word;

  if (word === 'git') {
    const sub = gitSubcommand(segment);
    if (GIT_CONTENT_SUBCOMMANDS.includes(sub)) return `git ${sub}`;
    if (sub === 'log' && GIT_PATCH_FLAG.test(segment)) return 'git log -p';
  }
  if (INTERPRETERS.includes(word) && INLINE_CODE_FLAG.test(segment)) {
    return `${word} with inline code`;
  }
  if (DOTNET_READ.test(segment)) return '[IO.File]::Read...';

  INPUT_REDIRECT.lastIndex = 0;
  let m;
  while ((m = INPUT_REDIRECT.exec(segment)) !== null) {
    if (secretPathIn(m[1])) return 'input redirection';
  }

  return null;
}

/** Why this segment counts as a write, or null if it does not. */
function writerIn(segment) {
  const word = commandWord(segment);

  if (WRITE_COMMANDS.includes(word)) return word;

  if (word === 'git') {
    const sub = gitSubcommand(segment);
    if (GIT_WRITE_SUBCOMMANDS.includes(sub)) return `git ${sub}`;
  }
  if (DOTNET_WRITE.test(segment)) return '[IO.File]::Write/Delete/...';

  OUTPUT_REDIRECT.lastIndex = 0;
  let m;
  while ((m = OUTPUT_REDIRECT.exec(segment)) !== null) {
    if (secretPathIn(m[1])) return 'output redirection';
  }

  return null;
}

/**
 * One command line can be several commands. Splitting on the separators keeps
 * `cat .env | head` and `KEY=$(cat .env)` from hiding behind a harmless first
 * word. Parentheses are deliberately NOT separators: splitting on them tears
 * `python -c "print(open('.env').read())"` apart and the path stops being
 * visible from the interpreter that reads it.
 */
const SEGMENT_SEPARATOR = /\$\(|[;|&\n\r]/;

function segmentsOf(command) {
  return command.split(SEGMENT_SEPARATOR);
}

/** The segment of `line` that spans index `at`. */
function segmentAt(line, at) {
  const before = line.slice(0, at).split(SEGMENT_SEPARATOR).pop();
  const after = line.slice(at).split(SEGMENT_SEPARATOR)[0];
  return before + after;
}

/** The command a body is handed to. `git commit` is one name, not two. */
function heredocReceiver(segment) {
  const word = commandWord(segment);
  if (word === 'git') return `git ${gitSubcommand(segment)}`.trim();
  return word;
}

const consumesAsData = (segment) =>
  HEREDOC_DATA_COMMANDS.includes(heredocReceiver(segment));

/**
 * Heredoc openers on one line, in order. Quoted text is skipped: `grep "a << b"`
 * opens nothing, and reading it as an opener would swallow the rest of the
 * command -- including any real command on the next line.
 */
function heredocOpenersIn(line) {
  const out = [];
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"') {
      const end = line.indexOf(c, i + 1);
      if (end < 0) break;
      i = end;
      continue;
    }
    if (c !== '<') continue;
    let j = i;
    while (line[j] === '<') j++;
    // `<<<` is a here-string, which holds no body to skip.
    if (j - i !== 2) { i = j - 1; continue; }
    const strip = line[j] === '-';
    if (strip) j++;
    while (line[j] === ' ' || line[j] === '\t') j++;
    const m = /^(?:'([^']*)'|"([^"]*)"|([^\s;&|<>()]+))/.exec(line.slice(j));
    if (!m) continue;
    out.push({
      heredoc: { delim: m[1] ?? m[2] ?? m[3].replace(/['"\\]/g, ''), strip },
      at: i,
    });
    i = j + m[0].length - 1;
  }
  return out;
}

/**
 * Whether the skipped text really ended on the delimiter line. An unterminated
 * heredoc means the line was misread, and dropping the rest of the command
 * would hide whatever came after it.
 */
function closedBy(body, heredoc) {
  const lines = body.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let last = (lines.pop() ?? '').replace(/\r$/, '');
  if (heredoc.strip) last = last.replace(/^\t+/, '');
  return last === heredoc.delim;
}

/**
 * The command with the heredoc bodies that are only data removed.
 * `skipHeredocBodies()` from the shared lexer decides where a body ends, so
 * the delimiter rules -- `<<-` and tabs, CRLF -- are stated in one place.
 */
function withoutDataHeredocs(command) {
  if (!command.includes('<<')) return command;

  let out = '';
  let i = 0;
  while (i < command.length) {
    const nl = command.indexOf('\n', i);
    if (nl < 0) {
      out += command.slice(i);
      break;
    }
    const line = command.slice(i, nl);
    out += command.slice(i, nl + 1);
    i = nl + 1;

    const openers = heredocOpenersIn(line);
    if (!openers.length) continue;

    const end = skipHeredocBodies(command, i, openers.map((o) => o.heredoc));
    const body = command.slice(i, end);
    const data =
      closedBy(body, openers[openers.length - 1].heredoc) &&
      openers.every((o) => consumesAsData(segmentAt(line, o.at)));
    if (!data) out += body;
    i = end;
  }
  return out;
}

/** `@'` or `@"` with nothing after it on the line opens a here-string. */
const PS_HERESTRING_OPENER = /@(['"])[ \t]*\r?(?=\n)/g;

/**
 * The same rule for PowerShell here-strings. `@' ... '@ | Set-Content notes.md`
 * writes a file and the body is its contents; `@' ... '@ | iex` runs the body,
 * so that one is still read. The text after `'@` is left in place, which is
 * what keeps the destination judged as it always was.
 */
function withoutDataHereStrings(command) {
  let out = '';
  let i = 0;
  while (i < command.length) {
    PS_HERESTRING_OPENER.lastIndex = i;
    const open = PS_HERESTRING_OPENER.exec(command);
    if (!open) {
      out += command.slice(i);
      break;
    }

    const nl = command.indexOf('\n', open.index);
    const close = open[1] === "'" ? /\r?\n[ \t]*'@/g : /\r?\n[ \t]*"@/g;
    close.lastIndex = nl;
    const end = close.exec(command);
    if (!end) {
      out += command.slice(i);
      break;
    }

    out += command.slice(i, nl + 1);
    const after = command.slice(end.index + end[0].length);
    const lineStart = command.lastIndexOf('\n', Math.max(open.index - 1, 0)) + 1;
    const statement =
      command.slice(lineStart, open.index) + after.split(/[\r\n]/)[0];
    const data = segmentsOf(statement)
      .map(heredocReceiver)
      .filter(Boolean)
      .every((word) => HEREDOC_DATA_COMMANDS.includes(word));

    if (!data) out += command.slice(nl + 1, end.index + end[0].length);
    i = end.index + end[0].length;
  }
  return out;
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (raw += c));
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(''));
  });
}

// ---------------------------------------------------------------------------

try {
  const raw = await readStdin();
  if (!raw.trim()) process.exit(0);

  const payload = JSON.parse(raw);
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  if (!SHELL_TOOL_RE.test(toolName)) process.exit(0);

  const toolInput = payload.tool_input;
  const command =
    toolInput && typeof toolInput.command === 'string' ? toolInput.command : '';
  if (!command.trim()) process.exit(0);

  // A heredoc body that is only data is removed first, so its lines are
  // not read as commands of their own.
  const code =
    toolName === 'PowerShell'
      ? withoutDataHereStrings(command)
      : withoutDataHeredocs(command);

  for (const segment of segmentsOf(code)) {
    if (!segment.trim()) continue;

    const path = secretPathIn(segment);
    if (!path) continue;

    // Reading is decided first, so a shape that both reads and writes --
    // `sed -i` on a secret -- keeps the message it has always had.
    const reader = readerIn(segment);
    if (reader) deny(command, { ...path, reader });

    const writer = writerIn(segment);
    if (writer) denyWrite(command, { ...path, writer });
  }

  process.exit(0);
} catch (err) {
  // Fail open, loudly. A guard that crashes must not become a guard that blocks
  // everything -- that trains people to disable it.
  process.stderr.write(`[guard-secrets] hook error (allowing call): ${err.message}\n`);
  process.exit(0);
}
