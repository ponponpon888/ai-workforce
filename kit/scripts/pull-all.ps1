#requires -Version 5.1
<#
.SYNOPSIS
    Bring every repository under a root directory up to date, without ever
    touching work in progress.

.DESCRIPTION
    Run it at logon. When you sit down, main is current everywhere.

    Rules, in order of importance:
      - Never stash. Never reset. Never checkout. Never merge.
      - A dirty working tree is skipped entirely.
      - A repository mid-rebase, mid-merge, mid-bisect or on a detached HEAD is skipped.
      - On the default branch with a clean tree: fast-forward only pull.
      - On a feature branch: remote fetch followed by local fast-forward advances the default
        branch without leaving the branch you are on. If that would not fast-forward,
        git refuses and the repository is reported, not forced.

    The whole point is that this can run unattended and still never lose a line of
    your work. If it cannot act safely, it reports and moves on.

    ASCII-only on purpose. See the encoding note in guard-sql.ps1.

.EXAMPLE
    .\pull-all.ps1 -Root C:\Dev

.EXAMPLE
    .\pull-all.ps1 -Root C:\Dev -Repos api,web,infra
#>

[CmdletBinding()]
param(
    [string] $Root = 'C:\Dev',

    # Explicit list of folder names under $Root. Omit to auto-discover every git repo.
    [string[]] $Repos,

    [string] $LogDir = $(Join-Path $Root '_logs'),

    # Keep this many days of logs.
    [int] $LogRetentionDays = 30,

    # Preview local decisions without fetching or writing logs.
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

# This runs unattended at logon, so git has to fail rather than wait. Without
# these, a repository whose credentials have expired stops on a prompt nobody is
# there to answer, and the run hangs silently instead of reporting. The second
# one covers Git Credential Manager, which pops a window of its own that
# GIT_TERMINAL_PROMPT does not reach.
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'never'
if ($DryRun) { $env:GIT_OPTIONAL_LOCKS = '0' }

# Validate before log creation, which otherwise creates a missing root too.
if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    Write-Error 'Root must be an existing directory. Nothing was updated.'
    exit 1
}

function Invoke-Git([string] $RepoPath, [string[]] $GitArgs) {
    $output = & git -C $RepoPath @GitArgs 2>&1
    return [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Output   = ($output | Out-String).Trim()
    }
}

# Explicit selections are checked together before any log or update is written.
$hasSelection = $PSBoundParameters.ContainsKey('Repos')
$requestedTargets = @()
if ($hasSelection) {
    if (-not $Repos -or $Repos.Count -eq 0) {
        Write-Error 'Repos must contain direct child directory names.'
        exit 2
    }
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Error 'git not found on PATH. Nothing to do.'
        exit 1
    }
    foreach ($entry in $Repos) {
        if ([string]::IsNullOrWhiteSpace($entry)) {
            Write-Error 'Repos must contain direct child directory names.'
            exit 2
        }
        $repoName = $entry.Trim()
        if ($repoName -eq '.' -or $repoName -eq '..' -or $repoName -match '[/\\:]') {
            Write-Error 'Repos must contain direct child directory names.'
            exit 2
        }
        $target = Join-Path $Root $repoName
        $valid = (Test-Path -LiteralPath $target -PathType Container) -and
            (Test-Path -LiteralPath (Join-Path $target '.git'))
        if ($valid) {
            $probe = Invoke-Git $target @('rev-parse', '--absolute-git-dir')
            $valid = $probe.ExitCode -eq 0
        }
        if (-not $valid) {
            Write-Error "Invalid requested repository: $repoName. Nothing was updated."
            exit 1
        }
        if ($requestedTargets -cnotcontains $target) { $requestedTargets += $target }
    }
}

# --- logging ---------------------------------------------------------------

if (-not $DryRun -and -not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}
$logFile = Join-Path $LogDir ('pull-all_{0}.log' -f (Get-Date -Format 'yyyyMMdd_HHmmss'))
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Log([string] $Message, [string] $Color = 'Gray') {
    $line = '{0}  {1}' -f (Get-Date -Format 'HH:mm:ss'), $Message
    Write-Host $line -ForegroundColor $Color
    if (-not $DryRun) {
        [System.IO.File]::AppendAllText($logFile, $line + [Environment]::NewLine, $utf8NoBom)
    }
}

# --- discovery -------------------------------------------------------------

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Log 'git not found on PATH. Nothing to do.' 'Red'
    exit 1
}


if ($hasSelection) {
    $targets = $requestedTargets
} else {
    $targets = Get-ChildItem -LiteralPath $Root -Directory |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName '.git') } |
        Select-Object -ExpandProperty FullName
}

Write-Log ("pull-all start  root=$Root  repos=" + (@($targets).Count))

$summary = @()

foreach ($repo in $targets) {
    $name = Split-Path $repo -Leaf

    # Resolve the real git dir: `.git` can be a file (worktrees, submodules).
    $gitDirResult = Invoke-Git $repo @('rev-parse', '--absolute-git-dir')
    if ($gitDirResult.ExitCode -ne 0) {
        Write-Log "$name : SKIP (not a git repo)" 'Yellow'
        $summary += [pscustomobject]@{ Repo = $name; Result = 'skip/not-a-repo' }
        continue
    }
    $gitDir = $gitDirResult.Output

    # --- refuse to act on anything mid-operation ---------------------------
    $inProgress = @('rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer', 'BISECT_LOG') |
        Where-Object { Test-Path -LiteralPath (Join-Path $gitDir $_) }

    if ($inProgress) {
        Write-Log "$name : SKIP (in progress: $($inProgress -join ', '))" 'Yellow'
        $summary += [pscustomobject]@{ Repo = $name; Result = 'skip/in-progress' }
        continue
    }

    $status = Invoke-Git $repo @('status', '--porcelain')
    if ($status.ExitCode -ne 0) {
        Write-Log "$name : FAILED reading working tree status -- $($status.Output)" 'Red'
        $summary += [pscustomobject]@{ Repo = $name; Result = 'fail/status' }
        continue
    }
    if ($status.Output) {
        Write-Log "$name : SKIP (dirty working tree)" 'Yellow'
        $summary += [pscustomobject]@{ Repo = $name; Result = 'skip/dirty' }
        continue
    }

    $branch = (Invoke-Git $repo @('rev-parse', '--abbrev-ref', 'HEAD')).Output
    if ($branch -eq 'HEAD') {
        Write-Log "$name : SKIP (detached HEAD)" 'Yellow'
        $summary += [pscustomobject]@{ Repo = $name; Result = 'skip/detached' }
        continue
    }

    # --- work out the default branch ---------------------------------------
    $head = (Invoke-Git $repo @('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')).Output
    if ($head -match '^origin/(.+)$') { $default = $Matches[1] } else { $default = 'main' }

    if ($DryRun) {
        if ($branch -eq $default) {
            Write-Log "$name : would pull --ff-only ($default)"
        } else {
            Write-Log "$name : would fetch origin $default and attempt local fast-forward (on '$branch')"
        }
        $summary += [pscustomobject]@{ Repo = $name; Result = 'dry-run' }
        continue
    }

    if ($branch -eq $default) {
        $r = Invoke-Git $repo @('pull', '--ff-only')
        if ($r.ExitCode -eq 0) {
            Write-Log "$name : ok ($default fast-forwarded)" 'Green'
            $summary += [pscustomobject]@{ Repo = $name; Result = 'ok' }
        } else {
            Write-Log "$name : FAILED ff-only pull -- $($r.Output)" 'Red'
            $summary += [pscustomobject]@{ Repo = $name; Result = 'fail/pull' }
        }
        continue
    }

    # Separate transport failure from a refused local fast-forward.
    $fetched = Invoke-Git $repo @('fetch', '--no-tags', 'origin', $default)
    if ($fetched.ExitCode -ne 0) {
        Write-Log "$name : FAILED fetch -- $($fetched.Output)" 'Red'
        $summary += [pscustomobject]@{ Repo = $name; Result = 'fail/fetch' }
        continue
    }
    $fetchedHead = Invoke-Git $repo @('rev-parse', '--verify', 'FETCH_HEAD^{commit}')
    if ($fetchedHead.ExitCode -ne 0) {
        Write-Log "$name : FAILED resolving fetched commit -- $($fetchedHead.Output)" 'Red'
        $summary += [pscustomobject]@{ Repo = $name; Result = 'fail/fetch' }
        continue
    }
    $commit = $fetchedHead.Output
    $r = Invoke-Git $repo @('fetch', '--no-tags', '.', "${commit}:refs/heads/${default}")
    if ($r.ExitCode -eq 0) {
        Write-Log "$name : ok (on '$branch', $default advanced)" 'Green'
        $summary += [pscustomobject]@{ Repo = $name; Result = 'ok/branch' }
    } else {
        $ancestry = Invoke-Git $repo @('merge-base', '--is-ancestor', "refs/heads/${default}", $commit)
        if ($ancestry.ExitCode -eq 1) {
            Write-Log "$name : $default not fast-forwardable, left alone -- $($r.Output)" 'Yellow'
            $summary += [pscustomobject]@{ Repo = $name; Result = 'skip/diverged' }
        } else {
            Write-Log "$name : FAILED local branch update -- $($r.Output)" 'Red'
            $summary += [pscustomobject]@{ Repo = $name; Result = 'fail/update' }
        }
    }
}

# --- wrap up ---------------------------------------------------------------

Write-Log '--- summary ---'
foreach ($s in $summary) { Write-Log ('{0,-28} {1}' -f $s.Repo, $s.Result) }

if (-not $DryRun) {
    Get-ChildItem -LiteralPath $LogDir -Filter 'pull-all_*.log' -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$LogRetentionDays) } |
        Remove-Item -Force -ErrorAction SilentlyContinue
    Write-Log "done. log: $logFile"
} else {
    Write-Log 'done. dry-run; no logs written.'
}

# Exit explicitly. Without this the script just ends, and $LASTEXITCODE is still
# whatever the last `git` call returned -- non-zero for any repository that was
# skipped or left alone, which is the normal path, not a failure. A scheduler or
# a CI step reading the exit code would see a run that did its job as failed.
#
# Non-zero only when something actually failed, which is what the Node twin does.
# Skips are the normal, safe path and must not read as failure.
exit $(if ($summary | Where-Object { $_.Result -like 'fail*' }) { 1 } else { 0 })
