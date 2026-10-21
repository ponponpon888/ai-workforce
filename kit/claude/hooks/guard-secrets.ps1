#requires -Version 5.1
<#
.SYNOPSIS
    Claude Code PreToolUse hook. Stops a shell command from reading a secret
    file into the transcript, or from overwriting or deleting one.

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
    reads, writes or destroys a file. Either one alone is fine:
    'grep -r createClient src/' reads without naming a secret, and
    'Set-Content notes.txt x' writes without naming one.

    Writing counts because a secret that is overwritten or deleted is as gone
    as one that is leaked: what is in a .env is usually the only copy of it,
    and nothing here can put it back. 'rm .env.bak' was the example this file
    used for something deliberately let through. It no longer is -- a backup of
    a secret is still a secret, and deleting it is not undoable either.

    NOTE ON SCOPE
    This stops accidents, not an adversary. Any reader or writer not on the
    lists below gets through, and so does anything that reaches the file
    without naming it -- a script holding the path, a wildcard. The point is that
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

# Skip-GdHeredocBodies decides where a heredoc body ends. guard-sql and
# guard-destructive already lex command lines with this; guard-secrets only
# needs the heredoc part of it.
. (Join-Path $PSScriptRoot (Join-Path 'lib' 'shell-lex.ps1'))

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
# Data: what counts as writing to, or destroying, a file. Same shape as the
# read lists above. Add to these lists, do not rewrite the logic below.
# ---------------------------------------------------------------------------

# Matched against the first word of a command, case-insensitively.
$WriteCommands = @(
    # POSIX shell
    'tee', 'cp', 'mv', 'install', 'ln', 'rm', 'unlink', 'shred', 'truncate', 'dd',
    # PowerShell cmdlets and the aliases people actually type. 'sc' and 'ac' are
    # Set-Content and Add-Content; 'ri', 'del' and 'erase' are Remove-Item.
    'set-content', 'sc', 'add-content', 'ac', 'clear-content', 'out-file',
    'new-item', 'ni', 'copy-item', 'cpi', 'copy', 'move-item', 'mi', 'move',
    'rename-item', 'rni', 'ren', 'remove-item', 'ri', 'del', 'erase'
)

# 'echo X=1 > .env' writes with no writer from the list present. A digit or '&'
# in front means a file descriptor rather than a path, which is why '2>&1' and
# '>&2' are not read as naming a file.
$OutputRedirect = '(?<![0-9&>])>{1,2}(?![>&])\s*([^\s;|&<>]+)'

# PowerShell can write or delete a file without naming a cmdlet at all.
$DotNetWrite = '\[\s*(?:System\s*\.\s*)?IO\s*\.\s*File\s*\]\s*::\s*(?:Write(?:AllText|AllBytes|AllLines)|Append(?:AllText|AllLines)|Delete|Copy|Move|Replace)'

# These overwrite or remove the file in the working tree. 'git add .env' and
# 'git commit -m "... .env ..."' name the path without changing it, so 'git'
# alone is not enough to count as a write.
$GitWriteSubcommands = @('checkout', 'restore', 'rm', 'mv')

# ---------------------------------------------------------------------------
# Data: which commands take a heredoc body as data rather than as code.
# ---------------------------------------------------------------------------

# A heredoc body is text until something runs it. "cat > notes.md <<'EOF'" with
# "echo X=1 > .env" inside it writes a Markdown file, and the .env there is a
# quotation. Reading every body line as its own command is what stopped this
# project's own report from being written (data/pitfalls/hook-018.json).
#
# So a body can be skipped -- but only when all four conditions below hold.
# This list is the second of them: the command the body is handed to consumes
# it as data and never executes or interprets it. Everything else keeps the old
# behaviour: "bash <<'EOF'" runs its body, "python - <<'EOF'" runs its body,
# and a secret named in there is as real as one named on the command line.
# 'sed -f -', 'awk -f -' and 'jq -f -' take the body as a program, so those are
# absent too. An unknown command reads, because reading costs a false positive
# and skipping costs a miss.
#
# Naming the receiving command was all the first version of this checked, and
# that was not enough: "cat <<'EOF' | bash" hands the body to cat, which copies
# it straight into a shell. The other three conditions ($RunsCodeCommands,
# $PipelineSeparator, and the quoted delimiter in Get-HeredocOpeners) are what
# close that.
#
# The destination is judged as it always was: the body is removed, the command
# line around it is not, so "cat > .env <<'EOF'" still blocks.
$HeredocDataCommands = @(
    # POSIX: stdin is a document to copy, count or search, not code.
    'cat', 'tac', 'tee', 'nl', 'head', 'tail', 'wc', 'rev', 'sort', 'uniq',
    'base64', 'fold', 'column', 'cmp', 'diff', 'grep', 'egrep', 'fgrep', 'rg',
    # The body is a message. 'git commit -F -' is how a long one gets written.
    'git commit', 'git tag', 'git notes',
    # PowerShell here-strings: the body is piped to something that stores or
    # prints it. iex, powershell and node are deliberately absent.
    'set-content', 'sc', 'add-content', 'ac', 'out-file', 'tee-object',
    'write-output', 'write-host', 'out-null', 'out-string', 'new-item', 'ni',
    'select-string', 'sls'
)

# Condition 4. Commands that run a file, or their own standard input, as code.
# A body stays data only for as long as nothing on the line can run it, and the
# command that receives the body is not the whole story:
# "cat > run.sh <<'EOF' ... EOF" followed by 'bash run.sh' writes code and then
# runs it. So if any of these appears anywhere on the command line -- judged
# with the bodies themselves removed, so that a word quoted inside a body
# cannot be what triggers it -- every body on that line is read.
#
# 'chmod' is here because making a file executable is the other half of running
# it, and 'xargs' because it builds a command out of its input.
#
# Running it later still counts. "cat <<'EOF' > j && crontab j" hands the body
# to cron rather than to a shell, and the body runs all the same.
$RunsCodeCommands = @(
    # Runs a file, or its own standard input, as code.
    'bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'busybox',
    'source', '.', 'eval', 'exec', 'xargs', 'parallel',
    'python', 'python3', 'node', 'deno', 'bun', 'perl', 'ruby', 'php',
    'lua', 'tclsh', 'rscript', 'osascript', 'npx',
    'pwsh', 'powershell', 'cmd', 'iex', 'invoke-expression',
    'invoke-command', 'icm', 'start-process', 'saps', 'chmod',
    # Registers a file so that something else runs it later.
    'crontab', 'at', 'batch', 'systemd-run', 'systemctl', 'launchctl',
    'schtasks', 'register-scheduledtask', 'register-scheduledjob',
    # A file of build steps is a file of commands.
    'make', 'gmake', 'ninja',
    # Runs whatever command comes after it.
    'nohup', 'setsid', 'timeout', 'env', 'stdbuf', 'nice', 'ionice', 'watch',
    'time', 'script',
    # Takes a program file: 'sed -f p.sed', 'awk -f p.awk', 'jq -f p.jq'. These
    # are far more often used to filter data, and naming one here costs a false
    # positive on a line that only happens to hold a data heredoc as well. The
    # body being read is the cheaper of the two mistakes, so they are here.
    'sed', 'awk', 'jq'
)

# './run.sh' runs a file with no interpreter named at all, which is the same
# move with one word removed. Only the extension is checked, because a command
# word has already been reduced to its leaf by the time it gets here and the
# leading './' is gone with the rest of the path.
$RunsAFile = '\.(?:sh|bash|zsh|ksh|ps1|psm1|bat|cmd|py|pl|rb|js|mjs|cjs|php)$'

# Options of 'xargs' that swallow the next word.
$XargsOptionsWithValue = @(
    '-I', '-i', '-n', '-L', '-P', '-s', '-d', '-E', '-e', '-a',
    '--replace', '--max-args', '--max-lines', '--max-procs', '--max-chars',
    '--delimiter', '--eof', '--arg-file'
)

# One command line can be several commands. Splitting on these separators keeps
# 'cat .env | head' and 'KEY=$(cat .env)' from hiding behind a harmless first
# word. Parentheses are deliberately NOT separators: splitting on them tears
# 'python -c "print(open(''.env'').read())"' apart and the path stops being
# visible from the interpreter that reads it.
$SegmentSeparator = '\$\(|[;|&\r\n]'

# A pipeline is what a heredoc body flows through, so '|' is not a separator
# here. ';' and '&' end one; '$(' starts a command of its own, the same way it
# does in $SegmentSeparator.
$PipelineSeparator = '\$\(|[;&\r\n]'

# '>(...)' and '<(...)' run a command, so a body that reaches one is read.
$ProcessSubstitution = '[<>]\('

# @' or @" with nothing after it on the line opens a PowerShell here-string.
$PsHereOpener = [regex] '@([''"])[ \t]*\r?(?=\n)'
$PsHereCloseSingle = [regex] '\r?\n[ \t]*''@'
$PsHereCloseDouble = [regex] '\r?\n[ \t]*"@'

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

function DenyWrite([string] $Command, [string] $Path, [string] $Label, [string] $Writer) {
    $snippet = $Command.Trim()
    if ($snippet.Length -gt 400) { $snippet = $snippet.Substring(0, 400) + ' ...' }

    $msg = @"
[guard-secrets] BLOCKED: this command writes to or deletes a secret file.

Command:
  $snippet

Matched:
  file       : $Path  ($Label)
  written by : $Writer

What to do:
  1. To change a value, ask the human to edit the file themselves. What
     is in a secret file is usually the only copy of it there is.
  2. To set an environment variable, use the tool that owns it rather
     than the file:
       vercel env add / supabase secrets set / gh secret set
  3. If a new environment needs one, ask them to copy .env.example
     themselves and fill it in.
  4. If this file is not a secret, name it as one that is not:
       .env.example  .env.sample  .env.template  .env.dist
"@
    [Console]::Error.WriteLine($msg)
    exit 2
}

# The first secret path named anywhere in this segment, or $null.
function Find-SecretPath([string] $Text) {
    # Classify Windows paths using the same patterns as slash-separated paths.
    $Text = $Text.Replace('\', '/')
    foreach ($p in $SecretPatterns) {
        foreach ($m in [regex]::Matches($Text, $p.Pattern)) {
            if ($p.Dotenv) {
                $fileName = ($m.Value -split '/')[-1]
                $tail = $fileName.Substring(4)
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
    return ($leaf.ToLowerInvariant() -replace '\.exe$', '')
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

# Why this segment counts as a write, or $null if it does not.
function Find-Writer([string] $Segment) {
    $word = Get-CommandWord $Segment

    if ($WriteCommands -contains $word) { return $word }

    if ($word -eq 'git') {
        $sub = Get-GitSubcommand $Segment
        if ($GitWriteSubcommands -contains $sub) { return "git $sub" }
    }
    if ($Segment -match $DotNetWrite) { return '[IO.File]::Write/Delete/...' }

    foreach ($m in [regex]::Matches($Segment, $OutputRedirect)) {
        if ($null -ne (Find-SecretPath $m.Groups[1].Value)) { return 'output redirection' }
    }

    return $null
}

# The pipeline of $Line that spans index $At.
function Get-PipelineAt([string] $Line, [int] $At) {
    $before = @($Line.Substring(0, $At) -split $PipelineSeparator)[-1]
    $after = @($Line.Substring($At) -split $PipelineSeparator)[0]
    return "$before$after"
}

# The command a body is handed to. 'git commit' is one name, not two.
function Get-HeredocReceiver([string] $Segment) {
    $word = Get-CommandWord $Segment
    if ($word -eq 'git') { return ('git ' + (Get-GitSubcommand $Segment)).Trim() }
    return $word
}

# Conditions 2 and 3: the body is handed to a command that consumes it as data,
# and so does everything that command pipes it on to.
# "cat <<'EOF' | sort | tee notes.md" stores a document; "cat <<'EOF' | bash"
# runs one, and naming only the receiver cannot tell the two apart.
function Test-PipesOnlyToData([string] $Line, [int] $At) {
    $pipeline = Get-PipelineAt $Line $At
    if ($pipeline -match $ProcessSubstitution) { return $false }
    $seen = 0
    foreach ($part in $pipeline.Split('|')) {
        $word = Get-HeredocReceiver $part
        if (-not $word) { continue }
        $seen++
        if (-not ($HeredocDataCommands -contains $word)) { return $false }
    }
    return ($seen -gt 0)
}

# Condition 4: the command on this line that runs code, or '' if there is none.
# The text passed in is the command line with every body already removed, so a
# word quoted inside a body is not what makes the body look like code.
function Find-CodeRunner([string] $Text) {
    foreach ($segment in ($Text -split $SegmentSeparator)) {
        $word = Get-CommandWord $segment
        if (-not $word) { continue }
        if (($RunsCodeCommands -contains $word) -or ($word -match $RunsAFile)) { return $word }
    }
    return ''
}

# Heredoc openers on one line, in order. Quoted text is skipped: 'grep "a << b"'
# opens nothing, and reading it as an opener would swallow the rest of the
# command -- including any real command on the next line.
function Get-HeredocOpeners([string] $Line) {
    $found = [System.Collections.Generic.List[object]]::new()
    $i = 0
    while ($i -lt $Line.Length) {
        $c = $Line[$i]
        if ($c -eq '\') { $i += 2; continue }
        if ($c -eq "'" -or $c -eq '"') {
            $end = $Line.IndexOf([string] $c, $i + 1)
            if ($end -lt 0) { break }
            $i = $end + 1
            continue
        }
        if ($c -ne '<') { $i++; continue }

        $j = $i
        while ($j -lt $Line.Length -and $Line[$j] -eq '<') { $j++ }
        # '<<<' is a here-string, which holds no body to skip.
        if (($j - $i) -ne 2) { $i = $j; continue }

        $strip = ($j -lt $Line.Length -and $Line[$j] -eq '-')
        if ($strip) { $j++ }
        while ($j -lt $Line.Length -and ($Line[$j] -eq ' ' -or $Line[$j] -eq "`t")) { $j++ }

        $m = [regex]::Match($Line.Substring($j), '^(?:''([^'']*)''|"([^"]*)"|([^\s;&|<>()]+))')
        if (-not $m.Success) { $i = $j; continue }
        # Condition 1. '<<EOF' expands $(...) and backticks in the body, so that
        # body is code the shell will run; any quoting in the delimiter --
        # "<<'EOF'", '<<"EOF"', '<<\EOF' -- turns the expansion off and is what
        # makes a body text.
        if ($m.Groups[1].Success) { $delim = $m.Groups[1].Value; $quoted = $true }
        elseif ($m.Groups[2].Success) { $delim = $m.Groups[2].Value; $quoted = $true }
        else {
            $delim = $m.Groups[3].Value -replace '[''"\\]', ''
            $quoted = ($m.Groups[3].Value -match '[''"\\]')
        }

        [void] $found.Add(@{ Delim = $delim; Strip = $strip; At = $i; Quoted = $quoted })
        $i = $j + $m.Length
    }
    return $found.ToArray()
}

# Whether the skipped text really ended on the delimiter line. An unterminated
# heredoc means the line was misread, and dropping the rest of the command
# would hide whatever came after it.
function Test-ClosedBy([string] $Body, [object] $Heredoc) {
    $lines = @($Body -split "`n")
    if ($lines[$lines.Count - 1] -eq '') {
        if ($lines.Count -le 1) { return $false }
        $lines = @($lines[0..($lines.Count - 2)])
    }
    $last = $lines[$lines.Count - 1]
    if ($last.EndsWith("`r")) { $last = $last.Substring(0, $last.Length - 1) }
    if ($Heredoc.Strip) { $last = $last -creplace '^\t+', '' }
    return ($last -ceq $Heredoc.Delim)
}

# The body's lines as one argument list, without the delimiter line.
function Get-BodyArguments([string] $Body) {
    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($l in ($Body -split "`n")) { [void] $lines.Add($l) }
    if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') {
        $lines.RemoveAt($lines.Count - 1)
    }
    if ($lines.Count -gt 0) { $lines.RemoveAt($lines.Count - 1) }
    return (($lines -join ' ').Trim())
}

# The command 'xargs' would build out of this body, or ''. A body piped to
# 'xargs rm' is neither code nor data: it is the argument list of a command that
# never appears next to it. Reading the body as lines of its own finds nothing
# -- '.env' alone is not a reader or a writer -- so the command xargs would
# actually run is written out for the rest of the hook to see.
function Get-XargsCommand([string] $Segment, [string] $BodyArgs) {
    $tokens = @($Segment.Trim() -split '\s+' | Where-Object { $_ })
    $i = -1
    for ($k = 0; $k -lt $tokens.Count; $k++) {
        if ((Get-Leaf $tokens[$k]) -eq 'xargs') { $i = $k; break }
    }
    if ($i -lt 0) { return '' }

    for ($i = $i + 1; $i -lt $tokens.Count; $i++) {
        if ($XargsOptionsWithValue -contains $tokens[$i]) { $i++; continue }
        if ($tokens[$i].StartsWith('-')) { continue }
        $rest = $tokens[$i..($tokens.Count - 1)] -join ' '
        return "$rest $BodyArgs`n"
    }
    # 'xargs' with no command of its own runs echo, which reads nothing.
    return ''
}

# Every command the 'xargs' calls on this line would build, one per line.
function Get-XargsCommands([string] $Line, [object[]] $Openers, [string] $Body) {
    $bodyArgs = Get-BodyArguments $Body
    if (-not $bodyArgs) { return '' }
    $out = ''
    foreach ($o in $Openers) {
        foreach ($part in (Get-PipelineAt $Line $o.At).Split('|')) {
            $out += Get-XargsCommand $part $bodyArgs
        }
    }
    return $out
}

# The command with the heredoc bodies that are only data removed.
# Skip-GdHeredocBodies from the shared lexer decides where a body ends, so the
# delimiter rules -- '<<-' and tabs, CRLF -- are stated in one place.
function Remove-DataHeredocs([string] $Command) {
    if ($Command.IndexOf('<<') -lt 0) { return $Command }

    # First pass: where every body is, and what the command line reads like
    # with all of them gone. Condition 4 is judged on that second text.
    $spans = [System.Collections.Generic.List[object]]::new()
    $outside = New-Object System.Text.StringBuilder
    $i = 0
    while ($i -lt $Command.Length) {
        $nl = $Command.IndexOf("`n", $i)
        if ($nl -lt 0) {
            [void] $outside.Append($Command.Substring($i))
            break
        }
        $line = $Command.Substring($i, $nl - $i)
        [void] $outside.Append($Command.Substring($i, $nl - $i + 1))
        $i = $nl + 1

        $openers = @(Get-HeredocOpeners $line)
        if ($openers.Count -eq 0) { continue }

        $end = Skip-GdHeredocBodies $Command $i $openers
        [void] $spans.Add(@{ Line = $line; Openers = $openers; From = $i; To = $end })
        $i = $end
    }

    $runsCode = Find-CodeRunner $outside.ToString()

    # Second pass: put back every body that is not data.
    $out = New-Object System.Text.StringBuilder
    $at = 0
    foreach ($span in $spans) {
        [void] $out.Append($Command.Substring($at, $span.From - $at))
        $at = $span.To

        $body = $Command.Substring($span.From, $span.To - $span.From)
        $closed = Test-ClosedBy $body $span.Openers[$span.Openers.Count - 1]
        $data = $closed -and (-not $runsCode)
        foreach ($o in $span.Openers) {
            if (-not $o.Quoted) { $data = $false }
            elseif (-not (Test-PipesOnlyToData $span.Line $o.At)) { $data = $false }
        }
        if ($data) { continue }

        [void] $out.Append($body)
        if ($closed) {
            $built = Get-XargsCommands $span.Line $span.Openers $body
            # The delimiter line is the last thing in $body, and a command line
            # arriving from the tool usually has no newline after it. Appending
            # without one glued 'EOF' to the command built here -- 'EOFrm .env'
            # is not a command the rest of the hook can read.
            if ($built) {
                if (-not $body.EndsWith("`n")) { [void] $out.Append("`n") }
                [void] $out.Append($built)
            }
        }
    }
    [void] $out.Append($Command.Substring($at))
    return $out.ToString()
}

# The same four conditions for PowerShell here-strings.
# "@' ... '@ | Set-Content notes.md" writes a file and the body is its contents;
# "@' ... '@ | iex" runs the body, so that one is still read. A '@" ... "@' body
# is never data: PowerShell expands $(...) inside it, so '@"' with
# '$(Get-Content .env)' in the body reads the file before anything downstream
# sees a thing -- the here-string counterpart of '<<EOF'. The text after '@ is
# left in place, which is what keeps the destination judged as it always was.
function Remove-DataHereStrings([string] $Command) {
    $spans = [System.Collections.Generic.List[object]]::new()
    $outside = New-Object System.Text.StringBuilder
    $i = 0
    while ($i -lt $Command.Length) {
        $open = $PsHereOpener.Match($Command, $i)
        if (-not $open.Success) {
            [void] $outside.Append($Command.Substring($i))
            break
        }
        $nl = $Command.IndexOf("`n", $open.Index)
        $closer = $PsHereCloseDouble
        if ($open.Groups[1].Value -eq "'") { $closer = $PsHereCloseSingle }
        $close = $closer.Match($Command, $nl)
        if (-not $close.Success) {
            [void] $outside.Append($Command.Substring($i))
            break
        }

        $to = $close.Index + $close.Length
        $tail = @($Command.Substring($to) -split '[\r\n]')[0]
        $lineStart = 0
        if ($open.Index -gt 0) { $lineStart = $Command.LastIndexOf("`n", $open.Index - 1) + 1 }
        $statement = $Command.Substring($lineStart, $open.Index - $lineStart) + $tail

        [void] $outside.Append($Command.Substring($i, $nl - $i + 1))
        [void] $spans.Add(@{
            Quote = $open.Groups[1].Value
            Statement = $statement
            From = $nl + 1
            To = $to
        })
        $i = $to
    }

    $runsCode = Find-CodeRunner $outside.ToString()

    $out = New-Object System.Text.StringBuilder
    $at = 0
    foreach ($span in $spans) {
        [void] $out.Append($Command.Substring($at, $span.From - $at))
        $at = $span.To

        $data = ($span.Quote -eq "'") -and (-not $runsCode)
        foreach ($segment in ($span.Statement -split $SegmentSeparator)) {
            $word = Get-HeredocReceiver $segment
            if ($word -and -not ($HeredocDataCommands -contains $word)) { $data = $false }
        }
        if (-not $data) {
            [void] $out.Append($Command.Substring($span.From, $span.To - $span.From))
        }
    }
    [void] $out.Append($Command.Substring($at))
    return $out.ToString()
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

    # One command line can be several commands, and a heredoc body that is only
    # data is removed first so that its lines are not read as commands of their
    # own. See $SegmentSeparator and $HeredocDataCommands above.
    if ($toolName -eq 'PowerShell') { $code = Remove-DataHereStrings $command }
    else { $code = Remove-DataHeredocs $command }

    foreach ($segment in ($code -split $SegmentSeparator)) {
        if (-not $segment.Trim()) { continue }

        $hit = Find-SecretPath $segment
        if ($null -eq $hit) { continue }

        # Reading is decided first, so a shape that both reads and writes --
        # 'sed -i' on a secret -- keeps the message it has always had.
        $reader = Find-Reader $segment
        if ($reader) { Deny $command $hit.Path $hit.Label $reader }

        $writer = Find-Writer $segment
        if ($writer) { DenyWrite $command $hit.Path $hit.Label $writer }
    }

    exit 0
}
catch {
    # Fail open, loudly. A guard that crashes must not become a guard that blocks
    # everything -- that trains people to disable it.
    [Console]::Error.WriteLine("[guard-secrets] hook error (allowing call): $($_.Exception.Message)")
    exit 0
}
