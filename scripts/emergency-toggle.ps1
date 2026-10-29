<#
.SYNOPSIS
  dsh-autorestart 的急救开关：DSH 起不来的时候，不用 DSH 也能把本插件摘掉（或装回去）。

.DESCRIPTION
  “刚打开插件，DSH 就起不来了” 是插件最难受的时刻：修它需要它自己。
  这个脚本只动一个文件 —— 桌面版 profile 的 package.json —— 而且只动一个数组：
  `dsh.profile.bundles`。

    - disable：从 bundles 里拿掉 "dsh-autorestart"（本来就不在 → 报告“已经禁用”，不算失败）；
    - enable ：把 "dsh-autorestart" 加回 bundles（已经在 → 报告“已经启用”）；
    - status ：只读，打印现在在不在 bundles 里。

  两条硬规矩：

    1. 写之前先备份成 `package.json.bak-emergency-<yyyyMMdd-HHmmss>`；
    2. 写完之后重新解析一遍 JSON 校验；校验不过就用备份回滚，并且如实报错。

  文件的缩进、行尾和末尾换行都原样保留（改的是文本，不是重新序列化整个 JSON）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\emergency-toggle.ps1 -Action status

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\emergency-toggle.ps1 -Action disable

.NOTES
  Windows PowerShell 5.1 就能跑（没有用 6.0+ 的语法），双击的 .cmd 入口也是它。
#>
[CmdletBinding()]
param(
  # 要做什么。
  [ValidateSet('disable', 'enable', 'status')]
  [string] $Action = 'status',

  # 只打印“将会怎么写”，不落盘。
  [switch] $DryRun,

  # 要操作的 package.json（测试和别的 profile 用）。
  [string] $PackageJson = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop\package.json')
)

$ErrorActionPreference = 'Stop'

# 本插件在 bundles 里的名字。
$PackageName = 'dsh-autorestart'

# 装回去时插在它后面（位置其实无所谓，但有个锚点更稳）。
$AnchorName = 'dsh-github-guard'

function Say {
  param([string] $Text, [string] $Color = 'Gray')
  Write-Host $Text -ForegroundColor $Color
}

function Fail {
  param([string] $Text)
  Write-Host ('急救开关失败：' + $Text) -ForegroundColor Red
  exit 1
}

# ---------------------------------------------------------------------------
# 文本工具：只在 bundles 数组那一段里动刀，其余字节一个不碰。
# ---------------------------------------------------------------------------

# bundles 数组的方括号位置。
function Get-ArrayRange {
  param([string] $Text)
  $marker = '"bundles"'
  $markerIndex = $Text.IndexOf($marker)
  if ($markerIndex -lt 0) { throw 'package.json 里没有 bundles 这一项' }
  $open = $Text.IndexOf('[', $markerIndex)
  if ($open -lt 0) { throw 'bundles 不是数组' }
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
  throw 'bundles 数组没有闭合'
}

# 数组里的每一项：名字、缩进、有没有逗号、它在文本里的位置。
function Get-Items {
  param([string] $Text, [int] $Open, [int] $Close)
  $body = $Text.Substring($Open + 1, $Close - $Open - 1)
  $items = @()
  $pattern = '(?m)^(?<indent>[ \t]*)"(?<name>[^"]*)"(?<comma>,?)[ \t]*\r?$'
  foreach ($match in [regex]::Matches($body, $pattern)) {
    $lineStart = $Open + 1 + $match.Index
    $lineEnd = $lineStart + $match.Length
    # 这一行末尾的行尾符（\r\n 或 \n）算在行里。
    if ($lineEnd -lt $Text.Length -and $Text[$lineEnd] -eq "`n") { $lineEnd++ }
    $nameGroup = $match.Groups['name']
    $commaGroup = $match.Groups['comma']
    $items += [pscustomobject]@{
      Name       = $nameGroup.Value
      Indent     = $match.Groups['indent'].Value
      HasComma   = ($commaGroup.Value -eq ',')
      CommaIndex = $commaGroup.Index
      # 名字后面那个右引号之后的位置（插逗号用）。
      ContentEnd = $nameGroup.Index + $nameGroup.Length + 1
      LineStart  = $lineStart
      LineEnd    = $lineEnd
    }
  }
  return $items
}

# 某一行的缩进（用来插出同样式子的新行）。
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

# 文件用的行尾符。
function Get-LineEnding {
  param([string] $Text)
  if ($Text.Contains("`r`n")) { return "`r`n" }
  return "`n"
}

# ---------------------------------------------------------------------------
# 开始。
# ---------------------------------------------------------------------------

if (-not (Test-Path -LiteralPath $PackageJson -PathType Leaf)) {
  Fail ('找不到 profile 的 package.json：' + $PackageJson)
}

$path = (Resolve-Path -LiteralPath $PackageJson).Path
$bytes = [System.IO.File]::ReadAllBytes($path)
$hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
$raw = [System.IO.File]::ReadAllText($path)

try {
  $document = $raw | ConvertFrom-Json
} catch {
  Fail ('这个 package.json 不是合法的 JSON：' + $_.Exception.Message)
}

$bundles = @()
$hasBundles = $false
if ($null -ne $document -and $null -ne $document.dsh -and $null -ne $document.dsh.profile -and $null -ne $document.dsh.profile.bundles) {
  $bundles = @($document.dsh.profile.bundles)
  $hasBundles = $true
}

$present = ($bundles -contains $PackageName)

Say ('文件：' + $path)

if ($Action -eq 'status') {
  if ($present) { Say ('已启用：' + $PackageName + ' 在 bundles 里。') 'Green' }
  else { Say ('已禁用：' + $PackageName + ' 不在 bundles 里。') 'Yellow' }
  exit 0
}

if ($Action -eq 'enable' -and -not $hasBundles) {
  Fail '这个 profile 里没有 dsh.profile.bundles 列表，装不回去（请手动加一行 "dsh-autorestart"）。'
}

# ---------------------------------------------------------------------------
# 算出新的文本。
# ---------------------------------------------------------------------------

$new = $raw
$range = Get-ArrayRange $raw
$items = Get-Items $raw $range[0] $range[1]
$eol = Get-LineEnding $raw

if ($Action -eq 'disable') {
  if (-not $present) {
    Say ('已经禁用：bundles 里本来就没有 ' + $PackageName + '（没有改动任何文件）。') 'Yellow'
    exit 0
  }
  $target = $items | Where-Object { $_.Name -eq $PackageName } | Select-Object -First 1
  if ($null -eq $target) { Fail ('在 bundles 里找不到 ' + $PackageName) }
  $shift = 0
  if (-not $target.HasComma) {
    # 它是数组里的最后一项：前一项的逗号要去掉，否则 JSON 非法。
    $previous = $items | Where-Object { $_.LineEnd -le $target.LineStart } | Select-Object -Last 1
    if ($null -ne $previous -and $previous.HasComma) {
      $new = $new.Remove($previous.CommaIndex, 1)
      $shift = -1
    }
  }
  $new = $new.Remove($target.LineStart + $shift, $target.LineEnd - $target.LineStart)
  $summary = ('把 ' + $PackageName + ' 从 bundles 里拿掉')
} else {
  # enable
  if ($present) {
    Say ('已经启用：' + $PackageName + ' 本来就在 bundles 里（没有改动任何文件）。') 'Yellow'
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
      # 锚点是最后一项：先给它补上逗号，再插新的一项（新的这项不带逗号）。
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
      # 数组是空的。
      $insertAt = $range[1]
      $line = (Get-LineIndent $raw $range[1]) + '  "' + $PackageName + '"'
    }
  }
  $new = $new.Insert($insertAt, $line + $eol)
  $summary = ('把 ' + $PackageName + ' 加回 bundles')
}

if ($DryRun) {
  Say ('[试运行] 将会' + $summary + '。') 'Cyan'
  Say ('[试运行] 将会写入：' + $path) 'Cyan'
  Say ('[试运行] 将会先备份成：' + $path + '.bak-emergency-<时间戳>') 'Cyan'
  Say ('[试运行] 没有改动任何文件。') 'Cyan'
  exit 0
}

# ---------------------------------------------------------------------------
# 写：先备份，再写，然后重新解析校验；校验不过就回滚。
# ---------------------------------------------------------------------------

$backup = $path + '.bak-emergency-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
try {
  Copy-Item -LiteralPath $path -Destination $backup -Force
} catch {
  Fail ('备份失败（没有动原文件）：' + $_.Exception.Message)
}

try {
  $encoding = New-Object System.Text.UTF8Encoding($hasBom)
  [System.IO.File]::WriteAllText($path, $new, $encoding)
} catch {
  Fail ('写入失败（备份在 ' + $backup + '）：' + $_.Exception.Message)
}

try {
  $written = [System.IO.File]::ReadAllText($path)
  $parsed = $written | ConvertFrom-Json
  $names = @()
  if ($null -ne $parsed -and $null -ne $parsed.dsh -and $null -ne $parsed.dsh.profile -and $null -ne $parsed.dsh.profile.bundles) {
    $names = @($parsed.dsh.profile.bundles)
  }
  if ($Action -eq 'enable' -and -not ($names -contains $PackageName)) {
    throw '写完之后 bundles 里仍然没有 ' + $PackageName
  }
  if ($Action -eq 'disable' -and ($names -contains $PackageName)) {
    throw '写完之后 bundles 里仍然有 ' + $PackageName
  }
} catch {
  # 校验不过：用备份把原文件放回去，然后如实报错。
  try {
    Copy-Item -LiteralPath $backup -Destination $path -Force
    Say ('已经用备份回滚：' + $backup) 'Yellow'
  } catch {
    Fail ('校验失败，而且回滚也失败了（备份在 ' + $backup + '）：' + $_.Exception.Message)
  }
  Fail ('校验失败（已回滚）：' + $_.Exception.Message)
}

Say ('已经' + $summary + '。') 'Green'
Say ('备份：' + $backup) 'Gray'
Say ('请重启 DSH 才会生效。') 'Gray'
exit 0
