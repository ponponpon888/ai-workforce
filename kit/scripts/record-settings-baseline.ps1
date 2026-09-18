#requires -Version 5.1
<#
.SYNOPSIS
    Record (or re-record) the "known good" copy of settings.json that
    guard-config.ps1's SessionStart check compares against on every launch.

.DESCRIPTION
    Run this yourself, after reading the diff below, whenever you have
    deliberately hand-edited settings.json. install.ps1 already records the
    first baseline for you at install time; this script is only for the
    edits you make afterward.

    Why this has to run outside Claude Code: known-good/ is one of
    guard-config's protected paths, so a Claude-Code-mediated Edit/Write or
    an obviously write-shaped shell command against it is refused. Running
    this script from an interactive Bash/PowerShell call is not blocked the
    same way -- the same accepted gap approve-ddl.ps1 has always had. The
    confirmation prompt below, plus Claude Code's own permission prompt for
    the shell call in the first place, are the actual backstops, not a
    guarantee this script cannot be invoked from inside a session. See
    data/pitfalls/hook-011.json.

    ASCII-only on purpose. See the encoding note in guard-sql.ps1.

.EXAMPLE
    .\record-settings-baseline.ps1

.EXAMPLE
    .\record-settings-baseline.ps1 -Force
#>

[CmdletBinding()]
param(
    [string] $ClaudeHome = $(Join-Path $HOME '.claude'),

    # Skip the confirmation prompt. Only for scripted use (install.ps1).
    [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$settingsPath = Join-Path $ClaudeHome 'settings.json'
$knownGoodDir = Join-Path $ClaudeHome 'known-good'
$knownGoodPath = Join-Path $knownGoodDir 'settings.json'

if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) {
    throw "record-settings-baseline: no settings.json at $settingsPath."
}
$current = [System.IO.File]::ReadAllBytes($settingsPath)

try {
    $null = (Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8) | ConvertFrom-Json
} catch {
    throw "record-settings-baseline: $settingsPath is not valid JSON. Fix it before recording a baseline."
}

Write-Host ''
Write-Host "settings.json : $settingsPath"
Write-Host "baseline      : $knownGoodPath"
Write-Host ''

# A readable diff between the recorded baseline and the current file.
# Prefers `git diff --no-index`, present wherever this kit is; falls back to
# a plain statement if git is missing. A broken diff view must not stop the
# recording itself.
function Show-Diff([byte[]] $Before, [byte[]] $After) {
    $dir = Join-Path ([System.IO.Path]::GetTempPath()) ('aiwf-baseline-diff-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    try {
        $a = Join-Path $dir 'baseline.json'
        $b = Join-Path $dir 'current.json'
        [System.IO.File]::WriteAllBytes($a, $Before)
        [System.IO.File]::WriteAllBytes($b, $After)
        $git = Get-Command git -ErrorAction SilentlyContinue
        if (-not $git) {
            Write-Host '(diff unavailable; git was not found -- review both copies by hand.)'
            return
        }
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $out = & git diff --no-index --no-color -- $a $b 2>&1
        } finally {
            $ErrorActionPreference = $previous
        }
        $text = ($out | Out-String).TrimEnd()
        if (-not $text) {
            Write-Host '(diff unavailable; the file content differs -- review both copies by hand.)'
            return
        }
        $text = $text -replace '(?m)^--- .*baseline\.json$', '--- recorded baseline' `
                       -replace '(?m)^\+\+\+ .*current\.json$', '+++ current settings.json'
        Write-Host $text
    } finally {
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if (-not (Test-Path -LiteralPath $knownGoodPath -PathType Leaf)) {
    Write-Host 'No baseline recorded yet -- this will be the first one.'
} else {
    $previousBytes = [System.IO.File]::ReadAllBytes($knownGoodPath)
    if ([Convert]::ToBase64String($current) -ceq [Convert]::ToBase64String($previousBytes)) {
        Write-Host 'settings.json already matches the recorded baseline. Nothing to do.'
        exit 0
    }
    Write-Host '--- diff: recorded baseline -> current settings.json --------' -ForegroundColor Cyan
    Show-Diff -Before $previousBytes -After $current
    Write-Host '---------------------------------------------------------------' -ForegroundColor Cyan
}

Write-Host ''

if (-not $Force) {
    $answer = Read-Host 'Record this as the new trusted baseline? (y/N)'
    if ($answer -ne 'y' -and $answer -ne 'Y') {
        Write-Host 'Cancelled. Nothing written.' -ForegroundColor Yellow
        exit 1
    }
}

if (-not (Test-Path -LiteralPath $knownGoodDir)) {
    New-Item -ItemType Directory -Path $knownGoodDir -Force | Out-Null
}
[System.IO.File]::WriteAllBytes($knownGoodPath, $current)

Write-Host 'Recorded. guard-config will stop warning about this settings.json at the next session start.' -ForegroundColor Green
