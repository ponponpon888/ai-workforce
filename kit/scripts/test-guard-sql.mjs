#!/usr/bin/env node
/**
 * test-guard-sql.mjs — Test suite for guard-sql.mjs. Run it after any change.
 *
 * Feeds crafted PreToolUse payloads to the hook and asserts the exit code.
 * Exit 2 means blocked, exit 0 means allowed.
 *
 * The "must allow" half matters more than the "must block" half: a guard that
 * fires on correct SQL gets switched off, and then you have no guard at all.
 *
 *   node kit/scripts/test-guard-sql.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(here, '..', 'claude', 'hooks', 'guard-sql.mjs');
const APPROVE = resolve(here, 'approve-ddl.mjs');
const APPROVAL_DIR = mkdtempSync(join(tmpdir(), 'aiwf-test-'));

// Real files, because the file route is the whole point: the hook has to open
// what the client is pointed at. A fixture that does not exist on disk tests the
// unreadable path instead, which is a different rule.
const SQL_DIR = mkdtempSync(join(tmpdir(), 'aiwf-sql-'));
const sqlFile = (name, body) => {
  const path = join(SQL_DIR, name);
  writeFileSync(path, body, 'utf8');
  return path;
};
const OK_SQL = sqlFile('ok.sql', 'select 1;\n');
const DROP_SQL = sqlFile('bad.sql', 'drop table users;\n');
const DDL_SQL = sqlFile('ddl.sql', 'create table a (id int);\n');
const QUOTED_SQL = sqlFile('quoted.sql', "insert into notes (body) values ('drop the old flow');\n");
const MISSING_SQL = join(SQL_DIR, 'not-written.sql');
const RENAME_SQL = sqlFile('rename.sql', 'rename table a to b;\n');
// psql has \i, MySQL has source, SQLite has .read. All three hide a file the
// approval never covered, so all three are refused inside a scanned file.
const MYSQL_INCLUDE_SQL = sqlFile('wrapper-mysql.sql', `source ${DROP_SQL}\n`);
const SQLITE_INCLUDE_SQL = sqlFile('wrapper-sqlite.sql', `.read ${DROP_SQL}\n`);

const BLOCK = 2;
const ALLOW = 0;

let pass = 0;
let fail = 0;

function callHook(toolName, toolInput) {
  const payload = JSON.stringify({
    session_id: 'test',
    hook_event_name: 'PreToolUse',
    cwd: process.cwd(),
    tool_name: toolName,
    tool_input: toolInput,
  });

  const r = spawnSync(process.execPath, [HOOK], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, AIWF_APPROVAL_DIR: APPROVAL_DIR },
  });
  return { code: r.status, out: (r.stderr || '') + (r.stdout || '') };
}

function assert(name, expected, result) {
  if (result.code === expected) {
    console.log(`  PASS  ${name}`);
    pass++;
  } else {
    console.log(`  FAIL  ${name} (expected ${expected}, got ${result.code})`);
    console.log(`        ${result.out.replace(/\r?\n/g, ' ').slice(0, 200)}`);
    fail++;
  }
}

function approve(sql) {
  spawnSync(process.execPath, [APPROVE, '--force', sql], {
    encoding: 'utf8',
    env: { ...process.env, AIWF_APPROVAL_DIR: APPROVAL_DIR },
  });
}

const SB = 'mcp__Supabase__execute_sql';
const MY = 'mcp__planetscale__execute_sql'; // PlanetScale speaks MySQL
const LITE = 'mcp__sqlite__query';

console.log('\nguard-sql test suite (node)\n');

console.log('must block:');
assert('DROP TABLE', BLOCK, callHook(SB, { query: 'drop table salons' }));
assert('DROP after a SELECT', BLOCK, callHook(SB, { query: 'select 1; drop table nothing;' }));
assert('TRUNCATE', BLOCK, callHook(SB, { query: 'truncate bookings' }));
assert('DELETE, no WHERE', BLOCK, callHook(SB, { query: 'delete from bookings' }));
assert('UPDATE, no WHERE', BLOCK, callHook(SB, { query: 'update bookings set status = 1' }));
assert('unapproved DDL', BLOCK, callHook(SB, { query: 'alter table bookings add column memo text' }));
assert('DELETE via psql', BLOCK, callHook('Bash', { command: 'psql $DB -c "delete from bookings"' }));
assert('WHERE hidden in a comment', BLOCK, callHook(SB, { query: 'delete from bookings -- where id = 1' }));
// A shell command line is not SQL. Reading `--sql` as a line comment deletes the
// statement the option carries, and the TRUNCATE stops being visible.
assert('TRUNCATE behind --sql', BLOCK,
  callHook('Bash', { command: "npx supabase db execute --sql 'truncate bookings'" }));
assert('DROP via the PowerShell tool', BLOCK,
  callHook('PowerShell', { command: 'psql $env:DB -c "drop table x"' }));

// SQL does not have to be on the command line. Each of these hands a client a
// file; a guard that reads only the command line saw none of them.
assert('DROP in a file fed with -f', BLOCK, callHook('Bash', { command: `psql -f ${DROP_SQL}` }));
assert('DROP in a file fed with --file=', BLOCK, callHook('Bash', { command: `psql --file=${DROP_SQL}` }));
assert('DROP in a file redirected in', BLOCK, callHook('Bash', { command: `psql < ${DROP_SQL}` }));
assert('DROP in a file piped through cat', BLOCK, callHook('Bash', { command: `cat ${DROP_SQL} | psql` }));
assert('DROP in a file included with \\i', BLOCK,
  callHook('Bash', { command: `psql -c "\\i ${DROP_SQL}"` }));
assert('DROP in a file fed to mysql', BLOCK, callHook('Bash', { command: `mysql app < ${DROP_SQL}` }));
assert('DROP in a file fed to sqlite3', BLOCK, callHook('Bash', { command: `sqlite3 app.db < ${DROP_SQL}` }));
assert('DROP in a file fed to supabase db execute', BLOCK,
  callHook('Bash', { command: `npx supabase db execute --file ${DROP_SQL}` }));
assert('unapproved DDL inside a file', BLOCK, callHook('Bash', { command: `psql -f ${DDL_SQL}` }));
// This one used to be a "must allow" case, on the reasoning that a path is not a
// statement. That reasoning is what left the file route open: the path is not the
// statement, it is where the statement is. An unreadable file is now treated as an
// unknown statement and is blocked even when the command has an approval.
assert('a file route with nothing readable behind it', BLOCK,
  callHook('Bash', { command: `npx supabase db push --file ${MISSING_SQL}` }));

console.log('\nmust block (MySQL):');
// None of these exist in Postgres, so the Postgres keyword list never saw them.
// Each one is as hard to undo as the DDL that was already gated, so each goes
// through the same human approval rather than being blocked outright.
assert('RENAME TABLE', BLOCK, callHook('Bash', { command: 'mysql app -e "rename table a to b"' }));
assert('REPLACE INTO (deletes the row it replaces)', BLOCK,
  callHook('Bash', { command: 'mysql app -e "replace into t (id) values (1)"' }));
assert('LOAD DATA INFILE', BLOCK,
  callHook('Bash', { command: "mysql app -e \"load data infile '/tmp/a.csv' replace into table t\"" }));
assert('FLUSH TABLES WITH READ LOCK', BLOCK,
  callHook('Bash', { command: 'mysql app -e "flush tables with read lock"' }));
assert('RESET MASTER', BLOCK, callHook('Bash', { command: 'mysql app -e "reset master"' }));
assert('PURGE BINARY LOGS', BLOCK,
  callHook('Bash', { command: "mysql app -e \"purge binary logs before '2020-01-01'\"" }));
assert('OPTIMIZE TABLE', BLOCK, callHook('Bash', { command: 'mysql app -e "optimize table t"' }));
assert('SET PASSWORD', BLOCK,
  callHook('Bash', { command: "mysql app -e \"set password for u@'%' = 'x'\"" }));
// MySQL reads # to the end of the line as a comment, so this is an unfiltered
// DELETE to the database and looked like a filtered one to the guard.
assert('WHERE hidden behind a # comment', BLOCK,
  callHook('Bash', { command: 'mysql app -e "delete from t # where id = 1"' }));
assert('RENAME TABLE in a file fed to mysql', BLOCK,
  callHook('Bash', { command: `mysql app < ${RENAME_SQL}` }));
assert('source include inside a file fed to mysql', BLOCK,
  callHook('Bash', { command: `mysql app < ${MYSQL_INCLUDE_SQL}` }));
assert('RENAME TABLE over a MySQL MCP server', BLOCK, callHook(MY, { query: 'rename table a to b' }));

console.log('\nmust block (SQLite):');
assert('ATTACH DATABASE', BLOCK,
  callHook('Bash', { command: 'sqlite3 app.db "attach database \'other.db\' as o"' }));
assert('PRAGMA writable_schema = ON', BLOCK,
  callHook('Bash', { command: 'sqlite3 app.db "pragma writable_schema = on"' }));
assert('PRAGMA foreign_keys = OFF', BLOCK,
  callHook('Bash', { command: 'sqlite3 app.db "pragma foreign_keys = off"' }));
assert('INSERT OR REPLACE', BLOCK,
  callHook('Bash', { command: 'sqlite3 app.db "insert or replace into t values (1)"' }));
assert('.restore over the open database', BLOCK,
  callHook('Bash', { command: 'sqlite3 app.db ".restore backup.db"' }));
assert('DROP in a file read with .read', BLOCK,
  callHook('Bash', { command: `sqlite3 app.db ".read ${DROP_SQL}"` }));
assert('DROP in a file loaded with -init', BLOCK,
  callHook('Bash', { command: `sqlite3 -init ${DROP_SQL} app.db` }));
assert('.read include inside a file fed to sqlite3', BLOCK,
  callHook('Bash', { command: `sqlite3 app.db < ${SQLITE_INCLUDE_SQL}` }));
assert('PRAGMA writable_schema over a SQLite MCP server', BLOCK,
  callHook(LITE, { query: 'pragma writable_schema = on' }));
// An ORM CLI can be pointed at either engine, so no dialect is assumed and
// every dialect's rules apply.
assert('MySQL statement through an ambiguous client', BLOCK,
  callHook('Bash', { command: 'npx prisma db execute --command "replace into t (id) values (1)"' }));

console.log('\nknown limitation, still BLOCK (hook-010, open_recorded — not a bug to fix silently):');
// Shell-grammar text is never neutralized (see the block comment on neutralize()),
// so a DDL keyword that is only TEXT -- not SQL actually sent to a client -- still
// trips the guard when an SQL client is invoked anywhere in the same command. This
// is a deliberate, documented trade-off (docs/02-guardrails.md), not an oversight.
// If a change here makes these ALLOW, that is a real fix — update hook-010.json's
// status/fix and docs/02 in the same change, do not just adjust this test.
assert('SQL-client name and DROP as plain text, not executed SQL', BLOCK,
  callHook('Bash', { command: 'psql -c "select 1" && echo "note: never run DROP TABLE in prod"' }));
assert('DDL keyword only in a commit message', BLOCK, callHook('Bash', {
  command: `git commit -m "docs: explain why psql -c 'DROP TABLE x' is blocked by guard-sql"`,
}));

console.log('\nmust allow:');
assert('DELETE with WHERE', ALLOW, callHook(SB, { query: 'delete from bookings where id = 1' }));
assert('UPDATE with WHERE', ALLOW, callHook(SB, { query: "update bookings set status = 1 where id = 'x'" }));
assert('plain SELECT', ALLOW, callHook(SB, { query: 'select * from salons limit 10' }));
assert('keyword inside a string', ALLOW, callHook(SB, { query: "insert into notes (body) values ('drop the old flow')" }));
assert('DELETE inside a comment', ALLOW, callHook(SB, { query: 'select * from t; -- delete from t;' }));
assert('semicolon inside a string', ALLOW, callHook(SB, { query: "select 'a; drop table t'" }));
assert('dollar-quoted body', ALLOW, callHook(SB, { query: "select $$ drop table t; $$" }));
assert('non-SQL Bash', ALLOW, callHook('Bash', { command: 'npm run build' }));
assert('Bash rm, not our job', ALLOW, callHook('Bash', { command: 'rm -rf ./dist' }));
assert('unrelated MCP tool', ALLOW, callHook('mcp__GitHub__search_code', { query: 'drop table' }));
assert('empty input', ALLOW, callHook('Bash', { command: '' }));
// The false-positive half of bringing PowerShell and shell grammar into scope:
// writing SQL into a file is not executing it, and a path is not a statement.
assert('here-string written to a file', ALLOW, callHook('PowerShell', {
  command: `@'\ndrop extension "pg_net";\n'@ | Set-Content supabase/migrations/20260101_x.sql`,
}));
assert('harmless SQL in a file', ALLOW, callHook('Bash', { command: `psql -f ${OK_SQL}` }));
assert('keyword inside a string, in a file', ALLOW,
  callHook('Bash', { command: `psql -f ${QUOTED_SQL}` }));
// The false-positive half of reading file routes. Each of these looks like one and
// is not: an -f that belongs to another command, and a here-document, whose << the
// redirect pattern must not read as a path.
assert('an -f that belongs to another command', ALLOW,
  callHook('Bash', { command: 'psql -c "select 1" && rm -f /tmp/junk' }));
assert('harmless here-document', ALLOW,
  callHook('Bash', { command: "psql <<'EOF'\nselect 1;\nEOF" }));

console.log('\nmust allow (MySQL / SQLite):');
// The half that matters more. -f is --file to psql and --force to mysql:
// reading it as psql does made the hook demand a file named `app`, fail to
// read it, and block a SELECT (data/pitfalls/hook-012.json).
assert('mysql -f is --force, not a file', ALLOW,
  callHook('Bash', { command: 'mysql -f app -e "select 1"' }));
assert('mysql --force with a real file route', ALLOW,
  callHook('Bash', { command: `mysql -f app < ${OK_SQL}` }));
assert('REPLACE the string function', ALLOW,
  callHook('Bash', { command: 'mysql app -e "select replace(name, \'a\', \'b\') from t"' }));
assert('REPLACE the string function, space before the paren', ALLOW,
  callHook('Bash', { command: 'mysql app -e "select replace (name, \'a\', \'b\') from t"' }));
assert('a column named source is not an include', ALLOW,
  callHook('Bash', { command: 'mysql app -e "select source from t"' }));
assert('# inside a string is not a comment boundary', ALLOW,
  callHook('Bash', { command: 'mysql app -e "delete from t where note = \'#1\'"' }));
assert('MySQL DELETE with WHERE', ALLOW,
  callHook('Bash', { command: 'mysql app -e "delete from t where id = 1"' }));
// # is an operator in Postgres, not a comment. Reading it as MySQL would hide
// the WHERE that follows it and block a filtered UPDATE.
assert('# as a Postgres operator, WHERE after it', ALLOW,
  callHook('Bash', { command: 'psql $DB -c "update t set flags = flags # 3 where id = 1"' }));
assert('MySQL rules do not leak into psql', ALLOW,
  callHook('Bash', { command: 'psql $DB -c "select replace(name, \'a\', \'b\') from t"' }));
assert('backtick identifier is quoting, not a statement', ALLOW,
  callHook(MY, { query: 'select `drop` from t where id = 1' }));
assert('SQLite read-only PRAGMA', ALLOW,
  callHook('Bash', { command: 'sqlite3 app.db "pragma table_info(t)"' }));
assert('SQLite PRAGMA read back, not set', ALLOW,
  callHook('Bash', { command: 'sqlite3 app.db "pragma journal_mode"' }));
assert('SQLite plain SELECT', ALLOW, callHook('Bash', { command: 'sqlite3 app.db "select 1"' }));
// Over MCP this is SQL, so the string is neutralized and the keyword inside it
// is inert. On a command line it is not: shell-grammar text is never
// neutralized, which is the documented trade-off recorded in hook-010.
assert('dialect keyword inside a string', ALLOW,
  callHook(LITE, { query: "select * from t where kind = 'attach database'" }));
assert('harmless file read with .read', ALLOW,
  callHook('Bash', { command: `sqlite3 app.db ".read ${OK_SQL}"` }));
assert('harmless file loaded with -init', ALLOW,
  callHook('Bash', { command: `sqlite3 -init ${OK_SQL} app.db` }));

console.log('\napproval token:');

// hook-005: the "Statement:" text shown for an unapproved DDL call must be
// byte-identical to the string isApproved() fingerprints (the raw tool_input
// value), or a human who copies the display into approve-ddl.mjs gets a
// different hash and the retry stays blocked with no clue why. For shell
// grammar this display used to be the first `;`-split segment, which drops
// the client wrapper's trailing characters (here, the closing `"` and `;`).
{
  const cmd = 'psql -c "alter table aiwf_display_check add column c text;"';
  const r = callHook('PowerShell', { command: cmd });
  const ok = r.code === BLOCK && r.out.includes(cmd);
  if (ok) {
    console.log('  PASS  BLOCKED Statement: shows the exact text isApproved() fingerprints');
    pass++;
  } else {
    console.log('  FAIL  BLOCKED Statement: shows the exact text isApproved() fingerprints ' +
      `(code ${r.code})`);
    console.log(`        ${r.out.replace(/\r?\n/g, ' ').slice(0, 300)}`);
    fail++;
  }
}

const DDL = 'create table memo_test (id int)';
approve(DDL);
assert('approved DDL passes', ALLOW, callHook(SB, { query: DDL }));
assert('token is single use', BLOCK, callHook(SB, { query: DDL }));
approve(DDL);
assert('approval is exact-match only', BLOCK, callHook(SB, { query: 'create table memo_test (id bigint)' }));

// A migration is normally several statements. Checking the token per statement
// consumed it on the first one and failed on the second — this test pins that.
const MULTI = 'create table a (id int); alter table a add column memo text';
approve(MULTI);
assert('approved multi-statement DDL passes', ALLOW, callHook(SB, { query: MULTI }));
assert('multi-statement token is single use too', BLOCK, callHook(SB, { query: MULTI }));
approve(MULTI);
assert('DROP still blocked inside an approved batch', BLOCK,
  callHook(SB, { query: 'create table a (id int); drop table b' }));

// The dialect statements are gated by the same token, not a second mechanism.
const RENAME = 'rename table orders to orders_old';
approve(RENAME);
assert('approved RENAME TABLE passes', ALLOW, callHook(MY, { query: RENAME }));
assert('RENAME TABLE token is single use too', BLOCK, callHook(MY, { query: RENAME }));

// An unreadable file route is refused for lack of knowledge, not because it is
// known to be bad, but unread content cannot be bound to a command-only approval.
const BLIND = `psql -f ${MISSING_SQL}`;
approve(BLIND);
assert('blind file route stays blocked despite approval', BLOCK, callHook('Bash', { command: BLIND }));
assert('blind file route remains blocked', BLOCK, callHook('Bash', { command: BLIND }));

rmSync(APPROVAL_DIR, { recursive: true, force: true });
rmSync(SQL_DIR, { recursive: true, force: true });

console.log(`\npass: ${pass}   fail: ${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
