-- ============================================================================
--  exposure-who-can-read.sql
--
--  Which tables and views in `public` can be read with the publishable (anon)
--  key, and by any signed-in account -- and how many of their columns.
--
--  WHAT IT READS
--  The catalog only: grants, policies, column names. It does not read a single
--  row of your tables, and it changes nothing. One statement, no transaction.
--
--  HOW TO USE
--  1. Read it. Do not run SQL you have not read.
--  2. Paste it into the Supabase SQL editor of YOUR OWN project and run it.
--     Do not run it against a project that is not yours.
--
--  HOW TO READ THE RESULT
--  One line per (role, object) that the role holds SELECT on.
--    reads                what the grants and policies add up to
--    columns              readable columns / all columns
--    named_like_private   readable columns whose NAME looks private. A guess
--                         from the name; it does not look at the contents.
--    row_conditions       the SELECT policies that apply to the role
--  Left out: tables with RLS on and no policy for the role (they return no
--  rows; the Supabase Security Advisor lists those).
--
--  WHAT IT CANNOT TELL YOU
--  How many rows a condition lets through. `is_admin()` and `true` look the
--  same from here. Run exposure-count-as-roles.sql for that.
--
--  `authenticated` is anyone who is signed in. If people can create their own
--  account in your project, that is anyone at all.
--
--  Verified on Postgres 16.15 (fixture) and 17.6 (three live Supabase
--  projects, 2026-10-07). See docs/20-supabase-exposure-check.md.
-- ============================================================================

with roles(r) as (values ('anon'), ('authenticated')),
rel as (
  select c.oid, c.relname, c.relkind, c.relrowsecurity,
         coalesce(array_to_string(c.reloptions, ','), '') as opts
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p', 'v', 'm', 'f')
),
pol as (
  select p.polrelid, r.r,
         count(*) as n,
         string_agg(p.polname || ': ' || coalesce(pg_get_expr(p.polqual, p.polrelid), 'true'), '  ||  ' order by p.polname) as conditions
  from pg_policy p
  cross join roles r
  where p.polpermissive
    and p.polcmd in ('r', '*')
    and exists (
      select 1 from unnest(p.polroles) x
      where x = 0 or pg_has_role(r.r, x, 'MEMBER')
    )
  group by p.polrelid, r.r
),
col as (
  select a.attrelid, r.r,
         count(*) as total,
         count(*) filter (where has_column_privilege(r.r, a.attrelid, a.attnum, 'SELECT')) as readable,
         string_agg(a.attname, ', ' order by a.attnum) filter (
           where has_column_privilege(r.r, a.attrelid, a.attnum, 'SELECT')
             and a.attname ~* '(mail|phone|tel$|_tel|address|addr|memo|note|token|secret|passw|birth|line_|ip_|_ip$|salary|bank|card)'
         ) as named_like_private
  from pg_attribute a
  cross join roles r
  where a.attnum > 0 and not a.attisdropped
  group by a.attrelid, r.r
)
select roles.r as role,
       rel.relname as object,
       case
         when rel.relkind in ('v', 'm', 'f') and rel.opts ~* 'security_invoker=(true|on|1)'
           then 'view, read with the caller''s rights'
         when rel.relkind in ('v', 'm', 'f')
           then 'view, read with its owner''s rights (RLS of the tables under it is not applied)'
         when not rel.relrowsecurity
           then 'ALL ROWS (RLS is off)'
         else 'rows that meet row_conditions'
       end as reads,
       col.readable || ' / ' || col.total as columns,
       col.named_like_private,
       pol.conditions as row_conditions
from rel
cross join roles
join col on col.attrelid = rel.oid and col.r = roles.r
left join pol on pol.polrelid = rel.oid and pol.r = roles.r
where col.readable > 0
  and not (rel.relkind in ('r', 'p') and rel.relrowsecurity and coalesce(pol.n, 0) = 0)
order by roles.r, rel.relname;
