# 01. The two-layer CLAUDE.md

日本語: [01-two-layer-claude-md.md](01-two-layer-claude-md.md)

## The conclusion

| File | Location | What goes in it | How often it changes |
|---|---|---|---|
| Shared | `~/.claude/CLAUDE.md` | **Safety rules only** | Almost never |
| Per project | `<project>/CLAUDE.md` | **Stack and local circumstances only** | Often |

Do not mix them. That is the whole idea.

---

## Why split them

At first the safety rules lived in each project's `CLAUDE.md`. That broke almost immediately.

The reason is mundane: **a per-project file gets edited constantly.** You add a library, you move
a directory, and while you are in there the safety lines quietly go stale — differently in each
project.

And the worst part: **a project you create tomorrow has no safety rules in it at all.** A new
project is where accidents are most likely, and that is exactly where the file starts empty.

Safety rules do not change. The stack does. Two things with different update frequencies do not
belong in the same file. That is all this is.

---

## What goes in the shared layer

`~/.claude/CLAUDE.md` — applies to every project, unconditionally.

Four kinds of thing, and nothing else:

1. **Where it must stop** (`DROP`, an `UPDATE` with no `WHERE`, reading `.env`, force push, ...)
2. **Where it may proceed** (anything reversible needs no confirmation)
3. **What it must report** (what it touched, what it filled in, every time)
4. **Environment constraints** (PowerShell, BOM-free UTF-8, no non-ASCII in `.ps1`)

The real file: [kit/claude/CLAUDE.md](../kit/claude/CLAUDE.md)

**What does not go in it:** the tech stack, npm scripts, directory layout, URLs. Put those in the
shared file and it grows with every project you add, until nobody reads it.

---

## What goes in the project layer

`<project>/CLAUDE.md` — applies only while that project is open.

Template: [kit/project-templates/nextjs-supabase-CLAUDE.md](../kit/project-templates/nextjs-supabase-CLAUDE.md)

The most valuable section in this layer is not the feature list or the architecture diagram. It is
**"known pitfalls"**.

A real example:

```markdown
## Known pitfalls

- Emit JSON-LD from a server component as a plain `<script>`. `next/script`'s `<Script>` injects
  on the client, so it never appears in the SSR HTML and never reaches an AI crawler that does not
  run JS. (FAQ structured data was missing from the HTML for months before anyone noticed.)

- `metadataBase` in `app/layout.tsx` is the apex domain, but the site is actually served from www.
  Canonical URLs are written as absolute www URLs to work around it.
```

This is where a pitfall you already hit goes, so the AI does not walk into it a second time.

Honestly: I have not filled this section in myself. Two of the three services I run do not have
pitfalls written in their `CLAUDE.md` (as the [case studies](case-studies/) say). I am in no
position to show you a number for how well it works. **I think it should be done, and I have not
done it** — that is the accurate statement.

---

## Operating notes

**Keep the shared file short.** Past 200 lines, something project-specific has crept in.

**Do not restate safety rules in a project file.** Restate them and one copy gets updated while
the other does not. A rule that contradicts itself is worse than no rule.

**Write the pitfall the day you hit it.** Leave it for later and the cause fades, and all that
survives is "something didn't work". That does not stop it happening again.
