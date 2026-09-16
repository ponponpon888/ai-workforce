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
$script:FileRoutePatterns = @(
    '(?:^|\s)(?:-f|--file)[=\s]+(\S+)',       # psql -f x.sql / --file=x.sql
    '(?:^|\s)<(?!<)\s*(\S+)',                 # psql < x.sql
    '\\ir?\s+(\S+)',                          # psql -c "\i x.sql"
    '\bcat\s+(\S+)',                          # cat x.sql | psql
    '(?:^|[\s"''`=])([^\s"''`;|<>]+\.sql)\b'  # any .sql path, however it got there
)

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

function Invoke-StatementScan([string] $Text, [string] $Grammar, [string] $Where) {
    $firstDdl = $null
    $cleaned = Get-NeutralizedSql $Text $Grammar
    if ($Grammar -eq 'sql' -and $cleaned -match '(?:^|[\r\n])\s*\\(?:i|ir)\b') {
        Deny "Nested SQL includes are unsupported; submit the reviewed SQL directly.$Where" 'SQL include'
    }
    foreach ($stmt in ($cleaned -split ';')) {
        if (-not $stmt.Trim()) { continue }
        if ($stmt -match '(?is)\bDROP\b') { Deny "DROP is never allowed from an agent.$Where" $stmt }
        if ($stmt -match '(?is)\bTRUNCATE\b') { Deny "TRUNCATE is never allowed from an agent.$Where" $stmt }
        if (($Grammar -eq 'sql' -and $stmt -match '(?i)^\s*DO\b') -or ($Grammar -eq 'shell' -and $stmt -match '(?i)\bDO\s+(?:LANGUAGE\b|[''"$])')) { Deny "Procedural DO blocks are unsupported.$Where" $stmt }
        if (Test-UnfilteredMutation $stmt) { Deny "UPDATE/DELETE needs a WHERE in the same SQL scope.$Where" $stmt }
        if ($null -eq $firstDdl -and $stmt -match '(?is)\b(CREATE|ALTER|GRANT|REVOKE|REINDEX|VACUUM)\b') { $firstDdl = $stmt }
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
    if ($toolName -notmatch '^(Bash|PowerShell)$|mcp__.*[Ss]upabase|mcp__.*[Pp]ostgres|mcp__.*[Nn]eon|mcp__.*[Pp]lanetscale') {
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
    # is blocked rather than being waved through.
    if ($grammar -eq 'shell') {
        # @() is load-bearing. PowerShell unrolls a returned collection, so a single
        # candidate comes back as a bare string, and under Set-StrictMode -Version
        # Latest reading .Count off a string throws -- which the catch below turns
        # into exit 0. The guard failed open on exactly the calls it was added for.
        $candidates = @(Get-FileRouteCandidate $sql)
        if ($candidates.Count -gt 0) {
            $cwd = if ($payload.PSObject.Properties.Name -contains 'cwd') { [string]$payload.cwd } else { '' }
            foreach ($path in $candidates) {
                $content = Read-SqlFile $path $cwd
                if ($null -eq $content) { Deny 'SQL file is unreadable; cannot verify its contents.' 'Unreadable SQL file' }
                $ddl = Invoke-StatementScan $content 'sql' " (from $path)"
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
        Deny 'DDL requires a human approval token that is missing or expired.' $sql
    }

    exit 0
}
catch {
    # An inspection failure is not a successful safety check. Do not print input.
    [Console]::Error.WriteLine('[guard-sql] hook error (blocked): unable to inspect input')
    exit 2
}
