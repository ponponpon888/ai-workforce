#requires -Version 5.1
<#
.SYNOPSIS
    Test suite for guard-sql.ps1. Run it after any change to the hook.

.DESCRIPTION
    Feeds crafted PreToolUse payloads to the hook and asserts the exit code.
    Exit 2 means blocked, exit 0 means allowed.

    ASCII-only on purpose. See the encoding note in guard-sql.ps1.

.EXAMPLE
    .\test-guard-sql.ps1
#>

[CmdletBinding()]
param(
    # Defaults are resolved AFTER param(), not here. See the note below.
    [string] $Hook,
    [string] $ApprovalDir = $(Join-Path ([System.IO.Path]::GetTempPath()) 'aiwf-test-approvals')
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
    $Hook = Join-Path (Split-Path -Parent $scriptDir) 'claude\hooks\guard-sql.ps1'
}

if (-not (Test-Path -LiteralPath $Hook)) { throw "hook not found: $Hook" }
if (Test-Path -LiteralPath $ApprovalDir) { Remove-Item -LiteralPath $ApprovalDir -Recurse -Force }
New-Item -ItemType Directory -Path $ApprovalDir -Force | Out-Null

$pwshExe = (Get-Process -Id $PID).Path

function Invoke-Hook {
    param([string] $ToolName, [hashtable] $ToolInput)

    $payload = @{
        session_id      = 'test'
        hook_event_name = 'PreToolUse'
        cwd             = (Get-Location).Path
        tool_name       = $ToolName
        tool_input      = $ToolInput
    } | ConvertTo-Json -Depth 5 -Compress

    # Windows PowerShell 5.1 wraps every stderr line of a native command in an
    # ErrorRecord when you merge streams with 2>&1. Under $ErrorActionPreference
    # = 'Stop' that becomes a terminating error -- so the very first BLOCKED test
    # killed the suite, because the hook reports its refusal on stderr. PowerShell
    # 7.x passes stderr through as plain strings and never does this.
    #
    # Dropping 2>&1 would also fix the crash, but then the hook's message would not
    # reach $Result.Output and a FAIL would print no diagnosis. So keep the merge
    # and relax the preference just around this call.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = $payload | & $pwshExe -NoProfile -File $Hook -ApprovalDir $ApprovalDir 2>&1
    } finally {
        $ErrorActionPreference = $previous
    }

    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($out | Out-String) }
}

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

$BLOCK = 2
$ALLOW = 0

Write-Host ''
Write-Host 'guard-sql test suite' -ForegroundColor Cyan
Write-Host ''

Write-Host 'must block:' -ForegroundColor White
Assert-Result 'DROP TABLE'            $BLOCK (Invoke-Hook 'mcp__Supabase__execute_sql' @{ query = 'drop table salons' })
Assert-Result 'DROP after a SELECT'   $BLOCK (Invoke-Hook 'mcp__Supabase__execute_sql' @{ query = 'select 1; drop table nothing;' })
Assert-Result 'TRUNCATE'              $BLOCK (Invoke-Hook 'mcp__Supabase__execute_sql' @{ query = 'truncate bookings' })
Assert-Result 'DELETE, no WHERE'      $BLOCK (Invoke-Hook 'mcp__Supabase__execute_sql' @{ query = 'delete from bookings' })
Assert-Result 'UPDATE, no WHERE'      $BLOCK (Invoke-Hook 'mcp__Supabase__execute_sql' @{ query = 'update bookings set status = 1' })
Assert-Result 'unapproved DDL'        $BLOCK (Invoke-Hook 'mcp__Supabase__execute_sql' @{ query = 'alter table bookings add column memo text' })
Assert-Result 'DELETE via psql'       $BLOCK (Invoke-Hook 'Bash' @{ command = 'psql $DB -c "delete from bookings"' })
Assert-Result 'WHERE hidden in a comment' $BLOCK (Invoke-Hook 'mcp__Supabase__execute_sql' @{ query = 'delete from bookings -- where id = 1' })

Write-Host ''
Write-Host 'must allow:' -ForegroundColor White
Assert-Result 'DELETE with WHERE'     $ALLOW (Invoke-Hook 'mcp__Supabase__execute_sql' @{ query = 'delete from bookings where id = 1' })
Assert-Result 'UPDATE with WHERE'     $ALLOW (Invoke-Hook 'mcp__Supabase__execute_sql' @{ query = "update bookings set status = 1 where id = 'x'" })
Assert-Result 'plain SELECT'          $ALLOW (Invoke-Hook 'mcp__Supabase__execute_sql' @{ query = 'select * from salons limit 10' })
Assert-Result 'keyword inside a string' $ALLOW (Invoke-Hook 'mcp__Supabase__execute_sql' @{ query = "insert into notes (body) values ('drop the old flow')" })
Assert-Result 'DELETE inside a comment' $ALLOW (Invoke-Hook 'mcp__Supabase__execute_sql' @{ query = 'select * from t; -- delete from t;' })
Assert-Result 'semicolon inside a string' $ALLOW (Invoke-Hook 'mcp__Supabase__execute_sql' @{ query = "select 'a; drop table t'" })
Assert-Result 'dollar-quoted body'    $ALLOW (Invoke-Hook 'mcp__Supabase__execute_sql' @{ query = 'select $$ drop table t; $$' })
Assert-Result 'non-SQL Bash'          $ALLOW (Invoke-Hook 'Bash' @{ command = 'npm run build' })
Assert-Result 'Bash rm, not our job'  $ALLOW (Invoke-Hook 'Bash' @{ command = 'rm -rf ./dist' })
Assert-Result 'unrelated MCP tool'    $ALLOW (Invoke-Hook 'mcp__GitHub__search_code' @{ query = 'drop table' })
Assert-Result 'empty input'           $ALLOW (Invoke-Hook 'Bash' @{ command = '' })

Write-Host ''
Write-Host 'approval token:' -ForegroundColor White
$ddl = 'create table memo_test (id int)'
& (Join-Path $scriptDir 'approve-ddl.ps1') -Sql $ddl -ApprovalDir $ApprovalDir -Force | Out-Null
Assert-Result 'approved DDL passes'   $ALLOW (Invoke-Hook 'mcp__Supabase__execute_sql' @{ query = $ddl })
Assert-Result 'token is single use'   $BLOCK (Invoke-Hook 'mcp__Supabase__execute_sql' @{ query = $ddl })

& (Join-Path $scriptDir 'approve-ddl.ps1') -Sql $ddl -ApprovalDir $ApprovalDir -Force | Out-Null
Assert-Result 'approval is exact-match only' $BLOCK (Invoke-Hook 'mcp__Supabase__execute_sql' @{ query = 'create table memo_test (id bigint)' })

# A migration is normally several statements. Checking the token per statement
# consumed it on the first one and failed on the second -- this test pins that.
$multi = 'create table a (id int); alter table a add column memo text'
$approve = Join-Path $scriptDir 'approve-ddl.ps1'
& $approve -Sql $multi -ApprovalDir $ApprovalDir -Force | Out-Null
Assert-Result 'approved multi-statement DDL passes' $ALLOW (Invoke-Hook 'mcp__Supabase__execute_sql' @{ query = $multi })
Assert-Result 'multi-statement token is single use too' $BLOCK (Invoke-Hook 'mcp__Supabase__execute_sql' @{ query = $multi })
& $approve -Sql $multi -ApprovalDir $ApprovalDir -Force | Out-Null
Assert-Result 'DROP still blocked inside an approved batch' $BLOCK (Invoke-Hook 'mcp__Supabase__execute_sql' @{ query = 'create table a (id int); drop table b' })

Remove-Item -LiteralPath $ApprovalDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host ("pass: {0}   fail: {1}" -f $pass, $fail) -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host ''
if ($fail -gt 0) { exit 1 }
