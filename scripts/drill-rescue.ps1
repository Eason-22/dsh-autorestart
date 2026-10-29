<#
.SYNOPSIS
  The dsh-autorestart rescue drill: break a profile on purpose, rescue it.

.DESCRIPTION
  This script only touches ITS OWN temporary directory. It never reads or
  writes the profile the user is running.

  Directory discipline (the hard requirement for running two drills at once):

    - the directory is %TEMP%\dsh-rescue-drill-<full GUID>, unique every run;
    - the drill creates it itself (without -Force): if it is already there,
      somebody else is using it and the drill stops;
    - the drill puts a lock file .lock inside it (created exclusively): no lock,
      no drill;
    - the cleanup deletes ONLY its own absolute path (Remove-Item -LiteralPath),
      never a wildcard scan of %TEMP% - that would delete the directory of a
      drill that is running at the same time;
    - success, a failed assertion and a crash all go through the same finally:
      the directory is always cleaned, and a directory that could not be
      cleaned is printed so a human can remove it.

  What the drill does:

    1. builds a fake profile (package.json + cordis.patch.yml + plugin tree);
    2. builds a snapshot (the "backup source") plus a NEWER directory that has
       no manifest - the snapshot selection has to skip it;
    3. breaks it on purpose: package.json becomes invalid JSON and the plugin
       directory is deleted;
    4. calls restore-profile.ps1;
    5. asserts: package.json parses, the bundles have content, the plugin
       version can be read, the broken-* evidence directory exists, a directory
       that is not a profile is refused, a missing target is refused, "the
       configuration says it is installed but it is not" must fail, a drive root
       is refused, a system directory is refused, a dry run changes nothing,
       the encoding rules hold;
    6. cleans up (finally).

  LANGUAGE: this file is pure ASCII on purpose. Windows PowerShell 5.1 reads a
  UTF-8 file without a byte order mark as ANSI, so one Chinese character
  inside the script turns into mojibake and the script dies with a ParserError
  before it does anything. The Chinese wording lives in
  scripts\rescue-strings.zh.json (UTF-8, no BOM) and is read at runtime; if
  that file is missing or broken, every message falls back to English and the
  script says so.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\drill-rescue.ps1

.NOTES
  Every assertion passing means exit code 0; any failing assertion means 1.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# The plugin the drill works with.
$PackageName = 'dsh-autorestart'

# How many assertions failed (the exit code is decided by it).
$script:Failures = 0

# This run's own directory, and whether this run is the one that created it.
$script:TempRoot = ''
$script:OwnsTempRoot = $false

# ---------------------------------------------------------------------------
# The Chinese strings: read from rescue-strings.zh.json, fall back to English.
# ---------------------------------------------------------------------------

$script:Strings = $null
$script:StringsError = ''

function Initialize-Strings {
  $path = Join-Path $PSScriptRoot 'rescue-strings.zh.json'
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    $script:StringsError = (T 'common.stringsMissingEn' 'the Chinese strings file is missing: {0} (falling back to English messages)') -f $path
    return
  }
  try {
    # Read as UTF-8 explicitly: Get-Content would use the console code page.
    $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
    $script:Strings = $text | ConvertFrom-Json
  } catch {
    $script:StringsError = (T 'common.stringsBrokenEn' 'the Chinese strings file could not be read: {0} (falling back to English messages)') -f $_.Exception.Message
    $script:Strings = $null
  }
}

# The node behind a dotted key, or $null when the key does not exist.
function Get-StringNode {
  param([string] $Key)
  if ($null -eq $script:Strings) { return $null }
  $node = $script:Strings
  foreach ($part in $Key.Split('.')) {
    if ($null -eq $node) { return $null }
    $property = $node.PSObject.Properties[$part]
    if ($null -eq $property) { return $null }
    $node = $property.Value
  }
  return $node
}

# Look a string up. The English fallback is right here in the script, so a
# missing key (or a broken strings file) never stops the drill.
function T {
  param([string] $Key, [string] $Fallback)
  $node = Get-StringNode $Key
  if ($null -ne $node) {
    $text = [string] $node
    if ($text -ne '') { return $text }
  }
  return $Fallback
}

# The same, for a list of strings (the words a refusal has to contain).
function TA {
  param([string] $Key, [string[]] $Fallback)
  $node = Get-StringNode $Key
  if ($null -ne $node) {
    $items = @($node)
    if ($items.Count -gt 0) { return $items }
  }
  return $Fallback
}

Initialize-Strings

function Say {
  param([string] $Text, [string] $Color = 'Gray')
  Write-Host $Text -ForegroundColor $Color
}

function Assert-True {
  param([string] $Name, [bool] $Condition, [string] $Detail = '')
  if ($Condition) {
    Write-Host ((T 'drill.assertPass' '  [pass] {0}') -f $Name) -ForegroundColor Green
    return
  }
  if ($Detail -eq '') {
    Write-Host ((T 'drill.assertFailPlain' '  [fail] {0}') -f $Name) -ForegroundColor Red
  } else {
    Write-Host ((T 'drill.assertFail' '  [fail] {0} - {1}') -f $Name, $Detail) -ForegroundColor Red
  }
  $script:Failures += 1
}

# A rejection has to be more than a non-zero exit code.
#
# An exit code on its own is not enough: a missing BOM, a broken script, a
# syntax error - all of those make the script exit non-zero without it having
# refused anything. That is how the BOM incident of 2026-10-29 produced a
# false pass: the screen was full of ParserErrors, the exit code was 1, and
# that looked like "the script refused on purpose".
# So the output has to contain the sentence that belongs to this scenario.
function Assert-Refused {
  param([string] $Name, $Result, [string[]] $Keywords)
  if ($null -eq $Result) {
    Write-Host ((T 'drill.refusedNoResult' '  [fail] {0} - there is no result to look at') -f $Name) -ForegroundColor Red
    $script:Failures += 1
    return
  }
  if ($Result.Code -eq 0) {
    Write-Host ((T 'drill.refusedNotRefused' '  [fail] {0} - the exit code is 0, the script did not refuse at all') -f $Name) -ForegroundColor Red
    $script:Failures += 1
    return
  }
  $text = [string]$Result.Output
  $hit = ''
  foreach ($keyword in $Keywords) {
    if ($text -like ('*' + $keyword + '*')) { $hit = $keyword; break }
  }
  if ($hit -eq '') {
    Write-Host ((T 'drill.refusedNoReason' '  [fail] {0} - the exit code is {1}, but the output does not say why it refused (one of these was expected: {2})') -f $Name, $Result.Code, ($Keywords -join ', ')) -ForegroundColor Red
    $script:Failures += 1
    return
  }
  Write-Host ((T 'drill.refusedOk' '  [pass] {0} - exit code {1}, the output says why: {2}') -f $Name, $Result.Code, $hit) -ForegroundColor Green
}

# Read a file; an unreadable file gives an empty string (an assertion must
# never take the drill down with it).
function Read-TextOrEmpty {
  param([string] $Path)
  try {
    return [System.IO.File]::ReadAllText($Path)
  } catch {
    return ''
  }
}

# Write a UTF-8 file without a byte order mark (the parent directory is
# created on the way).
function Write-TextFile {
  param([string] $Path, [string] $Text)
  $parent = Split-Path -Parent $Path
  if ($parent -ne '' -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

$scriptRoot = $PSScriptRoot
$restoreScript = Join-Path $scriptRoot 'restore-profile.ps1'
$cmdScript = Join-Path $scriptRoot 'restore-profile.cmd'

if (-not (Test-Path -LiteralPath $restoreScript -PathType Leaf)) {
  Write-Host ((T 'drill.noScript' 'the drill cannot run: {0} was not found') -f $restoreScript) -ForegroundColor Red
  exit 1
}

# A full GUID: every run gets a new directory, two drills never collide.
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-rescue-drill-' + ([guid]::NewGuid().ToString('N')))
$script:TempRoot = $tempRoot
# The lock file lives INSIDE the directory: when the directory is gone the lock
# is gone too, so %TEMP% never keeps a leftover with the same prefix.
$lockFile = Join-Path $tempRoot '.lock'

# Re-entry guard 1: the directory is already there, so somebody (or a run of
# ours that did not clean up) is using it.
if (Test-Path -LiteralPath $tempRoot) {
  Write-Host ((T 'drill.dirOccupied' 'the drill cannot run: this drill directory is already taken: {0}') -f $tempRoot) -ForegroundColor Red
  exit 1
}

# Run the restore script.
function Invoke-Restore {
  param([string[]] $Arguments, [string] $Label)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $restoreScript @Arguments 2>&1
  $code = $LASTEXITCODE
  $ErrorActionPreference = $previous
  Say ((T 'drill.outputHeader' '--- the output of the restore script ({0}) ---') -f $Label) 'DarkGray'
  foreach ($line in $output) { Write-Host ('    ' + [string]$line) }
  Say (T 'drill.outputEnd' '--- end of the output ---') 'DarkGray'
  return [pscustomobject]@{ Code = $code; Output = ($output | Out-String) }
}

try {
  # --- Re-entry guard 2: this drill creates the directory itself (without
  # -Force, so an existing directory is an error). ---
  New-Item -ItemType Directory -Path $tempRoot -ErrorAction Stop | Out-Null

  # --- Re-entry guard 3: the lock file is created exclusively. ---
  $lock = [System.IO.File]::Open($lockFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  $lock.Dispose()
  $script:OwnsTempRoot = $true

  Say ((T 'drill.dir' 'drill directory: {0}') -f $tempRoot) 'Cyan'

  $fakeHome = Join-Path $tempRoot 'dsh-home'
  $stateDir = Join-Path (Join-Path $fakeHome 'storages') 'dsh-autorestart'
  $backupsDir = Join-Path $stateDir 'backups'
  $profileDir = Join-Path $tempRoot 'profile'
  $pluginDir = Join-Path (Join-Path $profileDir 'node_modules') $PackageName

  # -------------------------------------------------------------------------
  # 1. Build a fake profile
  # -------------------------------------------------------------------------

  New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
  New-Item -ItemType Directory -Path $backupsDir -Force | Out-Null

  $goodPackageJson = @'
{
  "name": "drill-profile",
  "version": "1.0.0",
  "dsh": {
    "profile": {
      "bundles": ["dsh-autorestart"]
    }
  }
}
'@
  Write-TextFile (Join-Path $profileDir 'package.json') $goodPackageJson
  Write-TextFile (Join-Path $profileDir 'cordis.patch.yml') "rows:`n  - id: drill`n"
  Write-TextFile (Join-Path $pluginDir 'package.json') "{`n  `"name`": `"dsh-autorestart`",`n  `"version`": `"0.7.0`"`n}"
  Write-TextFile (Join-Path $pluginDir 'index.js') "export default 1`n"

  # -------------------------------------------------------------------------
  # 2. Build the snapshot (the backup source) plus a newer directory without a
  #    manifest - the snapshot selection has to skip it.
  # -------------------------------------------------------------------------

  $goodStamp = '2026-10-29T01-00-00-000Z'
  $decoyStamp = '2026-10-29T02-00-00-000Z'
  $goodSnapshot = Join-Path $backupsDir $goodStamp
  $decoySnapshot = Join-Path $backupsDir $decoyStamp
  $goodPluginDir = Join-Path (Join-Path $goodSnapshot 'node_modules') $PackageName

  New-Item -ItemType Directory -Path (Join-Path $goodSnapshot 'config') -Force | Out-Null
  New-Item -ItemType Directory -Path $goodPluginDir -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $profileDir 'package.json') -Destination (Join-Path $goodSnapshot 'config\package.json') -Force
  Copy-Item -LiteralPath (Join-Path $profileDir 'cordis.patch.yml') -Destination (Join-Path $goodSnapshot 'config\cordis.patch.yml') -Force
  Copy-Item -LiteralPath (Join-Path $pluginDir 'package.json') -Destination (Join-Path $goodPluginDir 'package.json') -Force
  Copy-Item -LiteralPath (Join-Path $pluginDir 'index.js') -Destination (Join-Path $goodPluginDir 'index.js') -Force

  $manifest = [ordered]@{
    stamp    = $goodStamp
    at       = [int64] 1792000000000
    atLocal  = '2026-10-29T09:00:00+08:00'
    profileDir = $profileDir
    includePlugins = $true
    files    = @('config\package.json', 'config\cordis.patch.yml', 'node_modules')
    bytes    = 128
  }
  Write-TextFile (Join-Path $goodSnapshot 'manifest.json') ($manifest | ConvertTo-Json -Depth 5)

  # The decoy: a newer directory, but no manifest - and a different package.json.
  New-Item -ItemType Directory -Path (Join-Path $decoySnapshot 'config') -Force | Out-Null
  Write-TextFile (Join-Path $decoySnapshot 'config\package.json') '{"name":"should-not-be-used"}'

  # -------------------------------------------------------------------------
  # 3. Break it on purpose
  # -------------------------------------------------------------------------

  Write-TextFile (Join-Path $profileDir 'package.json') '{ "name": "drill-profile", oops '
  Remove-Item -LiteralPath $pluginDir -Recurse -Force

  Say (T 'drill.broke' 'broken on purpose: package.json is invalid JSON now and the plugin directory is gone.') 'Yellow'

  # -------------------------------------------------------------------------
  # Run the restore script
  # -------------------------------------------------------------------------

  # The dry run: it only prints.
  $dryRun = Invoke-Restore -Arguments @('-DryRun', '-ProfileDir', $profileDir, '-StateDir', $stateDir) -Label 'dry run'
  Assert-True (T 'drill.assertDryRunExit' 'the dry run exits with 0') ($dryRun.Code -eq 0) ('exit code ' + $dryRun.Code)
  Assert-True (T 'drill.assertDryRunUntouched' 'the dry run did not touch package.json') ((Read-TextOrEmpty (Join-Path $profileDir 'package.json')) -like '*oops*')
  Assert-True (T 'drill.assertDryRunNoBroken' 'the dry run left no broken directory') (@(Get-ChildItem -LiteralPath $tempRoot -Directory -Filter 'profile.broken-*').Count -eq 0)

  # The real restore.
  $restore = Invoke-Restore -Arguments @('-ProfileDir', $profileDir, '-StateDir', $stateDir) -Label 'the real restore'
  Assert-True (T 'drill.assertRestoreExit' 'the restore exits with 0') ($restore.Code -eq 0) ('exit code ' + $restore.Code)

  # -------------------------------------------------------------------------
  # 4. The assertions
  # -------------------------------------------------------------------------

  Say (T 'drill.assertions' 'the assertions:') 'Cyan'

  # 4.1 The Chinese wording really comes out of the JSON.
  $hasChinese = [regex]::IsMatch([string]$restore.Output, '[\u4e00-\u9fff]')
  Assert-True (T 'drill.assertChineseOutput' 'the output of the restore script contains Chinese (the wording is read from the JSON)') $hasChinese

  # 4.2 package.json parses.
  $restoredPackage = $null
  $parseError = ''
  try {
    $restoredPackage = ([System.IO.File]::ReadAllText((Join-Path $profileDir 'package.json'))) | ConvertFrom-Json
  } catch {
    $parseError = $_.Exception.Message
  }
  Assert-True (T 'drill.assertParses' 'package.json parses after the restore') ($null -ne $restoredPackage) $parseError

  # 4.3 The snapshot with the manifest was used, not the newer decoy.
  $restoredName = ''
  if ($null -ne $restoredPackage) { $restoredName = [string] $restoredPackage.name }
  Assert-True (T 'drill.assertUsedSnapshot' 'the snapshot with the manifest was used (the newer decoy was skipped)') ($restoredName -eq 'drill-profile') ('the name that came back is "' + $restoredName + '"')

  # 4.4 The bundles have content.
  $bundles = @()
  if ($null -ne $restoredPackage -and $null -ne $restoredPackage.dsh -and $null -ne $restoredPackage.dsh.profile -and $null -ne $restoredPackage.dsh.profile.bundles) {
    $bundles = @($restoredPackage.dsh.profile.bundles)
  }
  Assert-True (T 'drill.assertBundles' 'dsh.profile.bundles has content after the restore') ($bundles.Count -gt 0) ('bundles: ' + $bundles.Count)

  # 4.5 The plugin version can be read.
  $pluginVersion = ''
  $pluginPkgPath = Join-Path $pluginDir 'package.json'
  if (Test-Path -LiteralPath $pluginPkgPath -PathType Leaf) {
    try {
      $pluginPkg = ([System.IO.File]::ReadAllText($pluginPkgPath)) | ConvertFrom-Json
      if ($null -ne $pluginPkg -and $null -ne $pluginPkg.version) { $pluginVersion = ([string] $pluginPkg.version).Trim() }
    } catch {
      $pluginVersion = ''
    }
  }
  Assert-True (T 'drill.assertVersionReadable' 'the plugin version can be read after the restore') ($pluginVersion -ne '') ('version "' + $pluginVersion + '"')
  Assert-True (T 'drill.assertVersionSame' 'the plugin version is the one of the snapshot') ($pluginVersion -eq '0.7.0') ('version "' + $pluginVersion + '"')

  # 4.6 The broken evidence directory exists and still holds the broken one.
  $brokenDirs = @(Get-ChildItem -LiteralPath $tempRoot -Directory -Filter 'profile.broken-*' -ErrorAction SilentlyContinue)
  Assert-True (T 'drill.assertBrokenExists' 'the broken evidence directory exists') ($brokenDirs.Count -ge 1) ('found ' + $brokenDirs.Count)
  if ($brokenDirs.Count -ge 1) {
    $brokenPackagePath = Join-Path $brokenDirs[0].FullName 'package.json'
    $brokenKeeps = (Test-Path -LiteralPath $brokenPackagePath -PathType Leaf) -and ((Read-TextOrEmpty $brokenPackagePath) -like '*oops*')
    Assert-True (T 'drill.assertBrokenKeeps' 'the broken directory still holds the broken one') $brokenKeeps
  }

  # 4.7 A directory that does not look like a profile has to be refused, with
  #     a reason.
  $notAProfile = Join-Path $tempRoot 'not-a-profile'
  New-Item -ItemType Directory -Path $notAProfile -Force | Out-Null
  $refused = Invoke-Restore -Arguments @('-ProfileDir', $notAProfile, '-StateDir', $stateDir) -Label 'a directory that is not a profile'
  Assert-Refused (T 'drill.assertNotProfileRefused' 'a directory that is not a profile is refused (exit code + reason)') $refused (TA 'drill.keywords.notProfile' @('does not look like a DSH profile'))
  Assert-True (T 'drill.assertNotProfileUntouched' 'the refused directory was not touched') (@(Get-ChildItem -LiteralPath $tempRoot -Directory -Filter 'not-a-profile.broken-*').Count -eq 0)

  # 4.8 A drive root has to be refused, with a reason.
  $rootRefused = Invoke-Restore -Arguments @('-ProfileDir', 'C:\', '-StateDir', $stateDir) -Label 'a drive root'
  Assert-Refused (T 'drill.assertDriveRootRefused' 'a drive root is refused (exit code + reason)') $rootRefused (TA 'drill.keywords.driveRoot' @('drive root'))

  # 4.9 The system directories have to be refused, with a reason (Windows /
  #     Program Files / ProgramData). The script refuses them before it
  #     touches them - this only proves that it refuses them the right way.
  foreach ($systemDir in @('C:\Windows', 'C:\Program Files', 'C:\ProgramData')) {
    $systemRefused = Invoke-Restore -Arguments @('-ProfileDir', $systemDir, '-StateDir', $stateDir) -Label ('the system directory ' + $systemDir)
    Assert-Refused ((T 'drill.assertSystemDirRefused' 'the system directory {0} is refused (exit code + reason)') -f $systemDir) $systemRefused (TA 'drill.keywords.systemDir' @('system directory'))
    Assert-True ((T 'drill.assertSystemDirIntact' 'the system directory {0} is untouched (it was not moved away)') -f $systemDir) (Test-Path -LiteralPath $systemDir -PathType Container)
  }

  # 4.10 A target profile that does not exist has to be refused, with a
  #      reason, and it must NOT be created.
  $missingProfile = Join-Path $tempRoot 'not-there-yet'
  $missingRefused = Invoke-Restore -Arguments @('-ProfileDir', $missingProfile, '-StateDir', $stateDir) -Label 'a target that does not exist'
  Assert-Refused (T 'drill.assertMissingDirRefused' 'a target profile that does not exist is refused (exit code + reason)') $missingRefused (TA 'drill.keywords.missingDir' @('does not exist'))
  Assert-True (T 'drill.assertMissingDirNotCreated' 'the target was not created') (-not (Test-Path -LiteralPath $missingProfile))

  # 4.11 "the configuration says it is installed but it is not" has to fail:
  #      the profile lists the plugin, node_modules does not have it.
  $lyingProfile = Join-Path $tempRoot 'lying-profile'
  $lyingState = Join-Path $tempRoot 'state-lying'
  $lyingBackups = Join-Path $lyingState 'backups'
  $lyingStamp = '2026-10-29T03-00-00-000Z'
  $lyingSnapshot = Join-Path $lyingBackups $lyingStamp
  New-Item -ItemType Directory -Path $lyingProfile -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $lyingSnapshot 'config') -Force | Out-Null
  Write-TextFile (Join-Path $lyingProfile 'package.json') "{`n  `"name`": `"lying-profile`",`n  `"dsh`": { `"profile`": { `"bundles`": [`"dsh-autorestart`"] } }`n}"
  Copy-Item -LiteralPath (Join-Path $lyingProfile 'package.json') -Destination (Join-Path $lyingSnapshot 'config\package.json') -Force
  $lyingManifest = [ordered]@{
    stamp    = $lyingStamp
    at       = [int64] 1792000001000
    atLocal  = '2026-10-29T09:00:01+08:00'
    profileDir = $lyingProfile
    includePlugins = $false
    files    = @('config\package.json')
    bytes    = 64
  }
  Write-TextFile (Join-Path $lyingSnapshot 'manifest.json') ($lyingManifest | ConvertTo-Json -Depth 5)
  $lying = Invoke-Restore -Arguments @('-ProfileDir', $lyingProfile, '-StateDir', $lyingState) -Label 'the configuration says it is installed'
  Assert-Refused (T 'drill.assertLyingRefused' 'a profile that lists the plugin without having it must fail (exit code + reason)') $lying (TA 'drill.keywords.notValidated' @('did not pass the check'))
  Assert-True (T 'drill.assertLyingBrokenHint' 'the failed restore says where the broken one is') ($lying.Output -like '*broken*')

  # 4.12 The encoding rules of the delivered files: the .ps1 is pure ASCII,
  #       the .cmd is pure ASCII.
  $ps1Bytes = [System.IO.File]::ReadAllBytes($restoreScript)
  $ps1IsAscii = $true
  foreach ($byte in $ps1Bytes) {
    if ($byte -gt 127) { $ps1IsAscii = $false; break }
  }
  Assert-True (T 'drill.assertPs1Ascii' 'restore-profile.ps1 is pure ASCII (maxByte <= 127)') $ps1IsAscii
  $cmdBytes = [System.IO.File]::ReadAllBytes($cmdScript)
  $cmdIsAscii = $true
  foreach ($byte in $cmdBytes) {
    if ($byte -gt 127) { $cmdIsAscii = $false; break }
  }
  Assert-True (T 'drill.assertCmdAscii' 'restore-profile.cmd is pure ASCII') $cmdIsAscii

  # 4.13 Everything happened inside the temporary directory (so the real
  #       profile of the user never has to be read).
  $insideTemp = $true
  if ($brokenDirs.Count -ge 1) {
    $insideTemp = $brokenDirs[0].FullName.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)
  }
  Assert-True (T 'drill.assertOnlyTemp' 'the drill only worked inside the temporary directory') $insideTemp

  # 4.14 The directory of this drill holds a lock file (the evidence of the
  #       re-entry guard).
  Assert-True (T 'drill.assertLockFile' 'the drill directory holds a lock file') (Test-Path -LiteralPath $lockFile -PathType Leaf)
} catch {
  Write-Host ((T 'drill.error' 'the drill hit an error: {0}') -f $_.Exception.Message) -ForegroundColor Red
  $script:Failures += 1
} finally {
  # -------------------------------------------------------------------------
  # The cleanup: ONLY its own absolute path, never a wildcard scan of %TEMP%.
  # -------------------------------------------------------------------------
  if ($script:OwnsTempRoot -and $script:TempRoot -ne '') {
    Say ((T 'drill.cleanup' 'cleaning up the temporary directory: {0}') -f $script:TempRoot) 'DarkGray'
    try {
      Remove-Item -LiteralPath $script:TempRoot -Recurse -Force -ErrorAction Stop
    } catch {
      # A failed cleanup does not fail the drill, but it is reported.
    }
    if (Test-Path -LiteralPath $script:TempRoot) {
      Write-Host ((T 'drill.notCleaned' 'the temporary directory was not cleaned up, please delete it yourself: {0}') -f $script:TempRoot) -ForegroundColor Yellow
      $script:Failures += 1
    } else {
      Say (T 'drill.cleaned' 'the temporary directory is clean.') 'Green'
    }
  }
}

# ---------------------------------------------------------------------------
# The result
# ---------------------------------------------------------------------------

if ($script:StringsError -ne '') {
  Write-Host ('WARNING: ' + $script:StringsError) -ForegroundColor Yellow
}

if ($script:Failures -gt 0) {
  Write-Host ((T 'drill.failed' 'the drill failed: {0} assertions did not hold.') -f $script:Failures) -ForegroundColor Red
  exit 1
}
Say (T 'drill.passed' 'the drill passed: break it on purpose, restore it, check it, clean up - the whole round trip works.') 'Green'
exit 0
