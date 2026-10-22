# dsh-autorestart

> **包名说明**：原先的包名在公共 npm registry（npmjs.com）上已被其他作者占用，因此本包更名为 **dsh-autorestart**。

**重启不断线 / Cross-restart continuation for DeepSeek Harness (dsh).**

Agent 在 DSH 重启（插件升级、应用崩溃、用户关闭再打开）之后，可以**自动接续重启前没做完的工作**，不需要人再发一条"继续"。
This Host plugin makes a DSH restart a *resumable* event instead of a dead end: a durable checkpoint, automatic
session resume on boot, durable-goal re-arm, and an agent-callable idle-aware graceful restart.

> 目标与社区插件 [dsh-phoenix](https://github.com/StvLi/dsh-phoenix) 相同，但这一版为 **Windows + DSH Desktop** 原生实现：
> 不依赖 systemd，使用 WMI/schtasks 脱离将要被销毁的 Electron 进程树来重启应用。

---

## 它解决什么

| 场景 | 没有它 | 有它 |
| --- | --- | --- |
| Agent 正在跑长任务，DSH 被重启/崩溃 | 这一轮丢失，必须人工催"继续" | 新进程启动后自动 resume 该会话并注入续接提示，继续干活 |
| Agent 有一个持久 goal（`create_goal`）跨重启 | goal 的 activation 是进程内的，重启后变回 `disarmed`，自动续跑停止 | 启动时重新 `goals.resume()`，goal round driver 立刻开始下一轮 |
| Agent 想装/升级插件但"重启必打断" | 只能等或赌 | 调 `continuum_restart`：等所有 agent idle（当前这一轮跑完）再重启，回来自己接着做 |

## 工作方式

```
agent/status(running) ──► 写 checkpoint（<DSH_HOME>\storages\dsh-autorestart\state.json，原子写）
        │
        ├─ continuum_restart 工具：checkpoint 标记 pendingResume + generation+1，轮询等 idle
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

## Agent 工具与"它怎么知道该用插件"

| 工具 | 作用 |
| --- | --- |
| `continuum_restart` | 请求**优雅重启**：等所有 agent idle 后重启应用，回来自动续接本会话。参数 `reason` / `resume` / `defer_seconds` |
| `continuum_status` | 只读：phase、generation、是否有待重启、检查点路径、识别的重启环境、被记录的会话 |
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

## 需要 goal 吗？

不需要。

| 情况 | 重启后行为 |
| --- | --- |
| 有 active goal | `goals.resume()` 重新武装 → goal round driver 自动开下一轮（可跨多轮持续，直到 goal 完成/预算用尽） |
| 没有 goal | 注入一条 `<continuum_resume>` 续接消息 → 新的一轮把活干完（这一轮结束后不会自动再起一轮） |

也就是说：**goal 是"多轮自动驾驶"的增强项，不是使用前提**。长任务建议用 `create_goal` 获得更强的连续性；
一次性收尾任务不用 goal 也完全能接续。

## 健康检查

```powershell
curl http://127.0.0.1:<当前 GUI 端口>/__dsh_autorestart/health
# {"ok":true,"plugin":"dsh-autorestart","bootId":"…","pid":17884,"phase":"running",
#  "pageHeartbeat":true,"systemPrompt":true,"configSchema":true,"indexTaps":2,…}

# 自检：把页面心跳注入逻辑作用到一段探针 HTML 上（不需要鉴权页面）
curl "http://127.0.0.1:<端口>/__dsh_autorestart/health?probeIndex=1"
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
- 测试：**88 个插件用例全绿**（`plugins/dsh-autorestart/test/*.test.mjs`）。连同对抗回归共 113 个用例，现已全绿；
  `verification/adversarial.test.mjs` 的 "bundle patch advertises only config keys the code implements" 原先仍断言旧的
  4 秒默认值（`relaunchDelaySeconds: 4`），已随这次 2 秒默认值一起更新为 2。运行：
  `<bundled node> --test "plugins/dsh-autorestart/test/*.test.mjs" "verification/adversarial.test.mjs"`
  （Node 24 把位置参数当 glob，务必加引号）。
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
lib/checkpoint.js    原子 JSON 检查点，容错读取，boot/restart/session 变更函数
lib/lifecycle.js     纯决策：bootPlan / restartDecision / continuationPrompt / describeState
lib/restart.js       Windows 脱离重启（WMI 主、schtasks 兜底、dryRun、自定义命令）
locale/{en,zh}.json  Plugin Manager 显示用标题/描述
icon.svg             插件图标
LICENSE              MIT 许可（发布到插件市场需要）
test/                node:test 用例（状态机 / 检查点 / 重启命令 / 集成恢复）
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
- 文案有两种状态：还有别的会话占着时显示「待重启 · 被 N 个会话占用」；都空闲时显示「待重启 · 空闲后自动重启」。
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
  "updatedAt": 1730000000000
}
```

- `blockedBy[]` 的每一项在原有字段（`sessionId`、`reason`）之外，可能多一个**可选的 `title`**：Host 会尽力从会话控制器（`ctx.get('sessionController').list({})`）里读出该会话的标题。
- 这是**尽力而为**：查不到标题就**不带 `title` 字段**，原有字段和行为完全不变；会话控制器缺失、抛错或没有标题都**不会**让这条路由失败。
- 标题查询结果会缓存约 **5 秒**（客户端每 2 秒轮询一次，不会把会话列表打成风暴）。

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
npm pack                 # -> dsh-autorestart-0.2.0.tgz
# 2. 发布到 registry
npm publish
# 3. 从市场安装
#    dsh CLI：dsh plugin install dsh-autorestart
#    或直接对 Agent 说：把 dsh-autorestart 装到当前 profile
```

`package.json` 里已经带齐市场需要的元数据：MIT license、`keywords`、`repository`，以及
`dsh.compatibility.dshReleases`（声明在 DSH `0.2.1-rc.2` 上实测兼容）。
改了代码记得重新 `npm pack`——市场里装的是 tarball，不是工作区目录。
