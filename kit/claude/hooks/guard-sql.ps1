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

    NOTE ON FILE ROUTES
    SQL does not have to appear on the command line. "psql -f x.sql", "psql < x.sql",
    "cat x.sql | psql" and "\i x.sql" all hand a database client a file, and a guard
    that reads only the command line sees none of it. The hook runs before the tool
    does, but the file was written by an earlier call and is already on disk, so it
    can be opened and scanned as SQL. When a file route is detected and nothing can
    be read, the call needs the same approval a DDL statement needs: an unreadable
    path is not a reason to assume the file is harmless.

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
    Any other failure exits 0: a broken guard must not brick the toolchain.
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
function Get-NeutralizedSql([string] $Sql, [string] $Grammar) {
    if ($Grammar -eq 'shell') { return $Sql }

    $pattern = @(
        "'(?:[^']|'')*'",                 # single-quoted literal, '' escape
        '\$([A-Za-z0-9_]*)\$.*?\$\1\$',   # postgres dollar-quoted body
        '--[^\r\n]*',                     # line comment
        '/\*.*?\*/'                       # block comment
    ) -join '|'

    $rx = [regex]::new($pattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)
    return $rx.Replace($Sql, {
        param($m)
        if ($m.Value.StartsWith("'") -or $m.Value.StartsWith('$')) { "''" } else { ' ' }
    })
}

function Get-SqlFingerprint([string] $Sql) {
    $normalized = ([regex]::Replace($Sql, '\s+', ' ')).Trim()
    $bytes  = [System.Text.Encoding]::UTF8.GetBytes($normalized)
    $sha    = [System.Security.Cryptography.SHA256]::Create()
    try {
        return -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
    } finally { $sha.Dispose() }
}

# A valid, unexpired approval token is consumed on use -- one statement, one run.
function Test-Approved([string] $Sql) {
    $file = Join-Path $ApprovalDir ((Get-SqlFingerprint $Sql) + '.approval')
    if (-not (Test-Path -LiteralPath $file)) { return $false }

    $age = (Get-Date) - (Get-Item -LiteralPath $file).LastWriteTime
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    return ($age.TotalMinutes -le $ApprovalTtlMinutes)
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
$script:FileRoutePatterns = @(
    '(?:^|\s)(?:-f|--file)[=\s]+(\S+)',       # psql -f x.sql / --file=x.sql
    '(?:^|\s)<(?!<)\s*(\S+)',                 # psql < x.sql
    '\\ir?\s+(\S+)',                          # psql -c "\i x.sql"
    '\bcat\s+(\S+)',                          # cat x.sql | psql
    '(?:^|[\s"''`=])([^\s"''`;|<>]+\.sql)\b'  # any .sql path, however it got there
)

# A pipeline stays whole: "cat x.sql | psql" is one segment.
$script:SegmentPattern = '&&|\|\||;|\r?\n'

# Files larger than this are not scanned; an unread file takes the approval path.
$script:MaxSqlFileBytes = 1048576

$script:SqlClientPattern = '(?is)\b(psql|sqlite3|mysql|mariadb|supabase\s+db|prisma\s+db|drizzle-kit)\b'

# Strip one layer of shell quoting from a token pulled out of a command line.
function Get-Unquoted([string] $Token) {
    return ($Token -replace '^["''`]+', '') -replace '["''`]+$', ''
}

# Paths a command line hands to a database client. Only segments that invoke a
# client are scanned, so an unrelated -f elsewhere on the line is left alone.
function Get-FileRouteCandidate([string] $Command) {
    $found = New-Object System.Collections.Generic.List[string]
    foreach ($segment in ($Command -split $script:SegmentPattern)) {
        if ($segment -notmatch $script:SqlClientPattern) { continue }
        foreach ($pattern in $script:FileRoutePatterns) {
            foreach ($m in [regex]::Matches($segment, $pattern)) {
                $path = Get-Unquoted $m.Groups[1].Value
                if ($path -and -not $found.Contains($path)) { $found.Add($path) | Out-Null }
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
function Invoke-StatementScan([string] $Text, [string] $Grammar, [string] $Where) {
    $firstDdl = $null
    foreach ($stmt in ((Get-NeutralizedSql $Text $Grammar) -split ';')) {
        if (-not $stmt.Trim()) { continue }

        if ($stmt -match '(?is)\bDROP\b') {
            Deny "DROP is never allowed from an agent.$Where" $stmt
        }
        if ($stmt -match '(?is)\bTRUNCATE\b') {
            Deny "TRUNCATE is never allowed from an agent.$Where" $stmt
        }
        if ($stmt -match '(?is)\bDELETE\s+FROM\b' -and $stmt -notmatch '(?is)\bWHERE\b') {
            Deny "DELETE without a WHERE clause.$Where" $stmt
        }
        if ($stmt -match '(?is)\bUPDATE\b[\s\S]*\bSET\b' -and $stmt -notmatch '(?is)\bWHERE\b') {
            Deny "UPDATE without a WHERE clause.$Where" $stmt
        }
        if ($null -eq $firstDdl -and $stmt -match '(?is)\b(CREATE|ALTER|GRANT|REVOKE|REINDEX|VACUUM)\b') {
            $firstDdl = $stmt
        }
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
    if ($toolName -notmatch '^(Bash|PowerShell|mcp__[Ss]upabase__|mcp__postgres|mcp__neon|mcp__planetscale)') {
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

    $firstDdl = Invoke-StatementScan $sql $grammar ''

    # The statement need not be on the command line. Read what the client is being
    # pointed at and scan that too; a file route with nothing readable behind it
    # takes the approval path rather than being waved through.
    if ($grammar -eq 'shell') {
        # @() is load-bearing. PowerShell unrolls a returned collection, so a single
        # candidate comes back as a bare string, and under Set-StrictMode -Version
        # Latest reading .Count off a string throws -- which the catch below turns
        # into exit 0. The guard failed open on exactly the calls it was added for.
        $candidates = @(Get-FileRouteCandidate $sql)
        if ($candidates.Count -gt 0) {
            $cwd = if ($payload.PSObject.Properties.Name -contains 'cwd') { [string]$payload.cwd } else { '' }
            $readAny = $false
            foreach ($path in $candidates) {
                $content = Read-SqlFile $path $cwd
                if ($null -eq $content) { continue }
                $readAny = $true
                $ddl = Invoke-StatementScan $content 'sql' " (from $path)"
                if ($null -eq $firstDdl) { $firstDdl = $ddl }
            }
            if (-not $readAny -and -not (Test-Approved $sql)) {
                $joined = $candidates -join ', '
                Deny "this call feeds a SQL file to a database client, and none of the files could be read ($joined), so what runs is unknown." $sql
            }
        }
    }

    # The approval covers the whole call, so check it ONCE, after the loop.
    # Checking inside the loop consumed the single-use token on the first DDL
    # statement, so an approved migration containing two of them always failed
    # on the second. Migrations routinely contain several statements.
    if ($null -ne $firstDdl -and -not (Test-Approved $sql)) {
        Deny 'DDL requires a human approval token that is missing or expired.' $firstDdl
    }

    exit 0
}
catch {
    # Fail open, loudly. A guard that crashes must not become a guard that blocks
    # everything -- that trains people to disable it.
    [Console]::Error.WriteLine("[guard-sql] hook error (allowing call): $($_.Exception.Message)")
    exit 0
}
