<#
.SYNOPSIS
  dsh-autorestart 自救包的演练：在隔离目录里把 profile 弄坏，再救回来。

.DESCRIPTION
  这个脚本**只碰临时目录**，绝不读写用户正在用的 profile：

    1. 造一个假的 profile（package.json + cordis.patch.yml + 插件树）；
    2. 造一份快照当"备份源"（放在假的 DSH_HOME 下面），另外再放一个
       **更新但没有 manifest** 的目录 —— 快照选择必须跳过它；
    3. **故意弄坏**：把 package.json 写成非法 JSON，删掉插件目录；
    4. 调用 restore-profile.ps1 还原；
    5. 断言：package.json 能解析、bundles 有内容、插件版本读得到、
       `broken-*` 证据目录存在、非 profile 目录会被拒绝、试运行不落盘、
       脚本文件的编码规矩没破；
    6. 清理临时目录（清理不干净就把残留路径打印出来）。

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

# ---------------------------------------------------------------------------
# 演练的临时目录
# ---------------------------------------------------------------------------

$scriptRoot = $PSScriptRoot
$restoreScript = Join-Path $scriptRoot 'restore-profile.ps1'
$cmdScript = Join-Path $scriptRoot 'restore-profile.cmd'

if (-not (Test-Path -LiteralPath $restoreScript -PathType Leaf)) {
  Write-Host ('演练失败：找不到 ' + $restoreScript) -ForegroundColor Red
  exit 1
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-rescue-drill-' + ([guid]::NewGuid().ToString('N').Substring(0, 10)))
$fakeHome = Join-Path $tempRoot 'dsh-home'
$stateDir = Join-Path $fakeHome 'storages\dsh-autorestart'
$backupsDir = Join-Path $stateDir 'backups'
$profileDir = Join-Path $tempRoot 'profile'

Say ('演练目录：' + $tempRoot) 'Cyan'

# ---------------------------------------------------------------------------
# 1. 造一个假的 profile
# ---------------------------------------------------------------------------

New-Item -ItemType Directory -Path (Join-Path (Join-Path $profileDir 'node_modules') $PackageName) -Force | Out-Null
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
[System.IO.File]::WriteAllText((Join-Path $profileDir 'package.json'), $goodPackageJson, (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText((Join-Path $profileDir 'cordis.patch.yml'), "rows:`n  - id: drill`n", (New-Object System.Text.UTF8Encoding($false)))
$pluginPackageJson = @'
{
  "name": "dsh-autorestart",
  "version": "0.7.0"
}
'@
[System.IO.File]::WriteAllText((Join-Path $profileDir ('node_modules\' + $PackageName + '\package.json')), $pluginPackageJson, (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText((Join-Path $profileDir ('node_modules\' + $PackageName + '\index.js')), "export default 1`n", (New-Object System.Text.UTF8Encoding($false)))

# ---------------------------------------------------------------------------
# 2. 造快照（备份源）+ 一个更新但没有 manifest 的目录（快照选择必须跳过它）
# ---------------------------------------------------------------------------

$goodStamp = '2026-10-29T01-00-00-000Z'
$decoyStamp = '2026-10-29T02-00-00-000Z'
$goodSnapshot = Join-Path $backupsDir $goodStamp
$decoySnapshot = Join-Path $backupsDir $decoyStamp

New-Item -ItemType Directory -Path (Join-Path $goodSnapshot 'config') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $goodSnapshot ('node_modules\' + $PackageName)) -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $profileDir 'package.json') -Destination (Join-Path $goodSnapshot 'config\package.json') -Force
Copy-Item -LiteralPath (Join-Path $profileDir 'cordis.patch.yml') -Destination (Join-Path $goodSnapshot 'config\cordis.patch.yml') -Force
Copy-Item -LiteralPath (Join-Path $profileDir ('node_modules\' + $PackageName + '\package.json')) -Destination (Join-Path $goodSnapshot ('node_modules\' + $PackageName + '\package.json')) -Force
Copy-Item -LiteralPath (Join-Path $profileDir ('node_modules\' + $PackageName + '\index.js')) -Destination (Join-Path $goodSnapshot ('node_modules\' + $PackageName + '\index.js')) -Force

$manifest = [ordered]@{
  stamp    = $goodStamp
  at       = [int64] 1792000000000
  atLocal  = '2026-10-29T09:00:00+08:00'
  profileDir = $profileDir
  includePlugins = $true
  files    = @('config\package.json', 'config\cordis.patch.yml', 'node_modules')
  bytes    = 128
}
[System.IO.File]::WriteAllText((Join-Path $goodSnapshot 'manifest.json'), ($manifest | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))

# 诱饵：更新的目录，但没有 manifest —— 而且它的 package.json 是另一份。
New-Item -ItemType Directory -Path (Join-Path $decoySnapshot 'config') -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $decoySnapshot 'config\package.json'), '{"name":"should-not-be-used"}', (New-Object System.Text.UTF8Encoding($false)))

# ---------------------------------------------------------------------------
# 3. 故意弄坏
# ---------------------------------------------------------------------------

[System.IO.File]::WriteAllText((Join-Path $profileDir 'package.json'), '{ "name": "drill-profile", oops ', (New-Object System.Text.UTF8Encoding($false)))
Remove-Item -LiteralPath (Join-Path $profileDir ('node_modules\' + $PackageName)) -Recurse -Force

Say '已经故意弄坏：package.json 写成非法 JSON，插件目录删掉了。' 'Yellow'

# ---------------------------------------------------------------------------
# 跑还原脚本
# ---------------------------------------------------------------------------

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

# 试运行：只打印，不落盘。
$dryRun = Invoke-Restore -Arguments @('-DryRun', '-ProfileDir', $profileDir, '-StateDir', $stateDir) -Label '试运行'
Assert-True '试运行退出码是 0' ($dryRun.Code -eq 0) ('退出码 ' + $dryRun.Code)
Assert-True '试运行没有改动 package.json' ((Get-Content -LiteralPath (Join-Path $profileDir 'package.json') -Raw) -like '*oops*')
Assert-True '试运行没有留下 broken 目录' (@(Get-ChildItem -LiteralPath $tempRoot -Directory -Filter 'profile.broken-*').Count -eq 0)

# 真正的还原。
$restore = Invoke-Restore -Arguments @('-ProfileDir', $profileDir, '-StateDir', $stateDir) -Label '真正的还原'
Assert-True '还原退出码是 0' ($restore.Code -eq 0) ('退出码 ' + $restore.Code)

# ---------------------------------------------------------------------------
# 4. 断言
# ---------------------------------------------------------------------------

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
$pluginPkgPath = Join-Path $profileDir ('node_modules\' + $PackageName + '\package.json')
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
  $brokenKeeps = (Test-Path -LiteralPath $brokenPackagePath -PathType Leaf) -and ((Get-Content -LiteralPath $brokenPackagePath -Raw) -like '*oops*')
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

# 4.8 交付物的编码规矩：ps1 带 BOM，cmd 是纯 ASCII。
$ps1Bytes = [System.IO.File]::ReadAllBytes($restoreScript)
$hasBom = ($ps1Bytes.Length -ge 3 -and $ps1Bytes[0] -eq 0xEF -and $ps1Bytes[1] -eq 0xBB -and $ps1Bytes[2] -eq 0xBF)
Assert-True 'restore-profile.ps1 是 UTF-8 带 BOM' $hasBom
$cmdBytes = [System.IO.File]::ReadAllBytes($cmdScript)
$cmdIsAscii = $true
foreach ($byte in $cmdBytes) {
  if ($byte -gt 127) { $cmdIsAscii = $false; break }
}
Assert-True 'restore-profile.cmd 是纯 ASCII' $cmdIsAscii

# 4.9 演练全程只在临时目录里动手（所以根本不需要去读用户真实的 profile）。
$insideTemp = $true
if ($brokenDirs.Count -ge 1) {
  $insideTemp = $brokenDirs[0].FullName.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)
}
Assert-True '演练只在临时目录里动手（broken 目录在临时目录下面）' $insideTemp

# ---------------------------------------------------------------------------
# 5. 清理
# ---------------------------------------------------------------------------

Say ('清理临时目录：' + $tempRoot) 'DarkGray'
$removed = $true
try {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction Stop
} catch {
  $removed = $false
}
if ($removed -and (Test-Path -LiteralPath $tempRoot)) { $removed = $false }
if ($removed) {
  Say '临时目录已清理干净。' 'Green'
} else {
  Write-Host ('临时目录没有清理干净，请自己删掉：' + $tempRoot) -ForegroundColor Yellow
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
