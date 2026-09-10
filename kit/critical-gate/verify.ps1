#requires -Version 5.1
# Offline tests only. No installer, execution-policy change, hooks or DB access.
[CmdletBinding()]
param(
    [string]$OutputDirectory,
    [string]$ExpectedNodeVersion = '24.13.0'
)
$ErrorActionPreference = 'Stop'
try {
    $node = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $runner = Join-Path $PSScriptRoot 'verify.mjs'
    $launcher = '{0}/{1}' -f $PSVersionTable.PSEdition, $PSVersionTable.PSVersion.ToString()
    $arguments = @($runner, '--expected-platform', 'win32', '--expected-node', $ExpectedNodeVersion, '--launcher', $launcher)
    if ($OutputDirectory) { $arguments += @('--output', $OutputDirectory) }
    & $node.Source @arguments
    $resultCode = $LASTEXITCODE
    if ($null -eq $resultCode) { exit 2 }
    exit $resultCode
} catch {
    [Console]::Error.WriteLine('Critical gate verification could not run. No passing result was recorded.')
    exit 2
}
