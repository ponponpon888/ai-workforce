# 00. Principles

日本語: [00-principles.md](00-principles.md)

## The premise

I am not an engineer. I spent 13 years as a hotel and ryokan general manager.
I can read code, but not to the level where I would catch a mistake in review.

That single fact is the reason for everything in this repository.

The usual "how to develop with AI" advice quietly assumes **a human who can review the output** —
someone who looks at the SQL the model produced and thinks "wait, there's no `WHERE`". I can't do
that. So the only option left was to build a structure that does not break even when I fail to
notice.

---

## The 8:2 split

| Share | Who | What |
|---|---|---|
| 8 | AI | Writes, researches, fixes, makes tests pass |
| 2 | Human | Decides what to build, stops it before production, carries the responsibility |

This ratio is not about how much to delegate. It exists to make explicit **what only a human can
carry**.

In practice, that turned out to be four things.

### 1. Deciding what to build

This one cannot be handed over. Hand it over and you get something plausible that nobody uses.

My input here is not code, it is the floor. Thirteen years in hotels means I know what actually
happens in the building the moment a booking lands. That is the only edge I have.

### 2. Stopping it before it touches production

AI breaks production without malice. Because there is no malice, "be careful" does not work as a
defence either. **The machine has to refuse the call before it runs.** That is the whole of
[02 Mechanical guardrails](02-guardrails.md).

### 3. Drawing the line at reversibility

This is the change that helped most in daily use.

- Reversible — a branch, a PR, a deploy you can roll back, research → **proceed without asking**
- Irreversible — `DROP`, a delete, a charge, a sent email → **stop**

I used to require confirmation before every implementation. Safe on paper, useless in practice:
there were so many prompts that they stopped being read. **A confirmation you don't read is worse
than no confirmation**, because it comes with the feeling of having checked.

Redrawing the line at reversibility cut the number of prompts by roughly 90%. Now I read all of
them, because there are few enough to read.

### 4. Carrying the responsibility

AI does not carry it. I am the one who apologizes to a user.

So anywhere the model said "this should be fine" becomes a place where *I* decided it was fine.
I make it explain itself down to the level where I can honestly hold that.

---

## Three rules

### Make it declare what it filled in

The most dangerous thing is a model quietly filling a gap in the spec. The code runs. The tests
pass. And there is now a decision in the system that nobody made.

So the shared `CLAUDE.md` requires this output every time:

```
## What I touched
- In scope: ...
- Outside the request: ...  (or "none")

## What I filled in
- Decisions I made because the spec was silent: ...
- Reasoning: ...
```

The only purpose is to keep things correctable.

### Make it build in the things nobody files a ticket for

Authorization. Idempotency. Delivery guarantees. Audit trail.

These four are almost never in a request. They get written down after the incident.

I do not have enough incidents behind me to know where they will hit, so I have them included
from the start whether or not they were asked for. "Nobody told me to add it" is a fatal answer
when one person is running production alone.

### Never trade safety for speed

Development speed is already sufficient. Trading safety for more of it just gets you to broken
faster.

---

## What I stepped in on the way here

To be clear: every rule in this repository was added afterwards, not designed up front.

- Work was executed in the wrong project's directory
  (→ absolute paths in [04](04-multi-project.md))
- Requiring confirmation for everything made confirmation meaningless
  (→ the line was redrawn at reversibility)
- Structured data was missing from the server-rendered HTML for months without me noticing
  (→ the "known pitfalls" section in each project's `CLAUDE.md`)
- PowerShell 5.1 mangled BOM-free UTF-8 and cost me half a day
  (→ the encoding section in [02](02-guardrails.md))

---

## The biggest one

In January 2026 I tried to build an AI agent SaaS and stopped after 14 days. That repository
still exists. I am adding a record of what went wrong to it and will publish it eventually.

Reading it back, four things stood out, and this repository is more or less the answer to those
four.

### 1. I built from the appearance inward

I rebuilt the UI theme six times. Marketplace → War Room → Visual Editor → Neural Glow →
Hex Grid → GlobalSidebar. Six days to build the features, eight days on that.

In all that time **I never once traced the data end to end.**

The result: the dashboard was structurally always empty. The write path used
`ai_type: 'code_generator'`; the read path filtered on
`['email','daily_report','apology','summary','idea']`. Not one row could ever match.

For the two weeks I worked on it, and the seven months it sat there, I assumed the empty
dashboard just meant no data had accumulated yet. I did not notice until I re-read the code.

### 2. I never confirmed the build passed

Every build log committed to that repository is a failure. There is not a single successful one.
I was moving on with "it probably builds".

→ Each project's `CLAUDE.md` now says `npm run build` must pass before pushing. This repository
runs, on itself, in CI on Ubuntu / macOS / Windows: a parse
check, a non-ASCII check, 29 guard-sql cases, 23 pull-all cases, and both installers.

### 3. I did not keep migrations

Zero `.sql` files. The schema existed only inside Supabase. Worse, two incompatible schemas —
`ai_activities` and `usage_logs` — coexisted in one app, and today I cannot tell which was
supposed to be authoritative.

→ [05 Production database](05-production-db.md). Schema changes go into migrations. The DDL
approval gate exists partly for this reason.

### 4. I never wrote down who it was for

The README was the `create-next-app` template. Nothing in the repository tells me who I
intended to sell it to.

→ This one cannot be fixed mechanically, so now I write the README first. That is why the
[per-project `CLAUDE.md` template](../kit/project-templates/nextjs-supabase-CLAUDE.md) opens with
"what is this service — the purpose, not a feature list".

---

That repository also still contains code that **fabricates RAG citations** — returning sources
like "Company Handbook 2024.pdf, relevance 0.95" with no RAG implemented at all. I wrote it to
make a demo look good and forgot it was there.

I do that in code I write myself. Draw your own conclusion about code a model writes — which is
where "make it declare what it filled in" above comes from.
