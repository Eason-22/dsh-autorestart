#!/bin/sh
# dsh-autorestart - profile snapshot restorer (POSIX: Linux, WSL, macOS).
#
# The same rules as restore-profile.ps1: the newest snapshot that carries a
# manifest is put back into a profile that is ALREADY there, the broken profile
# is kept (never deleted), the result is read back, and DSH is NOT restarted
# for you.
#
# The file is pure ASCII on purpose: the Chinese wording lives in
# rescue-strings.zh.json (UTF-8 without a BOM), like everywhere else in this
# plugin.
set -eu

PACKAGE_NAME='dsh-autorestart'
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
STRINGS_FILE="$SCRIPT_DIR/rescue-strings.zh.json"

DRY_RUN=0
SNAPSHOT=''
PROFILE_DIR=''
STATE_DIR=''

usage() {
  printf 'Usage: %s [--dry-run] [--snapshot DIR] [--profile DIR] [--state-dir DIR]\n' "$0"
  printf '  --dry-run       say what would happen, change nothing\n'
  printf '  --snapshot DIR  use this snapshot (default: the newest one with a manifest)\n'
  printf '  --profile DIR   the profile to restore into (default: the profile of this machine)\n'
  printf '  --state-dir DIR where the snapshots live (default: <DSH_HOME>/storages/dsh-autorestart)\n'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run|-n) DRY_RUN=1 ;;
    --snapshot) SNAPSHOT="${2:-}"; shift ;;
    --profile) PROFILE_DIR="${2:-}"; shift ;;
    --state-dir) STATE_DIR="${2:-}"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# The Chinese wording (and the English fallback)
# ---------------------------------------------------------------------------

NODE_BIN=''
if command -v node >/dev/null 2>&1; then
  NODE_BIN=$(command -v node)
fi

strings_error=''

# t <key> <english fallback>
#
# The key is a PATH into the strings file ("restore.title"), because that file
# is nested. Node reads it (it is on every machine that runs DSH); without
# node every message falls back to English.
t() {
  key="$1"
  fallback="$2"
  if [ -n "$NODE_BIN" ] && [ -f "$STRINGS_FILE" ]; then
    value=$("$NODE_BIN" -e '
      const fs = require("fs");
      try {
        const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8").replace(/^\uFEFF/, ""));
        let value = doc;
        for (const part of process.argv[2].split(".")) value = value == null ? undefined : value[part];
        if (typeof value !== "string" || value === "") process.exit(1);
        process.stdout.write(value);
      } catch (error) { process.exit(1); }
    ' "$STRINGS_FILE" "$key" 2>/dev/null) || value=''
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return 0
    fi
  fi
  printf '%s' "$fallback"
}

# fmt <text> <value> <value> ...   (replaces {0}, {1}, ...)
#
# Node does the replacement when it is there: the Chinese wording is UTF-8 and
# a byte-wise sed would mangle it. Without node only the English fallbacks are
# used, and those are plain ASCII.
fmt() {
  text="$1"
  shift
  if [ -n "$NODE_BIN" ]; then
    if "$NODE_BIN" -e '
      let text = process.argv[1];
      process.argv.slice(2).forEach((value, index) => { text = text.split("{" + index + "}").join(value); });
      process.stdout.write(text);
    ' "$text" "$@" 2>/dev/null; then
      return 0
    fi
  fi
  index=0
  for value in "$@"; do
    safe=$(printf '%s' "$value" | sed 's/[&|\\]/\\&/g')
    text=$(printf '%s' "$text" | sed "s|{$index}|$safe|g")
    index=$((index + 1))
  done
  printf '%s' "$text"
}

say() {
  printf '%s\n' "$1"
}

fail() {
  printf '%s%s\n' "$(t 'restore.failPrefix' 'restore failed: ')" "$1" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

full_path() {
  target="${1:-}"
  if [ -z "$target" ]; then
    printf ''
    return 0
  fi
  case "$target" in
    /*) resolved="$target" ;;
    *) resolved="$PWD/$target" ;;
  esac
  # Remove the trailing slashes (but keep the root "/").
  while [ "${resolved%/}" != "$resolved" ] && [ "${resolved%/}" != '' ]; do
    resolved="${resolved%/}"
  done
  printf '%s' "$resolved"
}

same_path() {
  [ "$(full_path "$1")" = "$(full_path "$2")" ]
}

# Is the child inside the parent (the parent itself does not count)?
is_inside() {
  child=$(full_path "$1")
  parent=$(full_path "$2")
  [ -n "$child" ] || return 1
  [ -n "$parent" ] || return 1
  [ "$child" != "$parent" ] || return 1
  case "$child" in
    "$parent"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# The system directories of a POSIX machine.
system_directories() {
  printf '%s\n' /usr /etc /bin /sbin /lib /lib64 /boot /dev /proc /sys /run /var/lib /var/log /opt /System /Library /Applications
}

# Why may this path not be touched? An empty string means: it may.
forbidden_reason() {
  target=$(full_path "$1")
  home_path=$(full_path "${HOME:-}")
  if [ -z "$target" ]; then
    t 'restore.gateEmptyPath' 'the target path is empty'
    return 0
  fi
  if [ "$target" = '/' ]; then
    t 'restore.gateFsRoot' 'refusing to touch the filesystem root'
    return 0
  fi
  if [ -n "$home_path" ] && same_path "$target" "$home_path"; then
    t 'restore.gateHome' 'refusing to touch the home directory itself'
    return 0
  fi
  for system in $(system_directories); do
    if same_path "$target" "$system" || is_inside "$target" "$system"; then
      fmt "$(t 'restore.gateSystemDir' 'refusing to touch the system directory: {0}')" "$system"
      return 0
    fi
  done
  # Somebody else's home: /home/<somebody else> (or /Users/<somebody else>).
  if [ -n "$home_path" ]; then
    for users_root in /home /Users; do
      if is_inside "$target" "$users_root"; then
        parent=$(full_path "$(dirname "$target")")
        if [ "$parent" = "$users_root" ]; then
          t 'restore.gateOtherUser' "refusing to touch another user's home directory"
          return 0
        fi
      fi
    done
  fi
  printf ''
}

dsh_home() {
  if [ -n "${DSH_HOME:-}" ]; then
    full_path "$DSH_HOME"
    return 0
  fi
  if [ -n "${HOME:-}" ]; then
    full_path "$HOME/.dsh"
    return 0
  fi
  printf ''
}

profiles_root() {
  root=$(dsh_home)
  if [ -z "$root" ]; then
    printf ''
    return 0
  fi
  full_path "$root/profiles"
}

backups_root() {
  if [ -n "$STATE_DIR" ]; then
    full_path "$STATE_DIR/backups"
    return 0
  fi
  root=$(dsh_home)
  if [ -z "$root" ]; then
    printf ''
    return 0
  fi
  full_path "$root/storages/dsh-autorestart/backups"
}

# Without --profile: where is the profile of this machine?
default_profile_dir() {
  # 1) The environment variable the host exports.
  if [ -n "${DSH_PROFILE_DIR:-}" ]; then
    explicit=$(full_path "$DSH_PROFILE_DIR")
    if [ -n "$explicit" ] && [ -d "$explicit" ]; then
      printf '%s' "$explicit"
      return 0
    fi
  fi
  # 2) The only profile that has this plugin in it - that is the one.
  root=$(profiles_root)
  if [ -n "$root" ] && [ -d "$root" ]; then
    match=''
    count=0
    for entry in "$root"/*; do
      [ -d "$entry" ] || continue
      pkg="$entry/package.json"
      [ -f "$pkg" ] || continue
      if declares_plugin "$pkg"; then
        match="$entry"
        count=$((count + 1))
      fi
    done
    if [ "$count" -eq 1 ]; then
      printf '%s' "$match"
      return 0
    fi
  fi
  # 3) The profile name the host asked for.
  if [ -n "${DSH_PROFILE:-}" ]; then
    full_path "$root/$DSH_PROFILE"
    return 0
  fi
  # 4) The default name.
  full_path "$root/desktop"
}

# ---------------------------------------------------------------------------
# The JSON bits (node when it is there, a light check otherwise)
# ---------------------------------------------------------------------------

# Does this package.json parse?
json_parses() {
  file="$1"
  [ -f "$file" ] || return 1
  if [ -n "$NODE_BIN" ]; then
    "$NODE_BIN" -e 'try { JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").replace(/^\uFEFF/, "")); process.exit(0) } catch (error) { process.exit(1) }' "$file" >/dev/null 2>&1
    return $?
  fi
  head -c 1 "$file" | grep -q '{' || return 1
  return 0
}

# Does this package.json carry a dsh.profile section?
has_profile_section() {
  file="$1"
  [ -f "$file" ] || return 1
  if [ -n "$NODE_BIN" ]; then
    "$NODE_BIN" -e 'try { const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").replace(/^\uFEFF/, "")); process.exit(d && d.dsh && d.dsh.profile ? 0 : 1) } catch (error) { process.exit(1) }' "$file" >/dev/null 2>&1
    return $?
  fi
  grep -q '"dsh"' "$file" 2>/dev/null && grep -q '"profile"' "$file" 2>/dev/null
}

# How many bundles does the profile declare?
bundles_count() {
  file="$1"
  if [ -n "$NODE_BIN" ]; then
    "$NODE_BIN" -e 'try { const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").replace(/^\uFEFF/, "")); const b = d && d.dsh && d.dsh.profile && d.dsh.profile.bundles; if (!Array.isArray(b)) process.exit(1); process.stdout.write(String(b.length)); process.exit(b.length > 0 ? 0 : 1) } catch (error) { process.exit(1) }' "$file" 2>/dev/null
    return $?
  fi
  count=$(sed -n 's/.*"bundles"[[:space:]]*:[[:space:]]*\[[^]]*\].*/x/p' "$file" | wc -l | tr -d ' ')
  [ "$count" -gt 0 ] || return 1
  printf '0'
  return 0
}

# Does the profile declare this plugin?
declares_plugin() {
  file="$1"
  [ -f "$file" ] || return 1
  if [ -n "$NODE_BIN" ]; then
    "$NODE_BIN" -e 'try { const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").replace(/^\uFEFF/, "")); const b = d && d.dsh && d.dsh.profile && d.dsh.profile.bundles; process.exit(Array.isArray(b) && b.indexOf(process.argv[2]) >= 0 ? 0 : 1) } catch (error) { process.exit(1) }' "$file" "$PACKAGE_NAME" >/dev/null 2>&1
    return $?
  fi
  grep -q "\"$PACKAGE_NAME\"" "$file" 2>/dev/null
}

# The version of the installed plugin (empty when it cannot be read).
plugin_version() {
  file="$1"
  [ -f "$file" ] || return 1
  if [ -n "$NODE_BIN" ]; then
    "$NODE_BIN" -e 'try { const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").replace(/^\uFEFF/, "")); const v = d && d.version ? String(d.version).trim() : ""; if (!v) process.exit(1); process.stdout.write(v) } catch (error) { process.exit(1) }' "$file" 2>/dev/null
    return $?
  fi
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -n 1
}

# ---------------------------------------------------------------------------
# The snapshot
# ---------------------------------------------------------------------------

manifest_value() {
  file="$1"
  key="$2"
  sed -n 's/.*"'"$key"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -n 1
}

manifest_number() {
  file="$1"
  key="$2"
  sed -n 's/.*"'"$key"'"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$file" | head -n 1
}

has_manifest() {
  [ -f "$1/manifest.json" ]
}

# The newest snapshot that carries a manifest.
select_snapshot() {
  root="$1"
  if [ ! -d "$root" ]; then
    fail "$(fmt "$(t 'restore.snapshotDirMissing' 'the snapshot directory cannot be found: {0}')" "$root")"
  fi
  best=''
  best_at=0
  best_name=''
  for entry in "$root"/*; do
    [ -d "$entry" ] || continue
    has_manifest "$entry" || continue
    at=$(manifest_number "$entry/manifest.json" 'at')
    [ -n "$at" ] || at=0
    name=$(basename "$entry")
    if [ -z "$best" ] || [ "$at" -gt "$best_at" ] || { [ "$at" -eq "$best_at" ] && [ "$name" \> "$best_name" ]; }; then
      best="$entry"
      best_at="$at"
      best_name="$name"
    fi
  done
  if [ -z "$best" ]; then
    fail "$(fmt "$(t 'restore.snapshotNone' 'there is no snapshot with a manifest under {0}')" "$root")"
  fi
  printf '%s' "$best"
}

# ---------------------------------------------------------------------------
# Start
# ---------------------------------------------------------------------------

if [ ! -f "$STRINGS_FILE" ]; then
  strings_error=$(fmt "$(t 'common.stringsMissingEn' 'the Chinese strings file is missing: {0} - falling back to English messages')" "$STRINGS_FILE")
  printf 'WARNING: %s\n' "$strings_error"
fi

say "$(t 'restore.title' 'dsh-autorestart - profile snapshot restorer')"

explicit_profile=0
if [ -n "$PROFILE_DIR" ]; then
  explicit_profile=1
  target_profile=$(full_path "$PROFILE_DIR")
else
  target_profile=$(default_profile_dir)
fi
if [ -z "$target_profile" ]; then
  fail "$(t 'restore.noProfileDir' 'the profile directory to restore into cannot be found (use --profile to say which one).')"
fi

# --- Gate 1: is the path itself safe? ---
forbidden=$(forbidden_reason "$target_profile")
if [ -n "$forbidden" ]; then
  fail "$forbidden$(fmt "$(t 'restore.targetSuffix' 'target: {0}')" "$target_profile")"
fi

if [ "$explicit_profile" -eq 0 ]; then
  profiles=$(profiles_root)
  if ! is_inside "$target_profile" "$profiles"; then
    fail "$(fmt "$(t 'restore.onlyProfiles' 'only a profile under {0} may be restored (target: {1})')" "$profiles" "$target_profile")"
  fi
fi
say "$(fmt "$(t 'restore.target' 'target profile: {0}')" "$target_profile")"

# --- Gate 2: the target profile directory has to exist ---
if [ ! -d "$target_profile" ]; then
  fail "$(fmt "$(t 'restore.missingDir' 'the target profile directory does not exist: {0} (the restore needs that directory to be there; the script does not create a profile directory for it)')" "$target_profile")"
fi

# --- Gate 3: does this directory still look like a DSH profile? ---
pkg_path="$target_profile/package.json"
fingerprint='not-a-profile'
if [ -f "$pkg_path" ]; then
  if has_profile_section "$pkg_path"; then
    fingerprint='profile'
    fingerprint_reason=$(t 'restore.fingerprintProfile' 'the profile package.json carries a dsh.profile section')
  elif [ -f "$target_profile/cordis.patch.yml" ] || [ -d "$target_profile/node_modules" ]; then
    fingerprint='broken-profile'
    fingerprint_reason=$(t 'restore.fingerprintBrokenNoDsh' 'the profile is broken - its package.json does not identify a profile - but the profile files are still there')
  else
    fingerprint_reason=$(t 'restore.fingerprintNotDshProfile' 'the package.json does not carry a dsh.profile section, and nothing else marks this as a profile')
  fi
else
  if [ -f "$target_profile/cordis.patch.yml" ] || [ -d "$target_profile/node_modules" ]; then
    fingerprint='broken-profile'
    fingerprint_reason=$(t 'restore.fingerprintBrokenNoPkg' 'the profile is broken - its package.json is missing - but the profile files are still there')
  else
    fingerprint_reason=$(t 'restore.fingerprintNotProfile' 'there is no package.json here - this does not look like a DSH profile')
  fi
fi
if [ "$fingerprint" = 'not-a-profile' ]; then
  fail "$fingerprint_reason$(fmt "$(t 'restore.targetSuffix' 'target: {0}')" "$target_profile")$(t 'restore.notProfileSuffix' '. Refusing to act - a directory that is not a profile must not be damaged.')"
fi
if [ "$fingerprint" = 'broken-profile' ]; then
  say "$(fmt "$(t 'restore.brokenNotice' 'this profile is already broken: {0}')" "$fingerprint_reason")"
fi

# --- Find the snapshot ---
if [ -n "$SNAPSHOT" ]; then
  snapshot_dir=$(full_path "$SNAPSHOT")
  if [ ! -d "$snapshot_dir" ]; then
    fail "$(fmt "$(t 'restore.snapshotMissing' 'this snapshot cannot be found: {0}')" "$snapshot_dir")"
  fi
  if ! has_manifest "$snapshot_dir"; then
    fail "$(fmt "$(t 'restore.snapshotNoManifest' 'this snapshot has no manifest.json, so it is not a snapshot: {0}')" "$snapshot_dir")"
  fi
else
  backups=$(backups_root)
  say "$(fmt "$(t 'restore.backupsDir' 'snapshot directory: {0}')" "$backups")"
  snapshot_dir=$(select_snapshot "$backups")
fi
snapshot_name=$(basename "$snapshot_dir")
manifest="$snapshot_dir/manifest.json"

# --- Gate 4: does the snapshot hold a real profile? ---
snapshot_pkg="$snapshot_dir/config/package.json"
if [ ! -f "$snapshot_pkg" ]; then
  fail "$(t 'restore.snapshotNoConfigPkg' 'this snapshot has no config/package.json')$(fmt "$(t 'restore.snapshotSuffix' '{0} - snapshot: {1}')" '' "$snapshot_dir")"
fi
if ! json_parses "$snapshot_pkg"; then
  fail "$(t 'restore.snapshotBadConfigPkg' 'the package.json of this snapshot is not valid JSON')$(fmt "$(t 'restore.snapshotSuffix' '{0} - snapshot: {1}')" '' "$snapshot_dir")"
fi
if ! has_profile_section "$snapshot_pkg"; then
  fail "$(t 'restore.snapshotNoDshProfile' 'the package.json of this snapshot has no dsh.profile')$(fmt "$(t 'restore.snapshotSuffix' '{0} - snapshot: {1}')" '' "$snapshot_dir")"
fi

described=$(manifest_value "$manifest" 'atLocal')
if [ -z "$described" ]; then
  described=$(t 'restore.snapshotUnknownTime' 'an unknown time')
else
  described=$(printf '%s' "$described" | tr 'T' ' ' | cut -c1-16)
fi
include_plugins='false'
if grep -q '"includePlugins"[[:space:]]*:[[:space:]]*true' "$manifest" 2>/dev/null; then
  include_plugins='true'
fi

say "$(fmt "$(t 'restore.usingSnapshot' 'snapshot to use: {0} ({1})')" "$snapshot_name" "$described")"

# --- The name of the evidence directory for the old profile ---
stamp=$(date -u +%Y%m%d-%H%M%S)
broken_dir="$target_profile.broken-$stamp"
counter=2
while [ -e "$broken_dir" ]; do
  broken_dir="$target_profile.broken-$stamp-$counter"
  counter=$((counter + 1))
done

# --- Dry run ---
if [ "$DRY_RUN" -eq 1 ]; then
  say "$(fmt "$(t 'restore.dryRunMove' '[dry run] the current profile would be moved to: {0}')" "$broken_dir")"
  say "$(fmt "$(t 'restore.dryRunCopy' '[dry run] the configuration and the plugins of {0} would be copied back to: {1}')" "$snapshot_name" "$target_profile")"
  say "$(fmt "$(t 'restore.dryRunVerify' '[dry run] package.json / dsh.profile.bundles / the version of {0} would be read back.')" "$PACKAGE_NAME")"
  say "$(t 'restore.dryRunNoChange' '[dry run] no file was changed.')"
  exit 0
fi

# --- Move the current profile away (never overwrites, never deletes) ---
if [ -d "$target_profile" ]; then
  if ! mv -- "$target_profile" "$broken_dir"; then
    fail "$(fmt "$(t 'restore.moveFailed' 'moving the current profile away failed (nothing was changed): {0}')" "$broken_dir")"
  fi
  say "$(fmt "$(t 'restore.moved' 'the old one has been moved to: {0}')" "$broken_dir")"
else
  say "$(t 'restore.noProfileBefore' 'the profile directory was not there, it is created.')"
fi

# --- Copy it back ---
mkdir -p -- "$target_profile"
if [ -d "$snapshot_dir/config" ]; then
  for item in "$snapshot_dir"/config/*; do
    [ -e "$item" ] || continue
    if ! cp -R -- "$item" "$target_profile/"; then
      fail "$(fmt "$(t 'restore.copyFailed' 'copying the snapshot back failed (the old one is still at {0}): {1}')" "$broken_dir" "$item")"
    fi
  done
fi
if [ -d "$snapshot_dir/node_modules" ]; then
  if ! cp -R -- "$snapshot_dir/node_modules" "$target_profile/node_modules"; then
    fail "$(fmt "$(t 'restore.copyFailed' 'copying the snapshot back failed (the old one is still at {0}): {1}')" "$broken_dir" 'node_modules')"
  fi
fi

# --- Read the result back ---
failed=''
check_ok() {
  say "$(fmt "$(t 'restore.checkOk' '  [ok] {0} - {1}')" "$1" "${2:-}")"
}
check_skipped() {
  say "$(fmt "$(t 'restore.checkSkipped' '  [skipped] {0} - {1}')" "$1" "${2:-}")"
}
check_bad() {
  say "$(fmt "$(t 'restore.checkBad' '  [bad] {0} - {1}')" "$1" "${2:-}")"
  failed="$failed, $1"
}

pkg_label=$(t 'restore.verifyPkgLabel' 'package.json can be parsed')
if [ ! -f "$target_profile/package.json" ]; then
  check_bad "$pkg_label" "$(t 'restore.verifyPkgMissing' 'package.json is missing')"
elif json_parses "$target_profile/package.json"; then
  check_ok "$pkg_label" ''
else
  check_bad "$pkg_label" "$(t 'restore.verifyPkgBad' 'not valid JSON')"
fi

bundles_label=$(t 'restore.verifyBundlesLabel' 'dsh.profile.bundles has content')
count=$(bundles_count "$target_profile/package.json" || printf '0')
if [ "$count" -gt 0 ] 2>/dev/null; then
  check_ok "$bundles_label" "$(fmt "$(t 'restore.verifyBundlesCount' '{0} in total')" "$count")"
else
  check_bad "$bundles_label" "$(t 'restore.verifyBundlesEmpty' 'there is no dsh.profile.bundles, or it is empty')"
fi

plugin_label=$(fmt "$(t 'restore.verifyPluginLabel' 'the version of {0} can be read')" "$PACKAGE_NAME")
if ! declares_plugin "$target_profile/package.json"; then
  check_skipped "$plugin_label" "$(fmt "$(t 'restore.verifyPluginNotDeclared' 'this profile does not list {0} (there is nothing to read)')" "$PACKAGE_NAME")"
else
  version=$(plugin_version "$target_profile/node_modules/$PACKAGE_NAME/package.json" || printf '')
  if [ -n "$version" ]; then
    check_ok "$plugin_label" "$version"
  else
    check_bad "$plugin_label" "$(t 'restore.verifyPluginNoVersion' 'the version number cannot be read')"
  fi
fi

if [ -n "$failed" ]; then
  fail "$(fmt "$(t 'restore.verifyFailed' 'the restored profile did not pass the check ({0}).')" "${failed#, }")"
fi

# --- One sentence a human can act on ---
plugin_note=$(t 'restore.noteWithPlugins' '(with the plugins)')
if [ "$include_plugins" != 'true' ]; then
  plugin_note=$(t 'restore.noteNoPlugins' '(configuration files only, no plugins)')
fi
say "$(fmt "$(t 'restore.done' 'restored to the snapshot of {0}{1}; you can open DSH again now.')" "$described" "$plugin_note")"
say "$(fmt "$(t 'restore.brokenLeft' 'the old one was left at: {0} (delete it yourself once you are sure)')" "$broken_dir")"
exit 0
