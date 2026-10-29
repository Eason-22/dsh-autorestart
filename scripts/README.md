# 自救包（scripts）

DSH 起不来的时候，这个文件夹里的东西**不用 DSH 自己**就能救自己。

- **双击哪个**：DSH 起不来（插件升级把 profile 弄坏了）→ 双击 `restore-profile.cmd`；只是想把本插件摘掉 → 双击 `emergency-disable.cmd`。
- **它会做什么**：`restore-profile.cmd` 把最新的那份快照（`<stateDir>\backups\` 里带 manifest 的）放回 profile —— 先把现在的 profile 整份挪到 `<profile>.broken-<时间戳>`，再复制快照里的配置和插件树，最后回读校验（package.json 能解析、`dsh.profile.bundles` 有内容、插件版本号读得到）；校验不过就如实报错，并告诉你原来那份还在哪个目录。**它不会替你重启 DSH**（重启由你自己来，免得"救一次挂一次"）。
- **会留下什么**：一个 `<profile>.broken-<yyyyMMdd-HHmmss>` 目录（出事之前的那份 profile 原封不动地留着，确认没问题后可以自己删掉），加上最后一行"已还原到 …… 现在可以重新打开 DSH"的结论。

## 两条硬规矩（有意收紧，不是 bug）

- **目标 profile 目录必须已经存在**：还原器把快照放回一个**已经存在**的 profile，**不会凭空新建**一个 profile（也不会替你建 `profiles` 目录）。路径写错的时候，宁可报错，也不留一个空壳 profile 在那儿。
- **插件版本号的校验看配置说话**：profile 的 `dsh.profile.bundles` 里**没有** `dsh-autorestart` → 这一项**跳过**；**声明了**、但 `node_modules/dsh-autorestart` 不在 → **必须失败**（配置说一套、磁盘是另一套，这是真坏，不能放过）。

## 演练（不碰你正在用的 profile）

```
powershell -NoProfile -ExecutionPolicy Bypass -File .\drill-rescue.ps1
```

在临时目录里造一个假 profile → 故意把 `package.json` 写坏、删掉插件目录 → 调 `restore-profile.ps1` 救回来 → 断言（能解析、插件版本读得到、`broken-*` 目录存在、非 profile 目录被拒绝、目标目录不存在时被拒绝、"配置说装了却没装"时必须失败）→ 清理临时目录。全绿时退出码是 0。

演练的目录纪律（**并发跑也互不干扰**）：每次跑用 `%TEMP%\dsh-rescue-drill-<完整 GUID>` 这个**唯一**目录，目录由本次演练自己创建（已存在就报错退出），目录里放一个独占的锁文件 `.lock`；清理**只删自己那一个绝对路径**（`Remove-Item -LiteralPath`），**绝不按前缀/通配符扫 `%TEMP%`** —— 那会踩到同时在跑的另一个演练。成功、断言不过、抛错中断，走的都是同一个 `finally`，一定会清理；清理不干净就把残留路径打印出来。

`restore-profile.ps1` 的参数：`-DryRun`（只打印将要做什么）、`-Snapshot <目录>`（指定某一份快照）、`-ProfileDir <路径>`（演练用的隔离目录）、`-StateDir <路径>`（插件状态目录，默认 `<DSH_HOME>\storages\dsh-autorestart`）。`DSH_HOME` 可以用环境变量覆盖，但目标 profile 目录必须已经在那儿。

> 编码规矩：两个 `.ps1` 必须是 **UTF-8 带 BOM**（Windows PowerShell 5.1 按 ANSI 读无 BOM 的 UTF-8，中文会变乱码、直接 ParserError），`.cmd` 必须是**纯 ASCII**。这条规矩由 `test/scripts-encoding.test.mjs` 天天盯着，脚本被改坏了一眼就能看见。
