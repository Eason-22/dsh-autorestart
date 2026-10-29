@echo off
rem dsh-autorestart - the emergency switch.
rem
rem Double-click this file when DSH does not start any more after the plugin was
rem enabled: it takes "dsh-autorestart" out of the profile's bundles list, so the
rem next start of DSH comes up WITHOUT this plugin. Restart DSH afterwards.
rem
rem (An optional first argument points at another package.json - that is how the
rem script is tested; without an argument the real desktop profile is used.)
rem
rem NOTE: this file is ASCII on purpose. cmd.exe reads a batch file with the
rem console code page, and a UTF-8 character in it would shift the rest of the
rem line and be run as a command. The Chinese explanation comes from the
rem PowerShell script below (and from docs/README.zh.md).
setlocal
if "%~1"=="" goto :real-profile
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0emergency-toggle.ps1" -Action disable -PackageJson "%~1"
goto :done
:real-profile
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0emergency-toggle.ps1" -Action disable
:done
set "RC=%ERRORLEVEL%"
echo.
echo The result is above. Restart DSH for it to take effect.
echo To try the plugin again: run emergency-toggle.ps1 -Action enable
pause
exit /b %RC%
