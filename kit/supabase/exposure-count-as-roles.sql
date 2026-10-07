-- ============================================================================
--  exposure-count-as-roles.sql
--
--  How many rows can actually be read
--    - with the publishable (anon) key, and
--    - by an account that has just signed up and owns nothing.
--
--  WHAT IT READS
--  Row COUNTS only. It never selects a column's contents. It changes nothing.
--  One statement; the role switch ends when the statement ends.
--
--  HOW TO USE
--  1. Read it. Do not run SQL you have not read.
--  2. Paste it into the Supabase SQL editor of YOUR OWN project and run it.
--     Do not run it against a project that is not yours.
--  It runs count(*) on every table and view in `public` that the two roles hold
--  SELECT on. On very large tables that takes time; list them in `skip` below.
--
--  HOW TO READ THE RESULT
--    asked_as      the role this file switched to
--    counted_as    the role Postgres reported from INSIDE the counting. If it
--                  does not equal asked_as, the switch did not happen: throw
--                  the result away.
--    object        '(objects counted)' is the tally line: how many tables and
--                  views were counted for that role. There is always one per
--                  role, so an all-clear result still shows the counting ran.
--    rows_visible  rows that role can read. Objects with 0 are left out.
--  Every line other than the tally is something a stranger can read. Check
--  each one against what you meant to publish.
--
--  The second role has `sub` set to a random uuid: signed in, but nobody your
--  data knows. Whatever it can see does not belong to it.
--
--  IF IT STOPS WITH AN ERROR
--  One object could not be counted as that role (for example a view that calls
--  a function the role may not execute). Add its name to `skip` and run again.
--
--  Verified on Postgres 16.15 (fixture) and 17.6 (three live Supabase
--  projects, 2026-10-07). See docs/20-supabase-exposure-check.md.
-- ============================================================================

with
skip as (
  -- names to leave out, e.g.  array['big_table', 'broken_view']
  select unnest(array[]::text[]) as relname
),
target as (
  select c.oid, n.nspname, c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p', 'v', 'm')
    and c.relname not in (select relname from skip)
),

-- 1. the publishable key
as_anon as materialized (
  select set_config('request.jwt.claims', '{"role":"anon"}', true) as claims,
         set_config('role', 'anon', true) as switched_to
),
anon_probe as materialized (
  select (xpath('/row/who/text()', query_to_xml('select current_user as who', false, true, '')))[1]::text as counted_as
  from as_anon
  where as_anon.switched_to = 'anon'
),
anon_counts as materialized (
  select t.relname,
         (xpath('/row/who/text()', x.doc))[1]::text as counted_as,
         (xpath('/row/n/text()', x.doc))[1]::text::bigint as n
  from as_anon
  cross join target t
  cross join lateral (
    select query_to_xml(format('select current_user as who, count(*) as n from %I.%I', t.nspname, t.relname), false, true, '') as doc
    where as_anon.switched_to = 'anon'
  ) x
  where has_any_column_privilege('anon', t.oid, 'SELECT')
),

-- 2. an account that has just signed up. It starts only after 1. has finished.
as_stranger as materialized (
  select set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true) as claims,
         set_config('role', 'authenticated', true) as switched_to
  from (select count(*) from anon_counts) counts_done,
       (select count(*) from anon_probe) probe_done
),
stranger_probe as materialized (
  select (xpath('/row/who/text()', query_to_xml('select current_user as who', false, true, '')))[1]::text as counted_as
  from as_stranger
  where as_stranger.switched_to = 'authenticated'
),
stranger_counts as materialized (
  select t.relname,
         (xpath('/row/who/text()', x.doc))[1]::text as counted_as,
         (xpath('/row/n/text()', x.doc))[1]::text::bigint as n
  from as_stranger
  cross join target t
  cross join lateral (
    select query_to_xml(format('select current_user as who, count(*) as n from %I.%I', t.nspname, t.relname), false, true, '') as doc
    where as_stranger.switched_to = 'authenticated'
  ) x
  where has_any_column_privilege('authenticated', t.oid, 'SELECT')
)

select 'anon' as asked_as, counted_as, relname as object, n as rows_visible
from anon_counts
where n > 0
union all
select 'anon', (select counted_as from anon_probe), '(objects counted)', (select count(*) from anon_counts)
union all
select 'authenticated', counted_as, relname, n
from stranger_counts
where n > 0
union all
select 'authenticated', (select counted_as from stranger_probe), '(objects counted)', (select count(*) from stranger_counts)
order by 1, 3;
