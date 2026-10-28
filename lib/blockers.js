/**
 * dsh-autorestart — ONE task count for every surface.
 *
 * A TASK is one conversation of the left sidebar: the session itself. A
 * subagent belongs to the session that spawned it, so a session and its
 * subagents are ONE task. The sidebar counts them once — so the bubble has
 * to count them the same way.
 *
 * THE DEFECT THIS FIXES
 *
 * The real machine showed this:
 *
 *     blockedBy: [1] session  (父会话 A)
 *                [2] subagent (父 = A)
 *                [3] subagent (父 = B)
 *
 * The sidebar showed TWO busy conversations, and the bubble said "waiting for
 * 3 tasks to finish". It counted every BLOCKER, so a parent session and its
 * own subagent were counted twice.
 *
 * THE RULE (one rule, four surfaces)
 *
 *   - a session is a task of its own: its key is its own session id;
 *   - a subagent belongs to the session that created it: its key is the
 *     PARENT's session id, so a parent and its subagents are ONE task;
 *   - a subagent whose parent is only known by its TITLE joins the session
 *     with that title (the shutdown card reports the title but no id);
 *   - a subagent with no known parent at all is a task of its own;
 *   - a pending restart is not a task: it is what the shutdown waits for.
 *
 * THE TWO HALVES
 *
 * The browser half of this rule lives in `client.js`: the client is a CLASSIC
 * script and cannot import an ES module. The two implementations MUST agree,
 * and `test/task-count.test.mjs` runs the same cases through both — so a
 * change on one side that is not made on the other fails the suite.
 *
 * ESM only, Node builtins only.
 */

/** The prefix of the key of a family that is known by its session id. */
const SESSION_KEY = 'session:'

/** The prefix of the key of a family that is only known by its title. */
const TITLE_KEY = 'title:'

/**
 * One trimmed string field of a blocker.
 *
 * @param {any} entry
 * @param {string} key
 * @returns {string}
 */
function field(entry, key) {
  if (!entry || typeof entry !== 'object') return ''
  const value = entry[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * WHAT a blocker is: a session, a subagent or a pending restart.
 *
 * The kind is NOT the only evidence: an entry that names a parent session
 * (`parentSessionId` / `parentTitle`) IS a subagent, whatever the Host
 * called it.
 *
 * @param {any} entry
 * @returns {'session'|'subagent'|'restart-pending'}
 */
export function blockerKind(entry) {
  if (!entry || typeof entry !== 'object') return 'session'
  if (entry.kind === 'restart-pending') return 'restart-pending'
  if (entry.kind === 'subagent') return 'subagent'
  if (entry.kind === 'session') return 'session'
  if (field(entry, 'parentSessionId') !== '' || field(entry, 'parentTitle') !== '') return 'subagent'
  return 'session'
}

/**
 * The session id of a blocker.
 *
 * @param {any} entry
 * @returns {string}
 */
function sessionIdOf(entry) {
  if (!entry || typeof entry !== 'object') return ''
  const value = entry.sessionId
  return value == null ? '' : String(value).trim()
}

/**
 * The title of the session a subagent belongs to.
 *
 * @param {any} entry
 * @returns {string}
 */
function parentTitleOf(entry) {
  return field(entry, 'parentTitle') || field(entry, 'label')
}

/**
 * The title of a blocker (for a session: its own title).
 *
 * @param {any} entry
 * @returns {string}
 */
function titleOf(entry) {
  return field(entry, 'label') || field(entry, 'title')
}

/**
 * The map "title of a session" → "session id" of the sessions in the list.
 *
 * It is the fallback for the surfaces that report the parent by its title
 * only (the shutdown card): without it, the members of a team would become
 * tasks of their own.
 *
 * @param {any[]} entries
 * @returns {Map<string, string>}
 */
function sessionTitles(entries) {
  const map = new Map()
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    if (blockerKind(entry) === 'subagent') continue
    const title = titleOf(entry)
    if (title === '') continue
    const id = sessionIdOf(entry)
    if (id === '') continue
    if (!map.has(title)) map.set(title, id)
  }
  return map
}

/**
 * The key of the family every entry belongs to.
 *
 * One key per entry, in the order of the list ('' for an entry that is not a
 * task at all).
 *
 * @param {any[]} entries the blockers the Host reported
 * @returns {string[]}
 */
export function blockerTaskKeys(entries) {
  const list = Array.isArray(entries) ? entries : []
  const titles = sessionTitles(list)
  const keys = []
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index]
    if (!entry || typeof entry !== 'object') {
      keys.push('')
      continue
    }
    const kind = blockerKind(entry)
    if (kind === 'restart-pending') {
      // A pending restart is not a task: it is what the shutdown waits for.
      keys.push('')
      continue
    }
    if (kind === 'subagent') {
      const parentId = field(entry, 'parentSessionId')
      if (parentId !== '') {
        keys.push(SESSION_KEY + parentId)
        continue
      }
      const parentTitle = parentTitleOf(entry)
      if (parentTitle !== '') {
        const known = titles.get(parentTitle)
        keys.push(known ? SESSION_KEY + known : TITLE_KEY + parentTitle)
        continue
      }
      const own = sessionIdOf(entry)
      keys.push(own !== '' ? SESSION_KEY + own : 'entry:' + index)
      continue
    }
    const own = sessionIdOf(entry)
    keys.push(own !== '' ? SESSION_KEY + own : 'entry:' + index)
  }
  return keys
}

/**
 * How many TASKS the blockers are.
 *
 * A parent session and its own subagents are ONE task: the same number the
 * left sidebar shows.
 *
 * @param {any[]} entries the blockers the Host reported
 * @returns {number}
 */
export function countBlockerTasks(entries) {
  const keys = blockerTaskKeys(entries)
  const families = new Set()
  for (const key of keys) {
    if (key !== '') families.add(key)
  }
  return families.size
}

/**
 * How many of those tasks are carried by SUBAGENTS ONLY.
 *
 * A task whose session is idle and whose subagent works is a task of the
 * subagent — that is what the card tells the user ("2 of them are
 * subagents"). A task whose session works itself is not one of them, even
 * when it has subagents of its own.
 *
 * @param {any[]} entries the blockers the Host reported
 * @returns {number}
 */
export function countSubagentTasks(entries) {
  const list = Array.isArray(entries) ? entries : []
  const keys = blockerTaskKeys(list)
  const families = new Map()
  list.forEach((entry, index) => {
    const key = keys[index]
    if (key === '') return
    const family = families.get(key) || { session: false, subagent: false }
    if (blockerKind(entry) === 'subagent') family.subagent = true
    else family.session = true
    families.set(key, family)
  })
  let count = 0
  for (const family of families.values()) {
    if (family.subagent && !family.session) count += 1
  }
  return count
}
