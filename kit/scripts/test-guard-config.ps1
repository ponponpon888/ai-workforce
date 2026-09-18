#requires -Version 5.1
<#
.SYNOPSIS
    Test suite for guard-config.ps1. Run it after any change.

.DESCRIPTION
    Feeds crafted PreToolUse and ConfigChange payloads to the hook and asserts
    the exit code. Exit 2 means blocked, exit 0 means allowed. Each call
    points the hook at a throwaway directory via -ClaudeHome so the test
    never touches a real ~/.claude.

    ASCII-only on purpose. See the encoding note in guard-sql.ps1.

.EXAMPLE
    .\test-guard-config.ps1
#>

[CmdletBinding()]
param(
    # Defaults are resolved AFTER param(), not here. See the note below.
    [string] $Hook
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 does not populate $PSCommandPath or $PSScriptRoot inside a
# param() default value when [CmdletBinding()] is present -- they are empty strings
# there, and Split-Path then throws before a single test has run. PowerShell 7.x
# populates them, so this only shows up on 5.1. Resolve script-relative paths after
# param(), where $PSCommandPath is correct on both.
$scriptDir = Split-Path -Parent $PSCommandPath
if (-not $Hook) {
    $Hook = Join-Path (Split-Path -Parent $scriptDir) 'claude\hooks\guard-config.ps1'
}

if (-not (Test-Path -LiteralPath $Hook)) { throw "hook not found: $Hook" }

$pwshExe = (Get-Process -Id $PID).Path

# A real directory, so path handling is exercised the same way it would be
# against a real claude home, even though this hook only pattern-matches text
# and never touches the filesystem itself.
$ClaudeHome = Join-Path ([System.IO.Path]::GetTempPath()) ('aiwf-cfg-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $ClaudeHome -Force | Out-Null

function Invoke-Hook {
    param([hashtable] $Payload)

    $json = $Payload | ConvertTo-Json -Depth 5 -Compress

    # Windows PowerShell 5.1 wraps every stderr line of a native command in an
    # ErrorRecord when you merge streams with 2>&1. Under $ErrorActionPreference
    # = 'Stop' that becomes a terminating error, so the very first BLOCKED test
    # would kill the suite. PowerShell 7.x passes stderr through as plain
    # strings and never does this. Relax the preference just around this call.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = $json | & $pwshExe -NoProfile -File $Hook -ClaudeHome $ClaudeHome 2>&1
    } finally {
        $ErrorActionPreference = $previous
    }

    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($out | Out-String) }
}

function Invoke-ToolHook([string] $ToolName, [hashtable] $ToolInput) {
    return Invoke-Hook @{
        session_id      = 'test'
        hook_event_name = 'PreToolUse'
        cwd             = (Get-Location).Path
        tool_name       = $ToolName
        tool_input      = $ToolInput
    }
}

function Invoke-ConfigChangeHook {
    param([string] $Source, [switch] $NoSource)

    $payload = @{ session_id = 'test'; hook_event_name = 'ConfigChange' }
    if (-not $NoSource) { $payload.config_source = $Source }
    return Invoke-Hook $payload
}

function Invoke-SessionStartHook {
    param([string] $TargetHome, [string] $StartupType, [switch] $NoStartupType)

    $json = @{ session_id = 'test'; hook_event_name = 'SessionStart' }
    if (-not $NoStartupType) { $json.startup_type = $StartupType }
    $body = $json | ConvertTo-Json -Compress

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = $body | & $pwshExe -NoProfile -File $Hook -ClaudeHome $TargetHome 2>&1
    } finally {
        $ErrorActionPreference = $previous
    }
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($out | Out-String) }
}

$BLOCK = 2
$ALLOW = 0

$pass = 0
$fail = 0

function Assert-Result {
    param([string] $Name, [int] $Expected, $Result)

    if ($Result.ExitCode -eq $Expected) {
        Write-Host ("  PASS  {0}" -f $Name) -ForegroundColor Green
        $script:pass++
    } else {
        Write-Host ("  FAIL  {0} (expected {1}, got {2})" -f $Name, $Expected, $Result.ExitCode) -ForegroundColor Red
        Write-Host ("        {0}" -f ($Result.Output -replace "`r?`n", ' ')) -ForegroundColor DarkGray
        $script:fail++
    }
}

$settingsPath = Join-Path $ClaudeHome 'settings.json'
$claudeMdPath = Join-Path $ClaudeHome 'CLAUDE.md'
$hookPath     = Join-Path $ClaudeHome 'hooks\guard-sql.ps1'
$approvalPath = Join-Path $ClaudeHome 'approvals\deadbeef.approval'
$scriptPath   = Join-Path $ClaudeHome 'scripts\approve-ddl.ps1'

Write-Host ''
Write-Host 'guard-config test suite' -ForegroundColor Cyan
Write-Host ''

Write-Host 'must block - Edit/Write tools:' -ForegroundColor White
Assert-Result 'Write settings.json' $BLOCK (Invoke-ToolHook 'Write' @{ file_path = $settingsPath; content = '{}' })
Assert-Result 'Edit CLAUDE.md' $BLOCK (Invoke-ToolHook 'Edit' @{ file_path = $claudeMdPath; old_string = 'x'; new_string = 'y' })
Assert-Result 'Edit a hook file' $BLOCK (Invoke-ToolHook 'Edit' @{ file_path = $hookPath; old_string = 'x'; new_string = 'y' })
Assert-Result 'Write an approval token directly' $BLOCK (Invoke-ToolHook 'Write' @{ file_path = $approvalPath; content = 'select 1' })
Assert-Result 'Edit approve-ddl.ps1 itself' $BLOCK (Invoke-ToolHook 'Edit' @{ file_path = $scriptPath; old_string = 'x'; new_string = 'y' })
Assert-Result 'Write the known-good SessionStart baseline directly' $BLOCK (Invoke-ToolHook 'Write' @{ file_path = (Join-Path $ClaudeHome 'known-good\settings.json'); content = '{}' })

Write-Host ''
Write-Host 'must block - shell commands:' -ForegroundColor White
Assert-Result 'rm on a hook file' $BLOCK (Invoke-ToolHook 'Bash' @{ command = "rm $hookPath" })
Assert-Result 'output redirection into settings.json' $BLOCK (Invoke-ToolHook 'Bash' @{ command = "echo bad > $settingsPath" })
Assert-Result 'append redirection into CLAUDE.md' $BLOCK (Invoke-ToolHook 'Bash' @{ command = "echo bad >> $claudeMdPath" })
Assert-Result 'cp writing an approval file' $BLOCK (Invoke-ToolHook 'Bash' @{ command = "cp /tmp/x $approvalPath" })
Assert-Result 'sed -i editing CLAUDE.md' $BLOCK (Invoke-ToolHook 'Bash' @{ command = "sed -i 's/x/y/' $claudeMdPath" })
Assert-Result 'PowerShell Set-Content on CLAUDE.md' $BLOCK (Invoke-ToolHook 'PowerShell' @{ command = "Set-Content $claudeMdPath -Value 'x'" })
Assert-Result 'PowerShell Remove-Item on an approval' $BLOCK (Invoke-ToolHook 'PowerShell' @{ command = "Remove-Item $approvalPath" })
Assert-Result 'a wrapper in front does not hide it' $BLOCK (Invoke-ToolHook 'Bash' @{ command = "cd /tmp && rm $hookPath" })
Assert-Result 'a subshell-style chain does not hide it' $BLOCK (Invoke-ToolHook 'Bash' @{ command = "echo hi; rm $settingsPath" })

Write-Host ''
Write-Host 'must allow - Edit/Write tools and shell commands:' -ForegroundColor White
Assert-Result 'Edit an unrelated project file' $ALLOW (Invoke-ToolHook 'Edit' @{ file_path = '/home/user/project/src/index.ts'; old_string = 'x'; new_string = 'y' })
Assert-Result 'Write to a project scripts dir with the same name' $ALLOW (Invoke-ToolHook 'Write' @{ file_path = '/home/user/project/scripts/build.mjs'; content = 'x' })
Assert-Result 'reading settings.json is fine' $ALLOW (Invoke-ToolHook 'Bash' @{ command = "cat $settingsPath" })
Assert-Result 'rm on an unrelated scripts dir' $ALLOW (Invoke-ToolHook 'Bash' @{ command = 'rm ./scripts/build.sh' })
Assert-Result 'cp between two unrelated files' $ALLOW (Invoke-ToolHook 'Bash' @{ command = 'cp foo.txt bar.txt' })
Assert-Result 'redirection to an unrelated file' $ALLOW (Invoke-ToolHook 'Bash' @{ command = 'echo hello > /tmp/output.txt' })
Assert-Result 'non-write Bash command' $ALLOW (Invoke-ToolHook 'Bash' @{ command = 'npm run build' })
Assert-Result 'unrelated MCP tool' $ALLOW (Invoke-ToolHook 'mcp__GitHub__search_code' @{ query = 'settings.json' })
Assert-Result 'empty command' $ALLOW (Invoke-ToolHook 'Bash' @{ command = '' })
Assert-Result 'empty input' $ALLOW (Invoke-ToolHook 'Bash' @{})

Write-Host ''
Write-Host 'ConfigChange:' -ForegroundColor White
Assert-Result 'user_settings change is blocked' $BLOCK (Invoke-ConfigChangeHook -Source 'user_settings')
Assert-Result 'user_settings change is blocked even with no config_source field' $BLOCK (Invoke-ConfigChangeHook -NoSource)
Assert-Result "project_settings change is not this hook's concern" $ALLOW (Invoke-ConfigChangeHook -Source 'project_settings')
Assert-Result "local_settings change is not this hook's concern" $ALLOW (Invoke-ConfigChangeHook -Source 'local_settings')
Assert-Result "skills change is not this hook's concern" $ALLOW (Invoke-ConfigChangeHook -Source 'skills')

Write-Host ''
Write-Host 'SessionStart:' -ForegroundColor White

function New-FreshHome {
    # Not $home -- PowerShell reserves $HOME as a read-only automatic
    # variable, and variable names are case-insensitive.
    $dir = Join-Path ([System.IO.Path]::GetTempPath()) ('aiwf-cfg-session-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $dir 'settings.json') -Value '{"hooks":{}}' -NoNewline -Encoding UTF8
    return $dir
}

$sessionHome = New-FreshHome
$r = Invoke-SessionStartHook -TargetHome $sessionHome -StartupType 'startup'
Assert-Result 'exits 0 (SessionStart can never block, even on first run)' $ALLOW $r
$baselinePath = Join-Path $sessionHome 'known-good\settings.json'
if (-not (Test-Path -LiteralPath $baselinePath -PathType Leaf)) {
    Write-Host '  FAIL  first run records a baseline' -ForegroundColor Red; $script:fail++
} elseif ([Convert]::ToBase64String([System.IO.File]::ReadAllBytes($baselinePath)) -cne [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Join-Path $sessionHome 'settings.json')))) {
    Write-Host '  FAIL  recorded baseline matches current settings.json' -ForegroundColor Red; $script:fail++
} else {
    Write-Host '  PASS  first run records a baseline matching current settings.json' -ForegroundColor Green; $script:pass++
}
if ($r.Output -notmatch '"additionalContext"' -or $r.Output -notmatch 'baseline recorded for the first time') {
    Write-Host '  FAIL  first run surfaces an informational (not alarming) context note' -ForegroundColor Red; $script:fail++
} else {
    Write-Host '  PASS  first run surfaces an informational (not alarming) context note' -ForegroundColor Green; $script:pass++
}
Remove-Item -LiteralPath $sessionHome -Recurse -Force -ErrorAction SilentlyContinue

$sessionHome = New-FreshHome
Invoke-SessionStartHook -TargetHome $sessionHome -StartupType 'startup' | Out-Null
$r = Invoke-SessionStartHook -TargetHome $sessionHome -StartupType 'startup'
Assert-Result 'second run against an unchanged file exits 0' $ALLOW $r
if ($r.Output.Trim()) {
    Write-Host '  FAIL  second run against an unchanged file says nothing' -ForegroundColor Red; $script:fail++
} else {
    Write-Host '  PASS  second run against an unchanged file says nothing' -ForegroundColor Green; $script:pass++
}
Remove-Item -LiteralPath $sessionHome -Recurse -Force -ErrorAction SilentlyContinue

$sessionHome = New-FreshHome
Invoke-SessionStartHook -TargetHome $sessionHome -StartupType 'startup' | Out-Null
Set-Content -LiteralPath (Join-Path $sessionHome 'settings.json') -Value '{"hooks":{},"tampered":true}' -NoNewline -Encoding UTF8
$r = Invoke-SessionStartHook -TargetHome $sessionHome -StartupType 'resume'
Assert-Result 'a settings.json that no longer matches the baseline still exits 0' $ALLOW $r
if ($r.Output -notmatch '"additionalContext"' -or $r.Output -notmatch 'WARNING') {
    Write-Host '  FAIL  mismatch surfaces a WARNING in additionalContext' -ForegroundColor Red; $script:fail++
} else {
    Write-Host '  PASS  mismatch surfaces a WARNING in additionalContext' -ForegroundColor Green; $script:pass++
}
if ($r.Output -notmatch 'hook-007') {
    Write-Host '  FAIL  warning points at hook-007.json for the background' -ForegroundColor Red; $script:fail++
} else {
    Write-Host '  PASS  warning points at hook-007.json for the background' -ForegroundColor Green; $script:pass++
}
$baselineAfter = Get-Content -LiteralPath (Join-Path $sessionHome 'known-good\settings.json') -Raw -Encoding UTF8
if ($baselineAfter -match 'tampered') {
    Write-Host '  FAIL  a mismatch does not silently adopt the new file as the baseline' -ForegroundColor Red; $script:fail++
} else {
    Write-Host '  PASS  a mismatch does not silently adopt the new file as the baseline' -ForegroundColor Green; $script:pass++
}
Remove-Item -LiteralPath $sessionHome -Recurse -Force -ErrorAction SilentlyContinue

$sessionHome = Join-Path ([System.IO.Path]::GetTempPath()) ('aiwf-cfg-session-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $sessionHome -Force | Out-Null
Assert-Result "no installed settings.json is not this hook's problem" $ALLOW (Invoke-SessionStartHook -TargetHome $sessionHome -StartupType 'startup')
if (Test-Path -LiteralPath (Join-Path $sessionHome 'known-good')) {
    Write-Host '  FAIL  no baseline directory is created when there is nothing to record' -ForegroundColor Red; $script:fail++
} else {
    Write-Host '  PASS  no baseline directory is created when there is nothing to record' -ForegroundColor Green; $script:pass++
}
Remove-Item -LiteralPath $sessionHome -Recurse -Force -ErrorAction SilentlyContinue

$sessionHome = New-FreshHome
Assert-Result 'clear is not startup or resume; skipped without recording a baseline' $ALLOW (Invoke-SessionStartHook -TargetHome $sessionHome -StartupType 'clear')
if (Test-Path -LiteralPath (Join-Path $sessionHome 'known-good')) {
    Write-Host '  FAIL  clear does not trigger baseline bootstrap' -ForegroundColor Red; $script:fail++
} else {
    Write-Host '  PASS  clear does not trigger baseline bootstrap' -ForegroundColor Green; $script:pass++
}
Remove-Item -LiteralPath $sessionHome -Recurse -Force -ErrorAction SilentlyContinue

$sessionHome = New-FreshHome
Assert-Result 'missing startup_type field still runs the check' $ALLOW (Invoke-SessionStartHook -TargetHome $sessionHome -NoStartupType)
if (-not (Test-Path -LiteralPath (Join-Path $sessionHome 'known-good\settings.json') -PathType Leaf)) {
    Write-Host '  FAIL  missing startup_type still records a baseline' -ForegroundColor Red; $script:fail++
} else {
    Write-Host '  PASS  missing startup_type still records a baseline' -ForegroundColor Green; $script:pass++
}
Remove-Item -LiteralPath $sessionHome -Recurse -Force -ErrorAction SilentlyContinue

Remove-Item -LiteralPath $ClaudeHome -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host ("pass: {0}   fail: {1}" -f $pass, $fail) -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host ''
if ($fail -gt 0) { exit 1 }

# Exit explicitly on success. Without this the script just ends, and $LASTEXITCODE
# is still whatever the last hook invocation returned. GitHub Actions ends a pwsh
# step with `exit $LASTEXITCODE`, so a fully passing suite could report itself as
# a failed step if the last case happened to be a BLOCK. See docs/02-guardrails.md
# for the same lesson learned the hard way with test-guard-sql.ps1.
exit 0
