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
 * SCOPE
 * This stops accidents, not an adversary. Any agent holding a shell could write
 * an approval file itself. The point is that a model doing the wrong thing by
 * mistake — the common case — hits a wall it cannot walk through by accident.
 *
 * Exit 0 -> allow.  Exit 2 -> block, reason on stderr.
 * Any internal failure exits 0: a broken guard must not brick the toolchain.
 */

import { createHash } from 'node:crypto';
import { existsSync, statSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APPROVAL_TTL_MINUTES = 15;
const APPROVAL_DIR =
  process.env.AIWF_APPROVAL_DIR || join(homedir(), '.claude', 'approvals');

/** Tools whose input we inspect. Anything else is none of our business. */
const SQL_TOOL_RE = /^(Bash|mcp__[Ss]upabase__|mcp__postgres|mcp__neon|mcp__planetscale)/;

/** A Bash call only counts as SQL if it actually invokes a database client. */
const SQL_CLIENT_RE = /\b(psql|sqlite3|mysql|mariadb|supabase\s+db|prisma\s+db|drizzle-kit)\b/i;

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
      `       node kit/scripts/approve-ddl.mjs '<the exact statement>'\n` +
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
 */
function neutralize(sql) {
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
  const normalized = sql.replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/** A valid, unexpired approval token is consumed on use — one statement, one run. */
function isApproved(sql) {
  const file = join(APPROVAL_DIR, `${fingerprint(sql)}.approval`);
  if (!existsSync(file)) return false;

  const ageMinutes = (Date.now() - statSync(file).mtimeMs) / 60000;
  try {
    rmSync(file, { force: true });
  } catch {
    /* consuming is best effort */
  }
  return ageMinutes <= APPROVAL_TTL_MINUTES;
}

function extractSql(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  for (const key of ['query', 'sql', 'statement', 'command']) {
    const value = toolInput[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
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
  const sql = extractSql(payload.tool_input);

  if (!sql.trim()) process.exit(0);
  if (!SQL_TOOL_RE.test(toolName)) process.exit(0);
  if (toolName === 'Bash' && !SQL_CLIENT_RE.test(sql)) process.exit(0);

  let firstDdl = null;

  for (const stmt of neutralize(sql).split(';')) {
    if (!stmt.trim()) continue;

    if (/\bDROP\b/is.test(stmt)) {
      deny('DROP is never allowed from an agent.', stmt);
    }
    if (/\bTRUNCATE\b/is.test(stmt)) {
      deny('TRUNCATE is never allowed from an agent.', stmt);
    }
    if (/\bDELETE\s+FROM\b/is.test(stmt) && !/\bWHERE\b/is.test(stmt)) {
      deny('DELETE without a WHERE clause.', stmt);
    }
    if (/\bUPDATE\b[\s\S]*\bSET\b/is.test(stmt) && !/\bWHERE\b/is.test(stmt)) {
      deny('UPDATE without a WHERE clause.', stmt);
    }
    if (firstDdl === null && /\b(CREATE|ALTER|GRANT|REVOKE|REINDEX|VACUUM)\b/is.test(stmt)) {
      firstDdl = stmt;
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
  // Fail open, loudly. A guard that crashes must not become a guard that blocks
  // everything — that trains people to disable it.
  process.stderr.write(`[guard-sql] hook error (allowing call): ${err.message}\n`);
  process.exit(0);
}
