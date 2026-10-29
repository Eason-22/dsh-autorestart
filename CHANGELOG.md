# Changelog

## 0.8.3 — 2026-10-29

**重启阶段搬到界面正中：不再挤在输入框那一行被截断，靠数字说话，也不是常驻。**

### 现场（真机截图）

阶段那行字挤在输入框工具行的小胶囊里（22px 高、一行宽）。窗口不宽时「正在等待所有会话空闲…（还有 1 个会话在忙）」被省略号吃掉，用户看不出卡在哪、还要不要等。另一次截图里浮层上的「等待会话空闲」挂了十分钟不消失——那笔重启只是在**排队等空闲**，其实什么动作都没在跑。

### 改

- **阶段改为主界面居中浮层**（`shell.overlay` 槽位，id `autorestart-restart-overlay`）：320px 固定宽、水平垂直居中、圆角、半透明，`pointer-events: none`——点哪里都照样点到下面的界面，不挡输入。
  - `snapshotting`：「DSH 重启前备份中」+ **真实进度条** + 「12.3 / 40 MB」+ 百分比（数字来自拷贝循环的实测字节，没测到就一个数字都不写）；
  - `restarting`：「正在重启…」，一直挂着，直到宿主真的退出；
  - `back`：「已回来」，**1.5 秒**后自动消失；
  - `waiting`：**浮层不出现**——只是排队等空闲，没有任何动作在跑，会话数交给胶囊去说；
  - state.json 里残留的旧阶段（`pendingRestart === false`）和页面的第一帧，都**不画**。
- **窄窗按字号缩放，不截断**：浮层里没有 `text-overflow`、没有省略号、不换行；窗口不够宽时用 `clamp()` 缩字号，数字永远完整可读。
- **底部胶囊恢复短句**（≤12 字、单行）：等空闲时「待重启 · 空闲后自动重启」/「待重启 · 等待 N 个会话」；备份中 / 重启中 / 回来时整行换成「重启前备份中」/「正在重启…」/「已回来」。长句只留 tooltip，细节全部交给浮层。
- **胶囊与面板的数字同源**：修掉「胶囊说还有 1 个会话、点开面板却说等 0 个任务」。两处现在读同一个 `blocking` 数字——Host 在 `restartPhase.blocking` 里单独报出它，不再只藏在句子中。
- **设置修改有回执**：改完设置，面板里给回执——成功是绿色「已生效」+ 时间；失败是红色并保留原因、不自动消失。
- **回执贴在设置面板内部顶部**（`position:sticky` + `top:0`，往下滚动设置内容也一直可见；条高 30px，覆盖不挤压表单），不再浮到窗口层——`shell.overlay` 上那条注册已删，提示只出现在本插件的设置页里，关掉设置页即清空。
- **口径统一**：悬停提示里的「任务」改成「会话」（英文 session(s)），和胶囊、面板保持一致。
- **备份太快也要让人看见**：一份 92 KB 的 profile 几十毫秒就备份完，而页面 2 秒才轮询一次——Web/WSL 实测里备份**真的做了**（`backups/2026-10-29T14-10-03` 就在那儿），用户却什么也没看到。现在备份卡**至少显示 800ms**，结束后再显示 1.2 秒「重启前备份完成（92 KB）」；即使这一页从头到尾没轮询到备份过程，也会用 Host 带给界面的真实体积补一张回执。体积按大小自动选单位（`92 KB` / `156 MB`），不会四舍五入成「0 MB」。这条保底只管**显示**：备份本身和重启都不会因此变慢。
- **说清是什么备份**：光看「正在备份」看不出备份的是什么，所以浮层改成「DSH 重启前备份中」、胶囊改成「重启前备份中」（英文 "Backing up before DSH restart" / "Backing up…"），进度条与 MB 数字不变。设置页与 tooltip 那句长句也一起改成同一个说法：「DSH 重启前备份中（预计 X 秒，已完成 Y MB）…」（英文 "Backing up before DSH restart (about Xs, Y MB done)…"），「慢就明说」那条也把主语补成「DSH 重启前备份比预期慢…」，全产品不再出现孤立的「正在备份」。

### 验证

- 单元测试 **760 → 801 项全绿**（新增 `test/restart-overlay.test.mjs` 19 条、`test/settings-save-notice.test.mjs`、`test/pill-count-source.test.mjs`）。
- 两个演练仍是 exit 0：`node scripts/drill-watchdog.mjs`、`powershell -File scripts/drill-rescue.ps1`。
- 客户端 bundle 仍是整文件一个 IIFE（`test/client-bundle-isolation.test.mjs` 守着）。

## 0.8.2 — 2026-10-29

**线上缺陷修复：宿主起来之后没有撤销看门狗，会把好环境回滚掉。**

### 事故现场（真机，19:19–19:21）

触发重启 → `watchdog-pending.json` 写入、`dsh-autorestart-watchdog` 计划任务注册成功、报告写 `armed`；新宿主 19:20:20 起来，health 连打 3 次都是 200；**但 `watchdog-ready.json` 从头到尾没出现**，`watchdog-pending.json` 还在、计划任务还在 `Ready`。当时是人工 `Unregister-ScheduledTask` 拆掉的——没人管的话，90 秒后它会还原快照并再拉起一个实例，**把一个健康的环境回滚掉**。

### 根因（已复现）

health 路由里那段"写 marker + 撤看门狗"的代码读的是 `stateDirOf()`——那是 runtime 工厂内部的闭包变量，**模块级函数根本看不见它**。所以每次请求都在第一行就抛 `ReferenceError: stateDirOf is not defined`，外面那个 `catch {}` 把异常吞了：路由照样回 200，marker 没写、pending 没清、计划任务没删，任何地方都没有痕迹。

- 复现方式：用测试上下文调真实的 health 路由，断言 marker 出现——旧代码失败（`ready written: false`）。
- 同源的第二个坑：`clearPending` / `readPending` 当时也没被 import，`armWatchdog` 注册失败的回滚分支同样会抛 `ReferenceError`。

### 修

- **health 路由不再靠闭包**：状态目录改由 `runtime.stateDir` 提供（`runtime` 上新增 `stateDir` / `pluginVersion`）。这类"路由看不见工厂内部变量"的错误从此没机会重演。
- **撤销拆成独立模块**（`lib/watchdog-disarm.js`），三件事分开做、都留痕：
  1. **先写 ready marker**（同步、read-back 校验）——它是唯一能阻止回滚的东西，绝不再依赖计划任务是否删成功；
  2. 清 `watchdog-pending.json`；
  3. 按 pending 自己写的 tier/taskName 删调度项（不再硬编码名字），删完**回查**（`schtasks /Query`）确认真的没了。
- **失败必须重试并留痕**：默认 3 次、退避 120ms/240ms；每次失败都带 `error.name` + `message`，写进 `watchdog-disarm.json`、health 响应、诊断文本（"报告一个问题"），不再静默。
- **开机就撤销，不等任何人来问**：`apply()` 里注册完路由立刻跑一次 disarm。即使一次 health 都没人打，宿主起来就会把看门狗撤掉；health 路由仍是第二道保险（后台清理，不拖慢响应）。
- **兜底（最要紧的一条）：看门狗回滚前必须自己问一次 health**。`runWatchdogFlow` 新增 3b 步：直接 HTTP 问 `127.0.0.1:<port>`（端口依次取实例记录 `access.json`、pending 里的 port、旧 `healthUrl`），**只要有一台在应答就绝不回滚**（`result: not-needed`）；一个端口都问不到时，额外再等一轮、复查 ready marker 与 pending，仍然没动静才允许回滚。
- **顺手修掉的版本号 bug**：runtime 里那份 `pluginVersion()` 读的是 `../package.json`（插件目录的上一层），永远返回 `unknown`；health 于是把 `unknown` / 硬编码常量当版本报出来。现在统一走模块级读取，`health.version` 是真正加载的版本。

### 演练

`node scripts/drill-watchdog.mjs` 从三个场景扩到**四个**，新增：

- **场景 ④「宿主起来了但没写 ready marker」**（就是这次事故）：假宿主只应答 health、绝不写 marker，并且**真实注册一个 Windows 计划任务**；断言 watchdog `result: not-needed`、`healthCheck: healthy`、**一次还原都没有**、pending 已消失、**计划任务真的被删掉**（`schtasks /Query` 查不到）。

### 重启阶段化 UI（同版发布：点下去 1 秒内就有反馈，备份有真实进度）

用户反馈："点『0 秒后重启』之后十几秒什么都不动，其实在备份 156MB，我会以为按钮没反应 / 0 秒是假的 / 有 bug。"

- **四个阶段立刻可见**：`waiting`「正在等待所有会话空闲…」→ `snapshotting`「正在备份配置和插件（预计 X 秒，已完成 Y MB）…」（0.8.3 起改为「DSH 重启前备份中（预计 X 秒，已完成 Y MB）…」）→ `restarting`「正在重启，稍后自动继续…」→ `back`「已回来，接着干」。阶段写在 checkpoint（`restartPhase`）里，点击的**同一次调用**就把 `waiting` 落盘并 persist，界面下一次轮询（2 秒一次，且点击后立即再拉一次）就能看到。
- **备份进度是真的**：`createBackup` 改成**文件级拷贝循环**（原来是 `fs.cpSync` 一次性拷完，既没进度也不能取消），边拷边报 `{ files, bytes, total }`，`total` 是拷之前量出来的真实总量；拷贝过程**每 120ms / 每 40 个文件让出一次事件循环**，所以取消请求能在拷贝途中被服务，进度也能在拷贝途中到界面。
- **备份阶段可取消**：取消后拷贝在下一个文件处停下，**半成品快照目录被删掉**（不留一个看着能还原的假备份），请求被撤回、宿主不重启；**进入 `restarting` 后取消被拒绝**（HTTP 409 + `reason: not-cancellable` + 原因），界面按钮置灰并说明"正在重启，已经不能取消了"。
- **两处都能读到**：`/__dsh_autorestart/health?state=1` 与 `/health` 都带 `restartPhase`（阶段、双语文字、可取消性、`slow`）和 `progress`（files/bytes/total/percent/ageMs）。
- **慢就明说**：备份超过 300 秒，或字节数 60 秒没动 → 显示「备份比预期慢（可能磁盘很忙），还在继续…」，绝不假装正常进度。
- **界面**：composer 那颗 pill 多一行阶段文字（含进度），设置页「重启设置」组标题下常驻一行同样的状态（pill 只在有待办重启时出现，设置页那行一直都在）。

### 验证

- 单元测试 **740 → 753 项全绿**（新增 `test/watchdog-disarm.test.mjs`：事故复现、开机自动撤销、marker 读写与 read-back、失败/重试/留痕、按 pending 选调度项、诊断文本、流程里"健康就不回滚"、问不到端口多等一轮）。
- 阶段化 UI 再加 **`test/restart-phase.test.mjs`（6 项，累计 760 项全绿）**：①点击后 1 秒内可读到 `phase='waiting'`（含 state 文件与 state 路由两处）②备份中 `progress.bytes` 单调增长且等于最终写入量 ③备份中取消 → 半成品目录消失、宿主没重启、请求被撤回 ④`restarting` 阶段取消被 409 拒绝并给出原因 ⑤慢拷贝两种文案 ⑥里程碑：健康拷贝报真实 MB 与预计秒数、没有测量前不报任何数字。
- 演练四场景 + 三档调度真机触发全部 exit 0。

## 0.8.1 — 2026-10-29

**修复打包遗漏**：0.8.0 的 npm 包按 `package.json` 的 `files` 白名单打包，而那份白名单只收了 `scripts/*.ps1` 与 `scripts/*.cmd`——**三个 POSIX 自救脚本（`restore-profile.sh` / `emergency-disable.sh` / `drill-rescue.sh`）、`scripts/README.md`、`scripts/rescue-strings.zh.json` 全都没进包**。Linux / WSL 用户装完 0.8.0 后，文档让他去双击/运行 `scripts/restore-profile.sh`，那个文件却不存在。

现在把白名单补齐（`.sh`、`.mjs`、`scripts/README.md`、`scripts/rescue-strings.zh.json`、`CHANGELOG.md`），并用 `npm pack --dry-run` 逐项确认：**54 → 61 个文件**，三个 `.sh` 都在。单元测试 740 项仍全绿。

0.8.0 的内容与行为没有其它变化；只是那个包缺文件。

## 0.8.0 — 2026-10-29

这一版把"出事之后怎么办"做成真正的闭环：**起不来就自动还原、再拉起、留下报告**，并且桌面端与各种 Web 托管端（Windows / Linux / WSL）都覆盖。

### 新增

- **看门狗（watchdog v2）**：重启前登记一个一次性监护者；新实例按约定报到就算过关，否则**先复查一次**（防误判），确认真的没起来才**自动还原重启前的快照 → 再自动拉起一次 → 把结果写进报告**。最多还原一次、拉起一次，绝不死循环；回滚前先探活，绝不双开。
- **三档调度，跨环境都可用**：Windows 一次性计划任务 → Linux/WSL 的 systemd-run → 自建后台进程（setsid nohup）。都没有时**明确告知"没有自动回滚"**，绝不假装有保护。
- **同一时刻只有一个监护者**：v2 可用时不启动旧的 v1；v2 不可用时才回落 v1；报告里记 arbiter 字段，出事能一眼看出当时是谁在监护。
- **POSIX 版自救包**：restore-profile.sh / emergency-disable.sh / drill-rescue.sh（与 Windows 的 .cmd/.ps1 同一套规则：先把坏的那份挪走留证、还原后回读校验、路径闸门、不自动重启）。
- **设置页「出事了怎么办」**：按平台显示对应的救命脚本绝对路径，可复制、可打开文件夹；Windows 还能一键在桌面放一个快捷方式（只有你点才创建）。
- **装上就告诉你有没有兜底**：第一次启用时真的建一个空计划任务验证能力（建 → 回读校验 → 删 → 再确认删掉），不能用就直接说清"会丢失：重启后起不来时不会自动恢复"。
- **平台能力矩阵**：docs/platform-matrix.md 列出 13 条能力 × 5 个平台，逐格标清能用、有前提（并写明用户会看到什么）与做不到。

### 修复

- **同一次重启出现两个看门狗会互相废掉**：旧的 PowerShell 看门狗只还原不拉起，若它先抢到锁，新的看门狗会放弃 → 结果是"配置回滚了却没有任何东西在运行"。已改成仲裁者，同一时刻只允许一个。
- **集成测试会往真实机器注册计划任务**（留下空壳任务）。测试改为注入，不再碰系统。
- 计划任务的触发时间曾写成 UTC，导致**任务会晚 8 小时才触发**；改为本地时间。
- 看门狗里一个忘记 await 的探活判断让 Promise 恒为真，看门狗每次都"放弃"；已修并加回归用例。

### 文档

- 讲清**关机倒数会关掉哪台机器**：Windows 桌面 / Windows web → 关这台 Windows；**WSL 里的 web → 关掉整台 Windows**（不是关 WSL）；容器里没有可靠的关机方式（界面会这么说）。
- 自救包补齐"Windows 用哪个、Linux/WSL 用哪个"，并写明 restore-profile 与 emergency-disable 的分工与选择口诀。
- 记录写 POSIX 脚本踩过的三个坑（dash 数单引号里的括号、双引号里的 sed 转义被吃、嵌套 JSON 平铺 grep 找不到）。

### 验证

- 单元测试 **740 项全绿**（node --test plugins/dsh-autorestart/test/*.test.mjs）。
- 看门狗演练（三档都真触发）+ Windows 自救演练 + **WSL 里的 POSIX 自救演练** 全部 exit 0。
- 全部脚本字节级纯 ASCII（rescue-strings.zh.json 无 BOM），机器上无残留计划任务。
- 未真关电：POSIX 的关机链路只验证到"计划层"（用户决定不为一条常识证据断开会话），矩阵里如实标注。

## 0.7.0 — 2026-10-29

这一版的主题是**认得出自己在什么环境里、并且永远不双开**，外加一个用户真能点到的问题反馈入口。
