# dsh-autorestart

## 截图

![dsh-autorestart 图标](assets/icon-180.png)

![dsh-autorestart 截图 1](assets/screenshot-1.png)

![dsh-autorestart 截图 2](assets/screenshot-2.png)

![dsh-autorestart 截图 3](assets/screenshot-3.png)

## 它解决什么问题

- DeepSeek Harness 在装插件、升级、崩溃、或关掉重开时，正在跑的任务会被打断。这个插件把"重启"变成一件可恢复的事，不再需要你事后补一句"继续"：
- 等所有对话都空闲了才重启：不会在你或别的会话正在跑的时候把应用关掉；
- 重启后自动接着干：被打断的会话自动恢复，目标（goal）会重新武装继续跑；
- 多个会话同时要求重启时合并成一次，且每个请求者都会被唤醒；
- 带 goal 的会话不会把重启卡死：重启前自动**解除（disarm）**它的 goal（当前那一轮照常跑完，什么都不丢），重启之后自动重新上链；
- 重启前有两道检查：宿主侧查一次，独立 helper 在杀进程前再查一次；
- 界面上能看到状态：输入框工具行左侧的"待重启 · 被 N 个会话占用"小胶囊、左侧栏会话标题旁的圆点；快重启时圆点呼吸，点胶囊看详情；
- 可配置：静默窗口（默认 2 秒）、杀进程前等待（默认 2 秒）、忙碌时是否允许强制重启等。
- 同一套"等到大家都安静"的想法还做成了**优雅挂机**：主界面左上角一个月亮按钮 → 等所有会话收工 → 屏幕上倒数 10 秒（大字 + 鲸鱼娘）→ **关掉整台电脑**（见「优雅挂机」）。

场景对照：

| 场景 | 没有它 | 有它 |
| --- | --- | --- |
| Agent 正在跑长任务，DSH 被重启/崩溃 | 这一轮丢失，必须人工催"继续" | 新进程启动后自动 resume 该会话并注入续接提示，继续干活 |
| Agent 有一个持久 goal（`create_goal`）跨重启 | goal 的 activation 是进程内的，重启后变回 `disarmed`，自动续跑停止 | 启动时重新 `goals.resume()`，goal round driver 立刻开始下一轮 |
| Agent 想装/升级插件但"重启必打断" | 只能等或赌 | 调 `continuum_restart`：等所有 agent idle（当前这一轮跑完）再重启，回来自己接着做 |

## 适合谁 / 不适合谁

适合：经常因为装插件、升级、应用崩溃而丢掉正在进行的长任务，希望重启后自动接续的人。

不适合：无法接受应用窗口关闭再重开的人；非 Windows 桌面且未配置 restartMode 为 command 的 web 部署（重启功能不可用）；正在跑关键任务的 profile（建议先在测试 profile 验证）。

> **包名说明**：原先的包名在公共 npm registry（npmjs.com）上已被其他作者占用，因此本包更名为 **dsh-autorestart**。

**重启不断线 / Cross-restart continuation for DeepSeek Harness (dsh).**

Agent 在 DSH 重启（插件升级、应用崩溃、用户关闭再打开）之后，可以**自动接续重启前没做完的工作**，不需要人再发一条"继续"。
This Host plugin makes a DSH restart a *resumable* event instead of a dead end: a durable checkpoint, automatic
session resume on boot, durable-goal re-arm, and an agent-callable idle-aware graceful restart.

> 目标与社区插件 [dsh-phoenix](https://github.com/StvLi/dsh-phoenix) 相同，但这一版为 **Windows + DSH Desktop** 原生实现：
> 不依赖 systemd，使用 WMI/schtasks 脱离将要被销毁的 Electron 进程树来重启应用。

---

## 占用 DSH 的哪些位置（安装前请先看一眼）

下面就是它动到的全部位置，没有别的：

| 类型 | 具体占用 |
| --- | --- |
| Agent 工具（6 个） | `continuum_restart`、`continuum_status`、`continuum_cancel_restart`、`continuum_park_goal`、`continuum_recover_now`、`continuum_handoff` |
| HTTP 路由（6 条） | `<healthPath>`（默认 `/__dsh_autorestart`）下的 `GET /health`（另有 `?state=1`、`?gate=1`、`?probeIndex=1`）、`POST /park`、`POST /recover`、`POST /handoff`、`GET /sleep`、`POST /sleep`（优雅挂机）；只接受本机回环或已认证的浏览器 |
| 前端槽位（4 个） | `conversation.input.left`（待重启小胶囊，id `autorestart-restart-pill`）、`sidebar.session.row.leading`（侧栏状态圆点，id `autorestart-restart-dot`）、`conversation.header.leading`（优雅挂机的月亮按钮）、`shell.overlay`（倒数覆盖层） |
| 系统提示词 | 一段「重启政策」说明，告诉 agent 怎么请求重启、插件会做什么 |
| 宿主事件 | `agent/status`（跟踪哪些会话在忙）、`tools/pre-execute`（拦下"手动杀/重启 DSH"的 shell 命令）、启动时的恢复流程 |
| profile 行 | 一条 bundle 行：`dsh-autorestart` |
| 写文件 | 只在 `<DSH_HOME>/storages/dsh-autorestart/` 下写：`state.json`（检查点）、`backups/`（重启前快照）、`restart-<代次>.cmd` / `restart-<代次>-watch.ps1`（脱离进程的重启 helper）、`last-rollback.json`（回退报告）。唯一会写进 profile 的时机是**回退**：把快照里的 `cordis.patch.yml`、`package.json`、`pnpm-lock.yaml` 和 `node_modules` 拷回去 |

## 重启前备份与自动回退

- **每次重启前**先给 profile 拍快照：`cordis.patch.yml`、`package.json`、`pnpm-lock.yaml`，以及（默认开启）已安装插件目录 `node_modules`。本机实测：**2.76 秒 / 117.6 MB / 5,562 个文件**。
- 快照放在 `storages/dsh-autorestart/backups/<时间戳>/`，带 `manifest.json`；**只保留最新 2 份**，写新快照时自动删旧的。
- 重启后 helper 会跑一个隐藏的看护脚本，轮询健康端点 **90 秒**（`rollbackTimeoutMs`）：正常回答就静默退出，**什么都不动**。
- 宿主**一直不回应**时：把快照拷回去 → 写 `last-rollback.json`（含"本次重启之后"的崩溃日志尾部，旧日志不会被误当证据）→ **自动再拉起一次**。
- 下次启动时 `continuum_status` 会报 `lastRollback`（时间、等了多久、是否回滚、快照路径、崩溃日志名与尾部摘要）。
- 开关：`backupOnRestart`（默认 `true`）、`backupIncludePlugins`（默认 `true`，关掉就只备配置文件）、`maxBackups`（默认 `2`）、`rollbackTimeoutMs`（默认 `90000`）。

### 首次安装只问一次：备份要不要连已装插件一起备

第一次用这个插件时，输入框上方会出现**一条非模态提示**（不是弹窗，不挡输入框，也不会自己消失），问一句：

- **「配置 + 已安装插件」** —— 每次重启多约 3 秒、约 117 MB；插件把启动搞坏时也能一起回退。
- **「只备份配置」** —— 瞬间完成、约 66 KB；插件问题无法回退，需要手动重装。

两个选项共享同一个基底：**配置一定会被备份**，插件只是"要不要额外带上"，不是二选一。

- **只问一次**：只有 `localStorage['dsh-autorestart:backup-choice-v1']` 缺失时才渲染；点任一项都会写下这个键，之后不再出现。
- **关掉也算作答**：按 `×` 或 `Esc` 与点选项写的是同一个「已作答」标记，这个浏览器此后**不会再被问**；关掉等于保留默认（配置 + 已安装插件）。
- **不打扰**：面板是 `role="status"` 的普通块，放在输入框下方的 dock 里；可聚焦、键盘可达、`Esc` 关闭。
- **答案存在哪**：宿主用官方 `configEditor` Service 写进 profile 配置（就是设置页里那个 `backupIncludePlugins` 键，**只有一份真相**）。万一这个服务不可用，才退化到写 `<DSH_HOME>/storages/dsh-autorestart/install-choice.json` 并在日志里 `warn`。**托管 profile 如果自己没有声明 `dsh-autorestart` 行**，就没有行可写，答案同样落在这个文件里而不是 profile 里 —— 声明那一行（见「平台与部署」）才能让 profile 配置保持唯一真相。
- **想改主意**：设置 → 插件 → dsh-autorestart → `backupIncludePlugins`。`continuum_status` 里随时能看到当前生效值（`backupIncludePlugins: true | false`）。

## 工作方式

```
agent/status(running) ──► 写 checkpoint（<DSH_HOME>\storages\dsh-autorestart\state.json，原子写）
        │
        ├─ continuum_restart 工具：checkpoint 标记 pendingResume + generation+1，轮询等 idle
        │        ├─ goal 驱动的会话：判定"被阻塞"之前先 goals.disarm() 解除 → 当前轮跑完、会话变 idle（disarmed 记录落盘）
        │        └─ 全空闲 ──► WMI 创建脱离进程树的 cmd：ping 延迟 → taskkill 整个应用 → 重新启动 exe
        │
        └─ 进程意外死亡 ──► 下一次启动时，旧 bootPid 记录里 running=true 的会话被判定为“中断”
                                   │
新进程 boot ──► apply()：beginBoot()（新 pid ⇒ 新 bootId）──► recoveryDelayMs 后恢复
                                   │
                    ┌──────────────┴──────────────┐
            session 有 active+disarmed 的 goal     无 goal（或 goal 不可续）
                    │                              │
          ctx.goals.resume(agent, ref)    agent.followup(<续接消息>)
                    │                              │
       goal round driver 自动开下一轮      一条带 <continuum_resume> 标记的续接消息
```

- **恢复是"至多一次/每次启动"的**：恢复尝试先原子落盘 `resumeAttempts`，再执行副作用；同一 bootId 内的热重载（HMR）不会重复恢复；
  未变化的 pid 不会被误判为重启（`bootPid` + `bootId`）。
- **冷会话用官方入口恢复**：`ctx.sessionController.resolveAgent(sessionId)`（会做 agent preset 组装）；
  续接消息通过 `agent.followup(...)` 进入该会话的 next-turn 队列 —— 不用 `sessionController.prompt`，
  因为它的进程内签名是 `prompt(request, signal)` 且会硬编码 human `user` source。
- **续接消息是普通 user message**，`source.kind='continuum'`（非 human authority）、内容明确标记
  `<continuum_resume>`，模型能看到完整历史后自行判断中断点。

## 安装

```powershell
# 在 dsh 里（或对 Agent 说）：把工作区里的这个包安装为 profile bundle
#   plugin_manager install_bundle  target = <本目录绝对路径>
# 等价命令行（需要 dsh CLI）：
dsh plugin --profile desktop add C:\path\to\dsh-autorestart
```

安装后行 id 为 `dsh-autorestart`。本机已经装好并处于 `active`。

## 配置

所有键都有默认值，写在 `cordis.patch.yml` 的 insert 行里；要覆盖就在 profile 的
`~/.dsh/profiles/<profile>/cordis.patch.yml` 里加同名 `- id: dsh-autorestart` 行（**整段替换 config**）。
插件同时导出真实的 `Config` schema（schemastery），所以 Plugin Manager / 配置编辑器里能看到键名、类型与默认值
（见 `GET /__dsh_autorestart/health` 的 `configSchema: true`）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉整个插件 |
| `stateFile` | `''` | 检查点路径；空 = `<DSH_HOME>/storages/dsh-autorestart/state.json` |
| `resumeOnBoot` | `true` | 启动时是否自动恢复 |
| `recoveryDelayMs` | `6000` | 启动后等多久再恢复（给 session store / model 就绪留时间） |
| `maxSessions` | `4` | 一次启动最多恢复几个会话 |
| `maxResumeAttempts` | `2` | 每个会话最多尝试恢复几次（跨启动累计，防重启循环） |
| `deferPollMs` | `3000` | 等 idle 的轮询间隔 |
| `deferSoftMs` | `300000` | 软期限：还在忙就告警 |
| `deferHardMs` | `900000` | 硬期限：超过后告警；只有 `forceRestartWhenBusy` 打开时才强制重启 |
| `deferPolicy` | `auto` | `auto` = 硬期限后按 `forceRestartWhenBusy` 决定（默认继续等）；`wait` = 一直等 |
| `forceRestartWhenBusy` | `false` | 硬期限到了但还有会话在跑时是否强制重启；默认 `false` = **不打断任何会话**，一直等到其他会话结束 |
| `restartMode` | `app` | `app` = 重启 DeepSeek Harness 桌面应用；`command` = 跑 `restartCommand` |
| `restartCommand` | `''` | 自定义重启命令，支持 `{pid}` `{ppid}` `{app}` 占位符 |
| `relaunchDelaySeconds` | `2` | 脱离的 helper 在杀掉应用**之前**等几秒（`ping -n 3`，约 2 秒） |
| `settleMs` | `2000` | 静默窗口（ms）：最后一次会话活动之后，宿主要安静这么久，重启才允许开始 |
| `autoReloadPage` | `true` | `dsh web`：host 重启（bootId 变化）后让页面自动 reload |
| `blockManualRestart` | `true` | 硬拦截 agent 用 shell 命令手动杀掉/重启 DSH，并引导到 `continuum_restart` |
| `healthPath` | `/__dsh_autorestart/health` | 健康检查路由（返回 bootId/pid/phase/自检标志） |
| `continuationText` | `''` | 覆盖默认续接提示文本 |
| `showSleepButton` | `true` | 优雅挂机的月亮按钮是否显示在主界面左上角 |
| `sleepCountdownSeconds` | `10` | 优雅挂机在真正关机前倒数几秒（3–120） |
| `sleepCommand` | `''` | 优雅挂机的自定义关机命令；留空 = 自动识别宿主（Windows 用 `cmd.exe /c …`，其它平台用 `/bin/sh -c …`） |

## Agent 工具与"它怎么知道该用插件"

| 工具 | 作用 |
| --- | --- |
| `continuum_restart` | 请求**优雅重启**：等所有 agent idle 后重启应用，回来自动续接本会话。参数 `reason` / `resume` / `defer_seconds` / `parkGoals`（现在表示"重启前解除 goal 驱动的阻塞"） |
| `continuum_park_goal` | **解除（disarm）**某个会话的 goal，让待重启不再被 goal 卡住；当前那一轮照常跑完，重启之后自动重新上链。参数 `sessionId`（省略 = 调用方自己的会话） |
| `continuum_recover_now` | **立刻重跑恢复**（不用等下一次重启）：重试卡住的会话，返回每个会话的动作 + 原因。参数 `sessionId`（省略 = 所有待恢复会话） |
| `continuum_handoff` | **会话接力**：把一个已经超出模型 context window 的会话交给一个**全新的会话**继续（带去 goal 目标、检查点里记录的接手原因和一段有界的对话尾部），旧会话保留成存档、goal 被解除。参数 `sessionId`（省略 = 调用方自己的会话）/ `maxChars`（默认 `20000`） |
| `continuum_status` | 只读：phase、generation、是否有待重启、检查点路径、识别的重启环境、被记录的会话、每个阻塞会话的阻塞原因、被停泊的 goal |
| `continuum_cancel_restart` | 取消待重启，并释放该会话的续接请求 |

除了工具本身（模型在工具表里能看到名字/描述），插件还有两层保证：

1. **system prompt 段落**（`systemPrompt.section('dsh-autorestart:restart-policy')`，全局、随插件上下线）：
   要重启 DSH 就调用 `continuum_restart`，不要自己 `taskkill`/`Stop-Process`；重启前把进度写进工作区/todo/goal；
   用 `continuum_status` / `continuum_cancel_restart` 查看与取消；**不要求 goal**。
2. **硬拦截工具守卫**（`ctx.tools.guard(...)`，`blockManualRestart` 默认开启）：当 agent 试图通过命令类工具
   （`pwsh` / `bash` / 终端 / `run_code` 等）执行"杀掉或重启 DeepSeek Harness"的命令时，**在 dispatch 之前直接拒绝**，
   返回一段说明并引导改用 `continuum_restart`。命中规则包括：
   - 杀进程类动词：`taskkill` / `Stop-Process` / `pkill` / `kill` / `terminate` / `wmic … delete|terminate` / `kill-port`，
     且命令文本里出现 `DeepSeek Harness`、`DeepSeek*`、`Deep*Harness*` 等进程选择形式；
   - 针对**本 host 进程 pid / 父进程（Electron 主进程）pid** 的 kill；
   - 针对**当前 web 端口**的 `kill-port`（端口从 `webServer.getOrigin()` 读取）；
   - `schtasks /run|/create` 且指向 dsh/deepseek/continuum；
   - **系统级关机/重启**：`shutdown /r|/s|/p|-r|-s`、`Restart-Computer`、`Stop-Computer`（一定会连带杀掉 DSH）。
   普通命令（如 `echo`、`git status`、`git commit -m "…taskkill…"` 不含 DSH 字样、`kill 777`、`npx kill-port 3000`、
   写文件/读文件/网页抓取里提到这些词）不受影响。拒绝次数可在健康路由的 `manualRestartBlocks` 看到。

**残差（诚实说明）**：这是**字符串模式匹配**，不是安全沙箱。编码混淆（`-EncodedCommand`）、按 `node.exe` 镜像名杀进程、
以及命令文本超过 200KB / 嵌套超过 4 层的参数扫描不到；用别的路径（GUI 菜单、外部脚本、系统重启）绕开也不受它管。
它要解决的是"agent 顺手 `taskkill` 自己"，不是防止恶意绕过。

所以**不需要改 AGENTS.md**——这是 Host 插件钩子（工具注册 + system prompt section + tools.guard），对 profile 内所有 agent 生效；
你当然也可以额外在 AGENTS.md 里写一条团队规范，但它只是重复。

## 优雅挂机（Graceful standby）

**它干什么。** 主界面左上角一个月亮按钮：点一下 → 等**所有**会话都收工 → 屏幕上倒数 10 秒（一个巨大的数字 + 一只蓝色小鲸鱼，每秒换一句中文）→ **关掉整台电脑**。倒数期间随时可以取消：覆盖层上有按钮，月亮按钮本身在挂机期间也变成了"再点一下 = 取消"。倒数期间要是有会话又开始干活，倒计时会退回"等待"，**绝不关机**。

**按钮在哪。** 月亮按钮在**主界面左上角、会话标题左边**（`conversation.header.leading` 槽位）。窗口最顶上那一排是 Electron 的原生菜单栏（Windows 上是「文件 / 编辑」，macOS 上是「应用 / 编辑」），**插件加不进去**，所以按钮放在它正下方的 Web 布局左上角。

**关的是真宿主机。** 不是关子系统，是关**整台机器**：

| 宿主 | 执行的命令 |
| --- | --- |
| Windows | `shutdown.exe /s /f /t 0` |
| **WSL**（DSH 跑在发行版里） | `/mnt/c/Windows/System32/shutdown.exe /s /f /t 0` —— 借挂载的 `C:` 盘调 Windows 的程序，所以**关掉的是整台 Windows**；**绝不只关 WSL 子系统** |
| 真 Linux 主机 | `systemctl poweroff`（兜底 `shutdown -h now`） |
| macOS | `osascript -e 'tell application "System Events" to shut down'` |
| 其它平台 | **一条命令都不执行**：按钮不显示，路由报 `phase: "unsupported"` |

WSL 的判定依据：`WSL_DISTRO_NAME`、`WSL_INTEROP`、`/proc/version` 里出现 microsoft，或挂载的 Windows 程序存在。倒数是插件自己做的，所以操作系统被要求**立即**关机（`/t 0`），不会再倒数第二遍。

**三个配置项。**

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `showSleepButton` | `true` | 左上角的月亮按钮是否显示 |
| `sleepCountdownSeconds` | `10` | 真正关机前倒数几秒（3–120） |
| `sleepCommand` | `''` | 自定义关机命令；留空 = 自动识别宿主，填了就用这条命令代替（Windows 走 `cmd.exe /c …`，其它平台走 `/bin/sh -c …`） |

**首次安装会问一次「按钮要不要留着」。** 答完写进 profile 配置的 `showSleepButton` 键（用官方 `configEditor` Service，和备份范围那次问询同一条路），所以设置页和问询看到的永远是同一个值。

**想空跑、不真关机。** 给宿主进程的环境变量设 `DSH_AUTORESTART_SLEEP_DRYRUN=1`：插件只报告"本来会执行什么命令"，**一条都不执行**。

**给代码看的状态字段。** `GET <healthPath 前缀>/sleep`（默认 `/__dsh_autorestart/sleep`）会回答阶段、倒数和"要关的是哪台机器"。其中三个字段是给**程序**看的、不是给人看的：`host.kind` 是机器类别（`windows` / `wsl` / `linux` / `macos` / `unsupported`；如果平台没认出来、但你配了 `sleepCommand`，则是 `custom`）；`host.suspect` 为 `true` 表示这台机器**只凭挂着 Windows 盘**才被认成 WSL（是佐证，不是铁证）；`lastRun.dryRun` 表示上一次是**试运行**，什么都没真关。

**关机命令起不来时的退路。** 宿主会等命令的**真实结果**（进程有没有真的起来）。命令起不来（找不到程序、权限不够）时，挂机**不会假装成功**：状态回到 `idle`，并给出原因（"关机命令没跑起来（…），电脑还开着，可以再点一次月亮按钮。"），电脑保持开机。界面上那个「正在关机」的视图也**不会把界面锁死**：最多停留 8 秒就会给出一个"关掉这个提示"的按钮。

## 需要 goal 吗？

不需要。

| 情况 | 重启后行为 |
| --- | --- |
| 有 active goal | `goals.resume()` 重新武装 → goal round driver 自动开下一轮（可跨多轮持续，直到 goal 完成/预算用尽） |
| 没有 goal | 注入一条 `<continuum_resume>` 续接消息 → 新的一轮把活干完（这一轮结束后不会自动再起一轮） |

也就是说：**goal 是"多轮自动驾驶"的增强项，不是使用前提**。长任务建议用 `create_goal` 获得更强的连续性；
一次性收尾任务不用 goal 也完全能接续。

## Goal 解除（disarm）：重启不再被 goal 卡死

带 durable goal 的会话会自己把自己占住：goal round driver 在 agent 空闲后的几毫秒内就开下一轮，
于是插件的空闲闸门（要 agent idle **且** 静默 `settleMs`）永远打不开，重启就一直等着 —— 而重启
往往正是这个 goal 继续跑下去所需要的。

**为什么不是 pause**：被 `ctx.goals.pause()` 暂停的 goal，模型自己已经没法再 resume（Host 只允许人恢复），
等于把会话停成一个只有人工才能撤销的状态。现在改成**解除（disarm）**：`ctx.goals.disarm(agent)`
只撤掉"进程内的续跑授权"，durable goal 依然是 `active`，所以重启后本插件早就实测通过的恢复路径
（`ctx.goals.resume`）直接适用。

- **解除条件**（全部满足才会解除）：goal 存在、`phase='active'`、`activation='armed'`、
  `roundsStarted < maxGoalRounds`（预算用完的 goal 解除之后再也续不了，只上报、不解除）。
- **解除动作**：`ctx.goals.disarm(agent)`。**当前正在跑的那一轮不会被取消**，它照常跑完（输出照旧留在
  会话日志里，什么都没丢），只是不会再起下一轮；会话因此空闲下来，静默窗口过去，重启就能进行。
- **解除记录**：成功后写检查点记录 `{ goalId, disarmedAt, resumedAt }`（`state.disarmedGoals`）。
- **旧记录兼容**：上一版 pause 实现写下的 `{ goalId, parkedAt, resumedAt }`（`state.parkedGoals`）
  仍然会被容错读取和修复，所以那一版暂停掉的 goal 重启后照样能恢复。

**能不能解除只看 goal 的实时状态**：判定依据只有它当下的 `phase` / `activation` / 轮次预算 ——
`active` + `armed` 且 `roundsStarted < maxGoalRounds` 才解除，其余情况（用户暂停、blocked、complete、
预算用尽、已经没有续跑授权）只上报原因。检查点里的记录**只用于上报**（`continuum_status` 里让人看见
这个插件解除过什么、恢复了没有），它**永远不会否决一次解除**：一个被恢复过（于是又是 `armed`）的 goal
必须能再解除一次，否则重启会一直等一个再也解不掉的 goal —— 那正是这个功能要消灭的死锁。每次新的解除
都会**覆盖**该会话的记录（`kind=disarmed`、新的解除时间、`resumedAt=null`），所以旧版 pause 实现留下的
记录也拦不住后来的解除；每次本插件把 goal 重新武装（boot 恢复、旧版 paused goal 的恢复、手动重试），
都会给记录打上恢复时间戳，让状态里显示它已经恢复。插件被重新应用（禁用再启用、热重载）时，
**工具和路由一起释放**：工具的 disposer 和路由一样交给 `ctx.effect` 由宿主持有，旧实例不会留下残留的
工具，新实例也不会撞上"重复注册"，于是 host 不会出现"工具属于旧实例、路由属于新实例"的错位。
- **恢复（boot）**：
  1. goal 是 `active` + `disarmed` 且有本插件的解除记录 → `ctx.goals.resume()` 重新上链（`resume-disarmed-goal`）；
  2. goal 是 `paused` 但有**旧版 parked 记录**且 goal id 一致 → 这是我们自己暂停的，可以 resume（`resume-paused-goal`）；
  3. goal 是 `active` + `disarmed` 且没有记录 → 走既有路径重新上链（`rearm-goal`）；
  4. resume 失败（revision 过期 / 预算用完）→ 回落到续接消息，**记录保留**，下次 boot 或手动重试还能再试一次。
     **用户自己暂停的 goal（没有记录）永远保持暂停。**

解除默认开启（**不需要任何配置**），也可以按次关闭：

- `continuum_restart` 的参数 `parkGoals`（默认 `true`，语义现在是"重启前解除 goal 驱动的阻塞"）。
  传 `false` 时什么都不解除，返回的提示会说明：goal 驱动的会话可能让重启一直等着。
- 工具 `continuum_park_goal`（参数 `sessionId?`，省略时是调用方自己的会话）：手动解除某个会话的
  goal，返回 `{ ok, disarmed, goalId, reason }`；不能解除时给出原因（例如预算用完 → `goal-exhausted`）。
- 新工具 `continuum_recover_now`（参数 `sessionId?`）：**立刻重跑恢复**，不用等下一次重启；
  返回每个会话的动作与原因。卡住的会话（agent 还没起来、resume 失败）用它重试。
- 路由：`POST <healthPath 前缀>/park`（保留给旧客户端，语义已经是解除）和新的
  `POST <healthPath 前缀>/recover`（默认 `/__dsh_autorestart/recover`，body `{ sessionId?: string }`）。
  两条都和健康路由同一套鉴权规则（loopback，或被连接服务放行的请求）。

`continuum_status` 会说明每个阻塞会话为什么阻塞：`goal-active`（被 armed 的 goal 占住，可解除）、
`goal-exhausted`（轮次预算用完，没法再继续）、`goal-paused` / `goal-blocked` / `goal-complete` /
`goal-disarmed`（已经没有续跑授权可以拿掉）。同时会列出解除过的 goal
（session id / goal id / disarmedAt / resumedAt，以及是否恢复成功），以及**每个会话上次恢复的动作与原因**：
`recovery: [{ sessionId, action, detail, pending, attempts, error }]`。`action` 取值：
`resume-disarmed-goal` / `resume-paused-goal` / `rearm-goal` / `prompt-continuation` /
`agent-not-live` / `session-controller-unavailable` / `goal-lookup-failed` / `prompt-failed` / `nothing`。
`?state=1` 路由同样返回 `recovery`、`parkUrl`、`recoverUrl`。

### 解除的残差限制（诚实说明）

- **轮次预算用完的 goal 没法继续**：`roundsStarted >= maxGoalRounds` 时解除它等于把后续轮次丢掉，
  所以只上报 `goal-exhausted`，不解除 —— 需要人工给这个会话一个新的 goal。
- **agent 还没活着的会话需要重试**：boot 恢复可能比 profile 加载 agent 更早，那个会话会记
  `agent-not-live` 并保持 pending；下一次 boot 会自动再试，也可以 `continuum_recover_now`
  （或 `POST /recover`）立刻重试。
- **解除后一直没被恢复的 goal 会留在检查点里**：只有恢复成功（或很久之后被清理）才会写上 `resumedAt`，
  这样下一个 boot 还能把它补回来；`continuum_status` 里一直能看到它。
- **goal 查找失败不会静默跳过**：`goals.get` 抛错时记 `goal-lookup-failed`，仍然注入续接消息让会话继续推进。

## 会话接力（上下文超限的救援）

- **它救的是哪种死局**：一个会话累积的对话超过了模型的 context window 之后，它**任何请求都跑不动**了 —— 供应商直接回
  `invalid_request_error`（说上下文超限）。而且**宿主自己的 compaction 也救不了**：压缩请求本身需要同一份超大的上下文，
  于是这个会话既不能继续、也不能被压缩，就卡在那里。
- **工具**：`continuum_handoff`，参数 `sessionId`（要接力的会话；省略 = 调用方自己的会话）和 `maxChars`
  （带走的对话尾部的字符预算，默认 `20000`）。
- **路由**：`POST <healthPath 前缀>/handoff`（默认 `/__dsh_autorestart/handoff`），body
  `{ "sessionId": "<会话 id>", "maxChars": 20000 }`；鉴权规则和健康路由**完全一致**（loopback，或被连接服务放行的请求）。
  路由没有"调用方会话"这个默认值，所以不传 `sessionId` 会直接被拒（`no-session`）。
- **带过去的东西**（顺序固定）：goal 的 **objective**（目标）、检查点里记录的**接手原因**（`reasons`，最新的在前）、
  以及对话的**有界尾部** —— 尾部按 plain text 渲染：文本消息渲染成 `角色: 内容`，**tool call / tool result 压成一行、
  只留工具名**（工具的载荷不带）。再早的内容**全部丢弃**。
- **旧会话的命运**：**保留**，并被标记为"已接力"（检查点里记 `handoff`：目标会话 id、接力时间、带走的字符数）；
  它的 goal 被**解除（disarm）**，于是它不再发出注定失败的请求；插件**永远不会再自动恢复它**
  （带 `handoff` 记录的会话会被 `recoverableSessions` 跳过）。旧会话的历史仍然完整可读，当作存档留着。
- **新会话**：在**同一个工作目录**下新建一个 live session，把上面那段接力文本作为一条
  `<continuum_handoff>` 续接消息投进去，agent 那边就能接着干活。

### 接力的限制（诚实说明）

- **源会话必须在当前进程里活着**：读不到它的消息就什么也做不了（`source-session-not-live`）——
  所以先在侧边栏把那个会话**打开一次**，让它进入本进程的 live 会话表。
- **源会话的 header 里必须有绝对工作目录**，否则没法在同样的目录下建新会话（`source-cwd-unknown`）。
- **带过去的是尾部摘要，不是完整历史**：更早的对话已经被丢弃，模型在新会话里看不到。
  目标（objective）和检查点里记录的原因还在，所以活儿一般接得上，但细节可能要重新说一遍。
- **接力是"一次性的"**：每个会话只会被接力一次，接力之后它就退出自动恢复路径了。

## 上下文超限保险

- **重启后重新武装 goal 之前，插件先判断这个会话是不是已经超过模型的 context window**。
  证据只取自**活着的会话**：最后一条 assistant 消息的 `usage.inputTokens` 对上该会话 request 的 `contextWindow`
  （**用超了**才算超限），以及最近一轮消息 / 事件里"上下文超限"类的报错。
  数字拿不到时**一律不算超限** —— 不知道窗口大小永远不会挡住正常的恢复路径。
- **一旦判定超限**，插件**拒绝**重新武装那个 goal，也**不排**续接消息（这两件事都只会失败）；
  改为把 `lastRecoveryAction` 记成 `context-overflow`（数字知道的话一并记下 `inputTokens` / `contextWindow`），
  并且**期待一次接力而不是一次重试** —— 该做的事是 `continuum_handoff`，不是再试一遍。
- **状态里看得见**：`continuum_status` 和 `?state=1` 的 `handoffs[]` **按会话**列出两件事：
  这个会话**是不是被接力过**（目标会话 id + 接力时间），以及**是不是已经超限**（`overContextLimit`）。
  这两类会话都不在自动恢复路径里，所以必须单独报出来，否则它们会从状态里凭空消失。

## 健康检查

```powershell
curl http://127.0.0.1:<当前 GUI 端口>/__dsh_autorestart/health
# {"ok":true,"plugin":"dsh-autorestart","bootId":"…","pid":17884,"phase":"running",
#  "pageHeartbeat":true,"systemPrompt":true,"configSchema":true,"indexTaps":2,…}

# 自检：把页面心跳注入逻辑作用到一段探针 HTML 上（不需要鉴权页面）
curl "http://127.0.0.1:<端口>/__dsh_autorestart/health?probeIndex=1"

# 解除某个会话的 goal，让待重启不再被 goal 卡住（鉴权规则同健康路由；旧路径，语义已是解除）
curl -X POST http://127.0.0.1:<端口>/__dsh_autorestart/park \
  -H "content-type: application/json" \
  -d "{\"sessionId\":\"<会话 id>\",\"restart\":true}"

# 立刻重跑恢复（不用等下一次重启）；body 的 sessionId 可省略 = 所有待恢复会话
curl -X POST http://127.0.0.1:<端口>/__dsh_autorestart/recover \
  -H "content-type: application/json" \
  -d "{\"sessionId\":\"<会话 id>\"}"
```

`bootId` / `pid` 每次**新进程**变化（重启后立刻能看出换了进程）。`autoReloadPage` 打开时，
`dsh web` 页面会轮询该路由；发现 `bootId` 变了就自动 `location.reload()`，不用手动刷新。

## 验证与已知限制

- **真实重启端到端已实测通过**：agent 自己调 `continuum_restart` → 等空闲 → WMI 脱离进程树 `taskkill` + 重启应用 →
  新 host 进程（pid `6560 → 17884`、bootId 更新、端口 `60909 → 65403`）自动 `resolveAgent` + 注入续接消息，
  **无人工输入**地开始下一轮继续原任务。证据见 `verification/e2e-restart-result.md`。
- **system prompt 钩子已实测**：启用后 agent 的 system prompt 中出现 `## Restart policy (dsh-autorestart)`；禁用插件后消失。
- **手动重启硬拦截已实测**：`pwsh` 执行 `echo taskkill /IM "DeepSeek Harness.exe" /T /F`（故意用 echo，即使守卫失效也不会
  真的杀进程）在 dispatch 前被拒绝；`Stop-Process -Name "DeepSeek*"`、`wmic … call terminate`、`npx kill-port <当前端口>`
  三种形态同样被拒；随后 `echo autorestart-guard-final-ok` 正常执行；`health.manualRestartBlocks` 计数递增。
  `blockManualRestart: false` 可关闭。
- **页面心跳已实测**：`health.pageHeartbeat=true`，`?probeIndex=1` 返回注入后的 HTML（含 `data-dsh-autorestart-heartbeat`）。
- **Config schema 已实测**：`Config.listConfigs` 对该行返回 `status: "schema"`（17 个键 + 默认值齐全）；`health.configSchema=true`。
  （注：profile 里的 linked bundle 用真实路径解析，找不到 `@deepseek-ai/schemastery`；插件会回退到
  `<dsh 安装目录>/app.asar/dsh/node_modules/@deepseek-ai/schemastery/lib/index.mjs` 加载。健康路由的
  `schemastery` 字段只报告粗粒度来源 `bare` / `asar-fallback` / `unresolved`；schema 缺失时降级为"配置照常可用、
  只是没有可视化 schema"，并在日志里给出警告，**不会**因此让插件激活失败。）
- 测试：**236 个插件用例全绿**（`plugins/dsh-autorestart/test/*.test.mjs`，其中 goal 解除 / 自述式恢复 /
  `continuum_recover_now` / `/recover` 路由 / 优雅挂机（宿主侧状态机 + 前端纯函数）是新增的用例）。运行：
  `<bundled node> --test "plugins/dsh-autorestart/test/*.test.mjs"`
  （Node 24 把位置参数当 glob，务必加引号）。
  注意：仓库外的 `verification/adversarial.test.mjs` 里仍是"只注册一条/两条路由"的旧断言（插件现在注册
  健康 + park + recover + handoff + choice + sleep 六条），该文件不在本插件改动范围内。
- 独立验证员复验：`verification/verify-report.md`。
- WMI 脱离进程树已实测（`Invoke-CimMethod Win32_Process Create` 的子进程 parent 是 `WmiPrvSE.exe`）。
- 健康路由在"开机时激活"的情况下会短暂晚于 webserver 就绪，插件会重试注册（≤30 次 × 2s）。
- **限制**：`restartMode: app` 只对 DSH Desktop 生效；`dsh web`/CLI 部署请设 `restartMode: command` 并给出你们自己的重启命令。
- 手动重启守卫是**模式匹配**（命令文本里 kill/restart 动词 + DSH 字样或本进程 pid）；如果你自己写了绕过它的脚本（例如
  编码混淆后再执行），守卫生效前提是文本可被识别。它防的是"agent 顺手 taskkill"，不是安全边界。
- 重启会关闭并重新打开桌面窗口（这是整应用重启，不是热重载）。
- 杀进程后没有二次确认：若助手进程创建成功但 `taskkill`/`start` 本身失败，会停在 `phase: restarting` 直到下次启动。
- 若进程在 **turn 结束时恰好** 被杀，checkpoint 可能仍记着 running，最多导致一次多余的续接提示。
- 恢复出的新一轮会消费 API token（和人工催"继续"一样）。

## 目录

```
index.js             插件入口：apply / 事件跟踪 / 工具 / 健康路由 / 启动恢复
lib/checkpoint.js    原子 JSON 检查点，容错读取，boot/restart/session/解除记录（含旧 parked 记录）变更函数
lib/lifecycle.js     纯决策：bootPlan / restartDecision / selectGoalDisarms / continuationPrompt / describeState
lib/restart.js       Windows 脱离重启（WMI 主、schtasks 兜底、dryRun、自定义命令）
lib/sleep.js         优雅挂机：识别真宿主机（含 WSL）、关机命令、等待→倒数→关机的状态机
locale/{en,zh}.json  Plugin Manager 显示用标题/描述
icon.svg             插件图标
LICENSE              MIT 许可（发布到插件市场需要）
test/                node:test 用例（状态机 / 检查点 / 重启命令 / goal 解除 / 集成恢复 / recover_now）
```


## Two-gate restart safety

A restart is never scheduled while another DSH conversation is still working.

1. Conversation gate: busyAgents() inspects every live agent (subagents and
   teammates included). An agent blocks the restart when its status is 'running'
   or when it still has queued inbox work (inbox.nextTurn / inbox.nextStep, or
   inbox.hasPending). The verdict is { allow:false, reason:'conversation-active',
   blockedBy:[...] }.
2. Settle gate: even with no busy conversation, the host must have been quiet for
   settleMs (default 2000 ms) since the last observed activity (agent/status,
   session/event, agent/inbox/inserted). Otherwise the verdict is
   { allow:false, reason:'settling' }. This closes the gap between the decision
   and the detached helper's ping delay, where a new turn could otherwise start
   and be killed.

The gate is evaluated three times: in the poll tick, again right after the
pre-restart session flush (before anything is scheduled), and once more inside the
detached helper (restart-<generation>.cmd in the state-file directory). The helper
GETs http://127.0.0.1:<webPort><healthPath>?gate=1 and exits without killing when
the gate denies the restart or the request fails.

Because a denied helper leaves this process alive, a watchdog armed for
relaunchDelaySeconds + 20 seconds treats that as a gate abort: it logs, increments
restart.gateAborts, rolls the checkpoint back to phase 'deferred' (decrementing
attempt so a later retry is allowed) and polls again. After more than 20 gate
aborts the plugin logs an error and schedules one ungated restart instead of
retrying forever. Even that ungated fallback re-checks the same gate before
anything is scheduled, so a busy conversation is never killed.

The hard deadline (deferHardMs) only warns: it forces a restart over a running
conversation only when forceRestartWhenBusy is enabled; by default it waits for
the other conversations, because a restart must never kill a conversation that is
still working.

Inspect the live verdict with continuum_status (gateAllow, quietForMs, blockedBy)
or by requesting the health path with ?gate=1.
## 多会话合并重启（coalescing）

- 多个会话同时调用 `continuum_restart` 时，请求会**合并成一次进程重启**：`generation` 仍然每次 +1，但 `restart` 会被替换为包含所有请求者的记录。
- `restart.requesters` 保存每个请求会话 `{ sessionId, requestedAt, reason, resume }`（按新到旧排序，最多 16 个）；`restart.bySessionId` 仅保留最后一个请求者以兼容旧逻辑。
- 每个请求者都会被标记 `pendingResume`，重启后**全部**被唤醒；`continuum_cancel_restart`（以及放弃重试/回滚路径）会一次性释放**所有**请求者，而不是只释放最后一个。
- 启动恢复按 `maxSessions` 分批执行，每批之间等待 `recoveryBatchDelayMs`（默认 1200ms），最多 5 批，因此一轮启动就能唤醒多于 `maxSessions` 的会话；只有超过批次上限时才会留到下一次启动。
- `resolveAgent` 在同一轮启动内最多重试 2 次（`resumeRetryDelayMs`，默认 1000ms）；最终失败会写入 `lastResumeError` 并保持 `pendingResume`，该字段也会出现在 `continuum_status` 的每个会话条目中。达到 `maxResumeAttempts` 后 `pendingResume` 被清除并记录最后的错误，避免坏会话无限重试。

## UI：等待重启小胶囊 + 侧边栏圆点

- 胶囊渲染在**输入框工具行左侧**（`conversation.input.left` 槽位），是一个高度约 22px 的小胶囊，**不额外占一行**（不再是输入框上方的一整行）。
- 只有当健康路由 `/__dsh_autorestart/health?state=1` 返回 `pendingRestart: true` **且**本会话 id 出现在 `waiters` 列表里时才会出现；别的会话等待重启时你看不到它。
- 文案有多种状态：还有别的会话占着时显示「待重启 · 被 N 个会话占用」；都空闲时显示「待重启 · 空闲后自动重启」；被某个会话**自动续跑的 goal** 占着时显示「待重启 · 被某个会话自动续跑的 goal 占着」（见下面的升级 3）。
- 悬停提示（原生 `title`）：「等待其他会话空闲后自动重启；重启后会自动继续本会话进度」。
- 颜色走**品牌色（蓝紫）** `var(--dsw-alias-brand-primary, #5b8def)`，**不再用告警黄（warning）色**：胶囊里的小圆点和侧边栏圆点都是品牌色，胶囊边框保持中性（`--dsw-alias-border-l1`），文字保持中性。
- 左侧边栏会话行的**行首 16px 状态格**里也会出现一个同款 8px 圆点（`sidebar.session.row.leading` 槽位，id `autorestart-restart-dot`，order 20）：纯图标，完整说明放在悬停 `title` 里，aria-label 为「待重启」/「Pending restart」。
- 那个 16px 状态格会被**优先级更高的行状态**（ask / 未读 / 运行中）替换，所以圆点只在该行**空闲**时出现。
- 胶囊与侧边栏圆点**共用同一个 2 秒轮询**（客户端只有一条 2s 定时器 + 一次 fetch，不是各轮各的）；重启一旦真正触发、状态里的 `pendingRestart` 变成 false，两个界面同时自动消失。
- 胶囊是**行内紧凑**的：`flex: none` + 固定高度，不撑高工具行；文字过长时按省略号截断（`white-space: nowrap` + `text-overflow: ellipsis`），不换行也不溢出。
- 工具行左侧的胶囊与费用条等其它 dock 条目互不影响：不依赖 `position:absolute/fixed`、不使用负 margin，也不新增兄弟元素。
- 客户端这一半（`client.js`）需要**刷新页面或 DSH 重启后**才会加载进前端，Host 端改动则随插件热更新生效。

### 升级 1：重启在即时的呼吸脉冲

- 当 `?state=1` 返回 `pendingRestart: true` **且** `allowRestart: true`（Host 的空闲闸门已开，重启随时都会发生）时，胶囊里的小圆点和侧边栏圆点都会**轻微呼吸**：`scale(1) -> scale(1.5) -> scale(1)`，同时透明度略微下沉。
- 动画只动 `transform` 和 `opacity`，**不改变布局**（不动 `width` / `height`），所以工具行不会被撑开。
- `@keyframes dsh-autorestart-pulse` 只往 `<head>` 里注入**一条**规则（按 id `dsh-autorestart-pulse` 去重），两个界面共用；最后一个订阅者离开时这条规则会被移除。
- 通过 `animation` 样式属性应用；系统开启「减少动态效果」（`prefers-reduced-motion: reduce`）时**不播放**任何动画。

### 升级 2：点胶囊看详情

- 胶囊现在是**可点击**的：`cursor: pointer`、`role="button"`、`tabIndex=0`、`aria-expanded`，鼠标点击以及 **Enter / Space** 都能展开或收起。
- 展开后是一个锚定在胶囊上方的小详情面板（胶囊外层 `position: relative`，面板 `position: absolute`、`bottom: 100%`、左对齐、`min-width: 260px`、圆角、小阴影、字号 12；背景 / 边框 / 文字颜色走宿主主题 token）。
- 面板内容：一行标题「待重启」；一行当前状态（**等待其他会话空闲** / **等待空闲窗口**）；**每个占用会话一行**（Host 给了标题就显示标题，没给就显示「有一个会话正在运行」）；一行**已等待时长**（客户端从第一次看到 pending 状态开始计时）；一行「重启后本会话会自动继续进度」。
- 点击面板外部或按 **Esc** 关闭；所有监听器和计时器在卸载时都会清理。
- 没有 pending 重启时整个组件**什么都不渲染**，绝不会影响输入框。

### 升级 3：goal 卡住时的胶囊状态 + 一键停泊并重启

- 当 `?state=1` 的 `blockedBy[]` 里出现 **goal 驱动的占用**时，胶囊会换一种状态文案：reason 为 `goal-active` 表示**某个会话的 goal 在自动续跑**（它自己就把重启一直占着），reason 为 `goal-exhausted` 表示**那个 goal 的轮次额度已经用完、没法再续跑**。
- `goal-active` 的条目会在胶囊里给出一个「**停泊并重启**」按钮：点击后客户端 `POST /__dsh_autorestart/park`（鉴权规则同健康路由），body 为 `{ "sessionId": "<占用会话>", "restart": true }`——Host 会**停泊那个 goal**（于是它不再自动续跑）并把**当前会话登记为待重启的请求方**，重启随即就能推进，重启后该 goal 会被自动恢复。
- `goal-exhausted` 的条目**不给按钮**：它的 goal 无法被继续，停泊也没有意义，胶囊只把原因说清楚。
- 请求在飞的时候按钮是**禁用**的（文案变成「停泊中…」）；失败时（比如 Host 回 **403** 或 **409**）在详情面板里显示一行**内联错误**，内容是 Host 自己给的那条消息。
- Host 停泊过的 goal 会通过 `?state=1` 的 `parkedGoals` 回报：胶囊上多一行「已停泊 N 个 goal，重启后自动继续」，详情面板里逐条列出**会话 id 与 goal id**。
- 胶囊依旧保持**单根、自居中、行内紧凑**：按钮是胶囊内部的子元素，复用胶囊自己的按钮样式，没有 `position:absolute/fixed`、没有负 margin，也没有在工具行里新增兄弟元素。

### `?state=1` 响应字段

```json
{
  "ok": true,
  "pendingRestart": true,
  "phase": "restarting",
  "generation": 3,
  "waiters": ["sess-a", "sess-b"],
  "blockedBy": [{ "sessionId": "sess-c", "reason": "running", "title": "重构解析器" }],
  "allowRestart": false,
  "quietForMs": 1200,
  "settleMs": 2000,
  "updatedAt": 1730000000000,
  "parkUrl": "/__dsh_autorestart/park",
  "parkedGoals": [{ "sessionId": "sess-c", "goalId": "goal-3", "parkedAt": 1730000000000, "resumedAt": null }]
}
```

- `blockedBy[]` 的每一项在原有字段（`sessionId`、`reason`）之外，可能多一个**可选的 `title`**：Host 会尽力从会话控制器（`ctx.get('sessionController').list({})`）里读出该会话的标题。
- 这是**尽力而为**：查不到标题就**不带 `title` 字段**，原有字段和行为完全不变；会话控制器缺失、抛错或没有标题都**不会**让这条路由失败。
- 标题查询结果会缓存约 **5 秒**（客户端每 2 秒轮询一次，不会把会话列表打成风暴）。
- `blockedBy[]` 里的 `reason` 可能是 **goal 相关**的：`goal-active`（持有一个会自动续跑的已武装 goal）、`goal-exhausted`（goal 的轮次额度用完，无法继续）等；此时原本的占用原因保留在 `busyReason` 里。
- `parkUrl` 是停泊路由的绝对路径（由配置的 `healthPath` 前缀推导），客户端优先用它，而不是自己猜路径。
- `parkedGoals` 与 `continuum_status` 上报的列表一致：本插件停泊过的每个 goal 的 `sessionId`、`goalId`、`parkedAt`、`resumedAt`（以及派生的 `resumed`）。

## 平台与部署

| 部署形态 | `restartMode` | 怎么重启 |
| --- | --- | --- |
| DeepSeek Harness 桌面应用 | `app`（默认） | 用宿主内置的**应用重启**能力：脱离进程树地杀掉并拉起桌面端 |
| 托管的 `dsh web` 部署 | `command` | 桌面端那套「重启应用」在 web 部署里不存在，必须自己给一条重启命令 |

托管 `dsh web` 的配置（注意是**整段替换 config**，不是合并）：

```yaml
- id: dsh-autorestart
  config:
    restartMode: command
    restartCommand: systemctl --user restart dsh-web
```

`restartCommand` 里可以用占位符 `{pid}`（当前宿主）、`{ppid}`（它的父进程）、`{app}`（桌面端路径）。

**不配这个，重启就会失败，而且失败是有提示的**：托管宿主不是桌面端，插件没有「重启应用」的能力，
日志里会出现
`no restart method available (not the desktop app and restartCommand is empty); leaving the checkpoint in place`，
待重启会被回退（退避后重试一次，再失败就取消，不会永远重试），**不会有任何进程被拉起** —— 只是把检查点
留在盘上，等你手动把宿主再起一次时它会接着跑。`continuum_status` 在取消之前会一直报待重启状态。

同一个 profile 行也是首次安装那次提问的落点：**托管 profile 如果自己没有 `dsh-autorestart` 行**，
`configEditor` 就没有行可写，答案会退到 `<DSH_HOME>/storages/dsh-autorestart/install-choice.json`
而不是 profile 配置；声明这一行才能让 profile（以及设置页）保持唯一真相。

- **浏览器侧的「待重启」小胶囊**依赖 `GET <healthPath>?state=1` 这条状态路由。这条路由现在接受
  **loopback 调用者**，*或* **宿主 connection 服务判定为「已认证浏览器」的请求**
  （`connection.requestRejection` 不给拒绝码就放行）。所以：**托管部署必须允许已认证浏览器访问这条状态路由**，
  否则远程浏览器拿不到 pending 标记，小胶囊永远不出现。
  两者都不成立时仍然返回 `403 {"ok":false,"error":"loopback-only"}`。
- 宿主没有 connection 服务时（例如更老的宿主版本），行为不变：仍然只接受 loopback。
- **两段等待现在都是 2 秒，且互相独立**：
  - `settleMs`（默认 `2000` ms）：最后一次会话活动之后，宿主必须静默这么久，重启才允许开始；
  - `relaunchDelaySeconds`（默认 `2` 秒）：脱离的 helper 在杀掉应用**之前**等这么久（`ping -n 3`，约 2 秒）。

  两个值都可以在 profile 的 config 里单独覆盖；把 `settleMs` 调大会更保守（更不容易打断刚起步的会话）。

## 发布到插件市场

```powershell
# 1. 打包
npm pack                 # -> dsh-autorestart-0.2.1.tgz
# 2. 发布到 registry
npm publish
# 3. 从市场安装
#    dsh CLI：dsh plugin install dsh-autorestart
#    或直接对 Agent 说：把 dsh-autorestart 装到当前 profile
```

`package.json` 里已经带齐市场需要的元数据：MIT license、`keywords`、`repository`，以及
`dsh.compatibility.dshReleases`（声明在 DSH `0.2.1-rc.2` 上实测兼容）。
改了代码记得重新 `npm pack`——市场里装的是 tarball，不是工作区目录。

## AI 生成声明

本插件由 AI 生成，**未经人工代码审核**。它会重启你的 DSH 进程并读写本地状态文件。请先在测试 profile 里验证行为符合预期，再用于日常/生产 profile；使用风险由使用者自行评估。

This plugin was generated by an AI and has **not been reviewed by a human**. It restarts your DSH process and writes local state files. Verify it in a test profile before using it in your working profile.
