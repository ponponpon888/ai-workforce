#requires -Version 5.1
<#
.SYNOPSIS
  POSIX shell, PowerShell and cmd.exe lexers, shared by the guard hooks that
  have to read a command line.

.DESCRIPTION
  Lifted out of guard-destructive.ps1 unchanged, and the twin of
  lib/shell-lex.mjs. guard-destructive needed a real lexer to see past quoting
  and wrappers; guard-sql needs the same thing to tell a DDL keyword that is
  being executed from one that is merely quoted inside a commit message
  (data/pitfalls/hook-010.json). A second implementation of shell quoting is
  exactly the kind of near-duplicate that drifts.

  A single grammar for all three shells is what made guard-sql's string
  neutralization create a hole in the first place: backticks and backslashes
  mean different things in each.

  This file only turns text into commands and words. It decides nothing about
  whether a command is dangerous -- that stays in each hook, because each hook
  is looking for something different.

  Dot-sourced, not run: it defines functions and returns. Set-StrictMode and
  $ErrorActionPreference come from the hook that sources it, so the rules it
  runs under are the caller's.
#>

# ---------------------------------------------------------------------------
# Words
# ---------------------------------------------------------------------------

# One shell word after quote removal. Dyn marks a word whose value depends on
# an expansion this hook cannot evaluate; VarRef and Subst are set only when
# the whole word is a single variable or a single command substitution, which
# is what lets 'X=rm; $X -rf .' and '$(which rm) -rf .' be resolved.
class GdWord {
    [string] $V = ''
    [bool] $Dyn = $false
    [bool] $Empty = $true
    [string] $VarRef = $null
    [string] $Subst = $null

    GdWord() { }
    GdWord([string] $v) { $this.V = $v; $this.Empty = ($v -eq '') }

    [void] Add([string] $s) {
        $this.V += $s
        $this.Empty = $false
        $this.VarRef = $null
        $this.Subst = $null
    }

    [void] AddDyn([string] $varRef, [string] $subst) {
        $wasEmpty = $this.Empty
        $this.Dyn = $true
        $this.Empty = $false
        if ($wasEmpty) { $this.VarRef = $varRef; $this.Subst = $subst }
        else { $this.VarRef = $null; $this.Subst = $null }
    }
}

function New-GdCommand {
    return @{
        Words       = [System.Collections.Generic.List[object]]::new()
        Heredocs    = [System.Collections.Generic.List[object]]::new()
        Herestrings = [System.Collections.Generic.List[object]]::new()
        PipedFrom   = $null
    }
}

# Out-of-range reads are normal while lexing; PowerShell's strict mode makes
# them errors, so every character read goes through here.
function Get-GdChar {
    param([string] $Src, [int] $Index)
    if ($Index -lt 0 -or $Index -ge $Src.Length) { return [char] 0 }
    return $Src[$Index]
}

# The unary comma keeps a one-element result an array: PowerShell unrolls a
# single-element array on the way out of a function, and the caller then reads
# .Count on a scalar. Every array return in this file carries it.
function Get-GdSlice {
    param([object[]] $Items, [int] $Start)
    if ($null -eq $Items -or $Start -ge $Items.Count) { return , @() }
    if ($Start -le 0) { return , $Items }
    return , @($Items[$Start..($Items.Count - 1)])
}

function Get-GdItem {
    param([object[]] $Items, [int] $Index)
    if ($null -eq $Items -or $Index -lt 0 -or $Index -ge $Items.Count) { return $null }
    return $Items[$Index]
}

# ---------------------------------------------------------------------------
# Shared scanning helpers
# ---------------------------------------------------------------------------

function Skip-GdHeredocBodies {
    param([string] $Src, [int] $Index, [object[]] $Heredocs)
    $i = $Index
    foreach ($h in $Heredocs) {
        while ($i -lt $Src.Length) {
            $j = $Src.IndexOf("`n", $i)
            if ($j -lt 0) { $j = $Src.Length }
            $line = $Src.Substring($i, $j - $i)
            $i = [Math]::Min($j + 1, $Src.Length)
            if ($line.EndsWith("`r")) { $line = $line.Substring(0, $line.Length - 1) }
            $cmp = $line
            if ($h.Strip) { $cmp = $cmp -creplace '^\t+', '' }
            if ($cmp -ceq $h.Delim) { break }
        }
    }
    return $i
}

# Index just past the ')' that closes a '(' already consumed, skipping quoted
# text. -Ps selects PowerShell quoting (backtick escapes, '' and "" doubling)
# instead of POSIX quoting (backslash escapes).
function Get-GdClosingParen {
    param([string] $Src, [int] $Index, [bool] $Ps)
    $i = $Index
    $depth = 1
    $heredocs = [System.Collections.Generic.List[object]]::new()
    while ($i -lt $Src.Length) {
        $c = Get-GdChar $Src $i
        # '$(cat <<EOF ... EOF)' is how commit messages are usually built. The
        # body is text, not code: an apostrophe or a parenthesis in it must not
        # be read as quoting or nesting.
        if ($c -eq "`n" -and $heredocs.Count -gt 0) {
            $i = Skip-GdHeredocBodies $Src ($i + 1) $heredocs.ToArray()
            $heredocs.Clear()
            continue
        }
        $atWordStart = $false
        if ($i -eq 0) { $atWordStart = $true }
        else { $atWordStart = ([string](Get-GdChar $Src ($i - 1))) -cmatch '[\s;&|(]' }

        if (-not $Ps -and $c -eq '<' -and (Get-GdChar $Src ($i + 1)) -eq '<' -and (Get-GdChar $Src ($i + 2)) -ne '<') {
            $j = $i + 2
            $strip = (Get-GdChar $Src $j) -eq '-'
            if ($strip) { $j++ }
            while ((Get-GdChar $Src $j) -eq ' ' -or (Get-GdChar $Src $j) -eq "`t") { $j++ }
            $m = [regex]::Match($Src.Substring($j), '^(?:''([^'']*)''|"([^"]*)"|([^\s;&|<>()]+))')
            if ($m.Success) {
                $delim = $m.Groups[1].Value
                if (-not $m.Groups[1].Success) { $delim = $m.Groups[2].Value }
                if (-not $m.Groups[1].Success -and -not $m.Groups[2].Success) {
                    $delim = $m.Groups[3].Value -creplace '[''"\\]', ''
                }
                [void] $heredocs.Add(@{ Delim = $delim; Strip = $strip })
                $i = $j + $m.Length
            }
            else { $i = $j }
            continue
        }
        if ($c -eq '#' -and $atWordStart) {
            while ($i -lt $Src.Length -and (Get-GdChar $Src $i) -ne "`n") { $i++ }
            continue
        }
        if ($Ps -and $c -eq '<' -and (Get-GdChar $Src ($i + 1)) -eq '#') {
            $end = $Src.IndexOf('#>', $i + 2)
            if ($end -lt 0) { $i = $Src.Length } else { $i = $end + 2 }
            continue
        }
        if ($Ps -and $c -eq '@' -and ((Get-GdChar $Src ($i + 1)) -eq "'" -or (Get-GdChar $Src ($i + 1)) -eq '"')) {
            $lineEnd = $Src.IndexOf("`n", $i + 2)
            if ($lineEnd -ge 0 -and $Src.Substring($i + 2, $lineEnd - ($i + 2)).Trim() -eq '') {
                $pattern = '\r?\n[ \t]*''@'
                if ((Get-GdChar $Src ($i + 1)) -eq '"') { $pattern = '\r?\n[ \t]*"@' }
                $m = [regex]::Match($Src, $pattern, 'None', [TimeSpan]::FromSeconds(5))
                $m = [regex]::Match($Src.Substring($lineEnd), $pattern)
                if ($m.Success) { $i = $lineEnd + $m.Index + $m.Length } else { $i = $Src.Length }
                continue
            }
        }
        if (-not $Ps -and $c -eq '\') { $i += 2; continue }
        if ($Ps -and $c -eq '`') { $i += 2; continue }
        if ($c -eq "'") {
            $i++
            while ($i -lt $Src.Length) {
                if ((Get-GdChar $Src $i) -eq "'") {
                    if ($Ps -and (Get-GdChar $Src ($i + 1)) -eq "'") { $i += 2; continue }
                    break
                }
                $i++
            }
            $i++
            continue
        }
        if ($c -eq '"') {
            $i++
            while ($i -lt $Src.Length -and (Get-GdChar $Src $i) -ne '"') {
                if ((-not $Ps -and (Get-GdChar $Src $i) -eq '\') -or ($Ps -and (Get-GdChar $Src $i) -eq '`')) { $i++ }
                elseif ((Get-GdChar $Src $i) -eq '$' -and (Get-GdChar $Src ($i + 1)) -eq '(') {
                    $i = Get-GdClosingParen $Src ($i + 2) $Ps
                    continue
                }
                $i++
            }
            $i++
            continue
        }
        if ($c -eq '(') { $depth++ }
        elseif ($c -eq ')') {
            $depth--
            if ($depth -eq 0) { return $i + 1 }
        }
        $i++
    }
    return $Src.Length
}

# Index just past the matching '}' of a '${' already consumed.
function Get-GdClosingBrace {
    param([string] $Src, [int] $Index)
    $i = $Index
    $depth = 1
    while ($i -lt $Src.Length) {
        $c = Get-GdChar $Src $i
        if ($c -eq '{') { $depth++ }
        elseif ($c -eq '}') {
            $depth--
            if ($depth -eq 0) { return $i + 1 }
        }
        $i++
    }
    return $Src.Length
}

# Every '$(...)' and backtick body inside text that the shell will expand.
function Get-GdSubstitutions {
    param([string] $Text)
    $out = [System.Collections.Generic.List[string]]::new()
    for ($i = 0; $i -lt $Text.Length; $i++) {
        $c = Get-GdChar $Text $i
        if ($c -eq '\') { $i++; continue }
        if ($c -eq '$' -and (Get-GdChar $Text ($i + 1)) -eq '(' -and (Get-GdChar $Text ($i + 2)) -ne '(') {
            $end = Get-GdClosingParen $Text ($i + 2) $false
            [void] $out.Add($Text.Substring($i + 2, [Math]::Max(0, $end - 1 - ($i + 2))))
            $i = $end - 1
        }
        elseif ($c -eq '`') {
            $end = $Text.IndexOf('`', $i + 1)
            if ($end -lt 0) { break }
            [void] $out.Add($Text.Substring($i + 1, $end - ($i + 1)))
            $i = $end
        }
    }
    return , $out.ToArray()
}

# ---------------------------------------------------------------------------
# POSIX lexer (Bash tool)
# ---------------------------------------------------------------------------

$script:PosixBoundary = @(' ', "`t", "`r", "`n", ';', '&', '|', '(', ')', '<', '>')
# Ordinal, not the default: PowerShell hash literals fold 'e' and 'E' together,
# and \n and \N are not the same escape.
$script:AnsiC = [System.Collections.Hashtable]::new([System.StringComparer]::Ordinal)
foreach ($pair in @(
        @('n', "`n"), @('t', "`t"), @('r', "`r"), @('a', [char] 7), @('b', [char] 8),
        @('e', [char] 27), @('E', [char] 27), @('f', [char] 12), @('v', [char] 11),
        @('\', '\'), @("'", "'"), @('"', '"'), @('?', '?')
    )) { $script:AnsiC[$pair[0]] = $pair[1] }

function Add-GdCommand {
    param([hashtable] $St, [string] $Sep)
    $cmd = $St.Cmd
    if ($cmd.Words.Count -gt 0 -or $cmd.Heredocs.Count -gt 0 -or $cmd.Herestrings.Count -gt 0) {
        [void] $St.Commands.Add($cmd)
    }
    $St.Cmd = New-GdCommand
    if ($Sep -eq '|') { $St.Cmd.PipedFrom = $cmd }
}

function Read-GdPosixDouble {
    param([hashtable] $St, [int] $Index, [GdWord] $Word)
    $src = $St.Src
    $j = $Index + 1
    $text = ''
    $dyn = $false
    $soleRef = $null
    $parts = 0
    while ($j -lt $src.Length -and (Get-GdChar $src $j) -ne '"') {
        $c = Get-GdChar $src $j
        if ($c -eq '\' -and ('$`"\' + "`n").IndexOf([string](Get-GdChar $src ($j + 1))) -ge 0) {
            if ((Get-GdChar $src ($j + 1)) -ne "`n") { $text += [string](Get-GdChar $src ($j + 1)) }
            $parts++
            $j += 2
            continue
        }
        if ($c -eq '$' -and (Get-GdChar $src ($j + 1)) -eq '(') {
            if ((Get-GdChar $src ($j + 2)) -eq '(') {
                $j = Get-GdClosingParen $src ($j + 2) $false
            }
            else {
                $end = Get-GdClosingParen $src ($j + 2) $false
                [void] $St.Nested.Add(@{ Src = $src.Substring($j + 2, [Math]::Max(0, $end - 1 - ($j + 2))); Label = '$(...)'; G = 'posix' })
                $j = $end
            }
            $dyn = $true
            $parts += 2
            continue
        }
        if ($c -eq '`') {
            $end = $src.IndexOf('`', $j + 1)
            $stop = $end
            if ($stop -lt 0) { $stop = $src.Length }
            $body = $src.Substring($j + 1, $stop - ($j + 1)) -creplace '\\`', '`'
            [void] $St.Nested.Add(@{ Src = $body; Label = '`...`'; G = 'posix' })
            $j = $stop + 1
            $dyn = $true
            $parts += 2
            continue
        }
        if ($c -eq '$') {
            if ((Get-GdChar $src ($j + 1)) -eq '{') {
                $end = Get-GdClosingBrace $src ($j + 2)
                $inner = $src.Substring($j + 2, [Math]::Max(0, $end - 1 - ($j + 2)))
                if ($parts -eq 0 -and $inner -cmatch '^[A-Za-z_][A-Za-z0-9_]*$') { $soleRef = $inner } else { $soleRef = $null }
                $j = $end
                $dyn = $true
                $parts++
                continue
            }
            $m = [regex]::Match($src.Substring($j + 1), '^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])')
            if ($m.Success) {
                if ($parts -eq 0 -and $m.Value -cmatch '^[A-Za-z_]') { $soleRef = $m.Value } else { $soleRef = $null }
                $j += 1 + $m.Length
                $dyn = $true
                $parts++
                continue
            }
        }
        $text += [string] $c
        $parts += 2
        $j++
    }
    if ($dyn) {
        if ($text -ne '') { $Word.Add($text) }
        if ($parts -eq 1) { $Word.AddDyn($soleRef, $null) } else { $Word.AddDyn($null, $null) }
    }
    else {
        $Word.Add($text)
    }
    return $j + 1
}

function Read-GdPosixDollar {
    param([hashtable] $St, [int] $Index, [GdWord] $Word)
    $src = $St.Src
    $i = $Index
    $next = Get-GdChar $src ($i + 1)
    if ($next -eq '(') {
        if ((Get-GdChar $src ($i + 2)) -eq '(') {
            # Arithmetic '$((...))': starting at the second '(' counts both.
            $Word.AddDyn($null, $null)
            return (Get-GdClosingParen $src ($i + 2) $false)
        }
        $end = Get-GdClosingParen $src ($i + 2) $false
        $body = $src.Substring($i + 2, [Math]::Max(0, $end - 1 - ($i + 2)))
        [void] $St.Nested.Add(@{ Src = $body; Label = '$(...)'; G = 'posix' })
        $Word.AddDyn($null, $body)
        return $end
    }
    if ($next -eq '{') {
        $end = Get-GdClosingBrace $src ($i + 2)
        $inner = $src.Substring($i + 2, [Math]::Max(0, $end - 1 - ($i + 2)))
        if ($inner -cmatch '^[A-Za-z_][A-Za-z0-9_]*$') { $Word.AddDyn($inner, $null) } else { $Word.AddDyn($null, $null) }
        return $end
    }
    if ($next -eq "'") {
        $j = $i + 2
        $text = ''
        while ($j -lt $src.Length -and (Get-GdChar $src $j) -ne "'") {
            if ((Get-GdChar $src $j) -eq '\' -and $j + 1 -lt $src.Length) {
                $e = [string](Get-GdChar $src ($j + 1))
                if ($e -ceq 'x' -and $src.Substring($j + 2) -cmatch '^[0-9a-fA-F]{1,2}') {
                    $hex = [regex]::Match($src.Substring($j + 2), '^[0-9a-fA-F]{1,2}').Value
                    $text += [string][char][Convert]::ToInt32($hex, 16)
                    $j += 2 + $hex.Length
                    continue
                }
                if ($e -cmatch '^[0-7]$') {
                    $oct = [regex]::Match($src.Substring($j + 1), '^[0-7]{1,3}').Value
                    $text += [string][char][Convert]::ToInt32($oct, 8)
                    $j += 1 + $oct.Length
                    continue
                }
                if ($script:AnsiC.ContainsKey($e)) { $text += [string] $script:AnsiC[$e] } else { $text += $e }
                $j += 2
                continue
            }
            $text += [string](Get-GdChar $src $j)
            $j++
        }
        $Word.Add($text)
        return $j + 1
    }
    if ($next -eq '"') { return (Read-GdPosixDouble $St ($i + 1) $Word) }
    $m = [regex]::Match($src.Substring($i + 1), '^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])')
    if ($m.Success) {
        if ($m.Value -cmatch '^[A-Za-z_]') { $Word.AddDyn($m.Value, $null) } else { $Word.AddDyn($null, $null) }
        return $i + 1 + $m.Length
    }
    $Word.Add('$')
    return $i + 1
}

function Read-GdPosixWord {
    param([hashtable] $St, [int] $Index)
    $src = $St.Src
    $i = $Index
    $word = [GdWord]::new()
    while ($i -lt $src.Length) {
        $c = Get-GdChar $src $i
        if ($script:PosixBoundary -ccontains [string] $c) { break }
        if ($c -eq '\') {
            if ((Get-GdChar $src ($i + 1)) -eq "`n") { $i += 2; continue }
            if ($i + 1 -lt $src.Length) { $word.Add([string](Get-GdChar $src ($i + 1))) }
            $i += 2
            continue
        }
        if ($c -eq "'") {
            $end = $src.IndexOf("'", $i + 1)
            $stop = $end
            if ($stop -lt 0) { $stop = $src.Length }
            $word.Add($src.Substring($i + 1, $stop - ($i + 1)))
            $i = $stop + 1
            continue
        }
        if ($c -eq '"') { $i = Read-GdPosixDouble $St $i $word; continue }
        if ($c -eq '$') { $i = Read-GdPosixDollar $St $i $word; continue }
        if ($c -eq '`') {
            $end = $src.IndexOf('`', $i + 1)
            $stop = $end
            if ($stop -lt 0) { $stop = $src.Length }
            $body = $src.Substring($i + 1, $stop - ($i + 1)) -creplace '\\`', '`'
            [void] $St.Nested.Add(@{ Src = $body; Label = '`...`'; G = 'posix' })
            $word.AddDyn($null, $body)
            $i = $stop + 1
            continue
        }
        $word.Add([string] $c)
        $i++
    }
    return @{ Word = $word; End = $i }
}

function Read-GdPosixRedirect {
    param([hashtable] $St, [int] $Index)
    $src = $St.Src
    $i = $Index
    $c = Get-GdChar $src $i
    # Process substitution runs a command: '<(...)', '>(...)'.
    if (($c -eq '<' -or $c -eq '>') -and (Get-GdChar $src ($i + 1)) -eq '(') {
        $end = Get-GdClosingParen $src ($i + 2) $false
        [void] $St.Nested.Add(@{ Src = $src.Substring($i + 2, [Math]::Max(0, $end - 1 - ($i + 2))); Label = '<(...)'; G = 'posix' })
        $w = [GdWord]::new()
        $w.AddDyn($null, $null)
        [void] $St.Cmd.Words.Add($w)
        return $end
    }
    if ($src.Substring($i).StartsWith('<<<')) {
        $j = $i + 3
        while ((Get-GdChar $src $j) -eq ' ' -or (Get-GdChar $src $j) -eq "`t" -or (Get-GdChar $src $j) -eq "`r") { $j++ }
        $read = Read-GdPosixWord $St $j
        [void] $St.Cmd.Herestrings.Add($read.Word.V)
        return $read.End
    }
    if ($src.Substring($i).StartsWith('<<')) {
        $j = $i + 2
        $strip = (Get-GdChar $src $j) -eq '-'
        if ($strip) { $j++ }
        while ((Get-GdChar $src $j) -eq ' ' -or (Get-GdChar $src $j) -eq "`t" -or (Get-GdChar $src $j) -eq "`r") { $j++ }
        $raw = [regex]::Match($src.Substring($j), '^[^\s;&|<>()]*').Value
        $read = Read-GdPosixWord $St $j
        [void] $St.Pending.Add(@{ Delim = $read.Word.V; Strip = $strip; Quoted = ($raw -cmatch '[''"\\]'); Cmd = $St.Cmd })
        return $read.End
    }
    $j = $i
    while ($j -lt $src.Length -and ([string](Get-GdChar $src $j)) -cmatch '[<>&|]') { $j++ }
    while ((Get-GdChar $src $j) -eq ' ' -or (Get-GdChar $src $j) -eq "`t" -or (Get-GdChar $src $j) -eq "`r") { $j++ }
    if ($j -ge $src.Length -or (Get-GdChar $src $j) -eq "`n") { return $j }
    $read = Read-GdPosixWord $St $j
    return $read.End
}

function Invoke-GdLexPosix {
    param([string] $Src)
    $st = @{
        Src      = $Src
        Commands = [System.Collections.Generic.List[object]]::new()
        Nested   = [System.Collections.Generic.List[object]]::new()
        Cmd      = (New-GdCommand)
        Pending  = [System.Collections.Generic.List[object]]::new()
    }
    $n = $Src.Length
    $i = 0
    while ($i -lt $n) {
        $c = Get-GdChar $Src $i
        if ($c -eq ' ' -or $c -eq "`t" -or $c -eq "`r") { $i++; continue }
        if ($c -eq '\' -and (Get-GdChar $Src ($i + 1)) -eq "`n") { $i += 2; continue }
        if ($c -eq '#') {
            while ($i -lt $n -and (Get-GdChar $Src $i) -ne "`n") { $i++ }
            continue
        }
        if ($c -eq "`n") {
            Add-GdCommand $st "`n"
            $i++
            foreach ($h in $st.Pending) {
                $lines = [System.Collections.Generic.List[string]]::new()
                while ($i -lt $n) {
                    $j = $Src.IndexOf("`n", $i)
                    if ($j -lt 0) { $j = $n }
                    $line = $Src.Substring($i, $j - $i)
                    $i = [Math]::Min($j + 1, $n)
                    if ($line.EndsWith("`r")) { $line = $line.Substring(0, $line.Length - 1) }
                    $cmp = $line
                    if ($h.Strip) { $cmp = $cmp -creplace '^\t+', '' }
                    if ($cmp -ceq $h.Delim) { break }
                    [void] $lines.Add($line)
                }
                $body = [string]::Join("`n", $lines.ToArray())
                [void] $h.Cmd.Heredocs.Add($body)
                if (-not $h.Quoted) {
                    foreach ($s in (Get-GdSubstitutions $body)) {
                        [void] $st.Nested.Add(@{ Src = $s; Label = '$(...)'; G = 'posix' })
                    }
                }
            }
            $st.Pending.Clear()
            continue
        }
        if ($c -eq ';') { Add-GdCommand $st ';'; $i++; continue }
        if ($c -eq '&') {
            if ((Get-GdChar $Src ($i + 1)) -eq '&') { Add-GdCommand $st '&&'; $i += 2; continue }
            if ((Get-GdChar $Src ($i + 1)) -eq '>') { $i = Read-GdPosixRedirect $st ($i + 1); continue }
            Add-GdCommand $st '&'
            $i++
            continue
        }
        if ($c -eq '|') {
            if ((Get-GdChar $Src ($i + 1)) -eq '|') { Add-GdCommand $st '||'; $i += 2; continue }
            Add-GdCommand $st '|'
            if ((Get-GdChar $Src ($i + 1)) -eq '&') { $i += 2 } else { $i++ }
            continue
        }
        if ($c -eq '(' -or $c -eq ')') { Add-GdCommand $st ([string] $c); $i++; continue }
        if ($c -eq '<' -or $c -eq '>') { $i = Read-GdPosixRedirect $st $i; continue }
        if (([string] $c) -cmatch '[0-9]') {
            $m = [regex]::Match($Src.Substring($i), '^[0-9]+(?=[<>])')
            if ($m.Success) { $i = Read-GdPosixRedirect $st ($i + $m.Length); continue }
        }
        if (($c -eq '{' -or $c -eq '}') -and ($i + 1 -ge $n -or ([string](Get-GdChar $Src ($i + 1))) -cmatch '[\s;]')) {
            Add-GdCommand $st ([string] $c)
            $i++
            continue
        }
        $read = Read-GdPosixWord $st $i
        [void] $st.Cmd.Words.Add($read.Word)
        $i = $read.End
    }
    Add-GdCommand $st 'end'
    return @{ Commands = $st.Commands.ToArray(); Nested = $st.Nested.ToArray() }
}

# ---------------------------------------------------------------------------
# PowerShell lexer (PowerShell tool)
# ---------------------------------------------------------------------------

$script:PsBoundary = @(' ', "`t", "`r", "`n", ';', '|', '(', ')', '{', '}', '<', '>', '&')

function Read-GdPsDouble {
    param([hashtable] $St, [int] $Index, [GdWord] $Word)
    $src = $St.Src
    $j = $Index + 1
    $text = ''
    $dyn = $false
    while ($j -lt $src.Length) {
        $c = Get-GdChar $src $j
        if ($c -eq '"') {
            if ((Get-GdChar $src ($j + 1)) -eq '"') { $text += '"'; $j += 2; continue }
            break
        }
        if ($c -eq '`') {
            if ($j + 1 -lt $src.Length) { $text += [string](Get-GdChar $src ($j + 1)) }
            $j += 2
            continue
        }
        if ($c -eq '$' -and (Get-GdChar $src ($j + 1)) -eq '(') {
            $end = Get-GdClosingParen $src ($j + 2) $true
            [void] $St.Nested.Add(@{ Src = $src.Substring($j + 2, [Math]::Max(0, $end - 1 - ($j + 2))); Label = '$(...)'; G = 'ps' })
            $j = $end
            $dyn = $true
            continue
        }
        if ($c -eq '$') {
            $m = [regex]::Match($src.Substring($j + 1), '^(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_:]*)')
            if ($m.Success) {
                $j += 1 + $m.Length
                $dyn = $true
                continue
            }
        }
        $text += [string] $c
        $j++
    }
    $Word.Add($text)
    if ($dyn) { $Word.AddDyn($null, $null) }
    return $j + 1
}

function Read-GdPsHereString {
    param([hashtable] $St, [int] $Index, [GdWord] $Word)
    $src = $St.Src
    $quote = Get-GdChar $src ($Index + 1)
    $lineEnd = $src.IndexOf("`n", $Index + 2)
    if ($lineEnd -lt 0) { return -1 }
    if ($src.Substring($Index + 2, $lineEnd - ($Index + 2)).Trim() -ne '') { return -1 }
    $pattern = '\r?\n[ \t]*"@'
    if ($quote -eq "'") { $pattern = '\r?\n[ \t]*''@' }
    $m = [regex]::Match($src.Substring($lineEnd), $pattern)
    $stop = $src.Length
    if ($m.Success) { $stop = $lineEnd + $m.Index }
    $body = $src.Substring($lineEnd + 1, [Math]::Max(0, $stop - ($lineEnd + 1)))
    $Word.Add($body)
    if ($quote -eq '"') {
        for ($k = 0; $k -lt $body.Length; $k++) {
            if ((Get-GdChar $body $k) -eq '`') { $k++; continue }
            if ((Get-GdChar $body $k) -eq '$' -and (Get-GdChar $body ($k + 1)) -eq '(') {
                $end = Get-GdClosingParen $body ($k + 2) $true
                [void] $St.Nested.Add(@{ Src = $body.Substring($k + 2, [Math]::Max(0, $end - 1 - ($k + 2))); Label = '$(...)'; G = 'ps' })
                $Word.AddDyn($null, $null)
                $k = $end - 1
            }
        }
    }
    if ($m.Success) { return $lineEnd + $m.Index + $m.Length }
    return $src.Length
}

function Read-GdPsWord {
    param([hashtable] $St, [int] $Index)
    $src = $St.Src
    $i = $Index
    $word = [GdWord]::new()
    while ($i -lt $src.Length) {
        $c = Get-GdChar $src $i
        if ($script:PsBoundary -ccontains [string] $c) { break }
        if ($c -eq '`') {
            if ((Get-GdChar $src ($i + 1)) -eq "`n" -or ((Get-GdChar $src ($i + 1)) -eq "`r" -and (Get-GdChar $src ($i + 2)) -eq "`n")) { break }
            if ($i + 1 -lt $src.Length) { $word.Add([string](Get-GdChar $src ($i + 1))) }
            $i += 2
            continue
        }
        if ($c -eq "'") {
            $j = $i + 1
            $text = ''
            while ($j -lt $src.Length) {
                if ((Get-GdChar $src $j) -eq "'") {
                    if ((Get-GdChar $src ($j + 1)) -eq "'") { $text += "'"; $j += 2; continue }
                    break
                }
                $text += [string](Get-GdChar $src $j)
                $j++
            }
            $word.Add($text)
            $i = $j + 1
            continue
        }
        if ($c -eq '"') { $i = Read-GdPsDouble $St $i $word; continue }
        if ($c -eq '@' -and $word.Empty -and ((Get-GdChar $src ($i + 1)) -eq "'" -or (Get-GdChar $src ($i + 1)) -eq '"')) {
            $end = Read-GdPsHereString $St $i $word
            if ($end -ge 0) { $i = $end; continue }
        }
        if (($c -eq '$' -or $c -eq '@') -and (Get-GdChar $src ($i + 1)) -eq '(') {
            $end = Get-GdClosingParen $src ($i + 2) $true
            $body = $src.Substring($i + 2, [Math]::Max(0, $end - 1 - ($i + 2)))
            [void] $St.Nested.Add(@{ Src = $body; Label = ([string] $c) + '(...)'; G = 'ps' })
            if ($c -eq '$') { $word.AddDyn($null, $body) } else { $word.AddDyn($null, $null) }
            $i = $end
            continue
        }
        if ($c -eq '$') {
            $m = [regex]::Match($src.Substring($i + 1), '^(?:\{([^}]*)\}|([A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_]*)?))')
            if ($m.Success) {
                $name = $m.Groups[1].Value
                if (-not $m.Groups[1].Success) { $name = $m.Groups[2].Value }
                $name = ($name -replace '^(?:script|global|local|private):', '').ToLowerInvariant()
                $word.AddDyn($name, $null)
                $i += 1 + $m.Length
                # '$x=...' without spaces: end the word at '=' so the assignment is visible.
                if ((Get-GdChar $src $i) -eq '=' -and (Get-GdChar $src ($i + 1)) -ne '=' -and $word.VarRef) { break }
                continue
            }
        }
        $word.Add([string] $c)
        $i++
    }
    return @{ Word = $word; End = $i }
}

function Invoke-GdLexPs {
    param([string] $Src)
    $st = @{
        Src      = $Src
        Commands = [System.Collections.Generic.List[object]]::new()
        Nested   = [System.Collections.Generic.List[object]]::new()
        Cmd      = (New-GdCommand)
        Pending  = [System.Collections.Generic.List[object]]::new()
    }
    $n = $Src.Length
    $i = 0
    while ($i -lt $n) {
        $c = Get-GdChar $Src $i
        if ($c -eq ' ' -or $c -eq "`t" -or $c -eq "`r") { $i++; continue }
        if ($c -eq '`' -and ((Get-GdChar $Src ($i + 1)) -eq "`n" -or (Get-GdChar $Src ($i + 1)) -eq "`r")) {
            if ((Get-GdChar $Src ($i + 1)) -eq "`r") { $i += 3 } else { $i += 2 }
            continue
        }
        if ($c -eq '<' -and (Get-GdChar $Src ($i + 1)) -eq '#') {
            $end = $Src.IndexOf('#>', $i + 2)
            if ($end -lt 0) { $i = $n } else { $i = $end + 2 }
            continue
        }
        if ($c -eq '#') {
            while ($i -lt $n -and (Get-GdChar $Src $i) -ne "`n") { $i++ }
            continue
        }
        if ($c -eq "`n" -or $c -eq ';') { Add-GdCommand $st ([string] $c); $i++; continue }
        if ($c -eq '|') {
            if ((Get-GdChar $Src ($i + 1)) -eq '|') { Add-GdCommand $st '||'; $i += 2; continue }
            Add-GdCommand $st '|'
            $i++
            continue
        }
        if ($c -eq '&') {
            if ((Get-GdChar $Src ($i + 1)) -eq '&') { Add-GdCommand $st '&&'; $i += 2; continue }
            # The call operator. "& 'Remove-Item' x" runs Remove-Item.
            $i++
            continue
        }
        if ($c -eq '(' -or $c -eq ')' -or $c -eq '{' -or $c -eq '}') { Add-GdCommand $st ([string] $c); $i++; continue }
        if ($c -eq '@' -and (Get-GdChar $Src ($i + 1)) -eq '{') { Add-GdCommand $st '{'; $i += 2; continue }
        if ($c -eq '<' -or $c -eq '>' -or ((($c -eq '*') -or (([string] $c) -cmatch '[0-9]')) -and ((Get-GdChar $Src ($i + 1)) -eq '>' -or (Get-GdChar $Src ($i + 1)) -eq '<'))) {
            $j = $i
            if ($c -ne '<' -and $c -ne '>') { $j = $i + 1 }
            while ($j -lt $n -and ((Get-GdChar $Src $j) -eq '<' -or (Get-GdChar $Src $j) -eq '>')) { $j++ }
            if ((Get-GdChar $Src $j) -eq '&' -and ([string](Get-GdChar $Src ($j + 1))) -cmatch '[0-9]') { $i = $j + 2; continue }
            while ($j -lt $n -and ((Get-GdChar $Src $j) -eq ' ' -or (Get-GdChar $Src $j) -eq "`t")) { $j++ }
            if ($j -ge $n -or (Get-GdChar $Src $j) -eq "`n") { $i = $j; continue }
            $read = Read-GdPsWord $st $j
            $i = $read.End
            continue
        }
        $read = Read-GdPsWord $st $i
        if ($read.End -eq $i) { $i++; continue }
        [void] $st.Cmd.Words.Add($read.Word)
        $i = $read.End
    }
    Add-GdCommand $st 'end'
    return @{ Commands = $st.Commands.ToArray(); Nested = $st.Nested.ToArray() }
}

# ---------------------------------------------------------------------------
# cmd.exe lexer ('cmd /c ...')
# ---------------------------------------------------------------------------

function Invoke-GdLexCmd {
    param([string] $Src)
    $commands = [System.Collections.Generic.List[object]]::new()
    $cmd = New-GdCommand
    $word = $null
    $inQuote = $false
    $n = $Src.Length
    for ($i = 0; $i -lt $n; $i++) {
        $c = Get-GdChar $Src $i
        if ($inQuote) {
            if ($c -eq '"') { $inQuote = $false } else { $word.Add([string] $c) }
            continue
        }
        if ($c -eq '"') {
            if ($null -eq $word) { $word = [GdWord]::new() }
            $word.Add('')
            $inQuote = $true
            continue
        }
        if ($c -eq '^') {
            if ($null -eq $word) { $word = [GdWord]::new() }
            $word.Add([string](Get-GdChar $Src ($i + 1)))
            $i++
            continue
        }
        if ($c -eq ' ' -or $c -eq "`t" -or $c -eq "`r") {
            if ($null -ne $word) { [void] $cmd.Words.Add($word); $word = $null }
            continue
        }
        if ($c -eq "`n" -or $c -eq '&' -or $c -eq '|' -or $c -eq '(' -or $c -eq ')') {
            if ($null -ne $word) { [void] $cmd.Words.Add($word); $word = $null }
            if ($cmd.Words.Count -gt 0) { [void] $commands.Add($cmd) }
            $cmd = New-GdCommand
            if (($c -eq '&' -or $c -eq '|') -and (Get-GdChar $Src ($i + 1)) -eq $c) { $i++ }
            continue
        }
        if ($c -eq '<' -or $c -eq '>') {
            if ($null -ne $word -and $word.V -cmatch '^[0-9]$') { $word = $null }
            if ($null -ne $word) { [void] $cmd.Words.Add($word); $word = $null }
            $j = $i
            while ($j -lt $n -and ((Get-GdChar $Src $j) -eq '<' -or (Get-GdChar $Src $j) -eq '>')) { $j++ }
            if ((Get-GdChar $Src $j) -eq '&') { $i = $j + 1; continue }
            while ($j -lt $n -and (Get-GdChar $Src $j) -eq ' ') { $j++ }
            while ($j -lt $n -and ([string](Get-GdChar $Src $j)) -cnotmatch '[\s&|<>()]') { $j++ }
            $i = $j - 1
            continue
        }
        if ($null -eq $word) { $word = [GdWord]::new() }
        $word.Add([string] $c)
    }
    if ($null -ne $word) { [void] $cmd.Words.Add($word) }
    if ($cmd.Words.Count -gt 0) { [void] $commands.Add($cmd) }
    return @{ Commands = $commands.ToArray(); Nested = @() }
}

# Words after the options of a wrapper. Valued options consume the next word
# unless written as '--opt=value'. '--' ends the options.
function Get-GdAfterOptions {
    param([object[]] $Items, [string[]] $Valued = @())
    if ($null -eq $Items) { return , @() }
    for ($i = 0; $i -lt $Items.Count; $i++) {
        $a = $Items[$i].V
        if ($a -ceq '--') { return , (Get-GdSlice $Items ($i + 1)) }
        if ($a.Length -gt 1 -and $a.StartsWith('-')) {
            if ($Valued -ccontains $a) { $i++ }
            continue
        }
        return , (Get-GdSlice $Items $i)
    }
    return , @()
}

function Get-GdValueAfter {
    param([object[]] $Items, [string[]] $Names)
    if ($null -eq $Items) { return $null }
    for ($i = 0; $i -lt $Items.Count; $i++) {
        $a = $Items[$i].V
        if ($Names -ccontains $a) {
            $next = Get-GdItem $Items ($i + 1)
            if ($null -ne $next) { return $next }
            return [GdWord]::new('')
        }
        foreach ($name in $Names) {
            if ($name.StartsWith('--') -and $a.StartsWith($name + '=')) { return [GdWord]::new($a.Substring($name.Length + 1)) }
        }
    }
    return $null
}
