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
