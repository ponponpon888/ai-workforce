# AI Workforce

**The operating kit a non-engineer uses to run several production products alone.**

AI writes the code. The human decides what to build and installs the mechanical stops that keep
AI from breaking production. This repository is those stops and that workflow, in runnable form.

## Things I found out the hard way

- **One invalid setting and your entire `settings.json` is ignored.** Write something like
  `disableAutoMode: true` (the valid value is the string `"disable"`) and Claude Code does not
  quietly skip that line — it skips the whole file, `allow`, `deny` and `ask` included. You can
  believe you have guardrails and have none.
  ([measurement](measurements/2026-09-10-modes-and-paths.md))
- **`Read` denies and `Edit` denies are not symmetric.** `Read(./secrets/**)` also stops Edit
  and Write. `Edit(...)` alone does **not** stop Read. Write only one of them and you are weaker
  than you think.
- Several bugs reproduce only on Windows PowerShell 5.1 and never on 7.x. A suite can be green
  on your machine and red the moment CI runs the other interpreter.

> **An honest caveat.** These files are the setup that protects production, **written out for
> publication** — not a copy of what is running on my machine right now.
> Verified on real hardware: Windows PowerShell 5.1 and 7, Linux and macOS on Node, a clean
> user account with no prior `~/.claude`, and GitHub Actions across Ubuntu, Windows and macOS.
> Counts and scope are in [integration status](docs/17-integration-status.md); what is still
> open is in [ROADMAP](ROADMAP.md).

Japanese is the canonical version: [README.md](README.md)

---

## What this is

- Configuration, hooks, scripts and operating rules for running Claude Code as real work
- Files you can drop into `~/.claude/` and use today, on Windows, macOS or Linux
- Not a blog post. This is what sits in the place where a mistake takes production down.

## What this is not

- Not an agent framework. It does not replace crewAI, AutoGen or LangGraph. There is no Python
  package here — it is config files, hooks and scripts.
- Not a prompt collection
- Not a claim that AI does everything. It is about the 20% it does not do.

---

## Who wrote this and why you might care

I am not an engineer. I spent 13 years as a hotel and ryokan general manager. I can read code,
but not well enough to catch a mistake in review.

That one fact is the reason for every design decision here.

The usual "how to develop with AI" advice quietly assumes **a human who can review the output** —
someone who looks at the SQL and notices the missing `WHERE`. I can't. So the only option was to
build a structure that does not break even when I fail to notice.

I run several products in production this way: Next.js + Supabase + Vercel. This repository is
the exact setup that makes that survivable.

---

## The 8:2 split

| Share | Who | What |
|---|---|---|
| 8 | AI | Writes, researches, fixes, makes tests pass |
| 2 | Human | Decides what to build, stops it before production, carries the responsibility |

Lose the 2 and you get speed with a broken production database. Almost everything in this
repository exists to mechanize that 2.

The line I use for the human half is **reversibility**. Reversible — a branch, a PR, a deploy
you can roll back — proceed without asking. Irreversible — `DROP`, a delete, a charge, a sent
email — stop.

I used to ask for confirmation before every implementation. It was safe on paper and useless in
practice: too many prompts, so I started clicking OK without reading. A confirmation you don't
read is worse than no confirmation, because it comes with the feeling of having checked.
Redrawing the line at reversibility cut the prompts by about 90%, and now I read all of them.

---

## Four pillars

### 1. Two-layer `CLAUDE.md`

Safety rules shared across every project (`~/.claude/CLAUDE.md`), tech stack per project
(`<project>/CLAUDE.md`).

They get separated because they change at different rates. The per-project file is edited
constantly, and safety rules living in it slowly rot and drift apart between projects. Worse, a
brand new project starts with no safety rules at all — and a brand new project is exactly where
mistakes happen.

→ [docs/01](docs/01-two-layer-claude-md.md)

### 2. Mechanical guardrails

"Be careful" does not stop anything. A `PreToolUse` hook inspects the statement and refuses the
call before it runs.

Blocked outright: `DROP`, `TRUNCATE`, `DELETE` without `WHERE`, `UPDATE ... SET` without `WHERE`.

DDL is different: it passes only with a **human approval token**. You read the SQL, run
`approve-ddl`, and the SHA-256 of that exact statement is written to a file. The hook accepts it
once, within 15 minutes, then deletes the token. One character different and the hash changes.

The tests matter more than the hook. **The false-positive half is the important half** — a guard
that fires on correct SQL gets switched off, and then you have no guard at all.

```bash
node kit/scripts/test-guard-sql.mjs    # pass: 45   fail: 0
```

Adding the "unrelated MCP tool" case is how I found a real bug: searching GitHub for the string
`drop table` was being read as SQL and blocked.

A second hook of the same shape, `guard-secrets`, stops a shell command from reading `.env` or a
private key. The `Read(./.env)` line in `deny` binds the Read tool alone, so `cat .env` and
`Get-Content .env` were walking straight past it. It refuses only when the command both names a
secret file and is a shape that reads one (65 cases: 34 must block, 31 must allow).

```bash
node kit/scripts/test-guard-secrets.mjs   # pass: 65   fail: 0
```

→ [docs/02](docs/02-guardrails.md) · [guard-sql.mjs](kit/claude/hooks/guard-sql.mjs) ·
[guard-secrets.mjs](kit/claude/hooks/guard-secrets.mjs)

### 3. Division of labor

The same model is good at different things depending on where it runs.

| Where | Does | Does not |
|---|---|---|
| Chat | Design, judgement, research, settling the spec | Local git, native builds |
| Local Claude Code | Files, git, builds, tests, implementation | Decide the spec on its own |
| GitHub MCP | Open, review and merge pull requests | — |

→ [docs/03](docs/03-division-of-labor.md)

### 4. Multi-project operation

Every repository is current the moment the machine boots, and work in progress is never touched.
The script never stashes, never resets, never checks out, and skips any repository with a dirty
tree.

That claim is tested against real git, not mocks: a real bare origin and six real clones (clean,
dirty, feature branch, detached HEAD, **a genuinely conflicted rebase left mid-flight**, and a
diverged local `main`).

```
destroys nothing:            (excerpt — full output in docs/04)
  PASS  dirty repo: uncommitted work intact
  PASS  dirty repo: still dirty (nothing was stashed)
  PASS  no stash was ever created
  PASS  mid-rebase: still mid-rebase
  PASS  diverged main: local commit not discarded
```

→ [docs/04](docs/04-multi-project.md) · [pull-all.mjs](kit/scripts/pull-all.mjs)

---

## Closing the holes the hook cannot reach

A `PreToolUse` hook only protects the client it is installed in. Anything the chat side calls
over MCP walks straight past it. Two documents cover what actually closes those:

**Supabase** — role grants do *not* help, because MCP runs through the Management API with your
developer credentials and goes over any `GRANT`. What works is the connection URL:
`read_only=true` switches the server to a read-only Postgres user, and `project_ref=<id>` limits
it to one project. Supabase's own docs say not to connect production at all.
→ [docs/06](docs/06-supabase-mcp.md)

**GitHub** — the MCP server has `--read-only` (which overrides toolset selection, so a
misconfiguration cannot open a hole), `--exclude-tools` (highest precedence — "open PRs but never
merge" is expressible), and `--lockdown-mode`. And the finding that surprised me: **a
fine-grained PAT cannot stop force-push or branch deletion.** Normal push, force-push and ref
deletion all require exactly `Contents (write)` — there is no finer grain. Rulesets stop those,
not tokens.
→ [docs/07](docs/07-github-vercel.md)

Both documents also cover prompt injection, which lands hard on any product with a user-writable
text field: a contact form, a profile bio, a review, an application message. Every one of those
is a place where a user's text becomes an instruction to your agent.

---

## Install

**Windows**

```powershell
git clone https://github.com/ponponpon888/ai-workforce.git
cd ai-workforce
.\kit\scripts\install.ps1 -WhatIf   # see what would happen
.\kit\scripts\install.ps1
```

**macOS / Linux**

```bash
git clone https://github.com/ponponpon888/ai-workforce.git
cd ai-workforce
node kit/scripts/install.mjs --dry-run
node kit/scripts/install.mjs
```

Nothing is deleted. Anything overwritten is copied to `.bak.<timestamp>` first.

There are two hook implementations with identical behaviour: `guard-sql.mjs` runs everywhere
(Claude Code already ships on Node, so there is nothing to install — no jq, no python), and
`guard-sql.ps1` is there for Windows setups that would rather keep Node out of the hook path.

CI runs the Node suites on Ubuntu, macOS and Windows, the PowerShell suites on all three, and
both installers into a throwaway home.

---

## Documentation

Japanese is canonical. **The two core documents are also in English** — 00 and 02, marked EN
below. For the rest, the tables, flags, file names and code are language-neutral, so they are
usable as-is; translations are welcome.

| | |
|---|---|
| [00 Principles](docs/00-principles.en.md) — EN | Why it looks like this. Includes the project I killed after 14 days, and the four things it taught me |
| [01 Two-layer CLAUDE.md](docs/01-two-layer-claude-md.md) | Splitting shared safety rules from per-project config |
| [02 Mechanical guardrails](docs/02-guardrails.en.md) — EN | Hooks, deny lists, the DDL approval token, the PowerShell encoding trap |
| [03 Division of labor](docs/03-division-of-labor.md) | Chat vs local Claude Code vs MCP |
| [04 Multi-project operation](docs/04-multi-project.md) | Auto-pull, absolute paths, naming |
| [05 Production database](docs/05-production-db.md) | Where the line sits with Supabase |
| [06 Closing the chat-side hole](docs/06-supabase-mcp.md) | Supabase MCP `read_only` / `project_ref`, prompt injection |
| [07 GitHub and Vercel](docs/07-github-vercel.md) | MCP read-only and tool exclusion, why a PAT cannot stop force-push |
| [08 Pitfall records](docs/08-pitfall-records.md) | Machine-readable pitfalls in `data/pitfalls/`: measured, inferred, documented and unverified kept apart |
| [Case studies](docs/case-studies/) | Excerpts from products that are actually running |
| [99 FAQ](docs/99-faq.md) | |

---

## On holes that are still open

Some are. They are written down as open, with the parts I could not verify left blank rather
than guessed:

- Vercel is not locked down. The best available answer is structural — route production deploys
  through Git only and protect `main` with a ruleset — not a Vercel setting.
- I could not confirm whether Vercel's MCP supports per-tool restriction or project-scoped
  tokens, so `docs/07` says so instead of guessing.
- `guard-sql` has a known false positive: when SQL arrives through a shell tool, string
  literals are not masked, so a harmless `has_schema_privilege(..., 'CREATE')` reads as DDL.
  Left open and recorded rather than patched in a hurry.

A setup presented as airtight looks better. But anyone copying it would get hurt by the parts
I quietly left out. Knowing where the machine stops and the discipline starts is worth more than
pretending there is no seam.

## Adoption support and consulting

This repository is MIT-licensed and can be installed without paid support. For usage questions, reproducible bugs, or pitfalls you have encountered, use [GitHub Issues](https://github.com/ponponpon888/ai-workforce/issues). Do not post secrets, internal company data, or customer information in a public issue.

Hands-on support is available when the standard kit is not enough:

- Review an existing Claude Code setup and operating workflow
- Design guardrails for production databases, secrets, and Git operations
- Implement custom hooks, diagnostics, and approval flows
- Define rollout and operating rules for a small team
- Validate an AI workflow through a small, focused business demo

I also build the products themselves — the Next.js + Supabase + Vercel platforms described in
the case studies. Indicative ranges, scoped per project:

| Scope | Range (JPY) | Approx. (USD) |
|---|---|---|
| Guardrail and workflow review — audit an existing setup, deliver a written plan | ¥300,000 – ¥600,000 | ~$2,000 – $4,000 |
| A working product — auth, database, admin, email, deployed | ¥600,000 – ¥1,500,000 | ~$4,000 – $10,000 |
| Multi-sided platform, integrations, ongoing build | ¥1,500,000+ | ~$10,000+ |
| Maintenance | from ¥30,000 / month | from ~$200 / month |

USD figures are approximate and track the exchange rate; the JPY figures are the actual ones.

An initial conversation does not require a purchase. We will first separate what the open-source kit already solves from what needs environment-specific implementation.

**[Discuss an AI Workforce adoption](https://www.shingokumon.com/contact)**

---

## Author

**Shingo Kumon** — 13 years as a hotel general manager, not an engineer, ships production
software with AI. [shingokumon.com](https://www.shingokumon.com)

Available for product and platform work, in Japan and internationally.

## Contributing

Yes, please — especially:

- A POSIX port of `pull-all` (Node version exists; a shell version would be welcome)
- `guard-sql` support for MySQL and SQLite
- **A pitfall you hit yourself.** Those are the most valuable thing in this repository.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. Use it, change it, ship it. No attribution required.
