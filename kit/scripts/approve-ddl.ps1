#requires -Version 5.1
<#
.SYNOPSIS
    Approve one exact SQL statement so guard-sql.ps1 will let it through once.

.DESCRIPTION
    Run this yourself, after reading the SQL. It writes a token named after the
    SHA-256 of the whitespace-normalized statement. The hook consumes the token on
    first use and refuses it after the TTL, so an approval cannot be reused later
    for a statement you never saw.

    ASCII-only on purpose. See the encoding note in guard-sql.ps1.

.EXAMPLE
    .\approve-ddl.ps1 -Sql "alter table bookings add column memo text"

.EXAMPLE
    .\approve-ddl.ps1 -Path .\supabase\migrations\20260906_add_memo.sql
#>

[CmdletBinding(DefaultParameterSetName = 'Sql')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Sql', Position = 0)]
    [string] $Sql,

    [Parameter(Mandatory, ParameterSetName = 'Path')]
    [string] $Path,

    [string] $ApprovalDir = $(
        if ($env:AIWF_APPROVAL_DIR) { $env:AIWF_APPROVAL_DIR }
        else { Join-Path $HOME '.claude\approvals' }
    ),

    # Skip the confirmation prompt. Only for scripted, reviewed pipelines.
    [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($PSCmdlet.ParameterSetName -eq 'Path') {
    $Sql = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
}

if (-not $Sql.Trim()) { throw 'Empty SQL.' }

$normalized = ([regex]::Replace($Sql, '\s+', ' ')).Trim()
$sha = [System.Security.Cryptography.SHA256]::Create()
try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($normalized)
    $fingerprint = -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
} finally { $sha.Dispose() }

Write-Host ''
Write-Host '--- SQL to approve -------------------------------------------' -ForegroundColor Cyan
Write-Host $Sql
Write-Host '--------------------------------------------------------------' -ForegroundColor Cyan
Write-Host "fingerprint : $fingerprint"
Write-Host "valid for   : 15 minutes, single use"
Write-Host ''

if (-not $Force) {
    $answer = Read-Host 'Approve this exact statement? (y/N)'
    if ($answer -ne 'y' -and $answer -ne 'Y') {
        Write-Host 'Cancelled. Nothing written.' -ForegroundColor Yellow
        exit 1
    }
}

if (-not (Test-Path -LiteralPath $ApprovalDir)) {
    New-Item -ItemType Directory -Path $ApprovalDir -Force | Out-Null
}

$file = Join-Path $ApprovalDir "$fingerprint.approval"

# BOM-free UTF-8, always.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($file, $normalized, $utf8NoBom)

Write-Host "Approved. Retry the tool call unchanged." -ForegroundColor Green
Write-Host "token: $file"
