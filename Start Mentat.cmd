@echo off
rem Double-click to start Mentat (no PowerShell needed).
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo First run: installing dependencies...
  call npm.cmd install || (echo Install failed. & pause & exit /b 1)
  if not exist "node_modules\electron\dist\electron.exe" node node_modules\electron\install.js
)
set ELECTRON_RUN_AS_NODE=
rem Electron with Mentat's name and icon (scripts\brand-dev.js); plain electron.exe if that fails.
set "EXE="
for /f "delims=" %%p in ('node scripts\brand-dev.js 2^>nul') do set "EXE=%%p"
if not defined EXE set "EXE=%~dp0node_modules\electron\dist\electron.exe"
start "" "%EXE%" "%~dp0."
