/**
 * The client half must keep its names to itself.
 *
 * WHAT HAPPENED IN THE FIELD: this plugin declared `const ZH` (and `const
 * EN`, and about forty more names) at the top level of a CLASSIC script. The
 * browser concatenates the client scripts of ALL the plugins into ONE bundle,
 * and those scripts therefore share ONE global lexical scope: another plugin
 * declared `const ZH` as well, and the whole bundle died with
 *
 *     Uncaught SyntaxError: Identifier 'ZH' has already been declared
 *
 * Every client plugin was dead with it, the Host reported "1 entry did not
 * activate" and the desktop app could not start at all.
 *
 * THE CONTRACT, proved below with the real semantics:
 *
 *   - the client script declares NOTHING at the top level (the whole file is
 *     one IIFE), so the bundle scope stays free of our names;
 *   - the bundle COMPILES next to another plugin that declares the same
 *     names. It is compiled with `new vm.Script(code)` — SCRIPT semantics: a
 *     `new Function` would hide the collision inside a function scope;
 *   - the bundle RUNS: the plugin still registers itself with the module
 *     loader and its exports still compute the task keys.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

/** The client script, exactly as the browser would evaluate it. */
const CLIENT_SOURCE = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/**
 * The client script of ANOTHER plugin: the same short names.
 *
 * This is what really happened in the field — another plugin declared `ZH`
 * and `EN` too. The probe at the end reads the other plugin's own `ZH`, so
 * the test can also prove that it survived.
 */
const OTHER_PLUGIN = [
  'const ZH = { hello: "zh" }',
  'const EN = { hello: "en" }',
  'const SLEEP_EXPORTS = { other: true }',
  'const moduleLoader = null',
  'function lookupSleepText() { return "the other plugin" }',
  'globalThis.__otherPluginProbe = ZH.hello',
].join('\n')

/** A blocking session — the shape the Host really sends. */
function session(sessionId, label) {
  return {
    sessionId,
    reason: 'running',
    kind: 'session',
    label,
    name: label,
    parentTitle: null,
    parentSessionId: null,
  }
}

/** A blocking subagent — the parent is known by its id. */
function subagent(sessionId, parentSessionId, parentTitle) {
  return {
    sessionId,
    reason: 'running',
    kind: 'subagent',
    label: parentTitle,
    name: `${parentTitle}的子智能体`,
    parentTitle,
    parentSessionId,
  }
}

/** A `localStorage` / `sessionStorage` stand-in. */
function createStorage() {
  const values = new Map()
  return {
    getItem: (key) => (values.has(String(key)) ? values.get(String(key)) : null),
    setItem: (key, value) => { values.set(String(key), String(value)) },
    removeItem: (key) => { values.delete(String(key)) },
    clear: () => { values.clear() },
  }
}

/* ------------------------------------------------------------------ *
 * The shape of the file.
 * ------------------------------------------------------------------ */

test('the whole client script is ONE IIFE', () => {
  const lines = CLIENT_SOURCE.split('\n')
  const opener = lines.findIndex((line) => line.trim() === ';(function () {')
  const closer = lines.findLastIndex((line) => line.trim() === '})()')
  assert.ok(opener > 0, 'the file must open with the IIFE')
  assert.ok(closer > opener, 'the file must close the IIFE at its end')
  // The loader call stays INSIDE the wrapper: the registration happens at the
  // same moment as before, nothing is deferred.
  const loader = lines.findIndex((line) => line.includes('moduleLoader.load('))
  assert.ok(loader > opener && loader < closer, 'the loader call must stay inside the IIFE')
})

test('the client script declares NOTHING in the bundle scope', () => {
  const offenders = []
  CLIENT_SOURCE.split('\n').forEach((line, index) => {
    // A declaration at the left margin lands in the scope the browser shares
    // with every other plugin of the bundle.
    if (/^(const|let|var|function|class|async)\s/.test(line)) {
      offenders.push(`${index + 1}: ${line.slice(0, 80)}`)
    }
  })
  assert.deepEqual(offenders, [], 'no declaration may sit at the left margin of the bundle scope')
})

/* ------------------------------------------------------------------ *
 * The bundle: another plugin with the same names.
 * ------------------------------------------------------------------ */

test('the bundle COMPILES next to another plugin that declares the same names', () => {
  const bundle = OTHER_PLUGIN + '\n' + CLIENT_SOURCE
  // `new vm.Script` is SCRIPT semantics — the same as the browser's
  // `<script>`: a `new Function` would hide the collision in a function scope.
  assert.doesNotThrow(() => new vm.Script(bundle, { filename: 'bundle.js' }))
})

test('the shape that broke the desktop app IS a syntax error', () => {
  // Without the wrapper the very same names in the very same bundle scope are
  // a SyntaxError — the failure the user saw in the field. The guard above
  // only means something because this is still true.
  const broken = OTHER_PLUGIN + '\nconst ZH = { hello: "ours" }\n'
  assert.throws(
    () => new vm.Script(broken, { filename: 'bundle.js' }),
    /already been declared/,
  )
})

/* ------------------------------------------------------------------ *
 * The bundle RUNS: the plugin still works.
 * ------------------------------------------------------------------ */

test('the bundle RUNS: the plugin registers itself and its exports still work', () => {
  const registered = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (value) => { registered.push(value) },
      },
      localStorage: createStorage(),
      sessionStorage: createStorage(),
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {},
      removeEventListener: () => {},
      location: { reload: () => {} },
    },
    document: {
      getElementById: () => null,
      createElement: (tag) => ({
        tag,
        id: '',
        textContent: '',
        parentNode: null,
        setAttribute: () => {},
        appendChild: () => {},
      }),
      head: { appendChild: (node) => node, removeChild: () => {} },
      querySelector: () => null,
    },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    AbortController,
  }
  vm.createContext(sandbox)
  vm.runInContext(OTHER_PLUGIN + '\n' + CLIENT_SOURCE, sandbox, { filename: 'bundle.js' })

  // The other plugin's own declaration is untouched.
  assert.equal(sandbox.__otherPluginProbe, 'zh', "the other plugin's ZH must survive")

  // Our plugin registered itself with the module loader.
  assert.equal(registered.length, 1, 'the client must register itself exactly once')
  assert.equal(registered[0].id, 'dsh-autorestart')
  assert.equal(typeof registered[0].factory, 'function')

  // Our names are NOT in the bundle scope any more: they are private to the
  // IIFE, so no other plugin can ever collide with them.
  for (const name of ['ZH', 'EN', 'SLEEP_EXPORTS', 'moduleLoader', 'blockerTaskKeys']) {
    assert.equal(sandbox[name], undefined, `${name} must not leak into the bundle scope`)
  }
  // A `function` declaration of the other plugin is still ITS function: ours
  // (the same name, inside the IIFE) did not overwrite it. (A function
  // declaration lands on the global object, a `const` does not — that is why
  // the `const` collision was the fatal one and this one only silent.)
  assert.equal(sandbox.lookupSleepText(), 'the other plugin')

  // The exports still work: the task keys of the live blockers.
  // (The array is copied into THIS realm: the sandbox has its own Array.)
  const api = sandbox.__dshAutorestartClient
  assert.ok(api, 'the client must publish its helpers on globalThis.__dshAutorestartClient')
  assert.equal(typeof api.blockerTaskKeys, 'function')
  const live = [
    session('sess-a', '写代码'),
    subagent('sess-child-a', 'sess-a', '写代码'),
    subagent('sess-child-b', 'sess-b', '调研'),
  ]
  assert.deepEqual(
    [...api.blockerTaskKeys(live)],
    ['session:sess-a', 'session:sess-a', 'session:sess-b'],
  )
  assert.equal(
    api.countBlockerTasks(live),
    2,
    'the parent and its own subagent are one task',
  )
})
