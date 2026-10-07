-- ============================================================================
--  exposure-callable-functions.sql
--
--  Which SECURITY DEFINER functions in `public` can be called with the
--  publishable (anon) key or by any signed-in account -- and through WHICH of
--  the two lines the EXECUTE right arrives.
--
--  WHY THE LINE MATTERS
--  A function is callable through two separate lines:
--    PUBLIC    the default every new function gets
--    explicit  the grants Supabase adds for anon / authenticated
--  Revoking one leaves the other. `revoke ... from anon` does nothing while
--  PUBLIC is still there, and `revoke ... from public` does nothing while the
--  explicit grant is still there. The Supabase Security Advisor tells you THAT
--  a function is callable; this tells you which revoke would close it.
--
--  WHAT IT READS
--  The catalog only: function names and their grants. It calls no function,
--  reads no table, and changes nothing. One statement, no transaction.
--
--  HOW TO USE
--  1. Read it. Do not run SQL you have not read.
--  2. Paste it into the Supabase SQL editor of YOUR OWN project and run it.
--     Do not run it against a project that is not yours.
--
--  HOW TO READ THE RESULT
--  One line per (role, function) the role can execute.
--    open_by   'PUBLIC only'    an earlier revoke from this role did not close
--                               it, or it was never granted explicitly
--              'explicit only'  PUBLIC is closed; the grant to the role is not
--              'both'           nothing has been revoked
--    to_close  the statement that closes it for that role. Revoking from
--              PUBLIC closes it for every role that had no grant of its own,
--              so read the other lines for the same function first.
--  Being callable is not a hole by itself: a function meant to be the public
--  entry point belongs here. Check each one against what you meant to expose.
--
--  Verified on Postgres 16.15 (fixture) and 17.6 (three live Supabase
--  projects, 2026-10-07). See docs/20-supabase-exposure-check.md.
-- ============================================================================

with roles(r) as (values ('anon'), ('authenticated')),
fn as (
  select p.oid,
         p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as signature,
         coalesce(p.proacl, acldefault('f', p.proowner)) as acl
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
),
line as (
  select fn.oid, fn.signature, roles.r,
         exists (
           select 1 from aclexplode(fn.acl) a
           where a.privilege_type = 'EXECUTE' and a.grantee = 0
         ) as via_public,
         (
           select string_agg(quote_ident(g.rolname), ', ' order by g.rolname)
           from aclexplode(fn.acl) a
           join pg_roles g on g.oid = a.grantee
           where a.privilege_type = 'EXECUTE'
             and pg_has_role(roles.r, a.grantee, 'MEMBER')
         ) as explicit_to
  from fn
  cross join roles
  where has_function_privilege(roles.r, fn.oid, 'EXECUTE')
)
select r as role,
       signature as function,
       case
         when via_public and explicit_to is not null then 'both'
         when via_public then 'PUBLIC only'
         else 'explicit only'
       end as open_by,
       format('revoke execute on function public.%s from %s;',
              signature,
              concat_ws(', ', case when via_public then 'public' end, explicit_to)) as to_close
from line
order by r, signature;
