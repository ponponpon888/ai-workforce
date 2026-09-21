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
 *   CREATE / ALTER / GRANT / REVOKE / REINDEX / VACUUM, plus the statements that
 *   only exist in one dialect: MySQL's RENAME TABLE / REPLACE / LOAD DATA /
 *   FLUSH / RESET / PURGE ... LOGS / OPTIMIZE / REPAIR / SET PASSWORD, and
 *   SQLite's ATTACH / DETACH / dangerous PRAGMA / INSERT OR REPLACE.
 *
 * DIALECT
 * The same string does not mean the same thing to every client. `-f` is
 * --file to psql and --force to mysql, and `#` opens a comment in MySQL while
 * it is an operator in Postgres. So the client being invoked decides which file
 * routes are read as files and which grammar the statement is read under. When
 * the client is ambiguous (an ORM CLI that could be pointed at either), every
 * rule applies and nothing is neutralized -- the conservative side of both.
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
import { existsSync, readFileSync, statSync, renameSync, lstatSync, openSync, closeSync, writeFileSync, fsyncSync, unlinkSync } from 'node:fs';
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

/**
 * Tools whose input we inspect. Anything else is none of our business.
 *
 * This is defence in depth against the settings.json matcher: a matcher is one
 * edit away from being widened, so the hook re-checks the tool name itself.
 * The MCP alternatives are NOT anchored to a fixed prefix (unlike Bash/PowerShell,
 * which are exact tool names) -- a connector can prepend its own name ahead of
 * the product name, e.g. `mcp__claude_ai_Supabase__list_projects`, and a
 * `mcp__[Ss]upabase__` prefix match misses it entirely. Match "supabase" (etc)
 * anywhere in the tool name instead. See data/pitfalls/hook-004.json.
 */
const SQL_TOOL_RE = /^(Bash|PowerShell)$|mcp__.*[Ss]upabase|mcp__.*[Pp]ostgres|mcp__.*[Nn]eon|mcp__.*[Pp]lanetscale|mcp__.*[Mm]ysql|mcp__.*[Mm]ariadb|mcp__.*[Ss]qlite/;

/** Tools that hand us a shell command line rather than a SQL statement. */
const SHELL_TOOL_RE = /^(Bash|PowerShell)$/;

/** A shell call only counts as SQL if it actually invokes a database client. */
const SQL_CLIENT_RE = /\b(psql|sqlite3|mysql|mariadb|supabase\s+db|prisma\s+db|drizzle-kit)\b/i;

/**
 * Which dialect a command segment speaks. Only clients that pin the dialect are
 * listed: `prisma db` and `drizzle-kit` are deliberately absent, because the
 * same command can be pointed at Postgres or MySQL and guessing one would switch
 * off the other one's rules. Two different clients in one segment is 'unknown'
 * for the same reason.
 */
const CLIENT_DIALECT_RES = [
  [/\bsqlite3\b/i, 'sqlite'],
  [/\b(mysql|mariadb)\b/i, 'mysql'],
  [/\b(psql|supabase\s+db)\b/i, 'postgres'],
];

/** The MCP side of the same question: the server name is all we get. */
const MCP_DIALECT_RES = [
  [/mcp__.*([Pp]lanetscale|[Mm]ysql|[Mm]ariadb)/, 'mysql'],
  [/mcp__.*[Ss]qlite/, 'sqlite'],
  [/mcp__.*([Ss]upabase|[Pp]ostgres|[Nn]eon)/, 'postgres'],
];

function dialectOf(text, table) {
  const hits = new Set();
  for (const [re, name] of table) if (re.test(text)) hits.add(name);
  return hits.size === 1 ? [...hits][0] : 'unknown';
}

/**
 * Markers that hand a database client a file instead of a statement. Each one is
 * scanned only inside a command segment that invokes a client, so `rm -f /tmp/junk`
 * sitting after `&&` is not mistaken for `psql -f`.
 *
 * `<(?!<)` matters: `psql <<'EOF'` is a here-document, not a redirect, and reading
 * `<'EOF'` as a path would demand approval for every harmless here-document.
 */
const COMMON_FILE_ROUTE_RES = [
  /(?:^|\s)<(?!<)\s*(\S+)/g, //            psql < x.sql
  /\bcat\s+(\S+)/g, //                     cat x.sql | psql
  /(?:^|[\s"'`=])([^\s"'`;|<>]+\.sql)\b/g, // any .sql path, however it got there
];

/**
 * Routes that belong to one client only.
 *
 * `-f` is the one that matters: to psql it is --file, to mysql it is --force.
 * Reading `mysql -f app -e "select 1"` as psql does made the hook demand a file
 * called `app`, fail to read it, and block a harmless SELECT. A guard that
 * fires on correct SQL gets switched off, so the option is read per client now
 * (data/pitfalls/hook-012.json).
 *
 * The MySQL `source` route requires the argument to look like a path -- a
 * slash, or an extension. `select source from t` must not be read as an
 * include of a file named `from`.
 */
const DIALECT_FILE_ROUTE_RES = {
  postgres: [
    /(?:^|\s)(?:-f|--file)[=\s]+(\S+)/g, // psql -f x.sql / --file=x.sql
    /\\ir?\s+(\S+)/g, //                    \i and \ir, psql's includes
  ],
  mysql: [
    /(?:^|[\s"'`;])source\s+([^\s;"'`]*(?:[\\/][^\s;"'`]*|\.[A-Za-z0-9]+))/gi,
  ],
  sqlite: [
    /(?:^|\s)(?:-init|--init)[=\s]+(\S+)/g, // sqlite3 -init x.sql
    /\.read\s+(\S+)/gi, //                    sqlite3's include
  ],
};

/** An ambiguous client gets every route: coverage over a tidy answer. */
function fileRouteResFor(dialect) {
  const own =
    dialect === 'unknown'
      ? Object.values(DIALECT_FILE_ROUTE_RES).flat()
      : DIALECT_FILE_ROUTE_RES[dialect] || [];
  return [...COMMON_FILE_ROUTE_RES, ...own];
}

/**
 * Statements that are not DDL by name but are just as unrecoverable, and exist
 * in only one dialect. They go through the same human approval as DDL rather
 * than being blocked outright, because each one has a legitimate use.
 *
 * REPLACE is matched only when an identifier follows it, never a `(`, so the
 * string function `replace(col,'a','b')` is left alone.
 */
const DIALECT_APPROVAL_RES = {
  mysql: [
    /\bRENAME\s+TABLE\b/i,
    /\bREPLACE\s+(?:LOW_PRIORITY\s+|DELAYED\s+)?(?:INTO\s+)?['"`\w]/i,
    /\bLOAD\s+DATA\b/i,
    /\bFLUSH\s+(?:NO_WRITE_TO_BINLOG\s+|LOCAL\s+)?[A-Z_]/i,
    /\bRESET\s+(MASTER|REPLICA|SLAVE|BINARY\s+LOGS|QUERY\s+CACHE)\b/i,
    /\bPURGE\s+(BINARY|MASTER)\s+LOGS\b/i,
    /\b(OPTIMIZE|REPAIR)\s+(?:NO_WRITE_TO_BINLOG\s+|LOCAL\s+)?TABLE\b/i,
    /\bSET\s+PASSWORD\b/i,
  ],
  sqlite: [
    /\b(ATTACH|DETACH)\s+(?:DATABASE\s+)?['"`\w]/i,
    // Only the pragmas whose value changes what the database enforces or how it
    // is written, and only when one is being set. `PRAGMA table_info(t)` and a
    // bare `PRAGMA journal_mode;` read state and stay allowed.
    /\bPRAGMA\s+(?:\w+\.)?(writable_schema|foreign_keys|ignore_check_constraints|defer_foreign_keys|legacy_alter_table|journal_mode|synchronous|trusted_schema)\s*[=(]/i,
    /\bINSERT\s+OR\s+REPLACE\b/i,
    /\bREPLACE\s+INTO\b/i,
    /(?:^|[\s"'`;])\.(restore|import)\b/i,
  ],
};

function needsApproval(stmt, dialect) {
  if (/\b(CREATE|ALTER|GRANT|REVOKE|REINDEX|VACUUM)\b/is.test(stmt)) return true;
  const own =
    dialect === 'unknown'
      ? Object.values(DIALECT_APPROVAL_RES).flat()
      : DIALECT_APPROVAL_RES[dialect] || [];
  return own.some((re) => re.test(stmt));
}

/**
 * Includes, per dialect. psql has \i, MySQL has source, SQLite has .read. All
 * three are refused inside a SQL file for the same reason: a command-only
 * approval cannot bind the contents of a file it never saw.
 */
const INCLUDE_RES = {
  postgres: /(?:^|[\r\n])\s*\\(?:i|ir)\b/,
  mysql: /(?:^|[\r\n])\s*source\s+[^\s;"'`]*(?:[\\/]|\.[A-Za-z0-9]+)/i,
  sqlite: /(?:^|[\r\n])\s*\.read\b/i,
};

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
function neutralize(sql, grammar, dialect) {
  if (grammar === 'shell') return sql;

  const alternatives = [
    "'(?:[^']|'')*'", // single-quoted literal, '' escape
    '\\$([A-Za-z0-9_]*)\\$[\\s\\S]*?\\$\\1\\$', // postgres dollar-quoted body
    '--[^\\r\\n]*', // line comment
    '/\\*[\\s\\S]*?\\*/', // block comment
  ];

  // MySQL only, and only when we know it is MySQL: `#` opens a comment there,
  // but it is an operator in Postgres. Hiding text that is not a comment would
  // hide a WHERE and turn an unfiltered DELETE into an allowed one, so this is
  // never applied to a dialect we are unsure about. The other direction was the
  // live hole: `delete from t # where id = 1` deletes the table on MySQL, and
  // the WHERE inside the comment made the guard read it as filtered.
  if (dialect === 'mysql') {
    alternatives.push('#[^\\r\\n]*'); // mysql line comment
    alternatives.push('`(?:[^`]|``)*`'); // mysql quoted identifier
  }

  const pattern = new RegExp(alternatives.join('|'), 'g');

  return sql.replace(pattern, (m) =>
    m.startsWith("'") || m.startsWith('$') || m.startsWith('`') ? "''" : ' '
  );
}

function fingerprint(sql) {
  return createHash('sha256').update('aiwf-exact-v2\0' + sql, 'utf8').digest('hex');
}

// The common, exclusive entry serializes ALL consumers, including Node and
// PowerShell. Rename alone is not an exclusive claim on Windows. Never steal a
// lock based on its age/PID and never restore a claimed token after a failure.
function blockApprovalState(digest) {
  process.stderr.write(
    `[guard-sql] BLOCKED: approval-state-unavailable\n` +
    `Fingerprint: ${digest}\n` +
    `A consumer may be active, or approval IO needs recovery. No retry was authorized.\n` +
    `Do not delete the lock or reissue this approval while callers may be running.\n` +
    `Stop all callers, reconcile the external result, then follow docs/18-approval-lock-recovery.md.\n`
  );
  process.exit(2);
}

function isApproved(sql) {
  const digest = fingerprint(sql);
  const file = join(APPROVAL_DIR, `${digest}.approval`);
  const lock = `${file}.lock`;
  const claimed = `${file}.used-${randomUUID()}`;
  let lockFd;
  try {
    lockFd = openSync(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'ENOENT') return false; // approval directory not installed
    blockApprovalState(digest);
  }

  let approved = false, cleanupComplete = false, released = false;
  try {
    // Metadata is diagnostic, NOT authority to expire/unlock. Even an empty or
    // malformed lock left by process death must block. Do not include SQL here.
    writeFileSync(lockFd, JSON.stringify({
      schema: 'aiwf-approval-lock-v1', pid: process.pid,
      createdAt: new Date().toISOString(), claim: claimed.slice(file.length),
    }) + '\n', 'utf8');
    fsyncSync(lockFd);
    let moved = false;
    try {
      renameSync(file, claimed);
      moved = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      cleanupComplete = true; // another completed consumer already used it
    }
    if (moved) {
      const stat = lstatSync(claimed);
      const age = Date.now() - stat.mtimeMs;
      approved = stat.isFile() && age >= 0 && age <= APPROVAL_TTL_MINUTES * 60000 &&
        readFileSync(claimed, 'utf8') === sql;
      // No ALLOW until consumption is complete. IO/cleanup failures retain the
      // lock and any claim evidence, rather than reopening the approval.
      unlinkSync(claimed);
      cleanupComplete = true;
    }
  } catch {
    approved = false;
  } finally {
    try { closeSync(lockFd); } catch { cleanupComplete = false; }
    if (cleanupComplete) {
      try { unlinkSync(lock); released = true; } catch { /* retain recovery state */ }
    }
  }
  if (!released) blockApprovalState(digest);
  return approved;
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
  const found = new Map();
  for (const segment of command.split(SEGMENT_RE)) {
    if (!SQL_CLIENT_RE.test(segment)) continue;
    const dialect = dialectOf(segment, CLIENT_DIALECT_RES);
    for (const re of fileRouteResFor(dialect)) {
      re.lastIndex = 0;
      for (const m of segment.matchAll(re)) {
        const path = unquote(m[1]);
        // The file is read under the dialect of the client it is handed to. A
        // path named twice by two clients keeps the first; the contents are
        // scanned either way and only the grammar would differ.
        if (path && !found.has(path)) found.set(path, dialect);
      }
    }
  }
  return [...found].map(([path, dialect]) => ({ path, dialect }));
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

function scanStatements(text, grammar, where, dialect) {
  let firstDdl = null;
  const cleaned = neutralize(text, grammar, dialect);
  const includeRes =
    dialect === 'unknown' || !INCLUDE_RES[dialect]
      ? Object.values(INCLUDE_RES)
      : [INCLUDE_RES[dialect]];
  if (grammar === 'sql' && includeRes.some((re) => re.test(cleaned))) {
    deny('Nested SQL includes are unsupported; submit the reviewed SQL directly.' + where, 'SQL include');
  }
  for (const stmt of cleaned.split(';')) {
    if (!stmt.trim()) continue;
    if (/\bDROP\b/is.test(stmt)) deny(`DROP is never allowed from an agent.${where}`, stmt);
    if (/\bTRUNCATE\b/is.test(stmt)) deny(`TRUNCATE is never allowed from an agent.${where}`, stmt);
    if ((grammar === 'sql' && /^\s*DO\b/i.test(stmt)) || (grammar === 'shell' && /\bDO\s+(?:LANGUAGE\b|['"$])/i.test(stmt))) deny('Procedural DO blocks are unsupported.' + where, stmt);
    if (hasUnfilteredMutation(stmt)) deny('UPDATE/DELETE needs a WHERE in the same SQL scope.' + where, stmt);
    // MySQL reads # to the end of the line as a comment. A command line is never
    // neutralized (see neutralize()), so `delete from t # where id = 1` showed
    // the guard a WHERE and showed MySQL an unfiltered DELETE -- the table.
    // Read the statement a second time with the # comments taken out and block
    // if THAT reading is unfiltered. This only ever adds a block: DROP and
    // TRUNCATE are still matched against the text exactly as it arrived, so
    // nothing can be hidden behind a # that was not blocked before.
    if ((dialect === 'mysql' || dialect === 'unknown') && stmt.includes('#') &&
        hasUnfilteredMutation(stmt.replace(/#[^\r\n]*/g, ' '))) {
      deny('UPDATE/DELETE needs a WHERE in the same SQL scope; MySQL reads # to the end of the line as a comment.' + where, stmt);
    }
    if (firstDdl === null && needsApproval(stmt, dialect)) firstDdl = stmt;
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

  // A shell call names its client on the command line; an MCP call only has the
  // server name. Either way, an answer of 'unknown' means every dialect's rules
  // apply and nothing is neutralized.
  const dialect =
    grammar === 'shell'
      ? dialectOf(sql, CLIENT_DIALECT_RES)
      : dialectOf(toolName, MCP_DIALECT_RES);

  let firstDdl = scanStatements(sql, grammar, '', dialect);

  // The statement need not be on the command line. Read what the client is being
  // pointed at and scan that too; a file route with nothing readable behind it
  // is blocked rather than being waved through.
  if (grammar === 'shell') {
    const candidates = fileRouteCandidates(sql);
    if (candidates.length > 0) {
      for (const { path, dialect: fileDialect } of candidates) {
        const content = readSqlFile(path, payload.cwd);
        if (content === null) deny('SQL file is unreadable; cannot verify its contents.', 'Unreadable SQL file');
        const ddl = scanStatements(content, 'sql', ` (from ${path})`, fileDialect);
        if (ddl !== null) deny('File-based DDL approval is unsupported; submit and approve the SQL text directly.', 'DDL in SQL file');
      }
    }
  }

  // The approval covers the whole call, so check it ONCE, after the loop.
  // Checking inside the loop consumed the single-use token on the first DDL
  // statement, so an approved migration containing two of them always failed
  // on the second. Migrations routinely contain several statements.
  //
  // The displayed statement is `sql`, the exact text isApproved() fingerprints
  // -- not `firstDdl`, which is only the first `;`-delimited segment and, for
  // shell grammar, does not include the client wrapper or trailing characters
  // (e.g. the closing quote and semicolon of `psql -c "alter table t add c;"`).
  // Showing firstDdl looked like the approval target but was not: a human who
  // copied it verbatim into approve-ddl.mjs got a different fingerprint and the
  // retry stayed blocked with no indication why. See data/pitfalls/hook-005.json.
  if (firstDdl !== null && !isApproved(sql)) {
    deny('This statement requires a human approval token that is missing or expired.', sql);
  }

  process.exit(0);
} catch (err) {
  // A failed inspection is not a successful safety check.
  process.stderr.write(`[guard-sql] hook error (blocked): unable to inspect input\n`);
  process.exit(2);
}
