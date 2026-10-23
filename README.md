# dsh-autorestart

Restart DeepSeek Harness without losing the work that is currently running.

[![npm version](https://img.shields.io/npm/v/dsh-autorestart?style=flat-square)](https://www.npmjs.com/package/dsh-autorestart)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![dsh-plugin](https://img.shields.io/github/topics/dsh-plugin?style=flat-square)](https://github.com/topics/dsh-plugin)
[![language](https://img.shields.io/badge/language-JavaScript-yellow?style=flat-square)](https://github.com/Eason-22/dsh-autorestart)

Chinese version: [README.zh.md](README.zh.md)

## What it does

`dsh-autorestart` turns a DeepSeek Harness restart into a resumable event instead of a dead end.

An agent can request a graceful restart. The plugin waits until every conversation is idle and the
host has been quiet for the settle window, then it restarts the host. Once the host is back, the
interrupted sessions resume automatically: a session that owns a durable goal gets that goal
re-armed so the goal round driver starts the next round, and a session without a goal receives one
continuation message that asks it to pick up where it left off.

Several sessions can request a restart at the same time. Those requests are coalesced into **one**
restart, and every requester is woken afterwards — not only the last one.

A goal-driven session would otherwise keep the restart waiting forever, because its goal starts the
next round as soon as the agent goes idle. The plugin therefore **disarms** such a goal before the
restart: the round that is running right now still finishes normally and nothing is lost, but no new
round starts, so the session goes idle and the restart can proceed. The goal is re-armed after the
restart and continues.

The browser shows the state: a compact "pending restart" pill on the left side of the input toolbar
and a small dot next to the session title in the sidebar. The pill can be clicked for details, and
the dot breathes when the restart is about to fire.

Two safety gates protect the restart. The host checks that no conversation is busy, and the detached
helper checks the same gate over loopback immediately before it kills the process, so a turn that
starts in between is never killed.

## Why

| Situation | Without it | With it |
| --- | --- | --- |
| An agent is running a long task and DSH is restarted or crashes | The round is lost and you have to type "continue" by hand | The new process resumes the session and injects a continuation message, so the work continues without you |
| An agent owns a durable goal (`create_goal`) that should survive a restart | The goal activation lives in the process, so after the restart it is `disarmed` and the automatic continuation stops | The plugin re-arms the goal at boot and the goal round driver starts the next round right away |
| An agent wants to install or upgrade a plugin, but a restart would cut the work short | You either wait or take the risk | Call `continuum_restart`: it waits until every agent is idle and the session continues by itself afterwards |

## Install

From npm — the package is published under the name `dsh-autorestart`:

```sh
dsh plugin install dsh-autorestart
```

From source:

```sh
git clone https://github.com/Eason-22/dsh-autorestart.git
cd dsh-autorestart
dsh plugin --profile desktop add /absolute/path/to/dsh-autorestart
```

Inside DSH the equivalent is the `plugin_manager` tool:

```
plugin_manager install_bundle  target = <absolute path to the package>
```

Installing into a profile adds a row with the id `dsh-autorestart` to the plugin list. The host half
of the plugin takes effect immediately, but the client half (the pending restart pill and the
sidebar dot) is loaded by the browser, so refresh the page or restart DSH once after the install.

## Usage

The plugin registers six tools for the agent. All of them are also visible to you in the session,
so you can call them yourself.

| Tool | What it does | Parameters |
| --- | --- | --- |
| `continuum_restart` | Requests a graceful restart. The restart waits until every conversation is idle and the host has been quiet for `settleMs`, then the app is relaunched and this session resumes automatically. | `reason` (string, recorded in the checkpoint and the log), `resume` (boolean, default `true`), `defer_seconds` (number, extra seconds to wait before the first idle check), `parkGoals` (boolean, default `true`) — disarm a goal-driven session before the restart |
| `continuum_status` | Read-only snapshot of the lifecycle: whether a restart is pending, which sessions were checkpointed, why each blocking session blocks, the goals this plugin disarmed, the last recovery action per session, the handoffs, the state file path and the detected restart environment. | `include_sessions` (boolean, default `true`) — include the per-session checkpoint entries |
| `continuum_cancel_restart` | Cancels a pending restart and releases the continuation request of every requester. Does nothing when no restart is pending. | none |
| `continuum_park_goal` | Disarms the goal of a session so that it no longer blocks the restart. The current round still finishes and the goal is re-armed after the restart. | `sessionId` (string, optional) — defaults to the calling session |
| `continuum_recover_now` | Re-runs the recovery immediately instead of waiting for the next restart, and reports the action and the reason for each session. | `sessionId` (string, optional) — defaults to all sessions pending recovery |
| `continuum_handoff` | Hands a session whose conversation exceeded the model context window over to a fresh session, carrying the goal objective, the recorded reasons and a bounded tail of the conversation. | `sessionId` (string, optional) — defaults to the calling session, `maxChars` (number, default `20000`) — character budget for the conversation tail |

A goal is an enhancement, not a requirement: without one, the plugin injects a single continuation
message instead of re-arming a goal.

## Configuration

Every key has a default, written in the `insert` row of `cordis.patch.yml`. To override a key, add
an `- id: dsh-autorestart` row with the same key to the `cordis.patch.yml` of the profile at
`~/.dsh/profiles/<profile>/cordis.patch.yml` (it replaces the whole config, it is not merged). The
plugin also exports a real schemastery `Config` schema, so the keys, their types and their defaults
show up in the Plugin Manager and in the config editor.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Turns the whole plugin off. |
| `stateFile` | `''` | Path of the checkpoint file. Empty means `<DSH_HOME>/storages/dsh-autorestart/state.json`. |
| `resumeOnBoot` | `true` | Whether interrupted sessions are resumed automatically at boot. |
| `recoveryDelayMs` | `6000` | How long to wait after boot before resuming, so the session store and the model are ready. |
| `maxSessions` | `4` | Maximum number of sessions resumed per boot. |
| `maxResumeAttempts` | `2` | Maximum resume attempts per session, counted across boots, so a bad session cannot loop forever. |
| `deferPollMs` | `3000` | Poll interval while waiting for the conversations to go idle. |
| `deferSoftMs` | `300000` | Soft deadline: warn when the conversations are still busy after this long. |
| `deferHardMs` | `900000` | Hard deadline: warn after this long. The restart is only forced when `forceRestartWhenBusy` is enabled. |
| `deferPolicy` | `auto` | `auto` = after the hard deadline, follow `forceRestartWhenBusy` (by default keep waiting). `wait` = wait forever. |
| `forceRestartWhenBusy` | `false` | Whether a restart may be forced while a conversation is still running. The default `false` never interrupts a session: the plugin waits until the other conversations finish. |
| `restartMode` | `app` | `app` = restart the DeepSeek Harness desktop app. `command` = run `restartCommand`. |
| `restartCommand` | `''` | Custom restart command. Supports the `{pid}`, `{ppid}` and `{app}` placeholders. |
| `relaunchDelaySeconds` | `2` | How long the detached helper waits before it kills the app (`ping -n 3`, roughly 2 seconds). |
| `settleMs` | `2000` | Quiet window in milliseconds: the host must stay silent this long after the last conversation activity before a restart may start. |
| `autoReloadPage` | `true` | `dsh web`: reload the page automatically when the host boot token changes. |
| `blockManualRestart` | `true` | Hard-block an agent that tries to kill or restart DSH with a shell command, and point it at `continuum_restart` instead. |
| `healthPath` | `/__dsh_autorestart/health` | Health check route. Returns the boot id, the pid, the phase and the self-check flags. |
| `continuationText` | `''` | Overrides the default continuation prompt text. |

The two waits are independent of each other, and both default to two seconds:

- `settleMs` (`2000` ms) is the quiet window after the last conversation activity during which the
  host has to stay silent before a restart is allowed to start.
- `relaunchDelaySeconds` (`2` seconds) is how long the detached helper waits before it kills the app.

Both can be overridden separately in the profile config. A larger `settleMs` is the more
conservative choice, because it is less likely to cut a session short that has just started.

### Platform note

`restartMode: app` only applies to the DeepSeek Harness desktop app. A hosted `dsh web`
deployment has no desktop app to relaunch, so it must set `restartMode: command` and provide a
restart command of its own:

```yaml
- id: dsh-autorestart
  config:
    restartMode: command
    restartCommand: systemctl --user restart dsh-web
```

Remember that this replaces the whole config instead of merging into it.

## Requirements and limits

- **Windows desktop.** `restartMode: app` restarts the DSH desktop app on Windows. Any other
  platform, and every hosted `dsh web` deployment, has to use `restartMode: command` with its own
  restart command.
- **The manual-restart guard is pattern matching, not a sandbox.** It looks at the command text for
  kill and restart verbs together with DSH process names or the pid of this host. Encoded commands,
  killing by image name, and routes around the guard — a GUI menu, an external script, a system
  reboot — are not covered. It exists to stop an agent from casually killing itself, not to contain
  a hostile command.
- **A session past the model context window cannot continue.** Once a conversation has grown beyond
  the model context window, the provider rejects every request with `invalid_request_error`, and the
  host's own compaction cannot rescue it because the compaction request needs the same oversized
  context. Hand such a session over with `continuum_handoff`; the plugin deliberately refuses to
  auto-resume it.
- **A hosted deployment must let the browser read the state route.** The pending restart pill reads
  `GET <healthPath>?state=1`. The route accepts loopback callers and requests that the host
  connection service considers authenticated browsers. A hosted deployment that blocks it will never
  show the pill.
- **The restart closes and reopens the desktop window.** It is a full app restart, not a hot reload.
- **The resumed round consumes API tokens**, exactly like typing "continue" by hand.

## Verify

The health route tells you whether the plugin is alive and what it has done:

```sh
curl http://127.0.0.1:<gui port>/__dsh_autorestart/health
# {"ok":true,"plugin":"dsh-autorestart","bootId":"…","pid":17884,"phase":"running",
#  "pageHeartbeat":true,"systemPrompt":true,"configSchema":true,"indexTaps":2,…}
```

`bootId` and `pid` change with every new process, so a restart is visible right away.

- `?state=1` returns the pending restart state: `pendingRestart`, `waiters`, `blockedBy`,
  `allowRestart`, `quietForMs`, `settleMs`, `parkedGoals`, `recovery` and `handoffs`.
- `?probeIndex=1` applies the page heartbeat injection to a probe HTML page, so the client half can
  be checked without an authenticated page.
- `?gate=1` returns the live idle gate verdict that the detached helper uses before it kills
  anything.
- `POST /__dsh_autorestart/park` disarms a goal, `POST /__dsh_autorestart/recover` re-runs the
  recovery immediately. Both use the same authentication rules as the health route.
- Inside a session, `continuum_status` reports the same lifecycle.

The plugin ships its own test suite: **129 test cases** in `plugins/dsh-autorestart/test/`, all
green. Run it with the bundled Node, from the workspace root:

```sh
node --test "plugins/dsh-autorestart/test/*.test.mjs"
```

Node 24 treats a positional argument as a glob, so keep the quotes. The same suite also runs with
a bare `node --test` from the package directory. Passing the directory itself (`node --test
test/`) does not work: the argument is read as a glob, and a glob does not match directories.

## Screenshots

![dsh-autorestart icon](assets/icon-180.png)

![dsh-autorestart screenshot 1](assets/screenshot-1.png)

![dsh-autorestart screenshot 2](assets/screenshot-2.png)

![dsh-autorestart screenshot 3](assets/screenshot-3.png)

## License

MIT — see [LICENSE](./LICENSE).

## AI-generated notice

This plugin was generated by an AI and has **not** been reviewed by a human. It restarts your DSH
process and writes local state files, so it can interrupt a running session. Try it in a test
profile first, evaluate the risk yourself, and only then use it in your daily profile.
