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

test('the PowerShell scripts keep their UTF-8 byte order mark', () => {
  for (const name of ['restore-profile.ps1', 'drill-rescue.ps1']) {
    const bytes = bytesOf(name);
    assert.ok(bytes.length >= 3, name + ' is empty');
    assert.equal(bytes[0], 0xef, name + ' must start with the UTF-8 BOM (EF BB BF)');
    assert.equal(bytes[1], 0xbb, name + ' must start with the UTF-8 BOM (EF BB BF)');
    assert.equal(bytes[2], 0xbf, name + ' must start with the UTF-8 BOM (EF BB BF)');
  }
});

test('the batch entry point stays pure ASCII', () => {
  const bytes = bytesOf('restore-profile.cmd');
  for (const byte of bytes) {
    assert.ok(byte < 128, 'restore-profile.cmd must stay ASCII (cmd.exe reads it with the console code page)');
  }
});

test('the batch entry point calls powershell.exe, never pwsh', () => {
  const text = bytesOf('restore-profile.cmd').toString('ascii');
  assert.match(text, /powershell\.exe/i, 'the .cmd must call powershell.exe');
  assert.doesNotMatch(text, /\bpwsh\b/i, 'the .cmd must not call pwsh (this machine only has Windows PowerShell 5.1)');
  assert.match(text, /-ExecutionPolicy\s+Bypass/i, 'the .cmd must bypass the execution policy');
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
