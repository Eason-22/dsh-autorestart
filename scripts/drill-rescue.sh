#!/bin/sh
# The rescue drill (POSIX): break a profile on purpose, put it back, prove it.
#
# Three traps this file avoids (the whole story: scripts/README.md):
#   1. the wording lives in rescue-strings.zh.json and is NESTED - it is read
#      by path with node, never by a flat grep;
#   2. the English fallbacks below must NOT contain parentheses: dash counts
#      them even inside single quotes, and one stray ")" breaks the script;
#   3. the sed expressions stay single-quoted: the shell eats the backslashes
#      in a double-quoted sed program and truncates it.
#
# The same assertions as drill-rescue.ps1, in a directory of its own under the
# temp directory. Nothing here touches the profile of a running DSH.
#
# The wording comes from rescue-strings.zh.json; the English fallbacks keep
# the script working without it.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RESTORE="$SCRIPT_DIR/restore-profile.sh"
DISABLE="$SCRIPT_DIR/emergency-disable.sh"
STRINGS_FILE="$SCRIPT_DIR/rescue-strings.zh.json"
PACKAGE_NAME='dsh-autorestart'

DRILL_DIR="${TMPDIR:-/tmp}/dsh-rescue-drill-$$"
FAILED=0

usage() {
  printf 'Usage: %s [drill-directory]\n' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    *) DRILL_DIR="$1" ;;
  esac
  shift
done

NODE_BIN=''
if command -v node >/dev/null 2>&1; then
  NODE_BIN=$(command -v node)
fi

# t <key> <english fallback>
#
# The key is a PATH into the strings file ("drill.passed"), because that file
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

# fmt <text> <value> ...
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

assert_pass() {
  say "$(fmt "$(t 'drill.assertPass' '  [pass] {0}')" "$1")"
}

assert_fail() {
  FAILED=$((FAILED + 1))
  say "$(fmt "$(t 'drill.assertFail' '  [FAIL] {0} -- {1}')" "$1" "$2")"
}

# The keywords a refusal has to carry (the same file the Windows drill uses).
keyword_list() {
  key="$1"
  if [ -n "$NODE_BIN" ] && [ -f "$STRINGS_FILE" ]; then
    "$NODE_BIN" -e '
      const fs = require("fs");
      try {
        const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8").replace(/^\uFEFF/, ""));
        let value = doc;
        for (const part of process.argv[2].split(".")) value = value == null ? undefined : value[part];
        if (!Array.isArray(value)) process.exit(1);
        process.stdout.write(value.join("\n"));
      } catch (error) { process.exit(1); }
    ' "$STRINGS_FILE" "$key" 2>/dev/null
    return $?
  fi
  printf ''
}

# refused <name> <output> <exit code> <keyword key>
refused() {
  name="$1"
  output="$2"
  code="$3"
  key="$4"
  if [ "$code" -eq 0 ]; then
    assert_fail "$name" "$(fmt "$(t 'drill.refusedNotRefused' '  [FAIL] {0} -- the exit code is 0, the script did not refuse')" "$name")"
    return
  fi
  found=''
  for word in $(keyword_list "$key"); do
    [ -n "$word" ] || continue
    if printf '%s' "$output" | grep -q "$word"; then
      found="$word"
      break
    fi
  done
  if [ -z "$found" ]; then
    assert_fail "$name" "$(fmt "$(t 'drill.refusedNoReason' '  [FAIL] {0} -- the exit code is {1}, but the output has no reason')" "$name" "$code")"
    return
  fi
  detail=$(fmt "$(t 'drill.refusedOk' '  [pass] {0} -- exit code {1}, the output says why')" "$name" "$code")
  assert_pass "$name ($detail)"
}

if [ ! -x "$RESTORE" ] && [ ! -f "$RESTORE" ]; then
  say "$(fmt "$(t 'drill.noScript' 'the drill failed: {0} not found')" "$RESTORE")"
  exit 1
fi
if [ -e "$DRILL_DIR" ]; then
  say "$(fmt "$(t 'drill.dirOccupied' 'the drill failed: this drill directory is already there: {0}')" "$DRILL_DIR")"
  exit 1
fi

say "$(fmt "$(t 'drill.dir' 'drill directory: {0}')" "$DRILL_DIR")"
mkdir -p -- "$DRILL_DIR"

PROFILE="$DRILL_DIR/profile"
STATE="$DRILL_DIR/state"
BACKUPS="$STATE/backups"
SNAPSHOT="$BACKUPS/20260101-000000"
mkdir -p -- "$PROFILE/node_modules/$PACKAGE_NAME" "$SNAPSHOT/config" "$SNAPSHOT/node_modules/$PACKAGE_NAME"

# --- the profile and the snapshot ---
cat > "$PROFILE/package.json" <<'JSON'
{
  "name": "dsh-profile",
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-autorestart"
      ]
    }
  }
}
JSON
cat > "$PROFILE/cordis.patch.yml" <<'YML'
# the profile configuration
YML
cat > "$PROFILE/node_modules/$PACKAGE_NAME/package.json" <<'JSON'
{
  "name": "dsh-autorestart",
  "version": "1.2.3"
}
JSON
cp "$PROFILE/package.json" "$SNAPSHOT/config/package.json"
cp "$PROFILE/cordis.patch.yml" "$SNAPSHOT/config/cordis.patch.yml"
cp "$PROFILE/node_modules/$PACKAGE_NAME/package.json" "$SNAPSHOT/node_modules/$PACKAGE_NAME/package.json"
cat > "$SNAPSHOT/manifest.json" <<'JSON'
{
  "at": 1767225600000,
  "atLocal": "2026-01-01T00:00:00",
  "includePlugins": true
}
JSON

# A NEWER decoy without a manifest: it must be skipped.
DECOY="$BACKUPS/20260202-000000"
mkdir -p -- "$DECOY/config"
cp "$PROFILE/package.json" "$DECOY/config/package.json"

# --- break it on purpose ---
printf '{ this is not json' > "$PROFILE/package.json"
rm -rf -- "$PROFILE/node_modules/$PACKAGE_NAME"

say "$(t 'drill.broke' 'broken on purpose: package.json is invalid JSON, the plugin directory is gone.')"

# --- 1) the dry run changes nothing ---
set +e
DRY_OUT=$("$RESTORE" --dry-run --profile "$PROFILE" --state-dir "$STATE" 2>&1)
DRY_CODE=$?
set -e
DRY_MARK=$(keyword_list 'drill.keywords.dryRun' | head -n 1)
if [ "$DRY_CODE" -eq 0 ] && { [ -z "$DRY_MARK" ] || printf '%s' "$DRY_OUT" | grep -q "$DRY_MARK"; }; then
  assert_pass "$(t 'drill.assertDryRunExit' 'the dry run exits with 0')"
else
  assert_fail "$(t 'drill.assertDryRunExit' 'the dry run exits with 0')" "$DRY_OUT"
fi
if [ -z "$(find "$DRILL_DIR" -maxdepth 1 -name 'profile.broken-*' 2>/dev/null)" ]; then
  assert_pass "$(t 'drill.assertDryRunNoBroken' 'the dry run leaves no broken directory')"
else
  assert_fail "$(t 'drill.assertDryRunNoBroken' 'the dry run leaves no broken directory')" 'there is one'
fi

# --- 2) the real restore ---
set +e
RESTORE_OUT=$("$RESTORE" --profile "$PROFILE" --state-dir "$STATE" 2>&1)
RESTORE_CODE=$?
set -e
if [ "$RESTORE_CODE" -eq 0 ]; then
  assert_pass "$(t 'drill.assertRestoreExit' 'the restore exits with 0')"
else
  assert_fail "$(t 'drill.assertRestoreExit' 'the restore exits with 0')" "$RESTORE_OUT"
fi

# --- the assertions about the result ---
if printf '%s' "$RESTORE_OUT" | LC_ALL=C grep -q '[^ -~]'; then
  assert_pass "$(t 'drill.assertChineseOutput' 'the output of the restore script carries Chinese (the wording comes from the JSON)')"
else
  assert_fail "$(t 'drill.assertChineseOutput' 'the output of the restore script carries Chinese (the wording comes from the JSON)')" 'no non-ASCII byte in the output'
fi

if [ -n "$NODE_BIN" ] && "$NODE_BIN" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$PROFILE/package.json" >/dev/null 2>&1; then
  assert_pass "$(t 'drill.assertParses' 'after the restore package.json can be parsed')"
else
  assert_fail "$(t 'drill.assertParses' 'after the restore package.json can be parsed')" 'it does not parse'
fi

if grep -q "$PACKAGE_NAME" "$PROFILE/package.json" 2>/dev/null; then
  assert_pass "$(t 'drill.assertUsedSnapshot' 'the snapshot with the manifest was used (the newer decoy was skipped)')"
else
  assert_fail "$(t 'drill.assertUsedSnapshot' 'the snapshot with the manifest was used (the newer decoy was skipped)')" 'the plugin is not in the bundles'
fi

if grep -q '"bundles"' "$PROFILE/package.json" 2>/dev/null; then
  assert_pass "$(t 'drill.assertBundles' 'after the restore dsh.profile.bundles has content')"
else
  assert_fail "$(t 'drill.assertBundles' 'after the restore dsh.profile.bundles has content')" 'there is no bundles'
fi

VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PROFILE/node_modules/$PACKAGE_NAME/package.json" 2>/dev/null | head -n 1)
if [ -n "$VERSION" ]; then
  assert_pass "$(t 'drill.assertVersionReadable' 'after the restore the version of the plugin can be read')"
else
  assert_fail "$(t 'drill.assertVersionReadable' 'after the restore the version of the plugin can be read')" 'there is no version'
fi
if [ "$VERSION" = '1.2.3' ]; then
  assert_pass "$(t 'drill.assertVersionSame' 'the version is the one of the snapshot')"
else
  assert_fail "$(t 'drill.assertVersionSame' 'the version is the one of the snapshot')" "got '$VERSION'"
fi

BROKEN=$(find "$DRILL_DIR" -maxdepth 1 -name 'profile.broken-*' 2>/dev/null | head -n 1)
if [ -n "$BROKEN" ]; then
  assert_pass "$(t 'drill.assertBrokenExists' 'the broken evidence directory is there')"
  if grep -q 'this is not json' "$BROKEN/package.json" 2>/dev/null; then
    assert_pass "$(t 'drill.assertBrokenKeeps' 'the broken directory keeps the broken version')"
  else
    assert_fail "$(t 'drill.assertBrokenKeeps' 'the broken directory keeps the broken version')" 'it does not'
  fi
else
  assert_fail "$(t 'drill.assertBrokenExists' 'the broken evidence directory is there')" 'there is none'
fi

# --- the refusals: the exit code AND the reason in the output ---
NOT_A_PROFILE="$DRILL_DIR/not-a-profile"
mkdir -p -- "$NOT_A_PROFILE"
printf 'hello' > "$NOT_A_PROFILE/readme.txt"
set +e
OUT=$("$RESTORE" --profile "$NOT_A_PROFILE" --state-dir "$STATE" 2>&1)
CODE=$?
set -e
refused "$(t 'drill.assertNotProfileRefused' 'a directory that is not a profile is refused')" "$OUT" "$CODE" 'drill.keywords.notProfile'
if [ "$(cat "$NOT_A_PROFILE/readme.txt")" = 'hello' ]; then
  assert_pass "$(t 'drill.assertNotProfileUntouched' 'the refused directory was not touched')"
else
  assert_fail "$(t 'drill.assertNotProfileUntouched' 'the refused directory was not touched')" 'it changed'
fi

set +e
OUT=$("$RESTORE" --profile / --state-dir "$STATE" 2>&1)
CODE=$?
set -e
refused "$(t 'drill.assertDriveRootRefused' 'the filesystem root is refused')" "$OUT" "$CODE" 'drill.keywords.driveRoot'

SYSTEM_DIR=/etc
set +e
OUT=$("$RESTORE" --profile "$SYSTEM_DIR" --state-dir "$STATE" 2>&1)
CODE=$?
set -e
refused "$(fmt "$(t 'drill.assertSystemDirRefused' 'the system directory {0} is refused')" "$SYSTEM_DIR")" "$OUT" "$CODE" 'drill.keywords.systemDir'
if [ -d "$SYSTEM_DIR" ]; then
  assert_pass "$(fmt "$(t 'drill.assertSystemDirIntact' 'the system directory {0} is untouched')" "$SYSTEM_DIR")"
else
  assert_fail "$(fmt "$(t 'drill.assertSystemDirIntact' 'the system directory {0} is untouched')" "$SYSTEM_DIR")" 'it is gone'
fi

MISSING="$DRILL_DIR/does-not-exist"
set +e
OUT=$("$RESTORE" --profile "$MISSING" --state-dir "$STATE" 2>&1)
CODE=$?
set -e
refused "$(t 'drill.assertMissingDirRefused' 'a target profile directory that does not exist is refused')" "$OUT" "$CODE" 'drill.keywords.missingDir'
if [ ! -e "$MISSING" ]; then
  assert_pass "$(t 'drill.assertMissingDirNotCreated' 'the missing directory was not created')"
else
  assert_fail "$(t 'drill.assertMissingDirNotCreated' 'the missing directory was not created')" 'it is there'
fi

# --- "the profile says one thing, the disk another": the restore must fail ---
LYING_PROFILE="$DRILL_DIR/lying"
LYING_SNAPSHOT="$BACKUPS/20260303-000000"
mkdir -p -- "$LYING_PROFILE" "$LYING_SNAPSHOT/config"
cat > "$LYING_PROFILE/package.json" <<'JSON'
{
  "name": "dsh-profile",
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-autorestart"
      ]
    }
  }
}
JSON
cp "$LYING_PROFILE/package.json" "$LYING_SNAPSHOT/config/package.json"
cat > "$LYING_SNAPSHOT/manifest.json" <<'JSON'
{
  "at": 1772668800000,
  "atLocal": "2026-03-03T00:00:00",
  "includePlugins": false
}
JSON
set +e
OUT=$("$RESTORE" --profile "$LYING_PROFILE" --snapshot "$LYING_SNAPSHOT" --state-dir "$STATE" 2>&1)
CODE=$?
set -e
if [ "$CODE" -ne 0 ]; then
  assert_pass "$(t 'drill.assertLyingRefused' 'the profile declares the plugin but does not have it -> the restore must fail')"
else
  assert_fail "$(t 'drill.assertLyingRefused' 'the profile declares the plugin but does not have it -> the restore must fail')" 'it exited with 0'
fi
LYING_BROKEN=$(find "$DRILL_DIR" -maxdepth 1 -name 'lying.broken-*' 2>/dev/null | head -n 1)
if [ -n "$LYING_BROKEN" ]; then
  assert_pass "$(t 'drill.assertLyingBrokenHint' 'the failing restore says the broken directory is still there')"
else
  assert_fail "$(t 'drill.assertLyingBrokenHint' 'the failing restore says the broken directory is still there')" 'there is none'
fi

# --- the scripts are pure ASCII ---
for script in "$RESTORE" "$DISABLE"; do
  if [ ! -f "$script" ]; then
    continue
  fi
  if LC_ALL=C grep -q '[^ -~]' "$script"; then
    assert_fail "$(fmt 'the script {0} is pure ASCII' "$(basename "$script")")" 'it holds a non-ASCII byte'
  else
    assert_pass "$(fmt 'the script {0} is pure ASCII' "$(basename "$script")")"
  fi
done

# --- the emergency switch ---
if [ -f "$DISABLE" ]; then
  EM_OUT=$("$DISABLE" --package "$PROFILE/package.json" --action disable 2>&1) || true
  if grep -q "$PACKAGE_NAME" "$PROFILE/package.json" 2>/dev/null; then
    assert_fail 'the emergency switch takes the plugin out of the bundles' 'it is still there'
  else
    assert_pass 'the emergency switch takes the plugin out of the bundles'
  fi
  if ls "$PROFILE"/package.json.bak-emergency-* >/dev/null 2>&1; then
    assert_pass 'the emergency switch leaves a backup behind'
  else
    assert_fail 'the emergency switch leaves a backup behind' 'there is none'
  fi
fi

# --- only the temp directory was touched ---
if [ -n "$(find "$DRILL_DIR" -maxdepth 1 -name 'profile.broken-*' 2>/dev/null)" ]; then
  assert_pass "$(t 'drill.assertOnlyTemp' 'the drill only touched its own temporary directory')"
else
  assert_fail "$(t 'drill.assertOnlyTemp' 'the drill only touched its own temporary directory')" 'nothing was touched'
fi

# --- cleanup ---
rm -rf -- "$DRILL_DIR"
if [ -e "$DRILL_DIR" ]; then
  assert_fail "$(t 'drill.notCleaned' 'the temporary directory was not cleaned up, please delete it yourself: {0}')" "$DRILL_DIR"
else
  assert_pass "$(t 'drill.cleaned' 'the temporary directory is clean.')"
fi

if [ "$FAILED" -eq 0 ]; then
  say "$(t 'drill.passed' 'the drill passed: broke it on purpose -> restored -> checked -> cleaned up.')"
  exit 0
fi
say "$(fmt "$(t 'drill.failed' 'the drill failed: {0} assertions did not pass.')" "$FAILED")"
exit 1
