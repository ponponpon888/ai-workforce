#!/usr/bin/env node
/**
 * guard-sql.mjs — Claude Code PreToolUse hook. Blocks destructive SQL before it
 * reaches a database.
 *
 * This is the cross-platform version. It runs anywhere Claude Code runs, because
 * Claude Code ships on Node — so there is nothing extra to install, no jq, no
 * python. The PowerShell twin (guard-sql.ps1) behaves identically and exists for
 * Windows setups that prefer it.
 *
 * Blocked outright:
 *   DROP, TRUNCATE, DELETE without WHERE, UPDATE ... SET without WHERE
 *
 * Blocked until a human approves the exact statement (see approve-ddl.mjs):
 *   CREATE / ALTER / GRANT / REVOKE / REINDEX / VACUUM
 *
 * SQL does not have to appear on the command line. `psql -f x.sql`, `psql < x.sql`,
 * `cat x.sql | psql` and `\i x.sql` all hand a database client a file, and a guard
 * that only reads the command line sees none of it -- so writing the file first and
 * running it second walked straight through. The hook runs before the tool does, but
 * the file was written by an earlier call and is already on disk, so it can be read
 * and scanned as SQL. Every candidate must be readable. Nested includes and file DDL
 * are unsupported and blocked: command-only approvals cannot bind file contents.
 *
 * SCOPE
 * This stops accidents, not an adversary. Any agent holding a shell could write
 * an approval file itself. The point is that a model doing the wrong thing by
 * mistake — the common case — hits a wall it cannot walk through by accident.
 *
 * Exit 0 -> allow.  Exit 2 -> block, reason on stderr.
 * Internal failures block with exit 2; inspect the error before retrying.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, rmSync, renameSync, lstatSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where to tell the human to run the approval script. Installed, the hook sits in
 * <claude home>/hooks and approve-ddl in <claude home>/scripts, so an absolute path
 * can be given -- the repo-relative one only works from a checkout of this repo,
 * which is not where anyone hits this message.
 */
const hookDir = dirname(fileURLToPath(import.meta.url));
const installedApprove = resolve(hookDir, '..', 'scripts', 'approve-ddl.mjs');
const APPROVE_COMMAND = existsSync(installedApprove)
  ? `node "${installedApprove}"`
  : 'node kit/scripts/approve-ddl.mjs';

const APPROVAL_TTL_MINUTES = 15;
const APPROVAL_DIR =
  process.env.AIWF_APPROVAL_DIR || join(homedir(), '.claude', 'approvals');

/** Tools whose input we inspect. Anything else is none of our business. */
const SQL_TOOL_RE = /^(Bash|PowerShell|mcp__[Ss]upabase__|mcp__postgres|mcp__neon|mcp__planetscale)/;

/** Tools that hand us a shell command line rather than a SQL statement. */
const SHELL_TOOL_RE = /^(Bash|PowerShell)$/;

/** A shell call only counts as SQL if it actually invokes a database client. */
const SQL_CLIENT_RE = /\b(psql|sqlite3|mysql|mariadb|supabase\s+db|prisma\s+db|drizzle-kit)\b/i;

/**
 * Markers that hand a database client a file instead of a statement. Each one is
 * scanned only inside a command segment that invokes a client, so `rm -f /tmp/junk`
 * sitting after `&&` is not mistaken for `psql -f`.
 *
 * `<(?!<)` matters: `psql <<'EOF'` is a here-document, not a redirect, and reading
 * `<'EOF'` as a path would demand approval for every harmless here-document.
 */
const FILE_ROUTE_RES = [
  /(?:^|\s)(?:-f|--file)[=\s]+(\S+)/g, // psql -f x.sql / --file=x.sql
  /(?:^|\s)<(?!<)\s*(\S+)/g, //            psql < x.sql
  /\\i r?\s*(\S+)/g, //                     placeholder, replaced below
  /\bcat\s+(\S+)/g, //                     cat x.sql | psql
  /(?:^|[\s"'`=])([^\s"'`;|<>]+\.sql)\b/g, // any .sql path, however it got there
];
// \i and \ir are psql's include commands, usually inside a -c string.
FILE_ROUTE_RES[2] = /\\ir?\s+(\S+)/g;

/** Command separators. A pipeline stays whole: `cat x.sql | psql` is one segment. */
const SEGMENT_RE = /&&|\|\||;|\r?\n/;

/** Files larger than this are not scanned; unread files are blocked. */
const MAX_SQL_FILE_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------

function deny(reason, statement) {
  let snippet = statement.trim();
  if (snippet.length > 400) snippet = snippet.slice(0, 400) + ' ...';

  process.stderr.write(
    `[guard-sql] BLOCKED: ${reason}\n\n` +
      `Statement:\n  ${snippet}\n\n` +
      `What to do:\n` +
      `  1. Show this statement to the human and explain what it changes.\n` +
      `  2. If it is DDL and they agree, ask them to run:\n` +
      `       ${APPROVE_COMMAND} '<the exact statement>'\n` +
      `     then retry the call unchanged.\n` +
      `  3. If it is a DELETE or UPDATE, add a WHERE clause.\n` +
      `  4. DROP and TRUNCATE are never approved by this hook. Do them by hand.\n`
  );
  process.exit(2);
}

/**
 * Replace string literals and comments with harmless placeholders, so keywords
 * inside them cannot trigger a false positive and semicolons inside them cannot
 * split a statement.
 *
 * One regex, scanned left to right: at each position the first alternative that
 * matches wins. That is what makes `'--'` read as a string and not a comment.
 *
 * This is SQL grammar, so it may only be applied to something that is SQL. On a
 * shell command line `--` opens an option, not a comment: applying it to
 * `npx supabase db execute --sql 'truncate bookings'` leaves
 * `npx supabase db execute` and the TRUNCATE is no longer in view. The quoting
 * is the shell's too, and the statement we need to read sits inside it. So a
 * command line is scanned exactly as it arrived.
 */
function neutralize(sql, grammar) {
  if (grammar === 'shell') return sql;

  const pattern = new RegExp(
    [
      "'(?:[^']|'')*'", // single-quoted literal, '' escape
      '\\$([A-Za-z0-9_]*)\\$[\\s\\S]*?\\$\\1\\$', // postgres dollar-quoted body
      '--[^\\r\\n]*', // line comment
      '/\\*[\\s\\S]*?\\*/', // block comment
    ].join('|'),
    'g'
  );

  return sql.replace(pattern, (m) =>
    m.startsWith("'") || m.startsWith('$') ? "''" : ' '
  );
}

function fingerprint(sql) {
  return createHash('sha256').update('aiwf-exact-v2\0' + sql, 'utf8').digest('hex');
}

/**
 * Take the one lock that lets a caller claim this approval, or report that someone
 * else holds it.
 *
 * The rename below is not enough on its own. On POSIX rename() is atomic against a
 * concurrent rename of the same source, so exactly one caller wins and the rest see
 * ENOENT. Windows renames through an open handle instead: the second caller opens
 * the file, the first renames it, and the second then renames *that same file* to
 * its own claim name. Both succeed, both read back the approved SQL, and both
 * return true -- six concurrent calls let two through in roughly 10% of rounds
 * here. An exclusive create has the same meaning on both platforms.
 *
 * A holder that dies leaves the lock behind, and until it expires this fingerprint
 * is refused. That is the safe direction, and it clears itself: a lock older than
 * the approval's own TTL is already past the point where the approval it guards
 * could be used, so the next caller takes it over.
 */
function acquireClaimLock(lock) {
  try { return openSync(lock, 'wx'); } catch { /* held, or left behind */ }
  try {
    if (Date.now() - statSync(lock).mtimeMs <= APPROVAL_TTL_MINUTES * 60000) return null;
    rmSync(lock, { force: true });
  } catch { return null; }
  // Lost the race to take over the expired lock: the winner is claiming it.
  try { return openSync(lock, 'wx'); } catch { return null; }
}

// One caller claims the token. Never restore a claimed token.
function isApproved(sql) {
  const file = join(APPROVAL_DIR, `${fingerprint(sql)}.approval`);
  const claimed = `${file}.used-${randomUUID()}`;
  const lock = `${file}.lock`;
  const fd = acquireClaimLock(lock);
  if (fd === null) return false;
  try {
    try { renameSync(file, claimed); } catch { return false; }
    try {
      const stat = lstatSync(claimed);
      const age = Date.now() - stat.mtimeMs;
      return stat.isFile() && age >= 0 && age <= APPROVAL_TTL_MINUTES * 60000 &&
        readFileSync(claimed, 'utf8') === sql;
    } catch { return false; }
    finally { try { rmSync(claimed, { force: true }); } catch { /* already consumed */ } }
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
    try { rmSync(lock, { force: true }); } catch { /* already gone */ }
  }
}

/**
 * Pull the statement out of whichever tool is being called, and report which
 * field it came from. The field name is half of how the grammar is decided.
 */
function extractSql(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return { value: '', key: '' };
  for (const key of ['query', 'sql', 'statement', 'command']) {
    const value = toolInput[key];
    if (typeof value === 'string' && value.trim()) return { value, key };
  }
  return { value: '', key: '' };
}

/** Strip one layer of shell quoting from a token pulled out of a command line. */
const unquote = (token) => token.replace(/^["'`]+/, '').replace(/["'`]+$/, '');

/**
 * Paths a command line hands to a database client. Only segments that invoke a
 * client are scanned, so an unrelated `-f` elsewhere on the line is left alone.
 */
function fileRouteCandidates(command) {
  const found = new Set();
  for (const segment of command.split(SEGMENT_RE)) {
    if (!SQL_CLIENT_RE.test(segment)) continue;
    for (const re of FILE_ROUTE_RES) {
      re.lastIndex = 0;
      for (const m of segment.matchAll(re)) {
        const path = unquote(m[1]);
        if (path) found.add(path);
      }
    }
  }
  return [...found];
}

/** Read a candidate path, or null when there is nothing readable there. */
function readSqlFile(path, cwd) {
  try {
    const absolute = isAbsolute(path) ? path : resolve(cwd || process.cwd(), path);
    if (!existsSync(absolute)) return null;
    const stat = statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_SQL_FILE_BYTES) return null;
    return readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Run the destructive-statement rules over one blob. Hard hits deny immediately;
 * the first DDL statement is handed back so the approval is checked once for the
 * whole call. `where` names the source in the block message.
 */
// Each modifying verb must have a WHERE at its own parenthesis depth.
// This is a scoped lexical check, not a complete SQL parser.
function hasUnfilteredMutation(stmt) {
  const tokens = stmt.toUpperCase().match(/[A-Z_][A-Z_0-9]*|[()]/g) || [];
  let depth = 0;
  const scoped = tokens.map(word => {
    if (word === ')') depth--;
    const token = { word, depth };
    if (word === '(') depth++;
    return token;
  });
  for (let i = 0; i < scoped.length; i++) {
    const start = scoped[i];
    if (!['UPDATE', 'DELETE'].includes(start.word)) continue;
    let modifies = false, where = false;
    for (let j = i + 1; j < scoped.length; j++) {
      const t = scoped[j];
      if (t.depth < start.depth) break;
      if (t.depth !== start.depth) continue;
      if (t.word === (start.word === 'UPDATE' ? 'SET' : 'FROM')) modifies = true;
      if (modifies && t.word === 'WHERE') where = true;
    }
    if (modifies && !where) return true;
  }
  return false;
}

function scanStatements(text, grammar, where) {
  let firstDdl = null;
  const cleaned = neutralize(text, grammar);
  if (grammar === 'sql' && /(?:^|[\r\n])\s*\\(?:i|ir)\b/.test(cleaned)) {
    deny('Nested SQL includes are unsupported; submit the reviewed SQL directly.' + where, 'SQL include');
  }
  for (const stmt of cleaned.split(';')) {
    if (!stmt.trim()) continue;
    if (/\bDROP\b/is.test(stmt)) deny(`DROP is never allowed from an agent.${where}`, stmt);
    if (/\bTRUNCATE\b/is.test(stmt)) deny(`TRUNCATE is never allowed from an agent.${where}`, stmt);
    if ((grammar === 'sql' && /^\s*DO\b/i.test(stmt)) || (grammar === 'shell' && /\bDO\s+(?:LANGUAGE\b|['"$])/i.test(stmt))) deny('Procedural DO blocks are unsupported.' + where, stmt);
    if (hasUnfilteredMutation(stmt)) deny('UPDATE/DELETE needs a WHERE in the same SQL scope.' + where, stmt);
    if (firstDdl === null && /\b(CREATE|ALTER|GRANT|REVOKE|REINDEX|VACUUM)\b/is.test(stmt)) firstDdl = stmt;
  }
  return firstDdl;
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
  const { value: sql, key: sqlField } = extractSql(payload.tool_input);

  if (!sql.trim()) process.exit(0);
  if (!SQL_TOOL_RE.test(toolName)) process.exit(0);

  // Tool name and field name together decide which grammar the same string is
  // read under: a shell tool handing us its `command` is a command line,
  // anything else is a SQL statement.
  const grammar =
    SHELL_TOOL_RE.test(toolName) && sqlField === 'command' ? 'shell' : 'sql';

  if (grammar === 'shell' && !SQL_CLIENT_RE.test(sql)) process.exit(0);

  let firstDdl = scanStatements(sql, grammar, '');

  // The statement need not be on the command line. Read what the client is being
  // pointed at and scan that too; a file route with nothing readable behind it
  // is blocked rather than being waved through.
  if (grammar === 'shell') {
    const candidates = fileRouteCandidates(sql);
    if (candidates.length > 0) {
      for (const path of candidates) {
        const content = readSqlFile(path, payload.cwd);
        if (content === null) deny('SQL file is unreadable; cannot verify its contents.', 'Unreadable SQL file');
        const ddl = scanStatements(content, 'sql', ` (from ${path})`);
        if (ddl !== null) deny('File-based DDL approval is unsupported; submit and approve the SQL text directly.', 'DDL in SQL file');
      }
    }
  }

  // The approval covers the whole call, so check it ONCE, after the loop.
  // Checking inside the loop consumed the single-use token on the first DDL
  // statement, so an approved migration containing two of them always failed
  // on the second. Migrations routinely contain several statements.
  if (firstDdl !== null && !isApproved(sql)) {
    deny('DDL requires a human approval token that is missing or expired.', firstDdl);
  }

  process.exit(0);
} catch (err) {
  // A failed inspection is not a successful safety check.
  process.stderr.write(`[guard-sql] hook error (blocked): unable to inspect input\n`);
  process.exit(2);
}
