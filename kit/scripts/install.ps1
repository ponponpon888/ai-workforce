#requires -Version 5.1
<#
.SYNOPSIS
    Install the AI Workforce kit into your Claude Code home directory.

.DESCRIPTION
    Copies the shared CLAUDE.md, settings.json and the guard-sql hook into
    ~/.claude, backing up anything already there. Nothing is deleted.

    Run with -WhatIf first to see exactly what would happen.

    ASCII-only on purpose. See the encoding note in guard-sql.ps1.

.EXAMPLE
    .\install.ps1 -WhatIf

.EXAMPLE
    .\install.ps1 -Lang en
#>

[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    # Language of the shared CLAUDE.md to install.
    [ValidateSet('ja', 'en')]
    [string] $Lang = 'ja',

    # Which guard-sql implementation to wire up.
    #   node       - guard-sql.mjs. Works on every platform, no extra install
    #                (Claude Code already ships on Node). The default.
    #   powershell - guard-sql.ps1. Same behaviour, for setups that would rather
    #                not put Node in the hook path.
    [ValidateSet('node', 'powershell')]
    [string] $Hook = 'node',

    [string] $ClaudeHome = $(Join-Path $HOME '.claude'),

    # Skip settings.json, keep whatever you already have there.
    [switch] $SkipSettings,

    # Skip CLAUDE.md, keep whatever you already have there.
    [switch] $SkipClaudeMd
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$kitRoot  = Split-Path -Parent (Split-Path -Parent $PSCommandPath)   # ...\kit
$srcClaude = Join-Path $kitRoot 'claude'
$stamp    = Get-Date -Format 'yyyyMMdd_HHmmss'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Step([string] $Message) { Write-Host "  $Message" -ForegroundColor Gray }

function Install-File {
    param(
        [Parameter(Mandatory)][string] $Content,
        [Parameter(Mandatory)][string] $Destination
    )

    $dir = Split-Path -Parent $Destination
    if (-not (Test-Path -LiteralPath $dir)) {
        if ($PSCmdlet.ShouldProcess($dir, 'create directory')) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
    }

    if (Test-Path -LiteralPath $Destination) {
        $backup = "$Destination.bak.$stamp.$([Guid]::NewGuid().ToString('N'))"
        if ($PSCmdlet.ShouldProcess($Destination, "back up to $(Split-Path $backup -Leaf)")) {
            # Fail before writing the destination if a backup already exists.
            [System.IO.File]::Copy($Destination, $backup, $false)
            Write-Step "backed up -> $backup"
        } else {
            Write-Step "would back up -> $backup"
        }
    }

    if ($PSCmdlet.ShouldProcess($Destination, 'write')) {
        # BOM-free UTF-8, always.
        [System.IO.File]::WriteAllText($Destination, $Content, $utf8NoBom)
        Write-Step "wrote      -> $Destination"
    } else {
        Write-Step "would write-> $Destination"
    }
}

Write-Host ''
Write-Host 'AI Workforce - install' -ForegroundColor Cyan
Write-Host "  kit         : $kitRoot"
Write-Host "  claude home : $ClaudeHome"
Write-Host "  language    : $Lang"
Write-Host ''

# --- 1. shared CLAUDE.md ---------------------------------------------------

Write-Host '1. shared CLAUDE.md' -ForegroundColor White
if ($SkipClaudeMd) {
    Write-Step 'skipped (-SkipClaudeMd). Keeping the CLAUDE.md you already have.'
} else {
    $claudeMdSource = if ($Lang -eq 'en') { 'CLAUDE.en.md' } else { 'CLAUDE.md' }
    $claudeMd = Get-Content -LiteralPath (Join-Path $srcClaude $claudeMdSource) -Raw -Encoding UTF8
    Install-File -Content $claudeMd -Destination (Join-Path $ClaudeHome 'CLAUDE.md')
}

# --- 2. hooks --------------------------------------------------------------

Write-Host "2. hooks ($Hook)" -ForegroundColor White

$homeSlash = $ClaudeHome -replace '\\', '/'
if ($Hook -eq 'node') {
    $sqlFile        = 'guard-sql.mjs'
    $secretsFile    = 'guard-secrets.mjs'
    $hookCommand    = "node `"$homeSlash/hooks/guard-sql.mjs`""
    $secretsCommand = "node `"$homeSlash/hooks/guard-secrets.mjs`""
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Step 'WARNING: node was not found on PATH. Install Node, or re-run with -Hook powershell.'
    }
} else {
    $sqlFile        = 'guard-sql.ps1'
    $secretsFile    = 'guard-secrets.ps1'
    $hookCommand    = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$homeSlash/hooks/guard-sql.ps1`""
    $secretsCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$homeSlash/hooks/guard-secrets.ps1`""
}

# NOT $hook -- PowerShell variable names are case-insensitive, so that would
# assign file content to the $Hook parameter and trip its ValidateSet.
foreach ($hookFile in @($sqlFile, $secretsFile)) {
    $hookContent = Get-Content -LiteralPath (Join-Path $srcClaude "hooks\$hookFile") -Raw -Encoding UTF8
    Install-File -Content $hookContent -Destination (Join-Path $ClaudeHome "hooks\$hookFile")
}

# --- 2b. approval script ---------------------------------------------------
#
# guard-sql refuses DDL until a human approves the exact statement, and its refusal
# message names the script that issues the approval. Without this the message points
# at a path inside a checkout of this repo, which is not where anyone reads it.

Write-Host '2b. approval script' -ForegroundColor White
$approveFile = if ($Hook -eq 'node') { 'approve-ddl.mjs' } else { 'approve-ddl.ps1' }
$approveContent = Get-Content -LiteralPath (Join-Path $kitRoot "scripts\$approveFile") -Raw -Encoding UTF8
Install-File -Content $approveContent -Destination (Join-Path $ClaudeHome "scripts\$approveFile")

# --- 3. settings.json ------------------------------------------------------

Write-Host '3. settings.json' -ForegroundColor White
if ($SkipSettings) {
    Write-Step 'skipped (-SkipSettings). Add these PreToolUse hooks to your own settings.json:'
    Write-Step "  $hookCommand"
    Write-Step "  $secretsCommand"
} else {
    $settings = Get-Content -LiteralPath (Join-Path $srcClaude 'settings.json') -Raw -Encoding UTF8
    $settings = $settings.Replace('{{CLAUDE_HOME}}', $homeSlash)
    # JSON string value: backslashes and quotes must be escaped.
    $settings = $settings.Replace('{{GUARD_SQL_COMMAND}}', ($hookCommand -replace '\\', '\\\\' -replace '"', '\"'))
    $settings = $settings.Replace('{{GUARD_SECRETS_COMMAND}}', ($secretsCommand -replace '\\', '\\\\' -replace '"', '\"'))
    Install-File -Content $settings -Destination (Join-Path $ClaudeHome 'settings.json')
    # One deny rule is Windows-only. On Windows it is live, and wider than the
    # name suggests; under pwsh on Linux or macOS it is dead weight. Say which.
    # $IsWindows only exists from PowerShell 6 on, and 5.1 is Windows-only, so
    # a missing variable means Windows.
    $onWindows = (-not (Test-Path variable:IsWindows)) -or $IsWindows
    Write-Step 'note: one deny rule is Windows-specific: PowerShell(Remove-Item:*).'
    if ($onWindows) {
        Write-Step '      It is live here, and it stops every Remove-Item,'
        Write-Step '      not just the recursive ones.'
    } else {
        Write-Step '      It is inert here. Trim it if you like.'
    }
}

# --- 4. what is left to do by hand -----------------------------------------

Write-Host ''
Write-Host 'Done. Two things are deliberately left to you:' -ForegroundColor Green
Write-Host ''
Write-Host '  a) Verify both hooks fire. In Claude Code, ask it to run:' -ForegroundColor White
Write-Host '       select 1; drop table nothing;      -> [guard-sql] must block it'
Write-Host '       Get-Content .env                   -> [guard-secrets] must block it'
Write-Host '     If either goes through, that hook is not wired up and you are'
Write-Host '     unprotected on that side.'
Write-Host ''
Write-Host '     The test suites cover behaviour, not wiring. All must pass:' -ForegroundColor Gray
Write-Host "       node `"$kitRoot\scripts\test-guard-sql.mjs`""
Write-Host "       & `"$kitRoot\scripts\test-guard-sql.ps1`""
Write-Host "       node `"$kitRoot\scripts\test-guard-secrets.mjs`""
Write-Host "       node `"$kitRoot\scripts\test-guard-secrets.mjs`" --target ps"
Write-Host ''
Write-Host '  b) Register pull-all.ps1 at logon, if you want it:' -ForegroundColor White
Write-Host '       $a = New-ScheduledTaskAction -Execute "powershell.exe" ``'
Write-Host "         -Argument '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$kitRoot\scripts\pull-all.ps1`" -Root C:\Dev'"
Write-Host '       $t = New-ScheduledTaskTrigger -AtLogOn'
Write-Host '       $t.Delay = "PT1M"'
Write-Host '       Register-ScheduledTask -TaskName "AIWF pull-all" -Action $a -Trigger $t'
Write-Host ''
Write-Host '     Read pull-all.ps1 before you register it. It never stashes, resets or'
Write-Host '     checks out, but you should confirm that for yourself.' -ForegroundColor Gray
Write-Host ''
