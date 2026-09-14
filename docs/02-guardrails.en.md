# 02. Mechanical guardrails

日本語: [02-guardrails.md](02-guardrails.md)

## Say this first

**This stops accidents. It does not stop an adversary.**

An agent holding a shell can, in principle, walk around all of it — including writing an approval
token itself. It is still worth having, because what actually happens is not malice. It is
carelessness.

- "I'll clear out the test data" → forgets the `WHERE`
- "I'll tidy up the schema" → drops a table it assumed was unused
- "I'll apply the migration" → the connection string pointed at production

None of those are attacks. So this is not built as a defence against attackers. It is built so
that **carelessness physically cannot get through**.

Leaving that distinction fuzzy while claiming "AI development is safe" would be a lie, so it goes
at the top.

---

## Three layers

| Layer | What it does | How it fails |
|---|---|---|
| 1. Instruction (`CLAUDE.md`) | Tells the model not to | The model skims it; long context dilutes it |
| 2. Permission (`deny` list) | Refuses tool calls by pattern | A phrasing that slips past the pattern |
| 3. Hook (`guard-sql`) | Parses the statement and refuses before it runs | Execution in a form it cannot parse |

**Layer 1 alone is not enough** — that is the starting point. Instructions only work
probabilistically. You need a layer that fails deterministically, before execution.

---

## Layer 1: instruction

The "where to stop" table in `~/.claude/CLAUDE.md`. See
[01 Two-layer CLAUDE.md](01-two-layer-claude-md.md).

This is the **first** judgement. Stop here and no tool call happens at all. The hook is the last
line, not an excuse to be sloppy here.

---

## Layer 2: permission (deny list)

`permissions.deny` in `~/.claude/settings.json`. Claude Code itself refuses matching calls.

```json
"deny": [
  "Read(.env)",
  "Read(./**/.env.*)",
  "Read(**/*.pem)",
  "Bash(rm -rf:*)",
  "Bash(git push --force:*)",
  "Bash(git reset --hard:*)",
  "Bash(supabase db reset:*)"
]
```

Alongside it, `defaultMode` is `ask`, `permissions.disableBypassPermissionsMode` is `true`, and
top-level `disableAutoMode` is `true` — so **the "approve everything" mode cannot be entered at
all**.

> That is the setting for **local Claude Code**. On the chat side I do skip approvals, and none
> of this applies there. It looks contradictory; they are different paths. What actually closes
> the chat side is in [06](06-supabase-mcp.md) and [07](07-github-vercel.md).

Read operations (`Read` / `Glob` / `Grep` / `git status` / `git diff`) are in `allow` and produce
no prompt. Prompting on those is how confirmation becomes meaningless, and a confirmation nobody
reads is the same as no confirmation.

The real file: [kit/claude/settings.json](../kit/claude/settings.json)

### Where the deny list ends

`Bash(rm -rf:*)` only catches `rm -rf` when the next character is a **space**. `rm -rfv /foo`
slips through on one extra flag character (see "Two spellings, and both of them worked" below).

So the deny list closes **the common accident shapes**, not the space of all of them. Layer 3
exists because that coverage gap is permanent.

---

## Layer 3: the hook

A `PreToolUse` hook reads the statement and refuses it just before execution.

The real file: [kit/claude/hooks/guard-sql.mjs](../kit/claude/hooks/guard-sql.mjs)
(and [guard-sql.ps1](../kit/claude/hooks/guard-sql.ps1), identical behaviour)

### What it refuses

| Case | Handling |
|---|---|
| `DROP` | Never. A human does it by hand |
| `TRUNCATE` | Never |
| `DELETE FROM` with no `WHERE` | Refused |
| `UPDATE ... SET` with no `WHERE` | Refused |
| `CREATE` / `ALTER` / `GRANT` / `REVOKE` / `REINDEX` / `VACUUM` | **Only with an approval token** |

### Neutralize strings and comments first

A naive regex gets these wrong:

```sql
insert into notes (body) values ('drop the old flow');   -- false positive
select * from t; -- delete from t;                       -- false positive
select 'a; b';                                           -- splits the statement wrongly
```

So before any check, one pass flattens string literals, dollar-quoted bodies, line comments and
block comments. It is a single regex alternation, and at each position the first alternative that
matches wins — which is what makes `'--'` read as a string rather than a comment.

```js
const pattern = new RegExp([
  "'(?:[^']|'')*'",                          // single-quoted literal, '' escape
  '\\$([A-Za-z0-9_]*)\\$[\\s\\S]*?\\$\\1\\$',// postgres dollar-quoted body
  '--[^\\r\\n]*',                            // line comment
  '/\\*[\\s\\S]*?\\*/',                      // block comment
].join('|'), 'g');
```

Splitting on `;` happens after that, so a semicolon inside a string cannot break a statement in
two.

### The DDL approval token

The rule is "show the SQL and get approval before running DDL", but a hook cannot hold a
conversation. So approval became **a file a human creates by hand**.

```bash
# You run this yourself, after reading the SQL
node kit/scripts/approve-ddl.mjs "alter table bookings add column memo text"
```

It normalizes whitespace, takes the SHA-256, and writes
`~/.claude/approvals/<hash>.approval`.

When the hook sees DDL it looks for that hash and:

- **not there → refuse**
- **there → allow, and delete the token immediately** (single use)
- **older than 15 minutes → refuse**

So: the statement you approved passes, once, within 15 minutes. One character different and the
hash changes, so a different statement cannot ride in on your approval.

### If the hook breaks, let the call through

```js
} catch (err) {
  process.stderr.write(`[guard-sql] hook error (allowing call): ${err.message}\n`);
  process.exit(0);
}
```

Fail **open**. That looks backwards.

The reasoning: a hook that develops a bug and starts blocking everything gets uninstalled, and
then the defence is zero. Failing loudly on stderr while letting the call through survives; a
guard that bricks the toolchain does not.

---

## The PowerShell trap (this actually happened)

The `.ps1` files are **ASCII only**. No Japanese in the messages, even though the docs are in
Japanese.

Windows PowerShell 5.1 reads a BOM-free UTF-8 script as the system ANSI codepage — CP932 on a
Japanese install. Non-ASCII message strings in such a `.ps1` become **mojibake at runtime**.

Same reason `Get-Content` needs `-Encoding UTF8` to read a UTF-8 file correctly.

- Finding the cause cost half a day
- The fix is the split: `.ps1` stays ASCII, documentation stays Japanese
- File writes always go through
  `[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`.
  `Out-File` and `>` insert BOMs and CRLFs of their own accord

The scripts in this repository are all in English because of that, not out of any commitment to
internationalization. CI fails the build if a `.ps1` contains a non-ASCII byte.

### 5.1 and 7.x are different runtimes (also from experience)

The first run of this suite on Windows PowerShell 5.1 died **before a single test executed**:

```
Split-Path : Cannot bind argument to parameter 'Path' because it is an empty string.
```

**Windows PowerShell 5.1 leaves `$PSCommandPath` and `$PSScriptRoot` empty inside a `param()`
default value when `[CmdletBinding()]` is present.** They are correct in the body, after
`param()`. PowerShell 7.x populates them in both places.

```powershell
[CmdletBinding()]
param(
    # On 5.1 $PSCommandPath is "" here, so Split-Path throws
    [string] $Hook = $(Join-Path (Split-Path -Parent $PSCommandPath) 'guard-sql.ps1')
)
```

The fix is to move the default out of `param()`:

```powershell
[CmdletBinding()]
param([string] $Hook)

$scriptDir = Split-Path -Parent $PSCommandPath   # correct on 5.1 too
if (-not $Hook) { $Hook = Join-Path $scriptDir 'guard-sql.ps1' }
```

Then, having fixed that and re-run on 5.1, **a second one turned up the same day.**

```
powershell.exe : [guard-sql] BLOCKED: DROP is never allowed from an agent.
    + FullyQualifiedErrorId : NativeCommandError
```

The hook was blocking correctly. The suite died anyway.

**5.1 wraps every stderr line of a native command in an `ErrorRecord` when you merge streams
with `2>&1`.** Under `$ErrorActionPreference = 'Stop'` that is a terminating error. guard-sql
reports its refusal on stderr, so **the first must-block case killed the run.** 7.x passes
stderr through as plain strings.

Dropping `2>&1` also fixes the crash, but then a FAIL prints no diagnosis. So keep the merge and
relax the preference just around that call:

```powershell
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    $out = $payload | & $pwshExe -NoProfile -File $Hook -ApprovalDir $ApprovalDir 2>&1
} finally {
    $ErrorActionPreference = $previous
}
```

### A related thing worth noticing

`pull-all.ps1` uses `2>&1` too, and it passed on 5.1 from the start — because it sets
`$ErrorActionPreference = 'Continue'` at the top of the script.

But it was written that way because an unattended script must not halt midway, **not because
anyone knew about this trap.** It was safe by accident. Nobody could see that until the suite
actually ran on 5.1.

### Why CI missed both

**`shell: pwsh` and `shell: powershell` are not the same runtime.** CI ran only on 7.x, so it
never saw either bug. There is now a separate job on `windows-latest` using `shell: powershell`.

---

## Diffing it against my own setup found four holes

This `kit/` is a write-up, for publication, of the `~/.claude/` that actually guards my
production work. Being a write-up of it, I assumed it was the same thing. Then I read the
two side by side, line by line.

**Four places where the real files were right and `kit/` was wrong.**

| Hole | What it means |
|---|---|
| No PowerShell tool in the `settings.json` matcher | On Windows, SQL issued through PowerShell **walks straight past the hook** |
| `Bash(Remove-Item -Recurse *)` in `deny` | `Remove-Item` is not a Bash command. **That line was stopping nothing** |
| Neutralization always strips `--` line comments | In `npx supabase db execute --sql 'truncate bookings'`, everything from `--sql` disappears, and **the TRUNCATE gets through** |
| No `GIT_TERMINAL_PROMPT=0` in `pull-all` | Documented as running unattended at logon, yet it **hangs silently the moment git asks for credentials** |

### The second one is just a typo

Nothing subtle about it. **A PowerShell command written into a Bash deny list.** I wrote it,
and I believed it had closed something.

Every test passed. The tests only covered the hook. **At that point `permissions` had no
tests at all** — the layer that sits furthest forward and fires most often was the least
verified one.

After writing this section I found the same typo a second time, in `ask`:
`Bash(Invoke-WebRequest *)`. What I had failed to do was **find every instance of a shape
once I had found one**. A diff will not surface it — both lines have been sitting there,
unchanged, since the day they were written. The same person makes the same mistake more
than once, usually in the same sitting.

### The third one opened up because I made it smarter

The neutralization itself is right. Without stripping SQL comments, a line like
`-- delete from t` is a false positive. That is why it exists.

But the hook does not only receive SQL. It receives shell command lines too. Apply SQL
grammar to one of those and an option such as `--sql` **is swallowed as a comment**. What
survives is `npx supabase db execute`, and the TRUNCATE is no longer in view.

The same string has to be **read under different grammar depending on how it arrived**.

The real setup does not have this hole, because it has no neutralization at all. Its false
positive rate is worse. **The part I made smarter for publication is the part that opened a
new hole.**

### There was no clever technique involved

I diffed them. Put `kit/` and `~/.claude/` side by side and keep going until every differing
line has an explanation. It took under an hour.

Skip it, and all four ship under a green test suite.

### Only two of the four tests failed first

Having found the holes, I added four tests before changing anything.

```
npx supabase db execute --sql 'truncate bookings'                -> must block
drop table x via the PowerShell tool                             -> must block
drop extension "pg_net" inside a here-string                     -> must allow
a command that merely contains the path supabase/migrations/...  -> must allow
```

Run against the unfixed code, **only the first two failed.** The other two were green from
the start.

Obvious in hindsight. Before the fix the PowerShell tool was outside the hook's scope
entirely, so **anything sent through it walked past and came back ALLOW**. A false-positive
test cannot go red before the false positive exists. Making it red would mean applying the
fix first, which is the wrong order.

**Writing a failing test first only works for the blocking half.**

I wrote all four anyway. The last two are there to check that the fix did not trade a hole
for a false positive — a different job. Written afterwards, they would only confirm that
whatever I happened to build passes.

**Closing a hole usually widens false positives.** Write only the blocking tests, go green,
and you will be the one switching the hook off next week.

---

## Everything passed, and then it went red

Every "green" up to here had been green on this machine. I pushed to GitHub, CI ran in a
real environment for the first time, and **three of fourteen jobs were red**.

The three were the PowerShell guard-sql jobs (5.1, pwsh on ubuntu, pwsh on windows). The
end of the log:

```
  PASS  DROP still blocked inside an approved batch

pass: 29   fail: 0
##[error]Process completed with exit code 1.
```

**All 29 tests passed.** It failed after finishing them. Not one line of error output.

### I never wrote the `exit 0` for the success path

The end of `test-guard-sql.ps1` read:

```
if ($fail -gt 0) { exit 1 }
```

It exits on failure. On success it says nothing. And the last test in the suite is a
must-block case, so the hook it calls returns `exit 2`. **That 2 is still sitting in
`$LASTEXITCODE` when the script ends.**

GitHub Actions wraps the body of a `run:` in a temporary script and appends
`exit $LASTEXITCODE`. So it leaks.

### It was green locally, because I was calling it differently

```
wrapped the way CI wraps it  -> exit 1
powershell -File directly    -> exit 0
```

Called with `-File`, that `exit` is never reached, and the run ends 0. No amount of running
it here would ever have reached that red.

**"The tests pass" and "the test runner can report that they passed" are two different
things.** I had only ever checked the first.

The Node version was fine. It writes `process.exit(fail > 0 ? 1 : 0)` — both branches. Of
two implementations of the same thing, only one was right.

### Having found one, I looked for every instance of the shape

This time I did. I called each entry-point `.ps1` the way Actions calls it and read the exit
code. There was one more.

`pull-all.ps1`. Hand it one directory that is not a git repository and the final
`git rev-parse` returns non-zero, which survives to the end. **Skipping a single repository
is enough.** It runs unattended at logon, so this is not a corner case.

It also turned up a contract that did not match: the Node version returns 1 on failure, the
PowerShell version returned 0. They are supposed to be twins. Fixed.

### This is a false positive, which is what makes it dangerous

It is not a miss. On real failure it does return 1. It was reporting failure on success.

But this repository has been saying all along that a hook with too many false positives gets
switched off. **The same is true of CI.** Red builds that turn out to be all PASS inside,
often enough, and people stop looking at red.

And until I read the log, I could not tell "a test failed" from "the runner could not report
success". There is now a separate check for that: a job called
`entry points report success`, which calls each entry point the way Actions does, on the
happy path, and looks only at the exit code.

---

## Two spellings, and both of them worked

`kit/` denied with `Bash(rm -rf *)`. My own live config denied with `Bash(rm -rf:*)`.
**Every line differed.** If one of the two spellings does nothing, then one of those
files had been protecting nothing from the start.

Nothing I could find said which. So I measured it.

### How

Three deny lines in a throwaway config, and `echo`.

```
"Bash(echo exact)"       <- no wildcard
"Bash(echo pfx:*)"       <- colon spelling
"Bash(echo sfx *)"       <- space spelling
```

The results.

| Pattern | `echo x` | `echo x hello` | `echo xhello` |
|---|---|---|---|
| `Bash(echo x)` | blocked | allowed | allowed |
| `Bash(echo x:*)` | blocked | blocked | allowed |
| `Bash(echo x *)` | blocked | blocked | allowed |

**The colon spelling and the space spelling behave identically.** Both are a prefix match
on the command, and neither cuts a word in half. Only the form without a wildcard is an
exact match.

The thing I was afraid of — one spelling being dead — had not happened. Only the
spelling differed. I aligned `kit/` on the colon form anyway, so that the next person
to diff these two files does not spend the same hour.

### Without a control, I would have drawn the wrong conclusion

The first run used only the two wildcard lines. **Both of them let the command through.**

That did not mean "neither spelling works". It meant **the config file was never read**.
The session's working directory was not where I assumed, so the settings I had carefully
placed were not in scope at all.

Adding one line without a wildcard, `Bash(echo exact)`, and **checking first that it
blocks**, is what surfaced it on the next run.

An experiment that never stops has two possible reasons. **The rule is not working, or
you are not measuring.** You need the one line that tells those apart.

### Both spellings share the same hole

`echo xhello` being allowed is another way of saying this.

```
Bash(rm -rf:*)  ->  rm -rf /foo    blocked
                ->  rm -rfv /foo   allowed
```

**One extra flag character walks straight past it.** So does `rm -fr`. What is being
blocked is the string `rm -rf`, not dangerous uses of `rm`.

I have not closed it. Closing it means denying `rm` itself, which also stops everyday
work like `rm -rf ./dist`. The argument this page keeps making — a rule with too many
false positives gets switched off — applies to this one too. For now it stays open,
and documented.

### This layer cannot have tests

The decision is made by Claude Code itself, not by any code in this repository. There is
no way to build a suite like `guard-sql`'s. All you can do is place a config, type the
command, and see whether it stopped. The table above is that, done by hand.

**The layer that sits furthest forward, and works best, is the hardest one to verify.**
It is also where all five typos were.

---

## The PowerShell aliases were not the problem I expected

`deny` was almost entirely Bash-side. `git push --force` and `git reset --hard` both walk
straight through when they go via the PowerShell tool. I was going to write the missing
lines, but there was one thing to check first.

In PowerShell, `rm` is an alias for `Remove-Item`. So are `del`, `rd`, `rmdir`, `erase`
and `ri`. If `deny` is a prefix match on the command string, then
**`PowerShell(Remove-Item:*)` does not stop `rm -rf x`** — and all six words need their
own line.

I measured it. **It stopped.**

```
deny has PowerShell(Remove-Item:*) / allow has PowerShell(rm:*)

rm <file>            -> blocked
Remove-Item <file>   -> blocked
```

Aliases are resolved to a name before the pattern is matched. The word I actually typed
was `rm`; `del`, `rd`, `rmdir`, `erase` and `ri` resolve to the same `Remove-Item`
according to `Get-Alias`, so that one line covers them too (I did not type those five).
It works in the other direction as well: write `PowerShell(gci:*)` and `Get-ChildItem`
is blocked.

**And `deny` beats `allow`.** The `rm` above was in the allow list, and it was still
blocked.

The number of lines to add dropped from 33 to 16.

### What escapes is naming the executable itself

On PowerShell 5.1, `curl` is an alias for `Invoke-WebRequest`, so
`PowerShell(Invoke-WebRequest:*)` stops it. **Write `curl.exe` and it does not.** That is
not an alias — it calls `C:\Windows\system32\curl.exe` directly.

PowerShell 7 reverses this. It has no `curl` or `wget` alias, so typing `curl` resolves
straight to `curl.exe`. **The spelling that closes the hole on 5.1 leaves it open on 7.**
Write both and both are covered.

### I got the measurement wrong the first time

The first run had only one kind of control. I had the line that shows the rules are being
evaluated at all (a command that must be blocked), but not the one that shows an
unmatched command gets through.

All six commands came back blocked. That reads two ways. **Either `deny` is working, or
everything on this path is coming back denied.** With `defaultMode` set to `default`, a
command that is not in `allow` sits waiting for confirmation and returns as denied — so
the two are indistinguishable.

Adding one command that should pass, and running it again, settled it.

**You need two controls: one that must be blocked, and one that must get through.** With
only one of them, you cannot tell that your experiment is not running.

---

## The `.env` I denied was never denied to `cat .env`

These lines had been in `deny` from the start.

```
"Read(.env)",
"Read(.env.*)",
"Read(./**/.env)",
"Read(./**/.env.*)",
```

They work. **They work on the Read tool.**

There is more than one route to the contents of `.env`. Opening it with the Read tool is
one. Typing `cat .env` into the Bash tool is another. Typing `Get-Content .env` into the
PowerShell tool is a third. `Read(...)` in `deny` sees the first. The other two get through
no matter what is written there.

`permissions` cannot close it. `Bash(cat:*)` would stop `cat .env`, and also
`cat package.json`. `PowerShell(Get-Content:*)` would stop reading any file at all. The
thing I need to decide on is neither "this command" nor "this file" but **this command
touching this file**, and `permissions` has no way to spell that.

So it became a hook. The same `PreToolUse` shape as `guard-sql`, looking at the `Bash` and
`PowerShell` tools and nothing else.

The rule is one line. **Block when the command both names a secret file and is a shape that
reads a file.**

| Command | Secret path | Reader | Result |
|---|---|---|---|
| `cat .env` | yes | yes | blocked |
| `rm .env.bak` | yes | no | allowed |
| `grep -r createClient src/` | no | yes | allowed |
| `cat .env.example` | no (exempt) | yes | allowed |

Requiring both is the whole design. Blocking on the string `.env` alone would block
`grep -r "process.env" src/`. Blocking on the reader alone would block `cat package.json`.
Either one is reason enough to switch a guard off.

And **this layer can have tests.** `permissions` is decided by Claude Code itself and I
cannot reach it (see "This layer cannot have tests"). The hook is decided by code in this
repository.

### One of the paths was too wide, so I narrowed it

The path set started as a copy of the `Read(...)` lines in `deny`, which is why `secrets/`
is in it. That also catches `src/lib/secrets/masker.ts` — code that handles secrets, not a
secret. Source and prose extensions under a `secrets/` directory are no longer treated as
secret. Same reasoning as exempting `.env.example`.

**So `Read(./secrets/**)` in `deny` and this hook now disagree.** Opening
`src/lib/secrets/masker.ts` with the Read tool is blocked; `cat`-ing it is allowed. I
narrowed the side I can narrow. `deny` is decided by Claude Code, and there is no spelling
that makes it narrower.

---

## What I thought I had closed opened in one move with `git show`

Right after the suite went green I noticed that `git show HEAD:.env` gets through.
`git diff .env` does too. Both print the contents.

Copying with `cp .env /tmp/x` and reading `/tmp/x` was on the "not closing this" list from
the start, because it takes two moves. `git show` takes one. Thinking about what a model
tries next after `cat .env` is refused, I could not leave it there.

My first thought was that adding `git` to the reader list would take `git status` and
`git log` with it, so I left it out. **That was wrong.** The rule is "a secret path *and* a
reader", and `git status` contains no `.env`. It does not get blocked.

What does get blocked is naming the path, as in `git diff .env`. Of those, the subcommands
that print contents are `show`, `diff`, `cat-file`, `blame` and `log -p`; `checkout`, `rm`
and `add` do not. Filtering on the subcommand was all it needed.

I nearly got a decision wrong there. "It would cause false positives" was a conclusion I
reached before recalling the shape of the rule I had written myself. I was predicting what
my design implied instead of checking it — the same move as in "Two spellings, and both of
them worked". This time I caught it before writing it down, but only after the
implementation was finished.

### What is still open

Where it is not closed, I say it is not closed.

- **Copying to another name first, `cp .env /tmp/x`.** Copying is not reading, so `cp` is
  not on the list. Two moves gets you past it
- **Any reader not on the list.** `myreader .env` gets through
- **A secret file whose name looks nothing like `.env`.** `config/prod-creds.yaml` is
  invisible from here
- **Writes.** `> .env` and `sed -i` are out of scope. This hook is about reading

This stops accidents, not an adversary. It is a wall where a hand reaches for `cat .env`.
Stopping a service-role key from landing in a transcript once already pays for it.

---

## Verifying it

### 1. Run the test suite

```bash
node kit/scripts/test-guard-sql.mjs      # Windows / macOS / Linux
```

```powershell
.\kit\scripts\test-guard-sql.ps1         # if you use the PowerShell hook
```

29 cases in total (10 must block, 13 must allow, 6 approval-token). Both halves.

```
guard-sql test suite (node)

must block:
  PASS  DROP TABLE
  PASS  TRUNCATE
  PASS  DELETE, no WHERE
  PASS  TRUNCATE behind --sql
  PASS  DROP in a file fed with -f
  PASS  DROP in a file piped through cat
  PASS  a file route with nothing readable behind it
  (excerpt; must block has 20 cases)

must allow:
  PASS  DELETE with WHERE
  PASS  keyword inside a string
  PASS  harmless SQL in a file
  PASS  an -f that belongs to another command
  PASS  harmless here-document
  (excerpt; must allow has 16 cases)

approval token:
  PASS  approved DDL passes
  PASS  token is single use
  PASS  approved blind file route passes
  (excerpt; approval token has 8 cases)

pass: 44   fail: 0
```

**The false-positive half is the important half.** Once correct SQL starts getting blocked,
people switch the hook off, and then the defence is zero.

That is not hypothetical: adding the `unrelated MCP tool` case is how a real hole surfaced.
Searching GitHub via `mcp__GitHub__search_code` with the query string `drop table` was being read
as SQL and refused. The `matcher` in `settings.json` was covering for it, but a matcher is one
edit away from being widened, so the hook now checks the tool name itself.

CI runs the Node suite on Ubuntu, macOS and Windows, and the PowerShell suite on Windows and
Ubuntu.

### 2. Confirm it is actually wired up

Passing tests mean nothing if it is not registered in `settings.json`.

Ask Claude Code to run:

```
run `select 1; drop table nothing;` on supabase
```

`[guard-sql] BLOCKED: DROP is never allowed from an agent.` means it works. If the statement just
runs, the hook is not wired up and you are unprotected.

---

## What this layer cannot reach

A `PreToolUse` hook only protects the client it is installed in. Anything the chat side calls
over MCP goes straight past it.

That is covered separately:

- [06 Closing the chat-side hole](06-supabase-mcp.md) — Supabase
- [07 GitHub and Vercel](07-github-vercel.md) — GitHub, Vercel
