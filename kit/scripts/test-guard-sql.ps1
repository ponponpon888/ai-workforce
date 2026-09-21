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
    [string] $ApprovalDir
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
if (-not $ApprovalDir) {
    $ApprovalDir = Join-Path ([System.IO.Path]::GetTempPath()) ('aiwf-test-approvals-' + [guid]::NewGuid().ToString('N'))
}
if (Test-Path -LiteralPath $ApprovalDir) { throw 'ApprovalDir must not already exist.' }
New-Item -ItemType Directory -Path $ApprovalDir -Force | Out-Null

$pwshExe = (Get-Process -Id $PID).Path

# Real files, because the file route is the whole point: the hook has to open what
# the client is pointed at. A fixture that does not exist on disk exercises the
# unreadable path instead, which is a different rule.
$sqlDir = Join-Path ([System.IO.Path]::GetTempPath()) ('aiwf-test-sql-' + [guid]::NewGuid().ToString('N'))
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
$RenameSql  = New-SqlFixture 'rename.sql' "rename table a to b;`n"
# psql has \i, MySQL has source, SQLite has .read. All three hide a file the
# approval never covered, so all three are refused inside a scanned file.
$MysqlIncludeSql  = New-SqlFixture 'wrapper-mysql.sql'  ('source ' + $DropSql + "`n")
$SqliteIncludeSql = New-SqlFixture 'wrapper-sqlite.sql' ('.read ' + $DropSql + "`n")

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
# unknown statement and is blocked even when the command has an approval.
Assert-Result 'a file route with nothing readable behind it' $BLOCK (Invoke-Hook 'Bash' @{ command = ('npx supabase db push --file ' + $MissingSql) })

Write-Host ''
Write-Host 'must block (MySQL):' -ForegroundColor White
# None of these exist in Postgres, so the Postgres keyword list never saw them.
# Each one is as hard to undo as the DDL that was already gated, so each goes
# through the same human approval rather than being blocked outright.
Assert-Result 'RENAME TABLE' $BLOCK (Invoke-Hook 'Bash' @{ command = 'mysql app -e "rename table a to b"' })
Assert-Result 'REPLACE INTO (deletes the row it replaces)' $BLOCK (Invoke-Hook 'Bash' @{ command = 'mysql app -e "replace into t (id) values (1)"' })
Assert-Result 'LOAD DATA INFILE' $BLOCK (Invoke-Hook 'Bash' @{ command = 'mysql app -e "load data infile ''/tmp/a.csv'' replace into table t"' })
Assert-Result 'FLUSH TABLES WITH READ LOCK' $BLOCK (Invoke-Hook 'Bash' @{ command = 'mysql app -e "flush tables with read lock"' })
Assert-Result 'RESET MASTER' $BLOCK (Invoke-Hook 'Bash' @{ command = 'mysql app -e "reset master"' })
Assert-Result 'PURGE BINARY LOGS' $BLOCK (Invoke-Hook 'Bash' @{ command = 'mysql app -e "purge binary logs before ''2020-01-01''"' })
Assert-Result 'OPTIMIZE TABLE' $BLOCK (Invoke-Hook 'Bash' @{ command = 'mysql app -e "optimize table t"' })
Assert-Result 'SET PASSWORD' $BLOCK (Invoke-Hook 'Bash' @{ command = 'mysql app -e "set password for u@''%'' = ''x''"' })
# MySQL reads # to the end of the line as a comment, so this is an unfiltered
# DELETE to the database and looked like a filtered one to the guard.
Assert-Result 'WHERE hidden behind a # comment' $BLOCK (Invoke-Hook 'Bash' @{ command = 'mysql app -e "delete from t # where id = 1"' })
Assert-Result 'RENAME TABLE in a file fed to mysql' $BLOCK (Invoke-Hook 'Bash' @{ command = ('mysql app < ' + $RenameSql) })
Assert-Result 'source include inside a file fed to mysql' $BLOCK (Invoke-Hook 'Bash' @{ command = ('mysql app < ' + $MysqlIncludeSql) })
Assert-Result 'RENAME TABLE over a MySQL MCP server' $BLOCK (Invoke-Hook 'mcp__planetscale__execute_sql' @{ query = 'rename table a to b' })

Write-Host ''
Write-Host 'must block (SQLite):' -ForegroundColor White
Assert-Result 'ATTACH DATABASE' $BLOCK (Invoke-Hook 'Bash' @{ command = 'sqlite3 app.db "attach database ''other.db'' as o"' })
Assert-Result 'PRAGMA writable_schema = ON' $BLOCK (Invoke-Hook 'Bash' @{ command = 'sqlite3 app.db "pragma writable_schema = on"' })
Assert-Result 'PRAGMA foreign_keys = OFF' $BLOCK (Invoke-Hook 'Bash' @{ command = 'sqlite3 app.db "pragma foreign_keys = off"' })
Assert-Result 'INSERT OR REPLACE' $BLOCK (Invoke-Hook 'Bash' @{ command = 'sqlite3 app.db "insert or replace into t values (1)"' })
Assert-Result '.restore over the open database' $BLOCK (Invoke-Hook 'Bash' @{ command = 'sqlite3 app.db ".restore backup.db"' })
Assert-Result 'DROP in a file read with .read' $BLOCK (Invoke-Hook 'Bash' @{ command = ('sqlite3 app.db ".read ' + $DropSql + '"') })
Assert-Result 'DROP in a file loaded with -init' $BLOCK (Invoke-Hook 'Bash' @{ command = ('sqlite3 -init ' + $DropSql + ' app.db') })
Assert-Result '.read include inside a file fed to sqlite3' $BLOCK (Invoke-Hook 'Bash' @{ command = ('sqlite3 app.db < ' + $SqliteIncludeSql) })
Assert-Result 'PRAGMA writable_schema over a SQLite MCP server' $BLOCK (Invoke-Hook 'mcp__sqlite__query' @{ query = 'pragma writable_schema = on' })
# An ORM CLI can be pointed at either engine, so no dialect is assumed and every
# dialect's rules apply.
Assert-Result 'MySQL statement through an ambiguous client' $BLOCK (Invoke-Hook 'Bash' @{ command = 'npx prisma db execute --command "replace into t (id) values (1)"' })

Write-Host ''
Write-Host 'known limitation, still BLOCK (hook-010, open_recorded -- not a bug to fix silently):' -ForegroundColor White
# Shell-grammar text is never neutralized (see the comment on Get-NeutralizedSql), so a
# DDL keyword that is only TEXT -- not SQL actually sent to a client -- still trips the
# guard when an SQL client is invoked anywhere in the same command. Deliberate, documented
# trade-off (docs/02-guardrails.md). If a change here makes these ALLOW, that is a real
# fix -- update hook-010.json and docs/02 in the same change, do not just adjust this test.
Assert-Result 'SQL-client name and DROP as plain text, not executed SQL' $BLOCK (Invoke-Hook 'Bash' @{ command = 'psql -c "select 1" && echo "note: never run DROP TABLE in prod"' })
Assert-Result 'DDL keyword only in a commit message' $BLOCK (Invoke-Hook 'PowerShell' @{ command = 'git commit -m "docs: explain why psql -c ''DROP TABLE x'' is blocked by guard-sql"' })

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
Write-Host 'must allow (MySQL / SQLite):' -ForegroundColor White
# The half that matters more. -f is --file to psql and --force to mysql: reading
# it as psql does made the hook demand a file named "app", fail to read it, and
# block a SELECT (data/pitfalls/hook-012.json).
Assert-Result 'mysql -f is --force, not a file' $ALLOW (Invoke-Hook 'Bash' @{ command = 'mysql -f app -e "select 1"' })
Assert-Result 'mysql --force with a real file route' $ALLOW (Invoke-Hook 'Bash' @{ command = ('mysql -f app < ' + $OkSql) })
Assert-Result 'REPLACE the string function' $ALLOW (Invoke-Hook 'Bash' @{ command = 'mysql app -e "select replace(name, ''a'', ''b'') from t"' })
Assert-Result 'REPLACE the string function, space before the paren' $ALLOW (Invoke-Hook 'Bash' @{ command = 'mysql app -e "select replace (name, ''a'', ''b'') from t"' })
Assert-Result 'a column named source is not an include' $ALLOW (Invoke-Hook 'Bash' @{ command = 'mysql app -e "select source from t"' })
Assert-Result '# inside a string is not a comment boundary' $ALLOW (Invoke-Hook 'Bash' @{ command = 'mysql app -e "delete from t where note = ''#1''"' })
Assert-Result 'MySQL DELETE with WHERE' $ALLOW (Invoke-Hook 'Bash' @{ command = 'mysql app -e "delete from t where id = 1"' })
# # is an operator in Postgres, not a comment. Reading it as MySQL would hide the
# WHERE that follows it and block a filtered UPDATE.
Assert-Result '# as a Postgres operator, WHERE after it' $ALLOW (Invoke-Hook 'Bash' @{ command = 'psql $DB -c "update t set flags = flags # 3 where id = 1"' })
Assert-Result 'MySQL rules do not leak into psql' $ALLOW (Invoke-Hook 'Bash' @{ command = 'psql $DB -c "select replace(name, ''a'', ''b'') from t"' })
Assert-Result 'backtick identifier is quoting, not a statement' $ALLOW (Invoke-Hook 'mcp__planetscale__execute_sql' @{ query = 'select `drop` from t where id = 1' })
Assert-Result 'SQLite read-only PRAGMA' $ALLOW (Invoke-Hook 'Bash' @{ command = 'sqlite3 app.db "pragma table_info(t)"' })
Assert-Result 'SQLite PRAGMA read back, not set' $ALLOW (Invoke-Hook 'Bash' @{ command = 'sqlite3 app.db "pragma journal_mode"' })
Assert-Result 'SQLite plain SELECT' $ALLOW (Invoke-Hook 'Bash' @{ command = 'sqlite3 app.db "select 1"' })
# Over MCP this is SQL, so the string is neutralized and the keyword inside it is
# inert. On a command line it is not: shell-grammar text is never neutralized,
# which is the documented trade-off recorded in hook-010.
Assert-Result 'dialect keyword inside a string' $ALLOW (Invoke-Hook 'mcp__sqlite__query' @{ query = "select * from t where kind = 'attach database'" })
Assert-Result 'harmless file read with .read' $ALLOW (Invoke-Hook 'Bash' @{ command = ('sqlite3 app.db ".read ' + $OkSql + '"') })
Assert-Result 'harmless file loaded with -init' $ALLOW (Invoke-Hook 'Bash' @{ command = ('sqlite3 -init ' + $OkSql + ' app.db') })

Write-Host ''
Write-Host 'approval token:' -ForegroundColor White

# hook-005: the "Statement:" text shown for an unapproved DDL call must be
# byte-identical to the string Test-Approved fingerprints (the raw tool_input
# value), or a human who copies the display into approve-ddl.ps1 gets a
# different hash and the retry stays blocked with no clue why. For shell
# grammar this display used to be the first ';'-split segment, which drops
# the client wrapper's trailing characters (here, the closing '"' and ';').
$displayCmd = 'psql -c "alter table aiwf_display_check add column c text;"'
$displayResult = Invoke-Hook 'PowerShell' @{ command = $displayCmd }
if ($displayResult.ExitCode -eq $BLOCK -and $displayResult.Output.Contains($displayCmd)) {
    Write-Host '  PASS  BLOCKED Statement: shows the exact text Test-Approved fingerprints' -ForegroundColor Green
    $script:pass++
} else {
    Write-Host ("  FAIL  BLOCKED Statement: shows the exact text Test-Approved fingerprints (exit {0})" -f $displayResult.ExitCode) -ForegroundColor Red
    Write-Host ("        {0}" -f ($displayResult.Output -replace "`r?`n", ' ')) -ForegroundColor DarkGray
    $script:fail++
}

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

# The dialect statements are gated by the same token, not a second mechanism.
$rename = 'rename table orders to orders_old'
& $approve -Sql $rename -ApprovalDir $ApprovalDir -Force | Out-Null
Assert-Result 'approved RENAME TABLE passes' $ALLOW (Invoke-Hook 'mcp__planetscale__execute_sql' @{ query = $rename })
Assert-Result 'RENAME TABLE token is single use too' $BLOCK (Invoke-Hook 'mcp__planetscale__execute_sql' @{ query = $rename })

# An unreadable file route is refused for lack of knowledge, not because it is known
# to be bad, but unread content cannot be bound to a command-only approval.
$blind = 'psql -f ' + $MissingSql
& $approve -Sql $blind -ApprovalDir $ApprovalDir -Force | Out-Null
Assert-Result 'blind file route stays blocked despite approval' $BLOCK (Invoke-Hook 'Bash' @{ command = $blind })
Assert-Result 'blind file route remains blocked' $BLOCK (Invoke-Hook 'Bash' @{ command = $blind })

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
