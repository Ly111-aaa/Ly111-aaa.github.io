@echo off
rem ============================================================
rem  Zero-dependency static blog - one-click launcher
rem   - if the blog server is already up, just open the browser
rem   - otherwise boot "node server.mjs" in a minimized window,
rem     wait until 127.0.0.1:5173 answers, then open the browser
rem  Usage: start-blog.cmd [check]   (check = dry run, no browser)
rem
rem  NOTE: keep this file pure ASCII. cmd.exe parses .cmd files
rem  using the OEM code page (GBK on zh-CN Windows), so UTF-8
rem  comments corrupt command parsing.
rem ============================================================
setlocal EnableExtensions
set "URL=http://127.0.0.1:5173"
set "DRYRUN="
if /i "%~1"=="check" set "DRYRUN=1"

rem ---- locate blog dir and node ------------------------------
set "BLOGDIR=%~dp0"
if "%BLOGDIR:~-1%"=="\" set "BLOGDIR=%BLOGDIR:~0,-1%"

set "NODE=node"
if exist "D:\soft\dsh\nodejs\node.exe" set "NODE=D:\soft\dsh\nodejs\node.exe"

rem ---- 1) already running? -----------------------------------
curl.exe -s -o NUL --max-time 3 "%URL%/health" >NUL 2>&1
if not errorlevel 1 goto :open

rem ---- 2) boot in a minimized window ------------------------
echo [blog] Starting the blog server, please wait...
start "dsh blog" /min cmd /c "cd /d "%BLOGDIR%" && "%NODE%" server.mjs"

rem ---- 3) wait until it answers (up to ~20 s) ---------------
set /a tries=0
:waitloop
curl.exe -s -o NUL --max-time 2 "%URL%/health" >NUL 2>&1
if not errorlevel 1 goto :open
set /a tries+=1
if %tries% geq 20 goto :timeout
timeout /t 1 /nobreak >NUL
goto :waitloop

:timeout
echo [blog] Server did not become ready in time. Check the "dsh blog" window for errors.
if not defined DRYRUN pause
exit /b 1

:open
if defined DRYRUN (
  echo [blog] Server is up at %URL%
  exit /b 0
)
start "" "%URL%"
exit /b 0
