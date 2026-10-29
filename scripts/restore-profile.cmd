@echo off
rem dsh-autorestart - restore the profile snapshot.
rem
rem Double-click this file when DSH does not start any more (a plugin upgrade
rem broke the profile, the configuration was damaged, node_modules is a mess):
rem it puts the newest snapshot that carries a manifest back over the profile.
rem
rem What it does, in this order:
rem   1. finds the newest snapshot with a manifest under <stateDir>\backups
rem   2. MOVES the current profile to <profile>\.broken-<timestamp> (nothing is
rem      deleted, the evidence stays)
rem   3. copies the configuration files and the plugin tree back
rem   4. reads the result back: package.json, dsh.profile.bundles and the
rem      version of dsh-autorestart have to be readable
rem
rem It never restarts DSH for you - you do that yourself.
rem
rem Optional arguments are passed straight to the PowerShell script, e.g.
rem   restore-profile.cmd -DryRun
rem   restore-profile.cmd -ProfileDir C:\temp\drill\profile -StateDir C:\temp\drill\state
rem
rem NOTE: this file is ASCII on purpose. cmd.exe reads a batch file with the
rem console code page, and a UTF-8 character in it would shift the rest of the
rem line and be run as a command. The Chinese explanation comes from the
rem PowerShell script below (and from scripts\README.md).
setlocal
set "SCRIPT=%~dp0restore-profile.ps1"
if not exist "%SCRIPT%" (
  echo Cannot find "%SCRIPT%".
  echo The rescue kit is incomplete - keep the plugin folder together.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo Done. The result is above - open DSH again.
) else (
  echo The restore did NOT finish. Read the red lines above.
  echo Your old profile was not deleted - it is kept as a ".broken-<timestamp>" folder.
)
pause
exit /b %RC%
