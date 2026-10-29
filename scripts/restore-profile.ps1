<#
.SYNOPSIS
  dsh-autorestart 的 profile 快照还原器（自救包的一半）。

.DESCRIPTION
  DSH 起不来了（插件升级把 profile 弄坏、配置写坏了、node_modules 装崩了），
  这个脚本把 profile 放回最近一次快照的状态 —— 不依赖 DSH 自己，也不依赖 node。

  它做四件事，按这个顺序：

    1. 找到要还原的快照（默认：`<stateDir>\backups\` 里最新的一份、带 manifest 的）；
    2. **先把现在的 profile 整份挪到 `<profileDir>.broken-<yyyyMMdd-HHmmss>`**
       —— 不覆盖、不删除，出事也还有证据；
    3. 把快照里的配置文件和插件树复制回 profile；
    4. **回读校验**：package.json 能解析、dsh.profile.bundles 有内容、
       dsh-autorestart 的版本号读得到；任何一项不过就如实报错，
       并且明确告诉你原来那份还在哪个目录里。

  两条硬规矩：

    1. **只动 DSH profile 目录**：默认只认 `<用户主目录>\.dsh\profiles\*`；
       用 `-ProfileDir` 显式指定别的目录时，也一样拒绝盘符根目录、系统目录、
       别人的用户目录。目标目录不像 DSH profile（有 package.json 但没有
       dsh.profile 字段、或者干脆什么都没有）就**拒绝动手**。
    2. **不自动重启 DSH**：脚本只管把文件放回去，重启由用户自己来 ——
       一个"救不回来还顺手再弄挂一次"的脚本没有意义。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\restore-profile.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\restore-profile.ps1 -DryRun

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\restore-profile.ps1 -ProfileDir C:\temp\drill\profile -StateDir C:\temp\drill\state

.NOTES
  Windows PowerShell 5.1 就能跑（没有用 6.0+ 的语法），双击的 .cmd 入口也是它。
  规则的同一份实现在 lib/rescue.js 里（node 可以直接 import 测试），
  scripts/drill-rescue.ps1 负责证明两边行为一致。
#>
[CmdletBinding()]
param(
  # 只打印"将会怎么做"，不落盘。
  [switch] $DryRun,

  # 指定用哪一份快照（默认：最新的、带 manifest 的那份）。
  [string] $Snapshot = '',

  # 要还原到哪个 profile 目录（不传就用桌面版默认那个）。
  [string] $ProfileDir = '',

  # 插件的状态目录（默认：`<DSH_HOME>\storages\dsh-autorestart`）。
  [string] $StateDir = ''
)

$ErrorActionPreference = 'Stop'

# 本插件在 profile 和插件树里的名字。
$PackageName = 'dsh-autorestart'

# 放走旧 profile 之后，它留下的证据目录（失败时要报给用户，所以是全局的）。
$script:BrokenDir = ''

# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------

function Say {
  param([string] $Text, [string] $Color = 'Gray')
  Write-Host $Text -ForegroundColor $Color
}

function Fail {
  param([string] $Text)
  Write-Host ('还原失败：' + $Text) -ForegroundColor Red
  if ($script:BrokenDir -ne '') {
    Write-Host ('你原来的 profile 完整地留在这里：' + $script:BrokenDir) -ForegroundColor Yellow
    Write-Host '（这个目录没有被动过，里面还是你出事之前的样子。）' -ForegroundColor Yellow
  }
  exit 1
}

# ---------------------------------------------------------------------------
# 路径工具
# ---------------------------------------------------------------------------

# 绝对路径，去掉末尾的分隔符（"C:\" 保留）。
function Resolve-FullPath {
  param([string] $Path)
  if ($null -eq $Path) { return '' }
  $trimmed = ([string]$Path).Trim()
  if ($trimmed -eq '') { return '' }
  try {
    $full = [System.IO.Path]::GetFullPath($trimmed)
  } catch {
    return ''
  }
  if ($full.Length -gt 3) { $full = $full.TrimEnd([char[]] @('\', '/')) }
  return $full
}

# 两个路径是不是同一个（Windows 上不区分大小写）。
function Test-SamePath {
  param([string] $A, [string] $B)
  return (Resolve-FullPath $A).ToLowerInvariant() -eq (Resolve-FullPath $B).ToLowerInvariant()
}

# $Child 在 $Parent 里面吗（不含 $Parent 自己）。
function Test-IsInside {
  param([string] $Child, [string] $Parent)
  $child = (Resolve-FullPath $Child).ToLowerInvariant()
  $parent = (Resolve-FullPath $Parent).ToLowerInvariant()
  if ($child -eq '' -or $parent -eq '') { return $false }
  if ($child -eq $parent) { return $false }
  if (-not $parent.EndsWith('\')) { $parent = $parent + '\' }
  return $child.StartsWith($parent)
}

# 系统目录清单：环境变量优先，系统盘兜底。
function Get-SystemDirectories {
  $list = New-Object System.Collections.Generic.List[string]
  $add = {
    param([string] $Value)
    if ($null -eq $Value) { return }
    $trimmed = ([string]$Value).Trim().TrimEnd([char[]] @('\', '/'))
    if ($trimmed -eq '') { return }
    if (-not $list.Contains($trimmed)) { $list.Add($trimmed) }
  }
  & $add $env:SystemRoot
  & $add $env:windir
  & $add $env:ProgramFiles
  & $add ${env:ProgramFiles(x86)}
  & $add $env:ProgramData
  $drive = 'C:'
  if (-not [string]::IsNullOrWhiteSpace($env:SystemDrive)) { $drive = $env:SystemDrive.Trim() }
  & $add ($drive + '\Windows')
  & $add ($drive + '\Program Files')
  & $add ($drive + '\Program Files (x86)')
  & $add ($drive + '\ProgramData')
  & $add ($drive + '\$Recycle.Bin')
  & $add ($drive + '\System Volume Information')
  return $list
}

# 这个路径为什么不能动？空字符串 = 可以动。
function Get-ForbiddenReason {
  param([string] $Target, [string] $HomeDir)
  $dir = Resolve-FullPath $Target
  if ($dir -eq '') { return '目标路径是空的' }
  if ($dir -match '^[A-Za-z]:[\\/]?$') { return '拒绝动盘符根目录' }
  $fsRoot = [System.IO.Path]::GetPathRoot($dir)
  if ($fsRoot -ne '' -and $dir.ToLowerInvariant() -eq $fsRoot.ToLowerInvariant()) { return '拒绝动文件系统根目录' }
  # 注意：不能叫 $home —— 那是 PowerShell 的只读自动变量。
  $homePath = Resolve-FullPath $HomeDir
  if ($homePath -ne '' -and (Test-SamePath $dir $homePath)) { return '拒绝动用户主目录本身' }
  foreach ($system in Get-SystemDirectories) {
    if ((Test-SamePath $dir $system) -or (Test-IsInside $dir $system)) {
      return ('拒绝动系统目录：' + $system)
    }
  }
  # 别人的用户目录：<Users>\<别人>。
  if ($homePath -ne '') {
    $usersRoot = Resolve-FullPath (Join-Path ([System.IO.Path]::GetPathRoot($homePath)) 'Users')
    if ($usersRoot -ne '' -and (Test-IsInside $dir $usersRoot)) {
      if ((Resolve-FullPath (Split-Path -Parent $dir)).ToLowerInvariant() -eq $usersRoot.ToLowerInvariant()) {
        return '拒绝动别人的用户目录'
      }
    }
  }
  return ''
}

# ---------------------------------------------------------------------------
# 目录：DSH home / profiles / state / backups
# ---------------------------------------------------------------------------

function Get-DshHome {
  if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
    return (Resolve-FullPath $env:DSH_HOME)
  }
  return (Resolve-FullPath (Join-Path $env:USERPROFILE '.dsh'))
}

function Get-ProfilesRoot {
  return (Resolve-FullPath (Join-Path (Get-DshHome) 'profiles'))
}

# 快照目录。
function Get-BackupsRoot {
  param([string] $State)
  if ($State -ne '') {
    return (Resolve-FullPath (Join-Path (Resolve-FullPath $State) 'backups'))
  }
  return (Resolve-FullPath (Join-Path (Join-Path (Get-DshHome) 'storages\dsh-autorestart') 'backups'))
}

# 不传 -ProfileDir 时，桌面版 profile 在哪儿。
function Get-DefaultProfileDir {
  # 1) 宿主自己导出的环境变量。
  if (-not [string]::IsNullOrWhiteSpace($env:DSH_PROFILE_DIR)) {
    $explicit = Resolve-FullPath $env:DSH_PROFILE_DIR
    if ($explicit -ne '' -and (Test-Path -LiteralPath $explicit -PathType Container)) { return $explicit }
  }
  # 2) 只有一个 profile 装了本插件 —— 那就是它。
  $root = Get-ProfilesRoot
  if (Test-Path -LiteralPath $root -PathType Container) {
    $matches = New-Object System.Collections.Generic.List[string]
    foreach ($entry in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
      $pkg = Join-Path $entry.FullName 'package.json'
      if (-not (Test-Path -LiteralPath $pkg -PathType Leaf)) { continue }
      try {
        $document = ([System.IO.File]::ReadAllText($pkg)) | ConvertFrom-Json
      } catch {
        continue
      }
      if ($null -eq $document -or $null -eq $document.dsh -or $null -eq $document.dsh.profile) { continue }
      $bundles = @()
      if ($null -ne $document.dsh.profile.bundles) { $bundles = @($document.dsh.profile.bundles) }
      if ($bundles -contains $PackageName) { $matches.Add($entry.FullName) }
    }
    if ($matches.Count -eq 1) { return $matches[0] }
  }
  # 3) 宿主指定的 profile 名。
  if (-not [string]::IsNullOrWhiteSpace($env:DSH_PROFILE)) {
    return (Resolve-FullPath (Join-Path $root $env:DSH_PROFILE.Trim()))
  }
  # 4) 桌面的默认名字。
  return (Resolve-FullPath (Join-Path $root 'desktop'))
}

# ---------------------------------------------------------------------------
# profile 指纹：这个目录还像不像 DSH profile
# ---------------------------------------------------------------------------

function Get-ProfileFingerprint {
  param([string] $Dir)
  $base = Resolve-FullPath $Dir
  $markers = New-Object System.Collections.Generic.List[string]
  $pkgPath = Join-Path $base 'package.json'
  $hasPackageJson = Test-Path -LiteralPath $pkgPath -PathType Leaf
  if ($hasPackageJson) { $markers.Add('package.json') }
  if (Test-Path -LiteralPath (Join-Path $base 'cordis.patch.yml') -PathType Leaf) { $markers.Add('cordis.patch.yml') }
  if (Test-Path -LiteralPath (Join-Path $base 'node_modules') -PathType Container) { $markers.Add('node_modules') }

  $kind = 'not-a-profile'
  $reason = '这里没有 package.json —— 不像 DSH profile'
  if ($hasPackageJson) {
    $parsed = $null
    try {
      $parsed = ([System.IO.File]::ReadAllText($pkgPath)) | ConvertFrom-Json
    } catch {
      $parsed = $null
    }
    if ($null -ne $parsed -and $null -ne $parsed.dsh -and $null -ne $parsed.dsh.profile) {
      $kind = 'profile'
      $reason = 'profile 的 package.json 里有 dsh.profile'
    } elseif ($markers.Count -ge 2) {
      $kind = 'broken-profile'
      $reason = 'profile 坏了（package.json 不再是 profile），但 profile 的文件还在'
    } else {
      $reason = 'package.json 里没有 dsh.profile，也没有别的东西能证明这是 profile'
    }
  } elseif ($markers.Count -gt 0) {
    $kind = 'broken-profile'
    $reason = 'profile 坏了（package.json 没了），但 profile 的文件还在'
  }
  return [pscustomobject]@{ Dir = $base; Kind = $kind; Reason = $reason; Markers = @($markers) }
}

# ---------------------------------------------------------------------------
# 快照：最新的、带 manifest 的那份
# ---------------------------------------------------------------------------

function Read-SnapshotManifest {
  param([string] $Dir)
  $manifestPath = Join-Path (Resolve-FullPath $Dir) 'manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $null }
  try {
    $text = [System.IO.File]::ReadAllText($manifestPath)
    if ($text.Length -gt 0 -and [int] $text[0] -eq 0xFEFF) { $text = $text.Substring(1) }
    $parsed = $text | ConvertFrom-Json
  } catch {
    return $null
  }
  if ($null -eq $parsed) { return $null }
  return $parsed
}

function Select-Snapshot {
  param([string] $BackupsDir)
  $root = Resolve-FullPath $BackupsDir
  $result = [pscustomobject]@{ Ok = $false; Dir = ''; Name = ''; Manifest = $null; Candidates = @(); Error = '' }
  if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    $result.Error = ('找不到快照目录：' + $root)
    return $result
  }
  $candidates = New-Object System.Collections.Generic.List[object]
  foreach ($entry in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
    $manifest = Read-SnapshotManifest $entry.FullName
    if ($null -eq $manifest) { continue }
    $at = $null
    if ($null -ne $manifest.at) {
      try { $at = [int64] $manifest.at } catch { $at = $null }
    }
    $candidates.Add([pscustomobject]@{ Name = $entry.Name; Dir = $entry.FullName; Manifest = $manifest; At = $at })
  }
  $result.Candidates = @($candidates | ForEach-Object { $_.Name })
  if ($candidates.Count -eq 0) {
    $result.Error = ('这个目录里没有一份带 manifest 的快照：' + $root)
    return $result
  }
  $sorted = @($candidates | Sort-Object -Property `
    @{ Expression = { if ($null -eq $_.At) { [int64] 0 } else { $_.At } }; Descending = $true }, `
    @{ Expression = { $_.Name }; Descending = $true })
  $best = $sorted[0]
  $result.Ok = $true
  $result.Dir = $best.Dir
  $result.Name = $best.Name
  $result.Manifest = $best.Manifest
  return $result
}

# 这份快照里装的是不是一个真的 DSH profile（要往 profile 目录里写，就必须是）。
function Test-SnapshotProfile {
  param([string] $SnapshotDir)
  $pkgPath = Join-Path (Join-Path (Resolve-FullPath $SnapshotDir) 'config') 'package.json'
  if (-not (Test-Path -LiteralPath $pkgPath -PathType Leaf)) {
    return [pscustomobject]@{ Ok = $false; Reason = '这份快照里没有 config\package.json' }
  }
  $parsed = $null
  try {
    $parsed = ([System.IO.File]::ReadAllText($pkgPath)) | ConvertFrom-Json
  } catch {
    return [pscustomobject]@{ Ok = $false; Reason = '这份快照的 package.json 不是合法的 JSON' }
  }
  if ($null -eq $parsed -or $null -eq $parsed.dsh -or $null -eq $parsed.dsh.profile) {
    return [pscustomobject]@{ Ok = $false; Reason = '这份快照的 package.json 里没有 dsh.profile' }
  }
  return [pscustomobject]@{ Ok = $true; Reason = '这份快照里装的是一个 DSH profile' }
}

# 快照自己说的时间（人话）。
function Get-SnapshotDisplay {
  param($Manifest)
  $display = '时间不明'
  $includePlugins = $false
  if ($null -ne $Manifest) {
    if ($null -ne $Manifest.atLocal -and ([string] $Manifest.atLocal).Trim() -ne '') {
      $display = (([string] $Manifest.atLocal).Trim() -replace 'T', ' ').Substring(0, 16)
    } elseif ($null -ne $Manifest.at) {
      try { $display = (Get-Date -Date ([DateTimeOffset]::FromUnixTimeMilliseconds([int64] $Manifest.at).LocalDateTime) -Format 'yyyy-MM-dd HH:mm') } catch { $display = '时间不明' }
    }
    $includePlugins = ($Manifest.includePlugins -eq $true)
  }
  return [pscustomobject]@{ Display = $display; IncludePlugins = $includePlugins }
}

# ---------------------------------------------------------------------------
# 开始
# ---------------------------------------------------------------------------

Say 'dsh-autorestart —— profile 快照还原器' 'Cyan'

$explicitProfile = ($ProfileDir -as [string]) -ne ''
if ($explicitProfile) {
  $targetProfile = Resolve-FullPath $ProfileDir
} else {
  $targetProfile = Get-DefaultProfileDir
}
if ($targetProfile -eq '') { Fail '找不到要还原的 profile 目录（用 -ProfileDir 说清楚要还原哪一个）。' }

# --- 闸门 1：路径本身安不安全 ---
$forbidden = Get-ForbiddenReason $targetProfile $env:USERPROFILE
if ($forbidden -ne '') { Fail ($forbidden + '（目标：' + $targetProfile + '）') }

if (-not $explicitProfile) {
  $profilesRoot = Get-ProfilesRoot
  if (-not (Test-IsInside $targetProfile $profilesRoot)) {
    Fail ('只允许还原 ' + $profilesRoot + ' 里的 profile（目标：' + $targetProfile + '）')
  }
}
Say ('目标 profile：' + $targetProfile)

# --- 闸门 2：这个目录还像不像 DSH profile ---
$fingerprint = Get-ProfileFingerprint $targetProfile
if ($fingerprint.Kind -eq 'not-a-profile') {
  Fail ($fingerprint.Reason + '（目标：' + $targetProfile + '）。拒绝动手 —— 免得把不是 profile 的目录弄坏。')
}
if ($fingerprint.Kind -eq 'broken-profile') {
  Say ('这个 profile 已经坏了：' + $fingerprint.Reason) 'Yellow'
}

# --- 找快照 ---
if (($Snapshot -as [string]) -ne '') {
  $snapshotDir = Resolve-FullPath $Snapshot
  if (-not (Test-Path -LiteralPath $snapshotDir -PathType Container)) {
    Fail ('找不到这份快照：' + $snapshotDir)
  }
  $manifest = Read-SnapshotManifest $snapshotDir
  if ($null -eq $manifest) { Fail ('这份快照没有 manifest.json，不是一份快照：' + $snapshotDir) }
  $selected = [pscustomobject]@{ Ok = $true; Dir = $snapshotDir; Name = (Split-Path -Leaf $snapshotDir); Manifest = $manifest }
} else {
  $backupsRoot = Get-BackupsRoot $StateDir
  Say ('快照目录：' + $backupsRoot)
  $selected = Select-Snapshot $backupsRoot
  if (-not $selected.Ok) { Fail $selected.Error }
  $snapshotDir = $selected.Dir
}
$manifest = $selected.Manifest

# --- 闸门 3：快照里装的是不是真的 profile ---
$snapshotProfile = Test-SnapshotProfile $snapshotDir
if (-not $snapshotProfile.Ok) { Fail ($snapshotProfile.Reason + '（快照：' + $snapshotDir + '）') }

$described = Get-SnapshotDisplay $manifest
Say ('要用快照：' + $selected.Name + '（' + $described.Display + '）')

# --- 算好"放走旧 profile"的证据目录名 ---
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$script:BrokenDir = $targetProfile + '.broken-' + $stamp
$counter = 2
while (Test-Path -LiteralPath $script:BrokenDir) {
  $script:BrokenDir = $targetProfile + '.broken-' + $stamp + '-' + $counter
  $counter += 1
}

# --- 试运行 ---
if ($DryRun) {
  Say ('[试运行] 会先把现在的 profile 挪到：' + $script:BrokenDir) 'Cyan'
  Say ('[试运行] 会把 ' + $selected.Name + ' 里的配置和插件复制回：' + $targetProfile) 'Cyan'
  Say ('[试运行] 会回读校验 package.json / dsh.profile.bundles / ' + $PackageName + ' 的版本号。') 'Cyan'
  Say ('[试运行] 没有改动任何文件。') 'Cyan'
  exit 0
}

# --- 挪走现在的 profile（不覆盖、不删除） ---
if (Test-Path -LiteralPath $targetProfile) {
  try {
    Move-Item -LiteralPath $targetProfile -Destination $script:BrokenDir -ErrorAction Stop
  } catch {
    Fail ('挪走现在的 profile 失败（没有动任何东西）：' + $_.Exception.Message)
  }
  Say ('原来那份已经挪到：' + $script:BrokenDir) 'Gray'
} else {
  Say ('原来那个 profile 目录本来就不在，直接新建。') 'Gray'
}

# --- 复制回来 ---
try {
  New-Item -ItemType Directory -Path $targetProfile -Force | Out-Null
  $configDir = Join-Path $snapshotDir 'config'
  if (Test-Path -LiteralPath $configDir -PathType Container) {
    foreach ($item in (Get-ChildItem -LiteralPath $configDir -Force)) {
      Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $targetProfile $item.Name) -Recurse -Force -ErrorAction Stop
    }
  }
  $pluginsDir = Join-Path $snapshotDir 'node_modules'
  if (Test-Path -LiteralPath $pluginsDir -PathType Container) {
    Copy-Item -LiteralPath $pluginsDir -Destination (Join-Path $targetProfile 'node_modules') -Recurse -Force -ErrorAction Stop
  }
} catch {
  Fail ('把快照复制回去失败（原来那份还在：' + $script:BrokenDir + '）：' + $_.Exception.Message)
}

# --- 回读校验 ---
$checks = New-Object System.Collections.Generic.List[object]

$pkgPath = Join-Path $targetProfile 'package.json'
$parsed = $null
if (-not (Test-Path -LiteralPath $pkgPath -PathType Leaf)) {
  $checks.Add([pscustomobject]@{ Label = 'package.json 能解析'; Status = 'failed'; Detail = 'package.json 不存在' })
} else {
  try {
    $parsed = ([System.IO.File]::ReadAllText($pkgPath)) | ConvertFrom-Json
    $checks.Add([pscustomobject]@{ Label = 'package.json 能解析'; Status = 'passed'; Detail = '' })
  } catch {
    $checks.Add([pscustomobject]@{ Label = 'package.json 能解析'; Status = 'failed'; Detail = '不是合法的 JSON' })
  }
}

$bundles = $null
if ($null -ne $parsed -and $null -ne $parsed.dsh -and $null -ne $parsed.dsh.profile -and $null -ne $parsed.dsh.profile.bundles) {
  $bundles = @($parsed.dsh.profile.bundles)
}
if ($null -ne $bundles -and $bundles.Count -gt 0) {
  $checks.Add([pscustomobject]@{ Label = 'dsh.profile.bundles 有内容'; Status = 'passed'; Detail = ($bundles.Count.ToString() + ' 个') })
} else {
  $checks.Add([pscustomobject]@{ Label = 'dsh.profile.bundles 有内容'; Status = 'failed'; Detail = '没有 dsh.profile.bundles，或者它是空的' })
}

$pluginPkgPath = Join-Path $targetProfile ('node_modules\' + $PackageName + '\package.json')
if (-not (Test-Path -LiteralPath $pluginPkgPath -PathType Leaf)) {
  $checks.Add([pscustomobject]@{ Label = $PackageName + ' 的版本号读得到'; Status = 'skipped'; Detail = '这个 profile 里没有装 ' + $PackageName + '（没什么可读）' })
} else {
  $version = ''
  try {
    $pluginPkg = ([System.IO.File]::ReadAllText($pluginPkgPath)) | ConvertFrom-Json
    if ($null -ne $pluginPkg -and $null -ne $pluginPkg.version) { $version = ([string] $pluginPkg.version).Trim() }
  } catch {
    $version = ''
  }
  if ($version -ne '') {
    $checks.Add([pscustomobject]@{ Label = $PackageName + ' 的版本号读得到'; Status = 'passed'; Detail = $version })
  } else {
    $checks.Add([pscustomobject]@{ Label = $PackageName + ' 的版本号读得到'; Status = 'failed'; Detail = '读不到版本号' })
  }
}

foreach ($check in $checks) {
  if ($check.Status -eq 'passed') { Say ('  [好] ' + $check.Label + ' —— ' + $check.Detail) 'Green' }
  elseif ($check.Status -eq 'skipped') { Say ('  [跳过] ' + $check.Label + ' —— ' + $check.Detail) 'Yellow' }
  else { Say ('  [坏] ' + $check.Label + ' —— ' + $check.Detail) 'Red' }
}

$failed = @($checks | Where-Object { $_.Status -eq 'failed' })
if ($failed.Count -gt 0) {
  Fail ('还原后的 profile 没通过校验（' + (($failed | ForEach-Object { $_.Label }) -join '、') + '）。')
}

# --- 一句人话 ---
$pluginNote = '（含插件）'
if (-not $described.IncludePlugins) { $pluginNote = '（只有配置文件，没有插件）' }
Say ('已还原到 ' + $described.Display + ' 的快照' + $pluginNote + '；现在可以重新打开 DSH。') 'Green'
Say ('原来那份留在了：' + $script:BrokenDir + '（确认没问题之后可以自己删掉它）') 'Gray'
exit 0
