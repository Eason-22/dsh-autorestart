/**
 * Where the rescue scripts live, and the desktop shortcut that points at them.
 *
 * The rescue kit is for EVERYBODY who installed the plugin, not for the author:
 * when DSH does not come up, the user cannot open a README — they need a path
 * they can copy, and a file they can double-click on the desktop. So the
 * settings page shows the two scripts where they really are, and the desktop
 * shortcut is a file the user asks for.
 *
 * Everything here is pure (the file system is injected), so a test can pin it
 * down without touching a real desktop.
 *
 * THE PATH IS NEVER GUESSED: it comes from the plugin directory the Host
 * resolved for itself. Nothing here assumes `node_modules/dsh-autorestart`.
 */

import path from 'node:path';

/** The two scripts a user may need when DSH does not come up. */
export const RESCUE_SCRIPT_NAMES = Object.freeze({
  restoreProfile: 'restore-profile.cmd',
  emergencyDisable: 'emergency-disable.cmd',
});

/** The file the desktop shortcut is written as (the NAME may be Chinese). */
export const DESKTOP_SHORTCUT_NAME = 'DSH 出事了双击这里.cmd';

/** Does the path exist? (Injected so a test never touches the disk.) */
function defaultExists(target) {
  try {
    // eslint-disable-next-line no-undef
    return require('node:fs').existsSync(target)
  } catch {
    return false
  }
}

/**
 * The directory that holds the scripts of a plugin directory.
 *
 * @param {string} pluginDir the directory of the plugin itself
 * @returns {string}
 */
export function rescueScriptsDir(pluginDir) {
  const dir = typeof pluginDir === 'string' ? pluginDir.trim() : '';
  if (dir === '') return '';
  return path.join(dir, 'scripts');
}

/**
 * The absolute paths of the two rescue scripts.
 *
 * @param {string} pluginDir
 * @returns {{ restoreProfile: string, emergencyDisable: string }}
 */
export function rescueScriptPaths(pluginDir) {
  const scripts = rescueScriptsDir(pluginDir);
  if (scripts === '') return { restoreProfile: '', emergencyDisable: '' };
  return {
    restoreProfile: path.join(scripts, RESCUE_SCRIPT_NAMES.restoreProfile),
    emergencyDisable: path.join(scripts, RESCUE_SCRIPT_NAMES.emergencyDisable),
  };
}

/**
 * The desktop directory of this machine — or an empty string when there is
 * none (a service, a container, a machine without a desktop).
 *
 * @param {{ env?: object, platform?: string, exists?: (p: string) => boolean }} [options]
 * @returns {string}
 */
export function desktopDir({ env = process.env, platform = process.platform, exists = defaultExists } = {}) {
  const candidates = [];
  if (platform === 'win32') {
    const profile = env.USERPROFILE || env.HOME || '';
    if (profile !== '') candidates.push(path.join(profile, 'Desktop'));
    // OneDrive moves the desktop folder; the shell still knows where it is.
    if (env.OneDrive) candidates.push(path.join(String(env.OneDrive), 'Desktop'));
  }
  const home = env.HOME || env.USERPROFILE || '';
  if (home !== '') candidates.push(path.join(home, 'Desktop'));
  for (const candidate of candidates) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // A candidate that cannot be checked is not the desktop.
    }
  }
  return '';
}

/**
 * Where the desktop shortcut would live (empty when there is no desktop).
 *
 * @param {string} desktop
 * @returns {string}
 */
export function desktopShortcutPath(desktop) {
  const dir = typeof desktop === 'string' ? desktop.trim() : '';
  if (dir === '') return '';
  return path.join(dir, DESKTOP_SHORTCUT_NAME);
}

/**
 * The content of the desktop shortcut.
 *
 * A .cmd file is read by cmd.exe with the console code page, so its content
 * has to stay pure ASCII — a Chinese character in it turns into mojibake and
 * the shortcut does nothing. The home directory may well hold such a
 * character (a Chinese user name), so the home prefix is written as
 * %USERPROFILE%: cmd.exe expands it to the very same directory at run time
 * and the file stays ASCII.
 *
 * @param {string} restoreProfilePath the absolute path of restore-profile.cmd
 * @param {{ home?: string }} [options]
 * @returns {string}
 */
export function desktopShortcutContent(restoreProfilePath, { home = '' } = {}) {
  const target = String(restoreProfilePath ?? '');
  const homeDir = typeof home === 'string' ? home.trim() : '';
  let written = target;
  if (homeDir !== '' && target.toLowerCase().startsWith(homeDir.toLowerCase() + path.sep)) {
    written = '%USERPROFILE%' + target.slice(homeDir.length);
  }
  return '@echo off\r\nstart "" "' + written + '"\r\n';
}

/**
 * Is this text pure ASCII?
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isAsciiText(text) {
  const value = String(text ?? '');
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 127) return false;
  }
  return true;
}

/**
 * Write the desktop shortcut.
 *
 * NEVER automatic: the caller only gets here when the user pressed the
 * button. The file is written with the content above and nothing else.
 *
 * @param {{
 *   desktop?: string,
 *   restoreProfilePath?: string,
 *   home?: string,
 *   writeFile?: (path: string, content: string) => void,
 *   exists?: (path: string) => boolean,
 * }} [options]
 * @returns {{ ok: boolean, path: string, error: string|null }}
 */
export function createDesktopShortcut({
  desktop = '',
  restoreProfilePath = '',
  home = '',
  writeFile,
  exists = defaultExists,
} = {}) {
  const dir = typeof desktop === 'string' ? desktop.trim() : '';
  if (dir === '') {
    return { ok: false, path: '', error: 'there is no desktop directory on this machine' };
  }
  if (typeof writeFile !== 'function') {
    return { ok: false, path: '', error: 'the shortcut cannot be written here' };
  }
  const target = desktopShortcutPath(dir);
  const content = desktopShortcutContent(restoreProfilePath, { home });
  if (!isAsciiText(content)) {
    return {
      ok: false,
      path: target,
      error: 'the path of the script holds characters a .cmd file cannot carry — copy the path by hand instead',
    };
  }
  try {
    writeFile(target, content);
  } catch (error) {
    return {
      ok: false,
      path: target,
      error: error && error.message ? error.message : String(error),
    };
  }
  return { ok: true, path: target, error: null };
}

/**
 * Everything the settings page needs to show the rescue kit.
 *
 * @param {{
 *   pluginDir?: string,
 *   env?: object,
 *   platform?: string,
 *   exists?: (p: string) => boolean,
 * }} [options]
 * @returns {{
 *   pluginDir: string,
 *   scriptsDir: string,
 *   restoreProfile: string,
 *   emergencyDisable: string,
 *   desktopDir: string,
 *   shortcutPath: string,
 *   shortcutExists: boolean,
 * }}
 */
export function rescueInfo({ pluginDir = '', env = process.env, platform = process.platform, exists = defaultExists } = {}) {
  const scripts = rescueScriptPaths(pluginDir);
  const desktop = desktopDir({ env, platform, exists });
  const shortcut = desktopShortcutPath(desktop);
  let shortcutExists = false;
  if (shortcut !== '') {
    try {
      shortcutExists = exists(shortcut) === true;
    } catch {
      shortcutExists = false;
    }
  }
  return {
    pluginDir: typeof pluginDir === 'string' ? pluginDir : '',
    scriptsDir: rescueScriptsDir(pluginDir),
    restoreProfile: scripts.restoreProfile,
    emergencyDisable: scripts.emergencyDisable,
    desktopDir: desktop,
    shortcutPath: shortcut,
    shortcutExists,
  };
}
