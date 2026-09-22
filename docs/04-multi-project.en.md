# 04. Running several projects alone

日本語: [04-multi-project.md](04-multi-project.md)

Hold four or five repositories by yourself and more of your time goes to
**remembering which one is in what state** than to writing code.

This page is about getting that time close to zero.

---

## Everything is up to date by the time you open the laptop

Forgetting `git pull` first thing and stacking work on a stale `main` was the most common
accident. So it runs from the task scheduler a minute after logon.

The scripts: [kit/scripts/pull-all.mjs](../kit/scripts/pull-all.mjs) (Windows / macOS / Linux)
/ [kit/scripts/pull-all.ps1](../kit/scripts/pull-all.ps1) (PowerShell)
/ [kit/scripts/pull-all.sh](../kit/scripts/pull-all.sh) (POSIX shell)

### What it will never do

These four are what the script protects:

- **No `stash`**
- **No `reset`**
- **No `checkout`**
- **No `merge`**

An unattended script that touches the working tree will destroy work eventually. There is
endless room to make it "smarter"; all of it was left out.

### What it does

| State | Action |
|---|---|
| Working tree is dirty | **Skip**. Do nothing |
| Mid rebase / merge / cherry-pick / revert / sequencer / bisect | **Skip** |
| Detached HEAD | **Skip** |
| On the default branch and clean | `git pull --ff-only` |
| On a working branch | `git fetch origin main:main` |

The last row is the point. `git fetch origin main:main` **advances the local `main` without
being on it**. It moves no checkout at all, so the branch you are working on is untouched.
And when it cannot fast-forward, git refuses, so nothing is ever forced.

Develop on a working branch, keep `main` current anyway. That was the state worth having.

Since it runs unattended, git must never stop to ask for credentials. The script sets
`GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never` at the top. The first silences the
terminal prompt, the second the window Git Credential Manager pops up on Windows. A
repository whose credentials expired fails and lands in the log instead of hanging silently.

### Logs

Every run writes `_logs/pull-all_<timestamp>.log`, deleted automatically after 30 days.

Without logs you cannot notice that an unattended script has stopped working. Everything is
recorded, "skipped today" included.

### Proving it destroys nothing

The reason to trust a script that runs unattended should be tests, not an impression from
reading the code.

```bash
node kit/scripts/test-pull-all.mjs              # Node
node kit/scripts/test-pull-all.mjs --target ps  # PowerShell (the same tests)
node kit/scripts/test-pull-all.mjs --target sh  # POSIX shell (the same tests)
```

git is not mocked. A **real bare origin and six real clones** are built, each put in a
different state, and the script is actually run against them.

| Clone | State |
|---|---|
| clean-on-main | on `main`, clean, origin one commit ahead |
| dirty | uncommitted changes |
| feature-branch | on a working branch holding its own commits |
| detached | detached HEAD |
| mid-rebase | stopped **in the middle of a genuinely conflicting rebase** |
| diverged | local `main` holds a commit origin does not |

And after the run, this is what gets checked.

```
destroys nothing:
  PASS  dirty repo: uncommitted work intact
  PASS  dirty repo: HEAD did not move
  PASS  dirty repo: still dirty (nothing was stashed)
  PASS  no stash was ever created
  PASS  detached HEAD: untouched
  PASS  mid-rebase: still mid-rebase
  PASS  mid-rebase: HEAD did not move
  PASS  diverged main: local commit not discarded
  PASS  diverged: HEAD did not move
```

**The half that matters is the "did nothing" half.** For a script that runs silently first
thing in the morning, "it did not touch what it must not touch" counts for more than "it
pulled correctly".

The same tests run against all three implementations -- Node, PowerShell and POSIX shell --
so the behaviour cannot drift apart as the implementations do. CI runs them on Ubuntu, macOS
and Windows.

### When you do not want Node on the logon path (the POSIX shell version)

`pull-all.sh` takes the same options, writes the same log lines and returns the same exit
codes as the Node version. It needs only `/bin/sh` (dash, bash or ash) plus `git`, `find`,
`sed` and `tr`.

```bash
sh kit/scripts/pull-all.sh --root ~/Dev --quiet
```

For cron, use this one.

```cron
@reboot sleep 60 && /bin/sh ~/Dev/ai-workforce/kit/scripts/pull-all.sh --root ~/Dev --quiet
```

**Exactly one difference is deliberate.** Old logs are deleted with `find -mtime`, so the
cutoff is measured in whole days (the Node version compares milliseconds). Logs go on the
same day, but not within the same minute. There is no portable way inside POSIX to compute
"N days ago", and cleaning up logs is not worth failing a run over -- the Node version's own
comment says as much -- so the difference was left in.

### What porting found: only the PowerShell version skipped dot-prefixed folders

Running a third implementation against the same fixtures showed that **repository folders
beginning with a dot**, such as `.dotfiles`, were not being updated by the PowerShell version
alone.

```
node    .dotrepo=updated  has space=updated  plain=updated
sh      .dotrepo=updated  has space=updated  plain=updated
pwsh    .dotrepo=STALE    has space=updated  plain=updated
```

The cause is that `Get-ChildItem -Directory` does not return dot-prefixed entries on Unix, or
hidden-attribute entries on Windows, by default. Node's `readdirSync` returns both, so the
set of repositories each implementation worked on had drifted apart. `-Force` brings it into
line, pinned by a test that runs against all three
([shell-003](../data/pitfalls/shell-003.json)).

Half the value of going from two implementations to three was seeing exactly this kind of
"only one of them differs".

### Registering it

**Windows (Task Scheduler)**

```powershell
$a = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\Dev\ai-workforce\kit\scripts\pull-all.ps1" -Root C:\Dev'
$t = New-ScheduledTaskTrigger -AtLogOn
$t.Delay = "PT1M"
Register-ScheduledTask -TaskName "AIWF pull-all" -Action $a -Trigger $t
```

The `PT1M` delay avoids running before the network is up and failing everything.

**macOS / Linux (cron)**

```cron
@reboot sleep 60 && /usr/bin/node ~/Dev/ai-workforce/kit/scripts/pull-all.mjs --root ~/Dev --quiet
```

On a machine without Node, replace that line with `pull-all.sh` (above).

The `sleep 60` is there for the same reason.

---

## Not noticing that local is behind

Working by pushing to GitHub straight from Claude Code leaves **only the local repository
behind**.

One project sat 17 commits behind locally before anyone noticed. The pushing side is current,
so nothing goes wrong -- until the next time you start working locally.

`pull-all` is a countermeasure for this too.

---

## Working in the wrong project

There has been an accident where work meant for `musubu` was carried out in
`hanami-nail-prototype`.

The reason is simple: both are Next.js App Router plus Supabase, so it **works convincingly
for a while**.

Two countermeasures, both cheap, so do both.

1. **Put the absolute path at the top of the prompt** ([03](03-division-of-labor.en.md))
2. **Put "check `pwd` matches before working" in the shared `CLAUDE.md`**

This is not the kind of accident that being careful prevents. Close it with a mechanism.

---

## Each project's CLAUDE.md as the place memory lives

What gets lost first across several projects is **why things are the way they are**.

Why you chose that implementation three months ago is not visible in the code. So each
project's `CLAUDE.md` records "what not to touch" and "known pitfalls".

That is for the AI and, equally, **for yourself three months from now**. Neither of you
remembers.

## Argument checking in the Node version

`pull-all.mjs` catches malformed arguments before creating a log or running Git, and stops
with exit code 2. The accepted options are `--root`, `--repos`, `--log-dir`,
`--retention-days`, `--dry-run` and `--quiet`. Options that take a value want it as the next
argument, separated by a space. Unknown options, a repeated option, an empty value and extra
positional arguments are all rejected.

`--repos` takes comma-separated folder names directly under the root. Empty elements, `.`,
`..`, path separators and colons are refused. This is a check on the argument's shape; it
does not constrain where a symbolic link points. `--retention-days` is limited to a safe
integer of 1 or more -- fractions, negatives and 0 are rejected.

```powershell
node kit/scripts/pull-all.mjs --root C:\Dev --repos api,web --retention-days 30 --dry-run
```

Exit codes: 0 for a normal finish or a safe skip, 1 for a failed update, 2 for an argument
error in the Node version. This check passed 39 cases on Linux / Node. **The PowerShell
version's argument handling was not changed here.**

## Checking the target folder first

Both the Node and PowerShell versions confirm the root is an existing directory before
creating a log. Given a path that does not exist, or a regular file, they explain and stop
with exit code 1. That prevents log creation from bringing a wrong target folder into
existence and then finishing successfully with zero repositories updated. It does not
guarantee read permission on the folder, nor cover a race where the path changes after the
check. The post-change suite passed 41 cases on Linux / Node. **The PowerShell version was
not run for this change.**

## Log retention under dry-run

The Node version's `--dry-run` prints what it would update and creates no log file and no log
directory. It neither appends to an existing log nor deletes logs past the retention period.
An earlier version created logs and deleted old ones even under dry-run. Because `--quiet`
also suppresses the normal output, leave it off when you want to see the plan. To stop Git
from updating its index opportunistically, dry-run sets `GIT_OPTIONAL_LOCKS=0`. In the
PowerShell version, `-DryRun` likewise prints the plan without fetching, updating branches, or
creating or deleting logs.

```powershell
.\kit\scripts\pull-all.ps1 -Root C:\Dev -Repos api,web -DryRun
```

It does not contact the remote, so it does not confirm whether a fast-forward would actually
work or whether authentication would succeed. **Verification of the PowerShell version is
incomplete.** The post-change Linux / Node suite passed 44 cases.

## When the working state cannot be inspected

If `git status` fails -- a corrupt Git index, for instance -- the run records `fail/status`
and neither fetches nor updates that repository. The overall exit code becomes 1. This is
kept distinct from `skip/dirty`, which means uncommitted changes were detected correctly. The
index is not repaired automatically and the original files are left alone. Both the Node and
PowerShell versions were changed; the Linux / Node check passed 47 cases. **PowerShell was not
run.**

## Checking targets named by hand

With `--repos`, every named target is confirmed to be a directory, to contain `.git`, and to
have a management directory Git can resolve -- before any log is created or anything is
updated. A name that does not exist, a plain folder, or a broken `.git` stops the whole run
with exit code 1. The same name given twice is collapsed into one. Under auto-detection, plain
folders mixed in are fine. This is a pre-flight check on updating; it is not a mechanism for
rolling everything back when the network fails, nor for preventing a race where a path
changes. The same pre-flight check was added to the PowerShell version's `-Repos`, which takes
an array, as in `-Repos api,web`; empty names and names containing a path separator are
refused. **Running it under PowerShell itself is unverified.** The post-change Linux / Node
tests passed 51 cases.

## A clean working tree is not enough if an operation is unfinished

A repository still holding `REVERT_HEAD` or a `sequencer` is skipped as `skip/in-progress`
too. After resolving a conflict, for example, there may be no diff while the Git operation is
still unfinished. The automatic update does not clear that state, and does not fetch or update
branches either. A genuinely conflicting revert returned to the same content as HEAD, and a
placed sequencer state, were both added to the shared tests.

## A dirty check that does not depend on Git's display settings

The dirty check passes `--untracked-files=all --ignore-submodules=none` explicitly. Even with
`status.showUntrackedFiles=no` or `submodule.<name>.ignore=all` configured, untracked files
and changes inside submodules are detected, and the run stops at `skip/dirty` before fetching.
This check does not list files ignored through `.gitignore` and the like. Your stored Git
configuration is not modified.

## Stopping when a log cannot be saved

If creating the log directory or appending to the log fails, the run prints the error and
stops with exit code 1. When the first log fails, no repository is updated at all. For a log
error after updating has started, the remaining work stops, but updates already completed are
not rolled back. `--dry-run` / `-DryRun` write no log, so they never reach this path.

## Log retention days in PowerShell

`-LogRetentionDays` takes 1 or more. Zero or a negative number is rejected with exit code 2,
and neither logs nor repository updates are started. The default is 30 days.

## When the current branch cannot be read

Where reading the current branch errors -- an initial state with no commits, for instance --
the run reports `fail/branch`. That repository is neither fetched nor updated, the remaining
targets are still processed, and the overall exit code becomes 1. This stops an error message
from being treated as a branch name.
