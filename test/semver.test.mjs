/**
 * Tests for the semver comparison the announcements are de-duplicated with.
 *
 * The comparison has to be NUMERIC: the string comparison of "0.10.0" and
 * "0.9.0" says the opposite of the truth, because "10" sorts before "9". A
 * card that comes back because of that would be exactly the bug this
 * comparison exists to prevent.
 *
 * Only the plain `x.y.z` triple is understood: anything else has no order at
 * all, and the caller decides what to do with that (the announcements treat
 * such a record as "seen" — a broken record must not make the card come back
 * for ever).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { compareSemver } from '../lib/semver.js'

test('the same version is equal to itself', () => {
  assert.equal(compareSemver('0.5.0', '0.5.0'), 0)
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0)
})

test('the numbers are compared, not the strings', () => {
  assert.equal(compareSemver('0.10.0', '0.9.0'), 1, '0.10.0 is newer than 0.9.0')
  assert.equal(compareSemver('0.9.0', '0.10.0'), -1, '0.9.0 is older than 0.10.0')
  assert.equal(compareSemver('1.0.0', '0.99.99'), 1)
  assert.equal(compareSemver('0.4.10', '0.4.9'), 1)
})

test('every segment decides the order', () => {
  assert.equal(compareSemver('1.0.0', '0.9.9'), 1, 'the major segment wins')
  assert.equal(compareSemver('0.6.0', '0.5.9'), 1, 'the minor segment wins')
  assert.equal(compareSemver('0.5.1', '0.5.0'), 1, 'the patch segment wins')
  assert.equal(compareSemver('0.5.0', '0.5.1'), -1)
  assert.equal(compareSemver('0.5.0', '0.6.0'), -1)
})

test('a version that is not a version has no order', () => {
  assert.equal(compareSemver('garbage', '0.5.0'), null)
  assert.equal(compareSemver('0.5.0', 'garbage'), null)
  assert.equal(compareSemver('garbage', 'garbage'), null)
  assert.equal(compareSemver('0.5', '0.5.0'), null, 'two segments are not enough')
  assert.equal(compareSemver('0.5.0.1', '0.5.0'), null, 'four segments are too many')
  assert.equal(compareSemver('v0.5.0', '0.5.0'), null, 'a prefix is not a version')
  assert.equal(compareSemver('0.5.0-beta.1', '0.5.0'), null, 'a pre-release tag is not a version')
  assert.equal(compareSemver('0.5.x', '0.5.0'), null)
  assert.equal(compareSemver('', '0.5.0'), null)
  assert.equal(compareSemver(null, '0.5.0'), null)
  assert.equal(compareSemver('0.5.0', undefined), null)
  assert.equal(compareSemver(42, '0.5.0'), null)
})

test('the surrounding spaces do not matter', () => {
  assert.equal(compareSemver(' 0.5.0 ', '0.5.0'), 0)
})
