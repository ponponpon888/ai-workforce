-- ============================================================================
--  exposure-fixture.sql
--
--  A small database shaped like a Supabase project, with known answers, for
--  kit/scripts/test-supabase-exposure.mjs. Every table holds 3 rows.
--
--  FOR A THROWAWAY SERVER ONLY. It expects the roles `anon`, `authenticated`
--  and `aiwf_dashboard` to exist already (the test script creates them and
--  removes them), and it is loaded into a database the script creates and
--  drops. Do not load it into a real project.
-- ============================================================================

create schema auth;

-- An empty or missing claim gives null, like Supabase's auth.uid().
create function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;
grant usage on schema auth to anon, authenticated;

create table auth.users (id uuid primary key, email text);
insert into auth.users values ('00000000-0000-0000-0000-00000000000a', 'admin@example.test');

-- What Supabase does to `public` by default.
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;

create schema private;
create function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users
    where id = (select auth.uid()) and email = 'admin@example.test'
  )
$$;
grant usage on schema private to anon, authenticated;

-- 1. RLS off, default grants: both roles read all 3 rows, all 3 columns.
create table public.t_open (id int primary key, name text, contact_email text);
insert into public.t_open values (1, 'a', 'a@x.test'), (2, 'b', 'b@x.test'), (3, 'c', 'c@x.test');

-- 2. The shape found on 2026-10-07 (rls-004). The rows are public for both
--    roles; the columns were narrowed for anon only.
--    anon: 2 rows, 2 of 4 columns.  signed-in stranger: 2 rows, 4 of 4 columns.
create table public.t_listing (id int primary key, name text, status text, contact_email text);
insert into public.t_listing values
  (1, 'a', 'published', 'a@x.test'), (2, 'b', 'published', 'b@x.test'), (3, 'c', 'draft', 'c@x.test');
alter table public.t_listing enable row level security;
create policy "anyone reads published" on public.t_listing
  for select to anon, authenticated using (status = 'published');
create policy "admin reads all" on public.t_listing
  for select to authenticated using ((select private.is_admin()));
revoke select on public.t_listing from anon;
grant select (id, name) on public.t_listing to anon;

-- 3. The policy is written for everyone, but its condition needs an admin:
--    0 rows for both. Counting policies would call this table readable.
create table public.t_admin_only (id int primary key, memo text);
insert into public.t_admin_only values (1, 'x'), (2, 'y'), (3, 'z');
alter table public.t_admin_only enable row level security;
create policy "admin only" on public.t_admin_only
  for select using ((select private.is_admin()));

-- 4. Owner-scoped: 0 rows for a stranger. No policy applies to anon.
create table public.t_owned (id int primary key, owner_id uuid, note text);
insert into public.t_owned values
  (1, '00000000-0000-0000-0000-0000000000b1', 'x'),
  (2, '00000000-0000-0000-0000-0000000000b2', 'y'),
  (3, '00000000-0000-0000-0000-0000000000b2', 'z');
alter table public.t_owned enable row level security;
create policy "owner reads own" on public.t_owned
  for select to authenticated using (owner_id = (select auth.uid()));

-- 5. RLS on, no policy: 0 rows for both.
create table public.t_locked (id int primary key, secret text);
insert into public.t_locked values (1, 'x'), (2, 'y'), (3, 'z');
alter table public.t_locked enable row level security;

-- 6. No grant for either client role: must not be listed and must not be counted.
create table public.t_server_only (id int primary key, token text);
insert into public.t_server_only values (1, 'x'), (2, 'y'), (3, 'z');
revoke all on public.t_server_only from anon, authenticated;

-- 7. A view made the default way reads with its owner's rights, so it walks
--    past the RLS of t_admin_only: 3 rows for both roles.
create view public.v_definer as select id, memo from public.t_admin_only;

-- 8. The same view with security_invoker: RLS applies again, 0 rows.
create view public.v_invoker with (security_invoker = true) as
  select id, memo from public.t_admin_only;

-- 9. A restrictive policy narrows what the permissive one lets through, and
--    only for the role it names: anon reads 2 rows, a signed-in stranger 3.
create table public.t_narrowed (id int primary key, region text, note text);
insert into public.t_narrowed values (1, 'jp', 'x'), (2, 'jp', 'y'), (3, 'us', 'z');
alter table public.t_narrowed enable row level security;
create policy "anyone reads" on public.t_narrowed for select using (true);
create policy "jp only" on public.t_narrowed as restrictive
  for select to anon using (region = 'jp');

-- 10. A materialized view is a stored copy. It cannot have RLS, so both roles
--     read all 3 rows of a table that lets neither of them through.
create materialized view public.m_copy as select id, memo from public.t_admin_only;

-- 11. A foreign table. Its wrapper has no handler, so any query through it
--     fails: it must be listed by exposure-who-can-read.sql and must NOT be
--     touched by exposure-count-as-roles.sql.
create foreign data wrapper aiwf_nowhere;
create server aiwf_nowhere_server foreign data wrapper aiwf_nowhere;
create foreign table public.ft_elsewhere (id int, memo text) server aiwf_nowhere_server;

-- Functions. EXECUTE arrives by two lines: the default to PUBLIC, and the
-- explicit grants to the client roles (rls-002).

-- nothing revoked.
create function public.f_both_lines() returns int
language sql security definer set search_path = '' as $$ select 1 $$;

-- revoked from the client roles only. PUBLIC is still there: both can call it.
create function public.f_public_left() returns int
language sql security definer set search_path = '' as $$ select 1 $$;
revoke execute on function public.f_public_left() from anon, authenticated;

-- revoked from PUBLIC only. The explicit grants are still there: both can call it.
create function public.f_explicit_left() returns int
language sql security definer set search_path = '' as $$ select 1 $$;
revoke execute on function public.f_explicit_left() from public;

-- both lines closed for anon; authenticated keeps its explicit grant.
create function public.f_signed_in_only() returns int
language sql security definer set search_path = '' as $$ select 1 $$;
revoke execute on function public.f_signed_in_only() from public;
revoke execute on function public.f_signed_in_only() from anon;

-- both lines closed for both.
create function public.f_closed() returns int
language sql security definer set search_path = '' as $$ select 1 $$;
revoke execute on function public.f_closed() from public;
revoke execute on function public.f_closed() from anon, authenticated;

-- not SECURITY DEFINER: outside what the function check lists.
create function public.f_invoker() returns int language sql as $$ select 1 $$;
