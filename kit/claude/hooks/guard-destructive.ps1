#requires -Version 5.1
<#
.SYNOPSIS
    Claude Code PreToolUse hook. Stops the destructive commands this kit
    already puts in permissions.deny when they arrive in a shape that deny
    does not match.

.DESCRIPTION
    The PowerShell twin of guard-destructive.mjs. Same rules, same grammars,
    same test cases: kit/scripts/test-guard-destructive.mjs --target ps runs
    the identical suite against this file, so the two cannot drift.

    Read guard-destructive.mjs for why this exists and what it does not
    cover. In short: permissions.deny already splits compound commands and
    strips timeout/nice/nohup/xargs, so 'cd /tmp && rm -rf x' is stopped by
    Claude Code itself. What deny does not match -- 'bash -c ...', /bin/rm,
    'git -C . push --force', 'rm -rfv', 'npx rimraf', 'cmd /c rd /s',
    'node -e' with rmSync -- is what this hook stops. Four commands with no
    deny counterpart are stopped too, because what they destroy does not
    come back: 'find -delete', 'git stash drop'/'clear',
    'gh repo sync --force', 'gh repo delete'.

    NOTE ON ENCODING
    ASCII-only on purpose. Windows PowerShell 5.1 reads a BOM-free UTF-8
    script as the system ANSI codepage, so non-ASCII literals would be
    mojibake on a Japanese Windows install.

.NOTES
    Exit 0 -> allow.  Exit 2 -> block, reason on stderr.
    Any internal failure exits 0 with a note on stderr: permissions.deny is
    still in front of this hook, so a broken guard must not brick the
    toolchain. The same choice guard-secrets and guard-config make.
#>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:MaxDepth = 8

# ---------------------------------------------------------------------------
# Lexers
# ---------------------------------------------------------------------------

# The POSIX / PowerShell / cmd lexers, shared with guard-sql. Dot-sourced so
# the functions land in this scope, exactly as when they lived here.
#
# This file has to be installed next to the hook. If it is missing the dot
# source throws, the hook exits non-zero before reading its input, and Claude
# Code reports a non-2 exit rather than acting on it -- a guard that is still
# registered and stops nothing. install.ps1 places it, doctor names it when it
# is absent, and probe-guards catches it at run time.
. (Join-Path $PSScriptRoot (Join-Path 'lib' 'shell-lex.ps1'))

# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------

function New-GdHit {
    param([string] $What, [object[]] $Via)
    if ($null -eq $Via) { $Via = @() }
    return @{ What = $What; Via = $Via }
}

function Get-GdCmdName {
    param([string] $Raw)
    $parts = $Raw -split '[\\/]'
    $base = $parts[$parts.Length - 1]
    if ($base -eq '') { $base = $Raw }
    return ($base.ToLowerInvariant() -replace '\.(?:exe|cmd|bat|com)$', '')
}

function Get-GdWordText {
    param([GdWord] $Word, [hashtable] $Ctx)
    if ($Word.Dyn -and $Word.VarRef -and $Ctx.Vars.ContainsKey($Word.VarRef)) { return [string] $Ctx.Vars[$Word.VarRef] }
    return $Word.V
}

function Join-GdWords {
    param([object[]] $Words, [hashtable] $Ctx)
    if ($null -eq $Words -or $Words.Count -eq 0) { return '' }
    $parts = @()
    foreach ($w in $Words) { $parts += (Get-GdWordText $w $Ctx) }
    return [string]::Join(' ', $parts)
}

function Resolve-GdDyn {
    param([GdWord] $Word, [hashtable] $Ctx)
    if ($Word.VarRef -and $Ctx.Vars.ContainsKey($Word.VarRef)) { return [string] $Ctx.Vars[$Word.VarRef] }
    if ($Word.Subst) {
        $m = [regex]::Match($Word.Subst, '^\s*(?:which|command\s+-v|type\s+-[pP]|whence\s+-p)\s+([^\s;|&]+)\s*$')
        if ($m.Success) { return $m.Groups[1].Value }
    }
    return $null
}

function Split-GdWords {
    param([string] $Text)
    $out = @()
    foreach ($t in ($Text -split '\s+')) { if ($t -ne '') { $out += [GdWord]::new($t) } }
    return , $out
}

function Test-GdAssignment {
    param([GdWord] $Word)
    return ($Word.V -cmatch '^[A-Za-z_][A-Za-z0-9_]*\+?=')
}

# Remember 'X=value' so a later '$X' in command position can be resolved.
function Add-GdAssignment {
    param([hashtable] $Command, [string] $G, [hashtable] $Ctx)
    $ws = $Command.Words.ToArray()
    if ($ws.Count -eq 0) { return $false }
    if ($G -eq 'ps') {
        $w0 = $ws[0]
        if (-not $w0.VarRef -or $ws.Count -lt 2) { return $false }
        $value = $null
        if ($ws[1].V -ceq '=' -and $ws.Count -ge 3) { $value = Get-GdSlice $ws 2 }
        elseif ($ws[1].V.StartsWith('=') -and -not $ws[1].V.StartsWith('==')) {
            $value = @([GdWord]::new($ws[1].V.Substring(1))) + (Get-GdSlice $ws 2)
        }
        if ($null -eq $value) { return $false }
        $Ctx.Vars[$w0.VarRef] = (Join-GdWords $value $Ctx).Trim()
        return $true
    }
    $start = 0
    if (@('export', 'declare', 'typeset', 'local', 'readonly') -ccontains $ws[0].V) { $start = 1 }
    $rest = @()
    foreach ($w in (Get-GdSlice $ws $start)) { if (-not $w.V.StartsWith('-')) { $rest += $w } }
    if ($rest.Count -eq 0) { return $false }
    foreach ($w in $rest) { if (-not (Test-GdAssignment $w)) { return $false } }
    foreach ($w in $rest) {
        $eq = $w.V.IndexOf('=')
        $name = $w.V.Substring(0, $eq) -replace '\+$', ''
        if ($w.Dyn) { [void] $Ctx.Vars.Remove($name) }
        else { $Ctx.Vars[$name] = $w.V.Substring($eq + 1) }
    }
    return $true
}

$script:RunnerNames = @(
    'sudo', 'doas', 'nice', 'ionice', 'timeout', 'time', 'nohup', 'command', 'builtin', 'noglob',
    'nocorrect', 'exec', 'stdbuf', 'setsid', 'chronic', 'unbuffer', 'caffeinate', 'busybox',
    'cross-env', 'xargs', 'watch', 'env', 'flock', 'wsl', 'npx', 'pnpx', 'bunx', 'npm', 'pnpm',
    'yarn', 'bun', 'direnv', 'devbox', 'mise', 'rtx', 'uv', 'poetry', 'pipenv', 'pdm', 'bundle',
    'dotenv', 'nix-shell', 'nix'
)

# Returns @{ Kind = 'rest'; Rest = <words> } for the inner command,
#         @{ Kind = 'source'; Source = <words> } for a string handed to a shell,
#         $null when there is no command to look at.
function Get-GdRunner {
    param([string] $Name, [object[]] $Rest)
    $first = Get-GdItem $Rest 0
    switch ($Name) {
        'sudo' { return @{ Kind = 'rest'; Rest = (Get-GdAfterOptions $Rest @('-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '--user', '--group', '--host', '--prompt', '--close-from', '--chdir', '--role', '--type', '--other-user', '--command-timeout')) } }
        'doas' { return @{ Kind = 'rest'; Rest = (Get-GdAfterOptions $Rest @('-u', '-C')) } }
        'nice' { return @{ Kind = 'rest'; Rest = (Get-GdAfterOptions $Rest @('-n', '--adjustment')) } }
        'ionice' { return @{ Kind = 'rest'; Rest = (Get-GdAfterOptions $Rest @('-c', '-n', '--class', '--classdata')) } }
        'timeout' { return @{ Kind = 'rest'; Rest = (Get-GdSlice (Get-GdAfterOptions $Rest @('-s', '-k', '--signal', '--kill-after')) 1) } }
        'time' { return @{ Kind = 'rest'; Rest = (Get-GdAfterOptions $Rest @('-o', '-f', '--output', '--format')) } }
        'nohup' { return @{ Kind = 'rest'; Rest = (Get-GdAfterOptions $Rest) } }
        'command' {
            if ($null -ne $first -and $first.V -cmatch '^-[a-zA-Z]*[vV]') { return $null }
            return @{ Kind = 'rest'; Rest = (Get-GdAfterOptions $Rest) }
        }
        'builtin' { return @{ Kind = 'rest'; Rest = $Rest } }
        'noglob' { return @{ Kind = 'rest'; Rest = $Rest } }
        'nocorrect' { return @{ Kind = 'rest'; Rest = $Rest } }
        'exec' { return @{ Kind = 'rest'; Rest = (Get-GdAfterOptions $Rest @('-a')) } }
        'stdbuf' { return @{ Kind = 'rest'; Rest = (Get-GdAfterOptions $Rest @('-i', '-o', '-e')) } }
        'setsid' { return @{ Kind = 'rest'; Rest = (Get-GdAfterOptions $Rest) } }
        'chronic' { return @{ Kind = 'rest'; Rest = (Get-GdAfterOptions $Rest) } }
        'unbuffer' { return @{ Kind = 'rest'; Rest = (Get-GdAfterOptions $Rest) } }
        'caffeinate' { return @{ Kind = 'rest'; Rest = (Get-GdAfterOptions $Rest @('-t', '-w')) } }
        'busybox' { return @{ Kind = 'rest'; Rest = $Rest } }
        'cross-env' { return @{ Kind = 'rest'; Rest = $Rest } }
        'xargs' { return @{ Kind = 'rest'; Rest = (Get-GdAfterOptions $Rest @('-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s', '--arg-file', '--delimiter', '--max-lines', '--max-args', '--max-procs', '--max-chars', '--process-slot-var', '--eof', '--replace')) } }
        'watch' { return @{ Kind = 'source'; Source = (Get-GdAfterOptions $Rest @('-n', '--interval')) } }
        'env' {
            for ($i = 0; $i -lt $Rest.Count; $i++) {
                $v = $Rest[$i].V
                if ($v -ceq '-S' -or $v -ceq '--split-string') { return @{ Kind = 'source'; Source = (Get-GdSlice $Rest ($i + 1)) } }
                if ($v.StartsWith('--split-string=')) { return @{ Kind = 'source'; Source = (@([GdWord]::new($v.Substring(15))) + (Get-GdSlice $Rest ($i + 1))) } }
                if ($v -cmatch '^-S.') { return @{ Kind = 'source'; Source = (@([GdWord]::new($v.Substring(2))) + (Get-GdSlice $Rest ($i + 1))) } }
                if (@('-u', '-C', '--unset', '--chdir') -ccontains $v) { $i++; continue }
                if ($v -ceq '--') { return @{ Kind = 'rest'; Rest = (Get-GdSlice $Rest ($i + 1)) } }
                if ($v.StartsWith('-') -or (Test-GdAssignment $Rest[$i])) { continue }
                return @{ Kind = 'rest'; Rest = (Get-GdSlice $Rest $i) }
            }
            return $null
        }
        'flock' {
            $r = Get-GdAfterOptions $Rest @('-w', '--wait', '--timeout', '-E', '--conflict-exit-code')
            $second = Get-GdItem $r 1
            if ($null -ne $second -and ($second.V -ceq '-c' -or $second.V -ceq '--command')) {
                $third = Get-GdItem $r 2
                if ($null -eq $third) { return $null }
                return @{ Kind = 'source'; Source = @($third) }
            }
            return @{ Kind = 'rest'; Rest = (Get-GdSlice $r 1) }
        }
        'wsl' {
            for ($i = 0; $i -lt $Rest.Count; $i++) {
                $v = $Rest[$i].V
                if ($v -ceq '-e' -or $v -ceq '--exec' -or $v -ceq '--') { return @{ Kind = 'rest'; Rest = (Get-GdSlice $Rest ($i + 1)) } }
                if (@('-d', '--distribution', '-u', '--user', '--cd', '--shell-type') -ccontains $v) { $i++; continue }
                if ($v.StartsWith('-')) { continue }
                return @{ Kind = 'source'; Source = (Get-GdSlice $Rest $i) }
            }
            return $null
        }
        'npx' {
            $call = Get-GdValueAfter $Rest @('-c', '--call')
            if ($null -ne $call) { return @{ Kind = 'source'; Source = @($call) } }
            return @{ Kind = 'rest'; Rest = (Get-GdAfterOptions $Rest @('-p', '--package')) }
        }
        'pnpx' { return (Get-GdRunner 'npx' $Rest) }
        'bunx' { return @{ Kind = 'rest'; Rest = (Get-GdAfterOptions $Rest @('-p', '--package')) } }
        'npm' {
            if ($null -ne $first -and @('exec', 'x') -ccontains $first.V) { return (Get-GdRunner 'npx' (Get-GdSlice $Rest 1)) }
            return $null
        }
        'pnpm' {
            if ($null -eq $first -or -not (@('dlx', 'exec') -ccontains $first.V)) { return $null }
            $r = Get-GdSlice $Rest 1
            for ($i = 0; $i -lt $r.Count; $i++) {
                if ($r[$i].V -ceq '-c' -or $r[$i].V -ceq '--shell-mode') { return @{ Kind = 'source'; Source = (Get-GdSlice $r ($i + 1)) } }
            }
            return @{ Kind = 'rest'; Rest = (Get-GdAfterOptions $r @('-p', '--package', '--filter', '-F', '-C', '--dir', '--workspace-concurrency')) }
        }
        'yarn' {
            if ($null -ne $first -and @('dlx', 'exec') -ccontains $first.V) { return @{ Kind = 'rest'; Rest = (Get-GdAfterOptions (Get-GdSlice $Rest 1) @('-p', '--package')) } }
            return $null
        }
        'bun' {
            if ($null -eq $first) { return $null }
            if ($first.V -ceq 'x') { return (Get-GdRunner 'bunx' (Get-GdSlice $Rest 1)) }
            if ($first.V -ceq 'exec') { return @{ Kind = 'source'; Source = (Get-GdSlice $Rest 1) } }
            return $null
        }
        'direnv' {
            if ($null -ne $first -and $first.V -ceq 'exec') { return @{ Kind = 'rest'; Rest = (Get-GdSlice $Rest 2) } }
            return $null
        }
        'devbox' {
            if ($null -ne $first -and $first.V -ceq 'run') { return @{ Kind = 'rest'; Rest = (Get-GdAfterOptions (Get-GdSlice $Rest 1) @('-c', '--config', '-e', '--env', '--env-file', '--environment')) } }
            return $null
        }
        'mise' {
            if ($null -eq $first -or -not (@('exec', 'x') -ccontains $first.V)) { return $null }
            $r = Get-GdSlice $Rest 1
            $command = Get-GdValueAfter $r @('-c', '--command')
            if ($null -ne $command) { return @{ Kind = 'source'; Source = @($command) } }
            for ($i = 0; $i -lt $r.Count; $i++) {
                if ($r[$i].V -ceq '--') { return @{ Kind = 'rest'; Rest = (Get-GdSlice $r ($i + 1)) } }
            }
            $rest2 = Get-GdAfterOptions $r @('-C', '--cd', '-j', '--jobs', '-E', '--env')
            while ($rest2.Count -gt 0 -and $rest2[0].V.Contains('@')) { $rest2 = Get-GdSlice $rest2 1 }
            return @{ Kind = 'rest'; Rest = $rest2 }
        }
        'rtx' { return (Get-GdRunner 'mise' $Rest) }
        'uv' {
            if ($null -ne $first -and $first.V -ceq 'run') { return @{ Kind = 'rest'; Rest = (Get-GdAfterOptions (Get-GdSlice $Rest 1) @('--with', '--python', '-p', '--directory', '--project', '--env-file', '--extra', '--group', '--package', '--index', '--index-url', '--with-requirements', '--with-editable')) } }
            return $null
        }
        'poetry' {
            if ($null -ne $first -and $first.V -ceq 'run') { return @{ Kind = 'rest'; Rest = (Get-GdAfterOptions (Get-GdSlice $Rest 1)) } }
            return $null
        }
        'pipenv' {
            if ($null -ne $first -and $first.V -ceq 'run') { return @{ Kind = 'rest'; Rest = (Get-GdAfterOptions (Get-GdSlice $Rest 1)) } }
            return $null
        }
        'pdm' {
            if ($null -ne $first -and $first.V -ceq 'run') { return @{ Kind = 'rest'; Rest = (Get-GdAfterOptions (Get-GdSlice $Rest 1)) } }
            return $null
        }
        'bundle' {
            if ($null -ne $first -and $first.V -ceq 'exec') { return @{ Kind = 'rest'; Rest = (Get-GdSlice $Rest 1) } }
            return $null
        }
        'dotenv' {
            for ($i = 0; $i -lt $Rest.Count; $i++) {
                if ($Rest[$i].V -ceq '--') { return @{ Kind = 'rest'; Rest = (Get-GdSlice $Rest ($i + 1)) } }
            }
            return @{ Kind = 'rest'; Rest = (Get-GdAfterOptions $Rest @('-e', '-v', '-c', '-p')) }
        }
        'nix-shell' {
            $run = Get-GdValueAfter $Rest @('--run', '--command')
            if ($null -ne $run) { return @{ Kind = 'source'; Source = @($run) } }
            return $null
        }
        'nix' {
            if ($null -eq $first -or -not (@('develop', 'shell') -ccontains $first.V)) { return $null }
            for ($i = 0; $i -lt $Rest.Count; $i++) {
                if ($Rest[$i].V -ceq '-c' -or $Rest[$i].V -ceq '--command') { return @{ Kind = 'rest'; Rest = (Get-GdSlice $Rest ($i + 1)) } }
            }
            return $null
        }
    }
    return $null
}

$script:PosixKeywords = @('if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'case', 'esac', 'in', 'select', 'function', 'coproc', '!', '{', '}')
$script:Shells = @('sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'yash', 'git-bash')
$script:PsRemoveItem = @('remove-item', 'rm', 'del', 'erase', 'rd', 'rmdir', 'ri')

$script:Interpreters = @{
    'node'     = @{ Short = @('e', 'p'); Long = @('--eval', '--print'); Sub = $null }
    'nodejs'   = @{ Short = @('e', 'p'); Long = @('--eval', '--print'); Sub = $null }
    'bun'      = @{ Short = @('e', 'p'); Long = @('--eval', '--print'); Sub = $null }
    'deno'     = @{ Short = @(); Long = @(); Sub = 'eval' }
    'python'   = @{ Short = @('c'); Long = @(); Sub = $null }
    'python3'  = @{ Short = @('c'); Long = @(); Sub = $null }
    'py'       = @{ Short = @('c'); Long = @(); Sub = $null }
    'pypy3'    = @{ Short = @('c'); Long = @(); Sub = $null }
    'perl'     = @{ Short = @('e', 'E'); Long = @(); Sub = $null }
    'ruby'     = @{ Short = @('e'); Long = @(); Sub = $null }
    'php'      = @{ Short = @('r'); Long = @(); Sub = $null }
}
foreach ($minor in @('3.8', '3.9', '3.10', '3.11', '3.12', '3.13', '3.14')) {
    $script:Interpreters["python$minor"] = $script:Interpreters['python']
}

$script:DestructiveCode = @(
    '\b(?:rmSync|rmdirSync|rm|rmdir)\s*\([^)]*\brecursive\s*:\s*(?:true|!0)',
    '\bDeno\s*\.\s*remove(?:Sync)?\s*\([^)]*\brecursive\s*:\s*true',
    '\bshutil\s*\.\s*rmtree\b',
    '(?:^|[^\w.])rmtree\s*\(',
    '\bremove_tree\s*\(',
    '\bFileUtils\s*\.\s*(?:rm_r|rm_rf|rmtree|remove_dir|remove_entry(?:_secure)?)\b'
)
$script:ExecHint = '\b(?:system|exec|execSync|execFileSync|spawn|spawnSync|popen|Popen|run|call|check_call|check_output|getoutput|getstatusoutput|shell_exec|passthru|proc_open|qx)\b|`'

$script:DotNetDelete = @(
    '\[\s*(?:System\s*\.\s*)?IO\s*\.\s*Directory\s*\]\s*::\s*Delete\s*\([^)]*,\s*\$true\s*\)',
    '\.\s*Delete\s*\(\s*\$true\s*\)',
    '\[\s*Microsoft\s*\.\s*VisualBasic\s*\.\s*FileIO\s*\.\s*FileSystem\s*\]\s*::\s*DeleteDirectory\s*\('
)

function Test-GdShortCluster {
    param([string] $Arg, [char] $Letter)
    if ($Arg -cnotmatch '^-[A-Za-z0-9]+$') { return $false }
    return ($Arg.Substring(1).IndexOf($Letter) -ge 0)
}

function Test-GdLongOption {
    param([string] $Arg, [string] $Full, [int] $Min)
    $key = ($Arg -split '=')[0]
    return ($key.Length -ge $Min -and $key.StartsWith('--') -and $Full.StartsWith($key))
}

# Options before '--'; after it everything is a path or refspec.
function Get-GdOptionsOf {
    param([string[]] $Items)
    if ($null -eq $Items) { return , @() }
    for ($i = 0; $i -lt $Items.Count; $i++) {
        if ($Items[$i] -ceq '--') {
            if ($i -eq 0) { return , @() }
            return , @($Items[0..($i - 1)])
        }
    }
    return , $Items
}

function Test-GdPosixRecursive {
    param([string[]] $Items)
    foreach ($a in (Get-GdOptionsOf $Items)) {
        if (Test-GdLongOption $a '--recursive' 3) { return $true }
        if ($a -cmatch '^-[A-Za-z]+$' -and $a -cmatch '[rR]') { return $true }
    }
    return $false
}

$script:GitGlobalValued = @('-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env', '--attr-source')

function Invoke-GdGit {
    param([string[]] $Items, [object[]] $Via)
    $i = 0
    $cleanWithoutForce = $false
    for (; $i -lt $Items.Count; $i++) {
        $a = $Items[$i]
        if (-not $a.StartsWith('-') -or $a -ceq '-') { break }
        $key = $a
        if ($a.Contains('=')) { $key = $a.Substring(0, $a.IndexOf('=')) }
        if (-not ($script:GitGlobalValued -ccontains $key)) { continue }
        $value = ''
        if ($a.Contains('=') -and $key -cne '-c') { $value = $a.Substring($a.IndexOf('=') + 1) }
        else {
            $i++
            $next = Get-GdItem $Items $i
            if ($null -ne $next) { $value = [string] $next }
        }
        if ($key -ceq '-c' -or $key -ceq '--config-env') {
            if ($value -match '^alias\.') { return (New-GdHit 'an inline git alias (git -c alias.*), which can stand for any command' $Via) }
            if ($value -match '^clean\.requireforce=(?:false|no|off|0)$') { $cleanWithoutForce = $true }
        }
    }
    $sub = ''
    $subWord = Get-GdItem $Items $i
    if ($null -ne $subWord) { $sub = ([string] $subWord).ToLowerInvariant() }
    $rest = @()
    foreach ($r in (Get-GdSlice $Items ($i + 1))) { $rest += [string] $r }
    $opts = Get-GdOptionsOf $rest
    $via2 = $Via + @('git')
    switch ($sub) {
        'push' {
            $afterDashes = $false
            foreach ($a in $rest) {
                if (-not $afterDashes -and $a -ceq '--') { $afterDashes = $true; continue }
                if (-not $afterDashes -and $a.StartsWith('--')) {
                    if ((Test-GdLongOption $a '--force' 4) -or (Test-GdLongOption $a '--force-with-lease' 9) -or (Test-GdLongOption $a '--mirror' 4)) {
                        return (New-GdHit "a force push (git push $a)" $via2)
                    }
                    continue
                }
                if (-not $afterDashes -and $a.Length -gt 1 -and $a.StartsWith('-')) {
                    if ($a.Substring(1).IndexOf('f') -ge 0) { return (New-GdHit "a force push (git push $a)" $via2) }
                    continue
                }
                if ($a.StartsWith('+')) { return (New-GdHit "a force push (refspec $a)" $via2) }
            }
            return $null
        }
        'reset' {
            foreach ($a in $opts) { if (Test-GdLongOption $a '--hard' 4) { return (New-GdHit 'git reset --hard' $via2) } }
            return $null
        }
        'clean' {
            $dry = $false
            $force = $cleanWithoutForce
            foreach ($a in $opts) {
                if ((Test-GdShortCluster $a 'n') -or (Test-GdLongOption $a '--dry-run' 4)) { $dry = $true }
                if ((Test-GdShortCluster $a 'f') -or (Test-GdLongOption $a '--force' 4)) { $force = $true }
            }
            if ($force -and -not $dry) { return (New-GdHit 'git clean that deletes files' $via2) }
            return $null
        }
        'stash' {
            # drop and clear throw away work that was never committed: there is
            # no reflog for a dropped stash entry.
            $action = ''
            foreach ($a in $rest) { if (-not $a.StartsWith('-')) { $action = $a.ToLowerInvariant(); break } }
            if (@('drop', 'clear') -ccontains $action) { return (New-GdHit "git stash $action" $via2) }
            return $null
        }
        'branch' {
            $forceDelete = $false
            $del = $false
            $force = $false
            foreach ($a in $opts) {
                if (Test-GdShortCluster $a 'D') { $forceDelete = $true }
                if ((Test-GdShortCluster $a 'd') -or (Test-GdLongOption $a '--delete' 5)) { $del = $true }
                if ((Test-GdShortCluster $a 'f') -or (Test-GdLongOption $a '--force' 4)) { $force = $true }
            }
            if ($forceDelete -or ($del -and $force)) { return (New-GdHit 'a forced branch delete (git branch -D)' $via2) }
            return $null
        }
    }
    return $null
}

# The GitHub CLI reaches past the local repository. 'gh repo sync --force'
# overwrites a branch the way a force push does, and 'gh repo delete' is the one
# command here with no local equivalent at all.
function Invoke-GdGh {
    param([string[]] $Items, [object[]] $Via)
    $positional = @()
    $flags = @()
    foreach ($a in $Items) {
        if ($a.StartsWith('-')) { $flags += $a } else { $positional += $a }
    }
    if ((Get-GdItem $positional 0) -cne 'repo') { return $null }
    $second = Get-GdItem $positional 1
    if ($second -ceq 'delete') { return (New-GdHit 'deleting a GitHub repository (gh repo delete)' ($Via + @('gh'))) }
    if ($second -ceq 'sync') {
        foreach ($a in $flags) {
            if ((Test-GdLongOption $a '--force' 4) -or (Test-GdShortCluster $a 'f')) {
                return (New-GdHit 'a forced branch overwrite (gh repo sync --force)' ($Via + @('gh')))
            }
        }
    }
    return $null
}

function Invoke-GdSupabase {
    param([string[]] $Items, [object[]] $Via)
    $valued = @('--workdir', '--profile', '--network-id', '--dns-resolver', '-o', '--output', '--project-ref', '--db-url', '--version')
    $positional = @()
    for ($i = 0; $i -lt $Items.Count; $i++) {
        $a = $Items[$i]
        if ($a -ceq '--') { continue }
        if ($a.StartsWith('-')) {
            if (-not $a.Contains('=') -and ($valued -ccontains $a)) { $i++ }
            continue
        }
        $positional += $a.ToLowerInvariant()
    }
    if ($positional.Count -ge 2 -and $positional[0] -ceq 'db' -and $positional[1] -ceq 'reset') {
        return (New-GdHit 'supabase db reset' $Via)
    }
    return $null
}

function Get-GdInterpreterCode {
    param([hashtable] $Spec, [string[]] $Items)
    if ($Spec.Sub) {
        if ((Get-GdItem $Items 0) -cne $Spec.Sub) { return $null }
        $words = @()
        foreach ($a in (Get-GdSlice $Items 1)) { $words += [GdWord]::new([string] $a) }
        $after = Get-GdAfterOptions $words
        if ($after.Count -eq 0) { return $null }
        return $after[0].V
    }
    for ($i = 0; $i -lt $Items.Count; $i++) {
        $a = $Items[$i]
        foreach ($long in $Spec.Long) {
            if ($a -ceq $long) {
                $next = Get-GdItem $Items ($i + 1)
                if ($null -eq $next) { return '' }
                return [string] $next
            }
            if ($a.StartsWith($long + '=')) { return $a.Substring($long.Length + 1) }
        }
        if ($a -cnotmatch '^-[A-Za-z]' -or $a.StartsWith('--')) {
            if (-not $a.StartsWith('-')) { return $null }
            continue
        }
        if (($Spec.Short -ccontains [string] $a[1]) -and $a.Length -gt 2 -and ($a.Substring(2) -cnotmatch '^[A-Za-z]+$')) { return $a.Substring(2) }
        if (($Spec.Short -ccontains [string] $a[$a.Length - 1]) -and $a -cmatch '^-[A-Za-z]+$') {
            $next = Get-GdItem $Items ($i + 1)
            if ($null -eq $next) { return '' }
            return [string] $next
        }
    }
    return $null
}

function Get-GdQuotedLiterals {
    param([string] $Code)
    $out = [System.Collections.Generic.List[string]]::new()
    $re = [regex] '''((?:[^''\\]|\\.)*)''|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`'
    foreach ($m in $re.Matches($Code)) {
        if ($out.Count -ge 50) { break }
        $v = $m.Groups[1].Value
        if (-not $m.Groups[1].Success) { $v = $m.Groups[2].Value }
        if (-not $m.Groups[1].Success -and -not $m.Groups[2].Success) { $v = $m.Groups[3].Value }
        [void] $out.Add($v)
    }
    return , $out.ToArray()
}

function Invoke-GdCode {
    param([string] $Code, [int] $Depth, [hashtable] $Ctx, [object[]] $Via)
    # Match calls, not mentions: print('shutil.rmtree ...') is text. The path
    # argument of a real call is a literal too, and blanking it keeps the
    # call's shape (rmtree('')) intact.
    $bare = [regex]::Replace($Code, '''(?:[^''\\]|\\.)*''|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`', { param($m) [string] $m.Value[0] + [string] $m.Value[0] })
    foreach ($re in $script:DestructiveCode) {
        if ($bare -cmatch $re) { return (New-GdHit 'a recursive delete in interpreter code' $Via) }
    }
    if ($Code -cnotmatch $script:ExecHint) { return $null }
    $literals = Get-GdQuotedLiterals $Code
    for ($i = 0; $i -lt $literals.Count; $i++) {
        $joined = [string]::Join(' ', (Get-GdSlice $literals $i))
        $hit = Invoke-GdScan $joined 'posix' ($Depth + 1) $Ctx $Via
        if ($null -ne $hit) { return $hit }
    }
    return $null
}

function Invoke-GdShell {
    param([string] $Name, [object[]] $Items, [hashtable] $Command, [int] $Depth, [hashtable] $Ctx, [object[]] $Via)
    $valued = @('-o', '+o', '-O', '+O', '--rcfile', '--init-file')
    $sawC = $false
    $stdin = $false
    $operand = $null
    for ($i = 0; $i -lt $Items.Count; $i++) {
        $a = $Items[$i].V
        if ($a -ceq '--command') {
            $next = Get-GdItem $Items ($i + 1)
            $text = ''
            if ($null -ne $next) { $text = Get-GdWordText $next $Ctx }
            return (Invoke-GdScan $text 'posix' ($Depth + 1) $Ctx ($Via + @("$Name -c")))
        }
        if ($a.StartsWith('--command=')) { return (Invoke-GdScan $a.Substring(10) 'posix' ($Depth + 1) $Ctx ($Via + @("$Name -c"))) }
        if ($a -ceq '-') { $stdin = $true; continue }
        if ($a -ceq '--') { $operand = Get-GdItem $Items ($i + 1); break }
        if ($a -cmatch '^[-+][A-Za-z]+$') {
            if ($valued -ccontains $a) { $i++; continue }
            if ($a[0] -ceq '-' -and $a.IndexOf('c') -ge 0) { $sawC = $true }
            if ($a[0] -ceq '-' -and $a.IndexOf('s') -ge 0) { $stdin = $true }
            continue
        }
        if ($a.StartsWith('--')) {
            if ($valued -ccontains $a) { $i++ }
            continue
        }
        $operand = $Items[$i]
        break
    }
    $label = "$Name -c"
    if ($sawC) {
        if ($null -eq $operand) { return $null }
        return (Invoke-GdScan (Get-GdWordText $operand $Ctx) 'posix' ($Depth + 1) $Ctx ($Via + @($label)))
    }
    if ($null -ne $operand -and -not $stdin) { return $null }
    $fed = [System.Collections.Generic.List[string]]::new()
    foreach ($b in $Command.Heredocs) { [void] $fed.Add([string] $b) }
    foreach ($b in $Command.Herestrings) { [void] $fed.Add([string] $b) }
    $from = $Command.PipedFrom
    if ($null -ne $from -and $from.Words.Count -gt 0) {
        $fromName = Get-GdCmdName ($from.Words[0].V)
        if (@('echo', 'printf') -ccontains $fromName) {
            $args2 = @()
            foreach ($w in (Get-GdSlice $from.Words.ToArray() 1)) { if ($w.V -cnotmatch '^-[neE]+$') { $args2 += $w } }
            [void] $fed.Add(((Join-GdWords $args2 $Ctx) -creplace '\\n', "`n"))
        }
    }
    foreach ($body in $fed) {
        $hit = Invoke-GdScan $body 'posix' ($Depth + 1) $Ctx ($Via + @("$Name (stdin)"))
        if ($null -ne $hit) { return $hit }
    }
    return $null
}

function Invoke-GdPowerShellExe {
    param([string] $Name, [object[]] $Items, [int] $Depth, [hashtable] $Ctx, [object[]] $Via)
    $valued = @('executionpolicy', 'ex', 'ep', 'windowstyle', 'w', 'win', 'outputformat', 'o', 'of', 'inputformat', 'if', 'inp', 'version', 'v', 'configurationname', 'config', 'workingdirectory', 'wd', 'settingsfile', 'psconsolefile', 'custompipename')
    for ($i = 0; $i -lt $Items.Count; $i++) {
        $a = $Items[$i].V
        if ($a.Length -gt 1 -and ($a.StartsWith('-') -or $a.StartsWith('/'))) {
            $key = (($a -replace '^[-/]+', '') -split ':')[0].ToLowerInvariant()
            if ((@('e', 'ec', 'en', 'enc') -ccontains $key) -or ($key.Length -ge 3 -and 'encodedcommand'.StartsWith($key))) {
                $decoded = ''
                $next = Get-GdItem $Items ($i + 1)
                if ($null -ne $next) {
                    try { $decoded = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String((Get-GdWordText $next $Ctx))) } catch { $decoded = '' }
                }
                return (Invoke-GdScan $decoded 'ps' ($Depth + 1) $Ctx ($Via + @("$Name -EncodedCommand")))
            }
            if ($key -ceq 'c' -or ($key.Length -ge 3 -and 'command'.StartsWith($key))) {
                return (Invoke-GdScan (Join-GdWords (Get-GdSlice $Items ($i + 1)) $Ctx) 'ps' ($Depth + 1) $Ctx ($Via + @("$Name -Command")))
            }
            if ($key -ceq 'f' -or $key -ceq 'file') { return $null }
            if ($valued -ccontains $key) { $i++ }
            continue
        }
        # powershell.exe treats a bare argument as -Command; pwsh treats it as -File.
        if ($Name -ceq 'pwsh') { return $null }
        return (Invoke-GdScan (Join-GdWords (Get-GdSlice $Items $i) $Ctx) 'ps' ($Depth + 1) $Ctx ($Via + @("$Name -Command")))
    }
    return $null
}

function Invoke-GdCmdExe {
    param([object[]] $Items, [int] $Depth, [hashtable] $Ctx, [object[]] $Via)
    for ($i = 0; $i -lt $Items.Count; $i++) {
        $a = $Items[$i].V
        $m = [regex]::Match($a, '^/([ckCK])(.*)$')
        if ($m.Success) {
            $parts = @()
            if ($m.Groups[2].Value -ne '') { $parts += $m.Groups[2].Value }
            foreach ($w in (Get-GdSlice $Items ($i + 1))) {
                $t = Get-GdWordText $w $Ctx
                if ($t -ne '') { $parts += $t }
            }
            return (Invoke-GdScan ([string]::Join(' ', $parts)) 'cmd' ($Depth + 1) $Ctx ($Via + @('cmd /c')))
        }
        if (-not $a.StartsWith('/')) { return $null }
    }
    return $null
}

function Get-GdCmdSwitches {
    param([string[]] $Items)
    $out = @()
    foreach ($a in $Items) {
        if ($a.StartsWith('/')) {
            foreach ($s in ($a -split '/')) { if ($s -ne '') { $out += $s.ToLowerInvariant() } }
        }
    }
    return , $out
}

# The verdict for one simple command. Words still include the command word;
# wrappers are peeled off in a loop until a real command is reached.
function Invoke-GdCommandWords {
    param([object[]] $Words, [string] $G, [int] $Depth, [hashtable] $Ctx, [hashtable] $Command, [object[]] $Via)
    $ws = @($Words)
    $via = @() + $Via
    for ($guard = 0; $guard -lt 64; $guard++) {
        if ($null -eq $ws -or $ws.Count -eq 0) { return $null }
        if ($G -cne 'ps') {
            while ($ws.Count -gt 0 -and (Test-GdAssignment $ws[0])) { $ws = Get-GdSlice $ws 1 }
            if ($ws.Count -eq 0) { return $null }
        }
        $w0 = $ws[0]
        if ($w0.Dyn) {
            $resolved = Resolve-GdDyn $w0 $Ctx
            if ($null -eq $resolved) { return $null }
            $ws = @() + (Split-GdWords $resolved) + (Get-GdSlice $ws 1)
            continue
        }
        if ($G -ceq 'cmd') {
            $m = [regex]::Match($w0.V, '^(rd|rmdir|del|erase)(/.*)$', 'IgnoreCase')
            if ($m.Success) {
                $ws = @([GdWord]::new($m.Groups[1].Value), [GdWord]::new($m.Groups[2].Value)) + (Get-GdSlice $ws 1)
                $w0 = $ws[0]
            }
        }
        $name = Get-GdCmdName $w0.V
        if ($name -eq '') { return $null }
        if ($name -cmatch '\s') { return (Invoke-GdScan $w0.V $G ($Depth + 1) $Ctx $via) }
        $rest = Get-GdSlice $ws 1
        $argv = @()
        foreach ($w in $rest) { $argv += (Get-GdWordText $w $Ctx) }

        if ($G -ceq 'posix' -and ($script:PosixKeywords -ccontains $name)) { $ws = $rest; continue }
        if ($G -ceq 'ps' -and $name -ceq '.') { $ws = $rest; continue }

        if ($script:RunnerNames -ccontains $name) {
            $r = Get-GdRunner $name $rest
            if ($null -eq $r) { return $null }
            $via = $via + @($name)
            if ($r.Kind -ceq 'source') {
                if ($r.Source.Count -eq 0) { return $null }
                return (Invoke-GdScan (Join-GdWords $r.Source $Ctx) 'posix' ($Depth + 1) $Ctx $via)
            }
            $ws = $r.Rest
            continue
        }

        if ($script:Shells -ccontains $name) { return (Invoke-GdShell $name $rest $Command $Depth $Ctx $via) }
        if ($name -ceq 'powershell' -or $name -ceq 'pwsh') { return (Invoke-GdPowerShellExe $name $rest $Depth $Ctx $via) }
        if ($name -ceq 'cmd') { return (Invoke-GdCmdExe $rest $Depth $Ctx $via) }
        if ($name -ceq 'eval') { return (Invoke-GdScan ([string]::Join(' ', $argv)) 'posix' ($Depth + 1) $Ctx ($via + @('eval'))) }
        if ($name -ceq 'invoke-expression' -or $name -ceq 'iex') {
            $parts = @()
            foreach ($a in $argv) { if ($a -notmatch '^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$') { $parts += $a } }
            return (Invoke-GdScan ([string]::Join(' ', $parts)) 'ps' ($Depth + 1) $Ctx ($via + @('Invoke-Expression')))
        }
        if ($name -ceq 'find') {
            # -delete removes everything the expression matched, with no second
            # chance and no rm on the command line to match a deny rule against.
            if ($argv -ccontains '-delete') { return (New-GdHit 'a recursive delete (find -delete)' $via) }
            for ($i = 0; $i -lt $rest.Count; $i++) {
                if (-not (@('-exec', '-execdir', '-ok', '-okdir') -ccontains $rest[$i].V)) { continue }
                $j = $i + 1
                while ($j -lt $rest.Count -and $rest[$j].V -cne ';' -and $rest[$j].V -cne '+') { $j++ }
                $inner = @()
                for ($k = $i + 1; $k -lt $j; $k++) { $inner += $rest[$k] }
                $hit = Invoke-GdCommandWords $inner 'posix' ($Depth + 1) $Ctx (New-GdCommand) ($via + @('find -exec'))
                if ($null -ne $hit) { return $hit }
                $i = $j
            }
            return $null
        }
        if ($name -ceq 'git') { return (Invoke-GdGit $argv $via) }
        if ($name -ceq 'gh') { return (Invoke-GdGh $argv $via) }
        if ($name -ceq 'supabase') { return (Invoke-GdSupabase $argv $via) }
        if ($name -ceq 'rimraf') { return (New-GdHit 'a recursive delete (rimraf)' $via) }

        if ($G -ceq 'ps' -and ($script:PsRemoveItem -ccontains $name)) {
            return (New-GdHit ("Remove-Item (" + $w0.V + "), which this kit denies outright for the PowerShell tool") $via)
        }
        if ($G -ceq 'cmd' -and (@('rd', 'rmdir', 'del', 'erase') -ccontains $name)) {
            if ((Get-GdCmdSwitches $argv) -ccontains 's') { return (New-GdHit "a recursive delete ($name /s)" $via) }
            return $null
        }
        if ($name -ceq 'rm') {
            if (Test-GdPosixRecursive $argv) {
                $flags = @()
                foreach ($a in $argv) { if ($a.StartsWith('-')) { $flags += $a } }
                return (New-GdHit ("a recursive delete (rm " + [string]::Join(' ', $flags) + ")") $via)
            }
            return $null
        }

        if ($script:Interpreters.ContainsKey($name)) {
            $code = Get-GdInterpreterCode $script:Interpreters[$name] $argv
            if ($null -eq $code) { return $null }
            return (Invoke-GdCode $code $Depth $Ctx ($via + @("$name (inline code)")))
        }
        return $null
    }
    return $null
}

# First destructive command anywhere in Src, read with grammar G.
function Invoke-GdScan {
    param([string] $Src, [string] $G, [int] $Depth, [hashtable] $Ctx, [object[]] $Via)
    if ($null -eq $Src -or $Src.Trim() -eq '') { return $null }
    if ($Depth -gt $script:MaxDepth) { return (New-GdHit 'commands nested too deeply to inspect' $Via) }
    if ($G -ceq 'ps') {
        foreach ($re in $script:DotNetDelete) {
            if ($Src -match $re) { return (New-GdHit 'a recursive .NET directory delete' $Via) }
        }
    }
    $lexed = $null
    if ($G -ceq 'ps') { $lexed = Invoke-GdLexPs $Src }
    elseif ($G -ceq 'cmd') { $lexed = Invoke-GdLexCmd $Src }
    else { $lexed = Invoke-GdLexPosix $Src }

    foreach ($inner in $lexed.Nested) {
        $hit = Invoke-GdScan $inner.Src $inner.G ($Depth + 1) $Ctx ($Via + @($inner.Label))
        if ($null -ne $hit) { return $hit }
    }
    foreach ($command in $lexed.Commands) {
        if (Add-GdAssignment $command $G $Ctx) { continue }
        $hit = Invoke-GdCommandWords $command.Words.ToArray() $G $Depth $Ctx $command $Via
        if ($null -ne $hit) { return $hit }
    }
    return $null
}

function Invoke-GdInspect {
    param([string] $ToolName, [string] $Command)
    if ($ToolName -cnotmatch '^(Bash|PowerShell)$') { return $null }
    if ($null -eq $Command -or $Command.Trim() -eq '') { return $null }
    $g = 'posix'
    if ($ToolName -ceq 'PowerShell') { $g = 'ps' }
    return (Invoke-GdScan $Command $g 0 @{ Vars = @{} } @())
}

# ---------------------------------------------------------------------------
# Hook entry point
# ---------------------------------------------------------------------------

function Deny-GdCall {
    param([hashtable] $Hit, [string] $Command)
    $shown = $Command
    if ($shown.Length -gt 300) { $shown = $shown.Substring(0, 300) + '...' }
    $via = '(direct)'
    if ($Hit.Via.Count -gt 0) { $via = [string]::Join(' > ', $Hit.Via) }
    $lines = @(
        "[guard-destructive] BLOCKED: $($Hit.What)."
        ''
        "Reached through : $via"
        "Command         : $shown"
        ''
        'permissions.deny matches the command text as written, after splitting'
        'compound commands and removing a few wrappers. This form gets past it,'
        'so this hook stops it instead.'
        ''
        'What to do:'
        '  1. If this really needs to happen, ask the human to run it in their own'
        '     terminal.'
        '  2. Do not rewrite it into another form (a different shell, a script,'
        '     an interpreter one-liner). That is the pattern this hook exists for.'
    )
    [Console]::Error.WriteLine([string]::Join([Environment]::NewLine, $lines))
    exit 2
}

try {
    $raw = [Console]::In.ReadToEnd()
    if (-not $raw -or -not $raw.Trim()) { exit 0 }
    $payload = $raw | ConvertFrom-Json

    $toolName = ''
    if ($payload.PSObject.Properties.Match('tool_name').Count -gt 0 -and $payload.tool_name -is [string]) {
        $toolName = $payload.tool_name
    }
    $command = ''
    if ($payload.PSObject.Properties.Match('tool_input').Count -gt 0 -and $null -ne $payload.tool_input) {
        $toolInput = $payload.tool_input
        if ($toolInput.PSObject.Properties.Match('command').Count -gt 0 -and $toolInput.command -is [string]) {
            $command = $toolInput.command
        }
    }

    $hit = Invoke-GdInspect $toolName $command
    if ($null -ne $hit) { Deny-GdCall $hit $command }
    exit 0
}
catch {
    # A broken guard must not brick the toolchain: permissions.deny is still in
    # front of this hook. Say so on stderr and let the call through.
    [Console]::Error.WriteLine("[guard-destructive] internal error, allowing: $($_.Exception.Message)")
    exit 0
}
