/**
 * The rescue kit's scripts must keep their encoding — or they die silently.
 *
 * This machine only has Windows PowerShell 5.1, whose console code page is
 * GB2312. PowerShell 5.1 reads a UTF-8 file WITHOUT a byte order mark as
 * ANSI, so every Chinese character in the file turns into mojibake and the
 * script dies with a ParserError before it does anything at all.
 *
 * That happened three times in one afternoon, so the rule is now stronger
 * than "remember the BOM": the .ps1 files are PURE ASCII, with no byte above
 * 127 and no byte order mark at all. The Chinese wording lives next to them
 * in one UTF-8 file without a BOM (rescue-strings.zh.json), and the scripts
 * read it at runtime.
 *
 * These scripts are normally never run — which is exactly why nothing notices
 * when an editor or a tool rewrites them. So the check lives here, in the
 * ordinary test run, and it reads the bytes itself: no PowerShell needed.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const stringsFile = 'rescue-strings.zh.json';

/** The bytes of a file. */
function bytesOf(name) {
  return fs.readFileSync(path.join(scriptsDir, name));
}

/**
 * Every script in the folder — DISCOVERED, not written down.
 *
 * A list of names has to be edited every time a script is added, and the one
 * that gets forgotten is exactly the one that breaks silently. Reading the
 * directory means a new script is covered the moment it lands.
 */
function scriptsWithExtension(extension) {
  return fs
    .readdirSync(scriptsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
    .map((entry) => entry.name)
    .sort();
}

/** Is there a string behind this dotted key? */
function hasKey(root, dottedKey) {
  let node = root;
  for (const part of dottedKey.split('.')) {
    if (!node || typeof node !== 'object' || !(part in node)) return false;
    node = node[part];
  }
  return node !== undefined && node !== null && node !== '';
}

/** How many leaves does this JSON tree have? */
function countLeaves(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') {
    return Object.values(value).reduce((sum, child) => sum + countLeaves(child), 0);
  }
  return 1;
}

test('the scripts folder holds the scripts it promises', () => {
  const ps1 = scriptsWithExtension('.ps1');
  const cmd = scriptsWithExtension('.cmd');
  assert.ok(ps1.length > 0, 'no .ps1 found in scripts/');
  assert.ok(cmd.length > 0, 'no .cmd found in scripts/');
  // The ones the rescue kit is made of.
  for (const name of ['emergency-toggle.ps1', 'restore-profile.ps1', 'drill-rescue.ps1']) {
    assert.ok(ps1.includes(name), 'scripts/' + name + ' is missing');
  }
  for (const name of ['emergency-disable.cmd', 'restore-profile.cmd']) {
    assert.ok(cmd.includes(name), 'scripts/' + name + ' is missing');
  }
  assert.ok(fs.existsSync(path.join(scriptsDir, stringsFile)), 'scripts/' + stringsFile + ' is missing');
});

test('EVERY PowerShell script stays pure ASCII', () => {
  const files = scriptsWithExtension('.ps1');
  assert.ok(files.length > 0, 'no .ps1 found in scripts/');
  for (const name of files) {
    const bytes = bytesOf(name);
    assert.ok(bytes.length > 0, name + ' is empty');
    for (const byte of bytes) {
      assert.ok(
        byte < 128,
        name + ' must stay pure ASCII (byte ' + byte + ' at ' + bytes.indexOf(byte) + '): the Chinese wording belongs in ' + stringsFile,
      );
    }
    // A byte order mark is not ASCII either, but say it plainly.
    assert.notEqual(bytes[0], 0xef, name + ' must not start with a UTF-8 BOM');
  }
});

test('EVERY batch file stays pure ASCII', () => {
  const files = scriptsWithExtension('.cmd');
  assert.ok(files.length > 0, 'no .cmd found in scripts/');
  for (const name of files) {
    for (const byte of bytesOf(name)) {
      assert.ok(byte < 128, name + ' must stay ASCII (cmd.exe reads it with the console code page)');
    }
  }
});

test('EVERY node script of scripts/ stays pure ASCII', () => {
  // The watchdog and its drill are run by the host and by the system (a
  // scheduled task, a systemd timer, a shell): they are read with whatever
  // code page the machine has. The Chinese wording lives in a JSON file.
  const files = scriptsWithExtension('.mjs');
  assert.ok(files.length > 0, 'no .mjs found in scripts/');
  for (const name of files) {
    const bytes = bytesOf(name);
    for (const byte of bytes) {
      assert.ok(byte < 128, name + ' must stay pure ASCII (byte ' + byte + ')');
    }
    assert.notEqual(bytes[0], 0xef, name + ' must not start with a UTF-8 BOM');
  }
});

test('EVERY batch file calls powershell.exe, never pwsh', () => {
  const files = scriptsWithExtension('.cmd');
  assert.ok(files.length > 0, 'no .cmd found in scripts/');
  for (const name of files) {
    const text = bytesOf(name).toString('ascii');
    assert.match(text, /powershell\.exe/i, name + ' must call powershell.exe');
    assert.doesNotMatch(text, /\bpwsh\b/i, name + ' must not call pwsh (this machine only has Windows PowerShell 5.1)');
    assert.match(text, /-ExecutionPolicy\s+Bypass/i, name + ' must bypass the execution policy');
  }
});

test('the Chinese strings file is UTF-8 without a BOM and parses', () => {
  const bytes = fs.readFileSync(path.join(scriptsDir, stringsFile));
  assert.notEqual(bytes[0], 0xef, stringsFile + ' must not have a byte order mark (it would break JSON.parse)');
  const text = bytes.toString('utf8');
  let parsed = null;
  assert.doesNotThrow(() => { parsed = JSON.parse(text); }, stringsFile + ' must be valid JSON');
  assert.ok(parsed && typeof parsed === 'object', stringsFile + ' must hold an object');
  assert.ok(countLeaves(parsed) > 0, stringsFile + ' must not be empty');
});

test('every key the scripts ask for exists in the Chinese strings file', () => {
  const parsed = JSON.parse(fs.readFileSync(path.join(scriptsDir, stringsFile), 'utf8'));
  for (const name of scriptsWithExtension('.ps1')) {
    const text = fs.readFileSync(path.join(scriptsDir, name), 'utf8');
    const keys = [...text.matchAll(/\bTA?\s+'([^']+)'/g)].map((match) => match[1]);
    for (const key of keys) {
      assert.ok(hasKey(parsed, key), name + ' asks for the missing key ' + key + ' in ' + stringsFile);
    }
  }
});

test('the scripts that print Chinese read the strings file', () => {
  for (const name of ['restore-profile.ps1', 'drill-rescue.ps1', 'emergency-toggle.ps1']) {
    const text = fs.readFileSync(path.join(scriptsDir, name), 'utf8');
    assert.ok(text.includes(stringsFile), name + ' must read the Chinese wording from ' + stringsFile);
    assert.ok(text.includes('[System.Text.Encoding]::UTF8'), name + ' must read that file as UTF-8 explicitly');
  }
});

test('the drill script never sweeps %TEMP% with a wildcard', () => {
  const text = bytesOf('drill-rescue.ps1').toString('ascii');
  // A wildcard scan of %TEMP% would delete the directory of a drill that is
  // running at the same time.
  assert.doesNotMatch(text, /Get-ChildItem[^\n]*\$env:TEMP/gi, 'the drill must not list %TEMP%');
  assert.doesNotMatch(text, /Remove-Item[^\n]*\$env:TEMP/gi, 'the drill must not delete anything in %TEMP% directly');
  // The only cleanup must name its own directory, literally.
  assert.match(text, /Remove-Item\s+-LiteralPath\s+\$script:TempRoot/gi, 'the cleanup must delete the drill\'s own directory by literal path');
});

test('the drill checks the rejection REASON, not only the exit code', () => {
  const text = bytesOf('drill-rescue.ps1').toString('ascii');
  // A script that cannot even parse also exits non-zero. The drill has to
  // tell "the script refused on purpose" apart from "the script broke".
  assert.match(text, /function\s+Assert-Refused/, 'the drill must have a rejection assertion that reads the output');
  const calls = text.match(/Assert-Refused\s+/g) || [];
  assert.ok(calls.length >= 5, 'every rejection scenario must use Assert-Refused (found ' + calls.length + ')');
  // The words a refusal has to contain live in the strings file now.
  const parsed = JSON.parse(fs.readFileSync(path.join(scriptsDir, stringsFile), 'utf8'));
  const keywords = parsed.drill && parsed.drill.keywords ? parsed.drill.keywords : {};
  for (const name of ['notProfile', 'driveRoot', 'systemDir', 'missingDir', 'notValidated']) {
    assert.ok(Array.isArray(keywords[name]) && keywords[name].length > 0, 'the strings file must list the words for ' + name);
    for (const word of keywords[name]) {
      assert.ok(word.length > 0, 'the words for ' + name + ' must not be empty');
    }
  }
});

test('the drill refuses the system directories too', () => {
  const text = bytesOf('drill-rescue.ps1').toString('ascii');
  for (const dir of ['C:\\Windows', 'C:\\Program Files', 'C:\\ProgramData']) {
    assert.ok(text.includes(dir), 'the drill must try the system directory ' + dir);
  }
});
