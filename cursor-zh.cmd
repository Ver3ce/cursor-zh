@echo off
rem Source-mode launcher (needs Node.js). exe users do not need this file.
rem First run does npm install + npm run build. Args pass through to node dist\index.js.
rem
rem KEEP THIS FILE ASCII-ONLY. cmd.exe re-reads the batch file by byte offset; if the
rem file contains UTF-8 multi-byte text and the code page changes mid-run (chcp below),
rem the parser jumps to wrong lines (wrong branch / lost labels / window closes).
setlocal
chcp 65001 >nul
cd /d "%~dp0"
rem Tell the program this window belongs to the launcher: pause on error instead of closing.
set CZ_LAUNCHER=cmd
where node >nul 2>nul
if errorlevel 1 (
  echo [cursor-zh] Node.js not found. Install Node.js 22+ or use cursor-zh.exe from the Releases page.
  goto :fail
)
if not exist "dist\index.js" (
  echo [cursor-zh] Not built yet, running npm install ^&^& npm run build ...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :fail
  call npm run build
  if errorlevel 1 goto :fail
)
if "%~1"=="" (
  node dist\index.js start
) else (
  node dist\index.js %*
)
if errorlevel 1 goto :fail
goto :eof
:fail
echo.
echo [cursor-zh] Exited with error (code %errorlevel%). Log file: %~dp0logs\cursor-zh.log
pause
