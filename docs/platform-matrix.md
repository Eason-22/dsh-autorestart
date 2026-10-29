# 跨环境能力矩阵

这张表回答一个具体的问题：**「我这套环境到底能做什么？」**

插件装在哪台机器上，就只有那台机器的答案 —— 所以每一行能力都按平台分开写，
而且每一格都要能在代码里找到对应实现，或者明确写「不支持」。

- **Windows 桌面**：DeepSeek Harness 桌面客户端（`restartMode: app`）。
- **Windows web**：托管在 Windows 上的 `dsh web`。
- **Linux web**：托管在 Linux 上的 `dsh web`。
- **WSL web**：托管在 WSL（Windows 里的 Linux）上的 `dsh web`。
- **容器**：Docker / CI 里的容器。

图例：✅ 能用 ｜ ⚠️ 能用但有条件（**每一格都写清「用户会看到什么」**）｜ ❌ 不支持（为什么在最后一列）

## 能力矩阵

| 能力 | Windows 桌面 | Windows web | Linux web | WSL web | 容器 | 说明（实现在哪） |
|---|---|---|---|---|---|---|
| 重启（DSH 自己把自己重启起来） | ✅ | ✅ | ✅ | ✅ | ✅ | `lib/restart.js`：桌面用当前 exe，托管用配置的 `restartCommand` |
| 会话续接（重启后接着干活） | ✅ | ✅ | ✅ | ✅ | ✅ | `lib/checkpoint.js` + `lib/lifecycle.js`：checkpoint 落在 `<DSH_HOME>/storages/dsh-autorestart/` |
| 重启前备份（profile 快照） | ✅ | ✅ | ✅ | ✅ | ✅ | `lib/backup.js`：快照目录 `<stateDir>/backups/`，默认留 2 份 |
| **自动回滚（看门狗）** | ✅ 计划任务 | ✅ 计划任务 | ✅ systemd 定时器 | ✅ systemd（有 systemd 时）/ ⚠️ 自建后台进程：没有 systemd 时，用户在设置页会看到「看门狗的触发方式：自建后台进程」 | ⚠️ 自建后台进程：用户会看到「看门狗的触发方式：自建后台进程」（容器里没有 systemd 定时器可依赖） | `lib/watchdog-tier.js` 选档，`lib/watchdog-schedule.js` 注册，`lib/watchdog.js` 跑流程 |
| 自动回滚的**能力检测**（能不能建任务） | ✅ | ✅ | ✅ | ✅ | ✅ | `lib/scheduler-capability.js`：真注册一次任务再回读、删掉、确认没了 |
| 自动回滚被拒时的降级链路 | ❌ | ❌ | ❌ | ❌ | ❌ | **有意不做**：被禁就是被禁，只告知（`README.md` 的「当机器不允许创建计划任务时」） |
| 手动还原（出事了自己救） | ✅ `restore-profile.cmd` | ✅ `restore-profile.cmd` | ✅ `restore-profile.sh` | ✅ `restore-profile.sh` | ✅ `restore-profile.sh` | `scripts/restore-profile.ps1` / `scripts/restore-profile.sh` |
| 摘掉本插件（急救开关） | ✅ `emergency-disable.cmd` | ✅ `emergency-disable.cmd` | ✅ `emergency-disable.sh` | ✅ `emergency-disable.sh` | ✅ `emergency-disable.sh` | `scripts/emergency-toggle.ps1` / `scripts/emergency-disable.sh` |
| 设置页「出事了怎么办」 | ✅ | ✅ | ✅ | ✅ | ✅ | 只显示**这台机器上真有的**脚本路径（`lib/rescue-paths.js` 按平台给 `.cmd` / `.sh`） |
| 桌面快捷方式（双击即救） | ✅ | ✅ | ❌ | ❌ | ❌ | 快捷方式是 Windows 的 `.cmd`；别的平台没有可双击的东西，就不显示这个按钮 |
| 关机倒数 | ✅ 关这台 Windows | ✅ 关这台 Windows | ✅ 关这台 Linux | ✅ **关掉整台 Windows**（不是关 WSL！） | ⚠️ 容器里没有意义：用户会看到「这台机器没有可靠的关机方式」，命令是空的、什么都不会执行 | 计划层已验证（`test/sleep-plan-posix.test.mjs`）；Windows 真关电已验，**POSIX 未真关电**（用户决定不真关：一条常识证据不值得断开所有会话） |
| 开机自启建议 | ✅ | ✅ | ✅ | ✅ | ⚠️ 容器里没有 systemd 用户会话：用户会看到「这里不能开机自启」的说明，插件只会给建议、不会去改系统 | `lib/autostart-advice.js` + `lib/supervisor-install.js`：Windows 用计划任务或启动文件夹，Linux 用 systemd user unit |
| 问题反馈（诊断信息） | ✅ | ✅ | ✅ | ✅ | ✅ | `lib/diagnostics.js`；设置页复制，诊断信息里也带 watchdog 档位 |

## 关机：会关掉哪台机器？

这一格必须说清楚 —— 猜错了代价太大。

| 你在哪 | 关机倒数按下去会关掉什么 | 界面上的原话（`host.label`） |
|---|---|---|
| Windows 桌面 | **这台 Windows 电脑** | 「关掉这台 Windows 电脑」 |
| Windows 上的 `dsh web` | **这台 Windows 电脑** | 「关掉这台 Windows 电脑」 |
| Linux 主机上的 `dsh web` | **那台 Linux 主机** | 「关闭这台 Linux 主机」 |
| **WSL 里的 `dsh web`** | **整台 Windows 主机**（不是那个 WSL 小环境！） | 「WSL 里的 DSH → 关掉整台 Windows」 |
| 容器 | 什么都没有（命令是空的） | 「这台机器没有可靠的关机方式」 |

> ⚠️ **在 WSL 里看到关机倒数，意味着你的整台机器会关机** —— 不是只停那个 Web 服务。
> WSL 是 Windows 上的一个 Linux 小环境，关掉它只会停掉那个发行版；要让**主机**关机，
> 插件走的是挂载盘里的 `shutdown.exe`（`/mnt/c/Windows/System32/shutdown.exe /s /f /t 0`），
> 备选是 `powershell.exe -Command "Stop-Computer -Force"` 和
> `cmd.exe /c shutdown.exe /s /f /t 0`。也就是说：**关的是主机**。

**验到什么程度**：计划层已验证（`test/sleep-plan-posix.test.mjs`：WSL 的计划必须走
「关整台 Windows」那条分支、纯 Linux 的计划里不许出现任何 Windows 命令、不支持的
平台命令为空且**什么都不执行**）。**Windows 真关电已验**；**POSIX 没有真关电** ——
用户决定不真关：为一条常识证据把所有人的会话都断掉不划算。

## 三档调度是怎么选的

`lib/watchdog-tier.js` 里的 `pickWatchdogTier()` 是**唯一**决定档位的地方
（设置页的警告、diagnostics 里的说明、真正注册看门狗，问的都是它）：

| 档 | 机制 | 什么机器 |
|---|---|---|
| `scheduled-task` | 一次性 Windows 计划任务（建完回读校验、用完全删、`IgnoreNew`、`EndBoundary` 必填） | Windows（桌面与 web） |
| `systemd-run` | `systemd-run --user --on-active=<秒>s --unit=dsh-autorestart-watchdog`，结束后 `systemctl --user reset-failed` | Linux、WSL（有 systemd 时） |
| `detached-process` | `setsid nohup sh -c 'sleep <秒>; <看门狗>' >/dev/null 2>&1 &`，pid 写进 stateDir 并回读确认还活着 | 容器、WSL（没有 systemd 时） |
| `none` | 没有可用机制 → **看门狗不注册**，`tier: 'none'`，设置页与 diagnostics 都明说「没有自动回滚」 | 被策略禁用的机器 |

## 手工还原脚本在每个平台上做什么

两个版本是**同一套规则**（`scripts/restore-profile.ps1` 与 `scripts/restore-profile.sh`）：

1. 默认取 `<stateDir>/backups/` 里**最新带 manifest** 的快照；
2. 还原前把现在的 profile 整份挪到 `<profileDir>.broken-<UTC 时间戳>`（**不删**）；
3. 还原后回读校验：`package.json` 能解析、`dsh.profile.bundles` 非空、
   **声明了 `dsh-autorestart` 就必须能在 `node_modules` 里读到版本号**；
4. 路径闸门：只接受 `<DSH_HOME>/profiles/*` 或显式指定的隔离路径；
   拒绝 `/`、`/usr`、`/etc`、`$HOME` 本身、别人的家目录；
5. **不自动重启 DSH**；`--dry-run`（Windows `-DryRun`）可以先看会发生什么。

中文文案都来自 `scripts/rescue-strings.zh.json`（UTF-8 **无 BOM**）；没有 node 的
机器上退回英文。

## 怎么自己验一遍

| 平台 | 命令 |
|---|---|
| Windows | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/drill-rescue.ps1` |
| Linux / WSL | `sh scripts/drill-rescue.sh` |

演练在**自己的临时目录**里造假 profile、故意弄坏、还原、断言，然后清理干净 ——
它不碰任何正在用的 profile。
