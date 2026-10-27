# dsh-autorestart

Restart DeepSeek Harness without losing the work that is currently running.

[![npm version](https://img.shields.io/npm/v/dsh-autorestart?style=flat-square)](https://www.npmjs.com/package/dsh-autorestart)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![dsh-plugin](https://img.shields.io/github/topics/dsh-plugin?style=flat-square)](https://github.com/topics/dsh-plugin)
[![language](https://img.shields.io/badge/language-JavaScript-yellow?style=flat-square)](https://github.com/Eason-22/dsh-autorestart)

Chinese version: [README.zh.md](docs/README.zh.md)

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
and a small dot next to the session title in the sidebar. The pill's text reports how many
conversations are still in the way (counted once per conversation, and the tooltip explains that a
conversation with queued-but-not-started work counts too); it does not open a details panel. The dot
breathes when the restart is about to fire.

Before every restart the plugin snapshots the profile, so a restart that leaves the host unable to
boot is rolled back automatically — see
[Pre-restart backup and automatic rollback](#pre-restart-backup-and-automatic-rollback).

The same "wait until everything is quiet" idea is also available as a **graceful shutdown**: a moon
button at the very bottom of the left sidebar (right next to Settings) waits for every conversation
to be idle, counts down on screen (a floating card with a huge number and a small whale) and then
switches the **real host machine** off — see [Graceful shutdown](#graceful-shutdown-收工关机).

Two safety gates protect the restart. The host checks that no conversation is busy, and the detached
helper checks the same gate over loopback immediately before it kills the process, so a turn that
starts in between is never killed.

## What it occupies in DSH

Nothing here is hidden: this is the complete list of where the plugin attaches itself, so you can see
what it adds before you install it.

| Kind | What it adds |
| --- | --- |
| Agent tools (6) | `continuum_restart`, `continuum_status`, `continuum_cancel_restart`, `continuum_park_goal`, `continuum_recover_now`, `continuum_handoff` |
| HTTP routes (6) | Under `<healthPath>` (default `/__dsh_autorestart`): `GET /health` (also `?state=1`, `?gate=1`, `?probeIndex=1`), `POST /park`, `POST /recover`, `POST /handoff`, `GET /sleep` and `POST /sleep` (the graceful shutdown — in the `human` mode only the page's button may drive it). Loopback or an authenticated browser only |
| Client slots (4) | `conversation.input.left` — the pending-restart pill (`autorestart-restart-pill`); `sidebar.session.row.leading` — the session status dot (`autorestart-restart-dot`); `sidebar.footer.action` — the moon button of the graceful shutdown (`autorestart-sleep-button`); `shell.overlay` — its countdown card |
| System prompt | One "Restart policy" section that tells the agent how to ask for a restart and what the plugin will do |
| Harness hooks | `agent/status` (tracks which conversations are busy), `tools/pre-execute` (blocks a shell command that would kill or relaunch DSH by hand), and the boot pass that resumes interrupted sessions |
| Profile row | One bundle row, `dsh-autorestart` |
| Writes | Only under `<DSH_HOME>/storages/dsh-autorestart/` — `state.json` (checkpoint), `backups/` (pre-restart snapshots), `restart-<gen>.cmd` / `restart-<gen>-watch.ps1` (the detached helper), `last-rollback.json` (rollback report). The only time it writes into the profile itself is a rollback, which copies that snapshot's `cordis.patch.yml`, `package.json`, `pnpm-lock.yaml` and `node_modules` back |

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
| `backupOnRestart` | `true` | Snapshot the profile before every restart, so a restart that leaves the host unable to boot can be rolled back. |
| `backupIncludePlugins` | `true` | Include the installed plugin tree in that snapshot (about 117 MB here, ~3 s). `false` keeps only the configuration files. |
| `maxBackups` | `2` | How many snapshots are kept; older ones are deleted when a new one is written. |
| `rollbackTimeoutMs` | `90000` | How long the detached watcher waits for the relaunched host before it restores the snapshot and launches the host again. |
| `showSleepButton` | `true` | Whether the moon button of the graceful shutdown is shown at the foot of the left sidebar, next to Settings. |
| `sleepCountdownSeconds` | `20` | How many seconds the graceful shutdown counts down before the machine goes down — a dropdown: `0` / `10` / `20` / `30` / `60` seconds. `0` means "switch off right away" (still waiting for the conversations to be idle). |
| `sleepCommand` | `''` | A custom shutdown command for the graceful shutdown. Empty = the host is detected automatically; a value replaces the detected command (`cmd.exe /c …` on Windows, `/bin/sh -c …` everywhere else). |

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

## Pre-restart backup and automatic rollback

A restart is only safe if the host comes back. Before every restart the plugin snapshots the profile
it was started from, so a restart that leaves the host unable to boot can be undone automatically.

- **What is backed up:** `cordis.patch.yml`, `package.json` and `pnpm-lock.yaml`, plus — unless
  `backupIncludePlugins` is turned off — the installed plugin tree (`node_modules`). Snapshots live in
  `<storage>/dsh-autorestart/backups/<timestamp>/` with a `manifest.json` next to them. On a profile
  like this one the full snapshot measures about 117 MB and takes under three seconds.
- **How many are kept:** the newest `maxBackups` snapshots (default `2`); older ones are deleted when
  a new one is written.
- **How a failed boot is detected:** the detached helper that kills and relaunches the host also runs
  a small PowerShell watcher. It polls the health route for `rollbackTimeoutMs` (default `90000`). A
  healthy answer ends the watch and nothing is touched.
- **What happens when the host never answers:** the watcher copies the snapshot back over the profile
  (configuration files, and the plugin tree when the snapshot holds one), writes
  `last-rollback.json` next to the checkpoint — including the tail of the newest crash log written
  *after* this restart — and launches the host again with the restored configuration.
- **How you learn about it:** the next boot reports it. `continuum_status` gains a `lastRollback`
  object (`at`, `waitedMs`, `rolledBack`, `backupDir`, `crashLog`, `crashTail`), and the next restart
  clears the report so it is never mistaken for a fresh one.
- **Turning it off:** `backupOnRestart: false` skips the snapshot entirely (no rollback point, and no
  watcher), which is what a user who keeps their own backups may prefer. `backupIncludePlugins:
  false` keeps the snapshot but limits it to the configuration files.

The rollback is deliberately conservative: it only runs when the relaunched host never answers its
own health route. A slow start inside `rollbackTimeoutMs` is never treated as a failure, and a
healthy host is never touched.

### The one-time install question

The first time the plugin is used, the composer dock shows ONE non-modal panel that asks whether the
pre-restart backup should also snapshot the installed plugin tree:

- **"Configuration + installed plugins"** — about 3 seconds and 117 MB more per restart; a plugin
  that breaks the boot can be rolled back too.
- **"Configuration only"** — instant, about 66 KB; plugin problems cannot be rolled back and need a
  manual reinstall.

Both options share the same base: the **configuration** is always backed up. The plugins are an
addition to it, never a rival of it.

- **It is asked exactly once.** The panel is rendered only while
  `localStorage['dsh-autorestart:backup-choice-v1']` is missing; picking an option records the answer and the
  panel never comes back.
- **Closing the panel counts as answering.** `×` and `Esc` write the very same "already answered" mark as
  picking an option, so that browser is never asked again — and closing keeps the default (configuration *and*
  plugins).
- **It never blocks you.** The panel is a `role="status"` block in the composer dock: the input box
  stays usable, nothing is modal, and the panel does not disappear on its own. It is keyboard
  reachable and `Esc` closes it.
- **Where the answer goes.** The host writes it into the profile configuration with the official
  `configEditor` service — the same `backupIncludePlugins` key the settings page edits, so there is
  one source of truth. If that service is unavailable the answer degrades to
  `<DSH_HOME>/storages/dsh-autorestart/install-choice.json` and a warning is logged. The same fallback
  happens in a hosted profile that declares no `dsh-autorestart` row of its own: there is no row for the
  editor to write, so the answer lands in that file instead of the profile. Declare the row (see
  *Hosted `dsh web` deployments* below) to keep the profile configuration as the single source of truth.
- **How to change your mind later:** Settings → Plugins → dsh-autorestart → `backupIncludePlugins`.
  `continuum_status` always reports the value that is in effect right now
  (`backupIncludePlugins: true | false`).

## Graceful shutdown (收工关机)

**What it does.** One moon button at the very bottom of the left sidebar: press it and the plugin
waits until **every** conversation is idle, the screen counts down (a huge number and a small blue
whale, one line of text per second), and then the machine is switched off. The countdown can always
be cancelled — the card has a button, and the moon button itself becomes a toggle while the shutdown
is armed. If a conversation starts working again during the countdown, the countdown goes back to
"waiting" and nothing is switched off.

**Where the button is.** The moon button sits at the **very bottom of the left sidebar, right next
to the Settings row** (`sidebar.footer.action`). That seat is a **root** slot, so the button is
there even when no conversation is open — on any page. When the sidebar is collapsed into its narrow
rail, the button shows its icon only (the tooltip and the accessible name still say what it does),
so the rail keeps its width.

**The countdown does not cover the interface.** The countdown is a **floating card** in the corner,
not a full-screen mask: it never dims the page, never locks the scrolling and never swallows a
click. You can keep reading the conversation, keep scrolling and keep switching conversations while
it counts down; only the card's own cancel button takes clicks. Switching a conversation or a page
does not interrupt the countdown either — the seconds come from the host, not from the view that
happens to be open.

**What gets switched off: the real host.** Not a subsystem — the whole machine:

| Host | Command |
| --- | --- |
| Windows | `shutdown.exe /s /f /t 0` |
| WSL (the DSH itself runs inside a distribution) | `/mnt/c/Windows/System32/shutdown.exe /s /f /t 0` — the Windows binary through the mounted `C:` drive, so **Windows itself** goes down. The WSL subsystem is never shut down. |
| A real Linux host | `systemctl poweroff` (fallback `shutdown -h now`) |
| macOS | `osascript -e 'tell application "System Events" to shut down'` |
| Anything else | **Nothing is executed at all.** The button stays hidden and the route reports `phase: "unsupported"`. |

A WSL host is recognised through `WSL_DISTRO_NAME`, `WSL_INTEROP`, a `/proc/version` that mentions
Microsoft, or the mounted Windows binary. The countdown belongs to the plugin, so the operating
system is asked to shut down immediately (`/t 0`) instead of counting down a second time.

**Configuration.** `showSleepButton` (default `true`) decides whether the button is shown,
`sleepCountdownSeconds` (a **dropdown**: `0` / `10` / `20` / `30` / `60` seconds, default `20`) how
long the countdown runs, and `sleepCommand` (default `''`) replaces the detected command with one of
your own — empty means "detect the host automatically". `0` means **no countdown at all**: the machine
is switched off as soon as every conversation is idle (a busy conversation still blocks it), and no
countdown card appears. A profile that still carries a value the dropdown does not offer (`15`,
`45`, …) is snapped onto the nearest offered one instead of breaking.

**One click is all it takes.** The moon button arms the shutdown: the host waits for every busy
conversation, counts down **20 seconds** in a floating card (it never covers the interface), and then
switches the machine off. Clicking the button again — or the cancel button on the card — takes it
back. Nothing else is asked of the user: no confirmation dialog, no second click.

**The desktop client and the hosted web client behave exactly the same.** There is no ticket, no
extra header and no hidden mode: `POST /__dsh_autorestart/sleep` takes nothing but the action, and
the same route serves both. A script (or an agent) can therefore drive the shutdown as well:

```bash
# arm it (the machine counts down and goes off)
curl -s -X POST http://127.0.0.1:<port>/__dsh_autorestart/sleep \
  -H 'content-type: application/json' -d '{"action":"arm"}'
# take it back
curl -s -X POST http://127.0.0.1:<port>/__dsh_autorestart/sleep \
  -H 'content-type: application/json' -d '{"action":"cancel"}'
```

**The one-time install question.** The first time the plugin is used, the composer dock asks once
more whether the button should stay. The answer is written into the profile configuration
(`showSleepButton`) through the same `configEditor` service the backup question uses, so the
settings page and the prompt always show the same value.

**The configuration page.** In *Settings → Plugins → dsh-autorestart* the plugin row carries the
three settings that matter:

- **Countdown seconds** — the dropdown `0` / `10` / `20` / `30` / `60`.
- **Backup before a restart** (`backupOnRestart`) — whether the pre-restart snapshot is taken at all.
- **Include the installed plugins in the backup** (`backupIncludePlugins`) — whether that snapshot
  also contains the plugin directory of the profile. It is greyed out when the backup itself is off.

A change is written into the profile configuration at once (through the plugin's own choice route)
and is read back from the host, so the page never shows a value the host did not take. A malformed
value is refused with a **400** and **nothing** is written.

**Trying it without switching anything off.** Set `DSH_AUTORESTART_SLEEP_DRYRUN=1` in the host
environment: the plugin then reports the command it *would* run and never runs it.

**The machine-readable state.** `GET <healthPath 前缀>/sleep` (default
`/__dsh_autorestart/sleep`) answers with the phase, the countdown and the host that is about to be
closed. A few of its fields are meant to be read by code rather than by a human: `host.kind` is the
kind of machine (`windows`, `wsl`, `linux`, `macos`, `unsupported`, or `custom` when the platform
could not be recognised but a `sleepCommand` was configured); `host.suspect` is `true` when the host
was only recognised as WSL because the Windows drive is mounted — a hint, not a proof;
`lastRun.dryRun` marks the last run as a rehearsal that switched nothing off; and
`backupOnRestart` / `backupIncludePlugins` report the effective scope of the pre-restart backup.

**When the shutdown command does not start.** The host waits for the real answer of the process. If
the command cannot start (missing binary, denied permission), the shutdown does **not** pretend it
worked: the phase goes back to `idle`, the reason is reported ("the shutdown command did not start
(…), the computer is still on, press the moon button again"), and the machine stays on. On screen
the "shutting down" card never locks the interface: after at most eight seconds it offers a button
that closes the card.

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

### Hosted `dsh web` deployments

| Deployment | `restartMode` | How the host is restarted |
| --- | --- | --- |
| DeepSeek Harness desktop app (Windows) | `app` (the default) | The host's own app restart: the old process tree is killed and the desktop app is relaunched |
| A hosted `dsh web` deployment | `command` | There is no "restart the app" in a web deployment — you must supply the command yourself |

Minimal configuration for a hosted `dsh web` (it **replaces** the whole `config` block, it is not merged):

```yaml
- id: dsh-autorestart
  config:
    restartMode: command
    restartCommand: systemctl --user restart dsh-web
```

`restartCommand` may use the placeholders `{pid}` (this host), `{ppid}` (its parent) and `{app}` (the desktop
app path).

**Without that configuration the restart fails, and it says so.** A hosted host is not the desktop app, so
the plugin has no way to relaunch it: the log gets
`no restart method available (not the desktop app and restartCommand is empty); leaving the checkpoint in place`,
the pending restart is rolled back (one retry with a backoff, then it is cancelled instead of retrying
forever), and nothing is relaunched — the checkpoint simply stays on disk, so the session is picked up again
when the host is started by hand. `continuum_status` keeps reporting the pending state until it is cancelled.

The same profile row is what the one-time install question writes into: a hosted profile that declares no
`dsh-autorestart` row has no row for the `configEditor` service to edit, so the answer falls back to
`<DSH_HOME>/storages/dsh-autorestart/install-choice.json` instead of the profile configuration. Declaring the
row keeps the profile (and therefore the settings page) as the single source of truth.

## Verify

The health route tells you whether the plugin is alive and what it has done:

```sh
curl http://127.0.0.1:<gui port>/__dsh_autorestart/health
# {"ok":true,"plugin":"dsh-autorestart","bootId":"…","pid":17884,"phase":"running",
#  "pageHeartbeat":true,"systemPrompt":true,"configSchema":true,"indexTaps":1,…}
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
- `GET /__dsh_autorestart/sleep` reports the state of the graceful shutdown, `POST
  /__dsh_autorestart/sleep` arms (`{ "action": "arm" }`) or cancels (`{ "action": "cancel" }`) it.
- Inside a session, `continuum_status` reports the same lifecycle.

The plugin ships its own test suite: **250 test cases** in `plugins/dsh-autorestart/test/`, all
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

## Submitting to the curated plugin list

The curated list lives in the `awesome-dsh-plugin/awesome-dsh-plugin` repository, and one pull
request that adds a single file is the whole submission: `data/plugins/<owner>__<repo>.yml`. For
this plugin that file is `data/plugins/Eason-22__dsh-autorestart.yml`:

```yaml
url: https://github.com/Eason-22/dsh-autorestart
name: Eason-22/dsh-autorestart
category: session
description:
  en: 'DeepSeek Harness plugin: restart without losing work, with an idle-aware graceful restart and automatic session resume after the host comes back.'
  zh: 'DeepSeek Harness 插件：重启不丢工作——等所有对话空闲后优雅重启，重启后自动接续被打断的会话。'
icon: https://raw.githubusercontent.com/Eason-22/dsh-autorestart/main/assets/icon-180.png
```

The list's CI checks that the repository declares a `dsh.bundle` manifest, that the repository is
at least one day old (the check re-runs by itself, so no need to resubmit), that the repository
exists and is not archived, and that a pull request adds at most three entries. Descriptions are
read as claims about the plugin and are checked against the code, so keep them factual and free of
marketing. The marketplace icon must be a GitHub-hosted raster image (png, jpg, jpeg or webp; SVG
is refused) — this repository ships `assets/icon-180.png` — and the optional `screenshots.json` next
to `package.json` lets the storefront show the images listed in `assets/`. The two READMEs of the
list are generated from the entry files; do not edit them by hand.

## AI-generated notice

This plugin was generated by an AI and has **not** been reviewed by a human. It restarts your DSH
process and writes local state files, so it can interrupt a running session. Try it in a test
profile first, evaluate the risk yourself, and only then use it in your daily profile.
