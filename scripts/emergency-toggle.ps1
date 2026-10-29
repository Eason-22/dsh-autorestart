<#
.SYNOPSIS
  The dsh-autorestart emergency switch: take this plugin out (or put it back)
  when DSH does not come up.

.DESCRIPTION
  "I enabled the plugin and DSH does not start any more" is the hardest moment
  for a plugin: fixing it needs the plugin itself. This script touches ONE
  file - the package.json of the desktop profile - and ONE array in it:
  `dsh.profile.bundles`.

    - disable: take "dsh-autorestart" out of the bundles (it was not there
      anyway -> report "already disabled", that is not a failure);
    - enable : put "dsh-autorestart" back into the bundles (it was already
      there -> report "already enabled");
    - status : read only, prints whether it is in the bundles right now.

  Two hard rules:

    1. the file is backed up as `package.json.bak-emergency-<yyyyMMdd-HHmmss>`
       before anything is written;
    2. after writing, the JSON is parsed again and checked; if the check
       fails, the backup is put back and the failure is reported honestly.

  The indentation, the line endings and the trailing newline of the file are
  kept as they are (the text is edited, the JSON is not re-serialized).

  LANGUAGE: this file is pure ASCII on purpose. Windows PowerShell 5.1 reads a
  UTF-8 file without a byte order mark as ANSI, so one Chinese character
  inside the script turns into mojibake and the script dies with a ParserError
  before it does anything. The Chinese wording lives in
  scripts\rescue-strings.zh.json (UTF-8, no BOM) and is read at runtime; if
  that file is missing or broken, every message falls back to English and the
  script says so.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\emergency-toggle.ps1 -Action status

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\emergency-toggle.ps1 -Action disable

.NOTES
  Windows PowerShell 5.1 is enough (nothing from 6.0+ is used); the .cmd entry
  point double-clicked by the user is that one too.
#>
[CmdletBinding()]
param(
  # What to do.
  [ValidateSet('disable', 'enable', 'status')]
  [string] $Action = 'status',

  # Only print what would be written, change nothing.
  [switch] $DryRun,

  # The package.json to work on (for tests and for other profiles).
  [string] $PackageJson = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop\package.json')
)

$ErrorActionPreference = 'Stop'

# The name of this plugin inside the bundles.
$PackageName = 'dsh-autorestart'

# The anchor it is put back after (the position does not matter, but an anchor
# is steadier than the end of the array).
$AnchorName = 'dsh-github-guard'

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

# Look a string up. The English fallback is right here in the script, so a
# missing key (or a broken strings file) never stops the rescue.
function T {
  param([string] $Key, [string] $Fallback)
  if ($null -ne $script:Strings) {
    $node = $script:Strings
    foreach ($part in $Key.Split('.')) {
      if ($null -eq $node) { break }
      $property = $node.PSObject.Properties[$part]
      if ($null -eq $property) { $node = $null; break }
      $node = $property.Value
    }
    if ($null -ne $node) {
      $text = [string] $node
      if ($text -ne '') { return $text }
    }
  }
  return $Fallback
}

Initialize-Strings

function Say {
  param([string] $Text, [string] $Color = 'Gray')
  Write-Host $Text -ForegroundColor $Color
}

function Fail {
  param([string] $Text)
  Write-Host ((T 'emergency.failed' 'the emergency switch failed: {0}') -f $Text) -ForegroundColor Red
  exit 1
}

# ---------------------------------------------------------------------------
# Text helpers: only the bundles array is touched, every other byte stays.
# ---------------------------------------------------------------------------

# The square brackets of the bundles array.
function Get-ArrayRange {
  param([string] $Text)
  $marker = '"bundles"'
  $markerIndex = $Text.IndexOf($marker)
  if ($markerIndex -lt 0) { throw 'package.json has no bundles entry' }
  $open = $Text.IndexOf('[', $markerIndex)
  if ($open -lt 0) { throw 'bundles is not an array' }
  $depth = 0
  $inString = $false
  $escaped = $false
  for ($i = $open; $i -lt $Text.Length; $i++) {
    $c = $Text[$i]
    if ($inString) {
      if ($escaped) { $escaped = $false; continue }
      if ($c -eq '\') { $escaped = $true; continue }
      if ($c -eq '"') { $inString = $false }
      continue
    }
    if ($c -eq '"') { $inString = $true; continue }
    if ($c -eq '[') { $depth++; continue }
    if ($c -eq ']') {
      $depth--
      if ($depth -eq 0) { return @($open, $i) }
    }
  }
  throw 'the bundles array is not closed'
}

# Every item of the array: the name, the indentation, the comma, the position
# in the text.
function Get-Items {
  param([string] $Text, [int] $Open, [int] $Close)
  $body = $Text.Substring($Open + 1, $Close - $Open - 1)
  $items = @()
  $pattern = '(?m)^(?<indent>[ \t]*)"(?<name>[^"]*)"(?<comma>,?)[ \t]*\r?$'
  foreach ($match in [regex]::Matches($body, $pattern)) {
    $lineStart = $Open + 1 + $match.Index
    $lineEnd = $lineStart + $match.Length
    # The line ending of that line (\r\n or \n) belongs to the line.
    if ($lineEnd -lt $Text.Length -and $Text[$lineEnd] -eq "`n") { $lineEnd++ }
    $nameGroup = $match.Groups['name']
    $commaGroup = $match.Groups['comma']
    $items += [pscustomobject]@{
      Name       = $nameGroup.Value
      Indent     = $match.Groups['indent'].Value
      HasComma   = ($commaGroup.Value -eq ',')
      CommaIndex = $commaGroup.Index
      # The position right after the closing quote of the name (where the
      # comma goes).
      ContentEnd = $nameGroup.Index + $nameGroup.Length + 1
      LineStart  = $lineStart
      LineEnd    = $lineEnd
    }
  }
  return $items
}

# The indentation of a line (so a new line can look the same).
function Get-LineIndent {
  param([string] $Text, [int] $Index)
  $start = $Text.LastIndexOf("`n", [Math]::Max(0, $Index - 1))
  if ($start -lt 0) { $start = 0 } else { $start++ }
  $indent = ''
  for ($i = $start; $i -lt $Text.Length; $i++) {
    $c = $Text[$i]
    if ($c -eq ' ' -or $c -eq "`t") { $indent += $c; continue }
    break
  }
  return $indent
}

# The line ending the file uses.
function Get-LineEnding {
  param([string] $Text)
  if ($Text.Contains("`r`n")) { return "`r`n" }
  return "`n"
}

# ---------------------------------------------------------------------------
# Start.
# ---------------------------------------------------------------------------

if ($script:StringsError -ne '') {
  Write-Host ('WARNING: ' + $script:StringsError) -ForegroundColor Yellow
}

if (-not (Test-Path -LiteralPath $PackageJson -PathType Leaf)) {
  Fail ((T 'emergency.notFound' 'the package.json of the profile cannot be found: {0}') -f $PackageJson)
}

$path = (Resolve-Path -LiteralPath $PackageJson).Path
$bytes = [System.IO.File]::ReadAllBytes($path)
$hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
$raw = [System.IO.File]::ReadAllText($path)

try {
  $document = $raw | ConvertFrom-Json
} catch {
  Fail ((T 'emergency.badJson' 'this package.json is not valid JSON: {0}') -f $_.Exception.Message)
}

$bundles = @()
$hasBundles = $false
if ($null -ne $document -and $null -ne $document.dsh -and $null -ne $document.dsh.profile -and $null -ne $document.dsh.profile.bundles) {
  $bundles = @($document.dsh.profile.bundles)
  $hasBundles = $true
}

$present = ($bundles -contains $PackageName)

Say ((T 'emergency.file' 'file: {0}') -f $path)

if ($Action -eq 'status') {
  if ($present) { Say ((T 'emergency.enabled' 'enabled: {0} is in the bundles.') -f $PackageName) 'Green' }
  else { Say ((T 'emergency.disabled' 'disabled: {0} is not in the bundles.') -f $PackageName) 'Yellow' }
  exit 0
}

if ($Action -eq 'enable' -and -not $hasBundles) {
  Fail (T 'emergency.noBundles' 'this profile has no dsh.profile.bundles list, so the plugin cannot be put back (please add a line "dsh-autorestart" by hand).')
}

# ---------------------------------------------------------------------------
# Work out the new text.
# ---------------------------------------------------------------------------

$new = $raw
$range = Get-ArrayRange $raw
$items = Get-Items $raw $range[0] $range[1]
$eol = Get-LineEnding $raw

if ($Action -eq 'disable') {
  if (-not $present) {
    Say ((T 'emergency.alreadyDisabled' 'already disabled: {0} was not in the bundles anyway (no file was changed).') -f $PackageName) 'Yellow'
    exit 0
  }
  $target = $items | Where-Object { $_.Name -eq $PackageName } | Select-Object -First 1
  if ($null -eq $target) { Fail ((T 'emergency.notInBundles' '{0} cannot be found in the bundles') -f $PackageName) }
  $shift = 0
  if (-not $target.HasComma) {
    # It is the last item of the array: the comma of the item before it has to
    # go, otherwise the JSON is invalid.
    $previous = $items | Where-Object { $_.LineEnd -le $target.LineStart } | Select-Object -Last 1
    if ($null -ne $previous -and $previous.HasComma) {
      $new = $new.Remove($previous.CommaIndex, 1)
      $shift = -1
    }
  }
  $new = $new.Remove($target.LineStart + $shift, $target.LineEnd - $target.LineStart)
  $summary = (T 'emergency.summaryRemove' 'take {0} out of the bundles') -f $PackageName
} else {
  # enable
  if ($present) {
    Say ((T 'emergency.alreadyEnabled' 'already enabled: {0} was in the bundles anyway (no file was changed).') -f $PackageName) 'Yellow'
    exit 0
  }
  $anchor = $items | Where-Object { $_.Name -eq $AnchorName } | Select-Object -First 1
  $line = ''
  $insertAt = 0
  if ($null -ne $anchor) {
    if ($anchor.HasComma) {
      $insertAt = $anchor.LineEnd
      $line = $anchor.Indent + '"' + $PackageName + '",'
    } else {
      # The anchor is the last item: give it a comma first, then insert the new
      # item (the new one has no comma).
      $new = $new.Insert($anchor.ContentEnd, ',')
      $insertAt = $anchor.LineEnd + 1
      $line = $anchor.Indent + '"' + $PackageName + '"'
    }
  } else {
    $last = $items | Select-Object -Last 1
    if ($null -ne $last) {
      if ($last.HasComma) {
        $insertAt = $last.LineEnd
      } else {
        $new = $new.Insert($last.ContentEnd, ',')
        $insertAt = $last.LineEnd + 1
      }
      $line = $last.Indent + '"' + $PackageName + '"'
    } else {
      # The array is empty.
      $insertAt = $range[1]
      $line = (Get-LineIndent $raw $range[1]) + '  "' + $PackageName + '"'
    }
  }
  $new = $new.Insert($insertAt, $line + $eol)
  $summary = (T 'emergency.summaryAdd' 'put {0} back into the bundles') -f $PackageName
}

if ($DryRun) {
  Say ((T 'emergency.dryRunWill' '[dry run] would {0}.') -f $summary) 'Cyan'
  Say ((T 'emergency.dryRunWrite' '[dry run] would write: {0}') -f $path) 'Cyan'
  Say ((T 'emergency.dryRunBackup' '[dry run] would back it up as: {0}.bak-emergency-<timestamp>') -f $path) 'Cyan'
  Say (T 'emergency.dryRunNoChange' '[dry run] no file was changed.') 'Cyan'
  exit 0
}

# ---------------------------------------------------------------------------
# Write: back up first, write, then parse and check again; on a failure, roll
# back.
# ---------------------------------------------------------------------------

$backup = $path + '.bak-emergency-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
try {
  Copy-Item -LiteralPath $path -Destination $backup -Force
} catch {
  Fail ((T 'emergency.backupFailed' 'the backup failed (the original file was not touched): {0}') -f $_.Exception.Message)
}

try {
  $encoding = New-Object System.Text.UTF8Encoding($hasBom)
  [System.IO.File]::WriteAllText($path, $new, $encoding)
} catch {
  Fail ((T 'emergency.writeFailed' 'the write failed (the backup is at {0}): {1}') -f $backup, $_.Exception.Message)
}

try {
  $written = [System.IO.File]::ReadAllText($path)
  $parsed = $written | ConvertFrom-Json
  $names = @()
  if ($null -ne $parsed -and $null -ne $parsed.dsh -and $null -ne $parsed.dsh.profile -and $null -ne $parsed.dsh.profile.bundles) {
    $names = @($parsed.dsh.profile.bundles)
  }
  if ($Action -eq 'enable' -and -not ($names -contains $PackageName)) {
    throw ('after writing, the bundles still do not hold ' + $PackageName)
  }
  if ($Action -eq 'disable' -and ($names -contains $PackageName)) {
    throw ('after writing, the bundles still hold ' + $PackageName)
  }
} catch {
  # The check failed: put the original file back, then report honestly.
  try {
    Copy-Item -LiteralPath $backup -Destination $path -Force
    Say ((T 'emergency.rolledBack' 'the backup was put back: {0}') -f $backup) 'Yellow'
  } catch {
    Fail ((T 'emergency.verifyFailedNoRollback' 'the check failed and the rollback failed too (the backup is at {0}): {1}') -f $backup, $_.Exception.Message)
  }
  Fail ((T 'emergency.verifyFailedRolledBack' 'the check failed (it was rolled back): {0}') -f $_.Exception.Message)
}

Say ((T 'emergency.done' 'done: {0}.') -f $summary) 'Green'
Say ((T 'emergency.backup' 'backup: {0}') -f $backup) 'Gray'
Say (T 'emergency.restartHint' 'restart DSH for it to take effect.') 'Gray'
exit 0
