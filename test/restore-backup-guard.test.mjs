/**
 * A BACKUP MAY ONLY GO BACK WHERE IT CAME FROM (Issue #5, PR #6).
 *
 * The incident this guards against really happened (2026-11-13): a rollback test
 * restored its synthetic copy — three lines, `rows:\n  - id: two-days-ago\n` —
 * into the LIVE profile, because `restoreBackup` never asked where the copy was
 * taken from. 72 KB of plugin configuration became 27 bytes, exit code 0, green
 * suite, nothing said.
 *
 * The check is deliberately TOLERANT, and these cases pin both halves: it must
 * refuse a copy from another profile, and it must keep restoring the legitimate
 * ones. A guard that refuses a real rollback would be its own disaster, so every
 * "we cannot tell" case is allowed through.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { restoreBackup } from '../lib/backup.js'
import './_tmp-guard.mjs'

const FIXTURE = 'rows:\n  - id: two-days-ago\n'
const PROFILE_FILE = 'cordis.patch.yml'

/** A backup directory holding one config file, and the profile it was taken from. */
function fixture(t, { manifest = true, source = null } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-guard-'))
  const fromProfile = source !== null ? source : path.join(base, 'profile-from')
  const toProfile = path.join(base, 'profile-to')
  const backupDir = path.join(base, 'backup')
  fs.mkdirSync(fromProfile, { recursive: true })
  fs.mkdirSync(toProfile, { recursive: true })
  fs.mkdirSync(path.join(backupDir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(backupDir, 'config', PROFILE_FILE), FIXTURE)
  if (manifest) {
    fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({ profileDir: fromProfile }))
  }
  t.after(() => { try { fs.rmSync(base, { recursive: true, force: true }) } catch {} })
  return { base, fromProfile, toProfile, backupDir }
}

test('a copy from ANOTHER profile is refused, and both paths are named', (t) => {
  const { fromProfile, toProfile, backupDir } = fixture(t)
  const result = restoreBackup({ backupDir, profileDir: toProfile })

  assert.equal(result.ok, false, 'restoring somebody else\'s copy must not be reported as a success')
  assert.ok(result.error, 'a refusal has to say something')
  assert.match(result.error, /taken from/i)
  assert.ok(result.error.includes(fromProfile), 'the message must name where the copy came from')
  assert.ok(result.error.includes(toProfile), 'the message must name where it was about to go')
})

test('a refused restore writes NOTHING into the target', (t) => {
  const { toProfile, backupDir } = fixture(t)
  fs.writeFileSync(path.join(toProfile, PROFILE_FILE), 'live: keep me\n')

  const result = restoreBackup({ backupDir, profileDir: toProfile })

  assert.equal(result.ok, false)
  assert.equal(fs.readFileSync(path.join(toProfile, PROFILE_FILE), 'utf8'), 'live: keep me\n',
    'the live file must be exactly what it was')
  assert.deepEqual(result.restored, [], 'nothing may be counted as restored')
})

test('the SAME profile still restores', (t) => {
  const { fromProfile, backupDir } = fixture(t)

  const result = restoreBackup({ backupDir, profileDir: fromProfile })

  assert.equal(result.ok, true, 'the normal case must not be blocked by the guard')
  assert.equal(fs.readFileSync(path.join(fromProfile, PROFILE_FILE), 'utf8'), FIXTURE)
})

test('verifyTarget:false is the documented escape for a MOVED profile', (t) => {
  const { toProfile, backupDir } = fixture(t)

  const result = restoreBackup({ backupDir, profileDir: toProfile, verifyTarget: false })

  assert.equal(result.ok, true, 'a profile that moved on purpose must still be restorable')
  assert.equal(fs.readFileSync(path.join(toProfile, PROFILE_FILE), 'utf8'), FIXTURE)
})

test('an OLD copy with no manifest says nothing, so it is allowed', (t) => {
  const { fromProfile, toProfile, backupDir } = fixture(t, { manifest: false })

  const result = restoreBackup({ backupDir, profileDir: toProfile })

  assert.equal(result.ok, true, 'a copy that predates the field must not become un-restorable')
  assert.equal(fs.readFileSync(path.join(toProfile, PROFILE_FILE), 'utf8'), FIXTURE)
})

test('a manifest WITHOUT profileDir is the same "says nothing" case', (t) => {
  const { fromProfile, toProfile, backupDir } = fixture(t)
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({ at: 1, files: [] }))

  const result = restoreBackup({ backupDir, profileDir: toProfile })

  assert.equal(result.ok, true)
})

test('case and separator noise is the same directory, not a different one', (t) => {
  const { fromProfile, backupDir } = fixture(t)
  fs.writeFileSync(
    path.join(backupDir, 'manifest.json'),
    JSON.stringify({ profileDir: fromProfile.toUpperCase() }),
  )
  const spelledDifferently = fromProfile.split('\\').join('/') + '/'

  const result = restoreBackup({ backupDir, profileDir: spelledDifferently })

  assert.equal(result.ok, true,
    `Windows hands out the same directory as C:\\a\\b, c:/a/b and C:\\a\\b\\ — refusing on that is worse than no check`)
})
