#requires -Version 5.1
<#
.SYNOPSIS
    Claude Code hook. Stops the agent from modifying or deleting this kit's
    own guardrails, and refuses live edits to the installed settings.json
    outright.

.DESCRIPTION
    PowerShell twin of guard-config.mjs. Same behaviour, same protected
    paths, same three hook events (PreToolUse, ConfigChange, SessionStart).
    See guard-config.mjs for the full design notes, including why
    SessionStart can only warn (additionalContext / systemMessage) and never
    block -- Claude Code ignores its exit code and any decision field
    outright (code.claude.com/docs/en/hooks, checked 2026-09-18). This file
    only carries the parts that differ for PowerShell.

    ASCII-only on purpose. See the encoding note in guard-sql.ps1.

.NOTES
    Exit 0 -> allow.  Exit 2 -> block, reason on stderr. SessionStart always
    exits 0 regardless of outcome; it speaks through stdout JSON instead.
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
# known-good/ holds the SessionStart baseline: it needs the same protection
# as approvals/, or a tampered settings.json and a freshly "approved"
# baseline could land together and the SessionStart check would never see a
# mismatch.
$script:ProtectedSubpaths = @('settings.json', 'CLAUDE.md', 'hooks', 'scripts', 'approvals', 'known-good')

$script:KnownGoodDir = Join-Path $ClaudeHome 'known-good'
$script:KnownGoodSettings = Join-Path $script:KnownGoodDir 'settings.json'
$script:InstalledSettings = Join-Path $ClaudeHome 'settings.json'

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

# Emits SessionStart's supported JSON output. additionalContext reaches
# Claude directly (SessionStart is one of the few events whose stdout the
# model actually sees); systemMessage reaches the human. SessionStart
# ignores exit codes and decision fields entirely -- there is no "block"
# branch to fall back to.
function Warn-SessionStart([string] $Message, [string] $SystemMessage) {
    $decision = @{
        hookSpecificOutput = @{ hookEventName = 'SessionStart' }
        additionalContext  = $Message
        systemMessage      = $SystemMessage
    } | ConvertTo-Json -Compress
    [Console]::Out.WriteLine($decision)
    [Console]::Error.WriteLine($Message)
}

# Compares the installed settings.json against the known-good/ baseline. See
# guard-config.mjs for the full design notes (hook-007.json / hook-011.json).
# Never throws: any failure here falls through to the outer try/catch and
# exits 0, same fail-open posture as the rest of this hook.
function Test-SessionStartBaseline {
    if (-not (Test-Path -LiteralPath $script:InstalledSettings -PathType Leaf)) { return }
    $current = [System.IO.File]::ReadAllBytes($script:InstalledSettings)

    if (-not (Test-Path -LiteralPath $script:KnownGoodSettings -PathType Leaf)) {
        # No baseline yet: an install that predates this check, or
        # known-good/ was lost. Trust the current file once rather than warn
        # on every session forever.
        try {
            New-Item -ItemType Directory -Path $script:KnownGoodDir -Force | Out-Null
            [System.IO.File]::WriteAllBytes($script:KnownGoodSettings, $current)
        } catch {
            # Could not record a baseline. Fail open: say nothing rather
            # than warn every single session with no way to clear it.
            return
        }
        Warn-SessionStart `
            "[guard-config] settings.json baseline recorded for the first time ($script:KnownGoodSettings). If $script:InstalledSettings does not reflect a version you trust, review it now and re-record with record-settings-baseline once it is correct." `
            'guard-config: settings.json baseline recorded for the first time.'
        return
    }

    $baseline = [System.IO.File]::ReadAllBytes($script:KnownGoodSettings)
    if ([Convert]::ToBase64String($current) -ceq [Convert]::ToBase64String($baseline)) { return }

    Warn-SessionStart `
        "[guard-config] WARNING: $script:InstalledSettings does not match its last recorded baseline ($script:KnownGoodSettings). It may have been edited while Claude Code was not running, or a change that ConfigChange blocked from an earlier session still landed on disk (see data/pitfalls/hook-007.json). Review the file yourself before trusting it. If this change is intentional, re-record the baseline outside Claude Code with record-settings-baseline." `
        'guard-config: settings.json changed since the last recorded baseline -- see additional context.'
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
        # payload does carry a config_source field and it names something
        # else, skip rather than block, on the theory that an unrecognized
        # source is more likely a Claude Code change we have not accounted
        # for than a reason to widen this hook's blast radius by accident.
        #
        # The field is config_source, not source -- corrected 2026-09-18
        # against code.claude.com/docs/en/hooks. See guard-config.mjs's copy
        # of this comment for why the old name never changed observed
        # behaviour, and data/pitfalls/hook-011.json for the confidence note.
        $source = if ($payload.PSObject.Properties.Name -contains 'config_source') {
            [string] $payload.config_source
        } else { $null }
        if (-not $source -or $source -eq 'user_settings') { Deny-ConfigChange }
        exit 0
    }

    if ($hookEventName -eq 'SessionStart') {
        # Matcher entries can restrict this to startup|resume, but check
        # here too in case of a custom, broader registration -- the same
        # defensive posture as the ConfigChange source check above.
        $startupType = if ($payload.PSObject.Properties.Name -contains 'startup_type') {
            [string] $payload.startup_type
        } else { $null }
        if (-not $startupType -or $startupType -eq 'startup' -or $startupType -eq 'resume') {
            Test-SessionStartBaseline
        }
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
