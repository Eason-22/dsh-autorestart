# dsh-autorestart — run the plugin's node:test suite with the DSH bundled Node.
#
# There is no `node` on PATH in the DSH desktop environment, so this script uses
# the runtime that ships with the app. Usage (from anywhere):
#
#   pwsh -NoProfile -File plugins/dsh-autorestart/scripts/run-tests.ps1
#
# Optional args:
#   -NodeExe  <path>  override the bundled node binary
#   -TestGlob <glob>  test file glob (default: <plugin>/test/*.test.mjs)
#
# NOTE: Node >= 24 treats positional --test arguments as glob patterns, so pass
# a glob (or explicit files), not a directory. `node --test <dir>` fails with
# MODULE_NOT_FOUND on v24.

param(
  [string]$NodeExe = 'C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe',
  [string]$TestGlob = ''
)

$ErrorActionPreference = 'Stop'
$pluginDir = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path -LiteralPath $NodeExe)) {
  throw "Bundled Node not found: $NodeExe"
}

$pattern = if ($TestGlob) { $TestGlob } else { Join-Path $pluginDir 'test\*.test.mjs' }

Write-Host 'dsh-autorestart tests'
Write-Host "  node : $NodeExe"
Write-Host "  tests: $pattern"
Write-Host ''

& $NodeExe --test $pattern
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
  Write-Host ''
  Write-Host "TESTS FAILED (exit code $exitCode)" -ForegroundColor Red
  exit $exitCode
}

Write-Host ''
Write-Host 'TESTS PASSED' -ForegroundColor Green
exit 0
