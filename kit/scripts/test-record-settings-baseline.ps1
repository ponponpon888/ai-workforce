#requires -Version 5.1
<#
.SYNOPSIS
    Test suite for record-settings-baseline.ps1. Run it after any change.

.DESCRIPTION
    ASCII-only on purpose. See the encoding note in guard-sql.ps1.

.EXAMPLE
    .\test-record-settings-baseline.ps1
#>

[CmdletBinding()]
param(
    [string] $Script
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $PSCommandPath
if (-not $Script) {
    $Script = Join-Path $scriptDir 'record-settings-baseline.ps1'
}
if (-not (Test-Path -LiteralPath $Script)) { throw "script not found: $Script" }

$pwshExe = (Get-Process -Id $PID).Path

$pass = 0
$fail = 0

function Assert-True {
    param([string] $Name, [bool] $Cond, [string] $Detail)
    if ($Cond) {
        Write-Host ("  PASS  {0}" -f $Name) -ForegroundColor Green
        $script:pass++
    } else {
        Write-Host ("  FAIL  {0}{1}" -f $Name, $(if ($Detail) { " -- $Detail" } else { '' })) -ForegroundColor Red
        $script:fail++
    }
}

function New-Fixture {
    $dir = Join-Path ([System.IO.Path]::GetTempPath()) ('aiwf-record-baseline-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    return $dir
}

function Invoke-Recorder {
    param([string] $TargetHome, [string[]] $ExtraArgs = @(), [string] $StdinText)

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $args = @('-NoProfile', '-File', $Script, '-ClaudeHome', $TargetHome) + $ExtraArgs
        if ($null -ne $StdinText) {
            $out = $StdinText | & $pwshExe @args 2>&1
        } else {
            $out = & $pwshExe @args 2>&1
        }
    } finally {
        $ErrorActionPreference = $previous
    }
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($out | Out-String) }
}

Write-Host ''
Write-Host 'record-settings-baseline test suite' -ForegroundColor Cyan
Write-Host ''

$dir = New-Fixture
$r = Invoke-Recorder -TargetHome $dir
Assert-True 'no settings.json fails with a clear message' ($r.ExitCode -ne 0 -and $r.Output -match 'no settings\.json') $r.Output
Assert-True 'nothing is created on that failure' (-not (Test-Path -LiteralPath (Join-Path $dir 'known-good')))
Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue

$dir = New-Fixture
Set-Content -LiteralPath (Join-Path $dir 'settings.json') -Value '{broken' -NoNewline -Encoding UTF8
$r = Invoke-Recorder -TargetHome $dir
Assert-True 'invalid JSON fails with a clear message' ($r.ExitCode -ne 0 -and $r.Output -match 'not valid JSON') $r.Output
Assert-True 'nothing is created on that failure' (-not (Test-Path -LiteralPath (Join-Path $dir 'known-good')))
Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue

$dir = New-Fixture
Set-Content -LiteralPath (Join-Path $dir 'settings.json') -Value '{"a":1}' -NoNewline -Encoding UTF8
$r = Invoke-Recorder -TargetHome $dir -ExtraArgs @('-Force')
Assert-True 'first record with -Force succeeds without a prompt' ($r.ExitCode -eq 0) $r.Output
$baselinePath = Join-Path $dir 'known-good\settings.json'
Assert-True 'records a baseline identical to settings.json' ((Test-Path -LiteralPath $baselinePath -PathType Leaf) -and (Get-Content -LiteralPath $baselinePath -Raw -Encoding UTF8) -eq '{"a":1}')
Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue

$dir = New-Fixture
Set-Content -LiteralPath (Join-Path $dir 'settings.json') -Value '{"a":1}' -NoNewline -Encoding UTF8
Invoke-Recorder -TargetHome $dir -ExtraArgs @('-Force') | Out-Null
$r = Invoke-Recorder -TargetHome $dir -ExtraArgs @('-Force')
Assert-True 're-running with no change is a no-op, exit 0' ($r.ExitCode -eq 0) $r.Output
Assert-True 'says nothing to do' ($r.Output -match 'nothing to do') $r.Output
Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue

$dir = New-Fixture
Set-Content -LiteralPath (Join-Path $dir 'settings.json') -Value '{"a":1}' -NoNewline -Encoding UTF8
Invoke-Recorder -TargetHome $dir -ExtraArgs @('-Force') | Out-Null
Set-Content -LiteralPath (Join-Path $dir 'settings.json') -Value '{"a":2}' -NoNewline -Encoding UTF8
$r = Invoke-Recorder -TargetHome $dir -StdinText "n`n"
Assert-True 'declining the prompt exits nonzero' ($r.ExitCode -ne 0) $r.Output
$baselinePath = Join-Path $dir 'known-good\settings.json'
Assert-True 'declining leaves the recorded baseline untouched' ((Get-Content -LiteralPath $baselinePath -Raw -Encoding UTF8) -eq '{"a":1}')
Assert-True 'shows a diff against the previous baseline' ($r.Output -match '-\{"a":1\}' -and $r.Output -match '\+\{"a":2\}') $r.Output
Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue

$dir = New-Fixture
Set-Content -LiteralPath (Join-Path $dir 'settings.json') -Value '{"a":1}' -NoNewline -Encoding UTF8
Invoke-Recorder -TargetHome $dir -ExtraArgs @('-Force') | Out-Null
Set-Content -LiteralPath (Join-Path $dir 'settings.json') -Value '{"a":2}' -NoNewline -Encoding UTF8
$r = Invoke-Recorder -TargetHome $dir -StdinText "y`n"
Assert-True 'accepting the prompt exits 0' ($r.ExitCode -eq 0) $r.Output
$baselinePath = Join-Path $dir 'known-good\settings.json'
Assert-True 'accepting updates the recorded baseline' ((Get-Content -LiteralPath $baselinePath -Raw -Encoding UTF8) -eq '{"a":2}')
Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host ("pass: {0}   fail: {1}" -f $pass, $fail) -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host ''
if ($fail -gt 0) { exit 1 }
exit 0
