#!/usr/bin/env node
/**
 * guard-secrets.mjs — Claude Code PreToolUse hook. Stops a shell command from
 * reading a secret file into the transcript.
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
 * reads a file. Either one alone is fine: `rm .env.bak` names one without
 * reading it, `grep -r createClient src/` reads without naming one.
 *
 * SCOPE
 * This stops accidents, not an adversary. `cp .env /tmp/x` then reading /tmp/x
 * gets through, and so does any reader not on the list below. The point is that
 * the common case — a model reaching for `cat .env` because it wants a
 * connection string — hits a wall instead of pasting a service-role key into a
 * transcript that then persists.
 *
 * Exit 0 -> allow.  Exit 2 -> block, reason on stderr.
 * Any internal failure exits 0: a broken guard must not brick the toolchain.
 */

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

/**
 * One command line can be several commands. Splitting on the separators keeps
 * `cat .env | head` and `KEY=$(cat .env)` from hiding behind a harmless first
 * word. Parentheses are deliberately NOT separators: splitting on them tears
 * `python -c "print(open('.env').read())"` apart and the path stops being
 * visible from the interpreter that reads it.
 */
function segmentsOf(command) {
  return command.split(/\$\(|[;|&\n\r]/);
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

  for (const segment of segmentsOf(command)) {
    if (!segment.trim()) continue;

    const path = secretPathIn(segment);
    if (!path) continue;

    const reader = readerIn(segment);
    if (reader) deny(command, { ...path, reader });
  }

  process.exit(0);
} catch (err) {
  // Fail open, loudly. A guard that crashes must not become a guard that blocks
  // everything -- that trains people to disable it.
  process.stderr.write(`[guard-secrets] hook error (allowing call): ${err.message}\n`);
  process.exit(0);
}
