#requires -Version 5.1
<#
.SYNOPSIS
    Claude Code PreToolUse hook. Blocks destructive SQL before it reaches a database.

.DESCRIPTION
    Reads the PreToolUse JSON payload from stdin, pulls the SQL out of the tool input,
    and refuses the tool call when the statement is destructive or is unapproved DDL.

    Blocked outright:
      - DROP ...
      - TRUNCATE ...
      - DELETE FROM ... with no WHERE clause
      - UPDATE ... SET ... with no WHERE clause

    Blocked until a human approves the exact statement (see approve-ddl.ps1):
      - CREATE / ALTER / GRANT / REVOKE / REINDEX / VACUUM
      - MySQL only: RENAME TABLE / REPLACE / LOAD DATA / FLUSH / RESET /
        PURGE ... LOGS / OPTIMIZE / REPAIR / SET PASSWORD
      - SQLite only: ATTACH / DETACH / a PRAGMA that sets state / INSERT OR REPLACE

    NOTE ON DIALECT
    The same string does not mean the same thing to every client. "-f" is --file
    to psql and --force to mysql, and "#" opens a comment in MySQL while it is an
    operator in Postgres. So the client being invoked decides which file routes
    are read as files and which grammar the statement is read under. When the
    client is ambiguous (an ORM CLI that could be pointed at either), every rule
    applies and nothing is neutralized -- the conservative side of both.

    NOTE ON FILE ROUTES
    SQL does not have to appear on the command line. "psql -f x.sql", "psql < x.sql",
    "cat x.sql | psql" and "\i x.sql" all hand a database client a file, and a guard
    that reads only the command line sees none of it. The hook runs before the tool
    does, but the file was written by an earlier call and is already on disk, so it
    can be opened and scanned as SQL. Every candidate must be readable. Nested includes and file DDL
    are unsupported and blocked: command-only approval cannot bind file contents.

    NOTE ON SCOPE
    This stops accidents, not an adversary. Any agent holding a shell could write an
    approval file itself. The point is that a model doing the wrong thing by mistake
    -- the common case -- hits a wall it cannot walk through by accident.

    NOTE ON ENCODING
    This file is deliberately ASCII-only. Windows PowerShell 5.1 reads a BOM-free
    UTF-8 script as the system ANSI codepage, so non-ASCII string literals would be
    mojibake on a Japanese Windows install. Keep it ASCII.

.NOTES
    Exit 0 -> allow.  Exit 2 -> block, reason on stderr.
    Internal inspection failures block with exit 2.
#>

[CmdletBinding()]
param(
    # Minutes an approval token stays valid.
    [int] $ApprovalTtlMinutes = 15,

    # Where approval tokens live.
    [string] $ApprovalDir = $(
        if ($env:AIWF_APPROVAL_DIR) { $env:AIWF_APPROVAL_DIR }
        else { Join-Path $HOME '.claude\approvals' }
    )
)

Set-StrictMode -Version Latest

# Where to tell the human to run the approval script. Installed, the hook sits in
# <claude home>\hooks and approve-ddl in <claude home>\scripts, so an absolute path
# can be given -- the repo-relative one only works from a checkout of this repo,
# which is not where anyone hits this message.
#
# $PSCommandPath is resolved here rather than in param(): Windows PowerShell 5.1
# leaves it empty inside a param() default when [CmdletBinding()] is present.
$installedApprove = Join-Path (Split-Path -Parent (Split-Path -Parent $PSCommandPath)) 'scripts\approve-ddl.ps1'
$approveCommand = if (Test-Path -LiteralPath $installedApprove) {
    "& '$installedApprove'"
} else {
    '.\kit\scripts\approve-ddl.ps1'
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Deny([string] $Reason, [string] $Statement) {
    $snippet = $Statement.Trim()
    if ($snippet.Length -gt 400) { $snippet = $snippet.Substring(0, 400) + ' ...' }

    $msg = @"
[guard-sql] BLOCKED: $Reason

Statement:
  $snippet

What to do:
  1. Show this statement to the human and explain what it changes.
  2. If it is DDL and they agree, ask them to run:
       $approveCommand -Sql '<the exact statement>'
     then retry the call unchanged.
  3. If it is a DELETE or UPDATE, add a WHERE clause.
  4. DROP and TRUNCATE are never approved by this hook. Do them by hand.
"@
    [Console]::Error.WriteLine($msg)
    exit 2
}

# Replace string literals and comments with harmless placeholders so that
# keywords inside them cannot trigger a false positive, and semicolons inside
# them cannot split a statement.
#
# This is SQL grammar, so it may only be applied to something that is SQL. On a
# shell command line '--' opens an option, not a comment: applying it to
# "npx supabase db execute --sql 'truncate bookings'" leaves
# "npx supabase db execute" and the TRUNCATE is no longer in view. The quoting
# is the shell's too, and the statement we need to read sits inside it. So a
# command line is scanned exactly as it arrived.
function Get-NeutralizedSql([string] $Sql, [string] $Grammar, [string] $Dialect) {
    if ($Grammar -eq 'shell') { return $Sql }

    $alternatives = New-Object System.Collections.Generic.List[string]
    $alternatives.Add("'(?:[^']|'')*'")                # single-quoted literal, '' escape
    $alternatives.Add('\$([A-Za-z0-9_]*)\$.*?\$\1\$')   # postgres dollar-quoted body
    $alternatives.Add('--[^\r\n]*')                    # line comment
    $alternatives.Add('/\*.*?\*/')                     # block comment

    # MySQL only, and only when we know it is MySQL: "#" opens a comment there,
    # but it is an operator in Postgres. Hiding text that is not a comment would
    # hide a WHERE and turn an unfiltered DELETE into an allowed one, so this is
    # never applied to a dialect we are unsure about.
    if ($Dialect -eq 'mysql') {
        $alternatives.Add('#[^\r\n]*')                 # mysql line comment
        $alternatives.Add('`(?:[^`]|``)*`')            # mysql quoted identifier
    }

    $pattern = ($alternatives -join '|')
    $rx = [regex]::new($pattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)
    return $rx.Replace($Sql, {
        param($m)
        if ($m.Value.StartsWith("'") -or $m.Value.StartsWith('$') -or $m.Value.StartsWith('`')) { "''" } else { ' ' }
    })
}

function Get-SqlFingerprint([string] $Sql) {
    $normalized = "aiwf-exact-v2" + [char]0 + $Sql
    $bytes  = [System.Text.Encoding]::UTF8.GetBytes($normalized)
    $sha    = [System.Security.Cryptography.SHA256]::Create()
    try {
        return -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
    } finally { $sha.Dispose() }
}

# Node and PowerShell use the SAME exclusive entry. Rename alone is not a
# cross-platform claim. Age/PID are never grounds to steal or remove the lock.
function Deny-ApprovalState([string] $Digest) {
    [Console]::Error.WriteLine(@"
[guard-sql] BLOCKED: approval-state-unavailable
Fingerprint: $Digest
A consumer may be active, or approval IO needs recovery. No retry was authorized.
Do not delete the lock or reissue this approval while callers may be running.
Stop all callers, reconcile the external result, then follow docs/18-approval-lock-recovery.md.
"@)
    exit 2
}

function Test-Approved([string] $Sql) {
    $digest = Get-SqlFingerprint $Sql
    $file = Join-Path $ApprovalDir ($digest + '.approval')
    $lock = $file + '.lock'
    $claimed = $file + '.used-' + [guid]::NewGuid().ToString('N')
    $lockStream = $null
    try {
        $lockStream = [System.IO.File]::Open($lock, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    } catch [System.IO.DirectoryNotFoundException] {
        return $false
    } catch {
        Deny-ApprovalState $digest
    }

    $approved = $false; $cleanupComplete = $false; $released = $false
    try {
        # Metadata is diagnostic only. Empty/malformed locks also block. No SQL.
        $record = @{
            schema = 'aiwf-approval-lock-v1'; pid = $PID
            createdAt = [DateTime]::UtcNow.ToString('o'); claim = $claimed.Substring($file.Length)
        } | ConvertTo-Json -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($record + "`n")
        $lockStream.Write($bytes, 0, $bytes.Length)
        $lockStream.Flush($true)
        $moved = $false
        try {
            [System.IO.File]::Move($file, $claimed)
            $moved = $true
        } catch [System.IO.FileNotFoundException] {
            $cleanupComplete = $true
        }
        if ($moved) {
            $item = Get-Item -LiteralPath $claimed -Force -ErrorAction Stop
            if (-not $item.PSIsContainer -and -not ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                $age = [DateTime]::UtcNow - $item.LastWriteTimeUtc
                $approved = ($age.TotalMinutes -ge 0 -and $age.TotalMinutes -le $ApprovalTtlMinutes -and
                    [string]::Equals([System.IO.File]::ReadAllText($claimed), $Sql, [System.StringComparison]::Ordinal))
            }
            # Consumption and lock cleanup must finish before returning ALLOW.
            [System.IO.File]::Delete($claimed)
            $cleanupComplete = $true
        }
    } catch {
        $approved = $false
    } finally {
        try { $lockStream.Dispose() } catch { $cleanupComplete = $false }
        if ($cleanupComplete) {
            try { [System.IO.File]::Delete($lock); $released = $true } catch { }
        }
    }
    if (-not $released) { Deny-ApprovalState $digest }
    return $approved
}

# Pull SQL out of whichever tool is being called, and report which field it came
# from. The field name is half of how the grammar is decided.
function Get-SqlFromToolInput($ToolName, $ToolInput) {
    $none = [pscustomobject]@{ Value = ''; Key = '' }
    if ($null -eq $ToolInput) { return $none }

    foreach ($key in @('query', 'sql', 'statement', 'command')) {
        if ($ToolInput.PSObject.Properties.Name -contains $key) {
            $value = $ToolInput.$key
            if ($value -is [string] -and $value.Trim()) {
                return [pscustomobject]@{ Value = $value; Key = $key }
            }
        }
    }
    return $none
}

# Markers that hand a database client a file instead of a statement. Each one is
# scanned only inside a command segment that invokes a client, so an "rm -f /tmp/junk"
# sitting after && is not mistaken for "psql -f".
#
# "<(?!<)" matters: "psql <<'EOF'" is a here-document, not a redirect, and reading
# "<'EOF'" as a path would demand approval for every harmless here-document.
$script:CommonFileRoutePatterns = @(
    '(?:^|\s)<(?!<)\s*(\S+)',                 # psql < x.sql
    '\bcat\s+(\S+)',                          # cat x.sql | psql
    '(?:^|[\s"''`=])([^\s"''`;|<>]+\.sql)\b'  # any .sql path, however it got there
)

# Routes that belong to one client only.
#
# "-f" is the one that matters: to psql it is --file, to mysql it is --force.
# Reading "mysql -f app -e ..." as psql does made the hook demand a file called
# "app", fail to read it, and block a harmless SELECT. A guard that fires on
# correct SQL gets switched off, so the option is read per client now
# (data/pitfalls/hook-012.json).
#
# The MySQL "source" route requires the argument to look like a path -- a slash,
# or an extension. "select source from t" must not be read as an include of a
# file named "from".
$script:DialectFileRoutePatterns = @{
    postgres = @(
        '(?:^|\s)(?:-f|--file)[=\s]+(\S+)',   # psql -f x.sql / --file=x.sql
        '\\ir?\s+(\S+)'                       # psql -c "\i x.sql"
    )
    mysql = @(
        '(?i)(?:^|[\s"''`;])source\s+([^\s;"''`]*(?:[\\/][^\s;"''`]*|\.[A-Za-z0-9]+))'
    )
    sqlite = @(
        '(?:^|\s)(?:-init|--init)[=\s]+(\S+)', # sqlite3 -init x.sql
        '(?i)\.read\s+(\S+)'                   # sqlite3's include
    )
}

# An ambiguous client gets every route: coverage over a tidy answer.
function Get-FileRoutePattern([string] $Dialect) {
    if ($Dialect -eq 'unknown') {
        $own = @($script:DialectFileRoutePatterns.Values | ForEach-Object { $_ })
    } elseif ($script:DialectFileRoutePatterns.ContainsKey($Dialect)) {
        $own = @($script:DialectFileRoutePatterns[$Dialect])
    } else {
        $own = @()
    }
    return @($script:CommonFileRoutePatterns) + $own
}

# Which dialect a command segment speaks. Only clients that pin the dialect are
# listed: "prisma db" and "drizzle-kit" are deliberately absent, because the same
# command can be pointed at Postgres or MySQL and guessing one would switch off
# the other one's rules. Two different clients in one segment is 'unknown' for
# the same reason.
$script:ClientDialectPatterns = @(
    @{ Pattern = '(?i)\bsqlite3\b'; Dialect = 'sqlite' },
    @{ Pattern = '(?i)\b(mysql|mariadb)\b'; Dialect = 'mysql' },
    @{ Pattern = '(?i)\b(psql|supabase\s+db)\b'; Dialect = 'postgres' }
)

# The MCP side of the same question: the server name is all we get.
$script:McpDialectPatterns = @(
    @{ Pattern = 'mcp__.*([Pp]lanetscale|[Mm]ysql|[Mm]ariadb)'; Dialect = 'mysql' },
    @{ Pattern = 'mcp__.*[Ss]qlite'; Dialect = 'sqlite' },
    @{ Pattern = 'mcp__.*([Ss]upabase|[Pp]ostgres|[Nn]eon)'; Dialect = 'postgres' }
)

function Get-SqlDialect([string] $Text, $Table) {
    $hits = New-Object System.Collections.Generic.List[string]
    foreach ($entry in $Table) {
        if ($Text -match $entry.Pattern -and -not $hits.Contains($entry.Dialect)) {
            $hits.Add($entry.Dialect) | Out-Null
        }
    }
    if ($hits.Count -eq 1) { return $hits[0] }
    return 'unknown'
}

# Statements that are not DDL by name but are just as unrecoverable, and exist in
# only one dialect. They go through the same human approval as DDL rather than
# being blocked outright, because each one has a legitimate use.
#
# REPLACE is matched only when an identifier follows it, never a "(", so the
# string function replace(col,'a','b') is left alone.
$script:CommonApprovalPattern = '(?is)\b(CREATE|ALTER|GRANT|REVOKE|REINDEX|VACUUM)\b'
$script:DialectApprovalPatterns = @{
    mysql = @(
        '(?i)\bRENAME\s+TABLE\b',
        '(?i)\bREPLACE\s+(?:LOW_PRIORITY\s+|DELAYED\s+)?(?:INTO\s+)?[''"`\w]',
        '(?i)\bLOAD\s+DATA\b',
        '(?i)\bFLUSH\s+(?:NO_WRITE_TO_BINLOG\s+|LOCAL\s+)?[A-Z_]',
        '(?i)\bRESET\s+(MASTER|REPLICA|SLAVE|BINARY\s+LOGS|QUERY\s+CACHE)\b',
        '(?i)\bPURGE\s+(BINARY|MASTER)\s+LOGS\b',
        '(?i)\b(OPTIMIZE|REPAIR)\s+(?:NO_WRITE_TO_BINLOG\s+|LOCAL\s+)?TABLE\b',
        '(?i)\bSET\s+PASSWORD\b'
    )
    sqlite = @(
        '(?i)\b(ATTACH|DETACH)\s+(?:DATABASE\s+)?[''"`\w]',
        # Only the pragmas whose value changes what the database enforces or how
        # it is written, and only when one is being set. "PRAGMA table_info(t)"
        # and a bare "PRAGMA journal_mode;" read state and stay allowed.
        '(?i)\bPRAGMA\s+(?:\w+\.)?(writable_schema|foreign_keys|ignore_check_constraints|defer_foreign_keys|legacy_alter_table|journal_mode|synchronous|trusted_schema)\s*[=(]',
        '(?i)\bINSERT\s+OR\s+REPLACE\b',
        '(?i)\bREPLACE\s+INTO\b',
        '(?i)(?:^|[\s"''`;])\.(restore|import)\b'
    )
}

function Test-NeedsApproval([string] $Statement, [string] $Dialect) {
    if ($Statement -match $script:CommonApprovalPattern) { return $true }
    if ($Dialect -eq 'unknown') {
        $own = @($script:DialectApprovalPatterns.Values | ForEach-Object { $_ })
    } elseif ($script:DialectApprovalPatterns.ContainsKey($Dialect)) {
        $own = @($script:DialectApprovalPatterns[$Dialect])
    } else {
        $own = @()
    }
    foreach ($pattern in $own) {
        if ($Statement -match $pattern) { return $true }
    }
    return $false
}

# Includes, per dialect. psql has \i, MySQL has source, SQLite has .read. All
# three are refused inside a SQL file for the same reason: a command-only
# approval cannot bind the contents of a file it never saw.
$script:IncludePatterns = @{
    postgres = '(?:^|[\r\n])\s*\\(?:i|ir)\b'
    mysql    = '(?i)(?:^|[\r\n])\s*source\s+[^\s;"''`]*(?:[\\/]|\.[A-Za-z0-9]+)'
    sqlite   = '(?i)(?:^|[\r\n])\s*\.read\b'
}

# A pipeline stays whole: "cat x.sql | psql" is one segment.
$script:SegmentPattern = '&&|\|\||;|\r?\n'

# Files larger than this are not scanned; unread files are blocked.
$script:MaxSqlFileBytes = 1048576

$script:SqlClientPattern = '(?is)\b(psql|sqlite3|mysql|mariadb|supabase\s+db|prisma\s+db|drizzle-kit)\b'

# Strip one layer of shell quoting from a token pulled out of a command line.
function Get-Unquoted([string] $Token) {
    return ($Token -replace '^["''`]+', '') -replace '["''`]+$', ''
}

# Paths a command line hands to a database client. Only segments that invoke a
# client are scanned, so an unrelated -f elsewhere on the line is left alone.
function Get-FileRouteCandidate([string] $Command) {
    $found = New-Object System.Collections.Generic.List[object]
    $seen = New-Object System.Collections.Generic.List[string]
    foreach ($segment in ($Command -split $script:SegmentPattern)) {
        if ($segment -notmatch $script:SqlClientPattern) { continue }
        $dialect = Get-SqlDialect $segment $script:ClientDialectPatterns
        foreach ($pattern in (Get-FileRoutePattern $dialect)) {
            foreach ($m in [regex]::Matches($segment, $pattern)) {
                $path = Get-Unquoted $m.Groups[1].Value
                # The file is read under the dialect of the client it is handed
                # to. A path named twice by two clients keeps the first; the
                # contents are scanned either way and only the grammar differs.
                if ($path -and -not $seen.Contains($path)) {
                    $seen.Add($path) | Out-Null
                    $found.Add([pscustomobject]@{ Path = $path; Dialect = $dialect }) | Out-Null
                }
            }
        }
    }
    return $found
}

# Read a candidate path, or $null when there is nothing readable there.
function Read-SqlFile([string] $Path, [string] $Cwd) {
    try {
        if ([System.IO.Path]::IsPathRooted($Path)) { $absolute = $Path }
        elseif ($Cwd) { $absolute = Join-Path $Cwd $Path }
        else { $absolute = Join-Path (Get-Location).Path $Path }

        if (-not (Test-Path -LiteralPath $absolute -PathType Leaf)) { return $null }
        $item = Get-Item -LiteralPath $absolute
        if ($item.Length -gt $script:MaxSqlFileBytes) { return $null }
        return [System.IO.File]::ReadAllText($absolute)
    } catch {
        return $null
    }
}

# Run the destructive-statement rules over one blob. Hard hits deny immediately;
# the first DDL statement is handed back so the approval is checked once for the
# whole call. $Where names the source in the block message.
# Check each modifying verb against WHERE at the same parenthesis depth.
# This remains a scoped lexical check, not a complete SQL parser.
function Test-UnfilteredMutation([string] $Statement) {
    $scoped = New-Object System.Collections.Generic.List[object]
    $depth = 0
    foreach ($m in [regex]::Matches($Statement.ToUpperInvariant(), '[A-Z_][A-Z_0-9]*|[()]')) {
        $word = $m.Value
        if ($word -eq ')') { $depth-- }
        $scoped.Add([pscustomobject]@{ Word = $word; Depth = $depth })
        if ($word -eq '(') { $depth++ }
    }
    for ($i = 0; $i -lt $scoped.Count; $i++) {
        $start = $scoped[$i]
        if ($start.Word -notin @('UPDATE', 'DELETE')) { continue }
        $modifies = $false; $hasWhere = $false
        $marker = if ($start.Word -eq 'UPDATE') { 'SET' } else { 'FROM' }
        for ($j = $i + 1; $j -lt $scoped.Count; $j++) {
            $t = $scoped[$j]
            if ($t.Depth -lt $start.Depth) { break }
            if ($t.Depth -ne $start.Depth) { continue }
            if ($t.Word -eq $marker) { $modifies = $true }
            if ($modifies -and $t.Word -eq 'WHERE') { $hasWhere = $true }
        }
        if ($modifies -and -not $hasWhere) { return $true }
    }
    return $false
}

function Invoke-StatementScan([string] $Text, [string] $Grammar, [string] $Where, [string] $Dialect) {
    $firstDdl = $null
    $cleaned = Get-NeutralizedSql $Text $Grammar $Dialect
    if ($Dialect -eq 'unknown' -or -not $script:IncludePatterns.ContainsKey($Dialect)) {
        $includePatterns = @($script:IncludePatterns.Values | ForEach-Object { $_ })
    } else {
        $includePatterns = @($script:IncludePatterns[$Dialect])
    }
    if ($Grammar -eq 'sql') {
        foreach ($pattern in $includePatterns) {
            if ($cleaned -match $pattern) {
                Deny "Nested SQL includes are unsupported; submit the reviewed SQL directly.$Where" 'SQL include'
            }
        }
    }
    foreach ($stmt in ($cleaned -split ';')) {
        if (-not $stmt.Trim()) { continue }
        if ($stmt -match '(?is)\bDROP\b') { Deny "DROP is never allowed from an agent.$Where" $stmt }
        if ($stmt -match '(?is)\bTRUNCATE\b') { Deny "TRUNCATE is never allowed from an agent.$Where" $stmt }
        if (($Grammar -eq 'sql' -and $stmt -match '(?i)^\s*DO\b') -or ($Grammar -eq 'shell' -and $stmt -match '(?i)\bDO\s+(?:LANGUAGE\b|[''"$])')) { Deny "Procedural DO blocks are unsupported.$Where" $stmt }
        if (Test-UnfilteredMutation $stmt) { Deny "UPDATE/DELETE needs a WHERE in the same SQL scope.$Where" $stmt }
        # MySQL reads # to the end of the line as a comment. A command line is
        # never neutralized (see Get-NeutralizedSql), so "delete from t # where
        # id = 1" showed the guard a WHERE and showed MySQL an unfiltered
        # DELETE -- the whole table. Read the statement a second time with the #
        # comments taken out and block if THAT reading is unfiltered. This only
        # ever adds a block: DROP and TRUNCATE are still matched against the text
        # exactly as it arrived.
        if (($Dialect -eq 'mysql' -or $Dialect -eq 'unknown') -and $stmt.Contains('#') -and
            (Test-UnfilteredMutation ($stmt -replace '#[^\r\n]*', ' '))) {
            Deny "UPDATE/DELETE needs a WHERE in the same SQL scope; MySQL reads # to the end of the line as a comment.$Where" $stmt
        }
        if ($null -eq $firstDdl -and (Test-NeedsApproval $stmt $Dialect)) { $firstDdl = $stmt }
    }
    return $firstDdl
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

try {
    $raw = [Console]::In.ReadToEnd()
    if (-not $raw) { exit 0 }

    $payload = $raw | ConvertFrom-Json
    $toolName = if ($payload.PSObject.Properties.Name -contains 'tool_name') { [string]$payload.tool_name } else { '' }
    $toolInput = if ($payload.PSObject.Properties.Name -contains 'tool_input') { $payload.tool_input } else { $null }

    $extracted = Get-SqlFromToolInput $toolName $toolInput
    $sql = $extracted.Value
    if (-not $sql.Trim()) { exit 0 }

    # Only inspect tools that actually talk to a database. The settings.json
    # matcher should already do this, but a matcher is one edit away from being
    # widened, and a `query` field on some unrelated MCP tool must not be read
    # as SQL. Defence in depth, and it costs nothing.
    #
    # The MCP alternatives are NOT anchored to a fixed prefix (unlike
    # Bash/PowerShell, which are exact tool names): a connector can prepend its
    # own name ahead of the product name, e.g.
    # "mcp__claude_ai_Supabase__list_projects", and a "mcp__[Ss]upabase__"
    # prefix match misses it entirely. Match "supabase" (etc) anywhere in the
    # tool name instead. See data/pitfalls/hook-004.json.
    if ($toolName -notmatch '^(Bash|PowerShell)$|mcp__.*[Ss]upabase|mcp__.*[Pp]ostgres|mcp__.*[Nn]eon|mcp__.*[Pp]lanetscale|mcp__.*[Mm]ysql|mcp__.*[Mm]ariadb|mcp__.*[Ss]qlite') {
        exit 0
    }

    # Tool name and field name together decide which grammar the same string is
    # read under: a shell tool handing us its 'command' is a command line,
    # anything else is a SQL statement.
    if ($toolName -match '^(Bash|PowerShell)$' -and $extracted.Key -eq 'command') {
        $grammar = 'shell'
    } else {
        $grammar = 'sql'
    }

    # A shell call only counts as SQL if it actually invokes a database client.
    if ($grammar -eq 'shell' -and $sql -notmatch '(?is)\b(psql|sqlite3|mysql|mariadb|supabase\s+db|prisma\s+db|drizzle-kit)\b') {
        exit 0
    }

    # A shell call names its client on the command line; an MCP call only has
    # the server name. Either way, 'unknown' means every dialect's rules apply
    # and nothing is neutralized.
    if ($grammar -eq 'shell') {
        $dialect = Get-SqlDialect $sql $script:ClientDialectPatterns
    } else {
        $dialect = Get-SqlDialect $toolName $script:McpDialectPatterns
    }

    $firstDdl = Invoke-StatementScan $sql $grammar '' $dialect

    # The statement need not be on the command line. Read what the client is being
    # pointed at and scan that too; a file route with nothing readable behind it
    # is blocked rather than being waved through.
    if ($grammar -eq 'shell') {
        # @() is load-bearing. PowerShell unrolls a returned collection, so a single
        # candidate comes back as a bare string, and under Set-StrictMode -Version
        # Latest reading .Count off a string throws -- which the catch below turns
        # into exit 0. The guard failed open on exactly the calls it was added for.
        $candidates = @(Get-FileRouteCandidate $sql)
        if ($candidates.Count -gt 0) {
            $cwd = if ($payload.PSObject.Properties.Name -contains 'cwd') { [string]$payload.cwd } else { '' }
            foreach ($candidate in $candidates) {
                $path = $candidate.Path
                $content = Read-SqlFile $path $cwd
                if ($null -eq $content) { Deny 'SQL file is unreadable; cannot verify its contents.' 'Unreadable SQL file' }
                $ddl = Invoke-StatementScan $content 'sql' " (from $path)" $candidate.Dialect
                if ($null -ne $ddl) { Deny 'File-based DDL approval is unsupported; submit and approve the SQL text directly.' 'DDL in SQL file' }
            }
        }
    }

    # The approval covers the whole call, so check it ONCE, after the loop.
    # Checking inside the loop consumed the single-use token on the first DDL
    # statement, so an approved migration containing two of them always failed
    # on the second. Migrations routinely contain several statements.
    #
    # The displayed statement is $sql, the exact text Test-Approved fingerprints
    # -- not $firstDdl, which is only the first ';'-delimited segment and, for
    # shell grammar, does not include the client wrapper or trailing characters
    # (e.g. the closing quote and semicolon of 'psql -c "alter table t add c;"').
    # Showing $firstDdl looked like the approval target but was not: a human who
    # copied it verbatim into approve-ddl.ps1 got a different fingerprint and the
    # retry stayed blocked with no indication why. See data/pitfalls/hook-005.json.
    if ($null -ne $firstDdl -and -not (Test-Approved $sql)) {
        Deny 'This statement requires a human approval token that is missing or expired.' $sql
    }

    exit 0
}
catch {
    # An inspection failure is not a successful safety check. Do not print input.
    [Console]::Error.WriteLine('[guard-sql] hook error (blocked): unable to inspect input')
    exit 2
}
