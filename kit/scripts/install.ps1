#requires -Version 5.1
<#
.SYNOPSIS
    Install the AI Workforce kit into your Claude Code home directory.

.DESCRIPTION
    Copies the shared CLAUDE.md, settings.json and the guard hooks into
    ~/.claude, backing up anything already there. Nothing is deleted.
    The hooks are guard-sql, guard-secrets, guard-config (self-tamper
    protection for these settings, CLAUDE.md and the hooks themselves, plus
    a SessionStart check that warns if settings.json changed while Claude
    Code was not running) and guard-destructive (the deny list's destructive
    commands, in the shapes deny does not match). Also records the
    known-good/ baseline guard-config's SessionStart check compares against;
    re-record it with record-settings-baseline.ps1 after any later
    hand-edit.

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

$pending = New-Object 'System.Collections.Generic.List[object]'
function Install-File {
    param([string] $Content, [string] $Destination)
    $pending.Add(@{ Content = $Content; Destination = $Destination })
}

function Write-InstalledFile {
    param(
        [Parameter(Mandatory)][string] $Content,
        [Parameter(Mandatory)][string] $Destination
    )

    if (Test-Path -LiteralPath $Destination -PathType Leaf) {
        $existingBytes = [System.IO.File]::ReadAllBytes($Destination)
        $desiredBytes = $utf8NoBom.GetBytes($Content)
        if ([Convert]::ToBase64String($existingBytes) -ceq [Convert]::ToBase64String($desiredBytes)) {
            Write-Step "unchanged -> $Destination"
            return
        }
    }
    $dir = Split-Path -Parent $Destination
    if (-not (Test-Path -LiteralPath $dir)) {
        if ($PSCmdlet.ShouldProcess($dir, 'create directory')) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        } elseif (-not $WhatIfPreference) {
            Write-Step "skipped (directory creation declined) -> $Destination"
            return
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
            if (-not $WhatIfPreference) {
                Write-Step "skipped (backup declined) -> $Destination"
                return
            }
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
    $configFile     = 'guard-config.mjs'
    $destructiveFile = 'guard-destructive.mjs'
    $hookCommand    = "node `"$homeSlash/hooks/guard-sql.mjs`""
    $secretsCommand = "node `"$homeSlash/hooks/guard-secrets.mjs`""
    $configCommand  = "node `"$homeSlash/hooks/guard-config.mjs`""
    $destructiveCommand = "node `"$homeSlash/hooks/guard-destructive.mjs`""
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Step 'WARNING: node was not found on PATH. Install Node, or re-run with -Hook powershell.'
    }
} else {
    $sqlFile        = 'guard-sql.ps1'
    $secretsFile    = 'guard-secrets.ps1'
    $configFile     = 'guard-config.ps1'
    $destructiveFile = 'guard-destructive.ps1'
    $hookExecutable = if ($PSVersionTable.PSVersion.Major -ge 7) { 'pwsh' } else { 'powershell.exe' }
    $hookCommand    = "$hookExecutable -NoProfile -ExecutionPolicy Bypass -File `"$homeSlash/hooks/guard-sql.ps1`""
    $secretsCommand = "$hookExecutable -NoProfile -ExecutionPolicy Bypass -File `"$homeSlash/hooks/guard-secrets.ps1`""
    $configCommand  = "$hookExecutable -NoProfile -ExecutionPolicy Bypass -File `"$homeSlash/hooks/guard-config.ps1`""
    $destructiveCommand = "$hookExecutable -NoProfile -ExecutionPolicy Bypass -File `"$homeSlash/hooks/guard-destructive.ps1`""
}


# NOT $hook -- PowerShell variable names are case-insensitive, so that would
# assign file content to the $Hook parameter and trip its ValidateSet.
foreach ($hookFile in @($sqlFile, $secretsFile, $configFile, $destructiveFile)) {
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

# --- 2c. settings baseline recorder -----------------------------------------
#
# guard-config's SessionStart check warns when settings.json no longer
# matches the last recorded baseline. This is the script a human runs, by
# hand, outside Claude Code, to re-record that baseline after a deliberate
# edit. See the SessionStart notes in guard-config.mjs for why it has to be
# a separate, human-run step rather than something this hook does itself.

Write-Host '2c. settings baseline recorder' -ForegroundColor White
$recorderFile = if ($Hook -eq 'node') { 'record-settings-baseline.mjs' } else { 'record-settings-baseline.ps1' }
$recorderContent = Get-Content -LiteralPath (Join-Path $kitRoot "scripts\$recorderFile") -Raw -Encoding UTF8
Install-File -Content $recorderContent -Destination (Join-Path $ClaudeHome "scripts\$recorderFile")
$recorderPath = Join-Path $ClaudeHome "scripts\$recorderFile"
# Same node/ps1 split as $configCommand etc. above -- $hookExecutable is only
# set in the -Hook ps1 branch, which is exactly when this side needs it.
$recorderCommand = if ($Hook -eq 'node') { "node `"$recorderPath`"" } else { "$hookExecutable -NoProfile -ExecutionPolicy Bypass -File `"$recorderPath`"" }

# --- 3. settings.json ------------------------------------------------------

Write-Host '3. settings.json' -ForegroundColor White
if ($SkipSettings) {
    Write-Step 'skipped (-SkipSettings). Add these PreToolUse hooks to your own settings.json:'
    Write-Step "  $hookCommand"
    Write-Step "  $secretsCommand"
    Write-Step "  $configCommand"
    Write-Step "  $destructiveCommand"
    Write-Step 'Also add a ConfigChange hook (matcher "user_settings") and a SessionStart'
    Write-Step 'hook (matcher "startup|resume") both running this command:'
    Write-Step "  $configCommand"
    Write-Step 'Without the SessionStart entry, step 4 below records a baseline nobody checks.'
} else {
    $settings = Get-Content -LiteralPath (Join-Path $srcClaude 'settings.json') -Raw -Encoding UTF8
    $settings = $settings.Replace('{{CLAUDE_HOME}}', $homeSlash)
    # JSON string value: backslashes and quotes must be escaped.
    $settings = $settings.Replace('{{GUARD_SQL_COMMAND}}', ($hookCommand -replace '\\', '\\\\' -replace '"', '\"'))
    $settings = $settings.Replace('{{GUARD_SECRETS_COMMAND}}', ($secretsCommand -replace '\\', '\\\\' -replace '"', '\"'))
    $settings = $settings.Replace('{{GUARD_CONFIG_COMMAND}}', ($configCommand -replace '\\', '\\\\' -replace '"', '\"'))
    $settings = $settings.Replace('{{GUARD_DESTRUCTIVE_COMMAND}}', ($destructiveCommand -replace '\\', '\\\\' -replace '"', '\"'))
    # Validate JSON before any destination is changed.
    $parsed = ConvertFrom-Json -InputObject $settings -ErrorAction Stop
    if ($null -eq $parsed -or $parsed -isnot [System.Management.Automation.PSCustomObject]) {
        throw 'install: settings must be a JSON object'
    }
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

# Reject layout conflicts before updating even the first file.
foreach ($entry in $pending) {
    if ((Test-Path -LiteralPath $entry.Destination) -and
        -not (Test-Path -LiteralPath $entry.Destination -PathType Leaf)) {
        throw "install: destination is not a file: $($entry.Destination)"
    }
    $parent = Split-Path -Parent $entry.Destination
    while ($parent) {
        if (Test-Path -LiteralPath $parent) {
            if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
                throw "install: parent is not a directory: $parent"
            }
            break
        }
        $next = Split-Path -Parent $parent
        if ($next -eq $parent) { break }
        $parent = $next
    }
}
# All selected sources and destination shapes are checked before the first write.
foreach ($entry in $pending) {
    Write-InstalledFile -Content $entry.Content -Destination $entry.Destination
}

# --- 4. known-good baseline -------------------------------------------------
#
# Records the settings.json now on disk (whichever one: freshly written
# above, or the pre-existing file if -SkipSettings kept it) as the trusted
# baseline guard-config's SessionStart check compares against. Day one gets
# a baseline the same way every later hand-edit does -- through
# record-settings-baseline, not written ad hoc here.

Write-Host '4. known-good baseline' -ForegroundColor White
$finalSettingsPath = Join-Path $ClaudeHome 'settings.json'
$knownGoodPath = Join-Path $ClaudeHome 'known-good\settings.json'
if ($WhatIfPreference) {
    Write-Step "would record -> $knownGoodPath"
} elseif (-not (Test-Path -LiteralPath $finalSettingsPath -PathType Leaf)) {
    Write-Step 'skipped: no settings.json on disk to record a baseline from.'
} else {
    $finalSettingsBytes = [System.IO.File]::ReadAllBytes($finalSettingsPath)
    $unchanged = (Test-Path -LiteralPath $knownGoodPath -PathType Leaf) -and
        ([Convert]::ToBase64String([System.IO.File]::ReadAllBytes($knownGoodPath)) -ceq [Convert]::ToBase64String($finalSettingsBytes))
    if ($unchanged) {
        Write-Step "unchanged -> $knownGoodPath"
    } else {
        $knownGoodDir = Split-Path -Parent $knownGoodPath
        if (-not (Test-Path -LiteralPath $knownGoodDir)) { New-Item -ItemType Directory -Path $knownGoodDir -Force | Out-Null }
        [System.IO.File]::WriteAllBytes($knownGoodPath, $finalSettingsBytes)
        Write-Step "recorded  -> $knownGoodPath"
    }
}

# --- 5. what is left to do by hand -----------------------------------------

Write-Host ''
Write-Host 'Done. Three things are deliberately left to you:' -ForegroundColor Green
Write-Host ''
Write-Host '  a) Quit Claude Code (/exit) and start it again. A running session keeps the' -ForegroundColor White
Write-Host '     hooks it started with, and guard-config refuses live changes to'
Write-Host '     settings.json on purpose. Then open /hooks: PreToolUse must show'
Write-Host '     Bash|PowerShell with 2 hooks, and SessionStart must show 1. If PreToolUse'
Write-Host '     shows 1, you are still testing the old settings, and every result below is'
Write-Host '     meaningless.'
Write-Host ''
Write-Host '     Verify all four hooks fire. In Claude Code, ask it to run:'
Write-Host '       select 1; drop table nothing;      -> [guard-sql] must block it'
Write-Host '       Get-Content .env                   -> [guard-secrets] must block it'
Write-Host "       cmd /c rd /s /q .\aiwf-nothing     -> [guard-destructive] must block it"
Write-Host '     Then ask it to edit or delete your own settings.json or CLAUDE.md:'
Write-Host '       -> [guard-config] must block it'
Write-Host '     If any of these goes through, that hook is not wired up and you are'
Write-Host '     unprotected on that side.'
Write-Host ''
Write-Host '     The test suites cover behaviour, not wiring. All must pass:' -ForegroundColor Gray
Write-Host "       node `"$kitRoot\scripts\test-guard-sql.mjs`""
Write-Host "       & `"$kitRoot\scripts\test-guard-sql.ps1`""
Write-Host "       node `"$kitRoot\scripts\test-guard-secrets.mjs`""
Write-Host "       node `"$kitRoot\scripts\test-guard-secrets.mjs`" --target ps"
Write-Host "       node `"$kitRoot\scripts\test-guard-config.mjs`""
Write-Host "       & `"$kitRoot\scripts\test-guard-config.ps1`""
Write-Host "       node `"$kitRoot\scripts\test-guard-destructive.mjs`""
Write-Host "       node `"$kitRoot\scripts\test-guard-destructive.mjs`" --target ps"
Write-Host ''
Write-Host '  b) After any deliberate hand-edit of settings.json, re-record its baseline' -ForegroundColor White
Write-Host '     yourself, outside Claude Code, or every session start will warn that it'
Write-Host '     no longer matches what was last approved:'
Write-Host "       $recorderCommand"
Write-Host ''
Write-Host '  c) Register pull-all.ps1 at logon, if you want it:' -ForegroundColor White
Write-Host '       $a = New-ScheduledTaskAction -Execute "powershell.exe" ``'
Write-Host "         -Argument '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$kitRoot\scripts\pull-all.ps1`" -Root C:\Dev'"
Write-Host '       $t = New-ScheduledTaskTrigger -AtLogOn'
Write-Host '       $t.Delay = "PT1M"'
Write-Host '       Register-ScheduledTask -TaskName "AIWF pull-all" -Action $a -Trigger $t'
Write-Host ''
Write-Host '     Read pull-all.ps1 before you register it. It never stashes, resets or'
Write-Host '     checks out, but you should confirm that for yourself.' -ForegroundColor Gray
Write-Host ''
