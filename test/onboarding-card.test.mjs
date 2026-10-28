/**
 * The one-time question about the self-starting supervisor.
 *
 * The card is a COMPLIANCE surface, not a decoration: it has to say what it
 * would change, which rights it needs, and how to remove it again. A user who
 * cannot undo it will not press the button.
 *
 * The copy lives in two places (the locale files of the package AND the
 * built-in dictionaries of the client), so both are checked here: a card that
 * says the wrong thing in one language is a card that lies.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import '../client.js'

/**
 * The pure helpers the client publishes for the tests.
 *
 * `client.js` is a CLASSIC script (the client module loader evaluates it as
 * a same-origin external classic script), so it has no ESM exports: the
 * dictionaries are read from the global namespace.
 */
const api = globalThis.__dshAutorestartClient
assert.ok(api, 'the client must publish its pure helpers on globalThis.__dshAutorestartClient')
const { dictionaries } = api

const zh = JSON.parse(fs.readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
const en = JSON.parse(fs.readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))

/** The three paragraphs the card has to carry. */
const MANDATORY = ['changes', 'rights', 'uninstall']

/** The three options of the card. */
const OPTIONS = ['install', 'keep', 'later']

test('the locale files carry the three mandatory paragraphs of the card', () => {
  for (const [name, locale] of [['zh', zh], ['en', en]]) {
    assert.ok(locale.supervisor, `${name}: the supervisor copy is missing`)
    for (const key of MANDATORY) {
      const text = locale.supervisor[key]
      assert.equal(typeof text, 'string', `${name}.supervisor.${key} is missing`)
      assert.ok(text.length > 20, `${name}.supervisor.${key} must say something`)
    }
    for (const key of OPTIONS) {
      const text = locale.supervisor[key]
      assert.equal(typeof text, 'string', `${name}.supervisor.${key} is missing`)
      assert.ok(text.length > 0, `${name}.supervisor.${key} must not be empty`)
    }
  }
})

test('the card says that the supervisor can be removed at any time', () => {
  // The user has to know BEFORE pressing the button that this is reversible.
  assert.match(zh.supervisor.installHint, /随时.*卸载/, 'the Chinese card must promise the uninstall')
  assert.match(en.supervisor.installHint, /uninstall/i, 'the English card must promise the uninstall')
  // And the manual way out has to be spelled out.
  assert.match(zh.supervisor.uninstall, /schtasks/, 'the Chinese card must name the manual command')
  assert.match(zh.supervisor.uninstall, /systemctl/, 'the Chinese card must name the Linux command')
  assert.match(en.supervisor.uninstall, /schtasks/, 'the English card must name the manual command')
  assert.match(en.supervisor.uninstall, /systemctl/, 'the English card must name the Linux command')
})

test('the card says that NO administrator rights are needed', () => {
  assert.match(zh.supervisor.rights, /不需要管理员/, 'the Chinese card must promise the zero rights')
  assert.match(en.supervisor.rights, /NO administrator/i, 'the English card must promise the zero rights')
})

test('the card says what it changes AND what it does not touch', () => {
  assert.match(zh.supervisor.changes, /会改什么/, 'the Chinese card must name what it changes')
  assert.match(zh.supervisor.changes, /不改/, 'the Chinese card must name what it leaves alone')
  assert.match(en.supervisor.changes, /What it changes/, 'the English card must name what it changes')
  assert.match(en.supervisor.changes, /does NOT change/, 'the English card must name what it leaves alone')
})

test('the built-in dictionaries of the client carry the same copy', () => {
  // The client falls back to its own dictionaries when the locale file of the
  // host is missing — so the two must not drift apart.
  for (const key of ['title', 'body', 'install', 'keep', 'later', 'error', ...MANDATORY]) {
    assert.equal(typeof dictionaries.zh['supervisor.' + key], 'string', 'zh.supervisor.' + key + ' is missing')
    assert.equal(typeof dictionaries.en['supervisor.' + key], 'string', 'en.supervisor.' + key + ' is missing')
  }
  assert.match(dictionaries.zh['supervisor.installHint'], /随时.*卸载/)
  assert.match(dictionaries.en['supervisor.installHint'], /uninstall/i)
})

test('the settings page can say who starts the host', () => {
  for (const key of ['status', 'installed', 'external', 'unknown', 'capable', 'install', 'uninstall', 'access']) {
    assert.equal(typeof dictionaries.zh['settings.supervisor.' + key], 'string', 'zh.settings.supervisor.' + key + ' is missing')
    assert.equal(typeof dictionaries.en['settings.supervisor.' + key], 'string', 'en.settings.supervisor.' + key + ' is missing')
  }
  assert.equal(dictionaries.zh['settings.groups.supervisor'], '开机自启')
  assert.equal(dictionaries.en['settings.groups.supervisor'], 'Start at login')
  // The settings copy exists in the locale files too.
  assert.ok(zh.settings.supervisor, 'the zh locale has no supervisor settings')
  assert.ok(en.settings.supervisor, 'the en locale has no supervisor settings')
  assert.equal(zh.settings.groups.supervisor, '开机自启')
  assert.equal(en.settings.groups.supervisor, 'Start at login')
})

test('the supervisor copy is the same in both languages', () => {
  // A key that exists in one language but not in the other shows the raw key
  // in the interface — so the two dictionaries must carry the same keys.
  const zhKeys = Object.keys(zh.supervisor).sort()
  const enKeys = Object.keys(en.supervisor).sort()
  assert.deepEqual(zhKeys, enKeys, 'the supervisor copy must exist in both languages')
  const zhSettings = Object.keys(zh.settings.supervisor).sort()
  const enSettings = Object.keys(en.settings.supervisor).sort()
  assert.deepEqual(zhSettings, enSettings, 'the supervisor settings must exist in both languages')
})
