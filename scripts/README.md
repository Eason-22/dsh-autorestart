# 自救包（scripts）

DSH 起不来的时候，这个文件夹里的东西**不用 DSH 自己**就能救自己。

- **双击哪个**：DSH 起不来（插件升级把 profile 弄坏了）→ 双击 `restore-profile.cmd`；只是想把本插件摘掉 → 双击 `emergency-disable.cmd`。
- **它会做什么**：`restore-profile.cmd` 把最新的那份快照（`<stateDir>\backups\` 里带 manifest 的）放回 profile —— 先把现在的 profile 整份挪到 `<profile>.broken-<时间戳>`，再复制快照里的配置和插件树，最后回读校验（package.json 能解析、`dsh.profile.bundles` 有内容、插件版本号读得到）；校验不过就如实报错，并告诉你原来那份还在哪个目录。**它不会替你重启 DSH**（重启由你自己来，免得"救一次挂一次"）。
- **会留下什么**：一个 `<profile>.broken-<yyyyMMdd-HHmmss>` 目录（出事之前的那份 profile 原封不动地留着，确认没问题后可以自己删掉），加上最后一行"已还原到 …… 现在可以重新打开 DSH"的结论。

## 演练（不碰你正在用的 profile）

```
powershell -NoProfile -ExecutionPolicy Bypass -File .\drill-rescue.ps1
```

在临时目录里造一个假 profile → 故意把 `package.json` 写坏、删掉插件目录 → 调 `restore-profile.ps1` 救回来 → 断言（能解析、插件版本读得到、`broken-*` 目录存在、非 profile 目录被拒绝）→ 清理临时目录。全绿时退出码是 0。

`restore-profile.ps1` 的参数：`-DryRun`（只打印将要做什么）、`-Snapshot <目录>`（指定某一份快照）、`-ProfileDir <路径>`（演练用的隔离目录）、`-StateDir <路径>`（插件状态目录，默认 `<DSH_HOME>\storages\dsh-autorestart`）。
