# Security policy

## Supported versions

Only the latest published version of `dsh-autorestart` receives fixes. Check with:

```sh
npm view dsh-autorestart version
```

Deprecated versions are marked on npm with the reason and the version to install instead.

## What this plugin is allowed to do on your machine

It is worth knowing this before you report (or decide to trust) anything:

- **It restarts the host.** A restart kills the DeepSeek Harness process and launches it again
  through a detached helper outside the Electron process tree.
- **It writes local state**, only under `<DSH_HOME>/storages/dsh-autorestart/`: the checkpoint,
  the pre-restart snapshots, the restart helper scripts and the rollback report.
- **It can restore a snapshot over the profile.** When the host does not come back after a restart,
  the helper copies the snapshot's `cordis.patch.yml`, `package.json`, `pnpm-lock.yaml` and
  `node_modules` back over the profile.
- **It stores no credentials** and sends nothing anywhere by itself.

## Reporting a vulnerability

Do **not** open a public issue for a security problem. Use GitHub's private channel:
[Report a vulnerability](https://github.com/Eason-22/dsh-autorestart/security/advisories/new).

Please include the version (`npm view dsh-autorestart version`), the platform, what an attacker
could do, and how you reproduced it. Never include your npm token, a GitHub token, or a copy of
your profile that still contains secrets.

This is a single-maintainer, AI-assisted project: expect a best-effort reply, not a service-level
agreement. If the problem is already public elsewhere, say so — that changes the priority.

## In scope (examples)

- The health route answering, or accepting a state-changing request, from a non-loopback caller
  that is not an authenticated browser.
- The manual-restart guard being bypassed in a way that lets an agent kill or relaunch DSH while a
  turn is running, losing that turn.
- A rollback restoring a snapshot the user did not ask for, or reading one outside the storage
  directory.
- The config editor or the settings page revealing a value that should be masked.
- `restartCommand` executing something other than the configured command.

Out of scope: problems in DeepSeek Harness itself (report them upstream), and anything that already
requires full local write access to your profile.
