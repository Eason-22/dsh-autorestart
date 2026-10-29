<#
.SYNOPSIS
  dsh-autorestart 自救包的演练：在隔离目录里把 profile 弄坏，再救回来。

.DESCRIPTION
  这个脚本**只碰自己这一次的临时目录**，绝不读写用户正在用的 profile。

  目录纪律（并发跑的硬要求）：

    - 目录名是 `%TEMP%\dsh-rescue-drill-<完整 GUID>`，每次唯一；
    - 目录由本次演练**自己创建**（不带 -Force）：已经存在就说明有人在用，直接报错退出；
    - 目录里放一个锁文件 `.lock`（独占创建）：锁拿不到就直接报错退出，不继续；
    - 清理**只删自己那一个绝对路径**（`Remove-Item -LiteralPath`），
      **绝不按前缀/通配符扫 `%TEMP%`** —— 那会踩到同时在跑的另一个演练；
    - 成功、断言不过、抛错中断，走的是**同一个 finally**：一定会清理，
      清理不干净就把残留路径打印出来。

  演练内容：

    1. 造一个假的 profile（package.json + cordis.patch.yml + 插件树）；
    2. 造一份快照当"备份源"（放在假的 DSH_HOME 下面），另外再放一个
       **更新但没有 manifest** 的目录 —— 快照选择必须跳过它；
    3. **故意弄坏**：把 package.json 写成非法 JSON，删掉插件目录；
    4. 调用 restore-profile.ps1 还原；
    5. 断言：package.json 能解析、bundles 有内容、插件版本读得到、
       `broken-*` 证据目录存在、非 profile 目录被拒绝、目标目录不存在时被拒绝、
       "配置说装了但没装"时必须失败、盘符根目录被拒绝、试运行不落盘、
       脚本文件的编码规矩没破；
    6. 清理（finally）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\drill-rescue.ps1

.NOTES
  全部断言通过时退出码是 0；任何一条断言不过，退出码是 1。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# 演练用的插件名。
$PackageName = 'dsh-autorestart'

# 断言失败的条数（最后用它决定退出码）。
$script:Failures = 0

# 本次演练自己的目录，以及"这个目录是不是我建的"。
$script:TempRoot = ''
$script:OwnsTempRoot = $false

function Say {
  param([string] $Text, [string] $Color = 'Gray')
  Write-Host $Text -ForegroundColor $Color
}

function Assert-True {
  param([string] $Name, [bool] $Condition, [string] $Detail = '')
  if ($Condition) {
    Write-Host ('  [通过] ' + $Name) -ForegroundColor Green
    return
  }
  $suffix = ''
  if ($Detail -ne '') { $suffix = ' —— ' + $Detail }
  Write-Host ('  [失败] ' + $Name + $suffix) -ForegroundColor Red
  $script:Failures += 1
}

# 读一个文件；读不到就返回空字符串（绝不让断言自己先崩掉）。
function Read-TextOrEmpty {
  param([string] $Path)
  try {
    return [System.IO.File]::ReadAllText($Path)
  } catch {
    return ''
  }
}

# 写一个 UTF-8（无 BOM）的文件（父目录顺手建好）。
function Write-TextFile {
  param([string] $Path, [string] $Text)
  $parent = Split-Path -Parent $Path
  if ($parent -ne '' -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

# ---------------------------------------------------------------------------
# 本次演练自己的目录：唯一 + 独占
# ---------------------------------------------------------------------------

$scriptRoot = $PSScriptRoot
$restoreScript = Join-Path $scriptRoot 'restore-profile.ps1'
$cmdScript = Join-Path $scriptRoot 'restore-profile.cmd'

if (-not (Test-Path -LiteralPath $restoreScript -PathType Leaf)) {
  Write-Host ('演练失败：找不到 ' + $restoreScript) -ForegroundColor Red
  exit 1
}

# 完整 GUID：每次跑都是一个新的目录，两个演练不会撞在一起。
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-rescue-drill-' + ([guid]::NewGuid().ToString('N')))
$script:TempRoot = $tempRoot
# 锁文件放在目录**里面**：目录没了锁也没了，不会给 %TEMP% 留下同前缀的残留。
$lockFile = Join-Path $tempRoot '.lock'

# 重入保护 1：目录已经在 = 有人（或上一次没清干净的自己）在用。
if (Test-Path -LiteralPath $tempRoot) {
  Write-Host ('演练失败：这个演练目录已经被占用了：' + $tempRoot) -ForegroundColor Red
  exit 1
}

# 跑还原脚本。
function Invoke-Restore {
  param([string[]] $Arguments, [string] $Label)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $restoreScript @Arguments 2>&1
  $code = $LASTEXITCODE
  $ErrorActionPreference = $previous
  Say ('--- 还原脚本的输出（' + $Label + '）---') 'DarkGray'
  foreach ($line in $output) { Write-Host ('    ' + [string]$line) }
  Say '--- 输出结束 ---' 'DarkGray'
  return [pscustomobject]@{ Code = $code; Output = ($output | Out-String) }
}

try {
  # --- 重入保护 2：目录由本次演练自己建（不带 -Force，已存在会失败） ---
  New-Item -ItemType Directory -Path $tempRoot -ErrorAction Stop | Out-Null

  # --- 重入保护 3：锁文件独占创建 ---
  $lock = [System.IO.File]::Open($lockFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  $lock.Dispose()
  $script:OwnsTempRoot = $true

  Say ('演练目录：' + $tempRoot) 'Cyan'

  $fakeHome = Join-Path $tempRoot 'dsh-home'
  $stateDir = Join-Path (Join-Path $fakeHome 'storages') 'dsh-autorestart'
  $backupsDir = Join-Path $stateDir 'backups'
  $profileDir = Join-Path $tempRoot 'profile'
  $pluginDir = Join-Path (Join-Path $profileDir 'node_modules') $PackageName

  # -------------------------------------------------------------------------
  # 1. 造一个假的 profile
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
  # 2. 造快照（备份源）+ 一个更新但没有 manifest 的目录（快照选择必须跳过它）
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

  # 诱饵：更新的目录，但没有 manifest —— 而且它的 package.json 是另一份。
  New-Item -ItemType Directory -Path (Join-Path $decoySnapshot 'config') -Force | Out-Null
  Write-TextFile (Join-Path $decoySnapshot 'config\package.json') '{"name":"should-not-be-used"}'

  # -------------------------------------------------------------------------
  # 3. 故意弄坏
  # -------------------------------------------------------------------------

  Write-TextFile (Join-Path $profileDir 'package.json') '{ "name": "drill-profile", oops '
  Remove-Item -LiteralPath $pluginDir -Recurse -Force

  Say '已经故意弄坏：package.json 写成非法 JSON，插件目录删掉了。' 'Yellow'

  # -------------------------------------------------------------------------
  # 跑还原脚本
  # -------------------------------------------------------------------------

  # 试运行：只打印，不落盘。
  $dryRun = Invoke-Restore -Arguments @('-DryRun', '-ProfileDir', $profileDir, '-StateDir', $stateDir) -Label '试运行'
  Assert-True '试运行退出码是 0' ($dryRun.Code -eq 0) ('退出码 ' + $dryRun.Code)
  Assert-True '试运行没有改动 package.json' ((Read-TextOrEmpty (Join-Path $profileDir 'package.json')) -like '*oops*')
  Assert-True '试运行没有留下 broken 目录' (@(Get-ChildItem -LiteralPath $tempRoot -Directory -Filter 'profile.broken-*').Count -eq 0)

  # 真正的还原。
  $restore = Invoke-Restore -Arguments @('-ProfileDir', $profileDir, '-StateDir', $stateDir) -Label '真正的还原'
  Assert-True '还原退出码是 0' ($restore.Code -eq 0) ('退出码 ' + $restore.Code)

  # -------------------------------------------------------------------------
  # 4. 断言
  # -------------------------------------------------------------------------

  Say '断言：' 'Cyan'

  # 4.1 package.json 能解析。
  $restoredPackage = $null
  $parseError = ''
  try {
    $restoredPackage = ([System.IO.File]::ReadAllText((Join-Path $profileDir 'package.json'))) | ConvertFrom-Json
  } catch {
    $parseError = $_.Exception.Message
  }
  Assert-True '还原后 package.json 能解析' ($null -ne $restoredPackage) $parseError

  # 4.2 用的是带 manifest 的那份快照，不是更新的那个诱饵。
  $restoredName = ''
  if ($null -ne $restoredPackage) { $restoredName = [string] $restoredPackage.name }
  Assert-True '用的是带 manifest 的那份快照（跳过了更新的诱饵）' ($restoredName -eq 'drill-profile') ('还原出来的 name 是 "' + $restoredName + '"')

  # 4.3 bundles 有内容。
  $bundles = @()
  if ($null -ne $restoredPackage -and $null -ne $restoredPackage.dsh -and $null -ne $restoredPackage.dsh.profile -and $null -ne $restoredPackage.dsh.profile.bundles) {
    $bundles = @($restoredPackage.dsh.profile.bundles)
  }
  Assert-True '还原后 dsh.profile.bundles 有内容' ($bundles.Count -gt 0) ('bundles 数量 ' + $bundles.Count)

  # 4.4 插件版本读得到。
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
  Assert-True '还原后插件版本读得到' ($pluginVersion -ne '') ('版本 "' + $pluginVersion + '"')
  Assert-True '插件版本是快照里的那一个' ($pluginVersion -eq '0.7.0') ('版本 "' + $pluginVersion + '"')

  # 4.5 broken 证据目录存在，而且里面还是坏掉的那份。
  $brokenDirs = @(Get-ChildItem -LiteralPath $tempRoot -Directory -Filter 'profile.broken-*' -ErrorAction SilentlyContinue)
  Assert-True 'broken 证据目录存在' ($brokenDirs.Count -ge 1) ('找到 ' + $brokenDirs.Count + ' 个')
  if ($brokenDirs.Count -ge 1) {
    $brokenPackagePath = Join-Path $brokenDirs[0].FullName 'package.json'
    $brokenKeeps = (Test-Path -LiteralPath $brokenPackagePath -PathType Leaf) -and ((Read-TextOrEmpty $brokenPackagePath) -like '*oops*')
    Assert-True 'broken 目录里保留的还是坏掉的那份' $brokenKeeps
  }

  # 4.6 目录长得不像 profile 的时候，脚本必须拒绝动手。
  $notAProfile = Join-Path $tempRoot 'not-a-profile'
  New-Item -ItemType Directory -Path $notAProfile -Force | Out-Null
  $refused = Invoke-Restore -Arguments @('-ProfileDir', $notAProfile, '-StateDir', $stateDir) -Label '不是 profile 的目录'
  Assert-True '不像 profile 的目录被拒绝（退出码不是 0）' ($refused.Code -ne 0) ('退出码 ' + $refused.Code)
  Assert-True '被拒绝的时候没有动那个目录' (@(Get-ChildItem -LiteralPath $tempRoot -Directory -Filter 'not-a-profile.broken-*').Count -eq 0)

  # 4.7 盘符根目录必须被拒绝。
  $rootRefused = Invoke-Restore -Arguments @('-ProfileDir', 'C:\', '-StateDir', $stateDir) -Label '盘符根目录'
  Assert-True '盘符根目录被拒绝（退出码不是 0）' ($rootRefused.Code -ne 0) ('退出码 ' + $rootRefused.Code)

  # 4.8 目标 profile 目录不存在时必须被拒绝，而且**不许**被创建出来。
  $missingProfile = Join-Path $tempRoot 'not-there-yet'
  $missingRefused = Invoke-Restore -Arguments @('-ProfileDir', $missingProfile, '-StateDir', $stateDir) -Label '目标目录不存在'
  Assert-True '目标 profile 目录不存在时被拒绝（退出码不是 0）' ($missingRefused.Code -ne 0) ('退出码 ' + $missingRefused.Code)
  Assert-True '目标目录不存在时没有把它创建出来' (-not (Test-Path -LiteralPath $missingProfile))

  # 4.9 "配置说装了、实际没装"必须失败：profile 声明了插件，node_modules 里却没有。
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
  $lying = Invoke-Restore -Arguments @('-ProfileDir', $lyingProfile, '-StateDir', $lyingState) -Label '配置说装了但没装'
  Assert-True '声明了插件却没装 → 还原必须失败（退出码不是 0）' ($lying.Code -ne 0) ('退出码 ' + $lying.Code)
  Assert-True '声明了插件却没装 → 明确说 broken 目录还在' ($lying.Output -like '*broken*')

  # 4.10 交付物的编码规矩：ps1 带 BOM，cmd 是纯 ASCII。
  $ps1Bytes = [System.IO.File]::ReadAllBytes($restoreScript)
  $hasBom = ($ps1Bytes.Length -ge 3 -and $ps1Bytes[0] -eq 0xEF -and $ps1Bytes[1] -eq 0xBB -and $ps1Bytes[2] -eq 0xBF)
  Assert-True 'restore-profile.ps1 是 UTF-8 带 BOM' $hasBom
  $cmdBytes = [System.IO.File]::ReadAllBytes($cmdScript)
  $cmdIsAscii = $true
  foreach ($byte in $cmdBytes) {
    if ($byte -gt 127) { $cmdIsAscii = $false; break }
  }
  Assert-True 'restore-profile.cmd 是纯 ASCII' $cmdIsAscii

  # 4.11 全程只在临时目录里动手（所以根本不需要去读用户真实的 profile）。
  $insideTemp = $true
  if ($brokenDirs.Count -ge 1) {
    $insideTemp = $brokenDirs[0].FullName.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)
  }
  Assert-True '演练只在临时目录里动手（broken 目录在临时目录下面）' $insideTemp

  # 4.12 演练自己占的目录有一个锁文件（重入保护的证据）。
  Assert-True '演练目录里有锁文件' (Test-Path -LiteralPath $lockFile -PathType Leaf)
} catch {
  Write-Host ('演练出错：' + $_.Exception.Message) -ForegroundColor Red
  $script:Failures += 1
} finally {
  # -------------------------------------------------------------------------
  # 清理：**只删自己这一个绝对路径**，绝不按前缀/通配符扫 %TEMP%。
  # -------------------------------------------------------------------------
  if ($script:OwnsTempRoot -and $script:TempRoot -ne '') {
    Say ('清理临时目录：' + $script:TempRoot) 'DarkGray'
    try {
      Remove-Item -LiteralPath $script:TempRoot -Recurse -Force -ErrorAction Stop
    } catch {
      # 清理失败不算演练失败，但要如实说。
    }
    if (Test-Path -LiteralPath $script:TempRoot) {
      Write-Host ('临时目录没有清理干净，请自己删掉：' + $script:TempRoot) -ForegroundColor Yellow
      $script:Failures += 1
    } else {
      Say '临时目录已清理干净。' 'Green'
    }
  }
}

# ---------------------------------------------------------------------------
# 结论
# ---------------------------------------------------------------------------

if ($script:Failures -gt 0) {
  Write-Host ('演练失败：' + $script:Failures + ' 条断言没过。') -ForegroundColor Red
  exit 1
}
Say '演练全部通过：故意弄坏 → 还原 → 校验 → 清理，一整圈跑通了。' 'Green'
exit 0
