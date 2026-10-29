/**
 * dsh-autorestart — WHICH MACHINE IS THIS?
 *
 * The plugin has to know whether it runs on Windows, on a real Linux, on a
 * macOS or INSIDE WSL (the Linux of Windows). The answer changes what may be
 * done:
 *
 *   - the graceful shutdown must reach the PHYSICAL machine (in WSL, shutting
 *     the distro down only stops the subsystem);
 *   - the "start at login" of the supervisor is a different thing in WSL
 *     (a systemd user unit + `loginctl enable-linger`, or a Windows-side
 *     task) than on a real Linux;
 *   - inside WSL there is NO Docker/Compose answer: the orchestrator is
 *     Windows itself.
 *
 * So the detection lives HERE, once, and both halves of the plugin use it.
 *
 * Everything is dependency-injected (the platform, the environment, the file
 * probes), so the whole matrix can be tested without a machine.
 *
 * ESM only, Node builtins only.
 */

import fs from 'node:fs'

/** The Windows shutdown binary as it is reachable from WSL. */
export const WSL_SHUTDOWN_EXE = '/mnt/c/Windows/System32/shutdown.exe'

/** The file that tells a WSL kernel from a real Linux kernel. */
export const WSL_PROC_VERSION = '/proc/version'

/** The kinds of host the plugin knows. */
export const HOST_KINDS = Object.freeze({
  WINDOWS: 'windows',
  WSL: 'wsl',
  LINUX: 'linux',
  MACOS: 'macos',
  UNSUPPORTED: 'unsupported',
})

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
}

/**
 * The evidence that this Linux is really a WSL distribution.
 *
 * Any ONE of them is enough:
 *   1. `WSL_DISTRO_NAME` is set (WSL exports it into every process),
 *   2. `WSL_INTEROP` is set (WSL exports it into every process),
 *   3. `/proc/version` mentions "microsoft" (the WSL kernel says so),
 *   4. the Windows shutdown binary is reachable under `/mnt/c`.
 *
 * @param {object} env
 * @param {(file: string) => string} readFile
 * @param {(file: string) => boolean} exists
 * @returns {string|null} the name of the evidence, or null
 */
export function detectWslEvidence(env, readFile, exists) {
  const environ = env && typeof env === 'object' ? env : {}
  if (nonEmptyString(environ.WSL_DISTRO_NAME) !== '') return 'WSL_DISTRO_NAME'
  if (nonEmptyString(environ.WSL_INTEROP) !== '') return 'WSL_INTEROP'
  let version = ''
  try {
    version = String(readFile(WSL_PROC_VERSION) || '')
  } catch {
    version = ''
  }
  if (version.toLowerCase().includes('microsoft')) return WSL_PROC_VERSION
  let found = false
  try {
    found = exists(WSL_SHUTDOWN_EXE) === true
  } catch {
    found = false
  }
  if (found) return WSL_SHUTDOWN_EXE
  return null
}

/**
 * Which machine is this?
 *
 * `suspect` is true when the ONLY evidence is the mounted Windows drive: a
 * real Linux with a manually mounted C: drive looks exactly the same. The
 * plugin says so instead of pretending to be sure — and it does NOT change
 * any system configuration on such a guess.
 *
 * @param {{
 *   platform?: string,
 *   env?: object,
 *   readFile?: (file: string) => string,
 *   exists?: (file: string) => boolean,
 * }} [options]
 * @returns {{
 *   kind: 'windows'|'wsl'|'linux'|'macos'|'unsupported',
 *   platform: string,
 *   evidence: string,
 *   suspect: boolean,
 *   distro: string,
 * }}
 */
export function detectHostKind({
  platform = process.platform,
  env = process.env,
  readFile,
  exists,
} = {}) {
  const plat = nonEmptyString(platform) || process.platform
  const environ = env && typeof env === 'object' ? env : process.env
  const readFileSafe = typeof readFile === 'function'
    ? readFile
    : (file) => fs.readFileSync(file, 'utf8')
  const existsSafe = typeof exists === 'function'
    ? exists
    : (file) => fs.existsSync(file)

  const base = {
    platform: plat,
    evidence: 'process.platform',
    suspect: false,
    distro: nonEmptyString(environ.WSL_DISTRO_NAME),
  }

  if (plat === 'win32') {
    return { ...base, kind: HOST_KINDS.WINDOWS }
  }
  if (plat === 'linux') {
    const evidence = detectWslEvidence(environ, readFileSafe, existsSafe)
    if (evidence !== null) {
      return {
        ...base,
        kind: HOST_KINDS.WSL,
        evidence,
        // Only the mounted drive: that is a HINT, not a proof.
        suspect: evidence === WSL_SHUTDOWN_EXE,
      }
    }
    return { ...base, kind: HOST_KINDS.LINUX }
  }
  if (plat === 'darwin') {
    return { ...base, kind: HOST_KINDS.MACOS }
  }
  return { ...base, kind: HOST_KINDS.UNSUPPORTED }
}
