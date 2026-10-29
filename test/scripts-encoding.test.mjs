/**
 * The rescue kit's scripts must keep their encoding — or they die silently.
 *
 * This machine only has Windows PowerShell 5.1, whose console code page is
 * GB2312. PowerShell 5.1 reads a UTF-8 file WITHOUT a byte order mark as
 * ANSI, so every Chinese character in the file turns into mojibake and the
 * script dies with a ParserError before it does anything at all.
 *
 * These scripts are normally never run — which is exactly why nothing notices
 * when an editor or a tool rewrites them without the BOM. So the check lives
 * here, in the ordinary test run, and it reads the bytes itself: no
 * PowerShell needed.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

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
});

test('EVERY PowerShell script keeps its UTF-8 byte order mark', () => {
  const files = scriptsWithExtension('.ps1');
  assert.ok(files.length > 0, 'no .ps1 found in scripts/');
  for (const name of files) {
    const bytes = bytesOf(name);
    assert.ok(bytes.length >= 3, name + ' is empty');
    assert.equal(bytes[0], 0xef, name + ' must start with the UTF-8 BOM (EF BB BF)');
    assert.equal(bytes[1], 0xbb, name + ' must start with the UTF-8 BOM (EF BB BF)');
    assert.equal(bytes[2], 0xbf, name + ' must start with the UTF-8 BOM (EF BB BF)');
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

test('the drill script never sweeps %TEMP% with a wildcard', () => {
  const text = bytesOf('drill-rescue.ps1').toString('utf8');
  // A wildcard scan of %TEMP% would delete the directory of a drill that is
  // running at the same time.
  assert.doesNotMatch(text, /Get-ChildItem[^\n]*\$env:TEMP/gi, 'the drill must not list %TEMP%');
  assert.doesNotMatch(text, /Remove-Item[^\n]*\$env:TEMP/gi, 'the drill must not delete anything in %TEMP% directly');
  // The only cleanup must name its own directory, literally.
  assert.match(text, /Remove-Item\s+-LiteralPath\s+\$script:TempRoot/gi, 'the cleanup must delete the drill\'s own directory by literal path');
});

test('the drill checks the rejection REASON, not only the exit code', () => {
  const text = bytesOf('drill-rescue.ps1').toString('utf8');
  // A script that cannot even parse also exits non-zero. The drill has to
  // tell "the script refused on purpose" apart from "the script broke".
  assert.match(text, /function\s+Assert-Refused/, 'the drill must have a rejection assertion that reads the output');
  const calls = text.match(/Assert-Refused\s+/g) || [];
  assert.ok(calls.length >= 5, 'every rejection scenario must use Assert-Refused (found ' + calls.length + ')');
  // The words that have to show up in the output for each scenario.
  for (const keyword of ['不像', '不是 profile', '盘符', '根目录', '系统目录', '不允许', '不存在']) {
    assert.ok(text.includes(keyword), 'the drill must look for the rejection reason «' + keyword + '»');
  }
});

test('the drill refuses the system directories too', () => {
  const text = bytesOf('drill-rescue.ps1').toString('utf8');
  for (const dir of ['C:\\Windows', 'C:\\Program Files', 'C:\\ProgramData']) {
    assert.ok(text.includes(dir), 'the drill must try the system directory ' + dir);
  }
});
