/**
 * dsh-autorestart — the NODE INTERPRETER the supervisor is started with.
 *
 * WHY THIS FILE EXISTS:
 *
 * The supervisor is a plain node script. The record that starts it at login
 * must therefore name a REAL node interpreter. `process.execPath` is NOT
 * always node:
 *
 *   - in the hosted web host it is node (`/usr/bin/node`, `node.exe`);
 *   - in the DESKTOP APP it is the Electron client
 *     (`…\DeepSeek Harness.exe`).
 *
 * A login record that starts the Electron client would open a SECOND copy of
 * the client at every login (the login record inherits the environment of the
 * user, which does NOT carry `ELECTRON_RUN_AS_NODE=1`, so the exe starts the
 * full application instead of running the script as node).
 *
 * So the interpreter is RESOLVED, never guessed:
 *
 *   1. the process itself IS node (the file name starts with `node`);
 *   2. the runtime that ships with the installation
 *      (`resources/runtime/primary-runtime/dependencies/node/bin/node.exe`);
 *   3. the `node` of the PATH.
 *
 * When none of them is there the answer is "no interpreter": the caller
 * refuses the installation and says why. The application executable is NEVER
 * used as a stand-in for node.
 *
 * ESM only, Node builtins only.
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * The node interpreter inside the runtime that ships with the installation.
 *
 * It is relative to the directory of the application executable.
 */
export const BUNDLED_NODE_RELATIVE_PATH = Object.freeze([
  'resources',
  'runtime',
  'primary-runtime',
  'dependencies',
  'node',
  'bin',
  'node.exe',
])

/**
 * Is this file name the name of a node interpreter?
 *
 * `node`, `node.exe`, `node22.exe` and `nodejs` are interpreters; a directory
 * called `node_modules` is not.
 *
 * @param {string} execPath
 * @returns {boolean}
 */
export function isNodeExecutable(execPath) {
  const text = String(execPath ?? '').trim()
  if (text === '') return false
  const base = path.basename(text).toLowerCase()
  if (!base.startsWith('node')) return false
  return !base.includes('node_modules')
}

/**
 * The directories of the PATH (Windows spells it `Path` as well).
 *
 * @param {object} env
 * @returns {string[]}
 */
function pathDirectories(env) {
  const raw = typeof env.PATH === 'string' && env.PATH !== ''
    ? env.PATH
    : (typeof env.Path === 'string' ? env.Path : '')
  if (raw === '') return []
  return raw.split(path.delimiter).map((part) => part.trim()).filter((part) => part !== '')
}

/**
 * Find a real node interpreter on this machine.
 *
 * @param {{
 *   execPath?: string,
 *   platform?: string,
 *   env?: object,
 *   existsSyncFn?: Function,
 * }} [options]
 * @returns {{
 *   ok: boolean,
 *   path: string,
 *   source: 'process'|'install-dir'|'path'|'',
 *   reason: string,
 *   tried: string[],
 * }}
 */
export function resolveNodeInterpreter(options = {}) {
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const execPath = String(options.execPath ?? '')
  const env = options.env && typeof options.env === 'object' ? options.env : process.env
  const exists = typeof options.existsSyncFn === 'function' ? options.existsSyncFn : fs.existsSync
  const tried = []

  // (1) The process IS node.
  if (isNodeExecutable(execPath)) {
    return { ok: true, path: execPath, source: 'process', reason: '', tried }
  }

  // (2) The runtime that ships with the installation.
  if (execPath !== '') {
    const directory = path.dirname(execPath)
    const candidates = platform === 'win32'
      ? [path.join(directory, ...BUNDLED_NODE_RELATIVE_PATH)]
      : []
    for (const candidate of candidates) {
      tried.push(candidate)
      if (exists(candidate)) {
        return { ok: true, path: candidate, source: 'install-dir', reason: '', tried }
      }
    }
  }

  // (3) The PATH.
  const names = platform === 'win32' ? ['node.exe'] : ['node']
  for (const directory of pathDirectories(env)) {
    for (const name of names) {
      const candidate = path.join(directory, name)
      tried.push(candidate)
      if (exists(candidate)) {
        return { ok: true, path: candidate, source: 'path', reason: '', tried }
      }
    }
  }

  return {
    ok: false,
    path: '',
    source: '',
    reason: 'no node interpreter was found: the executable of this process is not node, the installation carries no bundled node, and the PATH has none either — the application executable is never used as a stand-in for node',
    tried,
  }
}
