@echo off
rem ============================================================
rem  MiMo Voice Clone - launcher
rem  ASCII only on purpose: a UTF-8 .bat with Chinese text can be
rem  mis-parsed by cmd.exe (default GBK code page) and die silently,
rem  which looks exactly like "connection refused" in the browser.
rem  All user-facing text is printed by server.mjs instead.
rem ============================================================
setlocal
cd /d "%~dp0"

set "NODEEXE="
where node >nul 2>nul && set "NODEEXE=node"
if not defined NODEEXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODEEXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODEEXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODEEXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODEEXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODEEXE goto :nonode
if not exist "server.mjs" goto :nofile

echo.
echo   MiMo Voice Clone - starting local server...
echo   URL: http://127.0.0.1:8391   (browser opens automatically)
echo   Close this window to stop.
echo.

"%NODEEXE%" server.mjs
set "RC=%ERRORLEVEL%"

echo.
echo   Server stopped (exit code %RC%).
echo   If the browser said "connection refused", read this log:
echo     %~dp0startup.log
echo.
pause
exit /b %RC%

:nonode
echo.
echo   [ERROR] Node.js not found.
echo   Install Node.js 20+ from https://nodejs.org/ then run this again.
echo.
pause
exit /b 1

:nofile
echo.
echo   [ERROR] server.mjs not found in:
echo     %CD%
echo   Keep this .bat in the same folder as server.mjs.
echo.
pause
exit /b 1
