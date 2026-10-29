# 自救包隔离演练报告（restore-profile）

> 这是 **t2 演练与复核** 的留痕：把 profile 故意弄坏、再一键救回来，整个过程**只在临时目录里**发生，
> 用户正在用的 `C:\Users\Administrator\.dsh\profiles\desktop` **一个字节都没被碰过**。
> 报告里的每段输出都是那台机器上跑出来的真货，不是复述。

---

## 一、演练基本信息

| 项 | 值 |
| --- | --- |
| 演练时间 | 2026-10-29 16:11 – 16:19（Asia/Shanghai，UTC+8） |
| 机器 | Windows，**Windows PowerShell 5.1.19041.2673**（这台机器**没有装 pwsh**；`.cmd` 入口调的也是 `powershell.exe`） |
| 系统 ANSI 代码页 | **gb2312** ← 这条决定了下面第 9 节那个坑 |
| node | v24.22.1 |
| `DSH_HOME` | `C:\Users\Administrator\.dsh` |
| `DSH_PROFILE_DIR` | `C:\Users\Administrator\.dsh\profiles\desktop` ← **指向真实 profile**，所以演练全程必须显式传 `-ProfileDir` |
| 演练者 | gate（只跑不写业务代码） |

### 被测文件的指纹（这一轮跑的就是这个版本）

```
scripts\restore-profile.ps1   sha256=05b68b499f6c64f27ea4305312fe6d4d913676732220c442c36b574641704f8a  (UTF-8 BOM)  mtime 16:17:33
scripts\restore-profile.cmd   sha256=4c902fd65efb4c7419bf33b9398cf0cf26b7b59286a9754dc83435dd36d7694a  (纯 ASCII)   mtime 16:00:45
scripts\drill-rescue.ps1      sha256=42a414695ba202555b9a4ac416bbc224e0f78d84c3e97edcea7922c4e6ea7392  (UTF-8 BOM)  mtime 16:17:34
lib\rescue.js                 sha256=23c0f9324daacb4183e1c2545b4f85f5835834376dc3c50ec9594b10a94e81ea                   mtime 16:14:31
```

> 说明：演练期间 `dev` 正在同一个仓库上改这两个脚本（任务 t3），所以被测版本变了两次。
> 本报告的最终数据来自 **16:18 那一轮**（上表这组指纹）。中途那一版出过事故，见第 9 节。

---

## 二、结论先说

**通过。** 6 个必测项全绿，另外补了 9 项更狠的检查也全绿：

| 必测项 | 结果 | 证据 |
| --- | --- | --- |
| 隔离目录里的假 profile 被故意弄坏后，**一次运行内**恢复 | ✅ | 第 4 节，一次 `restore-profile.ps1` 运行，退出码 0 |
| 恢复后 `package.json` 可解析 | ✅ | 第 4 节 |
| 恢复后 `dsh.profile.bundles` 非空 | ✅ | 第 4 节（2 个） |
| 恢复后 `node_modules/dsh-autorestart/package.json` 的 version 可读 | ✅ | 第 4 节（`0.7.0`，且就是快照里那一份） |
| `broken-*` 证据目录确实存在 | ✅ | 第 4 节，且里面保留的还是坏掉的那份 |
| `-DryRun` 只打印计划、不改磁盘 | ✅ | 第 6 节（对比执行前后的文件清单 + SHA256 + mtime ticks） |
| 安全拒绝：不含 `package.json` 的目录 → 非零退出码、且不动它 | ✅ | 第 5 节 |
| 全程不触碰用户真实 profile | ✅ | 第 3 节 + 第 8 节（哈希、mtime ticks、ctime、6565 个文件的目录树指纹全部一致） |

---

## 三、第 0 步：记录基线（用户真实 profile）

**命令**（在 `C:\Users\Administrator\.dsh\profiles\desktop` 上，只读）：

```powershell
$pkg = 'C:\Users\Administrator\.dsh\profiles\desktop\package.json'
Get-FileHash -LiteralPath $pkg -Algorithm SHA256
Get-Item -LiteralPath $pkg | Select-Object Length, LastWriteTimeUtc, CreationTimeUtc
# 外加整个 profile 目录的「轻量树指纹」：每个文件的 相对路径|字节数|修改时间(ticks)，排序后取 SHA256
```

**真实输出**：

```
SHA256        : 754948513BBFBDA88CBED82982A80BAE9168844FCFB1A24C7823E615BC47A31D
Length        : 2902
LastWriteTime : 2026-10-29T16:03:52.0611312+08:00
LastWriteUtc  : 2026-10-29T08:03:52.0611312Z
CreationTime  : 2026-10-29T08:45:10.8879423+08:00

profile 目录规模：文件数 6565，总字节 169252227
目录树指纹 TreeHash = ED0330203CDE4FC47D2F6562F1A643E054092AFAC7280CD30860DDA6F164A7A8
```

基线另存了一份 JSON 到 `%TEMP%\dsh-t2-baseline.json`，收尾时用它做逐项对比。

---

## 四、第 1 步：跑插件自带的演练（`drill-rescue.ps1`）

**命令**：

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File plugins\dsh-autorestart\scripts\drill-rescue.ps1
```

**真实输出（节选，完整 22 条断言全过，退出码 0）**：

```
演练目录：C:\Users\Administrator\AppData\Local\Temp\dsh-rescue-drill-a8fbf6eb818b4368a9ec37ae4dab8bc2
已经故意弄坏：package.json 写成非法 JSON，插件目录删掉了。
--- 还原脚本的输出（试运行）---
    dsh-autorestart —— profile 快照还原器
    目标 profile：...\dsh-rescue-drill-a8fbf6eb818b4368a9ec37ae4dab8bc2\profile
    这个 profile 已经坏了：profile 坏了（package.json 不再是 profile），但 profile 的文件还在
    要用快照：2026-10-29T01-00-00-000Z（2026-10-29 09:00）
    [试运行] 会先把现在的 profile 挪到：...\profile.broken-20261029-161806
    [试运行] 没有改动任何文件。
--- 输出结束 ---
  [通过] 试运行退出码是 0
  [通过] 试运行没有改动 package.json
  [通过] 试运行没有留下 broken 目录
--- 还原脚本的输出（真正的还原）---
    原来那份已经挪到：...\profile.broken-20261029-161808
      [好] package.json 能解析
      [好] dsh.profile.bundles 有内容 —— 1 个
      [好] dsh-autorestart 的版本号读得到 —— 0.7.0
    已还原到 2026-10-29 09:00 的快照（含插件）；现在可以重新打开 DSH。
--- 输出结束 ---
  [通过] 还原退出码是 0
断言：
  [通过] 还原后 package.json 能解析
  [通过] 用的是带 manifest 的那份快照（跳过了更新的诱饵）
  [通过] 还原后 dsh.profile.bundles 有内容
  [通过] 还原后插件版本读得到
  [通过] 插件版本是快照里的那一个
  [通过] broken 证据目录存在
  [通过] broken 目录里保留的还是坏掉的那份
  [通过] 不像 profile 的目录被拒绝（退出码不是 0）
  [通过] 被拒绝的时候没有动那个目录
  [通过] 盘符根目录被拒绝（退出码不是 0）
  [通过] 目标 profile 目录不存在时被拒绝（退出码不是 0）
  [通过] 目标目录不存在时没有把它创建出来
  [通过] 声明了插件却没装 → 还原必须失败（退出码不是 0）
  [通过] 声明了插件却没装 → 明确说 broken 目录还在
  [通过] restore-profile.ps1 是 UTF-8 带 BOM
  [通过] restore-profile.cmd 是纯 ASCII
  [通过] 演练只在临时目录里动手（broken 目录在临时目录下面）
  [通过] 演练目录里有锁文件
清理临时目录：...\dsh-rescue-drill-a8fbf6eb818b4368a9ec37ae4dab8bc2
临时目录已清理干净。
演练全部通过：故意弄坏 → 还原 → 校验 → 清理，一整圈跑通了。
```

**退出码 = 0。**

其中「声明了插件却没装 → 还原必须失败」这一段值得单独看一眼——它证明脚本**不假装成功**：

```
      [好] package.json 能解析
      [好] dsh.profile.bundles 有内容 —— 1 个
      [坏] dsh-autorestart 的版本号读得到 —— profile 里写着要装 dsh-autorestart，但 node_modules\dsh-autorestart 不在 —— 配置说一套、磁盘是另一套
    还原失败：还原后的 profile 没通过校验（dsh-autorestart 的版本号读得到）。
    你原来的 profile 完整地留在这里：...\lying-profile.broken-20261029-161813
    （这个目录没有被动过，里面还是你出事之前的样子。）
```

---

## 五、第 2 步：我自己写的「更狠的坏法」独立演练

自带演练只坏两样（非法 JSON + 删插件目录）。我另写了一个**独立**的演练台（放在 `%TEMP%`，
**没有写进仓库**），比它狠一档，一次坏四处：

| 坏法 | 自带演练 | 我的演练 |
| --- | --- | --- |
| `package.json` 写成非法 JSON | ✅ | ✅ |
| 删掉 `node_modules/dsh-autorestart` | ✅ | ✅ |
| `cordis.patch.yml` 也写成垃圾 | — | ✅ |
| 塞一个快照里没有的残留文件 `leftover-junk.txt` | — | ✅ |

**坏完之后的 profile 指纹**（`relative path|字节数|mtime ticks|SHA256` 逐文件比对）：

```
package.json           -> 非法 JSON
cordis.patch.yml       -> "this is not yaml at all: [[["
node_modules/dsh-autorestart\   -> 整个删掉
leftover-junk.txt      -> 快照里没有的文件
```

**命令**：

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File %TEMP%\dsh-t2-my-drill-v4.ps1 -ScriptsRoot <插件 scripts 目录>
```

**真实输出（节选）**：

```
drill root: C:\Users\Administrator\AppData\Local\Temp\dsh-t2-drill-d3d60b5cca
started  : 2026-10-29 16:18:14 +08:00
=== STEP 2: 故意更狠地弄坏（比 t1 的演练更狠） ===
broken: package.json = invalid JSON / node_modules\dsh-autorestart = deleted / cordis.patch.yml = garbage / extra junk file

=== STEP 3: -DryRun 必须一个字节都不改 ===
  [PASS] DryRun exit code is 0
  [PASS] DryRun did not change any byte on disk
  [PASS] DryRun left no broken-* directory

=== STEP 4: 一键救回（一次 restore-profile.ps1 运行） ===
--- restore-profile.ps1 output (real restore) ---
    这个 profile 已经坏了：profile 坏了（package.json 不再是 profile），但 profile 的文件还在
    要用快照：2026-10-28T12-00-00-000Z（2026-10-28 20:00）
    原来那份已经挪到：...\profile.broken-20261029-161818
      [好] package.json 能解析
      [好] dsh.profile.bundles 有内容 —— 2 个
      [好] dsh-autorestart 的版本号读得到 —— 0.7.0
    已还原到 2026-10-28 20:00 的快照（含插件）；现在可以重新打开 DSH。
--- end of output ---
  [PASS] restore exit code is 0
  [PASS] restored package.json parses
  [PASS] used the snapshot that carries a manifest (skipped the newer decoy)
  [PASS] dsh.profile.bundles is not empty
  [PASS] node_modules/dsh-autorestart/package.json version is readable
  [PASS] the plugin version is the one from the snapshot
  [PASS] cordis.patch.yml restored from the snapshot
  [PASS] restored package.json is byte-identical to the snapshot copy
  [PASS] broken-* evidence directory exists
  [PASS] broken dir keeps the BROKEN package.json (invalid JSON)
  [PASS] broken dir keeps the BROKEN cordis.patch.yml (garbage)
  [PASS] broken dir keeps the file that is not in the snapshot
  [PASS] broken dir holds the state at the moment of the break (plugin dir was already gone)
  [PASS] the junk file was NOT resurrected in the restored profile

=== STEP 4c: explicit -Snapshot ===
  [PASS] explicit -Snapshot exit code is 0
  [PASS] explicit -Snapshot restored the plugin version
```

**退出码 = 0（`ALL MY OWN ASSERTIONS PASSED.`）。**

两条值得说明的：

- **「还原后 package.json 与快照里那份逐字节相同」** —— 还原不是「差不多」，是把快照原样放回去。
- **「快照里没有的残留文件不会被凭空造回来」** —— 还原只放回快照里的东西。
  那个残留文件在 `broken-*` 里（出事那一刻的样子），但不会出现在还原后的 profile 里。
- **`broken-*` 保存的是「出事那一刻」的状态**：我在移动之前就删掉了插件目录，所以证据目录里当然没有它。
  证据目录不是时光机，它保存的是**故障现场**，不是更早的样子。

---

## 六、第 3 步：`-DryRun` 不改磁盘

**做法**：在同一个坏掉的 profile 上先拍一份「逐文件 相对路径|字节数|mtime ticks|SHA256」清单，
跑 `-DryRun`，再拍一份，**逐字节比**。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\restore-profile.ps1 `
  -DryRun -ProfileDir <隔离 profile> -StateDir <隔离 state>
```

**真实输出**：

```
    [试运行] 会先把现在的 profile 挪到：...\profile.broken-20261029-161816
    [试运行] 会把 2026-10-28T12-00-00-000Z 里的配置和插件复制回：...\profile
    [试运行] 会回读校验 package.json / dsh.profile.bundles / dsh-autorestart 的版本号。
    [试运行] 没有改动任何文件。
---
  [PASS] DryRun exit code is 0
  [PASS] DryRun did not change any byte on disk
  [PASS] DryRun left no broken-* directory
```

清单逐项一致，**没有留下任何 `broken-*` 目录**，退出码 0。

---

## 七、第 4 步：安全拒绝（拿随机目录冒充 profile）

**做法**：造一个只装 5 个随机二进制文件 + 1 个子目录的临时目录（**没有 package.json**），
当 `-ProfileDir` 传进去，前后各拍一次清单。

**真实输出**：

```
--- restore-profile.ps1 output (not a profile) ---
    dsh-autorestart —— profile 快照还原器
    目标 profile：...\dsh-t2-drill-d3d60b5cca\not-a-profile
    还原失败：这里没有 package.json —— 不像 DSH profile（目标：...\not-a-profile）。拒绝动手 —— 免得把不是 profile 的目录弄坏。
--- end of output ---
  [PASS] not-a-profile dir is refused (exit code != 0)
  [PASS] the refused dir was NOT modified (same bytes + mtimes)
  [PASS] the refused dir has exactly the same entries and mtimes
  [PASS] no broken-* sibling was created for the refused dir
```

**退出码非 0；那个目录里的 5 个随机文件的 SHA256 和 mtime ticks 一个都没变；旁边也没多出 `not-a-profile.broken-*`。**

### 边界闸门顺带也验了一遍（全是只读探测，没碰那些目录）

| 目标 `-ProfileDir` | 脚本的回应 | 退出码 |
| --- | --- | --- |
| `C:\` | 还原失败：拒绝动盘符根目录（目标：C:\） | 非 0 |
| `C:\Windows` | 还原失败：拒绝动系统目录：C:\Windows | 非 0 |
| `C:\Program Files` | 还原失败：拒绝动系统目录：C:\Program Files | 非 0 |
| `C:\ProgramData` | 还原失败：拒绝动系统目录：C:\ProgramData | 非 0 |
| `C:\Users\Administrator` | 还原失败：拒绝动用户主目录本身 | 非 0 |
| `C:\Users\SomeoneElse` | 还原失败：拒绝动别人的用户目录 | 非 0 |

**显式 `-ProfileDir` 也不例外** —— 闸门在「显式指定」这条路上照样生效。

---

## 八、第 5 步：收尾对比基线（真实 profile 一个字节没动）

**命令**：重算第 3 步那一整套指纹，和基线 JSON 逐项比。

**真实输出**：

```
=== 用户真实 profile：演练前 vs 演练后 ===
  [一致] package.json SHA256            before=754948513BBFBDA88CBED82982A80BAE9168844FCFB1A24C7823E615BC47A31D  after=754948513BBFBDA88CBED82982A80BAE9168844FCFB1A24C7823E615BC47A31D
  [一致] package.json 字节数               before=2902  after=2902
  [一致] package.json 修改时间(UTC)        before=2026-10-29T08:03:52.0611312Z  after=2026-10-29T08:03:52.0611312Z
  [一致] package.json 修改时间(ticks)      before=639288578320611312  after=639288578320611312
  [一致] package.json 创建时间(UTC)        before=2026-10-29T00:45:10.8879423Z  after=2026-10-29T00:45:10.8879423Z
  [一致] profile 目录文件数                  before=6565  after=6565
  [一致] profile 目录总字节                  before=169252227  after=169252227
  [一致] profile 目录树指纹                  before=ED0330203CDE4FC47D2F6562F1A643E054092AFAC7280CD30860DDA6F164A7A8  after=ED0330203CDE4FC47D2F6562F1A643E054092AFAC7280CD30860DDA6F164A7A8

=== 结论：用户真实 profile 一字未动 ✅ ===
```

顺带查了 `C:\Users\Administrator\.dsh\profiles\` 下面，只剩 `desktop` / `headless` / `web` 三个目录，
**没有多出任何 `broken-*`**。

补充：`node --test test/rescue.test.mjs test/scripts-encoding.test.mjs` → **36 项全过，退出码 0**。

---

## 九、演练过程中真的出过一次事故（已修，留档）

**16:14:58**，`dev` 为任务 t3 改 `scripts/restore-profile.ps1` 时，**把 UTF-8 BOM 弄丢了**。
文件首字节从 `EF BB BF 3C`（`<#` 带 BOM）变成 `3C 23 0A 2E`（`<#` 不带 BOM）。

后果不是「中文显示乱码」，而是**整个脚本死掉**：

- 这台机器只有 Windows PowerShell 5.1（**没装 pwsh**），`.cmd` 入口调的也是 `powershell.exe`；
- 系统 ANSI 代码页是 **gb2312**，PS 5.1 读「无 BOM 的 UTF-8 文件」按 ANSI 解码 →
  中文变成乱码 → 多字节字符被截断 → **ParserError**，脚本**一行都没执行**；
- 连带 `drill-rescue.ps1` 自己那 22 条断言里 **9 条挂掉**，演练整体跑不完。

当时 `drill-rescue.ps1` 的真实输出（节选）：

```
--- 还原脚本的输出（真正的还原）---
    At ...\scripts\restore-profile.ps1:55 char:18
    +     Write-Host ('浣犲師鏉ョ殑 profile 瀹屾暣鍦扮暀鍦ㄨ繖閲岋細' + $script:BrokenDir) -F ...
    Unexpected token '浣犲師鏉ョ殑' in expression or statement.
    Not all parse errors were reported.  Correct the reported errors and try again.
        + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException
---
  [失败] 还原退出码是 0 —— 退出码 1
  [失败] 还原后 package.json 能解析 —— Invalid object passed in, ':' or '}' expected. (32): { "name": "drill-profile", oops
  ...
  [失败] restore-profile.ps1 是 UTF-8 带 BOM
演练失败：9 条断言没过。
```

**16:17:33 / 16:17:34 已修好**（两个 `.ps1` 的 BOM 都补回去了），并且新增了
`test/scripts-encoding.test.mjs` 做硬闸：直接读字节，断言两个 `.ps1` 必须以 `EF BB BF` 开头、
`.cmd` 必须纯 ASCII、`.cmd` 必须调 `powershell.exe` 而不是 `pwsh`。
本报告最终数据就是修好之后重跑的那一轮。

### 顺带暴露的一条演练盲区 —— **已修复（t4，commit `7209c4a`）**

「拒绝类」断言原本只看**退出码非 0**。脚本解析失败时退出码**也是**非 0 —— 于是
「不像 profile 的目录被拒绝」「盘符根目录被拒绝」这几条会**假通过**：
脚本坏成上面那样，它们照样显示 `[通过]`。

> 当时的建议：拒绝类断言除了退出码，还要断言输出里**出现了具体的拒绝原因**（例如包含「拒绝动盘符根目录」）。
> 这样「脚本自己坏了」和「脚本正确地拒绝了」才分得开。

**这条建议已经被采纳并实现了**（`dev` 的任务 t4，commit `7209c4a`）：演练里新增了
`Assert-Refused`，拒绝类断言现在**同时**检查退出码和输出里的拒绝原因。实跑输出：

```
  [通过] 不像 profile 的目录被拒绝（退出码 + 拒绝原因） —— 退出码 1，输出里有拒绝原因「不像」
  [通过] 盘符根目录被拒绝（退出码 + 拒绝原因） —— 退出码 1，输出里有拒绝原因「盘符」
  [通过] 系统目录 C:\Windows 被拒绝（退出码 + 拒绝原因） —— 退出码 1，输出里有拒绝原因「系统目录」
  [通过] 系统目录 C:\Program Files 被拒绝（退出码 + 拒绝原因） —— 退出码 1，输出里有拒绝原因「系统目录」
  [通过] 系统目录 C:\ProgramData 被拒绝（退出码 + 拒绝原因） —— 退出码 1，输出里有拒绝原因「系统目录」
  [通过] 目标 profile 目录不存在时被拒绝（退出码 + 拒绝原因） —— 退出码 1，输出里有拒绝原因「不存在」
  [通过] 声明了插件却没装 → 还原必须失败（退出码 + 拒绝原因） —— 退出码 1，输出里有拒绝原因「没通过校验」
```

**而且它被反向验证过**（`dev` 做了一次「人为再弄坏」）：临时去掉 BOM 再跑演练，
那些拒绝类断言现在会**如实失败**，而不是假通过：

```
BROKEN   first3=3C 23 0A                -> 演练 exit 1、16 条断言没过，
   每条拒绝类断言都写着「退出码是 1，但输出里没有拒绝原因（期望其中之一：…）」
RESTORED first3=EF BB BF identical=True -> 再跑 exit 0
```

也就是说：**BOM 事故那天会产生假通过的那批断言，现在会如实失败。**
这才是这条改动的意义 —— 演练的价值不在于「跑绿了」，而在于「它真的坏得能被看见」。

### 同一个坑又踩了一次（16:24:46）—— 但这次被硬闸当场抓住

修好 BOM 之后，**又有人在 16:24:46 改了一次 `scripts/drill-rescue.ps1`，BOM 又没了**
（首字节又回到 `3C 23 0A`）。根因很明确：**任何用 edit / 写文件工具重写这两个 `.ps1` 的动作，都会把 BOM 抹掉**。
这不是谁不小心，是工具行为 —— 所以「记得补 BOM」这种约定一定会再失效。

当前工作区的实测：

```
powershell.exe -ExecutionPolicy Bypass -File scripts\drill-rescue.ps1
  -> exit = 1，【0 条 [通过]、0 条 [失败]】（解析阶段就死了，一条断言都没跑到）
  At scripts\drill-rescue.ps1:70 char:20
  +     Write-Host ('  [澶辫触] ' + $Name + ' 鈥斺€?閫€鍑虹爜鏄?' + $Result.Code +  ...
  Unexpected token '[澶辫触]' in expression or statement.
```

**但这次没有造成事故** —— t3 新加的编码硬闸当场就抓住了：

```
node --test test\scripts-encoding.test.mjs
  ✖ the PowerShell scripts keep their UTF-8 byte order mark   (actual: 60, expected: 239 —— 60 是 '<'，239 是 0xEF)
  ✔ the batch entry point stays pure ASCII
  ✔ the batch entry point calls powershell.exe, never pwsh
  ✔ the drill script never sweeps %TEMP% with a wildcard
  pass 3 / fail 1
```

**已提交的历史是干净的**（`65a4c98` 那一版 BOM 在、drill 22 条断言全过、node --test 36/36 全过），
坏掉的只是当时的工作区。所以这两次事故的净结论是：

> **编码硬闸是有用的，但它只在「有人想起来跑测试」时才生效。**
> 这套脚本平时根本没人跑 —— 坏了没人发现，正是它当初能被悄悄弄死、而整个自救包静默失效的原因。
> 建议再往前一步：把「`.ps1` 丢了 BOM 就不许提交」做成 pre-commit 检查或发布前的必跑项。
> 更彻底的做法是把 `.ps1` 里面向用户的中文字符串挪到旁边的 UTF-8 文本文件、运行时读出来，
> 让 `.ps1` 本身变成纯 ASCII —— BOM 这个坑从此不存在。

---

## 十、已知限制

1. **这套自救包解决不了「完全起不来时自动回来」。**
   那要靠看门狗（`dsh-autorestart` 的 supervisor / 计划任务），不靠这套脚本。
   这套自救包只保证一件事：**你能一键回到上一次好状态**——
   前提是你还能双击 `scripts\restore-profile.cmd`（或者还记得手敲那条命令）。
   如果 DSH 起不来是「插件在启动阶段把宿主带崩了、连带连脚本都跑不起来」，
   这个自救包救不了你。

2. **它不替你重启 DSH。** 脚本只管把文件放回去，最后一句是「现在可以重新打开 DSH」。
   故意不自动重启：救不回来还顺手再弄挂一次没有意义。

3. **必须有「带 manifest 的快照」才救得回来。** 没有快照（或者快照目录被清空），
   脚本会直接报错退出。快照是插件平时运行时自动备的 —— **没备过就没有退路**。

4. **目标 profile 目录必须已经存在。** 脚本不会为了还原去新建一个 profile 目录
   （避免把一个打错字的目标变成一个空壳 profile）。这意味着**「profile 整个没了」这种情况救不回来**。

5. **最坏情况会被拒绝。** 实测：如果 profile 坏到**只剩一个非法的 `package.json`**，
   既没有 `cordis.patch.yml` 也没有 `node_modules`，脚本判不出「这曾经是个 profile」，直接拒绝：

   ```
   还原失败：package.json 里没有 dsh.profile，也没有别的东西能证明这是 profile（目标：...\worst-case-profile）。拒绝动手 —— 免得把不是 profile 的目录弄坏。
   ```

   这是**故意保守**的取舍（宁可不动，也不误伤），但用户要知道：**坏得越彻底，越可能落到拒绝这一边**。

6. **只还原快照里有的东西。** 还原只复制 `config/*` 和 `node_modules/`。
   profile 里其它位置（如果还有别的东西）在还原后**不在**了 —— 它们留在 `broken-*` 目录里。
   还原前请确认 `broken-*` 目录在你能找到的地方。

7. **`broken-*` 目录会一直堆着。** 脚本不会自动删它（证据要留）。手动确认没问题之后自己删。

8. **中文 Windows 上的编码陷阱（真实踩过，见第九节）。**
   PS 5.1 + gb2312 代码页下，`.ps1` **必须**是 UTF-8 带 BOM，否则整个脚本静默死掉。
   任何编辑器/脚本重写这两个 `.ps1` 之后，**必须**确认 BOM 还在 ——
   `test/scripts-encoding.test.mjs` 现在会替你盯这件事，**但跑测试得有人跑**。

   > **尚未落地的保险**：把「`.ps1` 丢了 BOM 就不许提交」做成 pre-commit 闸
   > （`.githooks/pre-commit` + `git config core.hooksPath .githooks`）。
   > 现在这条硬闸只在「有人想起来跑测试」时才生效，而这套脚本平时根本没人跑 ——
   > **今天它已经漏掉两次**（16:14:58、16:24:46）。这条建议已报给 captain 等派活。

9. **演练只在 Windows 上做过。** 这套脚本本来就只服务 Windows 桌面版；
   macOS / Linux 没有对应的演练覆盖。

---

## 十一、复现方式

```bash
# 1) 插件自带的演练（隔离目录，全绿退出码 0）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File plugins\dsh-autorestart\scripts\drill-rescue.ps1

# 2) 规则层单测（含编码硬闸）
cd plugins\dsh-autorestart && node --test test\rescue.test.mjs test\scripts-encoding.test.mjs

# 3) 手动试跑（先看它要干什么，再真干）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File plugins\dsh-autorestart\scripts\restore-profile.ps1 -DryRun
```

演练全程**不要**去掉 `-ProfileDir` / `-StateDir` 这两个隔离参数：
这台机器的 `DSH_PROFILE_DIR` 环境变量指向的是**真实** profile。

### 本轮遗留的两个临时目录（无害，但请知悉）

```
C:\Users\Administrator\AppData\Local\Temp\dsh-t2-drill-c77f730a2c   ← 中途一次演练中断，脚本自己没来得及清
C:\Users\Administrator\AppData\Local\Temp\dsh-t2-sut-278d686a       ← 「BOM 修好后的脚本副本」，已用完
```

两个都是本轮演练自己造的、**只在 TEMP 里**、**不含任何真实 profile 数据**。
清理它们的动作走了「开工前检查」的确认卡，但这个委派会话里没有可用的交互问答通道，
确认卡没等到回答、动作**没有执行** —— 所以它们还在原处。可以手动删掉：

```powershell
Remove-Item -LiteralPath "$env:TEMP\dsh-t2-drill-c77f730a2c"  -Recurse -Force
Remove-Item -LiteralPath "$env:TEMP\dsh-t2-sut-278d686a"      -Recurse -Force
```

> 顺带一提：这两个残留正好是「演练自己清理自己」这条要求的反例 ——
> **脚本被中断时，它自己建的目录会留在原地**。`drill-rescue.ps1` 现在会写锁文件来防并发，
> 但中断场景下的残留还是得靠人扫一眼 `%TEMP%`。

---

## 十二、收尾复验（提交之后的干净工作区）

演练期间 `dev` 在同一个仓库上改这两个脚本（任务 t3），所以最后**又跑了一遍**，
这次是跑在**已经提交、工作区干净**的树上。

**交付版本**：

| 提交 | 内容 |
| --- | --- |
| `4c89846` | t1 的原始交付（自救包 6 个新文件） |
| `65a4c98` | t3：修演练并发缺陷 + 补回 BOM + 把编码规矩升级成单测硬闸 |
| `7209c4a` | t4：拒绝类断言升级为「退出码 + 输出里的拒绝原因」 |
| `09735bf` → `52df711` | 本报告（含历次收尾复验） |

**关键事实：`65a4c98` 提交的就是本报告 16:18 那一轮测的那几个字节。**
逐个 sha256 对得上，没有「报告写的是旧版本、交付的是新版本」的问题：

```
scripts\restore-profile.ps1   sha256=05b68b499f6c64f27ea4305312fe6d4d913676732220c442c36b574641704f8a   ← 报告第一节那张表
scripts\restore-profile.cmd   sha256=4c902fd65efb4c7419bf33b9398cf0cf26b7b59286a9754dc83435dd36d7694a   ← 同上
scripts\drill-rescue.ps1      sha256=42a414695ba202555b9a4ac416bbc224e0f78d84c3e97edcea7922c4e6ea7392   ← 同上
```

**提交后在干净工作区（`git status` 为空）上的复验结果，2026-10-29 16:23**：

| 检查 | 结果 |
| --- | --- |
| `drill-rescue.ps1` | 退出码 **0**，**22 条 `[通过]`、0 条 `[失败]`** |
| 我自写的更狠演练 | 退出码 **0**，**PASS=33、FAIL=0** |
| `node --test test\rescue.test.mjs test\scripts-encoding.test.mjs` | **tests 36 / pass 36 / fail 0** |
| 用户真实 profile 基线 | SHA256、mtime、ctime、6565 文件树指纹 **四项全部仍与基线一致** |
| `profiles\` 下有没有 `broken-*` | **没有** |

这一轮演练的临时目录是
`%TEMP%\dsh-rescue-drill-9de04366792240c98a460c7486f5bba3`（32 位完整 GUID —— t3 的新规矩），
跑完**自己清掉了**。

### 16:28 再收一次尾（BOM 二次回归修好之后）

`dev` 修完第二次 BOM 回归后，我在**当时的工作区**上又整体跑了一遍，仍然全绿：

| 检查 | 结果 |
| --- | --- |
| `scripts\restore-profile.ps1` / `scripts\drill-rescue.ps1` 的 BOM | 都在（`EF BB BF`） |
| 编码硬闸 `node --test test\scripts-encoding.test.mjs` | **pass 6 / fail 0**（硬闸自己又长了两条） |
| `drill-rescue.ps1` | 退出码 **0**，**28 条 `[通过]`、0 条 `[失败]`** |
| 我自写的更狠演练 | 退出码 **0**，**PASS=33、FAIL=0** |
| `node --test test\rescue.test.mjs test\scripts-encoding.test.mjs` | **tests 38 / pass 38 / fail 0** |
| 用户真实 profile 基线 | SHA256、mtime、ctime **三项仍与基线一致**，无 `broken-*` |

当时工作区的脚本指纹：

```
scripts\restore-profile.ps1    sha256=05b68b499f6c64f27ea4305312fe6d4d913676732220c442c36b574641704f8a   ← 与 65a4c98 一致，没再变
scripts\restore-profile.cmd    sha256=4c902fd65efb4c7419bf33b9398cf0cf26b7b59286a9754dc83435dd36d7694a   ← 同上
scripts\drill-rescue.ps1       sha256=db36bb6282f0cfaa2171277883c8233d268afd51f20698572388c0f994c77ef4   ← t3 后续又改过
test\scripts-encoding.test.mjs sha256=c981c816911c72bf0020146fa66c77ccd97cd7999dae20a5d8bf73a7e275c12d   ← 同上
```

> **关于断言条数**：`drill-rescue.ps1` 的条数随 t3 的推进一路在长 ——
> t1 原始交付 **17 条** → t3 补完并发与编码 **22 条** → 再补 **28 条**。
> 报告正文里所有引用的输出片段来自 **22 条那一版**（与提交 `65a4c98` 逐字节一致）；
> 第十六节表格里的最终数字来自 **28 条那一版**。两版都全绿，结论不变。
>
> **`restore-profile.ps1` 和 `restore-profile.cmd` 自始至终没有再变过字节** ——
> 本次演练的核心结论（能救回来、会拒绝、-DryRun 不落盘）在这两个文件的每一个版本上都是一样的。

### 16:33 t4 之后的最终状态（commit `7209c4a`）

t4 把拒绝类断言升级成了「退出码 + 输出里的拒绝原因」（见第九节）。
我在**提交后的干净工作区**上又整体复验了一遍，全绿：

| 检查 | 结果 |
| --- | --- |
| `scripts\drill-rescue.ps1` 的 BOM | 在（`EF BB BF`） |
| `drill-rescue.ps1` | 退出码 **0**，**28 条 `[通过]`、0 条 `[失败]`**（含 7 条新的「退出码 + 拒绝原因」断言） |
| 我自写的更狠演练 | 退出码 **0**，**PASS=33、FAIL=0** |
| `node --test test\rescue.test.mjs test\scripts-encoding.test.mjs` | **tests 38 / pass 38 / fail 0** |
| 用户真实 profile 基线 | SHA256、mtime、ctime、6565 文件树指纹 **四项全部仍与基线一致** |
| `profiles\` 下有没有 `broken-*` | **没有** |

当时的脚本指纹（= 已提交版本）：

```
scripts\restore-profile.ps1   sha256=05b68b499f6c64f27ea4305312fe6d4d913676732220c442c36b574641704f8a
scripts\restore-profile.cmd   sha256=4c902fd65efb4c7419bf33b9398cf0cf26b7b59286a9754dc83435dd36d7694a
scripts\drill-rescue.ps1      sha256=db36bb6282f0cfaa2171277883c8233d268afd51f20698572388c0f994c77ef4
```

**本报告到此覆盖了完整的一轮生命周期**：
造坏 → 救回 → 断言 → 基线复核 → 编码事故 → 事故复现 → 硬闸生效 → 断言升级 → 复验。
所有环节的最终状态都是绿的，而用户真实的 profile 从头到尾一个字节都没被碰过。
