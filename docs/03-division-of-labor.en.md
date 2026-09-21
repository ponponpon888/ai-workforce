# 03. Division of labor

日本語: [03-division-of-labor.md](03-division-of-labor.md)

The same model is good at different things depending on where it runs. If you do not fix "what
happens where", heavy work drifts to the slow place.

---

## The conclusion

| Where | What it does | What it must not do | Why |
|---|---|---|---|
| **Chat** (Cowork / claude.ai) | Design, judgement, research, settling a spec, prose | Local git, native builds | Git auth does not work from there. It cannot drive a Windows-native `node_modules` |
| **Claude Code, locally** | Files, git, builds, tests, implementation | Deciding the spec on its own | Fastest place by far, but its context is narrow |
| **GitHub MCP** | Opening PRs, reviewing, merging | — | On a project where it is connected, chat-to-merged-PR is the shortest path |

---

## How the split settled

At first I had chat produce edited files, downloaded them, and put them in place with PowerShell's
`Copy-Item`.

There was a reason for that: it is safer than running a script that does string replacement in
place. A replacement script fails quietly when the target is not what it assumed. Swapping the
whole file gives you a result you can read.

It was simply too many round trips.

Now:

- **Design and judgement in chat** (long context, and it can look across several projects)
- **File operations in Claude Code locally** (no download, no `Copy-Item` in the middle)
- **On projects where GitHub MCP is connected, chat goes straight through to a PR and a merge**

Reaching from chat into a local repository stops at git authentication. This is not something to
fix with configuration: it is faster to accept that **it is the wrong tool for that job**.

---

## Naming the files you download

If you take files out of chat, the names will eventually cause an accident.

Download `route.ts` three times and your Downloads folder holds `route.ts`, `route (1).ts` and
`route (2).ts`. Nobody can tell which is current.

So name them **purpose + target + version + date**.

```
route_onboarding_parking_v4_20260824.ts
schema_person_jsonld_v2_20260901.ts
```

Long, yes. Not getting lost in Downloads matters more.

---

## The one thing every local Claude Code prompt needs

**Put the absolute path at the top of the prompt.** Every time.

```
Work in C:\Dev\musubu.
(the actual request follows)
```

Why: work has been carried out in the wrong project's directory. A `musubu` task ran in
`hanami-nail-prototype`. Both are Next.js + Supabase, so it works normally for a while.

The shared `CLAUDE.md` also carries a rule to confirm the directory with `pwd` before starting,
but **the prompt says it too**. Belt and braces. It is cheap.

---

## How the approval mode changed

The honest history:

| When | Setting | Why it ended |
|---|---|---|
| Early | Confirm before every change | So many confirmations that they stopped being read |
| Then | Auto-approve | One dialog per session, which got annoying |
| Now | Skip approvals (stop only the operations that cannot be undone, by hand) | — |

**That is about the chat side.** The current template for Claude Code sets
`permissions.defaultMode: "default"` and `permissions.disableBypassPermissionsMode: "disable"`.
Confirming that on a real machine is not finished ([02](02-guardrails.en.md)).

The chat side has **almost no mechanical guardrails**. `guard-sql` and the `deny` list only bind
local Claude Code, so Supabase / GitHub / Vercel called from chat walk straight past them.

For Supabase I found the way to close it: put `read_only=true` and `project_ref` in the connection
URL, and do not connect the production project → [06](06-supabase-mcp.en.md).

I looked at GitHub and Vercel too → [07](07-github-vercel.en.md).

GitHub can be constrained more finely than I expected (the MCP server's `--read-only`,
`--exclude-tools` and `--lockdown-mode`, fine-grained PATs, rulesets). One finding is worth
stating on its own: **a token's scopes cannot stop force-push or branch deletion.**
`Contents: Read and write` grants an ordinary push, a force push and a deletion through the same
single permission. What stops them is a ruleset on the repository.

**Vercel I have not managed to constrain.** What helps most is not a Vercel setting at all: route
production deploys through the Git integration only, and protect `main` with a ruleset. Then the
guardrail on the GitHub side is the guardrail on Vercel too.

If you turn approvals off, you owe the equivalent somewhere else. For a long time I turned them
off without paying it.
