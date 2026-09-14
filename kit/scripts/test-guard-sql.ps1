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

# Real files, because the file route is the whole point: the hook has to open what
# the client is pointed at. A fixture that does not exist on disk exercises the
# unreadable path instead, which is a different rule.
$sqlDir = Join-Path ([System.IO.Path]::GetTempPath()) 'aiwf-test-sql'
if (Test-Path -LiteralPath $sqlDir) { Remove-Item -LiteralPath $sqlDir -Recurse -Force }
New-Item -ItemType Directory -Path $sqlDir -Force | Out-Null

function New-SqlFixture([string] $Name, [string] $Body) {
    $path = Join-Path $sqlDir $Name
    [System.IO.File]::WriteAllText($path, $Body)
    return $path
}

$OkSql      = New-SqlFixture 'ok.sql'      "select 1;`n"
$DropSql    = New-SqlFixture 'bad.sql'     "drop table users;`n"
$DdlSql     = New-SqlFixture 'ddl.sql'     "create table a (id int);`n"
$QuotedSql  = New-SqlFixture 'quoted.sql'  "insert into notes (body) values ('drop the old flow');`n"
$MissingSql = Join-Path $sqlDir 'not-written.sql'

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
# A shell command line is not SQL. Reading `--sql` as a line comment deletes the
# statement the option carries, and the TRUNCATE stops being visible.
Assert-Result 'TRUNCATE behind --sql' $BLOCK (Invoke-Hook 'Bash' @{ command = "npx supabase db execute --sql 'truncate bookings'" })
Assert-Result 'DROP via the PowerShell tool' $BLOCK (Invoke-Hook 'PowerShell' @{ command = 'psql $env:DB -c "drop table x"' })

# SQL does not have to be on the command line. Each of these hands a client a file;
# a guard that reads only the command line saw none of them.
Assert-Result 'DROP in a file fed with -f'     $BLOCK (Invoke-Hook 'Bash' @{ command = ('psql -f ' + $DropSql) })
Assert-Result 'DROP in a file fed with --file=' $BLOCK (Invoke-Hook 'Bash' @{ command = ('psql --file=' + $DropSql) })
Assert-Result 'DROP in a file redirected in'   $BLOCK (Invoke-Hook 'Bash' @{ command = ('psql < ' + $DropSql) })
Assert-Result 'DROP in a file piped through cat' $BLOCK (Invoke-Hook 'Bash' @{ command = ('cat ' + $DropSql + ' | psql') })
Assert-Result 'DROP in a file included with \i' $BLOCK (Invoke-Hook 'Bash' @{ command = ('psql -c "\i ' + $DropSql + '"') })
Assert-Result 'DROP in a file fed to mysql'    $BLOCK (Invoke-Hook 'Bash' @{ command = ('mysql app < ' + $DropSql) })
Assert-Result 'DROP in a file fed to sqlite3'  $BLOCK (Invoke-Hook 'Bash' @{ command = ('sqlite3 app.db < ' + $DropSql) })
Assert-Result 'DROP in a file fed to supabase db execute' $BLOCK (Invoke-Hook 'Bash' @{ command = ('npx supabase db execute --file ' + $DropSql) })
Assert-Result 'unapproved DDL inside a file'   $BLOCK (Invoke-Hook 'Bash' @{ command = ('psql -f ' + $DdlSql) })
# This one used to be a "must allow" case, on the reasoning that a path is not a
# statement. That reasoning is what left the file route open: the path is not the
# statement, it is where the statement is. An unreadable file is now treated as an
# unknown statement and needs the same approval a DDL statement needs.
Assert-Result 'a file route with nothing readable behind it' $BLOCK (Invoke-Hook 'Bash' @{ command = ('npx supabase db push --file ' + $MissingSql) })

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
# The false-positive half of bringing PowerShell and shell grammar into scope:
# writing SQL into a file is not executing it, and a path is not a statement.
$hereDoc = "@'`ndrop extension `"pg_net`";`n'@ | Set-Content supabase/migrations/20260101_x.sql"
Assert-Result 'here-string written to a file' $ALLOW (Invoke-Hook 'PowerShell' @{ command = $hereDoc })
Assert-Result 'harmless SQL in a file' $ALLOW (Invoke-Hook 'Bash' @{ command = ('psql -f ' + $OkSql) })
Assert-Result 'keyword inside a string, in a file' $ALLOW (Invoke-Hook 'Bash' @{ command = ('psql -f ' + $QuotedSql) })
# The false-positive half of reading file routes. Each of these looks like one and
# is not: an -f that belongs to another command, and a here-document, whose << the
# redirect pattern must not read as a path.
Assert-Result 'an -f that belongs to another command' $ALLOW (Invoke-Hook 'Bash' @{ command = 'psql -c "select 1" && rm -f /tmp/junk' })
$hereDocSql = "psql <<'EOF'`nselect 1;`nEOF"
Assert-Result 'harmless here-document' $ALLOW (Invoke-Hook 'Bash' @{ command = $hereDocSql })

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

# An unreadable file route is refused for lack of knowledge, not because it is known
# to be bad, so a human approval of the exact call clears it.
$blind = 'psql -f ' + $MissingSql
& $approve -Sql $blind -ApprovalDir $ApprovalDir -Force | Out-Null
Assert-Result 'approved blind file route passes' $ALLOW (Invoke-Hook 'Bash' @{ command = $blind })
Assert-Result 'and its token is single use' $BLOCK (Invoke-Hook 'Bash' @{ command = $blind })

Remove-Item -LiteralPath $ApprovalDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $sqlDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host ("pass: {0}   fail: {1}" -f $pass, $fail) -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host ''
if ($fail -gt 0) { exit 1 }

# Exit explicitly on success. Without this the script just ends, and $LASTEXITCODE
# is still whatever the last hook invocation returned -- 2, because the final test
# is a must-block case. GitHub Actions ends a pwsh step with `exit $LASTEXITCODE`,
# so a fully passing suite reported itself as a failed step. Running the file with
# -File hides it, which is why this only ever showed up in CI.
exit 0
