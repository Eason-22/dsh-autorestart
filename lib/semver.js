/**
 * dsh-autorestart — the smallest semver comparison this plugin needs.
 *
 * The feature announcements are de-duplicated by VERSION, not by equality: a
 * record counts as "seen" as soon as it is not older than the current feature
 * version. That comparison has to be numeric — the string comparison of
 * "0.10.0" and "0.9.0" says the opposite of the truth, because "10" sorts
 * before "9".
 *
 * Only the plain `x.y.z` triple is understood. Anything else (a build
 * metadata suffix, a pre-release tag, a broken record) has no order at all,
 * and the caller decides what to do with that.
 *
 * @module lib/semver
 */

/** A version is three numbers and nothing else. */
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/

/**
 * Split a version into its three numbers.
 *
 * @param {unknown} value
 * @returns {[number, number, number]|null} null when it is not a version
 */
function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = VERSION_PATTERN.exec(value.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Compare two versions numerically.
 *
 * @param {unknown} a the left version
 * @param {unknown} b the right version
 * @returns {-1|0|1|null} -1 when `a` is older, 1 when it is newer, 0 when they
 *   are the same, and null when one of them is not a version at all
 */
export function compareSemver(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return null
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}
