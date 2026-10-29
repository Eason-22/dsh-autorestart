/**
 * REGISTERING THE WATCHDOG — one way per tier.
 *
 * The tiers differ in ONE thing only: how the watchdog is made to run later.
 * Everything after that (wait, re-check, restore, start again, report) is the
 * same code for every tier — see lib/watchdog.js.
 *
 * Each registration says what it did:
 *
 *   - the Windows task is read back after it was registered (and deleted
 *     completely afterwards);
 *   - the systemd unit is reset (`reset-failed`) when it is over, so it does
 *     not lie around as a failed unit;
 *   - the detached process writes its pid into the state directory, and the
 *     process is READ BACK to prove that it is really running.
 */

import fs from 'node:fs';
import path from 'node:path';

import { defaultExec, TIERS } from './watchdog-tier.js';

/**
 * The XML of a one-off Windows task.
 *
 * Two things are easy to get wrong, and both are learned the hard way:
 *
 *   - a one-off task needs an `EndBoundary`: without it the task has no end
 *     and the registration is refused;
 *   - `MultipleInstancesPolicy` must be `IgnoreNew`: a second instance of the
 *     watchdog would fight the first one over the same lock.
 *
 * @param {{ startIso: string, endIso: string, command: string, description?: string }} options
 * @returns {string}
 */
export function buildScheduledTaskXml({ startIso, endIso, command, description = 'dsh-autorestart watchdog' }) {
  const escape = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>' + escape(description) + '</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <TimeTrigger>',
    '      <StartBoundary>' + escape(startIso) + '</StartBoundary>',
    '      <EndBoundary>' + escape(endIso) + '</EndBoundary>',
    '      <Enabled>true</Enabled>',
    '    </TimeTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <Enabled>true</Enabled>',
    '    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    '      <Command>cmd</Command>',
    '      <Arguments>/c ' + escape(command) + '</Arguments>',
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

/**
 * Register the one-off Windows task and read it back.
 *
 * @param {{
 *   taskName: string,
 *   startIso: string,
 *   endIso: string,
 *   command: string,
 *   xmlPath: string,
 *   exec?: Function,
 *   writeFile?: Function,
 *   removeFile?: Function,
 * }} options
 * @returns {{ ok: boolean, taskName: string, error: string|null, steps: Array<object> }}
 */
export function registerScheduledTask({
  taskName,
  startIso,
  endIso,
  command,
  xmlPath,
  exec = defaultExec,
  writeFile = (target, content) => fs.writeFileSync(target, content, 'utf8'),
  removeFile = (target) => fs.rmSync(target, { force: true }),
}) {
  const steps = [];
  const step = (kind, ok, detail) => {
    steps.push({ kind, ok, detail: detail === undefined ? null : detail });
    return ok;
  };
  const xml = buildScheduledTaskXml({ startIso, endIso, command });
  try {
    writeFile(xmlPath, xml);
  } catch (error) {
    step('write-xml', false, error && error.message ? error.message : String(error));
    return { ok: false, taskName, error: 'the task description could not be written', steps };
  }
  step('write-xml', true, xmlPath);
  const created = exec('schtasks', ['/Create', '/TN', taskName, '/XML', xmlPath, '/F']);
  if (!step('create', created.ok, created.ok ? 'the task was registered' : created.error)) {
    removeFile(xmlPath);
    return { ok: false, taskName, error: created.error || 'the task was refused', steps };
  }
  // The read back: "it answered" is not "it is there".
  const query = exec('schtasks', ['/Query', '/TN', taskName, '/XML']);
  if (!step('verify', query.ok, query.ok ? 'the task was read back' : query.error)) {
    removeFile(xmlPath);
    return { ok: false, taskName, error: query.error || 'the task cannot be read back', steps };
  }
  const start = /<StartBoundary>([^<]+)<\/StartBoundary>/i.exec(query.stdout || '');
  const end = /<EndBoundary>([^<]+)<\/EndBoundary>/i.exec(query.stdout || '');
  const triggerOk = start !== null && String(start[1]).slice(0, 16) === String(startIso).slice(0, 16);
  if (!step('trigger', triggerOk, 'expected ' + startIso + ', got ' + (start ? start[1] : 'nothing'))) {
    removeFile(xmlPath);
    return { ok: false, taskName, error: 'the task was registered with another trigger', steps };
  }
  if (!step('end-boundary', end !== null, 'a one-off task needs an EndBoundary')) {
    removeFile(xmlPath);
    return { ok: false, taskName, error: 'the task has no end boundary', steps };
  }
  const ignoreNew = /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/i.test(query.stdout || '');
  step('ignore-new', ignoreNew, 'a second instance must not fight the first one');
  removeFile(xmlPath);
  return { ok: true, taskName, error: null, steps };
}

/**
 * Delete the one-off Windows task completely.
 *
 * @param {{ taskName: string, exec?: Function }} options
 * @returns {{ ok: boolean, error: string|null }}
 */
export function removeScheduledTask({ taskName, exec = defaultExec }) {
  const answer = exec('schtasks', ['/Delete', '/TN', taskName, '/F']);
  return { ok: answer.ok === true, error: answer.ok ? null : (answer.error || 'the task could not be deleted') };
}

/**
 * The local time of a moment, in the format the task XML wants.
 *
 * A one-off task is triggered by a LOCAL time: an ISO time with a `Z` would
 * be read as UTC and the task would fire hours later (or never).
 *
 * @param {Date|number} when
 * @returns {string}
 */
export function localIso(when) {
  const date = when instanceof Date ? when : new Date(Number(when) || Date.now());
  const pad = (value) => String(value).padStart(2, '0');
  return date.getFullYear()
    + '-' + pad(date.getMonth() + 1)
    + '-' + pad(date.getDate())
    + 'T' + pad(date.getHours())
    + ':' + pad(date.getMinutes())
    + ':' + pad(date.getSeconds());
}

/**
 * Register a systemd user timer.
 *
 * @param {{ unitId: string, delaySeconds: number, command: string[], exec?: Function }} options
 * @returns {{ ok: boolean, unitId: string, error: string|null }}
 */
export function registerSystemdRun({ unitId, delaySeconds, command, exec = defaultExec }) {
  const seconds = Math.max(1, Math.trunc(Number(delaySeconds) || 1));
  const argv = Array.isArray(command) ? command.map((entry) => String(entry)) : [String(command ?? '')];
  const answer = exec('systemd-run', [
    '--user',
    '--on-active=' + seconds + 's',
    '--unit=' + unitId,
    '--',
    ...argv,
  ]);
  return { ok: answer.ok === true, unitId, error: answer.ok ? null : (answer.error || 'systemd-run refused') };
}

/**
 * Clean the systemd unit up (a failed unit would stay in the list).
 *
 * @param {{ unitId: string, exec?: Function }} options
 * @returns {{ ok: boolean, error: string|null }}
 */
export function cleanupSystemdUnit({ unitId, exec = defaultExec }) {
  const answer = exec('systemctl', ['--user', 'reset-failed', unitId]);
  return { ok: answer.ok === true, error: answer.ok ? null : (answer.error || null) };
}

/**
 * Start the watchdog as a background process of our own.
 *
 * The pid is written into the state directory (so the process can be cleaned
 * up later) and the process is READ BACK: a background job that died at once
 * is not a watchdog.
 *
 * @param {{
 *   delaySeconds: number,
 *   command: string,
 *   pidPath: string,
 *   exec?: Function,
 *   writeFile?: Function,
 *   isAlive?: (pid: number) => boolean,
 * }} options
 * @returns {{ ok: boolean, pid: number, pidPath: string, error: string|null }}
 */
export function registerDetachedProcess({
  delaySeconds,
  command,
  pidPath,
  exec = defaultExec,
  writeFile = (target, content) => fs.writeFileSync(target, content, 'utf8'),
  isAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
}) {
  const seconds = Math.max(0, Math.trunc(Number(delaySeconds) || 0));
  // `setsid` detaches the process from this session: it survives the restart
  // that is about to happen.
  const shell = "setsid nohup sh -c 'sleep " + seconds + "; " + command + "' >/dev/null 2>&1 & echo $!";
  const answer = exec('sh', ['-c', shell]);
  if (!answer.ok) {
    return { ok: false, pid: 0, pidPath, error: answer.error || 'the background process could not be started' };
  }
  const pid = Number.parseInt(String(answer.stdout || '').trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return { ok: false, pid: 0, pidPath, error: 'the background process did not report a pid' };
  }
  try {
    writeFile(pidPath, String(pid) + '\n', 'utf8');
  } catch {
    // The pid file is a convenience; the watchdog itself is running.
  }
  if (!isAlive(pid)) {
    return { ok: false, pid, pidPath, error: 'the background process is not running' };
  }
  return { ok: true, pid, pidPath, error: null };
}

/**
 * Stop the background process of our own (when it is still around).
 *
 * @param {{ pidPath: string, kill?: Function, readPid?: Function }} options
 * @returns {{ ok: boolean, pid: number, error: string|null }}
 */
export function removeDetachedProcess({
  pidPath,
  kill = (pid) => { try { process.kill(pid, 'SIGTERM'); } catch { /* it is gone */ } },
  readPid = () => {
    try {
      return Number.parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
    } catch {
      return 0;
    }
  },
}) {
  const pid = readPid();
  if (!Number.isFinite(pid) || pid <= 0) return { ok: true, pid: 0, error: null };
  kill(pid);
  try {
    fs.rmSync(pidPath, { force: true });
  } catch {
    // The file is gone on the next run anyway.
  }
  return { ok: true, pid, error: null };
}

/**
 * Remove the scheduling item of a tier.
 *
 * @param {{ tier: string, taskName?: string, unitId?: string, pidPath?: string, exec?: Function }} options
 * @returns {{ ok: boolean, error: string|null }}
 */
export function removeScheduleItem({ tier, taskName = '', unitId = '', pidPath = '', exec = defaultExec }) {
  if (tier === TIERS.SCHEDULED_TASK) return removeScheduledTask({ taskName, exec });
  if (tier === TIERS.SYSTEMD_RUN) return cleanupSystemdUnit({ unitId, exec });
  if (tier === TIERS.DETACHED_PROCESS) return removeDetachedProcess({ pidPath });
  return { ok: true, error: null };
}

/**
 * Where the pid of the background process is written.
 *
 * @param {string} stateDir
 * @returns {string}
 */
export function detachedPidPath(stateDir) {
  return path.join(stateDir, 'watchdog.pid');
}
