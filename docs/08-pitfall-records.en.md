# 08. Making pitfalls machine-readable

日本語: [08-pitfall-records.md](08-pitfall-records.md)

This repository's pitfalls were written as prose for a long time. That is fine to read, but it
causes two problems.

1. **No checking tool can reach them.** The docs may say "if the `grammar === 'shell'` branch
   disappears, whatever follows `--sql` vanishes again", but nothing watches for it
2. **Confidence gets mixed together.** "I measured this in my own environment", "I derived it
   from another observation", "the official documentation says so" and "this was asserted but
   never checked" all sit in the same paragraph

`data/pitfalls/` exists to solve those two things and nothing else. It does not replace the
prose. The docs still carry the story; a record carries only "what, at what confidence, and
whether it is closed right now".

---

## Where things live

| | |
|---|---|
| `data/pitfalls/` | Pitfalls of this repository's tools and environment. One file per pitfall |
| `data/app-pitfalls/` | Pitfalls on the application side. Same schema. Still empty |
| `data/pitfalls/_schema.json` | The definition itself. The validator reads it and works from it |
| `data/pitfalls/_template.json` | The skeleton to copy when adding one |
| `data/pitfalls.index.json` | Generated, and committed. CI regenerates it and fails on a diff |

Files beginning with `_` are not records.

**Why this is not one file holding an array** is written up in a
[case study](case-studies/beauty-matching.md). A single large ledger became unwritable at
270KB, and eleven changes went unrecorded. With one file per pitfall, adding one from an issue
means placing one file, and it does not collide with other PRs.

---

## Confidence has four values

| Value | Meaning |
|---|---|
| `measured` | Measured in my own environment. The steps are in `repro` |
| `inferred` | Derived from quoted code or configuration. No record of running anything |
| `documented` | The official documentation says so. A URL is in `sources` |
| `unverified` | Asserted, with neither evidence nor derivation written down |

**When in doubt, go lower.** Even where the original prose said "measured", it is `unverified`
unless how it was measured is written down. That is not to doubt the writer; it is to **leave
a place where it can be checked again later**.

And the convention is enforced by machine. If "実測", "測定した", "検証済み", "確認済み" or
"measured" appears in `summary`, `fix` or `why_not_closed`, the validator fails unless
`confidence` is `measured` (rule R11). `title` is exempt: policing a title that simply quotes a
docs heading would only make the thing unpleasant to use.

---

## The measurement environment and `"unrecorded"`

A `measured` record carries an `environment`. Five fields are required.

```json
"environment": {
  "os": "unrecorded",
  "shell": "unrecorded",
  "shell_version": "unrecorded",
  "claude_code_version": "unrecorded",
  "node_version": "20"
}
```

When a value is not known, write **`"unrecorded"` rather than guessing**. It cannot be
omitted, because then "forgot to write it" and "there is no record" become indistinguishable.

Not knowing the environment and not having measured are different things. So a record stays
`measured` even when its environment is entirely `"unrecorded"`. **Freshness is a separate
axis.**

**`measured_on` is the exception: it does not take `"unrecorded"`.** A real date
(`YYYY-MM-DD`) is required. A record with no measurement date cannot be judged stale. A record
that cannot be picked up as "worth re-measuring" when its subject moves cannot sit on the
freshness axis at all. If no date comes out, it is not treated as a measurement and the
confidence goes down.

### `stale_risk`

A derived value computed while building `data/pitfalls.index.json`. It is not written into a
record.

| Value | When |
|---|---|
| `unknown_version` | `layer` is `permissions` or `hook` and `claude_code_version` is `"unrecorded"` |
| `ok` | The environment is recorded, or that layer does not depend on the Claude Code version |
| `not_applicable` | Not a measurement, so there is no environment to go stale |

`permissions` and `hook` are singled out because **what is being measured is Claude Code
itself**. A `deny` behaviour measured on an unknown version cannot be claimed to hold now. A
hand-written "last confirmed on" becomes a lie the day after it is written, so it is computed
instead.

---

## Kind, and the state of the response

| `kind` | Meaning | `status` |
|---|---|---|
| `trap` | Step into it and it becomes an accident | **Required** |
| `limitation` | A limit that cannot be closed, or is not yet understood | **Required** |
| `behaviour` | Not a hole; behaviour worth knowing | **Must not be present** |

`status` has three values: `closed` (closed it), `open_recorded` (recorded as an open hole) and
`untouched` (not addressed). `closed` requires `fix`, `open_recorded` requires
`why_not_closed`. In other words, **leaving a hole open makes you write down why**.

`behaviour` carries no `status` because a record such as "deny beats allow" should not be
counted as an unaddressed hole.

---

## `severity` is not a measurement

`severity` (`high` / `medium` / `low`) is **how heavily the writer judged that pitfall**. It is
neither measured nor quoted from anywhere. It is completely independent of `confidence`: an
`unverified` hole can carry `high` (looks dangerous, not checked yet) and a `measured`
behaviour can carry `low`. Being confident and being serious are unrelated.

So `severity` carries no claim gate (R11) -- there would be no point. And whoever is counting
should not read the distribution of `severity` as an indicator of how dangerous this repository
is. For that, read `status` and `stale_risk`.

**`severity` was assigned by Claude throughout.** No human confirmed it at the time each record
was written. Revisit and change it freely; that is what the axis is for.

---

## `origin` -- where it is written up

```
"origin": "docs/02-guardrails.md#3-つ目は賢くしたせいで空きました"
```

A file path and a heading anchor. The validator checks that the file exists, that the anchor
matches a heading in that file, and that **it is not shaped like a line number**. Line numbers
shift silently as soon as one line is added. If a heading changes, CI goes red.

### When there is no prose yet

Make "prose first" a rule and **a three-line heading stub passes it.** A stub and real prose
are indistinguishable to a machine. So the rule quietly degrades into a formality, and the docs
grow fat with stubs. The escape hatch is therefore provided in the open.

| `origin` | When to use it |
|---|---|
| `docs/02-guardrails.md#heading` | Prose exists. Both file and anchor are checked |
| `issue:42` | A report is the source. An issue number in this repository |
| `record` | This record is the first appearance. Not written anywhere yet |

The last two are not free. The index derives `has_prose: false` and counts them in
`counts.without_prose`. **How many holes exist only in the data and not in the docs** is
printed every time. If that keeps climbing, the docs have stopped keeping up with the data.

There is one trap in the ordering. `issue:42` ends in digits after a colon, so **the line-number
check eats it first** (`:[0-9]+$`). The shape test comes first, and the line-number check
applies only to the prose shape. A near miss such as `issue:0` or `issue:abc` is reported as
"not shaped like an issue", not "that is a line number", so nobody goes looking in the wrong
place.

---

## `detection` -- what a checking tool reads

```json
"detection": {
  "checkable": true,
  "kind": "file-content",
  "target": "kit/claude/hooks/guard-sql.mjs",
  "pattern": "grammar === 'shell'",
  "expect": "present",
  "message": "シェル文法の分岐が消えると、--sql の後ろが再びコメント扱いで消える。"
}
```

`expect` is the point: it distinguishes `present` (red if absent) from `absent` (red if
present). Without it a pattern alone does not say which direction is wrong, and the data is
unusable.

For `checkable: false`, `note` says why a machine cannot look at it.

The `permissions` layer is nearly all of these, because what decides the outcome is Claude Code
itself, not code here ([02](02-guardrails.en.md)).

Records with `checkable: true` are flattened into the index's `checks` array. An outside tool
only has to read that.

`node kit/scripts/lint-pitfalls.mjs` runs the checks carried by every `checkable: true` record.
It separates passes, violations and undecidable cases, and shows how many records cannot be
checked automatically (the number grows with the records, so it is not written here). For the
scope of the checks and the exit codes, see
[11. Static checking of pitfalls](11-pitfall-linter.md) (Japanese).

---

## Adding one

1. Copy `data/pitfalls/_template.json` to `data/pitfalls/<id>.json`
2. Fill it in. **Delete** the keys you do not use; leftover keys are an error
3. Validate, and rebuild the index

For an observation not yet written up in the docs, `origin` is `record` (first appearance) or
`issue:<number>` (a report is the source). **You do not have to write the prose first.** Prose
can follow.

```bash
node kit/scripts/validate-pitfalls.mjs
node kit/scripts/test-validate-pitfalls.mjs
node kit/scripts/build-pitfall-index.mjs
```

CI (the `pitfalls` job) does the same and goes red if the index comes out different. Adding a
record and forgetting to rebuild the index leaves checking tools reading yesterday's data, so
that is stopped by machine.

Reporting from an issue alone is fine too; turning it into a record is our job
→ [pitfall report template](https://github.com/ponponpon888/ai-workforce/issues/new?template=pitfall.yml)

---

## The list of checks

`rules` in `_schema.json` is the source of this table.

| | |
|---|---|
| R01 | The file name matches `<id>.json` |
| R02 | Required fields are present and no unknown field is |
| R03 | Types and enum values are valid |
| R04 | `id` matches `^[a-z][a-z0-9]*-[0-9]{3}$` |
| R05 | `measured` ⟺ `measured_on` / `environment` / `repro` are all present |
| R06 | `environment` has exactly 5 fields, each a value or `"unrecorded"` |
| R07 | `documented` has at least one `sources` entry |
| R08 | `inferred` has at least one `inferred_from` entry |
| R09 | `behaviour` forbids `status`; `trap` / `limitation` require it |
| R10 | `closed` requires `fix`; `open_recorded` requires `why_not_closed` |
| R11 | Only a `measured` record may claim to have measured |
| R12 | Everything `related` points at exists |
| R13 | `origin` has a known shape; in the prose shape the file exists and is not a line number |
| R14 | The `origin` anchor matches a heading in that file (prose shape only) |
| R15 | `checkable` requires `target` / `pattern` / `expect` |
| R16 | `measured_on` is a real date (`YYYY-MM-DD`); `"unrecorded"` does not pass |
| R17 | The file parses as JSON and is an object |
| R18 | `id` is unique across all records |

There is at least one counter-example per rule, and **the rule name is checked too**. A
validator that failed everything with "something is wrong" would otherwise pass those tests.

---

## Things to state plainly

- **The docs have not kept up with the data.** There are always some records whose `origin` is
  `record` (first appearance), meaning the prose does not exist yet. The number is in
  `counts.without_prose` in `data/pitfalls.index.json`. If it keeps climbing, the docs have
  stopped keeping up with the data.
- **Some records have an `environment` whose fields are all `"unrecorded"`.** For the older
  ones, the measurement date was got out of whoever measured it and added to the docs, but the
  OS, the shell and the `claude_code_version` were recorded nowhere. Only the ones written
  while measuring are filled in. `claude_code_version` is `"unrecorded"` for most records, so
  most `permissions` and `hook` records start at `stale_risk: unknown_version`.
- **The positive tests could not be made to fail first.** For the counter-examples, it was
  confirmed up front that all of them fail against a validator holding no rules at all. The
  positive cases cannot be made to fail first in principle, because "a validator that does
  nothing accepts a valid record". What [02](02-guardrails.en.md) says -- that only the tests
  on the blocking side can be made to fail first -- shows up here unchanged.

### Why counts are not written on this page

This page used to carry counts in the prose, such as "only 12 records so far" and "140
candidates". Every added record made those a lie, and they did become lies.

The counts live in `data/pitfalls.index.json`. It is generated, so rebuilding it after adding a
record always makes it agree. CI rebuilds it and goes red on a diff.

```bash
node -e "const j=require('./data/pitfalls.index.json'); console.log(j.counts)"
```

A number written into prose can be a lie the day after it is written. That is the same reason
`measured_on` was not made a hand-written "last confirmed on".

**A measurement recorded with its date and the commit it ran against is a different thing.**
[17. Integration status](17-integration-status.md) (Japanese) records "measured on this date,
against this commit, in this environment", so it is not a lie when today's counts differ.
Rewriting those numbers would destroy the record instead.

The distinction is whether the sentence says "how many there are now" or "how many there were
when this was measured". Leave the first to the generated file; freeze the second with its date
and its subject.
