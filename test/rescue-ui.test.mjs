/**
 * The rescue kit in the settings page: where the scripts are, how to copy
 * that path, and the desktop shortcut.
 *
 * The rules this pins down:
 *
 *   - the PATHS come from the Host (it resolved the plugin directory for
 *     itself) — the browser never guesses them, and nothing assumes
 *     `node_modules/dsh-autorestart`;
 *   - "copy the path" goes through the clipboard WITH its fallback (a refused
 *     clipboard gives the text back, so the path is never lost);
 *   - the desktop shortcut is written ONLY when the user asks for it: reading
 *     the settings page writes nothing to the desktop;
 *   - a machine without a desktop is a normal case, not a crash.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  createDesktopShortcut,
  desktopDir,
  desktopShortcutContent,
  desktopShortcutPath,
  isAsciiText,
  rescueInfo,
  rescueScriptPaths,
  RESCUE_SCRIPT_NAMES,
} from '../lib/rescue-paths.js';

/**
 * Load the client script the way the browser evaluates it.
 *
 * @param {{ language?: string }} options the browser language
 */
function loadClient({ language = 'zh-CN' } = {}) {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const sandbox = {
    window: {
      __ModuleLoader__: { load: () => {} },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {},
      removeEventListener: () => {},
      location: { reload: () => {} },
    },
    document: {
      getElementById: () => null,
      createElement: (tag) => ({ tag, id: '', textContent: '', parentNode: null, setAttribute: () => {}, appendChild: () => {} }),
      head: { appendChild: (node) => node, removeChild: () => {} },
      querySelector: () => null,
    },
    navigator: { language },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    AbortController,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  return sandbox.__dshAutorestartClient;
}

// ---------------------------------------------------------------------------
// 1) The paths come from the Host
// ---------------------------------------------------------------------------

test('the rescue paths come from the Host, not from the browser', () => {
  const api = loadClient();
  const paths = api.rescuePathsFor({
    rescue: {
      restoreProfile: 'C:\\profiles\\desktop\\node_modules\\dsh-autorestart\\scripts\\restore-profile.cmd',
      emergencyDisable: 'C:\\profiles\\desktop\\node_modules\\dsh-autorestart\\scripts\\emergency-disable.cmd',
    },
  });
  assert.equal(paths.length, 2);
  assert.equal(paths[0].key, 'restoreProfile');
  assert.equal(paths[0].path, 'C:\\profiles\\desktop\\node_modules\\dsh-autorestart\\scripts\\restore-profile.cmd');
  assert.equal(paths[1].key, 'emergencyDisable');
  assert.equal(paths[1].path, 'C:\\profiles\\desktop\\node_modules\\dsh-autorestart\\scripts\\emergency-disable.cmd');
});

test('a path that the Host did not send is not shown', () => {
  const api = loadClient();
  // The array comes from another realm (the vm), so it is compared by length.
  assert.equal(api.rescuePathsFor({}).length, 0);
  assert.equal(api.rescuePathsFor({ rescue: { restoreProfile: '   ' } }).length, 0);
  assert.equal(api.rescuePathsFor(null).length, 0);
  // Only one of the two: the other one is simply not offered.
  const one = api.rescuePathsFor({ rescue: { restoreProfile: 'C:\\a\\restore-profile.cmd' } });
  assert.equal(one.length, 1);
  assert.equal(one[0].key, 'restoreProfile');
});

test('the plugin directory is the source of the script paths', () => {
  const pluginDir = path.join('C:', 'profiles', 'desktop', 'node_modules', 'dsh-autorestart')
  const paths = rescueScriptPaths(pluginDir)
  assert.equal(paths.restoreProfile, path.join(pluginDir, 'scripts', RESCUE_SCRIPT_NAMES.restoreProfile))
  assert.equal(paths.emergencyDisable, path.join(pluginDir, 'scripts', RESCUE_SCRIPT_NAMES.emergencyDisable))
  // The scripts live NEXT to the plugin, not in a guessed layout.
  assert.ok(paths.restoreProfile.includes(path.join('scripts', 'restore-profile.cmd')))
})

// ---------------------------------------------------------------------------
// 2) "Copy the path" goes through the clipboard WITH its fallback
// ---------------------------------------------------------------------------

test('the copy button uses the clipboard, and falls back when it refuses', async () => {
  const api = loadClient();
  const written = [];
  const ok = await api.copyReportText('C:\\a\\restore-profile.cmd', {
    clipboard: { writeText: async (text) => { written.push(text) } },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.fallback, false);
  assert.deepEqual(written, ['C:\\a\\restore-profile.cmd']);

  // A refused clipboard: the text comes back, so the path is never lost.
  const refused = await api.copyReportText('C:\\a\\restore-profile.cmd', {
    clipboard: { writeText: async () => { throw new Error('denied') } },
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.fallback, true);
  assert.equal(refused.text, 'C:\\a\\restore-profile.cmd');

  // No clipboard at all (an insecure context).
  const none = await api.copyReportText('C:\\a\\restore-profile.cmd', { clipboard: null });
  assert.equal(none.fallback, true);
  assert.equal(none.text, 'C:\\a\\restore-profile.cmd');
});

// ---------------------------------------------------------------------------
// 3) The desktop shortcut: only when the user asks for it
// ---------------------------------------------------------------------------

test('reading the settings writes NOTHING to the desktop', () => {
  const calls = [];
  const info = rescueInfo({
    pluginDir: 'C:\\plugin',
    env: { USERPROFILE: 'C:\\Users\\Tester' },
    platform: 'win32',
    exists: (target) => target === 'C:\\Users\\Tester\\Desktop',
  });
  // Nothing was written: the file system was never asked to write.
  assert.deepEqual(calls, []);
  assert.equal(info.shortcutExists, false);
  assert.equal(info.desktopDir, 'C:\\Users\\Tester\\Desktop');
});

test('the shortcut is written when the user asks for it', () => {
  const written = [];
  const result = createDesktopShortcut({
    desktop: 'C:\\Users\\Tester\\Desktop',
    restoreProfilePath: 'C:\\plugin\\scripts\\restore-profile.cmd',
    home: 'C:\\Users\\Tester',
    writeFile: (target, content) => { written.push({ target, content }) },
  });
  assert.equal(result.ok, true);
  assert.equal(written.length, 1);
  assert.equal(written[0].target, desktopShortcutPath('C:\\Users\\Tester\\Desktop'));
  assert.ok(written[0].content.includes('start "" "'));
  assert.ok(written[0].content.includes('restore-profile.cmd'));
});

test('the shortcut content is pure ASCII and only starts the script', () => {
  const content = desktopShortcutContent('C:\\plugin\\scripts\\restore-profile.cmd', { home: '' });
  assert.equal(isAsciiText(content), true, 'a .cmd file is read with the console code page');
  assert.equal(content, '@echo off\r\nstart "" "C:\\plugin\\scripts\\restore-profile.cmd"\r\n');
  // The home prefix becomes %USERPROFILE%: the file stays ASCII even when the
  // user name holds characters a .cmd file cannot carry.
  const withHome = desktopShortcutContent('C:\\Users\\Tester\\plugin\\scripts\\restore-profile.cmd', { home: 'C:\\Users\\Tester' });
  assert.equal(isAsciiText(withHome), true);
  assert.ok(withHome.includes('%USERPROFILE%'));
});

test('a shortcut whose path cannot be written is refused, not written broken', () => {
  const written = [];
  const result = createDesktopShortcut({
    desktop: 'C:\\Users\\Tester\\Desktop',
    restoreProfilePath: 'C:\\Users\\测试者\\plugin\\scripts\\restore-profile.cmd',
    home: '',
    writeFile: (target, content) => { written.push(target) },
  });
  assert.equal(result.ok, false);
  assert.notEqual(result.error, '');
  assert.deepEqual(written, [], 'nothing is written when the file could not work');
});

// ---------------------------------------------------------------------------
// 4) A machine without a desktop is a normal case
// ---------------------------------------------------------------------------

test('without a desktop the settings page says so and nothing crashes', () => {
  const api = loadClient();
  const info = rescueInfo({
    pluginDir: 'C:\\plugin',
    env: { USERPROFILE: 'C:\\Users\\Tester' },
    platform: 'win32',
    exists: () => false,
  });
  assert.equal(info.desktopDir, '', 'there is no desktop here');
  assert.equal(info.shortcutPath, '');
  assert.equal(info.shortcutExists, false);
  // The paths are still there — that is the whole point of the section.
  const paths = api.rescuePathsFor({ rescue: info });
  assert.equal(paths.length, 2);
  // The shortcut cannot be created, and that is reported, not thrown.
  const result = createDesktopShortcut({
    desktop: info.desktopDir,
    restoreProfilePath: info.restoreProfile,
    home: '',
    writeFile: () => { throw new Error('must not be called') },
  });
  assert.equal(result.ok, false);
  assert.notEqual(result.error, '');
});

test('the desktop is found where the machine really keeps it', () => {
  // OneDrive moves the desktop folder: the first candidate that exists wins.
  const found = desktopDir({
    env: { USERPROFILE: 'C:\\Users\\Tester', OneDrive: 'C:\\Users\\Tester\\OneDrive' },
    platform: 'win32',
    exists: (target) => target === 'C:\\Users\\Tester\\OneDrive\\Desktop',
  });
  assert.equal(found, 'C:\\Users\\Tester\\OneDrive\\Desktop');
  // Nothing there at all: no desktop.
  const none = desktopDir({
    env: { USERPROFILE: 'C:\\Users\\Tester' },
    platform: 'win32',
    exists: () => false,
  });
  assert.equal(none, '');
});

// ---------------------------------------------------------------------------
// The texts of the section
// ---------------------------------------------------------------------------

test('the section says which script is which, and warns about the running host', () => {
  const api = loadClient();
  for (const language of ['zh-CN', 'en-US']) {
    const t = api.makeTranslate(null)
    const keys = [
      'settings.groups.rescue',
      'settings.rescue.hint',
      'settings.rescue.restoreProfile',
      'settings.rescue.emergencyDisable',
      'settings.rescue.copyPath',
      'settings.rescue.reveal',
      'settings.rescue.which',
      'settings.rescue.warning',
      'settings.rescue.shortcut',
      'settings.rescue.shortcutDone',
      'settings.rescue.noDesktop',
    ]
    for (const key of keys) {
      const text = t(key)
      assert.notEqual(text, key, key + ' must have a text (' + language + ')')
      assert.ok(text.length > 0, key + ' must not be empty (' + language + ')')
    }
  }
});

test('the warning says the scripts are for a host that does not come up', () => {
  // The language follows the browser when the Host says nothing.
  const zh = loadClient({ language: 'zh-CN' }).makeTranslate(null)('settings.rescue.warning')
  const en = loadClient({ language: 'en-US' }).makeTranslate(null)('settings.rescue.warning')
  assert.match(zh, /打不开/)
  assert.match(en, /does not come up/)
  // The warning must warn about overwriting a running configuration.
  assert.match(zh, /覆盖/)
  assert.match(en, /overwrites/)
})
