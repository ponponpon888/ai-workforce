#requires -Version 5.1
<#
.SYNOPSIS
    Claude Code PreToolUse hook. Stops a shell command from reading a secret
    file into the transcript.

.DESCRIPTION
    The 'deny' list in settings.json can hold Read(./.env), and that is real --
    but it only binds the Read tool. 'cat .env', 'Get-Content .env' and
    'sed -n 1p .env' arrive through the Bash and PowerShell tools instead, and
    walk straight past it. There is no pattern that closes this in 'permissions':
    denying Get-Content denies reading every file there is.

    So it is decided here, the same way guard-sql decides SQL. Unlike the
    permission layer, this one is our code, which means it can have tests.

    THE RULE
    Block when a command both (a) names a secret file and (b) is a shape that
    reads a file. Either one alone is fine: 'rm .env.bak' names one without
    reading it, 'grep -r createClient src/' reads without naming one.

    NOTE ON SCOPE
    This stops accidents, not an adversary. 'cp .env /tmp/x' then reading /tmp/x
    gets through, and so does any reader not on the list below. The point is that
    the common case -- a model reaching for 'cat .env' because it wants a
    connection string -- hits a wall instead of pasting a service-role key into a
    transcript that then persists.

    NOTE ON ENCODING
    This file is deliberately ASCII-only. Windows PowerShell 5.1 reads a BOM-free
    UTF-8 script as the system ANSI codepage, so non-ASCII string literals would be
    mojibake on a Japanese Windows install. Keep it ASCII.

.NOTES
    Exit 0 -> allow.  Exit 2 -> block, reason on stderr.
    Any other failure exits 0: a broken guard must not brick the toolchain.
#>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest

# ---------------------------------------------------------------------------
# Data: what counts as a secret file.
# ---------------------------------------------------------------------------

# These are meant to be committed and read. A file called .env.example is
# documentation, and blocking it is the kind of false positive that gets the
# whole hook switched off.
$PublicEnvSuffixes = @('example', 'sample', 'template', 'dist')

# 'secrets/' came straight from the deny list, and on its own it is too wide:
# src/lib/secrets/masker.ts is code that handles secrets, not a secret. Source
# and prose under a secrets/ directory are not treated as secret.
#
# Config extensions are deliberately absent. secrets/prod.yaml is exactly the
# kind of file this is for.
$NonSecretExtensions = @(
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs',
    '.java', '.php', '.cs', '.sql',
    '.md', '.txt', '.html', '.css', '.scss'
)

$SecretPatterns = @(
    # A leading dot is required: src/lib/env.ts and docs/environment.md must not
    # match. The optional suffix chain covers .env.local.
    @{ Label = 'dotenv file'
       Pattern = '(?<![\w.\-])(?:[\w.\-/~]*/)?\.env(?![\w])(?:\.[\w-]+)*'
       Dotenv = $true
       SkipSourceAndProse = $false }
    @{ Label = 'private key'
       Pattern = '(?<![\w.\-])[\w.\-/~]*\.pem(?![\w])'
       Dotenv = $false
       SkipSourceAndProse = $false }
    @{ Label = 'ssh private key'
       Pattern = '(?<![\w.\-])[\w.\-/~]*id_(?:rsa|dsa|ecdsa|ed25519)[\w.\-]*'
       Dotenv = $false
       SkipSourceAndProse = $false }
    @{ Label = 'service account key'
       Pattern = '(?<![\w.\-])[\w.\-/~]*service-account[\w.\-]*\.json(?![\w])'
       Dotenv = $false
       SkipSourceAndProse = $false }
    @{ Label = 'secrets directory'
       Pattern = '(?<![\w.\-])[\w.\-/~]*secrets/[\w.\-/]*'
       Dotenv = $false
       SkipSourceAndProse = $true }
    @{ Label = 'ssh directory'
       Pattern = '(?<![\w.\-])[\w.\-/~]*\.ssh/[\w.\-]*'
       Dotenv = $false
       SkipSourceAndProse = $false }
)

# ---------------------------------------------------------------------------
# Data: what counts as reading a file. Add to these lists, do not rewrite the
# logic below.
# ---------------------------------------------------------------------------

# Matched against the first word of a command, case-insensitively.
$ReadCommands = @(
    # POSIX shell
    'cat', 'tac', 'head', 'tail', 'less', 'more', 'nl', 'od', 'xxd', 'strings', 'base64',
    'grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk', 'cut', 'sort', 'uniq', 'wc', 'jq',
    'source', '.',
    # PowerShell
    'get-content', 'gc', 'type', 'select-string', 'sls', 'import-csv', 'format-hex', 'fhx'
)

# Interpreters only read a file when they are handed inline code to run.
$Interpreters = @('python', 'python3', 'node', 'perl', 'ruby', 'php')
$InlineCodeFlag = '(?:^|\s)-{1,2}[cer](?:\s|$)'

# git prints file contents, and 'git show HEAD:.env' is one move, not two.
# Only these subcommands do it: checkout, add and rm name the same path without
# revealing anything, so 'git' alone is not enough to count as a read.
$GitContentSubcommands = @('show', 'diff', 'cat-file', 'blame')
$GitPatchFlag = '(?:^|\s)(?:-p|--patch)(?:\s|$)'
# Global options that swallow the next word, which is therefore not the subcommand.
$GitOptionsWithValue = @('-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path')

# PowerShell can read a file without naming a cmdlet at all.
$DotNetRead = '\[\s*(?:System\s*\.\s*)?IO\s*\.\s*File\s*\]\s*::\s*Read(?:AllText|AllBytes|AllLines)'

# 'node < .env' reads the file without any reader on the list being present.
$InputRedirect = '(?<![<>])<(?![<&])\s*([^\s;|&<>]+)'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Deny([string] $Command, [string] $Path, [string] $Label, [string] $Reader) {
    $snippet = $Command.Trim()
    if ($snippet.Length -gt 400) { $snippet = $snippet.Substring(0, 400) + ' ...' }

    $msg = @"
[guard-secrets] BLOCKED: this command reads a secret file.

Command:
  $snippet

Matched:
  file    : $Path  ($Label)
  read by : $Reader

What to do:
  1. Do not read it another way. The contents would land in this
     transcript and stay there.
  2. If you need one value, ask the human for that one value and have
     them paste it. They can keep the rest of the file to themselves.
  3. If you only need to know which keys exist, ask them to run this
     themselves and paste the key names alone:
       bash        : cut -d= -f1 .env
       powershell  : (Get-Content .env) -replace '=.*'
  4. To set a value, use the tool that owns it rather than the file:
       vercel env add / supabase secrets set / gh secret set
  5. If this file is not a secret, name it as one that is not:
       .env.example  .env.sample  .env.template  .env.dist
"@
    [Console]::Error.WriteLine($msg)
    exit 2
}

# The first secret path named anywhere in this segment, or $null.
function Find-SecretPath([string] $Text) {
    foreach ($p in $SecretPatterns) {
        foreach ($m in [regex]::Matches($Text, $p.Pattern)) {
            if ($p.Dotenv) {
                $tail = $m.Value.Substring($m.Value.IndexOf('.env') + 4)
                $isPublic = $false
                foreach ($part in ($tail -split '\.')) {
                    if ($part -and ($PublicEnvSuffixes -contains $part.ToLowerInvariant())) {
                        $isPublic = $true
                    }
                }
                if ($isPublic) { continue }
            }
            if ($p.SkipSourceAndProse) {
                $dot = $m.Value.LastIndexOf('.')
                if ($dot -gt 0) {
                    $ext = $m.Value.Substring($dot).ToLowerInvariant()
                    if ($NonSecretExtensions -contains $ext) { continue }
                }
            }
            return @{ Path = $m.Value; Label = $p.Label }
        }
    }
    return $null
}

# "/usr/bin/cat" is still cat.
function Get-Leaf([string] $Token) {
    $bare = $Token -replace '^[''"]+|[''"]+$', ''
    if (-not $bare) { return '' }
    $parts = @($bare -split '[\\/]')
    $leaf = $parts[$parts.Count - 1]
    if (-not $leaf) { $leaf = $bare }
    return $leaf.ToLowerInvariant()
}

# The command word of a segment: leading environment assignments and 'sudo' are
# prefixes, not the command.
function Get-CommandWord([string] $Segment) {
    $tokens = @($Segment.Trim() -split '\s+' | Where-Object { $_ })
    $i = 0
    while ($i -lt $tokens.Count -and (
            $tokens[$i] -match '^[A-Za-z_][A-Za-z0-9_]*=' -or
            $tokens[$i] -eq 'sudo' -or
            $tokens[$i] -eq 'command')) {
        $i++
    }
    if ($i -ge $tokens.Count) { return '' }
    return Get-Leaf $tokens[$i]
}

# The subcommand of a git call. Walking the tokens rather than searching the
# whole segment is what keeps 'git commit -m "show the .env format"' out of it:
# the subcommand there is commit, and the word show is a message.
function Get-GitSubcommand([string] $Segment) {
    $tokens = @($Segment.Trim() -split '\s+' | Where-Object { $_ })
    $i = -1
    for ($k = 0; $k -lt $tokens.Count; $k++) {
        if ((Get-Leaf $tokens[$k]) -eq 'git') { $i = $k; break }
    }
    if ($i -lt 0) { return '' }

    for ($i = $i + 1; $i -lt $tokens.Count; $i++) {
        if ($GitOptionsWithValue -contains $tokens[$i]) { $i++; continue }
        if ($tokens[$i].StartsWith('-')) { continue }
        return $tokens[$i].ToLowerInvariant()
    }
    return ''
}

# Why this segment counts as a read, or $null if it does not.
function Find-Reader([string] $Segment) {
    $word = Get-CommandWord $Segment

    if ($ReadCommands -contains $word) { return $word }

    if ($word -eq 'git') {
        $sub = Get-GitSubcommand $Segment
        if ($GitContentSubcommands -contains $sub) { return "git $sub" }
        if ($sub -eq 'log' -and $Segment -match $GitPatchFlag) { return 'git log -p' }
    }
    if (($Interpreters -contains $word) -and ($Segment -match $InlineCodeFlag)) {
        return "$word with inline code"
    }
    if ($Segment -match $DotNetRead) { return '[IO.File]::Read...' }

    foreach ($m in [regex]::Matches($Segment, $InputRedirect)) {
        if ($null -ne (Find-SecretPath $m.Groups[1].Value)) { return 'input redirection' }
    }

    return $null
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

try {
    $raw = [Console]::In.ReadToEnd()
    if (-not $raw) { exit 0 }

    $payload = $raw | ConvertFrom-Json

    $toolName = ''
    if ($payload.PSObject.Properties.Name -contains 'tool_name') {
        $toolName = [string]$payload.tool_name
    }
    if ($toolName -notmatch '^(Bash|PowerShell)$') { exit 0 }

    $command = ''
    if ($payload.PSObject.Properties.Name -contains 'tool_input') {
        $toolInput = $payload.tool_input
        if ($null -ne $toolInput -and $toolInput.PSObject.Properties.Name -contains 'command') {
            $value = $toolInput.command
            if ($value -is [string]) { $command = $value }
        }
    }
    if (-not $command.Trim()) { exit 0 }

    # One command line can be several commands. Splitting on the separators keeps
    # 'cat .env | head' and 'KEY=$(cat .env)' from hiding behind a harmless first
    # word. Parentheses are deliberately NOT separators: splitting on them tears
    # 'python -c "print(open(''.env'').read())"' apart and the path stops being
    # visible from the interpreter that reads it.
    foreach ($segment in ($command -split '\$\(|[;|&\r\n]')) {
        if (-not $segment.Trim()) { continue }

        $hit = Find-SecretPath $segment
        if ($null -eq $hit) { continue }

        $reader = Find-Reader $segment
        if ($reader) { Deny $command $hit.Path $hit.Label $reader }
    }

    exit 0
}
catch {
    # Fail open, loudly. A guard that crashes must not become a guard that blocks
    # everything -- that trains people to disable it.
    [Console]::Error.WriteLine("[guard-secrets] hook error (allowing call): $($_.Exception.Message)")
    exit 0
}
