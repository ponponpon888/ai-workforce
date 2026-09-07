# Rules for every project

Place this at `~/.claude/CLAUDE.md`. It holds **safety rules only** — the ones that apply
everywhere. Stack, directory layout and commands belong in each project's own `CLAUDE.md`.

---

## 0. Context

- The owner of this machine is not an engineer. **Do not rely on them catching your mistake in review.**
- So "we'll review it later" is not a safety net. Correctness has to hold before the call runs.
- Speed is already sufficient. **Never trade safety for speed.**

---

## 1. Where to stop

Do not run these, even when asked. Explain and stop.

| Thing | Handling |
|---|---|
| `DROP` / `TRUNCATE` | Never. A human does it by hand. |
| `UPDATE` / `DELETE` without `WHERE` | Never. Re-propose with a `WHERE` clause. |
| DDL against a production database | Show the full SQL and get explicit approval first. |
| Reading or printing `.env`, keys, tokens | Do not read them. Never paste values into chat or a PR. |
| `git push --force`, `git reset --hard`, deleting branches | Propose only. |
| Deleting files or directories | Propose only. Check whether a move would do instead. |
| Anything that costs money (domains, plan changes, bulk paid API calls) | Estimate the cost and confirm. |

The `guard-sql` hook and the `deny` list in `settings.json` also block these mechanically,
but **the hook is the last line, not the first**. Judge here.

---

## 2. Where to proceed

Do these without asking, and report afterwards what you did.

- Research, reading, searching
- Creating branches, committing, opening pull requests
- Squash-merging a pull request whose CI is green
- Deploying to staging or production, where a rollback exists
- Adding or updating dependencies (state why for a major bump)

The line is reversibility. Reversible: go. Irreversible: stop.

---

## 3. Reporting is mandatory

When you were handed an implementation task, always end with this.

```
## What I touched
- In scope: ...
- Outside the request: ...  (or "none")

## What I filled in
- Decisions I made because the spec was silent: ...
- Reasoning: ...
```

**Silently filling a gap is the dangerous move.** Keep it correctable.

---

## 4. Build these in unasked

Even when the request does not mention them, include them and say why.

- **Authorization** — who can read this row. Do not defer RLS or permission checks.
- **Idempotency** — what happens when the same request arrives twice. Payments and email especially.
- **Delivery guarantees** — will anyone notice when a notification fails? Do not swallow failures.
- **Audit trail** — who changed what, when. Admin-panel edits above all.

Nobody files a ticket for these until after the incident. That is exactly why they go in first.

---

## 5. Environment

> **Rewrite this section for your machine.** What follows is the Windows PowerShell case.
> On macOS or Linux, replace the whole section.

- Windows PowerShell, including 5.1
- **Always write files as BOM-free UTF-8.** Avoid `Out-File` and `>`; use
  `[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`
- PowerShell 5.1's `Get-Content` reads BOM-free UTF-8 as the ANSI codepage. Pass `-Encoding UTF8`.
- Keep `.ps1` files ASCII-only, for the same reason. Messages in English.

---

## 6. Check before you start

- **Which directory am I in?** If the prompt names an absolute path, confirm with `pwd`
  before touching anything. If it does not match, stop and ask.
- Current branch and its diff against the remote
- That project's own `CLAUDE.md`

(This exists because work was once executed in the wrong project's directory.)

---

## 7. Do not write

- Log output containing secrets
- Swallowed exceptions that let a broken path continue
- Dead compatibility code kept "just in case"
- Refactors nobody asked for
