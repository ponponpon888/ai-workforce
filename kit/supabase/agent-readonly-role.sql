-- ============================================================================
--  agent-readonly-role.sql
--
--  A Postgres role for anything that connects to the database DIRECTLY with a
--  connection string: a local psql session, a script, an app service account.
--
--  READ THIS FIRST
--  This does NOT constrain the Supabase MCP server. MCP runs through the
--  Management API with your developer account's permissions, so it goes over
--  any GRANT you set here. To constrain MCP, use the connection URL parameters
--  (read_only=true, project_ref=<id>, features=<groups>).
--  See docs/06-supabase-mcp.md.
--
--  WHAT THIS GIVES YOU
--  A role that can read everything in `public` and nothing else. No INSERT,
--  no UPDATE, no DELETE, no DDL, no access to other schemas, no ability to
--  create anything.
--
--  HOW TO USE
--  1. Read it. Do not run SQL you have not read.
--  2. Replace the password below with one from a password manager.
--  3. Run it against the target project (Supabase SQL editor, or psql).
--  4. Build a connection string with this role and hand THAT to the agent,
--     never the postgres or service_role credentials.
--
--  Written for Postgres 15+ (Supabase). Verified against a live project
--  (2026-09-15, Postgres 17.6.1, empty tables): the role's four privilege
--  flags (rolsuper/rolbypassrls/rolcreatedb/rolcreaterole) were confirmed
--  false, and has_table_privilege / has_schema_privilege confirmed SELECT
--  allowed while INSERT/UPDATE/DELETE/CREATE were denied. See ROADMAP.md.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The role
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'agent_readonly') then
    -- CHANGE THIS PASSWORD before running.
    create role agent_readonly with login password 'CHANGE_ME_BEFORE_RUNNING';
  end if;
end
$$;

-- Never let this role create objects, even in schemas it can see.
revoke create on schema public from agent_readonly;
revoke all on database postgres from agent_readonly;

-- Connecting and looking at `public` is all it may do.
grant connect on database postgres to agent_readonly;
grant usage on schema public to agent_readonly;

-- ---------------------------------------------------------------------------
-- 2. Read on everything that exists today
-- ---------------------------------------------------------------------------

grant select on all tables in schema public to agent_readonly;
grant select on all sequences in schema public to agent_readonly;

-- ---------------------------------------------------------------------------
-- 3. Read on everything created from now on
--
--    Default privileges apply per granting role. If your migrations run as
--    `postgres`, the line below is the one that matters. Add a line for any
--    other role that creates tables, or new tables will be invisible to the
--    agent and you will spend an afternoon wondering why.
-- ---------------------------------------------------------------------------

alter default privileges for role postgres in schema public
  grant select on tables to agent_readonly;

alter default privileges for role postgres in schema public
  grant select on sequences to agent_readonly;

-- ---------------------------------------------------------------------------
-- 4. Row Level Security still applies
--
--    A plain role does NOT bypass RLS. That is the point: the agent sees the
--    same rows a normal client would. Do not add BYPASSRLS to make a query
--    work -- fix the query, or read the table as a human.
--
--    Confirm the role is not privileged:
--      select rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
--      from pg_roles where rolname = 'agent_readonly';
--    All four booleans must be false.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 5. Keep it out of schemas that are not yours
--
--    Supabase keeps auth data in `auth` and storage metadata in `storage`.
--    Neither is granted above; this documents the intent so a future you does
--    not "temporarily" grant them.
-- ---------------------------------------------------------------------------

revoke all on schema auth    from agent_readonly;
revoke all on schema storage from agent_readonly;

-- ---------------------------------------------------------------------------
-- 6. Verify
--
--    Run this as agent_readonly (a direct connection string, not the
--    Supabase MCP -- MCP runs as your developer account and will not show
--    these restrictions; see the note at the top). Every statement must
--    fail except the first.
--
--      select count(*) from public.<some_table>;   -- must succeed
--      insert into public.<some_table> default values;  -- must fail
--      update public.<some_table> set id = id;          -- must fail
--      delete from public.<some_table>;                 -- must fail
--      create table public.probe (id int);              -- must fail
--
--    An untested guardrail is not a guardrail. Run all five.
--
--    If you cannot run a direct psql session (no client installed, or a
--    guardrail hook -- e.g. guard-sql -- flags a keyword like 'CREATE'
--    appearing inside a has_schema_privilege(...) string argument as DDL
--    when the SQL is passed through a shell tool), a privilege-only check
--    run through the Supabase MCP or SQL editor gives the same answer
--    without touching any data:
--
--      select
--        has_table_privilege('agent_readonly', 'public.<some_table>', 'SELECT') as can_select,
--        has_table_privilege('agent_readonly', 'public.<some_table>', 'INSERT') as can_insert,
--        has_table_privilege('agent_readonly', 'public.<some_table>', 'UPDATE') as can_update,
--        has_table_privilege('agent_readonly', 'public.<some_table>', 'DELETE') as can_delete,
--        has_schema_privilege('agent_readonly', 'public', 'CREATE') as can_create_in_public;
--
--    can_select must be true; the other four must be false. This checks
--    the grants only, not RLS row visibility -- run the five live
--    statements too when you can, on a table you are prepared to see
--    partially exercised (WHERE-less UPDATE/DELETE on a non-empty table
--    is exactly the kind of statement your own production-DB rules should
--    make you stop and confirm before running).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- To remove the role again:
--
--   grant agent_readonly to postgres;
--   reassign owned by agent_readonly to postgres;
--   drop owned by agent_readonly;
--   drop role agent_readonly;
--
-- (On Supabase, `postgres` is not a full superuser and is not automatically
--  a member of roles it did not create -- the GRANT above is required first,
--  or REASSIGN/DROP OWNED fail with "permission denied to reassign/drop
--  objects". DROP ROLE fails while the role still owns or is granted
--  anything, which is why REASSIGN/DROP OWNED come first.)
-- ---------------------------------------------------------------------------
