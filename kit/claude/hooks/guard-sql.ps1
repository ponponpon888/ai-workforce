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
       .\kit\scripts\approve-ddl.ps1 -Sql '<the exact statement>'
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
function Get-NeutralizedSql([string] $Sql) {
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

# Pull SQL out of whichever tool is being called.
function Get-SqlFromToolInput($ToolName, $ToolInput) {
    if ($null -eq $ToolInput) { return '' }

    foreach ($key in @('query', 'sql', 'statement', 'command')) {
        if ($ToolInput.PSObject.Properties.Name -contains $key) {
            $value = $ToolInput.$key
            if ($value -is [string] -and $value.Trim()) { return $value }
        }
    }
    return ''
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

    $sql = Get-SqlFromToolInput $toolName $toolInput
    if (-not $sql.Trim()) { exit 0 }

    # Only inspect tools that actually talk to a database. The settings.json
    # matcher should already do this, but a matcher is one edit away from being
    # widened, and a `query` field on some unrelated MCP tool must not be read
    # as SQL. Defence in depth, and it costs nothing.
    if ($toolName -notmatch '^(Bash|mcp__[Ss]upabase__|mcp__postgres|mcp__neon|mcp__planetscale)') {
        exit 0
    }

    # A Bash call only counts as SQL if it actually invokes a database client.
    if ($toolName -eq 'Bash' -and $sql -notmatch '(?is)\b(psql|sqlite3|mysql|mariadb|supabase\s+db|prisma\s+db|drizzle-kit)\b') {
        exit 0
    }

    $clean = Get-NeutralizedSql $sql

    $firstDdl = $null

    foreach ($stmt in ($clean -split ';')) {
        if (-not $stmt.Trim()) { continue }

        if ($stmt -match '(?is)\bDROP\b') {
            Deny 'DROP is never allowed from an agent.' $stmt
        }
        if ($stmt -match '(?is)\bTRUNCATE\b') {
            Deny 'TRUNCATE is never allowed from an agent.' $stmt
        }
        if ($stmt -match '(?is)\bDELETE\s+FROM\b' -and $stmt -notmatch '(?is)\bWHERE\b') {
            Deny 'DELETE without a WHERE clause.' $stmt
        }
        if ($stmt -match '(?is)\bUPDATE\b[\s\S]*\bSET\b' -and $stmt -notmatch '(?is)\bWHERE\b') {
            Deny 'UPDATE without a WHERE clause.' $stmt
        }
        if ($null -eq $firstDdl -and $stmt -match '(?is)\b(CREATE|ALTER|GRANT|REVOKE|REINDEX|VACUUM)\b') {
            $firstDdl = $stmt
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
