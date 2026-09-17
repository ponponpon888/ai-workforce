#requires -Version 5.1
<#
.SYNOPSIS
    Claude Code hook. Stops the agent from modifying or deleting this kit's
    own guardrails, and refuses live edits to the installed settings.json
    outright.

.DESCRIPTION
    PowerShell twin of guard-config.mjs. Same behaviour, same protected
    paths, same two hook events (PreToolUse and ConfigChange). See
    guard-config.mjs for the full design notes; this file only carries the
    parts that differ for PowerShell.

    ASCII-only on purpose. See the encoding note in guard-sql.ps1.

.NOTES
    Exit 0 -> allow.  Exit 2 -> block, reason on stderr.
    Any internal failure exits 0: a broken guard must not brick the toolchain.
#>

[CmdletBinding()]
param(
    [string] $ClaudeHome = $(
        if ($env:AIWF_CLAUDE_HOME) { $env:AIWF_CLAUDE_HOME }
        else { Join-Path $HOME '.claude' }
    )
)

Set-StrictMode -Version Latest

# Windows paths are case-insensitive end to end; C:\Users\X\.claude and
# c:\users\x\.claude name the same directory. Normalize case only for the
# home prefix itself, not the subpath names chosen below.
$script:HomeNorm = ($ClaudeHome -replace '\\', '/').ToLowerInvariant()

# Directories and files inside the claude home that this hook protects.
$script:ProtectedSubpaths = @('settings.json', 'CLAUDE.md', 'hooks', 'scripts', 'approvals')

# The protected subpath a piece of text names, or $null.
function Get-ProtectedSubpath([string] $Text) {
    $norm = ($Text -replace '\\', '/').ToLowerInvariant()
    foreach ($sub in $script:ProtectedSubpaths) {
        if ($norm.Contains("$script:HomeNorm/$($sub.ToLowerInvariant())")) { return $sub }
    }
    return $null
}

# Commands that write, overwrite, rename, or delete a file. Matched against
# the leading word of a shell segment, the same shape as guard-secrets' reader
# list. cp/Copy-Item etc. are treated as writers regardless of which argument
# is the protected path -- copying a protected file out is blocked too, along
# with copying one in. Back it up by hand instead.
$script:WriteCommands = @(
    # POSIX
    'rm', 'cp', 'mv', 'tee', 'truncate', 'install', 'dd', 'shred', 'ln',
    # PowerShell (cmdlet names and their common aliases)
    'remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir',
    'copy-item', 'copy',
    'move-item', 'move',
    'rename-item', 'ren',
    'set-content', 'sc', 'add-content', 'ac', 'out-file', 'clear-content', 'clc',
    'new-item', 'ni'
)

# sed -i / perl -i edit the file named elsewhere on the same line, in place.
$script:InplaceEditPattern = '(?:^|\s)(?:sed|perl)\s+.*-i\b'

# Redirection into a file: > path, >> path -- the same operators in both
# POSIX shells and PowerShell. The negative lookarounds keep <path and >>>
# from being misread; they do not need to be exact, only to avoid capturing
# the wrong token as the destination.
$script:OutputRedirectPattern = '(?<!<)>>?(?!>)\s*([^\s;|&<>]+)'

function Get-LeafOf([string] $Token) {
    $bare = $Token -replace "^['`"]+", '' -replace "['`"]+`$", ''
    $parts = $bare -split '[\\/]'
    $leaf = $parts[$parts.Count - 1]
    if (-not $leaf) { $leaf = $bare }
    return ($leaf.ToLowerInvariant() -replace '\.exe$', '')
}

# The command word of a segment: leading env assignments and sudo are prefixes.
function Get-CommandWord([string] $Segment) {
    $tokens = @($Segment.Trim() -split '\s+' | Where-Object { $_ })
    $i = 0
    while ($i -lt $tokens.Count -and (
        $tokens[$i] -match '^[A-Za-z_][A-Za-z0-9_]*=' -or
        $tokens[$i] -eq 'sudo' -or $tokens[$i] -eq 'command'
    )) {
        $i++
    }
    if ($i -ge $tokens.Count) { return '' }
    return Get-LeafOf $tokens[$i]
}

# One command line can be several commands. &&/||/;/newline/$( all split it,
# so "cd /tmp && rm <path>" is inspected as two segments and the second one
# alone decides the verdict -- a wrapper in front does not hide it.
function Get-Segments([string] $Command) {
    return $Command -split '&&|\|\||[;|&\n\r]|\$\('
}

# Why this segment counts as a write to a protected path, or $null.
function Get-WriterHit([string] $Segment) {
    foreach ($m in [regex]::Matches($Segment, $script:OutputRedirectPattern)) {
        $sub = Get-ProtectedSubpath $m.Groups[1].Value
        if ($sub) { return [pscustomobject]@{ Sub = $sub; Via = 'output redirection' } }
    }
    if ($Segment -match $script:InplaceEditPattern) {
        $sub = Get-ProtectedSubpath $Segment
        if ($sub) { return [pscustomobject]@{ Sub = $sub; Via = 'in-place edit (sed/perl -i)' } }
    }
    $word = Get-CommandWord $Segment
    if ($script:WriteCommands -contains $word) {
        $sub = Get-ProtectedSubpath $Segment
        if ($sub) { return [pscustomobject]@{ Sub = $sub; Via = $word } }
    }
    return $null
}

function Deny-PreToolUse($Hit, [string] $Detail) {
    $lines = @(
        "[guard-config] BLOCKED: this call would modify or delete this kit's own guardrails."
        ''
        "Protected path : $ClaudeHome/$($Hit.Sub)"
        "Matched by     : $($Hit.Via)"
    )
    if ($Detail) { $lines += "Command/target : $Detail" }
    $lines += ''
    $lines += 'What to do:'
    $lines += '  1. If this change is intentional, make it yourself outside Claude Code -'
    $lines += '     edit the file directly, or run the script in your own terminal.'
    $lines += '  2. Do not look for a different tool or command to reach the same file;'
    $lines += '     this hook matches by path, not by which tool asked.'
    [Console]::Error.WriteLine(($lines -join "`n"))
    exit 2
}

# ConfigChange has no message surfaced to Claude or the user on a block
# (Anthropic's own docs say so). Writing to stderr is still worth doing for
# anyone reading the debug log, and printing the JSON decision alongside
# exit 2 is belt-and-suspenders: exit 2 blocks "whether or not you print
# JSON", per the hooks reference, so this does not depend on the decision
# schema being exactly right.
function Deny-ConfigChange {
    $decision = @{
        decision = 'block'
        reason   = "guard-config: this kit's settings.json is not editable from inside Claude Code."
    } | ConvertTo-Json -Compress
    [Console]::Out.WriteLine($decision)
    [Console]::Error.WriteLine(
        "[guard-config] BLOCKED: a ConfigChange to the installed settings.json was refused.`n" +
        'Edit it yourself, outside Claude Code, if this change is intentional.'
    )
    exit 2
}

try {
    $raw = [Console]::In.ReadToEnd()
    if (-not $raw) { exit 0 }

    $payload = $raw | ConvertFrom-Json
    $hookEventName = if ($payload.PSObject.Properties.Name -contains 'hook_event_name') {
        [string] $payload.hook_event_name
    } else { '' }

    if ($hookEventName -eq 'ConfigChange') {
        # settings.json's own hooks.ConfigChange matcher is already scoped to
        # "user_settings", so this only ever fires for the installed
        # ~/.claude/settings.json. The extra check here is defensive: if the
        # payload does carry a source field and it names something else, skip
        # rather than block, on the theory that an unrecognized source is more
        # likely a Claude Code change we have not accounted for than a reason
        # to widen this hook's blast radius by accident.
        $source = if ($payload.PSObject.Properties.Name -contains 'source') {
            [string] $payload.source
        } else { $null }
        if (-not $source -or $source -eq 'user_settings') { Deny-ConfigChange }
        exit 0
    }

    $toolName = if ($payload.PSObject.Properties.Name -contains 'tool_name') {
        [string] $payload.tool_name
    } else { '' }
    $toolInput = if ($payload.PSObject.Properties.Name -contains 'tool_input') {
        $payload.tool_input
    } else { $null }

    if ($toolName -match '^(Edit|Write|MultiEdit|NotebookEdit)$') {
        $filePath = if ($toolInput -and ($toolInput.PSObject.Properties.Name -contains 'file_path')) {
            [string] $toolInput.file_path
        } else { '' }
        if ($filePath) {
            $sub = Get-ProtectedSubpath $filePath
            if ($sub) { Deny-PreToolUse ([pscustomobject]@{ Sub = $sub; Via = "$toolName tool" }) $filePath }
        }
    } elseif ($toolName -match '^(Bash|PowerShell)$') {
        $command = if ($toolInput -and ($toolInput.PSObject.Properties.Name -contains 'command')) {
            [string] $toolInput.command
        } else { '' }
        if ($command.Trim()) {
            foreach ($segment in (Get-Segments $command)) {
                if (-not $segment.Trim()) { continue }
                $hit = Get-WriterHit $segment
                if ($hit) { Deny-PreToolUse $hit $segment.Trim() }
            }
        }
    }

    exit 0
} catch {
    # A failed inspection is not a successful safety check, but this hook
    # guards metadata about the other guards rather than a destructive action
    # directly -- fail open, as guard-secrets does, rather than block every
    # tool call kit-wide over an unparseable payload.
    exit 0
}
