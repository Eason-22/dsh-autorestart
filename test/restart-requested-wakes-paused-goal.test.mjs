// 自己发起重启的会话，不该被暂停的目标一起憋死（bug, 2026-11-13）。
//
// 真机事故：session-0cde21f1 自己发起了重启（pendingSource = "restart-requested"），
// 但它有一个 phase: paused 的目标，于是 shouldStayQuiet 判「用户停的，保持安静」，
// 把它要求重启去继续的活吞了。
//
// 规则：
//   - 这个会话自己要求的重启（restart-requested）⇒ 唤醒（返回 false）;
//   - 别人重启 / 采纳 / 处置 ⇒ 目标 paused 或 blocked 时仍然安静（原有行为，一条都不许变）。
//
// 边界：这条只唤醒会话，不让目标继续跑 —— 重新武装目标的分支要求 phase === 'active'，
// paused 目标永远走不到那里。见 lib/lifecycle.js 的 shouldStayQuiet 注释。

import test from 'node:test'
import assert from 'node:assert/strict'

import { PENDING_SOURCES, shouldStayQuiet } from '../lib/lifecycle.js'

const pausedGoal = { phase: 'paused', activation: 'disarmed' }
const blockedGoal = { phase: 'blocked' }
const activeGoal = { phase: 'active', activation: 'armed' }
const disarmedActiveGoal = { phase: 'active', activation: 'disarmed' }
const completeGoal = { phase: 'complete' }

test('自己发起重启 + 目标暂停 ⇒ 唤醒（这是本次修复的那一条）', () => {
  assert.equal(
    shouldStayQuiet({ goal: pausedGoal, source: PENDING_SOURCES.RESTART_REQUESTED }),
    false,
  )
})

test('自己发起重启 + 目标 blocked ⇒ 也唤醒', () => {
  assert.equal(
    shouldStayQuiet({ goal: blockedGoal, source: PENDING_SOURCES.RESTART_REQUESTED }),
    false,
  )
})

test('自己发起重启 + activation 是 paused ⇒ 也唤醒', () => {
  assert.equal(
    shouldStayQuiet({ goal: { phase: 'active', activation: 'paused' }, source: PENDING_SOURCES.RESTART_REQUESTED }),
    false,
  )
})

test('别人重启打断它（boot-interrupted）+ 目标暂停 ⇒ 仍然安静（原有契约不变）', () => {
  assert.equal(
    shouldStayQuiet({ goal: pausedGoal, source: PENDING_SOURCES.BOOT_INTERRUPTED }),
    true,
  )
})

test('采纳（adoption）+ 目标暂停 ⇒ 仍然安静（原有契约不变）', () => {
  assert.equal(
    shouldStayQuiet({ goal: pausedGoal, source: PENDING_SOURCES.ADOPTION }),
    true,
  )
})

test('没有来源信息 + 目标暂停 ⇒ 仍然安静（原有契约不变）', () => {
  assert.equal(shouldStayQuiet({ goal: pausedGoal }), true)
  assert.equal(shouldStayQuiet({ goal: pausedGoal, source: undefined }), true)
  assert.equal(shouldStayQuiet({ goal: pausedGoal, source: '' }), true)
})

test('目标 active ⇒ 一律不安静（原有契约不变）', () => {
  assert.equal(shouldStayQuiet({ goal: activeGoal, source: PENDING_SOURCES.RESTART_REQUESTED }), false)
  assert.equal(shouldStayQuiet({ goal: activeGoal, source: PENDING_SOURCES.ADOPTION }), false)
  assert.equal(shouldStayQuiet({ goal: disarmedActiveGoal, source: PENDING_SOURCES.ADOPTION }), false)
})

test('目标 complete 的两种来源区分保持原样', () => {
  // 被打断的是用户的回合 ⇒ 仍要给续跑消息
  assert.equal(shouldStayQuiet({ goal: completeGoal, source: PENDING_SOURCES.BOOT_INTERRUPTED }), false)
  assert.equal(shouldStayQuiet({ goal: completeGoal, source: PENDING_SOURCES.RESTART_REQUESTED }), false)
  // 只是被采纳 / 被处置 ⇒ 无事可做，保持安静
  assert.equal(shouldStayQuiet({ goal: completeGoal, source: PENDING_SOURCES.ADOPTION }), true)
  assert.equal(shouldStayQuiet({ goal: completeGoal, source: PENDING_SOURCES.DISPOSED }), false)
})

test('source 的大小写与空白不影响判定', () => {
  assert.equal(
    shouldStayQuiet({ goal: pausedGoal, source: '  RESTART-REQUESTED  ' }),
    false,
  )
})
