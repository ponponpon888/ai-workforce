# 05. Rules for the production database

日本語: [05-production-db.md](05-production-db.md)

Whether to let an AI touch production Supabase is the scariest part of this setup. Not letting it
is the safest answer, and it does not survive contact with actually running the thing.

So I drew a line instead.

---

## Four rules

### 1. DDL is shown in full and approved before it runs

`CREATE` / `ALTER` / `GRANT` / `REVOKE` are approved only after I have seen the whole statement.

This is not a promise, it is enforced mechanically by [the hook in 02](02-guardrails.en.md).
Without an approval token nothing gets through. The statement I approved runs for 15 minutes,
once.

### 2. `UPDATE` / `DELETE` require a `WHERE`

No exceptions. The hook refuses them.

"I want to update every row" is a real case. When it happens, you write `WHERE true` explicitly.
Written, it passes. **Making you write it is the point.**

### 3. `DROP` / `TRUNCATE` never run

Not from an agent. If it is genuinely needed, a human does it by hand in the Supabase dashboard.

There is no reason to keep an automated path open for something that happens a few times a year at
most.

### 4. Test data always carries a mark that says it can be deleted

Putting test data into production does happen (a bug that only reproduces there, for instance).

When it does, `admin_memo` gets **what it is for, and "safe to delete"**.

```sql
insert into salons (name, admin_memo)
values ('test salon', '2026-09-06 listing-flow check / safe to delete');
```

And then **it actually gets deleted** once the check is done. "I'll delete it later" does not
delete it. The mark exists so that the version of me who forgot can still find it afterwards.

---

## Keep development and production physically apart

The Supabase projects themselves are separate. `.env.local` and Vercel environment variables
switch between them, and **production connection details never sit on the local machine**.

On top of that, `settings.json` carries in `deny`:

```json
"Read(.env)",
"Read(./**/.env.*)",
"Read(**/*.pem)"
```

so the AI cannot read a connection string. What it cannot read, it cannot paste.

---

## Where this setup leaks

**None of these guardrails apply to Supabase called over MCP from chat (Cowork).**

`guard-sql` is a `PreToolUse` hook in local Claude Code, so an MCP call made from chat never
reaches it. Approval mode is set to skip as well, so `execute_sql` from chat runs essentially
as-is.

I worked out how to close it, and it got its own page →
**[06. Closing the hole on the chat side](06-supabase-mcp.en.md)**

The short version:

- The first thing I tried — "create a Postgres role for the agent and revoke its `GRANT`s" —
  **does not work.** MCP runs through the Management API with the developer account's
  permissions, so it goes over the top of role permissions
- What does work is a connection-URL parameter. `read_only=true` makes the server switch to a
  read-only user, and `project_ref=<id>` narrows the target to a single project
- Do not connect the production project to MCP. Supabase's own documentation says so

Role separation itself does work on the path that **connects to Postgres directly with a
connection string** (local psql, scripts, an application's service account). That template is in
[kit/supabase/agent-readonly-role.sql](../kit/supabase/agent-readonly-role.sql).

---
