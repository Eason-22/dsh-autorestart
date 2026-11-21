/**
 * AN EXPLICIT ANSWER BEATS A CACHE (issue #5).
 *
 * The incident: a rollback test set `DSH_PROFILE_DIR` to its fixture, ran
 * `restoreBackup`, and wrote three lines over a 72 KB live profile. The fixture was
 * correct; the RESOLVER was not. `resolveProfileDirDetailed()` read the remembered
 * `profile-dir.json` (STEP 0) BEFORE looking at the environment (STEP 1), so the
 * memo of the real machine won and the test read — and wrote — the real profile.
 *
 * Two defects, two halves of the fix, and these cases pin both:
 *
 *   1. an explicit source (`DSH_PROFILE_DIR`, `DSH_HOME`+`DSH_PROFILE`) outranks the
 *      memo, while the memo still serves an ordinary boot (it is a cache, not an
 *      answer);
 *   2. a caller that names only a `stateFile` gets its OWN memo directory, so a test
 *      can no longer read (or write) the memo of the machine it runs on.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveProfileDirDetailed } from '../index.js'
import './_tmp-guard.mjs'

const MEMO_FILE = 'profile-dir.json'

/** A temp tree holding one profile-looking directory, plus a place for the memo. */
function tree(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-precedence-'))
  const fixture = path.join(base, 'fixture-profile')
  const remembered = path.join(base, 'remembered-profile')
  const stateDir = path.join(base, 'state')
  fs.mkdirSync(fixture, { recursive: true })
  fs.mkdirSync(remembered, { recursive: true })
  fs.mkdirSync(stateDir, { recursive: true })
  t.after(() => { try { fs.rmSync(base, { recursive: true, force: true }) } catch {} })
  return { base, fixture, remembered, stateDir }
}

function remember(stateDir, dir) {
  fs.writeFileSync(
    path.join(stateDir, MEMO_FILE),
    JSON.stringify({ dir, source: 'DSH_PROFILE_DIR', at: Date.now() }),
  )
}

test('DSH_PROFILE_DIR outranks a stale memo (the incident cannot repeat)', (t) => {
  const { fixture, remembered, stateDir } = tree(t)
  remember(stateDir, remembered)

  const answer = resolveProfileDirDetailed({
    env: { DSH_PROFILE_DIR: fixture },
    argv: [],
    stateDir,
    homeDir: path.dirname(stateDir),
  })

  assert.equal(answer.dir, fixture, 'the explicit answer must win over the remembered one')
  assert.equal(answer.source, 'DSH_PROFILE_DIR')
})

test('DSH_HOME + DSH_PROFILE outranks a stale memo too', (t) => {
  const { base, remembered, stateDir } = tree(t)
  remember(stateDir, remembered)
  const home = path.join(base, 'home')
  const profile = path.join(home, 'profiles', 'web')
  fs.mkdirSync(profile, { recursive: true })

  const answer = resolveProfileDirDetailed({
    env: { DSH_HOME: home, DSH_PROFILE: 'web' },
    argv: [],
    stateDir,
    homeDir: base,
  })

  assert.equal(answer.dir, profile)
  assert.equal(answer.source, 'DSH_HOME/DSH_PROFILE')
})

test('the memo is still a cache: with nothing explicit, it answers without a scan', (t) => {
  const { remembered, stateDir } = tree(t)
  remember(stateDir, remembered)

  const answer = resolveProfileDirDetailed({
    env: {},
    argv: [],
    stateDir,
    homeDir: path.dirname(stateDir),
  })

  assert.equal(answer.dir, remembered)
  assert.equal(answer.source, 'remembered')
  assert.equal(answer.scanned, false, 'a cache hit must not scan the profiles directory')
})

test('a caller that names only a stateFile gets its OWN memo directory', (t) => {
  const { base, fixture } = tree(t)
  const isolated = path.join(base, 'isolated-state')
  fs.mkdirSync(isolated, { recursive: true })
  const stateFile = path.join(isolated, 'state.json')

  const answer = resolveProfileDirDetailed({
    env: { DSH_PROFILE_DIR: fixture },
    argv: [],
    stateFile,
    homeDir: base,
  })

  assert.equal(answer.dir, fixture)
  assert.equal(answer.source, 'DSH_PROFILE_DIR')
  assert.equal(
    fs.existsSync(path.join(isolated, MEMO_FILE)),
    true,
    'the memo must land next to the caller\'s stateFile, not in the shared real state dir',
  )
})
