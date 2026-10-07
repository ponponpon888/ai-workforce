#!/usr/bin/env node
/**
 * test-supabase-exposure.mjs -- The three exposure checks in kit/supabase/ give the right
 * answer on a database whose answers are known.
 *
 * The checks are SQL that a reader pastes into their own project. Nothing here can see that
 * project, so the only thing that can be tested is the SQL itself: load a fixture shaped like
 * a Supabase project (kit/supabase/test/exposure-fixture.sql), run each file, compare.
 *
 * What the cases are for:
 *   - the expected lines pin down what each file reports, including what it must NOT report
 *     (a table with no grant, a table whose policy lets nobody through);
 *   - exposure-count-as-roles.sql switches role inside one statement. If the switch silently
 *     did not happen, the counts would be the caller's own and every table would look wide
 *     open -- or, worse, on another setup, all clear. The file therefore reports the role it
 *     counted as, and a case here removes the switch and asserts that the column gives it away.
 *     A result that cannot be trusted has to say so.
 *
 * NEEDS A POSTGRES IT MAY CREATE AND DROP A DATABASE ON, AND CREATE ROLES ON.
 * A THROWAWAY ONE. It creates the roles `anon`, `authenticated` and `aiwf_dashboard`, marks
 * them with a comment, and removes them afterwards. It refuses to start if `anon` or
 * `authenticated` exist without that mark, or if the server looks like a Supabase project.
 *
 * How it reaches the server: the command in AIWF_PSQL (default `psql`, so the usual PG*
 * variables apply). The connecting role must be a superuser.
 *
 *   node kit/scripts/test-supabase-exposure.mjs
 *   AIWF_PSQL='sudo -u postgres psql' node kit/scripts/test-supabase-exposure.mjs --require-db
 *
 * Without a reachable server it prints "skipped" and exits 0: most machines that run the
 * other suites have no Postgres. --require-db turns that into exit 1. CI passes it, so that
 * a runner without Postgres is a red build and not a green one that tested nothing.
 *
 * Exit 0 -> all cases pass, or skipped.  Exit 1 -> a case failed, or --require-db and no server.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sqlDir = resolve(here, '..', 'supabase');
const read = (name) => readFileSync(resolve(sqlDir, name), 'utf8');

const requireDb = process.argv.slice(2).includes('--require-db');
const unknown = process.argv.slice(2).filter((a) => a !== '--require-db');
if (unknown.length) {
  console.error(`unknown argument: ${unknown.join(' ')}`);
  process.exit(1);
}

const PSQL = (process.env.AIWF_PSQL || 'psql').trim().split(/\s+/);
const DB = `aiwf_exposure_fixture_${process.pid}`;
const MARK = 'aiwf exposure fixture';
const ROLES = ['anon', 'authenticated', 'aiwf_dashboard'];

// SQL always goes in on stdin, never as a file path: the server-side user that psql runs as
// (sudo -u postgres) often cannot read the checkout.
function psql(db, sql) {
  const r = spawnSync(
    PSQL[0],
    [...PSQL.slice(1), '-X', '-q', '-At', '-F', ' | ', '-v', 'ON_ERROR_STOP=1', '-d', db],
    { input: sql, encoding: 'utf8' },
  );
  const out = (r.stdout || '').split(/\r?\n/).filter((line) => line !== '');
  return { code: r.status, out, err: (r.stderr || '').trim(), spawnError: r.error };
}

const probe = psql('postgres', 'select 1;');
if (probe.code !== 0) {
  const why = probe.spawnError ? probe.spawnError.message : probe.err.split('\n')[0];
  if (requireDb) {
    console.error(`no Postgres reachable through "${PSQL.join(' ')}": ${why}`);
    process.exit(1);
  }
  console.log(`skipped: no Postgres reachable through "${PSQL.join(' ')}" (${why})`);
  process.exit(0);
}

function refuse(message) {
  console.error(`refusing to run: ${message}`);
  process.exit(1);
}

{
  const r = psql(
    'postgres',
    `select rolname || '=' || coalesce(shobj_description(oid, 'pg_authid'), '')
       from pg_roles where rolname in ('supabase_admin', 'anon', 'authenticated', 'aiwf_dashboard');
     select 'superuser=' || (select rolsuper from pg_roles where rolname = current_user);`,
  );
  if (r.code !== 0) refuse(r.err);
  if (r.out.includes('superuser=false')) refuse('the connecting role is not a superuser');
  if (r.out.some((line) => line.startsWith('supabase_admin='))) {
    refuse('this server has a supabase_admin role. The fixture is for a throwaway server, not a project.');
  }
  for (const line of r.out) {
    const [name, mark] = line.split('=');
    if (ROLES.includes(name) && mark !== MARK) {
      refuse(`role "${name}" already exists here and was not created by this test. Use a throwaway server.`);
    }
  }
}

function cleanup() {
  psql('postgres', `drop database if exists ${DB};`);
  // Only what carries the mark, so that nothing this test did not create is ever dropped.
  psql(
    'postgres',
    ROLES.map(
      (name) => `do $$ begin
        if exists (select 1 from pg_roles where rolname = '${name}'
                   and shobj_description(oid, 'pg_authid') = '${MARK}') then
          execute 'drop role ${name}';
        end if;
      end $$;`,
    ).join('\n'),
  );
}

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    console.log(`  PASS  ${name}`);
    pass++;
  } else {
    console.log(`  FAIL  ${name}`);
    if (detail) console.log(detail.split('\n').map((line) => `        ${line}`).join('\n'));
    fail++;
  }
}

function sameLines(name, result, expected) {
  const ok = result.code === 0 && JSON.stringify(result.out) === JSON.stringify(expected);
  check(
    name,
    ok,
    ok ? '' : `exit ${result.code} ${result.err}\nexpected:\n${expected.join('\n')}\nactual:\n${result.out.join('\n')}`,
  );
}

// What a reader's SQL editor runs as: not a superuser, but a member of both client roles.
const asDashboard = (sql) => `set role aiwf_dashboard;\n${sql}`;

cleanup();
try {
  const setup = psql(
    'postgres',
    `create role anon nologin;
     create role authenticated nologin;
     create role aiwf_dashboard nologin;
     comment on role anon is '${MARK}';
     comment on role authenticated is '${MARK}';
     comment on role aiwf_dashboard is '${MARK}';
     grant anon, authenticated to aiwf_dashboard;
     create database ${DB};`,
  );
  if (setup.code !== 0) throw new Error(`could not prepare the server: ${setup.err}`);
  const fixture = psql(DB, read('test/exposure-fixture.sql'));
  if (fixture.code !== 0) throw new Error(`the fixture did not load: ${fixture.err}`);

  const READS_ROWS = 'rows that meet row_conditions';
  const READS_ALL = 'ALL ROWS (RLS is off)';
  const VIEW_OWNER = "view, read with its owner's rights (RLS of the tables under it is not applied)";
  const VIEW_CALLER = "view, read with the caller's rights";
  const MATVIEW = 'ALL ROWS of the stored copy (materialized view, no RLS)';
  const FOREIGN = 'ALL ROWS the other server returns (foreign table, no RLS here)';
  const ADMIN = '( SELECT private.is_admin() AS is_admin)';

  console.log('\nexposure-who-can-read.sql:');
  sameLines('lists what each role holds SELECT on, and nothing else', psql(DB, asDashboard(read('exposure-who-can-read.sql'))), [
    `anon | ft_elsewhere | ${FOREIGN} | 2 / 2 | memo | `,
    `anon | m_copy | ${MATVIEW} | 2 / 2 | memo | `,
    `anon | t_admin_only | ${READS_ROWS} | 2 / 2 | memo | admin only: ${ADMIN}`,
    `anon | t_listing | ${READS_ROWS} | 2 / 4 |  | anyone reads published: (status = 'published'::text)`,
    `anon | t_narrowed | ${READS_ROWS} | 3 / 3 | note | anyone reads: true  AND  [restrictive] jp only: (region = 'jp'::text)`,
    `anon | t_open | ${READS_ALL} | 3 / 3 | contact_email | `,
    `anon | v_definer | ${VIEW_OWNER} | 2 / 2 | memo | `,
    `anon | v_invoker | ${VIEW_CALLER} | 2 / 2 | memo | `,
    `authenticated | ft_elsewhere | ${FOREIGN} | 2 / 2 | memo | `,
    `authenticated | m_copy | ${MATVIEW} | 2 / 2 | memo | `,
    `authenticated | t_admin_only | ${READS_ROWS} | 2 / 2 | memo | admin only: ${ADMIN}`,
    `authenticated | t_listing | ${READS_ROWS} | 4 / 4 | contact_email | admin reads all: ${ADMIN}  ||  anyone reads published: (status = 'published'::text)`,
    `authenticated | t_narrowed | ${READS_ROWS} | 3 / 3 | note | anyone reads: true`,
    `authenticated | t_open | ${READS_ALL} | 3 / 3 | contact_email | `,
    `authenticated | t_owned | ${READS_ROWS} | 3 / 3 | note | owner reads own: (owner_id = ( SELECT auth.uid() AS uid))`,
    `authenticated | v_definer | ${VIEW_OWNER} | 2 / 2 | memo | `,
    `authenticated | v_invoker | ${VIEW_CALLER} | 2 / 2 | memo | `,
  ]);

  console.log('\nexposure-count-as-roles.sql:');
  const count = read('exposure-count-as-roles.sql');
  // 9 objects, not 10: ft_elsewhere is a foreign table and is left alone. Counting it would
  // fail the whole statement, because its wrapper has no handler.
  const COUNTS = [
    'anon | anon | (objects counted) | 9',
    'anon | anon | m_copy | 3',
    'anon | anon | t_listing | 2',
    'anon | anon | t_narrowed | 2',
    'anon | anon | t_open | 3',
    'anon | anon | v_definer | 3',
    'authenticated | authenticated | (objects counted) | 9',
    'authenticated | authenticated | m_copy | 3',
    'authenticated | authenticated | t_listing | 2',
    'authenticated | authenticated | t_narrowed | 3',
    'authenticated | authenticated | t_open | 3',
    'authenticated | authenticated | v_definer | 3',
  ];
  sameLines('counts as each role; t_admin_only, t_owned, t_locked and v_invoker give 0', psql(DB, asDashboard(count)), COUNTS);
  sameLines(
    'the role is back to the caller once the statement has ended',
    psql(DB, asDashboard(`${count}\nselect 'afterwards: ' || current_user;`)),
    [...COUNTS, 'afterwards: aiwf_dashboard'],
  );
  // The dashboard role of a real project can read every table by itself, which is exactly
  // the case in which a switch that did not happen would go unnoticed. A superuser stands in.
  sameLines('gives the same answer when the caller can read everything', psql(DB, count), COUNTS);

  {
    const SWITCH = "set_config('role', 'anon', true) as switched_to";
    const broken = count.replace(SWITCH, "'anon'::text as switched_to");
    const r = psql(DB, broken);
    const anonLines = r.out.filter((line) => line.startsWith('anon | '));
    check(
      'with the switch to anon removed, counted_as shows it on every anon line',
      count.includes(SWITCH) && r.code === 0 && anonLines.length > 0 && anonLines.every((line) => !line.startsWith('anon | anon | ')),
      `exit ${r.code} ${r.err}\n${r.out.join('\n')}`,
    );
    check(
      '...and those counts are the wrong ones (a table that lets nobody through shows 3)',
      r.out.some((line) => /^anon \| [^|]+ \| t_admin_only \| 3$/.test(line)),
      r.out.join('\n'),
    );
  }

  {
    const EMPTY = 'array[]::text[]';
    const skipping = count.replace(EMPTY, "array['t_open']");
    sameLines(
      'a name in skip is neither counted nor reported',
      psql(DB, asDashboard(skipping)),
      COUNTS.filter((line) => !line.includes('t_open')).map((line) => line.replace('(objects counted) | 9', '(objects counted) | 8')),
    );
    check('...and the test really edited the skip list', count.includes(EMPTY) && skipping !== count, '');
  }

  {
    // A view the roles may select from, built on a function they may not execute.
    const add = psql(DB, 'create view public.v_broken as select public.f_closed() as n;');
    const r = psql(DB, asDashboard(count));
    check(
      'an object that cannot be counted stops the whole statement with its error',
      add.code === 0 && r.code !== 0 && /permission denied for function f_closed/.test(r.err),
      `exit ${r.code} ${r.err}\n${r.out.join('\n')}`,
    );
    sameLines(
      '...and naming it in skip gets the rest counted',
      psql(DB, asDashboard(count.replace('array[]::text[]', "array['v_broken']"))),
      COUNTS,
    );
    psql(DB, 'drop view public.v_broken;');
  }

  console.log('\nexposure-callable-functions.sql:');
  sameLines(
    'lists SECURITY DEFINER functions each role can execute, and the line it comes by',
    psql(DB, asDashboard(read('exposure-callable-functions.sql'))),
    [
      'anon | f_both_lines() | both | revoke execute on function public.f_both_lines() from public, anon;',
      'anon | f_explicit_left() | explicit only | revoke execute on function public.f_explicit_left() from anon;',
      'anon | f_public_left() | PUBLIC only | revoke execute on function public.f_public_left() from public;',
      'authenticated | f_both_lines() | both | revoke execute on function public.f_both_lines() from public, authenticated;',
      'authenticated | f_explicit_left() | explicit only | revoke execute on function public.f_explicit_left() from authenticated;',
      'authenticated | f_public_left() | PUBLIC only | revoke execute on function public.f_public_left() from public;',
      'authenticated | f_signed_in_only() | explicit only | revoke execute on function public.f_signed_in_only() from authenticated;',
    ],
  );
  {
    // The statement the file prints has to do what it says.
    const close = psql(DB, 'revoke execute on function public.f_public_left() from public;');
    const r = psql(DB, asDashboard(read('exposure-callable-functions.sql')));
    check(
      'running the printed to_close removes that function from the list',
      close.code === 0 && r.code === 0 && r.out.length === 5 && !r.out.some((line) => line.includes('f_public_left')),
      `exit ${r.code} ${r.err}\n${r.out.join('\n')}`,
    );
  }
} catch (error) {
  console.log(`  FAIL  ${error.message}`);
  fail++;
} finally {
  cleanup();
}

console.log(`\npass: ${pass}   fail: ${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
