# 缴械审查：没点重启、但带目标的会话，被暂停后有没有还回来

日期：2026-11-25 · 数据源：`~/.dsh/storages/dsh-autorestart/state.json`（`disarmedGoals`）、`last-restart-request.json`、`last-restart-verdict.json`、`restart-gate.json`、插件源码

## 结论

1. **设计本身是对的**：带目标、且自己没点重启的会话，会被临时「缴械」（停掉目标驱动，好让重启能通过闸）；重启完成后，插件会把它的目标**自动重新武装**回来。最近 6 条这类记录里，5 条确实还回来了。
2. **有 1 条没还回来**（会话 `534dee38`，2026-11-25 00:47 被缴械）：它只拿到一条「继续干活」的提示，目标没被重新武装。那目标后来在 12:16 自己跑完了，所以**眼下没有可见损害**，但这条路径本身是缺陷。
3. **两本账混在一起**：手动缴械（`reason=null`）和老版本记录（无 `cycle`）与重启缴械共用一份记录，导致「暂停了几个目标」的统计口径算不清，也让「该不该自动还回」的判定要靠时间戳兜底。

## 逐条记录（Asia/Shanghai）

| 会话短 id | 原因 | 缴械时间 | 还回时间 | 该轮发起方 | 判定 |
|---|---|---|---|---|---|
| d3c6962f | restart-queued | 11-25 13:13 | — | 是（当前请求方） | 正常：重启尚未发生 |
| 80224f08 | restart-blocking | 11-25 12:35 | 11-25 13:09 | 否 | ✅ 已还回 |
| 0f49fc3a | restart-blocking | 11-25 01:10 | 11-25 01:12 | 否 | ✅ 已还回（收编路径） |
| 430045f6 | restart-queued | 11-25 01:09 | 11-25 01:12 | 是 | ✅ 已还回 |
| 534dee38 | restart-blocking | 11-25 00:47 | **无** | 否 | ⚠️ 未还回（目标后来自行完成） |
| 5dd230e3 | restart-blocking | 11-24 20:26 | 11-24 22:22 | 否 | ✅ 已还回 |
| fc5c2a64 | null（手动） | 11-23 18:39 | 无 | 否 | 手动缴械，按设计不自动还回 |
| e7aa1e1c | restart-blocking | 11-23 09:21 | 11-23 13:07 | 否 | ✅ 已还回（人工夺回） |
| bd2260e8 | restart-queued | 11-23 09:14 | 11-23 11:22 | 是 | ✅ 已还回 |
| cc4a998f | restart-queued | 11-23 04:38 | 11-23 07:05 | 是 | ✅ 已还回 |
| 4ee1c898 | restart-queued | 11-22 21:25 | 11-22 21:31 | 是 | ✅ 已还回 |
| 49f334a0 | restart-queued | 11-20 22:27 | 11-20 22:28 | 是 | ✅ 已还回 |
| 9d73d39e | restart-queued | 11-19 22:15 | 11-19 22:16 | 是 | ✅ 已还回 |
| 0cde21f1 | restart-queued | 11-18 20:34 | 11-18 23:07 | 是 | ✅ 已还回 |
| 41640697 | restart-blocking | 11-15 15:03 | 11-18 22:06 | 否 | ✅ 已还回（收编路径） |
| c47f8aa0 / 97f65825 / b4e4b419 / ebacc0e8 / db24d066 | null（旧版） | 11-06 ~ 10-23 | — | 不可判 | 旧版记录，超 24 小时不再自动还回 |

## 证据（代码位置）

- `restart-queued` 只写在一处、且只对**请求者自己**：`index.js:4457`（`disarmQueuedRestartGoals`），调用点 `index.js:10403`、`index.js:11910`。
- `restart-blocking` 只写在一处，且**显式豁免请求者**：`index.js:4398`；豁免判定在 `index.js:4354-4370`（还有请求者在跑就一个都不缴，返回 `skipped: 'requesters-still-running'`）。
- 重启后自动还回：`lib/checkpoint.js:2564`（`adoptDisarmedGoals`）遍历**全部**记录、不查 requesters；归属判定只看 reason，`lib/checkpoint.js:2621`，两种重启原因同样放行；收编后写 `pendingResume`（`lib/checkpoint.js:2665-2671`）。
- 开机执行还回：`index.js:9350-9352` 命中 `goal.activation === 'disarmed'` → `resume-disarmed-goal` → `index.js:9374` 恢复、`index.js:9378` 写回 `resumedAt`。
- 反例 `534dee38` 的实际下落：`state.json` → `sessions['...534dee38...'].lastRecoveryAction = 'prompt-continuation'`，说明它没走 re-arm 分支，只收到「继续」提示。缺的信息：那一代（cycle 937）开机时 `recoverSession` 的判定读数——本机没有按代保存的插件运行日志，读不到，不做推断。
- 单测已固化「非发起方也会被还回」：`test/goal-rearm-after-restart.test.mjs:530-573`。

## 要修的话改哪里（本轮未改，等拍板）

1. **兜底「缴了但没还回」**：`index.js:9347-9370` 的 re-arm 判定要求 `phase='active' && activation='disarmed'`；应允许「插件缴过、但状态已不在 disarmed」的情形也走 re-arm，而不是只发一条继续提示。同时让 `adoptDisarmedGoals`（`lib/checkpoint.js:2665-2671`）为「未还回」单独记一笔，便于追。
2. **手动缴械要能被区分**：`index.js:4290 / 10780 / 11891` 都是 `reason: null`；给它一个独立取值（如 `manual-park`），别和旧版记录共用同一条时间戳兜底（`lib/checkpoint.js:2625`）。
3. **统计口径按 reason 分组**：`client.js:4366-4425` 现在把手动缴械与重启缴械一起算「已停泊 n 个 goal」。
4. **现成的解锁阀**：`index.js:8879-8897`（`continuum_recover_now` 指定会话）能把插件锁住的目标要回来——遇到「目标停在那不动」先用它，不要手改 `state.json`。

## 现场提醒

当前待执行的重启是 generation 954（`d3c6962f` 于 13:13:04 发起），闸状态 `waiting-for-conversations`。请求方已停，所以下一轮轮询会把当时还在跑的会话按 `restart-blocking` 缴械——**用户看到「我没点重启也被缴械」的时刻就是这里**；按上面的代码路径，这些会话在重启完成后会被收编并自动还回。
